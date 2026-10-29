//! 评估层：把规则表套到一棵**已经扫好的树**上，算出每条规则认得多少、以及每一处没认的原因。
//!
//! 与 TS 侧 `core/rules/engine.ts` 同口径（逐函数对照见 M3 计划的交接表）。
//! **只读、零删除** —— 本文件不产生任何动作，只产生 `RuleReport`。
//! 取数只走**计价口径** `children_of`；任何"每层只回 N 项"的收窄都不许进这里。

use crate::env::{is_forbidden_path, path_is_under, resolve_pattern, segs_of, RuleEnv};
use crate::matcher::name_matches;
use crate::types::{
    AppFact, Rule, Risk, FORBIDDEN_PATH_PATTERNS, PACKAGE_TREE_NAMES, REPORT_ONLY_ROOT_PATTERNS,
    USER_DATA_LEAF_NAMES, USER_DATA_LEAF_RELATIVE,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashSet};

/// `MAX_WALK_DEPTH`（`engine.ts:44`）
pub const MAX_WALK_DEPTH: usize = 200;
/// `DAY_MS`（`engine.ts:42`）
const DAY_MS: i64 = 86_400_000;
/// `FILE_ATTRIBUTE_SYSTEM`
const ATTR_SYSTEM: u32 = 0x4;

/// 归一化路径键。**与 `shared/pathkey.ts:11` 逐字同口径** ——
/// `claimed` 表与 `dir_id_by_path` 共用它；两处两种归一化就是两套真相。
pub fn normalize_key(p: &str) -> String {
    let mut s = p.replace('/', "\\").to_lowercase();
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    s
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Directory,
    File,
}

/// 评估层要的最小节点视图。**带上 `path` 是必须的**：排除记录要能点名到具体路径
/// （`types.ts` 那条「excluded 记录必须点名到具体路径，不许只报一个总数」）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeView {
    pub kind: NodeKind,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub attrs: Option<u32>,
}

/// 扫描树的只读取数面。**由 `TreeIndex` 实现**（M3-A 的下一步）。
pub trait RuleSource {
    /// `openDir` 的第一件事。查不到 = 本次扫描没覆盖（没扫到 ≠ 不存在）。
    fn dir_id_by_path(&self, path: &str) -> Option<i64>;
    /// **计价口径**：这一层的完整清单。
    fn children_of(&self, dir_id: i64) -> Vec<NodeView>;
    /// 子树合计（`finalizeDir` 算好的那个）。`None` = 看到了但没量过，**不是 0**。
    fn size_of(&self, dir_id: i64) -> Option<u64>;
}

/// 排除理由。成员与 TS `types.ts:170` 同名（只列 M3-A 用得到的那几个）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExclusionReason {
    /// 落在 §16 🔴 禁止路径里（整条分支不可达）
    ForbiddenRoot,
    /// 落在「只上报不可删」根里：照常枚举、照常报字节，但不许被这条规则认领
    ReportOnlyRoot,
    /// 被属性证明带 SYSTEM（§28 原则二）
    ProtectedAttrs,
    /// 解析出的地盘是别的规则/禁止路径的祖先（§28 原则四）
    AncestorOfProtected,
    /// 裸容器变量或宽容器收尾，不构成叶子路径
    BroadContainer,
    /// 以通配收尾，落不到具体目录
    PatternNotLeaf,
    /// 注入的 env 里没有这个变量
    UnresolvedEnv,
    /// 禁止根 / 只上报根的模板自己解析不出来 → fail-safe，整份报告不出结论
    /// （TS `ExclusionReason` 的同名成员；只在报告级出现，`rule_id` 为 `None`）
    ForbiddenRootUnresolved,
    /// 这次扫描根本没覆盖到该路径（没扫 = 不知道，不是没有）
    NotScanned,
    /// 已被先声明的规则认领，不双计
    ClaimedByOtherRule,
    /// 所在规则被整体拒绝，本条路径连带出局
    RuleRejected,
    /// 探测表判定该规则依赖的工具未安装
    NotInstalled,
    /// M5-P1 T2（spec §2.3）：落在 `scopeFence` 之外（命中 denyRoots，或不在任何 allowRoots 之内）。
    /// **它与 `forbidden-root` 是同一个形状**：目录在 `open_dir` 那一层就被拒，
    /// 连"被列举"都不发生 —— 不是"列举完再滤掉命中"（那会让规则看着在工作、数字偏小，plan §0.2）。
    /// 记录必须点名到那个**具体目录**（`types.ts` 那条：不许只报一个总数）。
    OutsideFence,
    /// M5-P2 P2-T5（plan `2026-10-13-deepclean-tauri-m5-p2.md` §5 裁定 1）：leaf 下降时撞到
    /// **第三方代码树**（`PACKAGE_TREE_NAMES` 的整名命中）→ 整棵子树不进采集面。
    ///
    /// 与 `outside-fence` **同一个形状**：目录在 `open_dir` 那一层之前就被拒，连"被列举"都不发生
    /// —— 不是"枚举完再把里面的命中滤掉"（plan §0.2：后者让规则看着在工作、数字偏小）。
    /// 记录点名到那个**具体目录**（`…\node_modules`，不是它下面某条源码路径）。
    ///
    /// 为什么必须有这一条而不是靠 `scopeFence`：fence 点名的是**根**（`%PROGRAMFILES%` 那一类），
    /// 而包树长在授权根**里面**任意深度（`%LOCALAPPDATA%\Programs\nodejs\node_modules\…`），
    /// 那不是"越栏"，是"栏内有一棵别人的代码树"。
    PackageTree,
    /// M5-P1 T2（spec §4.2）/ **P2-T3 收窄**：注入的机器事实表把这一格**自己**判成了 `Unknown` ——
    /// 探针跑了、取证取到一半取不着（权限拒、枚举断、覆盖面不够），带着 `why` 弃权。
    ///
    /// ⚠️ 它现在**只**表达这一件事。P2-T1 那半边把 `Present` / `Unknown` / 缺键三档合并成这一条，
    /// 于是「探针看了但说不清」与「表里压根没这一格」在报告里长得一样 —— 而这两件事的**下一步动作
    /// 不同**（前者要补通道，后者要把候选交给探针）。P2-T3 把它们拆成三条分名的理由。
    /// 方向仍是**弃权**（少删），与 `not-installed` 同一条纪律：账上没了 + 报告里点名为什么没判。
    AppFactUnknown,
    /// M5-P2 P2-T3（plan §2.4）：注入的机器事实表说这个候选目录**本体在场**（`Present`）——
    /// 卸载表 / MSIX 包目录 / 安装根 / 进程镜像任一路证出来了。
    /// 这条与 `app-fact-unknown`、`app-fact-key-missing` **必须分得开**：这一档是
    /// 「看了，而且证明这个应用还活着」，是三条里唯一一条正面证据；把它和"没判出来"混在
    /// 一句话里，读报告的人就会去补探针，而真相是那台机器上应用还在跑。
    AppFactPresent,
    /// M5-P2 P2-T3（plan §2.4）：表里**根本没有这个键** —— 探针没被交代看这个目录。
    /// 与 `app-fact-unknown` 是两件事，而且方向上更危险：缺键既不是「查过说没查到」，
    /// 也不是「查了查不动」，它是什么都没发生过。spec §4.2 把这条钉死成 `Unknown` 同向
    /// （都不许提议），但**措辞必须能分开**，否则「补候选清单」这件事永远不会有出现在报告里的一天。
    AppFactKeyMissing,
    /// **CLEANUP-RULES §6 R-DENY-USERDATA / R-DENY-MSACTIVITY 的 guard**（本轮）：
    /// 这个目录的名字长得像缓存，但它长在**用户数据容器**里（`…\Microsoft\…`、`…\Packages\…`
    /// 每应用状态、`SystemApps\…`），删掉的是登录态 / 配置 / 会话，不是渲染层缓存。
    ///
    /// 与 `outside-fence` / `package-tree` **同一个形状**：目录在 `open_dir` 之前就被拒，
    /// 连"被列举"都不发生，记录点名到那个**具体目录**。
    /// 判据表住 `types.rs::USER_DATA_LEAF_RELATIVE` / `USER_DATA_LEAF_NAMES`（两侧逐条相同）。
    UserDataLeaf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exclusion {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_id: Option<String>,
    pub path: String,
    pub reason: ExclusionReason,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathHit {
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFinding {
    pub rule_id: String,
    pub name: String,
    /// 与 TS `RuleFinding.category` 同源。§17 预览要按它分组、§18 记录页要按它显示。
    pub category: crate::types::RuleCategory,
    pub risk_level: Risk,
    /// 与 TS `RuleFinding.cleanStrategy` 同源。**执行口径靠它**（M3-C 按它决定怎么收）。
    pub clean_strategy: crate::types::CleanStrategy,
    pub recoverable: bool,
    pub matched_roots: Vec<String>,
    pub sample_paths: Vec<PathHit>,
    pub sample_truncated: bool,
    pub file_count: u64,
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all_paths: Option<Vec<PathHit>>,
}

/// 四档各自的字节合计（TS `RuleReport.bytesByRisk`）。
/// **🔴 也在自己那一档里照常计数** —— 它只是不进 `reclaimable_bytes`。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BytesByRisk {
    pub safe: u64,
    pub caution: u64,
    pub high: u64,
    pub forbidden: u64,
}

/// §16 的分桶口径，**全仓唯一一份**。
///
/// 抽出来的理由不是整洁：预览那一边（`src-tauri/src/service.rs`）要把 §20 的「重复文件」伪项
/// 并进**同一张**分桶表，而 `reclaimable_bytes` 必须等于 `safe + caution + high`。
/// 两处各写一遍 `match` 就是两个口径，而两个口径迟早会比对方松一次 —— 松的那一次是多算「可回收」，
/// 方向是让用户看到一个腾不出来的数字。
pub fn add_bytes_by_risk(b: &mut BytesByRisk, risk: Risk, bytes: u64) {
    match risk {
        Risk::Safe => b.safe += bytes,
        Risk::Caution => b.caution += bytes,
        Risk::High => b.high += bytes,
        Risk::Forbidden => b.forbidden += bytes,
    }
}

/// 「可回收」合计：**🔴 永远不算在内**（它在 `bytes_by_risk` 自己那一格照常计数，只是不进这个和）。
pub fn reclaimable_of(b: &BytesByRisk) -> u64 {
    b.safe + b.caution + b.high
}

/// §3.6 地盘底账的一条（TS `TerritoryFact`）。
/// **只报关系、不改账**：`bytes = None` 是第三种状态「目录看到了、字节没量过」，不许退成 0。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerritoryFact {
    pub rule_id: String,
    pub detector_absent: bool,
    pub present: Vec<TerritoryPresent>,
    pub not_scanned: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerritoryPresent {
    pub path: String,
    pub bytes: Option<u64>,
}

/// 被拒规则挂的那条问题。TS 那边 `RuleProblem = Exclusion`（同一个类型），而 Rust 侧
/// 校验层的理由枚举（`validate::ProblemReason`）与排除记录的（`ExclusionReason`）是**两个类型**
/// —— 前者的 `invalid-shape` 根本不在后者里。硬并成一个枚举会改到排除面的类型，
/// 所以这里按**线上串**存：消费方（预览那句文案）要的本来就是那个 kebab-case 字面量。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedProblem {
    pub rule_id: String,
    pub path: String,
    pub reason: String,
    pub detail: String,
}

/// 声明层整条被拒的规则 —— TS `core/rules/types.ts` 的 `RejectedRule` 同形。
///
/// 为什么必须带 `name` 与 `problems` 而不能只留 id：§17 预览那句 `item-rejected` 的文案
/// 点名的是**规则名 + 被拒原因**（`core/rules/preview.ts:121-127`）。只带 id 时那句只能念
/// `windows-temp`，用户读到的是一个内部标识，不是"Windows 临时文件（禁止根模板没解析出来）"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RejectedRule {
    pub rule_id: String,
    pub name: String,
    pub problems: Vec<RejectedProblem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleReport {
    pub findings: Vec<RuleFinding>,
    pub exclusions: Vec<Exclusion>,
    /// 被声明层整条拒掉的规则（**按问题首次出现的次序**分组；fail-safe 那条路上是全部规则，
    /// 次序跟规则表）。**与 `exclusions` 里那批 `rule-rejected` 不是同一件事**：
    /// fail-safe 那条路上没有任何 `rule-rejected` 排除，但这里会列全部规则。
    /// §17 预览的 `item-rejected` 拒绝理由读的就是它。
    pub rejected_rules: Vec<RejectedRule>,
    /// 本次生效的禁止根（已解析成绝对路径、**升序**）。§17 预览靠它判 `blocked`（空 = 保护不在线）。
    pub forbidden_roots: Vec<String>,
    /// 本次生效的「只上报不可删」根（已解析、升序）。与禁止根分工见 `REPORT_ONLY_ROOT_PATTERNS`。
    pub report_only_roots: Vec<String>,
    /// 声明了 `requiresDetector` 的那几条规则的地盘底账，按 `rule_id` 升序、`present` 按路径升序。
    pub territories: Vec<TerritoryFact>,
    /// 四档各自的合计（含 🔴）。
    pub bytes_by_risk: BytesByRisk,
    /// 三档之和（安全 + 谨慎 + 高风险）。**🔴 不计入** —— 它照常上报占用，但绝不进可回收。
    pub reclaimable_bytes: u64,
    /// 禁止根 / 只上报根自己解析失败时置位：**fail-safe**，此时整份报告不可用于清理决策。
    pub safety_blocked: bool,
    /// §12「加入清理列表」反查用的**防双计表**：`normalize_key(文件路径) → 认领它的规则 id`。
    ///
    /// 只在 `EvaluateOptions.report_claims` 为真时挂（TS 同一条：`engine.ts:739` +
    /// `scan-service.ts:463` 那句 `reportClaims: tilePaths.length > 0`），平时是 `None` 且
    /// **不上线**（`skip_serializing_if`）：一棵 30 万文件的树就有 30 万条，每份报告都带它
    /// 等于把预估的 IPC 载荷撑大一个数量级，而只有逐文件勾选那条路读得懂它。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claimed_paths: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone)]
pub struct EvaluateOptions {
    pub now_ms: i64,
    pub max_listed_paths: usize,
    /// 点名要完整清单的规则 id（§18 执行器用）。默认不挂，不改变报告形状。
    pub collect_all_paths_for: BTreeSet<String>,
    pub detector_status: BTreeMap<String, bool>,
    pub forbidden_patterns: Vec<String>,
    pub report_only_patterns: Vec<String>,
    /// 把防双计那张表一起交出去（§12 的归属反查）。默认不给 —— 见 `RuleReport::claimed_paths` 的注释。
    pub report_claims: bool,
    /// M5-P1 T2（spec §4.2）/ **P2-T3 起真正被读**：机器事实表。键 = 候选目录 basename 的小写归一化，值 = 三态结论。
    ///
    /// 缺省仍是一张空表，而空表在 P2-T3 之后的含义**变了但方向没变**：声明了 `requiresAbsentAppFact`
    /// 的规则一个候选都判不出 `Absent` ⇒ 整条不提议（fail-safe 的方向是**少删**，不是多删）。
    /// 填它的是 M5-P2 的 `crates/appfacts`（注册表 / Appx / 进程 / 安装目录六路证据），不是这里。
    /// 引擎读的还是注入的表，一次都不碰系统 —— `lib.rs:4` 那句「零文件系统」不变。
    pub app_facts: BTreeMap<String, AppFact>,
    /// M5-P2 P2-T3（plan §5 交接的硬事实 7）：`Unknown` 那一档的**弃权理由原话**。
    ///
    /// 为什么是**第二张表**而不是把 `AppFact` 改成带字段的枚举：`crates/appfacts` 的
    /// `AppFact::Unknown { why: String }` 不可 `Copy`，而规则侧这份（`types.rs:94`）是
    /// **fieldless `Copy`** 的三态，它的线格式还要与 TS 的 `'present' | 'absent' | 'unknown'`
    /// 逐字对上（`types.rs` 的 serde 用例钉着）。所以接线时必须做一次**映射步**：状态进
    /// [`EvaluateOptions::app_facts`]，`why` 进这张表（同一把键）。[`app_fact_tables`] 就是那一步。
    ///
    /// 只有值为 `Unknown` 的条目会读它。`Unknown` 而这张表里没有键 ⇒ 排除记录如实写
    /// 「表弃权了但没交出理由」，不许编一句"大概是权限"糊过去。
    pub app_fact_whys: BTreeMap<String, String>,
}

impl Default for EvaluateOptions {
    fn default() -> Self {
        EvaluateOptions {
            now_ms: 0,
            max_listed_paths: 50,
            collect_all_paths_for: BTreeSet::new(),
            detector_status: BTreeMap::new(),
            forbidden_patterns: FORBIDDEN_PATH_PATTERNS.iter().map(|s| s.to_string()).collect(),
            report_only_patterns: REPORT_ONLY_ROOT_PATTERNS.iter().map(|s| s.to_string()).collect(),
            report_claims: false,
            // 空表 = 没有任何机器事实结论 = 一律弃权（不是"全都算残留"）
            app_facts: BTreeMap::new(),
            app_fact_whys: BTreeMap::new(),
        }
    }
}

/// 映射步的**输入行**（P2-T3，plan §5 P2-T1 交接的硬事实 7）。
///
/// 探针侧一张 `AppFactsTable` 交出来的是 `Present | Absent | Unknown{why:String}`；
/// 规则侧的三态是 fieldless `Copy`（还要与 TS 的线格式同串），`why` 装不进去。
/// 所以接线时（P2-T4 的 `src-tauri/src/service.rs`，plan §2.7）逐条落成这一行，再交给
/// [`app_fact_tables`] 拆成引擎吃的两张表 —— 把这一步做成**一个函数**而不是让调用方各写一遍
/// `match`，是因为写漏 `why` 的那一侧不会报错：报告只会少掉"为什么没判"那句原话。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppFactRow<'a> {
    /// 表键 = 候选目录 basename 的小写（`crates/appfacts::fact_key` 与这里 `base_name(..).to_lowercase()` 同口径）
    pub key: String,
    /// 规则侧的三态
    pub fact: AppFact,
    /// 探针侧的弃权理由原话；只有 `AppFact::Unknown` 那一档该带它
    pub why: Option<&'a str>,
}

/// 把探针侧逐条映射出的 [`AppFactRow`] 拆成 [`EvaluateOptions`] 的那两张表。
///
/// 三件判据都住在这一个函数里，所以它同时是"能红的那一段"：
/// ① `Unknown` 没有 `why` ⇒ 落一个**自我点名**的占位串（与 `appfacts::AppFact::unknown` 同一条纪律），
///    不许静默落成"没有理由"；
/// ② 非 `Unknown` 带的 `why` **不进水**（Present/Absent 没有理由可说，混进去会让报告念出
///    「证据说这个应用还活着，因为它不存在」这类自相矛盾的话）；
/// ③ 同键出现两次且结论**不一致** ⇒ 折成 `Unknown` 并点名"上游给了两个矛盾的结论"。
///    这里不 panic（评估是在预览路径上跑的，崩掉等于把整个界面带走），也不"留后一份"
///    —— 矛盾时选任何一档都是在替机器编一个证据，而 `Unknown` 是唯一不需要编的那一档。
pub fn app_fact_tables<'a, I>(rows: I) -> (BTreeMap<String, AppFact>, BTreeMap<String, String>)
where
    I: IntoIterator<Item = AppFactRow<'a>>,
{
    let mut facts: BTreeMap<String, AppFact> = BTreeMap::new();
    let mut whys: BTreeMap<String, String> = BTreeMap::new();
    for row in rows {
        let AppFactRow { key, fact, why } = row;
        let fact = match facts.get(&key) {
            Some(prev) if *prev != fact => {
                let name = |f: AppFact| match f {
                    AppFact::Present => "present",
                    AppFact::Absent => "absent",
                    AppFact::Unknown => "unknown",
                };
                whys.insert(
                    key.clone(),
                    format!(
                        "机器事实表里同一个键「{key}」出现了两个矛盾的结论（{} 与 {}）—— \
                         两半都不成立时不许挑一个信，按弃权处理",
                        name(*prev),
                        name(fact)
                    ),
                );
                AppFact::Unknown
            }
            _ => fact,
        };
        facts.insert(key.clone(), fact);
        match fact {
            AppFact::Unknown => {
                if whys.contains_key(&key) {
                    continue; // ③ 那条已经点过名了，不许被这一行的 why 顶掉
                }
                let text = match why.map(str::trim) {
                    Some(w) if !w.is_empty() => w.to_string(),
                    // 弃权必须说得出为什么没判（spec §4.2）：漏了理由就自我点名，不要留白
                    _ => format!(
                        "弃权理由缺失：表里「{key}」这一格是 unknown 却没带 why —— 按最保守档处理，不提议"
                    ),
                };
                whys.insert(key, text);
            }
            // Present / Absent 的 `why` 一律不进：那两档不需要理由，收进来只会在报告里造出矛盾句
            _ => {
                let _ = why;
            }
        }
    }
    (facts, whys)
}

#[derive(Default)]
struct Agg {
    count: u64,
    bytes: u64,
    paths: Vec<PathHit>,
}

/// 一条规则的一本账。leaf 模式下 `walk_leaf` 除了收文件还要把**命中的采集根**交回 `evaluate_rule`，
/// 所以账与根放在一起 —— 挂到 `St` 上就成了"引擎的账"，跨规则串账。
#[derive(Default)]
struct RuleAgg {
    agg: Agg,
    roots: Vec<String>,
    /// leaf 遍历的去重集：两个入口套住同一棵子树、或某个入口本身就是上一条命中的 leaf 时，
    /// 走第二遍会让**同一条规则**把同一个文件计两次（`claimed` 只挡跨规则，同规则重收它不挡）。
    walked: HashSet<String>,
}

/// 当前这条规则的围栏（已解析成具体根）。
///
/// `active = false` = 这条规则没带 `scopeFence` ⇒ `fence_allows` 一律放行、`fence_denies` 一律不回命中，
/// 既有 15 条因此**一个字节都不变**（回归轴 `no_leaf_rules_means_byte_identical_findings`）。
#[derive(Default)]
struct Fence {
    active: bool,
    allow: Vec<String>,
    deny: Vec<String>,
}

#[derive(Default)]
struct TerritoryLedger {
    detector_absent: bool,
    present: BTreeMap<String, Option<u64>>,
    not_scanned: usize,
}

struct St<'a> {
    source: &'a dyn RuleSource,
    env: &'a RuleEnv,
    forbidden_roots: Vec<String>,
    report_only_roots: Vec<String>,
    detector_status: BTreeMap<String, bool>,
    /// 当前这条规则声明的机器事实（spec §4.2）。P2-T3 起**真的被读**：采集根 = 入口的直属子目录，
    /// 逐格查这张表，只有 `Absent` 才收（见 [`St::collect_app_fact_entry`]）。
    app_facts: BTreeMap<String, AppFact>,
    /// `AppFact::Unknown` 那一档的弃权理由原话（映射步见 [`app_fact_tables`]）。
    app_fact_whys: BTreeMap<String, String>,
    /// 当前这条规则的围栏（`begin_rule` 每条规则换一次）。
    fence: Fence,
    now_ms: i64,
    list_cap: usize,
    collect_all_for: BTreeSet<String>,
    exclusions: Vec<Exclusion>,
    seen: HashSet<String>,
    claimed: BTreeMap<String, String>,
    ledgers: BTreeMap<String, TerritoryLedger>,
}

/// 声明了机器事实闸的规则：只有注入表把候选目录判成 `Absent` 才许提议。
fn wants_absent_app_fact(rule: &Rule) -> bool {
    rule.requires_absent_app_fact == Some(true)
}

/// 目录路径的 basename（leaf 判据只打在名字上，不看路径 —— spec §1「形状」那一类）。
fn base_name(path: &str) -> String {
    segs_of(path).pop().unwrap_or_default()
}

/// 重解析点目录（junction / symlink）：`FILE_ATTRIBUTE_REPARSE_POINT`。
/// 扫描器那一层本来就不进（`crates/scanner/src/accounting.rs` 的 `SkipReason::Reparse`），
/// 这里是评估层的第二道：合成树与别的取数面都可能把它带进来。
fn is_reparse_point(k: &NodeView) -> bool {
    k.kind == NodeKind::Directory && k.attrs.is_some_and(|a| a & ATTR_REPARSE_POINT != 0)
}

/// `FILE_ATTRIBUTE_REPARSE_POINT`
const ATTR_REPARSE_POINT: u32 = 0x400;

/// 这个子目录名是不是**第三方代码树**的整名？命中就返回命中的那个名单项。
///
/// 口径与 `BROAD_LEAF_NAMES` 那一条完全相同（basename 小写后**整名相等**，
/// 与 `validate.rs` 的 `BROAD_LEAF_NAMES.contains(&last_lower.as_str())` 同一法），**不是**第二把 glob —— 表里没有通配字符，
/// 整名相等也正好排掉了 `dist-types`、`node_modules2` 这类近失形状。
/// 与 TS `engine.ts::packageTreeHit` 逐字同判据。
fn package_tree_hit(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    PACKAGE_TREE_NAMES
        .iter()
        .position(|n| *n == lower.as_str())
        .map(|i| PACKAGE_TREE_NAMES[i])
}

/// 这个目录名是不是**用户数据容器里的缓存同名物**？命中就返回命中的那个路径片段。
///
/// 两条同时成立才算（cleanup-rules.md §6 的 guard，逐字见 `types.rs::USER_DATA_LEAF_RELATIVE`）：
///  · basename 命中 `USER_DATA_LEAF_NAMES`（约定成俗的缓存名 —— 认的是包的样子）；
///  · 路径里**含** `USER_DATA_LEAF_RELATIVE` 的某一段（`Microsoft\` / `SystemApps\` …）。
///
/// 为什么是"含某一段"而不是"落在某条禁止根里"：`%LOCALAPPDATA%\Microsoft` 整棵禁止会顺手
/// 关掉 `thumbnail-cache` 与 `error-reporting` 两条已上线规则（理由逐字在 `types.rs` 那张表的文档里）。
/// 而这里要拦的是「名字像缓存」的那一层，不是整棵子树 —— 判据的粗细与文档的 guard 对齐。
///
/// 口径与 `package_tree_hit` 同一法：basename 小写后**整名相等**，不新增第二把 glob。
/// 与 TS `engine.ts::userDataLeafHit` 逐字同判据。
fn user_data_leaf_hit(name: &str, path: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    if !USER_DATA_LEAF_NAMES.iter().any(|n| n.to_lowercase() == lower) {
        return None;
    }
    let p = path.replace('/', "\\").to_lowercase();
    USER_DATA_LEAF_RELATIVE
        .iter()
        .position(|seg| p.contains(&seg.to_lowercase()))
        .map(|i| USER_DATA_LEAF_RELATIVE[i])
}

impl<'a> St<'a> {
    /// 记一条排除。**返回它是否真的落了账**（同 `ruleId+reason+路径` 去过重）。
    /// 这个返回值只为地盘底账服务：底账的 `notScanned` 必须与 `exclusions` 里点名的条数**相等**，
    /// 而"相等"要钉得住就得两边各自数一遍 —— 让底账直接去数 exclusions 是自我印证，不算验证。
    fn exclude(
        &mut self,
        rule_id: Option<&str>,
        path: &str,
        reason: ExclusionReason,
        detail: String,
    ) -> bool {
        let key = format!("{}\u{0}{:?}\u{0}{}", rule_id.unwrap_or("-"), reason, normalize_key(path));
        if !self.seen.insert(key) {
            return false;
        }
        self.exclusions.push(Exclusion {
            rule_id: rule_id.map(|s| s.to_string()),
            path: path.to_string(),
            reason,
            detail,
        });
        true
    }

    fn ledger(&mut self, rule: &Rule) -> Option<&mut TerritoryLedger> {
        let det = rule.requires_detector.as_ref()?;
        if det.is_empty() {
            return None;
        }
        Some(self.ledgers.entry(rule.id.clone()).or_default())
    }

    /// 这条规则能不能把 `path` 算进自己名下？
    /// 「只上报不可删」根只对 🔴 规则开放 —— 它要如实报告占用，但 🟢/🟡 规则把它认领走
    /// 就等于把回收站摆上清理清单，而认领一旦发生在报告里，预览与执行器吃的就是那份清单。
    fn report_only_block(&self, path: &str, rule: &Rule) -> Option<String> {
        if rule.risk_level == Risk::Forbidden {
            return None;
        }
        is_forbidden_path(path, &self.report_only_roots)
    }

    /// 这条规则依赖的工具没装？**只有明确收到 `false` 才算没装** ——
    /// 缺 id 当没装会让一条真存在、真有几个 GB 的规则从一个坏掉的引用手里**静默消失**。
    fn absent_detector(&self, rule: &Rule) -> Option<String> {
        let det = rule.requires_detector.as_ref()?;
        if det.is_empty() {
            return None;
        }
        match self.detector_status.get(det) {
            Some(false) => Some(det.clone()),
            _ => None,
        }
    }

    /// 每条规则开工前把**它自己**的围栏换进来。
    ///
    /// 必须整体替换、不许残留：留着上一条规则的围栏等于给这一条套了一层别人的边界，
    /// 那是"看着有保护、实际拦错了地方"（`fence_denies` / `fence_allows` 按计划只收 `path`，
    /// 所以"当前是哪条规则的围栏"必须能在 `St` 上查到）。
    /// 声明层（`validate_fence`）已经保证这些根解析得出来；万一这里解不出来（同一份 env 下不该发生），
    /// 处置是 **fail-closed**：allow 侧一条都没补上 ⇒ 什么都进不去，而不是什么都进得来。
    fn begin_rule(&mut self, rule: &Rule) {
        let mut fence = Fence::default();
        if let Some(f) = &rule.scanner.scope_fence {
            fence.active = true;
            for p in &f.deny_roots {
                if let Ok(root) = crate::validate::fence_root(p, self.env, true) {
                    fence.deny.push(root);
                }
            }
            for p in &f.allow_roots {
                if let Ok(root) = crate::validate::fence_root(p, self.env, false) {
                    fence.allow.push(root);
                }
            }
        }
        self.fence = fence;
    }

    /// 这个路径命中哪条 deny 根 —— 回**那个根**，好让排除记录同时点名"哪个目录被拦"和"是谁拦的"。
    /// `None` = 没围栏，或没撞上任何 deny。
    fn fence_denies(&self, path: &str) -> Option<String> {
        if !self.fence.active {
            return None;
        }
        self.fence.deny.iter().find(|d| path_is_under(path, d)).cloned()
    }

    /// 这个路径在不在采集面之内。没带围栏的规则一律允许（既有 15 条逐字节不变的那一半保证）。
    fn fence_allows(&self, path: &str) -> bool {
        if !self.fence.active {
            return true;
        }
        self.fence.allow.iter().any(|a| path_is_under(path, a))
    }

    /// 机器事实闸（spec §4.2 / plan §2.4）：把**一个候选目录**（= 入口的直属子目录）交进表里查。
    ///
    /// 三档不批准的理由**各自一条、各自点名**，而且两两能被读者分开：
    /// `Present` = 「看了，本体还在」；`Unknown` = 「看了，但取证取不全，原话是 …」；
    /// **缺键** = 「这张表没被交代看过它」。最后那条绝不能读成"看过了、什么都没有"——
    /// 探针没跑过的目录，两半一条都没证过，而 `Absent` 后面接的是删除。
    ///
    /// 只有 `Absent` 返回 `true`。P2-T1 那半边把三档合并成一条 `AppFactUnknown` 的写法已经作废，
    /// 变异电池（plan §3-P2-T3）就是把"缺键当 Absent"装回来，看哪条用例红。
    fn app_fact_approves(&mut self, dir: &str, rule: &Rule) -> bool {
        let key = base_name(dir).to_lowercase();
        let rule_id = rule.id.clone();
        let tail = |what: &str| {
            format!(
                "{what}（查的键 =「{key}」，取候选目录 {dir} 的 basename 小写）→ 本条地盘不提议：0 字节、\
                 不进可回收，也不许静默消失",
            )
        };
        match self.app_facts.get(&key).copied() {
            Some(AppFact::Absent) => return true,
            Some(AppFact::Present) => {
                self.exclude(
                    Some(&rule_id),
                    dir,
                    ExclusionReason::AppFactPresent,
                    tail(
                        "注入的机器事实**证出了本体在场**（Present）：卸载表条目 / MSIX 包目录 / 安装根 / \
                         进程镜像至少一路命中 ⇒ 这个应用还在这台机器上，它的目录不是残留",
                    ),
                );
            }
            Some(AppFact::Unknown) => {
                // 把探针的 `why` 原话带进报告（这就是 [`app_fact_tables`] 那张副表存在的理由：
                // 规则侧的 fieldless 三态装不下它，而"为什么没判"恰恰是这一档唯一有用的信息）。
                let why = self
                    .app_fact_whys
                    .get(&key)
                    .cloned()
                    .unwrap_or_else(|| format!("表里「{key}」这一格是 unknown 却没带 why —— 弃权理由缺失，按最保守档处理"));
                self.exclude(
                    Some(&rule_id),
                    dir,
                    ExclusionReason::AppFactUnknown,
                    format!(
                        "注入的机器事实自己弃了权（Unknown），原话是：{why} —— 这**不是**「查了说没装」，\
                         而是「没能把两半都证出来」（查的键 =「{key}」，候选目录 {dir}）→ 本条地盘不提议：\
                         0 字节、不进可回收，也不许静默消失",
                    ),
                );
            }
            None => {
                self.exclude(
                    Some(&rule_id),
                    dir,
                    ExclusionReason::AppFactKeyMissing,
                    tail(
                        "注入的机器事实表里**没有这个键**（缺键）：探针根本没被交代看过这个目录 —— \
                         这既不是「查过、查无」也不是「查了查不动」，而是「什么都没发生过」。spec §4.2 定死缺键 = \
                         `Unknown` 同向（不许提议），但理由必须与那两条分开写，否则「把候选交给探针」这件事\
                         永远不会出现在报告里",
                    ),
                );
            }
        }
        false
    }

    /// **第三种采集模式**（plan §2.4，与既有两种并列：非 leaf 的地盘直收、leaf 的任意深度命中）。
    ///
    /// 声明了 `requiresAbsentAppFact` 的规则：采集根 = 入口目录的**直属子目录**（spec §3 3.5
    /// 那句「`LOCALAPPDATA`/`APPDATA`/`PROGRAMDATA` 顶层一项」）。逐个子目录查表，
    /// **只有 `Absent` 才收那一棵子树**；`Present` / `Unknown` / 缺键各记一条分名的排除。
    ///
    /// 三条不变量：
    ///  · **入口自己不是候选**。把 `%LOCALAPPDATA%` 本身（basename `local`）当候选会拿一个
    ///    容器名去查表，而表里的键是应用目录名 —— 那次查找永远缺键，整条规则就从报告里静默消失；
    ///  · **围栏照常生效**。`open_dir` 既拦入口也拦子树（`collect_territory` 逐层过它），
    ///    所以 `Absent` 批准的是"这块地可以收"，不是"可以越栏去收"；
    ///  · **重解析点目录既不当候选也不跟进**，与 `walk_leaf` 同一口径（junction 后面的东西
    ///    不在这条规则的授权根里）。
    ///
    /// 候选按归一化路径**先排后处理**：`children_of` 的清单序是取数面的次序，不是判据；
    /// 不排就会让"同一棵树跑两次"的排除记录次序取决于枚举器（与 leaf 模式末尾 `roots.sort` 同姿态）。
    fn collect_app_fact_entry(&mut self, entry: &str, rule: &Rule, out: &mut RuleAgg) {
        let rule_id = rule.id.clone();
        if !out.walked.insert(normalize_key(entry)) {
            return; // 两个 `paths` 条目解析到同一个入口：候选查两遍只会产出两份同样的排除记录
        }
        let Some(kids) = self.open_dir(entry, &rule_id) else { return };
        let mut dirs: Vec<NodeView> = kids
            .into_iter()
            .filter(|k| k.kind == NodeKind::Directory)
            .collect();
        dirs.sort_by(|a, b| normalize_key(&a.path).cmp(&normalize_key(&b.path)));
        for k in dirs {
            if is_reparse_point(&k) {
                self.exclude(
                    Some(&rule_id),
                    &k.path,
                    ExclusionReason::NotScanned,
                    format!("目录 {} 是重解析点（FILE_ATTRIBUTE_REPARSE_POINT）→ 不作为机器事实的候选，也不跟进去（与 walk_leaf / 扫描器 SkipReason::Reparse 同一口径）", k.path),
                );
                continue;
            }
            // 围栏在先、查表在后：被 deny 掉的候选**连枚举都不发生**（`outside-fence` 已点名），
            // 而且它不许进 `matched_roots` —— 表批准的是"这块地可以收"，不是"可以越栏去收"
            if self.fence_blocks(&k.path, &rule_id) {
                continue;
            }
            // 查表在先，收账在后：一条没被批准的候选目录，里面一个文件都不枚举（0 字节是结构性的）
            if !self.app_fact_approves(&k.path, rule) {
                continue;
            }
            if !out.roots.iter().any(|r| normalize_key(r) == normalize_key(&k.path)) {
                out.roots.push(k.path.clone());
            }
            self.collect_territory(&k.path, rule, &mut out.agg);
        }
    }

    /// 禁止分支与越栏分支**都根本不枚举** —— 同一个形状（spec §2.3 点名的就是这件事：
    /// 围栏要是有漏洞，漏的就是"任意深度 basename 判据"整块能力）。
    /// 顺序也是判据的一部分：先禁止根（既有口径逐字不变），再围栏 deny，最后 allow。
    ///
    /// 这一份**只做判定与记账，不碰取数面**（`dir_id_by_path` / `children_of` 都不在这里）。
    /// 把它从 `open_dir` 里抽出来，是因为第三种采集模式（[`St::collect_app_fact_entry`]）要在
    /// **枚举之前**问一句"这个候选目录在不在栏内"：让它直接调 `open_dir` 就会把没批准的候选也
    /// 列一遍 —— 而"一条都没批准的目录里面一个文件都不枚举"这句话，0 字节只是结果、
    /// 不枚举才是结构。两处共用这一份判据，就不存在"围栏在两个地方口径不一样"的那种漏
    /// （漏的那一边永远是**多删**那一侧）。
    fn fence_blocks(&mut self, path: &str, rule_id: &str) -> bool {
        if let Some(hit) = is_forbidden_path(path, &self.forbidden_roots) {
            self.exclude(
                Some(rule_id),
                path,
                ExclusionReason::ForbiddenRoot,
                format!("命中 §16 🔴 禁止路径 {hit} → 整条分支不可达，未枚举"),
            );
            return true;
        }
        if let Some(denied_by) = self.fence_denies(path) {
            self.exclude(
                Some(rule_id),
                path,
                ExclusionReason::OutsideFence,
                format!("目录 {path} 命中围栏 denyRoots {denied_by} → 整棵子树不可达，未枚举（plan §0.1：leaf 判据不许伸进应用自带的运行时资源）"),
            );
            return true;
        }
        if !self.fence_allows(path) {
            let allow = self.fence.allow.join("、");
            self.exclude(
                Some(rule_id),
                path,
                ExclusionReason::OutsideFence,
                format!("目录 {path} 不在围栏 allowRoots [{allow}] 之内 → 不是这条规则的采集面，未枚举"),
            );
            return true;
        }
        false
    }

    fn open_dir(&mut self, path: &str, rule_id: &str) -> Option<Vec<NodeView>> {
        if self.fence_blocks(path, rule_id) {
            return None;
        }
        let id = self.source.dir_id_by_path(path)?;
        Some(self.source.children_of(id))
    }

    /// 通配展开：`*` 恰好一层目录名，取值**一律来自扫描树**（不碰磁盘）。
    fn expand_step(&mut self, dir: &str, seg: &str, rule_id: &str) -> Vec<String> {
        let Some(kids) = self.open_dir(dir, rule_id) else { return Vec::new() };
        let mut out = Vec::new();
        for k in kids {
            if k.kind != NodeKind::Directory {
                continue;
            }
            if let Some(hit) = is_forbidden_path(&k.path, &self.forbidden_roots) {
                self.exclude(
                    Some(rule_id),
                    &k.path,
                    ExclusionReason::ForbiddenRoot,
                    format!("命中 §16 🔴 禁止路径 {hit} → 不作为候选地盘，未枚举"),
                );
                continue;
            }
            if seg == "*" {
                out.push(k.path);
                continue;
            }
            let base = segs_of(&k.path).pop().unwrap_or_default();
            if crate::matcher::glob_match(&base, seg) {
                out.push(k.path);
            }
        }
        out
    }

    /// 一条 paths 模板 → 扫描树上真实存在的地盘清单（可能 0 条）。
    fn resolve_territory(&mut self, pattern: &str, rule: &Rule) -> Vec<String> {
        // **先无条件开账**（TS `resolveTerritory` 的第一句就是 `territoryLedger(rule, st)`）。
        // 少了这一句，一条"第一条路径就撞上 unresolved-env"的规则（内置表里 maven / gradle /
        // huggingface 都是 `%USERPROFILE%\...`）在底账里**整条缺席** —— 而 §3.6 那一页正是靠
        // 这张表分开「没装」「没扫到」「盘上真没有」三种 0 的。缺席 ≠ 三种里的哪一种。
        let _ = self.ledger(rule);

        let res = resolve_pattern(pattern, self.env);
        let rule_id = rule.id.clone();
        if res.unresolved_var.is_some() {
            let v = res.unresolved_var.clone().unwrap_or_default();
            self.exclude(
                Some(&rule_id),
                pattern,
                ExclusionReason::UnresolvedEnv,
                format!("环境变量 %{v}% 未注入，无法定位该路径（不猜、不读真机）"),
            );
            return Vec::new();
        }
        // ⚠️ **这里不许加 `broad-container` / `pattern-not-leaf` 的早退**。我加过，结果是
        // `%SYSTEMDRIVE%\` 这条规则被 BroadContainer 拦在收尾把关之前，于是
        // **"地盘套住禁止路径"这条根本轮不到触发** —— 而它正是"整盘当清理范围"最该被拦住的地方。
        // TS 里这两个理由是**静态闸**（`validateRuleSet`，带 env 解析后再比段）的事，
        // 不在 `resolveTerritory` 里。Rust 侧的静态闸落在 `validate.rs::validate_rule_set`
        // —— 它目前**还没有**这两条判据，那是一个已登记的对账缺口（见 `tests/parity_with_ts.rs`），
        // 不是"本来就不用做"。

        let mut frontier: Vec<String> = res.base.clone().into_iter().collect();
        for seg in &res.rest {
            if frontier.is_empty() {
                break;
            }
            let wild = seg.contains('*') || seg.contains('?');
            let mut next: Vec<String> = Vec::new();
            for dir in &frontier {
                if wild {
                    for c in self.expand_step(dir, seg, &rule_id) {
                        if !next.contains(&c) {
                            next.push(c);
                        }
                    }
                } else {
                    let cand = join_win(dir, seg);
                    if let Some(hit) = is_forbidden_path(&cand, &self.forbidden_roots) {
                        self.exclude(
                            Some(&rule_id),
                            &cand,
                            ExclusionReason::ForbiddenRoot,
                            format!("命中 §16 🔴 禁止路径 {hit} → 不作为候选地盘"),
                        );
                        continue;
                    }
                    if self.source.dir_id_by_path(&cand).is_none() {
                        let fresh = self.exclude(
                            Some(&rule_id),
                            &cand,
                            ExclusionReason::NotScanned,
                            "本次扫描没有覆盖该目录（没扫到 ≠ 不存在，按未知处理）".to_string(),
                        );
                        if fresh {
                            if let Some(l) = self.ledger(rule) {
                                l.not_scanned += 1;
                            }
                        }
                        continue;
                    }
                    if !next.contains(&cand) {
                        next.push(cand);
                    }
                }
            }
            frontier = next;
        }

        // 收尾统一把关
        let mut out: Vec<String> = Vec::new();
        for dir in frontier {
            if let Some(hit) = is_forbidden_path(&dir, &self.forbidden_roots) {
                self.exclude(
                    Some(&rule_id),
                    &dir,
                    ExclusionReason::ForbiddenRoot,
                    format!("命中 §16 🔴 禁止路径 {hit} → 地盘不可达"),
                );
                continue;
            }
            // 地盘套住了禁止路径：宽容器一律不认（§28 原则四）。
            // 这一条就是"根闸"的评估层半边 —— `C:\` 当授权根时它必然命中。
            if let Some(swept) = self
                .forbidden_roots
                .iter()
                .find(|f| path_is_under(f, &dir) && normalize_key(f) != normalize_key(&dir))
                .cloned()
            {
                self.exclude(
                    Some(&rule_id),
                    &dir,
                    ExclusionReason::AncestorOfProtected,
                    format!("地盘 {dir} 套住了禁止路径 {swept}，宽容器一律不认（§28 原则四）"),
                );
                continue;
            }
            if self.source.dir_id_by_path(&dir).is_none() {
                let fresh = self.exclude(
                    Some(&rule_id),
                    &dir,
                    ExclusionReason::NotScanned,
                    "本次扫描没有覆盖该目录（没扫到 ≠ 不存在，按未知处理）".to_string(),
                );
                if fresh {
                    if let Some(l) = self.ledger(rule) {
                        l.not_scanned += 1;
                    }
                }
                continue;
            }
            if let Some(ro) = self.report_only_block(&dir, rule) {
                self.exclude(
                    Some(&rule_id),
                    &dir,
                    ExclusionReason::ReportOnlyRoot,
                    format!("地盘 {dir} 落在只上报根 {ro} 之内 → 非 🔴 规则不许把它当清理范围"),
                );
                continue;
            }
            if !out.contains(&dir) {
                out.push(dir.clone());
                let sz = self.source.dir_id_by_path(&dir).and_then(|id| self.source.size_of(id));
                if let Some(l) = self.ledger(rule) {
                    l.present.entry(dir.clone()).or_insert(sz);
                }
            }
        }
        out.sort_by(|a, b| normalize_key(a).cmp(&normalize_key(b)));
        out
    }

    /// 在一个地盘里收文件：**显式栈遍历**（递归会把深树变成栈溢出），禁止目录永不 open。
    fn collect_territory(&mut self, root: &str, rule: &Rule, agg: &mut Agg) {
        let rule_id = rule.id.clone();
        let mut stack: Vec<(String, usize)> = vec![(root.to_string(), 0)];
        let mut visited: HashSet<String> = HashSet::new();
        while let Some((cur, depth)) = stack.pop() {
            let key = normalize_key(&cur);
            if !visited.insert(key) {
                continue; // 树按构造无环，这层是兜底：任何情况下都不许无限转圈
            }
            let Some(kids) = self.open_dir(&cur, &rule_id) else { continue };
            for k in kids {
                if k.kind == NodeKind::Directory {
                    if !rule.scanner.recursive {
                        continue;
                    }
                    // 整棵子树按**目录级**拦掉：一条宽路径规则套住回收站时，排除记录只有一条
                    // 点名到那个目录，不会变成几万条噪声把真正的排除淹没。
                    if let Some(ro) = self.report_only_block(&k.path, rule) {
                        self.exclude(
                            Some(&rule_id),
                            &k.path,
                            ExclusionReason::ReportOnlyRoot,
                            format!("整棵子树落在只上报根 {ro} 之内 → 不认领其中任何文件"),
                        );
                        continue;
                    }
                    if depth + 1 > MAX_WALK_DEPTH {
                        self.exclude(
                            Some(&rule_id),
                            &k.path,
                            ExclusionReason::NotScanned,
                            format!("超过评估深度上限 {MAX_WALK_DEPTH}，按未知处理"),
                        );
                        continue;
                    }
                    stack.push((k.path, depth + 1));
                    continue;
                }
                self.take_file(&k, rule, agg);
            }
        }
    }

    /// 任意深度找 leaf（spec §2.2）。五条规矩都在这一段：
    ///  · 目录 basename 命中 `leafDirs` → 它就是采集根，收文件走**既有的** `collect_territory`
    ///    （`filePatterns` / `recursive` / `olderThanDays` 那一套判据一个都不另立），并且**不再深入**
    ///    找第二个命中 —— 里面再有一个 `Cache` 也是同一棵子树，分开收就是同一条规则计两次；
    ///  · 文件 basename 命中 `leafFiles` → 就地计，认领判据还是 `take_file` 那五道（同一把 glob，
    ///    `matcher.rs` / `nameMatches` 是全仓唯一的一份，plan Global Constraints）；
    ///  · 深度上限只有 `MAX_WALK_DEPTH` 这一把尺子（不许出现第二个），超限**记下来**而不是静默截掉；
    ///  · 重解析点目录跳过、不跟进；围栏在 `open_dir` 那一层拦，所以越栏目录连"被列举"都不发生；
    ///  · 子目录 basename 整名命中 `PACKAGE_TREE_NAMES`（第三方代码树）→ **不进入**、记一条
    ///    `package-tree` 点名那个目录（M5-P2 P2-T5 裁定 1）。这一条与围栏**同一个形状**：
    ///    包树目录不被打开，其中任何东西都不可能被认领 —— 两种 leaf 模式都吃这条判据。
    ///
    /// 计划 §3 给的签名是 `walk_leaf(&mut self, dir, rule, depth)`，这里多一个 `out`：
    /// 账本与命中的根要交回 `evaluate_rule`，把它们挂到 `St` 上就成了引擎级的一口锅
    /// （跨规则串账）。偏离已登记在 plan §10。
    fn walk_leaf(&mut self, dir: &str, rule: &Rule, depth: usize, out: &mut RuleAgg) {
        let rule_id = rule.id.clone();
        if !out.walked.insert(normalize_key(dir)) {
            return; // 两个入口套住同一棵子树 / 某个入口正是上一条命中的 leaf
        }
        let dirs_mode = !rule.scanner.leaf_dirs.is_empty();
        let files_mode = !rule.scanner.leaf_files.is_empty();
        // 入口自己就命中名单（`paths` 直接写到一个 `Cache` 上）也照收 —— 收完就停，不再往里找
        if dirs_mode && name_matches(&base_name(dir), &rule.scanner.leaf_dirs) {
            if !out.roots.iter().any(|r| normalize_key(r) == normalize_key(dir)) {
                out.roots.push(dir.to_string());
            }
            self.collect_territory(dir, rule, &mut out.agg);
            return;
        }
        let Some(kids) = self.open_dir(dir, &rule_id) else { return };
        for k in kids {
            if k.kind == NodeKind::Directory {
                if is_reparse_point(&k) {
                    self.exclude(
                        Some(&rule_id),
                        &k.path,
                        ExclusionReason::NotScanned,
                        format!("目录 {} 是重解析点（FILE_ATTRIBUTE_REPARSE_POINT）→ 不跟进去，与扫描器 SkipReason::Reparse 同一口径", k.path),
                    );
                    continue;
                }
                if depth + 1 > MAX_WALK_DEPTH {
                    self.exclude(
                        Some(&rule_id),
                        &k.path,
                        ExclusionReason::NotScanned,
                        format!("超过评估深度上限 {MAX_WALK_DEPTH}，按未知处理（点名到这一个目录，不是把整条分支静默截掉）"),
                    );
                    continue;
                }
                // M5-P2 P2-T5 裁定 1：**包树不进 leaf 采集**（plan §5 末节）。
                // 排在 leafDirs 命中**之前**、`open_dir` 之前 —— 与 `fence_blocks` 同一个形状：
                // 那一棵子树连"被列举"都不发生，不是"列举完再把里面的命中滤掉"（plan §0.2）。
                // 判据对 `leafDirs` 与 `leafFiles` 两种模式**同时**生效（轮转件与安装包 glob 一样会撞进代码树）。
                if let Some(hit) = package_tree_hit(&k.name) {
                    self.exclude(
                        Some(&rule_id),
                        &k.path,
                        ExclusionReason::PackageTree,
                        format!("目录 {} 是第三方代码树（basename 整名命中包树名单 {hit}）→ 整棵子树不进 leaf 采集，未枚举", k.path),
                    );
                    continue;
                }
                // **CLEANUP-RULES §6 的 guard**：名字像缓存、但长在用户数据容器里 —— 同样不枚举。
                // 排在 `leafDirs` 命中之前：命中之后就 `collect_territory` 了，那时候再拦就是"枚举完再滤"。
                if let Some(seg) = user_data_leaf_hit(&k.name, &k.path).filter(|_| rule.category == crate::types::RuleCategory::AppTransient) {
                    self.exclude(
                        Some(&rule_id),
                        &k.path,
                        ExclusionReason::UserDataLeaf,
                        format!(
                            "目录 {} 的名字是约定缓存名，但它长在用户数据容器里（路径含「{seg}」）→ \
                             按 §6 R-DENY-USERDATA / R-DENY-MSACTIVITY 的 guard 整棵不进采集，未枚举：\
                             这里装的是登录态 / 配置 / 会话，删掉不是「重下就能回来」",
                            k.path
                        ),
                    );
                    continue;
                }
                if dirs_mode && name_matches(&k.name, &rule.scanner.leaf_dirs) {
                    if !out.roots.iter().any(|r| normalize_key(r) == normalize_key(&k.path)) {
                        out.roots.push(k.path.clone());
                    }
                    self.collect_territory(&k.path, rule, &mut out.agg);
                    continue; // 命中即停
                }
                self.walk_leaf(&k.path, rule, depth + 1, out);
                continue;
            }
            if files_mode && name_matches(&k.name, &rule.scanner.leaf_files) {
                self.take_file(&k, rule, &mut out.agg);
            }
        }
    }

    /// 五道判据的**顺序不能换** —— 每一条都可能在前面那条之前就改变了结论。
    fn take_file(&mut self, k: &NodeView, rule: &Rule, agg: &mut Agg) {
        let rule_id = rule.id.clone();
        if let Some(hit) = is_forbidden_path(&k.path, &self.forbidden_roots) {
            self.exclude(
                Some(&rule_id),
                &k.path,
                ExclusionReason::ForbiddenRoot,
                format!("命中 §16 🔴 禁止路径 {hit} → 0 字节计入"),
            );
            return;
        }
        // §28 原则二的真属性判据：属性证得出 SYSTEM 就保护，与路径长什么样无关
        if k.attrs.is_some_and(|a| a & ATTR_SYSTEM != 0) {
            self.exclude(
                Some(&rule_id),
                &k.path,
                ExclusionReason::ProtectedAttrs,
                "文件属性已证明 SYSTEM（§28 原则二）→ 即使路径合法也不进任何清理地盘".to_string(),
            );
            return;
        }
        if !name_matches(&k.name, &rule.scanner.file_patterns) {
            return;
        }
        if let Some(days) = rule.scanner.older_than_days {
            if k.mtime_ms > self.now_ms - (days as i64) * DAY_MS {
                return;
            }
        }
        if let Some(ro) = self.report_only_block(&k.path, rule) {
            self.exclude(
                Some(&rule_id),
                &k.path,
                ExclusionReason::ReportOnlyRoot,
                format!("落在只上报根 {ro} 之内 → 占用如实报告，但非 🔴 规则不许认领"),
            );
            return;
        }
        let nk = normalize_key(&k.path);
        if let Some(owner) = self.claimed.get(&nk) {
            if owner != &rule_id {
                let owner = owner.clone();
                self.exclude(
                    Some(&rule_id),
                    &k.path,
                    ExclusionReason::ClaimedByOtherRule,
                    format!("已由规则 {owner} 计入，不双计（§17 的预估释放空间必须是真的）"),
                );
                return;
            }
        }
        self.claimed.insert(nk, rule_id.clone());
        agg.count += 1;
        agg.bytes += k.size;
        agg.paths.push(PathHit { path: k.path.clone(), size: k.size });
    }

    fn evaluate_rule(&mut self, rule: &Rule) -> RuleFinding {
        let mut out = RuleAgg::default();
        let dirs_mode = !rule.scanner.leaf_dirs.is_empty();
        let files_mode = !rule.scanner.leaf_files.is_empty();
        let leaf_mode = dirs_mode || files_mode;
        // 第三种采集模式（plan §2.4）：声明了机器事实闸的规则，采集根 = 入口的直属子目录。
        // 声明层（`validate.rs`）已经保证它**不可能**同时带 `leaf*` —— 混用是 `AmbiguousLeafMode`，
        // 所以这三判据在这里不必再排优先级。
        let app_fact_mode = wants_absent_app_fact(rule);

        for pattern in &rule.paths {
            for t in self.resolve_territory(pattern, rule) {
                if app_fact_mode {
                    self.collect_app_fact_entry(&t, rule, &mut out);
                    continue;
                }
                if leaf_mode {
                    // leaf 模式的采集面由 `walk_leaf` 决定：
                    //  · `leafDirs` → `matched_roots` 就是命中的那些目录（入口容器不是地盘，
                    //    把它列进去等于对用户宣布"我要清整个 AppData\Local"）；
                    //  · `leafFiles` → 没有"命中目录"这一层概念，根就是被搜过的那一层入口
                    //    （与既有口径同一姿态：根 = 这条规则从哪一层往里收）。
                    self.walk_leaf(&t, rule, 0, &mut out);
                    if !dirs_mode && !out.roots.contains(&t) {
                        out.roots.push(t.clone());
                    }
                    continue;
                }
                if !out.roots.contains(&t) {
                    out.roots.push(t.clone());
                }
                self.collect_territory(&t, rule, &mut out.agg);
            }
        }
        if dirs_mode || app_fact_mode {
            // 命中次序是遍历次序，不是判据；按归一化排一次，两次跑必须同序
            // （多个入口时这一条不是装饰：`paths` 写三条容器根，根数组原本是**按入口分组**的）
            out.roots.sort_by(|a, b| normalize_key(a).cmp(&normalize_key(b)));
        }
        let mut agg = out.agg;
        let roots = out.roots;
        agg.paths.sort_by(|a, b| normalize_key(&a.path).cmp(&normalize_key(&b.path)));
        // 完整清单**只在点名时**挂上：默认不改变报告形状（Task 16/17 的断言不受影响）
        let all = if self.collect_all_for.contains(&rule.id) {
            Some(agg.paths.clone())
        } else {
            None
        };
        finding(rule, roots, agg, self.list_cap, all)
    }

    /// 没装的工具：**一条 finding 都不出**，但它解析出的每条地盘都要在 `exclusions[]` 里点名。
    ///
    /// 为什么不能只是"跳过"：跳过之后那块地盘从 `reclaimable_bytes` 里消失，而这份报告和
    /// "这机器上根本没有这块缓存"长得一模一样 —— 静默消失与误报同样坏。
    /// 也**不能顺手回一条 0 字节的 finding**：那会让 `findings` 的条数与 TS 分叉
    /// （TS 是 `continue`，压根不 push），于是"哪些规则上表了"这件事在两套实现里不一样。
    /// 我第一版就是把 `finding(...)` 放在 `return` 里带出来的，被零容差对账当场打红。
    fn exclude_rule_as_not_installed(&mut self, rule: &Rule, detector_id: &str) {
        if let Some(l) = self.ledger(rule) {
            l.detector_absent = true;
        }
        for pattern in &rule.paths {
            for t in self.resolve_territory(pattern, rule) {
                self.exclude(
                    Some(&rule.id),
                    &t,
                    ExclusionReason::NotInstalled,
                    format!(
                        "探测器「{detector_id}」判定「{}」依赖的工具未安装 → 本条地盘不计入可回收（0 字节）",
                        rule.name
                    ),
                );
            }
        }
    }
}

/// 拼一层子路径。**不能直接 `format!("{dir}\{seg}")`** —— `dir` 是 `C:\` 时会拼出
/// `C:\Temp`（双分隔符），而 `normalize_key` 不折叠内部双分隔符 ⇒ `dir_id_by_path` 查不到 ⇒
/// **整块地盘静默变成 not-scanned**（0 字节，还带着一条"没扫到"的排除记录，看起来完全正常）。
/// 我第一版就是这么写的，被 `a_simple_rule_claims_its_territory` 当场打红。
///
/// `pub`：`tree_source` 适配器拼文件路径时用的是**同一把** —— 两处各写一份就是两套路径口径
/// （TS 侧同样是 `pathutil.ts` 的单一 `joinWin`，`engine.ts` 与 `tree-store.ts` 都用它）。
pub fn join_win(dir: &str, seg: &str) -> String {
    let d = dir.trim_end_matches(['\\', '/']);
    format!("{d}\\{seg}")
}

fn finding(
    rule: &Rule,
    roots: Vec<String>,
    agg: Agg,
    list_cap: usize,
    all: Option<Vec<PathHit>>,
) -> RuleFinding {
    let listed: Vec<PathHit> = agg.paths.iter().take(list_cap).cloned().collect();
    RuleFinding {
        rule_id: rule.id.clone(),
        name: rule.name.clone(),
        category: rule.category,
        risk_level: rule.risk_level,
        clean_strategy: rule.clean_strategy,
        recoverable: rule.recoverable,
        matched_roots: roots,
        sample_paths: listed,
        sample_truncated: agg.paths.len() > list_cap,
        file_count: agg.count,
        total_bytes: agg.bytes,
        all_paths: all,
    }
}

/// 把规则表套到树上。**纯读** —— 不产生任何动作。
pub fn evaluate_rules(
    source: &dyn RuleSource,
    rules: &[Rule],
    env: &RuleEnv,
    opts: &EvaluateOptions,
) -> RuleReport {
    let (mut forbidden_roots, f_unresolved) = resolve_roots(&opts.forbidden_patterns, env);
    let (mut report_only_roots, ro_unresolved) = resolve_roots(&opts.report_only_patterns, env);
    // 报告里的这两张表是**升序**的（TS `emptyReport` 就是这么给的），预览/执行层拿它直接比。
    forbidden_roots.sort();
    report_only_roots.sort();

    // fail-safe：🔴 清单自己落不了地，就等于引擎处于"看不见禁止路径"的状态。
    // 这时**一条结论都不给** —— 连 `findings` 都不产出。TS 就是这个形状：
    // 它在这条路上直接 `return report`，并把**全部**规则记成被拒。
    // 原先 Rust 只是把 `safety_blocked` 置位、照旧把 findings 算完 —— 那是"看着有保护，
    // 实际报告里躺着一份可清理清单"，而消费方一旦漏检这个标志就会拿它去执行。
    let mut unresolved = f_unresolved;
    unresolved.extend(ro_unresolved);
    if !unresolved.is_empty() {
        let mut exclusions = Vec::new();
        for p in &unresolved {
            exclusions.push(Exclusion {
                rule_id: None,
                path: p.clone(),
                reason: ExclusionReason::ForbiddenRootUnresolved,
                detail: format!(
                    "禁止路径模板无法解析（环境变量缺失）：{p} → 保护失效，本次不出结论"
                ),
            });
        }
        return RuleReport {
            findings: Vec::new(),
            exclusions,
            rejected_rules: rules
                .iter()
                .map(|r| RejectedRule {
                    rule_id: r.id.clone(),
                    name: r.name.clone(),
                    // 与 TS 同：这一条路上每条被拒规则都挂**同一个**合成问题，`path` 是全部
                    // 没解析出来的模板拼串（不是逐条一份）—— 用户要看到的是"哪些保护没落地"。
                    problems: vec![RejectedProblem {
                        rule_id: r.id.clone(),
                        path: unresolved.join("、"),
                        reason: "forbidden-root-unresolved".into(),
                        detail: format!(
                            "禁止路径模板无法解析（环境变量缺失）：{} → 保护失效，本次不出结论",
                            unresolved.join("、")
                        ),
                    }],
                })
                .collect(),
            forbidden_roots,
            report_only_roots,
            territories: Vec::new(),
            bytes_by_risk: BytesByRisk::default(),
            reclaimable_bytes: 0,
            safety_blocked: true,
            // fail-safe 那条路上没有任何认领发生（整份报告不出结论），所以也不交表。
            claimed_paths: None,
        };
    }

    let mut st = St {
        source,
        env,
        forbidden_roots,
        report_only_roots,
        detector_status: opts.detector_status.clone(),
        app_facts: opts.app_facts.clone(),
        app_fact_whys: opts.app_fact_whys.clone(),
        fence: Fence::default(),
        now_ms: opts.now_ms,
        list_cap: if opts.max_listed_paths > 0 { opts.max_listed_paths } else { 50 },
        collect_all_for: opts.collect_all_paths_for.clone(),
        exclusions: Vec::new(),
        seen: HashSet::new(),
        claimed: BTreeMap::new(),
        ledgers: BTreeMap::new(),
    };

    // 声明层闸门**整表一次**：规则之间的"地盘套住别家叶子"判据只有看到全表才判得出来
    // （TS 的 `validateRuleSet` 也是整表收）。原先这里是逐条 `validate_rule_set(&[rule])`，
    // 等于把那条判据静默关掉了 —— 单条规则永远不可能"套住别家"。
    let validation = crate::validate::validate_rule_set(
        rules,
        env,
        &opts.forbidden_patterns,
        &opts.report_only_patterns,
    );
    let valid: BTreeSet<usize> = validation.valid.iter().copied().collect();
    let valid_ids: BTreeSet<&str> =
        valid.iter().filter_map(|&i| rules.get(i)).map(|r| r.id.as_str()).collect();

    let mut findings = Vec::new();
    let mut rejected_rules: Vec<RejectedRule> = Vec::new();
    for p in &validation.problems {
        // 与 TS 同两条筛子（`engine.ts:716`）：问题指不到具体规则、或那条规则其实通过了校验，
        // 都**不算整条被拒**。少筛一条就会让预览念出"这条规则被声明层拒了"，而它照常产出了
        // findings。
        //
        // `rule-rejected` 那条**排除记录**也走同两条筛子、同一个循环 —— TS 就是这么写的
        // （`engine.ts:719` 在筛子之后）。分成两个循环时这里是"没筛子的那一份"，
        // 两条判据今天等价只因为校验器每条 problem 都紧跟一个 `continue`（valid 与 problem
        // 互斥）；把一致写成结构而不是巧合。
        let Some(r) = rules.iter().find(|x| x.id == p.rule_id) else { continue };
        if valid_ids.contains(r.id.as_str()) {
            continue;
        }
        let reason = serde_json::to_value(p.reason)
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| format!("{:?}", p.reason));
        let detail = format!("规则被拒（{reason}）：{}", p.detail);
        st.exclude(
            Some(&p.rule_id),
            &p.path,
            ExclusionReason::RuleRejected,
            detail.clone(),
        );
        let problem = RejectedProblem {
            rule_id: p.rule_id.clone(),
            path: p.path.clone(),
            reason,
            detail,
        };
        match rejected_rules.iter_mut().find(|x| x.rule_id == p.rule_id) {
            Some(owner) => owner.problems.push(problem),
            None => rejected_rules.push(RejectedRule {
                rule_id: r.id.clone(),
                name: r.name.clone(),
                problems: vec![problem],
            }),
        }
    }
    for (i, rule) in rules.iter().enumerate() {
        if !valid.contains(&i) {
            continue;
        }
        // 围栏是**按规则**生效的：换规则就得换围栏（带着上一条的围栏跑这一条 = 别人的边界）
        st.begin_rule(rule);
        if let Some(det) = st.absent_detector(rule) {
            st.exclude_rule_as_not_installed(rule, &det);
            continue;
        }
        let gated = wants_absent_app_fact(rule);
        let finding = st.evaluate_rule(rule);
        // 机器事实一个候选都没批下来：**不出 finding**（与 `not-installed` 同一个形状 ——
        // `findings` 的条数是"哪些规则上表了"这件事，TS 是 `continue` 压根不 push，
        // 一侧出 0 字节 finding 一侧不出会让两套实现对"上没上表"给出不同答案）。
        // 弃权的原因已经逐条落在 `exclusions[]` 里点名了，这里不是静默消失。
        if gated && finding.matched_roots.is_empty() && finding.file_count == 0 {
            continue;
        }
        findings.push(finding);
    }

    // §16：🔴 照常识别容量，但**绝不进「可回收」合计**
    let mut bytes_by_risk = BytesByRisk::default();
    for f in &findings {
        add_bytes_by_risk(&mut bytes_by_risk, f.risk_level, f.total_bytes);
    }
    let reclaimable_bytes = reclaimable_of(&bytes_by_risk);

    // §3.6 地盘底账：条目早就在 `St::ledgers` 里（只有带探测器那几条规则开账），这里只是导出。
    // `ledgers` / `present` 都是 `BTreeMap`，所以"按 ruleId 升序 + present 按路径升序"是构造出来的。
    let territories: Vec<TerritoryFact> = st
        .ledgers
        .iter()
        .map(|(rule_id, l)| TerritoryFact {
            rule_id: rule_id.clone(),
            detector_absent: l.detector_absent,
            present: l
                .present
                .iter()
                .map(|(path, bytes)| TerritoryPresent { path: path.clone(), bytes: *bytes })
                .collect(),
            not_scanned: l.not_scanned,
        })
        .collect();

    // §12：要交表就把那张表**搬**出去（`mem::take`），不 clone —— 一棵大树的认领表是几十万条量级，
    // 复制一份只为过一次 IPC 等于把预估的成本翻倍。
    let claimed_paths = if opts.report_claims { Some(std::mem::take(&mut st.claimed)) } else { None };

    RuleReport {
        findings,
        exclusions: st.exclusions,
        rejected_rules,
        forbidden_roots: st.forbidden_roots,
        report_only_roots: st.report_only_roots,
        territories,
        bytes_by_risk,
        reclaimable_bytes,
        safety_blocked: false,
        claimed_paths,
    }
}

/// 把禁止/只上报模板解析成具体根。**返回解不出来的那些模板**（调用方据此 fail-safe）。
///
/// ⚠️ **与 `validate.rs::resolve_roots` 是同一把尺子的两份写法**（那一份是声明层、这一份是评估层），
/// 两处必须逐字同口径 —— 差别只在：这一份会裁剪收尾分隔符（`%PROGRAMFILES%\` → `C:\Program Files`），
/// 免得报告里的禁止根与 TS/声明层的写法不一致（`path_is_under` 按段边界判，带不带尾分隔符结论相同）。
fn resolve_roots(patterns: &[String], env: &RuleEnv) -> (Vec<String>, Vec<String>) {
    let mut out = Vec::new();
    let mut unresolved = Vec::new();
    let cut = |s: String| -> String {
        let mut s = s;
        while s.len() > 3 && (s.ends_with('\\') || s.ends_with('/')) {
            s.pop();
        }
        s
    };
    for p in patterns {
        let r = resolve_pattern(p, env);
        match (r.concrete, r.base) {
            (Some(c), _) => out.push(cut(c)),
            (None, Some(b)) => out.push(cut(b)),
            (None, None) => unresolved.push(p.clone()),
        }
    }
    (out, unresolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin::builtin_rules;
    use crate::types::{CleanStrategy, RuleCategory, RuleScanner, RuleScopeFence};

    /// 合成树：目录按归一化路径建索引，id 从 1 起。
    /// `opened` 记的是**被枚举过**的目录 —— 「禁止 / 越栏 / 重解析点连被列举都不发生」这句话
    /// 只能这样验：0 字节是"结果对了"，没枚举才是"结构上到不了"（TS 侧同一个装置是 `guardedSource`）。
    #[derive(Default)]
    struct FakeTree {
        ids: BTreeMap<String, i64>,
        kids: BTreeMap<i64, Vec<NodeView>>,
        sizes: BTreeMap<i64, u64>,
        /// `dir_id → 路径`，只为 `opened` 那条断言服务
        paths: BTreeMap<i64, String>,
        opened: std::cell::RefCell<Vec<String>>,
    }

    impl RuleSource for FakeTree {
        fn dir_id_by_path(&self, path: &str) -> Option<i64> {
            self.ids.get(&normalize_key(path)).copied()
        }
        fn children_of(&self, dir_id: i64) -> Vec<NodeView> {
            if let Some(p) = self.paths.get(&dir_id) {
                self.opened.borrow_mut().push(p.clone());
            }
            self.kids.get(&dir_id).cloned().unwrap_or_default()
        }
        fn size_of(&self, dir_id: i64) -> Option<u64> {
            self.sizes.get(&dir_id).copied()
        }
    }

    /// `FILE_ATTRIBUTE_REPARSE_POINT`（`crates/scanner/src/enumerate.rs` 用的是同一个位）
    const ATTR_REPARSE_POINT: u32 = 0x400;

    /// 建夹具：`files` 是「文件路径 → 字节」，祖先目录自动补齐 ——
    /// 真实扫描出来的树里 `C:\a\b` 在则 `C:\a` 必在，规则的地盘要靠中间层逐级钻下去，
    /// 不补就是造一棵断头树（TS 侧 `storeFrom` 同一条构造纪律）。
    /// `reparse_dirs` 里那些目录补上 `FILE_ATTRIBUTE_REPARSE_POINT`。
    fn tree_of_files(files: &[(&str, u64)], reparse_dirs: &[&str]) -> FakeTree {
        // 构造期用**归一化路径**当键：`NodeView` 里没有 dir_id 可用，id 最后统一发。
        let mut dirs: BTreeMap<String, String> = BTreeMap::new(); // 键 → 原样路径
        let mut children: BTreeMap<String, Vec<NodeView>> = BTreeMap::new(); // 父 → 直属子项
        for (path, size) in files {
            let segs = segs_of(path);
            if segs.len() < 2 {
                panic!("夹具文件必须有父目录：{path}");
            }
            let parent = tokens_join(&segs[..segs.len() - 1]);
            ensure_dir_chain(&mut dirs, &mut children, &parent);
            children.entry(normalize_key(&parent)).or_default().push(NodeView {
                kind: NodeKind::File,
                name: segs.last().cloned().unwrap_or_default(),
                path: path.to_string(),
                size: *size,
                mtime_ms: 1,
                attrs: Some(0),
            });
        }
        for d in reparse_dirs {
            let key = normalize_key(d);
            let parent = normalize_key(&parent_of(d));
            let kids = children.get_mut(&parent).unwrap_or_else(|| panic!("夹具里没有目录 {d}"));
            let k = kids
                .iter_mut()
                .find(|k| k.kind == NodeKind::Directory && normalize_key(&k.path) == key)
                .unwrap_or_else(|| panic!("夹具里没有目录 {d}"));
            k.attrs = Some(k.attrs.unwrap_or(0) | ATTR_REPARSE_POINT);
        }
        // 发 id（按归一化路径升序 ⇒ 浅的先发，id 稳定），再挂每层清单与子树合计
        let mut t = FakeTree::default();
        for (i, key) in dirs.keys().cloned().collect::<Vec<_>>().into_iter().enumerate() {
            let id = i as i64 + 1;
            t.ids.insert(key.clone(), id);
            t.paths.insert(id, dirs[&key].clone());
        }
        for (pkey, kids) in &children {
            let Some(&id) = t.ids.get(pkey) else { continue };
            let mut ks = kids.clone();
            ks.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            t.kids.insert(id, ks);
        }
        for (key, &id) in &t.ids {
            // 子树合计（`size_of` 的口径）：按段边界把所有后代的直属文件累起来
            let total: u64 = children
                .iter()
                .filter(|(p, _)| path_is_under(p, key))
                .flat_map(|(_, kids)| kids.iter())
                .filter(|k| k.kind == NodeKind::File)
                .map(|k| k.size)
                .sum();
            t.sizes.insert(id, total);
        }
        t
    }

    /// 把一条目录路径连同所有祖先建出来。
    fn ensure_dir_chain(
        dirs: &mut BTreeMap<String, String>,
        children: &mut BTreeMap<String, Vec<NodeView>>,
        path: &str,
    ) {
        let segs = segs_of(path);
        let mut cur = String::new();
        let mut parent_key = String::new();
        for (i, s) in segs.iter().enumerate() {
            cur = if i == 0 {
                if s.ends_with(':') {
                    format!("{s}\\")
                } else {
                    s.clone()
                }
            } else {
                join_win(&cur, s)
            };
            let key = normalize_key(&cur);
            if !dirs.contains_key(&key) {
                dirs.insert(key.clone(), cur.clone());
                if i > 0 && !parent_key.is_empty() {
                    children.entry(parent_key.clone()).or_default().push(NodeView {
                        kind: NodeKind::Directory,
                        name: s.clone(),
                        path: cur.clone(),
                        size: 0,
                        mtime_ms: 0,
                        attrs: Some(0x10),
                    });
                }
            }
            parent_key = key;
        }
    }

    /// 段序列拼回路径（首段是盘符时补回尾分隔符，与 `env::tokens_to_path` 同一口径）。
    fn tokens_join(segs: &[String]) -> String {
        let mut out = String::new();
        for (i, s) in segs.iter().enumerate() {
            if i == 0 {
                out = if s.ends_with(':') { format!("{s}\\") } else { s.clone() };
            } else {
                out = join_win(&out, s);
            }
        }
        out
    }

    fn parent_of(path: &str) -> String {
        let segs = segs_of(path);
        if segs.len() <= 1 {
            return String::new();
        }
        tokens_join(&segs[..segs.len() - 1])
    }

    fn dir(id: i64, path: &str) -> (String, i64, NodeView) {
        let name = segs_of(path).pop().unwrap_or_default();
        (
            normalize_key(path),
            id,
            NodeView {
                kind: NodeKind::Directory,
                name,
                path: path.to_string(),
                size: 0,
                mtime_ms: 0,
                attrs: Some(0x10),
            },
        )
    }

    fn file(path: &str, size: u64, attrs: Option<u32>) -> NodeView {
        NodeView {
            kind: NodeKind::File,
            name: segs_of(path).pop().unwrap_or_default(),
            path: path.to_string(),
            size,
            mtime_ms: 1,
            attrs,
        }
    }

    /// C:\ ├ Temp\ {a.tmp 100, b.tmp 200} ├ Windows\ ├ $Recycle.Bin\{deleted.bin 500}
    fn tree() -> FakeTree {
        let mut t = FakeTree::default();
        let mut add = |id: i64, p: &str, kids: Vec<NodeView>, size: u64| {
            let (k, i, v) = dir(id, p);
            t.ids.insert(k, i);
            t.kids.insert(i, kids);
            t.sizes.insert(i, size);
            let _ = v;
        };
        add(1, r"C:\", vec![
            file(r"C:\Temp", 0, Some(0x10)),
            file(r"C:\Windows", 0, Some(0x10)),
            file(r"C:\$Recycle.Bin", 0, Some(0x10)),
        ], 800);
        add(2, r"C:\Temp", vec![file(r"C:\Temp\a.tmp", 100, Some(0)), file(r"C:\Temp\b.tmp", 200, Some(0))], 300);
        add(3, r"C:\Windows", vec![file(r"C:\Windows\keep.dll", 400, Some(0))], 400);
        add(4, r"C:\$Recycle.Bin", vec![file(r"C:\$Recycle.Bin\deleted.bin", 500, Some(0))], 500);
        // 目录项里 Temp/Windows/$Recycle.Bin 是以 NodeView::file 占位的，这里补正 kind
        for id in [1i64] {
            if let Some(k) = t.kids.get_mut(&id) {
                for n in k.iter_mut() {
                    n.kind = NodeKind::Directory;
                }
            }
        }
        t
    }

    fn env() -> RuleEnv {
        let mut m = RuleEnv::new();
        m.insert("SYSTEMDRIVE".into(), "C:".into());
        // WINDIR 必须注入：禁止路径表里有 `%WINDIR%\System32` 等四条，
        // 少一个变量就整份报告 `safetyBlocked`（fail-safe 是对的，是我的夹具不完整）
        m.insert("WINDIR".into(), r"C:\Windows".into());
        m.insert("TEMP".into(), r"C:\Temp".into());
        // CLEANUP-RULES §6 补齐 R-DENY-* 之后，禁止根模板引用了这一族变量
        //（`%PROGRAMFILES%\` / `%PROGRAMDATA%\Package Cache` / `%USERPROFILE%\.codex` 一族）。
        //
        // ⚠️ **这三个键的值必须与本文件其余夹具同口径**（`C:\Roam` / `C:\Local` / `C:\Users\Kano`，
        // 见 `leaf_env`）：禁止根与只上报根都是按**解析后的绝对路径**逐段比的，值换一套写法
        // （例如 `C:\Users\Kano\AppData\Roaming`）会让「这条路径落在禁止根里」的判据在合成树上
        // 全部静默失效 —— 那是把守卫关掉而不是把它验红。2026-10-19 实测过一次：
        // 补键补错值，rules crate 30 条判据同时转红。
        m.insert("PROGRAMFILES".into(), r"C:\Program Files".into());
        m.insert("PROGRAMDATA".into(), r"C:\ProgramData".into());
        m.insert("USERPROFILE".into(), r"C:\Users\Kano".into());
        m.insert("APPDATA".into(), r"C:\Roam".into());
        m.insert("LOCALAPPDATA".into(), r"C:\Local".into());
        return m;
    }

    fn mk_rule(id: &str, risk: Risk, paths: &[&str]) -> Rule {
        Rule {
            id: id.into(),
            name: id.into(),
            category: RuleCategory::Temp,
            description: "t".into(),
            paths: paths.iter().map(|s| s.to_string()).collect(),
            scanner: RuleScanner { file_patterns: vec![], older_than_days: None, recursive: true, ..Default::default() },
            risk_level: risk,
            clean_strategy: CleanStrategy::DeleteAll,
            recoverable: true,
            requires_detector: None,
            excluded_from_default_selection: None,
            requires_absent_app_fact: None,
        }
    }

    fn report(rules: &[Rule]) -> RuleReport {
        evaluate_rules(&tree(), rules, &env(), &EvaluateOptions::default())
    }

    #[test]
    fn a_simple_rule_claims_its_territory() {
        let r = report(&[mk_rule("temp", Risk::Safe, &[r"%TEMP%"])]);
        let f = &r.findings[0];
        assert_eq!(f.total_bytes, 300, "a.tmp + b.tmp");
        assert_eq!(f.file_count, 2);
        assert_eq!(f.matched_roots, vec![r"C:\Temp"]);
        assert_eq!(r.reclaimable_bytes, 300);
        assert!(!r.safety_blocked);
    }

    /// **今天的一条结构性事实**：一条被拒规则最多挂**一份**问题。
    ///
    /// 为什么把这件事写成测试而不是只写注释：`rejected_rules` 按 TS 的形状是
    /// `problems: Vec<_>`，里面有"同一条规则的第二份问题并进同一组"那一路（`engine.ts:717`
    /// 的 `owner.problems.push(p)`）。M5-L 的变异电池把 `push` 换成覆盖时**一条用例都不红** ——
    /// 不是判据太弱，是没有输入走到那里：`validate_rule_set` 每个 `push` 之后紧跟
    /// `continue` 或 `rejected = true; break`，所以一条规则永远只产一份问题，分组那一路不可达。
    ///
    /// 这条测试把"不可达"钉在那里：哪天有人加一个不 `continue` 的判据，它先红，
    /// 那一刻分组的代码才真的活起来、也才有东西可红。`len() == 4` 兼作防空转 ——
    /// 断言遍历一个空集合会因为"全都满足"而绿。
    #[test]
    fn one_rejected_rule_carries_exactly_one_problem_so_the_grouping_is_unreachable() {
        let r = report(&[
            mk_rule("relative", Risk::Safe, &[r"AppData\Local\Temp"]),
            mk_rule("empty", Risk::Safe, &[]),
            mk_rule("greedy", Risk::Safe, &[r"%SYSTEMDRIVE%\$Recycle.Bin"]),
            mk_rule("whole-drive", Risk::Safe, &[r"%SYSTEMDRIVE%\"]),
        ]);
        assert_eq!(r.findings.len(), 0, "四条都该在声明层被整条拒掉");
        let ids: Vec<&str> = r.rejected_rules.iter().map(|x| x.rule_id.as_str()).collect();
        // 顺带把**表次序**钉住：进表顺序 = 问题首次出现的顺序，不是 BTreeSet 的字典序。
        assert_eq!(ids, vec!["relative", "empty", "greedy", "whole-drive"], "四条各进一次表");
        for rej in &r.rejected_rules {
            assert_eq!(rej.problems.len(), 1, "规则 {} 挂了 {} 份问题（分组那一路今天不该可达）", rej.rule_id, rej.problems.len());
            assert!(!rej.name.is_empty(), "{} 的 name 是空的 —— 预览那句会念成「规则「」」", rej.rule_id);
            assert!(!rej.problems[0].reason.is_empty(), "{} 的 reason 是空的", rej.rule_id);
        }
    }

    /// **承重墙（第一层：声明层）**：非 🔴 规则**在形状闸就被整条拒掉** ——
    /// 它连评估都走不到，所以 `findings` 是空的。
    ///
    /// 我最初把这条写成"评估层会记一条 `report-only-root`"，跑出来是
    /// `index out of bounds` —— 因为规则压根没进评估。**那说明闸比我想的更靠前**，
    /// 不是缺陷。两层各自成立才是这条要证的。
    #[test]
    fn a_non_forbidden_rule_naming_the_recycle_bin_is_rejected_outright() {
        let r = report(&[mk_rule("greedy", Risk::Safe, &[r"%SYSTEMDRIVE%\$Recycle.Bin"])]);
        assert!(r.findings.is_empty(), "整条被拒，不该产出 finding");
        assert!(r.exclusions.iter().any(|e| e.reason == ExclusionReason::RuleRejected));
        assert_eq!(r.reclaimable_bytes, 0);
    }

    #[test]
    fn the_forbidden_rule_reports_but_never_counts_as_reclaimable() {
        let mut bin = mk_rule("recycle-bin", Risk::Forbidden, &[r"%SYSTEMDRIVE%\$Recycle.Bin"]);
        bin.clean_strategy = CleanStrategy::ManualOnly;
        let r = report(&[bin]);
        assert_eq!(r.findings[0].total_bytes, 500, "🔴 照常识别容量（用户要看）");
        assert_eq!(r.reclaimable_bytes, 0, "但它绝不进可回收合计");
    }

    /// **承重墙（静态闸）**：`%SYSTEMDRIVE%\` 解析成 `C:\`，是禁止根 `C:\Windows\System32`
    /// 的祖先 → **声明层**就整条拒掉，连评估都不让它进。
    ///
    /// 这一条原先走的是评估层（旧的 Rust 静态闸只看模板字面量，`%SYSTEMDRIVE%` 与 `%WINDIR%`
    /// 不同名所以看不见）。补齐静态闸之后它在更靠前的一层就被拦住了 —— 而 TS 一直是这样。
    #[test]
    fn a_drive_root_rule_is_refused_at_the_static_gate() {
        let r = report(&[mk_rule("whole-drive", Risk::Safe, &[r"%SYSTEMDRIVE%\"])]);
        assert!(r.findings.is_empty(), "整条被拒，不该产出 finding");
        assert!(r.exclusions.iter().any(|e| e.reason == ExclusionReason::RuleRejected));
        assert_eq!(r.reclaimable_bytes, 0);
    }

    /// **评估层的第二道闸**：`%SYSTEMDRIVE%\W*` 带通配 ⇒ 静态闸拿不到 `concrete`，看不见它
    /// 会展开成 `C:\Windows`；评估层展开之后才发现它套住了禁止根 → `ancestor-of-protected`。
    /// 这条就是"静态看不出来、解析出来才发现"的活样本。
    #[test]
    fn a_wildcard_territory_that_sweeps_a_forbidden_root_is_refused() {
        let r = report(&[mk_rule("wild-sweep", Risk::Safe, &[r"%SYSTEMDRIVE%\W*"])]);
        assert_eq!(r.findings[0].total_bytes, 0, "地盘是 C:\\Windows → 整块不认");
        assert!(
            r.exclusions.iter().any(|e| e.reason == ExclusionReason::AncestorOfProtected),
            "实得 {:?}",
            r.exclusions.iter().map(|e| e.reason).collect::<Vec<_>>()
        );
        assert_eq!(r.reclaimable_bytes, 0);
    }

    #[test]
    fn a_file_is_claimed_once_and_the_second_rule_is_told_why() {
        let r = report(&[
            mk_rule("first", Risk::Safe, &[r"%TEMP%"]),
            mk_rule("second", Risk::Safe, &[r"%TEMP%"]),
        ]);
        assert_eq!(r.findings[0].total_bytes, 300);
        assert_eq!(r.findings[1].total_bytes, 0, "不双计");
        assert!(r.exclusions.iter().any(|e| e.reason == ExclusionReason::ClaimedByOtherRule));
        assert_eq!(r.reclaimable_bytes, 300, "可回收只算一次");
    }

    #[test]
    fn an_uninjected_variable_yields_no_territory_and_says_so() {
        let r = report(&[mk_rule("nope", Risk::Safe, &[r"%NOPE%\Cache"])]);
        assert_eq!(r.findings[0].total_bytes, 0);
        assert!(r.findings[0].matched_roots.is_empty());
        assert!(r.exclusions.iter().any(|e| e.reason == ExclusionReason::UnresolvedEnv));
    }

    #[test]
    fn system_attribute_protects_even_on_a_legal_path() {
        let mut t = tree();
        if let Some(k) = t.kids.get_mut(&2) {
            k.push(file(r"C:\Temp\sys.tmp", 700, Some(0x4)));
        }
        let r = evaluate_rules(&t, &[mk_rule("temp", Risk::Safe, &[r"%TEMP%"])], &env(), &EvaluateOptions::default());
        assert_eq!(r.findings[0].total_bytes, 300, "带 SYSTEM 属性的那个不进地盘");
        assert!(r.exclusions.iter().any(|e| e.reason == ExclusionReason::ProtectedAttrs));
    }

    #[test]
    fn safety_blocked_when_a_protected_root_cannot_be_resolved() {
        let mut o = EvaluateOptions::default();
        o.forbidden_patterns = vec![r"%NOT_INJECTED%\System32".to_string()];
        let r = evaluate_rules(&tree(), &[], &env(), &o);
        assert!(r.safety_blocked, "解析不出禁止根就 fail-safe：宁可不给结论，也不放行");
    }

    #[test]
    fn the_builtin_table_evaluates_cleanly_on_a_synthetic_tree() {
        // 23 条规则跑一棵小树：不该 panic，不该产生任何 claimed 冲突以外的异常。
        // **用 `leaf_env()` 而不是 `env()`**（四个键那份）—— 表尾三条是容器入口规则，
        // `env()` 里没有 APPDATA/PROGRAMDATA/PROGRAMFILES，它们会被声明层 fail-closed 拒掉，
        // `findings.len()` 于是停在 15 并**照样绿**（被拒的规则不出 finding，也不报错）。
        // 这条回归轴要数的是"二十三条全部上线"，所以夹具必须给得出八键 —— 生产给得出（service.rs）。
        let rules = builtin_rules();
        let r = evaluate_rules(&tree(), &rules, &leaf_env(), &EvaluateOptions::default());
        // findings 是 **22** 而不是 23：表上第 22 条（`orphan-app-data`）在空表下没有任何候选被批准，
        // 按 `evaluate_rules` 里那条 `continue` 不出 finding。第 23 条（`gpu-driver-leftovers`）
        // 的路径模板解析得出来（八键 env），树上看不到那三处地盘也照旧出一条 0 字节 finding
        // （与 dev-tool-cache 同一姿势）—— 所以 missing 里**仍然只有** orphan 那一条。
        // 这个 22 **不是**"有一条掉了"——掉了的是谁、凭什么掉，由
        // `assert_every_rule_is_accounted_for` 逐条点名（不点名的话，
        // 哪天真掉一条规则，这个数字照样凑得出来，而那条规则的地盘已经从合计里静默消失了）。
        assert_eq!(
            assert_every_rule_is_accounted_for(&r, &rules),
            vec!["orphan-app-data".to_string()],
            "「没出 finding」的必须恰好是因弃权而没出的那一条"
        );
        assert_eq!(r.findings.len(), 22);
        assert!(!r.safety_blocked, "内置表 + 完整 env 不该触发 fail-safe");
        let _ = r.reclaimable_bytes;
    }

    /* ---------------- M3-B：预览要读的那几个报告字段 ---------------- */

    #[test]
    fn bytes_by_risk_counts_every_bucket_including_forbidden() {
        let mut bin = mk_rule("recycle-bin", Risk::Forbidden, &[r"%SYSTEMDRIVE%\$Recycle.Bin"]);
        bin.clean_strategy = CleanStrategy::ManualOnly;
        let r = report(&[mk_rule("temp", Risk::Safe, &[r"%TEMP%"]), bin]);
        assert_eq!(r.bytes_by_risk.safe, 300);
        assert_eq!(r.bytes_by_risk.forbidden, 500, "🔴 在自己那一档里照常计数");
        assert_eq!(r.bytes_by_risk.caution, 0);
        assert_eq!(r.bytes_by_risk.high, 0);
        assert_eq!(r.reclaimable_bytes, 300, "但它绝不进「可回收」");
    }

    #[test]
    fn protection_roots_are_reported_resolved_and_sorted() {
        let r = report(&[mk_rule("t", Risk::Safe, &[r"%TEMP%"])]);
        assert!(r.forbidden_roots.len() >= 6, "§16 的禁止根都要落地：{:?}", r.forbidden_roots);
        assert!(r.forbidden_roots.contains(&r"C:\Windows\System32".to_string()));
        let mut sorted = r.forbidden_roots.clone();
        sorted.sort();
        assert_eq!(r.forbidden_roots, sorted, "必须升序 —— 预览与执行层直接比这张表");
        // 只上报根：CLEANUP-RULES §6 之后从 1 条（回收站）涨到 12 条
        // （+ 用户级安装根 + MSIX 容器 + AI/用户数据容器一族）。方向是
        // **照常枚举、照实报占用、没有任何规则能认领**（见 `types.rs` 那两段的说明）。
        assert_eq!(
            r.report_only_roots,
            vec![
                r"C:\$Recycle.Bin".to_string(),
                r"C:\Local\Packages".to_string(),
                r"C:\Local\Programs".to_string(),
                r"C:\ProgramData\Package Cache".to_string(),
                r"C:\Roam\Claude".to_string(),
                r"C:\Roam\NutstoreClient".to_string(),
                r"C:\Roam\OpenAI".to_string(),
                r"C:\Roam\Spotify".to_string(),
                r"C:\Roam\Tencent".to_string(),
                r"C:\Roam\ZCode".to_string(),
                r"C:\Roam\com.qodercn.app.stable".to_string(),
                r"C:\Roam\douyin".to_string(),
            ]
        );
        let mut sorted = r.report_only_roots.clone();
        sorted.sort();
        assert_eq!(r.report_only_roots, sorted, "只上报根同样必须升序");
    }

    #[test]
    fn the_finding_carries_the_category_and_the_clean_strategy() {
        let mut r0 = mk_rule("temp", Risk::Safe, &[r"%TEMP%"]);
        r0.category = RuleCategory::BrowserCache;
        r0.clean_strategy = CleanStrategy::EmptyFolder;
        let r = report(&[r0]);
        assert_eq!(r.findings[0].category, RuleCategory::BrowserCache, "§17 预览按它分组");
        assert_eq!(r.findings[0].clean_strategy, CleanStrategy::EmptyFolder, "M3-C 按它决定怎么收");
    }

    #[test]
    fn territories_are_exported_only_for_detector_rules() {
        let mut npm = mk_rule("npm-cache", Risk::Caution, &[r"%TEMP%"]);
        npm.requires_detector = Some("npm".into());
        let r = report(&[mk_rule("plain", Risk::Safe, &[r"%TEMP%"]), npm]);
        assert_eq!(r.territories.len(), 1, "没声明 requiresDetector 的规则不进底账");
        let t = &r.territories[0];
        assert_eq!(t.rule_id, "npm-cache");
        assert!(!t.detector_absent);
        assert_eq!(t.present.len(), 1);
        assert_eq!(t.present[0].path, r"C:\Temp");
        assert_eq!(t.present[0].bytes, Some(300), "字节来自 sizeOf（子树合计）");
        assert_eq!(t.not_scanned, 0);
    }

    #[test]
    fn a_territory_the_tree_does_not_cover_is_counted_as_not_scanned() {
        let mut npm = mk_rule("npm-cache", Risk::Caution, &[r"%TEMP%\nope"]);
        npm.requires_detector = Some("npm".into());
        let r = report(&[npm]);
        let t = &r.territories[0];
        assert!(t.present.is_empty());
        assert_eq!(t.not_scanned, 1, "『没扫到』要与『缓存是空的』分开数");
    }

    #[test]
    fn a_rule_whose_first_path_is_unresolved_still_opens_a_ledger() {
        // 内置表里 maven / gradle / huggingface 的第一条路径都是 `%USERPROFILE%\...`：
        // 变量缺一次就早退，若不**先无条件开账**，这三条在底账里会整条缺席。
        let mut npm = mk_rule("npm-cache", Risk::Caution, &[r"%NOPE%\x"]);
        npm.requires_detector = Some("npm".into());
        let r = report(&[npm]);
        assert_eq!(r.territories.len(), 1, "底账整条缺席会让 §3.6 把三种 0 混成一个");
        assert_eq!(r.territories[0].rule_id, "npm-cache");
        assert!(r.territories[0].present.is_empty());
        assert_eq!(r.territories[0].not_scanned, 0);
        assert!(r.exclusions.iter().any(|e| e.reason == ExclusionReason::UnresolvedEnv));
    }

    #[test]
    fn an_absent_detector_is_recorded_in_the_ledger() {
        let mut npm = mk_rule("npm-cache", Risk::Caution, &[r"%TEMP%"]);
        npm.requires_detector = Some("npm".into());
        let mut o = EvaluateOptions::default();
        o.detector_status.insert("npm".into(), false);
        let r = evaluate_rules(&tree(), &[npm], &env(), &o);
        assert!(r.findings.is_empty(), "没装 → 一条 finding 都不出");
        assert_eq!(r.territories.len(), 1);
        assert!(r.territories[0].detector_absent);
        assert_eq!(r.reclaimable_bytes, 0);
    }

    /* ---------------------------------------------------------------- *
     * M5-P1 T2 —— 任意深度 leaf 遍历 + 围栏不枚举（plan §6-T2 / spec §2.2 §2.3）
     *
     * 夹具里每一条近失形状都不是装饰，全部来自 plan §5 的三条排除项与 spec §6.2 的反例表：
     * `Packages`（UWP 每应用状态，不是更新目录）、`HiviewPlatform.log`（在写、无 `.N`）、
     * `.git\objects` 与**无点前缀**的 `git\objects`、`crx_cache` 与名单里的 `component_crx_cache`、
     * `C:\Local\Programs\...`（用户级 Programs 里应用自带运行时，围栏 deny 的那一条）、
     * 重解析点目录、以及一条 210 层的深链。少一条 = 那条判据没被钉住。
     * ---------------------------------------------------------------- */

    /// 八个 `RULE_ENV_KEYS` 全给 —— 围栏要 deny Program Files 就得能用**同一套**解析口径点名它
    /// （`PROGRAMFILES` 是 §4.1 补进来的第 8 键；用字面盘符就是防护自己的口径分裂）。
    fn leaf_env() -> RuleEnv {
        let mut m = RuleEnv::new();
        m.insert("SYSTEMDRIVE".into(), "C:".into());
        m.insert("WINDIR".into(), r"C:\Windows".into());
        m.insert("TEMP".into(), r"C:\Temp".into());
        m.insert("LOCALAPPDATA".into(), r"C:\Local".into());
        m.insert("APPDATA".into(), r"C:\Roam".into());
        m.insert("PROGRAMDATA".into(), r"C:\ProgramData".into());
        m.insert("PROGRAMFILES".into(), r"C:\Program Files".into());
        m.insert("USERPROFILE".into(), r"C:\Users\Kano".into());
        m
    }

    /// 覆盖足够的围栏：`denyRoots` 必须 ⊇ 禁止根全集（`validate_fence` 逐条比对，
    /// 判据是 `path_is_under(req, deny)` —— **没有**"被祖先顺手罩住"这条捷径），外加地板。
    ///
    /// ⚠️ CLEANUP-RULES §6 之后禁止根从 6 条涨到 27 条，所以这份清单跟着涨。**叶子型那几条
    /// （`%LOCALAPPDATA%\Packages` / `%APPDATA%\Claude` 一族）也必须在这里点名**，否则
    /// `validate_fence` 直接以 `inadequate-fence` 拒掉整条规则（2026-10-19 实测：一次红 25 条）。
    ///
    /// 而把它们放进 deny_roots 会在**评估层**触发 `AncestorOfProtected`（`C:\Local` 是
    /// `C:\Local\Packages` 的祖先）—— 那条判据是正确的（宽容器不许扫进受保护子树），
    /// 所以叶子型禁止根不该出现在 deny_roots 里，该由 `report_only_block` 逐文件挡。
    /// 这正是它们同时在 `REPORT_ONLY_ROOT_PATTERNS` 里的原因。
    fn leaf_fence() -> RuleScopeFence {
        RuleScopeFence {
            allow_roots: vec!["%LOCALAPPDATA%".into(), "%APPDATA%".into(), "%PROGRAMDATA%".into()],
            deny_roots: vec![
                // 地板四条宽根（`FENCE_MINIMUM_DENY_PATTERNS` 全集）
                r"%WINDIR%\*".into(),
                r"%SYSTEMDRIVE%\System Volume Information".into(),
                r"%PROGRAMFILES%\*".into(),
                r"%SYSTEMDRIVE%\Program Files (x86)\*".into(),
                // T6 真机对账逮到的越界：病毒特征库不是缓存
                r"%PROGRAMDATA%\Microsoft\Windows Defender\*".into(),
                // R-DENY-SYSCOMP 里唯一带通配的一条（`Package Cache` 本体是叶子，
                // 见函数文档：它不能进 deny_roots）
                r"%PROGRAMDATA%\Package Cache\*".into(),
                // R-DENY-AIDATA 住在家目录的八条。它们**能**进 deny_roots：`%USERPROFILE%`
                // 不是本围栏的 allowRoots，所以不会触发 `AncestorOfProtected`。
                // （`%APPDATA%\Claude` 那一族不行 —— 见 `FORBIDDEN_PATH_PATTERNS` 的说明。）
                r"%USERPROFILE%\.codex".into(),
                r"%USERPROFILE%\.claude".into(),
                r"%USERPROFILE%\.qoder".into(),
                r"%USERPROFILE%\.qoder-cn".into(),
                r"%USERPROFILE%\.workbuddy".into(),
                r"%USERPROFILE%\.dsh".into(),
                r"%USERPROFILE%\.mem0".into(),
                r"%USERPROFILE%\.codebuddy".into(),
                // 容器族补充：用户级 Programs（plan §0.1 那条近失形状的落地形）
                r"%LOCALAPPDATA%\Programs\*".into(),
            ],
        }
    }

    /// plan §5.1 那 12 个 Chromium/Electron 约定名（T3 才上表；这里当夹具输入用）。
    const CACHE_LEAVES: [&str; 12] = [
        "Cache",
        "Code Cache",
        "GPUCache",
        "ShaderCache",
        "GrShaderCache",
        "DawnCache",
        "DawnGraphiteCache",
        "DawnWebGPUCache",
        "CachedData",
        "blob_storage",
        "CacheStorage",
        "component_crx_cache",
    ];

    fn leaf_rule(id: &str, dirs: &[&str], files: &[&str], patterns: &[&str], paths: &[&str]) -> Rule {
        let mut r = mk_rule(id, Risk::Caution, paths);
        r.category = RuleCategory::AppTransient;
        r.scanner.leaf_dirs = dirs.iter().map(|s| s.to_string()).collect();
        r.scanner.leaf_files = files.iter().map(|s| s.to_string()).collect();
        r.scanner.file_patterns = patterns.iter().map(|s| s.to_string()).collect();
        r.scanner.scope_fence = Some(leaf_fence());
        r
    }

    /// 三条规则形状对应 plan §5.1 / §5.3 / §5.2（六条规则本体是 T3 的活）。
    fn cache_rule() -> Rule {
        leaf_rule("app-cache-data", &CACHE_LEAVES, &[], &[], &["%LOCALAPPDATA%", "%APPDATA%", "%PROGRAMDATA%"])
    }
    fn updater_rule() -> Rule {
        leaf_rule(
            "installer-artifacts",
            &["*updater", "*Updater", "pending", "Update", "updates"],
            &[],
            &["*.exe", "*.msi", "*.msp", "*.nupkg", "*.appx", "*.msix", "*.zip", "*.7z", "*.rar", "*.iso"],
            &["%LOCALAPPDATA%", "%APPDATA%", "%PROGRAMDATA%"],
        )
    }
    fn logs_rule() -> Rule {
        leaf_rule(
            "app-rotated-logs",
            &[],
            &["*.?.log", "*.log.??", "*.etl"],
            &[],
            &["%LOCALAPPDATA%", "%APPDATA%", "%PROGRAMDATA%"],
        )
    }

    /// 共享合成树。`leafTree()` 的 TS 双胞胎在 `tests/unit/rules-engine.test.ts`，逐条同形状。
    fn leaf_tree() -> FakeTree {
        tree_of_files(
            &[
                // 容器根上散着的文件：leaf 模式一条都不许认领（采集根必须是命中的那个目录）
                (r"C:\Local\loose.bin", 10),
                // 深度 1 的命中 + 名单内但整名不中的近失（`LocalCache` ≠ `Cache`）
                (r"C:\Local\SomeApp\Cache\c1.bin", 100),
                (r"C:\Local\SomeApp\Cache\c2.dat", 60),
                (r"C:\Local\SomeApp\LocalCache\look.bin", 33),
                // 任意深度的命中
                (r"C:\Local\Deep\Nest\a\b\c\Cache\deep.bin", 70),
                // 命中即停：里面那个 `Cache` 属于**同一个根**，不是第二个命中
                (r"C:\Local\Twin\Cache\inner.bin", 30),
                (r"C:\Local\Twin\Cache\Cache\nested.bin", 5),
                // 名单内的下划线名 vs 名单外的下划线名
                (r"C:\Local\Crx\component_crx_cache\crx.bin", 25),
                (r"C:\Local\Crx\crx_cache\lookalike.bin", 25),
                // spec §6.2 的 `.git\objects` + plan §6-T2 点名的**无点前缀**孪生形状
                (r"C:\Local\Repo\.git\objects\pack\obj_1.idx", 90),
                (r"C:\Local\git\objects\abc.bin", 90),
                (r"C:\Local\git\config", 7),
                // 归既有第 7 条（`npm-cache`）的地盘：leaf 名单不许吃（plan §5 第三条排除项）
                (r"C:\Local\npm-cache\_cacache\pkg.bin", 80),
                // 轮转件 vs 在写件（plan §5 第二条排除项，glob 语义的活证据）
                (r"C:\Local\Hiview\HiviewPlatform.3.log", 400),
                (r"C:\Local\Hiview\HiviewPlatform.log", 1200),
                (r"C:\Local\Hiview\rot\HiviewService.1.log", 300),
                (r"C:\Local\Hiview\rot\HiviewService.log", 500),
                (r"C:\Local\Hiview\trace.log.01", 50),
                (r"C:\Local\Hiview\etl\monitor.etl", 60),
                // 更新目录形状 + 安装器形状（500 进账）与同目录里不是安装器的东西
                (r"C:\Local\foo-updater\pending\setup.exe", 500),
                (r"C:\Local\foo-updater\pending\notes.txt", 10),
                // UWP 每应用状态目录：`settings.zip` 是用户数据，不是更新包（plan §5 第一条排除项）
                (r"C:\Local\Packages\ExampleApp_1.0_x64__abc\LocalCache\Roaming\settings.zip", 700),
                (r"C:\Local\Packages\ExampleApp_1.0_x64__abc\Settings\roaming.lock", 10),
                // 围栏 deny 掉的那块：用户级 Programs 里应用自带的运行时资源
                (r"C:\Local\Programs\Microsoft VS Code\Resources\app\Cache\do-not-touch.bin", 9000),
                // 重解析点后面才可达的 `Cache`：整条分支不该被走到
                (r"C:\Local\Junction\Cache\via-junction.bin", 400),
                // `requiresAbsentAppFact` 那条规则的候选目录
                (r"C:\Local\Ghost\data.bin", 123),
                // 真·Program Files 两处（入口之下不可达，只用来验"连枚举都没发生"）
                (r"C:\Program Files\Huawei\PCManager\Application\Cache\app.bin", 8000),
                (r"C:\Program Files (x86)\Microsoft\Edge\Application\Cache\edge.bin", 7000),
                (r"C:\Windows\System32\Cache\sys.bin", 111),
                // allow 侧的对照组：入口落在 allowRoots 之外（`C:\Temp` 不在三条 allow 根里）
                (r"C:\Temp\Cache\outside-allow.bin", 999),
                // 另外两条 allow 根里的正常命中
                (r"C:\Roam\Another\Cache\roam.bin", 40),
                (r"C:\ProgramData\Vendor\Cache\pd.bin", 20),
            ],
            &[r"C:\Local\Junction"],
        )
    }

    /// 被认领的路径清单（跨 findings 汇总）—— 多条断言都用它做"不该出现的没出现"判据。
    fn claimed(report: &RuleReport) -> Vec<String> {
        report
            .findings
            .iter()
            .flat_map(|f| f.sample_paths.iter().map(|p| p.path.clone()))
            .collect()
    }

    /// **P2-T4 新增的记账判据**：表 22 条、`findings` 却可能只有 21 条 —— 那一格差**必须是可解释的**，
    /// 否则 `findings.len()` 就成了「有一条规则静默消失」的藏身处（本项目为这类失效记过账）。
    ///
    /// 唯一合法的差来自 `evaluate_rules` 里那一条 `continue`：声明了 `requiresAbsentAppFact` 的规则
    /// 在**一个候选都没被机器事实表批准**时不出 finding（TS 侧同一条 `continue` —— 一侧出 0 字节
    /// finding、一侧不出，两套实现对"这条规则上没上表"就会给出不同答案）。
    ///
    /// 所以这条断言两件事，然后把"没出 finding 的那几条 id"交回调用方点名：
    /// ① 上线数 + 弃权数 == 表长（一条都不许多、也不许少）；
    /// ② 掉出 `findings` 的那条**必须**声明了 `requiresAbsentAppFact`（别的规则掉出去＝静默消失）。
    /// 声明层被拒（`rejected_rules`）是**第三种**失效，这条先把它单独钉掉，绝不让它混进 ① 的算术里。
    /// "弃权的那条有没有把每个候选都点名"是另一件事、另一个判据（见
    /// `an_empty_app_fact_table_leaves_rule_22_at_zero_bytes_while_naming_every_candidate`），
    /// 这里不顺手代它断言 —— 那个断言只在"三根容器确实在扫描树上"的夹具里才成立。
    fn assert_every_rule_is_accounted_for(report: &RuleReport, rules: &[Rule]) -> Vec<String> {
        assert!(report.rejected_rules.is_empty(), "内置表被声明层拒了：{:?}", report.rejected_rules);
        let online: BTreeSet<String> =
            report.findings.iter().map(|f| f.rule_id.clone()).collect();
        assert_eq!(online.len(), report.findings.len(), "有规则出了两条 finding（同一条规则计了两遍账）");
        let missing: Vec<String> =
            rules.iter().map(|r| r.id.clone()).filter(|id| !online.contains(id)).collect();
        for id in &missing {
            let r = rules.iter().find(|r| r.id == *id).expect("findings 里缺的这条不在表里？");
            assert_eq!(
                r.requires_absent_app_fact,
                Some(true),
                "规则 {id} 既没被声明层拒、也没出 finding —— 那就是静默消失，不是弃权"
            );
        }
        assert_eq!(
            online.len() + missing.len(),
            rules.len(),
            "上线数 + 弃权数 ≠ 表长（findings={}，弃权 {missing:?}，表 {} 条）",
            report.findings.len(),
            rules.len()
        );
        missing
    }

    fn of<'a>(report: &'a RuleReport, id: &str) -> &'a RuleFinding {
        report.findings.iter().find(|f| f.rule_id == id).unwrap_or_else(|| panic!("没有 {id} 的 finding"))
    }

    /// **任意深度** + 命中即停 + 只认 basename 整名：这三件事在同一棵树上一次验完。
    #[test]
    fn leaf_dirs_match_at_any_depth_within_the_fence() {
        let t = leaf_tree();
        let r = evaluate_rules(&t, &[cache_rule()], &leaf_env(), &EvaluateOptions::default());
        for e in &r.exclusions {
            println!("DBG_EXCL path={:?} reason={:?}", e.path, e.reason);
        }
        let f = of(&r, "app-cache-data");
        assert_eq!(
            f.matched_roots,
            vec![
                r"C:\Local\Crx\component_crx_cache",
                r"C:\Local\Deep\Nest\a\b\c\Cache",
                r"C:\Local\SomeApp\Cache",
                r"C:\Local\Twin\Cache",
                r"C:\ProgramData\Vendor\Cache",
                r"C:\Roam\Another\Cache",
            ],
            "采集根必须是**命中的那些目录**（任意深度、跨三条 allow 根），而不是入口容器"
        );
        assert_eq!((f.file_count, f.total_bytes), (8, 350), "实得 {:?}", f.sample_paths);
        // 命中即停：`Twin\Cache\Cache` 是同一个根里 recursive 收进来的，不是第二个命中
        assert!(!f.matched_roots.iter().any(|p| p.ends_with(r"Twin\Cache\Cache")));
        // 容器上散着的文件不进账；`LocalCache` 这种整名不中的近失名也不进账
        let c = claimed(&r);
        assert!(!c.iter().any(|p| p.ends_with("loose.bin")), "{c:?}");
        assert!(!c.iter().any(|p| p.ends_with("look.bin")), "{c:?}");
        // 遍历真的发生过（不是"整条规则空转所以什么都没命中"）
        assert!(t.opened.borrow().iter().any(|p| p == r"C:\Local"), "实得 {:?}", t.opened.borrow());
    }

    /// **围栏是枚举边界，不是命中后的过滤器**（spec §2.3 / plan §0.2）：
    /// 被拒的目录连"被列举"都不发生，而排除记录点名到那个**具体路径**（不许只有总数）。
    #[test]
    fn a_denied_directory_is_never_enumerated_and_names_the_path() {
        let t = leaf_tree();
        let r = evaluate_rules(&t, &[cache_rule()], &leaf_env(), &EvaluateOptions::default());
        let ex: Vec<&Exclusion> =
            r.exclusions.iter().filter(|e| e.reason == ExclusionReason::OutsideFence).collect();
        assert!(!ex.is_empty(), "越栏一条都没记录 —— 围栏没生效或被悄悄滤成命中了");
        let denied = ex
            .iter()
            .find(|e| e.path == r"C:\Local\Programs")
            .unwrap_or_else(|| panic!("没有点名 C:\\Local\\Programs 的 outside-fence 记录：{:?}", ex.iter().map(|e| (&e.rule_id, &e.path)).collect::<Vec<_>>()));
        assert_eq!(denied.rule_id.as_deref(), Some("app-cache-data"), "排除记录要挂在认领它的那条规则名下");
        assert!(
            denied.detail.contains(r"C:\Local\Programs") && denied.detail.contains("围栏"),
            "理由要点名是哪个根拦的：{}",
            denied.detail
        );
        // 结构性不可达：那条分支一次都没被列举（"数字偏小"和"到不了"是两件事，这里验后者）
        for p in t.opened.borrow().iter() {
            assert!(!path_is_under(p, r"C:\Local\Programs"), "围栏外的目录被枚举了：{p}");
        }
        assert!(!of(&r, "app-cache-data").sample_paths.iter().any(|p| p.size == 9000), "9000 那块不许进账");

        // allow 侧同一个形状：入口本身落在 allowRoots 之外 → 整条分支出局 + 点名
        let outside = leaf_rule("outside-allow", &["Cache"], &[], &[], &[r"%TEMP%"]);
        let t2 = leaf_tree();
        let r2 = evaluate_rules(&t2, &[outside], &leaf_env(), &EvaluateOptions::default());
        assert_eq!(r2.findings[0].total_bytes, 0);
        let ex2: Vec<&Exclusion> =
            r2.exclusions.iter().filter(|e| e.reason == ExclusionReason::OutsideFence).collect();
        assert!(
            ex2.iter().any(|e| e.path == r"C:\Temp" && e.detail.contains("allowRoots")),
            "allowRoots 之外的入口没被点名：{:?}",
            ex2.iter().map(|e| (&e.path, &e.detail)).collect::<Vec<_>>()
        );
        for p in t2.opened.borrow().iter() {
            assert!(!path_is_under(p, r"C:\Temp"), "allow 根之外的入口被枚举了：{p}");
        }
    }

    /// plan §0.1 那条风险的正面证明：Program Files（含 32 位与用户级 `Programs`）里的 `Cache`
    /// 一个字节都不进账，而且**没被枚举**。
    #[test]
    fn near_miss_cache_under_program_files_is_not_claimed() {
        let t = leaf_tree();
        let r = evaluate_rules(
            &t,
            &[cache_rule(), updater_rule(), logs_rule()],
            &leaf_env(),
            &EvaluateOptions::default(),
        );
        for p in claimed(&r) {
            assert!(!p.contains("do-not-touch"), "用户级 Programs 里的运行时被吃了：{p}");
            assert!(!path_is_under(&p, r"C:\Program Files"), "Program Files 里的东西被吃了：{p}");
        }
        // 三处 Program Files 形状的目录一次都没被枚举。段边界判据顺带把 32 位那条也罩住：
        // `C:\Program Files (x86)\...` 不是 `C:\Program Files` 的字符串前缀，而是它的**子孙**。
        for p in t.opened.borrow().iter() {
            assert!(!path_is_under(p, r"C:\Program Files"), "枚举了 {p}");
            assert!(!path_is_under(p, r"C:\Local\Programs"), "枚举了 {p}");
        }
        // 账目也守得住：350 + 500 + 810，没有 7000/8000/9000 混进来
        assert_eq!((of(&r, "app-cache-data").total_bytes, of(&r, "installer-artifacts").total_bytes), (350, 500));
        assert_eq!(of(&r, "app-rotated-logs").total_bytes, 810);
        assert_eq!(r.reclaimable_bytes, 1660, "实得 {}", r.reclaimable_bytes);
    }

    /// `.git\objects`、**无点前缀**的 `git\objects`、`crx_cache`（名单里的是 `component_crx_cache`）、
    /// `npm-cache`（归既有第 7 条）、`Packages`（UWP 每应用状态）—— 五族近失一个都不许被认领。
    /// 反半边同样钉：名单里那个下划线名必须进账，否则这组断言只是"什么都没命中"的空转。
    #[test]
    fn git_objects_and_crx_cache_undotted_names_are_not_claimed() {
        let t = leaf_tree();
        let r = evaluate_rules(&t, &[cache_rule(), updater_rule()], &leaf_env(), &EvaluateOptions::default());
        let c = claimed(&r);
        for p in &c {
            for banned in
                [r"\.git\", r"C:\Local\git\", r"\crx_cache\", r"\npm-cache\", r"\Packages\"]
            {
                assert!(!p.contains(banned), "{p} 被认领了（{banned} 那一族近失形状）");
            }
        }
        assert!(c.iter().any(|p| p.ends_with(r"component_crx_cache\crx.bin")), "{c:?}");
        assert_eq!(of(&r, "app-cache-data").total_bytes, 350);
        // `Packages` 不许被更新目录名单当更新目录吃（plan §5 第一条排除项）：
        // 唯一进账的更新目录是 `foo-updater`，那 700 字节的 UWP `settings.zip` 一分都不算
        assert_eq!(of(&r, "installer-artifacts").matched_roots, vec![r"C:\Local\foo-updater"]);
        assert_eq!(of(&r, "installer-artifacts").total_bytes, 500);
    }

    /// 一棵 210 层的链，`Cache` 在最深处：**超限必须记下来**，不许静默截断，
    /// 也不许因此把整条规则罢工（浅处那一格照常进账）。
    #[test]
    fn leaf_walk_respects_the_single_depth_cap() {
        let mut files: Vec<(String, u64)> = Vec::new();
        let mut chain = String::from(r"C:\Local");
        let mut capped = String::new();
        for i in 1..=210 {
            chain = join_win(&chain, &format!("d{i:03}"));
            if i == MAX_WALK_DEPTH + 1 {
                capped = chain.clone(); // 第 201 层：正好是越过 `MAX_WALK_DEPTH` 的那一个
            }
        }
        files.push((join_win(&chain, r"Cache\over.bin"), 77));
        files.push((r"C:\Local\Shallow\Cache\ok.bin".to_string(), 11));
        let refs: Vec<(&str, u64)> = files.iter().map(|(p, s)| (p.as_str(), *s)).collect();
        let t = tree_of_files(&refs, &[]);

        let r = evaluate_rules(&t, &[cache_rule()], &leaf_env(), &EvaluateOptions::default());
        let f = of(&r, "app-cache-data");
        assert_eq!((f.file_count, f.total_bytes), (1, 11), "浅处那一格照常进账，深处那格不许进来");
        assert_eq!(f.matched_roots, vec![r"C:\Local\Shallow\Cache"]);
        // 超限是**记下来**的：点名到那一个目录，理由说清是深度上限（不是"没扫到"那种含混话）
        let over = r
            .exclusions
            .iter()
            .find(|e| e.path == capped)
            .unwrap_or_else(|| panic!("没有点名 {capped} 的超限记录：{:?}", r.exclusions.iter().map(|e| &e.path).collect::<Vec<_>>()));
        assert_eq!(over.reason, ExclusionReason::NotScanned, "超限按未知处理（与既有口径同一个理由）");
        assert!(over.detail.contains("深度上限") && over.detail.contains("200"), "实得 {}", over.detail);
        assert_eq!(
            MAX_WALK_DEPTH, 200,
            "深度上限只有这一把尺子（plan Global Constraints）；出现第二个上限就是两套真相"
        );
    }

    /// 重解析点目录：跳过，**不跟进去**（spec §2.2 与扫描器同口径 ——
    /// `crates/scanner/src/accounting.rs` 的 `SkipReason::Reparse` 早就让这类目录进不了树）。
    #[test]
    fn reparse_point_dirs_are_skipped_not_followed() {
        let t = leaf_tree();
        let r = evaluate_rules(&t, &[cache_rule()], &leaf_env(), &EvaluateOptions::default());
        let f = of(&r, "app-cache-data");
        assert_eq!(f.total_bytes, 350, "junction 后面那 400 字节一次都不进账");
        assert!(!claimed(&r).iter().any(|p| p.contains("via-junction")));
        let ex = r
            .exclusions
            .iter()
            .find(|e| e.path == r"C:\Local\Junction")
            .unwrap_or_else(|| panic!("没点名那个重解析点：{:?}", r.exclusions.iter().map(|e| (&e.reason, &e.path)).collect::<Vec<_>>()));
        assert_eq!(ex.reason, ExclusionReason::NotScanned);
        assert!(ex.detail.contains("重解析"), "理由要说清是重解析点：{}", ex.detail);
        // 不跟进 = 连列举都没发生（"跳过了"与"进去了再丢掉"是两件事）
        for p in t.opened.borrow().iter() {
            assert!(!path_is_under(p, r"C:\Local\Junction"), "重解析点被枚举了：{p}");
        }
    }

    /// `filePatterns: []` 在命中目录下 = 全收（`matcher.rs:12` 那句"空数组 = 该地盘下的所有文件"）。
    /// 反半边才是这条的价值：没有 leaf 命中的容器层，散着的文件一个都不认。
    #[test]
    fn empty_file_patterns_under_a_leaf_dir_collects_everything() {
        let t = leaf_tree();
        let r = evaluate_rules(&t, &[cache_rule()], &leaf_env(), &EvaluateOptions::default());
        let f = of(&r, "app-cache-data");
        let c = claimed(&r);
        assert!(c.iter().any(|p| p.ends_with(r"SomeApp\Cache\c1.bin")), "{c:?}");
        assert!(c.iter().any(|p| p.ends_with(r"SomeApp\Cache\c2.dat")), "扩展名不参与判据：{c:?}");
        assert!(c.iter().any(|p| p.ends_with(r"Twin\Cache\Cache\nested.bin")), "命中目录里的子树照常收：{c:?}");
        assert!(!c.iter().any(|p| p.ends_with("loose.bin")), "容器层散着的文件不许认领：{c:?}");
        assert_eq!((f.file_count, f.total_bytes), (8, 350));
        assert!(!f.sample_truncated, "8 条采样用不上上限");
    }

    /// plan §5 第二条排除项：`*.?.log` 正好吃轮转件、不吃同名无后缀的在写文件。
    /// 这条是 glob 语义的活证据（本机 `HiviewPlatform.log` 12.1 MiB 正在被写），必须有单测。
    #[test]
    fn leaf_files_match_at_any_depth_and_never_the_live_log() {
        let t = leaf_tree();
        let r = evaluate_rules(&t, &[logs_rule()], &leaf_env(), &EvaluateOptions::default());
        let c = claimed(&r);
        assert!(c.iter().any(|p| p.ends_with("HiviewPlatform.3.log")), "{c:?}");
        assert!(c.iter().any(|p| p.ends_with(r"rot\HiviewService.1.log")), "任意深度：{c:?}");
        assert!(c.iter().any(|p| p.ends_with("trace.log.01")), "{c:?}");
        assert!(c.iter().any(|p| p.ends_with("monitor.etl")), "{c:?}");
        assert!(
            !c.iter().any(|p| p.ends_with("HiviewPlatform.log") || p.ends_with("HiviewService.log")),
            "在写的日志被吃了：{c:?}"
        );
        let f = of(&r, "app-rotated-logs");
        assert_eq!((f.file_count, f.total_bytes), (4, 810));
        // leafFiles 模式不给目录当根（那是 leafDirs 的语义），根就是被搜过的那一层入口，
        // 次序沿用 `paths` 的表序 —— 与非 leaf 规则的 `matched_roots` 同一个姿态（不是字典序）
        assert_eq!(f.matched_roots, vec![r"C:\Local", r"C:\Roam", r"C:\ProgramData"], "按 paths 表序");
        // 反向对照：把这条判据放宽成 `*.log`（plan §7 变异 4）就会把 1200 + 500 那两块在写的吃进来 ——
        // 上面那两条 `!c.iter().any(...)` 就是它红了的地方。
    }

    /// 表里按 id 取**真规则**（不是测试自己复述一份形状）。
    /// 上面那组 `cache_rule()` / `logs_rule()` / `updater_rule()` 是 T2 造夹具用的替身，
    /// 改它们不会让产品侧任何一条断言变红 —— 所以下面三条只吃 `builtin_rules()`：
    /// plan §5 那三条排除项要钉的是**上表的那条规则**，否则变异清单跑不出红。
    fn builtin_rule(id: &str) -> Rule {
        builtin_rules()
            .into_iter()
            .find(|r| r.id == id)
            .unwrap_or_else(|| panic!("内置表里没有 {id} —— 它根本没上线"))
    }

    /// plan §5 第二条排除项，**在产品侧**：表里那条 `app-rotated-logs` 只吃轮转件。
    /// 与上面 `leaf_files_match_at_any_depth_and_never_the_live_log` 的区别是吃的规则来源 ——
    /// 那条改的是测试夹具（放宽它的 `leafFiles` 只会红在那条用例自己的夹具上），
    /// 这条改的是 `builtin.rs` 的字面量：plan §7 变异 4 把表里的 `*.?.log` 放宽成 `*.log`
    /// 必须让这条当场红。
    #[test]
    fn the_builtin_rotated_log_rule_never_touches_a_live_log() {
        let t = leaf_tree();
        let r = evaluate_rules(&t, &[builtin_rule("app-rotated-logs")], &leaf_env(), &EvaluateOptions::default());
        let c = claimed(&r);
        assert!(c.iter().any(|p| p.ends_with("HiviewPlatform.3.log")), "轮转件必须收到：{c:?}");
        assert!(c.iter().any(|p| p.ends_with(r"rot\HiviewService.1.log")), "任意深度：{c:?}");
        assert!(c.iter().any(|p| p.ends_with("trace.log.01")), "*.log.?? 那一档：{c:?}");
        assert!(c.iter().any(|p| p.ends_with("monitor.etl")), "*.etl 那一档：{c:?}");
        for live in ["HiviewPlatform.log", r"rot\HiviewService.log"] {
            assert!(
                !c.iter().any(|p| p.ends_with(live)),
                "表里这条规则把**正在被写**的日志吃了（{live}）：glob 从 `*.?.log` 放宽成 `*.log` 就是这一格。实得 {c:?}"
            );
        }
        let f = of(&r, "app-rotated-logs");
        // 400 + 300 + 50 + 60：在写那两个（1200 + 500）一个都不许进账
        assert_eq!((f.file_count, f.total_bytes), (4, 810), "实得 {:?}", f.sample_paths);
    }

    /// **双计契约**（plan §5 第三条排除项 / spec §2.2）：表尾那条 `app-cache-data` 的入口是 AppData
    /// 三根，地盘**覆盖**既有第 2 条（browser-cache）与第 7 条（npm-cache）—— 之所以不会虚高，
    /// 靠的只有两件事：`claimed` 表先声明者计账 + 新规则追加在表尾。这条就是那两件事的证明。
    ///
    /// 夹具故意把 `Cache` 这个名字放进 `npm-cache` 的地盘里（`npm-cache\Cache\pkg.bin`）：
    /// 它是 leaf 名单的正命中，如果顺序反过来（plan §7 变异 5：把新规则插到表头）就会被抢走。
    #[test]
    fn app_cache_data_does_not_reclaim_npm_cache_or_browser_cache() {
        let t = tree_of_files(
            &[
                (r"C:\Local\npm-cache\Cache\pkg.bin", 80),
                (r"C:\Local\npm-cache\_cacache\index.bin", 459),
                (r"C:\Local\Google\Chrome\User Data\Default\Cache\f_00000a.bin", 4000),
                (r"C:\Local\Google\Chrome\User Data\Default\Code Cache\app.js", 500),
            ],
            &[],
        );
        let rules = builtin_rules();
        let r = evaluate_rules(&t, &rules, &leaf_env(), &EvaluateOptions::default());
        // 23 条表 ⇒ 这里是 **22** 条 finding：第 22 条在空表下弃权（`evaluate_rules` 那条 `continue`），
        // 第 23 条照旧出 0 字节 finding（路径模板解析得出、树上无地盘）。
        // 这条双计契约比的是"同一份字节归谁"，不比条数 —— 但**必须由点名得出**：
        // 掉出去的恰好是 `orphan-app-data`，不是任何一条既有规则（真掉一条既有规则时，
        // 光看条数是绿不出来的，那正是本仓记过账的"静默消失"那一类）。
        assert_eq!(
            assert_every_rule_is_accounted_for(&r, &rules),
            vec!["orphan-app-data".to_string()]
        );
        assert_eq!(r.findings.len(), 22, "既有二十二条都要上线，实得 {:?}", r.rejected_rules);

        let npm = of(&r, "npm-cache");
        let browser = of(&r, "browser-cache");
        let cache = of(&r, "app-cache-data");
        assert_eq!((npm.file_count, npm.total_bytes), (2, 539), "npm-cache 那两条必须整块归第 7 条");
        assert_eq!((browser.file_count, browser.total_bytes), (2, 4500), "浏览器那两条必须整块归第 2 条");
        assert_eq!(
            (cache.file_count, cache.total_bytes),
            (0, 0),
            "app-cache-data 把已经记过账的地盘又算了一遍 = 预估虚高（M5-N 那类静默双计）"
        );

        // 不只"数字对"，机制也要点名：**是 leaf 名单正命中**的那三个文件留下了
        // claimed-by-other-rule 的排除记录，点名到具体路径与**归属者**
        // （0 字节必须能解释成"别人计过账"，不是"这里没东西"）。
        // `_cacache\index.bin` 不在这一列里，而且**不该**在：`_cacache` 不是名单里的名字，
        // `app-cache-data` 根本不会在它里面收文件 —— 给它记一条"别人计过账"就是引擎在做
        // 它没做过的事。（它归 npm-cache 由上面那条 `npm = (2, 539)` 判。）
        for (p, owner) in [
            (r"C:\Local\npm-cache\Cache\pkg.bin", "npm-cache"),
            (r"C:\Local\Google\Chrome\User Data\Default\Cache\f_00000a.bin", "browser-cache"),
            (r"C:\Local\Google\Chrome\User Data\Default\Code Cache\app.js", "browser-cache"),
        ] {
            let e = r
                .exclusions
                .iter()
                .find(|e| {
                    e.reason == ExclusionReason::ClaimedByOtherRule
                        && normalize_key(&e.path) == normalize_key(p)
                        && e.rule_id.as_deref() == Some("app-cache-data")
                })
                .unwrap_or_else(|| panic!("{p} 没有 app-cache-data 名下的 claimed-by-other-rule 记录"));
            assert!(
                e.detail.contains(owner),
                "理由要点名归属者 {owner}：{}",
                e.detail
            );
        }
        // 账目自洽：合计里那 5,039 字节只被计了一次
        assert_eq!(r.reclaimable_bytes, 539 + 4500);
        // 反向半边：`_cacache\index.bin` 名下**不许**有 app-cache-data 的排除记录（上面那句的判据形式）
        assert!(
            !r.exclusions.iter().any(|e| {
                e.rule_id.as_deref() == Some("app-cache-data")
                    && normalize_key(&e.path) == normalize_key(r"C:\Local\npm-cache\_cacache\index.bin")
            }),
            "app-cache-data 记录了一件它根本没试过认领的东西 —— 那说明它在 _cacache 里收了文件"
        );
    }

    /// plan §5 第一条排除项的**行为半边**：整张内置表都不许把 `%LOCALAPPDATA%\Packages`
    /// 本身当成一个采集根（UWP 每应用状态目录，参考机 879.6 MiB / 12,744 文件 —— 把它当
    /// "更新目录"是 plan 说的本轮最大的一次潜在误删）。
    /// `builtin.rs::packages_is_not_in_any_leaf_dir_list` 判的是名单，这条判的是结果 ——
    /// 两边都钉，才挡得住"名单没写 Packages 但用 `Pack*` 命中了它"这一类。
    ///
    /// 判据**故意只到那个容器本身**（`matched_roots` 里不许出现 `C:\Local\Packages`，
    /// 其中那个 `settings.zip` 也不许被认领），而不是"Packages 底下任何一个字节都不许被碰"：
    /// 后者会把 `Packages\<App>\LocalCache\…\Cache` 这种**名单内**的内层缓存目录一并禁掉，
    /// 那不是 plan §5 排除的东西（排除的是"Packages 整棵当更新目录"），写成判据就是自行加严。
    /// 正向对照（`foo-updater\pending\installer.exe` 必须被收走）是这条用例的牙：
    /// 没有它，"一条都没认领"会因为规则压根没上线而照样绿。
    #[test]
    fn no_builtin_rule_treats_the_uwp_packages_dir_as_a_collection_root() {
        let t = tree_of_files(
            &[
                (r"C:\Local\Packages\ExampleApp_1.0_x64__abc\LocalCache\Roaming\settings.zip", 700),
                (r"C:\Local\Packages\ExampleApp_1.0_x64__abc\Settings\roaming.lock", 10),
                // 正向对照：更新目录 + 安装包形状，`installer-artifacts` 必须收走它
                (r"C:\Local\foo-updater\pending\installer.exe", 500),
            ],
            &[],
        );
        let r = evaluate_rules(&t, &builtin_rules(), &leaf_env(), &EvaluateOptions::default());
        let roots: Vec<String> = r.findings.iter().flat_map(|f| f.matched_roots.clone()).collect();
        assert!(
            !roots.iter().any(|m| normalize_key(m) == normalize_key(r"C:\Local\Packages")),
            "`Packages` 本身成了一条规则的采集根（leafDirs 里出现了 Packages 或等价的 glob）：{roots:?}"
        );
        let c = claimed(&r);
        assert!(
            c.iter().any(|p| p.ends_with(r"foo-updater\pending\installer.exe")),
            "正向对照失效：installer-artifacts 一条都没收 = 上面两条断言是空的。实得 {c:?}"
        );
        for keep in ["settings.zip", "roaming.lock"] {
            assert!(
                !c.iter().any(|p| p.ends_with(keep)),
                "UWP 每应用状态目录里的 {keep} 被认领了 —— 那是商店应用的登录态与设置，不是更新包"
            );
        }
    }

    /// **fail-safe 方向**（spec §4.2 / plan §0.5 / §2.4）：空表 = 一个候选都判不出 `Absent` ⇒
    /// 声明了 `requiresAbsentAppFact` 的规则一个候选都不提议，但每个候选目录都要在 `exclusions[]`
    /// 里点名（不许静默消失）。
    ///
    /// P2-T3 起这条走的是**第三种采集模式**（候选 = 入口的直属子目录），所以那条排除的理由是
    /// `app-fact-key-missing` 而不是 P2-T1 那半边合并出来的 `app-fact-unknown` —— 空表的意思是
    /// "探针没被交代看过这些目录"，把它写成"探针说了不知道"就是把没查过说成查过。
    #[test]
    fn an_absent_app_fact_rule_proposes_nothing_while_the_table_is_empty() {
        let t = leaf_tree();
        let ghost = app_fact_rule("ghost-app-data", &["%LOCALAPPDATA%"]);
        let r = evaluate_rules(&t, &[ghost.clone()], &leaf_env(), &EvaluateOptions::default());
        assert!(r.findings.is_empty(), "空表 = 没有任何 Absent 结论 = 一条都不提议");
        assert_eq!(r.reclaimable_bytes, 0);
        let ex = r
            .exclusions
            .iter()
            .find(|e| e.reason == ExclusionReason::AppFactKeyMissing && e.path == r"C:\Local\Ghost")
            .unwrap_or_else(|| panic!("缺键必须点名，不许静默消失：{:?}", r.exclusions.iter().map(|e| (&e.reason, &e.path)).collect::<Vec<_>>()));
        assert_eq!(ex.path, r"C:\Local\Ghost", "要点名到那个具体目录");
        assert_eq!(ex.rule_id.as_deref(), Some("ghost-app-data"));
        assert!(ex.detail.contains("ghost") && ex.detail.contains("键"), "理由要点名查的是哪个键：{}", ex.detail);
        // 空表时 `leaf_tree()` 里 `C:\Local` 的**每一个**直属子目录都要有一格（一个都不许漏成
        // "静默不提议"）。13 个直属子目录里 `Programs` 走 deny 根、`Junction` 走重解析点，
        // 剩下 11 个都该是"缺键点名"—— 写成等号而不是 `>=`，是因为这一格数的正是覆盖面：
        // 少一个是漏点名，多一个是把更深的层也当成了候选（那两种都是这条模式的失效形状）。
        let named = r
            .exclusions
            .iter()
            .filter(|e| e.reason == ExclusionReason::AppFactKeyMissing)
            .count();
        assert_eq!(named, 11, "空表的覆盖面 = 入口的直属子目录（13 个里 deny 与重解析点各占一个）");

        // 表里真给了 Absent 才提议 —— 这条证明上面那段是**事实闸**，不是"把规则关掉"的开关。
        let mut o = EvaluateOptions::default();
        o.app_facts.insert("ghost".into(), AppFact::Absent);
        let ok = evaluate_rules(&t, &[ghost.clone()], &leaf_env(), &o);
        assert_eq!(of(&ok, "ghost-app-data").total_bytes, 123, "Absent 是唯一能提议的状态");
        // 反过来：Present（应用还在）不许提议 —— 本机审计就是靠这两半推翻过三次单路判据
        let mut o2 = EvaluateOptions::default();
        o2.app_facts.insert("ghost".into(), AppFact::Present);
        let no = evaluate_rules(&t, &[ghost], &leaf_env(), &o2);
        assert!(no.findings.is_empty(), "Present 还提议就是把活应用当残留");
        assert_eq!(no.reclaimable_bytes, 0);

        // 回归轴：没声明这个字段的规则，带不带表逐字节相同（与 `requiresDetector` 那条同一姿态）
        let plain = mk_rule("plain", Risk::Safe, &[r"%LOCALAPPDATA%\Ghost"]);
        let a = serde_json::to_string(&evaluate_rules(&t, &[plain.clone()], &leaf_env(), &EvaluateOptions::default())).unwrap();
        let mut o3 = EvaluateOptions::default();
        o3.app_facts.insert("ghost".into(), AppFact::Present);
        o3.app_facts.insert("nothing".into(), AppFact::Absent);
        let b = serde_json::to_string(&evaluate_rules(&t, &[plain], &leaf_env(), &o3)).unwrap();
        assert_eq!(a, b, "不带这个字段的规则不该因为表而改变任何一件事");
    }

    /// 第三种采集模式的规则（P2-T4 那条 `orphan-app-data` 的形状）：容器入口 + 围栏 + 机器事实闸。
    /// 声明层闸（`validate.rs::requires_absent_app_fact_with_leaf_dirs_is_refused` 的 ③ 段）
    /// 认的就是这个形状，评估层这三条用例全部跑在它上面。
    fn app_fact_rule(id: &str, paths: &[&str]) -> Rule {
        let mut r = leaf_rule(id, &[], &[], &[], paths);
        r.risk_level = Risk::High;
        r.requires_absent_app_fact = Some(true);
        r
    }

    /// **P2-T3 判据 ①**：`Absent` 只收**入口目录的直属子目录**那一层。
    ///
    /// 三段各自钉一件事：
    ///  · 直属子目录 `Ghost` 被表批准 ⇒ 整棵子树收（123 字节）、`matched_roots` 就是它；
    ///  · 表里同时把 `cache` 判成 `Absent` ⇒ **一个 `Cache` 都不许收**（`SomeApp\Cache` 160、
    ///    `Deep\Nest\a\b\c\Cache` 70、`Twin\Cache` 35 都在第二层以下或更深处）。这一格就是
    ///    "第三种模式 ≠ leaf 模式"的正面证据：把采集面写成任意深度，这条当场红；
    ///  · 入口自己（`C:\Local`，basename `local`）**不是候选** —— 拿容器名去查表永远缺键，
    ///    于是整条规则会从报告里静默消失；所以既不许有以 `C:\Local` 为 path 的排除记录，
    ///    也不许它进 `matched_roots`。
    ///
    /// 还钉住"没批准的候选一个文件都不枚举"：`SomeApp` 判 Present ⇒ 它家那 `Cache` 里
    /// 的 160 字节连被看见的资格都没有（`claimed` 里不许出现）。
    #[test]
    fn absent_only_collects_direct_children_of_the_entry() {
        let t = leaf_tree();
        let rule = app_fact_rule("orphan-app-data", &["%LOCALAPPDATA%"]);
        let mut o = EvaluateOptions::default();
        o.app_facts.insert("ghost".into(), AppFact::Absent);
        o.app_facts.insert("cache".into(), AppFact::Absent); // 深处的命中：这一格必须收不到
        o.app_facts.insert("someapp".into(), AppFact::Present);
        let r = evaluate_rules(&t, &[rule], &leaf_env(), &o);
        let f = of(&r, "orphan-app-data");
        assert_eq!(f.matched_roots, vec![r"C:\Local\Ghost"], "采集根只能是入口的直属子目录：{:?}", f.matched_roots);
        assert_eq!((f.file_count, f.total_bytes), (1, 123), "实得 {:?}", f.sample_paths);
        assert_eq!(f.risk_level, Risk::High, "🟠 这一档由规则声明，不是引擎加的");

        // 深处那三棵 `Cache` 一个字节都没进账（160 / 70 / 35）
        for keep in ["c1.bin", "c2.dat", "deep.bin", "inner.bin", "nested.bin"] {
            assert!(
                !claimed(&r).iter().any(|p| p.ends_with(keep)),
                "任意深度的 {keep} 被认领了 —— 第三种采集模式写成了 leaf 模式：{:?}",
                claimed(&r)
            );
        }
        // 入口自己不是候选
        assert!(
            !r.exclusions.iter().any(|e| e.path == r"C:\Local" && matches!(
                e.reason,
                ExclusionReason::AppFactKeyMissing | ExclusionReason::AppFactUnknown | ExclusionReason::AppFactPresent
            )),
            "拿容器名 `local` 去查了机器事实表 —— 入口自己成了候选：{:?}",
            r.exclusions.iter().map(|e| (&e.reason, &e.path)).collect::<Vec<_>>()
        );
    }

    /// **P2-T3 判据 ②**：`Present` / `Unknown` / 缺键 三档各记**一条分名的**排除，
    /// 三条**互相分得开**，每条都点名到那个具体路径；而且缺键**不许被读成 Absent**。
    ///
    /// 判据强度在中间那一段：三条理由的 `reason` 必须两两不同、`detail` 也必须两两不同
    /// （只比 `reason` 不够 —— 三个 reason 挂同一句措辞，读者还是分不出"看了说还在"与"没看过"）。
    /// `Unknown` 那条还要带上注入的 `why` 原话，这是 [`app_fact_tables`] 那张副表存在的全部理由。
    ///
    /// 变异电池（plan §3-P2-T3）把"缺键 ⇒ Unknown"装回成"缺键 ⇒ Absent"时，这条必须红：
    /// 少一条 `app-fact-key-missing`、`hiview` 那 4250 字节凭空进账。
    #[test]
    fn present_and_unknown_and_missing_key_each_get_named_exclusion() {
        let t = leaf_tree();
        let rule = app_fact_rule("orphan-app-data", &["%LOCALAPPDATA%"]);
        let rules = [rule.clone()];
        let mut o = EvaluateOptions::default();
        o.app_facts.insert("someapp".into(), AppFact::Present);
        o.app_facts.insert("hiview".into(), AppFact::Unknown);
        o.app_fact_whys.insert("hiview".into(), "C5 进程快照枚举到第 12 个进程时断了".to_string());
        // `git`（`C:\Local\git`）**不进表** —— 那一格就是要测的"缺键"
        let r = evaluate_rules(&t, &rules, &leaf_env(), &o);

        let pick = |reason: ExclusionReason, path: &str| -> (String, String) {
            let e = r
                .exclusions
                .iter()
                .find(|x| x.reason == reason && x.path == path)
                .unwrap_or_else(|| panic!(
                    "少了 {reason:?} 对 {path} 的那一条：三档弃权理由必须各自分名，实得 {:?}",
                    r.exclusions.iter().filter(|x| x.rule_id.as_deref() == Some("orphan-app-data")).map(|x| (&x.reason, &x.path)).collect::<Vec<_>>()
                ));
            (e.path.clone(), e.detail.clone())
        };
        let (present_path, present_detail) = pick(ExclusionReason::AppFactPresent, r"C:\Local\SomeApp");
        let (unknown_path, unknown_detail) = pick(ExclusionReason::AppFactUnknown, r"C:\Local\Hiview");
        let (missing_path, missing_detail) = pick(ExclusionReason::AppFactKeyMissing, r"C:\Local\git");

        // ① 每条都点名到**具体路径**（不是总数、不是父容器）
        assert_eq!(present_path, r"C:\Local\SomeApp");
        assert_eq!(unknown_path, r"C:\Local\Hiview");
        assert_eq!(missing_path, r"C:\Local\git", "缺键的那条也要落到具体目录");

        // ② 三条理由两两不同，措辞也两两不同（读者能分开）
        assert_ne!(present_detail, unknown_detail);
        assert_ne!(present_detail, missing_detail);
        assert_ne!(unknown_detail, missing_detail);
        assert!(present_detail.contains("Present") && present_detail.contains("本体"), "{present_detail}");
        assert!(unknown_detail.contains("Unknown"), "{unknown_detail}");
        assert!(missing_detail.contains("没有这个键") || missing_detail.contains("缺键"), "{missing_detail}");

        // ③ 探针的 `why` 原话进了报告 —— 这一格是"为什么没判"的唯一出处
        assert!(unknown_detail.contains("C5 进程快照枚举到第 12 个进程时断了"), "why 没被带进 detail：{unknown_detail}");

        // ④ 缺键**不是** Absent，也不是 Unknown：三档一条都不许进账
        assert!(r.findings.is_empty(), "一个候选都没批准 ⇒ 不出 finding（与 not-installed 同一形状）");
        assert_eq!(r.reclaimable_bytes, 0, "Present/Unknown/缺键 都不许凭空进账");
        for path in [r"C:\Local\SomeApp", r"C:\Local\Hiview", r"C:\Local\git"] {
            assert!(
                !claimed(&r).iter().any(|p| p.starts_with(path)),
                "{path} 的地盘被认领了 —— 三档弃权里有一档走漏：{:?}",
                claimed(&r)
            );
        }

        // ⑤ 批准一格、弃权三格：进账的只有 Ghost 那 123 字节，另外三条排除照旧各在其位
        let mut o2 = o.clone();
        o2.app_facts.insert("ghost".into(), AppFact::Absent);
        let r2 = evaluate_rules(&t, &rules, &leaf_env(), &o2);
        assert_eq!(of(&r2, "orphan-app-data").total_bytes, 123);
        for reason in [
            ExclusionReason::AppFactPresent,
            ExclusionReason::AppFactUnknown,
            ExclusionReason::AppFactKeyMissing,
        ] {
            assert!(r2.exclusions.iter().any(|e| e.reason == reason), "批准了一个候选之后另外三档的点名掉了：{reason:?}");
        }
    }

    /// **围栏对第三种模式照样生效**（plan §2.4「围栏仍要罩住被采集的子树」）。
    ///
    /// 两种越栏形状都要走到"根本没枚举"那一档，而不是"枚举完再滤命中"：
    ///  · `Packages\ExampleApp…`：`C:\Local\Packages` 在 leaf_tree 里是 UWP 状态目录，本条 allow
    ///    之内、无 deny ⇒ 正常批准（用来证明"上面那条没枚举"不是夹具搭错了）；
    ///  · `C:\Local\Programs\Microsoft VS Code…`：`%LOCALAPPDATA%\Programs\*` 在 denyRoots 里 ⇒
    ///    表说 Absent 也不许越栏，`open_dir` 那一层就把它连枚举一起拦掉，并留一条 `outside-fence`。
    /// 另加一格**重解析点**：`C:\Local\Junction`（表里给 Absent）既不许当候选也不许跟进 ——
    /// junction 后面的树不在这条规则的授权根里，与 `walk_leaf` / 扫描器同一口径。
    #[test]
    fn the_fence_still_applies_to_the_app_fact_collected_subtree() {
        let t = leaf_tree();
        let rule = app_fact_rule("orphan-app-data", &["%LOCALAPPDATA%"]);
        let mut o = EvaluateOptions::default();
        // 让 deny 根底下那个目录也成为候选：把表的键换成它的 basename（`programs`）
        o.app_facts.insert("programs".into(), AppFact::Absent);
        o.app_facts.insert("junction".into(), AppFact::Absent);
        let r = evaluate_rules(&t, &[rule], &leaf_env(), &o);
        assert!(r.findings.is_empty(), "被围栏拦住的那一格是唯一候选 ⇒ 一条都不提议");
        let fence = r
            .exclusions
            .iter()
            .find(|e| e.reason == ExclusionReason::OutsideFence && e.path == r"C:\Local\Programs")
            .unwrap_or_else(|| panic!(
                "表批准了 Absent 也不许越过 denyRoots，且要留下 outside-fence 的点名：{:?}",
                r.exclusions.iter().map(|e| (&e.reason, &e.path)).collect::<Vec<_>>()
            ));
        assert!(fence.detail.contains("denyRoots"), "{}", fence.detail);
        assert!(
            r.exclusions.iter().any(|e| e.reason == ExclusionReason::NotScanned && e.path == r"C:\Local\Junction"
                && e.detail.contains("重解析点")),
            "重解析点目录被当成了候选：{:?}",
            r.exclusions.iter().map(|e| (&e.reason, &e.path)).collect::<Vec<_>>()
        );
        assert!(
            !t.opened.borrow().iter().any(|p| normalize_key(p) == normalize_key(r"C:\Local\Programs")),
            "越栏的候选目录被枚举过了（那是「枚举完再滤掉」，plan §0.2 禁的形状）：{}",
            open_leap(&t)
        );
        assert!(
            !t.opened.borrow().iter().any(|p| normalize_key(p).starts_with(&normalize_key(r"C:\Local\Junction"))),
            "跟进重解析点目录了：{}",
            open_leap(&t)
        );
    }

    /// 把"被枚举过的目录"打成一串，只给 assert 的失败信息用。
    fn open_leap(t: &FakeTree) -> String {
        t.opened
            .borrow()
            .iter()
            .cloned()
            .collect::<Vec<_>>()
            .join("、")
    }

    /// **P2-T3 的映射步**（plan §5 交接的硬事实 7）：探针侧 `Unknown{why:String}` 到规则侧
    /// fieldless 三态的这一次转换不许把 `why` 弄丢，也不许把不相干的 `why` 收进来。
    #[test]
    fn the_app_fact_mapping_step_carries_the_why_and_strips_the_rest() {
        let (facts, whys) = app_fact_tables([
            AppFactRow { key: "claude".into(), fact: AppFact::Present, why: Some("别收") },
            AppFactRow { key: "acme".into(), fact: AppFact::Absent, why: None },
            AppFactRow {
                key: "ghost".into(),
                fact: AppFact::Unknown,
                why: Some("C5 进程快照在枚举到第 12 个进程时断了"),
            },
            AppFactRow { key: "nosy".into(), fact: AppFact::Unknown, why: Some("   ") },
        ]);
        assert_eq!(facts.len(), 4);
        assert_eq!(facts["claude"], AppFact::Present);
        assert_eq!(facts["acme"], AppFact::Absent);
        // `why` 只有 Unknown 那一档带得走
        assert_eq!(whys.len(), 2, "Present/Absent 的 why 不许进水：{whys:?}");
        assert!(whys["ghost"].contains("C5"), "探针的原话要逐字留着：{}", whys["ghost"]);
        assert!(whys["nosy"].contains("弃权理由缺失"), "空 why 要自我点名而不是留白：{}", whys["nosy"]);
        // 同键两个矛盾的结论 ⇒ 折成 Unknown（不 panic、也不"信后一份"）
        let (facts2, whys2) = app_fact_tables([
            AppFactRow { key: "x".into(), fact: AppFact::Absent, why: None },
            AppFactRow { key: "x".into(), fact: AppFact::Present, why: None },
        ]);
        assert_eq!(facts2["x"], AppFact::Unknown, "矛盾结论折成 Absent/Present 都是在替机器编证据");
        assert!(whys2["x"].contains("矛盾"), "要点名为什么矛盾：{}", whys2["x"]);

        // 端到端：映射步交出的 why 真的出现在排除记录里（这两段之间没有第二份措辞）
        let t = leaf_tree();
        let (f, w) = app_fact_tables([AppFactRow {
            key: "hiview".into(),
            fact: AppFact::Unknown,
            why: Some("C2 厂商键那一根被 ACL 拒了"),
        }]);
        let mut o = EvaluateOptions::default();
        o.app_facts = f;
        o.app_fact_whys = w;
        let r = evaluate_rules(&t, &[app_fact_rule("orphan-app-data", &["%LOCALAPPDATA%"])], &leaf_env(), &o);
        let e = r
            .exclusions
            .iter()
            .find(|x| x.reason == ExclusionReason::AppFactUnknown)
            .expect("Unknown 要有自己的那条排除");
        assert!(e.detail.contains("C2 厂商键那一根被 ACL 拒了"), "映射步到报告这一段把 why 弄丢了：{}", e.detail);
    }

    /// **回归轴**（plan §3-P2-T3 立的，P2-T4 改写）。原先这条的前提是「内置表还是 21 条、
    /// 一条都不带 `requiresAbsentAppFact`」—— 那句从 P2-T4 起**按设计不再成立**：表尾第 22 条
    /// `orphan-app-data` 带的就是它。留着那句只会得到一个红，而红里没有信息。
    ///
    /// 这里保留的是这条轴当初真正在保护的那件事，并把它的前提换成**正面形式**：
    /// 把表尾那条新规则摘掉 ⇒ 剩下的恰好是 P2-T4 动手之前那张表（21 条）⇒ 它的产出必须与
    /// pre-change 基线 `BUILTIN_P2T3_GOLDEN` **逐字节**相同，**挂满一张机器事实表也不许多变一个字节**。
    /// 而"表上带这个字段的规则恰好只有第 22 条、且它在表尾"这一格现在是被**断言**的（不是被假设），
    /// 因为它是那条摘除切片成立的前提：哪天多一条也带这个字段，切片就不再等于"动手之前那张表"，
    /// 这条用例当场红，而不是安静地少比一条规则。
    ///
    /// 第 22 条**自己**在空表下的那半（0 字节 + 每个候选点名）住在
    /// [`an_empty_app_fact_table_leaves_rule_22_at_zero_bytes_while_naming_every_candidate`]，
    /// 两条各管一头：那条管新规则的 fail-safe，这条管老账目不动。**不许合并成一句前提。**
    ///
    /// `BUILTIN_P2T3_GOLDEN` 是从 `d671390`（P2-T3 动手**之前**的那份 `engine.rs` + `validate.rs`）
    /// 用同一棵 `leaf_tree()`、同一份 `leaf_env()`、同一个 `project()` 投影录下来的，
    /// 不是改动之后自己给自己交的作业。
    #[test]
    fn the_builtin_table_without_the_new_rule_is_byte_identical() {
        let all = builtin_rules();
        assert_eq!(all.len(), 23, "表上现在是 23 条（P2-T4 的 `orphan-app-data` 与 M6 的 `gpu-driver-leftovers` 都在位）");
        let with_the_field: Vec<String> = all
            .iter()
            .filter(|r| r.requires_absent_app_fact == Some(true))
            .map(|r| r.id.clone())
            .collect();
        assert_eq!(with_the_field, vec!["orphan-app-data".to_string()], "带机器事实闸的规则必须恰好只有那一条（它排在哪儿由 builtin.rs 的位置判据管，这里不比位置）");
        // 切片按**谓词**取，不按位置（M5-P3：第 22 条已从表尾前移到六条形状规则之前）。
        // 原来那两句是 `all.last()` 点名 + `all[..21]` —— 它们绿在「第 22 条恰好在表尾」，
        // 而这条判据的真正含义是「动手之前那张 21 条表的产出逐字节不变」，与它排在哪无关。
        // M6 起谓词同时摘掉 `gpu-driver-leftovers`（它也在 golden 之后上表，且不带机器事实闸，
        // 只按上一条谓词滤不掉）。
        let rules: Vec<Rule> = all
            .iter()
            .filter(|r| r.requires_absent_app_fact.is_none() && r.id != "gpu-driver-leftovers")
            .cloned()
            .collect();
        assert_eq!(rules.len(), 21, "谓词取出的集合不是 21 条 —— 下面比的就不是动手之前那张表");
        // 21 条的**相对顺序**不再单独断言：那两个集合都从同一个 `all` 推出来，比了自己等于没比。
        // 这一维由下面那句 `produced == BUILTIN_P2T3_GOLDEN` 守 —— 那串投影把 findings 按顺序写死，
        // 既有 21 条彼此换了次序就会当场红。

        let t = leaf_tree();
        let base = evaluate_rules(&t, &rules, &leaf_env(), &EvaluateOptions::default());
        let produced = project(&base);
        assert_eq!(produced, BUILTIN_P2T3_GOLDEN, "内置表（21 条、无新字段）的产出变了 —— 逐字段比一遍再判");

        // 第二半：挂满一张表（三档都有、还带 whys）也不许改变一个字节 ——
        // 走的是"没有规则声明它"这一条，不是"表里恰好没键"
        let (facts, whys) = app_fact_tables([
            AppFactRow { key: "ghost".into(), fact: AppFact::Absent, why: None },
            AppFactRow { key: "cache".into(), fact: AppFact::Absent, why: None },
            AppFactRow { key: "someapp".into(), fact: AppFact::Present, why: None },
            AppFactRow { key: "hiview".into(), fact: AppFact::Unknown, why: Some("夹具：这一格故意弃权") },
            AppFactRow { key: "local".into(), fact: AppFact::Absent, why: None },
        ]);
        let mut o = EvaluateOptions::default();
        o.app_facts = facts;
        o.app_fact_whys = whys;
        let t2 = leaf_tree();
        let with_table = evaluate_rules(&t2, &rules, &leaf_env(), &o);
        assert_eq!(project(&with_table), BUILTIN_P2T3_GOLDEN, "挂上机器事实表就改变了既有 21 条的产出");
        assert_eq!(
            serde_json::to_string(&with_table).unwrap(),
            serde_json::to_string(&base).unwrap(),
            "整份报告的线格式（含 exclusions 的措辞）也必须逐字节相同"
        );

        // 第三半：把 21 条里随便一条**装上**这个字段，产出必须与基线不同 ——
        // 没有这一段，上面两条 equality 可以绿在"引擎根本没读这张表"上（恒过的闸）。
        let mut flagged = builtin_rules();
        let mut converted = 0;
        for r in &mut flagged {
            if r.scanner.leaf_dirs.is_empty() && r.scanner.leaf_files.is_empty() && r.scanner.scope_fence.is_none() {
                r.scanner.scope_fence = Some(leaf_fence());
                r.requires_absent_app_fact = Some(true);
                converted += 1;
            }
        }
        assert!(converted > 0, "夹具失效：一条都没改成第三种模式");
        let t3 = leaf_tree();
        let flagged_report = evaluate_rules(&t3, &flagged, &leaf_env(), &o);
        assert_ne!(
            project(&flagged_report),
            BUILTIN_P2T3_GOLDEN,
            "把规则改成带机器事实闸之后产出仍然逐字节相同 ⇒ 上面那条回归轴是空的（引擎没在读表）"
        );
    }

    /// 改动前录下的内置表投影（录制方法与"为什么不是自我印证"见上面那条用例的注释）。
    ///
    /// **P2-T5 重录一次**（本行以上那段"从 `d671390` 录制"的 provenance 不变，只是基线随裁定 1 挪了一格）：
    /// 包树不进 leaf 采集之后，夹具树里 `C:\Local\Repo\.git` 那一个目录变成 **4 条
    /// `package-tree` 排除**（`app-cache-data` / `app-rotated-logs` / `crash-dumps` /
    /// `installer-artifacts` —— 表上全部四条 leaf 规则各一条），
    /// 重录前后逐段比过：findings / rejectedRules / territories / bytesByRisk / reclaimableBytes /
    /// safetyBlocked **全部逐字节相同**，排除项一条没少 —— 差异只有那 4 条新增。
    /// 两条模板规则（`dev-tool-cache` / `user-downloads-installers`）不在名单内，
    /// 与 `NO_LEAF_GOLDEN` 那条纯模板回归轴同一个结论。
    const BUILTIN_P2T3_GOLDEN: &str = r#"[[["windows-temp","1","999",["C:\\Temp"],[["C:\\Temp\\Cache\\outside-allow.bin","999"]],false,"safe","temp"],["browser-cache","0","0",[],[],false,"safe","browser-cache"],["thumbnail-cache","0","0",[],[],false,"safe","thumbnail-cache"],["shader-cache","0","0",[],[],false,"safe","shader-cache"],["error-reporting","0","0",[],[],false,"safe","error-reporting"],["recycle-bin","0","0",[],[],false,"forbidden","recycle-bin"],["npm-cache","1","80",["C:\\Local\\npm-cache"],[["C:\\Local\\npm-cache\\_cacache\\pkg.bin","80"]],false,"caution","dev-cache"],["pip-cache","0","0",[],[],false,"caution","dev-cache"],["gradle-cache","0","0",[],[],false,"caution","dev-cache"],["vscode-cache","0","0",[],[],false,"caution","dev-cache"],["maven-repository","0","0",[],[],false,"caution","dev-cache"],["pnpm-store","0","0",[],[],false,"caution","dev-cache"],["yarn-cache","0","0",[],[],false,"caution","dev-cache"],["huggingface-cache","0","0",[],[],false,"caution","dev-cache"],["android-sdk-temp","0","0",[],[],false,"caution","dev-cache"],["app-cache-data","8","350",["C:\\Local\\Crx\\component_crx_cache","C:\\Local\\Deep\\Nest\\a\\b\\c\\Cache","C:\\Local\\SomeApp\\Cache","C:\\Local\\Twin\\Cache","C:\\ProgramData\\Vendor\\Cache","C:\\Roam\\Another\\Cache"],[["C:\\Local\\Crx\\component_crx_cache\\crx.bin","25"],["C:\\Local\\Deep\\Nest\\a\\b\\c\\Cache\\deep.bin","70"],["C:\\Local\\SomeApp\\Cache\\c1.bin","100"],["C:\\Local\\SomeApp\\Cache\\c2.dat","60"],["C:\\Local\\Twin\\Cache\\Cache\\nested.bin","5"],["C:\\Local\\Twin\\Cache\\inner.bin","30"],["C:\\ProgramData\\Vendor\\Cache\\pd.bin","20"],["C:\\Roam\\Another\\Cache\\roam.bin","40"]],false,"caution","app-transient"],["app-rotated-logs","4","810",["C:\\Local","C:\\Roam","C:\\ProgramData"],[["C:\\Local\\Hiview\\etl\\monitor.etl","60"],["C:\\Local\\Hiview\\HiviewPlatform.3.log","400"],["C:\\Local\\Hiview\\rot\\HiviewService.1.log","300"],["C:\\Local\\Hiview\\trace.log.01","50"]],false,"caution","app-transient"],["installer-artifacts","1","500",["C:\\Local\\foo-updater"],[["C:\\Local\\foo-updater\\pending\\setup.exe","500"]],false,"caution","installer-leftover"],["dev-tool-cache","0","0",[],[],false,"caution","app-transient"],["crash-dumps","0","0",[],[],false,"caution","app-transient"],["user-downloads-installers","0","0",[],[],false,"high","installer-leftover"]],[["android-sdk-temp","not-scanned","C:\\Local\\Android"],["app-cache-data","not-scanned","C:\\Local\\Junction"],["app-cache-data","outside-fence","C:\\Local\\Packages"],["app-cache-data","outside-fence","C:\\Local\\Programs"],["app-cache-data","package-tree","C:\\Local\\Repo\\.git"],["app-rotated-logs","not-scanned","C:\\Local\\Junction"],["app-rotated-logs","outside-fence","C:\\Local\\Packages"],["app-rotated-logs","outside-fence","C:\\Local\\Programs"],["app-rotated-logs","package-tree","C:\\Local\\Repo\\.git"],["browser-cache","not-scanned","C:\\Local\\Google"],["browser-cache","not-scanned","C:\\Local\\Microsoft"],["crash-dumps","not-scanned","C:\\Local\\Junction"],["crash-dumps","outside-fence","C:\\Local\\Packages"],["crash-dumps","outside-fence","C:\\Local\\Programs"],["crash-dumps","package-tree","C:\\Local\\Repo\\.git"],["dev-tool-cache","not-scanned","C:\\Local\\NuGet"],["dev-tool-cache","not-scanned","C:\\Local\\electron"],["dev-tool-cache","not-scanned","C:\\Local\\electron-builder"],["dev-tool-cache","not-scanned","C:\\ProgramData\\USOPrivate"],["dev-tool-cache","not-scanned","C:\\ProgramData\\USOShared"],["error-reporting","not-scanned","C:\\Local\\Microsoft"],["error-reporting","not-scanned","C:\\ProgramData\\Microsoft"],["gradle-cache","not-scanned","C:\\Users\\Kano\\.gradle"],["huggingface-cache","not-scanned","C:\\Users\\Kano\\.cache"],["installer-artifacts","not-scanned","C:\\Local\\Junction"],["installer-artifacts","outside-fence","C:\\Local\\Packages"],["installer-artifacts","outside-fence","C:\\Local\\Programs"],["installer-artifacts","package-tree","C:\\Local\\Repo\\.git"],["maven-repository","not-scanned","C:\\Users\\Kano\\.m2"],["npm-cache","not-scanned","C:\\Users\\Kano\\.npm-global"],["pip-cache","not-scanned","C:\\Local\\pip"],["pnpm-store","not-scanned","C:\\Local\\pnpm"],["pnpm-store","not-scanned","C:\\Local\\pnpm-store"],["recycle-bin","not-scanned","C:\\$Recycle.Bin"],["shader-cache","not-scanned","C:\\Local\\AMD"],["shader-cache","not-scanned","C:\\Local\\D3DSCache"],["shader-cache","not-scanned","C:\\Local\\NVIDIA"],["thumbnail-cache","not-scanned","C:\\Local\\Microsoft"],["user-downloads-installers","not-scanned","C:\\Users\\Kano\\Downloads"],["vscode-cache","not-scanned","C:\\Roam\\Code"],["yarn-cache","not-scanned","C:\\Local\\Yarn"]],[],[["android-sdk-temp",false,[],"1"],["gradle-cache",false,[],"1"],["huggingface-cache",false,[],"1"],["maven-repository",false,[],"1"],["npm-cache",false,[["C:\\Local\\npm-cache","80"]],"1"],["pip-cache",false,[],"1"],["pnpm-store",false,[],"2"],["vscode-cache",false,[],"1"],["yarn-cache",false,[],"1"]],["999","1740","0","0"],"2739",false]"#
    ;


    /* ---------------------------------------------------------------- *
     * P2-T3（plan `2026-10-13-deepclean-tauri-m5-p2.md` §5 那条发现的移植）——
     * TS 那台「枚举到就 throw」的结构性哨兵，Rust 侧此前**没有等价物**。
     *
     * 为什么必须补，以及它补的是哪一格：上面那条同名回归轴比的是 `project()` 的字节。
     * 而「枚举了 deny / 禁止根底下的目录，却一个字节都没认领」在字节口径下是**绿的** ——
     * 违例是那次枚举本身（引擎声称整棵子树不可达，却还是伸手去列了它），
     * 0 字节只是结果、不是结构。`FakeTree.opened` 事后确实记着，但只有"作者记得断言它"的
     * 用例才查得到；那条同名用例没断言，于是它对这一族失效是静默的。
     * 哨兵把判据从"事后翻记录"换成"被要求枚举就当场 panic"，就不依赖使用者的记性了。
     *
     * 名单的来源也要说一句，免得被当成"两边名单不一样所以哪边都没防"：
     * 这里防的是**内置表自己声明的不可达地板**（§16 `FORBIDDEN_PATH_PATTERNS` ∪
     * `FENCE_MINIMUM_DENY_PATTERNS`，即 `validate_fence` 拿去要求每条围栏 `deny_roots ⊇` 的
     * 那两张表），逐条走 `validate::fence_root(deny=true)` 的解析口径（剥掉收尾那一个通配段）。
     * TS 夹具的 `leaf_fence()` **额外**多 deny 了一根 `%LOCALAPPDATA%\Programs\*`，那是夹具围栏、
     * 不是产品地板（plan M5-P1 §10 第 12 条原文登记，并明写那台 throw 装置"不能直接跑真表"）；
     * 同一件事实在本节这份 pre-change golden 里是**字节**：`app-cache-data` 名下就带着
     * `…\Programs\Microsoft VS Code\Resources\app\Cache\do-not-touch.bin` 9000。
     * ⇒ 把那一根也写进哨兵名单 = 让内置表为一个它从未声明过的边界挨一下哨兵，
     *   两侧都会红，而那红是**假红**。名单由声明推导 ⇒ 地板表哪天加严，这里自动跟上。
     * ---------------------------------------------------------------- */

    /// 内置表自己声明的不可达地板（两张地板表逐条解析、按归一化去重）。
    /// 解不出来直接 panic —— 哨兵不许建立在"解析失败就等于没这条根"的那种根上。
    fn product_unreachable_floor() -> Vec<String> {
        let env = leaf_env();
        let mut out: Vec<String> = Vec::new();
        for p in crate::types::FORBIDDEN_PATH_PATTERNS
            .iter()
            .chain(crate::types::FENCE_MINIMUM_DENY_PATTERNS.iter())
        {
            let root = crate::validate::fence_root(p, &env, true)
                .unwrap_or_else(|e| panic!("地板根 {p} 解析不出来，结构性哨兵不能建立在解不出来的根上：{e}"));
            if !out.iter().any(|r| normalize_key(r) == normalize_key(&root)) {
                out.push(root);
            }
        }
        out
    }

    /// **结构性哨兵**：被要求 `children_of` 任何一个"声明为不可达"的目录就 panic。
    /// 与 TS `attrTree` 的 throw 装置同判据：枚举本身就是违例，认领与否、字节多少都无关。
    /// 取数面其余三 callable 原样转发给 `FakeTree`，`opened` 照旧记（要用它证明遍历真的发生过）。
    struct SentinelTree {
        inner: FakeTree,
        unreachable: Vec<String>,
    }

    impl SentinelTree {
        fn new(inner: FakeTree) -> Self {
            // 默认名单 = 产品自己声明的地板，一条不多一条不少（P2-T3 那两条用例吃的就是这一份）
            Self::armed(inner, &[])
        }
        /// 在**产品地板之上**再压几根"敢枚举就 panic"的名单 —— 只加严、不放松：
        /// `new()` 走的就是 `extra = []` 的同一条路径，P2-T3 那两条用例的哨兵强度逐字不变。
        /// P2-T5 用它把包树根交给哨兵（`package_trees_are_not_enumerated_not_filtered`）。
        fn armed(inner: FakeTree, extra_unreachable: &[&str]) -> Self {
            let mut unreachable = product_unreachable_floor();
            unreachable.extend(extra_unreachable.iter().map(|s| s.to_string()));
            assert!(!unreachable.is_empty(), "地板表解析出一片空集合 —— 那这台哨兵什么都没在防");
            Self { inner, unreachable }
        }
        fn opened(&self) -> Vec<String> {
            self.inner.opened.borrow().clone()
        }
    }

    impl RuleSource for SentinelTree {
        fn dir_id_by_path(&self, path: &str) -> Option<i64> {
            self.inner.dir_id_by_path(path)
        }
        fn children_of(&self, dir_id: i64) -> Vec<NodeView> {
            if let Some(p) = self.inner.paths.get(&dir_id) {
                if let Some(hit) = self.unreachable.iter().find(|g| path_is_under(p, g)) {
                    panic!(
                        "枚举了声明为不可达的目录 {p}（命中地板根 {hit}）—— 结构性不可达被打破了：\
                         引擎说这棵子树整条分支不可达，却还是伸手去列举了它（0 字节不算过）"
                    );
                }
            }
            self.inner.children_of(dir_id)
        }
        fn size_of(&self, dir_id: i64) -> Option<u64> {
            self.inner.size_of(dir_id)
        }
    }

    /// 哨兵**有牙**（与 P2-T1 那条"恒过的闸"同一条纪律）：名单里每一类地板根，直接去要它的子项
    /// 都必须 panic；而"合规的那一层"必须不 panic —— 否则这台装置是恒红的，测不出任何东西。
    /// 没有这一条，下面那条用例可以绿在"名单是空的 / 夹具里根本没有那种形状 / panic 写错了位置"上。
    #[test]
    fn the_sentinel_panics_on_every_floor_root_and_on_none_of_the_legitimate_ones() {
        for probe in [
            r"C:\Windows\System32",
            r"C:\Windows",
            r"C:\Program Files",
            r"C:\Program Files (x86)",
        ] {
            let t = SentinelTree::new(leaf_tree());
            let id = t
                .inner
                .dir_id_by_path(probe)
                .unwrap_or_else(|| panic!("夹具里没有 {probe} —— 那诱饵没上树，哨兵就是空跑"));
            let hit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.children_of(id)));
            assert!(hit.is_err(), "枚举 {probe} 没有 panic —— 恒过的闸，判据不成立");
        }
        // 反向半边：同一台装置在 allow 根之内的那一层必须正常交清单子
        let t = SentinelTree::new(leaf_tree());
        let id = t.inner.dir_id_by_path(r"C:\Local").expect("夹具没有 C:\\Local");
        let kids = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| t.children_of(id)));
        assert!(kids.is_ok(), "合规目录 C:\\Local 也被哨兵拦了 —— 恒红的闸同样测不出东西");
        assert!(!kids.unwrap().is_empty(), "C:\\Local 一层交不出子项：夹具空了");
    }

    /// **移植过来的那条结构性判据**（P2-T3 立、P2-T4 换前提）：**整张 22 条表**在一棵**挂着禁止根与
    /// 围栏外诱饵形状**的树上跑，全程由 `SentinelTree` 守着 —— 枚举到任何声明不可达的目录就当场 panic。
    ///
    /// P2-T4 之前这条只有"跑 21 条 + 与 pre-change 基线逐字节相同"那一半；那一半**原样留着**
    /// （基线里没有第 22 条，所以逐字节那半吃的仍是去掉表尾那一条的切片，理由见下面第二段的注释）。
    /// 新增的那半是这条轴今天真正的意义：**第三种采集模式现在被走到了**
    /// （`collect_app_fact_entry` 要 open 三条容器根、把每个直属子目录过一遍围栏判定 + 查表），
    /// 于是"从未枚举过地板根"这句话第一次不是成立在"没有规则用它"上，而是成立在"它在跑、却没越栏"上。
    #[test]
    fn the_builtin_table_under_the_structural_sentinel_never_enumerates_a_denied_directory() {
        let all = builtin_rules();
        assert_eq!(all.len(), 23, "M6 之后哨兵要跑的是**整张** 23 条表，不是去掉新规则那 21 条");
        // 逐字节那半的前提：`BUILTIN_P2T3_GOLDEN` 是**既有 21 条**的投影，第 22、23 条不在里面 ——
        // 把它们算进等式会得到一条恒红的断言，那不是判据。新规则自己的字节住在
        // `an_empty_app_fact_table_leaves_rule_22_at_zero_bytes_while_naming_every_candidate` 那一条。
        // 切片按**谓词**取，不按位置（TS 侧同一改动）：M5-P3 把第 22 条前移之后 `all[..21]` 含它、
        // 却少了 `user-downloads-installers`，等式比的就不是「动手之前那张表」了。
        // M6 起同时摘掉 `gpu-driver-leftovers`（同样在 golden 之后上表）。
        let rules: Vec<Rule> = all
            .iter()
            .filter(|r| r.requires_absent_app_fact.is_none() && r.id != "gpu-driver-leftovers")
            .cloned()
            .collect();
        assert_eq!(rules.len(), 21, "谓词取出的集合不是 21 条 —— 下面比的就不是动手之前那张表");

        let floor = product_unreachable_floor();
        // 诱饵确实在树上（否则"没响"不等于"没越界"，只等于"没得越"）
        for bait in [
            r"C:\Program Files\Huawei\PCManager\Application\Cache",
            r"C:\Windows\System32\Cache",
        ] {
            assert!(
                floor.iter().any(|g| path_is_under(bait, g)),
                "夹具诱饵 {bait} 不在地板名单里 —— 名单与夹具脱节了"
            );
        }

        let plain = SentinelTree::new(leaf_tree());
        let base = evaluate_rules(&plain, &rules, &leaf_env(), &EvaluateOptions::default());
        // 活跑过：不是一上来就整条规则被拒（那也会被误读成"一次都没枚举"）
        assert!(
            plain.opened().len() > 10,
            "遍历根本没发生过（{} 条）—— 这台哨兵是空跑的",
            plain.opened().len()
        );
        // 一条都没被声明层拒：否则"一次都没枚举"会被误读成哨兵过了，其实是谁都没上线
        assert!(base.rejected_rules.is_empty(), "内置表被拒：{:?}", base.rejected_rules);
        assert_eq!(base.findings.len(), 21, "二十一条都要真上线，否则上面那句「没响」没有意义");
        // 「没响」写成可复算的判据，而不只是"跑到最后没 panic"
        for p in plain.opened() {
            for g in &floor {
                assert!(!path_is_under(&p, g), "枚举了地板根 {g} 之下的 {p}");
            }
        }
        for p in claimed(&base) {
            for g in &floor {
                assert!(!path_is_under(&p, g), "认领了地板根 {g} 之下的 {p}");
            }
        }
        assert_eq!(project(&base), BUILTIN_P2T3_GOLDEN, "哨兵跑法下的内置表产出与 pre-change 基线不同");

        // 第二遍：挂满一张机器事实表（三档都有、还带 whys）—— 同一台哨兵、同一份字节、同一份枚举面
        let (facts, whys) = app_fact_tables([
            AppFactRow { key: "ghost".into(), fact: AppFact::Absent, why: None },
            AppFactRow { key: "cache".into(), fact: AppFact::Absent, why: None },
            AppFactRow { key: "someapp".into(), fact: AppFact::Present, why: None },
            AppFactRow {
                key: "hiview".into(),
                fact: AppFact::Unknown,
                why: Some("夹具：这一格故意弃权"),
            },
            AppFactRow { key: "local".into(), fact: AppFact::Absent, why: None },
        ]);
        let mut o = EvaluateOptions::default();
        o.app_facts = facts;
        o.app_fact_whys = whys;
        let armed = SentinelTree::new(leaf_tree());
        let with_table = evaluate_rules(&armed, &rules, &leaf_env(), &o);
        assert_eq!(project(&with_table), BUILTIN_P2T3_GOLDEN, "挂上机器事实表就改变了既有 21 条的产出");
        assert_eq!(
            armed.opened(),
            plain.opened(),
            "挂表之后被枚举的目录集合变了 —— 这 21 条里没有一条带 requiresAbsentAppFact，第三种采集模式根本不该被走到"
        );

        // ── P2-T4 新加的那一段：同一台哨兵跑**整张 22 条表**（空表 = 今天生产的默认形状）──
        // 第三种采集模式今天真的在跑了，所以这条判据从今天起才有内容：它跑过、它没越栏。
        let full = SentinelTree::new(leaf_tree());
        let full_report = evaluate_rules(&full, &all, &leaf_env(), &EvaluateOptions::default());
        assert_eq!(
            assert_every_rule_is_accounted_for(&full_report, &all),
            vec!["orphan-app-data".to_string()],
            "整张表在哨兵下的账目与 21 条那次对不上（第 22 条今天就该是弃权那一条）"
        );
        for p in full.opened() {
            for g in &floor {
                assert!(!path_is_under(&p, g), "第三种采集模式枚举了地板根 {g} 之下的 {p}");
            }
        }
        for p in claimed(&full_report) {
            for g in &floor {
                assert!(!path_is_under(&p, g), "整张表认领了地板根 {g} 之下的 {p}");
            }
        }
        // 而且它**没有多走盘**：22 条那次被枚举过的目录集合，去掉重复后与 21 条那次逐条相同 ——
        // 第 22 条只在容器规则已经打开过的那三根入口上列了一次子项。
        // （比集合而不是比 Vec：同一条 `C:\Local` 被两条规则各开一次是两次调用、一个目录。）
        let uniq = |v: Vec<String>| {
            let mut v = v;
            v.sort();
            v.dedup();
            v
        };
        assert_eq!(
            uniq(full.opened()),
            uniq(plain.opened()),
            "第 22 条上表之后被**枚举**的目录集合变了（0 字节是结果，没多走盘才是结构）"
        );
    }

    /// M5-P3 T1（plan `2026-10-14-deepclean-tauri-m5-p3.md` §2.5 / §3-T1 Step 2）——
    /// **表序前移的正面证据**，TS 同名同形（`tests/unit/rules-engine.test.ts`）。
    /// 这条写在本轮改动之前，所以今天必须红，且红在「app-cache-data 没被挡住」那一格。
    /// 吃整张内置表而不是单挑夹具规则：这次改的就是**表序**，把规则拆出来单跑等于把被测那一维拿掉。
    #[test]
    fn moving_rule_22_forward_makes_it_the_owner_of_files_the_shape_rules_claimed() {
        let t = leaf_tree();
        let rules = builtin_rules();
        let mut o = EvaluateOptions::default();
        o.app_facts.insert("someapp".into(), AppFact::Absent);
        o.app_facts.insert("hiview".into(), AppFact::Absent);
        let r = evaluate_rules(&t, &rules, &leaf_env(), &o);

        let orphan = of(&r, "orphan-app-data");
        for root in [r"C:\Local\SomeApp", r"C:\Local\Hiview"] {
            assert!(
                orphan.matched_roots.iter().any(|p| p == root),
                "候选 {root} 没进 matched_roots：{:?}",
                orphan.matched_roots
            );
        }
        // 排除记录按路径升序，两侧同一份期望串（String 的字节序：`H` < `e` < `r` < `t`）
        let stolen = |rid: &str| -> Vec<String> {
            let mut v: Vec<String> = r
                .exclusions
                .iter()
                .filter(|e| e.rule_id.as_deref() == Some(rid) && e.reason == ExclusionReason::ClaimedByOtherRule)
                .map(|e| e.path.clone())
                .collect();
            v.sort();
            v
        };
        assert_eq!(
            stolen("app-cache-data"),
            vec![r"C:\Local\SomeApp\Cache\c1.bin", r"C:\Local\SomeApp\Cache\c2.dat"],
            "app-cache-data 没被前移的第 22 条挡住 ⇒ 表序没生效"
        );
        assert_eq!(
            stolen("app-rotated-logs"),
            vec![
                r"C:\Local\Hiview\HiviewPlatform.3.log",
                r"C:\Local\Hiview\etl\monitor.etl",
                r"C:\Local\Hiview\rot\HiviewService.1.log",
                r"C:\Local\Hiview\trace.log.01",
            ],
            "轮转日志那四条没改姓"
        );
        assert!(
            of(&r, "app-cache-data").sample_paths.iter().all(|p| !p.path.contains("SomeApp")),
            "掉出去的格子没掉干净：{:?}",
            of(&r, "app-cache-data").sample_paths.iter().map(|p| &p.path).collect::<Vec<_>>()
        );
        // 反向半边：赢家手里必须真有这两格，否则上面两条可以绿在「谁都没认领」上
        for keep in ["c1.bin", "HiviewPlatform.3.log"] {
            assert!(
                orphan.sample_paths.iter().any(|p| p.path.ends_with(keep)),
                "第 22 条没认领 {keep} —— 排除记录可能绿在谁都没认领上：{:?}",
                orphan.sample_paths.iter().map(|p| &p.path).collect::<Vec<_>>()
            );
        }
    }

    /// M5-P3 T1 Step 3 —— **15 条基线免疫**（TS 同名同形）。这条今天绿、前移之后仍绿，
    /// 只在「前移过头」那个变异下红：它就是 §0 那格安全边界的守门人。
    /// 最后那句「第 22 条确实争过这个文件并被挡回来」是反空跑 —— 少了它，这条绿可能只是没走到。
    #[test]
    fn the_first_fifteen_rules_never_lose_territory_to_rule_22() {
        let t = leaf_tree();
        let rules = builtin_rules();
        let mut o = EvaluateOptions::default();
        o.app_facts.insert("npm-cache".into(), AppFact::Absent);
        let r = evaluate_rules(&t, &rules, &leaf_env(), &o);

        let npm = of(&r, "npm-cache");
        assert_eq!(npm.total_bytes, 80, "npm-cache 的地盘被第 22 条抢了 ⇒ 它排到了 15 条基线之前");
        assert_eq!(
            npm.sample_paths.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(),
            vec![r"C:\Local\npm-cache\_cacache\pkg.bin"]
        );
        assert!(
            r.exclusions.iter().any(|e| e.rule_id.as_deref() == Some("orphan-app-data")
                && e.reason == ExclusionReason::ClaimedByOtherRule
                && e.path == r"C:\Local\npm-cache\_cacache\pkg.bin"
                && e.detail.contains("npm-cache")),
            "第 22 条压根没碰过 pkg.bin ⇒ 这条用例什么都没钉：{:?}",
            r.exclusions.iter().map(|e| (&e.reason, &e.path)).collect::<Vec<_>>()
        );
    }

    /* ---------------------------------------------------------------- *
     * M5-P2 P2-T5（plan `2026-10-13-deepclean-tauri-m5-p2.md` §5 裁定 1）——
     * **包树不进 leaf 采集**。
     *
     * 夹具形状全部来自真机报告 `m5-p-golden-report.json`（`app-cache-data` 名下那 10 个地盘），
     * 不是想象中的形状：`…\Programs\nodejs\node_modules\undici\lib\cache`、
     * `…\hono\dist\middleware\cache`、`…\npm\node_modules\make-fetch-happen\lib\cache`。
     *
     * ⚠️ 这一组跑的是**内置表**（产品围栏），不是夹具那三条 leaf 规则 ——
     * `leaf_fence()` 额外 deny 了 `%LOCALAPPDATA%\Programs\*`，而产品地板里没有这一根
     * （M5-P1 §10 第 12 条原文登记）。拿夹具围栏跑这个形状 = 让"围栏"顶"包树判据"去接那条断言，
     * 那条判据今天根本没被走到（恒过的闸）。TS 侧同一组用例走 `builtinSentinelRun` 同一条理由。
     * ---------------------------------------------------------------- */

    /// 真机形状 + 一条**旁边**的真缓存（非真空判据）。
    fn package_tree_tree() -> FakeTree {
        tree_of_files(
            &[
                // ↓ 真机那 10 个地盘的形状：JavaScript 源码目录，名字恰好叫 `cache`
                (r"C:\Local\Programs\nodejs\node_modules\undici\lib\cache\store.js", 500),
                (r"C:\Local\Programs\nodejs\node_modules\undici\lib\cache\cache.js", 700),
                (r"C:\Local\Programs\nodejs\node_modules\hono\dist\middleware\cache\index.js", 300),
                (r"C:\Local\Programs\nodejs\node_modules\npm\node_modules\make-fetch-happen\lib\cache\entry.js", 250),
                // 轮转件 glob 的同一形状（裁定 1 明写：这条判据不是只给 leafDirs 那一族）
                (r"C:\Local\Programs\nodejs\node_modules\undici\logs\worker.1.log", 400),
                // 包树**之外**、同一条下降路径上的真缓存 —— 非真空对照
                (r"C:\Local\Programs\nodejs\Cache\real.bin", 800),
                (r"C:\Local\SomeApp\Cache\c1.bin", 100),
                // 包树名单里另两个名字的近邻形状：`venv` 里那个 `lib\site-packages`
                // （真机 `%LOCALAPPDATA%` 下 Python 虚拟环境的既有形状，同一条判据）
                (r"C:\Local\PyApp\venv\lib\site-packages\requests\cache\data.bin", 900),
                (r"C:\Local\PyApp\Cache\real2.bin", 60),
                // `dist` 是名单里的名字，但它**不是**任何一条 leaf 规则的采集根，
                // 于是那一格里根本不该有东西被认领（这一条是给判据本身做对照的）
                (r"C:\Local\WebApp\dist\assets\chunk.js", 120),
                (r"C:\Local\WebApp\Cache\real3.bin", 70),
                // ↓ 回归轴的那一半：这两格长在**模板地盘**（`dev-tool-cache` 的显式模板
                //   `%LOCALAPPDATA%\NuGet\v3-cache`）里，`lib` / `src` 只是模板根**下面**的目录名。
                //   模板通路走 `collect_territory`，不经过 leaf 下降 ⇒ 这 700 字节必须照常进账。
                (r"C:\Local\NuGet\v3-cache\lib\http.bin", 400),
                (r"C:\Local\NuGet\v3-cache\src\feed.bin", 300),
                // ↓ 2026-10-19：`%LOCALAPPDATA%\Programs` 进了 REPORT_ONLY（cleanup-rules §6
                //   R-DENY-INSTALLDIR）。于是 `Programs\nodejs` 那一整支从"包树判据在挡"变成
                //   "只上报根在挡"—— 主判据与反向半边都要另找一个**不被任何新门挡住**的邻层，
                //   否则它量到的就是别的门（包树判据自己反而没被量到）。
                (r"C:\Local\Portable\node_modules\undici\lib\cache\store.js", 500),
                (r"C:\Local\Portable\node_modules\undici\logs\worker.1.log", 400),
                // 这一支的非真空对照：同一条下降路径上、包树之外的真缓存
                (r"C:\Local\Portable\Cache\real.bin", 800),
            ],
            &[],
        )
    }

    /// 包树那一族的"不可达"名单（哨兵吃这个：枚举到就 panic）。
    ///
    /// 两条 `node_modules` 根都要在：`Programs\` 那一支现在还被 REPORT_ONLY 挡着
    /// （cleanup-rules §6），只有 `Portable\` 这一支真能验到包树判据本身。
    const PACKAGE_TREE_SENTINEL_ROOTS: [&str; 4] = [
        r"C:\Local\Programs\nodejs\node_modules",
        r"C:\Local\Portable\node_modules",
        r"C:\Local\PyApp\venv",
        r"C:\Local\WebApp\dist",
    ];

    /// **主判据**：真机上那一条形状的源码目录，一个字节都不许被认领，
    /// 并且要留下一条点名到 `…\node_modules` 那个**具体目录**的 `package-tree` 排除。
    #[test]
    fn a_source_directory_named_cache_under_a_package_tree_is_never_claimed() {
        let rules = builtin_rules();
        let t = SentinelTree::new(package_tree_tree());
        let report = evaluate_rules(&t, &rules, &leaf_env(), &Default::default());
        let c = claimed(&report);
        for p in &c {
            for g in PACKAGE_TREE_SENTINEL_ROOTS {
                assert!(!path_is_under(p, g), "认领了包树 {g} 之下的 {p} —— 那是已装应用的代码，不是缓存");
            }
        }
        // 逐条点名真机那四个形状（"一个字节都没进账"必须是这四个，不是恰好没别的）
        for bait in [
            r"C:\Local\Programs\nodejs\node_modules\undici\lib\cache\store.js",
            r"C:\Local\Programs\nodejs\node_modules\undici\lib\cache\cache.js",
            r"C:\Local\Programs\nodejs\node_modules\hono\dist\middleware\cache\index.js",
            r"C:\Local\Programs\nodejs\node_modules\npm\node_modules\make-fetch-happen\lib\cache\entry.js",
            r"C:\Local\PyApp\venv\lib\site-packages\requests\cache\data.bin",
        ] {
            assert!(!c.iter().any(|p| normalize_key(p) == normalize_key(bait)), "{bait} 被认领了");
        }
        // 排除记录：点名到**那个包树目录本身**，且是 leaf 那一条规则名下的。
        // ⚠️ 找 `Portable` 那一支：`Programs\node_modules` 现在被 REPORT_ONLY 挡着
        // （cleanup-rules §6 R-DENY-INSTALLDIR），它的排除理由是 report-only-root，
        // 到不了 package-tree 这一步。
        let ex: Vec<&Exclusion> = report
            .exclusions
            .iter()
            .filter(|e| e.reason == ExclusionReason::PackageTree)
            .collect();
        assert!(!ex.is_empty(), "包树被跳过了却没留下任何一条 package-tree 排除 —— 报告读起来就像那棵子树不存在");
        let named = ex
            .iter()
            .find(|e| normalize_key(&e.path) == normalize_key(r"C:\Local\Portable\node_modules"))
            .expect("必须点名到 …\\Portable\\node_modules 那一个具体目录，不许只报总数");
        assert_eq!(named.rule_id.as_deref(), Some("app-cache-data"));
        assert!(named.detail.contains("node_modules"), "detail 要把那个目录念出来：{}", named.detail);
        // 线上串必须是 kebab 的 package-tree（与 TS 侧同一个字面量，对账吃的就是这一格）
        assert_eq!(serde_json::to_value(named.reason).unwrap().as_str().unwrap(), "package-tree");
    }

    /// **结构性判据**：包树**不被枚举**，不是"枚举完再滤掉命中"（plan §0.2 同一个形状）。
    /// 用的是 P2-T3 那台现成的哨兵 —— 被要求 `children_of` 名单里的目录就当场 panic，
    /// 并把包树根**追加**进它的名单（`SentinelTree::armed` 只加严、不放松 `new()` 那一份）。
    #[test]
    fn package_trees_are_not_enumerated_not_filtered() {
        let rules = builtin_rules();
        let t = SentinelTree::armed(package_tree_tree(), &PACKAGE_TREE_SENTINEL_ROOTS);
        // 走到这里没 panic 就是判据成立；下面三段是"这台哨兵不是空跑"的自证。
        let report = evaluate_rules(&t, &rules, &leaf_env(), &Default::default());

        // ① 活跑过：不是"整条规则被拒所以什么都没枚举"，也不是"只有第 22 条在跑"
        assert_eq!(assert_every_rule_is_accounted_for(&report, &rules), vec!["orphan-app-data".to_string()]);
        assert_eq!(report.findings.len(), 22, "既有二十二条都要真上线（第 22 条在空表下弃权，见上面那句点名；第 23 条 0 字节照常上线）");
        assert!(
            t.opened().len() > 10,
            "遍历根本没发生过（{} 条）—— 这台哨兵是空跑的",
            t.opened().len()
        );
        // ② 可复算的"没响"：被枚举的目录集合里一个包树根之下都没有
        for p in t.opened() {
            for g in PACKAGE_TREE_SENTINEL_ROOTS {
                assert!(!path_is_under(&p, g), "枚举了包树根 {g} 之下的 {p} —— 不枚举才是结构，0 字节只是结果");
            }
        }
        // ③ 反向半边（恒过的闸那条纪律）：**没进名单的邻层**必须被枚举过，
        //    否则上面两段可以绿在"整棵 Portable 分支压根没走到"上。
        //    探针取 `Portable`（node_modules 的**父级**）而不是 `Portable\node_modules`
        //    本身 —— 后者正是包树判据要跳过的那个目录，要求它被枚举等于要求判据失效。
        //    （原来这条用 `Programs\nodejs`，同一形状；cleanup-rules §6 之后 Programs 整棵
        //     进了 REPORT_ONLY，于是挪到 Portable 这一支。）
        assert!(
            t.opened().iter().any(|p| normalize_key(p) == normalize_key(r"C:\Local\Portable")),
            "连 …\\Portable 都没枚举 ⇒ 判据其实是被别的门挡住的，不是包树这一条在起作用"
        );
        // ④ 三种 leaf 模式都吃这条判据：`leafFiles`（轮转件）名下也要有一条 package-tree
        for id in ["app-cache-data", "app-rotated-logs", "installer-artifacts", "crash-dumps"] {
            assert!(
                report.exclusions.iter().any(|e| e.reason == ExclusionReason::PackageTree && e.rule_id.as_deref() == Some(id)),
                "规则 {id} 的 leaf 下降没留下 package-tree 排除 —— 判据漏了它这一族"
            );
        }
    }

    /// **非真空对照**：包树判据不许把采集整段弄坏 —— 包树**旁边**那个真缓存必须照常认领。
    /// 上面两条如果因为"什么都没收到"而绿，这条当场红。
    #[test]
    fn a_real_cache_next_to_a_package_tree_is_still_found() {
        let rules = builtin_rules();
        let t = SentinelTree::new(package_tree_tree());
        let report = evaluate_rules(&t, &rules, &leaf_env(), &Default::default());
        let f = of(&report, "app-cache-data");
        // 探针用 `Portable` 那一支：`Programs\nodejs\Cache` 整棵在 REPORT_ONLY 里
        // （cleanup-rules §6 R-DENY-INSTALLDIR），照常枚举、照实报占用，但没有规则能认领它。
        for p in [
            r"C:\Local\Portable\Cache\real.bin",
            r"C:\Local\SomeApp\Cache\c1.bin",
            r"C:\Local\PyApp\Cache\real2.bin",
            r"C:\Local\WebApp\Cache\real3.bin",
        ] {
            assert!(
                claimed(&report).iter().any(|c| normalize_key(c) == normalize_key(p)),
                "{p} 没被认领 —— 采集这一整段坏了，那上面两条『没认领』就是假绿"
            );
        }
        // 800 + 100 + 60 + 70 = 1030：真缓存一格都没少
        assert_eq!(f.total_bytes, 1030, "实得 {:?}", f.sample_paths);
        assert!(
            f.matched_roots
                .iter()
                .any(|r| normalize_key(r) == normalize_key(r"C:\Local\Portable\Cache")),
            "…\\Portable\\Cache 必须是采集根 —— 包树判据不许把它也吃掉：{:?}",
            f.matched_roots
        );
    }

    /// **回归轴**（裁定 1 第 3 点）：包树名单**只**打在 leaf 下降上，模板通路一个字都不受影响。
    /// 三个方向合起来才是这句话：
    ///  ① 模板根**底下**那些恰好叫 `lib` / `src` 的目录，字节照常进账（`dev-tool-cache` 的
    ///     `%LOCALAPPDATA%\NuGet\v3-cache` 就是这一形状）—— 少了这一半，"模板规则没受影响"
    ///     可以绿在"模板通路压根没在这棵树上收到东西"上；
    ///  ② 模板规则名下**一条 `package-tree` 都不许出现**（出现了就是判据伸进 `collect_territory`）；
    ///  ③ 把 21 条的 leaf 判据全部摘成显式空值再跑同一棵树，那五条模板规则的 finding 逐字节不变。
    #[test]
    fn plain_template_rules_are_unaffected_by_the_package_tree_list() {
        let rules = builtin_rules();
        let with_leaf = {
            let t = SentinelTree::new(package_tree_tree());
            evaluate_rules(&t, &rules, &leaf_env(), &Default::default())
        };

        // ① 模板地盘里的 `lib` / `src`：700 字节照常认领
        let d = of(&with_leaf, "dev-tool-cache");
        assert_eq!(d.total_bytes, 700, "模板地盘下的包树名字目录被挡了 —— 判据越界到 collect_territory：实得 {:?}", d.sample_paths);
        assert_eq!(d.file_count, 2, "实得 {:?}", d.sample_paths);

        // ② 模板规则名下零条 package-tree
        for e in with_leaf.exclusions.iter().filter(|e| e.reason == ExclusionReason::PackageTree) {
            let id = e.rule_id.clone().unwrap_or_default();
            assert!(
                rules.iter().any(|r| r.id == id && !(r.scanner.leaf_dirs.is_empty() && r.scanner.leaf_files.is_empty())),
                "非 leaf 规则 {id} 记了一条 package-tree（{}/{:?}）—— 判据作用域越界",
                e.path,
                e.rule_id
            );
        }

        // ③ 摘掉 leaf 判据后，模板那几条的 finding 逐字节相同
        let mut templated = builtin_rules();
        for r in &mut templated {
            r.scanner.leaf_dirs = Vec::new();
            r.scanner.leaf_files = Vec::new();
        }
        let t2 = SentinelTree::new(package_tree_tree());
        let without_leaf = evaluate_rules(&t2, &templated, &leaf_env(), &Default::default());
        for id in ["dev-tool-cache", "user-downloads-installers", "windows-temp", "npm-cache", "browser-cache"] {
            let (a, b) = (of(&with_leaf, id), of(&without_leaf, id));
            assert_eq!(
                serde_json::to_string(a).unwrap(),
                serde_json::to_string(b).unwrap(),
                "模板规则 {id} 的产出因为包树名单变了 —— 判据作用域越界"
            );
        }
        // 反向半边：带 leaf 判据那一份**确实**有 package-tree（否则 ② 与 ③ 都是空的）
        assert!(
            with_leaf.exclusions.iter().any(|e| e.reason == ExclusionReason::PackageTree),
            "带 leaf 判据的那一份都没有 package-tree 排除 —— 这条回归轴什么都没比"
        );
    }

    /// 两侧名单**逐字同序**（plan Global Constraints：两份实现字段名/取值/顺序逐字相同）。
    /// 这条判据比的是"另一侧源码里的那一串字面量"，不是各自对一份本地抄本 ——
    /// 抄本会漂，而这条判据恰好防的就是漂（TS 侧同名用例反向读 Rust 源码）。
    ///
    /// 名单漂了会怎样：`app-cache-data` 在某一侧吃掉 `…\node_modules\…\cache`，
    /// 而零容差对账那台夹具没这种形状 ⇒ 两侧各说各话、报告字节不一样。
    #[test]
    fn the_package_tree_list_is_identical_on_both_sides() {
        let ts_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("仓库根")
            .join("core")
            .join("rules")
            .join("types.ts");
        let src = std::fs::read_to_string(&ts_path)
            .unwrap_or_else(|e| panic!("读不到 TS 侧 {}（{e}）—— 这条判据不许退化成只比自己", ts_path.display()));
        let ts_names = parse_name_list(&src, "export const PACKAGE_TREE_NAMES")
            .unwrap_or_else(|| panic!("TS 侧解析不出 PACKAGE_TREE_NAMES 那份名单（{}）—— 空集合与缺声明都算判据失败", ts_path.display()));
        let rust: Vec<String> = PACKAGE_TREE_NAMES.iter().map(|s| s.to_string()).collect();
        assert_eq!(rust, ts_names, "两侧包树名单不同序或不同串（Rust 取自 types.rs，TS 取自 core/rules/types.ts）");
        assert_eq!(rust.len(), 10, "名单长度变了要两侧同时改，并把这条断言一起改");
    }

    /// 从另一侧源码里取出 `<decl> … [ … ]` 那一段的字面量，按**出现次序**（单双引号都认 ——
    /// TS 用单引号、Rust 用双引号，同一份解析器两边复用，免得"两侧各自一套"又漂一次）。
    /// `=` 之后的那一个 `[` 才是值：Rust 的 `: [&str; 10]` 与 TS 的 `: readonly string[]`
    /// 都发生在 `=` **之前**，按名字找第一个 `[` 会读到类型标注（那正是这条判据最容易踩空的坑，
    /// 本棒第一版就是这么红的）。
    /// 解析不出来（找不到声明、找不到收尾 `]`、一个字符串都没有）一律返回 `None` 由调用方 panic ——
    /// 静默返回空集合会把这条判据变成恒过的闸。
    fn parse_name_list(src: &str, decl: &str) -> Option<Vec<String>> {
        let at = src.find(decl)?;
        let eq = src[at..].find('=')? + at;
        let open = src[eq..].find('[')? + eq;
        let close = src[open..].find(']')? + open;
        let body = &src[open + 1..close];
        let mut out: Vec<String> = Vec::new();
        let bytes: Vec<char> = body.chars().collect();
        let mut i = 0usize;
        while i < bytes.len() {
            let q = bytes[i];
            if q != '\'' && q != '"' {
                i += 1;
                continue;
            }
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != q {
                j += 1;
            }
            if j >= bytes.len() {
                break; // 引号没闭合：交给下面的空集合判据大声失败
            }
            out.push(bytes[i + 1..j].iter().collect());
            i = j + 1;
        }
        if out.is_empty() {
            return None;
        }
        Some(out)
    }

    /* ---------------------------------------------------------------- *
     * M5-P1 T3b-ii（plan §5.6）—— 表上第一档 🟠 才验得到的两件事
     * ---------------------------------------------------------------- */

    /// 🟠 的两个方向合起来才是这条规则的完整意思，缺一个是半句话：
    /// ① 字节**进** `reclaimable_bytes` —— §16 只把 🔴 排除在合计之外，
    ///    `reclaimable_of()` = safe + caution + high。用户要能看见那块地值多少；
    /// ② 默认勾选**点不到**它 —— §3.5 的派生（`validate.rs::default_unselectable_rule_ids`）
    ///    是这条豁免的唯一事实源，一键全选按它筛。
    /// 只有①就是"一键全选替用户勾掉自己的下载目录"；只有②就是"那块地盘从预估里静默消失"
    /// （数字比盘上小，那是 M5-N 记过账的那一类）。
    #[test]
    fn a_high_rules_bytes_are_reclaimable_but_never_default_selected() {
        let t = tree_of_files(&[(r"C:\Users\Kano\Downloads\setup.exe", 900)], &[]);
        let r = evaluate_rules(&t, &builtin_rules(), &leaf_env(), &EvaluateOptions::default());
        let f = of(&r, "user-downloads-installers");
        assert_eq!(f.risk_level, Risk::High, "🟠 上了表却没进报告，界面那一侧就永远看不见它");
        assert_eq!((f.file_count, f.total_bytes), (1, 900), "实得 {:?}", f.sample_paths);
        // ① 这张树上唯一那 900 字节就是 🟠 的 —— 合计里必须有它
        assert_eq!(r.bytes_by_risk.high, 900, "🟠 那一格第一次有了非零值：{:?}", r.bytes_by_risk);
        assert_eq!(r.bytes_by_risk.forbidden, 0, "🔴 不该有进账（没有回收站的地盘）");
        assert_eq!(
            r.reclaimable_bytes,
            r.bytes_by_risk.safe + r.bytes_by_risk.caution + r.bytes_by_risk.high,
            "可回收合计的口径就是 safe+caution+high，🔴 才排除"
        );
        assert_eq!(r.reclaimable_bytes, 900, "🟠 的字节没进合计 = 那块地盘从预估里静默消失");
        // ② 同一批字节不许被一键全选顺手勾走
        let exempt = crate::validate::default_unselectable_rule_ids(&builtin_rules());
        assert!(exempt.contains("user-downloads-installers"), "§3.5 派生少了它：{exempt:?}");
        assert!(exempt.contains("huggingface-cache"), "§3.5 派生原有那条不许掉：{exempt:?}");
        let default_selected_bytes: u64 = r
            .findings
            .iter()
            .filter(|x| !exempt.contains(&x.rule_id))
            .map(|x| x.total_bytes)
            .sum();
        assert_eq!(default_selected_bytes, 0, "一键全选点上了那条 🟠 的 900 字节");
    }

    /// plan §5.6 的 `recursive: false` = **只碰 Downloads 顶层**。子目录是用户自己的组织方式
    /// （`Downloads\2023\` 那一类），不是"安装包残留"。
    /// 三个文件各钉一件事：顶层 `.exe` 收、顶层照片不收、子目录 `.exe` 不收。
    /// 最后还有一组**同一棵树换成递归**的对照 —— 没有它，"子目录没收到"可能只是因为
    /// 引擎根本走不到那里（夹具形状不对也能绿）。
    #[test]
    fn a_non_recursive_rule_claims_the_top_level_only() {
        let t = tree_of_files(
            &[
                (r"C:\Users\Kano\Downloads\thing.exe", 700),
                (r"C:\Users\Kano\Downloads\holiday.jpg", 3000),
                (r"C:\Users\Kano\Downloads\sub\nested.exe", 8000),
            ],
            &[],
        );
        let r = evaluate_rules(&t, &builtin_rules(), &leaf_env(), &EvaluateOptions::default());
        let f = of(&r, "user-downloads-installers");
        assert_eq!((f.file_count, f.total_bytes), (1, 700), "实得 {:?}", f.sample_paths);
        assert_eq!(f.matched_roots, vec![r"C:\Users\Kano\Downloads"]);
        let c = claimed(&r);
        assert!(
            c.iter().any(|p| normalize_key(p) == normalize_key(r"C:\Users\Kano\Downloads\thing.exe")),
            "顶层的 .exe 必须被收走，否则下面两条反例是空的：{c:?}"
        );
        for keep in [r"C:\Users\Kano\Downloads\sub\nested.exe", r"C:\Users\Kano\Downloads\holiday.jpg"] {
            assert!(
                !c.iter().any(|p| normalize_key(p) == normalize_key(keep)),
                "{keep} 被认领了 —— 前者越界进子目录（recursive 被改成 true），后者是扩展名判据松了：{c:?}"
            );
        }
        // 对照组：把同一条声明改成递归，同一棵树就必须吃到子目录
        let mut flipped = builtin_rules()
            .into_iter()
            .find(|x| x.id == "user-downloads-installers")
            .unwrap();
        flipped.scanner.recursive = true;
        let r2 = evaluate_rules(&t, &[flipped], &leaf_env(), &EvaluateOptions::default());
        assert_eq!(
            of(&r2, "user-downloads-installers").total_bytes,
            8700,
            "递归对照失效：子目录里那 8000 走不到，上面「没收到」那条就什么都没证明"
        );
    }

    /* ---------------------------------------------------------------- *
     * 回归轴 —— 「不带新字段的规则，产出与改动前逐字段等」
     * ---------------------------------------------------------------- */

    /// 报告的可比投影：**定序数组**而不是对象（`serde_json::Map` 默认按字典序排键，
    /// `JSON.stringify` 按插入序 —— 两侧直接比对象字符串会得到一条永远红的假差异）。
    /// 排除项在这里排序，是为了让"两次跑必须同序"这条判据不被插入序干扰；
    /// findings 保持表序（次序本身就是行为，`claimed` 先声明者计账）。
    fn project(report: &RuleReport) -> String {
        let mut ex: Vec<Vec<String>> = report
            .exclusions
            .iter()
            .map(|e| {
                vec![
                    e.rule_id.clone().unwrap_or_default(),
                    serde_json::to_value(e.reason).unwrap().as_str().unwrap().to_string(),
                    e.path.clone(),
                ]
            })
            .collect();
        ex.sort();
        let findings: Vec<serde_json::Value> = report
            .findings
            .iter()
            .map(|f| {
                let sp: Vec<Vec<String>> = f
                    .sample_paths
                    .iter()
                    .map(|p| vec![p.path.clone(), p.size.to_string()])
                    .collect();
                serde_json::json!([
                    f.rule_id,
                    f.file_count.to_string(),
                    f.total_bytes.to_string(),
                    f.matched_roots,
                    sp,
                    f.sample_truncated,
                    serde_json::to_value(f.risk_level).unwrap().as_str().unwrap().to_string(),
                    serde_json::to_value(f.category).unwrap().as_str().unwrap().to_string(),
                ])
            })
            .collect();
        let rejected: Vec<Vec<String>> = report
            .rejected_rules
            .iter()
            .map(|r| {
                let mut reasons: Vec<String> =
                    r.problems.iter().map(|p| p.reason.clone()).collect();
                reasons.sort();
                let mut one = vec![r.rule_id.clone()];
                one.append(&mut reasons);
                one
            })
            .collect();
        let terr: Vec<serde_json::Value> = report
            .territories
            .iter()
            .map(|t| {
                let present: Vec<Vec<String>> = t
                    .present
                    .iter()
                    .map(|p| vec![p.path.clone(), p.bytes.map(|b| b.to_string()).unwrap_or_else(|| "~".into())])
                    .collect();
                serde_json::json!([t.rule_id, t.detector_absent, present, t.not_scanned.to_string()])
            })
            .collect();
        serde_json::to_string(&serde_json::json!([
            findings,
            ex,
            rejected,
            terr,
            [
                report.bytes_by_risk.safe.to_string(),
                report.bytes_by_risk.caution.to_string(),
                report.bytes_by_risk.high.to_string(),
                report.bytes_by_risk.forbidden.to_string(),
            ],
            report.reclaimable_bytes.to_string(),
            report.safety_blocked,
        ]))
        .unwrap()
    }

    /// 三条不带新字段的规则 + 一条被声明层拒掉的 —— 覆盖 findings / 两种排除 / 底账 / 被拒四格。
    fn legacy_rules() -> Vec<Rule> {
        let literal = mk_rule("legacy-literal", Risk::Safe, &[r"%LOCALAPPDATA%\SomeApp"]);
        let wild = mk_rule("legacy-wild", Risk::Caution, &[r"%LOCALAPPDATA%\*\Cache"]);
        let mut nonrec = mk_rule("legacy-nonrec", Risk::Safe, &[r"%LOCALAPPDATA%\Hiview"]);
        nonrec.scanner.file_patterns = vec!["*.log".into()];
        nonrec.scanner.recursive = false;
        let mut detector = mk_rule("legacy-detector", Risk::Caution, &[r"%TEMP%\Nope"]);
        detector.requires_detector = Some("npm".into());
        let forbidden = mk_rule("legacy-forbidden", Risk::Safe, &[r"%WINDIR%\System32"]);
        vec![literal, wild, nonrec, detector, forbidden]
    }

    /// **回归轴**：一条新字段都不带的规则集，产出必须与改动前**逐字段**相同。
    /// 那个基线不是口头承诺 —— `NO_LEAF_GOLDEN` 是 leaf 遍历 / 围栏 / 事实闸**落地之前**
    /// 从同一份代码、同一棵树上录下来的投影串（登记在 plan §10），改动把它顶红就得改回来问一遍。
    #[test]
    fn no_leaf_rules_means_byte_identical_findings() {
        let t = leaf_tree();
        let r = evaluate_rules(&t, &legacy_rules(), &leaf_env(), &EvaluateOptions::default());
        let produced = project(&r);
        assert_eq!(produced, NO_LEAF_GOLDEN, "不带新字段的规则产出了新东西 —— 把实得值与期望逐字段比一遍再判");

        // 第二半：把三个新字段**显式写成空值**（`leafDirs: []` / `leafFiles: []` / 无围栏 / 无事实声明），
        // 与"根本没写"必须同一个投影 —— 读空表与读 None 不许分叉出第二套真相。
        let mut spelled = legacy_rules();
        for rule in &mut spelled {
            rule.scanner.leaf_dirs = Vec::new();
            rule.scanner.leaf_files = Vec::new();
            rule.scanner.scope_fence = None;
            rule.requires_absent_app_fact = None;
        }
        let t2 = leaf_tree();
        let r2 = evaluate_rules(&t2, &spelled, &leaf_env(), &EvaluateOptions::default());
        assert_eq!(project(&r2), NO_LEAF_GOLDEN, "显式空值写出了第三种行为");
    }

    /// 改动前录下的投影基线（见上那条用例的注释）。
    /// 录制时间与状态：leaf 遍历 / 围栏不枚举 / 机器事实闸**都还没实现**的那份代码，
    /// 同一棵 `leaf_tree()`、同一份 `leaf_env()`、同一组 `legacy_rules()` —— 逐字段等，
    /// 不是"看起来差不多"。把它顶红之前先想清楚：不带新字段的规则凭什么会改变产出。
    const NO_LEAF_GOLDEN: &str = r#"[[["legacy-literal","3","193",["C:\\Local\\SomeApp"],[["C:\\Local\\SomeApp\\Cache\\c1.bin","100"],["C:\\Local\\SomeApp\\Cache\\c2.dat","60"],["C:\\Local\\SomeApp\\LocalCache\\look.bin","33"]],false,"safe","temp"],["legacy-wild","3","435",["C:\\Local\\Junction\\Cache","C:\\Local\\SomeApp\\Cache","C:\\Local\\Twin\\Cache"],[["C:\\Local\\Junction\\Cache\\via-junction.bin","400"],["C:\\Local\\Twin\\Cache\\Cache\\nested.bin","5"],["C:\\Local\\Twin\\Cache\\inner.bin","30"]],false,"caution","temp"],["legacy-nonrec","2","1600",["C:\\Local\\Hiview"],[["C:\\Local\\Hiview\\HiviewPlatform.3.log","400"],["C:\\Local\\Hiview\\HiviewPlatform.log","1200"]],false,"safe","temp"],["legacy-detector","0","0",[],[],false,"caution","temp"]],[["legacy-detector","not-scanned","C:\\Temp\\Nope"],["legacy-forbidden","rule-rejected","%WINDIR%\\System32"],["legacy-wild","claimed-by-other-rule","C:\\Local\\SomeApp\\Cache\\c1.bin"],["legacy-wild","claimed-by-other-rule","C:\\Local\\SomeApp\\Cache\\c2.dat"],["legacy-wild","not-scanned","C:\\Local\\Crx\\Cache"],["legacy-wild","not-scanned","C:\\Local\\Deep\\Cache"],["legacy-wild","not-scanned","C:\\Local\\Ghost\\Cache"],["legacy-wild","not-scanned","C:\\Local\\Hiview\\Cache"],["legacy-wild","not-scanned","C:\\Local\\Packages\\Cache"],["legacy-wild","not-scanned","C:\\Local\\Programs\\Cache"],["legacy-wild","not-scanned","C:\\Local\\Repo\\Cache"],["legacy-wild","not-scanned","C:\\Local\\foo-updater\\Cache"],["legacy-wild","not-scanned","C:\\Local\\git\\Cache"],["legacy-wild","not-scanned","C:\\Local\\npm-cache\\Cache"]],[["legacy-forbidden","forbidden-root"]],[["legacy-detector",false,[],"1"]],["1793","435","0","0"],"2228",false]"#;
}

