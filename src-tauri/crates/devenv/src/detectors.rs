//! 「工具装没装」的探测器层 —— TS `core/rules/detectors.ts` 的逐字对应移植。
//!
//! ## 这一层为什么必须一个字节都不碰机器（本 crate 的立命之本）
//!
//! 真机探测（`where npm`、目录存在性、`docker system df`）全部住在注入侧 —— Electron 那边是
//! `electron/services/detect-env.ts`，Tauri 这边是 D2 那一棒的壳层。本文件只吃**注入的事实**：
//! 「`npm` 能不能跑 = true」「`%LOCALAPPDATA%\npm-cache` 在不在 = false」。
//!
//! 后果是硬的：每一条判据都能在**没有磁盘、没有进程、没有环境变量表**的机器上穷举验证。
//! 反过来，只要这一层掺进一次真 `stat`，「全绿」就变成「**这台**机器上全绿」——
//! 下一个会话换一台装了的机器会拿到相反的结论，而两种红都跟代码无关
//! （V0.7 验收里 `--shot-detectors` 那一条钉的就是同一件事）。
//! 所以本 crate 有一条只读静态闸守着 `src/*.rs`：见 `tests/readonly.rs`。
//!
//! ## 三条设计裁定（照抄 TS，代价一并抄过来）
//! - **两级判据取「或」**：命令在 PATH **或** 已知目录存在，任一命中就算已装。
//!   误判「未装」会把真容量静默藏起来；误判「已装」退回「这工具不存在但它有缓存」——
//!   前者更坏，所以宁可松。
//! - **不碰注册表**，也不新建第二套路径真相：本模块只按 id 引用规则，清理范围只有 `Rule.paths`。
//! - **只报告**：探测器不带删除能力、不带勾选策略（§3.5 的 AI 模型结构性豁免不住在这一层）。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/* ================================================================== *
 * 注入的能力面
 * ================================================================== */

/// 一次**只读** `docker system df --format json` 的结局（由实现方分类，本层只消费）。
/// 四格各答一件不同的事，谁也不许顶替谁 —— 线形状与 TS 的判别联合同名同键（`kind`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DockerCliOutcome {
    /// CLI 与 daemon 都答了话；`stdout` 是原文，字节一律由本层从这份原文算。
    Ok { stdout: String },
    /// **连进程都没起来**（ENOENT）—— 这是唯一可能支持「未安装」的一格，
    /// 而且还得再过一道 `command_available("docker")` 反证才敢真写 false。
    CliMissing,
    /// 有限超时到了、进程被杀。
    TimedOut,
    /// 进程起来了但退出码非 0 —— daemon 没起、权限不够、这个版本不认识这个参数，全在这一格。
    CliFailed { message: String },
}

/// 注入的能力面 —— 探测器唯一的对外依赖。前两个方法都只回答「有没有」，都不返回内容。
pub trait DetectorProbe {
    /// 命令能不能跑（壳层 = 一次进程查询的退出码）。
    fn command_available(&self, command: &str) -> bool;
    /// 已知目录在不在这台机器上。传入的是 `%VAR%` 模板（与 `Rule.paths` 同一语言），
    /// **由实现方按自己那台机器解析**；这样本层连"这台机器上的变量叫什么"都不需要知道。
    /// 解析不出变量按「不存在」回答。
    fn path_exists(&self, path_template: &str) -> bool;
    /// 只读查询本机 Docker 占用。**默认 `None` = 压根没有这一能力面**（对应 TS 的可选方法）。
    /// `None` 不是「没装」也不是 0 —— 问不出 ≠ 没有，所以它必须是第三种答案。
    fn query_docker_disk_usage(&self) -> Option<DockerCliOutcome> {
        None
    }
}

/* ================================================================== *
 * 探测器表
 * ================================================================== */

/// 判据的形状。九个两级探测器共用一份实现；Docker 是第三种形状（能不能拿到可解析的 df 输出）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Judgment {
    /// 命令在 PATH **或** 已知目录存在。
    TwoLevel,
    /// 三格读数里只有 `absent` 才写 false。
    DockerDf,
}

/// 一个探测器 = 一个工具 + 它把关的规则 id。除判据外全是数据。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Detector {
    /// 稳定 id，写进 `Rule.requires_detector`（一旦上表就是契约，不许改名）。
    pub id: &'static str,
    /// 给人看的名字。
    pub display_name: &'static str,
    /// 本探测器**把关**的规则 id（方向注意：是「谁需要我」，不是「我要删什么」）。
    pub rule_ids: &'static [&'static str],
    /// 第一级判据：裸命令名（不带路径、不带 `.exe`）。
    pub commands: &'static [&'static str],
    /// 第二级判据：已知安装/缓存 footprint 的 `%VAR%` 模板。
    /// 它们**只是存在性证据，永远不是清理范围** —— 清理范围只有 `Rule.paths` 那一处。
    pub known_dirs: &'static [&'static str],
    pub judgment: Judgment,
}

impl Detector {
    /// 装没装。**只有明确量到「没有」才写 false**；Docker 那格的「量不到」算装着。
    pub fn is_installed(&self, probe: &dyn DetectorProbe) -> bool {
        match self.judgment {
            Judgment::TwoLevel => two_level_installed(self.commands, self.known_dirs, probe),
            Judgment::DockerDf => read_docker_disk_usage(probe).verdict != DockerVerdict::Absent,
        }
    }
}

/// 九个两级探测器 = §16 🟡 / §21 那批「依赖某个工具才存在」的规则。
/// 每条的 `known_dirs` 都取 `%VAR%` 模板且变量在 `RULE_ENV_KEYS` 里 —— 变量名拼错会让第二级
/// **永远**回答「不存在」，进而把真容量误判成未安装；这条由 `tests/data_shape.rs` 点名抓，不靠眼看。
pub fn dev_env_detectors() -> &'static [Detector] {
    &DEV_ENV_DETECTORS
}

/// 上表 + Docker。注意 `collect_install_status()` 的默认参数是**上面那九个**，不是这张 ——
/// 引擎那张表的语义是「谁把关哪条规则」，Docker 不把关任何规则，默认并进只会多一个没人读的键。
pub fn dev_env_detectors_with_docker() -> &'static [Detector] {
    &DEV_ENV_DETECTORS_WITH_DOCKER
}

static DEV_ENV_DETECTORS: [Detector; 9] = [
    Detector {
        id: "npm",
        display_name: "npm",
        rule_ids: &["npm-cache"],
        commands: &["npm"],
        known_dirs: &[r"%LOCALAPPDATA%\npm-cache", r"%USERPROFILE%\.npm-global\cache"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "pnpm",
        display_name: "pnpm",
        rule_ids: &["pnpm-store"],
        commands: &["pnpm"],
        known_dirs: &[r"%LOCALAPPDATA%\pnpm-store", r"%LOCALAPPDATA%\pnpm\store"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "yarn",
        display_name: "Yarn",
        rule_ids: &["yarn-cache"],
        commands: &["yarn"],
        known_dirs: &[r"%LOCALAPPDATA%\Yarn\Cache"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "pip",
        display_name: "pip",
        rule_ids: &["pip-cache"],
        commands: &["pip", "pip3"],
        known_dirs: &[r"%LOCALAPPDATA%\pip\Cache"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "maven",
        display_name: "Maven",
        rule_ids: &["maven-repository"],
        commands: &["mvn"],
        known_dirs: &[r"%USERPROFILE%\.m2\repository"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "gradle",
        display_name: "Gradle",
        // IDE 里跑过的构建不会往 PATH 放 gradle，所以 `.gradle\caches` 存在本身就算已装 ——
        // 两级取或就是为这种机器留的
        rule_ids: &["gradle-cache"],
        commands: &["gradle"],
        known_dirs: &[r"%USERPROFILE%\.gradle\caches"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "huggingface",
        display_name: "Hugging Face",
        // §3.5 的 AI 模型豁免（不进默认勾选）不住在这一层：这里只回答装没装
        rule_ids: &["huggingface-cache"],
        commands: &["hf", "huggingface-cli"],
        known_dirs: &[r"%USERPROFILE%\.cache\huggingface"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "android-sdk",
        display_name: "Android SDK",
        // 问的是 `Sdk` **根**（存在性证据），把关的规则地盘仍然是 `Sdk\.temp` ——
        // 多问一个目录不等于多删一个目录
        rule_ids: &["android-sdk-temp"],
        commands: &["sdkmanager", "adb"],
        known_dirs: &[r"%LOCALAPPDATA%\Android\Sdk"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "vscode",
        display_name: "VS Code",
        rule_ids: &["vscode-cache"],
        commands: &["code"],
        known_dirs: &[r"%APPDATA%\Code\CachedData", r"%USERPROFILE%\.vscode"],
        judgment: Judgment::TwoLevel,
    },
];

/// 九个两级 + Docker 那一个只读探测器（共十个）。
static DEV_ENV_DETECTORS_WITH_DOCKER: [Detector; 10] = [
    Detector {
        id: "npm",
        display_name: "npm",
        rule_ids: &["npm-cache"],
        commands: &["npm"],
        known_dirs: &[r"%LOCALAPPDATA%\npm-cache", r"%USERPROFILE%\.npm-global\cache"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "pnpm",
        display_name: "pnpm",
        rule_ids: &["pnpm-store"],
        commands: &["pnpm"],
        known_dirs: &[r"%LOCALAPPDATA%\pnpm-store", r"%LOCALAPPDATA%\pnpm\store"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "yarn",
        display_name: "Yarn",
        rule_ids: &["yarn-cache"],
        commands: &["yarn"],
        known_dirs: &[r"%LOCALAPPDATA%\Yarn\Cache"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "pip",
        display_name: "pip",
        rule_ids: &["pip-cache"],
        commands: &["pip", "pip3"],
        known_dirs: &[r"%LOCALAPPDATA%\pip\Cache"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "maven",
        display_name: "Maven",
        rule_ids: &["maven-repository"],
        commands: &["mvn"],
        known_dirs: &[r"%USERPROFILE%\.m2\repository"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "gradle",
        display_name: "Gradle",
        rule_ids: &["gradle-cache"],
        commands: &["gradle"],
        known_dirs: &[r"%USERPROFILE%\.gradle\caches"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "huggingface",
        display_name: "Hugging Face",
        rule_ids: &["huggingface-cache"],
        commands: &["hf", "huggingface-cli"],
        known_dirs: &[r"%USERPROFILE%\.cache\huggingface"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "android-sdk",
        display_name: "Android SDK",
        rule_ids: &["android-sdk-temp"],
        commands: &["sdkmanager", "adb"],
        known_dirs: &[r"%LOCALAPPDATA%\Android\Sdk"],
        judgment: Judgment::TwoLevel,
    },
    Detector {
        id: "vscode",
        display_name: "VS Code",
        rule_ids: &["vscode-cache"],
        commands: &["code"],
        known_dirs: &[r"%APPDATA%\Code\CachedData", r"%USERPROFILE%\.vscode"],
        judgment: Judgment::TwoLevel,
    },
    DOCKER_DETECTOR,
];

/// Docker 探测器。**它不在 `dev_env_detectors()` 那张表里**，三条理由（照抄 TS）：
/// 1. 那张表的语义是「谁把关哪条规则」，而 registry 里**没有任何 Docker 规则**（V0.4 裁定维持），
///    键进引擎只会多一个没人读的键。
/// 2. 那张表是 `BTreeMap<String, bool>`，而 Docker 的答案是三格的 —— 布尔装不下它。
/// 3. 并进那张表会连带撞掉两条**不属于这一层**的既有判据（「每个探测器至少把关一条规则」与
///    「九个分类全部算已装」）。
///
/// `known_dirs` 故意空：裁定 1 不许拿 `%LOCALAPPDATA%\Docker\*` 这类 FS 目录给 Docker 估容量，
/// 连「存在性证据」也不许 —— 字节只能来自那份 JSON，路径一次都不 stat。
/// `commands` 里那一个**不是**第一级判据，只是 `cli-missing` 那格的反证。
pub const DOCKER_DETECTOR: Detector = Detector {
    id: "docker",
    display_name: "Docker",
    rule_ids: &[],
    commands: &["docker"],
    known_dirs: &[],
    judgment: Judgment::DockerDf,
};

/* ================================================================== *
 * 两级判据
 * ================================================================== */

/// 两级判据的实现**只有一份**，所以「或」的语义不可能在某条探测器上悄悄变成「与」。
///
/// 这里**不求短路**：每个命令、每个目录都被问过一遍（与 TS 的 `.map(...).some(...)` 同形 ——
/// `map` 先把整数组算完）。多几次查询的成本换的是判据可解释：假探针的单测据此能钉住
/// 「这条规则到底问了哪几件事」，而短路实现下结论会随命令表顺序变。
/// 谁把它改成 `.any()` 惰性求值，`the_two_level_judgment_asks_every_command_and_dir` 会当场红。
fn two_level_installed(
    commands: &[&str],
    known_dirs: &[&str],
    probe: &dyn DetectorProbe,
) -> bool {
    let command_hits: Vec<bool> = commands.iter().map(|c| probe.command_available(c)).collect();
    let dir_hits: Vec<bool> = known_dirs.iter().map(|d| probe.path_exists(d)).collect();
    let hit_command = command_hits.iter().any(|b| *b);
    let hit_dir = dir_hits.iter().any(|b| *b);
    hit_command || hit_dir
}

/// 整表跑一遍，产出引擎要的那张状态表：键 = 探测器 id（= `Rule.requires_detector` 填的值）。
///
/// 为什么不直接把探测器对象交给引擎：引擎的判定语义是冻结的，它只该收到一个「结论」，
/// 不该收到一个能问出下一个问题的入口 —— 否则规则引擎就有能力去摸机器了。
///
/// **这张表是两态的（`bool`），三态住在「键在不在」里**：`get() == None` 是「没问过」，
/// 不是「没装」。表里出现的键必定来自探测器表；反之「规则写了而表里没有的 id」不在这里兜，
/// 由引擎按「已安装」处理、由视图按「不确定装没装」处理。
pub fn collect_install_status(
    probe: &dyn DetectorProbe,
    detectors: &[Detector],
) -> BTreeMap<String, bool> {
    let mut out = BTreeMap::new();
    for d in detectors {
        out.insert(d.id.to_string(), d.is_installed(probe));
    }
    out
}

/// 默认那张表（九个）跑一遍。
pub fn collect_install_status_default(probe: &dyn DetectorProbe) -> BTreeMap<String, bool> {
    collect_install_status(probe, dev_env_detectors())
}

/// 按规则 id 反查把关它的探测器（无人把关 → `None`，供接线侧与页面显示「无需探测」）。
pub fn detector_for_rule<'a>(rule_id: &str, detectors: &'a [Detector]) -> Option<&'a Detector> {
    detectors.iter().find(|d| d.rule_ids.contains(&rule_id))
}

/* ================================================================== *
 * Docker：CLI 委托（裁定 1）
 *
 * **为什么不能走两级判据**：§16 要的是「Docker 未使用数据」的容量，而那份容量在 docker 的
 * 数据目录里，路径既不是叶子路径、也不归 `Rule.paths` 表达。用 FS 通配去估字节过不了叶子路径
 * 判据，硬凑就是假字节数。这条绕开那个理由：**探测与容量都来自一次只读查询，清理动作交给
 * Docker 自己**（页面上那句「请用 `docker system prune`」是给**人看**的文案，不进 argv、
 * 不进这一层的任何一个函数名）。
 *
 * **为什么判据是「能不能拿到一份可解析的 df 输出」**：daemon 没起的机器上 `docker` 明明在 PATH，
 * 这时候说「已装但 0 字节」和说「未安装」都是谎。所以三分：
 * `measured` / `absent` / `unmeasurable`，只有 `absent` 才写 false 交给引擎那条轴。
 * ================================================================== */

/// 三格结论。`absent` 是「这台机器没装」，`unmeasurable` 是「装了（或说不准）但这次量不到」——
/// **两者都不是 0**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DockerVerdict {
    Measured,
    Absent,
    Unmeasurable,
}

/// df 报回来的一个类目。名字只用 CLI 自己报的那个键的小写形式，本层不改名、不并类。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerUsageCategory {
    pub name: String,
    pub reclaimable_bytes: u64,
}

/// Docker 的读数。页面那一行要用的就是这三格：`reclaimable_bytes == None` 时必须念「量不到」，
/// 不许印成 `0 B` —— 「0」在这里是一个测量结果，不是「没有」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerDiskUsage {
    pub verdict: DockerVerdict,
    /// 只来自那份 df 输出；量不到 / 未安装都是 `None`，不是 `Some(0)`。
    pub reclaimable_bytes: Option<u64>,
    /// 逐类目拆分；CLI 没报的类目**不出现在表里**（不补 0，补了就是「量到了 0」）。
    pub categories: Vec<DockerUsageCategory>,
    /// 给人看的一句话，写明这次是量到了、量不到、还是没装。
    pub detail: String,
}

/// df 的 HumanSize / CanonicalSize 是 1000 进制；带 i 的那几个才是 1024 进制。两套都认，别互相冒充。
fn size_unit(unit: &str) -> Option<f64> {
    match unit {
        "b" => Some(1.0),
        "kb" => Some(1e3),
        "mb" => Some(1e6),
        "gb" => Some(1e9),
        "tb" => Some(1e12),
        "pb" => Some(1e15),
        "kib" => Some(1024.0),
        "mib" => Some(1024.0 * 1024.0),
        "gib" => Some(1024.0 * 1024.0 * 1024.0),
        "tib" => Some(1024.0f64.powi(4)),
        "pib" => Some(1024.0f64.powi(5)),
        _ => None,
    }
}

fn is_ascii_space(c: char) -> bool {
    c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\u{0b}' || c == '\u{0c}'
}

fn is_ascii_digit(c: char) -> bool {
    c.is_ascii_digit()
}

fn is_ascii_letter(c: char) -> bool {
    c.is_ascii_alphabetic()
}

/// 人读尺寸串 → 字节：`0B` / `1.586MB` / `2.1 GiB` / `44.99MB (3 of 7 images)` 都认，
/// 认不出的一律 `None`（负数、`-`、空串、`Reclaimable: ""` 全在这儿被挡掉，不许悄悄当 0）。
///
/// 这里是手写的 `/^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]{0,3})\s*(?:\(|$)/` 等价物，
/// 不引正则库。两处的语义差异只有空白类：JS 的 `\s` 含 Unicode 空白，这里按 ASCII 空白 +
/// 垂直制表/换页；df 不会吐出别的空白种类，且两侧都只影响「读不读得出」同一种答案。
/// 单位取满三封信后**不再回溯**：JS 那侧一旦尾注检查失败而单位还能缩短，结论同样是
/// 「认不出」（>3 封连续字母时任何长度都配不上尾注），所以结果集相同。
fn parse_human_bytes(raw: &str) -> Option<u64> {
    let cs: Vec<char> = raw.chars().collect();
    let n = cs.len();
    let mut i = 0usize;
    while i < n && (is_ascii_space(cs[i]) || cs[i] == '\u{a0}') {
        i += 1;
    }
    // ([0-9]+(?:\.[0-9]+)?)
    let num_start = i;
    if i >= n || !is_ascii_digit(cs[i]) {
        return None;
    }
    while i < n && is_ascii_digit(cs[i]) {
        i += 1;
    }
    if i + 1 < n && cs[i] == '.' && is_ascii_digit(cs[i + 1]) {
        i += 1;
        while i < n && is_ascii_digit(cs[i]) {
            i += 1;
        }
    }
    let value: f64 = cs[num_start..i].iter().copied().collect::<String>().parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    // \s*
    while i < n && (is_ascii_space(cs[i]) || cs[i] == '\u{a0}') {
        i += 1;
    }
    // ([A-Za-z]{0,3}) —— 贪婪取满三封
    let unit_start = i;
    let mut taken = 0usize;
    while i < n && taken < 3 && is_ascii_letter(cs[i]) {
        i += 1;
        taken += 1;
    }
    let unit: String = cs[unit_start..i].iter().copied().collect::<String>().to_lowercase();
    // \s*(?:\(|$)
    while i < n && (is_ascii_space(cs[i]) || cs[i] == '\u{a0}') {
        i += 1;
    }
    if i < n && cs[i] != '(' {
        return None;
    }
    if unit.is_empty() {
        return Some(round_to_u64(value));
    }
    let multiplier = size_unit(&unit)?;
    Some(round_to_u64(value * multiplier))
}

/// JS 的 `Math.round`：正数半值向上。这里只会收到非负数（正则挡掉了 `-`），
/// 所以 Rust 的 `round()`（远离零）与它同形。
fn round_to_u64(v: f64) -> u64 {
    let r = v.round();
    if r <= 0.0 {
        0
    } else if r > u64::MAX as f64 {
        // 超出 u64 表示范围的读数：TS 那侧会交出一个已经丢了精度的 number，
        // 这一层交不出（见 `as_byte_count` 的 `?` 语义）。这条差异在回报里点名过，
        // 夹具不喂这种数。
        u64::MAX
    } else {
        r as u64
    }
}

/// df 里的一个尺寸字段（现代 CLI 给数字、老 CLI 给人读串）→ 字节；读不出就是真读不出。
fn as_byte_count(value: Option<&serde_json::Value>) -> Option<u64> {
    match value {
        Some(serde_json::Value::Number(num)) => {
            let v = num.as_f64()?;
            if !v.is_finite() || v < 0.0 {
                return None;
            }
            Some(round_to_u64(v))
        }
        Some(serde_json::Value::String(s)) => parse_human_bytes(s),
        // undefined（键缺失）/ null / 布尔 / 对象 / 数组 全部走这一支 —— 与 TS 的
        // `typeof value === 'number' | 'string'` 之外的兜底同形
        _ => None,
    }
}

fn unmeasurable(detail: &str) -> DockerDiskUsage {
    DockerDiskUsage {
        verdict: DockerVerdict::Unmeasurable,
        reclaimable_bytes: None,
        categories: Vec::new(),
        detail: detail.to_string(),
    }
}

/// `Ok(类目表)` 或 `Err(为什么读不出)`。
type DfCategories = Result<Vec<DockerUsageCategory>, String>;

/// `--format json` 有两种历史形状，都接：
/// - **数组**（老 CLI）：一行一个类目，`Reclaimable` 是人读串 —— 少一行、有一行解析不出来，整份读数作废。
/// - **对象**（现代 CLI）：`Images[].Reclaimable` / `Containers[].Size` / `Volumes[].Size`，单位是字节。
/// 某一类整个键缺失或为 `null` → 这一类**不进总数**（少报是一处看得见的缺口）；但同类里出现了
/// 解析不出来的值 → 整份读数判「量不到」，因为这时候连「少报了哪一格」都说不准。
fn categories_from_df_rows(rows: &[serde_json::Value]) -> DfCategories {
    if rows.is_empty() {
        return Err("df 返回空数组，一个类目都没报".to_string());
    }
    let mut out: Vec<DockerUsageCategory> = Vec::new();
    for raw in rows {
        let row = match raw.as_object() {
            Some(o) => o,
            None => return Err("df 的数组里有一行不是对象".to_string()),
        };
        let name = row
            .get("Type")
            .and_then(|t| t.as_str())
            .map(|t| t.to_lowercase())
            .unwrap_or_else(|| "未知类目".to_string());
        let bytes = match as_byte_count(row.get("Reclaimable")) {
            Some(b) => b,
            None => return Err(format!("类目「{name}」的 Reclaimable 读不成字节")),
        };
        out.push(DockerUsageCategory { name, reclaimable_bytes: bytes });
    }
    Ok(out)
}

/// 现代对象形状里被计入的三类（字段名各自是 CLI 报的哪个）。
const DF_OBJECT_CATEGORIES: [(&str, &str, &str); 3] = [
    ("Images", "images", "Reclaimable"),
    ("Containers", "containers", "Size"),
    ("Volumes", "volumes", "Size"),
];

fn categories_from_df_object(value: &serde_json::Map<String, serde_json::Value>) -> DfCategories {
    let mut out: Vec<DockerUsageCategory> = Vec::new();
    for (key, name, field) in DF_OBJECT_CATEGORIES {
        let rows = match value.get(key) {
            None | Some(serde_json::Value::Null) => continue,
            Some(other) => other,
        };
        let Some(rows) = rows.as_array() else {
            return Err(format!("{key} 不是数组"));
        };
        let mut sum: u64 = 0;
        for raw in rows {
            let Some(row) = raw.as_object() else {
                return Err(format!("{key} 里有一行不是对象"));
            };
            let bytes = match as_byte_count(row.get(field)) {
                Some(b) => b,
                None => return Err(format!("类目「{name}」里有一行的 {field} 读不成字节")),
            };
            // df 自己报的数已经过 round_to_u64 挡量级；这里再兜一次相加溢出
            sum = sum.saturating_add(bytes);
        }
        out.push(DockerUsageCategory { name: name.to_string(), reclaimable_bytes: sum });
    }
    if out.is_empty() {
        return Err("输出里一个被计数的类目都没有".to_string());
    }
    Ok(out)
}

/// 两种历史形状分发到这里；都不是 → 一句「读不出」，不猜一个数。
fn parse_df_value(value: &serde_json::Value) -> DfCategories {
    if let Some(rows) = value.as_array() {
        return categories_from_df_rows(rows);
    }
    match value.as_object() {
        Some(map) => categories_from_df_object(map),
        None => Err("输出既不是对象也不是数组".to_string()),
    }
}

/// 那份 stdout 是本层唯一的字节来源 —— 这里一个路径都不碰，所以「容量来自 FS 通配」
/// 这条路结构上不存在。
fn usage_from_df_stdout(stdout: &str) -> DockerDiskUsage {
    let text = stdout.trim();
    if text.is_empty() {
        return unmeasurable(
            "`docker system df` 退出码 0 但一个字都没给 → 量不到；这是没量到，不是 0 字节",
        );
    }
    let value: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            return unmeasurable(
                "`docker system df --format json` 的输出不是合法 JSON（版本不认识这个参数、或输出被截断都会走到这里）→ 量不到，不是 0 字节",
            )
        }
    };
    let categories = match parse_df_value(&value) {
        Ok(c) => c,
        Err(why) => return unmeasurable(&format!("df 报了东西但这一层读不出可回收字节（{why}）→ 量不到")),
    };
    let total = categories
        .iter()
        .fold(0u64, |acc, c| acc.saturating_add(c.reclaimable_bytes));
    let names = categories
        .iter()
        .map(|c| c.name.clone())
        .collect::<Vec<String>>()
        .join("、");
    DockerDiskUsage {
        verdict: DockerVerdict::Measured,
        reclaimable_bytes: Some(total),
        categories,
        detail: format!(
            "容量来自只读查询 `docker system df --format json`（类目：{}）。口径提醒：这是 df 自己报的逻辑字节，不是本次清理能释放的磁盘字节；build cache 未计入（形状跨版本差别最大，拿不准就不并进总数）。清理动作不归 DeepClean，交给 Docker 本身。",
            if names.is_empty() { "无".to_string() } else { names }
        ),
    }
}

/// 问一次 Docker，拿到三格结论之一。纯函数：机器侧全在注入的 `probe` 里，这里只分类与解析。
///
/// 「未安装」只有一个来源：`cli-missing`（ENOENT）**并且** `command_available("docker")` 也说找不到。
/// 为什么要后者反证 —— Windows 上起进程不认 `.cmd`/PATHEXT 那类垫片：Docker 的 CLI 有可能是
/// 一个 `docker.cmd`，`where` 找得到而进程起不来，这时候报「未安装」是假话，报「量不到」才是实话。
pub fn read_docker_disk_usage(probe: &dyn DetectorProbe) -> DockerDiskUsage {
    let Some(reply) = probe.query_docker_disk_usage() else {
        // 这一格是留给「探针压根没这个能力面」的（两级假探针就是这个形状）。
        // 结论既不写 false（引擎那条轴会把地盘摘掉）也不写 0 —— 问不出 ≠ 没有。
        return unmeasurable("注入的探针没有 Docker 只读查询能力面 → 无从判断，按「量不到」处理（不是未安装）");
    };
    match reply {
        DockerCliOutcome::Ok { stdout } => usage_from_df_stdout(&stdout),
        DockerCliOutcome::CliMissing => {
            if probe.command_available("docker") {
                return unmeasurable(
                    "起进程报 ENOENT，但 `where docker` 找得到（`.cmd` 垫片 / PATHEXT 这一类）→ 量不到，不是未安装",
                );
            }
            DockerDiskUsage {
                verdict: DockerVerdict::Absent,
                reclaimable_bytes: None,
                categories: Vec::new(),
                detail: "这台机器的 PATH 上没有 docker（连进程都起不来）→ 未安装。注意：这是探测结论，不等于盘上没有 Docker 数据；容量本就不由 FS 通配推断"
                    .to_string(),
            }
        }
        DockerCliOutcome::TimedOut => unmeasurable(
            "`docker system df` 到了有限超时被杀 → 量不到，不是未安装、也不是 0 字节",
        ),
        DockerCliOutcome::CliFailed { message } => {
            let hint = if message.is_empty() { String::new() } else { format!("（CLI 返回：{message}）") };
            unmeasurable(
                &format!(
                    "docker 在 PATH 上，但那次只读查询非 0 退出（daemon 没起是这一格最常见的一种）→ 量不到，不是未安装、也不是 0 字节{hint}"
                ),
            )
        }
    }
}

/* ================================================================== *
 * 单测
 *
 * 假探针**只记账不查真机**（`calls` 用来反证探测器没问出第三种问题）。
 * 目录那一级的比较做了大小写折叠 —— 那是**探针**的口径（Windows 不区分大小写），
 * 不是这一层的：这一层把 `%VAR%` 模板原样递出去，一个字符都不改。
 * ================================================================== */

/// 供本模块与 `view` 的单测共用的脚本化探针。
#[cfg(test)]
pub mod testing {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeSet;

    pub struct ScriptedProbe {
        pub commands: BTreeSet<String>,
        /// 存在的目录模板（比较时小写折叠，模拟 Windows 的不区分大小写）
        pub dirs: BTreeSet<String>,
        pub docker: Option<DockerCliOutcome>,
        pub asked_commands: RefCell<Vec<String>>,
        pub asked_dirs: RefCell<Vec<String>>,
        /// Docker 那次只读查询被问了几遍（TS 侧本机有进程级缓存，这一层没有 —— 允许 >1）
        pub docker_queries: RefCell<usize>,
    }

    impl ScriptedProbe {
        pub fn new(commands: &[&str], dirs: &[&str]) -> Self {
            ScriptedProbe {
                commands: commands.iter().map(|s| s.to_string()).collect(),
                dirs: dirs.iter().map(|s| s.to_lowercase()).collect(),
                docker: None,
                asked_commands: RefCell::new(Vec::new()),
                asked_dirs: RefCell::new(Vec::new()),
                docker_queries: RefCell::new(0),
            }
        }
        pub fn with_docker(mut self, outcome: DockerCliOutcome) -> Self {
            self.docker = Some(outcome);
            self
        }
        pub fn asked_commands(&self) -> Vec<String> {
            self.asked_commands.borrow().clone()
        }
        pub fn asked_dirs(&self) -> Vec<String> {
            self.asked_dirs.borrow().clone()
        }
        pub fn docker_query_count(&self) -> usize {
            *self.docker_queries.borrow()
        }
    }

    impl DetectorProbe for ScriptedProbe {
        fn command_available(&self, command: &str) -> bool {
            self.asked_commands.borrow_mut().push(command.to_string());
            self.commands.contains(command)
        }
        fn path_exists(&self, path_template: &str) -> bool {
            // 原样记账（证明模板没被这一层改写过），比较才折叠
            self.asked_dirs.borrow_mut().push(path_template.to_string());
            self.dirs.contains(&path_template.to_lowercase())
        }
        fn query_docker_disk_usage(&self) -> Option<DockerCliOutcome> {
            *self.docker_queries.borrow_mut() += 1;
            self.docker.clone()
        }
    }

    /// 只有两级能力面、**没有** Docker 查询那第三格的探针（TS 现有的三份假探针就是这个形状）。
    pub struct TwoLevelOnly(pub ScriptedProbe);
    impl DetectorProbe for TwoLevelOnly {
        fn command_available(&self, command: &str) -> bool {
            self.0.command_available(command)
        }
        fn path_exists(&self, path_template: &str) -> bool {
            self.0.path_exists(path_template)
        }
        // query_docker_disk_usage 用 trait 的默认实现 = None（没有这一能力面）
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{ScriptedProbe, TwoLevelOnly};
    use super::*;

    fn detector(id: &str) -> Detector {
        *dev_env_detectors()
            .iter()
            .find(|d| d.id == id)
            .unwrap_or_else(|| panic!("探测器表里没有 id={id}"))
    }

    // ---------- §4-B 的两级判据 ----------

    #[test]
    fn the_two_level_judgment_asks_every_command_and_dir() {
        // 不求短路：命令命中了也照样把每个目录问一遍。这条判据钉的是「这一层问了哪几件事」，
        // 短路实现下结论会随命令表顺序变，而界面那句「未检测到」的成因就查不出来了。
        let probe = ScriptedProbe::new(&["pip", "pip3"], &[r"%LOCALAPPDATA%\pip\Cache"]);
        let d = detector("pip");
        assert!(d.is_installed(&probe));
        assert_eq!(
            probe.asked_commands(),
            vec!["pip".to_string(), "pip3".to_string()],
            "两个命令都被问过（短路实现只会问第一个）"
        );
        assert_eq!(probe.asked_dirs(), vec![r"%LOCALAPPDATA%\pip\Cache".to_string()]);

        // 第一级已经命中，第二级仍然全问：npm 那两个目录一个都不在
        let probe2 = ScriptedProbe::new(&["npm"], &[]);
        assert!(detector("npm").is_installed(&probe2));
        assert_eq!(
            probe2.asked_dirs(),
            vec![r"%LOCALAPPDATA%\npm-cache".to_string(), r"%USERPROFILE%\.npm-global\cache".to_string()],
            "命令命中后仍把两个目录问完 = 判据可解释"
        );
    }

    #[test]
    fn command_hit_alone_counts_as_installed() {
        let probe = ScriptedProbe::new(&["gradle"], &[]);
        assert!(detector("gradle").is_installed(&probe));
    }

    #[test]
    fn dir_hit_alone_counts_as_installed() {
        // IDE 里跑过的构建不会往 PATH 放 gradle —— 两级取或就是为这种机器留的
        let probe = ScriptedProbe::new(&[], &[r"%USERPROFILE%\.gradle\caches"]);
        assert!(detector("gradle").is_installed(&probe));
    }

    #[test]
    fn both_levels_empty_is_not_installed() {
        let probe = ScriptedProbe::new(&[], &[]);
        assert!(!detector("maven").is_installed(&probe));
    }

    #[test]
    fn judgment_does_not_look_at_the_real_machine() {
        // **这一条是「判定层零文件」的行为证明**：同一张表、两个相反的假探针 → 两个相反的结论。
        // 结论只由注入的事实决定，所以换一台装了什么都不知道的操作员机器，判据结果不变。
        let installed = ScriptedProbe::new(&["mvn"], &[]);
        let absent = ScriptedProbe::new(&[], &[]);
        let d = detector("maven");
        assert!(d.is_installed(&installed));
        assert!(!d.is_installed(&absent));
        let a = collect_install_status(&installed, dev_env_detectors());
        let b = collect_install_status(&absent, dev_env_detectors());
        assert_eq!(a.get("maven"), Some(&true));
        assert_eq!(b.get("maven"), Some(&false));
        assert_ne!(a, b, "同一张表 + 两份相反的注入事实 = 两份相反的结论");
    }

    #[test]
    fn dir_templates_are_passed_out_verbatim_case_folding_is_the_probes_job() {
        // 探针那侧折叠大小写（Windows 口径），这一层一个字符都不改：
        // 夹具里给「大小写不同的同一路径」时，命中的是探针，不是判据偷偷做了归一。
        let probe = ScriptedProbe::new(&[], &[r"%localappdata%\PIP\cache"]);
        assert!(
            detector("pip").is_installed(&probe),
            "模板大小写不同也算命中（探针折叠），但递出去的串必须是探测器表里那一字"
        );
        assert_eq!(probe.asked_dirs(), vec![r"%LOCALAPPDATA%\pip\Cache".to_string()]);
    }

    #[test]
    fn install_status_keys_are_detector_ids_and_cover_all_nine() {
        let probe = ScriptedProbe::new(&["npm"], &[]);
        let table = collect_install_status_default(&probe);
        let mut ids: Vec<&str> = table.keys().map(|s| s.as_str()).collect();
        ids.sort();
        assert_eq!(
            ids,
            vec![
                "android-sdk",
                "gradle",
                "huggingface",
                "maven",
                "npm",
                "pip",
                "pnpm",
                "vscode",
                "yarn"
            ],
            "表里不许出现没有对应探测器的键（引擎按「缺 id 当已装」兜底，多写一个假 id 就永远兜不到）"
        );
        assert_eq!(table.get("npm"), Some(&true));
        assert_eq!(table.get("pnpm"), Some(&false));
        // **三态的第三格**：这张表本身是两态的，「不知道」住在「键不在」里。
        assert_eq!(table.get("docker"), None);
    }

    #[test]
    fn detector_for_rule_reverse_lookup() {
        let d = detector_for_rule("android-sdk-temp", dev_env_detectors()).expect("SDK 残留有人把关");
        assert_eq!(d.id, "android-sdk");
        assert!(detector_for_rule("windows-temp", dev_env_detectors()).is_none());
        // Docker 不把关任何规则：默认那张表反查不到它
        assert!(detector_for_rule("docker", dev_env_detectors()).is_none());
        let with_docker = detector_for_rule("npm-cache", dev_env_detectors_with_docker()).unwrap();
        assert_eq!(with_docker.id, "npm");
    }

    #[test]
    fn nine_detectors_guard_the_nine_tool_dependent_builtin_rules() {
        // 拿**真内置表**比，不看源码字符串：少把关一条就还是「没装也照样报缓存」
        let rules: Vec<String> = deepclean_rules::builtin_rules()
            .into_iter()
            .filter(|r| r.requires_detector.is_some())
            .map(|r| r.id)
            .collect();
        let mut guarded: Vec<String> = dev_env_detectors()
            .iter()
            .flat_map(|d| d.rule_ids.iter().map(|s| s.to_string()))
            .collect();
        guarded.sort();
        let mut expect = rules.clone();
        expect.sort();
        assert_eq!(guarded, expect, "探测器把关的规则与内置表声明的必须双向闭合");
        assert_eq!(rules.len(), 9);
        for rule in &rules {
            assert!(
                detector_for_rule(rule, dev_env_detectors()).is_some(),
                "规则 {rule} 声明了探测器却没人把关"
            );
        }
    }

    #[test]
    fn known_dir_templates_use_declared_env_keys_and_commands_are_bare_names() {
        // 变量名拼错会让第二级**永远**回答「不存在」，进而把真容量误判成未安装 —— 这条点名抓
        for d in dev_env_detectors_with_docker() {
            for dir in d.known_dirs {
                let var = dir
                    .strip_prefix('%')
                    .and_then(|s| s.split('\\').next())
                    .and_then(|s| s.strip_suffix('%'))
                    .unwrap_or_else(|| panic!("{} 的 knownDir 不是 %VAR% 模板：{dir}", d.id));
                assert!(
                    deepclean_rules::RULE_ENV_KEYS.contains(&var),
                    "{} 的模板用了没声明过的变量 {var}：{dir}",
                    d.id
                );
            }
            for c in d.commands {
                assert!(!c.contains('\\'), "{} 的命令带了路径：{c}", d.id);
                assert!(!c.contains('/'), "{} 的命令带了路径：{c}", d.id);
                assert!(!c.to_lowercase().ends_with(".exe"), "{} 的命令带了 .exe：{c}", d.id);
            }
        }
    }

    #[test]
    fn docker_detector_is_not_in_the_engine_table_but_is_in_the_full_picture() {
        assert!(!dev_env_detectors().iter().any(|d| d.id == "docker"));
        assert!(dev_env_detectors_with_docker().iter().any(|d| d.id == "docker"));
        // 裁定 1：Docker 的字节不许由 FS 目录推断 —— knownDirs 故意空
        assert!(DOCKER_DETECTOR.known_dirs.is_empty());
        assert!(DOCKER_DETECTOR.rule_ids.is_empty());
    }

    // ---------- Docker 的三格 ----------

    fn df_json(s: &str) -> DockerCliOutcome {
        DockerCliOutcome::Ok { stdout: s.to_string() }
    }

    #[test]
    fn modern_df_object_is_measured_with_named_categories() {
        let probe = ScriptedProbe::new(&[], &[]).with_docker(df_json(
            r#"{"Images":[{"Reclaimable":400}],"Containers":[{"Size":60}],"Volumes":[{"Size":240}]}"#,
        ));
        let u = read_docker_disk_usage(&probe);
        assert_eq!(u.verdict, DockerVerdict::Measured);
        assert_eq!(u.reclaimable_bytes, Some(700));
        assert_eq!(
            u.categories,
            vec![
                DockerUsageCategory { name: "images".into(), reclaimable_bytes: 400 },
                DockerUsageCategory { name: "containers".into(), reclaimable_bytes: 60 },
                DockerUsageCategory { name: "volumes".into(), reclaimable_bytes: 240 },
            ],
            "类目逐个点名，且顺序是 Images/Containers/Volumes"
        );
        assert_eq!(probe.asked_dirs().len(), 0, "容量来自 df，不来自摸目录");
    }

    #[test]
    fn legacy_human_readable_rows_use_the_same_caliber() {
        let probe = ScriptedProbe::new(&[], &[]).with_docker(df_json(
            r#"[{"Type":"Images","Reclaimable":"1.586MB"},{"Type":"Containers","Reclaimable":"1kB (1 of 2)"}]"#,
        ));
        let u = read_docker_disk_usage(&probe);
        assert_eq!(u.verdict, DockerVerdict::Measured);
        // 1.586MB = 1586000（1000 进制），1kB = 1000，尾注被丢掉
        assert_eq!(u.reclaimable_bytes, Some(1587000));
        assert_eq!(u.categories[0].name, "images", "类目名用 CLI 自己报的键的小写形式");
    }

    #[test]
    fn human_size_parsing_accepts_and_rejects_the_documented_shapes() {
        // 认得出的
        for (raw, want) in [
            ("0B", 0u64),
            ("1.586MB", 1_586_000),
            ("2.1 GiB", 2_254_857_830), // round(2.1 * 1024^3) = round(2254857830.4)
            ("44.99MB (3 of 7 images)", 44_990_000),
            ("1024", 1024),
            (" 12 kib ", 12_288),
        ] {
            assert_eq!(parse_human_bytes(raw), Some(want), "{raw} 应当读成 {want}");
        }
        // 认不出的**一律 None**，不许悄悄当 0
        for raw in ["", "-", "-5", "1e400x", "NaN", "5 xy", "Reclaimable: \"\"", "1.", "3 EB"] {
            assert_eq!(parse_human_bytes(raw), None, "认不出的串必须是 None：{raw:?}");
        }
        // 带 i 的是 1024 进制，不带的是 1000 进制 —— 两套不许互相冒充
        assert_eq!(parse_human_bytes("1 KB"), Some(1000));
        assert_eq!(parse_human_bytes("1 KiB"), Some(1024));
    }

    #[test]
    fn empty_stdout_bad_json_and_unreadable_category_are_all_unmeasurable_not_zero() {
        for stdout in [
            "   ",
            "not json at all",
            "null",
            "[]",
            r#"[{"Type":"Images","Reclaimable":"-"}]"#,
            r#"{"Images":[{"Reclaimable":-7}]}"#,
            r#"{"Containers":"不是数组"}"#,
            r#"{"Network":[]}"#,
        ] {
            let probe = ScriptedProbe::new(&["docker"], &[]).with_docker(df_json(stdout));
            let u = read_docker_disk_usage(&probe);
            assert_eq!(u.verdict, DockerVerdict::Unmeasurable, "{stdout:?} 必须判量不到");
            assert_eq!(u.reclaimable_bytes, None, "{stdout:?} 不许塌成 0");
            assert!(u.categories.is_empty());
            // 「量不到」也**不算**未安装：引擎那条轴不许被这一格摘掉地盘
            assert!(DOCKER_DETECTOR.is_installed(&probe));
        }
    }

    #[test]
    fn all_categories_reporting_zero_is_a_legitimate_measured_zero() {
        // 与「量不到」是两个不同的答案：这一格的 0 是测量结果
        let probe = ScriptedProbe::new(&[], &[]).with_docker(df_json(
            r#"{"Images":[{"Reclaimable":0}],"Containers":[],"Volumes":null}"#,
        ));
        let u = read_docker_disk_usage(&probe);
        assert_eq!(u.verdict, DockerVerdict::Measured);
        assert_eq!(u.reclaimable_bytes, Some(0));
        // Volumes 整个键为 null → 这一类**不进总数**，也不补 0；Containers 报了空数组 → 那格 0 是测出来的
        assert_eq!(u.categories.len(), 2);
        assert_eq!(u.categories[1].name, "containers");
    }

    #[test]
    fn absent_needs_both_enoent_and_the_where_counter_evidence() {
        // ENOENT 且 `where docker` 也说找不到 → absent（引擎那条轴只认这个）
        let probe = ScriptedProbe::new(&[], &[]).with_docker(DockerCliOutcome::CliMissing);
        let u = read_docker_disk_usage(&probe);
        assert_eq!(u.verdict, DockerVerdict::Absent);
        assert_eq!(u.reclaimable_bytes, None, "未安装也不许写成 0 字节");
        assert!(!DOCKER_DETECTOR.is_installed(&probe));

        // ENOENT 但 `where docker` 找得到（`.cmd` 垫片 / PATHEXT）→ 不许说未安装，降级成量不到
        let probe2 = ScriptedProbe::new(&["docker"], &[]).with_docker(DockerCliOutcome::CliMissing);
        let u2 = read_docker_disk_usage(&probe2);
        assert_eq!(u2.verdict, DockerVerdict::Unmeasurable);
        assert!(DOCKER_DETECTOR.is_installed(&probe2));
        assert!(u2.detail.contains("`.cmd` 垫片 / PATHEXT 这一类"), "detail 要交代为什么不说未安装");
    }

    #[test]
    fn timeout_and_cli_failure_are_neither_absent_nor_zero() {
        let p1 = ScriptedProbe::new(&[], &[]).with_docker(DockerCliOutcome::TimedOut);
        let u1 = read_docker_disk_usage(&p1);
        assert_eq!(u1.verdict, DockerVerdict::Unmeasurable);
        assert!(DOCKER_DETECTOR.is_installed(&p1));

        let p2 = ScriptedProbe::new(&[], &[]).with_docker(DockerCliOutcome::CliFailed {
            message: "Cannot connect to the Docker daemon".to_string(),
        });
        let u2 = read_docker_disk_usage(&p2);
        assert_eq!(u2.verdict, DockerVerdict::Unmeasurable);
        assert!(
            u2.detail.contains("CLI 返回：Cannot connect to the Docker daemon"),
            "daemon 没起那句话要留给用户看得见：detail 带上 CLI 的原文摘要"
        );
        // 空 message 不许留一对空括号
        let p3 = ScriptedProbe::new(&[], &[]).with_docker(DockerCliOutcome::CliFailed { message: String::new() });
        assert!(!read_docker_disk_usage(&p3).detail.contains("（）"));
    }

    #[test]
    fn a_probe_without_the_docker_capability_is_neither_absent_nor_zero() {
        // 这一格是留给「探针压根没这个能力面」的（两级假探针就是这个形状）。
        // 结论既不写 false（引擎那条轴会把地盘摘掉）也不写 0 —— 问不出 ≠ 没有。
        let probe = TwoLevelOnly(ScriptedProbe::new(&["npm"], &[]));
        let u = read_docker_disk_usage(&probe);
        assert_eq!(u.verdict, DockerVerdict::Unmeasurable);
        assert_eq!(u.reclaimable_bytes, None);
        assert!(DOCKER_DETECTOR.is_installed(&probe), "没有能力面 ≠ 未安装");
    }

    #[test]
    fn three_verdicts_are_the_only_answers_is_installed_can_give() {
        // 三格之外不许有第四种说法：is_installed 只能是布尔
        for outcome in [
            DockerCliOutcome::Ok { stdout: "[]".to_string() },
            DockerCliOutcome::CliMissing,
            DockerCliOutcome::TimedOut,
            DockerCliOutcome::CliFailed { message: "x".to_string() },
        ] {
            let probe = ScriptedProbe::new(&[], &[]).with_docker(outcome);
            let _: bool = DOCKER_DETECTOR.is_installed(&probe);
        }
    }

    #[test]
    fn df_is_asked_once_per_is_installed_call_at_this_layer() {
        // 这一层没有进程级缓存（缓存住在壳层，因为这里压根不起进程）——
        // 记下真实形状，免得有人把「问两次」读成 bug
        let probe = ScriptedProbe::new(&[], &[]).with_docker(df_json(r#"{"Images":[]}"#));
        assert!(DOCKER_DETECTOR.is_installed(&probe));
        assert_eq!(probe.docker_query_count(), 1);
    }
}
