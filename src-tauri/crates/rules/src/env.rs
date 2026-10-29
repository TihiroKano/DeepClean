//! 路径模板解析。**纯函数，不碰树、不碰盘、不读真机环境变量**（约束 7：判据要能在合成树上跑）。
//!
//! 与 TS 侧 `core/rules/engine.ts:91-166` 同口径。三个**拒绝理由**都产生在这一层，
//! 它们是"这条规则的地盘算不算数"的第一道闸：
//!  · `unresolved-env`  —— 注入的 env 里没有这个变量。**宁可不给结论，也不回落真机**。
//!  · `broad-container` —— 裸容器变量（`%LOCALAPPDATA%` 这种本身就是宽容器，不是叶子）。
//!  · `pattern-not-leaf` —— 以通配收尾（`%LOCALAPPDATA%\*`），落不到具体目录。

use crate::types::CONTAINER_VARS;
use std::collections::BTreeMap;

/// 环境变量表：**键用大写**。值必须是绝对路径。
pub type RuleEnv = BTreeMap<String, String>;

/// 段切分：`/` 归一成 `\`，切完丢掉空段。
pub fn segs_of(p: &str) -> Vec<String> {
    p.replace('/', "\\")
        .split('\\')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

pub fn norm_segs(p: &str) -> Vec<String> {
    segs_of(p).iter().map(|s| s.to_lowercase()).collect()
}

/// `child` 是否**等于或在** `parent` 之下 —— 按**段边界**比，不是字符串前缀：
/// `C:\Windows\Temples` **不算** `C:\Windows\Temp` 的子孙。
/// 字符串前缀那条路会让 `%TEMP%` 规则顺手吃掉隔壁的 `Temp2`。
pub fn path_is_under(child: &str, parent: &str) -> bool {
    let c = norm_segs(child);
    let p = norm_segs(parent);
    if p.is_empty() || c.len() < p.len() {
        return false;
    }
    p.iter().zip(c.iter()).all(|(a, b)| a == b)
}

/// 命中哪个禁止根（返回它自己，好让排除记录点名到根）。
pub fn is_forbidden_path(path: &str, roots: &[String]) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    roots.iter().find(|f| path_is_under(path, f)).cloned()
}

/// 变量段查询：**大小写不敏感**（`%temp%` 与 `%TEMP%` 是同一个变量）。
pub fn lookup_env(env: &RuleEnv, name: &str) -> Option<String> {
    let upper = name.to_uppercase();
    env.iter().find(|(k, _)| k.to_uppercase() == upper).map(|(_, v)| v.clone())
}

/// 把段拼回绝对路径；盘符单段（`C:`）补回尾斜杠，否则与树上的 `c:\` 对不上。
pub fn tokens_to_path(tokens: &[String]) -> String {
    if tokens.is_empty() {
        return String::new();
    }
    if tokens.len() == 1 && is_drive_token(&tokens[0]) {
        return format!("{}\\", tokens[0]);
    }
    let mut out = tokens[0].clone();
    for t in &tokens[1..] {
        out.push('\\');
        out.push_str(t);
    }
    out
}

fn is_drive_token(t: &str) -> bool {
    let b = t.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedPattern {
    /// 通配之前的字面前缀（已解析成绝对路径）；变量取不到值时为 `None`
    pub base: Option<String>,
    /// `base` 之后的段（可能含 `*`）
    pub rest: Vec<String>,
    /// 变量取不到值：点名是哪一个
    pub unresolved_var: Option<String>,
    /// 整条路径都是字面量时给出的完整绝对路径，否则 `None`
    pub concrete: Option<String>,
}

impl ResolvedPattern {
    /// 是否以通配收尾（§28 原则四：清理范围必须落到叶子上）
    pub fn has_wildcard_tail(&self) -> bool {
        self.rest.last().is_some_and(|s| s.contains('*') || s.contains('?'))
    }

    /// 是否是"裸容器"：整条路径就是一个容器变量（如 `%LOCALAPPDATA%`），
    /// 一段通配都没有却仍然是个宽容器。
    pub fn is_broad_container(&self, pattern: &str) -> bool {
        let segs = segs_of(pattern);
        if segs.len() != 1 {
            return false;
        }
        let s = segs[0].to_uppercase();
        let name = s.trim_start_matches('%').trim_end_matches('%');
        s.starts_with('%') && s.ends_with('%') && CONTAINER_VARS.contains(&name)
    }
}

/// 解析一条路径模板。**只从注入的 env 取值**。
pub fn resolve_pattern(pattern: &str, env: &RuleEnv) -> ResolvedPattern {
    let tokens = segs_of(pattern);
    let head = tokens.first().cloned().unwrap_or_default();

    let (base_segs, rest): (Vec<String>, Vec<String>) = if is_var_token(&head) {
        let name = head[1..head.len() - 1].to_uppercase();
        match lookup_env(env, &name) {
            None => {
                return ResolvedPattern {
                    base: None,
                    rest: tokens[1..].to_vec(),
                    unresolved_var: Some(name),
                    concrete: None,
                }
            }
            Some(val) => (segs_of(&val), tokens[1..].to_vec()),
        }
    } else if is_drive_token(&head) {
        // 盘符绝对写法（`C:\Users\...`）：`C:` 当 base，其余进 rest —— 与 %VAR% 走同一条展开逻辑
        (vec![head.clone()], tokens[1..].to_vec())
    } else {
        (Vec::new(), tokens.clone())
    };

    let wild = rest.iter().any(|s| s.contains('*') || s.contains('?'));
    let concrete = if wild {
        None
    } else {
        let mut all = base_segs.clone();
        all.extend(rest.iter().cloned());
        let p = tokens_to_path(&all);
        if p.is_empty() {
            None
        } else {
            Some(p)
        }
    };
    let base = {
        let b = tokens_to_path(&base_segs);
        if b.is_empty() {
            None
        } else {
            Some(b)
        }
    };
    ResolvedPattern { base, rest, unresolved_var: None, concrete }
}

fn is_var_token(s: &str) -> bool {
    s.len() >= 3
        && s.starts_with('%')
        && s.ends_with('%')
        && s[1..s.len() - 1].chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env() -> RuleEnv {
        let mut m = RuleEnv::new();
        m.insert("TEMP".into(), r"C:\Users\Kano\AppData\Local\Temp".into());
        m.insert("SYSTEMDRIVE".into(), "C:".into());
        m.insert("LOCALAPPDATA".into(), r"C:\Users\Kano\AppData\Local".into());
        // CLEANUP-RULES §6 补齐后的禁止根模板引用的其余变量（与 cleaner 的合成机同一份）。
        m.insert("PROGRAMFILES".into(), r"C:\Program Files".into());
        m
    }

    #[test]
    fn segment_boundaries_not_string_prefixes() {
        assert!(path_is_under(r"C:\Windows\Temp", r"C:\Windows\Temp"));
        assert!(path_is_under(r"C:\Windows\Temp\x", r"C:\Windows\Temp"));
        // 字符串前缀那条路会让 %TEMP% 规则顺手吃掉隔壁的 Temp2
        assert!(!path_is_under(r"C:\Windows\Temples", r"C:\Windows\Temp"));
        assert!(!path_is_under(r"C:\Windows", r"C:\Windows\Temp"));
        assert!(path_is_under(r"C:\Windows\Temp", r"C:\"));
    }

    #[test]
    fn case_insensitive_on_both_sides() {
        assert!(path_is_under(r"c:\WINDOWS\temp\a", r"C:\Windows\Temp"));
    }

    #[test]
    fn a_var_head_resolves_from_env_only() {
        let r = resolve_pattern(r"%TEMP%", &env());
        assert_eq!(r.base.as_deref(), Some(r"C:\Users\Kano\AppData\Local\Temp"));
        assert!(r.rest.is_empty());
        assert_eq!(r.concrete.as_deref(), Some(r"C:\Users\Kano\AppData\Local\Temp"));
        assert!(r.unresolved_var.is_none());
    }

    #[test]
    fn a_missing_var_is_unresolved_and_never_falls_back_to_the_real_machine() {
        let r = resolve_pattern(r"%NOPE%\Cache", &env());
        assert_eq!(r.unresolved_var.as_deref(), Some("NOPE"));
        assert!(r.base.is_none());
        assert!(r.concrete.is_none(), "解不出来就不许给一个具体路径");
    }

    #[test]
    fn lower_case_variable_names_work() {
        let r = resolve_pattern(r"%temp%", &env());
        assert_eq!(r.unresolved_var, None);
        assert!(r.concrete.is_some());
    }

    #[test]
    fn a_wildcard_makes_concrete_null_but_keeps_base_and_rest() {
        let r = resolve_pattern(r"%LOCALAPPDATA%\Google\Chrome\User Data\*\Cache", &env());
        assert_eq!(r.base.as_deref(), Some(r"C:\Users\Kano\AppData\Local"));
        assert_eq!(r.rest, vec!["Google", "Chrome", "User Data", "*", "Cache"]);
        assert!(r.concrete.is_none(), "带通配就没有唯一路径");
        assert!(!r.has_wildcard_tail(), "通配在中间，不以它收尾");
    }

    #[test]
    fn a_drive_letter_head_works_like_a_variable() {
        let r = resolve_pattern(r"C:\Users\Kano\x", &env());
        assert_eq!(r.base.as_deref(), Some(r"C:\"));
        assert_eq!(r.concrete.as_deref(), Some(r"C:\Users\Kano\x"));
    }

    #[test]
    fn a_single_drive_token_gets_a_trailing_backslash() {
        // 不补那一下，`C:` 与树上的 `c:\` 对不上 —— 整条规则的地盘会解析到零个节点
        assert_eq!(tokens_to_path(&["C:".to_string()]), r"C:\");
    }

    #[test]
    fn wildcard_tail_is_detectable() {
        let r = resolve_pattern(r"%LOCALAPPDATA%\*", &env());
        assert!(r.has_wildcard_tail());
        assert!(!resolve_pattern(r"%LOCALAPPDATA%\*\Cache", &env()).has_wildcard_tail());
    }

    #[test]
    fn broad_containers_are_recognised() {
        assert!(resolve_pattern("%LOCALAPPDATA%", &env()).is_broad_container("%LOCALAPPDATA%"));
        assert!(resolve_pattern("%USERPROFILE%", &env()).is_broad_container("%USERPROFILE%"));
        // %TEMP% 本身就已经是叶子级目录，不在容器名单里
        assert!(!resolve_pattern("%TEMP%", &env()).is_broad_container("%TEMP%"));
        // 带下级段就不是容器了
        assert!(!resolve_pattern(r"%LOCALAPPDATA%\Temp", &env()).is_broad_container(r"%LOCALAPPDATA%\Temp"));
    }

    #[test]
    fn slash_and_backslash_are_the_same() {
        assert_eq!(segs_of("C:/a/b"), vec!["C:", "a", "b"]);
        assert_eq!(segs_of(r"C:\a\b\\"), vec!["C:", "a", "b"]);
    }
}
