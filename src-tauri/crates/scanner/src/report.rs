//! 对外报告 —— **这份就是规格书「定扫描器协议」要的那个 JSON 形状**。
//!
//! 两处口径必须一眼看得见，不许含糊：
//!  · `bytes_counted` 是**占用合计**（分配大小、硬链接只算一次），不是表观大小之和；
//!  · `unaccounted_bytes = 卷已用 − bytes_counted`，**带符号**存 `i64`。
//!    用无符号 + `saturating_sub` 会把"合计比整卷还大"这种事故悄悄抹成 0 —— 那正是
//!    「80G 扫出 90G」想要被看见的东西。

use crate::model::{ScanMode, ScanTree};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScanReport {
    pub root: String,
    pub volume_serial: u32,
    pub volume_label: String,
    pub volume_total_bytes: u64,
    pub volume_free_bytes: u64,
    pub volume_used_bytes: u64,

    pub files: u64,
    pub dirs: u64,
    /// 表观（逻辑）大小之和 —— 与旧实现同口径，留着做对照
    pub bytes_logical: u64,
    /// 分配大小之和（**未去重**，含每条硬链接）
    pub bytes_alloc: u64,
    /// 占用合计（**已去重**）—— 唯一可以与卷容量比较的字节数
    pub bytes_counted: u64,
    /// 卷已用 − bytes_counted。**负数意味着口径不可能成立**。
    pub unaccounted_bytes: i64,

    pub denied: u64,
    pub missing: u64,
    pub busy: u64,
    pub other_errors: u64,
    pub skipped_reparse: u64,
    pub skipped_always: u64,
    pub deduped_hardlinks: u64,
    pub depth_capped: u64,

    /// 本棵树由哪一档产出（"mft" / "walk"）—— 口径差异的解释权在 `mft/mod.rs` 头注。
    pub scan_mode: ScanMode,
    /// 记录 0-15 收进 `$METADATA` 的条数（walk 档恒 0 —— 它看不见元文件）
    pub meta_records: u64,
    /// 收进 `$ORPHANS` 的不可达记录数（walk 档恒 0）
    pub orphan_records: u64,
    /// fixup / 解析失败的记录数（walk 档恒 0）
    pub records_corrupt: u64,

    pub elapsed_ms: u64,
    /// 三条自洽判据的合并结论：合计为正、未计入非负、合计不超过卷总容量
    pub accounting_ok: bool,
}

impl ScanReport {
    pub fn from_tree(t: &ScanTree) -> Self {
        let used = t.volume.used_bytes();
        let counted = t.counters.bytes_counted;
        let unaccounted = used as i64 - counted as i64;
        // walk 档 mft = None → unwrap_or_default 全 0 ——「walk 档恒 0」就是这句话
        let m = t.mft.unwrap_or_default();
        ScanReport {
            root: t.root.path.clone(),
            volume_serial: t.volume.serial,
            volume_label: t.volume.label.clone(),
            volume_total_bytes: t.volume.total_bytes,
            volume_free_bytes: t.volume.free_bytes,
            volume_used_bytes: used,
            files: t.counters.files,
            dirs: t.counters.dirs,
            bytes_logical: t.counters.bytes_logical,
            bytes_alloc: t.counters.bytes_alloc,
            bytes_counted: counted,
            unaccounted_bytes: unaccounted,
            denied: t.counters.errors.denied,
            missing: t.counters.errors.missing,
            busy: t.counters.errors.busy,
            other_errors: t.counters.errors.other_errors(),
            skipped_reparse: t.counters.skipped_reparse,
            skipped_always: t.counters.skipped_always,
            deduped_hardlinks: t.counters.deduped_hardlinks,
            depth_capped: t.counters.depth_capped,
            scan_mode: t.mode,
            meta_records: m.meta_records,
            orphan_records: m.orphan_records,
            records_corrupt: m.records_corrupt,
            elapsed_ms: t.elapsed_ms,
            accounting_ok: counted > 0
                && unaccounted >= 0
                && counted <= t.volume.total_bytes,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("ScanReport 全是平坦字段，序列化不可能失败")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Counters, ErrorTally, ScanNode, ScanTree};
    use crate::volume::VolumeInfo;

    fn tree(counted: u64, total: u64, free: u64) -> ScanTree {
        ScanTree {
            top: Vec::new(),
            root: ScanNode::dir("C:".into(), r"C:\".into()),
            counters: Counters { bytes_counted: counted, files: 1, ..Default::default() },
            volume: VolumeInfo { serial: 7, label: "SYS".into(), total_bytes: total, free_bytes: free },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            elapsed_ms: 12,
            mode: ScanMode::Walk,
            mft: None,
        }
    }

    #[test]
    fn unaccounted_is_used_minus_counted() {
        // used = 100 - 40 = 60；counted = 55 -> 未计入 5。**断言的是减法本身**，
        // 不是某个魔数 —— 魔数会随夹具变化而说谎。
        let t = tree(55, 100, 40);
        let r = ScanReport::from_tree(&t);
        assert_eq!(r.volume_used_bytes, 60);
        assert_eq!(r.unaccounted_bytes, 60 - 55);
        assert!(r.accounting_ok);
    }

    #[test]
    fn impossible_accounting_is_visible_not_saturated_to_zero() {
        // 合计（120）比整卷已用（100−10=90）还大：这正是"80G 扫出 90G"的签名。
        // 必须留下一个**负数**（90−120 = −30），而不是被 saturating_sub 抹成 0。
        let t = tree(120, 100, 10);
        let r = ScanReport::from_tree(&t);
        assert_eq!(r.volume_used_bytes, 90);
        assert_eq!(r.unaccounted_bytes, -30);
        assert!(!r.accounting_ok, "负数必须让自洽判据为假");
    }

    #[test]
    fn counted_above_volume_total_is_not_ok() {
        let t = tree(101, 100, 0);
        let r = ScanReport::from_tree(&t);
        assert!(!r.accounting_ok);
    }

    #[test]
    fn empty_scan_is_not_a_pass() {
        // 一个文件都没扫到的"成功"是假成功（根目录被拒时最像）
        let t = tree(0, 100, 40);
        let r = ScanReport::from_tree(&t);
        assert!(!r.accounting_ok);
    }

    #[test]
    fn other_errors_is_the_four_bucket_collapse() {
        assert_eq!(
            ErrorTally { too_many_handles: 1, not_dir: 2, cycle: 3, unknown: 4, ..Default::default() }.other_errors(),
            10
        );
        assert_eq!(ErrorTally { denied: 9, ..Default::default() }.other_errors(), 0, "denied 不进 otherErrors");
    }

    #[test]
    fn report_round_trips_through_json() {
        let t = tree(55, 100, 40);
        let r = ScanReport::from_tree(&t);
        let v: ScanReport = serde_json::from_str(&r.to_json()).expect("反序列化");
        assert_eq!(v, r);
    }
}
