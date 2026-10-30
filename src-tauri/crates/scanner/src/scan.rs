//! 扫描内核：把一次 Win32 递归遍历折成一棵树 + 一份全树累计量。
//!
//! 三条硬规则（其余判定都在 `accounting.rs` 里，那边是纯函数）：
//!  1. **重解析点不进入**：不递归、不计大小，但**报数**并留一条有界样本。
//!  2. **硬链接按 (卷序列号, 文件 ID) 去重**：两条路径都留在树里，第二条起 `counted = 0`。
//!  3. **占用口径**：所有聚合累加 `alloc`；逻辑大小只在节点上留一份供展示。
//!
//! 外加一条**哨兵**：`bytes_counted` 超过卷已用空间的 0.5% 就整轮判失败 —— 那正是
//! 「80G 的盘扫出 90G+」这一族缺陷的机器可判信号，误差留 0.5% 是为了吸收扫描期间
//! 磁盘自身的正常变动，不是为了放宽口径。

use crate::accounting::{skip_reason, FileAccounting, SkipReason};
use crate::enumerate::{read_dir_entries, EnumerateError};
use crate::model::{
    Counters, ScanFile, ScanMode, ScanNode, ScanTree, SkippedItem,
};
use crate::volume::VolumeInfo;
use crate::winerr::kind_of_win32;
use std::path::{Path, PathBuf};

/// 默认每目录最多存多少条文件记录。**只截断"存储"，计数与聚合照常累加** ——
/// 现行 TS 侧 `maxFiles` 的教训（`core/scan/tree-store.ts:405-412`）就是这一条：
/// 截断清单不能让合计跟着变小。
pub const DEFAULT_MAX_FILES_PER_DIR: usize = 200_000;
/// 有界样本上限，与 TS 侧 `MAX_DENIED_SAMPLE=200` 同口径。
pub const DEFAULT_SKIPPED_SAMPLE_CAP: usize = 200;
/// 递归深度上限。真实文件树远达不到；超了**报数**而不是静默截断。
pub const DEFAULT_MAX_DEPTH: usize = 1024;

#[derive(Debug, Clone)]
pub struct ScanOptions {
    pub root: PathBuf,
    pub max_files_per_dir: usize,
    pub skipped_sample_cap: usize,
    pub max_depth: usize,
    /// 「最大的 N 个文件」那张表的容量（与 TS `ScannerOpts.topN ?? 100` 同值）。
    /// 0 = 什么都不记（`getTopFiles` 会回空表，不是回全表）。
    pub top_n: usize,
    /// 要在遍历途中顺带数哪几个模型权重的扩展名（§3.6）。
    /// `None` / 空 = 一个都不数。存进来时已经归一过（见 [`normalize_count_exts`]）。
    pub count_exts: Option<std::collections::HashSet<String>>,
    /// 并行 worker 数（2026-10-29 加，设置页那格滑块的真读者）。
    ///
    /// `None` = 用本机逻辑核数（`available_parallelism`），也就是改之前的行为 ——
    /// 所以**没有设置时逐字等于 1.0.0**。设置页写进来的是绝对值，不是倍率：
    /// 倍率是给人看的口径，落进内核必须变成"这台机器上到底几条线程"，
    /// 否则同一份设置换一台机器跑出另一种并发度，而界面上那个数不会再变。
    ///
    /// 由 `scan_parallel` 夹进 `1..=MAX_WORKERS`（见那边 `clamp_workers`）。
    pub workers: Option<usize>,
}

/// 把调用方给的扩展名清单归一：**补点 + 小写**，与 TS `TreeStore` 构造函数逐字同。
///
/// 归一是判据不是礼貌：一个没点的键（`gguf`）**不会报错，只会永远数出 0**，而 0 在界面上
/// 是一句看起来可信的话（「这台机器上一个 `.gguf` 都没有」）。
/// 默认 100 —— 与 TS `scanner.ts:148` 的 `o.topN ?? 100` 同一个数，两边不许各写一份。
pub const DEFAULT_TOP_N: usize = 100;

pub fn normalize_count_exts<'a>(iter: impl IntoIterator<Item = &'a str>) -> std::collections::HashSet<String> {
    iter.into_iter()
        .map(|e| {
            let with_dot = e.strip_prefix('.').unwrap_or(e);
            format!(".{}", with_dot.to_lowercase())
        })
        .collect()
}

impl ScanOptions {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        ScanOptions {
            root: root.into(),
            max_files_per_dir: DEFAULT_MAX_FILES_PER_DIR,
            skipped_sample_cap: DEFAULT_SKIPPED_SAMPLE_CAP,
            max_depth: DEFAULT_MAX_DEPTH,
            top_n: DEFAULT_TOP_N,
            count_exts: None,
            workers: None,
        }
    }

    /// 注入并行 worker 数。`None` = 本机逻辑核数。
    pub fn with_workers(mut self, workers: Option<usize>) -> Self {
        self.workers = workers;
        self
    }

    /// 注入要数的扩展名（清单为空 → 等于没注入，与 TS 的 `countExts: []` 同形）。
    pub fn with_count_exts(mut self, exts: &[&str]) -> Self {
        let set = normalize_count_exts(exts.iter().copied());
        self.count_exts = if set.is_empty() { None } else { Some(set) };
        self
    }
}

#[derive(Debug)]
pub enum ScanFailure {
    /// 根目录都打不开 —— 这不是"跳过"，是整轮失败
    Root(EnumerateError),
    /// 占用合计超过卷已用空间 0.5% 以上：去重或口径错了
    ImpossibleAccounting { counted: u64, used: u64 },
    /// 用户中途取消：**整轮作废**（不留半棵树）—— "已扫到一半的树"在这个阶段没有消费方，
    /// 留着它只会让界面显示一个看似完整、实则缺一块的图。
    Cancelled,
}

impl std::fmt::Display for ScanFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScanFailure::Root(e) => write!(f, "根目录不可读：{e}"),
            ScanFailure::ImpossibleAccounting { counted, used } => write!(
                f,
                "口径不可能成立：占用合计 {counted} 超过卷已用 {used} 的 0.5% —— 去重或口径错了"
            ),
            ScanFailure::Cancelled => write!(f, "已取消"),
        }
    }
}
impl std::error::Error for ScanFailure {}

/// 扫描的中途控制。
///
/// **暂停不是"假装暂停"**：界面上的「暂停扫描」如果只是把按钮文案改了、扫描还在跑，
/// 那是一个看着接上了其实没有的功能。这里每进一个目录都读一次标志：
///  · `cancel` 一旦置位 → 整轮 `Err(Cancelled)`；
///  · `paused` 期间 → 空转睡眠，**不发起新的目录枚举**（已拿到的树不动）。
#[derive(Debug, Clone, Default)]
pub struct ScanControl {
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    paused: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl ScanControl {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub fn pause(&self) {
        self.paused.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn resume(&self) {
        self.paused.store(false, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn is_paused(&self) -> bool {
        self.paused.load(std::sync::atomic::Ordering::SeqCst)
    }
}

struct Ctx {
    volume_serial: u32,
    accounting: FileAccounting,
    counters: Counters,
    skipped: Vec<SkippedItem>,
    sample_cap: usize,
    sample_overflowed: bool,
    max_files_per_dir: usize,
    max_depth: usize,
    /// 已归一的扩展名清单（`None` = 一个都不数）。住在 Ctx 里而不是每次查 `opts`，
    /// 因为这是三十万条目录项走过的那一段。
    count_exts: Option<std::collections::HashSet<String>>,
    /// 扫描途中顺带维护的「最大的 N 个文件」。
    top: crate::heap::TopHeap,
    progress: Box<dyn FnMut(&Counters)>,
    control: ScanControl,
    cancelled: bool,
}

impl Ctx {
    fn note_skip(&mut self, path: &Path, reason: SkipReason) {
        if self.skipped.len() < self.sample_cap {
            self.skipped.push(SkippedItem { path: path.to_string_lossy().into_owned(), reason });
        } else {
            self.sample_overflowed = true;
        }
    }
}

pub fn scan_tree(
    opts: &ScanOptions,
    volume: &VolumeInfo,
    progress: impl FnMut(&Counters) + 'static,
) -> Result<ScanTree, ScanFailure> {
    scan_tree_with(opts, volume, ScanControl::new(), progress)
}

pub fn scan_tree_with(
    opts: &ScanOptions,
    volume: &VolumeInfo,
    control: ScanControl,
    progress: impl FnMut(&Counters) + 'static,
) -> Result<ScanTree, ScanFailure> {
    let started = std::time::Instant::now();
    let mut ctx = Ctx {
        volume_serial: volume.serial,
        accounting: FileAccounting::new(),
        counters: Counters::default(),
        skipped: Vec::new(),
        sample_cap: opts.skipped_sample_cap,
        sample_overflowed: false,
        max_files_per_dir: opts.max_files_per_dir,
        max_depth: opts.max_depth,
        count_exts: opts.count_exts.clone(),
        top: crate::heap::TopHeap::new(opts.top_n),
        progress: Box::new(progress),
        control,
        cancelled: false,
    };

    let root_name = opts
        .root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| opts.root.to_string_lossy().into_owned());

    // 根目录必须先自己可读，否则整轮失败（子目录出错才算"跳过"）
    match read_dir_entries(&opts.root) {
        Ok(entries) => {
            let root = walk_entries(&mut ctx, &opts.root, root_name, 0, entries);
            if ctx.cancelled {
                return Err(ScanFailure::Cancelled);
            }
            // 去重计数长在累加器上（那是它的归属），报告口径要的是 counters —— 必须显式搬一次。
            // 漏了这一行会让"去重生效了"与"报告说没去重"同时为真（测试当场抓到）。
            ctx.counters.deduped_hardlinks = ctx.accounting.deduped_hardlinks;
            // counters 与根节点是**两条独立累加路径**，必须相等 —— 测试里钉着这条。
            debug_assert_eq!(ctx.counters.bytes_counted, root.size_counted);
            debug_assert_eq!(ctx.counters.dirs, root.dir_count);
            debug_assert_eq!(ctx.counters.files, root.file_count);
            let used = volume.used_bytes();
            if ctx.counters.bytes_counted > used + used / 200 {
                return Err(ScanFailure::ImpossibleAccounting { counted: ctx.counters.bytes_counted, used });
            }
            Ok(ScanTree {
                top: ctx.top.entries().to_vec(),
                root,
                counters: ctx.counters,
                volume: volume.clone(),
                skipped_sample: ctx.skipped,
                skipped_sample_overflowed: ctx.sample_overflowed,
                elapsed_ms: started.elapsed().as_millis() as u64,
                mode: ScanMode::Walk,
                mft: None,
            })
        }
        Err(e) => Err(ScanFailure::Root(e)),
    }
}

/// 处理**已经被父目录枚举出来**的一批条目，返回这一层的节点。
/// 把"读目录"和"折树"拆开是为了让根目录的错误能单独判成 `ScanFailure::Root`。
fn walk_entries(
    ctx: &mut Ctx,
    dir_path: &Path,
    name: String,
    depth: usize,
    mut entries: Vec<crate::enumerate::RawEntry>,
) -> ScanNode {
    let mut node = ScanNode::dir(name, dir_path.to_string_lossy().into_owned());

    // 枚举顺序由文件系统决定，**必须排序**，否则同一棵树两次扫描的节点顺序不同，
    // 派生出来的一切（含"取前 N 大"）都不稳定。
    entries.sort_by(|a, b| a.name.cmp(&b.name));

    for e in entries {
        // 取消/暂停的检查点。**放在每个条目之前**，这样一屏有几千个条目时也能秒级停下。
        if ctx.control.is_cancelled() {
            ctx.cancelled = true;
            return node;
        }
        while ctx.control.is_paused() && !ctx.control.is_cancelled() {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        let child_path = dir_path.join(&e.name);

        if let Some(reason) = skip_reason(&e) {
            match reason {
                SkipReason::Reparse => ctx.counters.skipped_reparse += 1,
                SkipReason::Always => ctx.counters.skipped_always += 1,
            }
            ctx.note_skip(&child_path, reason);
            continue;
        }

        if e.is_dir {
            // 无论进不进得去，它都是一个**存在**的目录 —— 计数口径必须一致，
            // 否则 root.dir_count 与 counters.dirs 会对不上（那正是我们用来交叉校验的量）。
            ctx.counters.dirs += 1;
            node.dir_count += 1;

            if depth + 1 > ctx.max_depth {
                ctx.counters.depth_capped += 1;
                ctx.counters.errors.bump(crate::winerr::ScanErrorKind::Unknown);
                node.errors.bump(crate::winerr::ScanErrorKind::Unknown);
                continue;
            }
            match read_dir_entries(&child_path) {
                Ok(children) => {
                    let mut child = walk_entries(ctx, &child_path, e.name.clone(), depth + 1, children);
                    if ctx.cancelled {
                        return node;
                    }
                    // 目录自身的属性/时间来自**父目录的那一条目录项**（e），零额外 syscall
                    child.attrs = e.attrs;
                    child.creation_ms = e.creation_ms;
                    child.mtime_ms = e.last_write_ms;
                    node.size_logical += child.size_logical;
                    node.size_alloc += child.size_alloc;
                    node.size_counted += child.size_counted;
                    node.file_count += child.file_count;
                    node.dir_count += child.dir_count;
                    node.errors.merge(child.errors);
                    node.children.push(child);
                }
                Err(err) => {
                    // 打不开的子目录：**不进去，但报数**。它的体积会落进「未计入」。
                    let kind = kind_of_win32(err.win32);
                    ctx.counters.errors.bump(kind);
                    node.errors.bump(kind);
                }
            }
            (ctx.progress)(&ctx.counters);
            continue;
        }

        // 普通文件
        let counted = ctx.accounting.count_file(ctx.volume_serial, e.file_id, e.alloc_size);
        ctx.counters.files += 1;
        ctx.counters.bytes_logical += e.size;
        ctx.counters.bytes_alloc += e.alloc_size;
        ctx.counters.bytes_counted += counted;
        node.file_count += 1;
        node.size_logical += e.size;
        node.size_alloc += e.alloc_size;
        node.size_counted += counted;
        // 扩展名计数：**位置在截断闸之前**，与 `ctx.counters.files` 同一侧。
        // 少了几个 G 的模型没被数，在界面上会伪装成「这台机器上没有」，那才是事故。
        // 字节口径是表观 `e.size`（TS 的 `f.size` 同一边），不是分配大小、不是去重后计入量。
        let ext_hit = ctx
            .count_exts
            .as_ref()
            .is_some_and(|set| set.contains(crate::model::ext_of(&e.name).as_str()));
        if ext_hit {
            ctx.counters.ext_count += 1;
            ctx.counters.ext_bytes += e.size;
        }
        // 「最大的 N 个文件」：**0 字节不进堆**（一个满盘树里 0 字节文件能有几万个，
        // 让它们进堆会把真候选挤光），且先问 `wants` 再分配（热路径上省一次 clone + join）。
        if e.size > 0 && ctx.top.wants(e.size) {
            ctx.top.push(crate::model::TopHit {
                name: e.name.clone(),
                path: dir_path.join(&e.name).to_string_lossy().into_owned(),
                size: e.size,
                mtime_ms: e.last_write_ms,
            });
        }
        if node.files.len() < ctx.max_files_per_dir {
            node.files.push(ScanFile {
                name: e.name,
                size: e.size,
                alloc: e.alloc_size,
                counted,
                file_id: e.file_id,
                mtime_ms: e.last_write_ms,
                creation_ms: e.creation_ms,
                // 目录项里本来就有这一位（`e` 是父目录那条 `FileIdBothDirectoryInfo`），
                // 丢掉它等于把 §28 原则二的判据从源头上废掉。
                attrs: e.attrs,
            });
        } else {
            node.files_truncated = true;
        }
    }

    node
}
