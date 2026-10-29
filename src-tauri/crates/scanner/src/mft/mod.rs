//! MFT 直读档：整卷 NTFS 记录 → 与 walk 档同构的 [`crate::model::ScanTree`]。
//!
//! ## 为什么要有这一档
//!
//! walk 档（[`crate::scan`]）的文件大小来自**父目录枚举**（`FileIdBothDirectoryInfo`），
//! 所以被 ACL 挡住的**文件**并不少算 —— 少算的是打不开的**目录**：整个子树进不去，
//! 体积落进「未计入」。而 `System Volume Information`、`$Extend`、`pagefile.sys`
//! 这类大户恰恰住在那种目录里。MFT 是同一件事的彻底版：每条文件记录里直接写着
//! 大小与父引用，不需要打开任何一个文件 —— ACL 挡不住 MFT 的读者。
//! 对标工具 SpaceSniffer 的快与全就是这个来源（TS 参考实现 `core/ntfs/mft.ts` 头注里有
//! 2026-10-09 pagefile 9.27 GB 缺口的实测复盘）。
//!
//! ## 分层（unsafe 只进 `rawvol.rs`，其余全部纯函数）
//!
//! · `boot.rs`   —— 引导扇区 → 几何。偏移全部承袭 TS 版被真机纠正过两次的结论。
//! · `runs.rs`   —— data-run 变长解码 + `ExtentMap`（VCN → 卷内字节偏移）。
//!                  **TS 版 12% 惨案的根治点**：TS 按 `$MFT LCN × 簇 + index × 记录大小`
//!                  线性推偏移，隐含「$MFT 连续」假设，真机只读到 12%
//!                  （`docs/benchmarks/results.md` §10.4）。Rust 必须解析记录 0
//!                  非驻留 `$DATA` 的 run list，按盘区映射读。
//! · `record.rs` —— MFT 记录解析（fixup、属性遍历、扩展记录合并）。
//! · `rawvol.rs` —— `VolumeRead` 读取原语 + 真卷实现（unsafe 唯一驻留地）。
//! · `stream.rs` —— `$MFT` 顺序流 + 单条随机读。
//! · `tree.rs`   —— 树重建 + 计数（口径裁定集中在这里的注释里）。
//! · `testutil.rs`（仅 `cfg(test)`）—— 合成镜像编码器，与解析器互为镜像：
//!   任何一侧漂移，测试当场红。
//!
//! ## 档间已知差异（不是 bug，是口径，报告里的 `scan_mode` 字段负责解释）
//!
//! · meta 记录 0-15 **计入**（walk 档永远看不见它们）；
//! · `SKIP_ALWAYS` 不再按名跳过（walk 档跳它是因为 denied 噪声，MFT 档没有 denied）；
//! · 驻留小文件 alloc = 0（walk 档取整到簇，系统性多报）；
//! · ADS 计入 allocated 并单独报数（walk 档的目录项里没有 ADS，看不见）。

pub mod boot;
pub mod rawvol;
pub mod record;
pub mod runs;
pub mod stream;
pub mod tree;

#[cfg(test)]
pub(crate) mod testutil;

pub use boot::{parse_boot_sector, BootError, BootGeometry};
pub use rawvol::{RawVolume, VolumeRead};
pub use record::{
    apply_extensions, apply_update_sequence, parse_record, AttrListRef, FileNameAttr, MftRecord,
};
pub use runs::{decode_runs, ExtentMap, Run, RunError};
pub use stream::{MftStream, StreamError};
pub use tree::{build_tree, TreeBuild};

use std::path::Path;
use std::time::Instant;

use crate::model::{Counters, ScanMode, ScanTree};
use crate::scan::{ScanControl, ScanOptions};
use crate::volume::VolumeInfo;

/// MFT 档的失败清单。与 walk 档的 [`crate::scan::ScanFailure`] 平行，
/// 但**前四项的语义不同**：它们是「这一档开不了工」的分流信号（service 层收到
/// 就回退 walk 档），不是扫描本身的失败 —— walk 档没有"权限不够就换一条路"这回事。
#[derive(Debug)]
pub enum MftFailure {
    /// 根不是盘符根（`X:\`）。MFT 直读看到的是整卷，子目录请求不许进这一档。
    NotDriveRoot,
    /// 打不开裸卷（Win32 错误 5）—— 没有管理员。回退 walk 档或提示提权。
    NeedsElevation,
    /// 卷不是 NTFS —— MFT 直读无从谈起，walk 档照样能扫。
    NotNtfs,
    /// 引导扇区 / 几何 / 流结构与盘上事实对不上。宁可不扫也不扫出垃圾
    /// （TS 版 12% 惨案的教训：错了的几何读出来的每一条记录都是错的）。
    GeometryUnverified,
    /// 记录 5（根目录）不在 arena 里或不是目录。
    NoRootRecord,
    /// 卷读取 I/O 失败，携带 Win32 错误码原值。
    ReadFailed(u32),
    /// 用户中途取消：整轮作废（与 walk 档同一立场）。
    Cancelled,
    /// 哨兵：占用合计超过卷已用 0.5% 以上 —— 与 walk 档同判据。
    ImpossibleAccounting { counted: u64, used: u64 },
}

impl std::fmt::Display for MftFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MftFailure::NotDriveRoot => write!(f, "MFT 直读只支持盘符根（X:\\）"),
            MftFailure::NeedsElevation => write!(f, "MFT 直读需要管理员权限"),
            MftFailure::NotNtfs => write!(f, "卷不是 NTFS，MFT 直读不适用"),
            MftFailure::GeometryUnverified => write!(f, "卷几何与盘上事实对不上，拒绝以猜测继续"),
            MftFailure::NoRootRecord => write!(f, "根目录记录（MFT #5）缺失或不是目录"),
            MftFailure::ReadFailed(c) => write!(f, "卷读取失败（Win32 错误 {c}）"),
            MftFailure::Cancelled => write!(f, "已取消"),
            MftFailure::ImpossibleAccounting { counted, used } => write!(
                f,
                "口径不可能成立：占用合计 {counted} 超过卷已用 {used} 的 0.5% —— 去重或口径错了"
            ),
        }
    }
}
impl std::error::Error for MftFailure {}

impl From<BootError> for MftFailure {
    fn from(e: BootError) -> Self {
        match e {
            BootError::NotNtfs => MftFailure::NotNtfs,
            BootError::BadGeometry(_) => MftFailure::GeometryUnverified,
        }
    }
}

/// 裸卷打开的 Win32 错误码分流：5 = 需要提权，其余原样带过去。
fn map_win32(c: u32) -> MftFailure {
    if c == 5 {
        MftFailure::NeedsElevation
    } else {
        MftFailure::ReadFailed(c)
    }
}

/// 根路径必须是且仅是盘符根（`X:\` / `X:/`，大小写不限）→ 回大写盘符。
///
/// 为什么不许 `C:\Users`：MFT 直读看到的是**整卷**，把结果挂在一个子路径名下
/// 会让树与路径从根上对不上 —— 这种请求压根不该进这一档，而不是"扫子树"。
fn drive_root_letter(root: &Path) -> Option<char> {
    let s = root.as_os_str().to_str()?;
    let b = s.as_bytes();
    if b.len() == 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/')
    {
        Some(b[0].to_ascii_uppercase() as char)
    } else {
        None
    }
}

/// <10ms 的 try-first：盘符根 → 开裸卷 → 引导扇区 → 开 $MFT 流（记录 0 过 fixup）。
/// 全绿才值得走 MFT 档；任何一步失败都按 [`MftFailure`] 分流，service 层回退 walk。
pub fn probe_mft(root: &Path) -> Result<(), MftFailure> {
    let drive = drive_root_letter(root).ok_or(MftFailure::NotDriveRoot)?;
    let mut vol = RawVolume::open(drive).map_err(map_win32)?;
    let mut sector = [0u8; 512];
    vol.read_exact_at(0, &mut sector).map_err(map_win32)?;
    let geo = parse_boot_sector(&sector)?;
    // 开流 = 真正的几何验证（记录 0 过 fixup 才算数）；流不留在手上，probe 只判可行性
    drop(MftStream::open(vol, &geo).map_err(tree::map_stream)?);
    Ok(())
}

/// MFT 档整卷扫描：盘符根 → 裸卷 → $MFT 流 → 树重建 → 哨兵 → [`ScanTree`]。
///
/// 前置条件由 [`probe_mft`] 保证（service 层先 probe 再调这里）；这里再走一遍
/// 同样的打开序列 —— 开卷两次各 <10ms，换来两条路径彼此独立、谁也不用假设对方刚验过。
pub fn scan_volume_mft(
    opts: &ScanOptions,
    volume: VolumeInfo,
    control: &ScanControl,
    mut progress: impl FnMut(&Counters),
) -> Result<ScanTree, MftFailure> {
    let started = Instant::now();
    let drive = drive_root_letter(&opts.root).ok_or(MftFailure::NotDriveRoot)?;
    let mut vol = RawVolume::open(drive).map_err(map_win32)?;
    let mut sector = [0u8; 512];
    vol.read_exact_at(0, &mut sector).map_err(map_win32)?;
    let geo = parse_boot_sector(&sector)?;
    let stream = MftStream::open(vol, &geo).map_err(tree::map_stream)?;

    // 根名与 walk 档同一套 fallback（file_name 取不到就整串）—— 两档产出的根节点
    // 必须长得一样，界面上才看不出"这次扫的是另一棵树"。
    let root_name = opts
        .root
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| opts.root.to_string_lossy().into_owned());
    let root_path = opts.root.to_string_lossy().into_owned();

    let tb = build_tree(
        stream,
        &geo,
        opts,
        volume.serial,
        &root_name,
        &root_path,
        control,
        &mut progress,
    )?;

    // 哨兵与 walk 档同判据（0.5% 吸收扫描期间磁盘自身变动）。
    // MFT 档把 meta 记录也算进 counted —— 它们是真实占用，「卷已用」里本来就有。
    let used = volume.used_bytes();
    let counted = tb.counters.bytes_counted;
    if counted > used.saturating_add(used / 200) {
        return Err(MftFailure::ImpossibleAccounting { counted, used });
    }

    Ok(ScanTree {
        root: tb.root,
        counters: tb.counters,
        top: tb.top,
        volume,
        // MFT 档没有 denied 样本（ACL 挡不住 MFT 读者）；跳过量走 counters 报数
        skipped_sample: Vec::new(),
        skipped_sample_overflowed: false,
        elapsed_ms: started.elapsed().as_millis() as u64,
        mode: ScanMode::Mft,
        mft: Some(tb.stats),
    })
}
