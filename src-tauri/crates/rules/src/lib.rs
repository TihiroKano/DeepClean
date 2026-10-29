//! DeepClean 的清理规则引擎（M3-A）。
//!
//! **纯计算、零删除**：本 crate 里没有一行会动文件系统的代码。
//! 一条规则就是可序列化的数据（§15），执行留到 M3-C。行为基准是 TS 侧的 `core/rules/`。

pub mod builtin;
pub mod engine;
pub mod env;
pub mod matcher;
pub mod tree_source;
pub mod types;
pub mod validate;

pub use builtin::builtin_rules;
pub use env::{resolve_pattern, RuleEnv};
pub use tree_source::{FilteredSource, TreeSource};
pub use types::{
    AppFact, CleanStrategy, Risk, Rule, RuleCategory, RuleScanner, RuleScopeFence, BROAD_LEAF_NAMES, CONTAINER_VARS,
    FENCE_MINIMUM_DENY_PATTERNS, FORBIDDEN_PATH_PATTERNS, PACKAGE_TREE_NAMES, REPORT_ONLY_ROOT_PATTERNS, RULE_ENV_KEYS, RULE_FIELDS, RULE_OPTIONAL_FIELDS,
};
pub use validate::{default_unselectable_rule_ids, validate_rule_set, ProblemReason, RuleProblem, Validation};

pub fn name() -> &'static str {
    "deepclean-rules"
}

#[cfg(test)]
mod tests {
    #[test]
    fn name_is_stable() {
        assert_eq!(super::name(), "deepclean-rules");
    }
}
