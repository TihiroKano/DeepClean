//! 目录枚举：一次遍历同时取「文件 ID」与「磁盘分配大小」。
//!
//! **这是 M1 与现行 TS 实现的根本差别。** TS 侧对每个目录项单独 `stat` 且只拿逻辑大小
//! （`core/fs/fslike.ts:70`）；`FileIdBothDirectoryInfo` 把两样都在目录项里给全，
//! 所以硬链接去重与占用口径**都不需要任何额外 syscall**，也就没有"逐文件 stat 慢"这笔账。
//!
//! 四条承重事实（每一条都对应一个真实坑）：
//!  1. 能用 `CreateFileW` 打开**目录**的前提是带上 `FILE_FLAG_BACKUP_SEMANTICS`，否则一律
//!     `ACCESS_DENIED`（看起来像"没权限"，其实是参数不对）。
//!  2. `GetFileInformationByHandleEx` 一轮放不下就返回 `ERROR_MORE_DATA`；**这一轮里的数据
//!     是有效的**，要先解析再接着调；不能用"返回非 0 才算成功"那把尺子。
//!  3. `\\?\` 语义下目录枚举**会返回 `.` 与 `..`**（卷根不会），必须跳过 —— 不跳会多出
//!     两个长度全是点的假目录，而总字节数还是对的（本项目为这类"数字对、结构错"付过学费）。
//!  4. **先判 reparse 再判 dir**：重解析点常带 `FILE_ATTRIBUTE_DIRECTORY` 位，
//!     顺序反了就会把它当普通目录递归进去，直接踩成环。

use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetCompressedFileSizeW, GetFileInformationByHandleEx, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    // 这两个常量**必须**用 crate 的，不许自己数：`FileIdBothDirectoryInfo` 是 10、
    // `FileIdExtdDirectoryInfo` 是 19，而 14/15 是 `FileFullDirectoryInfo` —— 后者结构体
    // 里没有 ShortName/FileId，按前者的布局去解析它不会报错，只会把所有名字读成乱码。
    // 我第一次就是手写成 14/15，四条集成测试全红在两串乱码名字上。
    FileIdBothDirectoryInfo as CLASS_FILE_ID_BOTH,
    FileIdBothDirectoryRestartInfo as CLASS_FILE_ID_BOTH_RESTART,
};

/// 一轮缓冲 64 KiB：够放几百条目录项，条数再多也只是多调几轮。
pub const BUF_BYTES: usize = 64 * 1024;

const ERROR_MORE_DATA: u32 = 234;
const ERROR_NO_MORE_FILES: u32 = 18;
/// `GetFileInformationByHandleEx` 走的是 NT 层接口，缓冲不够时会直接把 STATUS 码
/// 当 Win32 错误抛出来，而不是折成 234。
const STATUS_BUFFER_OVERFLOW: u32 = 0x8000_0005;

/// `FILE_ID_BOTH_DIR_INFO`（微软文档逐字段照抄）。
///
/// **自己定义而不是引 crate 的结构体**：结构体布局是与内核的 ABI 契约，跟着 crate 小版本
/// 漂移是最坏的失败模式（字段悄悄错位，读出来的名字会是乱码而程序照跑）。下面
/// `layout_matches_the_win32_abi` 那条测试把两个关键偏移钉死，改布局必须先过它。
#[repr(C)]
struct FileIdBothDirInfo {
    next_entry_offset: u32,
    file_index: u32,
    creation_time: i64,
    last_access_time: i64,
    last_write_time: i64,
    change_time: i64,
    end_of_file: i64,
    allocation_size: i64,
    file_attributes: u32,
    file_name_length: u32,
    ea_size: u32,
    short_name_length: i8,
    short_name: [u16; 12],
    file_id: i64,
    file_name: [u16; 1],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEntry {
    pub name: String,
    /// 逻辑（表观）大小 —— 只用于展示，不参与任何聚合
    pub size: u64,
    /// 磁盘分配大小 —— **所有聚合都用它**
    pub alloc_size: u64,
    /// NTFS 文件引用号；非 NTFS（FAT/exFAT）可能为 0，那时不许拿去去重
    pub file_id: u64,
    pub attrs: u32,
    pub last_write_ms: i64,
    pub creation_ms: i64,
    pub is_dir: bool,
    pub is_reparse: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnumerateError {
    pub win32: u32,
    pub path: String,
}

impl std::fmt::Display for EnumerateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "枚举 {} 失败（win32 {}）", self.path, self.win32)
    }
}
impl std::error::Error for EnumerateError {}

/// FILETIME（自 1601 起的 100 ns）→ Unix 毫秒。纯函数。
pub fn filetime_to_unix_ms(ft: i64) -> i64 {
    const EPOCH_DIFF_MS: i64 = 11_644_473_600_000; // 1601 → 1970
    ft / 10_000 - EPOCH_DIFF_MS
}

/// 加 `\\?\` 前缀。绕过 MAX_PATH，且不做路径规范化 —— 深目录（dev 的 node_modules）
/// 不加前缀会被静默截断，那是"少计"而不是报错。UNC 路径要换成 `\\?\UNC\` 形式。
fn to_extended(path: &Path) -> Vec<u16> {
    let s = path.as_os_str().to_string_lossy();
    let prefixed = if let Some(rest) = s.strip_prefix(r"\\") {
        format!(r"\\?\UNC\{rest}")
    } else {
        format!(r"\\?\{s}")
    };
    std::ffi::OsStr::new(&prefixed)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

struct HandleGuard(HANDLE);
impl Drop for HandleGuard {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// 枚举目录的直接子项（不递归）。重解析点**照常返回**（由调用方决定进不进入），
/// 这样"跳过"这件事是可报数的，而不是在这里被静默吞掉。
pub fn read_dir_entries(dir: &Path) -> Result<Vec<RawEntry>, EnumerateError> {
    let err = |win32: u32| EnumerateError {
        win32,
        path: dir.to_string_lossy().into_owned(),
    };

    let path_w = to_extended(dir);
    let handle = unsafe {
        CreateFileW(
            path_w.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(err(last_error_code()));
    }
    let _guard = HandleGuard(handle);

    let name_offset = std::mem::offset_of!(FileIdBothDirInfo, file_name);
    let mut buf = vec![0u8; BUF_BYTES];
    let mut out: Vec<RawEntry> = Vec::new();
    let mut first = true;

    // ⚠️ **循环的终止条件不是 `ERROR_MORE_DATA`，而是调用失败**。这条是拿真盘纠出来的：
    // `GetFileInformationByHandleEx(FileIdBothDirectoryInfo)` 在**缓冲区被填满**时返回的是
    // **成功**（实测 64 KiB 缓冲 480 条、4 KiB 缓冲 28 条，两次都是 ok=1、err=0），
    // 不是文档里那套 "ERROR_MORE_DATA 就再来一轮"。照文档写会**静默截断到一轮缓冲的量**：
    // `C:\Windows\WinSxS` 顶层 8 万多个文件只回来 262 条，`C:` 整盘少算约 30 GB，
    // 而且**一条错误都不报**。回归测试：`enumerates_a_directory_that_does_not_fit_in_one_buffer`。
    loop {
        let class = if first { CLASS_FILE_ID_BOTH_RESTART } else { CLASS_FILE_ID_BOTH };
        first = false;

        let ok = unsafe {
            GetFileInformationByHandleEx(
                handle,
                class,
                buf.as_mut_ptr() as *mut core::ffi::c_void,
                buf.len() as u32,
            )
        };
        // `GetLastError` 的语义是"每线程最后一个错误"，下面那段解析会分配 String/调堆 ——
        // 堆操作本身就会把它冲掉。所以必须在**下一条语句**就取出来。
        let err_code = if ok == 0 { last_error_code() } else { 0 };

        let before = out.len();
        // ⚠️ **只在"缓冲区里真有新数据"时解析**。失败（尤其 `ERROR_NO_MORE_FILES`）时
        // 缓冲区里留着的是**上一轮的旧条目**：实测 4 条目的目录末轮 added=4、
        // 1500 条目的目录末轮 added=62，两轮读到的名字与上一轮完全相同。
        // 照单全收＝把最后一批重复计一遍（8 vs 4、1566 vs 1504）。
        let fresh = ok != 0 || err_code == ERROR_MORE_DATA || err_code == STATUS_BUFFER_OVERFLOW;
        if fresh {
            let mut offset = 0usize;
            loop {
                let info = unsafe { &*(buf.as_ptr().add(offset) as *const FileIdBothDirInfo) };
                let name_bytes = info.file_name_length as usize;
                if name_bytes >= 2 {
                    let name_ptr = unsafe { buf.as_ptr().add(offset + name_offset) } as *const u16;
                    let name_slice = unsafe { std::slice::from_raw_parts(name_ptr, name_bytes / 2) };
                    let name = String::from_utf16_lossy(name_slice);
                    if name != "." && name != ".." {
                        let attrs = info.file_attributes;
                        let is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
                        let end_of_file = info.end_of_file.max(0) as u64;
                        let mut alloc_size = info.allocation_size.max(0) as u64;

                        // ⚠️ **压缩文件在目录项里的 AllocationSize 是 0。**
                        // 2026-10-10 实测：`C:\Program Files\Windows NT\Accessories\wordpad.exe`
                        // 逻辑 2,932,736 B，目录项报 **0**，而真实占用 1,191,936 B（Compact OS）。
                        // 不补这一步，占用口径在压缩卷上会**严重少报** —— 而"少报"会**伪装成通过**：
                        // 「合计 ≤ 卷容量」那条判据在少报时自动成立，所以 M1 的验收当时没抓住它
                        // （整个 C: 因此少算约 1.6 GB / 25%，见 M2 验收档）。
                        // 这类文件退化成一次**按路径**的 `GetCompressedFileSizeW`（不必开句柄）。
                        if !is_dir && alloc_size == 0 && end_of_file > 0 {
                            let full = dir.join(&name);
                            if let Some(a) = compressed_size_fallback(&full) {
                                alloc_size = a;
                            }
                        }

                        out.push(RawEntry {
                            name,
                            size: end_of_file,
                            alloc_size,
                            file_id: info.file_id.max(0) as u64,
                            attrs,
                            last_write_ms: filetime_to_unix_ms(info.last_write_time),
                            creation_ms: filetime_to_unix_ms(info.creation_time),
                            // 顺序要紧：先 reparse 再 dir（见模块头第 4 条）
                            is_reparse: attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0,
                            is_dir,
                        });
                    }
                }
                if info.next_entry_offset == 0 {
                    break;
                }
                offset += info.next_entry_offset as usize;
                if offset >= buf.len() {
                    break;
                }
            }
        }

        if ok != 0 {
            // 成功但**一条都没新增** = 已经到底了（防御：避免空转）
            if out.len() == before {
                return Ok(out);
            }
            continue;
        }
        return match err_code {
            // 扫完了 —— 这才是正常的出口
            ERROR_NO_MORE_FILES => Ok(out),
            ERROR_MORE_DATA | STATUS_BUFFER_OVERFLOW => continue,
            other => Err(err(other)),
        };
    }
}

/// 压缩 / 稀疏文件的真实占用。**只在目录项报 0 时调用**（见上面那段注释）。
/// 比开句柄的 `FileStandardInfo` 便宜，且实测两者给同一个数。
fn compressed_size_fallback(path: &Path) -> Option<u64> {
    let w = to_extended(path);
    let mut hi: u32 = 0;
    let lo = unsafe { GetCompressedFileSizeW(w.as_ptr(), &mut hi) };
    // INVALID_FILE_SIZE（两个 32 位都全 1）= 调用失败。**失败就退回 0**，
    // 不许猜一个数：这里少报会被下游当成"这个文件不占空间"。
    if lo == u32::MAX && hi == u32::MAX {
        return None;
    }
    Some(((hi as u64) << 32) | lo as u64)
}

fn last_error_code() -> u32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 结构体布局是与内核的 ABI 契约。这两个偏移一旦漂了，读出来的名字是乱码、
    /// 而程序照常跑 —— 所以钉死在测试里，改布局必须先改这条。
    #[test]
    fn layout_matches_the_win32_abi() {
        assert_eq!(std::mem::offset_of!(FileIdBothDirInfo, allocation_size), 48);
        assert_eq!(std::mem::offset_of!(FileIdBothDirInfo, file_name_length), 60);
        assert_eq!(std::mem::offset_of!(FileIdBothDirInfo, file_id), 96);
        assert_eq!(std::mem::offset_of!(FileIdBothDirInfo, file_name), 104);
    }

    /// 2026-01-01T00:00:00Z。这是唯一一处"常数从哪来"能一眼验的地方。
    #[test]
    fn filetime_conversion_matches_a_known_instant() {
        let unix_ms: i64 = 1_767_225_600_000;
        let ft = (unix_ms + 11_644_473_600_000) * 10_000;
        assert_eq!(filetime_to_unix_ms(ft), unix_ms);
    }

    #[test]
    fn extended_prefix_handles_drive_and_unc() {
        // 比较整串（去掉尾部 NUL），不切片 —— 切片长度写错会把"内容对"误判成失败。
        let whole = |p: &Path| {
            let mut w = to_extended(p);
            assert_eq!(*w.last().unwrap(), 0, "必须以 NUL 结尾");
            w.pop();
            String::from_utf16_lossy(&w)
        };
        assert_eq!(whole(Path::new(r"D:\x")), r"\\?\D:\x");
        assert_eq!(whole(Path::new(r"\\srv\share\y")), r"\\?\UNC\srv\share\y");
    }
}
