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
    ///
    /// ⚠️ **2026-10-30 改口径：从"全文件禁直接删除 API"改成"按函数作用域禁"**。
    /// 原来的写法把 `DeleteFileW` / `remove_file` 等从**整个** executor.rs 里 ban 掉 ——
    /// 那在"真删通道也走 shell"的年代成立。真删通道换成内核 API 之后
    /// （`delete_permanently` 的注释写了为什么换、实测在哪），全文件 ban 会打红
    /// **正确的**代码。
    ///
    /// 这条闸的意图从来不是"文件里不许出现这个词"，而是：
    ///
    /// 1. **回收站通道**（`fn recycle`）必须走 `SHFileOperationW` + `FOF_ALLOWUNDO`，
    ///    且它的函数体里不许出现任何直接删除 API —— 那是绕过回收站的形状；
    /// 2. 直接删除 API 只许出现在**真删通道的两个函数体**里
    ///    （`delete_permanently` / `delete_many_permanently`）—— 出现在任何别的
    ///    函数里都是"绕过 `ctx.permanent` 路由"的形状。
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

        let banned = [
            "remove_file",
            "remove_dir",
            "remove_dir_all",
            "std::fs::remove",
            "DeleteFileW",
            "DeleteFile",
            "IFileOperation",
        ];

        // ① 回收站通道：函数体里必须有 ALLOWUNDO、必须没有任何直接删除 API。
        //    （`WindowsCleanFs` 的 impl 块偏移：trait 的默认实现里也有同名方法，
        //    从文件头找会红在 trait 那份上 —— 见 `fn_body_of` 的注释。）
        let win_impl = code_only
            .find("impl CleanFs for WindowsCleanFs")
            .expect("executor.rs 必须有 WindowsCleanFs 的 CleanFs 实现");
        let recycle_body = fn_body_of(code_only, "fn recycle", win_impl);
        assert!(
            recycle_body.contains("FOF_ALLOWUNDO"),
            "recycle 必须带 FOF_ALLOWUNDO（默认进回收站）—— 函数体级的判据，不是文件级的"
        );
        for b in banned {
            assert!(
                !recycle_body.contains(b),
                "recycle 函数体里出现了直接删除 API `{b}` —— 回收站通道不许绕过 shell"
            );
        }

        // ② 真删通道之外：抽掉两个真删函数的函数体之后，剩下的代码里
        //    不许出现任何直接删除 API。
        let without_permanent = remove_fn_body(
            &remove_fn_body(code_only, "fn delete_permanently", win_impl),
            "fn delete_many_permanently",
            win_impl,
        );
        for line in without_permanent.lines() {
            let code = line.trim_start();
            if code.starts_with("//") || code.starts_with('*') {
                continue;
            }
            for b in banned {
                assert!(
                    !code.contains(b),
                    "executor.rs 的真删通道之外出现了直接删除 API `{b}`：{line}\n\
                     直接删除只许在 delete_permanently / delete_many_permanently 两个函数体里 —— \
                     出现在别处就是绕过 ctx.permanent 路由。"
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
        // 2026-10-30：查找逻辑抽进 `fn_body_of`（与回收站那条共用），偏移语义见它的注释。
        let win_impl = code_only
            .find("impl CleanFs for WindowsCleanFs")
            .expect("executor.rs 必须有 WindowsCleanFs 的 CleanFs 实现");
        let body = fn_body_of(code_only, "fn delete_permanently", win_impl);
        assert!(
            !body.is_empty(),
            "WindowsCleanFs 必须实现 delete_permanently（真删通道）"
        );
        // ⚠️ **2026-10-30 改口径**：原来断言"必须走 SHFileOperationW"——
        // 那在"真删也走 shell"的年代是对的（错误分类同源）。真删通道换成内核 API
        // （`DeleteFileW` / `RemoveDirectoryW`）之后，这一条改成**二选一**：
        // 要么 shell 批量版、要么内核直接删。两条都是合法的真删通道，
        // 都归 `classify_last_error` / `classify_shfile_error` 同一套错误分类管
        // （那张表共用，`errno` 形状不变 —— 这才是"错误分类同源"的实质）。
        // 真正不许出现的是 ALLOWUNDO（见下一条）—— 那才是"偷偷进回收站"。
        assert!(
            body.contains("SHFileOperationW") || body.contains("DeleteFileW"),
            "delete_permanently 必须是合法的真删通道（SHFileOperationW 或 DeleteFileW）"
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
        // 2026-10-30 补：批量真删通道同一条纪律（它也走 SHFileOperationW 批量版，
        // 同样不许出现 ALLOWUNDO —— 批量真删回错了回收站比逐条那一条更难发现）。
        let many_body = fn_body_of(code_only, "fn delete_many_permanently", win_impl);
        assert!(
            !many_body.is_empty(),
            "WindowsCleanFs 必须实现 delete_many_permanently（批量真删通道）"
        );
        // 与上面那条同一纪律：注释行跳过 —— 批量版函数体里那句"与逐条真删同一组分界：
        // 不带 FOF_ALLOWUNDO"的**说明**本身就写着这个词，按原文扫会打红正确的代码。
        let many_code = many_body
            .lines()
            .filter(|l| {
                let c = l.trim_start();
                !(c.starts_with("//") || c.starts_with('*'))
            })
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !many_code.contains("FOF_ALLOWUNDO"),
            "delete_many_permanently 的代码不许出现 FOF_ALLOWUNDO —— 批量真删更不许偷偷进回收站"
        );
        assert!(
            many_code.contains("SHFileOperationW"),
            "delete_many_permanently 必须走 SHFileOperationW（批量入口，与逐条同源）"
        );
    }
}

/// 抽出 `code` 里**第一个**名为 `needle` 的函数体（从 needle 起到下一个同级 `\n    fn ` 或 impl 结束）。
///
/// 只对 `impl` 块里 4 空格缩进的方法可靠 —— 这正是本文件里唯一的使用场景。
///
/// `from`：从这段文本的**这个偏移**开始找。真删/批量函数在文件里有**两处**同名签名
/// —— trait 的默认实现（先出现）与 `WindowsCleanFs` 的覆写（后出现）。原测试
/// `permanent_deletion_channel_is_pinned` 早就为这同一个坑写过处理：
/// 先定位 `impl CleanFs for WindowsCleanFs`，从那里起找。这里把那套逻辑抽出来共用，
/// 调用方一律传 impl 块的偏移，不然判据会红在**正确的** trait 默认实现上。
///
/// 找不到时回**空串**：调用方的断言会红在"函数不见了"上，而不是静默通过
/// （"找不到就当没有"会让函数被改名/删除时判据静默失效，那正是
/// `settings-glass-bounds.test.ts` 里 `cssVar` 那条注释点名的形状）。
#[cfg(test)]
fn fn_body_of(code: &str, needle: &str, from: usize) -> String {
    let Some(at) = code[from..].find(needle) else {
        return String::new();
    };
    let at = from + at;
    let rest = &code[at..];
    let end = rest[needle.len()..]
        .find("\n    fn ")
        .map(|i| i + needle.len() + 1)
        .unwrap_or(rest.len());
    let mut body = rest[..end].to_string();
    // ⚠️ 剥掉挂在**下一个**函数头上的 `///` 文档注释：
    // "\n    fn " 的切点落在下一个函数的签名上，而它的 `///` 文档注释在切点之前 ——
    // 不剥的话，下一个函数的注释会被算进本函数体。2026-10-30 真删通道换成
    // `DeleteFileW` 之后，那份注释里写着这个词，recycle 的"函数体"于是含了
    // 直接删除 API，判据红在正确的代码上。
    //
    // 做法：从切点往前，把**连续**的 `///` 行与它们之间的纯空行剥干净
    // （`lastIndexOf("\n    ///")` 只能剥最后一行 —— 注释块内部有空行时会漏）。
    let mut cut = body.len();
    loop {
        let head = &body[..cut];
        let trimmed = head.trim_end();
        // 尾部是空行 → 缩小，继续看
        if trimmed.len() < head.len() && trimmed.ends_with('\n') {
            cut = trimmed.len();
            continue;
        }
        // 尾部是 `///` 行 → 整行剥掉
        if let Some(line_start) = trimmed.rfind('\n') {
            let line = trimmed[line_start + 1..].trim_start();
            if line.starts_with("///") {
                cut = line_start + 1;
                continue;
            }
        }
        break;
    }
    body.truncate(cut);
    body
}

/// 把 `code` 里从 `from` 起第一个 `needle` 函数的**整个函数体**删掉（连签名带体），返回剩余文本。
///
/// 用于"真删通道之外不许出现 X"那一半判据：只删掉那两个真删函数，
/// 其余代码照原样扫。找不到 needle 时原样返回 —— 上游的"必须有"断言会红，
/// 这里不替它兜。
#[cfg(test)]
fn remove_fn_body(code: &str, needle: &str, from: usize) -> String {
    let Some(at) = code[from..].find(needle) else {
        return code.to_string();
    };
    let at = from + at;
    let rest = &code[at..];
    let end = rest[needle.len()..]
        .find("\n    fn ")
        .map(|i| i + needle.len() + 1)
        .unwrap_or(rest.len());
    let mut out = String::with_capacity(code.len());
    out.push_str(&code[..at]);
    // 与 `fn_body_of` 同一处坑：切点之前挂着**下一个**函数的 `///` 文档注释，
    // 它属于剩下的代码（描述的是那个还存在的函数），必须保留。
    // 所以这里不删注释，只把函数本体（签名到下一个签名前）删掉。
    out.push_str(&rest[end..]);
    out
}
