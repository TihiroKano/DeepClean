//! **M3-A 的验收判据**：同一份夹具、同一份注入 env，两套引擎各跑一次，**零容差**对账。
//!
//! TS 侧是行为基准（`core/rules`，本仓正在跑的那一套）；Rust 侧是 `deepclean-rules`。
//! 两个实现对「什么可删」的判断只要差一处，就是两套事实源 —— 所以这里比的是**逐条**而不是总数。
//!
//! 比什么（四轴 + 三项结构面）：
//!   · 每条 finding 的 `ruleId` / `fileCount` / `totalBytes` / `samplePaths`（含顺序）
//!   · `matchedRoots`、`sampleTruncated`
//!   · findings 的**次序**（= 规则表次序；`claimed` 是先声明者计账，次序本身是行为）
//!   · `exclusions` 的 `(ruleId, reason, normalizeKey(path))` 三元组（按序无关地比集合）
//!   · 被整条拒掉的规则 id 集合、`reclaimableBytes`、`safetyBlocked`
//!
//! **归一化只在这一处发生，且两侧共用同一个投影函数** —— 两侧各自归一化到"看起来一致"
//! 会把真差异抹平（那正是本项目记过账的那类假绿灯）。
//!
//! 依赖：本测试会现起 `node` + `esbuild`（都来自本仓 `node_modules`）跑 TS 引擎。
//! 缺了它们会**大声失败**，不是静默跳过 —— 静默跳过的验收等于没有验收。

use deepclean_rules::engine::{evaluate_rules, EvaluateOptions, ExclusionReason};
use deepclean_rules::env::RuleEnv;
use deepclean_rules::tree_source::TreeSource;
use deepclean_rules::types::{FORBIDDEN_PATH_PATTERNS, REPORT_ONLY_ROOT_PATTERNS};
use deepclean_scanner::model::{Counters, ScanFile, ScanMode, ScanNode, ScanTree};
use deepclean_scanner::tree_index::TreeIndex;
use deepclean_scanner::volume::VolumeInfo;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

// 夹具住在 `tests/data/`，**不能叫 `tests/fixtures/`** —— 本仓 `.gitignore:6` 有一条
// `fixtures/`，放那儿会让夹具被静默忽略（测试在别人机器上找不到它，而"没跑"与"通过"长得一样）。
const FIXTURE_REL: &str = "src-tauri/crates/rules/tests/data/m3-parity.json";

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/src-tauri/crates/rules
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .expect("仓库根")
        .to_path_buf()
}

/* ------------------------------------------------------------------ *
 * 夹具 → Rust 树
 * ------------------------------------------------------------------ */

fn build_node(v: &Value) -> ScanNode {
    let name = v["name"].as_str().unwrap().to_string();
    let path = v["path"].as_str().unwrap().to_string();
    let mut n = ScanNode::dir(name, path);
    n.attrs = v["attrs"].as_u64().unwrap_or(0) as u32;
    n.mtime_ms = v["mtimeMs"].as_i64().unwrap_or(0);
    for f in v["files"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        n.files.push(ScanFile {
            name: f["name"].as_str().unwrap().to_string(),
            size: f["size"].as_u64().unwrap_or(0),
            alloc: f["size"].as_u64().unwrap_or(0),
            counted: f["size"].as_u64().unwrap_or(0),
            file_id: 1,
            mtime_ms: f["mtimeMs"].as_i64().unwrap_or(0),
            creation_ms: 0,
            // 夹具里的 `attrs` 是**真值**，两侧都读它；漏读会让 protected-attrs 判据静默失效
            attrs: f["attrs"].as_u64().unwrap_or(0) as u32,
        });
    }
    for c in v["children"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        n.children.push(build_node(c));
    }
    // **必须自己把合计算出来**：`ScanNode::dir()` 把 `size_counted` 初始化成 0，
    // 而真扫描器是一路累加上去的。少这一步，`TreeIndex::size_of` 会让底账里的
    // `present[].bytes` 全变 0 —— 而 0 与「没量到」在报告里是两句话。
    n.size_counted = n.files.iter().map(|f| f.counted).sum::<u64>()
        + n.children.iter().map(|c| c.size_counted).sum::<u64>();
    n.size_logical = n.files.iter().map(|f| f.size).sum::<u64>()
        + n.children.iter().map(|c| c.size_logical).sum::<u64>();
    n.size_alloc = n.size_counted;
    n.file_count = n.files.len() as u64 + n.children.iter().map(|c| c.file_count).sum::<u64>();
    n.dir_count = n.children.len() as u64 + n.children.iter().map(|c| c.dir_count).sum::<u64>();
    n
}

fn tree_of(case: &Value) -> TreeIndex {
    let root = build_node(&case["root"]);
    let t = ScanTree {
            top: Vec::new(),
        root,
        counters: Counters::default(),
        volume: VolumeInfo { serial: 1, label: "fixture".into(), total_bytes: u64::MAX, free_bytes: 0 },
        skipped_sample: Vec::new(),
        skipped_sample_overflowed: false,
        mode: ScanMode::Walk,
        mft: None,
        elapsed_ms: 0,
    };
    TreeIndex::build(&t)
}

fn rules_of(case: &Value) -> Vec<deepclean_rules::Rule> {
    match &case["rules"] {
        Value::String(s) if s == "builtin" => deepclean_rules::builtin_rules(),
        v => serde_json::from_value(v.clone()).expect("夹具里的自造规则必须能解析成 Rule"),
    }
}

/* ------------------------------------------------------------------ *
 * TS 引擎（现跑）
 * ------------------------------------------------------------------ */

fn run_ts(fixture_abs: &Path) -> Value {
    let root = repo_root();
    let esbuild = root.join("node_modules/esbuild/bin/esbuild");
    assert!(
        esbuild.exists(),
        "找不到 {} —— 对账需要本仓 node_modules。先 `npm i`。",
        esbuild.display()
    );
    let tmp = std::env::temp_dir().join(format!("deepclean-m3-parity-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).expect("建临时目录");
    let bundle = tmp.join("parity.mjs");

    let out = Command::new("node")
        .arg(&esbuild)
        .args(["scripts/parity-rules.mjs", "--bundle", "--platform=node", "--format=esm"])
        .arg(format!("--outfile={}", bundle.display()))
        .current_dir(&root)
        .output()
        .expect("起 esbuild 失败（node 在 PATH 上吗？）");
    assert!(
        out.status.success(),
        "esbuild 打包失败：\n{}",
        String::from_utf8_lossy(&out.stderr)
    );

    let out = Command::new("node")
        .arg(&bundle)
        .arg(fixture_abs)
        .current_dir(&root)
        .output()
        .expect("起 node 跑 TS 引擎失败");
    assert!(
        out.status.success(),
        "TS 引擎脚本退出码 {:?}：\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("TS 侧必须吐合法 JSON 到 stdout")
}

/* ------------------------------------------------------------------ *
 * 两侧 → 同一个可比的投影（**唯一**的归一化处）
 * ------------------------------------------------------------------ */

type ExclusionKey = (String, String, String);

/// 排除项归一成三元组；`rule-rejected` 那条**不比路径**。
///
/// ~~Rust 侧目前只写 `""`~~ —— 这句已经过期：`engine.rs` 现在把 `p.path` 原样带进排除记录。
/// 不比路径的真正原因换成了一个更具体的：**两侧把"出问题的那个模板"放在不同字段里**。
/// 以 `relative` 那条规则为例（paths 里写了相对路径）：
///  · TS `engine.ts:226` 调的是 `problem(r.id, 'invalid-shape', …)` ⇒ `path` = **规则 id**，
///    出问题的模板在 `detail` 的串里；
///  · Rust `validate.rs` 给的是**那个模板** ⇒ `path` = `AppData\Local\Temp`。
/// 两边信息都不缺，只是落在不同格子。要统一就得单方面改一侧的字段语义（而 `path` 是要上界面的
/// 排除面板那一列），不属于"比出来"的范围 —— 所以显式忽略，并把这个差记在这里，
/// 而不是算成一致替它背书。
fn exclusion_key(rule_id: Option<&str>, path: &str, reason: &str) -> ExclusionKey {
    let p = if reason == "rule-rejected" { String::new() } else { normalize(path) };
    (rule_id.unwrap_or("").to_string(), reason.to_string(), p)
}

fn normalize(p: &str) -> String {
    deepclean_rules::engine::normalize_key(p)
}

fn reason_str(r: ExclusionReason) -> String {
    serde_json::to_value(r).unwrap().as_str().unwrap().to_string()
}

/// Rust 报告 → 投影。
fn project_rust(report: &deepclean_rules::engine::RuleReport) -> Value {
    let findings: Vec<Value> = report
        .findings
        .iter()
        .map(|f| {
            json!({
                "ruleId": f.rule_id,
                "category": f.category,
                "cleanStrategy": f.clean_strategy,
                "recoverable": f.recoverable,
                "fileCount": f.file_count,
                "totalBytes": f.total_bytes,
                "sampleTruncated": f.sample_truncated,
                "matchedRoots": f.matched_roots,
                "samplePaths": f.sample_paths.iter().map(|p| json!({"path": p.path, "size": p.size})).collect::<Vec<_>>(),
            })
        })
        .collect();
    let mut ex: BTreeSet<String> = BTreeSet::new();
    for e in &report.exclusions {
        let k = exclusion_key(e.rule_id.as_deref(), &e.path, &reason_str(e.reason));
        ex.insert(format!("{}|{}|{}", k.0, k.1, k.2));
    }
    // 与 .mjs 同一份投影：`{ruleId, name, problems:[{path, reason}]}`，外层按 ruleId 升序。
    // 两侧都**不排 problems**（引擎给的次序就是判据的一部分）。原来只比 id，
    // 于是 `name` 与逐条 `reason` 这两格从来没人比过 —— 而它们正是预览那句要念给用户的东西。
    let mut rejected: Vec<Value> = report
        .rejected_rules
        .iter()
        .map(|r| {
            json!({
                "ruleId": r.rule_id,
                "name": r.name,
                // 不比 `path`：理由与上面 `exclusion_key` 同源（TS 把规则 id 放这一格，
                // Rust 把出问题的模板放这一格）。比的是 `name` 与 `reason` —— 预览那句
                // `item-rejected` 要念给用户的正是这两样。
                "problems": r
                    .problems
                    .iter()
                    .map(|q| json!({ "reason": q.reason }))
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    rejected.sort_by(|a, b| a["ruleId"].as_str().cmp(&b["ruleId"].as_str()));
    let territories: Vec<Value> = report
        .territories
        .iter()
        .map(|t| {
            json!({
                "ruleId": t.rule_id,
                "detectorAbsent": t.detector_absent,
                "present": t.present.iter().map(|p| json!({"path": p.path, "bytes": p.bytes})).collect::<Vec<_>>(),
                "notScanned": t.not_scanned,
            })
        })
        .collect();
    json!({
        "findings": findings,
        "exclusions": ex.into_iter().collect::<Vec<_>>(),
        "rejectedRules": rejected,
        "bytesByRisk": serde_json::to_value(report.bytes_by_risk).unwrap(),
        "forbiddenRoots": report.forbidden_roots,
        "reportOnlyRoots": report.report_only_roots,
        "territories": territories,
        "reclaimableBytes": report.reclaimable_bytes,
        "safetyBlocked": report.safety_blocked,
    })
}

/// TS 报告（`scripts/parity-rules.mjs` 的原样输出）→ 同一个投影。
fn project_ts(v: &Value) -> Value {
    let findings: Vec<Value> = v["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            json!({
                "ruleId": f["ruleId"],
                "category": f["category"],
                "cleanStrategy": f["cleanStrategy"],
                "recoverable": f["recoverable"],
                "fileCount": f["fileCount"],
                "totalBytes": f["totalBytes"],
                "sampleTruncated": f["sampleTruncated"],
                "matchedRoots": f["matchedRoots"],
                "samplePaths": f["samplePaths"],
            })
        })
        .collect();
    let mut ex: BTreeSet<String> = BTreeSet::new();
    for e in v["exclusions"].as_array().unwrap() {
        let k = exclusion_key(
            e["ruleId"].as_str(),
            e["path"].as_str().unwrap_or(""),
            e["reason"].as_str().unwrap(),
        );
        ex.insert(format!("{}|{}|{}", k.0, k.1, k.2));
    }
    let mut rejected: Vec<Value> = v["rejectedRules"].as_array().unwrap().clone();
    rejected.sort_by(|a, b| a["ruleId"].as_str().cmp(&b["ruleId"].as_str()));
    let territories: Vec<Value> = v["territories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            json!({
                "ruleId": t["ruleId"],
                "detectorAbsent": t["detectorAbsent"],
                "present": t["present"].as_array().unwrap().iter().map(|p| json!({"path": p["path"], "bytes": p["bytes"]})).collect::<Vec<_>>(),
                "notScanned": t["notScanned"],
            })
        })
        .collect();
    json!({
        "findings": findings,
        "exclusions": ex.into_iter().collect::<Vec<_>>(),
        "rejectedRules": rejected,
        "bytesByRisk": v["bytesByRisk"],
        "forbiddenRoots": v["forbiddenRoots"],
        "reportOnlyRoots": v["reportOnlyRoots"],
        "territories": territories,
        "reclaimableBytes": v["reclaimableBytes"],
        "safetyBlocked": v["safetyBlocked"],
    })
}

/* ------------------------------------------------------------------ *
 * 对账
 * ------------------------------------------------------------------ */

#[test]
fn the_rust_engine_agrees_with_the_ts_engine_on_the_shared_fixture() {
    let fixture = repo_root().join(FIXTURE_REL);
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(&fixture).expect("读夹具"))
        .expect("夹具是 JSON");
    let ts = run_ts(&fixture);

    let env: RuleEnv = serde_json::from_value(fx["env"].clone()).expect("env");
    let now_ms = fx["nowMs"].as_i64().unwrap_or(0);
    let list_cap = fx["maxListedPaths"].as_u64().unwrap_or(50) as usize;

    let mut mismatches: Vec<String> = Vec::new();
    let mut checked = 0usize;

    for case in fx["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let tree = tree_of(case);
        let src = TreeSource::new(&tree);
        let rules = rules_of(case);
        // 逐 case 可以覆盖 env（fail-safe 那条路要一个"禁止根解析不出来"的环境）
        let case_env: RuleEnv = match case.get("env").and_then(|v| v.as_object()) {
            Some(o) => serde_json::from_value(Value::Object(o.clone())).expect("case env"),
            None => env.clone(),
        };

        let mut opts = EvaluateOptions {
            now_ms,
            max_listed_paths: list_cap,
            collect_all_paths_for: BTreeSet::new(),
            detector_status: BTreeMap::new(),
            forbidden_patterns: FORBIDDEN_PATH_PATTERNS.iter().map(|s| s.to_string()).collect(),
            report_only_patterns: REPORT_ONLY_ROOT_PATTERNS.iter().map(|s| s.to_string()).collect(),
            // 对账不开这张表：TS 侧那份夹具也从没带 `claimedPaths`（`reportClaims` 是 §12 才开的），
            // 一侧开一侧不开会让投影凭空多出一个键，而那不是引擎结论的差异。
            report_claims: false,
            // M5-P1 T2：机器事实表两侧都挂**空表**。空表 = 声明了 `requiresAbsentAppFact` 的规则
            // 一律弃权；一侧挂非空表才会造出"只有一边提议"的假差异，那对账就不是零容差。
            // P2-T3 起的第二张表（`app_fact_whys`，弃权理由）同样挂空：对账夹具里没有带这个字段的规则。
            app_facts: BTreeMap::new(),
            app_fact_whys: BTreeMap::new(),
        };
        if let Some(ds) = case["detectorStatus"].as_object() {
            for (k, v) in ds {
                opts.detector_status.insert(k.clone(), v.as_bool().unwrap_or(false));
            }
        }

        let rust = project_rust(&evaluate_rules(&src, &rules, &case_env, &opts));
        let ts_case = project_ts(&ts[id]);
        checked += 1;
        if rust != ts_case {
            mismatches.push(diff_report(id, &rust, &ts_case));
        }
    }

    assert!(checked > 0, "夹具里一个 case 都没有 —— 判据空过比红还坏");
    assert!(
        mismatches.is_empty(),
        "Rust 引擎与 TS 引擎在 {} / {checked} 个 case 上不一致：\n\n{}",
        mismatches.len(),
        mismatches.join("\n\n")
    );
}

fn diff_report(id: &str, rust: &Value, ts: &Value) -> String {
    fn brief(v: &Value) -> String {
        let s = v.to_string();
        if s.len() <= 400 {
            s
        } else {
            // ⚠️ 不能写 `&s[..400]`：那个下标是**字节**下标，切在 400 处时正好可能落在
            // 一个多字节 UTF-8 字符中间（报告里全是中文规则名），于是这段**诊断代码自己**
            // panic —— 症状是"红了但看不到哪里红"，比红本身更坏（2026-10-20 实测踩到）。
            // 按字符边界回退到最近的一个合法断点。
            let mut cut = 400;
            while cut > 0 && !s.is_char_boundary(cut) {
                cut -= 1;
            }
            format!("{}…（共 {} 字节）", &s[..cut], s.len())
        }
    }
    let mut out = format!("===== case `{id}` =====\n");
    // 逐键比：先前这里只点名了四个键，于是新增字段的差异会打印出一段**空报告**
    // —— 「红了但看不出哪里红」比红本身更坏。
    let (ro, to) = (rust.as_object().unwrap(), ts.as_object().unwrap());
    let mut keys: Vec<&String> = ro.keys().chain(to.keys()).collect();
    keys.sort();
    keys.dedup();
    for k in keys {
        let (a, b) = (ro.get(k), to.get(k));
        if a == b {
            continue;
        }
        match k.as_str() {
            "findings" => {
                let rf = a.and_then(|v| v.as_array().cloned()).unwrap_or_default();
                let tf = b.and_then(|v| v.as_array().cloned()).unwrap_or_default();
                if rf.len() != tf.len() {
                    out.push_str(&format!("  findings 条数: rust={} ts={}\n", rf.len(), tf.len()));
                }
                for i in 0..rf.len().max(tf.len()) {
                    match (rf.get(i), tf.get(i)) {
                        (Some(x), Some(y)) if x == y => {}
                        (x, y) => out.push_str(&format!(
                            "  findings[{i}]:\n    rust = {}\n    ts   = {}\n",
                            x.map(brief).unwrap_or_else(|| "<缺>".into()),
                            y.map(brief).unwrap_or_else(|| "<缺>".into()),
                        )),
                    }
                }
            }
            "exclusions" => {
                let re: BTreeSet<String> = a
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect();
                let te: BTreeSet<String> = b
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect();
                for k in re.difference(&te) {
                    out.push_str(&format!("  只有 rust 有这条排除: {k}\n"));
                }
                for k in te.difference(&re) {
                    out.push_str(&format!("  只有 ts 有这条排除:   {k}\n"));
                }
            }
            _ => out.push_str(&format!(
                "  {k}:\n    rust = {}\n    ts   = {}\n",
                a.map(brief).unwrap_or_else(|| "<缺>".into()),
                b.map(brief).unwrap_or_else(|| "<缺>".into()),
            )),
        }
    }
    out
}
