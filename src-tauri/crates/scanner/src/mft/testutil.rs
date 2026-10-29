//! 合成镜像编码器 —— 仅 `cfg(test)`，与解析器**互为镜像**的另一侧。
//!
//! 立场从 TS 版原样搬来：无管理员的机器上一条真记录都拿不到，能测的只有手搓字节。
//! 这里按微软公开的盘上布局**正向编码**，`boot.rs`/`runs.rs`/`record.rs` 反向解码
//! —— 任何一侧偏移漂移，测试当场红。编码器不参考解析器的内部实现，只按公开布局写，
//! 镜像才有意义。MS2 的 `stream.rs` 会经由 [`InMemoryVolume`] 消费整套夹具。

use super::boot::BootGeometry;
use super::rawvol::VolumeRead;
use super::record::{
    ATTR_ATTRIBUTE_LIST, ATTR_DATA, ATTR_FILE_NAME, ATTR_INDEX_ROOT, ATTR_REPARSE_POINT,
    ATTR_STANDARD_INFO, REC_FLAG_IN_USE,
};
use super::runs::{decode_runs, ExtentMap};

/// 夹具统一用的 update sequence number。真卷 USN 不会是 0；0 在解析层被当作
/// "两种 fixup 约定都不成立"，所以夹具绝不能用 0。
pub const TEST_USN: u16 = 0xAAAA;

/// ERROR_HANDLE_EOF。InMemoryVolume 越界时回它 —— 与真卷"读过了卷尾"的语义一致。
const ERR_EOF: u32 = 38;

// ---------- 内存卷 ----------

/// 测试用内存卷：`image` 就是整卷字节。[`VolumeRead`] 的第一个实现者，
/// MS2 的 stream 测试经由它驱动"从卷字节到记录"的全链路。
pub struct InMemoryVolume {
    pub image: Vec<u8>,
    /// 扇区大小（字节）。MS2 的流式读取器按它对齐读；内存卷的读取本身按字节偏移。
    #[allow(dead_code)] // MS2 stream 接线前暂无读取者
    pub sector: u32,
}

impl VolumeRead for InMemoryVolume {
    fn read_exact_at(&mut self, offset: u64, buf: &mut [u8]) -> Result<(), u32> {
        let end = offset.checked_add(buf.len() as u64).ok_or(ERR_EOF)?;
        if end > self.image.len() as u64 {
            return Err(ERR_EOF);
        }
        let start = offset as usize;
        buf.copy_from_slice(&self.image[start..start + buf.len()]);
        Ok(())
    }
}

// ---------- 基础编码 ----------

/// 8 字节对齐（NTFS 属性长度必须 8 对齐，真卷如此，夹具照做）。
fn align8(n: usize) -> usize {
    (n + 7) & !7
}

fn push_le(out: &mut Vec<u8>, v: u64, bytes: usize) {
    out.extend_from_slice(&v.to_le_bytes()[..bytes]);
}

/// 最小无符号字节数（≥1）。
fn unsigned_width(v: u64) -> usize {
    (1..=8).find(|&n| (1u64 << (8 * n)) > v).unwrap_or(8)
}

/// 最小有符号字节数（≥1，两补码可表示）。
fn signed_width(d: i64) -> usize {
    (1..=8)
        .find(|&n| {
            let lim = 1i64 << (8 * n - 1);
            d >= -lim && d < lim
        })
        .unwrap_or(8)
}

// ---------- 引导扇区 ----------

/// 编码一张 NTFS 引导扇区。参数与 [`super::boot::BootGeometry`] 字段一一对应。
pub fn boot_sector(
    bytes_per_sector: u32,
    sectors_per_cluster: u32,
    total_sectors: u64,
    mft_lcn: u64,
    record_factor: i8,
) -> Vec<u8> {
    let mut s = vec![0u8; 512];
    s[0x03..0x0B].copy_from_slice(b"NTFS    "); // OEM 8 字节（解析只看前 7）
    s[0x0B..0x0D].copy_from_slice(&(bytes_per_sector as u16).to_le_bytes());
    s[0x0D] = sectors_per_cluster as u8;
    s[0x28..0x30].copy_from_slice(&total_sectors.to_le_bytes());
    s[0x30..0x38].copy_from_slice(&mft_lcn.to_le_bytes());
    // 记录因子：宽 4 字节但符号只写在最低字节（零扩展 signed char）—— 真卷字节
    // `f6 00 00 00` 按 int8 读才是 -10。夹具照零扩展编码，高 3 字节保持 0。
    s[0x40] = record_factor as u8;
    s[0x1FE..0x200].copy_from_slice(&[0x55, 0xAA]); // 小端读出 0xAA55
    s
}

// ---------- run list ----------

pub enum RunSpec {
    Data { delta: i64, clusters: u64 },
    Sparse { clusters: u64 },
}

/// 编码一段 run list（含终止符）。与 [`super::runs::decode_runs`] 互为镜像。
pub fn run_list(specs: &[RunSpec]) -> Vec<u8> {
    let mut out = Vec::new();
    for spec in specs {
        match spec {
            RunSpec::Sparse { clusters } => {
                let lw = unsigned_width(*clusters);
                out.push(lw as u8); // 高 4 位 = 0：偏移字段 0 字节 = 稀疏
                push_le(&mut out, *clusters, lw);
            }
            RunSpec::Data { delta, clusters } => {
                let lw = unsigned_width(*clusters);
                let ow = signed_width(*delta);
                out.push(((ow << 4) | lw) as u8);
                push_le(&mut out, *clusters, lw);
                push_le(&mut out, *delta as u64, ow); // 两补码低 ow 字节（相对增量）
            }
        }
    }
    out.push(0x00); // 终止符
    out
}

// ---------- 驻留属性 ----------

/// 驻留属性通用编码。`name_bytes` 为空 = 无名（name_off 落 0，解析层对无名不查偏移）。
/// 驻留头本身固定占 0x18 字节（类型/长度/非驻留位/名长/名偏移/值长/值偏移），
/// 所以值偏移的下界是 0x18 —— 小属性的值也必须排在头之后，不许压进头里。
fn build_resident(attr_type: u32, name_bytes: &[u8], value: &[u8]) -> Vec<u8> {
    let name_off: usize = if name_bytes.is_empty() { 0 } else { 0x18 };
    let value_off = align8(name_off + name_bytes.len()).max(0x18);
    let alen = align8(value_off + value.len());
    let mut buf = vec![0u8; alen];
    buf[0x00..0x04].copy_from_slice(&attr_type.to_le_bytes());
    buf[0x04..0x08].copy_from_slice(&(alen as u32).to_le_bytes());
    buf[0x08] = 0; // 驻留
    buf[0x09] = (name_bytes.len() / 2) as u8;
    buf[0x0A..0x0C].copy_from_slice(&(name_off as u16).to_le_bytes());
    buf[0x10..0x14].copy_from_slice(&(value.len() as u32).to_le_bytes());
    buf[0x14..0x16].copy_from_slice(&(value_off as u16).to_le_bytes());
    buf[name_off..name_off + name_bytes.len()].copy_from_slice(name_bytes);
    buf[value_off..value_off + value.len()].copy_from_slice(value);
    buf
}

fn utf16_le(name: &str) -> Vec<u8> {
    name.encode_utf16().flat_map(|c| c.to_le_bytes()).collect()
}

pub fn resident_attr(attr_type: u32, value: &[u8]) -> Vec<u8> {
    build_resident(attr_type, &[], value)
}

pub fn named_resident_attr(attr_type: u32, name: &str, value: &[u8]) -> Vec<u8> {
    build_resident(attr_type, &utf16_le(name), value)
}

/// `$STANDARD_INFORMATION`：+0x00 创建 / +0x08 修改 / +0x20 属性位。值长 0x30。
/// 时间入参是 Unix 毫秒，编码时转回 FILETIME —— 与解析侧 `filetime_to_unix_ms`
/// 精确互逆（FILETIME 恒为 10_000 的整数倍，无舍入）。
pub fn standard_info_attr(created_ms: i64, mtime_ms: i64, attrs: u32) -> Vec<u8> {
    let mut v = vec![0u8; 0x30];
    v[0x00..0x08].copy_from_slice(&unix_ms_to_filetime(created_ms).to_le_bytes());
    v[0x08..0x10].copy_from_slice(&unix_ms_to_filetime(mtime_ms).to_le_bytes());
    v[0x20..0x24].copy_from_slice(&attrs.to_le_bytes());
    build_resident(ATTR_STANDARD_INFO, &[], &v)
}

fn unix_ms_to_filetime(ms: i64) -> u64 {
    const EPOCH_DIFF_MS: i64 = 11_644_473_600_000; // 1601 → 1970，与 enumerate.rs 同值
    ((ms + EPOCH_DIFF_MS) * 10_000) as u64
}

/// `$FILE_NAME`：值内偏移见 record.rs 速查表 —— +0x00 父引用 / +0x28 alloc /
/// +0x30 real / +0x38 flags / +0x40 名长 / +0x41 命名空间 / +0x42 名字。
pub fn file_name_attr(
    parent_ref: u64,
    real_size: u64,
    alloc_size: u64,
    flags: u32,
    name: &str,
    ns: u8,
) -> Vec<u8> {
    let name_u16: Vec<u16> = name.encode_utf16().collect();
    let mut v = vec![0u8; 0x42 + name_u16.len() * 2];
    v[0x00..0x08].copy_from_slice(&parent_ref.to_le_bytes());
    v[0x28..0x30].copy_from_slice(&alloc_size.to_le_bytes());
    v[0x30..0x38].copy_from_slice(&real_size.to_le_bytes());
    v[0x38..0x3C].copy_from_slice(&flags.to_le_bytes());
    v[0x40] = name_u16.len() as u8;
    v[0x41] = ns;
    for (i, c) in name_u16.iter().enumerate() {
        v[0x42 + i * 2..0x44 + i * 2].copy_from_slice(&c.to_le_bytes());
    }
    build_resident(ATTR_FILE_NAME, &[], &v)
}

/// `$INDEX_ROOT` 的最小在场形态 —— 解析层只判存在，不读内容。
pub fn index_root_attr() -> Vec<u8> {
    build_resident(ATTR_INDEX_ROOT, &[], &[0u8; 16])
}

/// `$REPARSE_POINT` 的最小在场形态 —— 解析层只判存在，不读内容。
pub fn reparse_attr() -> Vec<u8> {
    build_resident(ATTR_REPARSE_POINT, &[], &[0u8; 8])
}

/// `$ATTRIBUTE_LIST` 的一个条目（无名字的最简 24 字节形态）。
pub struct AttrListEntry {
    pub attr_type: u32,
    pub lower_vcn: u64,
    pub record_ref: u64,
}

pub fn attr_list_attr(entries: &[AttrListEntry]) -> Vec<u8> {
    let mut v = Vec::with_capacity(entries.len() * 24);
    for e in entries {
        let mut it = [0u8; 24];
        it[0x00..0x04].copy_from_slice(&e.attr_type.to_le_bytes());
        it[0x04..0x06].copy_from_slice(&24u16.to_le_bytes());
        it[0x08..0x10].copy_from_slice(&e.lower_vcn.to_le_bytes());
        it[0x10..0x18].copy_from_slice(&e.record_ref.to_le_bytes());
        v.extend_from_slice(&it);
    }
    build_resident(ATTR_ATTRIBUTE_LIST, &[], &v)
}

// ---------- 非驻留属性 ----------

pub struct NonResidentSpec {
    pub start_vcn: u64,
    pub last_vcn: u64,
    pub alloc: u64,
    pub real: u64,
    pub initialized: u64,
    /// 已编码的 run list（[`run_list`] 的产物，含终止符）。
    pub runs: Vec<u8>,
}

/// 无名非驻留 `$DATA` —— 文件主数据的形态。
pub fn nonresident_data(spec: &NonResidentSpec) -> Vec<u8> {
    build_nonresident(&[], spec)
}

/// 带名非驻留 `$DATA` —— 非驻留备用数据流（ADS）的形态。
pub fn named_nonresident_data(name: &str, spec: &NonResidentSpec) -> Vec<u8> {
    build_nonresident(&utf16_le(name), spec)
}

/// 非驻留属性通用编码。固定头 0x40 字节；名字（若有）在 +0x40，run list 在其后。
fn build_nonresident(name_bytes: &[u8], spec: &NonResidentSpec) -> Vec<u8> {
    let run_off = align8(0x40 + name_bytes.len());
    let alen = align8(run_off + spec.runs.len());
    let mut buf = vec![0u8; alen];
    buf[0x00..0x04].copy_from_slice(&ATTR_DATA.to_le_bytes());
    buf[0x04..0x08].copy_from_slice(&(alen as u32).to_le_bytes());
    buf[0x08] = 1; // 非驻留
    buf[0x09] = (name_bytes.len() / 2) as u8;
    buf[0x0A..0x0C].copy_from_slice(&0x40u16.to_le_bytes()); // 名字偏移恒 0x40（无名时没人读它）
    buf[0x10..0x18].copy_from_slice(&spec.start_vcn.to_le_bytes());
    buf[0x18..0x20].copy_from_slice(&spec.last_vcn.to_le_bytes());
    buf[0x20..0x22].copy_from_slice(&(run_off as u16).to_le_bytes());
    buf[0x28..0x30].copy_from_slice(&spec.alloc.to_le_bytes());
    buf[0x30..0x38].copy_from_slice(&spec.real.to_le_bytes());
    buf[0x38..0x40].copy_from_slice(&spec.initialized.to_le_bytes());
    buf[0x40..0x40 + name_bytes.len()].copy_from_slice(name_bytes);
    buf[run_off..run_off + spec.runs.len()].copy_from_slice(&spec.runs);
    buf
}

// ---------- 完整记录 ----------

pub struct RecordSpec {
    pub sequence: u16,
    pub flags: u16,
    pub base_ref: u64,
    /// true = B 派约定：USN 在记录头 +0x08，USA 全是扇区尾原值。
    /// false = A 派：USA[0] 是 USN，USA[1..] 是原值。
    pub usa_b: bool,
    pub attrs: Vec<Vec<u8>>,
    pub record_bytes: usize,
    pub sector: u32,
}

/// 编码一条完整的 MFT 记录，含 fixup：先把各扇区尾原值存进 USA，再写 USN 上去
/// —— 与真卷的写入方向一致，解析侧 [`super::record::apply_update_sequence`] 负责还原。
pub fn file_record(spec: &RecordSpec) -> Vec<u8> {
    let n = spec.record_bytes / spec.sector as usize; // 扇区尾个数
    let usa_words = if spec.usa_b { n } else { n + 1 };
    let usa_off: usize = 0x30;
    let first_attr = align8(usa_off + usa_words * 2);
    let mut buf = vec![0u8; spec.record_bytes];
    buf[0x00..0x04].copy_from_slice(b"FILE");
    buf[0x04..0x06].copy_from_slice(&(usa_off as u16).to_le_bytes());
    buf[0x06..0x08].copy_from_slice(&(usa_words as u16).to_le_bytes());
    if spec.usa_b {
        buf[0x08..0x0A].copy_from_slice(&TEST_USN.to_le_bytes());
    } else {
        buf[0x30..0x32].copy_from_slice(&TEST_USN.to_le_bytes()); // USA[0] = USN
    }
    buf[0x10..0x12].copy_from_slice(&spec.sequence.to_le_bytes());
    buf[0x14..0x16].copy_from_slice(&(first_attr as u16).to_le_bytes());
    buf[0x16..0x18].copy_from_slice(&spec.flags.to_le_bytes());
    buf[0x1C..0x20].copy_from_slice(&(spec.record_bytes as u32).to_le_bytes()); // alloc
    buf[0x20..0x28].copy_from_slice(&spec.base_ref.to_le_bytes());

    let mut at = first_attr;
    for a in &spec.attrs {
        assert!(at + a.len() <= spec.record_bytes, "夹具属性总长越过记录大小");
        buf[at..at + a.len()].copy_from_slice(a);
        at += a.len();
    }
    // 属性终止符（解析层遇 0 或 0xFFFFFFFF 停）
    if at + 8 <= spec.record_bytes {
        buf[at..at + 4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
    }

    for i in 0..n {
        let t = (i + 1) * spec.sector as usize - 2;
        let orig = u16::from_le_bytes([buf[t], buf[t + 1]]);
        let slot = if spec.usa_b { usa_off + i * 2 } else { usa_off + (i + 1) * 2 };
        buf[slot..slot + 2].copy_from_slice(&orig.to_le_bytes());
        buf[t..t + 2].copy_from_slice(&TEST_USN.to_le_bytes());
    }
    buf
}

// ---------- 整卷镜像夹具（MS2 stream / MS3 tree 端到端用） ----------

/// 一张合成小卷：记录 0 自动生成（指向整段 `$MFT` 的非驻留 `$DATA`），
/// `records` 依次成为记录 1..n，全部按盘区映射**逐段摆进镜像** —— 碎片 run 时
/// 一条记录会被拆到多段盘区，正是流读取器要测的形态。
pub struct VolumeFixture {
    pub volume: InMemoryVolume,
    pub geo: BootGeometry,
    /// 记录 0 的第一个字节落在镜像里的偏移（= `mft_byte_offset`）。
    pub record0_offset: u64,
}

/// `runs` 决定 $MFT 的盘区布局，`records` 是记录 1..n 的原始字节。
/// 统一几何：512B 扇区、1 扇区/簇（512B 簇）、1024B 记录 —— 与真机默认卷同构，
/// 且记录边界与簇边界对齐（碎片时记录整簇地跨盘区）。
pub fn volume_fixture(runs: &[RunSpec], records: &[Vec<u8>]) -> VolumeFixture {
    const SECTOR: u32 = 512;
    const CLUSTER_BYTES: u64 = 512;
    const RECORD_BYTES: usize = 1024;

    let total_records = records.len() as u64 + 1; // 记录 0 自动生成
    let run_bytes = run_list(runs);
    let (decoded, _) = decode_runs(&run_bytes).expect("夹具 run list 必须能解");
    let total_clusters: u64 = decoded.iter().map(|r| r.clusters).sum();
    assert!(
        total_clusters * CLUSTER_BYTES >= total_records * RECORD_BYTES as u64,
        "夹具盘区总簇数不足以放下全部记录",
    );
    let first_lcn = decoded.iter().find_map(|r| r.lcn).expect("夹具至少要有一段非稀疏盘区");
    let map = ExtentMap::build(&decoded, CLUSTER_BYTES, 0).expect("夹具盘区映射必须能建");

    // 记录 0：SI + 无名非驻留 $DATA。real = 全部记录字节（real-size 口径的镜像），
    // alloc = 全部盘区（允许比 real 大 —— 分配区尾巴是垃圾，流不许读它当记录）。
    let record0 = file_record(&RecordSpec {
        sequence: 1,
        flags: REC_FLAG_IN_USE,
        base_ref: 0,
        usa_b: false,
        attrs: vec![
            standard_info_attr(0, 0, 0),
            nonresident_data(&NonResidentSpec {
                start_vcn: 0,
                last_vcn: total_clusters - 1,
                alloc: total_clusters * CLUSTER_BYTES,
                real: total_records * RECORD_BYTES as u64,
                initialized: total_records * RECORD_BYTES as u64,
                runs: run_bytes,
            }),
        ],
        record_bytes: RECORD_BYTES,
        sector: SECTOR,
    });

    let mft_offset = first_lcn * CLUSTER_BYTES;
    // 镜像必须覆盖**最后一个盘区的终点** —— 碎片盘区的 LCN 不连续（如 8→12→112），
    // 按"首 LCN + $MFT 总字节"算会把后面的盘区切出镜像外。盘区之间的空隙照常留白
    // （真卷上是别人的数据，镜像里是零，流不该读到它们）。
    let last_end_lcn = decoded
        .iter()
        .map(|r| r.lcn.map_or(0, |l| l + r.clusters))
        .max()
        .unwrap_or(0);
    let image_len = last_end_lcn * CLUSTER_BYTES + CLUSTER_BYTES;
    let mut image = vec![0u8; image_len as usize];

    // 摆放：与 stream 慢路径同一套盘区算术（镜像才镜像得起来）。
    // 记录 0 打头，其后依次是用户记录，按流内偏移逐段写进镜像。
    let mut all: Vec<&[u8]> = vec![&record0];
    all.extend(records.iter().map(|r| r.as_slice()));
    for (i, rec) in all.iter().enumerate() {
        assert_eq!(rec.len(), RECORD_BYTES, "夹具记录必须正好一条记录大小");
        let sp = i as u64 * RECORD_BYTES as u64;
        let mut done = 0usize;
        while done < rec.len() {
            let pos = sp + done as u64;
            let vcn = pos / CLUSTER_BYTES;
            let (base, avail) = map.offset_of_vcn(vcn).expect("夹具盘区必须覆盖整条 $MFT");
            let within = pos % CLUSTER_BYTES;
            let take = ((avail - within) as usize).min(rec.len() - done);
            let off = (base + within) as usize;
            image[off..off + take].copy_from_slice(&rec[done..done + take]);
            done += take;
        }
    }

    VolumeFixture {
        volume: InMemoryVolume { image, sector: SECTOR },
        geo: BootGeometry {
            bytes_per_sector: SECTOR,
            sectors_per_cluster: 1,
            bytes_per_file_record: RECORD_BYTES as u32,
            mft_lcn: first_lcn,
            total_sectors: image_len / CLUSTER_BYTES,
        },
        record0_offset: mft_offset,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::runs::{decode_runs, Run};

    /// 镜像守护：自己编的 run list 必须能被 decode_runs 原样还原 ——
    /// 含稀疏段与负增量。这条红 = 编码器或解码器有一侧漂了。
    #[test]
    fn run_list_round_trips_through_decode_runs() {
        let specs = [
            RunSpec::Data { delta: 100, clusters: 10 },
            RunSpec::Sparse { clusters: 4 },
            RunSpec::Data { delta: -60, clusters: 8 },
        ];
        let buf = run_list(&specs);
        let (runs, used) = decode_runs(&buf).expect("自己编的 run list 必须能解");
        assert_eq!(used, buf.len(), "消费长度必须正好到终止符（含）");
        assert_eq!(
            runs,
            vec![
                Run { lcn: Some(100), clusters: 10 },
                Run { lcn: None, clusters: 4 },
                Run { lcn: Some(40), clusters: 8 },
            ]
        );
    }

    #[test]
    fn in_memory_volume_reads_and_bounds_checks() {
        let mut v = InMemoryVolume { image: vec![1, 2, 3, 4, 5], sector: 512 };
        let mut b = [0u8; 2];
        v.read_exact_at(2, &mut b).unwrap();
        assert_eq!(b, [3, 4]);
        assert_eq!(v.read_exact_at(4, &mut b), Err(ERR_EOF), "跨过镜像尾必须整读失败，不许短读");
        assert_eq!(v.read_exact_at(u64::MAX - 1, &mut b), Err(ERR_EOF), "偏移溢出也不许 panic");
    }
}
