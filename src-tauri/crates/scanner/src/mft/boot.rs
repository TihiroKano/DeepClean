//! NTFS `$Boot` 引导扇区解析 —— **纯函数，零 unsafe**。
//!
//! 要的东西只有五个：每扇区字节数、每簇扇区数、`$MFT` 起始簇号、每条文件记录多少字节、卷总扇区数。
//!
//! ## 偏移全部承袭 TS 版被真机纠正过两次的结论（`core/ntfs/boot.ts`，2026-10-09 本机 C:）
//!
//! **第一错（TS 第一版）：整套偏移早 8 字节。** 正确布局是
//! `0x28 总扇区 / 0x30 MFT 起始簇 / 0x38 $MFTMirr 簇 / 0x40 记录因子`。
//! 读错的结果不是报错，而是"安静算错"：把 `$MFTMirr` 簇号的低 32 位当成记录因子，
//! 会得出 8192 字节/记录这种错得离谱却能一路跑下去的值。
//!
//! **第二错（TS 第一版）：记录因子按 int32 读。** 真卷 0x40 处 4 字节是 `f6 00 00 00`，
//! 按 int32 = 246（⇒ 一百万字节的记录），按 **int8 读最低字节** = -10 ⇒ 2^10 = 1024，
//! 与 `fsutil fsinfo ntfsinfo` 的 `Bytes Per FileRecord Segment` 逐位吻合。
//! 即：这个字段宽 4 字节但**符号只写在最低字节**（Windows 写的是零扩展的 signed char），
//! 只读最低字节对两种编码都成立。
//!
//! ## 自检立场（从 TS 版原样搬来，不许拆）
//!
//! 本层只解析、不自证。`probe`（`mod.rs`，MS2 落地）拿这里的几何去读**第一条记录**，
//! 要求 `FILE` 签名**且** update sequence 自洽 —— 两个条件同时成立的概率极低，
//! 所以"偏移猜错"会在第一次运行就变成一条有名有姓的失败。错的话会响，不会骗人。
//! 对过账的是本机那张卷；4Kn 卷、别的格式化参数，全靠这套自检兜住。

/// 解析成功的几何。所有后续读取都从这五个数推导。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootGeometry {
    /// 每扇区字节数（512..=4096，2 的幂；4Kn 卷可能是 4096）
    pub bytes_per_sector: u32,
    /// 每簇扇区数（非 0，2 的幂）
    pub sectors_per_cluster: u32,
    /// 每条文件记录字节数。通常 1024；也可能是 4096。
    pub bytes_per_file_record: u32,
    /// `$MFT` 起始 LCN（簇号）
    pub mft_lcn: u64,
    /// 卷总扇区数 —— 读取范围的上界，越界读卷会直接失败
    pub total_sectors: u64,
}

impl BootGeometry {
    pub fn cluster_bytes(&self) -> u64 {
        self.sectors_per_cluster as u64 * self.bytes_per_sector as u64
    }

    /// `$MFT` 未命名 `$DATA` 的起始字节偏移 = 起始簇 × 簇大小。
    /// **这只是 $MFT 的第一个盘区的位置** —— $MFT 碎片时后续盘区不在 continues
    /// 线性偏移上，必须走 `runs.rs` 的盘区映射（TS 版 12% 惨案的根因）。
    pub fn mft_byte_offset(&self) -> u64 {
        self.mft_lcn * self.cluster_bytes()
    }

    /// 卷总字节数。记录 0 的 $DATA `real size` 与它交叉印证（$MFT 不会比卷还大）。
    pub fn volume_bytes(&self) -> u64 {
        self.total_sectors * self.bytes_per_sector as u64
    }

    /// 记录大小上界复核。与 TS `openMft` 的 512..=65536 同值：
    /// 下界挡"0/8192 之类的错位读数"，上界挡 2^16 之外的荒谬值。
    pub fn record_size_sane(&self) -> bool {
        (512..=65536).contains(&self.bytes_per_file_record)
    }
}

/// 解析失败。每一种都是"这不是一张 NTFS 引导扇区"或"几何荒谬"，
/// 不是"解析失败" —— 调用方据此走 NotNtfs / 回退 walk，而不是继续往下算。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootError {
    /// 签名/OEM 不是 NTFS（含 FAT/exFAT 与 BitLocker 未解锁卷的密文头）
    NotNtfs,
    /// 签名像 NTFS 但几何字段过不了闸。字符串点名是哪个字段 —— 对账时一眼定位。
    BadGeometry(&'static str),
}

/// 解析 `$Boot`。`sector` 必须是**第 0 个扇区**（至少 512 字节；更长的缓冲只看前 512 布局
/// —— 引导扇区的 BPB 恒在扇区头 512 字节里，4Kn 卷也一样）。
pub fn parse_boot_sector(sector: &[u8]) -> Result<BootGeometry, BootError> {
    if sector.len() < 512 {
        return Err(BootError::NotNtfs);
    }
    // 盘上字节是 0x55 0xAA，按小端读出来是 0xAA55 —— **别写反**（TS 版注释原话）。
    let sig = u16::from_le_bytes([sector[0x1FE], sector[0x1FF]]);
    if sig != 0xAA55 {
        return Err(BootError::NotNtfs);
    }
    // OEM 标识 "NTFS    "：第 8 字节是空格，故取 7（TS 版同款）。
    if &sector[0x03..0x0A] != b"NTFS   " {
        return Err(BootError::NotNtfs);
    }

    let bytes_per_sector = u16::from_le_bytes([sector[0x0B], sector[0x0C]]) as u32;
    let sectors_per_cluster = sector[0x0D] as u32;
    if bytes_per_sector < 512 || bytes_per_sector > 4096 || !bytes_per_sector.is_power_of_two() {
        return Err(BootError::BadGeometry("bytes-per-sector"));
    }
    if sectors_per_cluster == 0 || !sectors_per_cluster.is_power_of_two() {
        return Err(BootError::BadGeometry("sectors-per-cluster"));
    }

    let mft_lcn = u64::from_le_bytes(sector[0x30..0x38].try_into().unwrap());
    // 记录因子：**带符号**。正数 = 簇数；负数 = 2^|值| 字节（格式化默认走负数支，-10 ⇒ 1024）。
    // 符号取在最低字节（上方第二错）。负数支不提前设 |值| 上界 —— 2^20 = 1MB 这类
    // "移位本身合法、大小荒谬"的值交给下面 512..=65536 那道闸去拒（file-record-size）；
    // 移位 ≥ 32 时 checked_shl 回 None，同样按 file-record-size 拒。两头都不 panic。
    let rec_factor = sector[0x40] as i8;
    let bytes_per_file_record = if rec_factor < 0 {
        match 1u32.checked_shl((-rec_factor) as u32) {
            Some(v) => v,
            None => return Err(BootError::BadGeometry("file-record-size")),
        }
    } else {
        (rec_factor as u32)
            .checked_mul(sectors_per_cluster)
            .and_then(|v| v.checked_mul(bytes_per_sector))
            .ok_or(BootError::BadGeometry("file-record-factor"))?
    };
    if !(512..=65536).contains(&bytes_per_file_record) {
        return Err(BootError::BadGeometry("file-record-size"));
    }

    // 总扇区数也要过闸（TS 版两条教训各挡一种）：0 与"MFT 起点不在卷内"。
    let total_sectors = u64::from_le_bytes(sector[0x28..0x30].try_into().unwrap());
    if total_sectors == 0 {
        return Err(BootError::BadGeometry("total-sectors"));
    }
    let cluster_bytes = sectors_per_cluster as u64 * bytes_per_sector as u64;
    let mft_offset = mft_lcn * cluster_bytes;
    if mft_offset == 0 {
        return Err(BootError::BadGeometry("mft-lcn"));
    }
    if mft_offset >= total_sectors * bytes_per_sector as u64 {
        return Err(BootError::BadGeometry("mft-outside-volume"));
    }

    Ok(BootGeometry {
        bytes_per_sector,
        sectors_per_cluster,
        bytes_per_file_record,
        mft_lcn,
        total_sectors,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mft::testutil::boot_sector;

    /// 最小可解析扇区：512B 扇区 + 1 扇区簇 + 记录因子 -10 + MFT 在簇 8。
    fn minimal() -> Vec<u8> {
        boot_sector(512, 1, 1_000_000, 8, -10)
    }

    #[test]
    fn parses_a_minimal_sector() {
        let g = parse_boot_sector(&minimal()).expect("最小扇区必须能解析");
        assert_eq!(g.bytes_per_sector, 512);
        assert_eq!(g.sectors_per_cluster, 1);
        assert_eq!(g.bytes_per_file_record, 1024);
        assert_eq!(g.mft_lcn, 8);
        assert_eq!(g.mft_byte_offset(), 8 * 512);
        assert_eq!(g.volume_bytes(), 1_000_000 * 512);
        assert!(g.record_size_sane());
    }

    #[test]
    fn signature_reversed_is_rejected() {
        // 盘上字节写反成 0xAA 0x55 —— 小端读出 0x55AA ≠ 0xAA55，必须拒。
        let mut s = minimal();
        s[0x1FE] = 0xAA;
        s[0x1FF] = 0x55;
        assert_eq!(parse_boot_sector(&s), Err(BootError::NotNtfs));
    }

    #[test]
    fn oem_must_say_ntfs() {
        let mut s = minimal();
        s[0x03..0x0A].copy_from_slice(b"FAT32  ");
        assert_eq!(parse_boot_sector(&s), Err(BootError::NotNtfs));
    }

    #[test]
    fn short_buffer_is_not_ntfs() {
        assert_eq!(parse_boot_sector(&[0u8; 511]), Err(BootError::NotNtfs));
    }

    /// TS 第二错的镜像：记录因子宽 4 字节但符号只在最低字节。
    /// 真卷字节 `f6 00 00 00` 按 int32 读是 246，按 int8 读才是 -10。
    #[test]
    fn record_factor_reads_low_byte_only() {
        let mut s = minimal();
        // 故意把高 3 字节写成非零（模拟符号扩展编码），最低字节 -10 不变
        s[0x41] = 0xFF;
        s[0x42] = 0xFF;
        s[0x43] = 0xFF;
        let g = parse_boot_sector(&s).expect("f6 ff ff ff 仍要按 -10 解");
        assert_eq!(g.bytes_per_file_record, 1024);
    }

    #[test]
    fn record_factor_positive_means_clusters() {
        // 正数支：2 簇 × 2 扇区 × 512B = 2048 字节/记录
        let s = boot_sector(512, 2, 1_000_000, 8, 2);
        let g = parse_boot_sector(&s).expect("正数因子要能解析");
        assert_eq!(g.bytes_per_file_record, 2048);
        assert_eq!(g.cluster_bytes(), 1024);
    }

    /// TS 第一错的哨兵：总扇区数在 **0x28**，不是 0x20。0x20 在真卷上另有他用，
    /// 从 0x20 读会得出比卷容量还大的荒谬数。
    #[test]
    fn total_sectors_is_at_0x28() {
        let s = minimal();
        let at_28 = u64::from_le_bytes(s[0x28..0x30].try_into().unwrap());
        assert_eq!(at_28, 1_000_000, "0x28 处必须是写入的总扇区数");
        let g = parse_boot_sector(&s).unwrap();
        assert_eq!(g.total_sectors, 1_000_000);
    }

    #[test]
    fn zero_sectors_per_cluster_is_rejected() {
        let s = boot_sector(512, 0, 1_000_000, 8, -10);
        assert_eq!(
            parse_boot_sector(&s),
            Err(BootError::BadGeometry("sectors-per-cluster"))
        );
    }

    #[test]
    fn absurd_record_size_is_rejected() {
        // -20 ⇒ 2^20 = 1MB 记录，越过 65536 上界
        let s = boot_sector(512, 1, 1_000_000, 8, -20);
        assert_eq!(
            parse_boot_sector(&s),
            Err(BootError::BadGeometry("file-record-size"))
        );
    }

    #[test]
    fn mft_must_live_inside_the_volume() {
        // MFT 起始簇 2_000_000 × 512B = 1,024,000,000 > 总扇区 1,000,000 × 512B
        let s = boot_sector(512, 1, 1_000_000, 2_000_000, -10);
        assert_eq!(
            parse_boot_sector(&s),
            Err(BootError::BadGeometry("mft-outside-volume"))
        );
    }

    #[test]
    fn four_kb_sector_volume_parses() {
        // 4Kn 卷：4096B 扇区、1 扇区簇、记录因子 -10
        let s = boot_sector(4096, 1, 100_000, 4, -10);
        let g = parse_boot_sector(&s).expect("4Kn 几何要能解析");
        assert_eq!(g.bytes_per_sector, 4096);
        assert_eq!(g.cluster_bytes(), 4096);
        assert_eq!(g.bytes_per_file_record, 1024);
    }
}
