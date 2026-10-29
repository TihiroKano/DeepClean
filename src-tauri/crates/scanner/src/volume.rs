//! 卷几何。
//!
//! **不走 PowerShell**：现行 TS 侧走 `Get-CimInstance Win32_LogicalDisk`
//! （`electron/services/drives.ts:4-6`，理由是 `fs.statfs` 不返回 bsize），
//! 而 Rust 里 `GetDiskFreeSpaceExW` 直接给三个数 —— 少一个进程、少一次文本解析。
//!
//! **序列号必须与本文件里的文件 ID 同源**：硬链接去重键是 `(卷序列号, 文件 ID)`，
//! 序列号取自 `GetVolumeInformationW` 作用于 `GetVolumePathNameW` 归出的**挂载点**
//! （"C:\Users\x" -> "C:\"）。混用别的来源（比如按盘符拼字面量）会在挂载点、
//! 卷影副本这类路径上给出与文件 ID 不匹配的号。

use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetVolumeInformationW, GetVolumePathNameW,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeInfo {
    pub serial: u32,
    pub label: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

impl VolumeInfo {
    pub fn used_bytes(&self) -> u64 {
        self.total_bytes.saturating_sub(self.free_bytes)
    }
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

fn nul_trimmed(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// 取 `path` 所在卷的几何。`path` 不存在时返回错误（`GetVolumePathNameW` 不给凭空路径猜卷）。
pub fn volume_of(path: &Path) -> std::io::Result<VolumeInfo> {
    let input = wide(path);
    let mut root = vec![0u16; 260];
    let ok = unsafe { GetVolumePathNameW(input.as_ptr(), root.as_mut_ptr(), root.len() as u32) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }

    let mut serial: u32 = 0;
    let mut label = vec![0u16; 261];
    let ok = unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            label.as_mut_ptr(),
            label.len() as u32,
            &mut serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }

    let mut free_to_caller: u64 = 0;
    let mut total: u64 = 0;
    let mut free: u64 = 0;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            root.as_ptr(),
            &mut free_to_caller,
            &mut total,
            &mut free,
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    let _ = free_to_caller; // 调用者可用额度，容量口径不用它 —— 显式丢弃而不是注释掉

    Ok(VolumeInfo {
        serial,
        label: nul_trimmed(&label),
        total_bytes: total,
        free_bytes: free,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn reads_the_system_drive() {
        let v = volume_of(Path::new("C:\\")).expect("C: 应当可读");
        assert_ne!(v.serial, 0, "卷序列号不该是 0");
        assert!(v.total_bytes > 0, "总容量不该是 0");
        assert!(v.free_bytes <= v.total_bytes, "可用不该超过总容量");
        assert!(v.used_bytes() <= v.total_bytes);
    }

    #[test]
    fn a_nested_path_resolves_to_the_same_volume() {
        let a = volume_of(Path::new("C:\\Windows")).expect("C:\\Windows 应当可读");
        let b = volume_of(Path::new("C:\\Users")).expect("C:\\Users 应当可读");
        assert_eq!(a.serial, b.serial, "同一卷的两个子路径必须归到同一个序列号");
        assert_eq!(a.total_bytes, b.total_bytes);
    }

    #[test]
    fn a_path_that_does_not_exist_is_an_error_not_a_guess() {
        let r = volume_of(Path::new("Q:\\definitely-not-a-volume\\x"));
        assert!(r.is_err(), "不存在的卷必须报错，不许猜一个出来");
    }
}
