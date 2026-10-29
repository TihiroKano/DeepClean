//! Win32 码 → 扫描错误分类。
//!
//! 分类口径与 TS 侧 `core/fs/errors.ts`（`ScanErrorKind`）**逐字相同**，成员名不许改 ——
//! M1-C 要拿两套实现背靠背对账，同一次扫描在两套实现里给出不同的分账就是失败。
//!
//! 1920（`ERROR_CANT_ACCESS_FILE`）**故意不映射**：TS 侧 `core/fs/winerr.ts:13-21` 就把它
//! 归到 unknown。这条注释不是解释，是约束 —— 想映射它的人先去看那份表的理由。

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScanErrorKind {
    Denied,
    Missing,
    Busy,
    TooManyHandles,
    NotDir,
    /// 扫描器自己判出来的重解析点环 —— 不对应任何 win32 码，所以不出现在 `kind_of_win32` 里
    Cycle,
    Unknown,
}

impl ScanErrorKind {
    /// 线上四桶口径（与 TS `core/scan/tree-store.ts:495` 相同）。
    /// 分账对外只报四桶，但内部必须留七类 —— 收成四桶是展示选择，不是分类依据。
    pub fn bucket(self) -> &'static str {
        match self {
            ScanErrorKind::Denied => "denied",
            ScanErrorKind::Missing => "missing",
            ScanErrorKind::Busy => "busy",
            ScanErrorKind::TooManyHandles
            | ScanErrorKind::NotDir
            | ScanErrorKind::Cycle
            | ScanErrorKind::Unknown => "otherErrors",
        }
    }
}

pub fn kind_of_win32(code: u32) -> ScanErrorKind {
    use ScanErrorKind::*;
    match code {
        2 | 3 => Missing,     // FILE_NOT_FOUND / PATH_NOT_FOUND
        5 => Denied,          // ACCESS_DENIED
        18 => TooManyHandles, // NO_MORE_FILES
        32 | 33 => Busy,      // SHARING_VIOLATION / LOCK_VIOLATION
        267 => NotDir,        // DIRECTORY
        _ => Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_documented_codes() {
        assert_eq!(kind_of_win32(5), ScanErrorKind::Denied);
        assert_eq!(kind_of_win32(2), ScanErrorKind::Missing);
        assert_eq!(kind_of_win32(3), ScanErrorKind::Missing);
        assert_eq!(kind_of_win32(32), ScanErrorKind::Busy);
        assert_eq!(kind_of_win32(33), ScanErrorKind::Busy);
        assert_eq!(kind_of_win32(18), ScanErrorKind::TooManyHandles);
        assert_eq!(kind_of_win32(267), ScanErrorKind::NotDir);
    }

    #[test]
    fn unmapped_codes_stay_unknown() {
        // 1920 是刻意不映射的；999999 是不存在的码。两者都必须落到 Unknown，
        // 否则"新增一条映射"会静默改变历史扫描的分账口径。
        assert_eq!(kind_of_win32(1920), ScanErrorKind::Unknown);
        assert_eq!(kind_of_win32(999_999), ScanErrorKind::Unknown);
    }

    #[test]
    fn cycle_is_not_a_win32_code() {
        // Cycle 由扫描器判定，任何 win32 码都不该映射到它 —— 这条是给未来加映射的人的护栏
        for code in [0u32, 1, 2, 3, 5, 18, 32, 33, 267, 1920, u32::MAX] {
            assert_ne!(kind_of_win32(code), ScanErrorKind::Cycle);
        }
    }

    #[test]
    fn buckets_collapse_seven_into_four() {
        assert_eq!(ScanErrorKind::Denied.bucket(), "denied");
        assert_eq!(ScanErrorKind::Missing.bucket(), "missing");
        assert_eq!(ScanErrorKind::Busy.bucket(), "busy");
        for k in [
            ScanErrorKind::TooManyHandles,
            ScanErrorKind::NotDir,
            ScanErrorKind::Cycle,
            ScanErrorKind::Unknown,
        ] {
            assert_eq!(k.bucket(), "otherErrors");
        }
    }
}
