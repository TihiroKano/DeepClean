//! M3-C-1：执行前的**授权闸**。**纯函数、零文件系统。**
//!
//! 两套词汇逐字同名于 TS `shared/types.ts`（`CleanBlockerReason` 12 个 / `CleanRefusalReason` 13 个）。
//! 判据顺序照抄 `core/clean/executor.ts:600-664` —— **顺序本身是行为**：同一条路径先撞上哪条
//! 拒绝理由，决定记录页那一行怎么写。自行归并理由会把"这条为什么没删"变成一句含糊话。
//!
//! 这一层是**四层闸的最后一道**（声明层 → 评估层 → 预览 → 执行器）。历史上回收站防护靠
//! "排在规则表第 6 位"那种顺序依赖，已被结构闸取代 —— 执行器这道不许省、不许退回去。
//!
//! **本文件一行删除代码都没有**：它只回答"这个根能不能当授权根""这条路径要不要拒绝"。
//! 真动作在 C-2，且它必须先过这里。

use deepclean_rules::engine::normalize_key;
use deepclean_rules::env::{is_forbidden_path, path_is_under, resolve_pattern, segs_of, RuleEnv};
use serde::{Deserialize, Serialize};

/// 整批拒绝的原因。TS `CleanBlockerReason` 的 12 个成员，逐字同名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CleanBlockerReason {
    RootMalformed,
    RootNotAbsolute,
    RootIsDriveRoot,
    RootMissing,
    RootNotADirectory,
    RootIsReparsePoint,
    RootUnstatable,
    RootForbidden,
    RootReportOnly,
    RootAncestorOfForbidden,
    RootForbiddenUnresolved,
    RootDeniedByCaller,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanBlocker {
    pub reason: CleanBlockerReason,
    pub detail: String,
}

/// 单条路径的拒绝原因。TS `CleanRefusalReason` 的 13 个成员，逐字同名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CleanRefusalReason {
    OutOfScope,
    OverlapsOutOfScope,
    EqualsAuthorizedRoot,
    ParentTraversal,
    ForbiddenRoot,
    ReportOnlyRoot,
    ForbiddenRootsUnresolved,
    ReparsePoint,
    ReparseAncestor,
    NotFound,
    Unstatable,
    MalformedPath,
    NotADeletableEntry,
    /// M6（免确认清理档）：`permanent`（真删）上下文缺确认回执 → 删除模式有、
    /// 授权凭据没有，整批拒绝（`executor.rs::run` 开头的结构闸，一个文件都不动）。
    PermanentWithoutConfirmation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanRefusal {
    pub path: String,
    pub reason: CleanRefusalReason,
    pub detail: String,
    pub bytes: u64,
    /// `reason = OverlapsOutOfScope` 时点名它是因为哪条越界请求被连带拒的
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overlap_of: Option<String>,
}

/// 解析好的保护名单。与 TS `resolveForbidden` 同口径：
/// 解出具体路径就用它；只有字面前缀（带通配）就用前缀；两者都没有 = 解不出来（调用方据此 fail-safe）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolvedPatterns {
    pub roots: Vec<String>,
    pub unresolved: Vec<String>,
}

impl ResolvedPatterns {
    pub fn is_unresolved(&self) -> bool {
        !self.unresolved.is_empty()
    }
}

pub fn resolve_roots(patterns: &[String], env: &RuleEnv) -> ResolvedPatterns {
    let mut out = ResolvedPatterns::default();
    for p in patterns {
        let r = resolve_pattern(p, env);
        match (r.concrete, r.base) {
            (Some(c), _) => out.roots.push(c),
            (None, Some(b)) => out.roots.push(b),
            (None, None) => out.unresolved.push(p.clone()),
        }
    }
    out
}

fn segs_of_path(p: &str) -> Vec<String> {
    segs_of(p)
}

/// 路径长什么样都**不许**：扩展长度前缀、shell 通配/引号字符、`.` 或 `..` 段。
/// 与 TS `pathShapeProblem` 逐条相同。
pub fn path_shape_problem(p: &str) -> Option<&'static str> {
    if p.starts_with("\\\\?\\") {
        return Some("扩展长度前缀（\\\\?\\）不是合法请求路径");
    }
    if p.contains(['"', '*', '?', '<', '>', '|']) {
        return Some("含 shell 通配/引号字符");
    }
    if segs_of_path(p).iter().any(|s| s == "." || s == "..") {
        return Some("含 . 或 .. 段");
    }
    None
}

/// 盘符根（裸 `C:` 或 `C:\`）。**必须排在"是不是绝对路径"之前判** ——
/// 裸盘符既不匹配 `X:\` 也不匹配 UNC，先按"不是绝对路径"报会掩盖真正的危险点。
pub fn is_drive_root_like(p: &str) -> bool {
    let t = p.replace('/', "\\");
    let t = t.trim_end_matches('\\');
    let b = t.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// 严格位于 `root` 之内（root 自己**不算**）。两个 key 都是 `normalize_key` 的产物。
/// **段边界比较，不是字符串前缀** —— 前缀那条路会让 `C:\ab` 落在 `C:\a` 里。
pub fn is_strictly_inside(key: &str, root_key: &str) -> bool {
    let prefix = if root_key.ends_with('\\') { root_key.to_string() } else { format!("{root_key}\\") };
    key.len() > prefix.len() - 1 && key.starts_with(&prefix)
}

/// 根的属性探测结论（注入）。
///
/// TS 那边是 `guardAuthorizedRootAsync` 里直接 `await fs.lstat`；这边做成注入，是为了把
/// **这一层钉成纯函数**：那三条判据（不存在 / 不是目录 / 是重解析点）才能不碰文件系统穷举验证 ——
/// 而"碰文件系统"的那一半正好是唯一危险的动作。真探针在 C-2 里是 `std::fs::symlink_metadata`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootKind {
    Directory,
    NotADirectory,
    ReparsePoint,
    Missing,
    Unstatable,
}

fn block(reason: CleanBlockerReason, detail: String) -> Result<(), Vec<CleanBlocker>> {
    Err(vec![CleanBlocker { reason, detail }])
}

/// `authorizedRoot` 的三关。`Ok(())` = 通过；`Err(blockers)` = **整批拒绝、零删除**。
///
/// 顺序照抄 `executor.ts:600-664`：形状 → 盘符根 → 保护名单落不落地 → 调用方围栏 →
/// 禁止根 / 只上报根 / 套住保护路径 → 最后才是属性探测。
pub fn guard_authorized_root(
    root: &str,
    forbidden: &ResolvedPatterns,
    deny: &ResolvedPatterns,
    report_only: &ResolvedPatterns,
    probe: impl Fn(&str) -> RootKind,
) -> Result<(), Vec<CleanBlocker>> {
    if root.trim().is_empty() {
        return block(CleanBlockerReason::RootMalformed, "authorizedRoot 必须是非空字符串".into());
    }
    let p = root.trim();
    if let Some(shape) = path_shape_problem(p) {
        return block(CleanBlockerReason::RootMalformed, format!("authorizedRoot {shape} → 拒绝"));
    }
    let slashed = p.replace('/', "\\");
    let is_drive_abs = slashed.len() >= 3
        && slashed.as_bytes()[0].is_ascii_alphabetic()
        && slashed.as_bytes()[1] == b':'
        && slashed.as_bytes()[2] == b'\\';
    let is_unc = slashed.starts_with("\\\\")
        && slashed.trim_start_matches('\\').split('\\').filter(|s| !s.is_empty()).count() >= 2;
    if !is_drive_abs && !is_unc {
        if is_drive_root_like(p) {
            return block(
                CleanBlockerReason::RootIsDriveRoot,
                format!("authorizedRoot「{p}」是盘符根 → 整批拒绝，零删除"),
            );
        }
        return block(
            CleanBlockerReason::RootNotAbsolute,
            format!("authorizedRoot「{p}」不是盘符绝对路径或 UNC 共享 → 拒绝（§28 原则四）"),
        );
    }
    if is_drive_root_like(p) {
        return block(
            CleanBlockerReason::RootIsDriveRoot,
            format!("authorizedRoot「{p}」是盘符根 → 整批拒绝，零删除"),
        );
    }

    // 保护名单**自己落不了地** = 保护看不见 = fail-safe。只上报根那张表落不了地同属这一类：
    // 看不见回收站就会把它当普通目录删。
    let mut unresolved = forbidden.unresolved.clone();
    unresolved.extend(report_only.unresolved.iter().cloned());
    if !unresolved.is_empty() {
        return block(
            CleanBlockerReason::RootForbiddenUnresolved,
            format!(
                "禁止根模板解析不出来（{}）→ 无法证明 {p} 不在 System32/WinSxS/回收站里，宁可什么都不删",
                unresolved.join("、")
            ),
        );
    }

    if let Some(hit) = is_forbidden_path(p, &deny.roots) {
        return block(
            CleanBlockerReason::RootDeniedByCaller,
            format!("authorizedRoot {p} 落在调用方追加的围栏 {hit} 之内 → 拒绝（单独点名，不与 §16 🔴 混写）"),
        );
    }
    if let Some(hit) = is_forbidden_path(p, &forbidden.roots) {
        return block(CleanBlockerReason::RootForbidden, format!("authorizedRoot {p} 命中 §16 🔴 禁止路径 {hit} → 整批拒绝"));
    }
    if let Some(hit) = is_forbidden_path(p, &report_only.roots) {
        return block(
            CleanBlockerReason::RootReportOnly,
            format!("authorizedRoot {p} 落在只上报根 {hit} 之内 → 回收站这类目录只许报告占用，整批拒绝（§16 🔴）"),
        );
    }
    let mut all: Vec<String> = forbidden.roots.clone();
    all.extend(deny.roots.iter().cloned());
    all.extend(report_only.roots.iter().cloned());
    if let Some(swept) = all
        .iter()
        .find(|f| path_is_under(f, p) && normalize_key(f) != normalize_key(p))
    {
        return block(
            CleanBlockerReason::RootAncestorOfForbidden,
            format!("authorizedRoot {p} 套住了禁止/只上报路径 {swept}，宽容器一律不认（§28 原则四）"),
        );
    }

    // 第三关：存在、是目录、且自己不是重解析点。
    match probe(p) {
        RootKind::ReparsePoint => block(
            CleanBlockerReason::RootIsReparsePoint,
            format!("authorizedRoot {p} 本身是重解析点 → 跟随它等于把授权根搬到别处"),
        ),
        RootKind::NotADirectory => block(CleanBlockerReason::RootNotADirectory, format!("authorizedRoot {p} 存在但不是目录")),
        RootKind::Missing => block(CleanBlockerReason::RootMissing, format!("authorizedRoot {p} 不存在（ENOENT）→ 零删除")),
        RootKind::Unstatable => block(
            CleanBlockerReason::RootUnstatable,
            format!("authorizedRoot {p} 读不到属性 → 无法证明安全性，零删除"),
        ),
        RootKind::Directory => Ok(()),
    }
}

/// 批次级的第一道逐条闸。`Ok(())` = 这条可以进下一关；`Err(refusal)` = 点名拒绝。
///
/// 与 TS 同顺序：形状 → 等于授权根本身 → **（不在授权根内的）禁止/只上报根** → 越界。
/// 注意"命中保护路径"那一条**只在路径不在授权根内时才在这一关拒**：
/// 在授权根内的那些留给第二遍（`executor.ts:382`：即使在授权根内也不删）——
/// 两遍都拒，但理由归属不同，记录页要点名到正确的那个。
pub fn classify_path(
    path: &str,
    authorized_root: &str,
    forbidden: &ResolvedPatterns,
    report_only: &ResolvedPatterns,
) -> Result<(), CleanRefusal> {
    let refuse = |reason, detail: String, bytes| Err(CleanRefusal {
        path: path.to_string(),
        reason,
        detail,
        bytes,
        overlap_of: None,
    });

    let p = path.trim();
    if p.is_empty() {
        return refuse(CleanRefusalReason::MalformedPath, "路径必须是非空字符串 → 这条不处理".into(), 0);
    }
    if let Some(shape) = path_shape_problem(p) {
        return refuse(
            CleanRefusalReason::ParentTraversal,
            format!("{shape} → 拒绝，且**不做二次 normalize 后放行**（§28 原则四）"),
            0,
        );
    }
    let root_key = normalize_key(authorized_root);
    let key = normalize_key(p);
    if key == root_key {
        return refuse(
            CleanRefusalReason::EqualsAuthorizedRoot,
            "请求删除授权根本身 = 无上限的删除范围，一律拒绝（§28 原则四）".into(),
            0,
        );
    }
    if is_forbidden_path(p, &forbidden.roots).is_none() {
        // 没撞禁止根，再看看只上报根
        if let Some(ro) = is_forbidden_path(p, &report_only.roots) {
            if !is_strictly_inside(&key, &root_key) {
                return refuse(
                    CleanRefusalReason::ReportOnlyRoot,
                    format!("命中只上报根 {ro}（且不在授权根之内）→ 拒绝"),
                    0,
                );
            }
        }
    } else if let Some(h) = is_forbidden_path(p, &forbidden.roots) {
        if !is_strictly_inside(&key, &root_key) {
            return refuse(
                CleanRefusalReason::ForbiddenRoot,
                format!("命中 §16 🔴 禁止路径 {h}（且不在授权根之内）→ 拒绝"),
                0,
            );
        }
    }
    if !is_strictly_inside(&key, &root_key) {
        return refuse(
            CleanRefusalReason::OutOfScope,
            format!("不在授权根 {authorized_root} 之内 → 拒绝（§28 原则四：清理范围必须明确）"),
            0,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> RuleEnv {
        let mut m = RuleEnv::new();
        m.insert("SYSTEMDRIVE".into(), "C:".into());
        m.insert("WINDIR".into(), r"C:\Windows".into());
        m.insert("TEMP".into(), r"C:\Temp".into());
        // CLEANUP-RULES §6 补齐 R-DENY-INSTALLDIR 之后，禁止根模板里出现了
        // `%PROGRAMFILES%\` 与 `%SYSTEMDRIVE%\Program Files (x86)\`。合成机少这一键时
        // `resolve_roots` 把模板记成 `unresolved`，于是每一条判据都报
        // `forbidden-roots-unresolved`（fail-safe 整批拒绝）—— 那是**模板在合成机里没有家**，
        // 不是守卫在工作。补上它，这里量的才真是「这个根落在禁止根里吗」。
        m.insert("PROGRAMFILES".into(), r"C:\Program Files".into());
        m.insert("PROGRAMDATA".into(), r"C:\ProgramData".into());
        m.insert("USERPROFILE".into(), r"C:\Users\Kano".into());
        m.insert("APPDATA".into(), r"C:\Users\Kano\AppData\Roaming".into());
        m.insert("LOCALAPPDATA".into(), r"C:\Users\Kano\AppData\Local".into());
        m
    }

    fn resolved() -> (ResolvedPatterns, ResolvedPatterns, ResolvedPatterns) {
        let forbidden = resolve_roots(&deepclean_rules::FORBIDDEN_PATH_PATTERNS.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &env());
        let report_only = resolve_roots(&deepclean_rules::REPORT_ONLY_ROOT_PATTERNS.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &env());
        (forbidden, ResolvedPatterns::default(), report_only)
    }

    fn guard(root: &str) -> Result<(), Vec<CleanBlocker>> {
        guard_all(root, RootKind::Directory)
    }
    fn guard_all(root: &str, kind: RootKind) -> Result<(), Vec<CleanBlocker>> {
        let (f, d, r) = resolved();
        guard_authorized_root(root, &f, &d, &r, |_| kind)
    }
    fn reason_of(e: &Result<(), Vec<CleanBlocker>>) -> CleanBlockerReason {
        e.as_ref().unwrap_err()[0].reason
    }

    /* ---------------- 13 条 blocker 各自可达 ---------------- */

    #[test]
    fn every_blocker_reason_is_reachable() {
        assert_eq!(reason_of(&guard_all("   ", RootKind::Directory)), CleanBlockerReason::RootMalformed);
        assert_eq!(reason_of(&guard(r"C:\a\*")), CleanBlockerReason::RootMalformed);
        assert_eq!(reason_of(&guard(r"C:\a\..\b")), CleanBlockerReason::RootMalformed);
        assert_eq!(reason_of(&guard(r"\\?\C:\a")), CleanBlockerReason::RootMalformed);
        assert_eq!(reason_of(&guard(r"AppData\Local\Temp")), CleanBlockerReason::RootNotAbsolute);
        assert_eq!(reason_of(&guard("C:")), CleanBlockerReason::RootIsDriveRoot, "裸盘符");
        assert_eq!(reason_of(&guard(r"C:\")), CleanBlockerReason::RootIsDriveRoot, "盘符根");
        assert_eq!(reason_of(&guard(r"C:\Windows\System32\x")), CleanBlockerReason::RootForbidden);
        assert_eq!(reason_of(&guard(r"C:\$Recycle.Bin\S-1-5-21")), CleanBlockerReason::RootReportOnly);
        assert_eq!(reason_of(&guard(r"C:\Windows")), CleanBlockerReason::RootAncestorOfForbidden, "套住 System32");
        assert_eq!(reason_of(&guard_all(r"C:\Sandbox", RootKind::Missing)), CleanBlockerReason::RootMissing);
        assert_eq!(reason_of(&guard_all(r"C:\Sandbox", RootKind::NotADirectory)), CleanBlockerReason::RootNotADirectory);
        assert_eq!(reason_of(&guard_all(r"C:\Sandbox", RootKind::ReparsePoint)), CleanBlockerReason::RootIsReparsePoint);
        assert_eq!(reason_of(&guard_all(r"C:\Sandbox", RootKind::Unstatable)), CleanBlockerReason::RootUnstatable);

        // root-denied-by-caller：调用方追加的围栏（单独点名，不与 §16 🔴 混写）
        let (f, _, r) = resolved();
        let deny = ResolvedPatterns { roots: vec![r"C:\Sandbox".into()], unresolved: Vec::new() };
        let e = guard_authorized_root(r"C:\Sandbox\x", &f, &deny, &r, |_| RootKind::Directory);
        assert_eq!(reason_of(&e), CleanBlockerReason::RootDeniedByCaller);

        // root-forbidden-unresolved：保护名单自己落不了地 → fail-safe
        let (_, d, _) = resolved();
        let bad = ResolvedPatterns { roots: Vec::new(), unresolved: vec!["%NOPE%\\System32".into()] };
        let e = guard_authorized_root(r"C:\Sandbox", &bad, &d, &ResolvedPatterns::default(), |_| RootKind::Directory);
        assert_eq!(reason_of(&e), CleanBlockerReason::RootForbiddenUnresolved);
    }

    #[test]
    fn a_clean_sandbox_root_passes() {
        assert!(guard(r"C:\Users\Kano\Desktop\DeepClean删除测试\target").is_ok());
        assert!(guard(r"C:\Temp\sandbox").is_ok());
        assert!(guard(r"\\server\share\sandbox").is_ok(), "UNC 共享也是合法授权根");
    }

    /// 盘符根必须先被认出来，不能被"不是绝对路径"掩盖 —— 那是**最危险**的那个根。
    #[test]
    fn a_bare_drive_letter_is_never_reported_as_merely_relative() {
        assert_eq!(reason_of(&guard("C:")), CleanBlockerReason::RootIsDriveRoot);
        assert_eq!(reason_of(&guard("c:/")), CleanBlockerReason::RootIsDriveRoot);
    }

    /* ---------------- 段边界 ---------------- */

    #[test]
    fn strictly_inside_respects_segment_boundaries() {
        assert!(is_strictly_inside(r"c:\a\b", r"c:\a"));
        assert!(!is_strictly_inside(r"c:\ab", r"c:\a"), "字符串前缀那条路会让它成立");
        assert!(!is_strictly_inside(r"c:\a", r"c:\a"), "根自己不算'严格在内'");
        assert!(is_strictly_inside(r"c:\a\b", r"c:\"), "盘符根要能装下子孙");
    }

    /* ---------------- 逐条拒绝 ---------------- */

    fn classify(p: &str) -> Result<(), CleanRefusal> {
        let (f, _, r) = resolved();
        classify_path(p, r"C:\Sandbox", &f, &r)
    }
    fn rreason(e: &Result<(), CleanRefusal>) -> CleanRefusalReason {
        e.as_ref().unwrap_err().reason
    }

    #[test]
    fn path_level_refusals_are_each_reachable() {
        assert_eq!(rreason(&classify("")), CleanRefusalReason::MalformedPath);
        assert_eq!(rreason(&classify(r"C:\Sandbox\*")), CleanRefusalReason::ParentTraversal);
        assert_eq!(rreason(&classify(r"C:\Sandbox\..\x")), CleanRefusalReason::ParentTraversal);
        assert_eq!(rreason(&classify(r"C:\Sandbox")), CleanRefusalReason::EqualsAuthorizedRoot);
        assert_eq!(rreason(&classify(r"C:\Windows\System32\k.dll")), CleanRefusalReason::ForbiddenRoot);
        assert_eq!(rreason(&classify(r"C:\$Recycle.Bin\x")), CleanRefusalReason::ReportOnlyRoot);
        assert_eq!(rreason(&classify(r"C:\Elsewhere\x")), CleanRefusalReason::OutOfScope);
        assert!(classify(r"C:\Sandbox\a.txt").is_ok());
        assert!(classify(r"C:\SAND\b").is_err(), "大小写不敏感、且段边界仍然成立");
    }

    /// **承重墙**：在授权根**之内**的禁止路径，这一关**不**报 out-of-scope 也不报 forbidden ——
    /// 它留给第二遍（`executor.ts:382`）。两遍都要拒，但理由归属不同，记录页要点名对。
    #[test]
    fn a_forbidden_path_inside_the_root_is_not_refused_by_this_pass() {
        let (f, _, r) = resolved();
        // 授权根自己就是 C:\Windows（虽然它其实过不了 guard，这里只测 classify 的分界）
        let e = classify_path(r"C:\Windows\System32\k.dll", r"C:\Windows", &f, &r);
        assert!(e.is_ok(), "在根内 → 这一关放行，交给第二遍按 forbidden-root 拒：{e:?}");
    }

    #[test]
    fn shape_problems_are_named_one_by_one() {
        assert!(path_shape_problem(r"\\?\C:\a").is_some());
        for bad in [r#"C:\a"b"#, r"C:\a*b", r"C:\a?b", r"C:\a<b", r"C:\a>b", r"C:\a|b"] {
            assert!(path_shape_problem(bad).is_some(), "{bad}");
        }
        assert!(path_shape_problem(r"C:\a\.\b").is_some());
        assert!(path_shape_problem(r"C:\a\..\b").is_some());
        assert!(path_shape_problem(r"C:\a\b").is_none());
        assert!(path_shape_problem(r"C:\a\..b").is_none(), "..b 是一段普通的名字");
    }
}
