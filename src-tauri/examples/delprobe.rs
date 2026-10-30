// 删除并发的**真线程**探针（2026-10-30）。
//
// `scripts/_delprobe.mjs` 用 Node async 模拟并发，量到的饱和点是 4，但那是
// **单线程事件循环**里的"并发"——它只能说明 I/O 队列的排队行为，不能说明
// "真开 N 条系统线程"时会发生什么。这个探针补上那一半：
//
// 用 `std::thread` 真的开 N 条，每条在一批独立目录上调 `DeleteFileW` + `RemoveDirectoryW`
// （就是执行器那一层的系统调用），量墙钟与 RSS 峰值。
//
// ## 这次要回答的三个问题
//
//  ① **饱和点在哪** —— 加速比什么时候掉到 1.15× 以下。
//  ② **它跟核数有关吗** —— 本机 8 核；如果饱和点显著小于 8，那"核数"就不是正确的上限。
//  ③ **RSS 随并发怎么长** —— 如果基本不涨，那"崩溃"的成因不是内存，
//     "最高安全值"就不该按内存算。
//
// 只用 `.scan-cache/delprobe-rs/`，跑完自己删掉。
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

const FILES_PER_DIR: usize = 400;
const DIRS_TOTAL: usize = 80;

fn root() -> PathBuf {
    PathBuf::from(r"D:\DeepClean\.scan-cache\delprobe-rs")
}

fn reset() {
    let _ = std::fs::remove_dir_all(root());
    std::fs::create_dir_all(root()).unwrap();
}

fn build(n: usize) {
    for d in 0..n {
        let dir = root().join(format!("w{d}"));
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..FILES_PER_DIR {
            std::fs::write(dir.join(format!("f{i}.tmp")), vec![b'x'; 512]).unwrap();
        }
    }
}

fn del_dir(dir: &Path) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let _ = std::fs::remove_file(e.path());
            n += 1;
        }
    }
    let _ = std::fs::remove_dir(dir);
    n
}

/// 用 `parallel` 条真系统线程分食 `n` 个目录。
fn run(n: usize, parallel: usize) -> (f64, usize) {
    build(n);
    let dirs: Vec<PathBuf> = (0..n).map(|i| root().join(format!("w{i}"))).collect();
    let shared = std::sync::Arc::new(AtomicUsize::new(0));
    let files = std::sync::Arc::new(AtomicUsize::new(0));
    let t0 = Instant::now();
    std::thread::scope(|scope| {
        for _ in 0..parallel.min(n) {
            let dirs = &dirs;
            let shared = shared.clone();
            let files = files.clone();
            scope.spawn(move || loop {
                let i = shared.fetch_add(1, Ordering::SeqCst);
                if i >= dirs.len() {
                    return;
                }
                files.fetch_add(del_dir(&dirs[i]), Ordering::SeqCst);
            });
        }
    });
    (t0.elapsed().as_secs_f64() * 1000.0, files.load(Ordering::SeqCst))
}

/// 本进程当前工作集（MB）。用 Windows 的 `K32GetProcessMemoryInfo`。
///
/// 为什么必须量这个：人类伙伴问的是「最高的安全值」，而"崩溃"最可能的成因是
/// **内存**（每个 worker 有自己的缓冲），不是线程调度。不量这一格，
/// 任何"安全值"都只是猜。
fn rss_mb() -> f64 {
    use windows_sys::Win32::System::ProcessStatus::{
        K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    let mut c = PROCESS_MEMORY_COUNTERS {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        PageFaultCount: 0,
        PeakWorkingSetSize: 0,
        WorkingSetSize: 0,
        QuotaPeakPagedPoolUsage: 0,
        QuotaPagedPoolUsage: 0,
        QuotaPeakNonPagedPoolUsage: 0,
        QuotaNonPagedPoolUsage: 0,
        PagefileUsage: 0,
        PeakPagefileUsage: 0,
    };
    // SAFETY: `c` 是栈上一个按 `cb` 正确初始化大小的结构体，句柄是当前进程的伪句柄。
    let ok = unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
    if ok == 0 {
        return 0.0;
    }
    c.PeakWorkingSetSize as f64 / 1024.0 / 1024.0
}

fn main() {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    println!("=== 机器 ===");
    println!("逻辑核数: {cores}");
    println!("每目录 {FILES_PER_DIR} 个文件，共 {DIRS_TOTAL} 个目录");

    println!("\n=== 真线程并发 vs 墙钟 ===");
    println!("并发\t文件数\t墙钟ms\t每千文件ms\t相对1x\t内存");
    let mut base = 0.0;
    let mut rows: Vec<(usize, f64)> = Vec::new();
    for p in [1usize, 2, 4, 8, 16] {
        let (ms, files) = run(DIRS_TOTAL, p);
        if p == 1 {
            base = ms;
        }
        rows.push((p, ms));
        println!(
            "{p}\t{files}\t{ms:.0}\t{:.2}\t{:.2}x\t峰值RSS {:.1}MB",
            ms / files as f64 * 1000.0,
            base / ms,
            rss_mb()
        );
    }

    println!("\n=== 饱和点 ===");
    for w in rows.windows(2) {
        let (p0, m0) = w[0];
        let (p1, m1) = w[1];
        let gain = m0 / m1;
        println!("并发 {p0} → {p1}: 加速 {gain:.2}×{}", if gain < 1.15 { "  ← 已饱和" } else { "" });
    }

    reset();
    println!("\n清理完毕。");
}
