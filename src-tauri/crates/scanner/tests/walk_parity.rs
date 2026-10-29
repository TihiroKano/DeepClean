//! walk 单线程（`scan.rs`，对照组）与并行档（`scan_parallel.rs`）的**逐字段等价闸**。
//!
//! 并行化最危险的失败模式不是崩溃，是**两次扫描给出两份不一样的账**：硬链接去重看首见序、
//! TopHeap 等尺寸看推送序、跳过样本看遭遇序 —— 三样都依赖访问顺序，而并行的访问顺序天然
//! 不定。这里在同一个运行时夹具上把两档各跑若干轮，断言产出**递归逐字段相等**；并行档的
//! 调度每轮都可能不同，5 轮全过才有资格说"等价"。
//!
//! ## 夹具刻意埋的每一样东西对应一条判据
//!
//! - 40×(30+3×8) 个普通文件 —— 主量；
//! - 130 个**等尺寸**文件 + 10 个更大的 —— TopHeap 容量 100 时必然要丢等尺寸的那批，
//!   丢哪几个由推送序决定（`heap.rs` 第 2 条形状：按 size 对账查不出来，只能靠顺序钉死）；
//! - 硬链接 1 本体 + 3 条链接 —— 去重的"首见计全额"；
//! - junction —— reparse 跳过 + 样本原位；
//! - `System Volume Information` / `DumpStack.log.tmp` —— 名单跳过（两档同一条 `SKIP_ALWAYS`）;
//! - 60 层深链 + 底部文件 —— 深路径（>260 字符）与 `\\?\` 语义；
//! - 150 个文件的 `bulk` 目录 + `max_files_per_dir=120` —— 存储截断（只截存储，计数照常）。
//!
//! ## 为什么夹具建完要先吃一趟热身扫描
//!
//! NTFS 的目录 LastWriteTime 在文件写入后**惰性回填**，触发条件是"该目录被打开"
//! （在 `scan_parallel.rs` 的单测里实测钉过）。热身扫描把全部待定时间戳冲掉，
//! 之后的单线程基准与并行各轮才是在**同一棵树**上对照 —— 否则测的是 NTFS 的落账时机。

use deepclean_scanner::model::{ScanNode, ScanTree};
use deepclean_scanner::scan::{scan_tree_with, ScanControl, ScanOptions};
use deepclean_scanner::scan_parallel::scan_tree_parallel_with;
use deepclean_scanner::volume::volume_of;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture {
    root: PathBuf,
    junction: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // junction 先摘（它指向夹具内部，不许让整树删除被它绊住）
        let _ = std::fs::remove_dir(&self.junction);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn mk(path: &Path) {
    std::fs::create_dir_all(path).expect("建目录失败");
}

fn put(path: &Path, bytes: &[u8]) {
    if let Some(p) = path.parent() {
        mk(p);
    }
    std::fs::write(path, bytes).expect("写文件失败");
}

fn build_fixture() -> Fixture {
    let tag = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("dc-parity-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    mk(&root);

    // 40 个顶层目录 × (30 文件 + 3 子目录 × 8 文件) = 2160
    for d in 0..40u32 {
        let dir = root.join(format!("d{d:02}"));
        for j in 0..30u32 {
            put(&dir.join(format!("f{j:02}.bin")), &vec![0u8; (j as usize * 7 + 1) % 4000 + 1]);
        }
        for s in 0..3u32 {
            let sub = dir.join(format!("s{s}"));
            for j in 0..8u32 {
                put(&sub.join(format!("g{j}.bin")), &vec![0u8; j as usize * 11 + 1]);
            }
        }
    }

    // 130 个等尺寸 + 10 个更大：堆容量 100 必丢等尺寸批 —— 丢谁看推送序
    for i in 0..130u32 {
        put(&root.join(format!("d{:02}", i % 40)).join(format!("eq_{i:03}.bin")), &vec![0u8; 5000]);
    }
    for i in 0..10u32 {
        put(&root.join(format!("big_{i}.bin")), &vec![0u8; 9000]);
    }

    // 硬链接：一条本体 + 三条链接，四条路径只计一次
    let src = root.join("d00").join("hl_src.bin");
    put(&src, &vec![0u8; 7000]);
    for (d, k) in [(5u32, 1u32), (15, 2), (25, 3)] {
        let dst = root.join(format!("d{d:02}")).join(format!("hl_link{k}.bin"));
        std::fs::hard_link(&src, &dst).expect("建硬链接失败");
    }

    // junction：reparse —— 两档都必须"不进入、不计数、留样本"
    let junction = root.join("d07").join("junc_to_d08");
    let out = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(root.join("d08"))
        .status()
        .expect("起 cmd 失败");
    assert!(out.success(), "mklink /J 失败（junction 建不出来，夹具不完整）");

    // 名单跳过：一个目录一条文件
    put(&root.join("System Volume Information").join("tracked.xml"), b"{}");
    put(&root.join("DumpStack.log.tmp"), b"tmp");

    // 60 层深链 + 底部文件：路径远超 260 字符，创建走 verbatim 前缀
    let mut deep = root.join("deep");
    for i in 0..60u32 {
        deep = deep.join(format!("c{i:02}"));
    }
    mk(Path::new(&format!(r"\\?\{}", deep.display())));
    put(Path::new(&format!(r"\\?\{}\bottom.txt", deep.display())), b"bottom");

    // 长文件名（194 字符）
    put(&root.join("d20").join(format!("{}.bin", "x".repeat(190))), b"long-name");

    // 存储截断：150 个文件配 max_files_per_dir=120
    for j in 0..150u32 {
        put(&root.join("bulk").join(format!("b{j:03}.txt")), b"x");
    }

    Fixture { root, junction }
}

fn std_opts(root: &Path) -> ScanOptions {
    let mut o = ScanOptions::new(root);
    o.max_files_per_dir = 120;
    o.with_count_exts(&["bin"])
}

fn assert_parity(a: &ScanTree, b: &ScanTree, ctx: &str) {
    if a.root == b.root
        && a.counters == b.counters
        && a.top == b.top
        && a.skipped_sample == b.skipped_sample
        && a.skipped_sample_overflowed == b.skipped_sample_overflowed
        && a.mode == b.mode
        && a.mft.is_none()
        && b.mft.is_none()
    {
        return;
    }
    // 失败时只报**首处分歧**的定位（整棵树的 Debug 是几 MB 噪声，会把真线索吞掉）
    let where_about = first_node_diff(&a.root, &b.root)
        .unwrap_or_else(|| "(树相同，分歧在计数器/Top/样本)".to_string());
    panic!(
        "{ctx}: 树逐字段不等\n  首处分歧 @ {}\n  counters 相等: {}\n  top 相等: {}\n  样本相等: {}",
        where_about,
        a.counters == b.counters,
        a.top == b.top,
        a.skipped_sample == b.skipped_sample
    );
}

/// 两棵树的第一处字段分歧（深度优先）。只用于失败诊断，不参与判定。
fn first_node_diff(a: &ScanNode, b: &ScanNode) -> Option<String> {
    if a.name != b.name {
        return Some(format!("name: {:?} vs {:?}", a.name, b.name));
    }
    if a.path != b.path {
        return Some(format!("path: {:?} vs {:?}", a.path, b.path));
    }
    for (label, x, y) in [
        ("size_logical", a.size_logical, b.size_logical),
        ("size_alloc", a.size_alloc, b.size_alloc),
        ("size_counted", a.size_counted, b.size_counted),
        ("file_count", a.file_count, b.file_count),
        ("dir_count", a.dir_count, b.dir_count),
    ] {
        if x != y {
            return Some(format!("{label} @ {}: {x} vs {y}", a.path));
        }
    }
    if a.errors != b.errors {
        return Some(format!("errors @ {}: {:?} vs {:?}", a.path, a.errors, b.errors));
    }
    if a.files_truncated != b.files_truncated {
        return Some(format!("files_truncated @ {}", a.path));
    }
    if a.attrs != b.attrs {
        return Some(format!("attrs @ {}: {:x} vs {:x}", a.path, a.attrs, b.attrs));
    }
    if a.creation_ms != b.creation_ms {
        return Some(format!("creation_ms @ {}: {} vs {}", a.path, a.creation_ms, b.creation_ms));
    }
    if a.mtime_ms != b.mtime_ms {
        return Some(format!("mtime_ms @ {}: {} vs {}", a.path, a.mtime_ms, b.mtime_ms));
    }
    if a.files.len() != b.files.len() {
        return Some(format!("files.len @ {}: {} vs {}", a.path, a.files.len(), b.files.len()));
    }
    for (fa, fb) in a.files.iter().zip(&b.files) {
        if fa != fb {
            return Some(format!("file @ {}\\{}: {fa:?} vs {fb:?}", a.path, fa.name));
        }
    }
    if a.children.len() != b.children.len() {
        return Some(format!(
            "children.len @ {}: {} vs {}",
            a.path,
            a.children.len(),
            b.children.len()
        ));
    }
    for (ca, cb) in a.children.iter().zip(&b.children) {
        if let Some(d) = first_node_diff(ca, cb) {
            return Some(d);
        }
    }
    None
}

/// 夹具自检：防"夹具残缺 → 两档都扫到空树 → 等价性空转"。断言的是**特性真的被踩到**。
fn sanity_guard(t: &ScanTree) {
    assert!(t.counters.files > 2400, "夹具文件数不齐：{}", t.counters.files);
    assert_eq!(t.counters.deduped_hardlinks, 3, "三条硬链接必须真的被去重");
    assert_eq!(t.counters.skipped_reparse, 1, "junction 必须真的被跳过");
    assert_eq!(t.counters.skipped_always, 2, "名单跳过必须真的是两条");
    assert_eq!(t.top.len(), 100, "等尺寸文件必须把堆顶满（丢谁看推送序）");
    assert_eq!(t.counters.depth_capped, 0, "标准参数不该触发深度截断");
    let bulk = t.root.children.iter().find(|c| c.name == "bulk").expect("夹具有 bulk 目录");
    assert!(bulk.files_truncated && bulk.files.len() == 120, "bulk 必须真的触发存储截断（存 120/150）");
    assert!(t.counters.ext_count > 0, "扩展名计数必须真的开过");
}

#[test]
fn parallel_walk_matches_single_thread_field_by_field() {
    let fx = build_fixture();
    let volume = volume_of(&fx.root).expect("夹具卷几何");
    let opts = std_opts(&fx.root);

    // 热身：冲掉 NTFS 的惰性目录时间戳（模块头）
    let _ = scan_tree_with(&opts, &volume, ScanControl::new(), |_| {}).expect("热身扫描");

    let single = scan_tree_with(&opts, &volume, ScanControl::new(), |_| {}).expect("单线程基准");
    sanity_guard(&single);
    for round in 0..5 {
        let par = scan_tree_parallel_with(&opts, &volume, ScanControl::new(), |_| {})
            .unwrap_or_else(|e| panic!("并行第 {round} 轮扫描失败：{e}"));
        assert_parity(&single, &par, &format!("标准参数第 {round} 轮"));
    }

    // 窄参数组：深度截断 + 小容量堆 —— 另外两条边界形状（depth_capped 的树形、堆只留 3 个）
    let mut narrow = ScanOptions::new(&fx.root);
    narrow.max_depth = 2;
    narrow.top_n = 3;
    let single_n = scan_tree_with(&narrow, &volume, ScanControl::new(), |_| {}).expect("窄参单线程");
    assert!(single_n.counters.depth_capped > 0, "窄参必须真的触发深度截断");
    for round in 0..5 {
        let par =
            scan_tree_parallel_with(&narrow, &volume, ScanControl::new(), |_| {}).expect("窄参并行");
        assert_parity(&single_n, &par, &format!("窄参第 {round} 轮"));
    }

    // 存储上限 0：所有目录不存文件但计数照常 —— 截断语义的极限形状
    let mut zero = ScanOptions::new(&fx.root);
    zero.max_files_per_dir = 0;
    zero.top_n = 0;
    let single_z = scan_tree_with(&zero, &volume, ScanControl::new(), |_| {}).expect("零上限单线程");
    assert!(single_z.root.files.is_empty() && single_z.root.files_truncated, "上限 0 应当只截存储");
    let par_z =
        scan_tree_parallel_with(&zero, &volume, ScanControl::new(), |_| {}).expect("零上限并行");
    assert_parity(&single_z, &par_z, "零上限");
}

/// 真机耗时对照（MS5 验收）。只读；默认跳过，手动跑：
/// `DC_BENCH_ROOT=<大目录> cargo test -p deepclean-scanner --test walk_parity bench -- --ignored --nocapture`
#[test]
#[ignore = "真机对照：设 DC_BENCH_ROOT 后跑 --ignored --nocapture"]
fn bench_real_machine() {
    let root = PathBuf::from(std::env::var("DC_BENCH_ROOT").expect("设 DC_BENCH_ROOT"));
    let volume = volume_of(&root).expect("卷几何");
    let opts = ScanOptions::new(&root);

    // 热身 + 自洽预检：目录刚被写过（比如刚编译完的 target）时 NTFS 还在惰性回填时间戳，
    // 先用一趟扫描把全树目录"开"一遍；再用两趟单线程确认树已经静止 ——
    // 两趟单线程都对不上就是 FS 在动（或还在回填），先说明白再谈并行等价。
    let warm = scan_tree_with(&opts, &volume, ScanControl::new(), |_| {}).expect("热身扫描");
    let single0 = scan_tree_with(&opts, &volume, ScanControl::new(), |_| {}).expect("自洽预检");
    if let Some(d) = first_node_diff(&warm.root, &single0.root) {
        eprintln!("[自洽] 热身与预检仍有分歧（回填未完/树在动）：{d}");
    }
    let single = scan_tree_with(&opts, &volume, ScanControl::new(), |_| {}).expect("单线程");
    assert_eq!(
        single.root, single0.root,
        "两趟单线程都对不上：树在两趟之间变了（{} files vs {} files）",
        single0.counters.files, single.counters.files
    );
    eprintln!(
        "[单线程] {}ms files={} dirs={} counted={}",
        single.elapsed_ms, single.counters.files, single.counters.dirs, single.counters.bytes_counted
    );
    for r in 0..3 {
        let wall = std::time::Instant::now();
        let par =
            scan_tree_parallel_with(&opts, &volume, ScanControl::new(), |_| {}).expect("并行");
        eprintln!(
            "[并行 #{r}] {}ms（内部 {}ms） files={} dirs={} counted={}",
            wall.elapsed().as_millis(),
            par.elapsed_ms,
            par.counters.files,
            par.counters.dirs,
            par.counters.bytes_counted
        );
        assert_parity(&single, &par, &format!("真机第 {r} 轮"));
    }
    eprintln!("[等价] 真机树 3 轮并行全部与单线程逐字段相等");
}
