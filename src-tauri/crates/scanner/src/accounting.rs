//! 六条规则里能做成**纯函数**的那部分：去重、跳过判定、聚合。
//!
//! 把这三件事从 walk 里抠出来单独放，是因为它们是本里程碑全部价值所在，而它们**不需要磁盘**
//! 就能穷举验证。walk 那一层只剩"调 Win32 + 拼树"，回归面小得多。

use crate::enumerate::RawEntry;
use std::collections::HashSet;

/// 按名字硬跳过的目录（大小写无关）。与 TS 侧 `core/fs/errors.ts:23` 的 `SKIP_ALWAYS` 同集。
///
/// **`System Volume Information` 必须在这里**：它在标准用户下必被拒、在管理员下默认也拒
/// （2026-10-10 全盘双轮对照实测），不跳就是几百上千条 denied 噪声，而它的体积照样会
/// 落进「未计入」—— 这正是"未计入"这个数存在的意义。
pub const SKIP_ALWAYS: [&str; 2] = ["system volume information", "dumpstack.log.tmp"];

/// 跳过原因。**跳过必须可报数**：现行 TS 实现把非目录非文件的东西判成 `'other'` 后
/// 静默丢弃（`core/scan/walk.ts:195`），当年查"为什么少了几百 MB"时没有任何线索。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum SkipReason {
    /// 重解析点（junction / 符号链接）—— 不进入、不计数
    Reparse,
    /// 名字命中 `SKIP_ALWAYS`
    Always,
}

pub fn skip_reason(entry: &RawEntry) -> Option<SkipReason> {
    if entry.is_reparse {
        return Some(SkipReason::Reparse);
    }
    let lower = entry.name.to_ascii_lowercase();
    if SKIP_ALWAYS.contains(&lower.as_str()) {
        return Some(SkipReason::Always);
    }
    None
}

/// 硬链接去重。
///
/// 键是 `(卷序列号, 文件 ID)` —— **必须成对**。只比文件 ID 会在多卷机器上撞号
/// （不同卷的 ID 空间各自独立），本项目在 V0.6 的重复检测里已经为这条付过学费
/// （`core/dup/detect.ts:492` 用的是 `` `${dev}:${ino}` ``）。
#[derive(Debug, Default)]
pub struct FileAccounting {
    seen: HashSet<(u32, u64)>,
    pub deduped_hardlinks: u64,
}

impl FileAccounting {
    pub fn new() -> Self {
        Self::default()
    }

    /// 这条文件应当计入多少字节。
    ///
    /// **首个出现计全额；同键的第二条起计 0**（不是计 size 的一半、也不是不计这条路径 ——
    /// 路径要留在树里给 UI 看，只是不再是第二份字节）。
    ///
    /// `file_id == 0` 时**不去重**：FAT/exFAT 不给有效 ID，把所有 0 当成同一条会把整个
    /// 目录合并成一个"文件"的字节数 —— 那是比多算更坏的少算。
    pub fn count_file(&mut self, volume_serial: u32, file_id: u64, alloc: u64) -> u64 {
        if file_id == 0 {
            return alloc;
        }
        if self.seen.insert((volume_serial, file_id)) {
            alloc
        } else {
            self.deduped_hardlinks += 1;
            0
        }
    }
}

/// 一棵子树的聚合量。**所有金额字段一律是分配大小口径**（`alloc`），
/// 逻辑大小只作为展示字段随节点带一份，不参与任何求和。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Agg {
    pub files: u64,
    pub dirs: u64,
    pub bytes_logical: u64,
    pub bytes_alloc: u64,
    pub bytes_counted: u64,
}

impl Agg {
    pub fn add(&mut self, other: Agg) {
        self.files += other.files;
        self.dirs += other.dirs;
        self.bytes_logical += other.bytes_logical;
        self.bytes_alloc += other.bytes_alloc;
        self.bytes_counted += other.bytes_counted;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, is_dir: bool, is_reparse: bool) -> RawEntry {
        RawEntry {
            name: name.to_string(),
            size: 0,
            alloc_size: 0,
            file_id: 0,
            attrs: 0,
            last_write_ms: 0,
            creation_ms: 0,
            is_dir,
            is_reparse,
        }
    }

    #[test]
    fn reparse_is_skipped_no_matter_what_it_points_at() {
        assert_eq!(skip_reason(&entry("link", false, true)), Some(SkipReason::Reparse));
        // 重解析点常常带 DIRECTORY 位 —— 顺序反了就会把它当普通目录递归进去直接踩成环
        assert_eq!(skip_reason(&entry("junc", true, true)), Some(SkipReason::Reparse));
    }

    #[test]
    fn skip_always_is_case_insensitive() {
        for n in ["System Volume Information", "SYSTEM VOLUME INFORMATION", "system volume information"] {
            assert_eq!(skip_reason(&entry(n, true, false)), Some(SkipReason::Always), "{n}");
        }
        assert_eq!(skip_reason(&entry("dumpstack.log.tmp", false, false)), Some(SkipReason::Always));
        assert_eq!(skip_reason(&entry("System Volume Information Backup", true, false)), None);
    }

    #[test]
    fn ordinary_entries_are_not_skipped() {
        assert_eq!(skip_reason(&entry("node_modules", true, false)), None);
        assert_eq!(skip_reason(&entry("a.bin", false, false)), None);
    }

    #[test]
    fn first_occurrence_counts_the_rest_count_zero() {
        let mut acc = FileAccounting::new();
        // 三条硬链接指向同一份 4096 字节
        assert_eq!(acc.count_file(1, 100, 4096), 4096);
        assert_eq!(acc.count_file(1, 100, 4096), 0);
        assert_eq!(acc.count_file(1, 100, 4096), 0);
        assert_eq!(acc.deduped_hardlinks, 2, "三条里后两条被去重");
        // 另一条普通文件照常全额
        assert_eq!(acc.count_file(1, 101, 8192), 8192);
    }

    #[test]
    fn the_same_file_id_on_another_volume_is_a_different_file() {
        let mut acc = FileAccounting::new();
        assert_eq!(acc.count_file(1, 100, 4096), 4096);
        assert_eq!(acc.count_file(2, 100, 4096), 4096, "只比 ID 会让两块盘上的文件互相抵消");
        assert_eq!(acc.deduped_hardlinks, 0);
    }

    #[test]
    fn zero_file_id_is_never_deduped() {
        // FAT/exFAT 的真实形态：全 0。当成同一条会把整个目录的字节合并成一个文件。
        let mut acc = FileAccounting::new();
        assert_eq!(acc.count_file(1, 0, 100), 100);
        assert_eq!(acc.count_file(1, 0, 200), 200);
        assert_eq!(acc.count_file(1, 0, 300), 300);
        assert_eq!(acc.deduped_hardlinks, 0);
    }

    #[test]
    fn agg_sums_every_axis() {
        let mut a = Agg { files: 1, dirs: 0, bytes_logical: 10, bytes_alloc: 4096, bytes_counted: 4096 };
        a.add(Agg { files: 2, dirs: 3, bytes_logical: 20, bytes_alloc: 8192, bytes_counted: 4096 });
        assert_eq!(a, Agg { files: 3, dirs: 3, bytes_logical: 30, bytes_alloc: 12288, bytes_counted: 8192 });
    }
}
