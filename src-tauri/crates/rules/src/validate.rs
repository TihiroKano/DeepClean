//! 声明层闸门：一条规则在**被评估之前**就要被判形状。**逐条与 TS `engine.ts::validateRuleSet` 同口径。**
//!
//! **为什么形状闸是安全的一部分**：一条被判不合格的规则会被整条拒掉 —— 它的地盘从可回收合计里
//! **静默消失**（不报错、只是数字变小）；反过来，一条**该被拒却没被拒**的规则会把
//! 远大于自己应得的地盘端走。两个方向都坏，所以两套实现必须同判据。
//!
//! 未知字段/缺字段/类型不对由 `serde` 的 `deny_unknown_fields` + 强类型承担（见 `types.rs` 的测试）
//! —— 一条 Rust `Rule` **在构造上不可能**字段缺失或类型错。TS 那边这一段是运行时的
//! `ruleShapeProblems`（它的规则来自 JSON）。所以本模块只在**两边共有**的语义判据上对齐：
//!
//! 1. `invalid-shape` —— 路径模板必须绝对（`%VAR%` 开头或盘符绝对），且不能为空。
//! 2. `pattern-not-leaf` —— 路径以 `*` / `?` 收尾。
//! 3. `forbidden-root` —— 解析出来的具体路径落在 §16 🔴 禁止根之内。
//! 4. `ancestor-of-protected` —— 解析出来的具体路径是某条禁止根 / 只上报根的**祖先**。
//! 5. `report-only-root` —— 非 🔴 规则的具体路径落在只上报根之内。
//! 6. `broad-container` —— 裸容器变量，或最后一段是宽容器名。
//! 7. `ancestor-of-protected`（规则之间）—— 本规则的段序列是**别条规则**的严格前缀。
//!
//! M5-P1 T1 追加（顺序：invalid-shape 之后、逐路径判据之前；TS 侧同序）：
//! 8. `ambiguous-leaf-mode` —— `leafDirs` 与 `leafFiles` 同时给出（§10 裁定 1，两种采集根语义混用）。
//! 9. `inadequate-fence` —— 有 `leaf*` 却没 `scopeFence`；或围栏根形状不合法 / `denyRoots`
//!    覆盖不足（必须 ⊇ 禁止根全集 ∪ `FENCE_MINIMUM_DENY_PATTERNS`）。
//! 10. `container-without-predicate` —— 带了围栏却没有 leaf 判据的容器入口。
//!     三者齐全（leaf* + 合法围栏）时 `paths` 进**容器入口模式**：7 与 6/2 的地盘判据对该规则放行。
//!     **`validate_fence` 本身不走 `BroadContainer`/`PatternNotLeaf`** —— 这个不对称是刻意的，
//!     理由逐字写在该函数注释里（plan §4.3），"顺手统一"会让围栏静默失效。
//!
//! M5-P2 P2-T3 追加（plan §2.5，仍然只用到**已有**的三条 `ProblemReason`，不新增成员）：
//! 11. `ambiguous-leaf-mode` —— `requiresAbsentAppFact` 与 `leafDirs`/`leafFiles` 混给。
//!     机器事实闸自己就是一种采集模式（采集根 = 入口的直属子目录），两种采集根语义混在一条规则里
//!     与 §10 裁定 1 是同一种病，所以复用同一条理由。
//! 12. `inadequate-fence` —— 带 `requiresAbsentAppFact` 却没带 `scopeFence`。
//!     通过这两条之后，带它的规则与 leaf 规则一样进**容器入口模式**（`paths` 允许停在
//!     `%LOCALAPPDATA%` 这一类容器上 —— spec §3 3.5「顶层一项」要的就是这个）。
//!
//! 判据顺序固定、每条规则只报**第一个**命中的问题（与 TS 的 `break` 一致）：顺序不同会让
//! 同一条规则在两套实现里"因为不同的理由被拒"，而记录页/预览要按理由分措辞。
//!
//! ### 两处**有意与 TS 保持一致**的取舍（都是 TS 的缺口，不是本模块的）
//!
//! · **没有重号闸**：TS 的 `validateRuleSet` 不查重复 ruleId，Rust 侧原先有一条 `DuplicateId`
//!   判据。为了"同一输入两套实现同判"，这里把它移除了 —— 留一条只有一侧有的闸，
//!   下一个人很快就会遇到"Rust 拒了 TS 没拒"，而那时没人能判断该信谁。
//!   代价如实记着：**规则表重号在两套实现里都不被拦**（`claimed` 表按 ruleId 记账，
//!   重号会让同一文件被两条规则各计一次）。这是**共同缺口**，要补就两边一起补。
//! · **具体路径的比较用解析后的绝对值**（不是模板字面量）：`%WINDIR%` 与 `%SYSTEMDRIVE%\Windows`
//!   字面不同名，解析出来才知道它们都套住了 `System32`。TS 就是这么判的。

use crate::env::{
    is_forbidden_path, path_is_under, resolve_pattern, segs_of, tokens_to_path, RuleEnv,
};
use crate::matcher::is_strict_territory_prefix;
use crate::types::{
    Rule, Risk, RuleScopeFence, BROAD_LEAF_NAMES, CONTAINER_VARS, FENCE_MINIMUM_DENY_PATTERNS,
};
use serde::Serialize;

/// 拒绝理由。**名字与 TS `ExclusionReason` 的对应成员逐字相同**（报告里要按它分措辞）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProblemReason {
    /// §15 形状不合格（本模块只管"路径必须绝对/不能为空"那一半）
    InvalidShape,
    /// 路径以通配收尾，落不到具体叶子目录（§28 原则四）
    PatternNotLeaf,
    /// 规则路径落在 §16 🔴 禁止路径之内
    ForbiddenRoot,
    /// 规则路径是禁止根 / 只上报根 / 别条规则地盘的祖先（§28 原则四）
    AncestorOfProtected,
    /// 非 🔴 规则把只上报根当成了自己的地盘
    ReportOnlyRoot,
    /// 裸容器变量，或最后一段是宽容器名
    BroadContainer,
    /// M5-P1 T1：容器入口没有配套的 leaf 形状判据（带围栏但没带 `leaf*`，spec §2.3）
    ContainerWithoutPredicate,
    /// M5-P1 T1：`leaf*` 判据缺围栏，或围栏覆盖不足 / 根形状不合法（plan §0.1 —— 围栏是这块能力的全部风险所在）
    InadequateFence,
    /// M5-P1 T1：`leafDirs` 与 `leafFiles` 同时给出 = 两种采集根语义混用（§10 裁定 1）
    AmbiguousLeafMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleProblem {
    pub rule_id: String,
    /// 出问题的那个路径模板（或规则 id —— 规则间的祖先判据没有单一"出问题的路径"）
    pub path: String,
    pub reason: ProblemReason,
    pub detail: String,
}

/// `validate_rule_set` 的回执。
#[derive(Debug, Clone, Default)]
pub struct Validation {
    /// 通过校验的规则在**输入切片里的下标**（不是规则 id：id 可能重复，下标不会）。
    pub valid: Vec<usize>,
    pub problems: Vec<RuleProblem>,
}

fn is_absolute_template(p: &str) -> bool {
    if p.starts_with('%') {
        return true;
    }
    let b = p.as_bytes();
    b.len() >= 3 && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// 把禁止 / 只上报模板解析成具体根。**与 TS `resolvePatterns` 同口径**：
/// 解出具体路径就用它；只有字面前缀（带通配）就用前缀；两者都没有 = 解不出来。
///
/// **带收尾分隔符的模板（`%PROGRAMFILES%\`）走 `concrete` 那一支**：`tokens_to_path` 在
/// `%VAR%` 只为唯一一段时不补尾分隔符（`%LOCALAPPDATA%` → `C:\Local`，这是采集入口要的形状），
/// 而**禁止根**要的是 `C:\Program Files`（不带尾分隔符）—— `path_is_under` 按段边界判，
/// 带不带尾分隔符结论相同，于是这里统一裁掉，免得同一个根在报告里出现两种写法。
fn resolve_roots(patterns: &[String], env: &RuleEnv) -> (Vec<String>, Vec<String>) {
    let mut roots = Vec::new();
    let mut unresolved = Vec::new();
    for p in patterns {
        let r = resolve_pattern(p, env);
        let cut = |s: String| -> String {
            let mut s = s;
            while s.len() > 3 && (s.ends_with('\\') || s.ends_with('/')) {
                s.pop();
            }
            s
        };
        match (r.concrete, r.base) {
            (Some(c), _) => roots.push(cut(c)),
            (None, Some(b)) => roots.push(cut(b)),
            (None, None) => unresolved.push(p.clone()),
        }
    }
    (roots, unresolved)
}

/// 围栏根 → 解析后的具体根。`deny=true` 时允许**恰好一个收尾通配段**（`%WINDIR%\*` —— deny 的
/// 语义天然是"整棵子树"）；通配出现在中间、或 allow 侧出现通配，一律拒。
/// 解不出变量、非绝对、解析成盘符根 —— 都返回 Err（理由串只给人看，判定看 `InadequateFence`）。
///
/// `pub(crate)`：评估层（`engine.rs::begin_rule`）要用**同一把**解析把围栏落成具体根 ——
/// 声明层与评估层各写一份"这个根解析成什么"就是两套口径，而围栏漏的那一边是**多删**方向。
pub(crate) fn fence_root(p: &str, env: &RuleEnv, deny: bool) -> Result<String, String> {
    if !is_absolute_template(p) {
        return Err(format!("围栏根 {p} 必须以 %VAR% 或盘符绝对路径开头"));
    }
    let mut segs = segs_of(p);
    if segs.last().is_some_and(|s| deny && (s == "*" || s == "?")) {
        segs.pop();
    }
    if segs.is_empty() {
        return Err(format!("围栏根 {p} 只有一个通配段，落不到具体目录"));
    }
    for s in &segs {
        if s.contains('*') || s.contains('?') {
            return Err(if deny {
                format!("围栏根 {p} 的通配只许作收尾整段（`%WINDIR%\\*` 这种），中间段带通配指不到具体子树")
            } else {
                format!("围栏根 {p} 不许含通配字符：allowRoots 是采集入口，必须落到具体目录")
            });
        }
    }
    let res = resolve_pattern(&tokens_to_path(&segs), env);
    if let Some(v) = &res.unresolved_var {
        return Err(format!("围栏根 {p} 的 %{v}% 在注入 env 里解析不出来 —— 围栏不许有解不出来的根"));
    }
    match res.concrete.clone().or_else(|| res.base.clone()) {
        None => Err(format!("围栏根 {p} 解析不出具体路径")),
        Some(path) => {
            let pseges = segs_of(&path);
            if pseges.len() == 1
                && pseges[0].len() == 2
                && pseges[0].as_bytes()[0].is_ascii_alphabetic()
                && pseges[0].as_bytes()[1] == b':'
            {
                return Err(format!("围栏根解析到盘符根 {path}：围栏不许落在盘符根上"));
            }
            Ok(path)
        }
    }
}

/// `scopeFence` 的结构闸。
///
/// ⚠️ **§4.3 的不对称是刻意的，不许"顺手统一"**：本函数**不走** `BroadContainer` /
/// `PatternNotLeaf` 那两条**地盘**判据 —— 围栏天然就要点名 `programdata`、
/// `program files (x86)` 这些容器（它们就在 `BROAD_LEAF_NAMES` 里），复用地盘校验会让
/// `denyRoots: ["%PROGRAMDATA%"]` 被自己拒掉，围栏**静默失效**（下一个人只会看到
/// "规则带着围栏却还是吃到了 Program Files"，或者更坏：围栏字段默默不起作用）。
/// 它只查三件事：解析后绝对、非盘符根、通配形态（allow 不许、deny 只许收尾整段）——
/// 再加一条覆盖判据：`denyRoots` 必须 ⊇ 禁止根全集 ∪ `FENCE_MINIMUM_DENY_PATTERNS`。
fn validate_fence(fence: &RuleScopeFence, env: &RuleEnv, forbidden_patterns: &[String]) -> Option<String> {
    if fence.allow_roots.is_empty() {
        return Some("围栏必须有 allowRoots：leaf 采集根的边界不能是空的".into());
    }
    let mut deny_roots = Vec::new();
    for p in &fence.deny_roots {
        match fence_root(p, env, true) {
            Ok(r) => deny_roots.push(r),
            Err(d) => return Some(d),
        }
    }
    for p in &fence.allow_roots {
        if let Err(d) = fence_root(p, env, false) {
            return Some(d);
        }
    }
    for req in forbidden_patterns.iter().map(String::as_str).chain(FENCE_MINIMUM_DENY_PATTERNS.iter().copied()) {
        // 必需覆盖项自己解析不出来 = 覆盖无法证明 = 拒（fail-closed，与"禁止根解不出来出 safetyBlocked"同方向）
        let covered = match fence_root(req, env, true) {
            Err(d) => return Some(format!("围栏覆盖判据无法解析必需项 {req}：{d}")),
            Ok(r) => deny_roots.iter().any(|d| path_is_under(&r, d)),
        };
        if !covered {
            return Some(format!(
                "denyRoots 必须覆盖 {req}：禁止根全集 + %WINDIR%\\* + %PROGRAMFILES%\\* + %SYSTEMDRIVE%\\Program Files (x86)\\* + %PROGRAMDATA%\\Microsoft\\Windows Defender\\* + %LOCALAPPDATA%\\Programs\\* 是围栏的地板（spec §2.3 / plan §4.2；第四条来自 T6 真机对账，第五条来自 cleanup-rules.md §6 R-DENY-INSTALLDIR）"
            ));
        }
    }
    None
}

/// 一条规则 set 的形状/结构把关。**判据顺序固定**，每条规则只报第一个命中的问题。
///
/// M5-P1 T1 起，`invalid-shape` 之后、逐路径判据之前插入三道**扫描器/围栏闸**（顺序即行为，
/// TS `engine.ts::validateRuleSet` 逐条同序）：
/// ① `AmbiguousLeafMode`（leafDirs+leafFiles 混给，§10 裁定 1）
/// ② `InadequateFence`（有 leaf* 没围栏，spec §2.3）
/// ③ 围栏在场 → `validate_fence`（结构 + 覆盖，不过则同样 `InadequateFence`）
/// 通过 ①–③ 后 `leaf* + scopeFence` 齐全 = **容器入口模式**：`paths` 降级为遍历入口/围栏锚点，
/// 不再是地盘叶子 —— ②宽容器/通配收尾与⑦规则间祖先对**该规则**放行（真正的边界由围栏根 +
/// basename 名单在评估层守，那是 T2）。没有 leaf* 但带了围栏的规则：非叶子路径改报
/// `ContainerWithoutPredicate`；**两者都没有的旧规则，判据与理由串逐字不变**（回归轴）。
pub fn validate_rule_set(
    rules: &[Rule],
    env: &RuleEnv,
    forbidden_patterns: &[String],
    report_only_patterns: &[String],
) -> Validation {
    let (forbidden_roots, _f_unresolved) = resolve_roots(forbidden_patterns, env);
    let (report_only_roots, _r_unresolved) = resolve_roots(report_only_patterns, env);

    let mut valid = Vec::new();
    let mut problems: Vec<RuleProblem> = Vec::new();

    for (i, r) in rules.iter().enumerate() {
        let mut push = |path: String, reason: ProblemReason, detail: String| {
            problems.push(RuleProblem { rule_id: r.id.clone(), path, reason, detail });
        };

        // ① 形状：路径必须绝对、不能为空（字段缺失/类型错在 Rust 侧由 serde 拦，构造不出来）
        if r.paths.is_empty() {
            push(r.id.clone(), ProblemReason::InvalidShape, "§15 形状不合格：paths 不能为空".into());
            continue;
        }
        if let Some(bad) = r.paths.iter().find(|p| !is_absolute_template(p)) {
            push(
                bad.clone(),
                ProblemReason::InvalidShape,
                format!("§15 形状不合格：路径 {bad} 必须以 %VAR% 或盘符绝对路径开头"),
            );
            continue;
        }

        // ── M5-P1 T1 扫描器/围栏闸（顺序即行为，与 TS `engine.ts::validateRuleSet` 逐条同序）──
        let has_leaf_dirs = !r.scanner.leaf_dirs.is_empty();
        let has_leaf_files = !r.scanner.leaf_files.is_empty();
        // M5-P2 P2-T3（plan §2.5）：机器事实闸是**第三种采集模式**，与 `leaf*` 那两种互斥。
        let app_fact_mode = r.requires_absent_app_fact == Some(true);
        if has_leaf_dirs && has_leaf_files {
            push(
                r.id.clone(),
                ProblemReason::AmbiguousLeafMode,
                "leafDirs 与 leafFiles 互斥（§10 裁定 1）：前者收\"名字像缓存/更新目录的子树\"，后者收\"任意深度名字像轮转件的文件\"，混在一条规则里产出无法解释的命中".into(),
            );
            continue;
        }
        if app_fact_mode && (has_leaf_dirs || has_leaf_files) {
            push(
                r.id.clone(),
                ProblemReason::AmbiguousLeafMode,
                format!(
                    "requiresAbsentAppFact 与 {} 互斥（plan §2.5）：机器事实闸自己就是一种**采集模式** —— \
                     采集根 = 入口目录的直属子目录、逐格查表、只有 Absent 才收；leaf* 的采集根由 basename \
                     名单在任意深度命中决定。两者同时给就没有\"这一层是谁定的\"了：同一条路径既能被表批准、\
                     又能被名单命中，字节算在哪一档说不清，而这条规则后面接的是删除",
                    if has_leaf_dirs { "leafDirs" } else { "leafFiles" }
                ),
            );
            continue;
        }
        let has_leaf = has_leaf_dirs || has_leaf_files;
        let fence = r.scanner.scope_fence.as_ref();
        if has_leaf && fence.is_none() {
            push(
                r.id.clone(),
                ProblemReason::InadequateFence,
                "leaf* 采集根必须同时声明 scopeFence：无围栏的 basename 判据（如 Cache）会任意深度吃到 Program Files 里应用自带运行时资源（plan §0.1）".into(),
            );
            continue;
        }
        if app_fact_mode && fence.is_none() {
            push(
                r.id.clone(),
                ProblemReason::InadequateFence,
                "requiresAbsentAppFact 的规则必须带 scopeFence：它的采集根是入口目录的**全部直属子目录**，\
                 没有围栏就等于让一张机器事实表去批准整个用户目录树（%LOCALAPPDATA% 底下几百个目录逐格问表）—— \
                 表错一格，收进来的就是别人家的运行时资源（plan §2.5「带它的规则必须容器入口 + 围栏」）".into(),
            );
            continue;
        }
        if let Some(f) = fence {
            if let Some(detail) = validate_fence(f, env, forbidden_patterns) {
                push(r.id.clone(), ProblemReason::InadequateFence, detail);
                continue;
            }
        }
        // leaf 判据 + 围栏齐全 = 容器入口模式：`paths` 是遍历入口而不是地盘叶子，
        // ②通配收尾 / ⑥宽容器 / ⑦规则间祖先这三条**地盘**判据对它放行（边界由围栏 + basename
        // 名单在评估层守，T2 落地"不枚举"）。缺任一项判据照旧；没 leaf 只带围栏的容器入口
        // 不豁免 —— 它换成 ContainerWithoutPredicate 这个更准的理由（拒整条这一点两边一致）。
        //
        // M5-P2 P2-T3：`requiresAbsentAppFact` 走的是**同一个容器入口模式**（`paths` 就是
        // `%LOCALAPPDATA%` 这一类容器，候选是它们的直属子目录 —— spec §3 3.5 那句「顶层一项」），
        // 所以豁免条件从"有 leaf"变成"有 leaf **或** 带机器事实闸"。上面两条闸已经保证
        // 这里不会同时为真（混用 = AmbiguousLeafMode），`has_leaf && app_fact_mode` 进不到这一行。
        let container_mode = (has_leaf || app_fact_mode) && fence.is_some();
        // 有围栏但没 leaf 判据的"容器入口"类拒绝 → 换用更准的 ContainerWithoutPredicate；
        // 围栏与 leaf 都没有的旧规则，判据名逐字不变（回归轴：既有测试钉着 broad-container/pattern-not-leaf）。
        let pattern_not_leaf_reason = if fence.is_some() {
            ProblemReason::ContainerWithoutPredicate
        } else {
            ProblemReason::PatternNotLeaf
        };
        let broad_container_reason = if fence.is_some() {
            ProblemReason::ContainerWithoutPredicate
        } else {
            ProblemReason::BroadContainer
        };

        let mut rejected = false;
        for pattern in &r.paths {
            if rejected {
                break;
            }
            let tokens = segs_of(pattern);
            let last = tokens.last().cloned().unwrap_or_default();

            // ② 以通配收尾
            if !container_mode && (last == "*" || last == "?") {
                push(
                    pattern.clone(),
                    pattern_not_leaf_reason,
                    if fence.is_some() {
                        "容器入口没有配套的 leaf 形状判据：围栏只收窄\"在哪找\"，判据必须落在 basename 上（spec §2.3）".to_string()
                    } else {
                        "路径以通配收尾，落不到具体叶子目录（§28 原则四）".to_string()
                    },
                );
                rejected = true;
                break;
            }

            // ③④⑤ 只在**字面路径**（无通配）且变量都解析得出来时才算 ——
            //    通配展开出来的具体地盘由评估层逐条把关（那边才知道树上真有什么）
            let res = resolve_pattern(pattern, env);
            if let (Some(concrete), Some(_)) = (res.concrete.clone(), res.base.clone()) {
                if let Some(hit) = is_forbidden_path(&concrete, &forbidden_roots) {
                    push(
                        pattern.clone(),
                        ProblemReason::ForbiddenRoot,
                        format!("规则路径落在 §16 🔴 禁止路径 {hit} 之内，声明层即不可达"),
                    );
                    rejected = true;
                    break;
                }
                if let Some(swept) = forbidden_roots.iter().find(|f| {
                    path_is_under(f, &concrete) && crate::engine::normalize_key(f) != crate::engine::normalize_key(&concrete)
                }) {
                    // **容器入口模式例外（CLEANUP-RULES §6 落地）**：这一类规则的 `paths` 是**遍历入口**
                    // 而不是地盘（真正的边界是 `scopeFence` 的 allowRoots/denyRoots），所以"入口套住了
                    // 一条禁止根"不等于"会扫走它" —— `%LOCALAPPDATA%` 底下现在有 `Packages` 这条禁止根，
                    // 而 `app-cache-data` 那几类恰恰要在这棵树上按 basename 找叶子，围栏会在枚举之前
                    // 把禁止根那几棵子树整棵拒掉（`engine.rs::fence_blocks`）。
                    // 非容器模式下这条判据逐字不变：那里 `paths` 就是地盘，套住禁止根 = 会扫走它。
                    if !container_mode {
                        push(
                            pattern.clone(),
                            ProblemReason::AncestorOfProtected,
                            format!("规则路径 {concrete} 是禁止路径 {swept} 的祖先，宽容器清理会顺手扫走它"),
                        );
                        rejected = true;
                        break;
                    }
                }
                if r.risk_level != Risk::Forbidden {
                    if let Some(ro) = is_forbidden_path(&concrete, &report_only_roots) {
                        push(
                            pattern.clone(),
                            ProblemReason::ReportOnlyRoot,
                            format!("规则路径落在只上报根 {ro} 之内 → 该目录只许报告占用、不许被非 🔴 规则清理，声明层即拒绝"),
                        );
                        rejected = true;
                        break;
                    }
                }
            }

            // ⑥ 裸容器变量 / 宽容器收尾（容器入口模式下放行：paths 是遍历入口，边界由围栏守）
            let head = tokens.first().cloned().unwrap_or_default();
            let bare = tokens.len() == 1;
            let var_name = if head.len() >= 3 && head.starts_with('%') && head.ends_with('%') {
                Some(head[1..head.len() - 1].to_uppercase())
            } else {
                None
            };
            if !container_mode {
                if bare {
                    if let Some(v) = &var_name {
                        if CONTAINER_VARS.contains(&v.as_str()) {
                            push(
                                pattern.clone(),
                                broad_container_reason,
                                if fence.is_some() {
                                    format!("容器入口 %{v}% 没有配套的 leaf 形状判据：它本身是容器目录，围栏不能替代判据（spec §2.3）")
                                } else {
                                    format!("%{v}% 本身是容器目录，不构成叶子级清理范围（§28 原则四）")
                                },
                            );
                            rejected = true;
                            break;
                        }
                    }
                }
                let last_lower = last.to_lowercase();
                if BROAD_LEAF_NAMES.contains(&last_lower.as_str()) {
                    push(
                        pattern.clone(),
                        broad_container_reason,
                        if fence.is_some() {
                            format!("路径落在宽容器「{last}」上且没有 leaf 判据：围栏只收窄范围，判据必须落在 basename 上（spec §2.3）")
                        } else {
                            format!("路径落在宽容器「{last}」上，清理范围必须精确到叶子路径（§28 原则四）")
                        },
                    );
                    rejected = true;
                    break;
                }
            }
        }
        if rejected {
            continue;
        }

        // ⑦ 规则之间的地盘包含：本规则的段序列是别条的**严格前缀** → 本规则不算精确到叶子。
        //    容器入口模式跳过 —— 它的 `paths` 是围栏锚点而不是地盘，T3 六条的
        //    `%LOCALAPPDATA%` 入口与既有 15 条的地盘重叠是设计使然（claimed 先声明者计账兜双计）。
        if !container_mode {
            let other = rules.iter().find(|b| {
                b.id != r.id
                    && r.paths.iter().any(|rp| {
                        let a = segs_of(rp);
                        b.paths.iter().any(|bp| is_strict_territory_prefix(&a, &segs_of(bp)))
                    })
            });
            if let Some(other) = other {
                push(
                    r.paths.first().cloned().unwrap_or_else(|| r.id.clone()),
                    ProblemReason::AncestorOfProtected,
                    format!("本规则的地盘整体套住了规则 {}，宽容器会顺手扫走别家叶子（§28 原则四）", other.id),
                );
                continue;
            }
        }

        valid.push(i);
    }

    Validation { valid, problems }
}

/// §3.5 的**唯一派生处**：哪些规则的字节不进「一键全选」的默认勾选。
///
/// 只认 `=== true`（与探测器那张表只认 `=== false` 同一个方向）：
/// 一个脏值不该顺手摘掉一条规则，也不该因为漏判把模型文件留在默认勾选里。
pub fn default_unselectable_rule_ids(rules: &[Rule]) -> std::collections::BTreeSet<String> {
    rules
        .iter()
        .filter(|r| matches!(r.excluded_from_default_selection, Some(true)))
        .map(|r| r.id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin::builtin_rules;
    use crate::types::{FORBIDDEN_PATH_PATTERNS, REPORT_ONLY_ROOT_PATTERNS};

    fn env() -> RuleEnv {
        let mut m = RuleEnv::new();
        m.insert("SYSTEMDRIVE".into(), "C:".into());
        m.insert("WINDIR".into(), r"C:\Windows".into());
        m.insert("TEMP".into(), r"C:\Temp".into());
        m.insert("LOCALAPPDATA".into(), r"C:\Local".into());
        // CLEANUP-RULES §6 补齐后的禁止根模板引用的其余变量（与 engine.rs 的 `leaf_env` 同一套值：
        // `C:\Roam` / `C:\Local` 是这套夹具的写法，换成真机形状会让按绝对路径比的判据静默失效）。
        m.insert("PROGRAMFILES".into(), r"C:\Program Files".into());
        m.insert("PROGRAMDATA".into(), r"C:\ProgramData".into());
        m.insert("USERPROFILE".into(), r"C:\Users\Kano".into());
        m.insert("APPDATA".into(), r"C:\Roam".into());
        m
    }

    fn forbidden() -> Vec<String> {
        FORBIDDEN_PATH_PATTERNS.iter().map(|s| s.to_string()).collect()
    }
    fn report_only() -> Vec<String> {
        REPORT_ONLY_ROOT_PATTERNS.iter().map(|s| s.to_string()).collect()
    }

    fn check(rules: &[Rule]) -> Validation {
        validate_rule_set(rules, &env(), &forbidden(), &report_only())
    }

    /// 围栏单测用的合成 env：8 个 `RULE_ENV_KEYS` 全给（`PROGRAMFILES` 是 §4.1 补进来的第 8 键）。
    fn fence_env() -> RuleEnv {
        let mut m = env();
        m.insert("APPDATA".into(), r"C:\Roam".into());
        m.insert("PROGRAMDATA".into(), r"C:\ProgramData".into());
        m.insert("PROGRAMFILES".into(), r"C:\Program Files".into());
        m.insert("USERPROFILE".into(), r"C:\Users\Kano".into());
        m
    }

    /// 一条「够用」的围栏：denyRoots 覆盖禁止根全集 + 地板。
    ///
    /// 直接展开 `FORBIDDEN_PATH_PATTERNS` 而**不手抄**：这张表在 CLEANUP-RULES §6 之后
    /// 从 6 条涨到 17 条，手抄清单每涨一次就要跟着改，忘了就是一片 `inadequate-fence`
    /// （2026-10-19 实测：validate.rs 五条用例集体转红）。展开让"表涨了、夹具没跟"不可能发生。
    ///
    /// ⚠️ 能在这里展开的前提：**FORBIDDEN 里剩下的每一条都不是 `%LOCALAPPDATA%` / `%APPDATA%` /
    /// `%PROGRAMDATA%` 的后代叶子** —— 那些已经移到 `REPORT_ONLY_ROOT_PATTERNS`（放进禁止根
    /// 会让本围栏的 allowRoots 变成"受保护路径的祖先"，评估层按 `AncestorOfProtected`
    /// 把规则判死）。所以这张表将来再加条目时，**只有"不住在那三个根下面"的才能进 FORBIDDEN**，
    /// 这条约束由 `engine.rs` 的 leaf 用例与 `builtin.rs` 的围栏覆盖用例共同看着。
    fn full_fence() -> RuleScopeFence {
        let mut deny: Vec<String> = FORBIDDEN_PATH_PATTERNS.iter().map(|s| s.to_string()).collect();
        for p in FENCE_MINIMUM_DENY_PATTERNS {
            if !deny.iter().any(|d| d == p) {
                deny.push(p.to_string());
            }
        }
        RuleScopeFence {
            allow_roots: vec!["%LOCALAPPDATA%".into()],
            deny_roots: deny,
        }
    }

    fn leaf_rule(id: &str, dirs: &[&str], files: &[&str], fence: Option<RuleScopeFence>, paths: &[&str]) -> Rule {
        let mut r = mk(id, Risk::Caution, paths);
        r.scanner.leaf_dirs = dirs.iter().map(|s| s.to_string()).collect();
        r.scanner.leaf_files = files.iter().map(|s| s.to_string()).collect();
        r.scanner.scope_fence = fence;
        r
    }

    fn check_env(rules: &[Rule], e: &RuleEnv) -> Validation {
        validate_rule_set(rules, e, &forbidden(), &report_only())
    }

    fn mk(id: &str, risk: Risk, paths: &[&str]) -> Rule {
        let mut r = builtin_rules()[0].clone();
        r.id = id.into();
        r.risk_level = risk;
        r.paths = paths.iter().map(|s| s.to_string()).collect();
        r
    }

    /// 内置表必须整体干净。**M5-P1 T3a 起这条用 `fence_env()`（八个 `RULE_ENV_KEYS` 全给）**：
    /// 表尾三条是容器入口规则，它们的围栏必须能点名 `%PROGRAMFILES%\*`（plan §4.1 加进来的第 8 键）。
    /// 拿只有四个键的 `env()` 跑这张表，三条新规则会因为"围栏根解析不出来"被 fail-closed 拒掉 ——
    /// 那时 `valid.len()` 仍是 15，这条回归轴就绿在一条**根本没上线**的规则上（假绿）。
    /// 生产侧本来就是八个键全注入（`src-tauri/src/service.rs::rule_env_from` 遍历 `RULE_ENV_KEYS`），
    /// 所以这里要复现的是生产的形状。
    /// M5-P1 T3b-ii 起条数 20 → 21（追加的那条 🟠 地盘是 `%USERPROFILE%\Downloads`，不新增对 env 的要求）。
    /// M5-P2 P2-T4 起 21 → 22（第 22 条 `orphan-app-data` 用的还是那三条容器根 + 同一份围栏根，
    /// 对 env 的要求与表尾那几条逐字相同 —— 八个 `RULE_ENV_KEYS` 全给才过得去）。
    /// M6 起 22 → 23（第 23 条 `gpu-driver-leftovers` 是显式路径模板族：`%SYSTEMDRIVE%` 与
    /// `%PROGRAMDATA%` 都在八个键里，同样不新增对 env 的要求）。
    #[test]
    fn the_builtin_table_has_no_shape_problems() {
        let v = check_env(&builtin_rules(), &fence_env());
        assert!(v.problems.is_empty(), "内置表必须干净，实得 {:?}", v.problems);
        assert_eq!(v.valid.len(), 23);
        // 干净的意思是"二十三条全部上线"，不是"二十一条上线、一条静默被拒"。
        // 被拒的规则在 `valid` 里缺席而**不报错**，所以名单要逐字点名。
        let got: Vec<usize> = v.valid.clone();
        assert_eq!(got, (0..23).collect::<Vec<usize>>(), "valid 必须是全表下标");
    }

    #[test]
    fn a_relative_path_is_rejected() {
        let v = check(&[mk("x", Risk::Safe, &[r"AppData\Local\Temp"])]);
        assert_eq!(v.problems[0].reason, ProblemReason::InvalidShape);
        assert!(v.valid.is_empty());
    }

    #[test]
    fn a_wildcard_tail_is_rejected() {
        let v = check(&[mk("x", Risk::Safe, &[r"%LOCALAPPDATA%\*"])]);
        assert_eq!(v.problems[0].reason, ProblemReason::PatternNotLeaf);
    }

    /// **承重墙**：非 🔴 规则踩到只上报根（回收站）必须被拒。
    /// 历史上唯一的屏障是「`recycle-bin` 恰好排在规则表第 6」，顺序依赖不是防护。
    #[test]
    fn a_non_forbidden_rule_claiming_the_recycle_bin_is_rejected() {
        let v = check(&[mk("greedy", Risk::Safe, &[r"%SYSTEMDRIVE%\$Recycle.Bin"])]);
        assert_eq!(v.problems[0].reason, ProblemReason::ReportOnlyRoot, "{:?}", v.problems);
    }

    #[test]
    fn the_forbidden_rule_itself_may_claim_the_recycle_bin() {
        let bin = builtin_rules().into_iter().find(|r| r.id == "recycle-bin").unwrap();
        assert!(check(&[bin]).problems.is_empty());
    }

    #[test]
    fn a_rule_claiming_system32_is_rejected() {
        let v = check(&[mk("x", Risk::Safe, &[r"%WINDIR%\System32"])]);
        assert_eq!(v.problems[0].reason, ProblemReason::ForbiddenRoot, "{:?}", v.problems);
    }

    /// **裸容器**：`%LOCALAPPDATA%` 本身就是宽容器。原先 Rust 侧没有这条判据 ——
    /// 于是它会被当清理地盘，把整个 Local 端走。
    #[test]
    fn a_bare_container_variable_is_rejected() {
        for bad in ["%LOCALAPPDATA%", "%PROGRAMDATA%", "%HOMEPATH%"] {
            let v = check(&[mk("c", Risk::Safe, &[bad])]);
            assert_eq!(v.problems[0].reason, ProblemReason::BroadContainer, "{bad}: {:?}", v.problems);
        }
    }

    /// **宽叶子名**：`...\AppData\Local` 这种最后一段是容器的路径也要拒。
    #[test]
    fn a_broad_leaf_name_is_rejected() {
        let v = check(&[mk("c", Risk::Safe, &[r"%USERPROFILE%\AppData\Local"])]);
        assert_eq!(v.problems[0].reason, ProblemReason::BroadContainer, "{:?}", v.problems);
    }

    /// **规则之间的祖先**：本规则的段序列是别条的严格前缀 → 拒本规则。
    /// 这条只有整表一起看才判得出来 —— 也是 `validate_rule_set` 必须收整表的原因。
    #[test]
    fn a_rule_that_is_a_strict_prefix_of_another_is_rejected() {
        let v = check(&[
            mk("wide", Risk::Safe, &[r"%LOCALAPPDATA%\npm-cache"]),
            mk("narrow", Risk::Safe, &[r"%LOCALAPPDATA%\npm-cache\_cacache"]),
        ]);
        assert_eq!(v.problems.len(), 1, "{:?}", v.problems);
        assert_eq!(v.problems[0].rule_id, "wide");
        assert_eq!(v.problems[0].reason, ProblemReason::AncestorOfProtected);
        assert_eq!(v.valid, vec![1], "保住的必须是 `narrow`（下标 1）");
    }

    /// `%SYSTEMDRIVE%\` 解析成 `C:\`，是 `System32` 的祖先 —— 静态层就该拦下它。
    /// 这与评估层的 `ancestor-of-protected` 是**两道闸**：静态这道连评估都不让它进。
    #[test]
    fn a_drive_root_territory_is_refused_statically() {
        let v = check(&[mk("whole", Risk::Safe, &[r"%SYSTEMDRIVE%\"])]);
        assert_eq!(v.problems[0].reason, ProblemReason::AncestorOfProtected, "{:?}", v.problems);
    }

    /// 派生只认 `Some(true)`。**M5-P1 T3b-ii 起名单是两条**（`huggingface-cache` + 表上第一档 🟠
    /// `user-downloads-installers`）—— 原先这里钉的是"只有 huggingface 一条"，那是"表上还没有 🟠"
    /// 的隐式假设，随那条上表如实变成两条；名字里那半句「只认真值」仍然准确，所以没改名。
    /// **M5-P2 P2-T4 起是三条**（表上第二档 🟠 `orphan-app-data`，spec §4.3 定死它不进默认勾选）。
    /// 逐条点名的判据在 `builtin.rs::only_huggingface_and_the_two_high_risk_rules_are_excluded_from_default_selection`，
    /// 这条只管派生函数自己的那一半（脏值 `Some(false)` 不许顺手摘掉一条规则）。
    #[test]
    fn default_unselectable_derives_only_the_true_value() {
        let mut rules = builtin_rules();
        assert_eq!(
            default_unselectable_rule_ids(&rules).into_iter().collect::<Vec<_>>(),
            vec!["huggingface-cache", "orphan-app-data", "user-downloads-installers"]
        );
        rules[0].excluded_from_default_selection = Some(false);
        assert!(!default_unselectable_rule_ids(&rules).contains("windows-temp"));
    }

    /* ---------------------------------------------------------------- *
     * M5-P1 T1 声明层围栏闸（plan §6-T1；TS 侧同名用例在 `rules-engine.test.ts`，
     * 逐条对照 —— 理由串走 kebab 线格式进 `rejectedRules`，parity 的 `fence` 用例点名比对）
     * ---------------------------------------------------------------- */

    /// 容器入口必须与 leaf 判据 **+** `scopeFence` **同时**出现（spec §2.3）。
    /// 只给围栏不给 leaf 判据 ⇒ 路径仍是"没有形状判据的容器地盘"⇒ 整条拒，理由点名
    /// `container-without-predicate`。反向半边（无围栏无 leaf 的旧规则）理由不许漂移成新的。
    #[test]
    fn a_container_path_without_leaf_predicate_is_refused() {
        let wide = leaf_rule("wide", &[], &[], Some(full_fence()), &["%LOCALAPPDATA%"]);
        let v = check_env(&[wide], &fence_env());
        assert_eq!(
            v.problems[0].reason,
            ProblemReason::ContainerWithoutPredicate,
            "带围栏但无 leaf 判据的容器入口：{:?}",
            v.problems
        );
        assert!(v.valid.is_empty());

        // 通配收尾同样算"非叶子入口"：有围栏无 leaf 时理由换成 container-without-predicate
        let tail = leaf_rule("tail", &[], &[], Some(full_fence()), &[r"%LOCALAPPDATA%\*"]);
        let v = check_env(&[tail], &fence_env());
        assert_eq!(v.problems[0].reason, ProblemReason::ContainerWithoutPredicate, "{:?}", v.problems);

        // 反向半边：不带围栏也不带 leaf 的裸容器 —— 旧判据 `broad-container` 逐字保留
        // （既有测试 `a_bare_container_variable_is_rejected` 钉的就是这条，不许被新名字顶掉）
        let legacy = mk("legacy", Risk::Safe, &["%LOCALAPPDATA%"]);
        let v = check(&[legacy]);
        assert_eq!(v.problems[0].reason, ProblemReason::BroadContainer, "{:?}", v.problems);
    }

    /// leaf* 判据没配围栏 = 这块能力的全部风险裸奔（`leafDirs: ["Cache"]` 无围栏会吃到
    /// Program Files 里应用自带运行时，plan §0.1）。整条拒进 `rejectedRules`，不许过滤命中。
    #[test]
    fn a_leaf_rule_without_a_fence_is_refused() {
        for (name, dirs, files) in [
            ("leaf-dirs", &["Cache"][..], &[][..]),
            ("leaf-files", &[][..], &["*.?.log"][..]),
        ] {
            let r = leaf_rule(name, dirs, files, None, &[r"%LOCALAPPDATA%\app"]);
            let v = check_env(&[r], &fence_env());
            assert_eq!(v.problems[0].reason, ProblemReason::InadequateFence, "{name}: {:?}", v.problems);
            assert!(v.valid.is_empty(), "{name}");
        }
    }

    /// `scopeFence.denyRoots` 必须**覆盖**禁止根全集 ∪ 地板；少一条整条拒 ——
    /// 围栏的地板不是约定，是声明层闸（spec §2.3）。
    ///
    /// ⚠️ 2026-10-19 起这张表里有一部分条目会被 FORBIDDEN 里的**同根非通配写法**顺带满足
    /// （`%PROGRAMFILES%\*` 的需求可以被 `%PROGRAMFILES%\` 顶掉 —— `path_is_under` 判同路径为 true）。
    /// 这不是漏洞：两条解析到同一个目录，保护范围一样。所以靶子只取**独占**那几条，
    /// 并把"谁被谁顶掉"记下来，免得下一个人以为漏测。
    #[test]
    fn a_fence_must_encompass_every_forbidden_root() {
        for drop in [
            r"%WINDIR%\*",
            r"%SYSTEMDRIVE%\System Volume Information",
            // 地板第四条也进来跑一遍：去掉它必须同样整条拒。T6 真机跑出来的那条
            // （Defender 特征库被当安装包收走）就是这条的来由 —— 只加进地板、
            // 不测"漏了会怎样"，等于下一次还会漏。
            r"%PROGRAMDATA%\Microsoft\Windows Defender\*",
            // CLEANUP-RULES §6 R-DENY-INSTALLDIR 的第五条：用户级安装根。
            r"%LOCALAPPDATA%\Programs\*",
        ] {
            let mut f = full_fence();
            f.deny_roots.retain(|d| d != drop);
            let r = leaf_rule("thin", &["Cache"], &[], Some(f), &["%LOCALAPPDATA%"]);
            let v = check_env(&[r], &fence_env());
            assert_eq!(v.problems[0].reason, ProblemReason::InadequateFence, "drop {drop}: {:?}", v.problems);
        }
        // 空 allowRoots 的围栏等于没有采集口径 —— 同样按 inadequate-fence 拒
        let mut f = full_fence();
        f.allow_roots.clear();
        let r = leaf_rule("no-allow", &["Cache"], &[], Some(f), &["%LOCALAPPDATA%"]);
        let v = check_env(&[r], &fence_env());
        assert_eq!(v.problems[0].reason, ProblemReason::InadequateFence, "{:?}", v.problems);
    }

    /// §10 裁定 1：`leafDirs` 与 `leafFiles` 互斥 —— 两种采集根语义混在一条规则里
    /// 会产出无法解释的命中。围栏齐不齐都要拒（这条闸排在围栏闸之前）。
    #[test]
    fn leaf_dirs_and_leaf_files_together_are_refused() {
        let r = leaf_rule("both", &["Cache"], &["*.?.log"], Some(full_fence()), &[r"%LOCALAPPDATA%\app"]);
        let v = check_env(&[r], &fence_env());
        assert_eq!(v.problems[0].reason, ProblemReason::AmbiguousLeafMode, "{:?}", v.problems);
        assert!(v.valid.is_empty());
    }

    /// **§4.3 的不对称，这条是它的钉**：围栏根**不**过 `BroadContainer`/`PatternNotLeaf`。
    /// `programdata` 在 `BROAD_LEAF_NAMES` 里、`%WINDIR%\*` 是通配收尾 —— 按**地盘**判据两条都拒；
    /// 可围栏天然就要点名这些容器，复用同一套校验会让 `denyRoots: ["%PROGRAMDATA%"]` 被自己拒掉，
    /// 围栏静默失效。`validate_fence()` 只查：解析后绝对、非盘符根、通配形态（allow 不许、deny 只许收尾整段）。
    #[test]
    fn fence_roots_are_not_held_to_the_broad_leaf_rule() {
        let mut f = full_fence();
        f.allow_roots.push("%PROGRAMDATA%".into());
        f.deny_roots.push("%PROGRAMDATA%".into());
        // 容器模式（leaf + 围栏）下 paths 允许停在容器上：入口不是地盘，围栏才是边界
        let r = leaf_rule("asym", &["Cache"], &[], Some(f), &["%LOCALAPPDATA%", "%PROGRAMDATA%"]);
        let v = check_env(&[r], &fence_env());
        assert!(
            v.problems.is_empty(),
            "围栏根被地盘判据拒了 —— §4.3 的不对称被\"顺手统一\"回去了：{:?}",
            v.problems
        );
        assert_eq!(v.valid.len(), 1);
    }

    /// §4.2 裁定：32 位根走 `%SYSTEMDRIVE%\Program Files (x86)\*`（`SYSTEMDRIVE` 已在表里，
    /// 括号不在形状判据的禁用字符集里），**不**新增带括号变量键。正反两半都要钉：
    /// 这条根必须被形状判定认下（不是装饰 —— 把它拿掉，覆盖判据当场失效）。
    #[test]
    fn a_parenthesised_literal_deny_root_passes_shape_check() {
        let r = leaf_rule("paren", &["Cache"], &[], Some(full_fence()), &["%LOCALAPPDATA%"]);
        let v = check_env(&[r], &fence_env());
        assert!(v.problems.is_empty(), "带括号的字面段被形状判定吃了：{:?}", v.problems);
        assert_eq!(v.valid.len(), 1);

        let mut f = full_fence();
        f.deny_roots.retain(|d| !d.contains("(x86)"));
        let r = leaf_rule("no-paren", &["Cache"], &[], Some(f), &["%LOCALAPPDATA%"]);
        let v = check_env(&[r], &fence_env());
        assert_eq!(
            v.problems[0].reason,
            ProblemReason::InadequateFence,
            "去掉带括号那条后必须覆盖失败 —— 段边界上 `Program Files` 套不住 `Program Files (x86)`：{:?}",
            v.problems
        );
    }

    /* ---------------------------------------------------------------- *
     * M5-P2 P2-T3 声明层互斥闸（plan §2.5；TS 侧同名用例在 `rules-engine.test.ts`）
     * ---------------------------------------------------------------- */

    /// 带机器事实闸的规则（P2-T4 那条 `orphan-app-data` 的形状）。
    fn app_fact_rule(id: &str, dirs: &[&str], files: &[&str], fence: Option<RuleScopeFence>, paths: &[&str]) -> Rule {
        let mut r = leaf_rule(id, dirs, files, fence, paths);
        r.risk_level = Risk::High;
        r.requires_absent_app_fact = Some(true);
        r
    }

    /// **P2-T3 的闸 ①**：`requiresAbsentAppFact` 与 `leafDirs` / `leafFiles` **互斥** →
    /// `ambiguous-leaf-mode` 整条拒。三种混法都要拒，而且**排在围栏闸之前**
    /// （顺序即行为：混了 leaf 又漏了围栏时，读者要看到的是"语义混用"那条更根本的理由，
    /// 与 TS `engine.ts::validateRuleSet` 同序）。
    ///
    /// 反向半边同样钉住：只有 `Some(true)` 算声明（`Some(false)` / `None` 都不不许顶掉
    /// 既有 leaf 规则的逐字行为 —— 与 `excludedFromDefaultSelection` 只认真值那一条同方向）。
    #[test]
    fn requires_absent_app_fact_with_leaf_dirs_is_refused() {
        for (name, dirs, files) in [
            ("with-leaf-dirs", &["Cache"][..], &[][..]),
            ("with-leaf-files", &[][..], &["*.?.log"][..]),
            ("with-both", &["Cache"][..], &["*.?.log"][..]),
        ] {
            let r = app_fact_rule(name, dirs, files, Some(full_fence()), &["%LOCALAPPDATA%"]);
            let v = check_env(&[r], &fence_env());
            assert_eq!(
                v.problems[0].reason,
                ProblemReason::AmbiguousLeafMode,
                "{name}：机器事实闸与 leaf* 混给必须整条拒：{:?}",
                v.problems
            );
            assert_eq!(v.problems.len(), 1, "{name}：一条规则只报第一个命中的问题");
            assert!(v.valid.is_empty(), "{name}");
            // 理由串要点名"是哪一半混进来了"，只写"互斥"的话读报告的人不知道去改哪个字段。
            // `with-both` 那一格走的是**既有的** leafDirs×leafFiles 理由串（它排在这条闸之前，
            // 两条都是 ambiguous-leaf-mode，先撞哪一条由顺序决定 —— 顺序本身就是判据，见上面）。
            if name != "with-both" {
                let detail = &v.problems[0].detail;
                let wants = if !dirs.is_empty() { "leafDirs" } else { "leafFiles" };
                assert!(detail.contains(wants), "{name}：detail 没点名 {wants}：{detail}");
                assert!(detail.contains("直属子目录"), "{name}：detail 没交代第三种采集模式是什么：{detail}");
            } else {
                assert!(
                    v.problems[0].detail.contains("leafDirs 与 leafFiles"),
                    "两条 leaf 混给时先撞的必须是既有那条理由串：{}",
                    v.problems[0].detail
                );
            }
        }

        // 混给 + 漏围栏：仍然先是 ambiguous（闸的顺序是判据，不是巧合）
        let r = app_fact_rule("no-fence-too", &["Cache"], &[], None, &["%LOCALAPPDATA%"]);
        let v = check_env(&[r], &fence_env());
        assert_eq!(v.problems[0].reason, ProblemReason::AmbiguousLeafMode, "{:?}", v.problems);

        // 反向半边：`Some(false)` 不算声明 —— 那条规则照旧走 leaf 模式，理由串不许变成新的
        let mut dirty = leaf_rule("dirty-true", &["Cache"], &[], Some(full_fence()), &["%LOCALAPPDATA%"]);
        dirty.requires_absent_app_fact = Some(false);
        let v = check_env(&[dirty], &fence_env());
        assert!(v.problems.is_empty(), "Some(false) 被当成了声明，把一条正常 leaf 规则拒了：{:?}", v.problems);
        assert_eq!(v.valid.len(), 1);
    }

    /// **P2-T3 的闸 ②**：带 `requiresAbsentAppFact` 的规则**必须容器入口 + 覆盖齐全的围栏**。
    /// 缺围栏 → `inadequate-fence`；围栏覆盖不足（少一条地板根）→ 同样 `inadequate-fence`；
    /// 齐了 → 与 leaf 规则同一个**容器入口模式**：`paths` 允许停在 `%LOCALAPPDATA%` 这类容器上
    /// （spec §3 3.5 的「顶层一项」就是这个形状）。
    /// 第四段是反向半边：不带这个字段的"只有围栏没有 leaf"的容器入口，理由仍是
    /// `container-without-predicate`，不许被这条新豁免顶掉（回归轴）。
    #[test]
    fn an_app_fact_rule_must_be_a_container_entry_with_a_covering_fence() {
        // ① 缺围栏
        let r = app_fact_rule("no-fence", &[], &[], None, &["%LOCALAPPDATA%"]);
        let v = check_env(&[r], &fence_env());
        assert_eq!(v.problems[0].reason, ProblemReason::InadequateFence, "{:?}", v.problems);
        assert!(v.problems[0].detail.contains("scopeFence"), "理由要点名缺的是围栏：{}", v.problems[0].detail);

        // ② 围栏在、覆盖不足（把 Defender 那条地板拿掉 —— 覆盖判据必须当场发现）
        let mut thin = full_fence();
        thin.deny_roots.retain(|d| !d.contains("Windows Defender"));
        let r = app_fact_rule("thin-fence", &[], &[], Some(thin), &["%LOCALAPPDATA%"]);
        let v = check_env(&[r], &fence_env());
        assert_eq!(v.problems[0].reason, ProblemReason::InadequateFence, "{:?}", v.problems);

        // ③ 齐了：三条容器根（spec §3 3.5 那个形状）必须整条过闸
        let r = app_fact_rule(
            "orphan-shape",
            &[],
            &[],
            Some(full_fence()),
            &["%LOCALAPPDATA%", "%APPDATA%", "%PROGRAMDATA%"],
        );
        let v = check_env(&[r], &fence_env());
        assert!(v.problems.is_empty(), "带机器事实闸 + 围栏的容器入口被拒了：{:?}", v.problems);
        assert_eq!(v.valid, vec![0], "必须上线，否则 P2-T4 那条规则的地盘会静默从合计里消失");

        // ④ 反向半边：同样的 paths、同样带围栏，但**不带**这个字段 → 仍是 container-without-predicate
        let plain = leaf_rule("plain-container", &[], &[], Some(full_fence()), &["%LOCALAPPDATA%"]);
        let v = check_env(&[plain], &fence_env());
        assert_eq!(v.problems[0].reason, ProblemReason::ContainerWithoutPredicate, "{:?}", v.problems);
    }
}
