//! **M3-B 的验收判据**：同一份夹具、同一棵树，两套预览实现各跑一次，**零容差**对账。
//!
//! TS 侧是行为基准（`core/rules/preview.ts`）；Rust 侧是 `deepclean-cleaner::build_preview_model`。
//! 两个实现对同一份报告给出的预估价只要差一处，执行器吃的就是两份不同的清单 —— 所以逐字段比。
//!
//! **归一化只有一处**：投影时把每个 `detail` 键摘掉（措辞不是契约 —— M3-A 对 `exclusions`
//! 是同一个纪律）。除此之外**逐字节比**，包括 `digest`。
//!
//! 依赖：本测试现起 `node` + `esbuild`（都来自本仓 `node_modules`）。缺了会**大声失败**，不静默跳过。
//!
//! ## ⚠ 一处**故意**留着的双向分叉（2026-10-13，M5-N）
//!
//! 「整项勾选的一条路径同时被逐路径勾选表达一次」这一形制，**两侧现在结论不同**：
//! Rust 只计一次钱并留一条 `duplicate-selection`，TS 仍各计一次（预估虚高）。
//! 这是人类伙伴的裁定（只修 Rust 侧）。2026-10-13 当天下午 Electron 壳整体删除
//! （`docs/acceptance/2026-10-13-electron-shell-removal.md`），所以 TS 侧的身份从"在发行的产品"
//! 变成**纯对账基准** —— 这条分叉不再伤任何用户，但它仍然是一个真实的口径差，别当已解决。
//!
//! ⇒ **本夹具刻意不含这一形制**（现有 case 里没有"整项与逐路径撞在同一条路径上"）。
//! 谁要往里加，加完必然红，而那条红是**分叉本身**，不是 Rust 算错了 —— 别照红去回退 Rust，
//! 要么连 `core/rules/preview.ts` 一起修，要么把这一格在文档里更正过来。
//! 证据：`scripts/m5n-tile-dup-e2e.ps1` 与 `docs/acceptance/2026-10-13-tauri-m5-n.md`。

use deepclean_cleaner::model::{PreviewBuildOptions, PreviewSelection};
use deepclean_cleaner::build_preview_model;
use deepclean_rules::engine::{evaluate_rules, EvaluateOptions};
use deepclean_rules::env::RuleEnv;
use deepclean_rules::tree_source::TreeSource;
use deepclean_rules::types::{FORBIDDEN_PATH_PATTERNS, REPORT_ONLY_ROOT_PATTERNS};
use deepclean_scanner::model::{Counters, ScanFile, ScanMode, ScanNode, ScanTree};
use deepclean_scanner::tree_index::TreeIndex;
use deepclean_scanner::volume::VolumeInfo;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

// 夹具在 `tests/data/`，**不能叫 `tests/fixtures/`** —— 本仓 `.gitignore:6` 有一条 `fixtures/`。
const FIXTURE_REL: &str = "src-tauri/crates/cleaner/tests/data/preview-parity.json";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().nth(3).expect("仓库根").to_path_buf()
}

/* ------------------------------------------------------------------ *
 * 夹具 → Rust 树（与 rules 那边的 loader 同口径：size_counted 必须自己累加）
 * ------------------------------------------------------------------ */

fn build_node(v: &Value) -> ScanNode {
    let mut n = ScanNode::dir(v["name"].as_str().unwrap().to_string(), v["path"].as_str().unwrap().to_string());
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
            attrs: f["attrs"].as_u64().unwrap_or(0) as u32,
        });
    }
    for c in v["children"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        n.children.push(build_node(c));
    }
    // `ScanNode::dir()` 把 size_counted 初始化成 0，真扫描器才一路累加 —— 少这一步，
    // 底账的 `present[].bytes` 会全变 0，而 0 与「没量到」是两句话。
    n.size_counted = n.files.iter().map(|f| f.counted).sum::<u64>()
        + n.children.iter().map(|c| c.size_counted).sum::<u64>();
    n.file_count = n.files.len() as u64 + n.children.iter().map(|c| c.file_count).sum::<u64>();
    n.dir_count = n.children.len() as u64 + n.children.iter().map(|c| c.dir_count).sum::<u64>();
    n
}

fn tree_of(root: &Value) -> TreeIndex {
    let t = ScanTree {
            top: Vec::new(),
        root: build_node(root),
        counters: Counters::default(),
        volume: VolumeInfo { serial: 1, label: "fixture".into(), total_bytes: 1u64 << 62, free_bytes: 0 },
        skipped_sample: Vec::new(),
        skipped_sample_overflowed: false,
        mode: ScanMode::Walk,
        mft: None,
        elapsed_ms: 0,
    };
    TreeIndex::build(&t)
}

/* ------------------------------------------------------------------ *
 * TS 预览（现跑）
 * ------------------------------------------------------------------ */

fn run_ts(fixture_abs: &Path) -> Value {
    let root = repo_root();
    let esbuild = root.join("node_modules/esbuild/bin/esbuild");
    assert!(esbuild.exists(), "找不到 {} —— 对账需要本仓 node_modules。先 `npm i`。", esbuild.display());
    let tmp = std::env::temp_dir().join(format!("deepclean-m3b-preview-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).expect("建临时目录");
    let bundle = tmp.join("parity-preview.mjs");

    let out = Command::new("node")
        .arg(&esbuild)
        .args(["scripts/parity-preview.mjs", "--bundle", "--platform=node", "--format=esm"])
        .arg(format!("--outfile={}", bundle.display()))
        .current_dir(&root)
        .output()
        .expect("起 esbuild 失败（node 在 PATH 上吗？）");
    assert!(out.status.success(), "esbuild 打包失败：\n{}", String::from_utf8_lossy(&out.stderr));

    let out = Command::new("node").arg(&bundle).arg(fixture_abs).current_dir(&root).output().expect("起 node 跑 TS 预览失败");
    assert!(
        out.status.success(),
        "TS 预览脚本退出码 {:?}：\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("TS 侧必须吐合法 JSON 到 stdout")
}

/* ------------------------------------------------------------------ *
 * 唯一的归一化：摘掉每一个 `detail`
 * ------------------------------------------------------------------ */

fn strip_details(v: &mut Value) {
    match v {
        Value::Object(m) => {
            m.remove("detail");
            for (_, child) in m.iter_mut() {
                strip_details(child);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(strip_details),
        _ => {}
    }
}

/* ------------------------------------------------------------------ *
 * 对账
 * ------------------------------------------------------------------ */

#[test]
fn the_rust_preview_agrees_with_the_ts_preview_on_the_shared_fixture() {
    let fixture = repo_root().join(FIXTURE_REL);
    let fx: Value = serde_json::from_str(&std::fs::read_to_string(&fixture).expect("读夹具")).expect("夹具是 JSON");
    let ts = run_ts(&fixture);

    let default_env: RuleEnv = serde_json::from_value(fx["env"].clone()).expect("env");
    let now_ms = fx["nowMs"].as_i64().unwrap_or(0);
    let default_cap = fx["maxListedPaths"].as_u64().unwrap_or(50) as usize;

    let mut mismatches: Vec<String> = Vec::new();
    let mut checked = 0usize;

    for case in fx["cases"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let tree = tree_of(&fx["trees"][case["tree"].as_str().unwrap()]);
        let src = TreeSource::new(&tree);
        // `rules: "builtin"` = 直接用**各自那张内置表**（TS 侧 `scripts/parity-preview.mjs` 里同名分支）。
        // M5-P1 T5a 起这一格有独立价值：`PreviewItem.description` 是按 rule_id 从
        // `builtin_rules()` / `BUILTIN_RULES` 查出来的，所以只有走这个入口，跨实现比的那份
        // items + digest 里才**真的带着规则文案** —— 表两侧的措辞一旦漂（改了一句中文、少写一条），
        // 这个 case 当场点名。走 `ruleSets` 的那几组自定义 id 在表外 ⇒ 文案恒为空串。
        let rules: Vec<deepclean_rules::Rule> = match case["rules"].as_str().unwrap() {
            "builtin" => deepclean_rules::builtin_rules(),
            key => serde_json::from_value(fx["ruleSets"][key].clone()).expect("夹具里的规则集必须能解析成 Rule"),
        };
        let env: RuleEnv = match case.get("env") {
            Some(v) => serde_json::from_value(v.clone()).expect("case env"),
            None => default_env.clone(),
        };
        let cap = case["maxListedPaths"].as_u64().map(|v| v as usize).unwrap_or(default_cap);
        let mut collect = BTreeSet::new();
        for r in case["collectAllPathsFor"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            collect.insert(r.as_str().unwrap().to_string());
        }

        let opts = EvaluateOptions {
            now_ms,
            max_listed_paths: cap,
            collect_all_paths_for: collect,
            detector_status: Default::default(),
            forbidden_patterns: FORBIDDEN_PATH_PATTERNS.iter().map(|s| s.to_string()).collect(),
            report_only_patterns: REPORT_ONLY_ROOT_PATTERNS.iter().map(|s| s.to_string()).collect(),
            // §12 的认领表与预览对账无关：TS 那侧跑这份夹具也从不开 `reportClaims`
            // （它是 `scan-service` 收到 tilePaths 时才开的开关，不住在引擎/预览这一层）。
            report_claims: false,
            // M5-P1 T2：机器事实表两侧都挂空表（空表 = 声明它的规则一律弃权，两侧同解）
            // P2-T3 起的第二张表（弃权理由 `app_fact_whys`）同样挂空：夹具里没有带这个字段的规则。
            app_facts: Default::default(),
            app_fact_whys: Default::default(),
        };
        let report = evaluate_rules(&src, &rules, &env, &opts);
        let selection = PreviewSelection { items: case["selection"]["items"].clone() };
        let opts = PreviewBuildOptions {
            now_ms,
            default_unselectable_rule_ids: case["defaultUnselectableRuleIds"]
                .as_array()
                .map(|a| a.iter().map(|v| v.as_str().unwrap().to_string()).collect())
                .unwrap_or_default(),
        };
        let rust_model = build_preview_model(&report, &selection, &opts);

        let mut rust_v = serde_json::to_value(&rust_model).unwrap();
        let mut ts_v = ts[id].clone();
        strip_details(&mut rust_v);
        strip_details(&mut ts_v);

        checked += 1;
        if rust_v != ts_v {
            mismatches.push(diff_report(id, &rust_v, &ts_v));
        }
    }

    assert!(checked > 0, "夹具里一个 case 都没有 —— 判据空过比红更坏");
    assert!(
        mismatches.is_empty(),
        "Rust 预览与 TS 预览在 {} / {checked} 个 case 上不一致：\n\n{}",
        mismatches.len(),
        mismatches.join("\n\n")
    );
}

fn brief(v: &Value) -> String {
    let s = v.to_string();
    if s.len() <= 500 {
        s
    } else {
        format!("{}…（共 {} 字节）", &s[..500], s.len())
    }
}

/// 逐键比。**不做"只点名几个键"的白名单** —— 那会让新增字段的差异打印成一段空报告
/// （"红了但看不出哪里红"比红本身更坏）。
fn diff_report(id: &str, rust: &Value, ts: &Value) -> String {
    let mut out = format!("===== case `{id}` =====\n");
    let (ro, to) = (rust.as_object().unwrap(), ts.as_object().unwrap());
    let mut keys: Vec<&String> = ro.keys().chain(to.keys()).collect();
    keys.sort();
    keys.dedup();
    for k in keys {
        let (a, b) = (ro.get(k), to.get(k));
        if a == b {
            continue;
        }
        match (a.and_then(|v| v.as_array()), b.and_then(|v| v.as_array())) {
            (Some(x), Some(y)) if x.len() == y.len() => {
                for i in 0..x.len() {
                    if x[i] != y[i] {
                        out.push_str(&format!("  {k}[{i}]:\n    rust = {}\n    ts   = {}\n", brief(&x[i]), brief(&y[i])));
                    }
                }
            }
            _ => out.push_str(&format!(
                "  {k}:\n    rust = {}\n    ts   = {}\n",
                a.map(brief).unwrap_or_else(|| "<缺>".into()),
                b.map(brief).unwrap_or_else(|| "<缺>".into())
            )),
        }
    }
    out
}
