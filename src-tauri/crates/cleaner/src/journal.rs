//! 清理日志的**一次清理**派生 —— **纯函数，零 IO**。
//!
//! 2026-10-25 重做（设计：`docs/superpowers/specs/2026-10-25-clean-journal-redesign-design.md`）。
//!
//! 旧版是「一个文件一行」的扁平账本（`JournalEntry`），只活在内存里、进程一退就没，
//! 也没法回答"哪一次清理"。人类伙伴要的是**一次清理一条日志**，留 30 天。
//! 所以这一层换成 `CleanRun`：
//!
//! ```text
//! CleanRun { id, ended_at_ms, drives, freed_bytes, file_count, files[] }
//! ```
//!
//! 三条结构边界（本文件末尾的静态判据钉着前两条）：
//!
//! 1. **没有删除能力**：不 import `std::fs`，也不 import 那个真会动手的 `executor` 之外的写接口。
//! 2. **不读中文措辞**：只认结构化字段 `ok` / `kind` / `status`。`detail` 那些句子
//!    从不参与判定 —— 把事实源建在字符串上，改一个词就会悄悄换掉日志口径。
//! 3. **不读时钟**：`ended_at_ms` 由调用方给（用 `task.finished_at_ms`）。可复现。
//!
//! **只记成功的**（人类伙伴 2026-10-25 定）：`deleted[]` 里只取 `ok == true && kind == File`。
//! 失败与跳过的那些不进日志 —— 执行弹窗里已经逐条列过，日志的职责是记账不是报错。
//! 代价如实记：用户看不到"上次有一堆删失败"，这是刻意的。

use crate::executor::{CleanDeletion, CleanDeletionKind};
use deepclean_rules::types::Risk;
use serde::{Deserialize, Serialize};

/// 30 天保留窗口。人类伙伴定的「每个清理记录保留 30 天」，从 `ended_at_ms` 算起。
pub const JOURNAL_RETENTION_MS: i64 = 30 * 24 * 3600 * 1000;

/// 归属表的一格：确认那一刻量到的规则、风险与字节。
///
/// **仍然保留**：`service.rs` 的 `ConfirmedPlan.attribution` 用它（确认凭据的一部分），
/// 与日志页无关。2026-10-25 重做时差点连它一起删掉，那是错的。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathAttribution {
    pub rule_id: String,
    pub risk: Risk,
    pub bytes: u64,
}

/// 日志详情里的一个文件。**只有成功的那些**会出现在这里。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalFile {
    /// 原样路径（给人看，不归一化）。
    pub path: String,
    pub size_bytes: u64,
}

/// **一次清理 = 一条**。这是日志页上滚动的单位。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanRun {
    /// 复用 `task.id`。
    pub id: String,
    /// 清理**结束**时刻（毫秒）。30 天从这里算 —— 人类伙伴定的是「从清理结束算起」。
    pub ended_at_ms: i64,
    /// 实际涉及的盘，升序去重（如 `["C:\\", "D:\\"]`）。
    ///
    /// 只从**成功文件的路径**推导：`dirs_removed` 不带字节、也不代表"在这块盘上清了多少"，
    /// 混进来只会让「在 X 盘」这句话变糊。UNC 路径推不出盘符 ⇒ 不计入。
    pub drives: Vec<String>,
    /// 成功释放的字节合计。与 `task.cleaned_size` 同口径（只算成功的文件）。
    pub freed_bytes: u64,
    /// 成功删除的文件数。
    pub file_count: u64,
    /// 详情：成功的那些文件。**存扁平**，折叠在 `journal_view` 里算。
    pub files: Vec<JournalFile>,
}

/// 路径的盘符（`"C:\\"` 形）。推不出（UNC / 相对路径 / 空）返回 `None`。
///
/// 大小写折叠到盘符：`c:\x` 与 `C:\y` 是同一块盘，不去重就会在界面上列出两个 C 盘。
pub fn drive_of(path: &str) -> Option<String> {
    let b = path.as_bytes();
    if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return Some(format!("{}:\\", (b[0] as char).to_ascii_uppercase()));
    }
    None
}

/// 把一次任务的结局派生成**一条**日志。一个文件都没删成 ⇒ `None`（不产生条目）。
///
/// `ended_at_ms` 由调用方给（`task.finished_at_ms`），本函数不读时钟。
pub fn build_run(task_id: &str, ended_at_ms: i64, deleted: &[CleanDeletion]) -> Option<CleanRun> {
    // 只取「成功删除的文件」—— 先判 ok，再判 kind。
    // 顺序是刻意的：`ok == false` 的行不管 kind 是什么都不该进日志。
    let files: Vec<JournalFile> = deleted
        .iter()
        .filter(|d| d.ok && d.kind == CleanDeletionKind::File)
        .map(|d| JournalFile { path: d.path.clone(), size_bytes: d.bytes })
        .collect();

    if files.is_empty() {
        return None;
    }

    let freed_bytes = files.iter().map(|f| f.size_bytes).sum();
    let mut drives: Vec<String> = files.iter().filter_map(|f| drive_of(&f.path)).collect();
    drives.sort();
    drives.dedup();

    Some(CleanRun {
        id: task_id.to_string(),
        ended_at_ms,
        drives,
        freed_bytes,
        file_count: files.len() as u64,
        files,
    })
}

/// 这一条过没过保留期。边界是**开区间**：正好 30 天不删，超 1 ms 就删。
pub fn is_expired(run: &CleanRun, now_ms: i64) -> bool {
    run.ended_at_ms + JOURNAL_RETENTION_MS < now_ms
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::CleanOutcome;

    fn del(path: &str, bytes: u64, ok: bool, kind: CleanDeletionKind) -> CleanDeletion {
        CleanDeletion {
            path: path.into(),
            kind,
            // 失败行执行器记 0（`executor.rs` 的口径：没删掉就没有释放）
            bytes: if ok { bytes } else { 0 },
            ok,
            errno: if ok { None } else { Some("WIN32_120".into()) },
            detail: None,
            attempts: Some(1),
            outcome: Some(if ok { CleanOutcome::Ok } else { CleanOutcome::Failed }),
        }
    }

    #[test]
    fn only_successful_file_deletions_become_journal_files() {
        let deleted = vec![
            del("C:\\a\\ok1.tmp", 100, true, CleanDeletionKind::File),
            del("C:\\a\\bad.tmp", 999, false, CleanDeletionKind::File),
            del("C:\\a\\dir", 0, true, CleanDeletionKind::Dir),
            del("C:\\a\\ok2.tmp", 50, true, CleanDeletionKind::File),
        ];
        let run = build_run("t1", 1_000, &deleted).expect("有成功的就有条目");
        assert_eq!(run.file_count, 2);
        assert_eq!(run.freed_bytes, 150, "失败的 999 不许计进去");
        assert_eq!(run.files.len(), 2);
        assert_eq!(run.files[0].path, "C:\\a\\ok1.tmp");
    }

    #[test]
    fn nothing_successful_means_no_run_at_all() {
        let deleted = vec![del("C:\\a\\x.tmp", 10, false, CleanDeletionKind::File)];
        assert!(build_run("t1", 1_000, &deleted).is_none(), "一个都没删成 ⇒ 不产生日志条目");
    }

    #[test]
    fn a_directory_only_task_produces_no_run() {
        // 只删了空目录（0 字节、kind=Dir）⇒ 没有"清理了多少文件"可记
        let deleted = vec![del("C:\\a\\emptydir", 0, true, CleanDeletionKind::Dir)];
        assert!(build_run("t1", 1_000, &deleted).is_none());
    }

    #[test]
    fn drives_are_derived_from_paths_deduped_and_sorted() {
        let deleted = vec![
            del("D:\\x\\a.tmp", 10, true, CleanDeletionKind::File),
            del("C:\\y\\b.tmp", 20, true, CleanDeletionKind::File),
            del("C:\\z\\c.tmp", 30, true, CleanDeletionKind::File),
        ];
        let run = build_run("t1", 1_000, &deleted).unwrap();
        assert_eq!(run.drives, vec!["C:\\".to_string(), "D:\\".to_string()]);
    }

    #[test]
    fn drive_of_handles_forward_slashes_and_unc() {
        assert_eq!(drive_of("C:/Users/a.tmp").as_deref(), Some("C:\\"));
        assert_eq!(drive_of("c:\\lower.tmp").as_deref(), Some("C:\\"), "大小写归一到盘符");
        assert_eq!(drive_of("\\\\server\\share\\a.tmp"), None, "UNC 没有盘符");
        assert_eq!(drive_of("relative\\a.tmp"), None);
    }

    #[test]
    fn freed_bytes_must_equal_cleaned_size_and_count_must_match() {
        // 两条对账：只记成功口径下，这两条必须**恒等**
        let deleted = vec![
            del("C:\\a\\x.tmp", 100, true, CleanDeletionKind::File),
            del("C:\\a\\y.tmp", 200, true, CleanDeletionKind::File),
            del("C:\\a\\bad.tmp", 999, false, CleanDeletionKind::File),
            del("C:\\a\\dir", 0, true, CleanDeletionKind::Dir),
        ];
        let run = build_run("t1", 1_000, &deleted).unwrap();
        let want_files = deleted.iter().filter(|d| d.ok && d.kind == CleanDeletionKind::File).count() as u64;
        assert_eq!(run.file_count, want_files, "file_count 必须等于 ok&&file 的条数");
        let want_bytes: u64 = deleted
            .iter()
            .filter(|d| d.ok && d.kind == CleanDeletionKind::File)
            .map(|d| d.bytes)
            .sum();
        assert_eq!(run.freed_bytes, want_bytes, "freed_bytes 必须等于那些行的字节和");
    }

    #[test]
    fn thirty_day_window_is_exclusive_at_the_boundary() {
        let deleted = vec![del("C:\\a\\x.tmp", 10, true, CleanDeletionKind::File)];
        let run = build_run("t1", 1_000_000, &deleted).unwrap();
        let now = 1_000_000 + JOURNAL_RETENTION_MS;
        assert!(!is_expired(&run, now), "正好 30 天不该删");
        assert!(is_expired(&run, now + 1), "超 1 ms 就该删");
        assert!(!is_expired(&run, now - 1), "差 1 ms 没到 30 天，留着");
    }

    /// 结构边界 1：本文件不许有文件系统能力。
    ///
    /// ⚠️ 扫的是**生产代码那一段**，不是整个文件：这条判据自己的 `banned` 字面量里就写着
    /// `std::fs::` 等词，扫全文件会自己把自己判红（第一版就是这么红的）。
    /// 切法是取 `#[cfg(test)]` 之前的部分。
    #[test]
    fn this_module_has_no_filesystem_access() {
        let src = include_str!("journal.rs");
        let cut = src.find("#[cfg(test)]").expect("本文件必须有测试模块");
        let code: String = src[..cut]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        for banned in ["std::fs::", "File::create", "remove_file", "remove_dir", "write_all"] {
            assert!(!code.contains(banned), "journal.rs 生产代码不许出现 {banned}（零 IO 边界）");
        }
    }
}
