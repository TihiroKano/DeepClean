//! 匹配原语：文件名 glob、段序列的严格前缀判据。
//!
//! 与 TS 侧 `core/rules/engine.ts:172-207` 同口径。**纯函数**。

use crate::env::segs_of;

/// 文件名 glob：`*` 任意串、`?` 单字符，**整名匹配、大小写不敏感**。
///
/// 为什么不用 crate：本项目运行时依赖一栏一向克制（TS 侧手写图标集是同一个理由），
/// 而这里要的语义比通用 glob 库更窄 —— 通用库会把 `**`、`[...]`、`{a,b}` 一并带进来，
/// 而规则表里**只允许 `*` 与 `?` 两种**（多了会让"地盘到底有多大"变得说不清）。
pub fn name_matches(name: &str, patterns: &[String]) -> bool {
    if patterns.is_empty() {
        return true; // 空数组 = 该地盘下的所有文件
    }
    patterns.iter().any(|g| glob_match(name, g))
}

pub fn glob_match(name: &str, glob: &str) -> bool {
    // 逐字符回溯匹配（`*` 可吞任意串）。不用正则引擎：省一个依赖，且这里只有两种元字符。
    let n: Vec<char> = name.to_lowercase().chars().collect();
    let g: Vec<char> = glob.to_lowercase().chars().collect();
    let (mut i, mut j) = (0usize, 0usize);
    let (mut star, mut mark) = (usize::MAX, 0usize);
    while i < n.len() {
        if j < g.len() && (g[j] == '?' || g[j] == n[i]) {
            i += 1;
            j += 1;
        } else if j < g.len() && g[j] == '*' {
            star = j;
            mark = i;
            j += 1;
        } else if star != usize::MAX {
            j = star + 1;
            mark += 1;
            i = mark;
        } else {
            return false;
        }
    }
    while j < g.len() && g[j] == '*' {
        j += 1;
    }
    j == g.len()
}

/// 段序列 `a` 是否是 `b` 的**严格前缀**（`*` 恰好匹配一段）——
/// 即 `a` 的地盘整个套住 `b`。§28 原则四靠它判"某条规则的地盘是不是别人的祖先"。
pub fn is_strict_territory_prefix(a: &[String], b: &[String]) -> bool {
    if a.len() >= b.len() {
        return false;
    }
    a.iter().zip(b.iter()).all(|(x, y)| x == "*" || x.to_lowercase() == y.to_lowercase())
}

/// 把一条路径按段拆开（供前缀判据使用）。
pub fn segs(p: &str) -> Vec<String> {
    segs_of(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &[&str]) -> Vec<String> {
        s.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn glob_star_and_question() {
        assert!(glob_match("thumbcache_64.db", "thumbcache_*.db"));
        assert!(glob_match("thumbcache_.db", "thumbcache_*.db"), "* 可以匹配空串");
        assert!(!glob_match("iconcache_64.db", "thumbcache_*.db"));
        assert!(glob_match("a", "a"));
        assert!(!glob_match("ab", "a"), "整名匹配，不许前缀通过");
        assert!(glob_match("a", "?"), "? 匹配单个字符，不含空");
        assert!(!glob_match("", "?"));
        assert!(glob_match("abc", "*"));
    }

    #[test]
    fn glob_is_case_insensitive() {
        assert!(glob_match("ThumbCache_64.DB", "thumbcache_*.db"));
    }

    #[test]
    fn glob_meta_characters_are_literal() {
        // `.` 必须是字面点，不能像正则那样匹配任意字符 —— 否则 thumbcache_Xdb 也会过
        assert!(!glob_match("thumbcache_64xdb", "thumbcache_*.db"));
        assert!(glob_match("a+b", "a+b"));
        assert!(glob_match("a(b)", "a(b)"));
    }

    #[test]
    fn empty_patterns_mean_everything() {
        assert!(name_matches("anything.dll", &[]));
        assert!(!name_matches("other.db", &v(&["thumbcache_*.db"])));
    }

    #[test]
    fn territory_prefix_requires_strictness() {
        assert!(is_strict_territory_prefix(&v(&["c:", "windows"]), &v(&["c:", "windows", "temp"])));
        assert!(!is_strict_territory_prefix(&v(&["c:", "windows"]), &v(&["c:", "windows"])), "相等不算严格前缀");
        assert!(!is_strict_territory_prefix(&v(&["c:", "a", "b"]), &v(&["c:", "a"])), "更长的一方不可能是前缀");
    }

    #[test]
    fn a_wildcard_segment_matches_any_single_segment() {
        // `*` 恰好一段：`%LOCALAPPDATA%\*\Cache` 套住 `...\Chrome\Cache` 但不套住 `...\a\b\Cache`
        assert!(is_strict_territory_prefix(&v(&["c:", "*"]), &v(&["c:", "chrome", "cache"])));
        assert!(is_strict_territory_prefix(&v(&["c:", "*", "cache"]), &v(&["c:", "chrome", "cache", "x"])));
    }

    #[test]
    fn territory_prefix_is_case_insensitive() {
        assert!(is_strict_territory_prefix(&v(&["C:", "Windows"]), &v(&["c:", "windows", "temp"])));
    }
}
