//! 真机 probe：管理员手跑，打印卷几何与 `$MFT` 规模，与
//! `fsutil fsinfo ntfsinfo` 对照（MS2 验收项）。
//!
//! 对照项（左 = 本程序输出，右 = fsutil 字段）：
//! · Bytes Per Sector         ← Bytes Per Sector
//! · Bytes Per Cluster        ← Bytes Per Cluster
//! · MFT Start Cluster        ← Mft Start Cluster
//! · Bytes Per FileRecord     ← Bytes Per FileRecord Segment
//! · $MFT Valid Data Length   ← Mft Valid Data Length（最强对账项，应逐位同值）
//! · $MFT 记录总数            ← Mft Valid Data Length ÷ Bytes Per FileRecord Segment
//!
//! 用法（管理员 PowerShell）：
//!   cargo run -p deepclean-scanner --example mft_probe -- C

use deepclean_scanner::mft::{parse_boot_sector, MftStream, RawVolume, StreamError, VolumeRead};

fn main() {
    let arg = match std::env::args().nth(1) {
        Some(a) => a,
        None => {
            eprintln!("用法: cargo run -p deepclean-scanner --example mft_probe -- <盘符，如 C>");
            std::process::exit(2);
        }
    };
    let drive = arg
        .chars()
        .find(|c| c.is_ascii_alphabetic())
        .unwrap_or_else(|| {
            eprintln!("盘符必须是字母：{arg}");
            std::process::exit(2);
        });

    let mut vol = match RawVolume::open(drive) {
        Ok(v) => v,
        Err(5) => {
            eprintln!(r"打开 \\.\{drive}: 被拒（win32 5）：需要管理员权限运行。");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!(r"打开 \\.\{drive}: 失败（win32 {e}）。");
            std::process::exit(1);
        }
    };

    let mut sector = [0u8; 512];
    if let Err(e) = vol.read_exact_at(0, &mut sector) {
        eprintln!("读引导扇区失败（win32 {e}）。");
        std::process::exit(1);
    }
    let geo = match parse_boot_sector(&sector) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("引导扇区不是可解析的 NTFS 卷：{e:?}（BitLocker 未解锁的卷会走到这里）。");
            std::process::exit(1);
        }
    };

    println!("== {drive}: 几何（与 fsutil fsinfo ntfsinfo 对照） ==");
    println!("Bytes Per Sector       : {}", geo.bytes_per_sector);
    println!("Bytes Per Cluster      : {}", geo.cluster_bytes());
    println!("MFT Start Cluster      : {}", geo.mft_lcn);
    println!("Bytes Per FileRecord   : {}", geo.bytes_per_file_record);
    println!("Total Sectors          : {}", geo.total_sectors);
    println!("Volume Bytes           : {}", geo.volume_bytes());

    match MftStream::open(vol, &geo) {
        Ok(st) => {
            println!();
            println!("$MFT Valid Data Length : {}", st.valid_bytes());
            println!("$MFT 记录总数          : {}", st.total_records());
            println!("$MFT 记录大小          : {}", st.record_size());
        }
        Err(StreamError::Io(e)) => {
            eprintln!("读 $MFT 失败（win32 {e}）。");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("$MFT 流打开失败：{e:?}。");
            std::process::exit(1);
        }
    }
}
