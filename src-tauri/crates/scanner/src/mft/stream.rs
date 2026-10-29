//! `$MFT` 顺序流 + 单条随机读 —— 盘区映射（[`ExtentMap`]）驱动的裸字节层。
//!
//! ## 职责边界
//!
//! 本层只管"把第 n 条记录的**原始字节**搬到调用方面前"：fixup 修正是解析层
//! （`record.rs`）的职责，流交出的字节**未过 fixup**（扇区尾还是 USN 原样）。
//! 树重建层（`tree.rs`）拿到后先 `apply_update_sequence` 再 `parse_record`。
//!
//! ## 两条读取路径
//!
//! · [`MftStream::next_raw`] —— 顺序扫全卷。1 MiB 块缓存：1024B 记录的卷上一块
//!   盖约 1024 条记录，块内命中零补读；`total_records` 开扫前已知（进度分母）。
//! · [`MftStream::read_record_at`] —— 随机读。扩展记录合并与 `$ATTRIBUTE_LIST`
//!   跟读用；**不动顺序游标**。快路径直接从顺序缓冲里拷（跟读的记录往往就在
//!   游标附近），慢路径按盘区逐段拼读 —— 一条记录可以横跨任意多段盘区。
//!
//! ## 大小口径
//!
//! `valid_bytes` 取记录 0 `$DATA` 的 **real size**（+0x30）—— 分配区（+0x28）里
//! valid 之后的字节是垃圾，读了也只会解析出损坏记录；`total_records = valid /
//! 记录大小`（整除，尾部凑不满一条的零头不可达）。**这是 TS 版 12% 惨案的另一半
//! 根治点**：盘区映射（`runs.rs`）负责"读对地方"，real-size 口径负责"不读垃圾"。

use super::boot::BootGeometry;
use super::rawvol::VolumeRead;
use super::record::{apply_update_sequence, parse_record, unnamed_data_runs};
use super::runs::{decode_runs, ExtentMap, RunError};

/// 单次补块的块长。1 MiB ≈ 1024 条记录（1024B 记录的卷）——
/// 大到让顺序扫描的补块次数可忽略，又小到不把 RSS 撑起来。
const CHUNK_BYTES: u64 = 1024 * 1024;

/// 流读取失败。每种变体都指名"下一步该做什么"：
/// `Io(5)` → 提权分流；`GeometryUnverified`/`NoMftData`/`BadRuns` → 几何不可信，
/// probe 回退 walk 档；`BeyondEnd` → 调用方算错了记录号（真卷上不应发生，报数）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamError {
    /// 底层读失败 —— Win32 错误码原样携带（38 = 卷尾短读，5 = 拒绝访问…）
    Io(u32),
    /// 记录 0 过不了 fixup / 解析 —— 引导扇区给出的几何对不上盘上事实
    GeometryUnverified,
    /// 记录 0 没有无名非驻留 `$DATA` —— 不是 NTFS 记录 0 该有的形状
    NoMftData,
    /// run list 解码失败（截断 / LCN 落负）
    BadRuns(RunError),
    /// 请求越过了 `$MFT` 的有效范围（盘区映射覆盖不到）
    BeyondEnd,
}

/// `$MFT` 流。泛型在 [`VolumeRead`] 上：真卷 [`super::rawvol::RawVolume`] 与
/// 测试镜像 `testutil::InMemoryVolume` 可以互换 —— 全部流逻辑在无管理员的
/// 机器上照测不误。
pub struct MftStream<V: VolumeRead> {
    vol: V,
    /// $MFT 自身的盘区映射（来自记录 0 的 run list —— TS 12% 惨案的根治点）
    map: ExtentMap,
    /// $MFT 有效字节数（real size 口径，分配区垃圾不计）
    valid_bytes: u64,
    record_size: u32,
    cluster_bytes: u64,
    /// 这段流的起始 VCN（$MFT 自身的 $DATA 恒 0；参数化以备扩展场景）
    first_vcn: u64,
    /// 顺序游标：下一条要交出的记录号
    next_number: u64,
    /// 顺序缓冲：`buf[i]` 是流内字节偏移 `buf_base + i`
    buf: Vec<u8>,
    buf_base: u64,
}

impl<V: VolumeRead> MftStream<V> {
    /// 从已解析的几何开流。步骤：读记录 0 → fixup → 解析 → 取无名非驻留 `$DATA`
    /// 的 run list → 建盘区映射 → 以 real size 定总记录数。
    ///
    /// 注意第一条记录是**直接按 `mft_byte_offset()` 线性读的** —— 此时还没有映射。
    /// 这是鸡生蛋的固有顺序，真 NTFS 卷上 $MFT 首盘区至少覆盖前 16 条元数据记录
    /// （MFT zone），不会在第一条记录中间断开。
    pub fn open(mut vol: V, geo: &BootGeometry) -> Result<Self, StreamError> {
        if !geo.record_size_sane() {
            return Err(StreamError::GeometryUnverified);
        }
        let record_size = geo.bytes_per_file_record;
        let mut buf = vec![0u8; record_size as usize];
        vol.read_exact_at(geo.mft_byte_offset(), &mut buf)
            .map_err(StreamError::Io)?;
        // 记录 0 过不了 fixup / 解析 = 几何对不上盘上事实。**不许拿没修正的
        // 缓冲继续**（record.rs 的立场），也不许猜另一种偏移再试 —— 回退是
        // 上层（probe）的事，这里只报可观察的失败。
        if !apply_update_sequence(&mut buf, geo.bytes_per_sector) {
            return Err(StreamError::GeometryUnverified);
        }
        let rec = parse_record(&buf, 0).ok_or(StreamError::GeometryUnverified)?;
        let (start_vcn, run_bytes) = unnamed_data_runs(&buf).ok_or(StreamError::NoMftData)?;
        let (runs, _used) = decode_runs(run_bytes).map_err(StreamError::BadRuns)?;
        let map = ExtentMap::build(&runs, geo.cluster_bytes(), start_vcn)
            .map_err(StreamError::BadRuns)?;
        // real size（+0x30），不是 allocated（+0x28）—— 分配区尾巴是垃圾。
        let valid_bytes = rec.data_size.ok_or(StreamError::NoMftData)?;
        // 交叉印证：$MFT 是卷上的一个文件，real size 不会比卷还大。越界说明
        // 前面的偏移有一处读错了 —— 按几何不可信拒，绝不带着坏映射往下跑。
        if valid_bytes > geo.volume_bytes() {
            return Err(StreamError::GeometryUnverified);
        }
        Ok(MftStream {
            vol,
            map,
            valid_bytes,
            record_size,
            cluster_bytes: geo.cluster_bytes(),
            first_vcn: start_vcn,
            next_number: 0,
            buf: Vec::new(),
            buf_base: 0,
        })
    }

    /// 记录总数（进度分母）。real size ÷ 记录大小，整除 —— 尾部凑不满一条的零头
    /// 不是记录，不可达。
    pub fn total_records(&self) -> u64 {
        self.valid_bytes / self.record_size as u64
    }

    /// $MFT 有效字节数。与 `fsutil fsinfo ntfsinfo` 的 `Mft Valid Data Length` 同源
    /// （真机对账项）。
    pub fn valid_bytes(&self) -> u64 {
        self.valid_bytes
    }

    pub fn record_size(&self) -> u32 {
        self.record_size
    }

    /// 顺序读下一条记录的**原始字节**（未过 fixup）。返回记录号；
    /// `Ok(None)` = 已读完。`out` 必须正好一条记录的长度。
    pub fn next_raw(&mut self, out: &mut [u8]) -> Result<Option<u64>, StreamError> {
        assert_eq!(
            out.len(),
            self.record_size as usize,
            "顺序读缓冲必须正好一条记录的长度",
        );
        let n = self.next_number;
        if n >= self.total_records() {
            return Ok(None);
        }
        let sp = n * self.record_size as u64;
        self.ensure(sp, out.len())?;
        let at = (sp - self.buf_base) as usize;
        out.copy_from_slice(&self.buf[at..at + self.record_size as usize]);
        // 只在成功交出后才推进游标 —— 失败的读不留半步。
        self.next_number = n + 1;
        Ok(Some(n))
    }

    /// 随机读第 `number` 条记录的原始字节。**不动顺序游标**。
    /// 越过 [`total_records`](Self::total_records) → `Err(BeyondEnd)`。
    pub fn read_record_at(&mut self, number: u64, out: &mut [u8]) -> Result<(), StreamError> {
        assert_eq!(
            out.len(),
            self.record_size as usize,
            "随机读缓冲必须正好一条记录的长度",
        );
        if number >= self.total_records() {
            return Err(StreamError::BeyondEnd);
        }
        let sp = number * self.record_size as u64;
        // 快路径：整条都在顺序缓冲里 —— 直接拷，缓存与游标一概不动。
        // （$ATTRIBUTE_LIST 跟读的记录常在游标附近，快路径是常态。）
        let end = sp + self.record_size as u64;
        if sp >= self.buf_base && end <= self.buf_base + self.buf.len() as u64 {
            let at = (sp - self.buf_base) as usize;
            out.copy_from_slice(&self.buf[at..at + self.record_size as usize]);
            return Ok(());
        }
        // 慢路径：按盘区逐段拼读 —— 一条记录可横跨任意多段盘区（$MFT 碎片的常态）。
        let mut done = 0usize;
        while done < out.len() {
            let pos = sp + done as u64;
            let vcn = self.first_vcn + pos / self.cluster_bytes;
            let (base, avail) = self.map.offset_of_vcn(vcn).ok_or(StreamError::BeyondEnd)?;
            let within = pos % self.cluster_bytes;
            // 这一盘区从当前字节起还剩 avail - within 字节；need 取剩下的缺口
            let take = (avail - within).min((out.len() - done) as u64) as usize;
            self.vol
                .read_exact_at(base + within, &mut out[done..done + take])
                .map_err(StreamError::Io)?;
            done += take;
        }
        Ok(())
    }

    /// 保证顺序缓冲覆盖流内字节 `[sp, sp + need)`。
    ///
    /// 三种情形：已覆盖 → 直接返回（顺序扫描的常态，零开销）；完全倒退或完全
    /// 越过 → 整块作废重读；从缓冲中部起、尾部越界 → 丢掉已消费前缀再补块。
    /// **刻意不在每次消费后 drain**：顺序扫描时整块缓冲是"一次补齐、逐条消费"，
    /// 每条记录都 memmove 一轮就是给 1 MiB 块加 512 倍的搬运开销。
    fn ensure(&mut self, sp: u64, need: usize) -> Result<(), StreamError> {
        let end = sp.checked_add(need as u64).ok_or(StreamError::BeyondEnd)?;
        let buf_end = self.buf_base + self.buf.len() as u64;
        if sp >= self.buf_base && end <= buf_end {
            return Ok(());
        }
        if sp < self.buf_base || sp >= buf_end {
            // 倒退（随机读把游标甩在了后面）或完全越过：作废重读
            self.buf.clear();
            self.buf_base = sp;
        } else {
            // 从缓冲中部开始、尾部越界：丢掉已消费前缀再补
            self.buf.drain(..(sp - self.buf_base) as usize);
            self.buf_base = sp;
        }
        while self.buf.len() < need {
            self.append_chunk(self.buf_base + self.buf.len() as u64)?;
        }
        Ok(())
    }

    /// 从流内字节偏移 `stream_pos` 起补一块（≤ [`CHUNK_BYTES`]，且不越过当前盘区尾）。
    fn append_chunk(&mut self, stream_pos: u64) -> Result<(), StreamError> {
        let vcn = self.first_vcn + stream_pos / self.cluster_bytes;
        let (base, avail) = self.map.offset_of_vcn(vcn).ok_or(StreamError::BeyondEnd)?;
        let within = stream_pos % self.cluster_bytes;
        // avail 是从该 VCN 到盘区尾的字节数（簇的整数倍 ≥ 1 簇），within < 1 簇
        // ⇒ extent_left 恒 > 0。take == 0 的防御分支挡的是 offset_of_vcn 语义
        // 漂移 —— 那种错宁可报错也不许在这里死循环。
        let extent_left = avail - within;
        let take = extent_left.min(CHUNK_BYTES);
        if take == 0 {
            return Err(StreamError::BeyondEnd);
        }
        let start = self.buf.len();
        self.buf.resize(start + take as usize, 0);
        self.vol
            .read_exact_at(base + within, &mut self.buf[start..])
            .map_err(StreamError::Io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mft::record::{apply_update_sequence, parse_record, NS_WIN32_AND_DOS, ATTR_DATA};
    use crate::mft::testutil::{
        file_name_attr, file_record, resident_attr, standard_info_attr, volume_fixture, RunSpec,
        RecordSpec, VolumeFixture,
    };

    const SECTOR: u32 = 512;
    const RECORD_BYTES: usize = 1024;

    /// 一条最简用户记录：SI + $FILE_NAME("f{i}.txt") + 驻留数据。
    fn user_record(i: usize) -> Vec<u8> {
        file_record(&RecordSpec {
            sequence: (i as u16) + 1,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                file_name_attr(5, 11, 4096, 0, &format!("f{i}.txt"), NS_WIN32_AND_DOS),
                resident_attr(ATTR_DATA, b"hello world"),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        })
    }

    fn simple_fixture(n_user: usize, runs: &[RunSpec]) -> VolumeFixture {
        let records: Vec<Vec<u8>> = (0..n_user).map(user_record).collect();
        volume_fixture(runs, &records)
    }

    /// 交出的原始字节 → fixup → 解析。流只负责搬字节，解析是调用方的活 ——
    /// 测试里把这条链走全，跟 tree.rs 的消费方式一致。
    fn parse_fresh(raw: &[u8], number: u64) -> crate::mft::record::MftRecord {
        let mut buf = raw.to_vec();
        assert!(apply_update_sequence(&mut buf, SECTOR), "夹具记录必须过 fixup");
        parse_record(&buf, number).expect("夹具记录必须能解析")
    }

    /// 顺序流：5 条记录（记录 0 自动 + 4 条用户）按号交出，记录 0 的
    /// `data_size` 是 real-size 口径（5 × 1024，全部记录字节）。
    #[test]
    fn sequential_stream_reads_records_in_order() {
        let f = simple_fixture(4, &[RunSpec::Data { delta: 8, clusters: 10 }]);
        let mut st = MftStream::open(f.volume, &f.geo).expect("夹具卷必须能开流");
        assert_eq!(st.total_records(), 5);
        assert_eq!(st.valid_bytes(), 5 * 1024, "real-size 口径，不是分配口径");
        let mut buf = vec![0u8; RECORD_BYTES];
        for n in 0..5u64 {
            assert_eq!(st.next_raw(&mut buf).expect("顺序读不许失败"), Some(n));
            let rec = parse_fresh(&buf, n);
            if n == 0 {
                assert_eq!(rec.data_size, Some(5 * 1024), "记录 0 的 real size = 全部记录字节");
            } else {
                assert_eq!(rec.names[0].name, format!("f{}.txt", n - 1));
            }
        }
    }

    /// 碎片 $MFT：三段盘区 LCN 8(2 簇) → 12(3 簇) → 112(5 簇)，记录 2 起横跨
    /// 盘区边界。TS 版按"起始簇 × 簇 + n × 记录大小"线性推偏移，从记录 2 开始
    /// 读到的全是别处的数据（真机 12% 惨案的形态）—— 这里顺序读与随机读都
    /// 必须逐条对得上名字。
    #[test]
    fn fragmented_mft_is_read_via_extent_map() {
        let f = simple_fixture(
            4,
            &[
                RunSpec::Data { delta: 8, clusters: 2 },
                RunSpec::Data { delta: 4, clusters: 3 },
                RunSpec::Data { delta: 100, clusters: 5 },
            ],
        );
        let mut st = MftStream::open(f.volume, &f.geo).expect("碎片 $MFT 必须能开流");
        let mut buf = vec![0u8; RECORD_BYTES];
        for n in 0..5u64 {
            assert_eq!(st.next_raw(&mut buf).expect("顺序读不许失败"), Some(n));
            if n > 0 {
                let rec = parse_fresh(&buf, n);
                assert_eq!(rec.names[0].name, format!("f{}.txt", n - 1), "跨盘区记录不许读串");
            }
        }
        for n in 0..5u64 {
            st.read_record_at(n, &mut buf).expect("随机读不许失败");
            if n > 0 {
                let rec = parse_fresh(&buf, n);
                assert_eq!(rec.names[0].name, format!("f{}.txt", n - 1));
            }
        }
    }

    /// 随机读不许动顺序游标：吃一条 → 随机跳两条 → 顺序必须从 1 继续；
    /// 同一条记录两种读法的原始字节必须逐位一致（都是未过 fixup 的盘上原样）。
    #[test]
    fn random_reads_do_not_disturb_the_sequential_cursor() {
        let f = simple_fixture(
            4,
            &[
                RunSpec::Data { delta: 8, clusters: 2 },
                RunSpec::Data { delta: 4, clusters: 3 },
                RunSpec::Data { delta: 100, clusters: 5 },
            ],
        );
        let mut st = MftStream::open(f.volume, &f.geo).unwrap();
        let mut seq_buf = vec![0u8; RECORD_BYTES];
        let mut rnd_buf = vec![0u8; RECORD_BYTES];
        assert_eq!(st.next_raw(&mut seq_buf).unwrap(), Some(0));
        st.read_record_at(4, &mut rnd_buf).unwrap();
        st.read_record_at(1, &mut rnd_buf).unwrap();
        assert_eq!(st.next_raw(&mut seq_buf).unwrap(), Some(1), "随机读后顺序游标从 1 继续");
        st.read_record_at(1, &mut rnd_buf).unwrap();
        assert_eq!(seq_buf, rnd_buf, "随机读与顺序读的原始字节必须逐位一致");
    }

    /// 破坏记录 0 第一扇区尾的 USN → fixup 试+验两种约定都必须对不上 → 拒开。
    /// **绝不许拿着没修正的记录继续** —— 那是 TS 版"读错位置还照跑"的失败形态。
    #[test]
    fn corrupted_record0_usn_fails_open() {
        let mut f = simple_fixture(2, &[RunSpec::Data { delta: 8, clusters: 6 }]);
        let t = (f.record0_offset + 0x1FE) as usize;
        f.volume.image[t] ^= 0xFF;
        assert!(
            matches!(MftStream::open(f.volume, &f.geo), Err(StreamError::GeometryUnverified)),
            "扇区尾 USN 对不上必须拒开",
        );
    }

    /// 越过记录总数的随机读 = BeyondEnd，不许 panic、不许回 0 偏移去读。
    #[test]
    fn random_read_past_the_end_is_beyond_end() {
        let f = simple_fixture(2, &[RunSpec::Data { delta: 8, clusters: 6 }]);
        let mut st = MftStream::open(f.volume, &f.geo).unwrap();
        assert_eq!(st.total_records(), 3);
        let mut buf = vec![0u8; RECORD_BYTES];
        assert_eq!(st.read_record_at(3, &mut buf), Err(StreamError::BeyondEnd));
        assert_eq!(st.read_record_at(999, &mut buf), Err(StreamError::BeyondEnd));
    }

    /// 读到底 → None，再读仍 None。**total_records 用 real-size 口径**：
    /// 夹具故意多给盘区（16 簇分配 vs 2 条记录），多出来的分配区不许变成记录。
    #[test]
    fn exhausted_stream_returns_none() {
        let f = simple_fixture(1, &[RunSpec::Data { delta: 8, clusters: 16 }]);
        let mut st = MftStream::open(f.volume, &f.geo).unwrap();
        assert_eq!(st.total_records(), 2, "总数按 real size，不按分配区");
        let mut buf = vec![0u8; RECORD_BYTES];
        assert_eq!(st.next_raw(&mut buf).unwrap(), Some(0));
        assert_eq!(st.next_raw(&mut buf).unwrap(), Some(1));
        assert_eq!(st.next_raw(&mut buf).unwrap(), None, "读完必须回 None");
        assert_eq!(st.next_raw(&mut buf).unwrap(), None, "再多读仍 None，不许 panic");
    }

    /// 卷在记录 0 中途截断 → 底层 EOF（38）按 `Io` 原样上抛，不许短读半条。
    #[test]
    fn truncated_volume_maps_to_io_error() {
        let mut f = simple_fixture(1, &[RunSpec::Data { delta: 8, clusters: 4 }]);
        let cut = f.record0_offset as usize + 512; // 记录 0 只剩前一半
        f.volume.image.truncate(cut);
        assert!(
            matches!(MftStream::open(f.volume, &f.geo), Err(StreamError::Io(38))),
            "卷尾短读按 Io(EOF) 上抛",
        );
    }
}
