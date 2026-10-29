//! **M3-C-1 授权闸零容差对账**：Rust `gate.rs` 与 TS `core/clean/executor.ts`
//! 在同一份夹具上给出逐字段相等的 `CleanBlocker` / `CleanRefusal`。
//!
//! 对 `detail` 做唯一归一化：摘掉（措辞不是契约）。其余字段逐字比。
//!
//! 依赖：本测试现起 `node` + `esbuild`（都来自本仓 `node_modules`）。缺了会大声失败，不静默跳过。

use deepclean_cleaner::gate::{
    classify_path, guard_authorized_root, resolve_roots, CleanBlocker, CleanBlockerReason, CleanRefusal,
    CleanRefusalReason, ResolvedPatterns, RootKind,
};
use deepclean_rules::env::RuleEnv;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;

const FIXTURE_REL: &str = "src-tauri/crates/cleaner/tests/data/gate-parity.json";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("仓库根")
        .to_path_buf()
}

/* ------------------------------------------------------------------ *
 * 夹具 → Rust 结构
 * ------------------------------------------------------------------ */

fn env_of(fx: &Value) -> RuleEnv {
    let mut env = RuleEnv::new();
    for (k, v) in fx["env"].as_object().unwrap() {
        env.insert(k.clone(), v.as_str().unwrap().to_string());
    }
    env
}

fn resolved_of(patterns: &[String], env: &RuleEnv) -> ResolvedPatterns {
    resolve_roots(patterns, env)
}

fn patterns_from(fx: &Value, case: &Value, key: &str) -> Vec<String> {
    let empty: Vec<Value> = Vec::new();
    let arr = case
        .get(key)
        .and_then(|v| v.as_array())
        .or_else(|| fx.get(key).and_then(|v| v.as_array()))
        .unwrap_or(&empty);
    arr.iter().map(|v| v.as_str().unwrap().to_string()).collect()
}

fn probe_kind(s: &str) -> RootKind {
    match s {
        "Missing" => RootKind::Missing,
        "NotADirectory" => RootKind::NotADirectory,
        "ReparsePoint" => RootKind::ReparsePoint,
        "Unstatable" => RootKind::Unstatable,
        _ => RootKind::Directory,
    }
}

/* ------------------------------------------------------------------ *
 * TS 基准（现跑）
 * ------------------------------------------------------------------ */

fn run_ts(fixture_abs: &Path) -> Value {
    let root = repo_root();
    let esbuild = root.join("node_modules/esbuild/bin/esbuild");
    assert!(
        esbuild.exists(),
        "找不到 {} —— 对账需要本仓 node_modules。先 `npm i` 。",
        esbuild.display()
    );
    let tmp = std::env::temp_dir().join(format!("deepclean-m3c-gate-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).expect("建临时目录");
    let bundle = tmp.join("parity-gate.mjs");

    let out = Command::new("node")
        .arg(&esbuild)
        .args(["scripts/parity-gate.mjs", "--bundle", "--platform=node", "--format=esm"])
        .arg(format!("--outfile={}", bundle.display()))
        .current_dir(&root)
        .output()
        .expect("起 esbuild 失败（node 在 PATH 上吗？）");
    assert!(out.status.success(), "esbuild 打包失败：\n{}", String::from_utf8_lossy(&out.stderr));

    let out = Command::new("node")
        .arg(&bundle)
        .arg(fixture_abs)
        .current_dir(&root)
        .output()
        .expect("起 node 跑 TS 授权闸失败");
    let _ = std::fs::remove_dir_all(&tmp);
    assert!(
        out.status.success(),
        "TS 授权闸脚本退出码 {:?}：\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("TS 侧必须吐合法 JSON 到 stdout")
}

/* ------------------------------------------------------------------ *
 * 归一化：摘掉 detail
 * ------------------------------------------------------------------ */

fn normalize(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.remove("detail");
            // overlapOf 只在有值时才是契约字段；TS 侧无重叠时吐 null，Rust 侧省略，归一成省略。
            if matches!(m.get("overlapOf"), Some(Value::Null)) {
                m.remove("overlapOf");
            }
            for (_, child) in m.iter_mut() {
                normalize(child);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(normalize),
        _ => {}
    }
}

/* ------------------------------------------------------------------ *
 * 对账
 * ------------------------------------------------------------------ */

#[test]
fn the_rust_gate_agrees_with_the_ts_gate_on_the_shared_fixture() {
    let fixture = repo_root().join(FIXTURE_REL);
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(&fixture).expect("读夹具")).expect("夹具是 JSON");
    let ts = run_ts(&fixture);
    let env = env_of(&fx);

    let mut mismatches: Vec<String> = Vec::new();
    let mut checked_blockers = 0usize;
    let mut checked_refusals = 0usize;
    let mut documented_refusals = 0usize;

    // ---- blocker cases ----
    for case in fx["blockerCases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let root = case["root"].as_str().unwrap();
        let forbidden = resolved_of(&patterns_from(&fx, case, "forbiddenPatterns"), &env);
        let report_only = resolved_of(&patterns_from(&fx, case, "reportOnlyPatterns"), &env);
        let deny = resolved_of(&patterns_from(&fx, case, "denyRoots"), &env);
        let probe = probe_kind(case["probe"].as_str().unwrap_or("Directory"));

        let rust = guard_authorized_root(root, &forbidden, &deny, &report_only, |_| probe);
        let ts_v = ts["blockerCases"][id].clone();

        let mut rust_v = serde_json::to_value(&GateResult::from(rust)).unwrap();
        let mut ts_v = ts_v.clone();
        normalize(&mut rust_v);
        normalize(&mut ts_v);

        checked_blockers += 1;
        if rust_v != ts_v {
            mismatches.push(format!("blocker case `{id}`:\n  rust = {}\n  ts   = {}", brief(&rust_v), brief(&ts_v)));
        }
    }

    // ---- refusal cases ----
    for case in fx["refusalCases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let path = case["path"].as_str().unwrap();
        let authorized_root = case["authorizedRoot"].as_str().unwrap();
        let forbidden = resolved_of(&patterns_from(&fx, case, "forbiddenPatterns"), &env);
        let report_only = resolved_of(&patterns_from(&fx, case, "reportOnlyPatterns"), &env);
        let scope = case["scope"].as_str().unwrap_or("classify");

        let rust = classify_path(path, authorized_root, &forbidden, &report_only);
        let ts_v = ts["refusalCases"][id].clone();

        if scope == "documented" {
            // 这些 reason 在 TS 执行器第二遍 / lstat 阶段才产生，classify_path 第一道闸返回 Ok。
            // 我们只钉住：Rust 与 TS 第一道闸都放行（即都返回空 refusals）。
            documented_refusals += 1;
            if !rust.is_ok() {
                mismatches.push(format!(
                    "documented refusal case `{id}`: Rust classify_path 应放行（第一道闸），却返回 {:?}",
                    rust
                ));
            }
            if ts_v["refusals"].as_array().map(|a| !a.is_empty()).unwrap_or(false) {
                mismatches.push(format!(
                    "documented refusal case `{id}`: TS 第一道闸应放行，却返回 {:?}",
                    ts_v
                ));
            }
            continue;
        }

        let mut rust_v = serde_json::to_value(&RefusalResult::from(rust)).unwrap();
        let mut ts_v = ts_v.clone();
        normalize(&mut rust_v);
        normalize(&mut ts_v);

        checked_refusals += 1;
        if rust_v != ts_v {
            mismatches.push(format!("refusal case `{id}`:\n  rust = {}\n  ts   = {}", brief(&rust_v), brief(&ts_v)));
        }
    }

    assert!(checked_blockers > 0, "夹具里一个 blocker case 都没有 —— 判据空过比红更坏");
    assert!(checked_refusals > 0, "夹具里一个 classify-scope refusal case 都没有 —— 判据空过比红更坏");
    assert!(
        mismatches.is_empty(),
        "Rust 授权闸与 TS 授权闸在 {} 个 case 上不一致（blocker={checked_blockers}, classify refusal={checked_refusals}, documented={documented_refusals}）：\n\n{}",
        mismatches.len(),
        mismatches.join("\n\n")
    );
}

/* ------------------------------------------------------------------ *
 * 把 Rust 返回值转成与 TS 输出同形的结构
 * ------------------------------------------------------------------ */

#[derive(serde::Serialize)]
struct GateResult {
    blockers: Vec<CleanBlocker>,
}

impl From<Result<(), Vec<CleanBlocker>>> for GateResult {
    fn from(r: Result<(), Vec<CleanBlocker>>) -> Self {
        Self {
            blockers: match r {
                Ok(()) => Vec::new(),
                Err(blockers) => blockers,
            },
        }
    }
}

#[derive(serde::Serialize)]
struct RefusalResult {
    refusals: Vec<CleanRefusal>,
}

impl From<Result<(), CleanRefusal>> for RefusalResult {
    fn from(r: Result<(), CleanRefusal>) -> Self {
        Self {
            refusals: match r {
                Ok(()) => Vec::new(),
                Err(refusal) => vec![refusal],
            },
        }
    }
}

fn brief(v: &Value) -> String {
    let s = v.to_string();
    if s.len() <= 500 {
        s
    } else {
        format!("{}…（共 {} 字节）", &s[..500], s.len())
    }
}

/* ------------------------------------------------------------------ *
 * 枚举存在性：确保 fixture 真的覆盖了全部 12+13 个 reason
 * ------------------------------------------------------------------ */

#[test]
fn fixture_covers_all_blocker_and_refusal_reasons() {
    let fixture = repo_root().join(FIXTURE_REL);
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(&fixture).expect("读夹具")).expect("夹具是 JSON");

    let expected_blockers: std::collections::HashSet<&str> = [
        "root-malformed",
        "root-not-absolute",
        "root-is-drive-root",
        "root-missing",
        "root-not-a-directory",
        "root-is-reparse-point",
        "root-unstatable",
        "root-forbidden",
        "root-report-only",
        "root-ancestor-of-forbidden",
        "root-forbidden-unresolved",
        "root-denied-by-caller",
    ]
    .into_iter()
    .collect();

    let expected_refusals: std::collections::HashSet<&str> = [
        "out-of-scope",
        "overlaps-out-of-scope",
        "equals-authorized-root",
        "parent-traversal",
        "forbidden-root",
        "report-only-root",
        "forbidden-roots-unresolved",
        "reparse-point",
        "reparse-ancestor",
        "not-found",
        "unstatable",
        "malformed-path",
        "not-a-deletable-entry",
    ]
    .into_iter()
    .collect();

    let mut seen_blockers = std::collections::HashSet::new();
    for case in fx["blockerCases"].as_array().unwrap() {
        seen_blockers.insert(case["expected"].as_str().unwrap());
    }

    let mut seen_refusals = std::collections::HashSet::new();
    for case in fx["refusalCases"].as_array().unwrap() {
        seen_refusals.insert(case["expected"].as_str().unwrap());
    }

    let missing_blockers: Vec<_> = expected_blockers.difference(&seen_blockers).copied().collect();
    let missing_refusals: Vec<_> = expected_refusals.difference(&seen_refusals).copied().collect();

    assert!(
        missing_blockers.is_empty(),
        "夹具缺 blocker reason: {:?}",
        missing_blockers
    );
    assert!(
        missing_refusals.is_empty(),
        "夹具缺 refusal reason: {:?}",
        missing_refusals
    );
}

/* ------------------------------------------------------------------ *
 * 枚举序列化 sanity：kebab-case 必须保持与 TS 字面量一致
 * ------------------------------------------------------------------ */

#[test]
fn blocker_reasons_serialize_to_kebab_case() {
    let cases: &[(CleanBlockerReason, &str)] = &[
        (CleanBlockerReason::RootMalformed, "root-malformed"),
        (CleanBlockerReason::RootNotAbsolute, "root-not-absolute"),
        (CleanBlockerReason::RootIsDriveRoot, "root-is-drive-root"),
        (CleanBlockerReason::RootMissing, "root-missing"),
        (CleanBlockerReason::RootNotADirectory, "root-not-a-directory"),
        (CleanBlockerReason::RootIsReparsePoint, "root-is-reparse-point"),
        (CleanBlockerReason::RootUnstatable, "root-unstatable"),
        (CleanBlockerReason::RootForbidden, "root-forbidden"),
        (CleanBlockerReason::RootReportOnly, "root-report-only"),
        (CleanBlockerReason::RootAncestorOfForbidden, "root-ancestor-of-forbidden"),
        (CleanBlockerReason::RootForbiddenUnresolved, "root-forbidden-unresolved"),
        (CleanBlockerReason::RootDeniedByCaller, "root-denied-by-caller"),
    ];
    for (reason, expected) in cases {
        let got = serde_json::to_string(reason).unwrap();
        assert_eq!(got, format!("\"{}\"", expected), "CleanBlockerReason 序列化不一致");
    }
}

#[test]
fn refusal_reasons_serialize_to_kebab_case() {
    let cases: &[(CleanRefusalReason, &str)] = &[
        (CleanRefusalReason::OutOfScope, "out-of-scope"),
        (CleanRefusalReason::OverlapsOutOfScope, "overlaps-out-of-scope"),
        (CleanRefusalReason::EqualsAuthorizedRoot, "equals-authorized-root"),
        (CleanRefusalReason::ParentTraversal, "parent-traversal"),
        (CleanRefusalReason::ForbiddenRoot, "forbidden-root"),
        (CleanRefusalReason::ReportOnlyRoot, "report-only-root"),
        (CleanRefusalReason::ForbiddenRootsUnresolved, "forbidden-roots-unresolved"),
        (CleanRefusalReason::ReparsePoint, "reparse-point"),
        (CleanRefusalReason::ReparseAncestor, "reparse-ancestor"),
        (CleanRefusalReason::NotFound, "not-found"),
        (CleanRefusalReason::Unstatable, "unstatable"),
        (CleanRefusalReason::MalformedPath, "malformed-path"),
        (CleanRefusalReason::NotADeletableEntry, "not-a-deletable-entry"),
        (CleanRefusalReason::PermanentWithoutConfirmation, "permanent-without-confirmation"),
    ];
    for (reason, expected) in cases {
        let got = serde_json::to_string(reason).unwrap();
        assert_eq!(got, format!("\"{}\"", expected), "CleanRefusalReason 序列化不一致");
    }
}
