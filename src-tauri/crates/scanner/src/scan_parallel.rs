//! walk 档的并行化（方案 C 的另一半）：**两阶段** —— A 并行建树，B 单线程 canonical fold。
//! `scan.rs` 原样保留作对照组；本模块的产出必须与它**递归逐字段相等**
//! （`tests/walk_parity.rs` 在运行时夹具上多轮钉死）。
//!
//! ## 为什么不是"把 scan.rs 多线程化"，而是拆成两阶段
//!
//! 单线程产出里有三样东西依赖**访问顺序**，而并行的访问顺序天然不定：
//!  1. 硬链接去重（[`FileAccounting`]）：同一条 `(serial, file_id)` **首个见到**的路径计全额；
//!  2. TopHeap 的等尺寸去留：堆满后 `size > 堆顶` 才替换，等尺寸文件**先推的留下**
//!     （`heap.rs` 第 2 条形状——那种错在按 size 对账时查不出来，只能靠顺序钉死）；
//!  3. `skipped_sample` 的清单序：样本按"遇到"的顺序截前 `cap` 条。
//!
//! 这三样留在并行阶段做，同一棵树两次扫描就会给出两份不一样的账 —— 那不是"并行开销"，
//! 是错误。所以：
//!
//! - **A 阶段**（并行 worker 池）：只做与顺序无关的事 —— 读目录、按名排序、建本目录的
//!   **条目表**（文件/子目录/跳过按排序后的原位交错），以及与顺序无关的累计
//!   （files/dirs/bytes_logical/bytes_alloc/ext/跳过报数/depth_capped）。子目录入队不等待。
//! - **B 阶段**（单线程）：沿 A 建好的树做**与 `scan.rs::walk_entries` 完全相同的 DFS 序**
//!   —— 条目表已保序，所以去重、入堆、样本截取、全部节点聚合（`size_*`/`file_count`/
//!   `dir_count`/`errors`）都在这个序上重算一遍，产出与单线程逐字段相等。
//!
//! ## 一条已知的暂时性偏差（写进契约，不是 bug）
//!
//! A 阶段进度里的 `bytes_counted` 是**未去重的分配合计**（等于 `bytes_alloc`），HUD 在
//! 扫描途中会略偏高（有硬链接的树上）；B 阶段完成后归真。进度的语义是"在动"，不是"终账"。
//!
//! ## 其余口径（与 scan.rs 同一条纪律的并行版）
//!
//! - 根目录读失败 → `ScanFailure::Root`（子目录读失败是父节点的报数，不算整轮失败）；
//! - 深度上限在**入队前**判（与单线程"递归前判"同位）：不入队、不入树、`depth_capped` 报数；
//! - 重解析点/名单命中：不进入不计数，样本按原位进 B 阶段；
//! - 取消 → 整轮 `Err(Cancelled)`（半棵树不产出）；暂停 = 不发起新的目录枚举
//!   （粒度是"每个目录"，比单线程"每个条目"粗 —— 一屏目录的枚举在百毫秒级，可接受）；
//! - 哨兵照用：`bytes_counted > 卷已用 + 0.5%` → `ImpossibleAccounting`；
//! - 三条 debug_assert（counters ↔ 根节点聚合）在两阶段之间当了交叉账本：
//!   A 阶段数的 files/dirs 对上 B 阶段折出来的 file_count/dir_count，两阶段各数一遍
//!   各有半份账，对不上就是其中一边漏了条目。
//!
//! ## 进度回调的线程约束
//!
//! 回调会从**多个 worker 线程**并发调用，签名因此是 `Fn + Send + Sync`（`scan.rs` 的
//! `FnMut` 携带可变状态，两档不通用）。service 侧的回调体本来就是 `&self` 幂等 + 锁内节流。

use crate::accounting::{skip_reason, Agg, FileAccounting, SkipReason};
use crate::enumerate::{read_dir_entries, EnumerateError};
use crate::heap::TopHeap;
use crate::model::{
    ext_of, Counters, ScanFile, ScanMode, ScanNode, ScanTree, SkippedItem, TopHit,
};
use crate::scan::{ScanControl, ScanFailure, ScanOptions};
use crate::volume::VolumeInfo;
use crate::winerr::{kind_of_win32, ScanErrorKind};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};

/// A 阶段条目表里的一项。**顺序即契约**：三者按目录项排序后的原位交错，
/// B 阶段按这个序做去重/入堆/样本，才能与单线程逐字段相等。
enum Ent {
    /// 普通文件。`counted` 在这里还不知道（去重是顺序敏感的），B 阶段回填。
    File(crate::enumerate::RawEntry),
    /// 已入队的子目录；读失败的槽位记在 `failed` 表里，B 阶段对父节点报数。
    Dir(usize),
    /// reparse / 名单命中 —— B 阶段按原位进样本（顺序敏感，不许在 A 阶段截）。
    Skipped(SkippedItem),
}

/// A 阶段的产出：一个"只差聚合与去重"的目录。
struct RawNode {
    name: String,
    path: String,
    attrs: u32,
    creation_ms: i64,
    mtime_ms: i64,
    /// 本目录全部条目，**已按名字排序并保留文件/子目录/跳过的原位交错**。
    entries: Vec<Ent>,
    /// 深度上限挡在门外的直接子目录数。`counters.depth_capped` 的 A 阶段来源；
    /// node.errors 的 Unknown 报数在 B 阶段补（聚合是 B 的活）。
    depth_capped: u64,
    files_truncated: bool,
}

/// 一个待处理目录。
struct Job {
    slot: usize,
    path: PathBuf,
    name: String,
    depth: usize,
    /// 目录自身的属性/时间 —— 来自**父目录的那条目录项**（与单线程同源，零额外 syscall）。
    attrs: u32,
    creation_ms: i64,
    mtime_ms: i64,
}

struct PoolState {
    queue: VecDeque<Job>,
    /// 已入队（含正在跑）还没完成的作业数。收工条件 = `queue` 空 **且** `pending == 0`
    /// —— 只有前者会在"最后一个作业在跑、队列已空"的窗口里假报收工。
    pending: usize,
    done: bool,
}

/// 全程共享。`count_exts`/`max_*` 是只读配置；`nodes`/`failed`/`root_err` 是 A 阶段的产出面。
struct Shared<F> {
    pool: Mutex<PoolState>,
    cv: Condvar,
    counters: Mutex<Counters>,
    nodes: Mutex<Vec<Option<RawNode>>>,
    /// 读失败的子目录槽位 → win32 分类。父节点的 node.errors 在 B 阶段照它报数
    /// （A 阶段父节点已经存好了，孩子失败时父节点不在手上，只能走这张表）。
    failed: Mutex<HashMap<usize, ScanErrorKind>>,
    root_err: Mutex<Option<EnumerateError>>,
    control: ScanControl,
    count_exts: Option<std::collections::HashSet<String>>,
    max_files_per_dir: usize,
    max_depth: usize,
    progress: Arc<F>,
}

/// 把设置里那格并行度夹进安全区间（2026-10-29，**2026-10-30 按实测改上界**）。
///
/// `None` → 本机逻辑核数（等于改之前那一行原样）。
///
/// ## 上界从「核数 ×2」改成「核数」—— 这一条有实测依据
///
/// 上一版的上界是 `核数 × 2`，写的时候是猜的。后来用
/// `src-tauri/examples/delprobe.rs`（真系统线程、32000 个文件、8 核机）量了：
///
/// | 并发 | 墙钟 | 相对 1x | 峰值 RSS |
/// | 1 | 7993ms | 1.00x | 4.6MB |
/// | 2 | 5246ms | 1.52x | 4.6MB |
/// | 4 | 3862ms | 2.07x | 4.7MB |
/// | 8 | 3256ms | **2.45x** | 4.8MB |
/// | 16 | 3323ms | 2.40x | 5.1MB |
///
/// 三个结论：
///  - **饱和在核数**（8）：16 比 8 慢 2%，那是唯一负收益的一档，而旧上界恰好放它过去；
///  - **内存不是约束**：16 倍并发只多 0.5 MB，所以"拉高会崩"不是 OOM；
///  - 加速比封顶 2.45×（不是 8×）⇒ 这项工作大部分串行，瓶颈在文件系统
///    （`SHFileOperationW` 每次调用的固定开销 + NTFS 日志），不在 CPU。
///
/// 所以上界 = 核数。超过它只会让人白等。
///
/// 下界仍是 1：0 条 worker 会让 `join` 立刻返回一棵空树（见
/// `scan_parallel` 的调用点），界面上表现为"这块盘什么都没占"，比崩溃更难查。
pub fn clamp_workers(declared: Option<usize>, cores: usize) -> usize {
    let cores = cores.max(1);
    match declared {
        None => cores,
        Some(n) => n.clamp(1, cores),
    }
}

pub fn scan_tree_parallel(
    opts: &ScanOptions,
    volume: &VolumeInfo,
    progress: impl Fn(&Counters) + Send + Sync + 'static,
) -> Result<ScanTree, ScanFailure> {
    scan_tree_parallel_with(opts, volume, ScanControl::new(), progress)
}

pub fn scan_tree_parallel_with(
    opts: &ScanOptions,
    volume: &VolumeInfo,
    control: ScanControl,
    progress: impl Fn(&Counters) + Send + Sync + 'static,
) -> Result<ScanTree, ScanFailure> {
    let started = std::time::Instant::now();
    let root_name = opts
        .root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| opts.root.to_string_lossy().into_owned());

    let sh = Arc::new(Shared {
        pool: Mutex::new(PoolState { queue: VecDeque::new(), pending: 0, done: false }),
        cv: Condvar::new(),
        counters: Mutex::new(Counters::default()),
        nodes: Mutex::new(Vec::new()),
        failed: Mutex::new(HashMap::new()),
        root_err: Mutex::new(None),
        control,
        count_exts: opts.count_exts.clone(),
        max_files_per_dir: opts.max_files_per_dir,
        max_depth: opts.max_depth,
        progress: Arc::new(progress),
    });

    // 根作业：slot 0。读失败走 root_err（整轮失败），其余都算"子目录的报数"。
    let root_slot = alloc_slot(&sh.nodes);
    {
        let mut st = sh.pool.lock().unwrap();
        st.queue.push_back(Job {
            slot: root_slot,
            path: opts.root.clone(),
            name: root_name,
            depth: 0,
            attrs: 0,
            creation_ms: 0,
            mtime_ms: 0,
        });
        st.pending += 1;
    }

    // 并行度：设置页那格滑块（2026-10-29）。`None` = 本机逻辑核数，与改之前逐字相同。
    // **夹紧住 1..=逻辑核数×2**（`clamp_workers` 的注释写了理由）：`settings.json`
    // 是外面能手改的文件，`usize::MAX` 条线程会当场把进程打死 —— 这一格存在的理由
    // 正是「拉满倍率导致崩溃」，所以上界必须在内核这一侧，不能只靠界面。
    let workers = clamp_workers(
        opts.workers,
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2),
    );
    let handles: Vec<_> = (0..workers)
        .map(|_| {
            let sh = sh.clone();
            std::thread::spawn(move || {
                // panic 传播：一个 worker 死了，别的可能还在 condvar 上等收工信号 ——
                // 先把 done 置位叫醒它们，再把 panic 原样续回去（join 侧收）。
                // 不做这一步，一个 bug 会把"局部 panic"放大成"整轮挂死"。
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker(&sh))) {
                    Ok(()) => {}
                    Err(e) => {
                        let mut st = sh.pool.lock().unwrap();
                        st.queue.clear();
                        st.done = true;
                        drop(st);
                        sh.cv.notify_all();
                        std::panic::resume_unwind(e);
                    }
                }
            })
        })
        .collect();
    for h in handles {
        h.join().expect("扫描工作线程 panic");
    }

    // 与单线程同序的裁决：根读失败优先（单线程在 walk 之前就死在这一格，不看取消位），
    // 然后才是取消。半棵树在这两个出口都不产出。
    if let Some(e) = sh.root_err.lock().unwrap().take() {
        return Err(ScanFailure::Root(e));
    }
    if sh.control.is_cancelled() {
        return Err(ScanFailure::Cancelled);
    }

    let mut arena = std::mem::take(&mut *sh.nodes.lock().unwrap());
    let failed = std::mem::take(&mut *sh.failed.lock().unwrap());
    let mut cx = FoldCx {
        serial: volume.serial,
        accounting: FileAccounting::new(),
        top: TopHeap::new(opts.top_n),
        sample: Vec::with_capacity(opts.skipped_sample_cap),
        sample_cap: opts.skipped_sample_cap,
        sample_overflowed: false,
        max_files_per_dir: opts.max_files_per_dir,
        counted_total: 0,
        arena: &mut arena,
        failed: &failed,
    };
    let root = fold(&mut cx, root_slot);

    let mut counters = std::mem::take(&mut *sh.counters.lock().unwrap());
    // A 阶段的 bytes_counted 是未去重临时值 —— 这里归真（deduped_hardlinks 同理，
    // 长在累加器上，报告口径要的是 counters，必须显式搬一次；scan.rs 同一条注释的镜像）。
    counters.bytes_counted = cx.counted_total;
    counters.deduped_hardlinks = cx.accounting.deduped_hardlinks;
    // errors 只在 B 阶段（fold）往 node.errors 上冒泡，A 阶段的 counters 没记 ——
    // 不搬这一步，`counters.errors.denied` 永远是 0，提权判据（`should_offer_elevation`）就瞎了。
    counters.errors = root.errors;
    // A、B 两阶段各数一遍：A 数的是"顺序无关的那些"，B 折出来的是"每棵子树的聚合"。
    // 三条对不上 = 某个条目在某一边被漏了/重复了 —— 这是两阶段契约的交叉账本。
    debug_assert_eq!(counters.bytes_counted, root.size_counted, "A/B 阶段 bytes_counted 对不上");
    debug_assert_eq!(counters.dirs, root.dir_count, "A/B 阶段 dirs 对不上");
    debug_assert_eq!(counters.files, root.file_count, "A/B 阶段 files 对不上");
    let used = volume.used_bytes();
    if counters.bytes_counted > used + used / 200 {
        return Err(ScanFailure::ImpossibleAccounting { counted: counters.bytes_counted, used });
    }
    Ok(ScanTree {
        top: cx.top.entries().to_vec(),
        root,
        counters,
        volume: volume.clone(),
        skipped_sample: cx.sample,
        skipped_sample_overflowed: cx.sample_overflowed,
        elapsed_ms: started.elapsed().as_millis() as u64,
        mode: ScanMode::Walk,
        mft: None,
    })
}

fn alloc_slot(nodes: &Mutex<Vec<Option<RawNode>>>) -> usize {
    let mut n = nodes.lock().unwrap();
    n.push(None);
    n.len() - 1
}

fn worker<F: Fn(&Counters)>(sh: &Shared<F>) {
    loop {
        let job = {
            let mut st = sh.pool.lock().unwrap();
            let mut picked = None;
            let mut exit = false;
            loop {
                if sh.control.is_cancelled() {
                    // 取消：清队列、置收工、叫醒所有等着的。在跑的作业会自己走完
                    // （它们的 complete 照常 pending--），pending 自然排干。
                    st.queue.clear();
                    st.done = true;
                    exit = true;
                    break;
                }
                if st.done {
                    exit = true;
                    break;
                }
                if let Some(j) = st.queue.pop_front() {
                    picked = Some(j);
                    break;
                }
                if st.pending == 0 {
                    st.done = true;
                    exit = true;
                    break;
                }
                st = sh.cv.wait(st).unwrap();
            }
            if exit {
                drop(st);
                sh.cv.notify_all();
            }
            picked
        };
        let Some(job) = job else { return };
        // 暂停闸：粒度是"每个目录"（见模块头）。取消时立刻放行。
        while sh.control.is_paused() && !sh.control.is_cancelled() {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        process_job(sh, job);
    }
}

/// A 阶段：读一个目录、建条目表、累计顺序无关量、把子目录入队。
fn process_job<F: Fn(&Counters)>(sh: &Shared<F>, job: Job) {
    let mut children: Vec<Job> = Vec::new();
    let mut raw = RawNode {
        name: job.name,
        path: job.path.to_string_lossy().into_owned(),
        attrs: job.attrs,
        creation_ms: job.creation_ms,
        mtime_ms: job.mtime_ms,
        entries: Vec::new(),
        depth_capped: 0,
        files_truncated: false,
    };
    let mut own = OwnTally::default();
    let mut files_seen = 0u64;

    if sh.control.is_cancelled() {
        complete(sh, children);
        return;
    }
    match read_dir_entries(&job.path) {
        Err(e) => {
            // 只有根（slot 0）的读失败是整轮失败；子目录的失败进 failed 表，
            // 由 B 阶段对父节点报数 —— 与单线程"父节点 errors.bump"同义。
            if job.slot == 0 {
                *sh.root_err.lock().unwrap() = Some(e);
            } else {
                sh.failed.lock().unwrap().insert(job.slot, kind_of_win32(e.win32));
            }
            fire_progress(sh);
            complete(sh, children);
            return;
        }
        Ok(mut entries) => {
            // 枚举顺序由文件系统决定，必须排序 —— 与单线程同一把尺（scan.rs 同一条注释）。
            entries.sort_by(|a, b| a.name.cmp(&b.name));
            for e in entries {
                // 每个条目一个取消检查点（比单线程同位，暂停只到目录粒度）。
                if sh.control.is_cancelled() {
                    break; // 产出将被整轮丢弃，不求半成品完整
                }
                let child_path = job.path.join(&e.name);

                if let Some(reason) = skip_reason(&e) {
                    match reason {
                        SkipReason::Reparse => own.skipped_reparse += 1,
                        SkipReason::Always => own.skipped_always += 1,
                    }
                    raw.entries.push(Ent::Skipped(SkippedItem {
                        path: child_path.to_string_lossy().into_owned(),
                        reason,
                    }));
                    continue;
                }

                if e.is_dir {
                    // 无论进不进得去，它都是一个**存在**的目录 —— 计数口径与单线程一致。
                    own.dirs += 1;
                    if job.depth + 1 > sh.max_depth {
                        own.depth_capped += 1;
                        raw.depth_capped += 1;
                        // 不入队、不入树：与单线程"递归前判"同位
                        continue;
                    }
                    let slot = alloc_slot(&sh.nodes);
                    children.push(Job {
                        slot,
                        path: child_path,
                        name: e.name.clone(),
                        depth: job.depth + 1,
                        attrs: e.attrs,
                        creation_ms: e.creation_ms,
                        mtime_ms: e.last_write_ms,
                    });
                    raw.entries.push(Ent::Dir(slot));
                    continue;
                }

                // 普通文件：顺序无关的累计在这里（去重/入堆是 B 的活）
                own.files += 1;
                own.logical += e.size;
                own.alloc += e.alloc_size;
                if sh
                    .count_exts
                    .as_ref()
                    .is_some_and(|set| set.contains(ext_of(&e.name).as_str()))
                {
                    own.ext_count += 1;
                    own.ext_bytes += e.size;
                }
                files_seen += 1;
                // **全部文件都进条目表**：超存储上限的文件在单线程里照样计数、照样进堆 ——
                // 存储截断只是"节点上不存"，B 阶段照 `max_files_per_dir` 收口。
                raw.entries.push(Ent::File(e));
            }
        }
    }
    raw.files_truncated = files_seen > sh.max_files_per_dir as u64;
    sh.nodes.lock().unwrap()[job.slot] = Some(raw);

    {
        let mut c = sh.counters.lock().unwrap();
        c.files += own.files;
        c.dirs += own.dirs;
        c.bytes_logical += own.logical;
        c.bytes_alloc += own.alloc;
        // ⚠️ 未去重临时值（= alloc）：进度语义是"在动"，B 阶段归真 —— 模块头有契约。
        c.bytes_counted += own.alloc;
        c.depth_capped += own.depth_capped;
        c.skipped_reparse += own.skipped_reparse;
        c.skipped_always += own.skipped_always;
        c.ext_count += own.ext_count;
        c.ext_bytes += own.ext_bytes;
        let snap = *c;
        drop(c);
        (sh.progress)(&snap);
    }
    complete(sh, children);
}

/// 一次作业完成：孩子入队 + 本作业销账 + （可能）收工广播。一把锁做完，
/// notify 放在锁外 —— 让等待者醒来时锁必然是空的。
fn complete<F: Fn(&Counters)>(sh: &Shared<F>, children: Vec<Job>) {
    let mut st = sh.pool.lock().unwrap();
    if !children.is_empty() && !st.done {
        st.pending += children.len();
        st.queue.extend(children);
    }
    st.pending -= 1; // 本作业已数在 pending 里，销一次账
    if st.pending == 0 && st.queue.is_empty() {
        st.done = true;
    }
    drop(st);
    sh.cv.notify_all();
}

fn fire_progress<F: Fn(&Counters)>(sh: &Shared<F>) {
    let snap = { *sh.counters.lock().unwrap() };
    (sh.progress)(&snap);
}

/// A 阶段本目录的顺序无关累计。锁内一次性合并，三十万条目录项的锁开销摊到每目录一次。
#[derive(Default)]
struct OwnTally {
    files: u64,
    dirs: u64,
    logical: u64,
    alloc: u64,
    ext_count: u64,
    ext_bytes: u64,
    skipped_reparse: u64,
    skipped_always: u64,
    depth_capped: u64,
}

struct FoldCx<'a> {
    serial: u32,
    accounting: FileAccounting,
    top: TopHeap,
    sample: Vec<SkippedItem>,
    sample_cap: usize,
    sample_overflowed: bool,
    max_files_per_dir: usize,
    counted_total: u64,
    arena: &'a mut Vec<Option<RawNode>>,
    failed: &'a HashMap<usize, ScanErrorKind>,
}

/// B 阶段：按与 `walk_entries` 完全相同的 DFS 序消费 A 的条目表。
/// 三样顺序敏感的东西（去重、入堆、样本）+ 全部节点聚合都在这里闭合。
fn fold(cx: &mut FoldCx, slot: usize) -> ScanNode {
    // 非取消路径上每个入队槽位都有产出（取消在 fold 之前就被拦下）
    let raw = cx.arena[slot].take().expect("槽位必有产出");
    let mut node = ScanNode::dir(raw.name, raw.path);
    node.attrs = raw.attrs;
    node.creation_ms = raw.creation_ms;
    node.mtime_ms = raw.mtime_ms;
    let mut agg = Agg::default();
    // 深度截断的 Unknown 报数归本节点（单线程：node.errors.bump(Unknown)，同位）
    for _ in 0..raw.depth_capped {
        node.errors.bump(ScanErrorKind::Unknown);
    }
    for ent in raw.entries {
        match ent {
            Ent::Skipped(item) => {
                if cx.sample.len() < cx.sample_cap {
                    cx.sample.push(item);
                } else {
                    cx.sample_overflowed = true;
                }
            }
            Ent::Dir(child) => {
                agg.dirs += 1;
                if let Some(kind) = cx.failed.get(&child) {
                    // 打不开的子目录：不进去，但报数（它的体积落进「未计入」）
                    node.errors.bump(*kind);
                    continue;
                }
                let kid = fold(cx, child);
                agg.files += kid.file_count;
                agg.dirs += kid.dir_count;
                agg.bytes_logical += kid.size_logical;
                agg.bytes_alloc += kid.size_alloc;
                agg.bytes_counted += kid.size_counted;
                node.errors.merge(kid.errors);
                node.children.push(kid);
            }
            Ent::File(e) => {
                let counted = cx.accounting.count_file(cx.serial, e.file_id, e.alloc_size);
                cx.counted_total += counted;
                agg.files += 1;
                agg.bytes_logical += e.size;
                agg.bytes_alloc += e.alloc_size;
                agg.bytes_counted += counted;
                // 存储截断只是"节点上不存"，计数照常（上面已做）—— scan.rs 同一条纪律
                if node.files.len() < cx.max_files_per_dir {
                    node.files.push(ScanFile {
                        name: e.name.clone(),
                        size: e.size,
                        alloc: e.alloc_size,
                        counted,
                        file_id: e.file_id,
                        mtime_ms: e.last_write_ms,
                        creation_ms: e.creation_ms,
                        attrs: e.attrs,
                    });
                }
                // 入堆在存储截断**之外**：0 字节不进堆、先问 wants 再分配 —— 与单线程同位
                if e.size > 0 && cx.top.wants(e.size) {
                    let top_path = join_display(&node.path, &e.name);
                    cx.top.push(TopHit {
                        name: e.name,
                        path: top_path,
                        size: e.size,
                        mtime_ms: e.last_write_ms,
                    });
                }
            }
        }
    }
    node.file_count = agg.files;
    // 深度截断的目录没有节点、没有条目，但它们在单线程里**计入** dir_count —— 补在这里
    node.dir_count = agg.dirs + raw.depth_capped;
    node.size_logical = agg.bytes_logical;
    node.size_alloc = agg.bytes_alloc;
    node.size_counted = agg.bytes_counted;
    node.files_truncated = raw.files_truncated;
    node
}

/// B 阶段没有 PathBuf，只有 node.path 那份 display 串 —— 直接走 `Path::join` 本尊，
/// 不自己复刻分隔符语义（盘符根、`C:/` 形尾、drive-relative 各有各的坑）。
/// 与单线程的差异只在非 UTF-16 可编码的名字（to_string_lossy 的替换），Windows 上几乎不存在。
fn join_display(parent: &str, name: &str) -> String {
    Path::new(parent).join(name).to_string_lossy().into_owned()
}

/* ================================================================== *
 * 单测
 *
 * 等价性主体在 tests/walk_parity.rs（运行时夹具 + 多轮对照）；这里只钉
 * 不方便在集成测试里单独立判的三格：路径拼接形状、根失败、即时取消。
 * ================================================================== */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::volume::volume_of;

    /// 并行度那格设置的安全夹紧（2026-10-29，2026-10-30 按实测改上界）。
    ///
    /// 这一组钉的正是人类伙伴那条要求：「确保用户拉满倍率导致崩溃的情况发生」不会成立。
    /// `settings.json` 是一个**外面能手改的文件**，所以上界必须在内核这一侧，
    /// 不能只靠界面的滑块 `max`。
    ///
    /// 上界是**核数**（不是核数 ×2）—— 依据是 `examples/delprobe.rs` 的实测：
    /// 8 核机上并发 8 是加速比最高的一档（2.45×），16 反而慢 2%。
    #[test]
    fn workers_are_clamped_so_a_hand_edited_setting_cannot_kill_the_process() {
        // `None` = 改之前的行为：本机逻辑核数
        assert_eq!(clamp_workers(None, 8), 8);
        // 显式要 4 条 → 4（诚实采纳）
        assert_eq!(clamp_workers(Some(4), 8), 4);
        // 0 条 worker 会让 join 立刻返回一棵**空树**（比崩溃更难查）→ 抬到 1
        assert_eq!(clamp_workers(Some(0), 8), 1);
        // 手改文件写了 99999 → 夹到**核数**，不是"照办"，也不是旧的核数×2
        assert_eq!(clamp_workers(Some(99_999), 8), 8);
        // 反面对照：旧上界（核数×2）必须**不再**被接受 —— 实测 16 是负收益那一档
        assert_ne!(clamp_workers(Some(99_999), 8), 16, "上界回退成核数×2 了");
        // 一台 1 核的机器：上界 1
        assert_eq!(clamp_workers(Some(64), 1), 1);
        // `cores = 0` 这种不可能的输入也不许让下界失守
        assert_eq!(clamp_workers(Some(5), 0), 1);
        // 恰好等于核数时原样通过（上界是闭区间）
        assert_eq!(clamp_workers(Some(8), 8), 8);
    }

    #[test]
    fn join_display_matches_pathbuf_join_on_the_awkward_shapes() {
        let eq = |parent: &str, name: &str| {
            assert_eq!(
                join_display(parent, name),
                Path::new(parent).join(name).to_string_lossy().into_owned(),
                "join_display({parent:?}, {name:?})"
            );
        };
        eq(r"C:\", "file.txt"); // 盘符根：不许变成 C:\\file
        eq("C:/", "file.txt"); // 正斜杠根：join 不补第二个分隔符
        eq(r"C:\sub", "file.txt");
        eq(r"C:\sub\", "file.txt"); // 尾分隔符：不许双写
        eq(r"\\?\UNC\srv\share", "file.txt");
        eq("C:", "file.txt"); // drive-relative：Path::join 的 "C:f" 语义，照抄不修
    }

    #[test]
    fn a_missing_root_is_a_root_failure_not_a_skip() {
        let root = std::env::temp_dir().join(format!("dc-par-missing-{}", std::process::id()));
        let volume = volume_of(std::path::Path::new(r"C:\")).expect("C: 几何");
        let r = scan_tree_parallel(&ScanOptions::new(&root), &volume, |_| {});
        assert!(matches!(r, Err(ScanFailure::Root(_))), "得到：{r:?}");
    }

    #[test]
    fn an_instant_cancel_yields_cancelled_not_a_tree() {
        let root = std::env::temp_dir();
        let volume = volume_of(std::path::Path::new(r"C:\")).expect("C: 几何");
        let control = ScanControl::new();
        control.cancel();
        let r = scan_tree_parallel_with(&ScanOptions::new(root), &volume, control, |_| {});
        assert!(matches!(r, Err(ScanFailure::Cancelled)), "得到：{r:?}");
    }

    #[test]
    fn a_tiny_real_tree_folds_into_the_same_shape_as_single_thread() {
        let base = std::env::temp_dir().join(format!("dc-par-tiny-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("sub")).unwrap();
        std::fs::write(base.join("a.txt"), b"hello").unwrap();
        std::fs::write(base.join("sub").join("b.txt"), [0u8; 100]).unwrap();
        let volume = volume_of(&base).unwrap();
        let opts = ScanOptions::new(&base);
        // NTFS 的目录 LastWriteTime 在文件写入后是**惰性回填**的，触发条件是"该目录被
        // 打开"（实测：睡 200ms 后首趟扫描仍读到旧值，递归开过它之后第二趟才读到新值）。
        // 所以夹具先吃一趟**热身扫描**把全部待定时间戳冲掉，之后的对照才是在"同一棵树"上。
        let _ = crate::scan::scan_tree_with(&opts, &volume, ScanControl::new(), |_| {}).unwrap();

        let single = crate::scan::scan_tree_with(&opts, &volume, ScanControl::new(), |_| {}).unwrap();
        let par = scan_tree_parallel(&opts, &volume, |_| {}).unwrap();

        assert_eq!(single.root, par.root);
        assert_eq!(single.counters, par.counters);
        assert_eq!(single.top, par.top);
        assert_eq!(par.counters.files, 2);
        assert_eq!(par.counters.dirs, 1);
        let _ = std::fs::remove_dir_all(&base);
    }
}
