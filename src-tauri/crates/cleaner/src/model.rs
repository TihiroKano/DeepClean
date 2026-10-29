//! §17 清理预览的**数据形状**（Rust 侧）。与 `shared/types.ts` 的 `Preview*` 那一族逐字同名。
//!
//! 铁律与 `types.rs` 同源：**这个模块里没有任何行为** —— 全是可序列化的数据。
//! 一条 `PreviewItem` 不可能自带"删哪些路径"的能力，因为执行入口吃的根本不是它
//! （§18 只认确认回执里的 digest，具体清单由主进程另取）。

use deepclean_rules::engine::TerritoryFact;
use deepclean_rules::types::{CleanStrategy, Risk, RuleCategory};
use serde::{Deserialize, Serialize};

/// 拒绝原因。成员名与 TS `PreviewRefusalReason` 逐字相同（kebab-case 序列化）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewRefusalReason {
    /// 勾选的项目本身是 🔴（`risk_level = forbidden`）
    ForbiddenRisk,
    /// 勾选的具体路径落在 §16 禁止根之内（复用引擎的 `is_forbidden_path`，不另立定义）
    ForbiddenRoot,
    /// 落在「只上报不可删」根之内：占用如实报告，但任何规则都勾不动
    ReportOnlyRoot,
    /// 报告的 🔴 保护没落地（`safety_blocked` / 禁止根为空）→ 整份预览不出结论
    SafetyBlocked,
    /// 勾了报告里没有的 ruleId
    UnknownRule,
    /// 该规则在 §15 声明层就被 `validate_rule_set` 拒了
    ItemRejected,
    /// 报告只枚举了采样路径，这条不在其中 → 无法定价，不猜也不重新走盘
    PathNotEnumerated,
    /// 重复勾选：同一项/同一路径第二次出现，不重复计价
    DuplicateSelection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewRefusalScope {
    Item,
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRefusal {
    pub scope: PreviewRefusalScope,
    pub rule_id: Option<String>,
    pub path: Option<String>,
    pub reason: PreviewRefusalReason,
    pub detail: String,
    /// 被挡在预估之外的字节（项级 = 该项大小，路径级 = 该路径大小；重复勾选类记 0，因为已经在数过的那次里了）
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricedPath {
    pub path: String,
    pub size: u64,
}

/// 勾选粒度：整项 / 只有已枚举的路径。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewScope {
    Rule,
    Paths,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewItem {
    pub rule_id: String,
    pub name: String,
    /// 这一项**自己的规则文案**（M5-P1 T5a，spec §5「删了会失去什么」那句话）。
    ///
    /// 来源是**规则表那一份**（`builtin_rules()` / TS 的 `BUILTIN_RULES`，按 `rule_id` 取），
    /// 预览层不写、不改、不翻译这一句话 —— 界面拿到的就是被哈希过的那一份。
    ///
    /// ⚠️ 它**进 digest 的覆盖字段**（`digest.rs`，两份口径都进）：不进的话服务端改一次文案、
    /// 旧回执照样能执行 —— 那正是 T4 给档位关掉的后门，不许从文案这一侧重新打开。
    ///
    /// 表外的 `rule_id`（§20 的重复文件伪项 `dup:*`、夹具里的自定义规则集）取不到规则，
    /// 这一格就是**空串**。空是事实，不是待办：不许在显示层编一句"通用说明"补上去
    /// （那等于让用户读到一句没有出处的话，而它又被哈希过）。
    pub description: String,
    pub category: RuleCategory,
    pub risk_level: Risk,
    pub clean_strategy: CleanStrategy,
    pub recoverable: bool,
    /// 用户勾了没有（§17 第三步）
    pub selected: bool,
    /// 是否计入预估。**🔴 永不为 true。**
    pub included: bool,
    /// 计入预估的字节
    pub bytes: u64,
    pub files: u64,
    pub scope: PreviewScope,
    /// `scope = Paths` 时被选中且完成定价的路径（升序）
    pub paths: Vec<PricedPath>,
    /// 未勾选或未计入时，这一项本来的全量口径 —— 两者之差就是「没算进来的部分」
    pub finding_bytes: u64,
    pub finding_files: u64,
    /// 报告的采样清单被截断过：路径级勾选只能覆盖已枚举部分，差额见 `finding_bytes`
    pub sample_truncated: bool,
    /// 这一项覆盖的目录（来自报告 `matched_roots`）
    pub matched_roots: Vec<String>,
    /// 这一项自己被拒的原因；`None` = 没被拒
    pub refusal: Option<PreviewRefusal>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRiskCell {
    pub items: u64,
    pub files: u64,
    pub bytes: u64,
}

/// 四档各自的小计（只统计**已计入**的项，所以 `forbidden` 恒为 0）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskBreakdown {
    pub safe: PreviewRiskCell,
    pub caution: PreviewRiskCell,
    pub high: PreviewRiskCell,
    pub forbidden: PreviewRiskCell,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewModel {
    /// 报告里的**全部**可清理项目（含未勾选的），顺序与报告 findings 一致
    pub items: Vec<PreviewItem>,
    /// 所有被拒的勾选 + 原因，一条都不静默吞掉
    pub refusals: Vec<PreviewRefusal>,
    pub total_bytes: u64,
    pub total_files: u64,
    pub risk_breakdown: RiskBreakdown,
    /// 被拒的字节合计：用户勾了但没进预估的量
    pub refused_bytes: u64,
    /// `true` = 🔴 保护不在线（`safety_blocked` 或禁止根为空）→ 整份预估为 0，不许确认
    pub blocked: bool,
    /// 与报告对账用：报告自己的 🟢🟡🟠 合计
    pub report_reclaimable_bytes: u64,
    pub report_forbidden_bytes: u64,
    /// 本次生效的禁止根（从报告透传）
    pub forbidden_roots: Vec<String>,
    pub report_only_roots: Vec<String>,
    pub report_exclusion_count: usize,
    /// §3.6 的地盘底账，**原样搬运**（这一层一旦重新判定就有了第二份事实源）
    pub territories: Vec<TerritoryFact>,
    /// §3.5：这些规则不进「一键全选」（派生只在 `default_unselectable_rule_ids` 一处）
    pub default_unselectable_rule_ids: Vec<String>,
    /// 诚实说明：🟠 提示、不可再生提示、路径级勾选的覆盖上限等
    pub notes: Vec<String>,
    /// 这份预估是什么时候算的（由调用方注入，本模块不读时钟）
    pub generated_at_ms: i64,
    /// 模型指纹：**档位无关**的那一份（`preview_digest(model, None)`）。
    /// 确认必须绑定在这一份预估上（改过一个数字就对不上）；
    /// 回执用的**执行凭据**是另一份，它把用户按下的档位也盖进去了 —— 见下面 `PreviewConfirmation::digest`。
    pub digest: String,
}

/// §17 的「用户选择」：按项勾选，或按报告里已枚举的路径逐条勾选。
///
/// ⚠️ `items` **故意是 `Value` 而不是强类型**：TS 那边对「`items` 不是数组」「条目不是对象」
/// 「`paths` 不是字符串数组」这三种畸形输入各有专属的拒绝理由，用强类型接住它们会把这些分支
/// 变成一次反序列化失败 —— 拒绝理由就没了。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSelection {
    pub items: serde_json::Value,
}

/// 构建选项。时钟靠注入（本模块不读 `Date.now()` / `SystemTime`，结果可复现）。
#[derive(Debug, Clone, Default)]
pub struct PreviewBuildOptions {
    pub now_ms: i64,
    pub default_unselectable_rule_ids: Vec<String>,
}

/* ------------------------------------------------------------------ *
 * §17 倒数第二步：确认（到此为止，不产动作）
 * ------------------------------------------------------------------ */

/// 确认被拦下的原因。成员名与 TS `PreviewConfirmBlocker` 逐字相同。
///
/// **声明次序 = 判定次序**（M5-P1 T4）：`RiskNotAcknowledged` 排在两道复核（指纹、内容）之后、
/// `SafetyBlocked` 之前。次序本身是行为 —— 界面按 blocker 列表逐条措辞，
/// 由 `confirm.rs::the_blocker_order_is_fixed` 与 TS 那条同名用例钉着。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreviewConfirmBlocker {
    NotAcknowledged,
    NothingToConfirm,
    SafetyBlocked,
    ForbiddenIncluded,
    /// 已计入预估的项里有**高于**用户按下档位的档 → 出不了回执（M5-P1 T4，spec §5）。
    RiskNotAcknowledged,
    StaleModel,
}

/// 回执的判别式。做成只有一个变体的枚举，**结构上不可能写出别的值** ——
/// 用 `String` 的话谁都能往里塞一个字面量，而下游按这个值认凭据。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PreviewConfirmationKind {
    #[serde(rename = "dc-preview-confirmation")]
    DcPreviewConfirmation,
}

/// §17 第五步「确认」的回执：**纯数据，且不含路径清单**。
///
/// §18 落地后它是**执行凭据**：`execute` 必须带回这个 `digest` 才能领到工作单，
/// 而工作单（具体路径）只在主进程内部生成与保存，从不写进这份回执。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewConfirmation {
    pub kind: PreviewConfirmationKind,
    pub acknowledged: bool,
    /// M5-P1 T4：用户**按下的档位**。「我确认了」与「我看见 🟠 了」从此是两句话。
    /// 它同时进 `digest` 的覆盖字段（`digest.rs`）—— 不进的话同一份模型换个档出同一个凭据，
    /// 那张旧回执就能冒充新档的回执。
    pub acknowledged_risk: Risk,
    pub confirmed: bool,
    pub blockers: Vec<PreviewConfirmBlocker>,
    /// **只有 `rule_id`** —— 这就是「回执不含路径清单」那条契约的落点。
    pub rule_ids: Vec<String>,
    pub items: u64,
    pub files: u64,
    pub total_bytes: u64,
    pub refusal_count: usize,
    /// **执行凭据**：`preview_digest(model, Some(acknowledged_risk))` ——
    /// 覆盖模型决策字段**加上这一项确认按下的档位**（M5-P1 T4）。
    /// 所以它**不等于** `PreviewModel.digest`（那一份是档位无关的模型指纹，`preview.rs` 写入、
    /// 确认时用来复核 stale）；渲染端要复核的是「我此刻看见的这份预估 + 我按下的档」这两件事的指纹。
    pub digest: String,
    /// 本回执**绑定的那一份模型的指纹**（= `PreviewModel.digest`，档位无关那一份）。
    ///
    /// 渲染端**没法**自己重算带档位的 `digest`（那要走 TS `core/rules/preview.ts`，
    /// 而 `tsconfig.web.json` 不允许 import `core/rules/**`），所以界面上的归属判据
    /// 「这张回执是不是属于我此刻看见的这份预估」只能靠服务端在这里陈述：`model_digest ==
    /// preview.digest` ⇔ 回执属于当前模型。缺了这一格，界面只剩「带档位 digest 比不带档位指纹」
    /// 那条永不成立的等式，「开始清理」永远灰。
    pub model_digest: String,
    pub confirmed_at_ms: i64,
    pub note: String,
}
