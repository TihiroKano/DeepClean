//! `deepclean-appfacts` —— 「这台机器上到底装着什么」的**只读取证层**（M5-P2）。
//!
//! 产出 `候选目录名 → AppFact` 的三态表，注入给 `deepclean-rules` 的
//! `EvaluateOptions::app_facts`（`crates/rules/src/engine.rs:264`）。引擎那边**零文件系统**
//! （`crates/rules/src/lib.rs:4` 那句不变）：它只读这张表，不读注册表、不读盘、不起进程。
//! 所以「谁在什么时候证的据」全部住在这一个 crate 里，判据也全部住在这里。
//!
//! ## 判据：两半都成立才算 `Absent`（规格 §4.2 / 计划 §1.1）
//!
//! ```text
//!   有安装痕迹      C2 厂商顶层键 ∨ C6 开始菜单 .lnk ∨ 服务 ∨ 计划任务   （任一命中）
//! ∧ 无本体          C1 卸载表 ∧ C3 Appx 包 ∧ C4 安装目录 ∧ C5 进程      （四条都取证成功、且都没命中）
//! ```
//!
//! 任何一条通道**给不出证据**（未实现、枚举失败、权限拒、超时）→ `Unknown` + `why`。
//! 参考机自己证伪过三次「查无即残留」（规格 §4.2 那张表：Claude 是已装 MSIX、kazumi 在跑、
//! `urban-friendship-story` 里是游戏存档），所以这里**不是**「查无即残留」。
//!
//! ## `Unknown` 是默认，不是异常
//!
//! - `AppFact::Unknown` **必须带 `why`**：一个说不出理由的弃权与「这一格根本没填」在报告里
//!   长得一样，那是这条判据最贵的失效模式。唯一的构造子是 [`AppFact::unknown`]。
//! - 表里**没有这个键**也算 `Unknown`（[`fact_for_key`]），不算「可以删」。
//!   方向与 `detector_status` 那条「缺 id 当没装」相反：那边缺键多报，这边缺键**多删**。
//! - 计划 §0.1：宁可整台机器一条都不提议，也不许猜。
//!
//! ## 证据方向：Present 是单向的
//!
//! C3（`%LOCALAPPDATA%\Packages\*`）只当 **Present** 的证据，**绝不当 Absent 的证据**
//! —— MSIX 卸载后 `Packages` 可能留壳，「见不到」推不出任何东西（计划 §1.2）。
//! C6 只当**痕迹**，不当 Present（快捷方式在卸载后能留很久）。
//! 反过来也一样：本体四条全空 ≠ Present —— 证据缺失永远落 `Unknown`，不落任何一档。
//!
//! ## 输入全靠注入
//!
//! [`collect_app_facts`] 吃的是 [`ProbeInput`]：一张 [`ProbeRoots`]（文件系统根清单）、
//! 一份 [`registry::RegistrySnapshot`]（已经枚举完的注册表）、一份
//! [`procs::ProcessSnapshot`]（已经枚举完的进程表），加上调用方给的候选名。
//! 根由 [`ProbeRoots::from_env_vars`] 从**调用方递进来的环境变量表**推导。本 crate 的
//! `src/` 里没有一次真实环境读取、也没有一次进程创建：
//! - 环境变量表由壳层（`src-tauri/src/service.rs`，P2-T4 那一棒）采集后传进来；
//! - 注册表与进程表的**采集**（`registry::collect_*` / `procs::collect_process_snapshot`）
//!   是唯一的真机入口，且它们只被壳层调；判据层吃的是它们交出来的**数据**；
//! - 于是这一层的每条判据都能在一棵**假根目录树 + 一份假快照**上穷举，不碰这台机器。
//!
//! 这条边界决定了「全绿」这个词的意思：掺进一次真机读取，全绿就退化成「**这台**机器上全绿」。
//! 由 `tests/readonly.rs` 那道静态闸钉住写/删/建与 spawn 这条路。
//!
//! ## 六条通道都落地了（P2-T2 之后）
//!
//! | 通道 | 方向 | 实现 |
//! |---|---|---|
//! | C1 卸载表三根（HKLM 64 / HKLM WOW6432Node / HKCU） | Present | [`registry`] |
//! | C2 `SOFTWARE` 顶层厂商键 | 痕迹 | [`registry`] |
//! | C3 `%LOCALAPPDATA%\Packages\*` | Present（单向） | [`fs_probe`] |
//! | C4 安装根一级目录（含 §4.4 的额外根） | Present | [`fs_probe`] |
//! | C5 进程镜像路径 | Present | [`procs`] |
//! | C6 开始菜单 `.lnk`（递归 ≤ 2 层，只看文件名） | 痕迹 | [`fs_probe`] |
//!
//! P2-T1 那两个接缝 const（`PENDING_BODY_CHANNELS` / `PENDING_TRACE_CHANNELS`）已经删掉，
//! 于是 [`judge`] 的第 ② 步不再必然接住 —— **`Absent` 从这一棒起是可达的**。
//! 这正是计划 §0.2 那三个反例、以及 §4.4 那条硬判据从「结构上不可能」变成「必须被测试钉住」
//! 的原因：判据现在真的能给出删除建议，所以每一路取不到证据都只能老老实实弃权。
//!
//! ## §4.4 的反馈环（这条是 P2-T2 的硬判据，不是可选项）
//!
//! ```text
//!   C1 卸载表的 InstallLocation ──展开成绝对路径──▶ C4 的额外安装根
//! ```
//!
//! 参考机 85 条卸载项里一大半 `InstallLocation` 在 D 盘，默认三根（`Program Files` ×2 +
//! `<LOCALAPPDATA>\Programs`）**看不见**那些应用；少了本体证据 ⇒ 第 ④ 步会接住 ⇒
//! **多判 `Absent`（多删）**。落点在 [`roots_with_feedback`]，展不出绝对路径的那些
//! 进 [`channel::ChannelScan::gaps`]（按候选名收敛的盲区），不当「没有这条」。

#![deny(unsafe_code)]

use std::collections::BTreeMap;
use std::path::PathBuf;

pub mod channel;
pub mod fs_probe;
pub mod procs;
pub mod registry;

pub use channel::{name_matches, package_family, ChannelScan};

// ---------------------------------------------------------------- 表与三态

/// 一条应用事实。**三态不许塌成两态**（规格 §4.2）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppFact {
    /// 本体在场：C1/C3/C4/C5 任一条**本体**通道证出来了。
    Present,
    /// `有安装痕迹 ∧ 无本体` 两半都成立 —— **唯一**能提议删除的状态。
    Absent,
    /// 弃权。`why` 是「为什么没判」的原话，报告要点名它（[`AppFact::unknown`] 是唯一构造子）。
    Unknown { why: String },
}

impl AppFact {
    /// 构造一个弃权。**空 `why` 是缺陷**：debug 构建直接 panic，发布构建退化成一个
    /// 点名「探针自己没记理由」的占位串 —— 因为一个没有理由的 `Unknown` 在报告里
    /// 与「这一格没填」长得一样，而那正是这条判据最贵的失效模式。
    pub fn unknown(why: impl Into<String>) -> Self {
        let raw = why.into();
        let why = if raw.trim().is_empty() {
            debug_assert!(false, "Unknown 必须带 why（计划 §1.1：弃权要能说出为什么没判）");
            "弃权理由缺失：探针没有记录是哪一路取不到证据 —— 按最保守档处理，不提议".to_string()
        } else {
            raw
        };
        AppFact::Unknown { why }
    }

    /// 弃权理由（`Present`/`Absent` 没有理由可说，返回 `None`）。
    pub fn why(&self) -> Option<&str> {
        match self {
            AppFact::Unknown { why } => Some(why),
            _ => None,
        }
    }

    /// 只有这一档能进 `orphan-app-data` 的采集面（P2-T3 在引擎侧读它）。
    pub fn is_absent(&self) -> bool {
        matches!(self, AppFact::Absent)
    }
}

/// 注入给引擎的那张表。key = **候选目录 basename 的小写**，与
/// `crates/rules/src/engine.rs:464` 的 `base_name(dir).to_lowercase()` 同口径 ——
/// 两侧对不上就等于表里永远缺键，而缺键在这边是「不删」，静默且无害，所以更要在这里钉住。
pub type AppFactsTable = BTreeMap<String, AppFact>;

/// 归一化候选目录名成表 key。给绝对路径也接（取最后一段），免得调用方各写一份切法。
pub fn fact_key(candidate: &str) -> String {
    candidate
        .replace('/', "\\")
        .split('\\')
        .filter(|s| !s.is_empty())
        .next_back()
        .unwrap_or_default()
        .to_lowercase()
}

/// 查表。**缺键 = `Unknown`**（带 why），不是「没有这条事实所以可以删」。
pub fn fact_for_key(table: &AppFactsTable, candidate: &str) -> AppFact {
    let key = fact_key(candidate);
    table.get(&key).cloned().unwrap_or_else(|| {
        AppFact::unknown(format!(
            "机器事实表里没有「{key}」这个键（取候选目录 basename 小写）—— 采集时没把这个目录交给探针，\
             而缺键不等于「已卸载」：两半一条都没证过"
        ))
    })
}

// ---------------------------------------------------------------- 通道与取证结果

/// 证据通道清单（计划 §1.3 的 C1–C6）。名字里带编号，好让 `why` 串能直接点名是哪一路。
pub const CH_UNINSTALL: &str = "C1 卸载表三根（HKLM 64/32 + HKCU）";
pub const CH_VENDOR_KEYS: &str = "C2 SOFTWARE 顶层厂商键";
pub const CH_PACKAGES: &str = "C3 %LOCALAPPDATA%\\Packages 包目录";
pub const CH_INSTALL_ROOTS: &str = "C4 安装根一级目录";
pub const CH_PROCESSES: &str = "C5 进程镜像路径";
pub const CH_START_MENU: &str = "C6 开始菜单 .lnk 文件名";

/// 「无本体」这一半需要**逐条证完**的四条通道。
pub const BODY_CHANNELS: [&str; 4] = [CH_UNINSTALL, CH_PACKAGES, CH_INSTALL_ROOTS, CH_PROCESSES];
/// 「有安装痕迹」这一半的通道（服务注册 / 计划任务还没进通道表，P2-T3 之后补）。
pub const TRACE_CHANNELS: [&str; 2] = [CH_VENDOR_KEYS, CH_START_MENU];

/// 单条通道的取证结果。**三态，不可塌成两态**：
/// 「证完了、确实没有」与「没证、不知道」是两句话（`devenv` 那侧同一条纪律）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// 通道跑成功了，这个候选没命中 —— 「无本体」需要的正是这种**证出来的没有**。
    CheckedNoHit,
    /// 取到了指向这个候选的证据，串里点名是哪一路的哪个条目。
    Hit(String),
    /// 给不出证据：未实现、根没配上、枚举失败、权限拒。`why` 非空是硬约束。
    Unavailable(String),
}

impl Probe {
    fn unavailable_why(&self) -> Option<&str> {
        match self {
            Probe::Unavailable(w) => Some(w.as_str()),
            _ => None,
        }
    }
}

/// 一条通道 + 它的取证结果（`why` 要能点名到通道，所以不能只存一串）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelProbe {
    pub channel: &'static str,
    pub probe: Probe,
}

impl ChannelProbe {
    pub fn new(channel: &'static str, probe: Probe) -> Self {
        Self { channel, probe }
    }
}

/// 一个候选的完整证据包：本体四条 + 痕迹若干。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CandidateEvidence {
    /// 本体通道（C1/C3/C4/C5）。
    pub body: Vec<ChannelProbe>,
    /// 痕迹通道（C2/C6，以及未来的服务 / 计划任务）。
    pub traces: Vec<ChannelProbe>,
}

/// **判据本体**（规格 §4.2 的那段伪码）。纯函数：只吃 [`CandidateEvidence`]，不碰盘。
///
/// 四步的顺序就是判据的顺序，不可调：
/// 1. 本体任一路命中 → `Present`（痕迹命中**不**参与这一步：快捷方式证不出「还在」）；
/// 2. 本体或痕迹任一路**取不到证据** → `Unknown` + 逐条点名 —— 这一轮的所有弃权都从这里出；
/// 3. 两半都取证成功、但一条痕迹都没有 → `Unknown`：「这台机器装过它」证不出来，
///    也就无从谈「残留」（方向同 §0.1）；
/// 4. 痕迹命中 ∧ 本体四条全部 [`Probe::CheckedNoHit`] → `Absent`。
pub fn judge(ev: &CandidateEvidence) -> AppFact {
    // ① 本体证据优先。
    if ev
        .body
        .iter()
        .any(|c| matches!(c.probe, Probe::Hit(_)))
    {
        return AppFact::Present;
    }

    // ② 任一路取不到证据 → 弃权，把取不到的那几条**逐一点名**（不许合并成一句「不确定」）。
    let missing: Vec<String> = ev
        .body
        .iter()
        .chain(ev.traces.iter())
        .filter_map(|c| {
            c.probe
                .unavailable_why()
                .map(|w| format!("{}：{w}", c.channel))
        })
        .collect();
    if !missing.is_empty() {
        return AppFact::unknown(format!(
            "「有安装痕迹 ∧ 无本体」这两半里有一条取不到证据 → {}",
            missing.join("；")
        ));
    }

    // ③ 没有痕迹：装过都证不出来，判不出残留。
    let trace_hits: Vec<&str> = ev
        .traces
        .iter()
        .filter_map(|c| match &c.probe {
            Probe::Hit(_) => Some(c.channel),
            _ => None,
        })
        .collect();
    if trace_hits.is_empty() {
        return AppFact::unknown(
            "本体四条通道都取证成功且全部没有命中，但安装痕迹一条都没有（查过的痕迹只有 C2 厂商顶层键与 C6 开始菜单快捷方式这两路，都没命中）——\
             「这台机器装过它」证不出来，两半只成立了一半，按弃权处理：无痕迹最可能的解释是探针\
             的覆盖面不够，而不是这个目录是残留"
                .to_string(),
        );
    }

    // ④ 两半都成立 —— 唯一能提议删除的那一档。
    AppFact::Absent
}

// ---------------------------------------------------------------- 根清单（全靠注入）

/// 一个候选目录（计划 §1.1 的采集根直属子目录名）。
///
/// 太短的候选名会让「双向包含」这条匹配口径吞掉一切（计划 §4.1 点名的正是这件事），
/// 于是这种名字**一条通道都不许给结论** —— 见 [`evidence_of_ambiguous_key`]。
pub const MIN_MATCHABLE_KEY_CHARS: usize = 3;

/// 候选名能不能拿去做子串匹配。不可匹配 → 全通道 [`Probe::Unavailable`] → `Unknown`。
pub fn is_matchable_key(key: &str) -> bool {
    key.chars().count() >= MIN_MATCHABLE_KEY_CHARS
}

/// 一个**取不到任何证据**的证据包：每条通道都带同一句 why。
/// 给「候选名太泛 / 太短」这种「拿不到归属」的情况用（计划 §4.1：`YLH` / `sand` 一律 `Unknown`）。
pub fn evidence_of_ambiguous_key(why: &str) -> CandidateEvidence {
    let mk = |channels: &[&'static str]| -> Vec<ChannelProbe> {
        channels
            .iter()
            .map(|c| ChannelProbe::new(c, Probe::Unavailable(why.to_string())))
            .collect()
    };
    CandidateEvidence {
        body: mk(&BODY_CHANNELS),
        traces: mk(&TRACE_CHANNELS),
    }
}

/// 一个安装根。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallRoot {
    pub path: PathBuf,
    /// **计划 §4.4 的额外根**（由卸载表的 `InstallLocation` 反推、或配置追加的那些）。
    ///
    /// 默认三根（`Program Files` ×2 + `%LOCALAPPDATA%\Programs`）只覆盖装在那里的应用；
    /// 装在 `D:\Browser\Claude` 这种自定义根上的，一级目录枚举**看不见**，
    /// 于是 C4 会给出「证完了、没有本体」—— 那正是把活应用判成残留的那一半。
    /// 额外根的语义是「调用方**指名**这就是某个应用的安装位置」，所以除了一级目录，
    /// 根自己的 basename 也算本体证据。方向是 Present（少删），不会造出误杀。
    pub extra: bool,
}

impl InstallRoot {
    pub fn standard(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), extra: false }
    }
    pub fn extra(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), extra: true }
    }
}

/// 三条文件系统通道的根清单。**全部由调用方给**：本 crate 不读真实环境变量（模块文档那句）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeRoots {
    /// C3：MSIX 包目录容器（通常是 `<LOCALAPPDATA>\Packages`）。`None` = 推导不出来 → 通道弃权。
    pub packages: Option<PathBuf>,
    /// C4：安装根清单（[`ProbeRoots::standard_install_roots`] + §4.4 的额外根）。
    pub install_roots: Vec<InstallRoot>,
    /// C6：开始菜单根（用户 + 公共两条）。
    pub start_menu_roots: Vec<PathBuf>,
}

impl ProbeRoots {
    /// 从**注入的环境变量表**推导默认根（键按 Windows 口径大小写不敏感查）。
    ///
    /// 表由壳层采集（P2-T4 的 `service.rs`）。测试传一张假表，于是这一层永远只在
    /// 调用方给的树上跑 —— 不碰这台机器。
    /// 缺变量**不回落真机**：对应的那条根交不出去，通道落 `Unavailable`。
    pub fn from_env_vars(env: &BTreeMap<String, String>) -> Self {
        let local = lookup_env(env, "LOCALAPPDATA").map(PathBuf::from);
        // `%LOCALAPPDATA%\Programs`：VS Code / Slack 那类用户级安装的位置。
        let mut install_roots: Vec<InstallRoot> = local
            .as_ref()
            .map(|p| vec![InstallRoot::standard(p.join("Programs"))])
            .unwrap_or_default();
        // 缺变量**不回落真机**：那一条根交不出去，通道落 Unavailable（口径同 crates/rules/src/env.rs 的 unresolved-env）。
        for v in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
            if let Some(p) = lookup_env(env, v) {
                install_roots.push(InstallRoot::standard(p));
            }
        }
        let mut start_menu_roots: Vec<PathBuf> = Vec::new();
        let sm = |base: Option<String>| -> Option<PathBuf> {
            base.map(|p| {
                PathBuf::from(p)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs")
            })
        };
        for v in ["ProgramData", "APPDATA"] {
            if let Some(p) = sm(lookup_env(env, v)) {
                start_menu_roots.push(p);
            }
        }
        let mut roots = Self {
            packages: local.as_ref().map(|p| p.join("Packages")),
            install_roots,
            start_menu_roots,
        };
        roots.dedup_roots();
        roots
    }

    pub fn push_standard(&mut self, path: impl Into<PathBuf>) {
        self.install_roots.push(InstallRoot::standard(path));
    }

    /// **§4.4 的硬判据**：追加一个自定义安装根（卸载表 `InstallLocation` 反推出来的那些）。
    pub fn push_extra_install_root(&mut self, path: impl Into<PathBuf>) {
        self.install_roots.push(InstallRoot::extra(path));
    }

    fn dedup_roots(&mut self) {
        let mut seen: Vec<PathBuf> = Vec::new();
        self.install_roots.retain(|r| {
            let p = r.path.clone();
            if seen.contains(&p) {
                false
            } else {
                seen.push(p);
                true
            }
        });
        let mut seen2: Vec<PathBuf> = Vec::new();
        self.start_menu_roots.retain(|p| {
            if seen2.contains(p) {
                false
            } else {
                seen2.push(p.clone());
                true
            }
        });
    }
}

/// 环境变量查表：**大小写不敏感**（与 `crates/rules/src/env.rs:46` 的 `lookup_env` 同口径）。
pub fn lookup_env(env: &BTreeMap<String, String>, name: &str) -> Option<String> {
    let upper = name.to_uppercase();
    env.iter()
        .find(|(k, _)| k.to_uppercase() == upper)
        .map(|(_, v)| v.clone())
}

// ---------------------------------------------------------------- 采集

/// 六条通道的取证结果，一次采集跑完（每条通道只枚举一遍 —— 计划 §2.7
/// 「一次扫描只采一次」在这层的投影）。
///
/// key = 通道名（[`CH_UNINSTALL`] … [`CH_START_MENU`]）。**这张表是判据层与采集层之间
/// 唯一的接缝**：[`FactScan::probe_for`] 对没在表里的通道一律交 [`Probe::Unavailable`]，
/// 于是「这条通道忘了接」与「这条通道跑失败了」在判据眼里同向 —— 都是弃权，都不许被
/// 读成「看过了，这里没有本体」。那条兜底分支由
/// `fs_probe::tests::an_unregistered_channel_never_reports_checked_no_hit` 钉住。
#[derive(Debug, Clone, Default)]
pub struct FactScan {
    pub channels: BTreeMap<&'static str, ChannelScan>,
}

impl FactScan {
    /// 把三条 FS 通道 + 注册表两路 + 进程一路并成一张表（**不含** §4.4 的反馈；
    /// 那一步在 [`roots_with_feedback`]，因为它要改的是 C4 的根清单）。
    pub fn from_parts(fs: &fs_probe::FsScan, registry: &registry::RegistrySnapshot, procs: &procs::ProcessSnapshot) -> Self {
        let mut channels = fs.channels.clone();
        channels.insert(CH_UNINSTALL, registry::uninstall_scan(registry));
        channels.insert(CH_VENDOR_KEYS, registry::vendor_key_scan(registry));
        channels.insert(CH_PROCESSES, procs::process_scan(procs));
        Self { channels }
    }

    pub fn insert(&mut self, channel: &'static str, scan: ChannelScan) {
        self.channels.insert(channel, scan);
    }

    /// 一条通道对一个候选的取证结果。没跑过的通道 = 弃权（见 [`FactScan`] 的文档）。
    pub fn probe_for(&self, channel: &'static str, key: &str) -> Probe {
        match self.channels.get(channel) {
            Some(cs) => cs.probe(key),
            // 兜底方向必须是弃权：未采集又没有结果 —— 不能替它作「这里没有本体」证。
            None => Probe::Unavailable(format!(
                "内部缺陷：通道「{channel}」没有取证结果 —— 采集侧没接上，绝不等于「看过了、没有」"
            )),
        }
    }

    /// 组装一个候选的完整证据包（本体四条 + 痕迹两条）。
    pub fn evidence_for(&self, key: &str) -> CandidateEvidence {
        if !is_matchable_key(key) {
            return evidence_of_ambiguous_key(&format!(
                "候选名「{key}」只有 {n} 个字符（双向包含的匹配口径要求 ≥ {MIN_CHARS} 个）—— \
                 这么短的名字会被匹配到几乎一切身上，这种身份不明的名字计划 §4.1 定的是一律弃权：\
                 它既当不了本体证据，也当不了痕迹证据，两半都成立不了",
                n = key.chars().count(),
                MIN_CHARS = MIN_MATCHABLE_KEY_CHARS,
            ));
        }
        CandidateEvidence {
            body: BODY_CHANNELS
                .iter()
                .map(|c| ChannelProbe::new(c, self.probe_for(c, key)))
                .collect(),
            traces: TRACE_CHANNELS
                .iter()
                .map(|c| ChannelProbe::new(c, self.probe_for(c, key)))
                .collect(),
        }
    }

    /// 对每个候选出表（`judge` 那一侧的纯函数；表 key 见 [`fact_key`]）。
    pub fn collect(&self, candidates: &[String]) -> AppFactsTable {
        let mut table = AppFactsTable::new();
        for c in candidates {
            let key = fact_key(c);
            if key.is_empty() {
                continue;
            }
            let ev = self.evidence_for(&key);
            table.insert(key, judge(&ev));
        }
        table
    }
}

/// 一次采集的**全部注入面**（P2-T4 的壳层负责填这三格，判据层一次都不自己去看）。
#[derive(Debug, Clone, Default)]
pub struct ProbeInput {
    /// C3/C4/C6 的根清单（§4.4 的额外根由 [`roots_with_feedback`] 追加，不必由调用方知道）。
    pub roots: ProbeRoots,
    /// C1/C2 的证据：注册表**已经枚举完**的快照（[`registry::collect_snapshot`] 的产物）。
    pub registry: registry::RegistrySnapshot,
    /// C5 的证据：进程表**已经枚举完**的快照（[`procs::collect_process_snapshot`] 的产物）。
    pub processes: procs::ProcessSnapshot,
    /// 推导根清单时用的那张环境变量表（`InstallLocation` 里的 `%VAR%` 靠它展开，
    /// 于是本 crate 仍然一次都不读真实环境）。
    pub env: BTreeMap<String, String>,
}

/// **计划 §4.4 的反馈环**：把 C1 卸载表的 `InstallLocation` 追加成 C4 的额外安装根。
///
/// 少这一步 ⇒ 装在 `D:\…` 这类自定义根上的应用拿不到本体证据 ⇒ 判出 `Absent` ⇒ 多删。
/// 展不出绝对路径的那些**不静默丢弃**：它们进 C4 的 `gaps`（见 [`channel::ChannelScan::gaps`]）。
pub fn roots_with_feedback(roots: &ProbeRoots, snap: &registry::RegistrySnapshot, env: &BTreeMap<String, String>) -> ProbeRoots {
    let mut out = roots.clone();
    for p in registry::extra_install_locations(snap, env) {
        out.push_extra_install_root(p);
    }
    out.dedup_roots();
    out
}

/// 全通道采集：C1/C2（注册表）+ C3/C4/C6（文件系统，含 §4.4 反馈）+ C5（进程表）。
pub fn scan_all(input: &ProbeInput) -> FactScan {
    let roots = roots_with_feedback(&input.roots, &input.registry, &input.env);
    let mut scan = FactScan::from_parts(&fs_probe::scan(&roots), &input.registry, &input.processes);
    // 盲区跟着反馈走：只有真的「拿一条 InstallLocation 去定位却没定位成」才留盲区。
    let gaps = registry::unresolvable_install_locations(&input.registry, &input.env);
    if let Some(cs) = scan.channels.get_mut(CH_INSTALL_ROOTS) {
        cs.gaps = gaps;
    }
    scan
}

/// **采集入口**：跑六条通道，对每个候选名出表。
///
/// 一次扫描只该调一次（计划 §2.7：进程表与注册表都是瞬时状态，两份报告不能拿两份事实）——
/// 这条纪律住在调用方，这里只保证**同一次调用内**每条通道只枚举一遍。
///
/// 表里现在交得出 `Absent` 了（P2-T1 交不出，因为三条通道没实现）。所以这一格的正确性
/// 完全由「任一路取不到证据 ⇒ 第 ② 步先接住」这条顺序保证，判据见 [`judge`]。
pub fn collect_app_facts(candidates: &[String], input: &ProbeInput) -> AppFactsTable {
    scan_all(input).collect(candidates)
}

/// 采集 + 出报告的形状：把表里每一格的 `why` 摊平成一行行文本，给 P2-T4 的验收文档用。
/// 这一层先有，是因为「弃权必须说得出理由」这条纪律最好在**生产它的那一侧**就有出口。
pub fn abstain_report(table: &AppFactsTable) -> Vec<String> {
    let mut out = Vec::new();
    for (key, fact) in table {
        if let Some(why) = fact.why() {
            out.push(format!("{key}\t{why}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cp(channel: &'static str, probe: Probe) -> ChannelProbe {
        ChannelProbe::new(channel, probe)
    }

    /// 把四条本体通道全设成「证完了、没有」。
    fn body_all_clear() -> Vec<ChannelProbe> {
        BODY_CHANNELS
            .iter()
            .map(|c| cp(*c, Probe::CheckedNoHit))
            .collect()
    }

    /// T2 之后的形状：六条通道**逐条证过**才轮到 Absent（P2-T1 那两个接缝 const 已删）。
    fn body_all_evidenced() -> Vec<ChannelProbe> {
        BODY_CHANNELS
            .iter()
            .map(|c| cp(*c, Probe::CheckedNoHit))
            .collect()
    }

    #[test]
    fn fact_key_matches_the_engines_basename_rule() {
        assert_eq!(fact_key("Claude"), "claude");
        assert_eq!(fact_key(r"C:\Users\x\AppData\Roaming\Claude"), "claude");
        assert_eq!(fact_key("C:/Users/x/AppData/Local/Packages/"), "packages");
        assert_eq!(fact_key(r"com.flutter.kazumi_wbnnev551gwxy"), "com.flutter.kazumi_wbnnev551gwxy");
        assert_eq!(fact_key(""), "");
        assert_eq!(fact_key(r"C:\"), "c:");
    }

    #[test]
    fn a_missing_key_is_unknown_not_absent() {
        let table: AppFactsTable = BTreeMap::new();
        let fact = fact_for_key(&table, r"C:\Users\x\AppData\Roaming\Ghost");
        let AppFact::Unknown { why } = &fact else {
            panic!("缺键必须落 Unknown，实际 {fact:?}");
        };
        assert!(!why.trim().is_empty(), "缺键的弃权也要带 why");
        assert!(why.contains("ghost"), "why 要点名到那个键：{why}");
        assert!(!fact.is_absent());
    }

    #[test]
    fn an_unknown_always_carries_a_non_empty_why() {
        // 唯一构造子的纪律：一个**没有理由**的弃权不许静默出厂。
        assert_eq!(AppFact::unknown("C1 取不到").why(), Some("C1 取不到"));
        assert!(AppFact::Present.why().is_none());
        assert!(AppFact::Absent.why().is_none());

        let built = std::panic::catch_unwind(|| AppFact::unknown("   "));
        match built {
            // debug 构建（cargo test 走的就是这一支）：空白 why 直接炸 —— 这就是「闸会红」的那一半。
            #[cfg(debug_assertions)]
            Err(_) => {}
            #[cfg(not(debug_assertions))]
            Err(_) => panic!("发布构建不该 panic，该交点名「探针没记理由」的占位串"),
            // 发布构建：退化成一个非空的占位理由，仍然说不出「为什么没判」这件事本身。
            Ok(fact) => {
                let why = fact.why().unwrap();
                assert!(!why.trim().is_empty(), "发布构建也不许交出空白 why");
                assert!(why.contains("理由缺失"), "占位串要自我点名：{why}");
            }
        }
    }

    #[test]
    fn judge_step_two_beats_step_four_when_a_channel_is_unavailable() {
        // 判据顺序本身也要钉住：痕迹齐、本体三条清、一条 Unavailable → Unknown，不是 Absent。
        let ev = CandidateEvidence {
            body: vec![
                cp(CH_UNINSTALL, Probe::CheckedNoHit),
                cp(CH_PACKAGES, Probe::CheckedNoHit),
                cp(CH_INSTALL_ROOTS, Probe::CheckedNoHit),
                cp(CH_PROCESSES, Probe::Unavailable("权限拒".into())),
            ],
            traces: vec![
                cp(CH_VENDOR_KEYS, Probe::Hit("HKLM\\SOFTWARE\\Acme".into())),
                cp(CH_START_MENU, Probe::CheckedNoHit),
            ],
        };
        let AppFact::Unknown { why } = judge(&ev) else {
            panic!("任一路取不到证据必须弃权：{:?}", judge(&ev));
        };
        assert!(why.contains(CH_PROCESSES), "why 要点名是哪一路：{why}");
    }

    #[test]
    fn judge_marks_absent_only_when_both_halves_hold() {
        let ev = CandidateEvidence {
            body: body_all_clear(),
            traces: vec![
                cp(CH_VENDOR_KEYS, Probe::CheckedNoHit),
                cp(CH_START_MENU, Probe::Hit("Acme 控制台.lnk".into())),
            ],
        };
        assert_eq!(judge(&ev), AppFact::Absent);
    }

    #[test]
    fn a_channel_with_no_result_is_never_read_as_checked_and_empty() {
        // P2-T1 的接缝（那两个 PENDING_* const）删掉之后，「这条通道没接上」这条防线
        // 不能跟着消失 —— 它换成了 FactScan 的兜底分支：表里没有这一路 ⇒ Unavailable。
        let scan = FactScan::default();
        for ch in BODY_CHANNELS.iter().chain(TRACE_CHANNELS.iter()) {
            assert!(
                matches!(scan.probe_for(ch, "claude"), Probe::Unavailable(_)),
                "空表把没采集的通道「{ch}」读成了「看过了、这里没有」：{:?}",
                scan.probe_for(ch, "claude")
            );
        }
        // 整条链路同向：一张空的 FactScan 对任何候选都交不出 Absent，也交不出 Present。
        let table = scan.collect(&["claude".to_string(), "kazumi".to_string()]);
        for (key, fact) in &table {
            assert!(matches!(fact, AppFact::Unknown { .. }), "「{key}」应为弃权：{fact:?}");
            assert!(fact.why().unwrap().contains(key) || fact.why().unwrap().contains("通道"), "弃权要说出为什么：{key}");
        }
    }

    #[test]
    fn absent_is_reachable_now_that_six_channels_are_wired() {
        // P2-T1 那句「结构上到不了 Absent」作废：六条通道都在表里、且逐条证完 ⇒ Absent。
        // 这条测的是**接缝已闭**，不是「Absent 常见」——它仍然要求痕迹 + 四条本体全部取证成功。
        let mut scan = FactScan::default();
        for ch in BODY_CHANNELS.iter() {
            scan.insert(ch, ChannelScan::default()); // 有结果、没命中（roots 由采集侧配）
        }
        for ch in TRACE_CHANNELS.iter() {
            scan.insert(ch, ChannelScan::default());
        }
        // 没配根的通道仍然只能弃权：roots_configured == 0 那一档必须先接住。
        let not_yet = scan.collect(&["ghost".to_string()]);
        assert!(
            !not_yet["ghost"].is_absent(),
            "「有一条结果但一个根都没配」被当成证完了：{:?}",
            not_yet["ghost"]
        );
        // 补齐成「每条都跑过、每条都没命中」+ 一条痕迹 ⇒ 这一格才是 Absent。
        let ev = CandidateEvidence {
            body: body_all_evidenced(),
            traces: vec![
                cp(CH_VENDOR_KEYS, Probe::Hit("HKLM\\SOFTWARE\\Acme".into())),
                cp(CH_START_MENU, Probe::CheckedNoHit),
            ],
        };
        assert_eq!(judge(&ev), AppFact::Absent, "接缝闭了，两半都成立就该给出 Absent");
    }

    /// **主会话裁定（plan `2026-10-13-deepclean-tauri-m5-p2.md` §5 末，P2-T2 遗留分歧 (b)）在产品侧的那一格。**
    /// 一条 `InstallLocation` 恰好等于某个标准根时（MSI 的脏值就这么写），`dedup_roots()` 留的是
    /// **先插入的那一份**：标准根由 `from_env_vars` 先入、额外根由 `roots_with_feedback` 后 push，
    /// 于是活下来的那份 `extra = false` ⇒ 标准根的 basename（`Program Files`）不算本体证据 ——
    /// 否则**每一个**装在 `C:\Program Files\Foo` 的应用都凭空拿到这个 token（把 Present 判宽），
    /// 反过来也让"标准根本身"被当成某个同名应用的安装位置。
    ///
    /// 基准侧的孪生用例：`tests/unit/appfacts.test.ts::a_standard_root_basename_is_not_body_evidence_p2_t3_ruling`。
    /// 这一条**不改任何行为**（Rust 从来就是这个形状），它只是把裁定里"以 Rust 为准"那句
    /// 从注释升级成断言 —— 缺了这一格，"TS 补 dedup 对齐 Rust"就只有一侧在钉。
    #[test]
    fn an_install_location_equal_to_a_standard_root_collapses_into_that_standard_root() {
        let mut env: BTreeMap<String, String> = BTreeMap::new();
        env.insert("LOCALAPPDATA".into(), r"C:\Users\k\AppData\Local".into());
        env.insert("ProgramFiles".into(), r"C:\Program Files".into());
        env.insert(r"ProgramFiles(x86)".into(), r"C:\Program Files (x86)".into());
        let mut roots = ProbeRoots::from_env_vars(&env);
        // 逐字相等的那一条（大小写也一样 —— `dedup_roots` 比的是 `PathBuf`，不做大小写/分隔符归一）
        roots.push_extra_install_root(r"C:\Program Files");
        // 不相等的那一条：§4.4 反推出来的自定义根，必须原样留着 `extra = true`
        roots.push_extra_install_root(r"D:\Software\Claude");
        roots.dedup_roots();

        let same: Vec<&InstallRoot> = roots
            .install_roots
            .iter()
            .filter(|r| r.path == PathBuf::from(r"C:\Program Files"))
            .collect();
        assert_eq!(
            same.len(),
            1,
            "相等的那条额外根没被去重成「那份标准根」：{:?}",
            roots.install_roots
        );
        assert!(
            !same[0].extra,
            "活下来的那份必须 extra=false，否则标准根的 basename 就成了本体证据：{:?}",
            roots.install_roots
        );
        let custom = roots
            .install_roots
            .iter()
            .find(|r| r.path == PathBuf::from(r"D:\Software\Claude"))
            .unwrap_or_else(|| panic!("自定义 InstallLocation 那条被误伤了 —— §4.4 的反馈环是少删方向：{:?}", roots.install_roots));
        assert!(custom.extra, "不相等的那一条必须仍是额外根：{:?}", roots.install_roots);

        // 反向半边：「留第一份」是这条函数的全部语义，不是「标准根优先」那种按值改写 ——
        // 额外根先入时活下来的就是 `extra = true` 那一份。钉住这一格，哪天有人把它"顺手改聪明"
        // （按 extra 排序去重、或大小写归一），当场红。
        let mut flipped = ProbeRoots::default();
        flipped.push_extra_install_root(r"C:\Program Files");
        flipped.push_standard(r"C:\Program Files");
        flipped.dedup_roots();
        assert_eq!(flipped.install_roots.len(), 1, "{:?}", flipped.install_roots);
        assert!(
            flipped.install_roots[0].extra,
            "去重按插入次序留第一份，不许按 extra 的高低重写：{:?}",
            flipped.install_roots
        );
    }
}
