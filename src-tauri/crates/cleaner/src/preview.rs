//! §17 清理预览 —— 「点击清理 ↓ 直接删除」的反面。**只产数据，不产动作。**
//!
//! 逐段照抄 TS `core/rules/preview.ts:46-355` 的**判据顺序**（顺序本身是行为：同一条勾选
//! 先撞上哪条拒绝理由，决定界面上那句话）。三条硬约束：
//!
//! 1. **🔴 不可能被选中**：`forbidden-risk` 项级拒绝 + 逐路径再判一次 `is_forbidden_path`
//!    （复用引擎那一把，不另立第三套「禁止」语义）。被拒的勾选**全部点名留痕**。
//! 2. **预估只来自已经扫好的树**：入参是 `RuleReport`，本模块没有 `std::fs` ——
//!    定价不了的记 `path-not-enumerated`，绝不靠再走一次磁盘补齐（§28 原则一）。
//! 3. **时钟靠注入**（`now_ms`），本模块不读 `SystemTime`，结果可复现。
//!
//! 本文件里**没有任何删除能力**：没有 `remove_*`、没有回收站 API、也没有留给执行方的桩
//! （桩会招调用者）。§18 的执行入口在 M3-C，且它只认确认回执里的 digest。

use crate::digest::{cmp_utf16, enum_name, preview_digest};
use crate::model::*;
use deepclean_rules::engine::{normalize_key, RuleFinding, RuleReport};
use deepclean_rules::env::is_forbidden_path;
use deepclean_rules::types::Risk;
use std::collections::{BTreeMap, BTreeSet};

const BLOCKED_DETAIL_SAFETY: &str =
    "报告处于 safetyBlocked 状态：§16 🔴 禁止路径没能落地（环境变量缺失）→ 预览不给出任何「可清理」结论";
const BLOCKED_DETAIL_EMPTY: &str =
    "报告的禁止根清单为空 = 🔴 保护不在线 → 预览不给出任何「可清理」结论（宁可说 0，也不猜能清）";

fn path_str(v: &serde_json::Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_string)
}

#[allow(clippy::too_many_arguments)]
fn refuse(
    refusals: &mut Vec<PreviewRefusal>,
    scope: PreviewRefusalScope,
    rule_id: Option<&str>,
    path: Option<&str>,
    reason: PreviewRefusalReason,
    detail: String,
    bytes: u64,
) -> PreviewRefusal {
    let r = PreviewRefusal {
        scope,
        rule_id: rule_id.map(str::to_string),
        path: path.map(str::to_string),
        reason,
        detail,
        bytes,
    };
    refusals.push(r.clone());
    r
}

/// 报告 + 用户选择 → 预览模型。**纯计算**。
///
/// M5-P1 T5a：每一项都带上**它自己那条规则的文案**（`PreviewItem::description`）。
/// 这句话是「删了会失去什么」的唯一出处（spec §5），所以它有两个硬性后果：
/// 1. **只在预览层查表，不在预览层写文案** —— 查的是 `deepclean_rules::builtin_rules()`，
///    与 TS 侧 `BUILTIN_RULES` 同一张表。表外的 id（`dup:*` 伪项、夹具自定义规则集）留空串。
/// 2. **它进 digest 的覆盖字段**（`digest.rs`），两份口径都进 —— 见那里那段注释。
pub fn build_preview_model(
    report: &RuleReport,
    selection: &PreviewSelection,
    opts: &PreviewBuildOptions,
) -> PreviewModel {
    // 规则文案表：按 rule_id 取。整份预览构建取一次（21 条，成本是一次表分配，不是每行一次）。
    let rule_table = deepclean_rules::builtin_rules();
    let mut rule_descriptions: BTreeMap<&str, &str> = BTreeMap::new();
    for r in &rule_table {
        // 同一 id 只认第一条 —— 与上面 `by_rule` 对 findings 的口径一致，两侧同解。
        rule_descriptions.entry(r.id.as_str()).or_insert(r.description.as_str());
    }

    let forbidden_roots = report.forbidden_roots.clone();
    // 「只上报不可删」根（回收站那一类）**不参与** `blocked` 判据：这张表为空只意味着这份报告
    // 没带第二类防护，而真正兜住删除的是执行器（它永远按 registry 默认名单再判一次）。
    let report_only_roots = report.report_only_roots.clone();
    let blocked = report.safety_blocked || forbidden_roots.is_empty();
    let blocked_detail = if report.safety_blocked { BLOCKED_DETAIL_SAFETY } else { BLOCKED_DETAIL_EMPTY };

    // 同一 ruleId 只认第一条（TS 的 `if (!byRule.has(...))`）
    let mut by_rule: BTreeMap<&str, &RuleFinding> = BTreeMap::new();
    for f in &report.findings {
        by_rule.entry(f.rule_id.as_str()).or_insert(f);
    }

    let mut refusals: Vec<PreviewRefusal> = Vec::new();
    let mut item_refusal: BTreeMap<String, PreviewRefusal> = BTreeMap::new();
    let mut selected_rules: BTreeSet<String> = BTreeSet::new();
    let mut rule_scope: BTreeSet<String> = BTreeSet::new();
    // 逐路径勾选的候选，保留用户勾选顺序（拒绝记录的顺序因此也可复现）
    let mut path_entries: Vec<(String, Vec<serde_json::Value>)> = Vec::new();

    let entries = selection.items.as_array().cloned().unwrap_or_default();
    if !selection.items.is_array() {
        refuse(
            &mut refusals,
            PreviewRefusalScope::Item,
            None,
            None,
            PreviewRefusalReason::UnknownRule,
            "选择结构非法：PreviewSelection.items 必须是数组 → 整份选择被忽略".into(),
            0,
        );
    }

    for raw in &entries {
        let rule_id = raw
            .get("ruleId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let Some(rule_id) = rule_id else {
            refuse(
                &mut refusals,
                PreviewRefusalScope::Item,
                None,
                None,
                PreviewRefusalReason::UnknownRule,
                "勾选项缺少合法的 ruleId（渲染进程只能按报告里给出的项来勾选）".into(),
                0,
            );
            continue;
        };
        let f = by_rule.get(rule_id.as_str()).copied();
        selected_rules.insert(rule_id.clone());

        if blocked {
            let first = !item_refusal.contains_key(&rule_id);
            let name = f.map(|x| x.name.clone()).unwrap_or_else(|| rule_id.clone());
            let bytes = f.map(|x| x.total_bytes).unwrap_or(0);
            let r = refuse(
                &mut refusals,
                PreviewRefusalScope::Item,
                Some(&rule_id),
                None,
                PreviewRefusalReason::SafetyBlocked,
                format!("{blocked_detail}；项目「{name}」的 {bytes} 字节没有算进预估"),
                if first { bytes } else { 0 },
            );
            if first {
                item_refusal.insert(rule_id.clone(), r);
            }
            continue;
        }

        let Some(f) = f else {
            if let Some(rej) = report.rejected_rules.iter().find(|x| x.rule_id == rule_id) {
                // 与 TS 同（`preview.ts:121-127`）：点名**规则名**与被拒**原因**，不是内部 id。
                // 唯一差的一格是函数名各侧写真跑的那个（TS `validateRuleSet` / Rust
                // `validate_rule_set`）—— 与"detail 是散文、两侧各写一遍"同一条 posture。
                // `problems` 为空时那句"未记录具体原因"照抄 —— 它是有意义的第三种情况。
                let why = if rej.problems.is_empty() {
                    "未记录具体原因".to_string()
                } else {
                    rej.problems
                        .iter()
                        .map(|p| p.reason.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                };
                refuse(
                    &mut refusals,
                    PreviewRefusalScope::Item,
                    Some(&rule_id),
                    None,
                    PreviewRefusalReason::ItemRejected,
                    format!(
                        "规则「{}」在 §15 声明层就被 validate_rule_set 拒了（{why}），报告里没有它 → 不计入预估",
                        rej.name
                    ),
                    0,
                );
            } else {
                refuse(
                    &mut refusals,
                    PreviewRefusalScope::Item,
                    Some(&rule_id),
                    None,
                    PreviewRefusalReason::UnknownRule,
                    format!("报告里没有 id 为「{rule_id}」的可清理项目（勾选必须点名到报告里的项）→ 不计入预估"),
                    0,
                );
            }
            continue;
        };

        // §16：🔴 项目照常识别容量，但禁止通过普通清理按钮直接删除 → 勾选即拒绝
        if f.risk_level == Risk::Forbidden {
            let first = !item_refusal.contains_key(&rule_id);
            let paths: Vec<serde_json::Value> =
                raw.get("paths").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let r = refuse(
                &mut refusals,
                PreviewRefusalScope::Item,
                Some(&rule_id),
                None,
                PreviewRefusalReason::ForbiddenRisk,
                format!(
                    "「{}」是 §16 🔴 禁止项目：{} 字节 / {} 个文件照常识别，但不进预估、不可通过普通清理勾选（策略 {}）",
                    f.name, f.total_bytes, f.file_count, enum_name(f.clean_strategy)
                ),
                if first { f.total_bytes } else { 0 },
            );
            if first {
                item_refusal.insert(rule_id.clone(), r);
            }
            for p in &paths {
                refuse(
                    &mut refusals,
                    PreviewRefusalScope::Path,
                    Some(&rule_id),
                    path_str(p).as_deref(),
                    PreviewRefusalReason::ForbiddenRisk,
                    "整项已被拒为 🔴 禁止项目，这条路径同样不计入预估".into(),
                    0,
                );
            }
            continue;
        }

        match raw.get("paths") {
            None | Some(serde_json::Value::Null) => {
                if rule_scope.contains(&rule_id) {
                    refuse(
                        &mut refusals,
                        PreviewRefusalScope::Item,
                        Some(&rule_id),
                        None,
                        PreviewRefusalReason::DuplicateSelection,
                        format!("「{}」已按整项勾选，重复勾选不重复计价（已计入 {} 字节）", f.name, f.total_bytes),
                        0,
                    );
                } else {
                    rule_scope.insert(rule_id.clone());
                }
            }
            Some(serde_json::Value::Array(a)) => {
                if !a.is_empty() {
                    path_entries.push((rule_id.clone(), a.clone()));
                }
            }
            Some(_) => {
                refuse(
                    &mut refusals,
                    PreviewRefusalScope::Item,
                    Some(&rule_id),
                    None,
                    PreviewRefusalReason::PathNotEnumerated,
                    format!("「{}」的 paths 字段不是数组 → 这次勾选无法定价（不猜、不重新走盘）", f.name),
                    0,
                );
            }
        }
    }

    /* ---------------- 逐项组装（顺序 = 报告 findings 顺序，可复现） ---------------- */

    // 全局去重：同一路径在整个预览里只计一次钱。
    // ~~引擎的 claimed 表已保证，这只是第二道保险~~ —— 那句是错的：claimed 表只管**登记表规则**
    // 之间不重叠，§20 的伪项与 §12 的逐路径勾选都走在它外面。所以这一张表是**唯一**那道闸，
    // 整项与逐路径两边都必须往里记账（整项那半边 2026-10-13 才接上，见下面的 `if whole`）。
    let mut priced_keys: BTreeSet<String> = BTreeSet::new();
    let mut items: Vec<PreviewItem> = Vec::new();
    let mut risk_breakdown = RiskBreakdown::default();
    let mut total_bytes = 0u64;
    let mut total_files = 0u64;

    for f in &report.findings {
        let selected = selected_rules.contains(&f.rule_id);
        let entry: Vec<&Vec<serde_json::Value>> = path_entries
            .iter()
            .filter(|(id, _)| id == &f.rule_id)
            .map(|(_, p)| p)
            .collect();
        let whole = !blocked && rule_scope.contains(&f.rule_id);
        let scope = if whole { PreviewScope::Rule } else { PreviewScope::Paths };
        let mut bytes = 0u64;
        let mut files = 0u64;
        let mut priced: Vec<PricedPath> = Vec::new();

        if whole {
            bytes = f.total_bytes;
            files = f.file_count;
            /* 整项勾选覆盖它认领的**每一条**路径 ⇒ 这些路径从此在本次预览里有了主人。
             * 不把它们交进全局去重表，另一条通道（§12 地图上「加入清理列表」那条逐路径勾选）
             * 再表达同一条路径时就会各计一次钱 —— 文件数与字节数同时虚高，而盘上只会少一次。
             * 上面那句「引擎的 claimed 表已保证」只对**登记表规则**成立：§20 的伪项不参与
             * claimed 表，它的一份待删路径完全可以同时是某条规则地盘里的文件。
             * 真机量实（`scripts/m5n-tile-dup-e2e.ps1`，2026-10-13）：同一个 5 MiB 文件
             * 在预览里计成 10.0 MB / 2 个文件，且一条拒绝都不留。
             *
             * 没有全量清单时**不假装**去重：认不全就没有对账的输入，宁可照旧发价，
             * 也不许拿采样那 50 条算出一个"看着像已去重"的更小数字（少计与多计同样是撒谎，
             * 而这一格在生产里拿不到 —— 壳层对全部内置规则都开着 `collect_all_paths_for`）。 */
            if let Some(all) = f.all_paths.as_ref() {
                for sp in all {
                    let key = normalize_key(&sp.path);
                    if priced_keys.contains(&key) {
                        bytes = bytes.saturating_sub(sp.size);
                        files = files.saturating_sub(1);
                        refuse(
                            &mut refusals,
                            PreviewRefusalScope::Path,
                            Some(&f.rule_id),
                            Some(&sp.path),
                            PreviewRefusalReason::DuplicateSelection,
                            "该路径已在本次勾选里计过一次 → 整项勾选不再为它重复计价".into(),
                            0,
                        );
                    } else {
                        priced_keys.insert(key);
                    }
                }
            }
            // 整项已经覆盖全部路径，逐路径勾选只是重复表达同一个意图：不重复计价，但要留痕
            for ps in &entry {
                for p in ps.iter() {
                    refuse(
                        &mut refusals,
                        PreviewRefusalScope::Path,
                        Some(&f.rule_id),
                        path_str(p).as_deref(),
                        PreviewRefusalReason::DuplicateSelection,
                        format!("「{}」已按整项勾选（{} 字节），逐路径勾选不再重复计价", f.name, f.total_bytes),
                        0,
                    );
                }
            }
        } else if !blocked {
            // 定价用的清单：引擎挂了**全量认领清单**（all_paths）时用它，否则退回采样。
            // 两个来源都是规则引擎自己认领过的文件 —— 所以"客户端报了个路径"绝不等于"它就能被定价"。
            let mut sample: BTreeMap<String, (String, u64)> = BTreeMap::new();
            for sp in f.all_paths.as_ref().unwrap_or(&f.sample_paths) {
                sample.insert(normalize_key(&sp.path), (sp.path.clone(), sp.size));
            }
            for ps in &entry {
                for p in ps.iter() {
                    let Some(p) = path_str(p) else {
                        refuse(
                            &mut refusals,
                            PreviewRefusalScope::Path,
                            Some(&f.rule_id),
                            None,
                            PreviewRefusalReason::PathNotEnumerated,
                            "路径必须是绝对路径字符串 → 这条勾选无法定价".into(),
                            0,
                        );
                        continue;
                    };
                    let key = normalize_key(&p);
                    if priced_keys.contains(&key) {
                        refuse(
                            &mut refusals,
                            PreviewRefusalScope::Path,
                            Some(&f.rule_id),
                            Some(&p),
                            PreviewRefusalReason::DuplicateSelection,
                            "该路径已在本次勾选里计过一次，不重复计价".into(),
                            0,
                        );
                        continue;
                    }
                    priced_keys.insert(key.clone());
                    // 枚举层的第二道闸：报告里挂着禁止路径（畸形数据）也照样拒掉，用的还是引擎那一把判据
                    if let Some(hit) = is_forbidden_path(&p, &forbidden_roots) {
                        refuse(
                            &mut refusals,
                            PreviewRefusalScope::Path,
                            Some(&f.rule_id),
                            Some(&p),
                            PreviewRefusalReason::ForbiddenRoot,
                            format!("命中 §16 🔴 禁止路径 {hit} → 即使它挂在 🟢 项目名下也不给定价、不计入预估"),
                            sample.get(&key).map(|x| x.1).unwrap_or(0),
                        );
                        continue;
                    }
                    if let Some(ro) = is_forbidden_path(&p, &report_only_roots) {
                        refuse(
                            &mut refusals,
                            PreviewRefusalScope::Path,
                            Some(&f.rule_id),
                            Some(&p),
                            PreviewRefusalReason::ReportOnlyRoot,
                            format!("落在只上报根 {ro} 之内 → 大小照常报告，但它不属于任何可清理项，勾了也不计入预估"),
                            sample.get(&key).map(|x| x.1).unwrap_or(0),
                        );
                        continue;
                    }
                    let Some(sp) = sample.get(&key) else {
                        refuse(
                            &mut refusals,
                            PreviewRefusalScope::Path,
                            Some(&f.rule_id),
                            Some(&p),
                            PreviewRefusalReason::PathNotEnumerated,
                            format!(
                                "报告只枚举了本项的采样路径（本项共 {} 个文件{}）→ 这条给不出大小，不猜也不重新走盘（§28 原则一）",
                                f.file_count,
                                if f.sample_truncated { "，采样已截断" } else { "" }
                            ),
                            0,
                        );
                        continue;
                    };
                    priced.push(PricedPath { path: sp.0.clone(), size: sp.1 });
                    bytes += sp.1;
                    files += 1;
                }
            }
            priced.sort_by(|a, b| cmp_utf16(&a.path.to_lowercase(), &b.path.to_lowercase()));
        }

        let included = selected && !blocked && f.risk_level != Risk::Forbidden && (whole || files > 0);
        let refusal = item_refusal.get(&f.rule_id).cloned();

        if included {
            let cell = match f.risk_level {
                Risk::Safe => &mut risk_breakdown.safe,
                Risk::Caution => &mut risk_breakdown.caution,
                Risk::High => &mut risk_breakdown.high,
                Risk::Forbidden => &mut risk_breakdown.forbidden,
            };
            cell.items += 1;
            cell.files += files;
            cell.bytes += bytes;
            total_bytes += bytes;
            total_files += files;
        }

        items.push(PreviewItem {
            rule_id: f.rule_id.clone(),
            name: f.name.clone(),
            // 查表，不写文案：表里没有这个 id ⇒ 空串（见 `model.rs` 那个字段的注释）。
            description: rule_descriptions.get(f.rule_id.as_str()).copied().unwrap_or("").to_string(),
            category: f.category,
            risk_level: f.risk_level,
            clean_strategy: f.clean_strategy,
            recoverable: f.recoverable,
            selected,
            included,
            bytes: if included { bytes } else { 0 },
            files: if included { files } else { 0 },
            scope,
            paths: if included && scope == PreviewScope::Paths { priced } else { Vec::new() },
            finding_bytes: f.total_bytes,
            finding_files: f.file_count,
            sample_truncated: f.sample_truncated,
            matched_roots: f.matched_roots.clone(),
            refusal,
        });
    }

    let mut notes: Vec<String> = Vec::new();
    if blocked {
        notes.push(blocked_detail.to_string());
    }
    if risk_breakdown.high.items > 0 {
        notes.push("§16 🟠 高风险项目：清理后可能导致软件重新下载数据或重新生成缓存，必须向用户明确提示".into());
    }
    if items.iter().any(|i| i.included && !i.recoverable) {
        notes.push("含不可再生项目（recoverable=false）：删掉不会像缓存那样自动长回来，与缓存类不同（§15）".into());
    }
    if items.iter().any(|i| i.included && i.scope == PreviewScope::Paths) {
        let has_all = report
            .findings
            .iter()
            .any(|f| f.all_paths.is_some() && selected_rules.contains(&f.rule_id));
        notes.push(if has_all {
            "路径级勾选按该规则认领的「全部」文件定价（引擎已把全量清单交给预览），不在其地盘里的路径会被点名拒绝。".to_string()
        } else {
            "路径级勾选只能对报告已枚举的路径定价（本项未挂全量清单，「已枚举」上限来自报告的采样条数）；其余部分见各行的 findingBytes 与 path-not-enumerated 记录".to_string()
        });
    }
    if items.iter().any(|i| i.included && i.scope == PreviewScope::Rule && i.sample_truncated) {
        notes.push("整项勾选按报告的全量口径计价（totalBytes），与采样清单是否截断无关".into());
    }

    let refused_bytes = refusals.iter().map(|r| r.bytes).sum();
    let mut model = PreviewModel {
        items,
        refusals,
        total_bytes,
        total_files,
        risk_breakdown,
        refused_bytes,
        blocked,
        report_reclaimable_bytes: report.reclaimable_bytes,
        report_forbidden_bytes: report.bytes_by_risk.forbidden,
        forbidden_roots,
        report_only_roots,
        report_exclusion_count: report.exclusions.len(),
        territories: report.territories.clone(),
        default_unselectable_rule_ids: opts.default_unselectable_rule_ids.clone(),
        notes,
        generated_at_ms: opts.now_ms,
        digest: String::new(),
    };
    // 模型指纹 = **档位无关**那一份（`None`）：这一刻还没有任何人确认过，
    // 确认时复核 `stale-model` 用的就是它；回执凭据另算一份把档位盖进去（`confirm.rs`）。
    model.digest = preview_digest(&model, None);
    model
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::PreviewSelection;
    use deepclean_rules::engine::{BytesByRisk, PathHit, RejectedProblem, RejectedRule, RuleFinding, RuleReport};
    use deepclean_rules::types::{CleanStrategy, RuleCategory};
    use serde_json::json;

    const TEMP: &str = r"C:\Temp";
    const BIN: &str = r"C:\$Recycle.Bin";

    fn finding(id: &str, risk: Risk, paths: &[(&str, u64)]) -> RuleFinding {
        let sample: Vec<PathHit> = paths.iter().map(|(p, s)| PathHit { path: (*p).into(), size: *s }).collect();
        let total: u64 = paths.iter().map(|(_, s)| s).sum();
        RuleFinding {
            rule_id: id.into(),
            name: format!("{id}-名"),
            category: RuleCategory::Temp,
            risk_level: risk,
            clean_strategy: CleanStrategy::DeleteAll,
            recoverable: true,
            matched_roots: vec![TEMP.into()],
            sample_paths: sample,
            sample_truncated: false,
            file_count: paths.len() as u64,
            total_bytes: total,
            all_paths: None,
        }
    }

    /// 挂上**全量认领清单**。生产里这张表一直在：壳层对全部 15 条内置规则开着
    /// `collect_all_paths_for`（`src-tauri/src/service.rs` 的 `rule_report`），§20 的伪项
    /// 更是自带（`crates/dupes/src/findings.rs` 的 `all_paths: Some(paths)`）。
    /// 整项勾选要跟逐路径勾选对账同一条路径，除了这张表没有第二个来源 —— 不许重新走盘去补。
    fn with_all(mut f: RuleFinding) -> RuleFinding {
        f.all_paths = Some(f.sample_paths.clone());
        f
    }

    fn report(findings: Vec<RuleFinding>) -> RuleReport {
        let mut bytes_by_risk = BytesByRisk::default();
        for f in &findings {
            deepclean_rules::engine::add_bytes_by_risk(&mut bytes_by_risk, f.risk_level, f.total_bytes);
        }
        RuleReport {
            findings,
            exclusions: Vec::new(),
            rejected_rules: Vec::new(),
            forbidden_roots: vec![r"C:\Windows\System32".into(), r"C:\Windows\WinSxS".into()],
            report_only_roots: vec![BIN.into()],
            territories: Vec::new(),
            bytes_by_risk,
            reclaimable_bytes: deepclean_rules::engine::reclaimable_of(&bytes_by_risk),
            safety_blocked: false,
            claimed_paths: None,
        }
    }

    fn sel(items: serde_json::Value) -> PreviewSelection {
        PreviewSelection { items }
    }

    fn opts() -> PreviewBuildOptions {
        PreviewBuildOptions { now_ms: 1_700_000_000_000, default_unselectable_rule_ids: vec!["hf".into()] }
    }

    fn build(r: &RuleReport, items: serde_json::Value) -> PreviewModel {
        build_preview_model(r, &sel(items), &opts())
    }

    fn reasons(m: &PreviewModel) -> Vec<PreviewRefusalReason> {
        m.refusals.iter().map(|r| r.reason).collect()
    }

    /* ① 🔴 项目：勾选即拒绝，绝不计入 */

    #[test]
    fn a_forbidden_item_is_refused_and_never_priced() {
        let r = report(vec![finding("bin", Risk::Forbidden, &[(BIN, 500)])]);
        let m = build(&r, json!([{ "ruleId": "bin" }]));
        let item = &m.items[0];
        assert!(item.selected, "用户确实勾了");
        assert!(!item.included, "🔴 永不计入");
        assert_eq!(item.bytes, 0);
        assert_eq!(item.files, 0);
        assert_eq!(item.finding_bytes, 500, "但识别到的容量照常上报");
        assert_eq!(m.total_bytes, 0);
        assert_eq!(m.risk_breakdown.forbidden.items, 0);
        assert_eq!(reasons(&m).first(), Some(&PreviewRefusalReason::ForbiddenRisk));
        assert_eq!(item.refusal.as_ref().unwrap().bytes, 500, "项级拒绝要带上它本来的大小");
    }

    /* ② blocked：保护不在线时任何勾选都不出结论 */

    #[test]
    fn a_blocked_report_refuses_every_selection() {
        let mut r = report(vec![finding("temp", Risk::Safe, &[(r"C:\Temp\a", 100)])]);
        r.safety_blocked = true;
        let m = build(&r, json!([{ "ruleId": "temp" }]));
        assert!(m.blocked);
        assert_eq!(m.total_bytes, 0);
        assert_eq!(m.items[0].included, false);
        assert!(reasons(&m).contains(&PreviewRefusalReason::SafetyBlocked));
        assert!(!reasons(&m).contains(&PreviewRefusalReason::ForbiddenRisk), "先撞的是 safety-blocked 那道");
        assert!(m.notes.iter().any(|n| n.contains("safetyBlocked")), "notes 要把话说出来");
    }

    /// 「禁止根为空 = 保护不在线」是第二类 blocked（报告没带保护，不是引擎承认自己瞎了）。
    #[test]
    fn an_empty_forbidden_root_list_is_also_blocked() {
        let mut r = report(vec![finding("temp", Risk::Safe, &[(r"C:\Temp\a", 100)])]);
        r.forbidden_roots.clear();
        let m = build(&r, json!([{ "ruleId": "temp" }]));
        assert!(m.blocked);
        assert!(reasons(&m).contains(&PreviewRefusalReason::SafetyBlocked));
    }

    /* ③ 整项 + 逐路径：不重复计价，但要留痕 */

    #[test]
    fn whole_item_then_paths_does_not_double_price() {
        let r = report(vec![finding("temp", Risk::Safe, &[(r"C:\Temp\a", 100), (r"C:\Temp\b", 200)])]);
        let m = build(&r, json!([
            { "ruleId": "temp" },
            { "ruleId": "temp", "paths": [r"C:\Temp\a"] }
        ]));
        assert_eq!(m.total_bytes, 300, "只计一次");
        let item = &m.items[0];
        assert_eq!(item.scope, PreviewScope::Rule);
        assert!(item.paths.is_empty(), "整项勾选的 item 不带逐路径清单");
        assert!(reasons(&m).contains(&PreviewRefusalReason::DuplicateSelection));
    }

    #[test]
    fn selecting_the_same_rule_twice_is_named_not_silently_ignored() {
        let r = report(vec![finding("temp", Risk::Safe, &[(r"C:\Temp\a", 100)])]);
        let m = build(&r, json!([{ "ruleId": "temp" }, { "ruleId": "temp" }]));
        assert_eq!(m.total_bytes, 100);
        assert!(reasons(&m).contains(&PreviewRefusalReason::DuplicateSelection));
    }

    /* ④⑤ 逐路径定价：两道保护闸 + 枚举不到就不猜 */

    #[test]
    fn a_path_under_a_protected_root_is_refused_with_its_own_reason() {
        let r = report(vec![finding(
            "wide",
            Risk::Safe,
            &[(r"C:\Windows\System32\k.dll", 999), (BIN, 500), (r"C:\Temp\a", 100)],
        )]);
        let m = build(&r, json!([{
            "ruleId": "wide",
            "paths": [r"C:\Windows\System32\k.dll", BIN, r"C:\Temp\a"]
        }]));
        assert_eq!(m.total_bytes, 100, "只有干净那条被计价");
        let rs = reasons(&m);
        assert!(rs.contains(&PreviewRefusalReason::ForbiddenRoot), "禁止根要单独一类");
        assert!(rs.contains(&PreviewRefusalReason::ReportOnlyRoot), "只上报根是另一类，不许与禁止根混");
        let forbidden = m.refusals.iter().find(|x| x.reason == PreviewRefusalReason::ForbiddenRoot).unwrap();
        assert_eq!(forbidden.bytes, 999, "被挡的字节要如实记");
    }

    #[test]
    fn a_path_the_report_never_enumerated_cannot_be_priced() {
        let r = report(vec![finding("temp", Risk::Safe, &[(r"C:\Temp\a", 100)])]);
        let m = build(&r, json!([{ "ruleId": "temp", "paths": [r"C:\Temp\a", r"C:\Temp\ghost"] }]));
        assert_eq!(m.total_bytes, 100, "认不出来的那条不猜大小");
        let ghost = m
            .refusals
            .iter()
            .find(|x| x.reason == PreviewRefusalReason::PathNotEnumerated)
            .expect("必须点名 path-not-enumerated");
        assert_eq!(ghost.path.as_deref(), Some(r"C:\Temp\ghost"));
        assert_eq!(ghost.bytes, 0);
    }

    #[test]
    fn the_same_path_under_two_rules_is_priced_once() {
        let r = report(vec![
            finding("a", Risk::Safe, &[(r"C:\Temp\x", 100)]),
            finding("b", Risk::Safe, &[(r"C:\Temp\x", 100)]),
        ]);
        let m = build(&r, json!([
            { "ruleId": "a", "paths": [r"C:\Temp\x"] },
            { "ruleId": "b", "paths": [r"C:\Temp\x"] }
        ]));
        assert_eq!(m.total_bytes, 100, "同一路径只计一次钱");
        assert!(reasons(&m).contains(&PreviewRefusalReason::DuplicateSelection));
    }

    /* 整项勾选 × 逐路径勾选 撞在同一条路径上（§20 的组 + §12 的地图那一条）。
     * 上面那条只覆盖"两边都按路径勾"；`the_same_path_under_two_rules_is_priced_once` 的
     * 注释说"引擎的 claimed 表已保证一条路径只有一个主人"—— 那句对**登记表规则**成立，
     * 对 §20 的伪项不成立：它的待删路径完全可以同时是某条规则地盘里的文件。
     * 真机量实（`scripts/m5n-tile-dup-e2e.ps1`，2026-10-13）：同一个 5 MiB 文件在预览里
     * 计了两次、一个字节都没留痕，而盘上只会少 5 MiB。 */

    #[test]
    fn a_path_priced_by_tile_then_covered_by_a_whole_item_is_priced_once() {
        let r = report(vec![
            finding("temp", Risk::Safe, &[(r"C:\Temp\x", 100)]),
            with_all(finding("dup:g1", Risk::High, &[(r"C:\Temp\x", 100)])),
        ]);
        let m = build(&r, json!([
            { "ruleId": "temp", "paths": [r"C:\Temp\x"] },
            { "ruleId": "dup:g1" }
        ]));
        assert_eq!(m.total_bytes, 100, "整项勾选要把它认领的那条路径让给已经计过钱的那次");
        assert_eq!(m.total_files, 1, "文件数同轴：一个文件不能算两个");
        assert!(
            reasons(&m).contains(&PreviewRefusalReason::DuplicateSelection),
            "第二次表达必须点名，不许静默吞掉"
        );
    }

    #[test]
    fn a_whole_item_priced_first_lets_no_other_item_price_its_paths_again() {
        // 反过来的次序：整项那条先在 findings 里出现 ⇒ 它先认领，逐路径那次才被拒。
        // 两条用例是两个轴，只做一条会留下"次序决定对不对"这种行为。
        let r = report(vec![
            with_all(finding("dup:g1", Risk::High, &[(r"C:\Temp\x", 100)])),
            finding("temp", Risk::Safe, &[(r"C:\Temp\x", 100)]),
        ]);
        let m = build(&r, json!([
            { "ruleId": "dup:g1" },
            { "ruleId": "temp", "paths": [r"C:\Temp\x"] }
        ]));
        assert_eq!(m.total_bytes, 100, "同一条路径在两种表达之间也只计一次");
        assert_eq!(m.total_files, 1);
        assert!(reasons(&m).contains(&PreviewRefusalReason::DuplicateSelection));
    }

    #[test]
    fn a_whole_item_without_a_full_list_is_not_pretended_to_be_deduped() {
        // 没有全量清单就没有对账的输入 —— 这条钉的是"本模块**不覆盖**这一格"，不是"它也去重了"。
        // 生产拿不到这个形状（见 `with_all` 的注释），所以它是一格边界而不是一条待办。
        let r = report(vec![
            finding("temp", Risk::Safe, &[(r"C:\Temp\x", 100)]),
            finding("dup:g1", Risk::High, &[(r"C:\Temp\x", 100)]), // all_paths = None
        ]);
        let m = build(&r, json!([
            { "ruleId": "temp", "paths": [r"C:\Temp\x"] },
            { "ruleId": "dup:g1" }
        ]));
        assert_eq!(m.total_bytes, 200, "认不全就照旧按整项发价 —— 宁可虚高，也不许编一个去重结果");
    }

    /* ⑥⑦ 小计与合计 */

    #[test]
    fn the_breakdown_counts_only_included_items_and_refused_bytes_is_the_sum() {
        let r = report(vec![
            finding("a", Risk::Safe, &[(r"C:\Temp\a", 100)]),
            finding("b", Risk::High, &[(r"C:\Temp\b", 200)]),
            finding("bin", Risk::Forbidden, &[(BIN, 500)]),
        ]);
        let m = build(&r, json!([{ "ruleId": "a" }, { "ruleId": "b" }, { "ruleId": "bin" }]));
        assert_eq!(m.total_bytes, 300);
        assert_eq!(m.total_files, 2);
        assert_eq!(m.risk_breakdown.safe, PreviewRiskCell { items: 1, files: 1, bytes: 100 });
        assert_eq!(m.risk_breakdown.high, PreviewRiskCell { items: 1, files: 1, bytes: 200 });
        assert_eq!(m.risk_breakdown.forbidden.items, 0, "🔴 恒为 0");
        assert_eq!(m.refused_bytes, 500, "被拒的字节 = 各条拒绝之和（这里就是 🔴 那一项）");
        assert!(m.notes.iter().any(|n| n.contains("高风险")), "🟠 必须点名提示");
    }

    #[test]
    fn an_unselected_item_is_listed_but_prices_nothing() {
        let r = report(vec![finding("a", Risk::Safe, &[(r"C:\Temp\a", 100)])]);
        let m = build(&r, json!([]));
        assert_eq!(m.items.len(), 1, "报告里的项都要列出来");
        assert!(!m.items[0].selected);
        assert!(!m.items[0].included);
        assert_eq!(m.total_bytes, 0);
        assert!(m.refusals.is_empty());
    }

    /* 畸形的勾选输入各有专属理由 */

    #[test]
    fn malformed_selections_are_named_not_dropped() {
        let r = report(vec![finding("a", Risk::Safe, &[(r"C:\Temp\a", 100)])]);

        // items 不是数组
        let m = build(&r, json!({ "nope": 1 }));
        assert_eq!(reasons(&m), vec![PreviewRefusalReason::UnknownRule]);
        assert!(m.refusals[0].detail.contains("选择结构非法"));

        // 缺 ruleId
        let m = build(&r, json!([{ "paths": [] }]));
        assert_eq!(reasons(&m), vec![PreviewRefusalReason::UnknownRule]);

        // 报告里没有这个 id
        let m = build(&r, json!([{ "ruleId": "ghost" }]));
        assert_eq!(reasons(&m), vec![PreviewRefusalReason::UnknownRule]);

        // 声明层就被拒的规则：那句必须点名**规则名**与被拒**原因**（与 TS 同形，只差函数名那一格），
        // 不是内部 id —— 用户看得懂的是"Windows 临时文件（invalid-shape）"，不是"bad"。
        let mut r2 = report(vec![finding("a", Risk::Safe, &[(r"C:\Temp\a", 100)])]);
        r2.rejected_rules.push(RejectedRule {
            rule_id: "bad".into(),
            name: "坏规则".into(),
            problems: vec![RejectedProblem {
                rule_id: "bad".into(),
                path: r"C:\Temp".into(),
                reason: "invalid-shape".into(),
                detail: "§15 形状不合格：paths 不能为空".into(),
            }],
        });
        let m = build(&r2, json!([{ "ruleId": "bad" }]));
        assert_eq!(reasons(&m), vec![PreviewRefusalReason::ItemRejected]);
        let d = &m.refusals[0].detail;
        assert!(d.contains("坏规则"), "那句没点规则名，用户读到的还是内部 id：{d}");
        assert!(d.contains("invalid-shape"), "那句没带被拒原因：{d}");
        assert!(!d.contains("「bad」"), "那句拿内部 id 当名字念：{d}");

        // `problems` 是空表时那句要改口成"未记录具体原因"，而不是括号里空着
        let mut r3 = report(vec![finding("a", Risk::Safe, &[(r"C:\Temp\a", 100)])]);
        r3.rejected_rules.push(RejectedRule {
            rule_id: "bad".into(),
            name: "坏规则".into(),
            problems: Vec::new(),
        });
        let m = build(&r3, json!([{ "ruleId": "bad" }]));
        assert!(m.refusals[0].detail.contains("未记录具体原因"), "{:?}", m.refusals[0].detail);

        // paths 字段不是数组
        let m = build(&r, json!([{ "ruleId": "a", "paths": "C:\\Temp\\a" }]));
        assert_eq!(reasons(&m), vec![PreviewRefusalReason::PathNotEnumerated]);
    }

    /* 透传与指纹 */

    #[test]
    fn the_ledger_and_the_exemption_table_are_passed_through_untouched() {
        let mut r = report(vec![finding("a", Risk::Safe, &[(r"C:\Temp\a", 100)])]);
        r.territories.push(deepclean_rules::engine::TerritoryFact {
            rule_id: "npm-cache".into(),
            detector_absent: true,
            present: Vec::new(),
            not_scanned: 3,
        });
        r.exclusions.push(deepclean_rules::engine::Exclusion {
            rule_id: None,
            path: "p".into(),
            reason: deepclean_rules::engine::ExclusionReason::NotScanned,
            detail: "d".into(),
        });
        let m = build(&r, json!([{ "ruleId": "a" }]));
        assert_eq!(m.territories.len(), 1, "底账原样搬运，预览这一层不判定");
        assert_eq!(m.report_exclusion_count, 1);
        assert_eq!(m.default_unselectable_rule_ids, vec!["hf".to_string()]);
        assert_eq!(m.generated_at_ms, 1_700_000_000_000);
        assert_eq!(m.digest.len(), 16);
    }

    /// `all_paths` 在时按**全量认领清单**定价（采样只有一条也不影响），且 notes 要换成对应措辞。
    #[test]
    fn all_paths_takes_precedence_over_the_truncated_sample() {
        let mut f = finding("temp", Risk::Safe, &[(r"C:\Temp\a", 100)]);
        f.sample_truncated = true;
        f.file_count = 2;
        f.total_bytes = 300;
        f.all_paths = Some(vec![
            PathHit { path: r"C:\Temp\a".into(), size: 100 },
            PathHit { path: r"C:\Temp\b".into(), size: 200 },
        ]);
        let r = report(vec![f]);
        let m = build(&r, json!([{ "ruleId": "temp", "paths": [r"C:\Temp\b"] }]));
        assert_eq!(m.total_bytes, 200, "采样里没有 b，但全量清单里有");
        assert!(m.notes.iter().any(|n| n.contains("全部")), "notes 要说明定价口径：{:?}", m.notes);
    }

    #[test]
    fn an_included_whole_item_carries_the_truncated_note() {
        let mut f = finding("temp", Risk::Safe, &[(r"C:\Temp\a", 100)]);
        f.sample_truncated = true;
        let r = report(vec![f]);
        let m = build(&r, json!([{ "ruleId": "temp" }]));
        assert!(m.items[0].sample_truncated);
        assert!(m.notes.iter().any(|n| n.contains("全量口径")), "{:?}", m.notes);
    }

    #[test]
    fn a_non_recoverable_included_item_is_called_out() {
        let mut f = finding("temp", Risk::Safe, &[(r"C:\Temp\a", 100)]);
        f.recoverable = false;
        let r = report(vec![f]);
        let m = build(&r, json!([{ "ruleId": "temp" }]));
        assert!(m.notes.iter().any(|n| n.contains("不可再生")), "{:?}", m.notes);
    }

    /* M5-P1 T5a：规则文案必须到得了界面 */

    /// **每一项都必须带上它自己那条规则的 `description`。**
    ///
    /// 这是「文案到得了界面」的**行为**断言，不是读源码的 grep 闸：它跑的是真 `build_preview_model`，
    /// 输入是把**整张内置表（21 条）一条条合成成 finding** 的一份报告（合成树口径 —— 预览的入参本来就
    /// 是报告而不是树，见文件头约束 2；用真树反而覆盖不齐，`requiresDetector` 那一族在没有对应
    /// 探测器状态的树上会**一条 finding 都不产**，于是"每项都有文案"会退化成"恰好有的那几项有文案"）。
    ///
    /// 三条判据，少一条都留得下后门：
    /// 1. **条数**：模型里的项必须**等于**表里的规则条数 —— 项少了的话，"每条非空"能空过。
    /// 2. **非空**，且**点名**是哪几条空了（红的信息量要够人去修）。空文案不许在显示层
    ///    拿一句"通用说明"补上 —— 那句没有出处，而它又被哈希进过执行凭据。
    /// 3. **逐字等于规则那一份**：预览层一旦自己写句子，两侧就开始分叉，而 digest 盖住的是分叉后的那份。
    #[test]
    fn every_item_carries_its_rule_description() {
        let rules = deepclean_rules::builtin_rules();
        assert!(!rules.is_empty(), "内置表是空的 ⇒ 这条判据会空过");

        let findings: Vec<RuleFinding> = rules
            .iter()
            .enumerate()
            .map(|(n, r)| RuleFinding {
                rule_id: r.id.clone(),
                name: r.name.clone(),
                category: r.category,
                risk_level: r.risk_level,
                clean_strategy: r.clean_strategy,
                recoverable: r.recoverable,
                matched_roots: vec![format!(r"C:\synth\{n}")],
                sample_paths: vec![PathHit { path: format!(r"C:\synth\{n}\f{n}"), size: 100 + n as u64 }],
                sample_truncated: false,
                file_count: 1,
                total_bytes: 100 + n as u64,
                all_paths: None,
            })
            .collect();
        let ids: Vec<String> = rules.iter().map(|r| r.id.clone()).collect();
        let r = report(findings);
        let m = build(&r, json!(ids.iter().map(|id| json!({ "ruleId": id })).collect::<Vec<_>>()));

        assert_eq!(
            m.items.len(),
            rules.len(),
            "预览模型里的项数（{}）与内置表条数（{}）对不上 ⇒ 「每条都有文案」会空过",
            m.items.len(),
            rules.len()
        );

        let empty: Vec<&str> = m.items.iter().filter(|i| i.description.trim().is_empty()).map(|i| i.rule_id.as_str()).collect();
        assert!(
            empty.is_empty(),
            "这些项的 description 是空的，「删了会失去什么」这句话到不了界面：{empty:?}"
        );

        // 项的顺序 = 报告 findings 顺序 = 表序（`build_preview_model` 按 findings 组装），逐条比文案本身。
        for (item, rule) in m.items.iter().zip(rules.iter()) {
            assert_eq!(item.rule_id, rule.id, "项序与表序错位，下面的逐条比对就没有意义");
            assert_eq!(
                item.description, rule.description,
                "项「{}」的文案不是规则那一份（预览层自己写了句子？），界面读到的会是被哈希的另一句话",
                rule.id
            );
        }
    }

    /// 表外的 `rule_id`（§20 的重复文件伪项 `dup:*`、夹具里的自定义规则集）**留空串**，
    /// 与「查不到就编一句」是两件事：这一格是**登记**，不是待办。
    /// 空串照样进 digest（覆盖字段看的是字段，不是"字段非空"），所以旧凭据也不会因为文案后补而失效。
    #[test]
    fn a_rule_id_outside_the_builtin_table_carries_an_empty_description_not_an_invented_one() {
        let r = report(vec![finding("dup:3823da", Risk::High, &[(r"C:\Temp\d1", 100)])]);
        let m = build(&r, json!([{ "ruleId": "dup:3823da" }]));
        assert_eq!(m.items[0].description, "", "预览层不许替表外的项编一句文案");
        assert!(m.items[0].included, "对照组：这一项确实进了预估，红不是走错分支红出来的");
    }
}
