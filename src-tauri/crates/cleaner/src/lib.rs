//! DeepClean 的清理链（M3-B / M3-C）。
//!
//! **只有 `executor` 一个模块会动文件系统**。默认只走回收站（`SHFileOperationW` +
//! `FOF_ALLOWUNDO`）—— 这一条由 `executor_uses_recycle_bin_with_allowundo`（静态）与
//! `recycle_actually_lands_in_the_recycle_bin…`（行为：问 Shell 要回收站计数）两道钉着。
//! M6 起执行器另有**一条**受控真删通道（`delete_permanently`，FO_DELETE 不带
//! `FOF_ALLOWUNDO`）：它同样只住在 executor.rs、上下文必须 `permanent` **且**带确认回执
//! （缺一整批拒绝），由 `permanent_deletion_channel_is_pinned`（静态）与真删行为测试钉着。
//! 2026-10-24 起执行器多一个**只观测**的注入面 `CleanProgress`（逐条删除落下时回报一次），
//! 与 `CleanLog` 同一位置、同一条纪律：不参与任何判定，没挂就整段跳过。
//! 其余模块（`model` / `preview` / `digest` / `confirm` / `gate` / `journal`）一律零文件系统，
//! 由 `no_direct_deletion_api_in_non_executor_modules` 随编译跑。
//! §18 的执行入口只认 `PreviewConfirmation.digest`，渲染端报上来的路径清单一律不作数。

pub mod confirm;
pub mod digest;
pub mod executor;
pub mod gate;
pub mod journal;
pub mod journal_view;
pub mod logline;
pub mod model;
pub mod preview;

pub use confirm::{confirm_preview, CONFIRM_NOTE};
pub use digest::{cmp_utf16, execution_digest, preview_digest};
pub use executor::{
    CleanDeletion, CleanDeletionKind, CleanOutcome, CleanProgress, CleanProgressEvent, CleanTask,
    CleanTaskStatus, CleanVerification, CleanFs, EntryKind, ExecuteCtx, MeasureResult, RecycleError,
    RecycleErrorKind, Retry, WindowsCleanFs, execute_cleanup,
};
pub use gate::{
    classify_path, guard_authorized_root, is_drive_root_like, is_strictly_inside, path_shape_problem,
    resolve_roots, CleanBlocker, CleanBlockerReason, CleanRefusal, CleanRefusalReason, ResolvedPatterns,
    RootKind,
};
pub use journal::{
    build_run, drive_of, is_expired, CleanRun, JournalFile, PathAttribution, JOURNAL_RETENTION_MS,
};
pub use journal_view::{children_of, local_day, summarize_roots, DirEntry, DirSummary};
pub use logline::{CleanLog, LogFields, LogValue, format_log_line, local_stamp};
pub use model::{
    PricedPath, PreviewBuildOptions, PreviewConfirmBlocker, PreviewConfirmation,
    PreviewConfirmationKind, PreviewItem, PreviewModel, PreviewRefusal, PreviewRefusalReason,
    PreviewRefusalScope, PreviewRiskCell, PreviewScope, PreviewSelection, RiskBreakdown,
};
pub use preview::build_preview_model;

pub fn name() -> &'static str {
    "deepclean-cleaner"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_stable() {
        assert_eq!(name(), "deepclean-cleaner");
    }

    /// **结构性安全判据**：M3-B 那批模块（确认/预览/指纹/授权闸）仍然是零删除的；
    /// M3-C 的执行器只允许走回收站（`SHFileOperationW` + `FOF_ALLOWUNDO`），
    /// 不许直接 `remove_file` / `remove_dir` / `DeleteFile` / `IFileOperation`。
    #[test]
    fn no_direct_deletion_api_in_non_executor_modules() {
        let zero_deletion_sources = [
            ("lib.rs", include_str!("lib.rs")),
            ("model.rs", include_str!("model.rs")),
            ("digest.rs", include_str!("digest.rs")),
            ("preview.rs", include_str!("preview.rs")),
            ("confirm.rs", include_str!("confirm.rs")),
            ("gate.rs", include_str!("gate.rs")),
            ("journal.rs", include_str!("journal.rs")),
            // M5-K 新加的两格。`logline.rs` 是这次必须进名单的理由（它贴着执行器）；
            // `journal_view.rs` 是**补漏** —— 它一直不在这份名单里，于是这一路零删除的判据
            // 从来没扫过它。名单少一行与判据失效在结果里长得一样（都表现为"绿"）。
            ("logline.rs", include_str!("logline.rs")),
            ("journal_view.rs", include_str!("journal_view.rs")),
        ];
        let banned_everywhere = ["remove_file", "remove_dir", "remove_dir_all", "std::fs::remove", "DeleteFileW", "DeleteFile", "IFileOperation"];
        for (name, src) in zero_deletion_sources {
            let code_only = src.split("#[cfg(test)]").next().unwrap_or("");
            for line in code_only.lines() {
                let code = line.trim_start();
                if code.starts_with("//") || code.starts_with('*') {
                    continue;
                }
                for b in banned_everywhere {
                    assert!(
                        !code.contains(b),
                        "{name} 里出现了直接删除 API `{b}`：{line}\n\
                         M3-B 模块必须保持零删除。"
                    );
                }
            }
        }
    }

    /// M3-C 执行器只允许通过回收站 API 删除，且必须带 `FOF_ALLOWUNDO`。
    #[test]
    fn executor_uses_recycle_bin_with_allowundo() {
        let src = include_str!("executor.rs");
        let code_only = src.split("#[cfg(test)]").next().unwrap_or("");
        assert!(
            code_only.contains("SHFileOperationW"),
            "executor.rs 必须调用 SHFileOperationW"
        );
        assert!(
            code_only.contains("FOF_ALLOWUNDO"),
            "executor.rs 必须带 FOF_ALLOWUNDO（默认进回收站）"
        );
        let banned = ["remove_file", "remove_dir", "remove_dir_all", "std::fs::remove", "DeleteFileW", "DeleteFile", "IFileOperation"];
        for line in code_only.lines() {
            let code = line.trim_start();
            if code.starts_with("//") || code.starts_with('*') {
                continue;
            }
            for b in banned {
                assert!(
                    !code.contains(b),
                    "executor.rs 里出现了直接删除 API `{b}`：{line}\n\
                     默认必须进回收站，不许直接删除。"
                );
            }
        }
    }

    /// M6：真删通道的三条静态纪律。
    ///
    /// 1. `delete_permanently` 必须存在且走 `SHFileOperationW`（与回收站同一入口家族，
    ///    错误分类同源）—— 通道要真能用，不是纸面声明。
    /// 2. 它的函数体**不许**出现 `FOF_ALLOWUNDO`：带了就进回收站，真删语义名存实亡，
    ///    而任务回执与 `ok = true` 在那种情况下照样成立（这正是回收站那条行为测试的注释
    ///    点名的那个坑，这里在静态层再拦一次）。
    /// 3. 执行器必须真的**按 ctx 路由**（`self.fs.delete_permanently(path)` 存在），
    ///    且真删必须有授权凭据闸（`PermanentWithoutConfirmation` 被引用）。
    #[test]
    fn permanent_deletion_channel_is_pinned() {
        let src = include_str!("executor.rs");
        let code_only = src.split("#[cfg(test)]").next().unwrap_or("");
        assert!(
            code_only.contains("self.fs.delete_permanently(path)"),
            "执行器必须真的按 ctx.permanent 路由到 delete_permanently"
        );
        assert!(
            code_only.contains("PermanentWithoutConfirmation"),
            "真删通道必须带授权凭据闸（permanent 且无 digest ⇒ 整批拒绝）"
        );
        // 取 WindowsCleanFs 实现里的 delete_permanently 函数体（trait 那份默认实现先出现在
        // 文件里，直接 find 会命中它 —— 那份本来就不含 SHFileOperationW，断言会打红正确的代码）。
        let win_impl = code_only
            .find("impl CleanFs for WindowsCleanFs")
            .expect("executor.rs 必须有 WindowsCleanFs 的 CleanFs 实现");
        let start = win_impl
            + code_only[win_impl..]
                .find("fn delete_permanently")
                .expect("WindowsCleanFs 必须实现 delete_permanently（真删通道）");
        let rest = &code_only[start..];
        let end = rest["fn delete_permanently".len()..]
            .find("\n    fn ")
            .map(|i| i + "fn delete_permanently".len() + 1)
            .unwrap_or(rest.len());
        let body = &rest[..end];
        assert!(
            body.contains("SHFileOperationW"),
            "delete_permanently 必须走 SHFileOperationW（错误分类与回收站同源）"
        );
        // 与上面那条钉子同一纪律：注释行跳过 —— 函数体里的"刻意不带 FOF_ALLOWUNDO"注释
        // 本身就写着这个词，按原文扫会打红正确的代码。
        let body_code = body
            .lines()
            .filter(|l| {
                let c = l.trim_start();
                !(c.starts_with("//") || c.starts_with('*'))
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !body_code.contains("FOF_ALLOWUNDO"),
            "delete_permanently 的代码不许出现 FOF_ALLOWUNDO —— 带了就进回收站，真删通道名存实亡"
        );
    }
}
