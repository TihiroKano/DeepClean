//! §17 倒数第二步：确认。**纯数据，且不含路径清单。**
//!
//! 刻意的三件事：
//! - **不出具工作单**：只列 `rule_id` 与合计。一份能直接喂给删除循环的路径清单才是危险的东西。
//! - **指纹必须对得上**：确认的是用户看见的那一份预估，改过一个字节都算 stale。
//! - **档位必须按得够**（M5-P1 T4，spec §5）：`acknowledged` 只说「我点了确认」，
//!   说明不了用户看见过 🟠。所以另收一个 `acknowledged_risk`，判据是
//!   「**已计入项里的最高档** 是否被这一档盖住」—— 盖不住就出不了回执，也就删不了任何东西。
//!
//! 内容复核、指纹复核、档位复核**彼此独立**（与 TS `confirmPreview` 同口径）：就算有人把指纹也
//! 重新算对了，一份"把 🔴 算成 included"的模型照样确认不了；同理，一份只按了 🟡 的确认
//! 也盖不住含 🟠 的预估。
//!
//! **回执的 `digest` 是「模型决策字段 + 这一项按下的档位」**（`digest.rs`）：
//! 少了后半句，同一份预估按 🟢 档领到的旧回执就能顶着一份含 🟠 的预估重放。

use crate::digest::preview_digest;
use crate::model::*;
use deepclean_rules::env::is_forbidden_path;
use deepclean_rules::types::Risk;

/// 回执里那句实话：回执是**凭据**，不是工作单。
pub const CONFIRM_NOTE: &str =
    "确认回执不含路径清单（一份能直接喂给删除循环的工作单才是危险的东西）；执行入口只认这份 digest，\
     具体清单由主进程从「已扫好的树」里另取，且每条都要重新过 authorized_root 的闸";

/// 风险档的**序**（🟢 < 🟡 < 🟠 < 🔴）。四档是闭集，写全 ⇒ 以后加一档会编译不过，
/// 而不是落到 `_ => 0` 那种"新档自动等于最低档"的静默失效上。
/// 与 TS `core/rules/preview.ts` 里用 `RISKS` 那张既有名单下标定序同口径（两份都是四档升序）。
fn tier_rank(risk: Risk) -> u8 {
    match risk {
        Risk::Safe => 0,
        Risk::Caution => 1,
        Risk::High => 2,
        Risk::Forbidden => 3,
    }
}

/// 这份预估**要求**用户按到哪一档 = 已计入项里的最高档。
/// 一项都没计入时回 `None`（没有档可要求；`nothing-to-confirm` 那道闸管这种情况）。
///
/// 只看 `included`：未勾选的 🟠 行用户还没决定要删，不该逼他按 🟠。
/// **🔴 不参与抬档**（spec §5 把确认档位定义成 safe/caution/high 三档）：🔴 永不可能合法地
/// 出现在 `included` 里，一份把 🔴 算进来的模型由 ② 内容复核那条拦 —— 这里再抬一次档只是把
/// 同一件事说两遍，还会造出"要求按 🔴 档"那种没人能按的闸。
fn required_tier(model: &PreviewModel) -> Option<Risk> {
    model
        .items
        .iter()
        .filter(|i| i.included && i.risk_level != Risk::Forbidden)
        .map(|i| i.risk_level)
        .max_by_key(|r| tier_rank(*r))
}

/// 这一项的**路径或地盘**里有落在 `roots` 之下的吗（返回命中的那个根，好让调用方点名）。
fn forbidden_hit_in_item(i: &PreviewItem, roots: &[String]) -> Option<String> {
    for p in &i.paths {
        if let Some(hit) = is_forbidden_path(&p.path, roots) {
            return Some(hit);
        }
    }
    for r in &i.matched_roots {
        if let Some(hit) = is_forbidden_path(r, roots) {
            return Some(hit);
        }
    }
    None
}

/// 「确认」—— 判据顺序固定，结果可复现（顺序本身是行为：界面按 blocker 列表分措辞）。
///
/// 固定次序：① 指纹 → ② 内容（🔴/只上报）→ ③ **档位** → ④ `safety-blocked` → ⑤ 未勾选 → ⑥ 空勾选。
/// ③ 夹在两道复核之后、`SafetyBlocked` 之前，与 `ForbiddenIncluded` 今天所在的位置同形：
/// 先说「这份预估本身不干净」，再说「你按的档不够」，最后才是「保护没落地」。
pub fn confirm_preview(
    model: &PreviewModel,
    acknowledged: bool,
    acknowledged_risk: Risk,
    now_ms: i64,
) -> PreviewConfirmation {
    let mut blockers: Vec<PreviewConfirmBlocker> = Vec::new();

    // ① 指纹复核：重算一遍**模型那一份**（档位无关），和模型自己带的那一份比
    let model_digest = preview_digest(model, None);
    if model_digest != model.digest {
        blockers.push(PreviewConfirmBlocker::StaleModel);
    }

    // ② 内容复核：**与指纹复核独立** —— 指纹重算对了也挡不住一份 🔴 被算成 included 的模型。
    //    只上报根同样复核：有人手工拼出一份把回收站算成 🟢 的模型，这份确认也不许出具。
    let forged = model.items.iter().any(|i| {
        i.included
            && (i.risk_level == Risk::Forbidden
                || forbidden_hit_in_item(i, &model.forbidden_roots).is_some()
                || forbidden_hit_in_item(i, &model.report_only_roots).is_some())
    });
    if forged {
        blockers.push(PreviewConfirmBlocker::ForbiddenIncluded);
    }

    // ③ 档位复核（M5-P1 T4 的新闸）：已计入项的最高档**超出**用户按下的档 → 出不了回执。
    //    方向是单向的：按得比要求的低才拦，按得高不拦（含 🟢 的预估按 🟠 档确认是合法但过度询问，
    //    过度询问由渲染端负责，不在这里罚）。
    if let Some(required) = required_tier(model) {
        if tier_rank(required) > tier_rank(acknowledged_risk) {
            blockers.push(PreviewConfirmBlocker::RiskNotAcknowledged);
        }
    }

    if model.blocked {
        blockers.push(PreviewConfirmBlocker::SafetyBlocked);
    }
    if !acknowledged {
        blockers.push(PreviewConfirmBlocker::NotAcknowledged);
    }

    let has_something = model.total_bytes > 0 && model.items.iter().any(|i| i.included);
    if blockers.is_empty() && !has_something {
        blockers.push(PreviewConfirmBlocker::NothingToConfirm);
    }

    let confirmed = blockers.is_empty();
    let included: Vec<&PreviewItem> = if confirmed {
        model.items.iter().filter(|i| i.included).collect()
    } else {
        Vec::new()
    };

    PreviewConfirmation {
        kind: PreviewConfirmationKind::DcPreviewConfirmation,
        acknowledged,
        acknowledged_risk,
        confirmed,
        blockers,
        rule_ids: included.iter().map(|i| i.rule_id.clone()).collect(),
        items: included.len() as u64,
        files: included.iter().map(|i| i.files).sum(),
        total_bytes: included.iter().map(|i| i.bytes).sum(),
        refusal_count: model.refusals.len(),
        // 执行凭据：模型决策字段 **+ 按下的档位**。同一份预估按 🟡 与按 🟠 出来必须是两个串。
        digest: preview_digest(model, Some(acknowledged_risk)),
        // 归属凭据：本回执绑定的那一份**模型指纹**（档位无关）。渲染端没法自己重算带档位那一份
        // （`tsconfig.web.json` 不允许 import `core/rules/**`），所以归属判据只能在这里陈述。
        model_digest: model.digest.clone(),
        confirmed_at_ms: now_ms,
        note: CONFIRM_NOTE.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::PreviewSelection;
    use crate::preview::build_preview_model;
    use deepclean_rules::engine::{BytesByRisk, PathHit, RuleFinding, RuleReport};
    use deepclean_rules::types::{CleanStrategy, RuleCategory};
    use serde_json::json;

    const BIN: &str = r"C:\$Recycle.Bin";
    const TEMP_FILE: &str = r"C:\Temp\a.tmp";

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
            matched_roots: vec![r"C:\Temp".into()],
            sample_paths: sample,
            sample_truncated: false,
            file_count: paths.len() as u64,
            total_bytes: total,
            all_paths: None,
        }
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
            forbidden_roots: vec![r"C:\Windows\System32".into()],
            report_only_roots: vec![BIN.into()],
            territories: Vec::new(),
            bytes_by_risk,
            reclaimable_bytes: deepclean_rules::engine::reclaimable_of(&bytes_by_risk),
            safety_blocked: false,
            claimed_paths: None,
        }
    }

    fn model_of(findings: Vec<RuleFinding>, items: serde_json::Value) -> PreviewModel {
        let r = report(findings);
        build_preview_model(
            &r,
            &PreviewSelection { items },
            &PreviewBuildOptions { now_ms: 1_700_000_000_000, default_unselectable_rule_ids: Vec::new() },
        )
    }

    fn clean_model() -> PreviewModel {
        model_of(vec![finding("temp", Risk::Safe, &[(TEMP_FILE, 100)])], json!([{ "ruleId": "temp" }]))
    }

    /// 只有 🟡 的一项（`windows-temp` 那族缓存的档位）：档位闸的"够档"对照组。
    fn caution_model() -> PreviewModel {
        model_of(vec![finding("warn", Risk::Caution, &[(TEMP_FILE, 200)])], json!([{ "ruleId": "warn" }]))
    }

    /// 含**一项已计入的 🟠**（M5-P1 T3b-ii 上表的 `user-downloads-installers` 就是这一档）+ 一项 🟢，
    /// 让"预估里混着高风险"这件事是真的，而不是只有一项 🟠 的退化形状。
    fn high_model() -> PreviewModel {
        model_of(
            vec![finding("temp", Risk::Safe, &[(TEMP_FILE, 100)]), finding("dl", Risk::High, &[(r"C:\Users\Kano\Downloads\setup.exe", 900)])],
            json!([{ "ruleId": "temp" }, { "ruleId": "dl" }]),
        )
    }

    /// **没过闸 = 没有回执**：`confirmed` 是 false，而且这份回执**不带任何清单与合计**。
    /// 两条都得看：只断言 `confirmed == false` 的话，"照样把 ruleIds / totalBytes 填好、
    /// 只是顺手打个 blocker 标记"那种形态就过去了 —— 那等于闸没拦，只是说了句不响的话。
    /// （执行侧的形态由 `service.rs` 钉：只有 `confirmed` 才会往 `confirmations` 里锚计划。）
    fn no_receipt(c: &PreviewConfirmation) {
        assert!(!c.confirmed, "没过闸却回了 confirmed=true：{:?}", c.blockers);
        assert!(c.rule_ids.is_empty(), "没过闸却带出了 ruleIds：{:?}", c.rule_ids);
        assert_eq!((c.items, c.files, c.total_bytes), (0, 0, 0), "没过闸却带出了合计");
    }

    #[test]
    fn a_clean_selection_confirms_and_lists_only_rule_ids() {
        let m = clean_model();
        let c = confirm_preview(&m, true, Risk::Safe, 42);
        assert_eq!(c.kind, PreviewConfirmationKind::DcPreviewConfirmation);
        assert!(c.confirmed);
        assert!(c.blockers.is_empty(), "{:?}", c.blockers);
        assert_eq!(c.rule_ids, vec!["temp".to_string()]);
        assert_eq!(c.items, 1);
        assert_eq!(c.files, 1);
        assert_eq!(c.total_bytes, 100);
        assert_eq!(c.acknowledged_risk, Risk::Safe, "按下的档位要如实带在回执上");
        assert_eq!(c.digest, preview_digest(&m, Some(Risk::Safe)), "凭据 = 模型决策字段 + 按下的档位");
        assert_eq!(c.confirmed_at_ms, 42, "时间靠注入，本模块不读时钟");
        assert_eq!(c.note, CONFIRM_NOTE);
    }

    /// 回执的**线上键名**本身就是契约：渲染端没法自己重算带档位的 digest（`previewDigest`
    /// 是 `core/rules/preview.ts` 里的值，而 web 那个 composite 项目不允许把规则引擎当运行时引进来），
    /// 所以「这张回执属不属于我此刻看见的这份预估」只能读服务端陈述的 `modelDigest`。
    /// 跨语言那道 `scripts/parity-preview.mjs` **不比 confirmation**（那文件里 `confirmation`
    /// 与 `digest` 零命中），于是摘掉 `model.rs` 上的 `#[serde(rename_all = "camelCase")]`
    /// 会让界面读到 `undefined` ⇒ `canExecuteReceipt` 走「缺失即不放行」⇒「开始清理」永久灰，
    /// 而 cargo / npm / tsc / golden 四道闸全绿。这条就钉那一格。
    #[test]
    fn the_receipt_carries_the_wire_names_the_renderer_has_to_read() {
        let c = confirm_preview(&clean_model(), true, Risk::High, 42);
        let v = serde_json::to_value(&c).expect("回执必须可序列化");
        let obj = v.as_object().expect("回执序列化出来得是对象");
        for want in ["digest", "modelDigest", "acknowledgedRisk", "confirmed", "ruleIds"] {
            assert!(obj.contains_key(want), "回执线上少了渲染端要读的键 {want}：{:?}", obj.keys().collect::<Vec<_>>());
        }
        for snake in ["model_digest", "acknowledged_risk", "rule_ids", "confirmed_at_ms"] {
            assert!(!obj.contains_key(snake), "线上键名退化成 snake_case 了：{snake}（渲染端读不到 ⇒ 执行入口永久灰）");
        }
        assert_eq!(
            obj["modelDigest"].as_str().expect("modelDigest 得是字符串"),
            c.model_digest.as_str(),
            "modelDigest 装的必须是那份**档位无关**的模型指纹，不是带档位的凭据"
        );
        assert_ne!(c.model_digest, c.digest, "两份口径按设计就不该相等（相等说明 M5-P1 T4 那半白做了）");
    }

    /// **承重墙**：回执里不许出现任何路径 —— 它就是靠这一点与"工作单"分开的。
    ///
    /// 判据要把模型序列化成 JSON 再找路径子串，所以**必须先算一遍转义形式**：
    /// 序列化后反斜杠是双写的，拿原文去找会永远找不到 —— 那样这条判据会**恒真**，
    /// 也就是"看着在验、其实什么都没验"。第一版就是这么写错的，被下面那条对照逮住。
    #[test]
    fn the_receipt_never_carries_a_path() {
        // 用**路径级勾选**：整项勾选的 item 里根本没有具体文件路径，那时这条判据测不到东西
        let m = model_of(
            vec![finding("temp", Risk::Safe, &[(TEMP_FILE, 100)])],
            json!([{ "ruleId": "temp", "paths": [TEMP_FILE] }]),
        );
        fn needle(p: &str) -> String {
            serde_json::to_string(p).unwrap().trim_matches('"').to_string()
        }

        // 对照：模型自己序列化后**确实**带着这条路径 —— 没有这一步就不知道判据有没有分辨力
        let ms = serde_json::to_string(&m).unwrap();
        assert!(ms.contains(&needle(TEMP_FILE)), "对照失败：模型里本该有这条路径：{ms}");
        assert!(ms.contains(&needle(r"C:\Temp")), "对照失败：地盘也该在模型里");

        let c = confirm_preview(&m, true, Risk::Safe, 7);
        let s = serde_json::to_string(&c).unwrap();
        for p in [TEMP_FILE, r"C:\Temp", BIN, r"C:\Windows\System32"] {
            assert!(!s.contains(&needle(p)), "回执里出现了路径 {p}：{s}");
        }
    }

    /* ---------------- 五种 blocker 各自可达 ---------------- */

    #[test]
    fn stale_model_fires_when_the_fingerprint_was_tampered_with() {
        let mut m = clean_model();
        m.digest = "00000000deadbeef".into();
        let c = confirm_preview(&m, true, Risk::Safe, 0);
        assert!(c.blockers.contains(&PreviewConfirmBlocker::StaleModel));
        assert!(!c.confirmed);
        assert_eq!(c.total_bytes, 0, "没过闸就不许给出合计");
        assert!(c.rule_ids.is_empty());
    }

    /// 内容复核**独立于**指纹复核：把 `included` 改脏之后**把指纹一起重算对**，
    /// `stale-model` 就不该再响 —— 这时唯一拦得住它的就是 `forbidden-included`。
    #[test]
    fn forbidden_included_fires_even_when_the_fingerprint_is_consistent() {
        let mut m = clean_model();
        m.items[0].included = true;
        m.items[0].risk_level = Risk::Forbidden;
        m.digest = preview_digest(&m, None); // 指纹重新算对了
        let c = confirm_preview(&m, true, Risk::Safe, 0);
        assert!(!c.blockers.contains(&PreviewConfirmBlocker::StaleModel), "指纹是一致的");
        assert!(c.blockers.contains(&PreviewConfirmBlocker::ForbiddenIncluded), "{:?}", c.blockers);
    }

    /// 同一道闸的第二形态：项名是 🟢，但它的地盘落在只上报根（回收站）里。
    #[test]
    fn an_item_whose_territory_sits_under_a_report_only_root_is_caught() {
        let mut m = clean_model();
        m.items[0].included = true;
        m.items[0].risk_level = Risk::Safe;
        m.items[0].matched_roots = vec![BIN.into()];
        m.digest = preview_digest(&m, None);
        let c = confirm_preview(&m, true, Risk::Safe, 0);
        assert!(c.blockers.contains(&PreviewConfirmBlocker::ForbiddenIncluded), "{:?}", c.blockers);
    }

    #[test]
    fn safety_blocked_fires_on_a_blocked_model() {
        let mut r = report(vec![finding("temp", Risk::Safe, &[(TEMP_FILE, 100)])]);
        r.safety_blocked = true;
        let m = build_preview_model(
            &r,
            &PreviewSelection { items: json!([{ "ruleId": "temp" }]) },
            &PreviewBuildOptions::default(),
        );
        let c = confirm_preview(&m, true, Risk::Safe, 0);
        assert!(c.blockers.contains(&PreviewConfirmBlocker::SafetyBlocked));
        assert!(!c.confirmed);
    }

    #[test]
    fn not_acknowledged_fires_when_the_box_is_unchecked() {
        let m = clean_model();
        let c = confirm_preview(&m, false, Risk::Safe, 0);
        assert!(c.blockers.contains(&PreviewConfirmBlocker::NotAcknowledged));
        assert!(!c.acknowledged);
    }

    #[test]
    fn nothing_to_confirm_fires_when_there_is_nothing_included() {
        let m = model_of(vec![finding("temp", Risk::Safe, &[(TEMP_FILE, 100)])], json!([]));
        let c = confirm_preview(&m, true, Risk::Safe, 0);
        assert!(c.blockers.contains(&PreviewConfirmBlocker::NothingToConfirm), "{:?}", c.blockers);
        assert_eq!(c.blockers.len(), 1, "这是唯一一条「没有坏消息」的 blocker：{:?}", c.blockers);
        assert!(!c.confirmed);
    }

    /// 顺序固定：界面按 blocker 列表分措辞，列表次序本身是行为。
    /// 这一份**不含**档位那一格（🟢 项 + 🟢 档 = 够档），逐字沿用 T4 之前的期望 —— 回归轴：
    /// 新闸不许动到既有三条的次序与可达性。
    #[test]
    fn the_blocker_order_is_fixed() {
        let mut m = clean_model();
        m.blocked = true;
        m.digest = "tampered".into();
        let c = confirm_preview(&m, false, Risk::Safe, 0);
        assert_eq!(
            c.blockers,
            vec![
                PreviewConfirmBlocker::StaleModel,
                PreviewConfirmBlocker::SafetyBlocked,
                PreviewConfirmBlocker::NotAcknowledged,
            ]
        );
    }

    /// **顺序即行为**（plan §6-T4）：新 blocker 排在指纹复核与内容复核**之后**、`SafetyBlocked` 之前，
    /// 与 `ForbiddenIncluded` 今天坐的位置同形。四道闸一起造出来，一次点名整条次序。
    #[test]
    fn the_new_blocker_sits_after_content_and_fingerprint_checks() {
        let mut m = high_model();
        // ② 内容复核：项名是 🟢，但地盘落在只上报根里（与 `an_item_..._report_only_root...` 同一种畸形）
        m.items[0].matched_roots = vec![BIN.into()];
        m.blocked = true; // ④ 保护没落地
        m.digest = "tampered".into(); // ① 指纹对不上
        let c = confirm_preview(&m, true, Risk::Safe, 0); // ③ 档位按低了（项里有 🟠）
        assert_eq!(
            c.blockers,
            vec![
                PreviewConfirmBlocker::StaleModel,
                PreviewConfirmBlocker::ForbiddenIncluded,
                PreviewConfirmBlocker::RiskNotAcknowledged,
                PreviewConfirmBlocker::SafetyBlocked,
            ],
            "界面按这个次序念，次序换了就是改了用户看见的那句话"
        );
    }

    /* ---------------- M5-P1 T4：按最高风险档确认 ---------------- */

    /// **本 Task 的那道闸**：预估里有一项已计入的 🟠，按 🟡 档确认 = 拦下，且**没有回执**。
    /// 「没有回执」判两件事：`confirmed == false`，以及这份确认**没带出任何清单与合计** ——
    /// 只断言前者会放过"照样把 ruleIds / totalBytes 填好、只多打一个 blocker 标记"那种形态。
    #[test]
    fn a_high_item_without_high_ack_is_blocked() {
        let m = high_model();
        let c = confirm_preview(&m, true, Risk::Caution, 0);
        assert_eq!(c.blockers, vec![PreviewConfirmBlocker::RiskNotAcknowledged], "{:?}", c.blockers);
        no_receipt(&c);
        assert_eq!(c.acknowledged_risk, Risk::Caution, "按下的档位如实带出来，别偷偷升档");

        // 同一份预估按 🟠 档确认就出得来（闸只拦"按得不够"，不拦含 🟠 的预估本身）
        let ok = confirm_preview(&m, true, Risk::High, 0);
        assert!(ok.confirmed, "{:?}", ok.blockers);
        assert_eq!(ok.rule_ids, vec!["temp".to_string(), "dl".to_string()]);
        assert_eq!(ok.total_bytes, 1_000);

        // 🔴 不在这一格里：`included` 恒不含 🔴，所以它抬不高"要求的档位"，
        // 那条闸归内容复核（`forbidden-included`），不归这一条。
        let mut with_forbidden = model_of(
            vec![finding("temp", Risk::Safe, &[(TEMP_FILE, 100)]), finding("bin", Risk::Forbidden, &[(BIN, 500)])],
            json!([{ "ruleId": "temp" }, { "ruleId": "bin" }]),
        );
        with_forbidden.items.iter_mut().find(|i| i.rule_id == "bin").unwrap().included = true;
        let c = confirm_preview(&with_forbidden, true, Risk::Safe, 0);
        assert!(c.blockers.contains(&PreviewConfirmBlocker::ForbiddenIncluded), "{:?}", c.blockers);
        assert!(!c.blockers.contains(&PreviewConfirmBlocker::RiskNotAcknowledged), "🔴 由内容复核那条管，别在这里重复计一次");
    }

    /// 未勾选的 🟠 行**不许**抬档：判据只看 `included`，否则用户只是看了张清单就被要求按 🟠。
    #[test]
    fn an_unchecked_high_row_does_not_raise_the_required_tier() {
        let m = model_of(
            vec![finding("temp", Risk::Safe, &[(TEMP_FILE, 100)]), finding("dl", Risk::High, &[(r"C:\Users\Kano\Downloads\setup.exe", 900)])],
            json!([{ "ruleId": "temp" }]),
        );
        let dl = m.items.iter().find(|i| i.rule_id == "dl").expect("🟠 那一项要在清单里");
        assert!(!dl.included && !dl.selected, "这一项应当只是列着、没被勾进预估");
        let c = confirm_preview(&m, true, Risk::Safe, 0);
        assert!(c.confirmed, "{:?}", c.blockers);
    }

    /// 🟡 档足够的那一半：只含 🟡 的预估按 🟡 确认照样出得来（不许因为"有黄字"就索要 🟠）。
    #[test]
    fn a_caution_only_model_still_confirms_with_caution_ack() {
        let m = caution_model();
        let c = confirm_preview(&m, true, Risk::Caution, 0);
        assert!(c.confirmed, "{:?}", c.blockers);
        assert!(c.blockers.is_empty(), "{:?}", c.blockers);
        assert_eq!(c.acknowledged_risk, Risk::Caution);
        assert_eq!(c.total_bytes, 200);

        // 反半边（不许过度询问）：只含 🟢 的预估按 🟡 档确认照样过得去 ——
        // 按得**高**不是错，判据只拦"按得不够"。
        let safe = clean_model();
        let over = confirm_preview(&safe, true, Risk::Caution, 0);
        assert!(over.confirmed, "{:?}", over.blockers);
        assert!(over.blockers.is_empty(), "{:?}", over.blockers);
    }

    /// **钉 §3 末尾那句后门**：同一份预估、同一个 `acknowledged`，只换按下的档位 →
    /// 凭据必须是两个串。否则一张 🟢 档领到的旧回执能顶着一份含 🟠 的预估重放。
    #[test]
    fn digest_changes_when_acknowledged_risk_changes() {
        for m in [clean_model(), caution_model(), high_model()] {
            let by_safe = confirm_preview(&m, true, Risk::Safe, 0).digest;
            let by_caution = confirm_preview(&m, true, Risk::Caution, 0).digest;
            let by_high = confirm_preview(&m, true, Risk::High, 0).digest;
            assert_ne!(by_safe, by_caution, "{:?} 下 🟢 档与 🟡 档出了同一个凭据", m.items.len());
            assert_ne!(by_caution, by_high);
            assert_ne!(by_safe, by_high);
            // 两份口径各归各位：模型那一份（`None`）不受档位影响，
            // 它是 `build_preview_model` 写进 `model.digest`、复核 stale 用的那把尺子。
            assert_eq!(by_high.len(), m.digest.len());
            assert_ne!(m.digest, by_high, "回执凭据不等于模型指纹：它多盖了一个档位");
            assert_ne!(m.digest, by_safe);
        }
    }

    /// 被档位拦下的那次确认，出的凭据是**按低档**那一份 —— 它进不了执行侧：
    /// `service.rs` 只在 `confirmed` 时把计划锚进 `confirmations`，锚的键是回执自己的 digest。
    #[test]
    fn the_blocked_receipt_carries_the_low_tier_credential() {
        let m = high_model();
        let blocked = confirm_preview(&m, true, Risk::Caution, 0);
        let allowed = confirm_preview(&m, true, Risk::High, 0);
        assert!(!blocked.confirmed && allowed.confirmed);
        assert_eq!(blocked.digest, preview_digest(&m, Some(Risk::Caution)), "回执如实带的是用户按下的那一档，不是被要求的那一档");
        assert_eq!(allowed.digest, preview_digest(&m, Some(Risk::High)));
        assert_ne!(blocked.digest, allowed.digest, "低档那一张和够档那一张必须是两张不同的纸");
    }

    #[test]
    fn a_refused_selection_still_counts_its_refusals_in_the_receipt() {
        let m = model_of(
            vec![finding("temp", Risk::Safe, &[(TEMP_FILE, 100)]), finding("bin", Risk::Forbidden, &[(BIN, 500)])],
            json!([{ "ruleId": "temp" }, { "ruleId": "bin" }]),
        );
        let c = confirm_preview(&m, true, Risk::Safe, 0);
        assert!(c.confirmed, "🔴 被拒不影响 🟢 那一条的确认");
        assert_eq!(c.rule_ids, vec!["temp".to_string()], "🔴 不许进 ruleIds");
        assert_eq!(c.refusal_count, 1, "被拒的条数要如实带出来");
        assert_eq!(c.total_bytes, 100);
    }
}
