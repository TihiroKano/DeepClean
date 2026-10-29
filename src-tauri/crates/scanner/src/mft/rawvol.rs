//! 卷读取原语 —— MFT 档唯一的 I/O 边界，**crate 里 unsafe 的第三处**（MS2 起）。
//!
//! ## 为什么收在这一个文件里
//!
//! 纯解析层（`boot`/`runs`/`record`）与树重建（`tree.rs`）全部经由 [`VolumeRead`]
//! 取字节，谁也不直接碰 Win32。于是合成镜像（`testutil::InMemoryVolume`，仅 cfg(test)）
//! 与真卷实现（[`RawVolume`]）可以互换 —— 没有管理员的机器上照样全测，
//! 真卷的 unsafe 也被圈死在这一个文件里，进不来第二个。
//!
//! ## 错误口径
//!
//! `Err(u32)` 直接装 **Win32 错误码**，不另造枚举：调用方（probe / service 层）按
//! `5`（ACCESS_DENIED → 报"需要提权"）、`32`/`33`（共享冲突 → BitLocker/占用分流）
//! 分流，其余原样透传。真卷实现从 `GetLastError()` 原样带来；合成镜像越界回
//! `38`（ERROR_HANDLE_EOF），与"读过了卷尾"的真实语义一致。

/// 逐字节精确读：从卷内字节偏移 `offset` 起读满 `buf.len()` 字节。
///
/// 实现方必须**要么读满、要么报错**，不许短读 —— 短读会让上层把半条记录当整条解析，
/// 那正是 MFT 直读最要堵的静默错（TS 版 12% 惨案的教训：读错了地方，剩下的全是垃圾）。
pub trait VolumeRead {
    fn read_exact_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), u32>;
}

use windows_sys::Win32::Foundation::{
    CloseHandle, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, SetFilePointerEx, FILE_BEGIN, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};

fn last_error() -> u32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32
}

/// `\\.\X:` 裸卷句柄（持有所有权，Drop 关闭）。
///
/// ## 三个打开参数都是裁定过的，别改
///
/// · **`GENERIC_READ`**：读卷只需要读。写碰都不碰 —— 这一层是只读的，谁想写谁自己提权。
/// · **`FILE_SHARE_READ | FILE_SHARE_WRITE`**：卷永远被系统占用着（USN 日志、配额…），
///   不共享写直接打不开。`FILE_SHARE_DELETE` 对卷句柄无意义，不给。
/// · **不带 `FILE_FLAG_NO_BUFFERING`**：带它就必须扇区对齐缓冲，换取的直读性能
///   对"顺序吃几百 MB 的 $MFT"没有决定性差别，却把对齐责任压到每个调用点。
///   不带它，缓存管理器替我们兜任意偏移 —— 实现简单，错的可能性少一种。
pub struct RawVolume {
    handle: HANDLE,
}

impl RawVolume {
    /// 打开盘符卷的裸设备。需要管理员 —— 没有时返回 `Err(5)`，probe 据此报
    /// "需要提权"并回退 walk 档。BitLocker 未解锁的卷打不开时会带出对应错误码
    /// （由上层分流），这里不猜、不改写。
    pub fn open(drive: char) -> Result<Self, u32> {
        if !drive.is_ascii_alphabetic() {
            return Err(87); // ERROR_INVALID_PARAMETER：盘符只可能是字母
        }
        let path: Vec<u16> = format!("\\\\.\\{}:", drive.to_ascii_uppercase())
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0, // 无标志：见模块注释第三条
                std::ptr::null_mut(), // 无模板句柄（*mut c_void，0 不自动转型）
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(last_error());
        }
        Ok(RawVolume { handle })
    }
}

impl Drop for RawVolume {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.handle);
        }
    }
}

impl VolumeRead for RawVolume {
    fn read_exact_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), u32> {
        // 先定位再读。SetFilePointerEx 返回 0 且 GetLastError 为 0 才是成功 ——
        // BOOL 0 = 失败；这里只信 BOOL。
        unsafe {
            let mut new_pos: i64 = 0;
            if SetFilePointerEx(self.handle, offset as i64, &mut new_pos, FILE_BEGIN) == 0 {
                return Err(last_error());
            }
            let mut filled = 0usize;
            while filled < buf.len() {
                let mut got: u32 = 0;
                let ok = ReadFile(
                    self.handle,
                    buf[filled..].as_mut_ptr(),
                    (buf.len() - filled) as u32,
                    &mut got,
                    std::ptr::null_mut(),
                );
                if ok == 0 {
                    return Err(last_error());
                }
                if got == 0 {
                    // 读到卷尾还没读满 —— 这是要堵的"短读"，按 EOF 报错而不是返回半截
                    return Err(38); // ERROR_HANDLE_EOF
                }
                filled += got as usize;
            }
        }
        Ok(())
    }
}
