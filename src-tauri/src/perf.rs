//! M5-F「十万级文件不卡界面」那几笔成本的**室内**测量。全部 `#[ignore]`：要 100k 真文件的
//! 静止夹具与几十秒墙钟，不进常规闸（进了就把整套闸拖成一次磁盘体检）。
//!
//! 这里只量**纯计算**的代价，因为它们决定「扫描途中一次点击会不会把界面按住」。
//! 界面那半边（轮询延迟、峰值工作集、扫描途中点得动）只能在真窗口上量，
//! 由 `scripts/m5f-perf-e2e.ps1` 负责 —— 两边合起来才是这一格的证据。
//!
//! ## 为什么这几条值得单独量
//!
//! `service::build_preview` 抱着**会话锁**走完整个函数（那里有注释点名），而它里面依次做：
//! `rule_report_with_facts`（机器事实采集 + 引擎整树评估）→ §12 归属反查。
//! 扫描线程发布进度要拿的正是同一把锁。所以"卡不卡界面"不是一句感觉，而是这三段
//! 在锁里各花多少毫秒 —— 数出来才知道哪一段是真的。
//!
//! ## 跑法
//!
//! ```text
//! cargo test -p deepclean-app --bin deepclean-app perf:: -- --ignored --nocapture
//! ```
//!
//! 缺夹具时**大声失败**（下面 `fixture_root` 那条断言），不许静默跳过后回报"这一格过了"。

#![cfg(test)]

use crate::service;
use deepclean_scanner::scan::{scan_tree, ScanOptions};
use deepclean_scanner::tree_index::TreeIndex;
use deepclean_scanner::volume::volume_of;
use std::path::PathBuf;
use std::time::Instant;

/// 十万级静止夹具（`scripts/make-fixture.mjs` 造的，含 `System Volume Information` 与
/// 12 段 >260 字符的 `longpath` 两颗刻意布下的雷）。
const FIXTURE: &str = r"D:\deepclean-fixture\f100k";

/// 量哪一棵树。**两条轴要分开量**：`f100k` 是"文件多、目录少"（98k 文件 / 60 目录），
/// 拿它量 `knows_path_in_tree` 会得到一个好看的假数 —— 那条判据是**逐目录**线性扫的。
/// 所以目录那一轴要换一棵目录多的树（本机用 `DC_PERF_ROOT=C:\Windows` 跑第二遍）。
fn root_to_scan() -> PathBuf {
    match std::env::var("DC_PERF_ROOT") {
        Ok(s) if !s.trim().is_empty() => PathBuf::from(s.trim()),
        _ => PathBuf::from(FIXTURE),
    }
}

fn fixture_root() -> PathBuf {
    let p = root_to_scan();
    assert!(
        p.is_dir(),
        "要量的树不在：{p:?} —— 这一格**没跑**，不许写成通过。\
         （f100k 的造法：npm run fixture -- --files=100000 --out={FIXTURE}）"
    );
    p
}

/// **只扫描、只报数**的那一条 —— 给 M5-M 的「同刻背靠背对账」用。
///
/// 为什么不用上面那条 `hundred_thousand_files_the_five_numbers`：它后面还接了折 arena、
/// 整树规则评估、200 次反查、2 万组合成翻译，几十秒墙钟。而"同刻"这件事的全部意义是
/// **两次相邻运行之间这棵树自己没动**（M1/M2 那笔欠账就是这么来的：相邻两次跑差出
/// 125,125 vs 120,640，分不清是口径还是漂移）。窗口越宽，越可能量到的是漂移而不是差异。
/// 所以这里只留 `scan_tree` 一步，秒级。
///
/// 跑法（`DC_PERF_ROOT` 指定要量的树；缺了大声失败）：
/// ```text
/// DC_PERF_ROOT='C:\Windows\System32\en-US' \
///   cargo test --bin deepclean-app perf:: -- --ignored --nocapture scan_only
/// ```
#[test]
#[ignore = "要真盘一棵树；跑法见函数注释，或由 scripts/m5m-same-instant-reconcile.sh 统一驱动"]
fn scan_only_the_three_numbers() {
    let root = fixture_root();
    let volume = volume_of(&root).expect("取卷几何");
    let opts = ScanOptions::new(&root).with_count_exts(&deepclean_devenv::MODEL_FILE_EXTENSIONS);
    let t = Instant::now();
    let tree = scan_tree(&opts, &volume, |_| {}).expect("这棵树不该扫失败");
    let scan_ms = t.elapsed().as_secs_f64() * 1000.0;
    // 三轴各给两份：`bytes_counted` 是**占用**口径（分配大小、硬链接去重），
    // `bytes_logical` 才是与 TS 侧 `store.stats().totalBytes` / `Measure-Object Length -Sum`
    // 同一件事的那一份。M5-F 就差点拿前者去比后者，凭空造出一笔 295,788 的"差异"。
    println!(
        "M5M {}",
        serde_json::json!({
            "root": root.display().to_string(),
            "files": tree.counters.files,
            "dirs": tree.counters.dirs,
            "bytes_logical": tree.counters.bytes_logical,
            "bytes_counted": tree.counters.bytes_counted,
            "deduped_hardlinks": tree.counters.deduped_hardlinks,
            "denied": tree.counters.errors.denied,
            "skipped": tree.counters.skipped_always + tree.counters.skipped_reparse,
            "depth_capped": tree.counters.depth_capped,
            "scan_ms": (scan_ms * 10.0).round() / 10.0,
        })
    );
}

fn us_per_call(start: Instant, calls: usize) -> f64 {
    start.elapsed().as_secs_f64() * 1_000_000.0 / calls as f64
}

#[test]
#[ignore = "要 100k 真文件夹具与几十秒墙钟；跑法见本文件头与 docs/acceptance/2026-10-12-tauri-m5-f.md"]
fn hundred_thousand_files_the_five_numbers() {
    let root = fixture_root();
    let volume = volume_of(&root).expect("取卷几何");

    // ① 扫描 —— 用**产品那一份**选项（`service::start_scan` 也是这两行）
    let opts = ScanOptions::new(&root).with_count_exts(&deepclean_devenv::MODEL_FILE_EXTENSIONS);
    let t = Instant::now();
    let tree = scan_tree(&opts, &volume, |_| {}).expect("十万级扫描不该失败");
    let scan_ms = t.elapsed().as_secs_f64() * 1000.0;
    let (files, dirs, bytes, denied, skipped) = (
        tree.counters.files,
        tree.counters.dirs,
        tree.counters.bytes_counted,
        tree.counters.errors.denied,
        tree.counters.skipped_always + tree.counters.skipped_reparse,
    );
    // 对账要用**同口径那一份**：oracle 的 bytes 是表观（`Measure-Object Length -Sum`），
    // 而 `bytes_counted` 是占用（分配大小、硬链接去重）—— 拿后者比前者会凭空造出差异。
    let (bytes_logical, deduped) = (tree.counters.bytes_logical, tree.counters.deduped_hardlinks);
    let depth_capped = tree.counters.depth_capped;

    // ② 折成 arena
    let t = Instant::now();
    let idx = TreeIndex::build(&tree);
    let index_ms = t.elapsed().as_secs_f64() * 1000.0;
    let dirs_in_arena = idx.dirs_len();

    // ③ 引擎整树评估 —— 它和 ④ 都发生在**会话锁里面**（`build_preview` 里那段注释点名）
    // 事实表在这里现采，与 `service::build_preview` 同一条口径（一次扫描只采一次）；
    // 要量的正是「采 + 评」合计 —— 那才是锁外先算完能省掉的那部分。
    let t = Instant::now();
    let report = service::rule_report_with_facts(&idx, 1, false, service::app_facts_for_tree(&idx));
    let rule_ms = t.elapsed().as_secs_f64() * 1000.0;
    let findings = report.findings.len();

    // ④ 一次点击的白名单反查：命中 / 落空（落空 = 整棵 arena 扫完，是最坏那一次）
    let hit_path = idx
        .top_files()
        .first()
        .map(|h| h.path.clone())
        .expect("十万级夹具的 Top 榜不可能空");
    let miss_path = format!(r"{}\__no-such-dir__\__no-such-file__.bin", root.display());
    const CALLS: usize = 200;
    let t = Instant::now();
    for _ in 0..CALLS {
        assert!(crate::paths::knows_path_in_tree(&idx, false, &hit_path), "命中那一格先要成立");
    }
    let hit_us = us_per_call(t, CALLS);
    let t = Instant::now();
    for _ in 0..CALLS {
        assert!(!crate::paths::knows_path_in_tree(&idx, false, &miss_path), "落空那一格先要成立");
    }
    let miss_us = us_per_call(t, CALLS);

    // ~~⑤ §20 翻译~~：重复文件检测下线后那一格跟着撤（它量的是 `findings_for` 的 O(总组数)，
    // 而现在那条链不存在了）。三个数的判据本身留在 `docs/benchmarks/results.md` 里。

    println!(
        "M5F {}",
        serde_json::json!({
            "root": root.display().to_string(),
            "files": files, "dirs": dirs, "bytes_counted": bytes,
            "bytes_logical": bytes_logical, "deduped_hardlinks": deduped,
            "depth_capped": depth_capped,
            // 与 `SessionState::truncated()` 同一判据的点名版（0 号槽就是根，`dir()` 已把
            // ROOT_DIR_ID 映到那儿）：>0 就说明有目录被 `max_files_per_dir` 截过
            "files_truncated_dirs": (0..dirs_in_arena as i64)
                .filter(|&i| idx.dir(i).is_some_and(|d| d.files_truncated))
                .count(),
            "denied": denied, "skipped": skipped,
            "scan_ms": (scan_ms * 10.0).round() / 10.0,
            "index_ms": (index_ms * 10.0).round() / 10.0,
            "dirs_in_arena": dirs_in_arena,
            "rule_report_ms": (rule_ms * 10.0).round() / 10.0,
            "rule_findings": findings,
            "knows_hit_us_per_call": (hit_us * 100.0).round() / 100.0,
            "knows_miss_us_per_call": (miss_us * 100.0).round() / 100.0,
        })
    );
}

/// 开发环境页首开那条链的各段耗时（人类伙伴 2026-10-20：首次进入要空白 5-10 秒）。
///
/// 那条链是 `dc_dev_env_view` → `assemble_dev_env_view` → `build_preview` →
/// `app_facts_for_tree` + `rule_report_with_facts` → `build_dev_env_view`。
/// 本测试把**树已在内存之后**的三段分开量，指出该优化哪一段：
///
///  ① `facts_ms`   —— 机器事实采集（`TreeSource::new` 全树路径索引 + Toolhelp32 进程表
///                      + 注册表）。这一段与「扫的是什么盘」成正比，是唯一会到秒级的候选。
///  ② `eval_ms`    —— 引擎整树评估（吃上面那份事实）。
///  ③ `assemble_ms`—— `build_dev_env_view` 纯内存组装。
///
/// 用法（与上面那条同一条跑法，换根用 `DC_PERF_ROOT`）：
/// ```text
/// DC_PERF_ROOT=C:\ cargo test -p deepclean-app --bin deepclean-app perf::devenv -- --ignored --nocapture
/// ```
#[test]
#[ignore = "要真盘与几十秒墙钟；跑法见本函数文档"]
fn devenv_first_open_cost() {
    let root = root_to_scan();
    let volume = volume_of(&root).expect("取卷几何");
    let opts = ScanOptions::new(&root).with_count_exts(&deepclean_devenv::MODEL_FILE_EXTENSIONS);
    let tree = scan_tree(&opts, &volume, |_| {}).expect("扫描不该失败");
    let idx = TreeIndex::build(&tree);

    // ① 采集：连量三次。第一次含冷启动（进程表 / 注册表句柄），后两次是热路径 ——
    //    产品上每次进页面都是"热"的那一次，所以后两次才是用户等的那段。
    let mut facts_ms = Vec::new();
    let mut facts_keep = None;
    for _ in 0..3 {
        let t = Instant::now();
        let f = service::app_facts_for_tree(&idx);
        facts_ms.push(t.elapsed().as_secs_f64() * 1000.0);
        facts_keep = Some(f);
    }

    // ② 评估：只评估（事实复用上面那份，不再重采）
    let t = Instant::now();
    let report = service::rule_report_with_facts(&idx, 1, false, facts_keep.expect("刚采过"));
    let eval_ms = t.elapsed().as_secs_f64() * 1000.0;

    // ③ 组装：纯内存
    let rules = deepclean_rules::builtin_rules();
    let t = Instant::now();
    let view = deepclean_devenv::view::build_dev_env_view(&deepclean_devenv::view::DevEnvViewInput {
        rules: &rules,
        install_status: std::collections::BTreeMap::new(),
        docker: None,
        bytes_by_rule: std::collections::BTreeMap::new(),
        model_files: None,
        territories: &report.territories,
        scanned_root: Some(root.display().to_string()),
    });
    let assemble_ms = t.elapsed().as_secs_f64() * 1000.0;

    println!(
        "DEVENV_OPEN {}",
        serde_json::json!({
            "root": root.display().to_string(),
            "files": tree.counters.files,
            "dirs": tree.counters.dirs,
            "facts_cold_ms": (facts_ms[0] * 10.0).round() / 10.0,
            "facts_hot_ms": (facts_ms[2] * 10.0).round() / 10.0,
            "eval_ms": (eval_ms * 10.0).round() / 10.0,
            "assemble_ms": (assemble_ms * 10.0).round() / 10.0,
            // 用户在树已在内存时等的那一段 = 热采集 + 评估（组装可忽略）
            "user_wait_ms": ((facts_ms[2] + eval_ms) * 10.0).round() / 10.0,
            "groups": view.groups.len(),
        })
    );
}
