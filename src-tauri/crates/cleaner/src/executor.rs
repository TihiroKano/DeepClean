//! M3-C-2：清理执行器。**默认进回收站**，可取消，有记录。
//!
//! 所有真动作都走注入的 `CleanFs`：单元测试用合成 fs 穷举每一条拒绝理由与重试/取消路径，
//! 生产环境用 `WindowsCleanFs` —— 它通过 `SHFileOperationW` + `FOF_ALLOWUNDO` 把文件/目录
//! 移进回收站，而不是直接 `DeleteFile` / `RemoveDirectory`。
//!
//! 安全闸复用 `gate` 的同一套判据（`guard_authorized_root`、`classify_path`、
//! `is_forbidden_path`、`normalize_key`），不另立第三套“禁止”语义。

use crate::digest::execution_digest;
use crate::gate::{
    classify_path, guard_authorized_root, is_strictly_inside, resolve_roots, CleanBlocker, CleanRefusal,
    CleanRefusalReason, ResolvedPatterns, RootKind,
};
use crate::logline::{CleanLog, LogValue};
use deepclean_rules::engine::normalize_key;
use deepclean_rules::env::{is_forbidden_path, RuleEnv};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/* ------------------------------------------------------------------ *
 * I/O 面（注入式）
 * ------------------------------------------------------------------ */

/// 节点属性结论。与 TS `CleanFsStat` 同口径，但把“lstat 读不到”也收进来。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    File { size: u64 },
    Directory,
    ReparsePoint,
    Missing,
    Unstatable,
    Other,
}

impl EntryKind {
    pub fn file_size(&self) -> Option<u64> {
        match self {
            EntryKind::File { size } => Some(*size),
            _ => None,
        }
    }
}

/// 回收失败分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecycleErrorKind {
    /// 占用中 / 资源暂时不够，值得按配置重试。
    Transient,
    /// 权限、不存在、稳定错误等，重试也没用。
    Permanent,
}

/// 回收失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecycleError {
    pub kind: RecycleErrorKind,
    pub errno: String,
    pub detail: String,
}

impl RecycleError {
    pub fn transient(errno: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            kind: RecycleErrorKind::Transient,
            errno: errno.into(),
            detail: detail.into(),
        }
    }
    pub fn permanent(errno: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            kind: RecycleErrorKind::Permanent,
            errno: errno.into(),
            detail: detail.into(),
        }
    }
}

impl fmt::Display for RecycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.errno, self.detail)
    }
}

impl std::error::Error for RecycleError {}

/// 授权根总字节 / 文件数读数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MeasureResult {
    pub bytes: u64,
    pub files: u64,
}

/// 执行器需要的最小文件系统面。**生产实现是 `WindowsCleanFs`**。
pub trait CleanFs {
    fn lstat(&self, path: &str) -> EntryKind;
    fn recycle(&self, path: &str) -> Result<(), RecycleError>;
    /// M6：永久删除（不进回收站）。**默认实现直接报错** —— 真删能力必须由生产实现
    /// 显式声明，测试替身不声明就永远拿不到它：「忘了实现」与「没授权」在结果上分得开。
    fn delete_permanently(&self, _path: &str) -> Result<(), RecycleError> {
        Err(RecycleError::permanent(
            "E_PERMANENT_NOT_DECLARED",
            "这个 CleanFs 没有声明永久删除能力（trait 默认实现）→ 拒绝",
        ))
    }
    fn measure(&self, root: &str) -> MeasureResult;
    /// 卷的可用字节。`None` = **读不到** —— §19 那一格必须显示「未采集」，不许印成 0。
    ///
    /// 为什么非要有这一格：`rootBytesBefore/After` 与「预估释放」全是**逐路径表观大小之和**，
    /// 两边同口径，所以硬链接参与时它照样等于 0。没有一条磁盘侧的独立读数，
    /// §19 就是拿两笔同源账互相对账 —— 那是自证，不是验证。
    fn measure_free(&self, root: &str) -> Option<u64>;
}

/* ------------------------------------------------------------------ *
 * 任务视图数据形状
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CleanTaskStatus {
    Pending,
    Running,
    Completed,
    Cancelled,
    Refused,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CleanDeletionKind {
    File,
    Dir,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CleanOutcome {
    Ok,
    Failed,
    Cancelled,
}

/// 逐条删除结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanDeletion {
    pub path: String,
    pub kind: CleanDeletionKind,
    pub bytes: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errno: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempts: Option<u32>,
    /// **仅呈现字段**：判定路径不看它（与 TS 同一条纪律）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<CleanOutcome>,
}

/// **一条删除落下之后**的那次回报（2026-10-24）。
///
/// 为什么现在要有它：§18 的 `progress` 事件到 M6 为止只有 `done` 一种 —— 一批清理要等
/// `execute_cleanup` 整个返回，界面才第一次看到数字。真机上那表现为「点了清理，
/// 弹窗转了十几秒一个文件都没出现，然后突然整个列表刷出来、进度条直接 100%」。
/// 用户要的是「边清边滚」，那就必须**在删除发生的那一刻**把它送出去。
///
/// 三条纪律，与 `CleanLog` 那条同一位置、同一理由：
/// 1. **只观测，不判定**。这一格不参与任何一道闸、也不算进六个计数 —— 把它接进判定
///    会让"通知通道坏了"变成"删不下去"，那是反过来的。
/// 2. **没挂就不报**（`Option`），执行链照常跑完。
/// 3. 字段是**已经发生的事实**（这条删了没删掉、多大、第几条/共几条），不是预估。
///
/// `done`/`total` 与 `task.progress` 同一个分母（文件 + 目录），所以外面那一格进度条
/// 与这里滚出来的行数天然对得上，不会出现"列表 300 行而进度条说 12%"那种两套账。
#[derive(Debug, Clone)]
pub struct CleanProgressEvent {
    /// 刚刚落下的那一条（绝对路径，与 `CleanTask.deleted[].path` 同源）
    pub path: String,
    /// 这条是不是真删掉了。`false` = 失败（**不是**拒绝 —— 拒绝发生在动手之前，
    /// 不进进度，它进 `refusals[]`）
    pub ok: bool,
    /// 这条的字节数：成功 = 量到的表观大小；失败 = 0（与 `CleanTask.deleted[].bytes` 同口径）
    pub bytes: u64,
    /// 已经处理完几条
    pub done: usize,
    /// 这一批一共几条（文件 + 目录）
    pub total: usize,
    /// 累计释放字节（= `task.cleaned_size` 的当时值）
    pub cleaned_size: u64,
}

/// 进度上报的注入面。与 [`CleanLog`] 同形：执行器只认 trait，写盘/IPC 在外壳层。
///
/// `Send + Sync` 是被 `ExecuteCtx` 的用法逼出来的（它要跨 Tauri 的 IPC 线程），不是装饰。
pub trait CleanProgress: Send + Sync {
    fn tick(&self, ev: &CleanProgressEvent);
}

/// §19 清理后验证。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanVerification {
    pub root_bytes_before: u64,
    pub root_bytes_after: u64,
    /// before − after（可为负：清理期间别人在写）
    pub actual_freed_bytes: i64,
    pub predicted_freed_bytes: u64,
    /// 实际 unlink 成功的那些文件的字节和
    pub deleted_bytes: u64,
    pub delta_bytes: i64,
    pub files_before: u64,
    pub files_after: u64,
    /// 调用方没接这个读数时为 undefined，读不到为 null
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_bytes_before: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_bytes_after: Option<Option<u64>>,
    pub note: String,
}

/// §18 任务视图。字段名与 `shared/types.ts` `CleanTask` 逐字对应。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanTask {
    pub id: String,
    pub status: CleanTaskStatus,
    pub progress: f64,
    pub total_size: u64,
    pub cleaned_size: u64,
    pub success_count: u64,
    pub failed_count: u64,
    pub authorized_root: String,
    pub requested_paths: Vec<String>,
    pub accepted_paths: Vec<String>,
    pub blockers: Vec<CleanBlocker>,
    pub refusals: Vec<CleanRefusal>,
    pub deleted: Vec<CleanDeletion>,
    pub dirs_removed: Vec<String>,
    pub verification: Option<CleanVerification>,
    pub digest: String,
    /// 只写不读：归属表查询键，由调用方注入。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confirmation_digest: Option<String>,
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
}

/* ------------------------------------------------------------------ *
 * 执行上下文
 * ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy)]
pub struct Retry {
    pub max_attempts: u32,
    pub delay_ms: u64,
}

impl Default for Retry {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            delay_ms: 50,
        }
    }
}

/// 单次执行请求上下文。时钟、`cancel`、重试参数都由调用方注入。
#[derive(Clone)]
pub struct ExecuteCtx {
    pub id: String,
    pub authorized_root: String,
    pub requested_paths: Vec<String>,
    pub forbidden_patterns: Vec<String>,
    pub deny_roots: Vec<String>,
    pub report_only_patterns: Vec<String>,
    pub env: RuleEnv,
    pub retry: Retry,
    pub now_ms: i64,
    pub confirmation_digest: Option<String>,
    /// M6（免确认清理档）：真删（永久删除、不进回收站）通道的开关，默认 false（回收站）。
    /// true 时逐条删除走 `CleanFs::delete_permanently`，且**必须**带着 `confirmation_digest`
    /// —— 两道缺一，`run()` 开头的结构闸整批拒绝。只有 service 层的免确认清理链
    /// （`dc_auto_clean`）会把这一格打开；常规确认档（`run_cleanup`）恒为回收站。
    pub permanent: bool,
    pub cancel: Arc<AtomicBool>,
    /// §29 的落盘注入面（基准 `RunCleanOptions.logger`，`executor.ts:114`）：
    /// 每一次删除（成功/失败）与每一条拒绝都要一行，**在删除进行的那一刻**写，
    /// 不是事后从 `CleanTask` 摊平 —— 基准那句理由成立：「崩溃时不能丢最后几行」，
    /// 而日志最值钱的就是崩之前那几条（账本那本内存账在崩溃时整个没了，正是它补的位置）。
    ///
    /// 没有它执行链照常跑：这一格只**记账**，不参与任何判定（六道闸、六个计数、`status`
    /// 的算法都不看它一眼）。基准同样：logger 一写失败就 `broken = true` 从此不再写，
    /// 不拦删除。把它接进判定会让"日志文件写不下"变成"删不下去"，那是反过来的。
    pub log: Option<Arc<dyn CleanLog>>,
    /// §18 的**逐条**进度注入面（2026-10-24 加）。理由与代价写在 [`CleanProgressEvent`] 那段。
    /// 与 `log` 同一位置、同一条纪律：只观测、不判定，没挂就整段跳过。
    pub progress: Option<Arc<dyn CleanProgress>>,
    /// **共享的已处理计数**（2026-10-24 并发删除加）。多批并发跑时，各批的 `done` 要
    /// 加在一个跨批计数器上，报出去的事件才是「全局第几条」而不是「批内第几条」。
    /// `None` = 单批顺序跑（旧行为，逐字不变）。
    pub shared_done: Option<Arc<std::sync::atomic::AtomicUsize>>,
    /// **共享的累计释放字节**（2026-10-24 并发删除加）。同上：并发时各批的
    /// `cleaned_size` 是本批的，事件要报全局累计，界面那句「已释放 X」才不跳回 0。
    pub shared_cleaned: Option<Arc<std::sync::atomic::AtomicU64>>,
    /// **跳过 §19 前后测量**（2026-10-24 并发删除加）。多批并发时「先测再删再测」的
    /// 前后读数会互相污染（另一批删了这个根下的文件），所以只有**最后一批**做测量，
    /// 前几批跳过。`false` = 照常测量（旧行为）。
    pub skip_verification: bool,
}

impl fmt::Debug for ExecuteCtx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExecuteCtx")
            .field("id", &self.id)
            .field("authorized_root", &self.authorized_root)
            .field("requested_paths", &self.requested_paths)
            .field("forbidden_patterns", &self.forbidden_patterns)
            .field("deny_roots", &self.deny_roots)
            .field("report_only_patterns", &self.report_only_patterns)
            .field("env", &self.env)
            .field("retry", &self.retry)
            .field("now_ms", &self.now_ms)
            .field("confirmation_digest", &self.confirmation_digest)
            .field("permanent", &self.permanent)
            .field("cancel", &self.cancel.load(Ordering::Relaxed))
            .field("has_log", &self.log.is_some())
            .field("has_progress", &self.progress.is_some())
            .finish()
    }
}

impl ExecuteCtx {
    pub fn new(id: impl Into<String>, authorized_root: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            authorized_root: authorized_root.into(),
            requested_paths: Vec::new(),
            forbidden_patterns: Vec::new(),
            deny_roots: Vec::new(),
            report_only_patterns: Vec::new(),
            env: RuleEnv::new(),
            retry: Retry::default(),
            now_ms: 0,
            confirmation_digest: None,
            permanent: false,
            cancel: Arc::new(AtomicBool::new(false)),
            log: None,
            progress: None,
            shared_done: None,
            shared_cleaned: None,
            skip_verification: false,
        }
    }

    /// 挂上 §29 的落盘注入面。
    pub fn with_log(mut self, log: Arc<dyn CleanLog>) -> Self {
        self.log = Some(log);
        self
    }

    /// 挂上 §18 的逐条进度注入面。
    pub fn with_progress(mut self, progress: Arc<dyn CleanProgress>) -> Self {
        self.progress = Some(progress);
        self
    }

    /// 挂上**跨批共享的已处理计数**（并发删除，2026-10-24）。见字段注释。
    pub fn with_shared_done(mut self, counter: Arc<std::sync::atomic::AtomicUsize>) -> Self {
        self.shared_done = Some(counter);
        self
    }

    /// 挂上**跨批共享的累计释放字节**（并发删除，2026-10-24）。见字段注释。
    pub fn with_shared_cleaned(mut self, counter: Arc<std::sync::atomic::AtomicU64>) -> Self {
        self.shared_cleaned = Some(counter);
        self
    }

    /// 跳过 §19 前后测量（并发删除里只有最后一批测，2026-10-24）。见字段注释。
    pub fn with_skip_verification(mut self, skip: bool) -> Self {
        self.skip_verification = skip;
        self
    }

    /// 用**调用方持有的**取消标志替换内部那一个。
    ///
    /// 为什么要这一格：一次任务现在会跑多批（见 `service::execute_plan`），而
    /// `dc_cancel_cleanup` 拿到的是 `state.running` 里存的那一个 ctx —— 它只能立起
    /// **某一批**的标志。共享一个标志之后，"取消"对全部批次都生效，
    /// 而已经开跑的那一批照旧在它自己的循环里看到它。
    pub fn with_cancel_flag(mut self, cancel: Arc<AtomicBool>) -> Self {
        self.cancel = cancel;
        self
    }

    pub fn with_requested_paths(mut self, paths: Vec<String>) -> Self {
        self.requested_paths = paths;
        self
    }

    pub fn with_now_ms(mut self, now_ms: i64) -> Self {
        self.now_ms = now_ms;
        self
    }

    pub fn with_env(mut self, env: RuleEnv) -> Self {
        self.env = env;
        self
    }

    pub fn with_forbidden_patterns(mut self, patterns: Vec<String>) -> Self {
        self.forbidden_patterns = patterns;
        self
    }

    pub fn with_report_only_patterns(mut self, patterns: Vec<String>) -> Self {
        self.report_only_patterns = patterns;
        self
    }

    pub fn with_deny_roots(mut self, roots: Vec<String>) -> Self {
        self.deny_roots = roots;
        self
    }

    pub fn with_retry(mut self, retry: Retry) -> Self {
        self.retry = retry;
        self
    }

    pub fn with_confirmation_digest(mut self, digest: impl Into<String>) -> Self {
        self.confirmation_digest = Some(digest.into());
        self
    }

    /// M6：打开真删通道。授权凭据是**另一格**（`confirmation_digest`）—— 两道在
    /// `run()` 开头的结构闸汇合，缺一整批拒绝。builder 故意不做"传了 permanent 就顺带
    /// 免 digest"的合并：授权凭据与删除模式是两个正交的声明，合并会让"没带凭据的真删"
    /// 在构造处就静默成立。
    pub fn with_permanent(mut self, permanent: bool) -> Self {
        self.permanent = permanent;
        self
    }

    pub fn cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    fn should_cancel(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }
}

/* ------------------------------------------------------------------ *
 * 核心执行器
 * ------------------------------------------------------------------ */

/// 把带 `#[serde(rename_all = "kebab-case")]` 的枚举折成它的**线上串**。
///
/// 日志那一行要的是 `out-of-scope` 这样的串，与排除清单、账本、IPC 同一个口径 ——
/// 在这里再手写一遍 `match` 就是长出第四套理由名（这个项目已经数过三次这种账）。
/// 序列化成不了（理论上不可能，那几个枚举都有 kebab 名）时回**空串**而不是 panic：
/// 一行日志写歪了不该把删除拦下来。
fn wire<T: Serialize>(v: T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|x| x.as_str().map(str::to_string))
        .unwrap_or_default()
}

struct Executor<'a, FS: CleanFs + ?Sized> {
    ctx: &'a ExecuteCtx,
    fs: &'a FS,
    task: CleanTask,
    forbidden: ResolvedPatterns,
    deny: ResolvedPatterns,
    report_only: ResolvedPatterns,
    lstat_cache: HashMap<String, EntryKind>,
}

impl<'a, FS: CleanFs + ?Sized> Executor<'a, FS> {
    fn new(ctx: &'a ExecuteCtx, fs: &'a FS) -> Self {
        let task = CleanTask {
            id: ctx.id.clone(),
            status: CleanTaskStatus::Pending,
            progress: 0.0,
            total_size: 0,
            cleaned_size: 0,
            success_count: 0,
            failed_count: 0,
            authorized_root: ctx.authorized_root.clone(),
            requested_paths: ctx.requested_paths.clone(),
            accepted_paths: Vec::new(),
            blockers: Vec::new(),
            refusals: Vec::new(),
            deleted: Vec::new(),
            dirs_removed: Vec::new(),
            verification: None,
            digest: String::new(),
            confirmation_digest: ctx.confirmation_digest.clone(),
            started_at_ms: ctx.now_ms,
            finished_at_ms: ctx.now_ms,
        };
        let forbidden = resolve_roots(&ctx.forbidden_patterns, &ctx.env);
        let deny = resolve_roots(&ctx.deny_roots, &ctx.env);
        let report_only = resolve_roots(&ctx.report_only_patterns, &ctx.env);
        Self {
            ctx,
            fs,
            task,
            forbidden,
            deny,
            report_only,
            lstat_cache: HashMap::new(),
        }
    }

    fn root_probe(&self, p: &str) -> RootKind {
        match self.fs.lstat(p) {
            EntryKind::Directory => RootKind::Directory,
            EntryKind::File { .. } | EntryKind::Other => RootKind::NotADirectory,
            EntryKind::ReparsePoint => RootKind::ReparsePoint,
            EntryKind::Missing => RootKind::Missing,
            EntryKind::Unstatable => RootKind::Unstatable,
        }
    }

    fn refuse(&mut self, path: impl Into<String>, reason: CleanRefusalReason, detail: impl Into<String>, bytes: u64, overlap_of: Option<String>) {
        let path = path.into();
        // §29 的 `log?.clean(path, { status: 'refused', reason, task })`：msg 就是那条路径本身，
        // 与成功/失败那几条同一个形状（一行一件事，grep 一条路径能得到它的全部下场）。
        // `reason` 用**线上串**（kebab-case），与排除清单/账本同一个口径，不再立第四套理由名。
        let why = wire(reason);
        self.task.refusals.push(CleanRefusal {
            path: path.clone(),
            reason,
            detail: detail.into(),
            bytes,
            overlap_of,
        });
        self.log_line(&path, &[("status", Some(LogValue::Str("refused"))), ("reason", Some(LogValue::Str(&why))), ("task", Some(LogValue::Str(&self.task.id)))]);
    }

    /// 往注入面写一行；**没挂 logger 就整段跳过**。这一条路径不参与任何判定 ——
    /// 基准里 logger 写失败只是不再写，不拦删除。
    fn log_line(&self, msg: &str, fields: &[(&str, Option<LogValue<'_>>)]) {
        if let Some(l) = &self.ctx.log {
            l.clean(msg, fields);
        }
    }

    /// 往进度注入面报一条；**没挂就整段跳过**，与 [`Self::log_line`] 同一条纪律。
    ///
    /// ⚠️ 调用点必须落在「这条的结局已经写进 `task` 之后、循环下一次 `should_cancel` 之前」：
    /// 报出去的那几个数（`done`/`total`/`cleaned_size`/`ok`/`bytes`）全是**已发生的事实**，
    /// 提前报就会让界面上滚出来一行还没发生的事。
    ///
    /// `done` 的口径：挂了 `shared_done` 时（并发删除）用跨批计数器，
    /// `done` 参数被忽略 —— 调用点仍传批内数，这里只认共享的那个，避免两个口径打架。
    /// `cleaned_size` 同理：挂了 `shared_cleaned` 时，本批成功一条就把它累进去再报。
    fn report(&self, path: &str, ok: bool, bytes: u64, done: usize, total: usize) {
        let Some(p) = &self.ctx.progress else { return };
        let gdone = match &self.ctx.shared_done {
            Some(c) => c.fetch_add(1, Ordering::SeqCst) + 1,
            None => done,
        };
        let gcleaned = match &self.ctx.shared_cleaned {
            Some(c) => {
                if ok {
                    c.fetch_add(bytes, Ordering::SeqCst) + bytes
                } else {
                    c.load(Ordering::SeqCst)
                }
            }
            None => self.task.cleaned_size,
        };
        p.tick(&CleanProgressEvent {
            path: path.to_string(),
            ok,
            bytes,
            done: gdone,
            total,
            cleaned_size: gcleaned,
        });
    }

    fn lstat(&mut self, p: &str) -> EntryKind {
        let key = normalize_key(p);
        if let Some(hit) = self.lstat_cache.get(&key).copied() {
            return hit;
        }
        let kind = self.fs.lstat(p);
        self.lstat_cache.insert(key, kind);
        kind
    }

    fn blocked_hit(&self, p: &str) -> Option<(String, CleanRefusalReason, &'static str)> {
        if let Some(f) = is_forbidden_path(p, &self.forbidden.roots) {
            return Some((f, CleanRefusalReason::ForbiddenRoot, "§16 🔴 禁止路径"));
        }
        if let Some(d) = is_forbidden_path(p, &self.deny.roots) {
            return Some((d, CleanRefusalReason::ForbiddenRoot, "调用方追加的围栏"));
        }
        if let Some(r) = is_forbidden_path(p, &self.report_only.roots) {
            return Some((r, CleanRefusalReason::ReportOnlyRoot, "只上报根（占用如实报告，但任何规则都不可删）"));
        }
        None
    }

    fn first_reparse_ancestor(&mut self, path: &str, root_key: &str) -> Option<String> {
        // 只查授权根之内的那些祖先段
        let mut cur = parent_of(path);
        let mut chain: Vec<String> = Vec::new();
        while let Some(p) = cur {
            let key = normalize_key(&p);
            if key.len() <= root_key.len() || !key.starts_with(root_key) {
                break;
            }
            chain.insert(0, p.clone());
            cur = parent_of(&p);
        }
        for dir in chain {
            if let EntryKind::ReparsePoint = self.lstat(&dir) {
                return Some(dir);
            }
        }
        None
    }

    fn run(mut self) -> CleanTask {
        let root = self.ctx.authorized_root.clone();

        // §29 的第一行。基准把它放在 authorizedRoot 那三关**之前**（`executor.ts:260`），
        // 于是"整批被 authorizedRoot 拦下"的那一类在日志里是**有开头也有结尾**的一对，
        // 而不是无声消失；字段序也照抄 `{task, root, requested}`。
        let requested = self.ctx.requested_paths.len() as i64;
        self.log_line(
            "clean start",
            &[
                ("task", Some(LogValue::Str(&self.task.id))),
                ("root", Some(LogValue::Str(&root))),
                ("requested", Some(LogValue::Int(requested))),
            ],
        );

        // -------- M6 结构闸：真删通道必须带着确认回执 --------
        // `permanent` 与 `confirmation_digest` 缺一 ⇒ 整批拒绝，一个文件都不动。
        // service 层的免确认链（dc_auto_clean）两条都给；常规确认档 permanent 恒为 false。
        // 这道闸守的是执行器自己 —— 未来有人新开一条调用路径忘了带凭据时，这里是
        // 文件系统之前的最后一道，拒绝发生在**碰任何东西之前**。
        if self.ctx.permanent && self.ctx.confirmation_digest.is_none() {
            self.task.status = CleanTaskStatus::Refused;
            for p in &self.ctx.requested_paths {
                self.refuse(
                    p.clone(),
                    CleanRefusalReason::PermanentWithoutConfirmation,
                    "permanent（真删）上下文没带确认回执 → 删除模式有、授权凭据没有，整批拒绝",
                    0,
                    None,
                );
            }
            self.task.finished_at_ms = self.ctx.now_ms;
            let status = wire(self.task.status);
            self.log_line(
                "clean end",
                &[
                    ("task", Some(LogValue::Str(&self.task.id))),
                    ("status", Some(LogValue::Str(&status))),
                    ("blocked", Some(LogValue::Str("permanent-without-confirmation"))),
                    ("success", Some(LogValue::Int(0))),
                    ("failed", Some(LogValue::Int(0))),
                    ("cleanedSize", Some(LogValue::Int(0))),
                ],
            );
            return self.task;
        }

        // -------- authorizedRoot 三关 --------
        if let Err(blockers) = guard_authorized_root(
            &root,
            &self.forbidden,
            &self.deny,
            &self.report_only,
            |p| self.root_probe(p),
        ) {
            // `blocked` 那一格是**第一个 blocker 的理由**，不是全部（基准 `guard[0]?.reason ?? ''`）。
            // 要在 `blockers` 被 move 进 task 之后再取就没了，所以在这里读。
            let blocked = blockers.first().map(|b| wire(b.reason)).unwrap_or_default();
            self.task.status = CleanTaskStatus::Refused;
            self.task.blockers = blockers;
            let fallback_reason = if self.forbidden.is_unresolved() || self.report_only.is_unresolved() {
                CleanRefusalReason::ForbiddenRootsUnresolved
            } else {
                CleanRefusalReason::OutOfScope
            };
            for p in &self.ctx.requested_paths {
                self.refuse(
                    p.clone(),
                    fallback_reason,
                    "authorizedRoot 校验未通过 → 整批拒绝，一个文件都不动",
                    0,
                    None,
                );
            }
            self.task.finished_at_ms = self.ctx.now_ms;
            // 这一路的 `success/failed/cleanedSize` 写死 0（`executor.ts:295`），不读 task。
            // 今天**读与不读结果一样** —— 三关没过之前一条都没删，那几个计数本来就是 0，
            // 所以这一格没有判据可钉（M5-K 变异电池把这里改成读 task，一条用例都不红）。
            // 保留字面量是给未来的：这一路以后若开始记账，那三格的含义仍是"什么都没发生"。
            let status = wire(self.task.status);
            self.log_line(
                "clean end",
                &[
                    ("task", Some(LogValue::Str(&self.task.id))),
                    ("status", Some(LogValue::Str(&status))),
                    ("blocked", Some(LogValue::Str(&blocked))),
                    ("success", Some(LogValue::Int(0))),
                    ("failed", Some(LogValue::Int(0))),
                    ("cleanedSize", Some(LogValue::Int(0))),
                ],
            );
            return self.task;
        }

        let root_key = normalize_key(&root);

        // -------- 闸 1：越界 / 重叠 --------
        #[derive(Clone)]
        struct Item {
            path: String,
            key: String,
        }

        let mut survivors: Vec<Item> = Vec::new();
        let mut escape_sources: Vec<String> = Vec::new();

        for raw in &self.ctx.requested_paths {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                self.refuse(raw.clone(), CleanRefusalReason::MalformedPath, "路径必须是非空字符串 → 这条不处理", 0, None);
                escape_sources.push(normalize_key(raw));
                continue;
            }
            let p = trimmed.to_string();
            let key = normalize_key(&p);
            if let Err(r) = classify_path(&p, &root, &self.forbidden, &self.report_only) {
                // classify_path 把「在授权根内的禁止路径」放行了；这里把其余拒绝理由落盘。
                // 但 equals-authorized-root / out-of-scope / forbidden-root(report-only-root) 外的拒绝
                // 已经在 classify_path 里给出，且它不知道 deny 根，所以 blocked_hit 要再查一次 deny 根，
                // 给越界路径点出最狠的那个理由。
                let (reason, detail, escaped) = match r.reason {
                    CleanRefusalReason::OutOfScope => {
                        if let Some((hit, reason, label)) = self.blocked_hit(&p) {
                            (
                                reason,
                                format!("命中 {label} {hit}（且不在授权根 {root} 内）→ 拒绝"),
                                true,
                            )
                        } else {
                            (r.reason, r.detail, true)
                        }
                    }
                    _ => (r.reason, r.detail, true),
                };
                self.refuse(p.clone(), reason, detail, 0, None);
                if escaped {
                    escape_sources.push(key);
                }
                continue;
            }
            survivors.push(Item { path: p, key });
        }

        let in_scope: Vec<Item> = survivors
            .into_iter()
            .filter(|it| {
                if let Some(src) = escape_sources.iter().find(|src| is_strictly_inside(&it.key, src) || it.key == **src) {
                    self.refuse(
                        it.path.clone(),
                        CleanRefusalReason::OverlapsOutOfScope,
                        format!("与越界请求 {src} 重叠 → 不许只删这个批次里看起来安全的那部分"),
                        0,
                        Some(src.clone()),
                    );
                    return false;
                }
                true
            })
            .collect();

        // -------- 闸 2b / 闸 3 / 闸 4：逐条定性 --------
        let mut files: Vec<Item> = Vec::new();
        let mut dirs: Vec<Item> = Vec::new();
        let mut sizes: HashMap<String, u64> = HashMap::new();
        let mut seen: HashSet<String> = HashSet::new();

        for it in in_scope {
            if seen.contains(&it.key) {
                continue; // 同一路径重复出现只处理一次
            }
            seen.insert(it.key.clone());

            if let Some((hit, reason, label)) = self.blocked_hit(&it.path) {
                self.refuse(
                    it.path.clone(),
                    reason,
                    format!("命中 {label} {hit} → 即使在授权根内也不删（复用引擎的同一判据）"),
                    0,
                    None,
                );
                continue;
            }

            match self.lstat(&it.path) {
                EntryKind::Missing => {
                    self.refuse(
                        it.path.clone(),
                        CleanRefusalReason::NotFound,
                        "lstat 就 ENOENT：目标不存在 → 记「跳过文件」（§29），不冒充删除失败",
                        0,
                        None,
                    );
                }
                EntryKind::Unstatable => {
                    self.refuse(
                        it.path.clone(),
                        CleanRefusalReason::Unstatable,
                        "lstat 读不到（权限/IO 错误）：既证不出它是普通文件，也证不出它不是 reparse point → 拒绝",
                        0,
                        None,
                    );
                }
                EntryKind::ReparsePoint => {
                    self.refuse(
                        it.path.clone(),
                        CleanRefusalReason::ReparsePoint,
                        "最后一段是重解析点（symlink/junction）→ 不跟随、不删除（与 core/fs 的 kind=other 同口径）",
                        0,
                        None,
                    );
                }
                kind => {
                    if let Some(ancestor) = self.first_reparse_ancestor(&it.path, &root_key) {
                        self.refuse(
                            it.path.clone(),
                            CleanRefusalReason::ReparseAncestor,
                            format!("路径中间的 {ancestor} 是重解析点 → 跟随它会删到授权根之外的真实位置，一律拒绝"),
                            kind.file_size().unwrap_or(0),
                            Some(ancestor),
                        );
                        continue;
                    }
                    match kind {
                        EntryKind::File { size } => {
                            files.push(it.clone());
                            sizes.insert(it.key, size);
                        }
                        EntryKind::Directory => {
                            dirs.push(it.clone());
                            sizes.insert(it.key, 0);
                        }
                        _ => {
                            self.refuse(
                                it.path.clone(),
                                CleanRefusalReason::NotADeletableEntry,
                                "既不是文件也不是目录（管道/设备/reparse 之类）→ 无可删语义",
                                0,
                                None,
                            );
                        }
                    }
                }
            }
        }

        self.task.accepted_paths = files.iter().chain(dirs.iter()).map(|i| i.path.clone()).collect();
        self.task.digest = execution_digest(&self.task.authorized_root, &self.task.accepted_paths);
        self.task.total_size = files.iter().map(|i| sizes.get(&i.key).copied().unwrap_or(0)).sum();

        // -------- §19 before 读数 --------
        // 并发删除时只有最后一批测（`skip_verification` 置位的前几批跳过）——
        // 否则"先测再删再测"的前后读数会被并发的另一批污染。
        let before = self.fs.measure(&self.task.authorized_root);
        // 可用空间必须在动手**之前**取：晚一步就把它和删除效果混在一起了。
        let free_before = self.fs.measure_free(&self.task.authorized_root);

        // -------- 开删 --------
        self.task.status = CleanTaskStatus::Running;
        let total = files.len() + dirs.len();
        let mut done = 0usize;

        for it in files {
            if self.ctx.should_cancel() {
                self.task.status = CleanTaskStatus::Cancelled;
                break;
            }
            let size = sizes.get(&it.key).copied().unwrap_or(0);
            let r = self.try_remove(&it.path);
            match r {
                RemoveOutcome::Ok { attempts } => {
                    self.task.success_count += 1;
                    self.task.cleaned_size += size;
                    self.task.deleted.push(CleanDeletion {
                        path: it.path.clone(),
                        kind: CleanDeletionKind::File,
                        bytes: size,
                        ok: true,
                        errno: None,
                        detail: None,
                        attempts: Some(attempts),
                        outcome: Some(CleanOutcome::Ok),
                    });
                    self.log_line(
                        &it.path,
                        &[
                            ("status", Some(LogValue::Str("success"))),
                            ("size", Some(LogValue::Int(size as i64))),
                            ("kind", Some(LogValue::Str("file"))),
                            ("attempts", Some(LogValue::Int(attempts as i64))),
                            ("task", Some(LogValue::Str(&self.task.id))),
                        ],
                    );
                    // 账本与日志都写完、`cleaned_size` 已经加过才报 —— 报的是事实，不是打算
                    self.report(&it.path, true, size, done + 1, total);
                }
                RemoveOutcome::Vanished { attempts } => {
                    self.refuse(
                        it.path.clone(),
                        CleanRefusalReason::NotFound,
                        format!("第 {attempts} 次尝试时 ENOENT：文件已被其他程序删掉 → 记「跳过文件」（§9 / §29），不冒充删除失败"),
                        0,
                        None,
                    );
                }
                RemoveOutcome::Failed { attempts, errno, detail, cancelled } => {
                    self.task.failed_count += 1;
                    self.task.deleted.push(CleanDeletion {
                        path: it.path.clone(),
                        kind: CleanDeletionKind::File,
                        bytes: 0,
                        ok: false,
                        errno: Some(errno.clone()),
                        detail: Some(if cancelled {
                            format!("{detail}；重试到第 {attempts} 次前收到取消 → 停手（§28 原则六）")
                        } else {
                            detail
                        }),
                        attempts: Some(attempts),
                        outcome: Some(if cancelled { CleanOutcome::Cancelled } else { CleanOutcome::Failed }),
                    });
                    // 注意 `size` 这一格：账本行里那条删除记的是 **0 字节**（没删掉就没有释放），
                    // 而日志这一行写的是**量到的**大小 —— 基准就是这两套（`executor.ts:473` 用 `size`，
                    // 同一批的 `deleted[]` 行写 `bytes: 0`）。含义不同：日志答"这条多大、为什么没成"，
                    // 账本答"这次真腾出了多少"。照抄，不把它抹平成同一个数。
                    self.log_line(
                        &it.path,
                        &[
                            ("status", Some(LogValue::Str("failed"))),
                            ("size", Some(LogValue::Int(size as i64))),
                            ("errno", Some(LogValue::Str(&errno))),
                            ("kind", Some(LogValue::Str("file"))),
                            ("attempts", Some(LogValue::Int(attempts as i64))),
                            ("task", Some(LogValue::Str(&self.task.id))),
                        ],
                    );
                    // 失败也报：界面上那一行是红的，而不是"没发生"。`bytes` 记 0，
                    // 与 `deleted[].bytes` 同口径（没删掉就没有释放）。
                    self.report(&it.path, false, 0, done + 1, total);
                    if cancelled {
                        self.task.status = CleanTaskStatus::Cancelled;
                    }
                }
            }
            done += 1;
            self.task.progress = if total > 0 { done as f64 / total as f64 } else { 1.0 };
            if self.task.status == CleanTaskStatus::Cancelled {
                break;
            }
        }

        if self.task.status != CleanTaskStatus::Cancelled {
            // 目录按深度从深到浅：子目录先变空
            let mut ordered = dirs;
            ordered.sort_by(|a, b| {
                let depth_a = segs_of(&a.path).len();
                let depth_b = segs_of(&b.path).len();
                depth_b.cmp(&depth_a).then_with(|| crate::digest::cmp_utf16(&a.path, &b.path))
            });
            for it in ordered {
                if self.ctx.should_cancel() {
                    self.task.status = CleanTaskStatus::Cancelled;
                    break;
                }
                let r = self.try_remove(&it.path);
                match r {
                    RemoveOutcome::Ok { attempts } => {
                        self.task.success_count += 1;
                        self.task.dirs_removed.push(it.path.clone());
                        self.task.deleted.push(CleanDeletion {
                            path: it.path.clone(),
                            kind: CleanDeletionKind::Dir,
                            bytes: 0,
                            ok: true,
                            errno: None,
                            detail: None,
                            attempts: Some(attempts),
                            outcome: Some(CleanOutcome::Ok),
                        });
                        self.log_line(
                            &it.path,
                            &[
                                ("status", Some(LogValue::Str("success"))),
                                ("size", Some(LogValue::Int(0))),
                                ("kind", Some(LogValue::Str("dir"))),
                                ("attempts", Some(LogValue::Int(attempts as i64))),
                                ("task", Some(LogValue::Str(&self.task.id))),
                            ],
                        );
                        self.report(&it.path, true, 0, done + 1, total);
                    }
                    RemoveOutcome::Vanished { attempts } => {
                        self.refuse(
                            it.path.clone(),
                            CleanRefusalReason::NotFound,
                            format!("第 {attempts} 次尝试时目录已不存在（别的程序先删了它）→ 记「跳过」（§9），不冒充删除失败"),
                            0,
                            None,
                        );
                    }
                    RemoveOutcome::Failed { attempts, errno, detail, cancelled } => {
                        self.task.failed_count += 1;
                        self.task.deleted.push(CleanDeletion {
                            path: it.path.clone(),
                            kind: CleanDeletionKind::Dir,
                            bytes: 0,
                            ok: false,
                            errno: Some(errno.clone()),
                            detail: Some(if cancelled {
                                format!("{detail}；重试到第 {attempts} 次前收到取消 → 停手（§28 原则六）")
                            } else {
                                detail
                            }),
                            attempts: Some(attempts),
                            outcome: Some(if cancelled { CleanOutcome::Cancelled } else { CleanOutcome::Failed }),
                        });
                        // 同文件那一处：这一行写"量到的大小"没意义，目录那一路基准给的就是 `size: 0`。
                        self.log_line(
                            &it.path,
                            &[
                                ("status", Some(LogValue::Str("failed"))),
                                ("size", Some(LogValue::Int(0))),
                                ("errno", Some(LogValue::Str(&errno))),
                                ("kind", Some(LogValue::Str("dir"))),
                                ("attempts", Some(LogValue::Int(attempts as i64))),
                                ("task", Some(LogValue::Str(&self.task.id))),
                            ],
                        );
                        self.report(&it.path, false, 0, done + 1, total);
                        if cancelled {
                            self.task.status = CleanTaskStatus::Cancelled;
                        }
                    }
                }
                done += 1;
                self.task.progress = if total > 0 { done as f64 / total as f64 } else { 1.0 };
                if self.task.status == CleanTaskStatus::Cancelled {
                    break;
                }
            }
        }

        if self.task.status != CleanTaskStatus::Cancelled {
            self.task.status = CleanTaskStatus::Completed;
        }
        if total == 0 && self.task.blockers.is_empty() {
            self.task.progress = 1.0;
        }
        self.task.finished_at_ms = self.ctx.now_ms;

        // -------- §19 清理后验证 --------
        // 并发删除时前几批跳过（`skip_verification`）—— 它们的 before/after 会被并发批污染，
        // 合并任务里的验证只认最后一批测出来的那一份。
        if self.ctx.skip_verification {
            self.task.verification = None;
        } else {
            self.task.verification = self.build_verification(&before, free_before);
        }

        // §29 的最后一行，字段序照抄 `executor.ts:553-561`。
        // `actualFreedBytes` 走 `Option`：验证那格没做成时它**整段不出现**（基准给 undefined，
        // 格式化函数把 undefined 的字段跳过），而不是印成 `actualFreedBytes=0` ——
        // 后者会把"没量到"读成"量到 0 字节"，而这一格正是全场最容易被误读的那一个。
        //
        // ⚠️ `ms` 这一格在 Tauri 侧**恒为 0**，且不是巧合：`started_at_ms` 与
        // `finished_at_ms` 都取注入的那一个 `now_ms`（本模块按纪律不读 `SystemTime`，
        // 结果要可复现），而基准是 `o.nowMs ?? Date.now()` 在两头各读一次墙钟 —— 生产里
        // `nowMs` 不注入，所以它拿到的是真耗时。要换成真值就得把"时钟"从**一个数**改成
        // **一个函数**，那是执行器契约的改动（几十个测试的 `with_now_ms(0)` 全跟着动），
        // 换的只是日志里一格时长。**登记为已知差**（验收文档 §没做），别把这格当耗时读。
        let status = wire(self.task.status);
        let freed = self.task.verification.as_ref().map(|v| v.actual_freed_bytes);
        let ms = self.task.finished_at_ms - self.task.started_at_ms;
        self.log_line(
            "clean end",
            &[
                ("task", Some(LogValue::Str(&self.task.id))),
                ("status", Some(LogValue::Str(&status))),
                ("success", Some(LogValue::Int(self.task.success_count as i64))),
                ("failed", Some(LogValue::Int(self.task.failed_count as i64))),
                ("refused", Some(LogValue::Int(self.task.refusals.len() as i64))),
                ("cleanedSize", Some(LogValue::Int(self.task.cleaned_size as i64))),
                ("actualFreedBytes", freed.map(LogValue::Int)),
                ("ms", Some(LogValue::Int(ms))),
            ],
        );

        self.task
    }

    /// §19 清理后验证：把「删完之后」的读数算成那一格（2026-10-24 从 `run` 里抽出来，
    /// 让 `skip_verification` 的早退路径不复制这段）。口径与抽出来之前逐字相同。
    fn build_verification(&self, before: &MeasureResult, free_before: Option<u64>) -> Option<CleanVerification> {
        let after = self.fs.measure(&self.task.authorized_root);
        let free_after = self.fs.measure_free(&self.task.authorized_root);
        let actual = before.bytes.saturating_sub(after.bytes) as i64;
        let free_pair = match (free_before, free_after) {
            (Some(b), Some(a)) => Some(format!("{b} → {a}")),
            _ => None,
        };
        Some(CleanVerification {
            root_bytes_before: before.bytes,
            root_bytes_after: after.bytes,
            actual_freed_bytes: actual,
            predicted_freed_bytes: self.task.total_size,
            deleted_bytes: self.task.cleaned_size,
            delta_bytes: actual - self.task.total_size as i64,
            files_before: before.files,
            files_after: after.files,
            free_bytes_before: Some(free_before),
            free_bytes_after: Some(free_after),
            note: if actual as u64 == self.task.total_size {
                format!(
                    "§19 对账：授权根表观大小 {} → {} 字节。预估 {} 与前后差 {} 在这套「逐路径表观大小之和」的口径下相等 —— 相等只证明两笔表观账互相吻合，不证明磁盘真省下了这些字节：硬链接的名字删掉只减链接计数、表观照样少一份，簇大小与备用数据流同理。{}",
                    before.bytes,
                    after.bytes,
                    self.task.total_size,
                    actual,
                    match &free_pair {
                        Some(p) => format!("磁盘侧的独立读数是可用空间 {p}，那一格才是「盘上真省了多少」。"),
                        None => "本次没采到卷的可用空间，所以磁盘那一侧没有独立读数 —— 上面那句就是唯一的口径依据。".to_string(),
                    }
                )
            } else {
                format!(
                    "§19 对账：工作单表观合计 {} 字节，授权根表观大小前后差 {} 字节（差额 {}）。两个数字都如实报告，而它们都是「逐路径表观大小之和」—— 磁盘簇占用、备用数据流、清理期间的并发写入都会造成差，硬链接则会造成反方向的假性一致（两边同样都不看 inode）；磁盘上真省了多少看{}",
                    self.task.total_size,
                    actual,
                    actual - self.task.total_size as i64,
                    match &free_pair {
                        Some(_) => "下面的可用空间（§35.2 已知偏差）",
                        None => "不到可用空间这一格 —— 本次没采到它",
                    }
                )
            },
        })
    }

    fn try_remove(&mut self, path: &str) -> RemoveOutcome {
        let max_attempts = self.ctx.retry.max_attempts.max(1);
        let delay = Duration::from_millis(self.ctx.retry.delay_ms);
        let mut attempts: u32 = 0;
        loop {
            attempts += 1;
            if self.ctx.should_cancel() && attempts > 1 {
                // 退避期间收到取消：记 cancelled，已删的不复活
                return RemoveOutcome::Failed {
                    attempts,
                    errno: "CANCELLED".into(),
                    detail: "重试退避期间收到取消".into(),
                    cancelled: true,
                };
            }
            // M6：删除模式由 ctx 声明，执行器只做路由 —— 两条通道共用同一套重试/取消/
            // vanished 分类，错误语义也同源（`classify_shfile_error`）。
            let removed = if self.ctx.permanent {
                self.fs.delete_permanently(path)
            } else {
                self.fs.recycle(path)
            };
            match removed {
                Ok(()) => return RemoveOutcome::Ok { attempts },
                Err(e) => {
                    if e.kind == RecycleErrorKind::Permanent {
                        // lstat 与 recycle 之间目标被别的程序删了 ⇒ 记「跳过」（§9 / §29），
                        // **不冒充删除失败**。TS 同一处是 `executor.ts:497` 的 `vanished` 分支；
                        // 消费侧（两个 `RemoveOutcome::Vanished` 臂）早就写好了，缺的一直是这里 ——
                        // 少了它，`failed_count` 会把"本来就不存在"报成"删失败"。
                        if e.errno == "ENOENT" {
                            return RemoveOutcome::Vanished { attempts };
                        }
                        return RemoveOutcome::Failed {
                            attempts,
                            errno: e.errno,
                            detail: e.detail,
                            cancelled: false,
                        };
                    }
                    if attempts >= max_attempts {
                        return RemoveOutcome::Failed {
                            attempts,
                            errno: e.errno,
                            detail: e.detail,
                            cancelled: false,
                        };
                    }
                    if self.ctx.should_cancel() {
                        return RemoveOutcome::Failed {
                            attempts,
                            errno: e.errno,
                            detail: e.detail,
                            cancelled: true,
                        };
                    }
                    if self.ctx.retry.delay_ms > 0 {
                        thread::sleep(delay);
                    }
                }
            }
        }
    }
}

enum RemoveOutcome {
    Ok { attempts: u32 },
    Vanished { attempts: u32 },
    Failed { attempts: u32, errno: String, detail: String, cancelled: bool },
}

pub fn execute_cleanup(ctx: &ExecuteCtx, fs: &impl CleanFs) -> CleanTask {
    Executor::new(ctx, fs).run()
}

/* ------------------------------------------------------------------ *
 * Windows 生产实现：SHFileOperationW + FOF_ALLOWUNDO
 * ------------------------------------------------------------------ */

#[cfg(windows)]
pub struct WindowsCleanFs;

#[cfg(windows)]
impl WindowsCleanFs {
    pub fn new() -> Self {
        Self
    }
}

#[cfg(windows)]
impl CleanFs for WindowsCleanFs {
    fn lstat(&self, path: &str) -> EntryKind {
        match std::fs::symlink_metadata(path) {
            Ok(m) => {
                if m.is_symlink() {
                    EntryKind::ReparsePoint
                } else if m.is_dir() {
                    EntryKind::Directory
                } else if m.is_file() {
                    EntryKind::File { size: m.len() }
                } else {
                    EntryKind::Other
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => EntryKind::Missing,
            Err(_) => EntryKind::Unstatable,
        }
    }

    fn recycle(&self, path: &str) -> Result<(), RecycleError> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{FOF_ALLOWUNDO, FO_DELETE, SHFileOperationW, SHFILEOPSTRUCTW};

        // pFrom 必须是双 null 结尾的宽字符串
        let mut wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
        wide.push(0);
        let mut op = SHFILEOPSTRUCTW {
            hwnd: std::ptr::null_mut(),
            wFunc: FO_DELETE,
            pFrom: wide.as_ptr(),
            pTo: std::ptr::null(),
            fFlags: (FOF_ALLOWUNDO as u16) | FOF_NO_UI_FLAGS,
            fAnyOperationsAborted: 0,
            hNameMappings: std::ptr::null_mut(),
            lpszProgressTitle: std::ptr::null(),
        };
        let rc = unsafe { SHFileOperationW(&mut op) };
        if rc == 0 {
            Ok(())
        } else {
            Err(classify_shfile_error(rc))
        }
    }

    /// M6：真删 —— FO_DELETE **不带** `FOF_ALLOWUNDO`，文件不经过回收站、立即释放。
    /// 与 `recycle` 的差别就这一个标志位；错误分类同 `classify_shfile_error`。
    /// 这条通道只对「`permanent: true` **且** 带确认回执」的上下文开放（`run()` 开头的结构闸）。
    fn delete_permanently(&self, path: &str) -> Result<(), RecycleError> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{FO_DELETE, SHFileOperationW, SHFILEOPSTRUCTW};

        // pFrom 必须是双 null 结尾的宽字符串
        let mut wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
        wide.push(0);
        let mut op = SHFILEOPSTRUCTW {
            hwnd: std::ptr::null_mut(),
            wFunc: FO_DELETE,
            pFrom: wide.as_ptr(),
            pTo: std::ptr::null(),
            // ⚠️ 刻意**不带** FOF_ALLOWUNDO：带了就进回收站，等于把真删语义架空。
            // FOF_NO_UI_FLAGS 保留（静默、不确认、不弹错误框 —— 与 recycle 同一纪律）。
            fFlags: FOF_NO_UI_FLAGS,
            fAnyOperationsAborted: 0,
            hNameMappings: std::ptr::null_mut(),
            lpszProgressTitle: std::ptr::null(),
        };
        let rc = unsafe { SHFileOperationW(&mut op) };
        if rc == 0 {
            Ok(())
        } else {
            Err(classify_shfile_error(rc))
        }
    }

    fn measure(&self, root: &str) -> MeasureResult {
        measure_dir(root)
    }

    fn measure_free(&self, root: &str) -> Option<u64> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let mut wide: Vec<u16> = OsStr::new(root).encode_wide().chain(Some(0)).collect();
        let mut free_available = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(wide.as_mut_ptr(), &mut free_available, std::ptr::null_mut(), std::ptr::null_mut())
        };
        // 返回的是 BOOL：0 = 失败。盘符根之外的路径 Win32 也认（它向上找到卷）。
        if ok != 0 {
            Some(free_available)
        } else {
            None
        }
    }
}

#[cfg(windows)]
const FOF_NO_UI_FLAGS: u16 = 0x0414; // FOF_SILENT (0x0004) | FOF_NOCONFIRMATION (0x0010) | FOF_NOERRORUI (0x0400)

#[cfg(windows)]
fn classify_shfile_error(rc: i32) -> RecycleError {
    use windows_sys::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_BUSY, ERROR_FILE_NOT_FOUND, ERROR_LOCK_VIOLATION,
        ERROR_NOT_READY, ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION,
    };
    let errno = format!("WIN32_{rc}");
    match rc as u32 {
        ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION | ERROR_BUSY | ERROR_NOT_READY => {
            RecycleError::transient(errno, format!("SHFileOperationW 返回 {rc}，按瞬态错误处理"))
        }
        ERROR_ACCESS_DENIED => RecycleError::permanent(errno, format!("SHFileOperationW 拒绝访问（{rc}）")),
        ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => {
            RecycleError::permanent("ENOENT", format!("SHFileOperationW 找不到路径（{rc}）"))
        }
        _ => RecycleError::permanent(errno, format!("SHFileOperationW 失败，代码 {rc}")),
    }
}

fn measure_dir(root: &str) -> MeasureResult {
    let mut bytes = 0u64;
    let mut files = 0u64;
    let _ = measure_dir_recursive(root, &mut bytes, &mut files);
    MeasureResult { bytes, files }
}

fn measure_dir_recursive(dir: &str, bytes: &mut u64, files: &mut u64) -> Result<(), std::io::Error> {
    for entry in std::fs::read_dir(dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let path_str = path.to_string_lossy().to_string();
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_symlink() {
            continue; // 不跟随重解析点
        }
        if meta.is_dir() {
            let _ = measure_dir_recursive(&path_str, bytes, files);
        } else if meta.is_file() {
            *files += 1;
            *bytes += meta.len();
        }
    }
    Ok(())
}

fn segs_of(p: &str) -> Vec<String> {
    p.replace('/', "\\").split('\\').filter(|s| !s.is_empty()).map(String::from).collect()
}

fn parent_of(p: &str) -> Option<String> {
    let slashed = p.replace('/', "\\");
    let trimmed = slashed.trim_end_matches('\\');
    trimmed.rfind('\\').map(|i| trimmed[..i].to_string())
}

/* ------------------------------------------------------------------ *
 * 合成 fs（测试专用）
 * ------------------------------------------------------------------ */

#[cfg(test)]
#[derive(Debug, Clone, Default)]
pub struct SyntheticFs {
    entries: HashMap<String, SyntheticEntry>,
    fail_recycle: HashMap<String, (RecycleError, u32)>,
    /// 第 n 次 recycle 调用时把这个 ctx 的取消立起来（确定性取消，不靠线程 sleep）。
    cancel_on_recycle: Option<(u32, ExecuteCtx)>,
    /// §19 磁盘侧独立读数。`None` = 这台"机器"读不到可用空间（那一格必须显示「未采集」）。
    free_bytes: Option<u64>,
    /// 第二次读数相对第一次的增量（模拟"真的腾出了空间"）。
    free_delta_after: u64,
    free_calls: u32,
    /// 调用过 recycle 的路径（成功也算）。
    pub recycled: Vec<String>,
    /// M6：调用过 delete_permanently 的路径（成功也算）—— 与 `recycled` 分开记，
    /// 路由测试要证明两条通道**互不串线**。
    pub permanently_deleted: Vec<String>,
}

#[cfg(test)]
#[derive(Debug, Clone)]
pub enum SyntheticEntry {
    File { size: u64 },
    Dir,
    Reparse,
    Other,
    Unstatable,
}

#[cfg(test)]
impl SyntheticFs {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_file(mut self, path: impl Into<String>, size: u64) -> Self {
        self.entries.insert(path.into(), SyntheticEntry::File { size });
        self
    }

    pub fn with_dir(mut self, path: impl Into<String>) -> Self {
        self.entries.insert(path.into(), SyntheticEntry::Dir);
        self
    }

    pub fn with_reparse(mut self, path: impl Into<String>) -> Self {
        self.entries.insert(path.into(), SyntheticEntry::Reparse);
        self
    }

    pub fn with_other(mut self, path: impl Into<String>) -> Self {
        self.entries.insert(path.into(), SyntheticEntry::Other);
        self
    }

    pub fn with_unstatable(mut self, path: impl Into<String>) -> Self {
        self.entries.insert(path.into(), SyntheticEntry::Unstatable);
        self
    }

    /// 把 `path` 摆成 `guard_authorized_root` 探针要的那个 `RootKind`。
    /// 没有这个 helper 的话，测试里的 `kind` 只能靠"恰好没建那个目录"来间接模拟 ——
    /// 那种写法会让 `NotADirectory` 与 `Missing` 撞成同一条分支（都是"根不在 entries 里"）。
    pub fn with_kind(mut self, path: &str, kind: RootKind) -> Self {
        match kind {
            RootKind::Directory => self.entries.insert(path.into(), SyntheticEntry::Dir),
            RootKind::NotADirectory => self.entries.insert(path.into(), SyntheticEntry::File { size: 1 }),
            RootKind::ReparsePoint => self.entries.insert(path.into(), SyntheticEntry::Reparse),
            RootKind::Unstatable => self.entries.insert(path.into(), SyntheticEntry::Unstatable),
            RootKind::Missing => self.entries.remove(path),
        };
        self
    }

    /// 设置某条路径第几次 recycle 会失败；succeed_after 表示第几次失败后成功（0 = 每次都失败）。
    pub fn with_recycle_failure(mut self, path: impl Into<String>, err: RecycleError, succeed_after: u32) -> Self {
        self.fail_recycle.insert(path.into(), (err, succeed_after));
        self
    }

    /// 第 `n` 次 recycle 调用时把 `ctx` 的取消标志立起来。
    /// 取消必须**确定性**触发：靠 `thread::sleep(5ms)` 再 cancel 的写法，在批量只有两个文件的
    /// 时候整批早就跑完了，测到的其实是"没取消"那条分支。
    pub fn with_cancel_on_recycle(mut self, n: u32, ctx: ExecuteCtx) -> Self {
        self.cancel_on_recycle = Some((n, ctx));
        self
    }

    /// 给合成 fs 一条磁盘侧的可用空间读数；`None` 表示"这台机器问不出来"。
    pub fn with_free_bytes(mut self, before: Option<u64>, delta_after: u64) -> Self {
        self.free_bytes = before;
        self.free_delta_after = delta_after;
        self
    }

    pub fn exists(&self, path: &str) -> bool {
        self.entries.contains_key(path)
    }
}

#[cfg(test)]
impl SyntheticFs {
    fn lstat_impl(&self, path: &str) -> EntryKind {
        match self.entries.get(path) {
            Some(SyntheticEntry::File { size }) => EntryKind::File { size: *size },
            Some(SyntheticEntry::Dir) => EntryKind::Directory,
            Some(SyntheticEntry::Reparse) => EntryKind::ReparsePoint,
            Some(SyntheticEntry::Other) => EntryKind::Other,
            Some(SyntheticEntry::Unstatable) => EntryKind::Unstatable,
            None => EntryKind::Missing,
        }
    }

    fn measure_impl(&self, root: &str) -> MeasureResult {
        let root_key = normalize_key(root);
        let prefix = if root_key.ends_with('\\') { root_key } else { format!("{}\\", root_key) };
        let mut bytes = 0u64;
        let mut files = 0u64;
        for (p, e) in &self.entries {
            if p == root {
                continue;
            }
            if !normalize_key(p).starts_with(&prefix) {
                continue;
            }
            if let SyntheticEntry::File { size } = e {
                files += 1;
                bytes += *size;
            }
        }
        MeasureResult { bytes, files }
    }
}

#[cfg(test)]
#[derive(Clone, Default)]
pub struct SyntheticFsRefCell {
    inner: std::rc::Rc<std::cell::RefCell<SyntheticFs>>,
}

#[cfg(test)]
impl SyntheticFsRefCell {
    pub fn new(fs: SyntheticFs) -> Self {
        Self {
            inner: std::rc::Rc::new(std::cell::RefCell::new(fs)),
        }
    }

    pub fn borrow(&self) -> std::cell::Ref<'_, SyntheticFs> {
        self.inner.borrow()
    }

    pub fn borrow_mut(&self) -> std::cell::RefMut<'_, SyntheticFs> {
        self.inner.borrow_mut()
    }
}

#[cfg(test)]
impl CleanFs for SyntheticFsRefCell {
    fn lstat(&self, path: &str) -> EntryKind {
        self.inner.borrow().lstat_impl(path)
    }

    fn recycle(&self, path: &str) -> Result<(), RecycleError> {
        let mut fs = self.inner.borrow_mut();
        fs.recycled.push(path.to_string());
        let n = fs.recycled.len() as u32;
        if let Some((at, ctx)) = fs.cancel_on_recycle.clone() {
            if n >= at {
                ctx.cancel();
            }
        }
        if let Some((err, succeed_after)) = fs.fail_recycle.get(path).cloned() {
            let count = fs.recycled.iter().filter(|p| *p == path).count() as u32;
            // `succeed_after` = 容忍连续失败几次后放行；**0 = 永远失败**（与 builder 的注释同口径）。
            if succeed_after == 0 || count <= succeed_after {
                return Err(err);
            }
        }
        fs.entries.remove(path);
        Ok(())
    }

    /// M6：与 recycle 同一套账（记名、失败表、摘条目），只是记进**另一列** ——
    /// 路由测试据此证明 permanent 上下文一次都没碰过 recycle，反之亦然。
    fn delete_permanently(&self, path: &str) -> Result<(), RecycleError> {
        let mut fs = self.inner.borrow_mut();
        fs.permanently_deleted.push(path.to_string());
        if let Some((err, succeed_after)) = fs.fail_recycle.get(path).cloned() {
            let count = fs.permanently_deleted.iter().filter(|p| *p == path).count() as u32;
            if succeed_after == 0 || count <= succeed_after {
                return Err(err);
            }
        }
        fs.entries.remove(path);
        Ok(())
    }

    fn measure(&self, root: &str) -> MeasureResult {
        self.inner.borrow().measure_impl(root)
    }

    fn measure_free(&self, _root: &str) -> Option<u64> {
        let mut fs = self.inner.borrow_mut();
        // 每次读都掉一点，好让「清理前 → 清理后」在合成 fs 上也是个真变化（不是同一个常数）。
        fs.free_calls += 1;
        let base = fs.free_bytes?;
        Some(if fs.free_calls == 1 { base } else { base + fs.free_delta_after })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gate::CleanBlockerReason;
    // 只有测试那一路用得到（生产代码只碰 `CleanLog` / `LogValue`），所以放在这里而不是模块顶部 ——
    // 挂在顶部会带着两个 unused import 警告跑完全量闸。
    use crate::logline::{format_log_line, LogFields};

    const ROOT: &str = r"C:\Sandbox";

    fn env() -> RuleEnv {
        let mut m = RuleEnv::new();
        m.insert("SYSTEMDRIVE".into(), "C:".into());
        m.insert("WINDIR".into(), r"C:\Windows".into());
        m.insert("TEMP".into(), r"C:\Temp".into());
        // 与 `gate.rs::tests::env` 同一份合成机：禁止根模板引用的每一个变量都要有家
        // （CLEANUP-RULES §6 补齐后多了 `%PROGRAMFILES%\` 一族）。少一个键就是
        // `forbidden-roots-unresolved` 一片红，而那不是这些判据要量的东西。
        m.insert("PROGRAMFILES".into(), r"C:\Program Files".into());
        m.insert("PROGRAMDATA".into(), r"C:\ProgramData".into());
        m.insert("USERPROFILE".into(), r"C:\Users\Kano".into());
        m.insert("APPDATA".into(), r"C:\Users\Kano\AppData\Roaming".into());
        m.insert("LOCALAPPDATA".into(), r"C:\Users\Kano\AppData\Local".into());
        m
    }

    fn default_patterns() -> (Vec<String>, Vec<String>) {
        (
            deepclean_rules::types::FORBIDDEN_PATH_PATTERNS.iter().map(|s| s.to_string()).collect(),
            deepclean_rules::types::REPORT_ONLY_ROOT_PATTERNS.iter().map(|s| s.to_string()).collect(),
        )
    }

    fn ctx_with_paths(root: &str, paths: Vec<String>) -> ExecuteCtx {
        let (f, r) = default_patterns();
        ExecuteCtx::new("test-task", root)
            .with_requested_paths(paths)
            .with_env(env())
            .with_forbidden_patterns(f)
            .with_report_only_patterns(r)
            .with_now_ms(42)
    }

    fn run(ctx: &ExecuteCtx, fs: SyntheticFs) -> CleanTask {
        execute_cleanup(ctx, &SyntheticFsRefCell::new(fs))
    }

    fn reasons(task: &CleanTask) -> Vec<CleanRefusalReason> {
        task.refusals.iter().map(|r| r.reason).collect()
    }

    /* ---------------- 12 条 blocker 各自可达 ---------------- */

    #[test]
    fn every_blocker_reason_is_reachable() {
        let (f, r) = default_patterns();

        let cases: Vec<(CleanBlockerReason, &str, RootKind)> = vec![
            (CleanBlockerReason::RootMalformed, "   ", RootKind::Directory),
            (CleanBlockerReason::RootMalformed, r"C:\a\*", RootKind::Directory),
            (CleanBlockerReason::RootMalformed, r"C:\a\..\b", RootKind::Directory),
            (CleanBlockerReason::RootMalformed, r"\\?\C:\a", RootKind::Directory),
            (CleanBlockerReason::RootNotAbsolute, r"AppData\Local\Temp", RootKind::Directory),
            (CleanBlockerReason::RootIsDriveRoot, "C:", RootKind::Directory),
            (CleanBlockerReason::RootIsDriveRoot, r"C:\", RootKind::Directory),
            (CleanBlockerReason::RootForbidden, r"C:\Windows\System32\x", RootKind::Directory),
            (CleanBlockerReason::RootReportOnly, r"C:\$Recycle.Bin\S-1-5-21", RootKind::Directory),
            (CleanBlockerReason::RootAncestorOfForbidden, r"C:\Windows", RootKind::Directory),
            (CleanBlockerReason::RootMissing, r"C:\Sandbox", RootKind::Missing),
            (CleanBlockerReason::RootNotADirectory, r"C:\Sandbox", RootKind::NotADirectory),
            (CleanBlockerReason::RootIsReparsePoint, r"C:\Sandbox", RootKind::ReparsePoint),
            (CleanBlockerReason::RootUnstatable, r"C:\Sandbox", RootKind::Unstatable),
        ];

        for (expected, root, kind) in cases {
            let ctx = ExecuteCtx::new("t", root)
                .with_env(env())
                .with_forbidden_patterns(f.clone())
                .with_report_only_patterns(r.clone())
                .with_requested_paths(vec![r"C:\Sandbox\a.txt".into()])
                .with_now_ms(0);
            let fs = SyntheticFs::new().with_file(r"C:\Sandbox\a.txt", 1).with_kind(root, kind);
            let task = run(&ctx, fs);
            assert_eq!(task.blockers.len(), 1, "root={root}, expected={expected:?}");
            assert_eq!(task.blockers[0].reason, expected, "root={root}");
            assert_eq!(task.status, CleanTaskStatus::Refused);
        }

        // RootDeniedByCaller
        let ctx = ExecuteCtx::new("t", r"C:\Sandbox\x")
            .with_env(env())
            .with_forbidden_patterns(f.clone())
            .with_report_only_patterns(r.clone())
            .with_deny_roots(vec![r"C:\Sandbox".into()])
            .with_requested_paths(vec![r"C:\Sandbox\x\a.txt".into()])
            .with_now_ms(0);
        let fs = SyntheticFs::new().with_file(r"C:\Sandbox\x\a.txt", 1);
        let task = run(&ctx, fs);
        assert_eq!(task.blockers[0].reason, CleanBlockerReason::RootDeniedByCaller);

        // RootForbiddenUnresolved
        let ctx = ExecuteCtx::new("t", r"C:\Sandbox")
            .with_env(env())
            .with_forbidden_patterns(vec!["%NOPE%\\System32".into()])
            .with_requested_paths(vec![r"C:\Sandbox\a.txt".into()])
            .with_now_ms(0);
        let fs = SyntheticFs::new().with_file(r"C:\Sandbox\a.txt", 1);
        let task = run(&ctx, fs);
        assert_eq!(task.blockers[0].reason, CleanBlockerReason::RootForbiddenUnresolved);
    }

    /* ---------------- 13 条 refusal 各自可达 ---------------- */

    #[test]
    fn every_refusal_reason_is_reachable() {
        // malformed-path
        let ctx = ctx_with_paths(ROOT, vec!["".into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT));
        assert!(reasons(&task).contains(&CleanRefusalReason::MalformedPath));

        // parent-traversal (wildcard)
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\*.txt".into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT));
        assert!(reasons(&task).contains(&CleanRefusalReason::ParentTraversal));

        // parent-traversal (dots)
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\..\x".into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT));
        assert!(reasons(&task).contains(&CleanRefusalReason::ParentTraversal));

        // equals-authorized-root
        let ctx = ctx_with_paths(ROOT, vec![ROOT.into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT));
        assert!(reasons(&task).contains(&CleanRefusalReason::EqualsAuthorizedRoot));

        // forbidden-root（授权根外命中禁止根）
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Windows\System32\k.dll".into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT));
        assert!(reasons(&task).contains(&CleanRefusalReason::ForbiddenRoot));

        // report-only-root（授权根外命中只上报根）
        let ctx = ctx_with_paths(ROOT, vec![r"C:\$Recycle.Bin\x".into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT));
        assert!(reasons(&task).contains(&CleanRefusalReason::ReportOnlyRoot));

        // out-of-scope
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Elsewhere\x".into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT));
        assert!(reasons(&task).contains(&CleanRefusalReason::OutOfScope));

        // overlaps-out-of-scope
        // 与 TS 同形状：越界那条自己走不到 survivors，被它「套住」的在范围内的路径才会收到这条。
        // 拿授权根本身当越界源 —— 请求删根 ⇒ 根下每一条一起拒。
        let ctx = ctx_with_paths(ROOT, vec![ROOT.into(), r"C:\Sandbox\a.txt".into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT).with_file(r"C:\Sandbox\a.txt", 1));
        assert!(reasons(&task).contains(&CleanRefusalReason::OverlapsOutOfScope));

        // not-found
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\gone.txt".into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT));
        assert!(reasons(&task).contains(&CleanRefusalReason::NotFound));

        // unstatable
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\bad.txt".into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT).with_unstatable(r"C:\Sandbox\bad.txt"));
        assert!(reasons(&task).contains(&CleanRefusalReason::Unstatable));

        // reparse-point
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\link.txt".into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT).with_reparse(r"C:\Sandbox\link.txt"));
        assert!(reasons(&task).contains(&CleanRefusalReason::ReparsePoint));

        // reparse-ancestor
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\junc\file.txt".into()]);
        let task = run(
            &ctx,
            SyntheticFs::new()
                .with_dir(ROOT)
                .with_reparse(r"C:\Sandbox\junc")
                .with_file(r"C:\Sandbox\junc\file.txt", 1),
        );
        assert!(reasons(&task).contains(&CleanRefusalReason::ReparseAncestor));

        // not-a-deletable-entry
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\pipe".into()]);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT).with_other(r"C:\Sandbox\pipe"));
        assert!(reasons(&task).contains(&CleanRefusalReason::NotADeletableEntry));

        // forbidden-roots-unresolved：落在 blocker 拒绝后的整批 fallback
        let ctx = ExecuteCtx::new("t", ROOT)
            .with_env(env())
            .with_forbidden_patterns(vec!["%NOPE%\\System32".into()])
            .with_requested_paths(vec![r"C:\Sandbox\a.txt".into()])
            .with_now_ms(0);
        let task = run(&ctx, SyntheticFs::new().with_dir(ROOT).with_file(r"C:\Sandbox\a.txt", 1));
        assert!(reasons(&task).contains(&CleanRefusalReason::ForbiddenRootsUnresolved));
    }

    /// 「授权根**之内**命中禁止路径 → 第二遍按 forbidden-root 拒」这条分支，在公开入口上**不可达**。
    ///
    /// 理由是 Windows 路径的祖先是全序的：一条路径既在授权根内、又落在某个禁止根内，
    /// 那么授权根与那个禁止根必有一个套住另一个 ——
    /// 根在禁止根之下 ⇒ 守卫回 `root-forbidden`；禁止根在根之下 ⇒ 守卫回 `root-ancestor-of-forbidden`。
    /// 两种都到不了逐条闸。TS 执行器同一处（`executor.ts:380`）也是同样的死分支，**没有替它改行为**。
    ///
    /// 这条判据钉的是"不可达"本身：哪天守卫被改弱到能构造出这种批次，下面两个断言就会红。
    #[test]
    fn a_forbidden_path_inside_the_authorized_root_cannot_be_built_past_the_guard() {
        let (f, r) = default_patterns();

        // ① 想拿「禁止根之下的一个子目录」当授权根：根自己就在禁止根里。
        let deep = r"C:\Windows\System32\config";
        let ctx = ExecuteCtx::new("t", deep)
            .with_env(env())
            .with_forbidden_patterns(f.clone())
            .with_report_only_patterns(r.clone())
            .with_requested_paths(vec![format!(r"{deep}\SAM")])
            .with_now_ms(0);
        let task = run(&ctx, SyntheticFs::new().with_dir(deep).with_file(format!(r"{deep}\SAM"), 1));
        assert_eq!(task.blockers[0].reason, CleanBlockerReason::RootForbidden, "根落在禁止根之内 → 守卫先拒整批");
        assert!(
            !reasons(&task).contains(&CleanRefusalReason::ForbiddenRoot),
            "整批在守卫就停了，走不到逐条的 forbidden-root"
        );

        // ② 想拿「禁止根的父目录」当授权根：宽容器。
        let wide = r"C:\Windows";
        let ctx = ExecuteCtx::new("t", wide)
            .with_env(env())
            .with_forbidden_patterns(f)
            .with_report_only_patterns(r)
            .with_requested_paths(vec![r"C:\Windows\System32\k.dll".into()])
            .with_now_ms(0);
        let task = run(&ctx, SyntheticFs::new().with_dir(wide).with_file(r"C:\Windows\System32\k.dll", 1));
        assert_eq!(task.blockers[0].reason, CleanBlockerReason::RootAncestorOfForbidden, "根套住禁止路径 → 宽容器不认");
        assert!(
            !reasons(&task).contains(&CleanRefusalReason::ForbiddenRoot),
            "同上：这一遍根本到不了逐条闸"
        );
    }

    /* ---------------- 执行与统计 ---------------- */

    /* ---------------- §29 落盘日志 ---------------- */

    /// 收集型 logger。它把每行交给**生产那个格式化函数**摊平 —— 判据要钉的是最终落进
    /// 文件的那串字；测试里自己再拼一遍 `k=v`，就等于只验了事件顺序、格式那一半没人看。
    #[derive(Default)]
    struct Capture(std::sync::Mutex<Vec<String>>);

    impl CleanLog for Capture {
        fn clean(&self, msg: &str, fields: LogFields<'_>) {
            self.0.lock().unwrap().push(format_log_line("T", "CLEAN", msg, fields));
        }
    }

    impl Capture {
        fn lines(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    /// 成功那一路：开头一行、每条删除一行（顺序 = 真发生的顺序：文件先、目录从深到浅）、
    /// 结尾一行。字段序与 `executor.ts:451/495/553` 逐字同。
    #[test]
    fn every_deletion_and_the_pair_of_start_end_go_to_the_injected_log() {
        let cap = std::sync::Arc::new(Capture::default());
        let ctx = ctx_with_paths(
            ROOT,
            vec![
                r"C:\Sandbox\a.txt".into(),
                r"C:\Sandbox\b.txt".into(),
                r"C:\Sandbox\sub".into(),
            ],
        )
        .with_log(cap.clone());
        let fs = SyntheticFs::new()
            .with_dir(ROOT)
            .with_file(r"C:\Sandbox\a.txt", 100)
            .with_file(r"C:\Sandbox\b.txt", 200)
            .with_dir(r"C:\Sandbox\sub");
        let task = execute_cleanup(&ctx, &SyntheticFsRefCell::new(fs));
        assert_eq!(task.success_count, 3);
        assert_eq!(
            cap.lines(),
            vec![
                r"T [CLEAN] clean start task=test-task root=C:\Sandbox requested=3",
                r"T [CLEAN] C:\Sandbox\a.txt status=success size=100 kind=file attempts=1 task=test-task",
                r"T [CLEAN] C:\Sandbox\b.txt status=success size=200 kind=file attempts=1 task=test-task",
                r"T [CLEAN] C:\Sandbox\sub status=success size=0 kind=dir attempts=1 task=test-task",
                "T [CLEAN] clean end task=test-task status=completed success=3 failed=0 refused=0 cleanedSize=300 actualFreedBytes=300 ms=0",
            ],
            "逐行逐字钉住：这一串就是文件里的内容"
        );
    }

    /// **authorizedRoot 整批拦下**那一路也要有开头与结尾一对（基准把 `clean start` 放在三关
    /// 之前，正是为了这一条）。少了结尾，日志里就留下一条永远不结束的 start。
    #[test]
    fn a_blocked_run_still_logs_start_refusals_and_end() {
        let cap = std::sync::Arc::new(Capture::default());
        // 授权根本身落在禁止路径里 ⇒ 三关不过 ⇒ 整批拒绝
        let ctx = ExecuteCtx::new("blocked-task", r"C:\Windows\System32")
            .with_forbidden_patterns(
                deepclean_rules::types::FORBIDDEN_PATH_PATTERNS.iter().map(|s| s.to_string()).collect(),
            )
            .with_report_only_patterns(
                deepclean_rules::types::REPORT_ONLY_ROOT_PATTERNS.iter().map(|s| s.to_string()).collect(),
            )
            .with_env(env())
            .with_requested_paths(vec![r"C:\Windows\System32\k.dll".into()])
            .with_now_ms(0)
            .with_log(cap.clone());
        let task = execute_cleanup(&ctx, &SyntheticFsRefCell::new(SyntheticFs::new()));
        assert_eq!(task.status, CleanTaskStatus::Refused, "前提：这一路真的整批被拦");
        let lines = cap.lines();
        assert_eq!(
            lines[0],
            r"T [CLEAN] clean start task=blocked-task root=C:\Windows\System32 requested=1",
            "{lines:?}"
        );
        assert_eq!(
            lines[1],
            r"T [CLEAN] C:\Windows\System32\k.dll status=refused reason=out-of-scope task=blocked-task",
            "第二条该是那一次拒绝：{lines:?}"
        );
        let end = lines.last().unwrap();
        assert!(end.starts_with("T [CLEAN] clean end task=blocked-task status=refused blocked="), "{end}");
        assert!(
            end.contains("success=0 failed=0 cleanedSize=0"),
            "整批被拦那一行写死 0，不读 task 的计数：{end}"
        );
        assert!(end.contains("blocked="), "{end}");
    }

    /// 失败那一路：`errno` 要进日志，而 `size` 那一格是**量到的大小**（账本行那里是 0）——
    /// 基准就是两套（`executor.ts:473` 用 `size`，同批的 `deleted[]` 行写 `bytes: 0`），
    /// 含义不同：日志答"这条多大、为什么没成"，账本答"这次真腾出多少"。
    #[test]
    fn a_failed_deletion_logs_errno_and_the_measured_size() {
        let cap = std::sync::Arc::new(Capture::default());
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\stuck.bin".into()]).with_log(cap.clone());
        let fs = SyntheticFs::new()
            .with_dir(ROOT)
            .with_file(r"C:\Sandbox\stuck.bin", 77)
            .with_recycle_failure(
                r"C:\Sandbox\stuck.bin",
                RecycleError { errno: "EACCES".into(), kind: RecycleErrorKind::Permanent, detail: "被占用".into() },
                0,
            );
        let task = execute_cleanup(&ctx, &SyntheticFsRefCell::new(fs));
        assert_eq!(task.failed_count, 1);
        assert_eq!(task.deleted[0].bytes, 0, "账本行：没删掉就没有释放");
        assert_eq!(
            cap.lines()[1],
            r"T [CLEAN] C:\Sandbox\stuck.bin status=failed size=77 errno=EACCES kind=file attempts=1 task=test-task",
            "{:?}",
            cap.lines()
        );
    }

    /// "ENOENT 记跳过、不冒充失败"那一路在日志里也是 `refused`（不是 failed）。
    #[test]
    fn a_vanished_entry_is_logged_as_refused_not_failed() {
        let cap = std::sync::Arc::new(Capture::default());
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\gone.txt".into()]).with_log(cap.clone());
        let fs = SyntheticFs::new()
            .with_dir(ROOT)
            .with_file(r"C:\Sandbox\gone.txt", 10)
            .with_recycle_failure(
                r"C:\Sandbox\gone.txt",
                RecycleError { errno: "ENOENT".into(), kind: RecycleErrorKind::Permanent, detail: "没了".into() },
                0,
            );
        let task = execute_cleanup(&ctx, &SyntheticFsRefCell::new(fs));
        assert_eq!(reasons(&task), vec![CleanRefusalReason::NotFound]);
        let lines = cap.lines();
        assert!(lines[1].contains("status=refused") && lines[1].contains("reason=not-found"), "{:?}", lines);
        assert!(!lines.iter().any(|l| l.contains("status=failed")), "ENOENT 不许在日志里变成删除失败：{:?}", lines);
    }

    /// 🔴 **日志不参与判定**（基准同样：logger 写失败只是不再写，不拦删除）。
    /// 同一份输入挂不挂 logger，任务必须逐字节相同 —— 这条是"把日志接进判定"那类改动的拦网。
    /// 比 `digest` 而不是比结构体：`CleanTask` 没有 `PartialEq`，而它的**序列化形状**才是
    /// 跨 IPC 给出去的那个东西，比它更贴切。
    #[test]
    fn attaching_a_logger_changes_nothing_about_the_outcome() {
        let mk = |with_log: bool| {
            let cap = std::sync::Arc::new(Capture::default());
            let mut ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\a.txt".into(), r"C:\Sandbox\sub".into()]);
            if with_log {
                ctx = ctx.with_log(cap.clone());
            }
            let fs = SyntheticFs::new()
                .with_dir(ROOT)
                .with_file(r"C:\Sandbox\a.txt", 100)
                .with_dir(r"C:\Sandbox\sub");
            let task = execute_cleanup(&ctx, &SyntheticFsRefCell::new(fs));
            (serde_json::to_value(&task).unwrap(), cap.lines())
        };
        let (bare, _) = mk(false);
        let (logged, lines) = mk(true);
        assert_eq!(bare, logged, "挂了 logger 之后任务形状变了 —— 日志渗进判定了");
        assert_eq!(lines.len(), 4, "前提：这一路确实写了 4 行（不然上面那条相等是空比）");
    }

    #[test]
    fn files_are_deleted_before_dirs_and_stats_match() {
        let ctx = ctx_with_paths(
            ROOT,
            vec![
                r"C:\Sandbox\a.txt".into(),
                r"C:\Sandbox\b.txt".into(),
                r"C:\Sandbox\sub".into(),
            ],
        );
        let fs = SyntheticFs::new()
            .with_dir(ROOT)
            .with_file(r"C:\Sandbox\a.txt", 100)
            .with_file(r"C:\Sandbox\b.txt", 200)
            .with_dir(r"C:\Sandbox\sub");
        let task = run(&ctx, fs);
        assert_eq!(task.status, CleanTaskStatus::Completed);
        assert_eq!(task.success_count, 3);
        assert_eq!(task.cleaned_size, 300);
        assert_eq!(task.total_size, 300);
        assert_eq!(task.dirs_removed, vec![r"C:\Sandbox\sub"]);
        let recycled = task.deleted.iter().map(|d| d.path.clone()).collect::<Vec<_>>();
        assert!(recycled.contains(&r"C:\Sandbox\a.txt".into()));
        assert!(recycled.contains(&r"C:\Sandbox\b.txt".into()));
        assert!(recycled.contains(&r"C:\Sandbox\sub".into()));
    }

    #[test]
    fn duplicate_requested_paths_are_processed_once() {
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\a.txt".into(), r"C:\Sandbox\a.txt".into()]);
        let fs = SyntheticFs::new().with_dir(ROOT).with_file(r"C:\Sandbox\a.txt", 10);
        let task = run(&ctx, fs);
        assert_eq!(task.success_count, 1);
        assert_eq!(task.cleaned_size, 10);
    }

    /* ---------------- 重试 ---------------- */

    #[test]
    fn transient_error_is_retried_then_succeeds() {
        let ctx = ExecuteCtx::new("t", ROOT)
            .with_env(env())
            .with_forbidden_patterns(default_patterns().0)
            .with_report_only_patterns(default_patterns().1)
            .with_requested_paths(vec![r"C:\Sandbox\a.txt".into()])
            .with_retry(Retry { max_attempts: 3, delay_ms: 0 })
            .with_now_ms(0);
        let fs = SyntheticFs::new()
            .with_dir(ROOT)
            .with_file(r"C:\Sandbox\a.txt", 10)
            .with_recycle_failure(r"C:\Sandbox\a.txt", RecycleError::transient("EBUSY", "busy"), 2);
        let task = run(&ctx, fs);
        assert_eq!(task.status, CleanTaskStatus::Completed);
        assert_eq!(task.success_count, 1);
        let del = &task.deleted[0];
        assert_eq!(del.attempts, Some(3));
        assert_eq!(del.outcome, Some(CleanOutcome::Ok));
    }

    /// lstat 之后、recycle 之前目标被别的程序删掉 ⇒ 记「跳过」，**不冒充删除失败**。
    /// 这条钉的是 `RemoveOutcome::Vanished` 的**生产侧**：消费侧两个臂一直在那儿，
    /// 缺生产者时 `dead_code` 警告是唯一会说话的东西 —— 而没人看警告。
    #[test]
    fn a_target_that_vanished_mid_batch_is_skipped_not_failed() {
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\gone.txt".into()]);
        let fs = SyntheticFs::new()
            .with_dir(ROOT)
            .with_file(r"C:\Sandbox\gone.txt", 7)
            .with_recycle_failure(r"C:\Sandbox\gone.txt", RecycleError::permanent("ENOENT", "路径已不存在"), 0);
        let task = run(&ctx, fs);
        assert_eq!(task.failed_count, 0, "本来就不存在 ⇒ 不是删除失败");
        assert_eq!(task.success_count, 0);
        assert!(
            reasons(&task).contains(&CleanRefusalReason::NotFound),
            "应记成 not-found（§9 的「跳过文件」）：{:?}",
            task.refusals
        );
    }

    #[test]
    fn permanent_error_fails_without_retry() {
        let ctx = ExecuteCtx::new("t", ROOT)
            .with_env(env())
            .with_forbidden_patterns(default_patterns().0)
            .with_report_only_patterns(default_patterns().1)
            .with_requested_paths(vec![r"C:\Sandbox\a.txt".into()])
            .with_retry(Retry { max_attempts: 5, delay_ms: 0 })
            .with_now_ms(0);
        let fs = SyntheticFs::new()
            .with_dir(ROOT)
            .with_file(r"C:\Sandbox\a.txt", 10)
            .with_recycle_failure(r"C:\Sandbox\a.txt", RecycleError::permanent("EACCES", "denied"), 0);
        let task = run(&ctx, fs);
        assert_eq!(task.status, CleanTaskStatus::Completed);
        assert_eq!(task.failed_count, 1);
        assert_eq!(task.success_count, 0);
        let del = &task.deleted[0];
        assert_eq!(del.attempts, Some(1));
        assert_eq!(del.outcome, Some(CleanOutcome::Failed));
        assert_eq!(del.errno.as_deref(), Some("EACCES"));
    }

    /* ---------------- 取消 ---------------- */

    #[test]
    fn cancel_stops_mid_batch_and_leaves_already_deleted_dead() {
        let ctx = ExecuteCtx::new("t", ROOT)
            .with_env(env())
            .with_forbidden_patterns(default_patterns().0)
            .with_report_only_patterns(default_patterns().1)
            .with_requested_paths(vec![r"C:\Sandbox\a.txt".into(), r"C:\Sandbox\b.txt".into()])
            .with_retry(Retry { max_attempts: 1, delay_ms: 0 })
            .with_now_ms(0);
        ctx.cancel();
        let fs = SyntheticFs::new()
            .with_dir(ROOT)
            .with_file(r"C:\Sandbox\a.txt", 10)
            .with_file(r"C:\Sandbox\b.txt", 20);
        let cell = SyntheticFsRefCell::new(fs);
        let task = execute_cleanup(&ctx, &cell);
        assert_eq!(task.status, CleanTaskStatus::Cancelled);
        assert_eq!(task.success_count, 0);
        assert_eq!(task.deleted.len(), 0);
        assert!(cell.borrow().exists(r"C:\Sandbox\a.txt"), "取消前没动过第一条 → 它必须还在");
        assert!(cell.borrow().exists(r"C:\Sandbox\b.txt"), "取消后第二条不许被碰");
    }

    #[test]
    fn cancel_after_first_file_keeps_it_deleted() {
        let ctx = ExecuteCtx::new("t", ROOT)
            .with_env(env())
            .with_forbidden_patterns(default_patterns().0)
            .with_report_only_patterns(default_patterns().1)
            .with_requested_paths(vec![r"C:\Sandbox\a.txt".into(), r"C:\Sandbox\b.txt".into()])
            .with_retry(Retry { max_attempts: 2, delay_ms: 0 })
            .with_now_ms(0);
        // 第一条 recycle 一被调用就把取消立起来，并让它先失败一次 →
        // 走「重试前发现已取消」那条分支（记 cancelled，不是 failed）。
        // 不用 `thread::sleep` 再 cancel：整批只有两个文件，睡的那 5 ms 里早跑完了，
        // 那样测到的其实是「没取消」那条分支。
        let fs = SyntheticFs::new()
            .with_dir(ROOT)
            .with_file(r"C:\Sandbox\a.txt", 10)
            .with_file(r"C:\Sandbox\b.txt", 20)
            .with_recycle_failure(r"C:\Sandbox\a.txt", RecycleError::transient("EBUSY", "busy"), 1)
            .with_cancel_on_recycle(1, ctx.clone());
        let cell = SyntheticFsRefCell::new(fs);
        let task = execute_cleanup(&ctx, &cell);
        assert_eq!(task.status, CleanTaskStatus::Cancelled);
        let a = task.deleted.iter().find(|d| d.path == r"C:\Sandbox\a.txt").expect("第一条要有记录");
        assert_eq!(a.outcome, Some(CleanOutcome::Cancelled), "{a:?}");
        assert_eq!(task.success_count, 0);
        assert!(cell.borrow().exists(r"C:\Sandbox\b.txt"), "取消后第二条不许被碰");
    }

    /* ---------------- 指纹与验证 ---------------- */

    #[test]
    fn execution_digest_matches_ts_shape() {
        let d1 = execution_digest(r"C:\Root", &[r"C:\Root\a.txt".into(), r"C:\Root\b.txt".into()]);
        assert_eq!(d1.len(), 16);
        let d2 = execution_digest(r"C:\Root", &[r"C:\Root\b.txt".into(), r"C:\Root\a.txt".into()]);
        assert_eq!(d1, d2, "顺序无关");
        let d3 = execution_digest(r"C:\Root", &[r"C:\Root\a.txt".into()]);
        assert_ne!(d1, d3);
    }

    #[test]
    fn verification_reports_before_and_after_bytes() {
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\a.txt".into()]);
        let fs = SyntheticFs::new().with_dir(ROOT).with_file(r"C:\Sandbox\a.txt", 123);
        let task = run(&ctx, fs);
        let v = task.verification.expect("verification present");
        assert_eq!(v.root_bytes_before, 123);
        assert_eq!(v.root_bytes_after, 0);
        assert_eq!(v.actual_freed_bytes, 123);
        assert_eq!(v.predicted_freed_bytes, 123);
        assert_eq!(v.deleted_bytes, 123);
        assert_eq!(v.delta_bytes, 0);
        assert_eq!(v.files_before, 1);
        assert_eq!(v.files_after, 0);
    }

    /// §19 的**磁盘侧独立读数**：可用空间前后各取一次，且 `before` 必须在动手之前取。
    /// 没有这一格，「预估 == 前后差」就是拿两笔同口径的表观账互相对账 —— 自证，不是验证。
    #[test]
    fn verification_carries_an_independent_disk_side_reading() {
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\a.txt".into()]);
        let fs = SyntheticFs::new()
            .with_dir(ROOT)
            .with_file(r"C:\Sandbox\a.txt", 123)
            .with_free_bytes(Some(1_000), 400);
        let v = run(&ctx, fs).verification.expect("verification present");
        assert_eq!(v.free_bytes_before, Some(Some(1_000)));
        assert_eq!(v.free_bytes_after, Some(Some(1_400)));
        assert!(v.note.contains("1000 → 1400"), "note 要把磁盘侧读数指出来：{}", v.note);
    }

    /// 读不到就是读不到：那一格保持 `None`，note 改口说"没有独立读数"，
    /// **不许**印成 0（0 字节可用空间是一句假话）。
    #[test]
    fn an_unavailable_free_reading_says_so_instead_of_printing_zero() {
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\a.txt".into()]);
        let fs = SyntheticFs::new().with_dir(ROOT).with_file(r"C:\Sandbox\a.txt", 5).with_free_bytes(None, 0);
        let v = run(&ctx, fs).verification.expect("verification present");
        assert_eq!(v.free_bytes_before, Some(None), "调用方接了这条读数，但机器答不上来");
        assert_eq!(v.free_bytes_after, Some(None));
        assert!(v.note.contains("没采到"), "note 必须承认没有独立依据：{}", v.note);
        assert!(!v.note.contains("可用空间 0"), "不许把读不到印成 0：{}", v.note);
    }

    /* ---------------- e2e 靶场（只在授权目录真删） ---------------- */

    fn authorized_target_dir() -> Option<String> {
        let home = std::env::var("USERPROFILE").ok()?;
        let dir = format!(r"{}\Desktop\DeepClean删除测试\target", home);
        if std::fs::metadata(&dir).map(|m| m.is_dir()).unwrap_or(false) {
            Some(dir)
        } else {
            None
        }
    }

    /// 两条真文件系统 e2e 共用同一个靶场目录、以及**同一台机器的回收站计数** ——
    /// 并行跑会互相污染读数（实测：一条把另一条的探针算进 `files_before`，
    /// 另一条把回收站计数抬了 2 而不是 1）。回收站是机器级状态，crate 内隔离不了，只能串起来。
    static REAL_FS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn real_fs_guard() -> std::sync::MutexGuard<'static, ()> {
        REAL_FS_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 这个测试**只在** `%USERPROFILE%\Desktop\DeepClean删除测试\target` 存在时运行，
    /// 且只在那个目录里创建/删除临时文件，验证真实回收站路径。
    #[test]
    fn real_recycle_under_authorized_target_only() {
        let _serial = real_fs_guard();
        let Some(root) = authorized_target_dir() else {
            eprintln!("授权靶场不存在，跳过真实 e2e");
            return;
        };

        // 创建临时文件与空目录
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let file_path = format!(r"{}\c2-e2e-{}.txt", root, stamp);
        let dir_path = format!(r"{}\c2-e2e-dir-{}", root, stamp);
        std::fs::write(&file_path, b" DeepClean C-2 e2e ").expect("write test file");
        std::fs::create_dir(&dir_path).ok();

        let ctx = ExecuteCtx::new(format!("c2-e2e-{}", stamp), &root)
            .with_env(env())
            .with_forbidden_patterns(default_patterns().0)
            .with_report_only_patterns(default_patterns().1)
            .with_requested_paths(vec![file_path.clone(), dir_path.clone()])
            .with_now_ms(stamp as i64);

        let fs = WindowsCleanFs::new();
        let task = execute_cleanup(&ctx, &fs);

        // 清理：如果测试通过也要把目录（若没删成）删掉
        let _ = std::fs::remove_file(&file_path);
        let _ = std::fs::remove_dir(&dir_path);

        assert_eq!(task.status, CleanTaskStatus::Completed, "e2e 任务应完成: {:?}", task.deleted);
        assert_eq!(task.success_count, 2, "应成功回收文件和空目录");
        assert!(
            task.deleted.iter().any(|d| d.path == file_path && d.ok),
            "文件应被回收: {file_path}"
        );
        assert!(
            task.dirs_removed.iter().any(|d| d == &dir_path),
            "目录应被回收: {dir_path}"
        );
        assert_eq!(
            task.verification.as_ref().map(|v| v.files_before.saturating_sub(v.files_after)),
            Some(1),
            "验证应体现文件数减少"
        );
    }

    /// 回收站条目计数 —— Shell 自己的口径，**不读任务回执**。
    #[cfg(windows)]
    fn recycle_bin_item_count(volume: &str) -> i64 {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::{SHQueryRecycleBinW, SHQUERYRBINFO};
        let mut wide: Vec<u16> = OsStr::new(volume).encode_wide().chain(Some(0)).collect();
        let mut info = SHQUERYRBINFO {
            cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32,
            i64Size: 0,
            i64NumItems: 0,
        };
        let rc = unsafe { SHQueryRecycleBinW(wide.as_mut_ptr(), &mut info) };
        assert!(rc >= 0, "SHQueryRecycleBinW({volume}) 失败，HRESULT {rc}");
        info.i64NumItems
    }

    /// **独立**钉住「默认进回收站」：不看 `task.deleted[].ok`，改问 Shell 的回收站计数。
    ///
    /// 为什么必须有这条：上面那条 e2e 读的是执行器自己的回执，而回执与回收站是两件事 ——
    /// `FOF_ALLOWUNDO` 少写一个字母时 `SHFileOperationW` 照样返回 0、`ok` 照样是 true，
    /// 文件却被**永久删除**了。两侧同口径的"对账相等"证明不了任何一边。
    /// 判据是计数 +1：真删会让它停在 `before`，进回收站才会是 `before + 1`。
    #[cfg(windows)]
    #[test]
    fn recycle_actually_lands_in_the_recycle_bin_not_just_in_the_task_report() {
        let _serial = real_fs_guard();
        let Some(root) = authorized_target_dir() else {
            eprintln!("授权靶场不存在，跳过回收站计数 e2e");
            return;
        };
        let volume = format!("{}:\\", root.as_bytes()[0] as char);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path = format!(r"{}\c2-rb-probe-{}.txt", root, stamp);
        std::fs::write(&file_path, b"DeepClean C-2 recycle-bin oracle probe").expect("写探针文件");

        let before = recycle_bin_item_count(&volume);
        let rc = WindowsCleanFs::new().recycle(&file_path);
        let after = recycle_bin_item_count(&volume);

        assert!(rc.is_ok(), "回收调用失败：{rc:?}");
        assert!(
            std::fs::symlink_metadata(&file_path).is_err(),
            "探针文件应已离开原路径 {file_path}"
        );
        assert_eq!(
            after,
            before + 1,
            "回收站计数必须恰好 +1。停在 {before} ⇒ 文件被永久删除了（`FOF_ALLOWUNDO` 没生效），\
             而任务回执在这种情况下同样是 `ok = true`。"
        );
        // 探针留在回收站里由用户自行清空 —— 本测试不碰回收站内容，只数它。
    }

    /* ---------------- M6：受控真删通道 ---------------- */

    /// 结构闸：`permanent` 上下文没带确认回执 ⇒ 整批拒绝，一个文件都不动。
    /// 拒绝发生在 authorizedRoot 三关**之前** —— 所以 blockers 必须为空、理由必须全是
    /// `PermanentWithoutConfirmation`（混进 out-of-scope / root blocker 就是闸的次序错了）。
    #[test]
    fn a_permanent_context_without_a_confirmation_digest_is_refused_wholesale() {
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\a.tmp".into(), r"C:\Sandbox\b.tmp".into()])
            .with_permanent(true); // 有真删、没凭据
        let cell = SyntheticFsRefCell::new(
            SyntheticFs::new()
                .with_dir(ROOT)
                .with_file(r"C:\Sandbox\a.tmp", 10)
                .with_file(r"C:\Sandbox\b.tmp", 20),
        );
        let task = execute_cleanup(&ctx, &cell);
        assert_eq!(task.status, CleanTaskStatus::Refused);
        assert_eq!(task.deleted.len(), 0, "一个文件都不许动");
        assert_eq!(task.success_count, 0);
        assert_eq!(task.refusals.len(), 2, "两条请求逐条点名");
        assert!(
            reasons(&task).iter().all(|&r| r == CleanRefusalReason::PermanentWithoutConfirmation),
            "理由必须是凭据那一格：{:?}",
            reasons(&task)
        );
        assert!(
            task.blockers.is_empty(),
            "结构闸拒绝的不是授权根，blockers 必须为空：{:?}",
            task.blockers
        );
        assert!(cell.borrow().recycled.is_empty() && cell.borrow().permanently_deleted.is_empty());
    }

    /// 路由钉：`permanent + digest` 两条通道走真删、一次都不碰回收站；
    /// 同一批请求不打开 permanent（常规确认档的形状）走回收站、一次都不碰真删。
    /// 两列分开记账（`recycled` / `permanently_deleted`），"路由错了但账面 Completed"骗不过。
    #[test]
    fn the_permanent_flag_routes_between_delete_permanently_and_recycle() {
        // 正向：真删通道
        let ctx = ctx_with_paths(ROOT, vec![r"C:\Sandbox\a.tmp".into(), r"C:\Sandbox\sub".into()])
            .with_confirmation_digest("digest-1")
            .with_permanent(true);
        let cell = SyntheticFsRefCell::new(
            SyntheticFs::new()
                .with_dir(ROOT)
                .with_dir(r"C:\Sandbox\sub")
                .with_file(r"C:\Sandbox\a.tmp", 10),
        );
        let task = execute_cleanup(&ctx, &cell);
        assert_eq!(task.status, CleanTaskStatus::Completed);
        assert_eq!(cell.borrow().permanently_deleted.len(), 2, "两条都走真删通道");
        assert!(
            cell.borrow().recycled.is_empty(),
            "permanent 上下文一次都不许碰回收站：{:?}",
            cell.borrow().recycled
        );

        // 反向：同一批请求、同一张凭据，不打开 permanent ⇒ 全走回收站（既有通道零漂移）
        let ctx2 = ctx_with_paths(ROOT, vec![r"C:\Sandbox\a.tmp".into(), r"C:\Sandbox\sub".into()])
            .with_confirmation_digest("digest-1");
        let cell2 = SyntheticFsRefCell::new(
            SyntheticFs::new()
                .with_dir(ROOT)
                .with_dir(r"C:\Sandbox\sub")
                .with_file(r"C:\Sandbox\a.tmp", 10),
        );
        let task2 = execute_cleanup(&ctx2, &cell2);
        assert_eq!(task2.status, CleanTaskStatus::Completed);
        assert_eq!(cell2.borrow().recycled.len(), 2);
        assert!(cell2.borrow().permanently_deleted.is_empty());
    }

    /// M6 真删通道的行为钉（与回收站那条 e2e 同一对账方向，断言反过来）：
    /// 文件**真的没了**，且回收站计数**纹丝不动** —— 计数 +1 就说明它进了回收站
    /// （`FOF_ALLOWUNDO` 混进来了），真删语义名存实亡，而任务回执在那种情况下照样 `ok = true`。
    #[cfg(windows)]
    #[test]
    fn a_permanent_delete_leaves_no_file_and_no_recycle_bin_entry() {
        let _serial = real_fs_guard();
        let Some(root) = authorized_target_dir() else {
            eprintln!("授权靶场不存在，跳过真删 e2e");
            return;
        };
        let volume = format!("{}:\\", root.as_bytes()[0] as char);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let file_path = format!(r"{}\c6-permanent-probe-{}.txt", root, stamp);
        std::fs::write(&file_path, b"DeepClean M6 permanent-delete probe").expect("写探针文件");

        let before = recycle_bin_item_count(&volume);
        let rc = WindowsCleanFs::new().delete_permanently(&file_path);
        let after = recycle_bin_item_count(&volume);

        assert!(rc.is_ok(), "真删调用失败：{rc:?}");
        assert!(
            std::fs::symlink_metadata(&file_path).is_err(),
            "探针文件应已彻底消失（不是进回收站）：{file_path}"
        );
        assert_eq!(
            after, before,
            "回收站计数必须不变。+1 ⇒ 它进了回收站，真删通道名存实亡。"
        );
    }
}
