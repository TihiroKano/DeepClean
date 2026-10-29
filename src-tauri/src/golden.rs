//! M5-P1 T6：本机 golden 对账。**全部 `#[ignore]`** —— 要真扫整卷 + 几十秒到几分钟墙钟，
//! 进了常规闸就把整套闸拖成一次磁盘体检。
//!
//! ## 为什么走 `service::rule_report` 而不是自己拼一遍
//!
//! golden 判的是"产品在这台机器上会给出什么"。这里若自己组一份 `RuleEnv`、自己建
//! `TreeSource`、自己挑 `EvaluateOptions`，那量的就是**我这个 harness**，不是产品 ——
//! 两侧同口径的对账证不了任何事。所以本文件只做三件事：扫一棵真树、调产品那个函数、把结果打出来。
//! 环境表与选项**一律用产品那条路径**（`service::rule_env()` / `rule_report()`）。
//!
//! ## 只读
//!
//! 这条通道一行删除代码都不碰：`evaluate_rules` 是纯计算（`crates/rules/src/lib.rs:4`），
//! 本文件也只 import 扫描与评估。没有 `dc_execute`、没有 `ExecuteCtx`。
//!
//! ## 跑法
//!
//! ```text
//! cd src-tauri && source ../scripts/rust-env.sh
//! cargo test -p deepclean-app --bin deepclean-app golden:: -- --ignored --nocapture
//! ```

use deepclean_scanner::scan::{scan_tree, ScanOptions};
use deepclean_scanner::tree_index::TreeIndex;
use deepclean_scanner::volume::volume_of;
use std::path::PathBuf;

/// 前 15 条（本次改动**之前**的内置表）的 id —— 基线那一栏只加这些，逐条点名不许靠顺序猜。
/// 顺序与 `builtin.rs` 的有序 id 测试同源；漂了就是那边先红。
const PRE_EXISTING: [&str; 15] = [
    "windows-temp",
    "browser-cache",
    "thumbnail-cache",
    "shader-cache",
    "error-reporting",
    "recycle-bin",
    "npm-cache",
    "pip-cache",
    "gradle-cache",
    "vscode-cache",
    "maven-repository",
    "pnpm-store",
    "yarn-cache",
    "huggingface-cache",
    "android-sdk-temp",
];

/// 本轮新增的六条（M5-P1 T3a/T3b-i/T3b-ii）。
const NEW_RULES: [&str; 6] = [
    "app-cache-data",
    "app-rotated-logs",
    "installer-artifacts",
    "dev-tool-cache",
    "crash-dumps",
    "user-downloads-installers",
];

/// M5-P2 那条吃**机器事实表**的规则（第 22 条）。单独一组：它的字节不进 P1 那六条的账，
/// 而它能不能出条目取决于 C5/C1 那几路探针有没有跑完 —— 混在一组里就看不出这一点。
const P2_RULES: [&str; 1] = ["orphan-app-data"];

/// 反例：这些路径前缀**不许**出现在任何**可清理** finding 的 `matchedRoots` 里（golden §四）。
/// 命中即红 —— 这一半才是"判据不太宽"的证据。
/// 注意 `$Recycle.Bin` 的口径：`recycle-bin` 那条 🔴 规则**本来就该**点名它并如实报告占用，
/// 所以判据是"非 🔴 的 finding 不许吃它"，不是"任何 finding 不许含它"（第一版我写成后者，
/// 被自己这条闸当场判红 —— 那是 harness 过宽，不是产品越界）。
const FORBIDDEN_HITS: [&str; 10] = [
    r"program files",
    r"program files (x86)",
    r"\winsxs\",
    r"\system32\",
    r"\windows\installer",
    r"$recycle.bin",
    // T6 真机跑出来的那一条：病毒特征库不是安装包
    r"microsoft\windows defender",
    r"\system volume information",
    // P2-T5：真机上 app-cache-data 曾认领 10 个 node_modules 里名叫 cache 的**源码目录**。
    // 包树排除落地后这里必须恒为 0 —— 它不是重复测一遍排除逻辑，而是一条漂移探针：
    // 哪天 PACKAGE_TREE_NAMES 被动了，这里先红。
    r"\node_modules\",
    r"\appdata\local\programs\nodejs\",
];

fn mib(b: u64) -> f64 {
    (b as f64) / 1_048_576.0
}

fn gib(b: u64) -> f64 {
    (b as f64) / 1_073_741_824.0
}

#[test]
#[ignore = "真扫整卷 C:\\，几十秒到几分钟；只在 T6 验收时手动跑"]
fn golden_reconciliation_on_this_machine() {
    let root = PathBuf::from(std::env::var("DC_GOLDEN_ROOT").unwrap_or_else(|_| r"C:\".to_string()));
    let volume = volume_of(&root).expect("取卷几何失败");
    println!(
        "[卷] {} 总={:.2} GiB 可用={:.2} GiB",
        volume.label,
        gib(volume.total_bytes),
        gib(volume.free_bytes)
    );

    let mut last = std::time::Instant::now();
    let tree = match scan_tree(&ScanOptions::new(&root), &volume, move |c| {
        if last.elapsed().as_secs_f64() > 20.0 {
            println!("[进度] files={} dirs={}", c.files, c.dirs);
            last = std::time::Instant::now();
        }
    }) {
        Ok(t) => t,
        Err(e) => panic!("扫描失败：{e:?}"),
    };
    println!("[扫完] files={} dirs={}", tree.counters.files, tree.counters.dirs);

    let idx = TreeIndex::build(&tree);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    // ↓↓↓ 产品那条路径，一个参数都不自己发明 ↓↓↓
    let report = crate::service::rule_report_with_facts(&idx, now, false, crate::service::app_facts_for_tree(&idx));

    let mut baseline: u64 = 0;
    let mut added: u64 = 0;
    let mut orphan_bytes: u64 = 0;
    println!("\n=== 逐条 finding（按表序）===");
    for f in &report.findings {
        let group = if PRE_EXISTING.contains(&f.rule_id.as_str()) {
            baseline += f.total_bytes;
            "旧"
        } else if NEW_RULES.contains(&f.rule_id.as_str()) {
            added += f.total_bytes;
            "新"
        } else if P2_RULES.contains(&f.rule_id.as_str()) {
            orphan_bytes += f.total_bytes;
            "P2"
        } else {
            panic!(
                "finding {} 不在 golden 的任何一组名单里 —— 内置表长了一条而这里没登记，\
                 那么「既有 15 / 新增 6」这两栏合计就不再把账算死，绿灯不再说明任何口径",
                f.rule_id
            );
        };
        println!(
            "[{}] {:<28} {:?} files={:<8} {:>9.2} MiB roots={}",
            group,
            f.rule_id,
            f.risk_level,
            f.file_count,
            mib(f.total_bytes),
            f.matched_roots.len()
        );
    }
    println!("\n=== 合计 ===");
    println!(
        "既有 15 条基线 = {:.2} MiB   M5-P1 新增 6 条 = {:.2} MiB   M5-P2 那条（第 22 条）= {:.2} MiB",
        mib(baseline),
        mib(added),
        mib(orphan_bytes)
    );
    println!(
        "bytes_by_risk safe={:.2} caution={:.2} high={:.2} forbidden={:.2} MiB",
        mib(report.bytes_by_risk.safe),
        mib(report.bytes_by_risk.caution),
        mib(report.bytes_by_risk.high),
        mib(report.bytes_by_risk.forbidden)
    );
    println!("reclaimable_bytes = {:.2} MiB   safety_blocked = {}", mib(report.reclaimable_bytes), report.safety_blocked);

    // 第 22 条的两条硬要求，由 harness 自己打出来（验收文档引这两行，不引我手读 JSON 的结论）。
    match report.findings.iter().find(|f| f.rule_id == "orphan-app-data") {
        Some(f) => {
            let excluded = report
                .exclusions
                .iter()
                .filter(|e| e.rule_id.as_deref() == Some("orphan-app-data") && format!("{:?}", e.reason) != "ClaimedByOtherRule")
                .count();
            println!(
                "orphan-app-data: risk={:?} roots={} files={:.0} bytes={:.2} MiB —— 弃权 {} 条（Present/Unknown，逐条带 why）",
                f.risk_level,
                f.matched_roots.len(),
                f.file_count,
                mib(f.total_bytes),
                excluded
            );
        }
        None => println!(
            "orphan-app-data: 本轮**没有** finding —— 一个 Absent 都没证出来。零不是干净：\
             这台机器有审计确认的残留，所以这一行意味着探针弃权过头（见 C5/角色词那两处真机缺陷）"
        ),
    }

    let mut by_reason: std::collections::BTreeMap<String, usize> = Default::default();
    for e in &report.exclusions {
        *by_reason.entry(format!("{:?}", e.reason)).or_default() += 1;
    }
    println!("\n=== 排除记录按理由分组（点名条数）===");
    for (reason, n) in &by_reason {
        println!("{reason:<26} {n}");
    }
    // 反空跑：包树排除在参考机上必须**非零**。这里"零"不是干净，是那道检查不咬了 ——
    // 而它报出来的样子和"这台机器就是没有包树"完全一样，只有钉住才分得开。
    let pkg = by_reason.get("PackageTree").copied().unwrap_or(0);
    println!("PackageTree 排除 = {pkg}（参考机实测 131 量级）");
    assert!(pkg > 0, "package-tree 排除为 0 —— 检查要么没生效要么被删了，不是这台机器没有包树");

    // 反例闸：任何 finding 的 matchedRoots 落在禁入前缀里 = 判据太宽
    println!("\n=== 反例闸（命中即红）===");
    let mut offenders = Vec::new();
    for f in &report.findings {
        // 🔴 那条规则的职责就是点名回收站并如实报告占用，它不参与"能不能删"的反例判定
        if f.risk_level == deepclean_rules::types::Risk::Forbidden {
            continue;
        }
        for r in &f.matched_roots {
            let low = r.to_lowercase();
            if let Some(p) = FORBIDDEN_HITS.iter().find(|p| low.contains(*p)) {
                offenders.push((f.rule_id.clone(), r.clone(), (*p).to_string()));
            }
        }
    }
    if offenders.is_empty() {
        println!("零命中 —— 没有任何 finding 的地盘落在 Program Files / Windows / 回收站里");
    } else {
        for (id, root, pat) in &offenders {
            println!("违规 {id} 的地盘 {root} 含禁入前缀 {pat}");
        }
    }

    // 机器可读那一份，给验收文档引用
    let json = serde_json::to_string_pretty(&report).expect("报告序列化失败");
    let out = std::env::var("DC_GOLDEN_OUT").unwrap_or_else(|_| "target/m5-p-golden-report.json".to_string());
    std::fs::write(&out, json).expect("写 JSON 失败");
    println!("\n[落盘] {out}");

    assert!(offenders.is_empty(), "反例闸命中 {offenders:?}");
    assert!(!report.safety_blocked, "safety_blocked=true 时这份报告不可用于清理决策");
}
