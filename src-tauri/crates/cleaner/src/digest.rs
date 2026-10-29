//! 模型指纹：§17「确认」守住「确认的就是这一份预估」的那把尺子。
//!
//! **只读决策字段** —— `items` 的账目（含每条项的规则文案 `description`，T5a）与 `refusals` 的账目，加上几个合计。
//! `notes`（措辞）/ `territories`（§3.6 底账）/ `default_unselectable_rule_ids`（§3.5 默认勾选）
//! **不参与**：改一句界面说明不该换掉一张 §18 的执行授权凭据。
//!
//! M5-P1 T4 起有**两份口径**，都出自同一个 `preview_digest`，区别只在那一个参数：
//! - `None` —— **模型指纹**：预估产出时还没有任何人确认过，所以没有档位可写。
//!   `build_preview_model` 把它写进 `model.digest`，`confirm_preview` 拿它复核 `stale-model`。
//! - `Some(acknowledged_risk)` —— **回执 / 执行凭据**：把用户按下的档位一起盖进授权串。
//!   少了这一步，「同一份模型、不同档位」出的是同一个 digest，
//!   一张 🟢 档领到的旧回执就能顶着一份含 🟠 的预估重放 —— 那正是 spec §5 要关的后门。
//!
//! M5-P1 T5a 起，每条项的**规则文案** `description` 也在覆盖字段里，而且**两份口径都进**
//! （不是只进 `Some` 那一支）。理由与 T4 给档位的那条一模一样，只是方向换成措辞：
//! `description` 是用户在确认框里读到的「删了会失去什么」那句话，它在**任何人确认之前**就已经在这份模型上了，
//! 所以它属于**模型指纹**那一半。只把它塞进 `Some(tier)` 分支的话，服务端把某条规则的文案改软一次
//! （🟠 那句改成"放心删"），旧回执仍然对得上新模型 —— 那张纸是 §18 唯一的执行通行证，
//! 而它这次没有盖住用户其实没再看见过的措辞。T4 用 `ack=` 关掉的后门，不许从文案这一侧重新打开。
//!
//! 与 `notes` 的区别是**真的**，不是双标：`notes` 是模型级的散文（合计口径说明、提示语），
//! 改它不动的是"同一份账"；`description` 挂在**具体那一条项**上，是那条项的决策依据本身。
//! 所以 `notes` 照旧不进串（`wording_and_default_selection_do_not_enter_the_digest` 钉着），
//! `description` 照旧必须进（`digest_changes_when_an_items_description_changes` 钉着）。

use crate::model::{PreviewModel, PreviewScope};
use deepclean_rules::engine::normalize_key;
use deepclean_rules::types::Risk;
use std::cmp::Ordering;

/// **按 UTF-16 码元**比较，与 JS 的 `<` / `Array#sort()` 逐字同口径。
///
/// 不能用 Rust 默认的 `String::cmp`（UTF-8 字节序）：UTF-8 保的是**码点**序，
/// `U+E000 < U+1F600` ⇒ 码点序里 emoji 在**后**；而 UTF-16 把 U+1F600 拆成代理对 `D83D DE00`，
/// 首个码元 `D83D < E000` ⇒ **JS 的 `<` / `Array#sort()` 把 emoji 排在 U+E000 之前**。
/// （`['\u{1F600}','\u{E000}']` 在 node 里就是这么排的，实测，不是推。）
/// 两套排序只在**补充平面字符**上分叉 —— 也就是"文件名里有 emoji 的那些盘"。
/// 夹具里必须放一个 emoji 路径，否则这条差异测不出来。
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

pub(crate) fn enum_name<T: serde::Serialize>(v: T) -> String {
    serde_json::to_value(v).ok().and_then(|x| x.as_str().map(str::to_string)).unwrap_or_default()
}

/// 决策字段的规范化串 → FNV-1a 双轮 32 bit 十六进制（共 16 位）。
///
/// `acknowledged_risk`：见模块头那两份口径。`None` = 模型指纹（档位还不存在），
/// `Some(t)` = 回执凭据（`t` 进授权串，段名 `ack=<kebab>`，与 TS `previewDigest(model, tier)` 逐字同）。
///
/// 每条项的段：`ruleId:included:bytes:files:scope:paths\u{0}description`。
/// 文案放在**最后一个字段、用 `\u{0}` 隔开**（与 `refusals` 的段同一条姿势）：规则文案是中文散文，
/// 里面出现 `:` 或 `，` 都正常，用 `\u{0}` 而不是再挤一个 `:`，是为了不让一句文案
/// 看起来像是多出来的账目字段。两侧必须逐字同形 —— 这个分隔符本身就是 parity 的一部分。
pub fn preview_digest(m: &PreviewModel, acknowledged_risk: Option<Risk>) -> String {
    let mut items: Vec<&crate::model::PreviewItem> = m.items.iter().collect();
    items.sort_by(|a, b| cmp_utf16(&a.rule_id, &b.rule_id));
    let items = items
        .iter()
        .map(|i| {
            let mut paths: Vec<String> = i.paths.iter().map(|p| normalize_key(&p.path)).collect();
            paths.sort_by(|a, b| cmp_utf16(a, b));
            format!(
                "{}:{}:{}:{}:{}:{}\u{0}{}",
                i.rule_id,
                if i.included { 1 } else { 0 },
                i.bytes,
                i.files,
                match i.scope {
                    PreviewScope::Rule => "rule",
                    PreviewScope::Paths => "paths",
                },
                paths.join(","),
                // M5-P1 T5a：规则文案进串。见文件头那段 —— 只进 `Some` 那一支是后门，不是口径。
                i.description
            )
        })
        .collect::<Vec<_>>()
        .join("|");

    let mut refs: Vec<String> = m
        .refusals
        .iter()
        .map(|r| {
            format!(
                "{}\u{0}{}\u{0}{}\u{0}{}",
                enum_name(r.reason),
                r.rule_id.clone().unwrap_or_default(),
                r.path.as_deref().map(normalize_key).unwrap_or_default(),
                r.bytes
            )
        })
        .collect();
    refs.sort_by(|a, b| cmp_utf16(a, b));

    let mut parts = vec![
        if m.blocked { "B".to_string() } else { "-".to_string() },
        m.total_bytes.to_string(),
        m.total_files.to_string(),
        m.refused_bytes.to_string(),
        m.report_reclaimable_bytes.to_string(),
        m.report_forbidden_bytes.to_string(),
        format!(
            "safe={},caution={},high={},forbidden={}",
            m.risk_breakdown.safe.bytes,
            m.risk_breakdown.caution.bytes,
            m.risk_breakdown.high.bytes,
            m.risk_breakdown.forbidden.bytes
        ),
        items,
        refs.join("|"),
    ];
    // M5-P1 T4：确认按下的档位**是**授权串的一部分（`Some` 那一支）。
    // 段名 `ack=`，取值走 `enum_name`（kebab）⇒ 与 TS 模板串 `` `ack=${tier}` `` 逐字同形。
    if let Some(risk) = acknowledged_risk {
        parts.push(format!("ack={}", enum_name(risk)));
    }
    let src = parts.join("\u{1}");

    format!("{:08x}{:08x}", fnv1a_utf16(&src, 0x811c_9dc5), fnv1a_utf16(&src, 0x0100_0193))
}

/// §18 任务指纹：`authorizedRoot` + 接受路径集合（归一、升序）。
/// 与 TS `executionDigest` 逐字同口径：UTF-16 码元 FNV-1a 双轮。
pub fn execution_digest(root: &str, accepted_paths: &[String]) -> String {
    let mut paths: Vec<String> = accepted_paths.iter().map(|p| normalize_key(p)).collect();
    paths.sort_by(|a, b| cmp_utf16(a, b));
    let body = format!("{}\u{1}{}", normalize_key(root), paths.join("\u{0}"));
    format!("{:08x}{:08x}", fnv1a_utf16(&body, 0x811c_9dc5), fnv1a_utf16(&body, 0x0100_0193))
}

/// FNV-1a，**逐 UTF-16 码元**（JS `s.charCodeAt(i)` 喂的就是这个）。
/// 用 `chars()`（码点）或 `as_bytes()`（UTF-8 字节）在补充平面上都会给出不同的指纹。
fn fnv1a_utf16(s: &str, seed: u32) -> u32 {
    let mut h = seed;
    for u in s.encode_utf16() {
        h ^= u as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::*;

    fn empty_model() -> PreviewModel {
        PreviewModel {
            items: Vec::new(),
            refusals: Vec::new(),
            total_bytes: 0,
            total_files: 0,
            risk_breakdown: RiskBreakdown::default(),
            refused_bytes: 0,
            blocked: false,
            report_reclaimable_bytes: 0,
            report_forbidden_bytes: 0,
            forbidden_roots: Vec::new(),
            report_only_roots: Vec::new(),
            report_exclusion_count: 0,
            territories: Vec::new(),
            default_unselectable_rule_ids: Vec::new(),
            notes: Vec::new(),
            generated_at_ms: 0,
            digest: String::new(),
        }
    }

    fn item(rule_id: &str, bytes: u64) -> PreviewItem {
        PreviewItem {
            rule_id: rule_id.into(),
            name: rule_id.into(),
            // 默认空串：这条 helper 的用例钉的是账目，不是文案。文案那一格由
            // `digest_changes_when_an_items_description_changes` 单独钉（它给非空值）。
            description: String::new(),
            category: deepclean_rules::types::RuleCategory::Temp,
            risk_level: deepclean_rules::types::Risk::Safe,
            clean_strategy: deepclean_rules::types::CleanStrategy::DeleteAll,
            recoverable: true,
            selected: true,
            included: true,
            bytes,
            files: 1,
            scope: PreviewScope::Rule,
            paths: Vec::new(),
            finding_bytes: bytes,
            finding_files: 1,
            sample_truncated: false,
            matched_roots: Vec::new(),
            refusal: None,
        }
    }

    #[test]
    fn the_digest_is_sixteen_hex_digits() {
        let d = preview_digest(&empty_model(), None);
        assert_eq!(d.len(), 16, "两轮 32 bit 各补 8 位：{d}");
        assert!(d.chars().all(|c| c.is_ascii_hexdigit()), "{d}");
    }

    /// **M5-P1 T4 的后门钉子**：确认按下的档位必须进**回执凭据**那一份。
    /// 不进的话，同一份预估按 🟢 档领到的旧回执可以顶着一份含 🟠 的预估重放 ——
    /// 那张纸是 §18 唯一的执行通行证，档位不在串上就等于「用户看见过哪一档」从没被哈希过。
    ///
    /// 两份口径都要有牙，所以三件事分别钉：
    /// - 档位换了 → 凭据换（`Some(caution)` ≠ `Some(high)`，且都不等于 `None`）
    /// - 模型指纹那一支（`None`）逐字不变 → build 写进 `model.digest` 的那一份、
    ///   以及 `preview-parity.json` 现算现比的那一份都不动号
    #[test]
    fn the_credential_digest_covers_the_acknowledged_tier() {
        let m = empty_model();
        let tier_free = preview_digest(&m, None);
        let safe = preview_digest(&m, Some(Risk::Safe));
        let caution = preview_digest(&m, Some(Risk::Caution));
        let high = preview_digest(&m, Some(Risk::High));
        assert_ne!(caution, high, "同一份模型换个档必须出不同的凭据");
        assert_ne!(safe, caution);
        assert_ne!(safe, tier_free);
        assert_ne!(high, tier_free);
        assert_eq!(tier_free, preview_digest(&m, None), "模型指纹那一份仍是纯模型的（build/stale 复核用它）");
    }

    /// 反面对照：`notes`（措辞）换了不该让**任一份**口径动 —— 新段只认 `ack=`，别顺手把说明读进授权串。
    #[test]
    fn the_acknowledged_tier_segment_is_the_only_thing_that_moved() {
        let mut a = empty_model();
        a.notes.push("一句说明".into());
        let mut b = a.clone();
        b.notes.push("两句说明".into());
        assert_eq!(preview_digest(&a, None), preview_digest(&b, None));
        assert_eq!(preview_digest(&a, Some(Risk::High)), preview_digest(&b, Some(Risk::High)));
    }

    /// **M5-P1 T5a 的后门钉子**：每条项的规则文案 `description` 必须进 digest 的覆盖字段，
    /// 而且进的是**模型指纹那一半**（`None` 支）—— 它在任何人确认之前就已经挂在这份模型上了。
    ///
    /// 只把它写进 `Some(tier)` 那一支等于什么：服务端把某条规则的「删了会失去什么」改软一次，
    /// `build_preview_model` 写进 `model.digest` 的那一份**逐字不变**，于是
    /// ① 用户重开预估时 `stale-model` 复核照样通过（他看见的文案已经不是签字那一刻的那份），
    /// ② 旧回执的凭据也照样能对上重算出来的凭据。那就是 T4 用 `ack=` 关掉的后门，
    ///    换成从文案这一侧重新打开 —— 所以这里的判据是 `None` 与 `Some` **两支都必须红**。
    ///
    /// 其余账目一个字节都没动（同一份模型 clone 出来只改一句文案），
    /// 所以这条红只能来自 `description` 进了串 —— 不是来自合计漂移。
    #[test]
    fn digest_changes_when_an_items_description_changes() {
        let mut base = empty_model();
        let mut i = item("windows-temp", 100);
        i.description = "只删 %TEMP% 里的临时文件，应用自己的运行数据不在范围内".into();
        base.items.push(i);
        base.total_bytes = 100;
        base.total_files = 1;
        base.risk_breakdown.safe = PreviewRiskCell { items: 1, files: 1, bytes: 100 };

        // 唯一变量：那一条项的文案。字节、文件数、勾选、档位一个字都没改。
        let mut reworded = base.clone();
        reworded.items[0].description = "放心删，这些都是没用的垃圾文件".into();
        assert_ne!(base.items[0].bytes, 0, "对照组：账目两边相同，红的只能来自文案");
        assert_eq!(base.total_bytes, reworded.total_bytes);
        assert_eq!(base.items[0].rule_id, reworded.items[0].rule_id);

        assert_ne!(
            preview_digest(&base, None),
            preview_digest(&reworded, None),
            "模型指纹必须盖住每条项的文案 —— 不盖就是「服务端改文案、旧回执照样有效」那条后门"
        );
        // `Some` 那一支（真正的执行凭据）也必须跟着换：两份口径共用同一个覆盖集。
        assert_ne!(
            preview_digest(&base, Some(Risk::Safe)),
            preview_digest(&reworded, Some(Risk::Safe)),
            "回执凭据同样必须盖住文案"
        );
        // 反向对照：文案为空 vs 文案为空 ⇒ 不动号（排除"只是多加了一段就全变了"这种假阳性）。
        let mut same_a = base.clone();
        let mut same_b = base.clone();
        same_a.items[0].description = "同一句话".into();
        same_b.items[0].description = "同一句话".into();
        assert_eq!(preview_digest(&same_a, None), preview_digest(&same_b, None));
        assert_eq!(preview_digest(&same_a, Some(Risk::High)), preview_digest(&same_b, Some(Risk::High)));
    }

    #[test]
    fn the_digest_is_stable_across_calls() {
        let m = empty_model();
        assert_eq!(preview_digest(&m, None), preview_digest(&m, None), "同一份模型两次必须逐字相同");
    }

    /// **承重墙**：账目动了指纹必须动 —— 否则「确认绑定在看见的那一份上」是句空话。
    #[test]
    fn changing_the_books_changes_the_digest() {
        let a = empty_model();
        let mut b = empty_model();
        b.items.push(item("x", 100));
        b.total_bytes = 100;
        b.total_files = 1;
        assert_ne!(preview_digest(&a, None), preview_digest(&b, None));

        let mut c = b.clone();
        c.items[0].bytes = 101;
        c.total_bytes = 101;
        assert_ne!(preview_digest(&b, None), preview_digest(&c, None), "改一个字节也要换指纹");
    }

    /// 措辞与「界面默认勾了哪几行」不是账目：改它们不该换掉一张执行授权凭据。
    #[test]
    fn wording_and_default_selection_do_not_enter_the_digest() {
        let a = empty_model();
        let mut b = empty_model();
        b.notes.push("一句新说明".into());
        b.default_unselectable_rule_ids.push("huggingface-cache".into());
        b.territories.push(deepclean_rules::engine::TerritoryFact {
            rule_id: "npm-cache".into(),
            detector_absent: true,
            present: Vec::new(),
            not_scanned: 3,
        });
        b.report_exclusion_count = 7;
        assert_eq!(preview_digest(&a, None), preview_digest(&b, None));
    }

    /// 排序必须按 **UTF-16 码元**：emoji（补充平面）上 Rust 默认的 UTF-8 字节序会给出不同结果。
    #[test]
    fn utf16_ordering_differs_from_byte_ordering_on_supplementary_planes() {
        let emoji = "\u{1F600}"; // U+1F600，UTF-16 是代理对 D83D DE00
        let high_bmp = "\u{E000}"; // U+E000，落在代理区之后
        assert_eq!(cmp_utf16(emoji, high_bmp), Ordering::Less, "UTF-16 里代理对 < U+E000");
        assert_eq!(emoji.cmp(high_bmp), Ordering::Greater, "而 UTF-8 字节序恰好相反");
    }

    #[test]
    fn the_digest_notices_a_path_swap_between_two_items() {
        let mut a = empty_model();
        let mut i1 = item("a", 1);
        i1.scope = PreviewScope::Paths;
        i1.paths = vec![PricedPath { path: r"C:\x".into(), size: 1 }];
        let mut i2 = item("b", 1);
        i2.scope = PreviewScope::Paths;
        i2.paths = vec![PricedPath { path: r"C:\y".into(), size: 1 }];
        a.items = vec![i1, i2];
        let mut b = a.clone();
        b.items.swap(0, 1);
        assert_eq!(preview_digest(&a, None), preview_digest(&b, None), "items 内部按 ruleId 排序，输入顺序不该影响指纹");
    }
}
