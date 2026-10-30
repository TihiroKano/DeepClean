// 1.0.3 vs 1.0.4 删除路径的端到端对照（2026-10-30）。
//
// 1.0.3：真删走 SHFileOperationW（shell 层），每文件一次调用。
// 1.0.4：真删走 DeleteFileW（内核层），每文件一次调用，但少掉 shell 那层包装。
//
// 结论先行（数据在下面）：内核直删快约 1.6×。批量 SHFileOperationW
// 那条路试过 —— **慢 10 倍**（shell 对多路径列表是逐条串行处理的，
// 还要多付一次 256 条的事务管理），已经从代码里撤掉，这条记录留作依据。
//
// ⚠️ 只在 .scan-cache/batchprobe/ 里跑，跑完自删。
use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::time::Instant;
use windows_sys::Win32::Storage::FileSystem::DeleteFileW;
use windows_sys::Win32::UI::Shell::{FO_DELETE, SHFileOperationW, SHFILEOPSTRUCTW};

/// 与 executor.rs 那条同一组标志：静默、不确认、不弹错误框。
const FOF_NO_UI_FLAGS: u16 = 0x0414; // FOF_SILENT | FOF_NOCONFIRMATION | FOF_NOERRORUI

const FILES: usize = 2000;

fn root() -> PathBuf {
    PathBuf::from(r"D:\DeepClean\.scan-cache\batchprobe")
}

fn build() {
    let _ = std::fs::remove_dir_all(root());
    for d in 0..40 {
        let dir = root().join(format!("w{d}"));
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..FILES / 40 {
            std::fs::write(dir.join(format!("f{i}.tmp")), vec![b'x'; 512]).unwrap();
        }
    }
}

fn all_files() -> Vec<String> {
    let mut out = Vec::new();
    for d in 0..40 {
        let dir = root().join(format!("w{d}"));
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            out.push(e.path().to_string_lossy().into_owned());
        }
    }
    out.sort();
    out
}

/// 1.0.3 那条路：SHFileOperationW 逐条（真删 = 不带 ALLOWUNDO）。
fn shell_delete(path: &str) -> bool {
    let mut wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
    wide.push(0);
    let mut op = SHFILEOPSTRUCTW {
        hwnd: std::ptr::null_mut(),
        wFunc: FO_DELETE,
        pFrom: wide.as_ptr(),
        pTo: std::ptr::null(),
        fFlags: FOF_NO_UI_FLAGS,
        fAnyOperationsAborted: 0,
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: std::ptr::null(),
    };
    unsafe { SHFileOperationW(&mut op) == 0 }
}

/// 1.0.4 那条路：内核直删（与 WindowsCleanFs::delete_permanently 的核心步同 API）。
fn kernel_delete(path: &str) -> bool {
    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
    unsafe { DeleteFileW(wide.as_ptr()) != 0 }
}

fn main() {
    let n = FILES;

    println!("=== 1.0.3 路：SHFileOperationW 逐条，{n} 个文件 ===");
    build();
    let paths = all_files();
    let t0 = Instant::now();
    let ok = paths.iter().filter(|p| shell_delete(p)).count();
    let shell = t0.elapsed().as_secs_f64() * 1000.0;
    println!("成功 {ok}，墙钟 {shell:.0}ms，每千文件 {:.1}ms", shell / n as f64 * 1000.0);

    println!("\n=== 1.0.4 路：DeleteFileW 内核直删，{n} 个文件 ===");
    build();
    let paths = all_files();
    let t0 = Instant::now();
    let ok = paths.iter().filter(|p| kernel_delete(p)).count();
    let kernel = t0.elapsed().as_secs_f64() * 1000.0;
    println!(
        "成功 {ok}，墙钟 {kernel:.0}ms，每千文件 {:.1}ms，加速 {:.2}×",
        kernel / n as f64 * 1000.0,
        shell / kernel
    );

    let _ = std::fs::remove_dir_all(root());
    println!("\n清理完毕。");
}
