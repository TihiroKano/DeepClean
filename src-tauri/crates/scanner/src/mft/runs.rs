//! NTFS data-run 变长解码 + 盘区映射（VCN → 卷内字节偏移）—— **纯函数，零 unsafe**。
//!
//! ## 这是 TS 版 12% 惨案的根治点
//!
//! TS 参考实现（`core/ntfs/volume.ts`）按 `$MFT 起始簇 × 簇大小 + 记录号 × 记录大小`
//! 线性推每条记录的偏移，**隐含「$MFT 在盘上连续」的假设**。真机 C: 的 $MFT 是碎的：
//! `docs/benchmarks/results.md` §10.4 记录了只读到 12% 就开始读到别处的数据、
//! 全部当损坏记录扔掉的实况。NTFS 对大元数据流一样会碎片化 —— $MFT 动辄几百 MB，
//! 卷用久了必然散开。根治法只有一条：**解析记录 0 非驻留 `$DATA` 的 run list**，
//! 拿到 $MFT 自身的盘区映射，按映射读。
//!
//! ## run list 的编码（微软 `DATA_RUN` 约定）
//!
//! 每段一个 header 字节：低 4 位 = 长度字段的字节数（无符号），高 4 位 = 偏移字段的字节数
//! （**有符号**，是相对前一段 LCN 的增量 —— 所以段与段不能乱序消费）。header == 0 结束。
//! 偏移字段字节数为 0 = 稀疏段（没有 LCN，读了得零）。

/// 一段盘区。`lcn: None` = 稀疏段（$MFT 实际不会稀疏，但解码器必须能表示它才完备）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Run {
    pub lcn: Option<u64>,
    pub clusters: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunError {
    /// 缓冲不够 / 没有终止符
    Truncated,
    /// 增量累加溢出或落成负 LCN
    Overflow,
}

/// 解码一段 run list。返回（盘区序列，消费的字节数——含结尾终止符）。
///
/// 三个硬规则：① 长度/偏移字段字节数不许超过 8，也不许越过缓冲；
/// ② 偏移按**有符号**增量累加，落成负数就是输入荒谬，Err 而不是猜；
/// ③ 缓冲耗尽还没见到终止符 → `Truncated`（属性值里 run list 的长度恰好覆盖到终止符，
/// 所以"没终止符"意味着调用方切错了切片，宁可不收）。
pub fn decode_runs(buf: &[u8]) -> Result<(Vec<Run>, usize), RunError> {
    let mut out: Vec<Run> = Vec::new();
    let mut prev_lcn: i64 = 0;
    let mut i = 0usize;
    loop {
        if i >= buf.len() {
            return Err(RunError::Truncated);
        }
        let header = buf[i];
        if header == 0 {
            return Ok((out, i + 1));
        }
        let len_bytes = (header & 0x0F) as usize;
        let off_bytes = (header >> 4) as usize;
        if len_bytes == 0 || len_bytes > 8 || off_bytes > 8 {
            return Err(RunError::Truncated);
        }
        if i + 1 + len_bytes + off_bytes > buf.len() {
            return Err(RunError::Truncated);
        }
        // 长度字段：无符号小端
        let mut clusters: u64 = 0;
        for b in 0..len_bytes {
            clusters |= (buf[i + 1 + b] as u64) << (8 * b);
        }
        // 偏移字段：有符号小端，相对前一段的增量（先符号扩展再相加）
        let lcn = if off_bytes == 0 {
            None
        } else {
            let mut raw: u64 = 0;
            for b in 0..off_bytes {
                raw |= (buf[i + 1 + len_bytes + b] as u64) << (8 * b);
            }
            let shift = 64 - 8 * off_bytes as u32;
            let delta = ((raw << shift) as i64) >> shift;
            prev_lcn = prev_lcn
                .checked_add(delta)
                .ok_or(RunError::Overflow)?;
            if prev_lcn < 0 {
                return Err(RunError::Overflow);
            }
            Some(prev_lcn as u64)
        };
        i += 1 + len_bytes + off_bytes;
        out.push(Run { lcn, clusters });
    }
}

/// VCN → 卷内字节偏移的映射表。$MFT 只有一段非驻留 `$DATA`，一次建全量映射。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtentMap {
    runs: Vec<Run>,
    cluster_bytes: u64,
    first_vcn: u64,
}

impl ExtentMap {
    /// `first_vcn` 是这段流覆盖的起始 VCN（$MFT 自身的 $DATA 恒为 0；
    /// 扩展记录里的碎片段从别的 VCN 起，那时传对应的起始 VCN）。
    pub fn build(runs: &[Run], cluster_bytes: u64, first_vcn: u64) -> Result<Self, RunError> {
        if cluster_bytes == 0 {
            return Err(RunError::Overflow);
        }
        if runs.is_empty() {
            return Err(RunError::Truncated);
        }
        Ok(ExtentMap { runs: runs.to_vec(), cluster_bytes, first_vcn })
    }

    pub fn total_clusters(&self) -> u64 {
        self.runs.iter().map(|r| r.clusters).sum()
    }

    pub fn total_bytes(&self) -> u64 {
        self.total_clusters() * self.cluster_bytes
    }

    pub fn first_vcn(&self) -> u64 {
        self.first_vcn
    }

    /// 定位原语：该 VCN 落在哪一段盘区 →（卷内字节偏移，这一段内从该 VCN 起还有多少连续字节）。
    /// 越界（超出映射覆盖的 VCN 范围）或落在稀疏段 → `None`，调用方按可观察的失败报数，
    /// **不许拿 0 偏移去读** —— 那会把别的数据当记录解析，正是 TS 惨案里"12% 之后全是垃圾"的形态。
    pub fn offset_of_vcn(&self, vcn: u64) -> Option<(u64, u64)> {
        let rel = vcn.checked_sub(self.first_vcn)?;
        let mut acc: u64 = 0;
        for r in &self.runs {
            if rel < acc.checked_add(r.clusters)? {
                let lcn = r.lcn?;
                let within = rel - acc;
                let off = lcn * self.cluster_bytes + within * self.cluster_bytes;
                let avail = (r.clusters - within) * self.cluster_bytes;
                return Some((off, avail));
            }
            acc += r.clusters;
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 单段：delta=+8、8 簇。长度 1 字节、偏移 1 字节 → header = (1<<4)|1 = 0x11。
    #[test]
    fn decodes_a_single_run() {
        let buf = [0x11, 0x08, 0x08, 0x00];
        let (runs, used) = decode_runs(&buf).expect("单段要能解");
        assert_eq!(used, 4, "消费到终止符（含）");
        assert_eq!(runs, vec![Run { lcn: Some(8), clusters: 8 }]);
    }

    /// 多段：偏移是**相对增量**。+8、-4 ⇒ LCN 8、4 —— 乱序消费就是错的，这条钉住累加语义。
    #[test]
    fn offsets_are_relative_increments() {
        let buf = [0x11, 0x08, 0x08, 0x11, 0x04, 0xFC, 0x00];
        // 第二段偏移字节 0xFC = -4（1 字节有符号）
        let (runs, _) = decode_runs(&buf).expect("多段要能解");
        assert_eq!(
            runs,
            vec![
                Run { lcn: Some(8), clusters: 8 },
                Run { lcn: Some(4), clusters: 4 }
            ]
        );
    }

    /// 稀疏段：偏移字节数 0（header 高 4 位为 0）。$MFT 实际不会稀疏，但解码器必须能表示。
    #[test]
    fn sparse_runs_have_no_lcn() {
        // 0x01 = 长度字段 1 字节、偏移字段 0 字节（稀疏）
        let buf = [0x01, 0x10, 0x11, 0x08, 0x0C, 0x00];
        let (runs, _) = decode_runs(&buf).expect("含稀疏段要能解");
        assert_eq!(
            runs,
            vec![
                Run { lcn: None, clusters: 16 },
                Run { lcn: Some(12), clusters: 8 }
            ]
        );
    }

    #[test]
    fn truncated_input_is_err() {
        // 没有终止符
        assert_eq!(decode_runs(&[0x11, 0x08, 0x08]), Err(RunError::Truncated));
        // header 声称的长度越过缓冲
        assert_eq!(decode_runs(&[0x11, 0x08]), Err(RunError::Truncated));
        // 缓冲为空
        assert_eq!(decode_runs(&[]), Err(RunError::Truncated));
    }

    #[test]
    fn absurd_header_fields_are_err() {
        // 长度字段 0 字节（header 低 4 位为 0 且非 0 终止符）
        assert_eq!(decode_runs(&[0x10, 0x00]), Err(RunError::Truncated));
        // 偏移字段 9 字节（> 8）
        assert_eq!(decode_runs(&[0x91, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0x00]), Err(RunError::Truncated));
    }

    /// 负增量把 LCN 拉成负数 = 输入荒谬，Err 而不是回绕。
    #[test]
    fn negative_lcn_is_err() {
        let buf = [0x11, 0x08, 0x02, 0x11, 0x08, 0xF8, 0x00]; // 第二段 delta = -8
        assert_eq!(decode_runs(&buf), Err(RunError::Overflow));
    }

    fn two_run_map() -> ExtentMap {
        // 簇 512B：[VCN 0..8) @ LCN 8、[VCN 8..16) @ LCN 4
        let runs = vec![
            Run { lcn: Some(8), clusters: 8 },
            Run { lcn: Some(4), clusters: 8 },
        ];
        ExtentMap::build(&runs, 512, 0).unwrap()
    }

    #[test]
    fn offset_within_the_first_run() {
        let m = two_run_map();
        assert_eq!(m.offset_of_vcn(0), Some((8 * 512, 8 * 512)));
        assert_eq!(m.offset_of_vcn(3), Some(((8 + 3) * 512, 5 * 512)));
    }

    /// 跨段：VCN 10 在第二段里 —— 卷内偏移要拼上第二段的 LCN。
    /// 这一条就是 $MFT 碎片场景的定位语义，线性推偏移在这里会算到第一段之外去。
    #[test]
    fn offset_across_runs_splices_correctly() {
        let m = two_run_map();
        assert_eq!(m.offset_of_vcn(8), Some((4 * 512, 8 * 512)));
        assert_eq!(m.offset_of_vcn(10), Some((6 * 512, 6 * 512)));
        // 末尾越界
        assert_eq!(m.offset_of_vcn(16), None);
        assert_eq!(m.offset_of_vcn(999), None);
    }

    #[test]
    fn first_vcn_offsets_are_relative() {
        // 扩展记录场景：这段流从 VCN 16 起
        let runs = vec![Run { lcn: Some(100), clusters: 4 }];
        let m = ExtentMap::build(&runs, 512, 16).unwrap();
        assert_eq!(m.offset_of_vcn(16), Some((100 * 512, 4 * 512)));
        assert_eq!(m.offset_of_vcn(15), None, "first_vcn 之前的 VCN 不归这段管");
        assert_eq!(m.total_bytes(), 4 * 512);
    }

    #[test]
    fn sparse_hole_returns_none_not_zero() {
        // [VCN 0..4) 稀疏、[VCN 4..8) @ LCN 9
        let runs = vec![
            Run { lcn: None, clusters: 4 },
            Run { lcn: Some(9), clusters: 4 },
        ];
        let m = ExtentMap::build(&runs, 512, 0).unwrap();
        assert_eq!(m.offset_of_vcn(0), None, "稀疏段回 None，绝不回 0 偏移");
        assert_eq!(m.offset_of_vcn(4), Some((9 * 512, 4 * 512)));
    }
}
