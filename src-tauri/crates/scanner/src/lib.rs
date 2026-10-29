//! M1 的扫描内核（M1-A 起）。
//!
//! 与现行 TS 实现的根本差别只有一条，但它是「80G 的盘扫出 90G+」的根因：
//! **一次目录遍历同时拿到文件 ID 与磁盘分配大小**（`FileIdBothDirectoryInfo`），
//! 于是硬链接去重与占用口径都不需要额外的 `stat`。TS 侧是逐目录项 `stat` 且只拿逻辑大小
//! （`core/fs/fslike.ts:70`），两件事都做不到。
//!
//! 分层：`enumerate`/`volume` 是 Win32 薄封装（`unsafe` 只在这两个文件里；
//! MFT 档的卷读取原语收在 `mft/rawvol.rs`，真卷实现 MS2 起加入成为第三处）；
//! `accounting` 是纯函数规则；`scan` 拼树；`report` 是对外协议。

pub mod accounting;
/// M1-T6「以管理员重新扫描」：判据 + 助手命令行构造 + `runas` 起进程。
pub mod elevate;
pub mod heap;
pub mod enumerate;
/// MFT 直读档（精度对齐 SpaceSniffer）：分层与口径见 `mft/mod.rs` 头注。
pub mod mft;
pub mod model;
pub mod report;
pub mod scan;
/// walk 档的并行化：两阶段（A 并行建树 + B 单线程 canonical fold），与 `scan` 逐字段等价。
pub mod scan_parallel;
pub mod tree_index;
pub mod volume;
pub mod winerr;

pub use report::ScanReport;
pub use scan::{scan_tree, ScanFailure, ScanOptions};

pub fn name() -> &'static str {
    "deepclean-scanner"
}

#[cfg(test)]
mod tests {
    #[test]
    fn name_is_stable() {
        assert_eq!(super::name(), "deepclean-scanner");
    }
}
