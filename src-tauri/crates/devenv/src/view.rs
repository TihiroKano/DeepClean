//! §3.6「开发环境」页的视图判据 —— TS `core/rules/devenv-view.ts` 的逐字对应移植。
//!
//! **纯函数，零文件、零进程、零环境读取**。这个文件存在的唯一理由：把「哪一行允许出现哪种控件」
//! 做成**数据**，而不是渲染层的自觉。三条硬要求（AI 模型行不给「全选本组」、Docker 行不给任何能
//! 触发删除的控件、未安装要念「未检测到」而不是 0 B）一旦写成界面里的 `if`，就变成了
//! 「下一个改界面的人看不见的那条规矩」；放在这里，界面只负责把算好的 `actions` 照画。
//!
//! ## 三态不许塌成两态（这一版的口径）
//!
//! `install_state` 有三格，`display_bytes` 另有 `None`，`territory_missing` 又是第三种 0 ——
//! 界面那五句话的**先后顺序**是 V0.7 定过的（`docs/acceptance/2026-10-07-v0.7-devenv.md` 未完 #4）：
//!
//! ```text
//! 「未检测到该工具」 > 「不确定装没装」 > 「这棵树上没有它的地盘」 > 「这次没量到」 > 数字
//! ```
//!
//! 顺序住在 `src/renderer/pages/DevEnv.tsx` 的 `devEnvBytesText` 那条 `if` 链上（界面不改），
//! 但**它每往后退一格，都必须有一格数据可退**。所以这一层要守的是：任何一格的缺席都不许被
//! 写成另一格的结论。塌成一态就是让「没量过」冒充「没有」。
//!
//! 三条各自的落点：
//! - `excluded_from_default_selection`（§3.5，声明在 registry）→ 这一行拿不到 `group-select-all`。
//! - Docker 不在内置规则表里，所以它的行是**合成**的，动作固定只有 `view` + `prune-hint` ——
//!   结构上写不出删除控件，而不是「UI 少画一个」。
//! - `install_state != installed` 时 `display_bytes` 恒为 `None`：0 B 会被读成「这个工具没缓存」，
//!   而事实是「没探测到它装没装」。这两句话在界面上必须是两种话。

use crate::detectors::DockerDiskUsage;
use crate::model_files::{ModelTally, ScanStatus};
use deepclean_rules::engine::TerritoryFact;
use deepclean_rules::types::{Rule, RuleCategory};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// §3.6 的七个生态（线格式的枚举值与 TS 的字符串字面量联合逐字同）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DevEnvGroupId {
    Node,
    Java,
    Python,
    Ide,
    Android,
    Ai,
    Container,
}

/// 分组标题。`DEV_ENV_GROUP_LABELS` 与分组判据住在这一层（那是主进程的结论，不是传输格式）。
pub fn group_label(id: DevEnvGroupId) -> &'static str {
    match id {
        DevEnvGroupId::Node => "Node / 前端包管理",
        DevEnvGroupId::Java => "Java / JVM 构建",
        DevEnvGroupId::Python => "Python",
        DevEnvGroupId::Ide => "编辑器与 IDE",
        DevEnvGroupId::Android => "Android SDK",
        DevEnvGroupId::Ai => "AI 模型与权重",
        DevEnvGroupId::Container => "容器",
    }
}

/// 页面出组的固定顺序（`GROUP_ORDER`）。顺序即界面版面，不许按分组名字典序。
pub const GROUP_ORDER: [DevEnvGroupId; 7] = [
    DevEnvGroupId::Node,
    DevEnvGroupId::Java,
    DevEnvGroupId::Python,
    DevEnvGroupId::Ide,
    DevEnvGroupId::Android,
    DevEnvGroupId::Ai,
    DevEnvGroupId::Container,
];

/// ruleId → 生态。**漏一条就是当场抛**（见 `build_dev_env_view` 里那一句），
/// 因为「页面上少一行」和「这台机器没这个生态」在肉眼看来完全同形，没人会去数内置表有几条。
pub fn group_of_rule(rule_id: &str) -> Option<DevEnvGroupId> {
    match rule_id {
        "npm-cache" | "pnpm-store" | "yarn-cache" => Some(DevEnvGroupId::Node),
        "maven-repository" | "gradle-cache" => Some(DevEnvGroupId::Java),
        "pip-cache" => Some(DevEnvGroupId::Python),
        "vscode-cache" => Some(DevEnvGroupId::Ide),
        "android-sdk-temp" => Some(DevEnvGroupId::Android),
        "huggingface-cache" => Some(DevEnvGroupId::Ai),
        _ => None,
    }
}

/// 只有这一个分组里的行需要「模型本体归大文件」那条路由（§21 原文：模型文件本体不进清理表）。
const LARGE_FILES_ROUTE_GROUPS: [DevEnvGroupId; 1] = [DevEnvGroupId::Ai];

fn group_is_ai_routes(id: DevEnvGroupId) -> bool {
    LARGE_FILES_ROUTE_GROUPS.contains(&id)
}

/// 一行上允许出现的动作。渲染端只照画，不许在这里之外加减。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DevEnvRowAction {
    GroupSelectAll,
    ToggleInclude,
    Detail,
    GoLargeFiles,
    View,
    PruneHint,
}

/// 三格各说各的事：`unknown` = 没问过探测器，`not-installed` = 探测说没装 —— 界面上是两句话。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallState {
    Installed,
    NotInstalled,
    Unknown,
}

/// §3.6 未完 #2 的残留清单。
///
/// `bytes = None` 是第三种状态「目录看到了、字节没量过」—— 界面必须能把它和「0 字节」分开念。
/// 它**不带来任何控件**：`actions` 由这张表的另一列决定，残留只是说明（用例钉着这两列互不越界）。
///
/// ⚠️ 「残留目录是空的（0 字节）什么都不报」这句 V0.7 裁定的落点在**界面**
/// （`DevEnv.tsx` 的 `devEnvResidualText`：`t.bytes <= 0 → ''`、`t.paths.length === 0 → ''`），
/// 不在这一层 —— 这里把它塌成 `None` 就等于再造一份口径。这一层守的是另一半：
/// **底账里一条地盘都没看到时 `residual` 恒 `None`**（`present` 为空）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevEnvResidual {
    pub bytes: Option<u64>,
    pub paths: Vec<String>,
}

/// 一行（`DevEnvRowWire`）。字段名逐字对齐 `shared/types.ts`，因为界面那份 React 代码不改。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevEnvRow {
    pub rule_id: String,
    pub name: String,
    pub install_state: InstallState,
    /// `None` = 这一格没量过（没扫过 / 未安装而不该给数）；`Some(0)` 是「量过且真是 0」。
    pub display_bytes: Option<u64>,
    pub display_files: Option<u64>,
    pub excluded_from_default_selection: bool,
    pub residual: Option<DevEnvResidual>,
    /// §3.6 未完 #4b：这一行的地盘**整条都不在这棵被扫的树上**。
    pub territory_missing: bool,
    pub actions: Vec<DevEnvRowAction>,
    /// 仅 Docker 行有值：那句要交给用户自己执行的命令（DeepClean 不代它跑，也不持有它的删除路径）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prune_command: Option<String>,
}

/// 一个分组的模型计数那一格是**三种状态**（TS 的 `modelFiles?: ModelTallyWire | null`）：
/// - `None`（不上线）= 这个生态不问这个问题 → 界面画空；
/// - `Some(None)`（上线为 `null`）= 还没扫过 → 界面念「还没扫过」；
/// - `Some(Some(t))` = 有读数。
/// 少了中间那一格，「没扫过」就会被读成「这台机器上一个权重都没有」。
///
/// ⚠️ `Option<Option<T>>` 的**读回**方向默认分不开「键缺席」与「键为 null」（serde 都把 null
/// 读成外层 `None`）。写出去是对的，但读回来会塌成一格 —— 所以下线方向挂一个自定义反序列化：
/// 缺席走 `default`（外层 None），`null` 读成 `Some(None)`，有值读成 `Some(Some(t))`。
/// 没有这一手，`tests/parity_with_ts.rs` 的形状往返会当场红（它就是这么被抓到的）。
pub type ModelFilesCell = Option<Option<ModelTally>>;

fn deserialize_model_files_cell<'de, D>(deserializer: D) -> Result<ModelFilesCell, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let inner = Option::<ModelTally>::deserialize(deserializer)?;
    Ok(Some(inner))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevEnvGroup {
    pub id: DevEnvGroupId,
    pub label: String,
    pub rows: Vec<DevEnvRow>,
    #[serde(
        default,
        deserialize_with = "deserialize_model_files_cell",
        skip_serializing_if = "Option::is_none"
    )]
    pub model_files: ModelFilesCell,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevEnvView {
    pub groups: Vec<DevEnvGroup>,
    /// 内置 dev-cache 规则数。页面用它自证「一条都没漏」，而不是只念分组数。
    pub declared_rule_count: usize,
    /// §3.6 未完 #4b：这些占用数字**是从哪棵树量到的**。`None` = 还没扫过。
    /// 那一格念「0 B」之前要说清量的是哪棵树，否则「我这台机器上没有缓存」会被当成结论。
    pub scanned_root: Option<String>,
}

/// 规则 id → 报告里的占用（来自最近一次预估/报告的 finding）。缺键 = 这份报告没覆盖到。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleOccupancy {
    pub bytes: u64,
    pub files: u64,
}

/// 唯一的输入形状。`bytes_by_rule` 由调用方从最近一次预估里挑出来（不重新走盘）。
/// 缺省值走 [`DevEnvViewInput::new`]（derive 不出 `Default`：`territories` 是一个借用切片）。
#[derive(Debug, Clone)]
pub struct DevEnvViewInput<'a> {
    pub rules: &'a [Rule],
    /// 探测器 id → 装没装。**缺键 = 没问过**（三态住在键的缺席里，见 `detectors::collect_install_status`）。
    pub install_status: BTreeMap<String, bool>,
    /// Docker 那次只读查询的三格结论；`None` = 没查过（界面上念「不知道」，不念「未检测到」）。
    pub docker: Option<DockerDiskUsage>,
    pub bytes_by_rule: BTreeMap<String, RuleOccupancy>,
    /// 扫描途中顺带数出来的模型权重计数；`None` = 还没扫过。
    /// 它挂在**分组**上而不是某一条规则行上：这一句问的是「这棵树上躺着几个权重」，
    /// 而不是「这条规则的地盘里躺着几个」—— 接到 `huggingface-cache` 那一行，
    /// 就等于让一行「只管 `.cache\huggingface`」的规则替整棵树报数。
    pub model_files: Option<ModelTally>,
    /// §3.6 未完 #2 / #4b：引擎那张地盘底账。空 = 这份报告没带（没扫过）→ 那两句话都不许出现。
    pub territories: &'a [TerritoryFact],
    /// 这些占用数字是从哪棵树量到的；`None` = 还没扫过。
    pub scanned_root: Option<String>,
}

impl<'a> DevEnvViewInput<'a> {
    /// TS 那一侧的可选字段默认值都在这一个构造点上（缺省 = 空表 / 没查过 / 没带底账）。
    pub fn new(rules: &'a [Rule]) -> Self {
        DevEnvViewInput {
            rules,
            install_status: BTreeMap::new(),
            docker: None,
            bytes_by_rule: BTreeMap::new(),
            model_files: None,
            territories: &[],
            scanned_root: None,
        }
    }
}

/// Docker 行的固定形状。写死在这里，是为了让「这行没有删除控件」成为一句可测的话。
fn docker_row(docker: &Option<DockerDiskUsage>) -> DevEnvRow {
    DevEnvRow {
        rule_id: "docker".to_string(),
        name: "Docker".to_string(),
        // 'unmeasurable'（CLI 报了错、daemon 没起）算「装着」：那次 df 确实被回答过，只是这次量不到。
        // None（压根没查）才是 unknown —— 三个词各说各的事，界面上不许互换。
        install_state: match docker {
            None => InstallState::Unknown,
            Some(d) if d.verdict == crate::detectors::DockerVerdict::Absent => InstallState::NotInstalled,
            Some(_) => InstallState::Installed,
        },
        // 只有 'measured' 才给字节：`reclaimable_bytes == None` 时这一格必须念「量不到」，
        // 印成 0 B 就是把「没量到」宣布成「省不下任何东西」（V0.6 §2.7 那条同一类错）。
        display_bytes: match docker {
            Some(d) if d.verdict == crate::detectors::DockerVerdict::Measured => d.reclaimable_bytes,
            _ => None,
        },
        display_files: None,
        excluded_from_default_selection: true,
        // Docker 没有「规则地盘」这个概念（V0.4 否掉了拿 FS 通配估它的字节），所以这两列恒是保守形状
        residual: None,
        territory_missing: false,
        actions: vec![DevEnvRowAction::View, DevEnvRowAction::PruneHint],
        prune_command: Some("docker system prune".to_string()),
    }
}

/// 算出 §3.6 那一页要的整份视图。**纯函数**：同样的输入必须逐字节同样的输出（可复现性）。
pub fn build_dev_env_view(input: &DevEnvViewInput) -> DevEnvView {
    // 底账按 ruleId 建索引：同一条规则出现多次时**第一条赢**（与 TS 的 `if (!byRule.has(...))` 同形，
    // 也和它一样不排序、不合并 —— 底账是引擎的产物，视图不许替它做决定）。
    let mut by_rule: BTreeMap<&str, &TerritoryFact> = BTreeMap::new();
    for t in input.territories {
        by_rule.entry(t.rule_id.as_str()).or_insert(t);
    }

    // 残留那一格。三条都是刻意的：
    // - 只在**探测明确判未装**时给：装了又在计账的规则，它的占用本来就在「占用」那一列里，
    //   同一笔字节出现两次就是重复上报（本项目最忌的那类）。「没问过」也不算未装 ——
    //   没确认过「没装」就没资格说「还躺着」。
    // - 字节只要有一个「没量过」（None）就整体退成 None：把没量到的那部分当 0 加进去，
    //   念出来的是一个偏小的「共 X」，比念「没量过」更像准数。
    // - 它只进 `residual`，**不进 `actions`** —— 报占用与允许勾选是两条独立的列，越界就是加删除能力。
    let residual_of = |rule: &Rule, detected: Option<bool>| -> Option<DevEnvResidual> {
        if detected != Some(false) {
            return None;
        }
        let t = by_rule.get(rule.id.as_str())?;
        if !t.detector_absent || t.present.is_empty() {
            return None;
        }
        let mut sum: Option<u64> = Some(0);
        for p in &t.present {
            sum = match (sum, p.bytes) {
                (Some(acc), Some(b)) => Some(acc.saturating_add(b)),
                _ => None,
            };
        }
        Some(DevEnvResidual {
            bytes: sum,
            paths: t.present.iter().map(|p| p.path.clone()).collect(),
        })
    };

    let mut by_group: BTreeMap<DevEnvGroupId, Vec<DevEnvRow>> = BTreeMap::new();

    for rule in input.rules {
        if rule.category != RuleCategory::DevCache {
            continue;
        }
        let Some(group) = group_of_rule(&rule.id) else {
            // 故意抛而不是兜到一个「其它」分组：兜住就等于把漏归组变成静默少一行
            panic!("§3.6 漏了生态归组：规则「{}」不在 GROUP_BY_RULE 里", rule.id);
        };
        // 没声明探测器的规则在这一格上就是「不知道」：少一个探测器不该变成「已装」或「未装」的假结论
        let detected: Option<bool> = rule
            .requires_detector
            .as_ref()
            .and_then(|d| input.install_status.get(d).copied());
        let priced = input.bytes_by_rule.get(&rule.id);
        let t = by_rule.get(rule.id.as_str()).copied();
        let install_state = match detected {
            None => InstallState::Unknown,
            Some(true) => InstallState::Installed,
            Some(false) => InstallState::NotInstalled,
        };
        let mut actions: Vec<DevEnvRowAction> = vec![DevEnvRowAction::Detail];
        // 「这一行能不能被勾进工作单」跟着**检测结论**走，不跟着规则存不存在走。
        // 未装 / 没探测过的行照样挂着「全选本组」与「勾上这一项」= 按钮是死的，
        // 而它左边那一格正写着「未检测到」—— 一句诚实的话配一个误导的控件，等于把诚实又收回去一半。
        if install_state == InstallState::Installed {
            actions.push(DevEnvRowAction::ToggleInclude);
            if rule.excluded_from_default_selection != Some(true) {
                actions.push(DevEnvRowAction::GroupSelectAll);
            }
        }
        // 「前往大文件」不受 installState 管：那是一条路由，不是删除控件 —— 权重目录可以在
        // CLI 没装的情况下照样躺在盘上（下载完再卸载工具的人就是这么来的）。
        if group_is_ai_routes(group) {
            actions.push(DevEnvRowAction::GoLargeFiles);
        }
        let row = DevEnvRow {
            rule_id: rule.id.clone(),
            name: rule.name.clone(),
            install_state,
            // 未安装 / 没探测过都不给字节：那一格上的 0 会被读成「这工具没缓存」，而事实是我们没问过它装没装
            display_bytes: if detected == Some(true) { priced.map(|p| p.bytes) } else { None },
            display_files: if detected == Some(true) { priced.map(|p| p.files) } else { None },
            excluded_from_default_selection: rule.excluded_from_default_selection == Some(true),
            residual: residual_of(rule, detected),
            // 「这次没扫到那块地」与「那块地是空的」是两个 0。只有底账真跑过（有这一条规则）
            // 且一条地盘都没看到、还有点名的没覆盖到，才敢说 missing ——
            // 缺底账时一律 false：宁可少说一句，也不凭「没有」就宣称知道。
            territory_missing: t
                .map(|t| t.present.is_empty() && t.not_scanned > 0)
                .unwrap_or(false),
            actions,
            prune_command: None,
        };
        by_group.entry(group).or_default().push(row);
    }

    // 容器那一组永远有 Docker 那一行（哪怕内置表里一条容器规则都没有）—— 与 TS 同形
    by_group.entry(DevEnvGroupId::Container).or_default().push(docker_row(&input.docker));

    // 先把要出组的分组定下来（借位用完再动 by_group），再逐组把行摘出来排 order。
    let live_groups: Vec<DevEnvGroupId> = GROUP_ORDER
        .iter()
        .copied()
        .filter(|id| by_group.get(id).map(|v| !v.is_empty()).unwrap_or(false))
        .collect();

    let groups: Vec<DevEnvGroup> = live_groups
        .into_iter()
        .map(|id| {
            let mut rows = by_group.remove(&id).unwrap_or_default();
            // 行内按 ruleId 升序：同一份规则表跑两次必须逐字节相同（可复现性是这一版全程硬要求）
            rows.sort_by(|a, b| a.rule_id.cmp(&b.rule_id));
            let mut g = DevEnvGroup {
                id,
                label: group_label(id).to_string(),
                rows,
                model_files: None,
            };
            // 模型计数挂在**分组**上，不挂在那条规则行上 —— 那一格问的是「这次扫到的树里躺着多少个权重」，
            // 而 `huggingface-cache` 那条规则的地盘只有 `.cache\huggingface` 一个目录。
            // 把它印在行里那格「占用」旁边，等于宣布「这个目录里有 26 GB」，而数是从整棵树数出来的。
            if group_is_ai_routes(id) {
                g.model_files = Some(input.model_files.clone());
            }
            g
        })
        .collect();

    DevEnvView {
        groups,
        declared_rule_count: input
            .rules
            .iter()
            .filter(|r| r.category == RuleCategory::DevCache)
            .count(),
        scanned_root: input.scanned_root.clone(),
    }
}

/// 界面那句「这行有没有任何一种能把文件送进工作单的控件」的判据（§3.6 第三条的机器版本）。
/// 住在这一层只为了给它一条**行为**断言可钉 —— 渲染层那一份是同一判据的镜像，不改界面。
pub fn row_has_delete_control(row: &DevEnvRow) -> bool {
    row.actions.contains(&DevEnvRowAction::ToggleInclude)
        || row.actions.contains(&DevEnvRowAction::GroupSelectAll)
}

/// 「全选本组」到底扫进哪几行。**两道都要过**：`toggle-include` 说这一行允许被勾；
/// `excluded_from_default_selection` 说它**不进批量勾选**。只过前一道就会把 AI 模型那一行扫进
/// 「全选本组」—— 那是 §3.5 那条豁免在页面上的复活路径。
pub fn group_include_ids(rows: &[DevEnvRow]) -> Vec<String> {
    rows.iter()
        .filter(|r| {
            r.actions.contains(&DevEnvRowAction::ToggleInclude) && !r.excluded_from_default_selection
        })
        .map(|r| r.rule_id.clone())
        .collect()
}

/// `ScanStatus` 的别名导出，让 D2 只认这一层的名字（视图与计数用的是同一份线形状）。
pub type ViewScanStatus = ScanStatus;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detectors::{DockerUsageCategory, DockerVerdict};
    use crate::model_files::MODEL_FILE_EXTENSIONS;
    use deepclean_rules::engine::{TerritoryFact, TerritoryPresent};
    use deepclean_rules::types::{CleanStrategy, Risk, RuleScanner};

    fn rule(id: &str, detector: Option<&str>, excluded: Option<bool>) -> Rule {
        Rule {
            id: id.to_string(),
            name: format!("{id} 的名字"),
            category: RuleCategory::DevCache,
            description: "测试用".to_string(),
            paths: vec![r"%LOCALAPPDATA%\x".to_string()],
            scanner: RuleScanner {
                file_patterns: Vec::new(),
                older_than_days: None,
                recursive: true,
                ..Default::default()
            },
            risk_level: Risk::Caution,
            clean_strategy: CleanStrategy::DeleteAll,
            recoverable: true,
            requires_detector: detector.map(|s| s.to_string()),
            excluded_from_default_selection: excluded,
            requires_absent_app_fact: None,
        }
    }

    fn territory(rule_id: &str, absent: bool, present: &[(&str, Option<u64>)], not_scanned: usize) -> TerritoryFact {
        TerritoryFact {
            rule_id: rule_id.to_string(),
            detector_absent: absent,
            present: present
                .iter()
                .map(|(p, b)| TerritoryPresent { path: p.to_string(), bytes: *b })
                .collect(),
            not_scanned,
        }
    }

    fn status(pairs: &[(&str, bool)]) -> BTreeMap<String, bool> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    fn row_of(view: &DevEnvView, rule_id: &str) -> DevEnvRow {
        view.groups
            .iter()
            .flat_map(|g| g.rows.iter())
            .find(|r| r.rule_id == rule_id)
            .unwrap_or_else(|| panic!("视图里没有 {rule_id} 这一行"))
            .clone()
    }

    fn occ(bytes: u64, files: u64) -> RuleOccupancy {
        RuleOccupancy { bytes, files }
    }

    /// `src/renderer/pages/DevEnv.tsx` 里 `devEnvBytesText` 那条 `if` 链的**逐字转录**，
    /// 只为给「五句话各自有独立的落点」一条可跑的行为断言。界面那份才是出货的那一份；
    /// 界面上改了链序（或加了第六格），这条用例必须跟着改 —— 它红了就是提醒：口径变了。
    fn ui_bytes_sentence(row: &DevEnvRow, scanned_root: Option<&str>) -> String {
        match row.install_state {
            InstallState::NotInstalled => "未检测到该工具".to_string(),
            InstallState::Unknown => "不确定装没装".to_string(),
            InstallState::Installed if row.territory_missing => format!(
                "这棵树上没有它的地盘（扫的是 {}）",
                scanned_root.unwrap_or("未知根")
            ),
            InstallState::Installed if row.display_bytes.is_none() => "这次没量到".to_string(),
            InstallState::Installed => format!("{} B", row.display_bytes.unwrap()),
        }
    }

    // ---------- §4-B 点名的六条 ----------

    #[test]
    fn installed_and_priced_yields_numbers() {
        // ① 探测器装了且地盘点到 → 出数字
        let rules = vec![rule("npm-cache", Some("npm"), None)];
        let input = DevEnvViewInput {
            rules: &rules,
            install_status: status(&[("npm", true)]),
            bytes_by_rule: vec![("npm-cache".to_string(), occ(33_000, 7))].into_iter().collect(),
            ..DevEnvViewInput::new(&rules)
        };
        let view = build_dev_env_view(&input);
        let row = row_of(&view, "npm-cache");
        assert_eq!(row.install_state, InstallState::Installed);
        assert_eq!(row.display_bytes, Some(33_000));
        assert_eq!(row.display_files, Some(7));
        assert_eq!(row.actions, vec![DevEnvRowAction::Detail, DevEnvRowAction::ToggleInclude, DevEnvRowAction::GroupSelectAll]);
        assert_eq!(ui_bytes_sentence(&row, Some(r"C:\Users\楠楠")), "33000 B");
    }

    #[test]
    fn installed_but_territory_is_not_on_this_tree_says_so() {
        // ② 装了但地盘不在这棵树上 → 「这棵树上没有它的地盘」
        let rules = vec![rule("gradle-cache", Some("gradle"), None)];
        let territories = vec![territory("gradle-cache", false, &[], 1)];
        let input = DevEnvViewInput {
            rules: &rules,
            install_status: status(&[("gradle", true)]),
            territories: &territories,
            scanned_root: Some(r"D:\模型".to_string()),
            ..DevEnvViewInput::new(&rules)
        };
        let view = build_dev_env_view(&input);
        let row = row_of(&view, "gradle-cache");
        assert!(row.territory_missing, "底账一条地盘都没看到、且点名有 1 条没覆盖 → missing");
        assert_eq!(row.display_bytes, None, "这份报告没有它的占用 → None，不是 Some(0)");
        // 「这块地是空的」与「这次没扫到那块地」是两个 0：missing 那一格不许念 0 B
        assert_eq!(
            ui_bytes_sentence(&row, Some(r"D:\模型")),
            r"这棵树上没有它的地盘（扫的是 D:\模型）"
        );
        assert_eq!(row.residual, None, "装着的规则不许报残留（同一笔字节印两次就是重复上报）");
    }

    #[test]
    fn unknown_status_is_never_a_number_and_never_not_detected() {
        // ③ 状态「不知道」→ 「不确定装没装」，**不许**出数字也不许出「未检测到」
        let rules = vec![rule("pip-cache", Some("pip"), None)];
        let input = DevEnvViewInput {
            rules: &rules,
            // 表里压根没有 pip 这个键 = 没问过
            bytes_by_rule: vec![("pip-cache".to_string(), occ(22_000, 3))].into_iter().collect(),
            ..DevEnvViewInput::new(&rules)
        };
        let view = build_dev_env_view(&input);
        let row = row_of(&view, "pip-cache");
        assert_eq!(row.install_state, InstallState::Unknown);
        assert_eq!(row.display_bytes, None, "没问过就不许把报告里的字节端出去");
        assert_eq!(row.display_files, None);
        assert_eq!(row.actions, vec![DevEnvRowAction::Detail], "没探测过的行一个勾选动作都不给（只留「详情」）");
        assert!(!row_has_delete_control(&row));
        assert_eq!(ui_bytes_sentence(&row, None), "不确定装没装");
    }

    #[test]
    fn not_installed_says_not_detected_and_hides_the_number() {
        // ④ 未装 → 「未检测到」，那一格的 0 会被读成「这工具没缓存」
        let rules = vec![rule("vscode-cache", Some("vscode"), None)];
        let input = DevEnvViewInput {
            rules: &rules,
            install_status: status(&[("vscode", false)]),
            bytes_by_rule: vec![("vscode-cache".to_string(), occ(15_000, 9))].into_iter().collect(),
            ..DevEnvViewInput::new(&rules)
        };
        let view = build_dev_env_view(&input);
        let row = row_of(&view, "vscode-cache");
        assert_eq!(row.install_state, InstallState::NotInstalled);
        assert_eq!(row.display_bytes, None);
        assert_eq!(row.actions, vec![DevEnvRowAction::Detail]);
        assert_eq!(ui_bytes_sentence(&row, None), "未检测到该工具");
    }

    #[test]
    fn an_unseen_territory_reports_no_residual() {
        // ⑤ 残留空目录 → 什么都不报。两条落点都要钉：
        //    (a) 这一层：底账里一条地盘都没看到 → residual 恒 None；
        //    (b) 报了 0 字节的那一支住在界面（`devEnvResidualText`：`bytes <= 0 → ''`），
        //        这一层**不许**替它塌掉 —— 那会造出第二套口径。
        let rules = vec![rule("maven-repository", Some("maven"), None)];
        let territories = vec![territory("maven-repository", true, &[], 2)];
        let input = DevEnvViewInput {
            rules: &rules,
            install_status: status(&[("maven", false)]),
            territories: &territories,
            ..DevEnvViewInput::new(&rules)
        };
        let view = build_dev_env_view(&input);
        let row = row_of(&view, "maven-repository");
        assert_eq!(row.residual, None, "一条地盘都没看到 → 什么都不报");
        assert_eq!(row.actions, vec![DevEnvRowAction::Detail]);

        // 盘上确实有个空目录（0 字节）：数据照实带上（None 与 Some(0) 是两句话），
        // 界面那句「不报」由 `devEnvResidualText` 落
        let empty_dir = vec![territory(
            "maven-repository",
            true,
            &[(r"C:\Users\楠楠\.m2\repository", Some(0))],
            0,
        )];
        let input2 = DevEnvViewInput {
            rules: &rules,
            install_status: status(&[("maven", false)]),
            territories: &empty_dir,
            ..DevEnvViewInput::new(&rules)
        };
        let row2 = row_of(&build_dev_env_view(&input2), "maven-repository");
        assert_eq!(
            row2.residual,
            Some(DevEnvResidual { bytes: Some(0), paths: vec![r"C:\Users\楠楠\.m2\repository".to_string()] }),
            "Some(0) 是「量过且真是 0」，不许被这一层塌成 None（那才是第二套口径）"
        );
    }

    #[test]
    fn the_five_sentences_stay_distinguishable_and_ordered() {
        // 「三态不许塌成两态」的行为证明：**五格各有一种数据形状**，
        // 且界面那条链的先后顺序（V0.7 未完 #4 定过）在同时成立时取靠前那一格。
        let cases: Vec<(InstallState, bool, Option<u64>, &str)> = vec![
            (InstallState::NotInstalled, false, None, "未检测到该工具"),
            (InstallState::Unknown, false, None, "不确定装没装"),
            (
                InstallState::Installed,
                true,
                None,
                r"这棵树上没有它的地盘（扫的是 C:\Machine）",
            ),
            (InstallState::Installed, false, None, "这次没量到"),
            (InstallState::Installed, false, Some(0), "0 B"),
        ];
        let sentences: Vec<String> = cases
            .iter()
            .map(|(state, missing, bytes, _)| {
                let row = DevEnvRow {
                    rule_id: "x".into(),
                    name: "X".into(),
                    install_state: *state,
                    display_bytes: *bytes,
                    display_files: None,
                    excluded_from_default_selection: false,
                    residual: None,
                    territory_missing: *missing,
                    actions: vec![DevEnvRowAction::Detail],
                    prune_command: None,
                };
                ui_bytes_sentence(&row, Some(r"C:\Machine"))
            })
            .collect();
        let mut uniq = sentences.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(sentences, cases.iter().map(|c| c.3.to_string()).collect::<Vec<String>>(), "五格各说各的事");
        assert_eq!(uniq.len(), 5, "五句话塌成了 {} 句", uniq.len());

        // 先后顺序：三格同时成立时取**靠前**那一格（把 missing 抢到未检测到之前会红在这里）
        let both = DevEnvRow {
            rule_id: "x".into(),
            name: "X".into(),
            install_state: InstallState::NotInstalled,
            display_bytes: None,
            display_files: None,
            excluded_from_default_selection: false,
            residual: None,
            territory_missing: true,
            actions: vec![DevEnvRowAction::Detail],
            prune_command: None,
        };
        assert_eq!(ui_bytes_sentence(&both, None), "未检测到该工具");
        let unknown_and_missing = DevEnvRow { install_state: InstallState::Unknown, ..both.clone() };
        assert_eq!(ui_bytes_sentence(&unknown_and_missing, None), "不确定装没装");
        // 0 只许出现在「真量到 0」那一格
        let zero = DevEnvRow {
            install_state: InstallState::Installed,
            territory_missing: false,
            display_bytes: Some(0),
            ..both.clone()
        };
        assert_eq!(ui_bytes_sentence(&zero, None), "0 B");
    }

    #[test]
    fn model_tally_is_carried_per_group_not_per_rule() {
        // ⑥ 计数挂在**生态分组**上而不是某一条规则上；未扫完时那一格只能是下界
        let rules = vec![rule("huggingface-cache", Some("huggingface"), Some(true))];
        let tally = ModelTally {
            count: 137,
            bytes: 140_288,
            root_path: r"D:\模型".to_string(),
            files_seen: 41_000,
            truncated: false,
            scan_status: ScanStatus::Running,
            extensions: MODEL_FILE_EXTENSIONS.iter().map(|s| s.to_string()).collect(),
        };
        let input = DevEnvViewInput {
            rules: &rules,
            install_status: status(&[("huggingface", true)]),
            model_files: Some(tally.clone()),
            ..DevEnvViewInput::new(&rules)
        };
        let view = build_dev_env_view(&input);
        let ai = view.groups.iter().find(|g| g.id == DevEnvGroupId::Ai).expect("AI 分组必须在");
        assert_eq!(ai.model_files, Some(Some(tally.clone())), "那一格住在分组上");
        // 规则行上**没有**这一格：把它印在「占用」旁边，等于宣布那个目录里有 26 GB，而数是从整棵树数出来的
        let row = row_of(&view, "huggingface-cache");
        let wire = serde_json::to_value(&row).unwrap();
        assert!(wire.get("modelFiles").is_none(), "行上不许长出一格模型计数");
        assert_eq!(row.actions, vec![
            DevEnvRowAction::Detail,
            DevEnvRowAction::ToggleInclude,
            DevEnvRowAction::GoLargeFiles
        ], "AI 行拿不到「全选本组」，但手动勾选与那条路由都还在");
        // 扫描状态原样带出来 —— 那一格是**下界**不是结论，措辞由界面按状态选
        assert_eq!(ai.model_files.clone().unwrap().unwrap().scan_status, ScanStatus::Running);
        // 非 AI 分组那一格**不上线**（undefined = 这个生态不问这个问题）
        let node = view.groups.iter().find(|g| g.id == DevEnvGroupId::Node);
        if let Some(g) = node {
            assert_eq!(g.model_files, None);
        }
    }

    #[test]
    fn model_files_cell_distinguishes_not_asked_from_not_scanned() {
        // 三格：不问 / 没扫过 / 有读数。少了中间那一格，「没扫过」就会被读成「这台机器上没有权重」
        let rules = vec![rule("huggingface-cache", Some("huggingface"), Some(true))];
        let input = DevEnvViewInput::new(&rules);
        let view = build_dev_env_view(&input);
        let ai = view.groups.iter().find(|g| g.id == DevEnvGroupId::Ai).unwrap();
        assert_eq!(ai.model_files, Some(None), "没扫过 → 上线成 null，界面上念「还没扫过」");
        let wire = serde_json::to_value(&view).unwrap();
        let ai_group = wire["groups"].as_array().unwrap().iter().find(|g| g["id"] == "ai").unwrap();
        assert!(ai_group.get("modelFiles").is_some());
        assert!(ai_group["modelFiles"].is_null());
    }

    // ---------- 其余每条判据 ----------

    #[test]
    fn every_builtin_dev_cache_rule_is_grouped_and_counted() {
        let rules = deepclean_rules::builtin_rules();
        let input = DevEnvViewInput::new(&rules);
        let view = build_dev_env_view(&input);
        let listed: Vec<String> = view.groups.iter().flat_map(|g| g.rows.iter().map(|r| r.rule_id.clone())).collect();
        let mut rule_rows: Vec<String> = listed.iter().filter(|id| id.as_str() != "docker").cloned().collect();
        assert!(listed.contains(&"docker".to_string()), "Docker 那行是合成的，也必须出现");
        let mut expect: Vec<String> = rules
            .iter()
            .filter(|r| r.category == RuleCategory::DevCache)
            .map(|r| r.id.clone())
            .collect();
        rule_rows.sort();
        expect.sort();
        assert_eq!(rule_rows, expect, "覆盖性：去掉合成行之后不多不少");
        assert_eq!(view.declared_rule_count, 9);
        // 七个分组全出（容器那组恒有 Docker）
        let ids: Vec<DevEnvGroupId> = view.groups.iter().map(|g| g.id).collect();
        assert_eq!(ids, GROUP_ORDER.to_vec());
        for g in &view.groups {
            assert_eq!(g.label, group_label(g.id));
        }
    }

    #[test]
    #[should_panic(expected = "§3.6 漏了生态归组")]
    fn a_rule_without_a_group_panics_instead_of_vanishing() {
        // 故意抛而不是兜到「其它」分组：兜住就等于把漏归组变成静默少一行
        let rules = vec![rule("brand-new-dev-cache", Some("whatever"), None)];
        build_dev_env_view(&DevEnvViewInput::new(&rules));
    }

    #[test]
    fn rules_outside_dev_cache_do_not_appear_and_do_not_count() {
        let mut rules = deepclean_rules::builtin_rules();
        let dev_count = rules.iter().filter(|r| r.category == RuleCategory::DevCache).count();
        rules.retain(|r| r.category != RuleCategory::DevCache);
        assert!(!rules.is_empty());
        let view = build_dev_env_view(&DevEnvViewInput::new(&rules));
        assert_eq!(view.declared_rule_count, 0);
        assert_eq!(dev_count, 9);
        // 只剩容器那一组（里面只有合成出来的 Docker 行）
        assert_eq!(view.groups.len(), 1);
        assert_eq!(view.groups[0].id, DevEnvGroupId::Container);
        assert_eq!(view.groups[0].rows.len(), 1);
    }

    #[test]
    fn row_order_is_by_rule_id_and_the_whole_view_is_reproducible() {
        // 同一份输入跑两次必须逐字节相同（可复现性是这一版全程硬要求），且规则表顺序不改变结论
        let rules: Vec<Rule> = deepclean_rules::builtin_rules()
            .into_iter()
            .filter(|r| r.category == RuleCategory::DevCache)
            .collect();
        let a = serde_json::to_string(&build_dev_env_view(&DevEnvViewInput::new(&rules))).unwrap();
        let mut reversed = rules.clone();
        reversed.reverse();
        let b = serde_json::to_string(&build_dev_env_view(&DevEnvViewInput::new(&reversed))).unwrap();
        assert_eq!(a, b, "行内按 ruleId 升序 ⇒ 输入顺序不许影响输出");
        let view = build_dev_env_view(&DevEnvViewInput::new(&rules));
        for g in &view.groups {
            let mut ids: Vec<String> = g.rows.iter().map(|r| r.rule_id.clone()).collect();
            ids.sort();
            assert_eq!(g.rows.iter().map(|r| r.rule_id.clone()).collect::<Vec<_>>(), ids);
        }
    }

    #[test]
    fn group_select_all_follows_the_detection_and_the_exemption() {
        let rules = deepclean_rules::builtin_rules()
            .into_iter()
            .filter(|r| r.category == RuleCategory::DevCache)
            .collect::<Vec<_>>();
        let input = DevEnvViewInput {
            rules: &rules,
            install_status: status(&[
                ("huggingface", true),
                ("npm", true),
                ("gradle", true),
                ("pnpm", false),
                // yarn / pip / maven / android-sdk / vscode 都不在表里 = 没问过
            ]),
            ..DevEnvViewInput::new(&rules)
        };
        let view = build_dev_env_view(&input);
        let ai = row_of(&view, "huggingface-cache");
        assert!(ai.actions.contains(&DevEnvRowAction::ToggleInclude));
        assert!(!ai.actions.contains(&DevEnvRowAction::GroupSelectAll), "AI 模型行拿不到「全选本组」");
        assert!(ai.excluded_from_default_selection);
        let npm = row_of(&view, "npm-cache");
        assert!(npm.actions.contains(&DevEnvRowAction::GroupSelectAll), "不许为了摘 AI 那条把整个动作面收窄");
        let pnpm = row_of(&view, "pnpm-store");
        assert_eq!(pnpm.install_state, InstallState::NotInstalled);
        assert!(!pnpm.actions.contains(&DevEnvRowAction::GroupSelectAll));
        assert!(!pnpm.actions.contains(&DevEnvRowAction::ToggleInclude), "未装的那一行按钮是死的");
        let yarn = row_of(&view, "yarn-cache");
        assert_eq!(yarn.install_state, InstallState::Unknown);
        assert_eq!(yarn.actions, vec![DevEnvRowAction::Detail]);

        // 「全选本组」实际扫到谁（两道都要过）
        let node = view.groups.iter().find(|g| g.id == DevEnvGroupId::Node).unwrap();
        assert_eq!(group_include_ids(&node.rows), vec!["npm-cache".to_string()]);
        let ai_group = view.groups.iter().find(|g| g.id == DevEnvGroupId::Ai).unwrap();
        assert!(group_include_ids(&ai_group.rows).is_empty(), "AI 那一组的「全选」必须扫不到任何东西");
    }

    #[test]
    fn docker_row_has_no_control_that_can_trigger_a_delete() {
        // §3.6 第三条判据的机器版本：Docker 行只有「查看」与那句 prune 说明
        let rules: Vec<Rule> = Vec::new();
        let usage = DockerDiskUsage {
            verdict: DockerVerdict::Measured,
            reclaimable_bytes: Some(1_587_000),
            categories: vec![DockerUsageCategory { name: "images".into(), reclaimable_bytes: 1_587_000 }],
            detail: "…".into(),
        };
        let input = DevEnvViewInput {
            rules: &rules,
            docker: Some(usage),
            ..DevEnvViewInput::new(&rules)
        };
        let view = build_dev_env_view(&input);
        let row = row_of(&view, "docker");
        assert_eq!(row.install_state, InstallState::Installed);
        assert_eq!(row.display_bytes, Some(1_587_000));
        assert_eq!(row.actions, vec![DevEnvRowAction::View, DevEnvRowAction::PruneHint]);
        assert!(!row_has_delete_control(&row));
        assert_eq!(row.prune_command.as_deref(), Some("docker system prune"));
        assert!(row.excluded_from_default_selection);
        assert_eq!(row.residual, None);
        assert!(!row.territory_missing, "Docker 没有「规则地盘」这个概念，底账里没有它 → 保守形状，不许崩");
    }

    #[test]
    fn docker_states_do_not_collapse_into_zero_or_not_detected() {
        let rules: Vec<Rule> = Vec::new();
        // 没查过 → unknown（不许冒充「未检测到」）
        let v = build_dev_env_view(&DevEnvViewInput { rules: &rules, ..DevEnvViewInput::new(&rules) });
        assert_eq!(row_of(&v, "docker").install_state, InstallState::Unknown);
        assert_eq!(row_of(&v, "docker").display_bytes, None);

        // absent → 未检测到，字节仍是 None 而不是 Some(0)
        let absent = DockerDiskUsage {
            verdict: DockerVerdict::Absent,
            reclaimable_bytes: None,
            categories: vec![],
            detail: "PATH 上没有 docker".into(),
        };
        let v = build_dev_env_view(&DevEnvViewInput {
            rules: &rules,
            docker: Some(absent),
            ..DevEnvViewInput::new(&rules)
        });
        let row = row_of(&v, "docker");
        assert_eq!(row.install_state, InstallState::NotInstalled);
        assert_eq!(row.display_bytes, None);

        // unmeasurable → 算装着，但那一格不许写 0 也不许写「未检测到」
        let shrug = DockerDiskUsage {
            verdict: DockerVerdict::Unmeasurable,
            reclaimable_bytes: None,
            categories: vec![],
            detail: "daemon 没起".into(),
        };
        let v = build_dev_env_view(&DevEnvViewInput {
            rules: &rules,
            docker: Some(shrug),
            ..DevEnvViewInput::new(&rules)
        });
        let row = row_of(&v, "docker");
        assert_eq!(row.install_state, InstallState::Installed);
        assert_eq!(row.display_bytes, None);
        assert_eq!(ui_bytes_sentence(&row, None), "这次没量到");
    }

    #[test]
    fn residual_and_missing_need_a_real_ledger() {
        let rules = vec![rule("pnpm-store", Some("pnpm"), None)];
        // 没传底账：两句话都不许出现（宁可少说一句，也不凭「没有」就宣称知道）
        let input = DevEnvViewInput {
            rules: &rules,
            install_status: status(&[("pnpm", false)]),
            ..DevEnvViewInput::new(&rules)
        };
        let row = row_of(&build_dev_env_view(&input), "pnpm-store");
        assert_eq!(row.residual, None);
        assert!(!row.territory_missing);

        // 半截在地上、半截没扫到 → 不算「没有它的地盘」（否则这一行会两头都念）
        let half = vec![territory(
            "pnpm-store",
            true,
            &[(r"C:\Users\楠楠\AppData\Local\pnpm-store\v3", Some(4_096))],
            1,
        )];
        let row = row_of(
            &build_dev_env_view(&DevEnvViewInput {
                rules: &rules,
                install_status: status(&[("pnpm", false)]),
                territories: &half,
                ..DevEnvViewInput::new(&rules)
            }),
            "pnpm-store",
        );
        assert!(!row.territory_missing);
        assert_eq!(row.residual.as_ref().unwrap().bytes, Some(4_096));
        // 「没量过」不退成 0：只要有一条字节是 None，整体就是 None
        let mixed = vec![territory(
            "pnpm-store",
            true,
            &[
                (r"C:\Users\楠楠\AppData\Local\PNPM-store\v3", Some(4_096)),
                (r"D:\pnpm 存储", None),
            ],
            0,
        )];
        let row = row_of(
            &build_dev_env_view(&DevEnvViewInput {
                rules: &rules,
                install_status: status(&[("pnpm", false)]),
                territories: &mixed,
                ..DevEnvViewInput::new(&rules)
            }),
            "pnpm-store",
        );
        assert_eq!(row.residual.as_ref().unwrap().bytes, None);
        assert_eq!(row.residual.as_ref().unwrap().paths.len(), 2);
    }

    #[test]
    fn reporting_residual_grows_no_controls() {
        // 用例钉着这两列互不越界：残留只是说明，越界就是加删除能力
        let rules = vec![rule("maven-repository", Some("maven"), None)];
        let territories = vec![territory("maven-repository", true, &[(r"C:\Users\楠楠\.m2\repository", Some(7_000))], 0)];
        let with_residual = build_dev_env_view(&DevEnvViewInput {
            rules: &rules,
            install_status: status(&[("maven", false)]),
            territories: &territories,
            ..DevEnvViewInput::new(&rules)
        });
        let without = build_dev_env_view(&DevEnvViewInput {
            rules: &rules,
            install_status: status(&[("maven", false)]),
            ..DevEnvViewInput::new(&rules)
        });
        let a = row_of(&with_residual, "maven-repository");
        let b = row_of(&without, "maven-repository");
        assert!(a.residual.is_some());
        assert_eq!(a.actions, b.actions, "残留不许长出任何控件");
        assert!(!row_has_delete_control(&a));
        assert!(group_include_ids(&with_residual.groups[0].rows).is_empty());
    }

    #[test]
    fn never_confirmed_absent_does_not_claim_residual() {
        // 探测器**压根没问过**（unknown）而底账写着 detectorAbsent → 也不报残留：
        // 没确认过「没装」就没资格说「还躺着」
        let rules = vec![rule("maven-repository", Some("maven"), None)];
        let territories = vec![territory("maven-repository", true, &[(r"C:\Users\楠楠\.m2\repository", Some(7_000))], 0)];
        let row = row_of(
            &build_dev_env_view(&DevEnvViewInput { rules: &rules, territories: &territories, ..DevEnvViewInput::new(&rules) }),
            "maven-repository",
        );
        assert_eq!(row.install_state, InstallState::Unknown);
        assert_eq!(row.residual, None);
    }

    #[test]
    fn a_rule_declaring_an_unknown_detector_id_is_unknown_not_absent() {
        // 与引擎「缺 id 按已装」同一个方向：视图这一格不许把「没查到」读成「没装」
        let rules = vec![rule("npm-cache", Some("bun"), None)];
        let input = DevEnvViewInput {
            rules: &rules,
            install_status: status(&[("npm", true)]),
            ..DevEnvViewInput::new(&rules)
        };
        let row = row_of(&build_dev_env_view(&input), "npm-cache");
        assert_eq!(row.install_state, InstallState::Unknown);
        assert_eq!(row.display_bytes, None);
    }

    #[test]
    fn a_rule_without_a_detector_is_unknown_by_design() {
        // 没声明探测器的规则在这一格上就是「不知道」：少一个探测器不该变成「已装」或「未装」的假结论
        let rules = vec![rule("npm-cache", None, None)];
        let row = row_of(&build_dev_env_view(&DevEnvViewInput::new(&rules)), "npm-cache");
        assert_eq!(row.install_state, InstallState::Unknown);
    }

    #[test]
    fn scanned_root_is_carried_through_verbatim() {
        let rules: Vec<Rule> = Vec::new();
        let view = build_dev_env_view(&DevEnvViewInput {
            rules: &rules,
            scanned_root: Some(r"\\srv\share\归档".to_string()),
            ..DevEnvViewInput::new(&rules)
        });
        assert_eq!(view.scanned_root.as_deref(), Some(r"\\srv\share\归档"));
        let none = build_dev_env_view(&DevEnvViewInput::new(&rules));
        assert_eq!(none.scanned_root, None, "还没扫过 → null，不许编一个根");
    }

    #[test]
    fn wire_field_names_match_shared_types_exactly() {
        // 界面那份 React 代码不改 ⇒ 线格式的键名是契约。逐键点名，少一格/多一格都要红。
        let rules = vec![rule("npm-cache", Some("npm"), None)];
        let input = DevEnvViewInput {
            rules: &rules,
            install_status: status(&[("npm", true)]),
            ..DevEnvViewInput::new(&rules)
        };
        let wire = serde_json::to_value(build_dev_env_view(&input)).unwrap();
        let row = &wire["groups"][0]["rows"][0];
        let keys: Vec<&String> = row.as_object().unwrap().keys().collect();
        for k in [
            "ruleId",
            "name",
            "installState",
            "displayBytes",
            "displayFiles",
            "excludedFromDefaultSelection",
            "residual",
            "territoryMissing",
            "actions",
        ] {
            assert!(keys.iter().any(|s| *s == k), "DevEnvRowWire 缺键 {k}");
        }
        assert!(!keys.iter().any(|s| *s == "pruneCommand"), "普通规则行不许带 pruneCommand");
        assert_eq!(wire["groups"][0]["id"].as_str(), Some("node"));
        assert_eq!(row["installState"].as_str(), Some("installed"));
        assert_eq!(row["actions"][0].as_str(), Some("detail"));
        let view_keys: Vec<&String> = wire.as_object().unwrap().keys().collect();
        for k in ["groups", "declaredRuleCount", "scannedRoot"] {
            assert!(view_keys.iter().any(|s| *s == k), "DevEnvViewWire 缺键 {k}");
        }
        assert!(wire["scannedRoot"].is_null(), "None 必须上线成 null（界面按 === null 判「还没扫过」）");
    }

    #[test]
    fn the_ledger_index_takes_the_first_entry_for_a_rule() {
        // 与 TS 的 `if (!byRule.has(t.ruleId))` 同形：同一条规则出现两次，第一条赢，不合并
        let rules = vec![rule("npm-cache", Some("npm"), None)];
        let territories = vec![
            territory("npm-cache", false, &[], 3),
            territory("npm-cache", true, &[(r"C:\dup", Some(9))], 0),
        ];
        let row = row_of(
            &build_dev_env_view(&DevEnvViewInput {
                rules: &rules,
                install_status: status(&[("npm", true)]),
                territories: &territories,
                ..DevEnvViewInput::new(&rules)
            }),
            "npm-cache",
        );
        assert!(row.territory_missing, "取的是**第一条**（present 空 + notScanned 3）");
        assert_eq!(row.residual, None, "第二条没被读到");
    }
}
