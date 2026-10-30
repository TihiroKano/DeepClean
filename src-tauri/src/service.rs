//! 扫描会话服务：把 `deepclean_scanner` 接到 Tauri 上。
//!
//! 三件事：
//!  1. 扫描跑在**独立线程**（`std::thread`），不占主线程也不占 WebView2 的线程；
//!  2. 进度经 `dc://scan` 事件推给界面，**有闸**（250 ms 一次）—— 每个目录推一次会把
//!     IPC 变成瓶颈，而进度条要的是"动"，不是"每一次都精确"；
//!  3. 取消/暂停是**真的**（见 `ScanControl`）：界面点「暂停扫描」而扫描还在跑，
//!     那是一个看着接上了其实没有的功能。

use deepclean_scanner::model::Counters;
use deepclean_scanner::scan::{ScanControl, ScanFailure, ScanOptions};
use deepclean_scanner::scan_parallel::scan_tree_parallel_with;
use deepclean_scanner::tree_index::TreeIndex;
// 只在测试里用到：那几处 `payload(..)` 断言读的是 `excluded_*` / `session_*`，
// 与口径无关，但形参必须给一个值。
#[cfg(test)]
use deepclean_scanner::tree_index::SizeBasis;
use deepclean_scanner::volume::{volume_of, VolumeInfo};
use deepclean_rules::engine::{evaluate_rules, EvaluateOptions, RuleReport};
use deepclean_rules::env::RuleEnv;
use deepclean_rules::tree_source::TreeSource;
use deepclean_rules::types::Risk;
use deepclean_cleaner::{
    build_preview_model, confirm_preview, execute_cleanup, CleanTask, ExecuteCtx,
    PreviewBuildOptions, PreviewConfirmation, PreviewModel, PreviewSelection, WindowsCleanFs,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub const SCAN_EVENT: &str = "dc://scan";
/// §18 的清理进度事件。
pub const CLEAN_EVENT: &str = "dc://clean";
/// 2026-10-24：清理的**逐条**进度（弹窗里滚那串文件路径）。
///
/// 为什么另开一条而不是把 `CLEAN_EVENT` 发密一点：那条事件的载荷是整个 `CleanTask`
/// （`deleted[]` 会一路长到几万条），按 250 ms 发一次就是把整份账本反复序列化过 IPC。
/// 这条只带"刚刚落下的一条 + 几个计数"，固定大小。
pub const CLEAN_PROGRESS_EVENT: &str = "dc://clean-progress";

/// 逐条进度事件的载荷。字段与 `deepclean_cleaner::CleanProgressEvent` 一一对应，
/// 另加 `taskId`（界面要按任务过滤，多窗口/两次清理并存时不许串台）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanProgressWire {
    pub task_id: String,
    pub path: String,
    pub ok: bool,
    pub bytes: u64,
    pub done: usize,
    pub total: usize,
    pub cleaned_size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanEventWire {
    pub kind: String,
    pub task: CleanTask,
}
/// 进度事件的闸。250 ms 与现行 Electron 侧的节奏一致（那边是 400 ms 刷新 + 节流）。
const EMIT_EVERY: Duration = Duration::from_millis(250);
/// 逐条进度的事件闸（2026-10-24）。
///
/// 为什么不是 250 ms：那个节奏是给"整份快照"用的；这里一条事件只带一行路径，
/// 而弹窗要的是"看着它滚"。但也不能每条都发 —— 一个 15618 文件的 `%TEMP%` 会打出
/// 一万五千条 IPC，WebView 那边光渲染就追不上删除速度，表现是列表卡住而进度条不动。
///
/// 取的折中：**每 40 ms 或每 64 条里先到的那一个**。两个闸都必要 ——
/// 小批量（几十个文件）时条数闸永远不触发，全靠时间闸让"边删边滚"成立；
/// 大批量时时间闸每 40 ms 放一次一条，靠条数闸兜住渲染压力。
/// `done == total` 那条**永远放行**（最后一格必须是尽头，不能被节流吞掉）。
const PROGRESS_EVERY: Duration = Duration::from_millis(40);
const PROGRESS_BURST: usize = 64;

/// 把执行器的逐条回调接到 Tauri 事件上，并做节流。
///
/// ⚠️ 这个结构只**发事件**，不写任何账本：账本（`deleted[]`、`cleaned_size`、journal）
/// 仍由执行器与 `record_journal` 负责。两套各写一份就是第二份真相。
pub struct EventProgressSink {
    app: AppHandle,
    task_id: String,
    /// 这一趟任务**全部**要处理的条数（= `plan.planned_count()`，与 `merge_tasks` 同一分母）。
    total: u64,
    last_emit: Mutex<Instant>,
    /// 上一批报出来的 `done` / `total`（批内口径）。执行器每批从 1 重新数，
    /// 所以这两个数一旦**回绕**（新批的 done 比上一批小），就要把上一批的总数累进 base。
    last_done: AtomicU64,
    last_total: AtomicU64,
    /// 已完成批次的条数累计。全局 done = base + 批内 done。
    batch_base: AtomicU64,
}

impl EventProgressSink {
    pub fn new(app: AppHandle, task_id: impl Into<String>, total: usize) -> Self {
        Self {
            app,
            task_id: task_id.into(),
            total: total as u64,
            // 初值取"刚发过"：第一条会因为它等了 40 ms 才出来，这没关系 ——
            // 第一条本来就不该在"刚点下去"的那一帧出现（那时清单还没落地）。
            last_emit: Mutex::new(Instant::now()),
            last_done: AtomicU64::new(0),
            last_total: AtomicU64::new(0),
            batch_base: AtomicU64::new(0),
        }
    }

    /// 这个 `done` 该不该发出去。`true` = 放行（并顺手把状态推进）。
    fn should_emit(&self, done: u64, total: u64) -> bool {
        // 最后一格永远放行。
        if total > 0 && done >= total {
            return true;
        }
        let prev = self.last_done.swap(done, Ordering::SeqCst);
        if done.saturating_sub(prev) >= PROGRESS_BURST as u64 {
            return true;
        }
        let mut le = self.last_emit.lock().unwrap();
        if le.elapsed() >= PROGRESS_EVERY {
            *le = Instant::now();
            return true;
        }
        false
    }
}

impl deepclean_cleaner::CleanProgress for EventProgressSink {
    fn tick(&self, ev: &deepclean_cleaner::CleanProgressEvent) {
        // 批内 done 回绕（新批从 1 重新数）⇒ 把上一批的总数累进 base。
        let prev_done = self.last_done.load(Ordering::SeqCst);
        let prev_total = self.last_total.load(Ordering::SeqCst);
        if (ev.done as u64) < prev_done {
            self.batch_base.fetch_add(prev_total, Ordering::SeqCst);
        }
        self.last_total.store(ev.total as u64, Ordering::SeqCst);

        let gdone = self.batch_base.load(Ordering::SeqCst) + ev.done as u64;
        let gtotal = self.total;
        if !self.should_emit(gdone, gtotal) {
            return;
        }
        let _ = self.app.emit(
            CLEAN_PROGRESS_EVENT,
            CleanProgressWire {
                task_id: self.task_id.clone(),
                path: ev.path.clone(),
                ok: ev.ok,
                bytes: ev.bytes,
                done: gdone as usize,
                total: gtotal as usize,
                cleaned_size: ev.cleaned_size,
            },
        );
    }
}

/// 每一层最多回多少个子项。**这是视图口径**（`level_of`），不是计价口径。
pub const DEFAULT_LEVEL_CAP: usize = 1200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Running,
    Paused,
    Completed,
    Cancelled,
    Failed,
}

impl Status {
    pub fn wire(self) -> &'static str {
        match self {
            Status::Running => "running",
            Status::Paused => "paused",
            Status::Completed => "completed",
            Status::Cancelled => "cancelled",
            Status::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCountersWire {
    pub files: u64,
    pub dirs: u64,
    /// **占用口径**（分配大小、硬链接已去重），不是表观大小之和。
    /// 旧实现这里是表观大小，所以 80 GB 的盘能扫出 90 GB —— 这个数就是那么来的。
    pub total_bytes: u64,
    pub denied: u64,
    pub missing: u64,
    pub busy: u64,
    pub other_errors: u64,
    pub skipped: u64,
    /// 下面三个是**「这一轮根本没看过的东西」**，与上面那四个错误桶是两回事：
    /// 错误桶是"试了但没成功"，这三个是"按策略/按结构就没进去"。
    /// 它们以前只活在扫描器内部（`commands.rs:111` 那份 UI 快照里有 `skippedAlways`，
    /// 而**导出报告里一个都没有**）—— 于是拿一份报告的人看到 `errors.skipped=0`
    /// 会读成"这棵树全看完了"，而真话可能是"三万个条目被 SKIP_ALWAYS 挡在外面"。
    /// 口径：`skipped` 保持"四个错误桶之和"不动（改了会让新旧报告的那一格无法对照），
    /// 新增的三个各自独立，谁也不并进谁。
    pub skipped_always: u64,
    pub skipped_reparse: u64,
    pub depth_capped: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSnapshotWire {
    #[serde(flatten)]
    pub counters: ScanCountersWire,
    pub scan_id: String,
    pub root: String,
    pub status: String,
    pub current_path: String,
    pub elapsed_ms: u64,
    pub started_at_ms: Option<i64>,
    pub finished_at_ms: Option<i64>,
    pub truncated: bool,
    /// 下面三个是**新实现多出来的**（前端今天不读，但地图/未计入那一块要用）
    pub bytes_logical: u64,
    pub unaccounted_bytes: i64,
    pub deduped_hardlinks: u64,
    /// "walk" | "mft" —— HUD 徽标与报告的解释字段（MFT 档会看见 meta 记录与 ADS）。
    pub scan_mode: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEventWire {
    pub kind: String,
    pub snapshot: ScanSnapshotWire,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveInfoWire {
    pub root: String,
    pub label: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub used_bytes: u64,
}

pub struct SessionState {
    pub status: Status,
    pub counters: Counters,
    pub current_path: String,
    pub started_at_ms: Option<i64>,
    pub finished_at_ms: Option<i64>,
    /// `Arc` 不是为了省内存，是为了**让读命令能把树带出锁外**：`dc_children` / `build_preview`
    /// 原先只能"抱着会话锁跑完"，因为 `tree` 借自守卫。整棵树不支持 clone（十万目录的 DFS 克隆
    /// 实测 1.7 s），所以用一次指针克隆换掉那段持锁 —— 扫描线程收尾时换指针、读命令读时各克隆一份，
    /// 两边都不再需要对方让路。
    pub tree: Option<Arc<TreeIndex>>,
    pub error: Option<String>,
    pub unaccounted: i64,
    /// 本轮产出树的是哪一档（"walk" / "mft"）。**回退要改写**：MFT 档中途失败
    /// 整轮回退 walk 重扫时，这里必须跟着改回去 —— 徽标对着 walk 的结果说 MFT
    /// 是比没有徽标更糟的谎言。口径解释权在 `mft/mod.rs` 头注「档间已知差异」。
    pub scan_mode: &'static str,
    /// §7「排除该目录」的**视图**排除集（`dirId` 升序）。三条边界与 TS 同：
    /// 不改任何数字、不碰计价路径（`children_of`）、也不是「扫描时跳过」。
    /// 归属住在这一轮会话上：`dirId` 只在本次扫描的树里有意义，存到渲染端会跨轮复活成
    /// 另一棵树的 id，存到磁盘更是把「这块噪音我先不看」做成永久配置。
    pub view_excluded: std::collections::BTreeSet<i64>,
}

pub struct Session {
    pub id: String,
    pub root: String,
    pub control: ScanControl,
    pub state: Mutex<SessionState>,
    /// §17 预览的**报告复用槽**（2026-10-22：首次勾选延迟）。
    ///
    /// 键是 `(report_claims, deleted_snapshot)`：
    /// `scan_id` 不必进键，因为槽就住在 `Session` 上 —— 换一次扫描是换一个 `Session`，
    /// 缓存随旧会话一起丢掉，**结构上不可能**把上一轮的账套到这一轮上
    /// （这比"记得把 scan_id 写进键里"可靠：那种约定靠人守）。
    ///
    /// 树在 `start_scan` 里**只在扫描完成时 publish 一次**，之后不可变 ⇒ 报告在会话存活
    /// 期间也确实不变。理由、代价与「谁不许读它」见 [`selection_report_slot`]。
    pub report_cache: Mutex<Option<(bool, Vec<String>, Arc<RuleReport>)>>,
    /// **本会话已删除的文件路径集合**（归一化键，2026-10-24）。
    ///
    /// 树是扫描时的不可变快照，清理删的是磁盘文件 —— 这一格记下「删了哪些」，
    /// `report_for_preview` 把它喂给 `FilteredSource`，清理之后这一页的数字才会少下去。
    /// 只在 `execute_plan` 收尾时追加，从不回退：删掉的东西不会自己长回来。
    ///
    /// ⚠️ 它是**预览缓存的第二格键**（2026-10-25 修「清理后再勾选又是几百毫秒」）：
    /// 曾经写的是"已删集合非空 ⇒ 一律不复用缓存"，那条一刀切让清理之后的**每一次**
    /// 勾选都重跑全树索引 + 规则评估（真机 `C:\Windows` 125k 文件实测 244 ms 起）。
    /// 现在键里放的是这一格的**快照**：集合不变就一直复用，变了才重算。
    pub deleted_paths: Mutex<std::collections::BTreeSet<String>>,
}

impl SessionState {
    /// 树里只要有一层被截断过就点名。**口径只这一处**：`snapshot()` 与 §3.6 那格都读它，
    /// 复制一份判断就是给「地图说没截断、这一页说截断了」留后路。
    pub fn truncated(&self) -> bool {
        let Some(t) = self.tree.as_deref() else { return false };
        (1..t.dirs_len() as i64).any(|i| t.dir(i).is_some_and(|d| d.files_truncated))
            || t.dir(deepclean_scanner::tree_index::ROOT_DIR_ID)
                .is_some_and(|d| d.files_truncated)
    }
}

impl Session {
    pub fn snapshot(&self) -> ScanSnapshotWire {
        snapshot_of(self, &self.state.lock().unwrap())
    }
}

/// 快照的**真正实现**：吃一个已经拿好的守卫。
/// 分出来这一半是因为 `dc_export_report` 需要"在同一把锁里既取快照又读树"——
/// 直接在持锁时调 `Session::snapshot()` 会自锁死（本会话真撞过：IPC 永不返回，
/// 界面连 `.catch` 都走不到，症状是"点了没反应"）。
pub fn snapshot_of(session: &Session, st: &SessionState) -> ScanSnapshotWire {
    {
        let c = st.counters;
        ScanSnapshotWire {
            counters: ScanCountersWire {
                files: c.files,
                dirs: c.dirs,
                total_bytes: c.bytes_counted,
                denied: c.errors.denied,
                missing: c.errors.missing,
                busy: c.errors.busy,
                other_errors: c.errors.other_errors(),
                skipped: c.errors.denied + c.errors.missing + c.errors.busy + c.errors.other_errors(),
                skipped_always: c.skipped_always,
                skipped_reparse: c.skipped_reparse,
                depth_capped: c.depth_capped,
            },
            scan_id: session.id.clone(),
            root: session.root.clone(),
            status: st.status.wire().to_string(),
            current_path: st.current_path.clone(),
            // 完成后必须钉在「完成 − 开始」，只有还在扫时才随墙钟走（HUD 要活数）。
            // 写成 `now − started` 会让这一格变成"你什么时候来取快照"的函数：扫描停下之后
            // 界面上那句「用时」还在往上走，导出报告里由它派生的 `speed.*` 三个数也跟着漂
            // ——`report.rs` 顶上「同一份输入两次导出逐字节相同」那句就靠这一格兜住。
            elapsed_ms: match (st.started_at_ms, st.finished_at_ms) {
                (Some(s), Some(f)) => (f - s).max(0) as u64,
                (Some(s), None) => (now_ms() - s).max(0) as u64,
                _ => 0,
            },
            started_at_ms: st.started_at_ms,
            finished_at_ms: st.finished_at_ms,
            truncated: st.truncated(),
            bytes_logical: c.bytes_logical,
            unaccounted_bytes: st.unaccounted,
            deduped_hardlinks: c.deduped_hardlinks,
            scan_mode: st.scan_mode.to_string(),
        }
    }
}

/// ⚠️ **2026-10-30 从 `#[derive(Default)]` 改成手写**：多了 `cached_settings` 那一格，
/// 而 `AppSettings` 没有实现 `Default` trait（它有的是 `AppSettings::default()` 这个
/// **同名关联函数**，因为 `wallpaper` 是 `String`、`to_string()` 不是 const fn）。
/// 派生 `Default` 会去找 `Default::default()`，编译期就找不到。
///
/// 手写这一份的代价：以后再加字段，这里必须跟着补一行 —— 忘了就是 E0063（缺字段），
/// 编译期会报，不会静默。所以这个代价是"编译器管着"的，可以接受。
impl Default for AppState {
    fn default() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            current: Mutex::new(None),
            confirmations: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            task_order: Mutex::new(Vec::new()),
            running: Mutex::new(HashMap::new()),
            journal: Mutex::new(crate::journal_store::JournalStore::default()),
            journal_path: Mutex::new(None),
            dev_env_status: Mutex::new(None),
            clean_log: Mutex::new(None),
            // 缓存初值是**产品默认设置**，不是零值：`scan_workers` 的零值语义是
            // "用推荐值"，恰好也是默认，但 `locale` 零值是空串 —— 那会让
            // 「还没人写过缓存」与「语言被设成空」混成一件事。
            cached_settings: Mutex::new(crate::settings::AppSettings::default()),
            seq: AtomicU64::new(1),
        }
    }
}

pub struct AppState {
    pub sessions: Mutex<HashMap<String, Arc<Session>>>,
    pub current: Mutex<Option<Arc<Session>>>,
    /// 确认过的执行凭据：`digest → 计划`。**渲染端报上来的路径清单一律不作数** ——
    /// 清单是确认那一刻由主进程从已扫好的树里另取的（见 `executable_paths`）。
    pub confirmations: Mutex<HashMap<String, ConfirmedPlan>>,
    pub tasks: Mutex<HashMap<String, CleanTask>>,
    /// 任务入队次序（`tasks` 是 HashMap，列表页要有稳定次序）。
    pub task_order: Mutex<Vec<String>>,
    /// 正在跑的任务 → 它的取消把手。`dc_cancel_cleanup` 就靠这个把取消立起来。
    pub running: Mutex<HashMap<String, ExecuteCtx>>,
    /// 清理日志的账本（2026-10-25 重做：一次清理一条，落盘保留 30 天）。
    ///
    /// 与旧的 `Mutex<Vec<JournalEntry>>` 的区别：那边一个文件一行、只在内存；
    /// 这边是 `JournalStore`（`journal_store.rs`），带落盘与 30 天淘汰。
    pub journal: Mutex<crate::journal_store::JournalStore>,
    /// 落盘路径。`None` = 这台机器上定不出应用数据目录。
    ///
    /// **定不出时不报错、不拦流程**：内存照记，只是不落盘 ——
    /// 与 `clean_log` 那条「建不出文件就这一格是 None，流程照跑」同一条纪律。
    pub journal_path: Mutex<Option<PathBuf>>,
    /// 「装没装」那张表的**进程级**缓存（基准：`scan-service.ts:52-64` 的 `realDetectorStatusCache`）。
    /// 为什么不挂在调用上：一趟要起 11 次 `where`（几百毫秒到一秒），而「装没装」在一次进程内
    /// 不会变 —— 真要刷新就重启应用。Docker 那一格**不在这里缓存**（基准同样每次现查，
    /// 见 `scan-service.ts:178-182`：daemon 起来过没有、df 量到了多少，是会随时间变的东西）。
    pub dev_env_status: Mutex<Option<std::collections::BTreeMap<String, bool>>>,
    /// §29 的逐条删除落盘日志（`electron/services/clean-service.ts:135` 那格 `logPath` 的正主）。
    /// `None` = 这台机器上**建不出**那个日志文件（只读漫游配置、磁盘满、目录被占），
    /// 于是记录页那格给 null、页脚那句照实说"没能确定日志文件路径" —— 不是揣一个写不进去的路。
    pub clean_log: Mutex<Option<Arc<crate::cleanlog::FileCleanLog>>>,
    /// **当前设置的一份缓存**（2026-10-30）。
    ///
    /// 为什么要有它：删除并发度（那格「删除速率」）的真读者是 `execute_plan`，
    /// 而那个函数的签名里**没有 `AppHandle`**（`Option<&AppHandle>`，子单元测试传 `None`），
    /// 于是它没法自己算出 settings.json 在哪。
    ///
    /// 谁往里写：`dc_settings_set` 成功后（那是唯一会改设置的地方）与
    /// `dc_settings_get` 读到之后。两处都写，是因为"用户从没打开过设置页"时
    /// 只有后者会跑 —— 而这时也得有默认值，不能是零值 `usize::default()`。
    ///
    /// **它不是第二份真相**：这个结构的所有字段都来自 `settings::load_settings`
    /// 或 `save_settings` 的返回值，没有任何地方从这里**回写**文件。
    pub cached_settings: Mutex<crate::settings::AppSettings>,
    seq: AtomicU64,
}

/// 一批「同一个授权根之下的那些路径」。
///
/// 2026-10-24：执行计划从「一个授权根 + 一张清单」变成**一批**这种小单元。
///
/// 为什么必须拆：授权根原先取会话扫描根，而首页默认扫的就是盘根（`C:\`），
/// `guard_authorized_root` 对盘符根一律回 `root-is-drive-root` ⇒ 整批拒绝、零删除
/// （`gate.rs`，M3-C 验收文档写着「这是刻意的，不是缺陷」）。那个人类伙伴点完清理
/// 一个文件都没动，看到的是「整批拒绝」，与「按钮坏了」在屏幕上长得一样。
///
/// 拆成哪一批：**按规则自己的地盘**（`RuleFinding.matched_roots`）。于是 `%TEMP%` 那一批
/// 的授权根就是 `%TEMP%` 本身，浏览器缓存那一批就是某个 `…\Cache` 目录本身 ——
/// 比「整盘」窄得多，比「公共祖先」也可行（真实清单的公共祖先是 `C:\`，
/// 因为 `%TEMP%` 在 `C:\Users\…` 下而 `%PROGRAMDATA%` 在 `C:\ProgramData` 下，
/// 取公共祖先等于什么都没改）。
///
/// ⚠️ 授权根**不能**取「匹配根的父目录」：`%LOCALAPPDATA%` 套着只上报根
/// `%LOCALAPPDATA%\Packages` 与 `%LOCALAPPDATA%\Programs`，会被
/// `root-ancestor-of-forbidden` 整批拦下。取匹配根本身才既非盘根、又不套住保护路径。
///
/// ## 2026-10-25：容器入口规则的匹配根本身就套住了受保护路径
///
/// 上面那句只对**窄规则**成立。`app-rotated-logs` / `app-cache-data` 这类容器入口规则的
/// `matched_roots` 就是 `%PROGRAMDATA%` / `%LOCALAPPDATA%` 本身（`engine.ts` 的 leafFiles
/// 分支：`leafFiles` 没有"命中目录"这层概念，根就是被搜过的那一层入口）。而
/// `%PROGRAMDATA%` 套着只上报根 `%PROGRAMDATA%\Package Cache` ⇒ 这一批必然被
/// `root-ancestor-of-forbidden` 整批拒掉，**一条都删不了**，而界面上那 125 条各自
/// 显示成「被拒」——真机实测（2026-10-24 那次一键清理：8 批里 1 批整批被拒、125 条全落在这里）。
///
/// 收窄的判据不是"取公共祖先"：真机上那 125 条的公共祖先**就是** `%PROGRAMDATA%` 本身
/// （`C:\ProgramData\USOShared\Logs\System` 与 `C:\ProgramData\Comms\Hiview` 的最近共同祖先是它），
/// 所以公共祖先对这批等于什么都没改。改成**按被认领路径的父目录拆**：每个父目录都比
/// 容器根窄得多，且实测都不套住 `Package Cache`。
///
/// 收窄只在**原根确实会被拒**时发生，且收窄后的每一个根都要过同一道判据；
/// 有一个不过就原样保留原根，交给执行器如实拒绝 —— 宁可整批被拒，也不在这里替它
/// 编一个能删的根（§28 原则四：范围本身是危险物）。执行器那道闸一个字都没动。
#[derive(Debug, Clone)]
pub struct CleanBatch {
    /// 这一批的授权根 = 这批路径所属的那块地盘（`matched_roots` 里最深的那个）
    pub root: String,
    pub paths: Vec<String>,
}

/// 一次「确认」所锚定的执行计划。
///
/// 只存**读得到的**那几样：批次（授权根 + 清单）、归属表。指纹本身是这张表的键，不必再存一份。
#[derive(Debug, Clone)]
pub struct ConfirmedPlan {
    pub digest: String,
    /// 这一趟计划属于哪次扫描（2026-10-24 加：`execute_plan` 收尾要把已删文件记回这个会话）。
    pub scan_id: String,
    /// 一批一条授权根。顺序稳定（按 root 升序），所以执行次序可复现。
    pub batches: Vec<CleanBatch>,
    /// §1.7 的归属表：`normalize_key(path) → (ruleId, risk, bytes)`。
    /// **确认那一刻**从报告里取，日志页的 `risk` / `ruleId` 只认它 —— 查不到就是「未知」。
    ///
    /// ⚠️ 2026-10-25 起**没有读面**：旧清理日志用它查 `risk` / `rule_id`，那一整套下线了。
    /// 仍照旧填（`build_preview` 那处），因为确认凭据里带着它是既有形状；删字段要连
    /// `attribution_of` 与两处构造点一起动，那是另一件事。
    #[allow(dead_code)]
    pub attribution: HashMap<String, deepclean_cleaner::PathAttribution>,
}

impl ConfirmedPlan {
    /// 这次一共要动几个文件/目录（各批加起来）。进度条的分母与执行器同一个口径。
    pub fn planned_count(&self) -> usize {
        self.batches.iter().map(|b| b.paths.len()).sum()
    }

    /// 授权根的对外说法：一批时就是那个根，多批时点名条数。
    /// 记录页/日志要一句话说清「这次动的范围有多大」，而拼一串根名会把一行撑爆。
    pub fn root_label(&self) -> String {
        match self.batches.as_slice() {
            [] => "（空）".to_string(),
            [one] => one.root.clone(),
            many => format!("{} 块地盘（{}）", many.len(), many[0].root),
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// §15 那份"哪些目录没算进地图"的清单。**唯一取数点**：`dc_skipped` 与 §报告导出都走它，
/// 两处各写一份过滤就是两套真相（一边列得出来、另一边列不出来时，报告和面板会互相打脸）。
pub fn skipped_sample_of(
    tree: &deepclean_scanner::tree_index::TreeIndex,
) -> impl Iterator<Item = String> + '_ {
    tree.skipped
        .iter()
        .filter(|s| {
            matches!(
                s.reason,
                deepclean_scanner::accounting::SkipReason::Reparse
                    | deepclean_scanner::accounting::SkipReason::Always
            )
        })
        .map(|s| s.path.clone())
}

/// 列出可见盘符。**不用 PowerShell**（现行 TS 侧走 `Get-CimInstance Win32_LogicalDisk`）——
/// `volume_of` 一个字面量盘符就能问出全部三个数。
///
/// ⚠️ `label` 在**卷没有卷标**时给的是空串，不是"本地磁盘"这个名字（2026-10-29 改）。
///
/// 原来这里回退成 `"本地磁盘"` —— 那是一句**写死在服务端的中文**，
/// 加了界面语言之后它会是一个永远不跟着变的词：英文界面下盘符列表里会冒出一句中文。
/// 而"这盘没名字"这件事本身该由**显示层**决定怎么说（各语言各有各的说法）。
/// 所以服务端只报事实（空串），渲染端用 `t('本地磁盘')` 兜底 —— 那一处已经在
/// `DrivePicker` / `Home` 里了。
pub fn list_drives() -> Vec<DriveInfoWire> {
    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if let Ok(v) = volume_of(Path::new(&root)) {
            out.push(DriveInfoWire {
                root,
                // 空串 = "这卷没有卷标"，由渲染端按界面语言兜底（见上面那段注释）
                label: v.label.clone(),
                total_bytes: v.total_bytes,
                free_bytes: v.free_bytes,
                used_bytes: v.used_bytes(),
            });
        }
    }
    out
}

/// 读这一格的设置，翻成内核要的 `Option<usize>`（2026-10-29）。
///
/// `0` = "用推荐值" 的哨兵（见 `settings::SCAN_WORKERS_AUTO`）→ 回 `None`，
/// 由 `clamp_workers` 用本机逻辑核数填空 —— 也就是改之前的行为。
/// 读盘失败时同样回 `None`：这一格读不到不该让整次扫描起不来，
/// 那会把"设置文件坏了"变成"扫描按钮没反应"。
fn read_scan_workers(app: &AppHandle) -> Option<usize> {
    let path = crate::settings::settings_path(&app).ok()?;
    let (s, _) = crate::settings::load_settings(&path);
    (s.scan_workers != crate::settings::SCAN_WORKERS_AUTO).then_some(s.scan_workers)
}

/// 起一轮扫描。
///
/// `volume` 由调用方传入（`dc_start` 在阻塞线程池里取好）而不是这里现取：`volume_of` 是一次
/// `GetVolumePathNameW`，扫描根填成断连的网络路径时它会等 —— 等在这里就等于等在主线程上。
pub fn start_scan(app: AppHandle, state: &AppState, root: String, volume: VolumeInfo) -> Result<String, String> {
    let root_path = Path::new(&root).to_path_buf();
    let id = format!("t{}-{}", now_ms(), state.seq.fetch_add(1, Ordering::SeqCst));

    let session = Arc::new(Session {
        id: id.clone(),
        root: root.clone(),
        control: ScanControl::new(),
        report_cache: Mutex::new(None),
        deleted_paths: Mutex::new(std::collections::BTreeSet::new()),
        state: Mutex::new(SessionState {
            status: Status::Running,
            counters: Counters::default(),
            current_path: root.clone(),
            started_at_ms: Some(now_ms()),
            finished_at_ms: None,
            tree: None,
            error: None,
            unaccounted: 0,
            scan_mode: "walk",
            view_excluded: Default::default(),
        }),
    });

    {
        let mut cur = state.current.lock().unwrap();
        if let Some(old) = cur.take() {
            old.control.cancel(); // 上一轮还在跑就让它停 —— 否则两个扫描抢同一块盘
        }
        *cur = Some(session.clone());
    }
    state.sessions.lock().unwrap().insert(id.clone(), session.clone());

    // §3.6 那一格（「这棵树上躺着几个模型权重」）要的两个数就在遍历途中顺带累加。
    // 名单只有一处来源：`deepclean-devenv` 的那份口径（与 TS 的 MODEL_FILE_EXTENSIONS 同一份，
    // 由 devenv 的对账闸钉着）。在这里另抄一遍就是给「两张表对什么是 .gguf 各说一套」留后路。
    let opts = ScanOptions::new(&root_path)
        .with_count_exts(&deepclean_devenv::MODEL_FILE_EXTENSIONS)
        // 并行度（2026-10-29）：设置页那格滑块。`0` = 用推荐值（本机逻辑核数），
        // 落进内核再夹一次（`clamp_workers`）—— 界面的滑块挡不住手改 settings.json，
        // 而这一格存在的理由正是「拉满倍率把进程打死」。
        .with_workers(read_scan_workers(&app));
    let app2 = app.clone();
    let s2 = session.clone();
    // 预热要的 `id`：`id` 后面 `sessions.insert` 与 `Ok(id)` 还要用，不能 move 进闭包，
    // 所以这里 clone 一份专供闭包拥有。
    let id_warm = id.clone();
    let app_cb = app.clone();
    let s_cb = session.clone();
    std::thread::spawn(move || {
        // 进度回调两档共用：counters/current_path/暂停态是幂等设置，节流只管 emit 频率。
        // 逻辑收在一个可 Clone 的回调体里 —— 并行 walk 档要求 `Fn + Send + Sync + 'static`
        // （回调从 worker 池多线程进），MFT 档借引用；闭包拥有全套捕获（AppHandle/Arc），
        // 三个分支各拿一份 clone 即可。
        #[derive(Clone)]
        struct ProgressCb {
            app: AppHandle,
            session: Arc<Session>,
            last_emit: Arc<Mutex<Instant>>,
        }
        impl ProgressCb {
            fn call(&self, c: &Counters) {
                let mut st = self.session.state.lock().unwrap();
                st.counters = *c;
                st.current_path = self.session.root.clone();
                if self.session.control.is_paused() {
                    st.status = Status::Paused;
                } else if st.status == Status::Paused {
                    st.status = Status::Running;
                }
                drop(st);
                let mut le = self.last_emit.lock().unwrap();
                if le.elapsed() >= EMIT_EVERY {
                    *le = Instant::now();
                    drop(le);
                    let _ = self.app.emit(
                        SCAN_EVENT,
                        ScanEventWire {
                            kind: "progress".into(),
                            snapshot: self.session.snapshot(),
                        },
                    );
                }
            }
        }
        let pcb = ProgressCb {
            app: app_cb,
            session: s_cb,
            last_emit: Arc::new(Mutex::new(Instant::now() - EMIT_EVERY)),
        };
        let walk_progress = { let p = pcb.clone(); move |c: &Counters| p.call(c) };

        // MFT 档 try-first（SpaceSniffer 精度的来源）：probe <10ms，全绿才走；
        // 中途失败（几何对不上 / 卷读取坏了）回退 walk 整轮重扫 —— 宁可慢，不要缺。
        // **取消不回退**：用户已经叫停，回退等于违背命令；Cancelled 原样上抛。
        let result = if deepclean_scanner::mft::probe_mft(&opts.root).is_ok() {
            s2.state.lock().unwrap().scan_mode = "mft";
            match deepclean_scanner::mft::scan_volume_mft(
                &opts,
                volume.clone(),
                &s2.control,
                &walk_progress,
            ) {
                Ok(tree) => Ok(tree),
                Err(deepclean_scanner::mft::MftFailure::Cancelled) => Err(ScanFailure::Cancelled),
                Err(_) => {
                    {
                        let mut st = s2.state.lock().unwrap();
                        st.scan_mode = "walk"; // 徽标跟着真话走
                        st.counters = Counters::default(); // MFT 档的半截进度不许残留
                        st.current_path = s2.root.clone();
                    }
                    // walk 档走并行版（与单线程逐字段等价，walk_parity 钉死）；
                    // A 阶段进度里的 bytes_counted 是未去重临时值，done 后归真 —— HUD 语义不变
                    scan_tree_parallel_with(&opts, &volume, s2.control.clone(), walk_progress.clone())
                }
            }
        } else {
            scan_tree_parallel_with(&opts, &volume, s2.control.clone(), walk_progress.clone())
        };

        // 建树**先于**持锁：`TreeIndex::build` 对 50 万文件的树要 DFS 克隆全部节点（1–3 秒级），
        // 持锁做这段会让任何进来的 `dc_snapshot` / `dc_children` 堵在互斥锁上 —— 而这些是
        // 同步命令（跑在主线程），一堵就是「未响应」。先在锁外算完，锁里只做指针交换。
        let index = result.as_ref().ok().map(|tree| {
            let used = tree.volume.used_bytes();
            let unaccounted = used as i64 - tree.counters.bytes_counted as i64;
            (TreeIndex::build(tree), tree.counters, unaccounted)
        });
        let mut st = s2.state.lock().unwrap();
        // 先取一个 bool：`match result` 的 Err 支路会把 `ScanFailure` move 走，
        // 之后再用 `result.is_ok()` 就是"借用已部分移动的值"（E0382）。
        let ok_warm = result.is_ok();
        match result {
            Ok(_) => {
                let (idx, counters, unaccounted) = index.unwrap();
                st.unaccounted = unaccounted;
                st.tree = Some(Arc::new(idx));
                st.counters = counters;
                st.status = Status::Completed;
            }
            Err(ScanFailure::Cancelled) => st.status = Status::Cancelled,
            Err(e) => {
                st.status = Status::Failed;
                st.error = Some(e.to_string());
            }
        }
        st.finished_at_ms = Some(now_ms());
        drop(st);

        // §3.6 开发环境页的**预热**（人类伙伴 2026-10-20：「能不能在扫描时就把那 12 秒算掉」）。
        //
        // 位置是刻意选的：树已经建好、会话锁已经放开、而且我们仍在**扫描线程**里 ——
        // 预热不影响任何 IPC（窗口不会因为这一下变未响应）。
        //
        // 代价：扫描完成后到 `done` 事件之间多一段（C 盘实测 12 s）。收益：开发环境页
        // **首次**点开就是现成的，不再有 5-10 秒空白。用户要的是"点开就有内容"，
        // 而这两段总时长是一样的 —— 差别只是这 12 s 花在"扫描刚结束"还是"第一次点页面"。
        // 花在扫描结束更符合直觉：那时 HUD 本来就在转。
        //
        // 失败只记一句话，**不许**把这一轮的扫描判失败 —— 预热是优化，不是扫描的一部分。
        // **`done` 先发，预热后排**（2026-10-22 修）。
        //
        // 人类伙伴报告：「debug 版本扫描结束会卡死（耗时已经停了，但是仍提示扫描中)」。
        // 成因在下面这段预热的位置：它跑在**扫描线程**上，而 `done` 事件原先写在它后面 ⇒
        // 第 458 行早就把 `status` 置成 Completed、第 465 行也写了 `finished_at_ms`
        // （所以界面上「用时」**已经停住不动**），可界面拿状态的唯一通道是 `dc://scan` 事件，
        // 而那一条要等预热跑完才发 ⇒ 这段时间里界面一直显示「扫描中…」。
        // 实测：`C:\Windows`（35,374 目录）预热 3267 ms；代码注释自记全盘 C: 约 12 s。
        // 那 3–12 秒被用户读成"卡死"，而它不是扫描没完成，是**通知被优化挡在后面**。
        //
        // 顺序调换是安全的：事件里带的是同一份 `snapshot`（读的是已经写好的状态），
        // 预热改的是 `dev_env_report_slot` 与探测器缓存，两者不相干；
        // 而预热仍留在扫描线程里 ⇒ 窗口不会因此未响应（这一条是它的原始目的，没变）。
        let _ = app2.emit(SCAN_EVENT, ScanEventWire { kind: "done".into(), snapshot: s2.snapshot() });

        if ok_warm {
            let t = Instant::now();
            // 预热**两样**，都发生在扫描线程（窗口不会因此未响应）：
            //
            // ① `detector_status` —— 那 11 次 `where`（本机实测 1.7 s）。它本来是
            //    **进程级缓存**，但缓存只在"第二次"才生效：第一次进页面照样真跑一遍。
            //    在这里提前跑掉，首次进页面就直接命中。
            //    顺带修掉一个隐藏的顺序依赖：不预热时，用户第一次点开发环境页要付这 1.7 s，
            //    而那是与"扫的是什么盘"完全无关的成本。
            // ② 规则报告 —— 那 12 s（采集 + 评估），`warm_dev_env_report` 产出的那份。
            warm_detector_status();
            match warm_dev_env_report(&s2, &id_warm) {
                Some(cache) => {
                    *dev_env_report_slot().lock().unwrap() = Some((id_warm.clone(), cache));
                    eprintln!("[dc] 开发环境页预热 {}（{} ms）", id_warm, t.elapsed().as_millis());
                }
                None => eprintln!("[dc] 开发环境页预热 {} 未产出（树没建完？）", id_warm),
            }
        }
    });

    Ok(id)
}

/* ------------------------------------------------------------------ *
 * §17 预览与确认（M3-B）
 * ------------------------------------------------------------------ */

/// `previewCleanup` 的线格式。与 Electron 侧的 `PreviewPayload` 同形。
/// §12 的 `unclaimedTilePaths` 已落地；~~§20 那一路~~ 重复文件检测下线后一并撤掉。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewPayloadWire {
    pub scan_id: String,
    pub scan_status: String,
    pub preview: PreviewModel,
    pub confirmation: Option<PreviewConfirmation>,
    /// 请求带了 `tilePaths` 时回：这些文件不在任何规则的地盘里，所以没进勾选。
    /// **点名，不静默丢** —— 没给 tilePaths 时这个键整个不上线（TS 的 `undefined` 同形）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unclaimed_tile_paths: Option<Vec<String>>,
}

/// §12 的形状门：只留非空字符串（`trim()` 后），其余丢掉。丢脏值不等于认得合法值 ——
/// 合法与否由**引擎的认领表**判，查不到就退回 `unclaimed_tile_paths` 点名。
fn sanitize_tile_paths(raw: Option<Vec<serde_json::Value>>) -> Vec<String> {
    raw.unwrap_or_default()
        .into_iter()
        .filter_map(|v| match v {
            serde_json::Value::String(s) if !s.trim().is_empty() => Some(s),
            _ => None,
        })
        .collect()
}

/// 被 `DC_ENV_ROOT` 重定向的键 —— **只有规则领地那一类**。
///
/// `SYSTEMDRIVE` / `WINDIR` 绝不重定向：禁止根与只上报根就是从这两个解析出来的
/// （`%WINDIR%\System32` 等 6 条 + 回收站），把它们一起搬走等于把 §16 那道结构闸
/// 挪进沙箱里自己夸自己通过 —— 那就不再是在验守卫，而是在验我把守卫关掉了。
#[cfg(debug_assertions)]
const REDIRECTABLE_ENV_KEYS: [&str; 5] = ["TEMP", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA", "USERPROFILE"];

/// 真机环境变量 → 引擎的 `RuleEnv`。**全仓只有这一处读真机环境**：
/// 引擎与预览都必须靠注入，它们的判据才可能在合成树上跑。缺的变量**不补** ——
/// 缺了就缺了，引擎会把它记成 `unresolved-env` / 触发 fail-safe，那是要看见的信号。
pub fn rule_env() -> RuleEnv {
    rule_env_from(|k| std::env::var(k).ok())
}

/// `rule_env` 的可测内核：环境读取与 `DC_ENV_ROOT` 都由参数注入。
pub fn rule_env_from(read: impl Fn(&str) -> Option<String>) -> RuleEnv {
    let mut m = RuleEnv::new();
    // dev-only 验收口子：设了 `DC_ENV_ROOT` 就把那五个领地键指到它下面的同名子目录。
    // 用途与 `DC_AUTOSCAN` 同类 —— 规格里 M3 要"真机点一次清理"，而规则领地写死在
    // `%USERPROFILE%\...` 下，不重定向就只能拿用户的真缓存去点。
    // `debug_assertions` 门控 ⇒ **打包版拿不到它**。
    #[cfg(debug_assertions)]
    let root = read("DC_ENV_ROOT").filter(|s| !s.is_empty());
    // 上面那条绑定只在 debug 构建里被用（下面那个 `#[cfg(debug_assertions)]` 块），
    // 所以 release 侧必须叫 `_root` —— 否则 `cargo check --release` 每条命令都带一条告警，
    // M6 出包时"零告警"这条判据就永远红着。
    #[cfg(not(debug_assertions))]
    let _root: Option<String> = None;

    for k in deepclean_rules::RULE_ENV_KEYS {
        #[cfg(debug_assertions)]
        if let Some(r) = &root {
            if REDIRECTABLE_ENV_KEYS.contains(&k) {
                m.insert(k.to_string(), format!(r"{r}\{k}"));
                continue;
            }
        }
        if let Some(v) = read(k) {
            if !v.is_empty() {
                m.insert(k.to_string(), v);
            }
        }
    }
    m
}

/// 会话里的树 → 规则报告。**纯读**。
///
/// `collect_all_paths_for` 点名**全部**内置规则：§17 的逐路径定价要吃引擎认领过的**全量**清单，
/// 否则只能给报告采样里那 50 条定价（`preview.ts` 的 notes 会如实说这件事）。
/// 挂在报告上的是路径引用，量级与"这次扫描认领了多少文件"同阶，只在这条命令里活一次。
///
/// ⚠️ **没有 `pub fn rule_report` 这个便捷入口**（曾经有）：它自己采机器事实，而采集在十万级
/// 目录的树上是百毫秒级 —— 放在"已经拿着会话锁"的调用路径上就是一处未响应。要报告的调用方
/// 一律走 [`rule_report_with_facts`]，先把事实采好再进锁。
/// 内核：机器事实**由调用方先采好再交进来**。
///
/// 分出来这一半的理由只有一条，但它是「未响应」的一处真凶：采集（`TreeSource::new` 的全树
/// 路径索引 + Toolhelp32 进程表 + 注册表）在十万级目录的树上是**百毫秒级**的，而
/// `build_preview` 是在**持有会话锁**时调它的（见 `build_preview` 里那段注释）。
/// 先把采集做完、再进锁，锁里就只剩纯内存的引擎评估（同一棵树上实测 0.41 ms）。
///
/// 口径不变：两份报告仍然吃**同一份**事实表 —— 只是把「采」与「评」按锁边界切开。
///
/// `pub(crate)`：`perf.rs` / `golden.rs` 两个测试模块要量「采 + 评」合计（那正是锁外
/// 先算完能省掉的那部分），它们走的就是产品这一条路，不另开一个测量入口。
pub(crate) fn rule_report_with_facts(
    tree: &TreeIndex,
    now: i64,
    report_claims: bool,
    facts: (std::collections::BTreeMap<String, deepclean_rules::AppFact>, std::collections::BTreeMap<String, String>),
) -> RuleReport {
    // 索引建一次就够：调用方若已经为采事实建过一份，`rule_report_with_facts_reusing` 会把它传进来。
    let source = TreeSource::new(tree);
    rule_report_with_source(&source, now, report_claims, facts)
}

/// 与 [`rule_report_with_facts`] 同一条评估链，只是**复用调用方已经建好的路径索引**。
///
/// 抽这一半的理由是实测出来的一笔纯浪费：一次 `build_preview` 里
/// `app_facts_for_tree` 与 `rule_report_with_facts` **各建了一次** `TreeSource::new`
/// （全树归一化路径索引，`C:\Windows` 35,374 目录实测 **165–170 ms**），
/// 而两份索引喂的是同一棵不可变的树 ⇒ 第二份与第一份逐字节相同。
/// 去掉它零语义变化，直接省掉一次全树遍历。
pub(crate) fn rule_report_with_facts_reusing(
    source: &dyn deepclean_rules::engine::RuleSource,
    now: i64,
    report_claims: bool,
    facts: (std::collections::BTreeMap<String, deepclean_rules::AppFact>, std::collections::BTreeMap<String, String>),
) -> RuleReport {
    rule_report_with_source(source, now, report_claims, facts)
}

/// 评估内核：吃一个**已经建好的** `RuleSource`，不再自建索引。
fn rule_report_with_source(
    source: &dyn deepclean_rules::engine::RuleSource,
    now: i64,
    report_claims: bool,
    facts: (std::collections::BTreeMap<String, deepclean_rules::AppFact>, std::collections::BTreeMap<String, String>),
) -> RuleReport {
    let rules = deepclean_rules::builtin_rules();
    let env = rule_env();
    let mut opts = EvaluateOptions {
        now_ms: now,
        max_listed_paths: 50,
        // §12 的归属反查要的那张防双计表。TS 是 `reportClaims: tilePaths.length > 0`
        // （`scan-service.ts:463`）—— 只有真拿文件路径来问归属时才交，平时一份都不带。
        report_claims,
        ..Default::default()
    };
    for r in &rules {
        opts.collect_all_paths_for.insert(r.id.clone());
    }
    let (facts_table, whys) = facts;
    opts.app_facts = facts_table;
    opts.app_fact_whys = whys;
    evaluate_rules(source, &rules, &env, &opts)
}

/// 一趟机器事实采集（**不许在持会话锁时调**，理由见 [`rule_report_with_facts`]）。
///
/// 入参是树而不是索引：`TreeSource::new` 要全场走一遍（十万目录约 181 ms），
/// 而 `app_facts_for` 只需要在树上按路径查几个 id。
///
/// `pub(crate)`：同上，测量入口必须与产品同一条路。
pub(crate) fn app_facts_for_tree(
    tree: &TreeIndex,
) -> (
    std::collections::BTreeMap<String, deepclean_rules::AppFact>,
    std::collections::BTreeMap<String, String>,
) {
    let source = TreeSource::new(tree);
    app_facts_for_tree_reusing(&source)
}

/// 同 [`app_facts_for_tree`]，但**复用调用方建好的索引** —— 一次 preview 只该建一份。
///
/// 参数从 `&TreeSource` 泛化成 `&dyn RuleSource`（2026-10-24）：`report_for_preview`
/// 在「已删集合非空」时喂 `FilteredSource`（包在真索引外面的过滤层），两者都要能走这一条。
pub(crate) fn app_facts_for_tree_reusing(
    source: &dyn deepclean_rules::engine::RuleSource,
) -> (
    std::collections::BTreeMap<String, deepclean_rules::AppFact>,
    std::collections::BTreeMap<String, String>,
) {
    let env = rule_env();
    app_facts_for(source, &env)
}

/// 把六路机器事实的结论交给评估层（M5-P2 P2-T4，spec §4 / plan §2.7）。
///
/// 候选目录**取自已扫描的树**，不再走一遍磁盘：同一棵树既是判据的输入也是候选集的边界，
/// 分两次枚举时树会中间变（真机上应用一直在写），错位的表象是"某个目录被提议却不在报告里"。
///
/// 状态与理由**分两张表**交：规则侧那份 `AppFact` 是 fieldless `Copy`（线格式还要与 TS 的
/// `'present' | 'absent' | 'unknown'` 逐字对上），而 `appfacts` 那份是
/// `Unknown { why: String }`。`app_fact_tables` 就是那一步映射，`why` 不许在映射里丢掉 ——
/// 丢了报告就只能说"弃权了"，说不出"为什么没判"。
fn app_facts_for(
    source: &dyn deepclean_rules::engine::RuleSource,
    env: &RuleEnv,
) -> (
    std::collections::BTreeMap<String, deepclean_rules::AppFact>,
    std::collections::BTreeMap<String, String>,
) {
    use deepclean_appfacts as af;
    use deepclean_rules::engine::{AppFactRow, NodeKind};
    let mut candidates: Vec<String> = Vec::new();
    for key in ["LOCALAPPDATA", "APPDATA", "PROGRAMDATA"] {
        let Some(root) = env.get(key) else { continue };
        let Some(id) = source.dir_id_by_path(root) else { continue };
        for kid in source.children_of(id) {
            if kid.kind != NodeKind::Directory {
                continue;
            }
            if let Some(name) = std::path::Path::new(&kid.path).file_name() {
                candidates.push(name.to_string_lossy().into_owned());
            }
        }
    }
    let mut roots = af::ProbeRoots::from_env_vars(env);
    // **卷根也是安装容器**（这一格是真机抓出来的：`%LOCALAPPDATA%\miHoYo` 被判残留，而本体
    // 就摆在 `D:\mihoyo`）。默认三根 + `InstallLocation` 反馈只看得见**登记了卸载项**的安装；
    // 走自家启动器装的游戏/工具没有卸载表条目，本体在别的卷上就是盲区 ⇒ 少一条本体证据 ⇒
    // **多判 Absent（多删）**，是这一层最坏的那一侧。补 26 次 `is_dir` 换一条独立的本体轴。
    for letter in b'A'..=b'Z' {
        let cand = format!("{}:\\", (letter as char).to_ascii_uppercase());
        if std::path::Path::new(&cand).is_dir() {
            roots.push_standard(cand);
        }
    }
    let input = af::ProbeInput {
        roots,
        registry: af::registry::collect_snapshot(),
        processes: af::procs::collect_process_snapshot(),
        env: env.clone(),
    };
    let table = af::collect_app_facts(&candidates, &input);
    deepclean_rules::engine::app_fact_tables(table.iter().map(|(k, v)| AppFactRow {
        key: k.clone(),
        fact: match v {
            af::AppFact::Present => deepclean_rules::AppFact::Present,
            af::AppFact::Absent => deepclean_rules::AppFact::Absent,
            af::AppFact::Unknown { .. } => deepclean_rules::AppFact::Unknown,
        },
        why: v.why(),
    }))
}

/// §17 预览的**报告复用槽**（2026-10-22：首次勾选延迟）。
///
/// ## 为什么要有它
///
/// `C:\Windows`（125,139 文件 / 35,374 目录，debug）上实测一次 `build_preview` 约 **490 ms**：
/// `app_facts_for_tree` 244 ms + `rule_report_with_facts` 244 ms，而真正由勾选决定的
/// `build_preview_model` 只有 **0.7 ms**（比例约 700:1）。
/// 也就是说用户每点一次复选框，99.9% 的时间花在**与这次点击无关**的重算上。
///
/// ## 为什么报告可以复用（这是读出来的事实，不是估计）
///
/// 1. `selection` 根本不在 [`rule_report_with_facts`] 的形参里 —— 报告是
///    f(树, 机器事实, `report_claims`) 的函数，勾选不在其中；
/// 2. `builtin.rs` 里**没有一条规则**设 `older_than_days`，所以 `engine.rs:1121` 那个时间
///    分支在生产规则集上永不进入 ⇒ 连 `now` 都不影响报告；
/// 3. 树的生命周期与 `scan_id` 对齐（换一次扫描 `Session` 整个换掉），所以 `scan_id` 进键
///    就足以保证不把上一轮的账套到这一轮上。
///
/// ## 键为什么是这三样
///
/// `(scan_id, report_claims)`：前者见上；后者决定报告**形状**（`claimed_paths` 挂不挂），
/// 同一个会话上两种都会出现（不带 tilePaths / 带 tilePaths），混用会把一张不带认领表的
/// 报告交给 §12 的归属反查，于是「这个文件归哪条规则」全线查不到、全落 `unclaimed`。
///
/// ## 谁**不**许读它
///
/// `confirm` 那一趟（[`build_preview`] 的 `confirm.is_some()`）永远实时重算。
/// 回执是 §18 删除的授权凭据，必须锚在**当下这份**机器事实：拿一份旧报告出回执，
/// 可能删掉一个刚装上的应用的数据（`orphan-app-data` 的判据正是「装了没」）。
/// 那 490 ms 花在用户显式按下「确认」上完全可接受 —— 这一份慢是**刻意保留**的。
///
/// ## 已知代价（如实登记，不隐藏）
///
/// 同一次页面停留内，若中途装了 / 卸了应用、或应用起了进程，`orphan-app-data` 与
/// `app-cache-data` 的判定不会自动刷新 —— 要刷新就重新扫一次或重开这一页（换 `scan_id`）。
/// 方向是安全的：机器事实变新只会**减少**提议（装上了 ⇒ 判 present ⇒ 不删），
/// 而缓存住的是更早那份，最坏情况是"该停的提议没停"，由 `confirm` 那一趟的实时重算兜住。
///
/// 槽本身住在 [`Session::report_cache`] 上，不是进程级静态 —— 缓存的生命周期必须与
/// 「这一轮扫描」对齐，否则同一进程里两个会话（以及测试里前后两棵树）会互相污染。

/// 一次 preview 要的报告：**命中会话缓存就用缓存里那份，否则真算并填进去**。
///
/// `reuse` 为假时（`confirm` 那一趟）永远真算、且**不写缓存** —— 写进去会让一次确认把
/// 「缓存里那份」顶成新的，而缓存的存在意义就是"勾选期间不变的那一份"。
///
/// ## 缓存键 = `(report_claims, 已删集合快照)`（2026-10-25 修正）
///
/// 原来第二格是"已删集合**非空**"：清理之后缓存**永久**失效，于是清理之后的每一次勾选
/// 都要重跑全树索引 + 机器事实采集 + 规则评估（`C:\Windows` 125k 文件实测 244 ms 起，
/// 全盘预热后仍在同一量级）。用户报的症状正是「清理过一次之后，勾选又开始延迟」。
///
/// 真正让缓存作废的是"**已删集合变了**"，不是"非空"。现在键里放集合的快照：
/// 集合不变（含从空变空）就一直复用；`execute_plan` 追加过 ⇒ 键变 ⇒ 重算一次，
/// 之后又稳定下来。清理后**第一次**勾选付一次全量（那是应该的 —— 数字要跟着磁盘现实走），
/// 之后每一次都是缓存命中。
fn report_for_preview(
    session: &Session,
    tree: &TreeIndex,
    now: i64,
    report_claims: bool,
    reuse: bool,
) -> Arc<RuleReport> {
    let deleted = session.deleted_paths.lock().unwrap().clone();
    // 快照只进键不进 `FilteredSource` 的输入判断：空集合与旧行为逐字相同
    // （`FilteredSource` 没活干，报告与缓存那份字节相等），所以"清理前"这条路径没有任何变化。
    let deleted_key: Vec<String> = deleted.iter().cloned().collect();
    if reuse {
        let hit = {
            let guard = session.report_cache.lock().unwrap();
            match guard.as_ref() {
                Some((claims, key, r)) if *claims == report_claims && *key == deleted_key => Some(Arc::clone(r)),
                _ => None,
            }
        };
        if let Some(r) = hit {
            return r;
        }
    }
    // 索引**建一次**：机器事实采集与规则评估吃的是同一棵不可变的树，
    // 原先各建一次 `TreeSource::new`（35k 目录实测 165–170 ms），第二份与第一份逐字节相同。
    let source = TreeSource::new(tree);
    // 已删集合非空 ⇒ 在过滤层上评估：报告与预览读到的就是「删完之后」的树。
    let report = if deleted.is_empty() {
        Arc::new(rule_report_with_facts_reusing(
            &source,
            now,
            report_claims,
            app_facts_for_tree_reusing(&source),
        ))
    } else {
        let filtered = deepclean_rules::FilteredSource::new(&source, &deleted);
        Arc::new(rule_report_with_facts_reusing(
            &filtered,
            now,
            report_claims,
            app_facts_for_tree_reusing(&filtered),
        ))
    };
    if reuse {
        *session.report_cache.lock().unwrap() = Some((report_claims, deleted_key, Arc::clone(&report)));
    }
    report
}

/// §17：报告 + 用户选择 → 预估（可选同时给出「确认」回执）。**只读，没有执行入口。**
///
/// 入参 `selection` 原样收 `serde_json::Value`：TS 侧对「`items` 不是数组」「条目不是对象」
/// 这类畸形输入有**专属拒绝理由**，用强类型接住会把这些分支变成一次反序列化失败 —— 理由就没了。
/// 缺 `selection` 时退化成 `items = null`（不是数组）⇒ 与 TS 同样地记一条 `unknown-rule` 拒绝。
///
/// ~~`dup` / `dup_group_ids` / `dup_exclusions`~~：重复文件检测（§20）已下线，这三格一并撤掉 ——
/// 渲染端只报「勾了哪几条规则」与「从地图加进来的路径」。
pub fn build_preview(
    state: &AppState,
    scan_id: &str,
    selection: serde_json::Value,
    confirm: Option<bool>,
    acknowledged_risk: Option<Risk>,
    tile_paths: Option<Vec<serde_json::Value>>,
) -> Result<Option<PreviewPayloadWire>, String> {
    let s = state.sessions.lock().unwrap().get(scan_id).cloned();
    let Some(s) = s else { return Ok(None) };
    // 还没扫完就没有树 —— 回 None 而不是一份空预估（空预估会被界面念成"没有可清理的东西"，
    // 而那是个看起来正常的假结论）。与 `dc_children` 同一条口径。
    //
    // **树先克隆出来、锁立刻放掉。** 原先这把锁"抱着走完整个函数"，代价是 `rule_report` 里的
    // 机器事实采集（全树路径索引 + Toolhelp32 进程表 + 注册表，十万目录实测 187 ms）全程压在
    // 会话锁上：同一段时间里 `dc_children` / `dc_snapshot` 一律排队（实测最大 7 188 ms），
    // 窗口就是「未响应」。`tree` 是 `Arc`，这里只多一次指针克隆。
    let (tree, status_wire) = {
        let st = s.state.lock().unwrap();
        match st.tree.as_ref() {
            Some(t) => (t.clone(), st.status.wire().to_string()),
            None => return Ok(None),
        }
    };
    let tree: &TreeIndex = &tree;

    let now = now_ms();
    // §12：渲染端报来的**具体文件路径**（地图上「加入清理列表」点进来的）。形状门照
    // `scan-service.ts:447` 那句 `typeof p === 'string' && p.trim().length > 0`。
    let tiles = sanitize_tile_paths(tile_paths);
    // 采集在**锁外**：`rule_report_with_facts` 吃调用方采好的事实表，锁里只剩纯内存评估。
    //
    // **勾选变化时复用报告**（2026-10-22）：`selection` 不在报告的入参里，且没有一条内置规则
    // 读时钟，所以报告与勾选无关 —— 每次点击都重算那 244 ms 纯属浪费。理由与代价见
    // [`Session::report_cache`] 那段注释。`confirm` 那一趟（`confirm.is_some()`）**永不复用**：
    // 回执是删除的授权凭据，必须锚在当下这份机器事实上。
    let report = report_for_preview(&s, tree, now, !tiles.is_empty(), confirm.is_none());
    let mut sel: PreviewSelection = serde_json::from_value(selection).unwrap_or_default();

    /* ---- §12 的归属反查，照 `scan-service.ts:477-497`。                              *
     * 用**引擎自己的认领表**回答"这个文件归哪条规则"。查不到就是查不到：原样退回        *
     * `unclaimed_tile_paths` 点名给用户，绝不为了"让按钮有用"去猜一条规则，也不允许     *
     * 在壳层另写一套路径匹配当第二口径。                                                */
    let mut unclaimed: Vec<String> = Vec::new();
    if !tiles.is_empty() {
        let mut by_rule: HashMap<String, Vec<String>> = HashMap::new();
        // TS 那张 `Map` 走**首次出现顺序**，而 `HashMap` 的迭代序随哈希种子漂 ⇒ items 的追加
        // 次序会变、拒绝清单的次序也跟着变（顺序即行为，M3-A 为规则表的顺序改过一次代码）。
        let mut rule_order: Vec<String> = Vec::new();
        for p in &tiles {
            let owner = report
                .claimed_paths
                .as_ref()
                .and_then(|m| m.get(&deepclean_rules::engine::normalize_key(p)).cloned());
            match owner {
                None => unclaimed.push(p.clone()),
                Some(rid) => {
                    by_rule.entry(rid.clone()).or_default().push(p.clone());
                    if !rule_order.contains(&rid) {
                        rule_order.push(rid);
                    }
                }
            }
        }
        if let Some(arr) = sel.items.as_array_mut() {
            for rid in &rule_order {
                let paths = by_rule.remove(rid).unwrap_or_default();
                // 同一规则**已经有逐路径那条勾选** ⇒ 并进去（去重，原有的排前面）；
                // 只有整项勾选（不带 paths）时保持独立 —— 把它并进整项那条 = 静默吞掉一次勾选，
                // 那是 Task 16/17 的"一条都不静默"纪律不允许的（`scan-service.ts:494` 同句注释）。
                let existing = arr.iter_mut().find(|e| {
                    e.get("ruleId").and_then(|v| v.as_str()) == Some(rid.as_str()) && e.get("paths").is_some()
                });
                match existing {
                    Some(e) => {
                        let mut merged: Vec<String> = e
                            .get("paths")
                            .and_then(|v| v.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                            .unwrap_or_default();
                        for p in paths {
                            if !merged.contains(&p) {
                                merged.push(p);
                            }
                        }
                        if let Some(obj) = e.as_object_mut() {
                            obj.insert("paths".into(), serde_json::json!(merged));
                        }
                    }
                    None => arr.push(serde_json::json!({ "ruleId": rid, "paths": paths })),
                }
            }
        }
    }

    let opts = PreviewBuildOptions {
        now_ms: now,
        default_unselectable_rule_ids: deepclean_rules::default_unselectable_rule_ids(
            &deepclean_rules::builtin_rules(),
        )
        .into_iter()
        .collect(),
    };
    let preview = build_preview_model(&report, &sel, &opts);
    // M5-P1 T4：确认**按档**。渲染端此刻还没带上 `acknowledgedRisk`（那是 T5b 的活），
    // 缺省**按 🟡**，不是按「最高档」—— 缺省替用户按高档 = 服务端替他承认「我看见 🟠 了」，
    // 那正是本 Task 要关的那扇门。所以缺省的口径是：
    //   🟢/🟡 的预估照常出回执（逐字等于 T4 之前的行为），
    //   含 🟠 的预估**出不了回执**，直到调用方显式传 `acknowledgedRisk = "high"`。
    let confirmation = confirm.map(|ack| confirm_preview(&preview, ack, acknowledged_risk.unwrap_or(Risk::Caution), now));

    // 「确认」通过 ⇒ 把执行计划锚在指纹上。清单在这里、且只在这里从**报告**取一次：
    // `preview.items[].paths` 只带逐路径勾选那一批，整项勾选的那批不带清单，
    // 得回到 finding 的全量认领表（`all_paths`，退回 `sample_paths`）。
    if let Some(c) = &confirmation {
        if c.confirmed {
            let plan = ConfirmedPlan {
                digest: c.digest.clone(),
                scan_id: scan_id.to_string(),
                batches: executable_batches(&report, &preview),
                attribution: attribution_of(&report, &preview),
            };
            state.confirmations.lock().unwrap().insert(plan.digest.clone(), plan);
        }
    }

    Ok(Some(PreviewPayloadWire {
        scan_id: scan_id.to_string(),
        scan_status: status_wire,
        preview,
        confirmation,
        unclaimed_tile_paths: if tiles.is_empty() { None } else { Some(unclaimed) },
    }))
}

/// 确认过的每一项 ⇒ 要动手的路径清单，**按「这块地盘的根」分组**。
/// **从报告的认领表取，不从渲染端取。**
///
/// 返回一批 [`CleanBatch`]：每批的 `root` 是这批路径所属的那块地盘，`paths` 是它底下的清单。
/// 分组键的取法见并行注释：整项勾选按 `finding.matched_roots` 里**最深的那个命中根**
/// （最深 = 最窄，越窄越安全）；逐路径勾选按 `preview.items[].matched_roots` 的同一套。
///
/// ⚠️ 分组键**不是**「路径的父目录」。取父目录会让 `%TEMP%\x.tmp` 的授权根变成 `%TEMP%`
/// 本身（那没问题），但遇到 `%TEMP%` 下再一层子目录时就变成"根比清单还窄"，
/// 于是清单里同批的兄弟路径被判 out-of-scope。用规则自己的地盘当键，边界与规则表一致。
fn executable_batches(report: &RuleReport, preview: &PreviewModel) -> Vec<CleanBatch> {
    // 路径 → 它属于哪块地盘。归一化键做大写无关的去重，但值保留原样路径。
    let mut by_root: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();

    // 报名的「每个规则命中过哪些根」 —— 一张一次建好的表，不按路径去扫 findings（那是 O(n·m)）。
    let mut roots_of_rule: HashMap<&str, &Vec<String>> = HashMap::new();
    for f in &report.findings {
        roots_of_rule.entry(f.rule_id.as_str()).or_insert(&f.matched_roots);
    }

    for item in preview.items.iter().filter(|i| i.included) {
        let roots = roots_of_rule.get(item.rule_id.as_str()).copied();
        let fallback_root = roots
            .and_then(|r| deepest(r))
            // 规则一条命中根都没报（表外 id / 夹具自定义规则集）：退回会话扫描根，
            // 让执行器按老路子整批判（多半会中 root-is-drive-root 的整批拒绝，
            // 但那是**如实拒绝**，不是我们在这里替它编一个授权根）
            .unwrap_or_default();

        if item.scope == deepclean_cleaner::PreviewScope::Paths {
            for p in &item.paths {
                let root = deepest_containing(roots, &p.path).unwrap_or_else(|| fallback_root.clone());
                by_root.entry(root).or_default().push(p.path.clone());
            }
        } else if let Some(f) = report.findings.iter().find(|f| f.rule_id == item.rule_id) {
            // 整项勾选：每条路径归到「包住它的那个最深命中根」。
            // 这样 `matched_roots` 有多条时（`browser-cache` 的 Chrome/Edge 各 Profile），
            // 每条路径各回自己的那一片，而不是整批塞进第一条根里。
            for h in f.all_paths.as_ref().unwrap_or(&f.sample_paths) {
                let root = deepest_containing(roots, &h.path).unwrap_or_else(|| fallback_root.clone());
                by_root.entry(root).or_default().push(h.path.clone());
            }
        }
    }

    let mut out: Vec<CleanBatch> = Vec::with_capacity(by_root.len());
    for (root, mut paths) in by_root {
        paths.sort();
        paths.dedup();
        // 授权根本身不能出现在清单里（`equals-authorized-root` 会整条拒掉它）。
        // 这里**不剔**：那是执行器该说的话，静默剔掉等于替它消化掉一条拒绝记录。
        out.push(CleanBatch { root, paths });
    }
    // 容器入口规则那几批：匹配根就是 `%PROGRAMDATA%` / `%LOCALAPPDATA%` 本身，
    // 而它们套着只上报根（`%PROGRAMDATA%\Package Cache`、`%LOCALAPPDATA%\Packages` …）
    // ⇒ 执行器会整批拒。收窄到「被认领路径的父目录」，收窄不过就原样保留。
    // 判据与代价见 `CleanBatch` 那段注释。
    let mut out = narrow_sweeping_roots(out, report);
    // 次序稳定：按根排。执行次序因此可复现（M3-A 那条"顺序即行为"的纪律）。
    out.sort_by(|a, b| a.root.cmp(&b.root));
    out
}

/// 把**套住了受保护路径**的批次根收窄到被认领路径的父目录。
///
/// 只做一件事：`root` 套住禁止根 / 只上报根 ⇒ 这一批在执行器那道闸上必然整批被拒
/// （`root-ancestor-of-forbidden`），一条都删不了。此时把清单按父目录重新分组，
/// 每组一个更窄的根。**根没套住任何受保护路径的批次原样通过**，一个字节都不动。
///
/// 三条纪律：
/// 1. 收窄后的每一个根**自己**也要过同一道判据；有一个不过，整批退回原根，
///    交给执行器如实拒绝 —— 这里不替它编一个"能删的根"（§28 原则四）。
/// 2. 收窄后若某组的父目录**等于**被认领路径本身（清单里只有目录、且就在根下），
///    那组退回原根 —— `equals-authorized-root` 一样会拒，收窄没意义。
/// 3. 收窄只在 `root` **确实**套住受保护路径时发生。宽容器本来能删的批次不受影响，
///    所以真实清单里那 25 批（`%TEMP%`、各个 `…\Cache`）逐字不变。
fn narrow_sweeping_roots(batches: Vec<CleanBatch>, report: &RuleReport) -> Vec<CleanBatch> {
    // 受保护路径全集 = 禁止根 ∪ 只上报根（与 `guard_authorized_root` 那处 `all` 同口径）。
    // 用报告里**已解析**的那两份，不另解析模板：两处解析出两种结果就是两套真相。
    let mut guarded: Vec<String> = report.forbidden_roots.clone();
    guarded.extend(report.report_only_roots.iter().cloned());
    if guarded.is_empty() {
        return batches;
    }
    let sweeps = |root: &str| -> bool {
        let rk = deepclean_rules::engine::normalize_key(root);
        guarded.iter().any(|g| {
            let gk = deepclean_rules::engine::normalize_key(g);
            gk != rk && deepclean_cleaner::is_strictly_inside(&gk, &rk)
        })
    };

    let mut out: Vec<CleanBatch> = Vec::with_capacity(batches.len());
    for b in batches {
        if !sweeps(&b.root) {
            out.push(b); // 这条根本来就不套住任何受保护路径 —— 原样通过
            continue;
        }
        // 按父目录重新分组。父目录取不到（根下的直接子项）⇒ 这一条没有更窄的合法根。
        let mut by_parent: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
        let mut ungroupable = false;
        for p in &b.paths {
            match parent_dir(p) {
                Some(parent) if !sweeps(&parent) => by_parent.entry(parent).or_default().push(p.clone()),
                // 父目录本身仍套住受保护路径，或取不到父目录 ⇒ 这条收不窄
                _ => ungroupable = true,
            }
        }
        // 任何一条收不窄 ⇒ 整批退回原根：只收窄一部分会让"同一次勾选里有的能删有的被拒"
        // 变成一句无法解释的话，而原根那一条拒绝理由至少是诚实的。
        if ungroupable || by_parent.is_empty() {
            out.push(b);
            continue;
        }
        for (root, paths) in by_parent {
            out.push(CleanBatch { root, paths });
        }
    }
    out
}

/// 路径的父目录（去掉最后一段）。盘符根与取不到父目录的返回 `None`。
fn parent_dir(p: &str) -> Option<String> {
    let t = p.trim_end_matches(['\\', '/']);
    let idx = t.rfind(['\\', '/'])?;
    let parent = &t[..idx];
    // `C:` 这种裸盘符不是合法授权根（`root-is-drive-root`），不许收窄到它。
    if parent.len() <= 2 && parent.as_bytes().get(1) == Some(&b':') {
        return None;
    }
    Some(parent.to_string())
}

/// 最深的那个根（段数最多 = 最窄 = 最安全）。`None` / 空表 ⇒ `None`。
fn deepest(roots: &[String]) -> Option<String> {
    roots
        .iter()
        .max_by_key(|r| deepclean_rules::engine::normalize_key(r).matches('\\').count())
        .cloned()
}

/// 包住 `path` 的那些根里最深的那个。没有根包住它 ⇒ `None`（调用方退回默认根）。
///
/// 「包住」用**段边界**判，不用字符串前缀 —— 前缀会让 `C:\ab` 落在 `C:\a` 里
/// （`gate::is_strictly_inside` 同一个理由，这里复用它）。
fn deepest_containing(roots: Option<&Vec<String>>, path: &str) -> Option<String> {
    let roots = roots?;
    let key = deepclean_rules::engine::normalize_key(path);
    roots
        .iter()
        .filter(|r| {
            let rk = deepclean_rules::engine::normalize_key(r);
            deepclean_cleaner::is_strictly_inside(&key, &rk) || key == rk
        })
        .max_by_key(|r| deepclean_rules::engine::normalize_key(r).matches('\\').count())
        .cloned()
}

/// 归属表：确认那一刻，每条被计入的路径属于哪条规则、什么风险、多大。
/// 只从**报告的认领表**取（`all_paths` 优先，退回 `sample_paths`），不猜、不重新走盘。
fn attribution_of(
    report: &RuleReport,
    preview: &PreviewModel,
) -> HashMap<String, deepclean_cleaner::PathAttribution> {
    let mut out = HashMap::new();
    for item in preview.items.iter().filter(|i| i.included) {
        let Some(f) = report.findings.iter().find(|f| f.rule_id == item.rule_id) else { continue };
        for h in f.all_paths.as_ref().unwrap_or(&f.sample_paths) {
            out.entry(deepclean_rules::engine::normalize_key(&h.path)).or_insert_with(|| {
                deepclean_cleaner::PathAttribution {
                    rule_id: f.rule_id.clone(),
                    risk: f.risk_level,
                    bytes: h.size,
                }
            });
        }
    }
    out
}

/// §18：拿一张确认回执去真删。**唯一的删除入口**，且它只认 `digest`。
///
/// 授权根取会话扫描根 —— 扫的是 `C:\` 就会被 `root-is-drive-root` 整批拒绝，
/// 这是**刻意的**（§28 原则四），不是缺陷。
pub fn run_cleanup(app: &AppHandle, state: &AppState, digest: &str) -> Result<CleanTask, String> {
    let plan = lookup_plan(state, digest)?;
    let task_id = format!("clean-{}-{}", now_ms(), state.seq.fetch_add(1, Ordering::SeqCst));
    let task = execute_plan(&plan, state, Some(app), &task_id, false);
    // 派生账本必须在任务落地之后、事件发出去之前 —— 否则记录页收到 `done` 去查时还是空的
    // （`CleanHistory` 就是拿 `onCleanEvent` 的 done 触发 `load()` 的）。
    record_journal(state, &task, &plan);
    let _ = app.emit(CLEAN_EVENT, CleanEventWire { kind: "done".into(), task: task.clone() });
    Ok(task)
}

/* ------------------------------------------------------------------ *
 * M6 免确认清理档：一键清理
 * ------------------------------------------------------------------ */

/// 免确认名单（M6 的产物）—— **2026-10-24 起一键清理不再用它**：
/// 人类伙伴当天定的是「点击后只清理勾选的内容」，名单由界面勾选决定。
///
/// 这一段留着的理由与 [`auto_clean_selection`] 同一处：它还是那张「哪些规则算纯垃圾、
/// 哪些要过进程闸」的知识表，而那张表将来要变成**默认勾选**的依据
/// （现在默认勾选由 `defaultUnselectableRuleIds` 决定，两套口径并存）。
/// 等两者合并成一处后删。
///
/// 名单里的每一条都对着用户定的口径（纯垃圾 / 安装包 / 显卡老驱动与着色器缓存 /
/// 应用残留缓存）：
/// - 前六条 🟢（可再生或无留存价值）+ `installer-artifacts` 🟡 + `user-downloads-installers` 🟠；
/// - `orphan-app-data` 🟠 —— 「应用是否安装、是否存在进程」在规则层就判完了
///   （机器事实闸：安装痕迹有、本体四路查无才提议）；
/// - `app-cache-data` 🟡 —— 唯一要**再过一道进程闸**的一条：缓存目录的「应用键」
///   撞上在跑的进程 ⇒ 那条路径这次不删（[`auto_clean_app_cache_paths`]）。
#[allow(dead_code)]
pub const AUTO_CLEAN_RULE_IDS: &[&str] = &[
    "windows-temp",
    "browser-cache",
    "thumbnail-cache",
    "shader-cache",
    "error-reporting",
    "gpu-driver-leftovers",
    "installer-artifacts",
    "user-downloads-installers",
    "orphan-app-data",
    "app-cache-data",
];

/// 在跑进程的**路径段集合**（小写）。进程镜像路径按 `\` `/` 拆段，段名小写入集合 ——
/// 「应用键撞进程段」这一格的全部原料。快照**现取**（进程表是瞬时状态，不缓存）。
///
/// ⚠️ 2026-10-24：`run_auto_clean` 改按勾选后，这条与 [`app_is_running`] /
/// [`auto_clean_app_cache_paths`] 一起**不再被产品路径调用**（进程闸的迁移还没做，
/// 见 [`AUTO_CLEAN_RULE_IDS`] 那段注释）。测试仍在用，所以只挂 `allow(dead_code)` 不删。
#[allow(dead_code)]
fn running_process_segments() -> std::collections::BTreeSet<String> {
    use deepclean_appfacts as af;
    let snap = af::procs::collect_process_snapshot();
    let mut out = std::collections::BTreeSet::new();
    for r in &snap.records {
        let raw = r.image.as_deref().unwrap_or(r.exe.as_str());
        for seg in raw.split(['\\', '/']) {
            let seg = seg.trim();
            if !seg.is_empty() {
                out.insert(seg.to_lowercase());
            }
        }
    }
    out
}

/// `app-cache-data` 的进程闸（M6）：这条缓存路径的「应用键」——三根容器（`%LOCALAPPDATA%`
/// `%APPDATA%` `%PROGRAMDATA%`）之下**第一段**目录名 —— 是否撞上某个在跑进程的路径段。
/// 撞上 = 应用在跑 ⇒ 这次不删（`true`）。应用键取不出来（路径不在三根之下）⇒
/// **当作在跑**（fail-safe：宁少删，不许一条取不出键的路径溜进真删通道）。
fn app_is_running(path: &str, env: &RuleEnv, running: &std::collections::BTreeSet<String>) -> bool {
    let p = deepclean_rules::engine::normalize_key(path);
    let key = ["LOCALAPPDATA", "APPDATA", "PROGRAMDATA"]
        .iter()
        .filter_map(|var| env.get(*var).map(|root| deepclean_rules::engine::normalize_key(root)))
        .filter_map(|root| {
            let prefix = format!("{root}\\");
            p.strip_prefix(&prefix)
                .map(|rest| rest.split('\\').next().unwrap_or("").to_string())
        })
        .find(|k| !k.is_empty());
    match key {
        None => true,
        Some(k) => running.contains(&k),
    }
}

/// 把报告里免确认名单的 finding 翻成选区 JSON（`dc_preview` 的 selection 形状）。
/// `app-cache-data` 逐路径过滤（进程闸），其余整项勾选；0 字节的不进选区。
/// `collect_all_paths` 在 [`rule_report`] 里对全表点名，所以这里的逐路径清单是**全量**。
/// 进程段集合由调用方给（`run_auto_clean` 现取一次）—— 注入才让选区判据能拿构造的
/// 段集合测，不用每次测试都采一遍真机镜像。
///
/// ⚠️ 2026-10-24：`run_auto_clean` 已改成按勾选（名单从渲染端来），这个函数**不再被产品路径调用**。
/// 它连同 [`AUTO_CLEAN_RULE_IDS`] 一起留着，因为它们还钉着两条有用的判据
/// （「在跑应用的缓存不删」「取不出应用键按在跑算」），而那两条将来要挂到勾选链上。
/// 等那条迁移做完一起删。
#[allow(dead_code)]
fn auto_clean_selection(
    report: &RuleReport,
    env: &RuleEnv,
    running: &std::collections::BTreeSet<String>,
) -> Vec<serde_json::Value> {
    let mut items: Vec<serde_json::Value> = Vec::new();
    for f in &report.findings {
        if !AUTO_CLEAN_RULE_IDS.contains(&f.rule_id.as_str()) || f.total_bytes == 0 {
            continue;
        }
        if f.rule_id == "app-cache-data" {
            let paths: Vec<String> = auto_clean_app_cache_paths(f, env, &running);
            if !paths.is_empty() {
                items.push(serde_json::json!({ "ruleId": f.rule_id, "paths": paths }));
            }
        } else {
            items.push(serde_json::json!({ "ruleId": f.rule_id }));
        }
    }
    items
}

/// 先跑一遍**不带确认**的预览，从里面读出「这次勾选要求按到哪一档」
/// （= 已计入项里的最高档，`confirm::required_tier` 同一口径）。
///
/// 为什么要先跑一趟：`build_preview` 的 `acknowledged_risk` 是入参，而它的正确值
/// 取决于**这份勾选算出来的模型**。写死 High 会让任何含 🟠 的勾选都能过（过度授权），
/// 写死 Safe 会让含 🟡 的都过不了。所以先算模型、再按模型给档。
///
/// 代价：这一趟是纯内存评估（报告有缓存），毫秒级；紧跟的那一趟 `confirm=true` **永不复用缓存**
/// （授权凭据必须锚在当下这份机器事实上），所以总共两次评估。可接受。
fn required_tier_for_selection(
    state: &AppState,
    scan_id: &str,
    selection: &serde_json::Value,
    tile_paths: &[serde_json::Value],
) -> Result<Risk, String> {
    let peek = build_preview(
        state,
        scan_id,
        selection.clone(),
        None,
        None,
        Some(tile_paths.to_vec()),
    )?;
    let Some(p) = peek else {
        return Err("E_NO_SCAN：会话没有可用的报告".into());
    };
    // 与 `shared/classify` 的 `requiredRiskOf` / Rust `confirm::required_tier` 同一条：
    // 只看 included，🔴 不抬档（它不可能合法地进 included），空集合退回 Safe。
    let mut tier = Risk::Safe;
    for i in p.preview.items.iter().filter(|i| i.included) {
        let rank = |r: Risk| match r {
            Risk::Safe => 0,
            Risk::Caution => 1,
            Risk::High => 2,
            Risk::Forbidden => 3,
        };
        if rank(i.risk_level) > rank(tier) && i.risk_level != Risk::Forbidden {
            tier = i.risk_level;
        }
    }
    Ok(tier)
}

/// 进程闸过滤出**这次可以真删**的那部分 app-cache-data 路径。
/// 拆出独立函数是为了子单元测试能直接喂构造的 finding（不用起一台真机器）。
///
/// ⚠️ 2026-10-24 起 `run_auto_clean` **不再调用它**（一键清理改成按勾选，名单不再由服务端挑）。
/// 保留的理由：它是「应用在跑就别删它的缓存」这条判据的**唯一实现**，而那条判据本身
/// 现在挂在 `build_preview_model` 的勾选链上（用户可以把正在跑的应用缓存勾进来 ——
/// 那时挡它的是执行器的路径闸，不是这里）。等那条迁移做完，这个函数与
/// [`AUTO_CLEAN_RULE_IDS`] 一起删。**在那之前它仍然是这条判据的可测入口**（有 6 条单测钉着）。
#[allow(dead_code)]
fn auto_clean_app_cache_paths(
    f: &deepclean_rules::engine::RuleFinding,
    env: &RuleEnv,
    running: &std::collections::BTreeSet<String>,
) -> Vec<String> {
    f.all_paths
        .as_ref()
        .unwrap_or(&f.sample_paths)
        .iter()
        .map(|h| h.path.clone())
        .filter(|p| !app_is_running(p, env, running))
        .collect()
}

/// 一键清理（2026-10-24 改口径）。
///
/// ## 它现在是什么
///
/// **按界面上勾的那几项清**。人类伙伴当天定下的两条：「一键清理去掉开关」、
/// 「点击后只清理勾选的内容」。所以：
///
/// 1. **不再读设置开关**（`autoCleanEnabled` 已从设置里删除）。原先它是总闸，关着时整条
///    回 `E_AUTO_CLEAN_DISABLED` —— 而那句话渲染在页面底部，滚出屏幕之后与"按钮坏了"
///    长得一模一样，这正是本次要修的那个症状的第一半。
/// 2. **名单由渲染端报**（`selection`，即用户勾的那些 ruleId + 从地图加进来的 tilePaths）。
///    这与 M6 那条「名单不从客户端来」的纪律**相反**，所以要说清为什么现在敢：
///    - 渲染端报的仍然只是**勾了哪几条规则**，不是路径清单。路径依旧由服务端从报告里取
///      （`executable_batches` 读 `RuleFinding.all_paths`），渲染端一个字节的清单都插不进来。
///    - 勾选要过 `build_preview_model` 的全套判据：🔴 不可勾、只上报根逐条拒、
///      禁止根逐条拒、越界拒。**绕不过任何一道** —— 它走的就是手动档同一条预览链。
///    - 回执按档：内部 confirm 用 `required_tier` 算出来的那一档，不是固定 High。
/// 3. **仍然是真删**（`permanent=true`，不进回收站）。那是人类伙伴当天选的。
///
/// ## 它曾经是什么（留档，免得有人按旧注释改回去）
///
/// 旧实现用自己的固定名单 [`AUTO_CLEAN_RULE_IDS`]，且授权根取会话扫描根 —— 扫盘根时
/// 整批被 `root-is-drive-root` 拒。两件事叠在一起就是"点了清理一个文件都没动"。
///
/// ## 已知的时间窗（如实登记）
///
/// 进程闸（`app_is_running`）是**另一次**采集，与 `build_preview` 内部那次
/// （orphan-app-data 的机器事实）不共享快照 —— 中间几百毫秒里应用状态变化不在第二次判定里。
/// 方向是安全的：`orphan-app-data` 第二次判成 present 时 finding 消失，
/// `executable_batches` 取不到清单 ⇒ 自然不执行。
pub fn run_auto_clean(
    app: &AppHandle,
    state: &AppState,
    scan_id: &str,
    selection: serde_json::Value,
    tile_paths: Vec<serde_json::Value>,
) -> Result<CleanTask, String> {
    // 选区必须由调用方（渲染端）给，且必须是非空的 items 数组 ——
    // "没给勾选"不许被解读成"那就清全部"（那是替用户按了全选）。
    let items_empty = selection
        .get("items")
        .and_then(|v| v.as_array())
        .map(|a| a.is_empty())
        .unwrap_or(true);
    if items_empty && tile_paths.is_empty() {
        return Err("E_AUTO_CLEAN_NOTHING：一项都没勾（勾选的内容为空）→ 什么都不删".into());
    }

    // 档位：用 `required_tier` 那一套口径算出来（已计入项里的最高档），
    // 不是固定 High。界面上"我了解"那个勾选框在合并成一颗按钮时已经去掉了，
    // 所以这一步的"确认"语义就是**按下这颗按钮**本身。
    // 内部 confirm 的 acknowledged 恒 true —— 用户按下按钮就是那个动作。
    let tier = required_tier_for_selection(state, scan_id, &selection, &tile_paths)?;

    let payload = build_preview(state, scan_id, selection, Some(true), Some(tier), Some(tile_paths))?;
    let Some(payload) = payload else {
        return Err("E_NO_SCAN：会话没有可用的报告".into());
    };
    let Some(c) = payload.confirmation else {
        return Err("E_AUTO_CLEAN_REFUSED：确认没有出回执 → 什么都不删".into());
    };
    if !c.confirmed {
        return Err(format!(
            "E_AUTO_CLEAN_REFUSED：确认被拦（{:?}）→ 什么都不删",
            c.blockers
        ));
    }

    let plan = lookup_plan(state, &c.digest)?;
    let task_id = format!("auto-{}-{}", now_ms(), state.seq.fetch_add(1, Ordering::SeqCst));
    let task = execute_plan(&plan, state, Some(app), &task_id, true);
    record_journal(state, &task, &plan);
    let _ = app.emit(CLEAN_EVENT, CleanEventWire { kind: "done".into(), task: task.clone() });
    Ok(task)
}

/// 回执查不到 ⇒ **一句 E_UNKNOWN_CONFIRMATION，什么都不删**。
/// 拆出来是为了让这条能被判据真跑到（`run_cleanup` 要 `AppHandle`，子单元给不出）。
pub fn lookup_plan(state: &AppState, digest: &str) -> Result<ConfirmedPlan, String> {
    state
        .confirmations
        .lock()
        .unwrap()
        .get(digest)
        .cloned()
        .ok_or_else(|| "E_UNKNOWN_CONFIRMATION: 没有这张确认回执（或它已过期）→ 什么都不删".to_string())
}

/// 执行链里不依赖 `AppHandle` 的那一半 —— 拆出来是为了那三条**整批拒绝**的判据能被子单元
/// 直接跑到（它们一次文件都不该动，所以用真 `WindowsCleanFs` 也是安全的）。
///
/// `permanent`（M6 免确认清理档）：true = 真删（不进回收站）。执行器侧的结构闸要求
/// permanent 上下文必须带确认回执（`plan.digest` 在这里总会带上 —— ConfirmedPlan 的键就是它），
/// 所以这一格真正的纪律在调用方：**只有** `run_auto_clean`（免确认档）传 true，
/// 常规确认档（`run_cleanup`）恒为 false。
pub fn execute_plan(
    plan: &ConfirmedPlan,
    state: &AppState,
    app: Option<&AppHandle>,
    task_id: &str,
    permanent: bool,
) -> CleanTask {
    // 每批一条授权根、一张清单，各跑一次执行器，最后并成一个任务。
    //
    // 为什么不是"把各批路径并进一次执行"：执行器的授权根是**一个**字段，而 `guard_authorized_root`
    // 只认一个根。并为一次就必须取公共祖先 —— 而真实清单的公共祖先是 `C:\`（`%TEMP%` 在
    // `C:\Users\…` 下、`%PROGRAMDATA%` 在 `C:\ProgramData` 下），整批又会被 root-is-drive-root 拒。
    // 所以"一次执行 = 一个授权根"这条**执行器契约一个字都不动**，改成多跑几趟。
    //
    // 代价如实登记：
    // 1. §19 清理前后测量是**逐批**的（measure 吃一个根）。合并任务里那一份用「各批 before/after 之和」，
    //    所以 `note` 的口径不再是"这一个目录的前后"，改成"这批地盘各自前后之和"（见 `merge_tasks`）。
    // 2. 进度条的分母要按**全部批次**算，否则每批都从 0% 跳到 100%。合并时重算（同处）。
    // 3. 取消：每一批都要看到同一个取消标志，所以标志在循环外建、逐批注入。
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));

    // 逐条进度：一个任务一个 sink（它带 taskId，界面按它过滤）。多批共用同一个 ——
    // 每批各建一个会让界面上"滚到第 3 批"时 `done` 从 0 重新数。
    //
    // `app` 可以是 `None`（子单元测试走这条路）：那时不挂进度注入面 —— 执行链照跑，
    // 只是没人收到事件。这与 `CleanLog` 那条「没挂就整段跳过」是同一条纪律。
    // `total` 用 `plan.planned_count()`：进度事件的分母是**整个任务**，
    // 不是某一批 —— 与 `merge_tasks` 重算 progress 用的分母同一个数。
    let progress = app.map(|a| {
        Arc::new(EventProgressSink::new(
            a.clone(),
            task_id.to_string(),
            plan.planned_count(),
        ))
    });

    // 取消把手在整个任务期间**一直在**（不是每批插一次、拔一次）：换批那一瞬间点取消
    // 拿到 `false` 的话，界面会如实说"没取消掉"，而后面几批其实还会开跑。
    // 这里先塞一个只带共享标志的 ctx，`execute_batch` 每批用同一个标志重建 ctx 覆盖它 ——
    // 键不变，所以两次之间不会被看到"不在跑"。
    {
        let placeholder = ExecuteCtx::new(task_id.to_string(), String::new()).with_cancel_flag(cancel.clone());
        state.running.lock().unwrap().insert(task_id.to_string(), placeholder);
    }

    // 跨批共享的进度计数（2026-10-24 并发删除）：报出去的事件是「全局第几条」，
    // 界面那句「已释放 X」是「全局累计」，不是某一批的局部数。
    let shared_done = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let shared_cleaned = Arc::new(std::sync::atomic::AtomicU64::new(0));

    /*
     * 并发删除 —— **2026-10-30 重做：从"一批一条线程"改成"一批切成 N 片"**。
     *
     * ## 为什么改
     *
     * 人类伙伴要的是设置里那格滑块真能调**删除**速度。上一版按批次并发，而批次数
     * 由「授权根有几个」决定（勾了几条规则、每条规则命中几个根）—— 与滑块无关。
     * 实测（`examples/delprobe.rs`，8 核机、32000 文件、真系统线程）：
     *
     * | 并发 | 墙钟 | 相对 1x | 峰值 RSS |
     * | 1 | 7993ms | 1.00x | 4.6MB |
     * | 2 | 5246ms | 1.52x | 4.6MB |
     * | 4 | 3862ms | 2.07x | 4.7MB |
     * | 8 | 3256ms | **2.45x** | 4.8MB |
     * | 16 | 3323ms | 2.40x ← 饱和 | 5.1MB |
     *
     * 三个结论直接决定了这一版怎么写：
     *  ① **饱和在 8**（= 本机逻辑核数）。16 反而慢 2% —— 所以"核数"是对的阈值，
     *     我原来写的 `核数 × 2` 是错的（它允许的 16 恰好是实测负收益那一档）。
     *  ② **内存不是约束**：16 倍并发只多 0.5 MB。所以"拉高会崩"不是内存杀，
     *     是**排队浪费**。保险机制应该是"别让人白等"，不是"防 OOM"。
     *  ③ 加速比封顶 2.45×（不是 8×）说明这项工作大部分串行 —— 瓶颈在文件系统
     *     （一次 delete 的系统调用开销 + NTFS 日志），不在 CPU。所以超过核数没有任何好处。
     *
     * ## 怎么切
     *
     * 一个批次 = 一个授权根 + 一张路径清单。执行器的契约是"一次执行 = 一个授权根"，
     * 这条**一个字没动**（`guard_authorized_root` 只认一个根，并为一次会退化成 `C:\`）。
     * 所以切成 N 片时，每片**仍然用同一个授权根**，只是 `requested_paths` 少一些：
     *
     *   `batch.paths` 按轮转（`i % n`）分给 N 个 `ExecuteCtx`
     *
     * 轮转而不是连续切块：连续切块会让最后一片拿到清单尾部，而清单是排过序的
     * —— 同一目录下的文件会全落在同一片，那一片最慢、其余几片早早空转。
     *
     * ## 三条代价（比上一版更细，逐条登记）
     *
     * 1. **§19 前后测量**：仍然只有**最后一片**做报告（`skip_verification` 置位其余）。
     *    `before` 读数在每片里都会取（那是 `measure()` 的无条件调用），但只有最后一片
     *    把自己的 before/after 写进任务 —— 其余片跳过报告，避免"另一片正在删同一棵树"
     *    把读数搅成中间值。合并口径见 `merge_tasks`。
     * 2. **每片的 `digest` 只覆盖自己那些路径**（`execution_digest(root, accepted)`），
     *    合并后的 `digest` 由 `merge_tasks` 重算 —— 这本来就是逐批重算的，
     *    切片没有改变那件事的形状。
     * 3. **日志行序、`deleted` 清单序**按调度决定，不再与清单序一致。上一版已经如此。
     *
     * ## 空批次与空片
     *
     * `paths` 为空的批次仍然要跑一次（它承载"整批拒绝"的语义 —— 授权根不合法时
     * 拒绝发生在碰任何东西之前）。切片时**空批次不切**，原样一片跑，
     * 否则会切出 N 个都拒绝一次的副本，`refusals` 里同一件事重复 N 遍。
     */
    let workers = read_scan_workers_for_delete(state);
    let mut slices: Vec<(usize, &CleanBatch, Vec<String>)> = Vec::new();
    for (bi, batch) in plan.batches.iter().enumerate() {
        for b in slice_batch_paths(&batch.paths, workers) {
            slices.push((bi, batch, b));
        }
    }
    let n_slices = slices.len();
    let mut parts: Vec<Option<CleanTask>> = vec![None; n_slices];
    std::thread::scope(|scope| {
        let handles: Vec<_> = slices
            .iter()
            .enumerate()
            .map(|(i, (bi, batch, paths))| {
                let state = state;
                let plan = plan;
                let cancel = cancel.clone();
                let progress = progress.clone();
                let shared_done = shared_done.clone();
                let shared_cleaned = shared_cleaned.clone();
                let is_last = i + 1 == n_slices;
                let _ = bi;
                let paths = paths.clone();
                scope.spawn(move || {
                    // 每片开跑前先看一眼：可能已经被用户取消，那这一片一条都不该动。
                    if cancel.load(Ordering::SeqCst) {
                        return None;
                    }
                    Some(execute_slice_concurrent(
                        plan,
                        batch,
                        &paths,
                        state,
                        task_id,
                        permanent,
                        cancel,
                        progress,
                        shared_done,
                        shared_cleaned,
                        is_last,
                    ))
                })
            })
            .collect();
        for (i, h) in handles.into_iter().enumerate() {
            parts[i] = h.join().ok().flatten();
        }
    });
    let parts: Vec<CleanTask> = parts.into_iter().flatten().collect();

    // 任务结束才拔掉这把把手。
    state.running.lock().unwrap().remove(task_id);

    let task = merge_tasks(task_id, parts, plan);

    // 把**真删掉的文件**记进本会话的已删集合（2026-10-24：图二数字要变）。
    // 记的是 `deleted[].ok === true` 且 kind === file 的路径 —— 目录不算：
    // `FilteredSource` 只从 `children_of` 里摘文件，目录行的口径是「还剩多少字节」。
    // 这条必须在 `report_for_preview` 下一次读缓存之前落地（它靠「已删集合非空」作废缓存）。
    if let Some(session) = state.sessions.lock().unwrap().get(plan.scan_id.as_str()).cloned() {
        let mut acc = session.deleted_paths.lock().unwrap();
        for d in task.deleted.iter().filter(|d| d.ok && d.kind == deepclean_cleaner::CleanDeletionKind::File) {
            acc.insert(deepclean_rules::engine::normalize_key(&d.path));
        }
    }

    // §3.6 开发环境页的报告缓存**在这一刻作废**（人类伙伴 2026-10-20：
    // 「保留记录至本次程序关闭或者执行清理操作后」）。
    //
    // 为什么清理后必须作废：那一页的「占用」列读的是**扫描那棵树**得出的报告，
    // 而清理删掉了树里的真实文件 —— 缓存里的字节从此比磁盘上的实况大。
    // 留着它，用户会看到"npm 缓存还有 1.7 MB"，而那一格其实已经空了。
    //
    // 缓存容量本来就是 1（一次只有一个会话在跑），所以整个作废即可。
    // 下次进开发环境页会重新算一遍（那 12 秒）—— 但那正是清理之后**应该**付的代价：
    // 数字必须重新对现实。
    //
    // ⚠️ 探测器那张表（「装没装」）**不在这里作废**：它描述的是安装状态，
    // 删缓存文件不会让一个工具变成"没装"。作废它只会让下次进页面再付一次 1.7 s，
    // 而那次查询的答案与这次清理无关。
    *dev_env_report_slot().lock().unwrap() = None;

    {
        let mut t = state.tasks.lock().unwrap();
        t.insert(task_id.to_string(), task.clone());
        let mut order = state.task_order.lock().unwrap();
        order.push(task_id.to_string());
    }
    task
}

/// 删除并发度 —— 读设置里那格「删除速率」（2026-10-30）。
///
/// ## 为什么这一格现在有两个读者
///
/// 上一版它只喂扫描（`scan_parallel`）。人类伙伴要的是它能调**删除**速度，
/// 所以这一版把它也接到删除链上（`execute_plan` 的切片数）。
/// 两个读者用同一个键是有意的：界面上只有一格，用户调它时期望的是"整体快一点"，
/// 而不是"扫描快、删除不动"。
///
/// ## 默认值 = 逻辑核数的 60%
///
/// `SCAN_WORKERS_AUTO`（0）落成 `核数 × 0.6`（四舍五入，至少 1）—— 与设置页
/// 滑块的默认档同一个算式（`PerformanceCard` 的 `defaultWorkers`）。
///
/// 为什么是 60% 而不是 100%：实测（`examples/delprobe.rs`）加速比饱和在核数，
/// 8 线程 2.45× 与 5 线程的差距远小于直觉 —— 文件系统日志把并行收益封顶了。
/// 默认留 40% 的核给机器上跑着的别的活：清理是瞬时突发负载，
/// 默认不占满全部核是 polite 的那一档。用户拉满也不崩（内存不涨），
/// 只是那几秒里别的程序少几个核。
///
/// ## 为什么这里拿不到 `AppHandle`
///
/// `execute_plan` 的签名里没有 `app`（它是 `Option<&AppHandle>`，子单元测试传 `None`）。
/// 而设置文件的路径要么从 app 推、要么从 `DC_SETTINGS_DIR` 覆盖 —— 前者不可用。
/// 所以这一格走 `state` 上缓存的那份：**`dc_start` / `dc_settings_set` 每次成功后
/// 都会把当前设置抄一份进去**（见 `AppState::cached_settings`）。读不到就用默认算式。
fn read_scan_workers_for_delete(state: &AppState) -> usize {
    let declared = state.cached_settings.lock().unwrap().scan_workers;
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(2).max(1);
    if declared == crate::settings::SCAN_WORKERS_AUTO {
        // 与设置页 `PerformanceCard` 的 `defaultWorkers` 同一条算式（见 `default_workers_of`）。
        return default_workers_of(cores);
    }
    // 与内核 `clamp_workers` 同一把尺子：1..=核数。手改文件写了 99999 也不许开 99999 条线程。
    declared.clamp(1, cores)
}

/// 把一批切成 N 片 —— **纯函数**，好让"切片本身对不对"能被子单元直接钉住
/// （不需要文件系统、不需要起线程）。
///
/// ## 三条口径，每条都有代价
///
/// 1. **轮转分片**（`i % n`）而不是连续切块：清单是排过序的，连续切块会让
///    同一目录下的文件全落进同一片 —— 那一片最慢、其余几片早早空转，
///    并发度白加。轮转让每一片都横跨整张清单。
///
/// 2. **空批次不切**：`paths` 为空时回一片空切片，不是 N 片。那一批承载的是
///    "整批拒绝"的语义（授权根不合法时，拒绝要发生在碰任何东西之前）——
///    切成 N 片会让同一件事在 `refusals` 里重复 N 遍。
///
/// 3. **片数 = `min(路径数, workers)`**：路径比线程少时多开线程只是空转。
///    这个 `min` 也是"用户把滑块拉到 8、但只勾了 3 个文件"这种情况的正确处置。
///
/// 返回的是 `Vec<Vec<String>>`：外层一片一层。
fn slice_batch_paths(paths: &[String], workers: usize) -> Vec<Vec<String>> {
    let workers = workers.max(1);
    if paths.is_empty() {
        return vec![Vec::new()];
    }
    let n = paths.len().min(workers);
    let mut buckets: Vec<Vec<String>> = vec![Vec::new(); n];
    for (i, p) in paths.iter().enumerate() {
        buckets[i % n].push(p.clone());
    }
    buckets
}

/// 「删除速率」的**默认档 = 核数的 60%**（2026-10-30 第三轮，人类伙伴点名）。
///
/// 与设置页 `PerformanceCard` 的 `defaultWorkers` 同一条算式 —— 两侧必须给同一个数，
/// 否则界面上写着「默认推荐 = 5 线程」而实际跑 8 线程，那是两套真相。
/// 这一格没法直接测（它吃 `&AppState`，而 `cached_settings` 在构造里），
/// 所以把**算式**抽成这个纯函数，两侧各自调用它。
fn default_workers_of(cores: usize) -> usize {
    ((cores.max(1) as f64) * 0.6).round().max(1.0) as usize
}

/// 跑**一片**（2026-10-30 切片并发）。授权根就是这一批的地盘，`paths` 是这一片分到的子集。
///
/// 与上一版 `execute_batch_concurrent` 的唯一差别就是 `paths`：那个跑整批，
/// 这个跑整批里按轮转分出来的一片。**授权根、禁止模式、确认回执、共享计数、
/// 取消标志全部与整批那一次逐字相同** —— 切片只动"这一次要碰哪些路径"这一件事。
///
/// `cancel` 由调用方持有 —— 取消按钮立的是它，而每一片都要看见同一个标志
/// （否则「取消」只停得下正在跑的那一片）。`shared_done` / `shared_cleaned` 是跨片
/// 共享的进度计数；`is_last` 决定这一片做不做 §19 前后测量的**报告**
/// （只有最后一片报告，理由见 `execute_plan` 那段注释）。
fn execute_slice_concurrent(
    plan: &ConfirmedPlan,
    batch: &CleanBatch,
    paths: &[String],
    state: &AppState,
    task_id: &str,
    permanent: bool,
    cancel: Arc<std::sync::atomic::AtomicBool>,
    progress: Option<Arc<EventProgressSink>>,
    shared_done: Arc<std::sync::atomic::AtomicUsize>,
    shared_cleaned: Arc<std::sync::atomic::AtomicU64>,
    is_last: bool,
) -> CleanTask {
    let ctx = ExecuteCtx::new(task_id.to_string(), batch.root.clone())
        .with_env(rule_env())
        .with_forbidden_patterns(
            deepclean_rules::FORBIDDEN_PATH_PATTERNS.iter().map(|s| s.to_string()).collect(),
        )
        .with_report_only_patterns(
            deepclean_rules::REPORT_ONLY_ROOT_PATTERNS.iter().map(|s| s.to_string()).collect(),
        )
        // ⚠️ 这一行是切片与整批的唯一实质差别：片上只带自己那些路径。
        .with_requested_paths(paths.to_vec())
        .with_confirmation_digest(plan.digest.clone())
        .with_permanent(permanent)
        .with_now_ms(now_ms())
        // 取消标志是**共享**的：`dc_cancel_cleanup` 立起一次，所有片都要看到。
        .with_cancel_flag(cancel)
        .with_shared_done(shared_done)
        .with_shared_cleaned(shared_cleaned)
        .with_skip_verification(!is_last);

    // §29：挂上逐条删除的落盘日志。`init_clean_log` 没挂上（建不出文件）时这一格是 `None`，
    // 执行链照跑 —— 日志不参与判定，那条不变量由 `attaching_a_logger_changes_nothing_about_the_outcome` 钉。
    let ctx = match state.clean_log.lock().unwrap().as_ref() {
        Some(l) => ctx.with_log(l.clone()),
        None => ctx,
    };
    // §18 的逐条进度：界面那个弹窗靠它滚列表。
    let ctx = match progress {
        Some(p) => ctx.with_progress(p as Arc<dyn deepclean_cleaner::CleanProgress>),
        None => ctx,
    };

    // 把这一批的 ctx 挂上去（**不**在这里移除：整个任务期间这个键要一直在，
    // 否则换批的空隙里点取消会拿到 false。移除由 `execute_plan` 在全部批次跑完后做）。
    state.running.lock().unwrap().insert(task_id.to_string(), ctx.clone());
    let task = execute_cleanup(&ctx, &WindowsCleanFs::new());
    task
}

/// 把若干批的结局并成一个 `CleanTask`。
///
/// 合并口径每一条都要说清，因为它们都是"看起来显然、其实各有取舍"的那类：
/// 1. **counts / sizes** 直接相加。`success_count` / `failed_count` / `cleaned_size` 都可加。
/// 2. **progress** 重算成 `已处理 / 全部计划`，**不是**各批 progress 的平均
///    （平均会让"第一批 100%、第二批 0%"显示成 50%，而实际已经过半）。
/// 3. **status**：任一批 cancelled ⇒ cancelled；有一批 refused 而另一批真删了 ⇒ completed
///    （`refused` 的语义是"一根手指都没动"，整次任务只在**全部**批次都没动时才配这个状态）。
/// 4. **blockers**：各批拼起来，`reason+detail` 相同的只留一条 —— 两批因为同一件事被拒时，
///    屏幕上出现两行一模一样的话读起来像两个问题。
/// 5. **verification**：各批前后字节相加，`note` 重写成"这批地盘各自前后之和"的口径 ——
///    不能把某一批的 `note` 原样拿来念（那句话说的是"授权根表观大小"，而合并之后授权根不止一个了）。
fn merge_tasks(task_id: &str, parts: Vec<CleanTask>, plan: &ConfirmedPlan) -> CleanTask {
    use deepclean_cleaner::{CleanTaskStatus, CleanVerification};

    let mut merged = CleanTask {
        id: task_id.to_string(),
        status: CleanTaskStatus::Pending,
        progress: 0.0,
        total_size: 0,
        cleaned_size: 0,
        success_count: 0,
        failed_count: 0,
        authorized_root: plan.root_label(),
        requested_paths: plan.batches.iter().flat_map(|b| b.paths.clone()).collect(),
        accepted_paths: Vec::new(),
        blockers: Vec::new(),
        refusals: Vec::new(),
        deleted: Vec::new(),
        dirs_removed: Vec::new(),
        verification: None,
        digest: plan.digest.clone(),
        confirmation_digest: Some(plan.digest.clone()),
        started_at_ms: 0,
        finished_at_ms: 0,
    };

    if parts.is_empty() {
        // 一条批次都没有（确认过的清单是空的）：不该执行到这里，但也不许编一个 completed。
        merged.status = CleanTaskStatus::Refused;
        return merged;
    }

    let mut any_cancelled = false;
    let mut any_ran = false;
    let mut all_refused = true;
    let planned = plan.planned_count().max(1);

    let (mut before_bytes, mut after_bytes) = (0u64, 0u64);
    let (mut files_before, mut files_after) = (0u64, 0u64);
    let (mut before_free, mut after_free) = (Some(0u64), Some(0u64));
    let mut free_before_seen = false;
    let mut free_after_seen = false;
    let mut verify_note_parts: Vec<String> = Vec::new();

    for p in parts {
        merged.total_size += p.total_size;
        merged.cleaned_size += p.cleaned_size;
        merged.success_count += p.success_count;
        merged.failed_count += p.failed_count;
        merged.accepted_paths.extend(p.accepted_paths);
        merged.deleted.extend(p.deleted);
        merged.dirs_removed.extend(p.dirs_removed);
        merged.refusals.extend(p.refusals);
        for b in p.blockers {
            if !merged.blockers.iter().any(|x| x.reason == b.reason && x.detail == b.detail) {
                merged.blockers.push(b);
            }
        }
        if p.status == CleanTaskStatus::Cancelled {
            any_cancelled = true;
        }
        if p.status != CleanTaskStatus::Refused {
            any_ran = true;
            all_refused = false;
        }
        if let Some(v) = p.verification {
            before_bytes += v.root_bytes_before;
            after_bytes += v.root_bytes_after;
            files_before += v.files_before;
            files_after += v.files_after;
            if let Some(b) = v.free_bytes_before.flatten() {
                before_free = Some(before_free.unwrap_or(0) + b);
                free_before_seen = true;
            }
            if let Some(a) = v.free_bytes_after.flatten() {
                after_free = Some(after_free.unwrap_or(0) + a);
                free_after_seen = true;
            }
            verify_note_parts.push(v.note);
        }
        merged.started_at_ms = if merged.started_at_ms == 0 {
            p.started_at_ms
        } else {
            merged.started_at_ms.min(p.started_at_ms)
        };
        merged.finished_at_ms = merged.finished_at_ms.max(p.finished_at_ms);
    }

    merged.status = if any_cancelled {
        CleanTaskStatus::Cancelled
    } else if all_refused {
        CleanTaskStatus::Refused
    } else if any_ran {
        CleanTaskStatus::Completed
    } else {
        CleanTaskStatus::Pending
    };

    // 进度按**全部计划**重算：已处理 = 成功 + 失败。
    // 拒绝的不算"处理过" —— 它们一条都没动，算进去会让"整批被拒"显示成 100% 完成。
    let handled = (merged.success_count + merged.failed_count) as usize;
    merged.progress = if merged.status == CleanTaskStatus::Refused {
        0.0
    } else if handled >= planned {
        1.0
    } else {
        handled as f64 / planned as f64
    };

    // 任务指纹就报**确认那一个 digest** —— 它是授权凭据，也是记录页 join 的键。
    // 多批时把各批指纹再哈希一遍会造出第四种指纹口径，而没有任何一条链需要它。
    merged.digest = plan.digest.clone();

    if !verify_note_parts.is_empty() {
        let actual = before_bytes.saturating_sub(after_bytes) as i64;
        merged.verification = Some(CleanVerification {
            root_bytes_before: before_bytes,
            root_bytes_after: after_bytes,
            actual_freed_bytes: actual,
            predicted_freed_bytes: merged.total_size,
            deleted_bytes: merged.cleaned_size,
            delta_bytes: actual - merged.total_size as i64,
            files_before,
            files_after,
            // 任何一批没采到 ⇒ 整格「未采集」。混着报会让人以为那个数是全量的。
            free_bytes_before: if free_before_seen { Some(before_free) } else { Some(None) },
            free_bytes_after: if free_after_seen { Some(after_free) } else { Some(None) },
            note: format!(
                "§19 对账：这次动的是 {} 块地盘（本次：{}），每一块各自测了前后再相加。三格数是各块地盘表观大小之和，不是某一个目录的前后差 —— 授权根已经不再是一个，所以授权根表观大小这种读法在这份任务上不成立。口径仍是逐路径表观大小之和，不含硬链接 inode 去重：磁盘上真省了多少看可用空间那一格。",
                plan.batches.len(),
                plan.root_label()
            ),
        });
    }

    merged
}

/// 请求取消一个正在跑的清理任务。`false` = 那个任务不在跑（已结束或从来不存在）。
///
/// 2026-10-24：任务现在会跑多批。`state.running` 里存的是**当时那一批**的 ctx，
/// 而批次之间那个键是空的（每批各自插入/移除）—— 于是"恰好在换批的那一瞬间点取消"
/// 会拿到 `false`，界面照实说"没取消掉"，而后面几批其实还会跑。
/// 现在的做法：**整个任务期间都留一个把手**，键是 ctx 本身，而 ctx 里的 `cancel`
/// 是所有批次共用的那一个 `Arc`（见 `execute_plan`）。换批只需换 ctx，标志不变。
pub fn cancel_cleanup(state: &AppState, task_id: &str) -> bool {
    match state.running.lock().unwrap().get(task_id) {
        Some(ctx) => {
            ctx.cancel();
            true
        }
        None => false,
    }
}

/// 一次清理的结局派生成**一条**日志。任务结束的那一刻派生一次。
///
/// 2026-10-25 重做：旧版把结局摊平成「一个文件一行」写进内存账本；现在是一条 run，
/// 只记成功的文件（人类伙伴定的），落盘保留 30 天。
///
/// **写盘在锁内**（设计 §10.3 定的并发模型）：一把 `Mutex<JournalStore>` 同时守住
/// 内存账本与落盘，不另起写线程、不去抖。「关掉程序 → 重开还在」那条判据是硬判据，
/// 延迟写会让它偶现失败。
///
/// 淘汰是**双保险**的一半（另一半是 `spawn_journal_pruner` 的每小时一次）：
/// 只靠定时的话，一台从不关机的机器会长期带着过期数据。
pub fn record_journal(state: &AppState, task: &CleanTask, _plan: &ConfirmedPlan) {
    // 整批被拒 / 取消到一条没删：不产生日志条目。
    // （`build_run` 对空 files 也回 None，这里先判一次是为了不去抢锁。）
    if matches!(task.status, deepclean_cleaner::CleanTaskStatus::Refused) {
        return;
    }
    let Some(run) = deepclean_cleaner::build_run(&task.id, task.finished_at_ms, &task.deleted) else {
        // 0 个成功文件 ⇒ 没有"清理了多少"可记。整批只删了空目录也走这里。
        return;
    };

    let path = state.journal_path.lock().unwrap().clone();
    let mut store = state.journal.lock().unwrap();
    store.push(run);
    store.prune(now_ms());
    if let Some(p) = path {
        // 记账失败不该让清理回滚：内存里那份已经是对的，盘上晚一步而已。
        if let Err(e) = store.save(&p) {
            eprintln!("[dc] 清理日志没落盘（{e}）→ 内存里那条还在，重启后会丢");
        }
    }
}

/// 落盘位置：`<app_data>/logs/clean-journal.json`。
///
/// 与 `cleanlog::FileCleanLog::create` 同一个目录树（`logs/`），
/// 因为它们是同一件事的两张脸：逐条操作日志与"每次清理一条"的账本。
pub fn journal_path(app_data: &Path) -> PathBuf {
    app_data.join("logs").join("clean-journal.json")
}

/// 启动时读盘 + 起淘汰线程。照 `init_clean_log` 的注入手法。
pub fn init_journal_store(app: &AppHandle) {
    use tauri::Manager;
    let made = app.path().app_data_dir().map(|dir| journal_path(&dir));
    match made {
        Ok(p) => {
            let state = app.state::<AppState>();
            let loaded = crate::journal_store::JournalStore::load(&p);
            let n = loaded.runs().len();
            *state.journal.lock().unwrap() = loaded;
            *state.journal_path.lock().unwrap() = Some(p.clone());
            eprintln!("[dc] 清理日志：读到 {n} 条（{p:?}）");
        }
        Err(e) => {
            // 定不出目录 ⇒ 内存照记、不落盘。不是致命错误。
            eprintln!("[dc] 清理日志没能确定落盘位置（{e}）→ 本次只在内存里记");
        }
    }
}

/// 每小时淘汰一次超过 30 天的日志。
///
/// 为什么不用 `tauri::async_runtime` 定时器：这个是纯阻塞的短活（读内存 + 偶尔写一次盘），
/// 起一条普通线程最省事，也不必和运行时的关闭顺序纠缠。
pub fn spawn_journal_pruner(app: AppHandle) {
    use tauri::Manager;
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(3600));
        let state = app.state::<AppState>();
        let path = state.journal_path.lock().unwrap().clone();
        let mut store = state.journal.lock().unwrap();
        let removed = store.prune(now_ms());
        if removed > 0 {
            if let Some(p) = path {
                match store.save(&p) {
                    Ok(()) => eprintln!("[dc] 清理日志：淘汰了 {removed} 条超过 30 天的记录"),
                    Err(e) => eprintln!("[dc] 清理日志：淘汰失败（{e}）"),
                }
            }
        }
    });
}
/// 日志列表：**倒序**（新的在前），已过期的顺手剔除。
///
/// 2026-10-25 重做：旧的 `journal_query` 是「三维筛选 + 分页 + 行合计」，读的是内存里
/// 一个文件一行的账本。现在列表的单位是**一次清理**，排序只有时间一维 ——
/// 30 天窗口本身就是时间维，再加筛选是下一版的事（设计 §9 登记过）。
pub fn journal_runs(state: &AppState) -> Vec<deepclean_cleaner::CleanRun> {
    let now = now_ms();
    let store = state.journal.lock().unwrap();
    let mut out: Vec<_> = store
        .runs()
        .iter()
        .filter(|r| deepclean_cleaner::journal_view::within_retention(r, now))
        .cloned()
        .collect();
    // 新的在前；同一毫秒的按 id 排，保证次序可复现
    out.sort_by(|a, b| b.ended_at_ms.cmp(&a.ended_at_ms).then_with(|| a.id.cmp(&b.id)));
    out
}

/// 某一次清理的**第一层**目录汇总（详情页打开时拉这一个）。
///
/// 未知 id ⇒ 空 Vec，不报错：界面上"这一层没有东西"与"这条不存在"是同一种空态。
pub fn journal_dir_summary(state: &AppState, run_id: &str) -> Vec<deepclean_cleaner::DirSummary> {
    let store = state.journal.lock().unwrap();
    match store.get(run_id) {
        Some(run) => deepclean_cleaner::journal_view::summarize_roots(run),
        None => Vec::new(),
    }
}

/// 某个目录的**下一层**（懒加载：点开一层拉一层）。
pub fn journal_dir_children(
    state: &AppState,
    run_id: &str,
    dir: &str,
) -> Vec<deepclean_cleaner::DirEntry> {
    let store = state.journal.lock().unwrap();
    match store.get(run_id) {
        Some(run) => deepclean_cleaner::journal_view::children_of(run, dir),
        None => Vec::new(),
    }
}

/* ------------------------------------------------------------------ *
 * M4 离线授权：`activate` / `status` 两个语义入口的 IPC 侧
 *
 * 这一层**只做三件事**：定目录、把 Rust 枚举翻成界面拿得到的 JSON、把 crate 的错误翻成
 * 带稳定 `E_` 码的串。判定一律在 `deepclean-license` 里（那边 39 条判据 + 三道结构闸），
 * 这里再算一遍就是第二份真相 —— 尤其「签名对不对」「码在不在表里」这种。
 * ------------------------------------------------------------------ */

use deepclean_license::{
    activate as license_activate, now_unix_ms, status as license_status, ActivationError,
    ActivationOutcome, LicensePaths, LicenseStatus, StatusProblem,
};

/// 授权三件套的落点。**同一个目录**：清单（注入的交付物）+ 设备私钥 + 激活记录。
pub fn license_paths_in(dir: &Path) -> LicensePaths {
    LicensePaths {
        table_path: dir.join("codes.sha256"),
        device_key_path: dir.join("device.key"),
        license_path: dir.join("license.dat"),
    }
}

/// 授权目录：`override_dir`（dev-only，见 `dev_license_dir`）优先，否则应用数据目录下的
/// `license`。给覆盖但**去空白后为空**按没给处理 —— 空串会把三份文件指到当前工作目录，
/// 那种目录既不在交付路径上、也不在卸载清理范围内。
pub fn license_dir(override_dir: Option<String>, app_data: PathBuf) -> PathBuf {
    match override_dir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => app_data.join("license"),
    }
}

/// 每条 `Invalid` 原因 = 一个稳定机器码 + 一句能说清「哪里不对」的中文。
///
/// 机器码是给日志/判据用的（中文会被改文案，机器码不许跟着漂），
/// 中文是给界面念的（`Invalid` 六种原因并成一句，运维就分不开「没私钥」和「文件坏了」）。
fn status_problem_wire(p: &StatusProblem) -> (&'static str, &'static str) {
    match p {
        StatusProblem::NoDeviceKey => (
            "no-device-key",
            "本机没有可用的设备密钥，无法确认这份授权绑定到哪台机器",
        ),
        StatusProblem::LicenseUnreadable => (
            "license-unreadable",
            "授权文件读不动，或内容不是合法的激活记录",
        ),
        StatusProblem::DeviceMismatch => (
            "device-mismatch",
            "这份授权绑的是别的设备（多半是把授权文件从另一台机器拷过来的）",
        ),
        StatusProblem::BadSignature => (
            "bad-signature",
            "授权文件的正文与签名不一致，文件被改动过",
        ),
        StatusProblem::CodeNotInTable => (
            "code-not-in-table",
            "授权文件里的激活码不在本版交付的清单里",
        ),
        StatusProblem::TableUnavailable => (
            "table-unavailable",
            "激活码清单缺失或损坏，这一台机器无法核对授权",
        ),
    }
}

/// `status` 的 wire。**只有五个键**，且 `licensed` 之外一律不带时间戳（判据钉着，理由见
/// `the_status_wire_field_set_is_closed`：授权 wire 多一个字段就是往渲染进程递东西）。
pub fn status_wire(s: &LicenseStatus) -> serde_json::Value {
    let (state, activated_at_ms, device_id, problem) = match s {
        LicenseStatus::Unlicensed => ("unlicensed", None, None, None),
        LicenseStatus::Licensed { activated_at_ms, device_id } => {
            ("licensed", Some(*activated_at_ms), Some(device_id.clone()), None)
        }
        LicenseStatus::Invalid { problem } => ("invalid", None, None, Some(problem)),
    };
    let (code, reason) = match problem {
        Some(p) => {
            let (code, reason) = status_problem_wire(p);
            (Some(code), Some(reason))
        }
        None => (None, None),
    };
    serde_json::json!({
        "state": state,
        "activatedAtMs": activated_at_ms,
        "deviceId": device_id,
        "problem": code,
        "problemReason": reason,
    })
}

/// `activate` 成功那条的 wire。`already-active` 报的是**原来那次**的时间戳 ——
/// 幂等不重写，界面念的也不该是「刚才」。
pub fn activation_wire(o: &ActivationOutcome) -> serde_json::Value {
    let (outcome, activated_at_ms, device_id) = match o {
        ActivationOutcome::Activated { activated_at_ms, device_id } => {
            ("activated", *activated_at_ms, device_id.clone())
        }
        ActivationOutcome::AlreadyActive { activated_at_ms, device_id } => {
            ("already-active", *activated_at_ms, device_id.clone())
        }
    };
    serde_json::json!({
        "activation": outcome,
        "activatedAtMs": activated_at_ms,
        "deviceId": device_id,
    })
}

/// 失败 → 「稳定码 + crate 自己那句话」。码分四条是因为**缺表和错码是两件不同的事**：
/// 把「清单没交付」报成「激活码无效」，用户会对着抄了三遍的码怀疑自己手抖。
pub fn activation_error_string(e: &ActivationError) -> String {
    match e {
        ActivationError::Table(inner) => format!("E_LICENSE_TABLE: {inner}"),
        ActivationError::InvalidCode => "E_LICENSE_INVALID_CODE: 激活码无效".to_string(),
        ActivationError::DeviceKey(inner) => format!("E_LICENSE_DEVICE_KEY: {inner}"),
        ActivationError::LicenseFile(inner) => format!("E_LICENSE_FILE_WRITE: {inner}"),
    }
}

/// 读授权状态。**只读** —— crate 的 `status` 不生成设备密钥（那会让一份外来 `license.dat`
/// 在本机「变成本机的」，把设备绑定绕过去），这一层也不替它建目录。
pub fn read_license_status_at(paths: &LicensePaths) -> serde_json::Value {
    status_wire(&license_status(paths))
}

/// 激活。**这是 M4 唯一会写文件的入口**：`device.key`（DPAPI 保护）与 `license.dat`。
///
/// 建父目录这一句不是多余的防御：crate 自己不做（`save_device_key` 直接 `fs::write`），
/// 而首次运行时 `%APPDATA%\com.deepclean.app\license` 恰恰就是不存在的那一个。
/// 不建的后果是把「目录没建出来」报成 `E_LICENSE_DEVICE_KEY` —— 一个误导人的码。
pub fn run_license_activate_at(paths: &LicensePaths, code: &str) -> Result<serde_json::Value, String> {
    for writable in [&paths.device_key_path, &paths.license_path] {
        if let Some(dir) = writable.parent() {
            std::fs::create_dir_all(dir).map_err(|e| {
                format!("E_LICENSE_DIR: 授权目录建不出来（{}）：{e}", dir.display())
            })?;
        }
    }
    license_activate(paths, code, now_unix_ms())
        .map(|outcome| activation_wire(&outcome))
        .map_err(|e| activation_error_string(&e))
}

/// `DC_LICENSE_DIR` 的读取口，**只在 `debug_assertions` 里编译进去**（与 `dev_autoscan`
/// 同一条规矩：打包版拿不到它）。
///
/// 为什么要有：它改变的是**三份文件所在的目录**（外加首启投递的那份清单），不是判定本身
/// （判定仍然只认清单里的哈希）。验收靠它把整条链指向一个空的临时目录，从而在不往
/// `%APPDATA%` 留东西的前提下跑出「首次运行 → 投递清单 → 用真码激活」的真实次序。
///
/// 2026-10-11 更正：本段原先写的是「那 1000 个真码不在仓库，所以真机上点一次激活在今天
/// **必然**失败关闭」。那句已被推翻 —— 真码已按规格书生成（明文在仓库外的发放清单里），
/// 哈希清单随二进制交付（`license_table.rs`）。这个覆盖点保留，但理由换成上面那句。
#[cfg(debug_assertions)]
fn dev_license_dir_override() -> Option<String> {
    std::env::var("DC_LICENSE_DIR").ok()
}

#[cfg(not(debug_assertions))]
fn dev_license_dir_override() -> Option<String> {
    None
}

/// 挂上 §29 的逐条删除日志。**建不出来不拦启动** —— 与激活码清单投递同一个 posture：
/// 为了"日志文件建不出来"把清理软件整个打不开，是比"没有那份日志"更糟的降级。
/// 挂不上时那一格留 `None`，记录页的 `logPath` 于是给 null，页脚那句照实说没能确定路径。
///
/// 调用点必须在 `dc_execute` 之前（`main.rs` 的 `setup`）：晚一步的话第一趟清理的
/// 那批删除就没有日志，而"少了一段日志"这件事在界面上没有任何提示。
pub fn init_clean_log(app: &AppHandle) {
    use tauri::Manager;
    let made = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到应用数据目录：{e}"))
        .and_then(|dir| crate::cleanlog::FileCleanLog::create(&dir));
    match made {
        Ok(log) => {
            let state = app.state::<AppState>();
            *state.clean_log.lock().unwrap() = Some(Arc::new(log));
        }
        Err(e) => eprintln!("[dc] 清理日志没挂上（{e}）→ 记录页那格将是 null"),
    }
}

/// 从 `AppHandle` 定出授权目录并转成三份文件的落点。
///
/// 这一层没有单测：它的全部逻辑（覆盖优先、空串按没给、文件名与同目录布局）已被
/// `the_three_license_files_live_under_one_directory` 与 `the_dev_override_moves_the_whole_license_dir`
/// 钉住，剩下的 `app_data_dir()` 是框架给的保证。
///
/// 2026-10-11 更正：原先这里写「它唯一的失败形态是指错目录，而那会在激活时以
/// `E_LICENSE_TABLE` 现形」。投递链落地后那句不再成立 —— 指错一个**可写**的目录时，
/// `materialize_code_table` 会把清单一起建过去，激活照样能过。真话是：**目录错了不会报错，
/// 只是整条授权（含清单、设备密钥、激活记录）搬到别处**，可见后果是卸载后留下孤儿文件，
/// 不是放行变严或变松。
pub fn license_paths(app: &AppHandle) -> Result<LicensePaths, String> {
    use tauri::Manager;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("E_LICENSE_DIR: 拿不到应用数据目录：{e}"))?;
    Ok(license_paths_in(&license_dir(dev_license_dir_override(), app_data)))
}

/// 首启把内嵌的激活码清单投递到授权目录 —— **这一句才是「全新安装能激活」的那一环**。
///
/// 判定与投递分得开：crate 只管「码在不在表里」，而「表从哪来」是壳层的产品问题，
/// 理由与选定形态（内嵌而非打包资源/联网拉取）写在 `license_table.rs` 顶部。
/// 调用点在 `main.rs` 的 `setup`：状态查询也要读这份表（核对 `license.dat` 里的
/// `code_hash`），所以它必须在**两个命令之前**，而不是只在激活前补一句。
///
/// 失败**不拦启动**：授权目录写不下去时（只读漫游配置文件、磁盘满），把清理软件整个打不开
/// 是比「激活不了」更糟的降级；错误串走 stderr，而用户看得见的那一面是激活/状态上的具名错误。
pub fn materialize_code_table(app: &AppHandle) -> Result<crate::license_table::Placement, String> {
    let paths = license_paths(app)?;
    crate::license_table::ensure_at(&paths.table_path)
}

/// 界面侧的「查状态」。**永远不要求联网** —— 已激活的用户断网之后照样要看得见自己的授权，
/// 否则这道闸就从"激活时的一次门槛"变成了"随时可以把软件关掉的远程开关"，那是另一个产品。
pub fn license_status_at(app: &AppHandle) -> Result<serde_json::Value, String> {
    Ok(read_license_status_at(&license_paths(app)?))
}

/// 界面侧的「激活」。**M4 改版：先过网络这一关**（在线激活），过了才交给 crate 做本地校验。
/// 判定与写点都不在这里 —— 见 `netprobe.rs`（网络）与 `deepclean-license`（授权语义）。
pub fn license_activate_at(app: &AppHandle, code: &str) -> Result<serde_json::Value, String> {
    let paths = license_paths(app)?;
    crate::netprobe::activate_guarded(&paths, code, &crate::netprobe::probe())
}

/* ------------------------------------------------------------------ *
 * §7 视图排除（M5-E③）
 * ------------------------------------------------------------------ */

/// 「排除该目录」/「恢复」。判据只有这一处（基准 `tree-store.ts:539-541` 的 `canExclude`）：
/// 必须是这棵树上真实存在的目录，且**不是扫描根** —— 排除根等于给用户一张空图
/// （这一轮再也没有任何一层可看），所以结构性地拒掉。
///
/// 回 `false` = 这一条**没被接受**，必须把拒说出来而不是静默成功：渲染端据此决定要不要重画
/// 这一层（那句「没有生效」的横幅就是这么来的）。
///
/// 它只动 `view_excluded`，因此只影响 `level_of`（视图口径）。计价口径 `children_of` 一个字节
/// 都不动 —— 漏进去就是「把目录从地图上藏起来、清理预估照旧删它的文件」那种隐藏式误删。
pub fn set_excluded(state: &AppState, scan_id: &str, dir_id: i64, excluded: bool) -> bool {
    let Some(session) = state.sessions.lock().unwrap().get(scan_id).cloned() else {
        return false;
    };
    let mut st = session.state.lock().unwrap();
    let Some(idx) = st.tree.as_ref() else { return false };
    let acceptable = dir_id != deepclean_scanner::tree_index::ROOT_DIR_ID && idx.dir(dir_id).is_some();
    if !acceptable {
        return false;
    }
    if excluded {
        st.view_excluded.insert(dir_id);
    } else {
        st.view_excluded.remove(&dir_id);
    }
    true
}

/// 横幅要读的那两份"本轮累计"：排了几个目录、合共多少字节。
/// 住在壳层而不是 `TreeIndex::payload` —— 视图层不认识会话状态，而这两个数**就是**会话状态。
/// 每个被排除目录按它自己的 `size_counted`（完整子树口径）计，与地图上那一格显示的同一把尺子。
pub fn session_excluded_totals_of(st: &SessionState) -> (usize, u64) {
    let Some(idx) = st.tree.as_ref() else { return (0, 0) };
    let bytes: u64 = st.view_excluded.iter().filter_map(|id| idx.dir(*id)).map(|d| d.size_counted).sum();
    (st.view_excluded.len(), bytes)
}

/// 一次性清掉本轮全部排除（侧栏那句「清除全部排除」）。会话不在 → `false`（同上，不许静默成功）。
pub fn clear_exclusions(state: &AppState, scan_id: &str) -> bool {
    let Some(session) = state.sessions.lock().unwrap().get(scan_id).cloned() else {
        return false;
    };
    session.state.lock().unwrap().view_excluded.clear();
    true
}

/* ------------------------------------------------------------------ *
 * §3.6 开发环境页：真机组装（M5-D2）
 *
 * 基准：`electron/services/scan-service.ts:201-234`（`devenvView(scanId)`）。
 * **没有任何新的走盘或执行能力**：字节那一列是从 `build_preview` 已经算好的报告里挑
 * `finding_bytes`（全量口径，与勾没勾无关），模型计数那一格是扫描途中顺带累加的两个数
 * （`Counters::ext_count` / `ext_bytes`），所以这条通道只是把既有结论换个形状交给界面，
 * 不产生任何确认资格。
 * ------------------------------------------------------------------ */

use deepclean_devenv::detectors::{collect_install_status_default, read_docker_disk_usage, DockerDiskUsage};
use deepclean_devenv::model_files::{model_tally_from, ExtTotals, ModelTally, ModelTallyEnv, ScanStatus};
use deepclean_devenv::view::{build_dev_env_view, DevEnvView, DevEnvViewInput, RuleOccupancy};

impl From<Status> for ScanStatus {
    /// 壳层那一族五个 → devenv 那一族六个。**`Idle` 在这一格不可达**：走到这里必然有一个
    /// session，而 session 一出生就是 `Running`。`idle` 那句话住在前端
    /// （`useScan.ts` 的 `snapshot?.status ?? 'idle'`），由「压根没有这次会话」来表达，
    /// 不由这里补一个假档 —— 那会让「没扫过」与「扫完了」共用同一句话。
    fn from(s: Status) -> Self {
        match s {
            Status::Running => ScanStatus::Running,
            Status::Paused => ScanStatus::Paused,
            Status::Completed => ScanStatus::Completed,
            Status::Cancelled => ScanStatus::Cancelled,
            Status::Failed => ScanStatus::Failed,
        }
    }
}

/// 「装没装」那张表：进程级缓存一趟到底（理由见 [`AppState::dev_env_status`]）。
///
/// **缓存有两层，读哪层都一样**：`AppState::dev_env_status`（页面那条 IPC 读的）与
/// `detector_status_slot()`（预热写的）。预热跑在扫描线程的 `'static` 闭包里，拿不到
/// `State<'_, AppState>`（`commands.rs:28` 点名的寿命问题），所以它写模块级那一层；
/// 而本函数**两层都查**，于是无论哪一层先填上，页面那边都命中。
pub fn detector_status(state: &AppState) -> std::collections::BTreeMap<String, bool> {
    // 先查模块级（预热可能已经填好）
    if let Some(hit) = detector_status_slot().lock().unwrap().as_ref() {
        return hit.clone();
    }
    let mut cache = state.dev_env_status.lock().unwrap();
    if let Some(hit) = cache.as_ref() {
        return hit.clone();
    }
    let face = crate::dev_env::OsProcess;
    let probe = crate::dev_env::SystemProbe::new(&face, &crate::dev_env::dev_env_exists);
    let got = collect_install_status_default(&probe);
    *cache = Some(got.clone());
    got
}

/// 探测器结论的**模块级**缓存槽。与 [`dev_env_report_slot`] 同一个理由：
/// 预热发生在扫描线程的 `'static` 闭包里，`State<'_, AppState>` 活不过那个闭包。
static DETECTOR_STATUS: std::sync::OnceLock<
    std::sync::Mutex<Option<std::collections::BTreeMap<String, bool>>>,
> = std::sync::OnceLock::new();

/// 探测器缓存槽的访问器。
pub fn detector_status_slot() -> &'static std::sync::Mutex<Option<std::collections::BTreeMap<String, bool>>> {
    DETECTOR_STATUS.get_or_init(|| std::sync::Mutex::new(None))
}

/// 预热版探测：跑一次 11 路 `where`（本机实测 1.7 s）并填进模块级缓存。
///
/// **只在扫描线程刚结束时调**（见 `start_scan` 里那段预热）。它让开发环境页的
/// **首次**打开就命中缓存 —— 否则那 1.7 s 是用户点开页面后才付的，而它与
/// "扫的是什么盘"毫无关系，纯粹是页面第一次问"装没装"的一次性成本。
pub fn warm_detector_status() {
    let face = crate::dev_env::OsProcess;
    let probe = crate::dev_env::SystemProbe::new(&face, &crate::dev_env::dev_env_exists);
    let got = collect_install_status_default(&probe);
    *detector_status_slot().lock().unwrap() = Some(got);
}

/// 真机起一次只读 `docker system df`。**每次现查**（不缓存），与基准同一分工。
pub fn detect_docker_usage() -> DockerDiskUsage {
    let face = crate::dev_env::OsProcess;
    let probe = crate::dev_env::SystemProbe::new(&face, &crate::dev_env::dev_env_exists);
    read_docker_disk_usage(&probe)
}

/// 那一页的组装。探测的两个结论做成入参（**不是**顺手解耦：这样这一段的判据 —— 尤其是
/// 「没扫过时那一格念『还没扫过』而不是一排 0」—— 能在不碰真机的前提下反复验，
/// 同 TS 把 `detectorStatusProvider` / `dockerUsageProvider` 做成注入点的理由）。
///
/// `dev_env_report` 是同一棵树的报告缓存（理由见 [`AppState::dev_env_report`]）：
/// **命中就不重跑** `build_preview` 那一整条链（C 盘实测 12 s）。
/// 缓存的键由调用方给（`scan_id`），这里只负责查与填，不判断"该不该信"。
pub fn assemble_dev_env_view(
    state: &AppState,
    scan_id: Option<&str>,
    install_status: std::collections::BTreeMap<String, bool>,
    docker: Option<DockerDiskUsage>,
) -> DevEnvView {
    use std::collections::BTreeMap;
    let rules = deepclean_rules::builtin::builtin_rules();
    let mut bytes_by_rule: BTreeMap<String, RuleOccupancy> = BTreeMap::new();
    let mut territories: Vec<deepclean_rules::engine::TerritoryFact> = Vec::new();
    let mut model_files: Option<ModelTally> = None;
    let mut scanned_root: Option<String> = None;

    if let Some(id) = scan_id {
        // 拿一次锁只拷六个量，**必须在调 build_preview 之前放开**：那条要重新锁
        // sessions 与会话状态，带着锁进去就是自己和自己死锁。
        let picked = state.sessions.lock().unwrap().get(id).cloned().map(|session| {
            let st = session.state.lock().unwrap();
            (
                session.root.clone(),
                st.status,
                st.counters.files,
                st.counters.ext_count,
                st.counters.ext_bytes,
                st.truncated(),
            )
        });
        if let Some((root, status, files, ext_count, ext_bytes, truncated)) = picked {
            scanned_root = Some(root.clone());
            model_files = Some(model_tally_from(
                &ExtTotals { count: ext_count as f64, bytes: ext_bytes as f64 },
                &ModelTallyEnv {
                    root_path: root,
                    files_seen: files,
                    truncated,
                    scan_status: status.into(),
                },
            ));
            // 空勾选**不是**「什么都不回」：items 来自报告的全部 finding，与勾没勾无关，
            // 全量口径就在 `finding_bytes` 上。
            //
            // **先查缓存**：同一棵树的报告算过一次就存下来，第二次进这一页不再付那 12 秒。
            // 缓存未命中才走原来那条链，算完当场填进去。
            let cached = {
                let guard = dev_env_report_slot().lock().unwrap();
                match guard.as_ref() {
                    Some((kid, c)) if kid == id => Some(c.clone()),
                    _ => None,
                }
            };
            if let Some(c) = cached {
                bytes_by_rule = c.bytes_by_rule;
                territories = c.territories;
            } else if let Some(payload) = build_preview(
                state,
                id,
                // `build_preview` 的 `selection` 形参**就是勾选对象本身**（不是整个请求体）。套一层
                // `{selection: ...}` 会让 `items` 缺失，引擎于是白记一条 `unknown-rule` 拒绝
                // （本棒顺手修掉的形状错；数字不受影响 —— 全量口径在 `finding_bytes` 上）。
                serde_json::json!({ "items": [] }),
                None,
                None,
                None,
            )
            .unwrap_or(None)
            {
                for item in &payload.preview.items {
                    bytes_by_rule.insert(
                        item.rule_id.clone(),
                        RuleOccupancy { bytes: item.finding_bytes, files: item.finding_files },
                    );
                }
                // §3.6 未完 #2 / #4b：地盘底账同路带走（报告里本来就有，零额外遍历）
                territories = payload.preview.territories.clone();
                // 填缓存。**只存这一次**：树没变，重算只会得到同一份数字。
                let mut guard = dev_env_report_slot().lock().unwrap();
                *guard = Some((
                    id.to_string(),
                    DevEnvReportCache {
                        bytes_by_rule: bytes_by_rule.clone(),
                        territories: territories.clone(),
                    },
                ));
            }
        }
    }

    build_dev_env_view(&DevEnvViewInput {
        rules: &rules,
        install_status,
        docker,
        bytes_by_rule,
        model_files,
        territories: &territories,
        scanned_root,
    })
}

/// [`AppState::dev_env_report`] 里存的那一份。两个字段都是**只读快照**：
/// 一旦写入就不再改（同一棵树的报告是定值），所以跨页面直接 clone 出去用。
#[derive(Debug, Clone)]
pub struct DevEnvReportCache {
    /// `rule_id → (finding_bytes, finding_files)`。开发环境页「占用」那一列的原料。
    pub bytes_by_rule: std::collections::BTreeMap<String, RuleOccupancy>,
    /// §3.6 地盘底账（`#2` / `#4b` 两格要用）。
    pub territories: Vec<deepclean_rules::engine::TerritoryFact>,
}

/// 开发环境页报告缓存的**唯一存储点**。`&'static` 引用让扫描线程的 `'static` 闭包
/// 也能拿到它（`State<'_, AppState>` 借用的对象活不过那个闭包，理由见字段注释）。
static DEV_ENV_REPORT: std::sync::OnceLock<std::sync::Mutex<Option<(String, DevEnvReportCache)>>> =
    std::sync::OnceLock::new();

/// 缓存格的访问器。**进程内只此一把锁**，页面读与扫描线程写都走它。
pub fn dev_env_report_slot() -> &'static std::sync::Mutex<Option<(String, DevEnvReportCache)>> {
    DEV_ENV_REPORT.get_or_init(|| std::sync::Mutex::new(None))
}

/// 把这一次会话的报告算好，返回给调用方填进 [`dev_env_report_slot`]。
///
/// **只在扫描线程刚结束时调一次**（见 `start_scan` 里那段预热），页面那边只读不写。
/// 走的是与 `assemble_dev_env_view` 完全相同的那条链（`rule_report_with_facts` +
/// 同一个 `build_preview` 用的空勾选），所以预热算出来的与页面要的**逐字节同一份** ——
/// 不存在"预热一份、页面另算一份"的分叉。
///
/// 入参是 `&Session` 而不是 `&AppState`：预热跑在扫描线程的 `'static` 闭包里，
/// 而 `State<'_, AppState>` 借的托管对象活不过那个闭包（`commands.rs:28` 点名）。
/// `Session` 是 `Arc`，闭包本来就持有一份。
pub fn warm_dev_env_report(session: &Session, scan_id: &str) -> Option<DevEnvReportCache> {
    // 树没建完（取消 / 失败那两路）就不预热。这时页面那边照旧走"现算"分支，
    // 只是它要自己付那 12 秒 —— 而那正是一个还没扫完的会话该有的代价。
    let tree = { session.state.lock().unwrap().tree.clone()? };
    let _: &TreeIndex = &tree;

    let report = rule_report_with_facts(&tree, now_ms(), false, app_facts_for_tree(&tree));
    let mut bytes_by_rule = std::collections::BTreeMap::new();
    // 与 `assemble_dev_env_view` 的现算分支**同一个字段**：那边读的是
    // `PreviewItem::finding_bytes`，而它就是 `Finding::total_bytes`
    // （`cleaner/src/preview.rs:445` 一句 `finding_bytes: f.total_bytes`）。
    // 两边必须是同一个数，否则预热版与现算版会给开发环境页两份不同的占用。
    for f in &report.findings {
        bytes_by_rule.insert(
            f.rule_id.clone(),
            RuleOccupancy { bytes: f.total_bytes, files: f.file_count },
        );
    }
    let _ = scan_id; // 键由调用方写（slot 里那个 tuple 的第一格），这里只产内容
    Some(DevEnvReportCache { bytes_by_rule, territories: report.territories.clone() })
}

#[cfg(test)]
mod preview_tests {
    use super::*;
    use deepclean_rules::engine::{add_bytes_by_risk, BytesByRisk};
    use deepclean_scanner::model::{ScanFile, ScanMode, ScanNode, ScanTree};
    use deepclean_scanner::volume::VolumeInfo;
    use serde_json::json;

    /// 把夹具树的根**钉在真机的 `%TEMP%` 上**：`rule_env()` 读的是真环境，
    /// 而 `windows-temp` 规则要 `%TEMP%` 正好等于树根，`dir_id_by_path` 才会命中根。
    fn session_with_temp_tree(file_bytes: u64) -> Arc<Session> {
        let temp = std::env::var("TEMP").expect("本机必须有 TEMP（否则这条判据验的是别的东西）");
        let mut root = ScanNode::dir("Temp".into(), temp);
        root.files.push(ScanFile {
            name: "dc-preview-probe.tmp".into(),
            size: file_bytes,
            alloc: file_bytes,
            counted: file_bytes,
            file_id: 1,
            mtime_ms: 0,
            creation_ms: 0,
            attrs: 0,
        });
        root.size_counted = file_bytes;
        root.file_count = 1;
        let tree = TreeIndex::build(&ScanTree {
            top: Vec::new(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 1u64 << 62, free_bytes: 0 },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            mode: ScanMode::Walk,
            mft: None,
            elapsed_ms: 0,
        });
        Arc::new(Session {
            id: "s1".into(),
            root: "t".into(),
            control: ScanControl::new(),
        report_cache: Mutex::new(None),
        deleted_paths: Mutex::new(std::collections::BTreeSet::new()),
            state: Mutex::new(SessionState {
                status: Status::Completed,
                counters: Counters::default(),
                current_path: String::new(),
                started_at_ms: None,
                finished_at_ms: None,
                tree: Some(std::sync::Arc::new(tree)),
                error: None,
                unaccounted: 0,
                scan_mode: "walk",
                view_excluded: Default::default(),
            }),
        })
    }

    /// 「用时」必须是**这一趟扫描**的时长，而不是"你什么时候来取快照"。
    ///
    /// 修之前这一格写作 `now − started`：扫描 9 秒前就完成了，界面上那句「用时」还在往上走，
    /// 而 `dc_export_report` 里由它派生的 `speed.*` 三个数随导出时刻漂移 ——
    /// `report.rs` 顶上那句「同一份输入两次导出逐字节相同」就是被这一格破掉的。
    ///
    /// 两个时间戳**都必须钉在过去**：若写成 `started = now − 1000`，旧代码算出来也是 1000，
    /// 这条测试红不起来（第一版就差点这么写）。
    /// 导出报告的 `counters.skipped` 只算四个**错误**桶，绝不把"按策略没进去"的量并进来。
    /// 混在一起的后果是具体的：扫系统卷时 `SKIP_ALWAYS` 会挡掉几万个条目，
    /// 一旦并入，一次完全干净的扫描会在报告里报出"三万个错误"，
    /// 而拿报告的人分不清"读不到"与"本来就不该读"。
    #[test]
    fn the_exported_error_sum_excludes_the_policy_skip_counters() {
        let mut counters = Counters::default();
        counters.errors.denied = 3;
        counters.errors.missing = 1;
        counters.errors.busy = 2;
        counters.skipped_always = 30_117;
        counters.skipped_reparse = 42;
        counters.depth_capped = 7;
        let st = SessionState {
            status: Status::Completed,
            counters,
            current_path: String::new(),
            started_at_ms: Some(1_000),
            finished_at_ms: Some(2_000),
            tree: None,
            error: None,
            unaccounted: 0,
            scan_mode: "walk",
            view_excluded: Default::default(),
        };
        let session = Session {
            id: "s-cov".into(),
            root: "t".into(),
            control: ScanControl::new(),
            report_cache: Mutex::new(None),
            deleted_paths: Mutex::new(std::collections::BTreeSet::new()),
            state: Mutex::new(st),
        };
        let w = snapshot_of(&session, &session.state.lock().unwrap());
        assert_eq!(w.counters.skipped, 6, "skipped 必须只等于 denied+missing+busy+other（3+1+2+0）");
        assert_eq!((w.counters.skipped_always, w.counters.skipped_reparse, w.counters.depth_capped), (30_117, 42, 7), "三个覆盖量得各自原样带出去");
    }

    #[test]
    fn elapsed_ms_freezes_when_done_but_ticks_while_running() {
        let mk = |started: i64, finished: Option<i64>| {
            Arc::new(Session {
                id: "s1".into(),
                root: "t".into(),
                control: ScanControl::new(),
                report_cache: Mutex::new(None),
                deleted_paths: Mutex::new(std::collections::BTreeSet::new()),
                state: Mutex::new(SessionState {
                    status: Status::Completed,
                    counters: Counters::default(),
                    current_path: String::new(),
                    started_at_ms: Some(started),
                    finished_at_ms: finished,
                    tree: None,
                    error: None,
                    unaccounted: 0,
                    scan_mode: "walk",
                    view_excluded: Default::default(),
                }),
            })
        };

        // 已完成：扫描真长 1000 ms，且 9000 ms 前就结束了 —— 现在来取，仍必须是 1000。
        let base = now_ms();
        let done = mk(base - 10_000, Some(base - 9_000));
        assert_eq!(
            done.snapshot().elapsed_ms,
            1_000,
            "已完成的扫描，用时不能随取快照的时刻往上走"
        );

        // 反向半边：还在扫（finished 缺席）时必须是活的，否则 HUD 那格会钉死。
        let running = mk(now_ms() - 1_234, None);
        let live = running.snapshot().elapsed_ms;
        assert!(
            (1_234..6_000).contains(&live),
            "扫描途中的用时必须随墙钟走，实得 {live}"
        );
    }

    fn state_with(s: Arc<Session>) -> AppState {
        let st = AppState::default();
        st.sessions.lock().unwrap().insert("s1".into(), s);
        st
    }

    /// `dc_preview` 那条路的全链：真环境 → 真树 → 报告 → 预览 → 确认回执。
    #[test]
    fn preview_over_a_real_session_prices_and_confirms() {
        let state = state_with(session_with_temp_tree(100));
        let payload = build_preview(&state, "s1", json!({ "items": [{ "ruleId": "windows-temp" }] }), Some(true), None, None)
            .expect("这条链不该报错")
            .expect("有树就该有回执");
        assert_eq!(payload.scan_id, "s1");
        assert_eq!(payload.scan_status, "completed");
        let p = &payload.preview;
        assert!(
            !p.blocked,
            "禁止根解析不出来会 fail-safe —— 这条判据依赖本机有 SYSTEMDRIVE/WINDIR：{:?}",
            p.notes
        );
        let item = p.items.iter().find(|i| i.rule_id == "windows-temp").unwrap();
        assert!(item.included);
        assert_eq!(item.bytes, 100, "树根就是 %TEMP%，那一个文件应当被计价");
        assert_eq!(p.total_bytes, 100);

        let c = payload.confirmation.expect("带了 confirm 就要有回执");
        assert!(c.confirmed, "{:?}", c.blockers);
        assert_eq!(c.rule_ids, vec!["windows-temp".to_string()]);
        assert_eq!(c.total_bytes, 100);
        // M5-P1 T4：回执的指纹**不再等于**模型指纹 —— 它是「模型决策字段 + 这一项按下的档位」。
        // 模型那一份照旧躺在 `preview.digest`（`stale-model` 复核用的就是它）；
        // 执行凭据是回执这一份，锚进 `state.confirmations` 的键也是它。
        assert_eq!(c.acknowledged_risk, Risk::Caution, "请求没带 acknowledgedRisk ⇒ 按 🟡 算，服务端不替用户按 🟠");
        assert_eq!(c.digest, deepclean_cleaner::preview_digest(p, Some(Risk::Caution)));
        assert_ne!(c.digest, p.digest, "回执凭据必须比模型指纹多盖一个档位（否则旧回执能换档重放）");
        // 回执**不含路径清单**：这条在产品侧由 cleaner 的单测钉着，这里再确认一次透传没走样
        let s = serde_json::to_string(&c).unwrap();
        assert!(!s.contains("dc-preview-probe"), "回执里出现了具体文件：{s}");
    }

    /// §12 的夹具树：`%TEMP%` 下 N 个文件（`windows-temp` 的地盘就是它，所以这些文件会被认领）。
    fn session_with_temp_files(names: &[&str], bytes: u64) -> Arc<Session> {
        let temp = std::env::var("TEMP").expect("本机必须有 TEMP（否则这条判据验的是别的东西）");
        let mut root = ScanNode::dir("Temp".into(), temp);
        for n in names {
            root.files.push(ScanFile {
                name: (*n).to_string(),
                size: bytes,
                alloc: bytes,
                counted: bytes,
                file_id: 1,
                mtime_ms: 0,
                creation_ms: 0,
                attrs: 0,
            });
        }
        root.size_counted = bytes * names.len() as u64;
        root.file_count = names.len() as u64;
        let tree = TreeIndex::build(&ScanTree {
            top: Vec::new(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 1u64 << 62, free_bytes: 0 },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            mode: ScanMode::Walk,
            mft: None,
            elapsed_ms: 0,
        });
        Arc::new(Session {
            id: "s1".into(),
            root: "t".into(),
            control: ScanControl::new(),
        report_cache: Mutex::new(None),
        deleted_paths: Mutex::new(std::collections::BTreeSet::new()),
            state: Mutex::new(SessionState {
                status: Status::Completed,
                counters: Counters::default(),
                current_path: String::new(),
                started_at_ms: None,
                finished_at_ms: None,
                tree: Some(std::sync::Arc::new(tree)),
                error: None,
                unaccounted: 0,
                scan_mode: "walk",
                view_excluded: Default::default(),
            }),
        })
    }

    fn temp_path(name: &str) -> String {
        let temp = std::env::var("TEMP").expect("本机必须有 TEMP");
        format!("{}\\{}", temp.trim_end_matches('\\'), name)
    }

    /// **归属由引擎自己的认领表回答**：地图上点进来的文件路径 → 它属于哪条规则，
    /// 于是清理页出现的是"这条规则里的这一个文件"（逐路径勾选那条 scope），而不是整项。
    #[test]
    fn a_tile_path_is_attributed_by_the_engines_own_claim_table() {
        let state = state_with(session_with_temp_files(&["dc-tile-a.tmp"], 100));
        let payload = build_preview(
            &state,
            "s1",
            json!({ "items": [] }),
            None,
            None,
            Some(vec![json!(temp_path("dc-tile-a.tmp"))]),
        )
        .unwrap()
        .unwrap();
        assert_eq!(payload.unclaimed_tile_paths, Some(Vec::new()), "这个文件在 %TEMP% 里，该被认领");
        let item = payload
            .preview
            .items
            .iter()
            .find(|i| i.rule_id == "windows-temp")
            .expect("归属反查没产出任何项");
        assert!(item.included, "报了路径就等于勾了它");
        assert_eq!(item.bytes, 100, "逐路径计价：只算点进来那一个文件");
        assert_eq!(payload.preview.total_bytes, 100);
    }

    /// 查不到归属就**点名退回**，绝不猜一条规则、也不静默丢掉那次点击。
    #[test]
    fn a_tile_that_no_rule_claimed_is_named_not_guessed() {
        let state = state_with(session_with_temp_files(&["dc-tile-a.tmp"], 100));
        let stranger = r"C:\deepclean-no-such-territory\x.bin".to_string();
        let payload = build_preview(
            &state,
            "s1",
            json!({ "items": [] }),
            None,
            None,
            Some(vec![json!(&stranger)]),
        )
        .unwrap()
        .unwrap();
        assert_eq!(payload.unclaimed_tile_paths, Some(vec![stranger.clone()]), "没认领的路径必须原样点名");
        // 判"有没有猜归属"要看**是否被算进勾选**：模型里没被整项勾选的行本来就带 `scope = Paths`
        // （`preview.rs:245` 那句 `scope = if whole { Rule } else { Paths }`），
        // 拿 scope 当证据会把正常形状抓成违例 —— 第一版就这么假红过一次。
        let wt = payload.preview.items.iter().find(|i| i.rule_id == "windows-temp");
        assert!(
            wt.map(|i| !i.included && i.paths.is_empty()).unwrap_or(true),
            "查不到归属却把 windows-temp 算成了勾选"
        );
        assert_eq!(payload.preview.total_bytes, 0, "查不到归属的东西不许进预估");
    }

    /// 同一规则已经有**逐路径**那条勾选时，tile 反查出来的文件要**并进它**而不是再开一项
    /// （两项同规则 = 一次勾选被静默吞掉，或反过来把同一文件算两遍）。
    #[test]
    fn a_tile_merges_into_an_existing_per_path_selection_of_the_same_rule() {
        let state = state_with(session_with_temp_files(&["dc-tile-a.tmp", "dc-tile-b.tmp"], 100));
        let payload = build_preview(
            &state,
            "s1",
            json!({ "items": [{ "ruleId": "windows-temp", "paths": [temp_path("dc-tile-a.tmp")] }] }),
            None,
            None,
            Some(vec![json!(temp_path("dc-tile-b.tmp"))]),
        )
        .unwrap()
        .unwrap();
        let rows: Vec<&_> = payload
            .preview
            .items
            .iter()
            .filter(|i| i.rule_id == "windows-temp")
            .collect();
        assert_eq!(rows.len(), 1, "同一规则被开成两项 = 并账没并上");
        assert_eq!(rows[0].bytes, 200, "两个文件都该算进来");
        assert_eq!(payload.preview.total_bytes, 200);
    }

    /// 没给 tilePaths 时那个键**不上线**（TS 的 `undefined` 同形）：界面靠"有没有这个键"
    /// 决定要不要念"这几个文件不在任何规则的地盘里"那一句，挂个空数组会让它凭空念一句。
    #[test]
    fn the_unclaimed_key_is_absent_unless_the_request_asked_for_it() {
        let state = state_with(session_with_temp_files(&["dc-tile-a.tmp"], 100));
        let no_tiles = build_preview(&state, "s1", json!({ "items": [] }), None, None, None)
            .unwrap()
            .unwrap();
        let wire = serde_json::to_value(&no_tiles).unwrap();
        assert!(wire.get("unclaimedTilePaths").is_none(), "没问归属却挂了键：{wire}");

        let with_tiles = build_preview(
            &state,
            "s1",
            json!({ "items": [] }),
            None,
            None,
            Some(vec![json!(r"C:\nope\x.bin")]),
        )
        .unwrap()
        .unwrap();
        let wire = serde_json::to_value(&with_tiles).unwrap();
        assert!(wire.get("unclaimedTilePaths").is_some(), "问了归属却没回点名");
    }

    /// **诊断探针（真机 §12 不通时写的，留着因为它钉的是一个真实形状）**：
    /// 认领表里的键，必须就是地图报上来的那种路径 —— 扫描根**不是** %TEMP% 本身、
    /// 而是它的父目录（真机 DC_ENV_ROOT 就是这个形状：根 = envroot，领地 = envroot\TEMP）。
    /// 单测里根恰好等于 %TEMP%，那一层差异被抹平了，所以它绿而真机不通。
    #[test]
    fn the_claim_table_carries_the_map_path_when_the_scan_root_is_a_parent() {
        let dir = std::env::temp_dir().join(format!("deepclean-m5c-claim-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("TEMP")).unwrap();
        std::fs::write(dir.join("TEMP\\x.tmp"), vec![7u8; 2048]).unwrap();
        let root = dir.display().to_string();

        let mut root_node = ScanNode::dir("m5c".into(), root.clone());
        let mut temp = ScanNode::dir("TEMP".into(), format!(r"{root}\TEMP"));
        temp.files.push(ScanFile {
            name: "x.tmp".into(),
            size: 2048,
            alloc: 2048,
            counted: 2048,
            file_id: 1,
            mtime_ms: 0,
            creation_ms: 0,
            attrs: 0,
        });
        temp.size_counted = 2048;
        temp.file_count = 1;
        root_node.children.push(temp);
        let tree = TreeIndex::build(&ScanTree {
            top: Vec::new(),
            root: root_node,
            counters: Counters::default(),
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 1u64 << 62, free_bytes: 0 },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            mode: ScanMode::Walk,
            mft: None,
            elapsed_ms: 0,
        });

        // 注入环境：`TEMP` 指到夹具里那一层（真机由 DC_ENV_ROOT 完成同一件事）
        let r = root.clone();
        let env = rule_env_from(|k| {
            if k == "TEMP" || k == "tmp" { Some(format!(r"{r}\TEMP")) } else { std::env::var(k).ok() }
        });
        let rules = deepclean_rules::builtin_rules();
        let mut opts = EvaluateOptions {
            now_ms: now_ms(),
            max_listed_paths: 50,
            report_claims: true,
            ..Default::default()
        };
        for ru in &rules {
            opts.collect_all_paths_for.insert(ru.id.clone());
        }
        let report = evaluate_rules(&TreeSource::new(&tree), &rules, &env, &opts);

        let claimed = report.claimed_paths.expect("report_claims 开了就该有表");
        let map_path = format!(r"{root}\TEMP\x.tmp");
        let key = deepclean_rules::engine::normalize_key(&map_path);
        let owner = claimed.get(&key);
        eprintln!(
            "探针：认领 {} 条；地图形状的路径 = {map_path}；归属 = {owner:?}；表里前 3 个键 = {:?}",
            claimed.len(),
            claimed.keys().take(3).collect::<Vec<_>>()
        );
        assert_eq!(owner.map(String::as_str), Some("windows-temp"), "认领表里查不到地图会报上来的那个路径");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn preview_returns_none_for_an_unknown_session_or_an_unfinished_scan() {
        let state = AppState::default();
        assert!(build_preview(&state, "nope", json!({ "items": [] }), None, None, None).unwrap().is_none(), "未知会话回 None");

        let s = session_with_temp_tree(10);
        s.state.lock().unwrap().tree = None; // 还没扫完
        let state = state_with(s);
        assert!(build_preview(&state, "s1", json!({ "items": [] }), None, None, None).unwrap().is_none(), "没树回 None 而不是一份空预估");
    }

    /// 🔴 不许被计价：即便用户点了它，预估里也不许出现它的字节。
    #[test]
    fn a_forbidden_selection_never_lands_in_the_estimate() {
        let state = state_with(session_with_temp_tree(100));
        let payload = build_preview(
            &state,
            "s1",
            json!({ "items": [{ "ruleId": "recycle-bin" }, { "ruleId": "windows-temp" }] }),
            None,
            None,
            None,
        )
        .unwrap()
        .unwrap();
        let bin = payload.preview.items.iter().find(|i| i.rule_id == "recycle-bin").unwrap();
        assert!(!bin.included, "🔴 永不计入");
        assert_eq!(bin.bytes, 0);
        assert_eq!(payload.preview.total_bytes, 100, "只有 windows-temp 那 100 字节");
    }

    /* ------------------------------------------------------------------ *
     * 勾选重算的报告复用（2026-10-22：首次勾选延迟）
     *
     * 实测（`C:\Windows`，125,139 文件 / 35,374 目录，debug 构建）：一次 `build_preview`
     * 约 490 ms —— `app_facts_for_tree` 244 ms + `rule_report_with_facts` 244 ms ——
     * 而**真正由勾选决定**的 `build_preview_model` 只有 0.7 ms（比例约 700:1）。
     *
     * 报告与勾选无关，这是可读出来的事实，不是估计：
     *  · `selection` 根本不在 `rule_report_with_facts` 的形参里（`service.rs:594`）；
     *  · `builtin.rs` 里**没有一条规则**设 `older_than_days`，所以连 `now` 都不影响报告
     *    （`engine.rs:1121` 那个分支在生产规则集上永不进入）。
     *
     * 所以勾选变化时报告应当被复用。下面两条钉住它，且钉的是**行为**不是实现：
     * 往缓存里塞一份假报告，看 `build_preview` 是否原样把它念出来 —— 原样念出来才证明
     * 它真的读了缓存；若它又算了一遍，假数据会被真报告覆盖，断言当场红。
     * ------------------------------------------------------------------ */

    /// 一份**形状合法但数字是假的**报告：`windows-temp` 一条，424,242 字节。
    ///
    /// 数字刻意取得与任何真树都对不上 —— 断言里出现 424242 就只可能来自这份假报告。
    fn fake_report_for_cache_probe() -> RuleReport {
        let mut bytes_by_risk = BytesByRisk::default();
        add_bytes_by_risk(&mut bytes_by_risk, Risk::Safe, 424_242);
        RuleReport {
            findings: vec![deepclean_rules::engine::RuleFinding {
                rule_id: "windows-temp".to_string(),
                name: "Windows 临时文件".to_string(),
                category: deepclean_rules::types::RuleCategory::Temp,
                risk_level: Risk::Safe,
                clean_strategy: deepclean_rules::types::CleanStrategy::DeleteAll,
                recoverable: true,
                matched_roots: vec![],
                sample_paths: vec![],
                sample_truncated: false,
                file_count: 7,
                total_bytes: 424_242,
                all_paths: None,
            }],
            exclusions: Vec::new(),
            rejected_rules: Vec::new(),
            // 禁止根必须非空，否则 `build_preview_model` 判 blocked（`preview.rs:77`），
            // 那时任何勾选都不出结论 —— 这条用例验的是缓存，不该被 fail-safe 盖住。
            forbidden_roots: vec![r"C:\Windows\System32".to_string()],
            report_only_roots: vec![],
            territories: vec![],
            bytes_by_risk,
            reclaimable_bytes: 424_242,
            safety_blocked: false,
            claimed_paths: None,
        }
    }

    /// 往这个会话的缓存里塞一份假报告 —— 探针用的注入点。
    ///
    /// `deleted` 是**已删集合快照**那一格键。探针塞的是空快照，所以下面几条判据
    /// （同 claims 复用 / 换 claims 重算）量的还是它们原本量的东西；
    /// 集合本身进键这件事由 `a_deleted_path_snapshot_bounds_the_cache` 单独钉。
    fn plant_fake_report(state: &AppState, scan_id: &str, claims: bool) {
        plant_fake_report_with(state, scan_id, claims, Vec::new());
    }

    fn plant_fake_report_with(state: &AppState, scan_id: &str, claims: bool, deleted: Vec<String>) {
        let s = state.sessions.lock().unwrap().get(scan_id).cloned().expect("会话该在");
        *s.report_cache.lock().unwrap() = Some((claims, deleted, Arc::new(fake_report_for_cache_probe())));
    }

    /// ① **同一会话、同一 `report_claims`** ⇒ 第二趟必须复用第一趟的报告。
    #[test]
    fn a_second_preview_on_the_same_session_reuses_the_report() {
        let state = state_with(session_with_temp_tree(100));

        // 第一趟：真算。它会把报告填进会话缓存。
        let first = build_preview(&state, "s1", json!({ "items": [] }), None, None, None)
            .unwrap()
            .expect("有树就该有回包");
        assert_eq!(first.preview.total_bytes, 0, "空勾选什么都不计价");

        // 把缓存换成假报告。第二趟若**真的复用**，念出来的就是 424242。
        plant_fake_report(&state, "s1", false);

        let second = build_preview(
            &state,
            "s1",
            json!({ "items": [{ "ruleId": "windows-temp" }] }),
            None,
            None,
            None,
        )
        .unwrap()
        .expect("有树就该有回包");
        let item = second
            .preview
            .items
            .iter()
            .find(|i| i.rule_id == "windows-temp")
            .expect("假报告里有这一条，复用才会出现在页上");
        assert_eq!(
            item.finding_bytes, 424_242,
            "第二趟没有复用报告 —— 它又把那 244 ms 的机器事实采集重跑了一遍（假数据被真报告覆盖）"
        );
        assert_eq!(item.bytes, 424_242, "计价照常走勾选那一步（勾了就该计入）");
    }

    /// ② **换一次扫描必须重算**：把上一轮的报告套到这一轮上，等于给用户看别的盘的账。
    ///
    /// 缓存现在住在 `Session` 上，所以这条是**结构性**成立的：新会话就是新的 `report_cache`，
    /// 旧会话那份随它一起被丢弃。这里钉的是那个结构 —— 一个会话的缓存不许被另一个会话读到。
    #[test]
    fn a_different_scan_id_never_reuses_the_report() {
        let state = state_with(session_with_temp_tree(100));
        // s1 的缓存里塞一份假报告
        plant_fake_report(&state, "s1", false);

        // 另建一个会话（= 换了一次扫描）。它的缓存是空的 ⇒ 必须真算，拿到真树的 100。
        let s2 = session_with_temp_tree(100);
        let mut s2 = Arc::try_unwrap(s2).ok().expect("刚建出来没有别的引用");
        s2.id = "s2".to_string();
        state.sessions.lock().unwrap().insert("s2".into(), Arc::new(s2));

        let payload = build_preview(
            &state,
            "s2",
            json!({ "items": [{ "ruleId": "windows-temp" }] }),
            None,
            None,
            None,
        )
        .unwrap()
        .expect("有树就该有回包");
        let item = payload.preview.items.iter().find(|i| i.rule_id == "windows-temp").unwrap();
        assert_eq!(
            item.finding_bytes, 100,
            "另一个会话拿到了 s1 的缓存 —— 那是把上一轮扫描的账套到了这一轮上"
        );
        // 反向半边：s1 自己那份假报告**还在**（证明上面不是"把两份都清了"才过的）
        let s1 = state.sessions.lock().unwrap().get("s1").cloned().unwrap();
        assert!(
            s1.report_cache.lock().unwrap().is_some(),
            "查 s2 把 s1 的缓存也清掉了 —— 那这条判据没在验隔离"
        );
    }

    /// ③ **`report_claims` 不同的两份报告不许混用**：它决定报告**形状**
    /// （`claimed_paths` 挂不挂），混用会把一张不带认领表的报告交给 §12 的归属反查。
    #[test]
    fn the_claims_variant_is_part_of_the_cache_key() {
        let state = state_with(session_with_temp_tree(100));
        // 缓存里躺的是「不带 claims」那一份
        plant_fake_report(&state, "s1", false);

        // 这次请求带 tilePaths ⇒ report_claims = true ⇒ 键不同 ⇒ 必须真算
        let payload = build_preview(
            &state,
            "s1",
            json!({ "items": [{ "ruleId": "windows-temp" }] }),
            None,
            None,
            Some(vec![json!(r"C:\Temp\whatever.tmp")]),
        )
        .unwrap()
        .expect("有树就该有回包");
        let item = payload.preview.items.iter().find(|i| i.rule_id == "windows-temp").unwrap();
        assert_eq!(
            item.finding_bytes, 100,
            "带 tilePaths 的那一趟吃了不带 claims 的缓存 —— 归属反查会拿到一张没有认领表的报告"
        );
    }

    /// ④ **已删集合的快照是缓存键的第二格**（2026-10-25 修「清理后又开始延迟」）。
    ///
    /// 人类伙伴报的症状：勾选之后又出现延迟、勾没显示出来、也没计入。
    /// 修法不是把延迟调回去，而是找出 10-22 那份修法漏掉的那一格：
    /// `report_for_preview` 原来写的是"已删集合**非空** ⇒ 一律不复用缓存"，
    /// 于是清理过一次之后，缓存**永久**失效 —— 此后的每一次勾选都重跑全树索引
    /// + 机器事实采集 + 规则评估（`C:\Windows` 125k 文件实测 244 ms 起）。
    /// 真机日志里 `auto-…-2` 删了 330 个文件，之后再勾选就是那一档慢。
    ///
    /// 三条钉住的东西：
    ///  ① 集合**没变**（哪怕非空）⇒ 第二趟复用缓存（这是这条修法的本体）；
    ///  ② 集合**变了** ⇒ 必须重算（这是 10-24 那条「清理后数字要变」的回归防线）；
    ///  ③ 重算之后缓存里存的是**新快照**那一格 —— 之后又稳定复用，
    ///     而不是每勾一次都全量（否则这条修法只生效一次）。
    /// ⚠️ 夹具形状：进 `deleted_paths` 的就是 `normalize_key` 之后的键（`execute_plan`
    /// 收尾那段逐字这么写），所以缓存键那一格也必须用同一个函数算 —— 两边写法不同
    /// 会让"集合没变"看起来像"变了"，这条判据会红在自己的夹具上。
    #[test]
    fn a_deleted_path_snapshot_bounds_the_cache() {
        use deepclean_rules::engine::normalize_key;
        let state = state_with(session_with_temp_tree(100));
        let first_key = normalize_key(r"C:\Temp\a.tmp");

        // ① 先造一份"清理过"的缓存：假报告 + 一条已删快照，与会话的集合**逐字相同**
        plant_fake_report_with(&state, "s1", false, vec![first_key.clone()]);
        state
            .sessions
            .lock()
            .unwrap()
            .get("s1")
            .unwrap()
            .deleted_paths
            .lock()
            .unwrap()
            .insert(first_key);

        let reused = build_preview(
            &state,
            "s1",
            json!({ "items": [{ "ruleId": "windows-temp" }] }),
            None,
            None,
            None,
        )
        .unwrap()
        .expect("有树就该有回包");
        let item = reused.preview.items.iter().find(|i| i.rule_id == "windows-temp").unwrap();
        assert_eq!(
            item.finding_bytes, 424_242,
            "已删集合没变却重算了 —— 清理之后的每次勾选又要付那 244 ms"
        );

        // ② 再删一条 ⇒ 快照变了 ⇒ 必须重算（拿真树的 100，不是假报告的 424242）
        let second_key = normalize_key(r"C:\Temp\b.tmp");
        state
            .sessions
            .lock()
            .unwrap()
            .get("s1")
            .unwrap()
            .deleted_paths
            .lock()
            .unwrap()
            .insert(second_key);
        let recomputed = build_preview(
            &state,
            "s1",
            json!({ "items": [{ "ruleId": "windows-temp" }] }),
            None,
            None,
            None,
        )
        .unwrap()
        .expect("有树就该有回包");
        let item2 = recomputed.preview.items.iter().find(|i| i.rule_id == "windows-temp").unwrap();
        assert_eq!(
            item2.finding_bytes, 100,
            "已删集合变了却复用缓存 —— 清理后的数字不会跟着降（10-24 那个缺陷回来了）"
        );

        // ③ 缓存里存的必须是**新快照**：之后又稳定复用
        let s = state.sessions.lock().unwrap().get("s1").cloned().unwrap();
        let key_now = s.deleted_paths.lock().unwrap().iter().cloned().collect::<Vec<_>>();
        assert!(
            matches!(s.report_cache.lock().unwrap().as_ref(), Some((c, k, _)) if !*c && *k == key_now),
            "重算之后没把新快照写进缓存 —— 这条修法只生效一次，之后每次都全量"
        );
    }

    /// ⑤ **确认那一趟不许吃缓存**：回执是删除的授权凭据，必须基于当下这份机器事实。
    ///
    /// 这条与上面几条方向相反，且是**必须保留的那一份慢**：490 ms 花在用户显式按下
    /// 「确认」上完全可接受，而拿一份旧机器事实出的回执可能删掉一个刚装上的应用的数据。
    #[test]
    fn the_confirm_round_trip_never_reads_the_cached_report() {
        let state = state_with(session_with_temp_tree(100));
        // 缓存里塞一份「windows-temp 有 424242 字节」的假报告
        plant_fake_report(&state, "s1", false);

        // 带 confirm 的那一趟：必须真算，拿到真树的 100 字节，而不是假报告的 424242
        let payload = build_preview(
            &state,
            "s1",
            json!({ "items": [{ "ruleId": "windows-temp" }] }),
            Some(true),
            None,
            None,
        )
        .unwrap()
        .expect("有树就该有回包");
        let c = payload.confirmation.expect("带了 confirm 就该有回执");
        assert_eq!(
            c.total_bytes, 100,
            "确认那趟吃了缓存 —— 回执锚在一份过期的机器事实上"
        );
    }

    /* ------------------------------------------------------------------ *
     * 「扫描结束 → 界面知道」那条通知不许被预热挡在后面（2026-10-22）
     *
     * 人类伙伴报告：「debug 版本扫描结束会卡死（耗时已经停了，但是仍提示扫描中）」。
     *
     * 成因是可读出来的：`start_scan` 的扫描线程里，第 458 行早就把 `status` 置成
     * `Completed`、第 465 行也写了 `finished_at_ms`（所以「用时」**已经停住**），
     * 而界面拿状态的唯一通道是 `dc://scan` 事件 —— 那条事件原先写在**开发环境页预热之后**。
     * 预热实测 `C:\Windows`（35,374 目录）3267 ms，代码注释自记全盘 C: 约 12 s，
     * 于是那 3–12 秒里：耗时不动、界面仍念「扫描中…」。
     *
     * 判据用的是**源码顺序**，因为 `start_scan` 必须要一个真的 `AppHandle`（`tauri::test`
     * 之外造不出来），而这条缺陷的全部内容就是"两行的先后"。抽成纯函数也没用 ——
     * 那会验一个陪衬，而不是真代码里的那两行。
     *
     * ⚠️ 判据只认**函数体的位置**：`SCAN_EVENT` 常量声明在文件上方、`emit` 那一行在
     * `start_scan` 里，拿全文 `find` 会命中常量名而不是调用 —— 所以从 `fn start_scan(`
     * 处切起。这与 `commands.rs` 的 `rust_params` 同一条理由（那里也踩过"注释里的字"的坑）。
     * ------------------------------------------------------------------ */

    /// 判据内核：给一段源码，回答「`done` 事件是否排在预热之前」。
    ///
    /// 抽出来只为一件事：**正反两条用例走同一段逻辑**。若把它写在 `#[test]` 里，
    /// 反面对照就只能另造一份字符串自己跟自己比 —— 那种对照证明不了真判据有判别力
    /// （第一版就是这样，它红了也只说明那段假字符串是反序）。
    ///
    /// `None` = 起点或两个锚点找不到。**不许退化成 `true`**：找不到锚点时"通过"是假绿，
    /// 而这条闸的全部价值就在于它会在顺序被调回去时红。
    fn done_event_precedes_warmup(src: &str) -> Option<bool> {
        let at = src.find("pub fn start_scan(")?;
        let body = &src[at..];
        let emit_at = body.find("emit(SCAN_EVENT")?;
        let warm_at = body.find("warm_detector_status()")?;
        Some(emit_at < warm_at)
    }

    /// `done` 事件必须在预热**之前**发出。
    #[test]
    fn the_done_event_is_emitted_before_the_dev_env_warmup() {
        let src = include_str!("service.rs");
        let verdict = done_event_precedes_warmup(src)
            .expect("判据的起点/锚点找不到（start_scan / emit(SCAN_EVENT) / warm_detector_status）—— \
                     那样这一格必须红，不许静默放过");
        assert!(
            verdict,
            "`done` 事件排在预热之后了 ⇒ 扫描已完成（耗时已停）而界面仍显示「扫描中…」，\
             实测要白等 3267 ms（C:\\Windows）/ 约 12 s（全盘 C:）"
        );
    }

    /// 反面对照：**同一段逻辑**喂一份反序源码必须回答「不是」。
    ///
    /// 这份反序样本照着真缺陷的形状写（预热在前、emit 在后），
    /// 所以它红了就说明上面那条闸在真被调回去时会红的。
    #[test]
    fn the_ordering_check_answers_no_for_a_swapped_source() {
        let wrong = "pub fn start_scan(a: A) { warm_detector_status(); emit(SCAN_EVENT, x); }";
        assert_eq!(
            done_event_precedes_warmup(wrong),
            Some(false),
            "反序源码被判成「顺序正确」⇒ 上面那条闸没有判别力"
        );
        // 正序样本必须答 true（否则这条判据恒 false，是另一种坏法）
        let right = "pub fn start_scan(a: A) { emit(SCAN_EVENT, x); warm_detector_status(); }";
        assert_eq!(done_event_precedes_warmup(right), Some(true));
        // 锚点缺失必须是 None，不许默认成"通过"
        assert_eq!(done_event_precedes_warmup("pub fn other() {}"), None);
    }

    /* ---------------- dev-only 的 DC_ENV_ROOT 口子 ---------------- */

    fn env_with(pairs: &[(&str, &str)]) -> RuleEnv {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect();
        rule_env_from(|k| map.get(k).cloned())
    }

    /// 设了 `DC_ENV_ROOT` ⇒ 五个**规则领地**键指到它下面，验收才拿得到"规则能命中、
    /// 又只碰得到我自己造的文件"那种输入。
    #[test]
    #[cfg(debug_assertions)]
    fn the_dev_override_moves_the_territory_keys() {
        let e = env_with(&[
            ("DC_ENV_ROOT", r"C:\sandbox\envroot"),
            ("TEMP", r"D:\real\temp"),
            ("LOCALAPPDATA", r"D:\real\local"),
            ("USERPROFILE", r"D:\real\profile"),
        ]);
        assert_eq!(e.get("TEMP").map(String::as_str), Some(r"C:\sandbox\envroot\TEMP"));
        assert_eq!(e.get("LOCALAPPDATA").map(String::as_str), Some(r"C:\sandbox\envroot\LOCALAPPDATA"));
        assert_eq!(e.get("USERPROFILE").map(String::as_str), Some(r"C:\sandbox\envroot\USERPROFILE"));
    }

    /// **承重的那半边**：`SYSTEMDRIVE` / `WINDIR` 不许被搬走。
    /// 禁止根与只上报根全从这两个解析（`%WINDIR%\System32` 等 6 条 + 回收站）——
    /// 把它们一起重定向进沙箱，§16 那道结构闸就变成"在沙箱里自己夸自己通过"，
    /// 那次真机清理验的就不再是守卫了。
    #[test]
    #[cfg(debug_assertions)]
    fn the_dev_override_never_moves_the_guard_keys() {
        let e = env_with(&[
            ("DC_ENV_ROOT", r"C:\sandbox\envroot"),
            ("SYSTEMDRIVE", "C:"),
            ("WINDIR", r"C:\Windows"),
            // R-DENY-* 那批模板引用的其余键（CLEANUP-RULES §6 补齐时加进来的）。
            // 少任何一个，这条判据量到的就是"模板解析不出来"而不是"guard keys 没被搬走" ——
            // 2026-10-19 实测踩过：`%PROGRAMFILES%\` 一进来，`unresolved` 立刻非空。
            ("PROGRAMFILES", r"C:\Program Files"),
            ("PROGRAMDATA", r"C:\ProgramData"),
            ("USERPROFILE", r"C:\Users\Kano"),
            ("APPDATA", r"C:\Users\Kano\AppData\Roaming"),
            ("LOCALAPPDATA", r"C:\Users\Kano\AppData\Local"),
        ]);
        assert_eq!(e.get("SYSTEMDRIVE").map(String::as_str), Some("C:"));
        assert_eq!(e.get("WINDIR").map(String::as_str), Some(r"C:\Windows"));

        // 而且搬走之后禁止根**仍然解析得到**（这是守卫还在工作的直接证据）。
        let forbidden = deepclean_cleaner::resolve_roots(
            &deepclean_rules::FORBIDDEN_PATH_PATTERNS.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            &e,
        );
        assert!(forbidden.unresolved.is_empty(), "{:?}", forbidden.unresolved);
        assert!(forbidden.roots.iter().any(|r| r.starts_with(r"C:\Windows\System32")), "{:?}", forbidden.roots);
    }

    /// 没设口子时逐字等于旧行为（五个键照旧读真机值）。
    #[test]
    fn without_the_override_the_env_is_just_the_real_machine() {
        let e = env_with(&[("TEMP", r"D:\real\temp"), ("SYSTEMDRIVE", "C:")]);
        assert_eq!(e.get("TEMP").map(String::as_str), Some(r"D:\real\temp"));
        assert_eq!(e.len(), 2, "只插非空的键，也不凭空多一条 DC_ENV_ROOT");
        assert!(!e.contains_key("DC_ENV_ROOT"));
    }

    /// 空串口子 = 没设（与"缺的变量不补"同一条纪律，不是拿 `C:\envroot\TEMP` 去覆盖真值）。
    #[test]
    #[cfg(debug_assertions)]
    fn an_empty_override_root_is_treated_as_absent() {
        let e = env_with(&[("DC_ENV_ROOT", ""), ("TEMP", r"D:\real\temp")]);
        assert_eq!(e.get("TEMP").map(String::as_str), Some(r"D:\real\temp"));
    }

    /* ---------------- §18 执行入口的三条整批拒绝 ---------------- */

    fn plan(root: &str, paths: Vec<String>) -> ConfirmedPlan {
        ConfirmedPlan {
            digest: "d-test".into(),
            scan_id: "t-test".into(),
            batches: vec![CleanBatch { root: root.into(), paths }],
            attribution: HashMap::new(),
        }
    }

    /// 没有回执就没有执行这回事。
    #[test]
    fn an_unknown_digest_executes_nothing() {
        let state = AppState::default();
        let e = lookup_plan(&state, "nope").expect_err("未知指纹必须被拒");
        assert!(e.starts_with("E_UNKNOWN_CONFIRMATION"), "{e}");
        assert!(state.tasks.lock().unwrap().is_empty(), "连任务都不该被记下来");

        // 对照：真存进去一张，就查得到 —— 否则上面那条恒真（什么都没验）。
        state.confirmations.lock().unwrap().insert("d-real".into(), plan(r"C:\Sandbox", vec![]));
        assert!(lookup_plan(&state, "d-real").is_ok(), "回执存在时必须查得到");
    }

    /* ---------------- 批次授权根：套住受保护路径时收窄 ---------------- */

    /// 造一份只有一条 `app-rotated-logs` finding 的报告，`%PROGRAMDATA%` 当匹配根
    /// （`leafFiles` 分支的真实形状：根就是被搜过的那层容器入口）。
    fn sweeping_report() -> RuleReport {
        let pdata = r"C:\ProgramData";
        RuleReport {
            findings: vec![deepclean_rules::engine::RuleFinding {
                rule_id: "app-rotated-logs".into(),
                name: "应用轮转日志".into(),
                category: deepclean_rules::types::RuleCategory::AppTransient,
                risk_level: Risk::Caution,
                clean_strategy: deepclean_rules::types::CleanStrategy::DeleteAll,
                recoverable: false,
                matched_roots: vec![pdata.to_string()],
                sample_paths: vec![],
                sample_truncated: false,
                file_count: 2,
                total_bytes: 100,
                all_paths: None,
            }],
            exclusions: vec![],
            rejected_rules: vec![],
            forbidden_roots: vec![r"C:\Windows\System32".into()],
            // 这一条就是真机上让那批整批被拒的那一条
            report_only_roots: vec![r"C:\ProgramData\Package Cache".into()],
            territories: vec![],
            bytes_by_risk: Default::default(),
            reclaimable_bytes: 100,
            safety_blocked: false,
            claimed_paths: None,
        }
    }

    fn rotated_log_item(paths: Vec<&str>) -> deepclean_cleaner::PreviewItem {
        deepclean_cleaner::PreviewItem {
            rule_id: "app-rotated-logs".into(),
            name: "应用轮转日志".into(),
            description: String::new(),
            category: deepclean_rules::types::RuleCategory::AppTransient,
            risk_level: Risk::Caution,
            clean_strategy: deepclean_rules::types::CleanStrategy::DeleteAll,
            recoverable: false,
            selected: true,
            included: true,
            bytes: 100,
            files: 2,
            scope: deepclean_cleaner::PreviewScope::Paths,
            paths: paths
                .into_iter()
                .map(|p| deepclean_cleaner::PricedPath { path: p.to_string(), size: 50 })
                .collect(),
            finding_bytes: 100,
            finding_files: 2,
            sample_truncated: false,
            matched_roots: vec![r"C:\ProgramData".into()],
            refusal: None,
        }
    }

    fn model_with(items: Vec<deepclean_cleaner::PreviewItem>) -> PreviewModel {
        PreviewModel {
            items,
            refusals: vec![],
            total_bytes: 100,
            total_files: 2,
            risk_breakdown: Default::default(),
            refused_bytes: 0,
            blocked: false,
            report_reclaimable_bytes: 100,
            report_forbidden_bytes: 0,
            forbidden_roots: vec![r"C:\Windows\System32".into()],
            report_only_roots: vec![r"C:\ProgramData\Package Cache".into()],
            report_exclusion_count: 0,
            territories: vec![],
            default_unselectable_rule_ids: vec![],
            notes: vec![],
            generated_at_ms: 0,
            digest: "d".into(),
        }
    }

    /// **这条是那个缺陷的判据。** 匹配根 `%PROGRAMDATA%` 套着只上报根
    /// `%PROGRAMDATA%\Package Cache` ⇒ 不收窄的话这一批在执行器那道闸上整批被拒、
    /// 一条都删不了（2026-10-24 真机：8 批里 1 批这样，125 条全落在这里）。
    /// 收窄后每个根都比 `Package Cache` 窄，且都不套住它。
    #[test]
    fn a_container_root_that_sweeps_a_report_only_root_is_narrowed_to_parent_dirs() {
        let report = sweeping_report();
        let model = model_with(vec![rotated_log_item(vec![
            r"C:\ProgramData\Comms\Hiview\HiviewPlatform.1.log",
            r"C:\ProgramData\Comms\Hiview\HiviewService.1.log",
            r"C:\ProgramData\USOShared\Logs\System\a.1.etl",
        ])]);
        let batches = executable_batches(&report, &model);

        let roots: Vec<&str> = batches.iter().map(|b| b.root.as_str()).collect();
        assert_eq!(
            roots,
            vec![r"C:\ProgramData\Comms\Hiview", r"C:\ProgramData\USOShared\Logs\System"],
            "两个父目录各一批，容器根本身不该再出现"
        );
        assert!(
            !roots.iter().any(|r| r.eq_ignore_ascii_case(r"C:\ProgramData")),
            "容器根套住 Package Cache，收窄后不许留着它"
        );
        // 收窄后的每个根都必须真能过 `root-ancestor-of-forbidden` 那道判据
        for r in &roots {
            assert!(
                !deepclean_cleaner::is_strictly_inside(r"C:\programdata\package cache", &r.to_lowercase()),
                "{r} 仍然套住 Package Cache —— 收窄没生效"
            );
        }
        assert_eq!(batches.iter().map(|b| b.paths.len()).sum::<usize>(), 3, "一条路径都不许丢");
    }

    /// 默认档 = 核数的 60%（2026-10-30 第三轮）。
    ///
    /// 与设置页 `PerformanceCard` 的 `defaultWorkers` 同一条算式。
    /// 两侧分叉的表现：界面写「默认推荐 = 5 线程」而实际跑 8 线程 ——
    /// TS 那一侧有判据钉着算式，这一侧钉 Rust 侧的同一个数。
    #[test]
    fn the_delete_default_is_sixty_percent_of_cores() {
        assert_eq!(default_workers_of(8), 5);   // 8 * 0.6 = 4.8 -> 5
        assert_eq!(default_workers_of(10), 6);  // 6.0 -> 6
        assert_eq!(default_workers_of(4), 2);   // 2.4 -> 2
        // 1 核机：0.6 -> 1（至少 1 条线程 —— 0 条会让 join 返回空树）
        assert_eq!(default_workers_of(1), 1);
        assert_eq!(default_workers_of(0), 1);
        // 反面对照：不许是 100%（那是上一轮的默认）
        assert_ne!(default_workers_of(8), 8);
    }

    /// 切片本身（2026-10-30）—— 不碰文件系统，纯函数。
    ///
    /// 这一组钉的是"删得多快"那件事的**形状**：切几片、每片拿到哪些路径。
    /// 它不证明"真的更快"（那要 `examples/delprobe.rs` 那种实测），
    /// 但它挡住四类会让并发白费的错法。
    #[test]
    fn a_batch_is_sliced_round_robin_not_in_contiguous_chunks() {
        let paths: Vec<String> = (0..8).map(|i| format!(r"C:\dbg\f{i}.tmp")).collect();

        // ① 片数 = min(路径数, workers)
        assert_eq!(slice_batch_paths(&paths, 4).len(), 4);
        assert_eq!(slice_batch_paths(&paths, 8).len(), 8);
        // 路径比线程少时多开只是空转
        assert_eq!(slice_batch_paths(&paths[..3], 8).len(), 3);
        // workers = 0 也不许切出 0 片（那会让整批一条都不跑）
        assert_eq!(slice_batch_paths(&paths, 0).len(), 1);

        // ② **轮转**：每片都横跨整张清单，不是连续切块。
        //    连续切块时第 0 片会是 f0..f3 —— 那正是"同一目录全落一片"的形状。
        let s = slice_batch_paths(&paths, 4);
        assert_eq!(s[0], vec![r"C:\dbg\f0.tmp", r"C:\dbg\f4.tmp"]);
        assert_eq!(s[1], vec![r"C:\dbg\f1.tmp", r"C:\dbg\f5.tmp"]);
        assert!(
            !s[0].contains(&r"C:\dbg\f1.tmp".to_string()),
            "连续切块了：第 0 片吃到了相邻的两条"
        );

        // ③ 一片都不丢、也不重复
        let mut all: Vec<String> = s.into_iter().flatten().collect();
        all.sort();
        let mut want = paths.clone();
        want.sort();
        assert_eq!(all, want, "切完之后路径集合变了");
    }

    #[test]
    fn an_empty_batch_slices_into_exactly_one_empty_slice() {
        // 空批次承载"整批拒绝"的语义 —— 切成 N 片会让同一件事在 refusals 里重复 N 遍。
        let s = slice_batch_paths(&[], 8);
        assert_eq!(s.len(), 1);
        assert!(s[0].is_empty());
        // 反面对照：非空批次不许退化成一整片（那等于没切）
        let one = vec![r"C:\dbg\a.tmp".to_string()];
        assert_eq!(slice_batch_paths(&one, 8).len(), 1, "一条路径本来就只能一片");
        let two = vec![r"C:\dbg\a.tmp".to_string(), r"C:\dbg\b.tmp".to_string()];
        assert_eq!(slice_batch_paths(&two, 8).len(), 2);
    }

    #[test]
    fn a_batch_whose_root_sweeps_nothing_is_left_verbatim() {
        let report = sweeping_report();
        let mut item = rotated_log_item(vec![r"C:\ProgramData\Comms\Hiview\HiviewPlatform.1.log"]);
        // 匹配根换成一个不套住 Package Cache 的窄目录
        item.matched_roots = vec![r"C:\ProgramData\Comms\Hiview".into()];
        let model = model_with(vec![item]);
        let mut report = report;
        report.findings[0].matched_roots = vec![r"C:\ProgramData\Comms\Hiview".into()];

        let batches = executable_batches(&report, &model);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].root, r"C:\ProgramData\Comms\Hiview", "没收窄的必要就不许动它");
        assert_eq!(batches[0].paths, vec![r"C:\ProgramData\Comms\Hiview\HiviewPlatform.1.log"]);
    }

    /// 收窄**失败**时退回原根，把拒绝如实留给执行器 —— 不在这里编一个"能删的根"。
    /// 构造：父目录本身仍套住受保护路径（`Package Cache` 就在它的正下方）。
    #[test]
    fn a_root_that_cannot_be_narrowed_is_kept_so_the_executor_refuses_it_honestly() {
        let mut report = sweeping_report();
        report.report_only_roots = vec![r"C:\ProgramData\Comms\Package Cache".into()];
        // 清单里那一条的父目录 = `C:\ProgramData\Comms`，它套住 `...\Comms\Package Cache`
        let model = model_with(vec![rotated_log_item(vec![
            r"C:\ProgramData\Comms\Hiview.1.log",
        ])]);

        let batches = executable_batches(&report, &model);
        assert_eq!(batches.len(), 1);
        assert_eq!(
            batches[0].root, r"C:\ProgramData",
            "收不窄就原样保留，让执行器如实说 root-ancestor-of-forbidden"
        );
    }

    /// 盘符根不是合法授权根（`root-is-drive-root`），收窄不许落到它上面。
    #[test]
    fn parent_dir_never_returns_a_bare_drive() {
        assert_eq!(parent_dir(r"C:\x"), None, "C: 是盘符根，不许当授权根");
        assert_eq!(parent_dir(r"C:\a\b"), Some(r"C:\a".into()));
        assert_eq!(parent_dir(r"C:\a\b\"), Some(r"C:\a".into()), "尾斜杠不影响取父目录");
        assert_eq!(parent_dir(r"C:\"), None);
    }

    /// **扫完整盘再清理在结构上不可能**：`C:\` 过不了守卫，整批拒绝、零删除。
    /// 这条走的是真 `WindowsCleanFs` —— 它一个文件都没动，正因为如此才敢用真的。
    #[test]
    fn a_plan_rooted_at_a_drive_letter_refuses_the_whole_batch() {
        let state = AppState::default();
        let p = plan("C:\\", vec![r"C:\Temp\x.tmp".into()]);
        let task = execute_plan(&p, &state, None, "t-drive-root", false);
        assert_eq!(task.status, deepclean_cleaner::CleanTaskStatus::Refused);
        assert_eq!(
            task.blockers[0].reason,
            deepclean_cleaner::CleanBlockerReason::RootIsDriveRoot,
            "{:?}",
            task.blockers
        );
        assert_eq!(task.success_count, 0);
        assert!(task.deleted.is_empty(), "整批拒绝 ⇒ 一条都没动");
        assert!(task.accepted_paths.is_empty());
    }

    /// 授权根**套住**禁止路径 ⇒ 宽容器一律不认。
    #[test]
    fn a_plan_whose_root_sweeps_a_forbidden_path_refuses_the_whole_batch() {
        let state = AppState::default();
        let p = plan(r"C:\Windows", vec![r"C:\Windows\Temp\x.tmp".into()]);
        let task = execute_plan(&p, &state, None, "t-ancestor", false);
        assert_eq!(task.status, deepclean_cleaner::CleanTaskStatus::Refused);
        assert_eq!(
            task.blockers[0].reason,
            deepclean_cleaner::CleanBlockerReason::RootAncestorOfForbidden,
            "{:?}",
            task.blockers
        );
        assert!(task.deleted.is_empty());
    }

    /// 回收站这类「只上报不可删」的根当授权根 ⇒ 整批拒绝。
    /// 看不见它就会被当普通目录删，那是这一层最贵的一种错。
    #[test]
    fn a_plan_rooted_at_a_report_only_root_refuses_the_whole_batch() {
        let state = AppState::default();
        let bin = format!(
            "{}\\$Recycle.Bin",
            std::env::var("SYSTEMDRIVE").unwrap_or_else(|_| "C:".into())
        );
        let p = plan(&bin, vec![format!(r"{bin}\S-1-5-18\x")]);
        let task = execute_plan(&p, &state, None, "t-report-only", false);
        assert_eq!(task.status, deepclean_cleaner::CleanTaskStatus::Refused);
        assert!(
            matches!(
                task.blockers.first().map(|b| b.reason),
                Some(
                    deepclean_cleaner::CleanBlockerReason::RootReportOnly
                        | deepclean_cleaner::CleanBlockerReason::RootForbidden
                        | deepclean_cleaner::CleanBlockerReason::RootAncestorOfForbidden
                )
            ),
            "{:?}",
            task.blockers
        );
        assert!(task.deleted.is_empty());
    }

    /// 取消把手只在**正在跑**时找得到；跑完就摘掉，所以事后取消回 false 而不是静默成功。
    #[test]
    fn cancel_only_reaches_a_task_that_is_actually_running() {
        let state = AppState::default();
        assert!(!cancel_cleanup(&state, "never-existed"));
        let p = plan("C:\\", vec![]);
        execute_plan(&p, &state, None, "t-done", false);
        assert!(!cancel_cleanup(&state, "t-done"), "已结束 ⇒ 不许报「取消成功」");
    }

    /* ---------------- 清理后「图二数字」必须下降（2026-10-25 缺陷） ---------------- */

    /// **这条是「清理之后预估条目还是原来那么大」那个缺陷的判据。**
    ///
    /// 人类伙伴 2026-10-25 复现：只勾一个 4 MB 的条目（`thumbnail-cache`），清理成功
    /// （`cleanedSize=4201960`，日志里有记录），但清理页那个条目**还显示 4 MB**。
    ///
    /// 链路上每一段都自称"他处已验"：前端 `refreshNonce` 进缓存键、`report_for_preview`
    /// 在 `deleted_paths` 非空时作废缓存、`FilteredSource` 摘已删文件。
    /// 但**从未有一条测试把这几段串起来跑一次**。这条就是串起来的那条。
    ///
    /// 直接调 `report_for_preview`：写进一个已删路径，看报告字节降不降。
    fn sample_tree(files: &[(&str, u64)]) -> Arc<Session> {
        use deepclean_scanner::model::ScanFile as SF;
        let temp = std::env::var("TEMP").expect("本机必须有 TEMP");
        let mut root = ScanNode::dir("Temp".into(), temp.clone());
        let mut total = 0u64;
        for (name, bytes) in files {
            root.files.push(SF {
                name: (*name).into(),
                size: *bytes,
                alloc: *bytes,
                counted: *bytes,
                file_id: 1,
                mtime_ms: 0,
                creation_ms: 0,
                attrs: 0,
            });
            total += bytes;
        }
        root.size_counted = total;
        root.file_count = files.len() as u64;
        let tree = TreeIndex::build(&ScanTree {
            top: Vec::new(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 1u64 << 62, free_bytes: 0 },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            mode: ScanMode::Walk,
            mft: None,
            elapsed_ms: 0,
        });
        Arc::new(Session {
            id: "s1".into(),
            root: temp,
            control: ScanControl::new(),
            report_cache: Mutex::new(None),
            deleted_paths: Mutex::new(std::collections::BTreeSet::new()),
            state: Mutex::new(SessionState {
                status: Status::Completed,
                counters: Counters::default(),
                current_path: String::new(),
                started_at_ms: None,
                finished_at_ms: None,
                tree: Some(std::sync::Arc::new(tree)),
                error: None,
                unaccounted: 0,
                scan_mode: "walk",
                view_excluded: Default::default(),
            }),
        })
    }

    #[test]
    fn a_deleted_file_lowers_the_preview_bytes() {
        use deepclean_rules::engine::normalize_key;

        let s = sample_tree(&[("a.tmp", 100), ("b.tmp", 200)]);
        let tree = {
            let st = s.state.lock().unwrap();
            st.tree.clone().expect("树在")
        };
        let tree: &TreeIndex = &tree;

        // ① 删之前
        let before = report_for_preview(&s, &tree, 0, false, false);
        let temp = std::env::var("TEMP").unwrap();
        let key = normalize_key(&format!("{temp}\\a.tmp"));

        // ② 记一条已删（模拟 execute_plan 收尾那段）
        s.deleted_paths.lock().unwrap().insert(key);

        // ③ 再要一份报告 —— **不许复用缓存**
        let after = report_for_preview(&s, &tree, 0, false, true);

        let bytes_of = |r: &RuleReport| {
            r.findings
                .iter()
                .find(|f| f.rule_id == "windows-temp")
                .map(|f| f.total_bytes)
                .unwrap_or(0)
        };
        assert_eq!(bytes_of(&before), 300, "删前两个文件共 300");
        assert_eq!(
            bytes_of(&after),
            200,
            "删掉 a.tmp(100) 之后必须剩 200 —— 这一格不动就是「清完还显示原数」那个缺陷"
        );
    }

    /* ---------------- 清理日志（2026-10-25 重做） ---------------- */

    use deepclean_cleaner::executor::{CleanDeletion, CleanDeletionKind, CleanOutcome};

    fn del(path: &str, bytes: u64, ok: bool) -> CleanDeletion {
        CleanDeletion {
            path: path.into(),
            kind: CleanDeletionKind::File,
            bytes: if ok { bytes } else { 0 },
            ok,
            errno: if ok { None } else { Some("WIN32_120".into()) },
            detail: None,
            attempts: Some(1),
            outcome: Some(if ok { CleanOutcome::Ok } else { CleanOutcome::Failed }),
        }
    }

    /// 造一个带 `deleted[]` 的 task。`(path, bytes, ok)`。
    fn task_with_deleted(rows: Vec<(&str, u64, bool)>) -> CleanTask {
        CleanTask {
            id: "t-journal".into(),
            status: deepclean_cleaner::CleanTaskStatus::Completed,
            progress: 1.0,
            total_size: 0,
            cleaned_size: rows.iter().filter(|r| r.2).map(|r| r.1).sum(),
            success_count: rows.iter().filter(|r| r.2).count() as u64,
            failed_count: rows.iter().filter(|r| !r.2).count() as u64,
            authorized_root: "C:\\".into(),
            requested_paths: vec![],
            accepted_paths: vec![],
            blockers: vec![],
            refusals: vec![],
            deleted: rows.iter().map(|(p, b, ok)| del(p, *b, *ok)).collect(),
            dirs_removed: vec![],
            verification: None,
            digest: "d".into(),
            confirmation_digest: None,
            started_at_ms: 0,
            // ⚠️ 必须给**当前时间**，不能给 5000：`record_journal` 里紧跟一次
            // `prune(now_ms())`，而现在是 2026 年 —— 一个 1970 年的时间戳会被当过期当场删掉，
            // 于是"一次清理一条"那条判据会打出 left:0（实测踩过一次）。
            finished_at_ms: now_ms(),
        }
    }

    fn run_aged(age_ms: i64) -> deepclean_cleaner::CleanRun {
        let deleted = vec![del("C:\\a\\old.tmp", 1, true)];
        let mut r = deepclean_cleaner::build_run("aged", 1_000_000 - age_ms, &deleted).unwrap();
        r.id = "aged".into();
        r
    }

    #[test]
    fn journal_path_is_logs_clean_journal_json_under_app_data() {
        let p = journal_path(Path::new(r"C:\Users\x\AppData\Roaming\com.deepclean.app"));
        assert!(p.ends_with(Path::new("logs").join("clean-journal.json")), "{p:?}");
    }

    /// **这条是设计 §8 的第 1 条硬判据**：一次清理只能产生一条日志。
    /// 若 `record_journal` 在每批之后被调用一次，26 个批次会变成 26 条碎片。
    #[test]
    fn one_clean_task_produces_exactly_one_run() {
        let state = AppState::default();
        let task = task_with_deleted(vec![
            ("C:\\a\\x.tmp", 100, true),
            ("C:\\a\\y.tmp", 200, true),
            ("C:\\b\\z.tmp", 300, true),
            ("C:\\a\\bad.tmp", 999, false),
        ]);
        record_journal(&state, &task, &plan("C:\\", vec![]));

        let store = state.journal.lock().unwrap();
        assert_eq!(store.runs().len(), 1, "一次清理只能是一条日志");
        assert_eq!(store.runs()[0].freed_bytes, 600, "失败的 999 不许计进去");
        assert_eq!(store.runs()[0].file_count, 3);
    }

    #[test]
    fn a_refused_task_writes_no_run() {
        let state = AppState::default();
        let mut task = task_with_deleted(vec![("C:\\a\\x", 10, true)]);
        task.status = deepclean_cleaner::CleanTaskStatus::Refused;
        record_journal(&state, &task, &plan("C:\\", vec![]));
        assert!(state.journal.lock().unwrap().runs().is_empty());
    }

    #[test]
    fn a_task_with_zero_successful_files_writes_no_run() {
        let state = AppState::default();
        let task = task_with_deleted(vec![("C:\\a\\x", 10, false)]);
        record_journal(&state, &task, &plan("C:\\", vec![]));
        assert!(
            state.journal.lock().unwrap().runs().is_empty(),
            "一个都没删成 ⇒ 没有\"清理了多少\"可记"
        );
    }

    /// 双保险的一半：写入后就顺手淘汰，不等定时线程。
    #[test]
    fn writing_also_prunes_expired_runs() {
        let state = AppState::default();
        {
            let mut s = state.journal.lock().unwrap();
            s.push(run_aged(deepclean_cleaner::JOURNAL_RETENTION_MS + 1000));
        }
        record_journal(
            &state,
            &task_with_deleted(vec![("C:\\a\\x", 10, true)]),
            &plan("C:\\", vec![]),
        );
        let store = state.journal.lock().unwrap();
        assert_eq!(store.runs().len(), 1, "老的那条应被顺手淘汰，只剩新的");
        assert_ne!(store.runs()[0].id, "aged");
    }

    #[test]
    fn without_a_path_writes_are_no_ops_not_panics() {
        let state = AppState::default(); // journal_path 是 None
        record_journal(
            &state,
            &task_with_deleted(vec![("C:\\a\\x", 10, true)]),
            &plan("C:\\", vec![]),
        );
        // 内存里照样记，只是不落盘 —— 记账不许因为定不出目录就整条丢掉
        assert_eq!(state.journal.lock().unwrap().runs().len(), 1);
    }

    #[test]
    fn runs_come_back_newest_first() {
        let state = AppState::default();
        {
            let mut s = state.journal.lock().unwrap();
            // 用**当前时间**附近的时间戳：太老会被 30 天窗口滤掉（与上面 task_with_deleted 同一个坑）
            let base = now_ms();
            for (id, off) in [("a", 1_000i64), ("b", 3_000), ("c", 2_000)] {
                let deleted = vec![del("C:\\a\\x.tmp", 1, true)];
                let mut r = deepclean_cleaner::build_run(id, base + off, &deleted).unwrap();
                r.id = id.into();
                s.push(r);
            }
        }
        let ids: Vec<_> = journal_runs(&state).into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["b", "c", "a"], "新的在前");
    }

    #[test]
    fn expired_runs_never_come_back_from_the_list() {
        let state = AppState::default();
        {
            let mut s = state.journal.lock().unwrap();
            s.push(run_aged(deepclean_cleaner::JOURNAL_RETENTION_MS + 1));
        }
        // 列表自己也要滤（定时线程可能还没跑过）
        assert!(journal_runs(&state).is_empty(), "过期的从列表里就不该出现");
    }

    #[test]
    fn an_unknown_run_id_returns_empty_not_an_error() {
        let state = AppState::default();
        assert!(journal_dir_summary(&state, "nope").is_empty());
        assert!(journal_dir_children(&state, "nope", "C:\\x").is_empty());
    }

    #[test]
    fn dir_summary_and_children_read_the_stored_run() {
        let state = AppState::default();
        let task = task_with_deleted(vec![
            ("C:\\T\\sub\\a.tmp", 100, true),
            ("C:\\T\\direct.tmp", 50, true),
        ]);
        record_journal(&state, &task, &plan("C:\\", vec![]));
        let id = state.journal.lock().unwrap().runs()[0].id.clone();

        let roots = journal_dir_summary(&state, &id);
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].dir, "C:\\T");
        assert_eq!(roots[0].file_count, 2);
        assert_eq!(roots[0].bytes, 150);

        let kids = journal_dir_children(&state, &id, "C:\\T");
        assert_eq!(kids.len(), 2, "{kids:?}");
        assert!(kids[0].is_dir, "目录排前面");
    }
}

#[cfg(test)]
mod dev_env_view_tests {
    //! §3.6 那一页的**运输**判据（M5-D2）。这些用例盯的是「既有结论换个形状」这一段：
    //! 计价归规则引擎与预估，视图那一半归 `deepclean-devenv`（那边有对账闸与九条变异）。
    //! 这里唯一的危险形状是**静默的 0**：没扫过时那一格念「还没扫过」，不是念一排 0。

    use super::*;
    use deepclean_devenv::detectors::{DockerDiskUsage, DockerVerdict};
    use deepclean_devenv::view::InstallState;
    use deepclean_scanner::model::{Counters, ScanFile, ScanMode, ScanNode, ScanTree};
    use deepclean_scanner::volume::VolumeInfo;
    use serde_json::json;
    use std::collections::BTreeMap;

    /// 把合成树钉在 **maven 那条规则的地盘祖链**上：`rule_env()` 读真环境，于是
    /// `%USERPROFILE%` = 树根，`.m2` 与 `repository` 是它的两层子节点。
    ///
    /// 为什么非要摆祖链（本次实测撞出来的）：地盘是**逐段下钻**的
    /// （`engine.rs:389-430`，每一段都问一次 `dir_id_by_path`），只把根摆在
    /// `%USERPROFILE%\.m2\repository` 会让中间那层 `.m2` 查无此目录 ⇒ 整条规则判成
    /// 「这次没扫到那块地」⇒ 计价 0 ⇒ 下面那条相等判据空转。真实树上 `.m2` 当然是在的。
    fn session_with_maven_tree(file_bytes: u64, ext_count: u64, ext_bytes: u64) -> Arc<Session> {
        use std::path::Path;
        let userprofile = std::env::var("USERPROFILE").expect("本机必须有 USERPROFILE");
        let m2 = Path::new(&userprofile).join(".m2");
        let mut repo_node = ScanNode::dir(
            "repository".into(),
            m2.join("repository").to_string_lossy().into_owned(),
        );
        repo_node.files.push(ScanFile {
            name: "dc-m5d-probe.jar".into(),
            size: file_bytes,
            alloc: file_bytes,
            counted: file_bytes,
            file_id: 1,
            mtime_ms: 0,
            creation_ms: 0,
            attrs: 0,
        });
        repo_node.size_logical = file_bytes;
        repo_node.size_alloc = file_bytes;
        repo_node.size_counted = file_bytes;
        repo_node.file_count = 1;

        let mut m2_node = ScanNode::dir(".m2".into(), m2.to_string_lossy().into_owned());
        m2_node.children.push(repo_node);
        m2_node.size_logical = file_bytes;
        m2_node.size_alloc = file_bytes;
        m2_node.size_counted = file_bytes;
        m2_node.file_count = 1;
        m2_node.dir_count = 1;

        let root_name = Path::new(&userprofile)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| userprofile.clone());
        let mut root = ScanNode::dir(root_name, userprofile.clone());
        root.children.push(m2_node);
        root.size_logical = file_bytes;
        root.size_alloc = file_bytes;
        root.size_counted = file_bytes;
        root.file_count = 1;
        root.dir_count = 2;
        let tree = TreeIndex::build(&ScanTree {
            top: Vec::new(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo {
                serial: 1,
                label: "t".into(),
                total_bytes: 1u64 << 62,
                free_bytes: 0,
            },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            mode: ScanMode::Walk,
            mft: None,
            elapsed_ms: 0,
        });
        let mut counters = Counters::default();
        counters.files = 9;
        counters.ext_count = ext_count;
        counters.ext_bytes = ext_bytes;
        Arc::new(Session {
            id: "s1".into(),
            root: userprofile,
            control: ScanControl::new(),
        report_cache: Mutex::new(None),
        deleted_paths: Mutex::new(std::collections::BTreeSet::new()),
            state: Mutex::new(SessionState {
                status: Status::Completed,
                counters,
                current_path: String::new(),
                started_at_ms: None,
                finished_at_ms: None,
                tree: Some(std::sync::Arc::new(tree)),
                error: None,
                unaccounted: 0,
                scan_mode: "walk",
                view_excluded: Default::default(),
            }),
        })
    }

    fn state_of(s: &Arc<Session>) -> AppState {
        let st = AppState::default();
        st.sessions.lock().unwrap().insert("s1".into(), s.clone());
        st
    }

    fn docker_unmeasurable() -> DockerDiskUsage {
        DockerDiskUsage {
            verdict: DockerVerdict::Unmeasurable,
            reclaimable_bytes: None,
            categories: Vec::new(),
            detail: "测试夹具：这一次没量到".to_string(),
        }
    }

    fn preview_of(state: &AppState) -> PreviewPayloadWire {
        build_preview(
            state,
            "s1",
            json!({ "items": [] }),
            None,
            None,
            None,
        )
        .expect("这条链不该报错")
        .expect("有树就该有预估")
    }

    #[test]
    fn bytes_travel_from_the_preview_to_the_row_and_not_into_a_second_caliber() {
        // 这一格**不重新走盘**：行上的数字必须逐字等于预估项的 `finding_bytes`（全量口径，
        // 与勾没勾无关）。壳层另算一遍就是第二个口径 —— 那正是本项目一路在躲的形状。
        let session = session_with_maven_tree(4096, 0, 0);
        let state = state_of(&session);
        let payload = preview_of(&state);
        let item = payload
            .preview
            .items
            .iter()
            .find(|i| i.rule_id == "maven-repository")
            .expect("报告里该有 maven 那一条");
        assert!(item.finding_bytes > 0, "夹具没把这一条喂出字节，下面那句相等就是空转");

        let mut install = BTreeMap::new();
        install.insert("maven".to_string(), true);
        let view = assemble_dev_env_view(
            &state,
            Some("s1"),
            install,
            Some(docker_unmeasurable()),
        );
        let row = view
            .groups
            .iter()
            .flat_map(|g| g.rows.iter())
            .find(|r| r.rule_id == "maven-repository")
            .expect("maven 那一行该在页上");
        assert_eq!(row.install_state, InstallState::Installed);
        assert_eq!(row.display_bytes, Some(item.finding_bytes), "数字在运输途中变了");
        assert_eq!(row.display_files, Some(item.finding_files));
        assert_eq!(view.scanned_root.as_deref(), Some(session.root.as_str()), "要点名是哪棵树量的");
    }

    #[test]
    fn the_model_tally_lands_on_the_group_not_on_a_single_rule_row() {
        // 「这棵树上躺着几个权重」问的是整棵树。把它接到 `huggingface-cache` 那一行，
        // 等于让一条只管 `.cache\huggingface` 的规则替整棵树报数。
        let session = session_with_maven_tree(4096, 7, 1_234_567);
        let state = state_of(&session);
        let view = assemble_dev_env_view(
            &state,
            Some("s1"),
            BTreeMap::new(),
            Some(docker_unmeasurable()),
        );
        let tallied: Vec<&ModelTally> = view
            .groups
            .iter()
            .filter_map(|g| g.model_files.as_ref().and_then(|c| c.as_ref()))
            .collect();
        assert_eq!(tallied.len(), 1, "计数只该落在一个分组上，多了就是挂错地方");
        let t = tallied[0];
        assert_eq!((t.count, t.bytes), (7, 1_234_567), "扫描途中那两个数没原样带过来");
        assert_eq!(t.files_seen, 9, "分母是这棵树见过的全部条数");
        assert_eq!(t.root_path, session.root);
        assert_eq!(t.scan_status, ScanStatus::Completed);
        assert!(!t.truncated);
    }

    #[test]
    fn no_session_answers_nothing_rather_than_a_row_of_zeros() {
        // `scanId` 为 None 或那趟扫描不在了 → 字节格全 None、计数格全 None，界面念「还没扫过」。
        // 回一排 0 在这里是**假的测量结果**：0 会被读成「这台机器上没有缓存」。
        for (label, id) in [("scan_id 为 None", None), ("那趟扫描不在了", Some("gone"))] {
            let state = AppState::default();
            let view = assemble_dev_env_view(
                &state,
                id,
                BTreeMap::new(),
                Some(docker_unmeasurable()),
            );
            assert!(view.scanned_root.is_none(), "{label}：不该有名下来的树");
            for g in &view.groups {
                assert!(
                    matches!(g.model_files, None | Some(None)),
                    "{label}：分组 {:?} 的模型计数本该是「没扫过」，实际 {:?}",
                    g.id,
                    g.model_files
                );
            }
            for r in view.groups.iter().flat_map(|g| g.rows.iter()) {
                assert!(r.display_bytes.is_none(), "{label}：{} 行端出了数字", r.rule_id);
                assert!(r.display_files.is_none(), "{label}：{} 行端出了条数", r.rule_id);
            }
        }
    }

    #[test]
    fn the_status_map_carries_five_literals_and_invents_no_idle() {
        // 六个字面量逐字同 TS；`idle` 那一档**不住在这里**（走到这一步必然有一个 session，
        // 而 session 一出生就是 running）。在这里补一个假 Idle 会让「没扫过」与「扫完了」共用一句话。
        assert_eq!(ScanStatus::from(Status::Running), ScanStatus::Running);
        assert_eq!(ScanStatus::from(Status::Paused), ScanStatus::Paused);
        assert_eq!(ScanStatus::from(Status::Completed), ScanStatus::Completed);
        assert_eq!(ScanStatus::from(Status::Cancelled), ScanStatus::Cancelled);
        assert_eq!(ScanStatus::from(Status::Failed), ScanStatus::Failed);
        assert_eq!(Status::Completed.wire(), "completed");
    }

    /// §3.6 报告缓存的两条红线（人类伙伴 2026-10-20：别每次打开都重算那 12 秒；
    /// 但清理之后必须作废）。
    ///
    /// ① **同一次扫描内复用**：第二次 `assemble_dev_env_view` 必须走缓存。
    ///    证法不是"看起来快了"，而是**往缓存里塞一份假数据**，看页面是否原样把它念出来 ——
    ///    原样念出来才证明它真的读了缓存，而不是又算了一遍（又算一遍会得到真数字，
    ///    假数据就被覆盖掉，断言当场红）。
    /// ② **清理后作废**：塞进去的假数据在 `execute_plan` 之后必须消失。
    ///    留着它用户会看到已经删掉的占用 —— 那比慢 12 秒坏得多。
    #[test]
    fn the_report_cache_is_reused_within_a_scan_and_dropped_after_a_cleanup() {
        // **先把全局槽清空**：`dev_env_report_slot()` 是进程级共享状态，同批里先跑的
        // 用例（`bytes_travel_from_the_preview_to_the_row...`）会往里写一份真报告。
        // 不先清空，我这份假数据可能被那份真报告顶掉，于是断言读到 4096（真数字）而不是
        // 424242（假数据）—— 那种失败说的是"测试顺序"，不是"缓存没接上"。
        *dev_env_report_slot().lock().unwrap() = None;

        // ① 假数据进缓存（键 = 这一次会话的 scan_id）
        let fake = DevEnvReportCache {
            bytes_by_rule: [(
                "maven-repository".to_string(),
                RuleOccupancy { bytes: 424_242, files: 7 },
            )]
            .into_iter()
            .collect(),
            territories: Vec::new(),
        };
        *dev_env_report_slot().lock().unwrap() = Some(("s1".to_string(), fake));

        let session = session_with_maven_tree(4096, 0, 0);
        let state = state_of(&session);
        // 探测器必须说 maven「已安装」：`build_dev_env_view` 刻意只在
        // `detected == Some(true)` 时才把字节放进行里（`view.rs:346`）——
        // 没问过装没装的一律给 None，免得 0 被读成"这工具没缓存"。
        // 传空表会让这一格恒为 None，那条断言就证不到缓存本身上去。
        let mut install = std::collections::BTreeMap::new();
        install.insert("maven".to_string(), true);
        let view = assemble_dev_env_view(&state, Some("s1"), install, Some(docker_unmeasurable()));
        let row = view
            .groups
            .iter()
            .flat_map(|g| g.rows.iter())
            .find(|r| r.rule_id == "maven-repository")
            .expect("maven 那一行该在页上");
        assert_eq!(
            row.display_bytes,
            Some(424_242),
            "第二次进页面没读缓存 —— 又把那 12 秒算了一遍（假数据被真报告覆盖了）"
        );
        assert_eq!(row.display_files, Some(7), "缓存里的条数也没原样带出来");

        // ② 清理之后作废。**不真的删文件**：只要 `execute_plan` 走到清缓存那一步就够，
        // 所以给一个空 plan（没有路径 ⇒ 什么都不删，但链照跑完）。
        let plan = ConfirmedPlan {
            digest: "cache-guard".to_string(),
            scan_id: session.id.clone(),
            batches: vec![CleanBatch { root: session.root.clone(), paths: Vec::new() }],
            attribution: std::collections::HashMap::new(),
        };
        let _ = execute_plan(&plan, &state, None, "cache-guard-task", true);
        assert!(
            dev_env_report_slot().lock().unwrap().is_none(),
            "清理之后缓存还在 —— 用户会看到已经删掉的占用"
        );

        // 收尾也清一次：这条用例动的是进程级共享状态，留一个 None 在里面
        // 比留一份夹具数据干净（后面用例要走"现算"分支时不该被缓存喂到旧数字）。
        *dev_env_report_slot().lock().unwrap() = None;
    }
}

#[cfg(test)]
mod exclusion_tests {
    //! §7 视图排除的三条红线（M5-E③）。最要紧的是最后一条：**排除不许漏进计价路径** ——
    //! 那族错的名字叫「把目录从地图上藏起来、清理预估照旧删它的文件」。

    use super::*;
    use deepclean_scanner::model::{Counters, ScanFile, ScanMode, ScanNode, ScanTree};
    use deepclean_scanner::tree_index::ROOT_DIR_ID;
    use deepclean_scanner::volume::VolumeInfo;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    /// 树根钉在真 `%TEMP%`（`windows-temp` 那条规则要它正好是根），根下两个子目录：
    /// `in/` 里放一个会被计价的 `.tmp`，`out/` 是空的。
    fn session() -> Arc<Session> {
        let temp = std::env::var("TEMP").expect("本机必须有 TEMP");
        let mut inside = ScanNode::dir("in".into(), format!(r"{temp}\in"));
        inside.files.push(ScanFile {
            name: "dc-m5e.tmp".into(),
            size: 4096,
            alloc: 4096,
            counted: 4096,
            file_id: 7,
            mtime_ms: 0,
            creation_ms: 0,
            attrs: 0,
        });
        inside.size_counted = 4096;
        inside.file_count = 1;
        let outside = ScanNode::dir("out".into(), format!(r"{temp}\out"));
        let mut root = ScanNode::dir("Temp".into(), temp);
        root.children.push(inside);
        root.children.push(outside);
        root.dir_count = 2;
        root.file_count = 1;
        root.size_counted = 4096;
        let mut counters = Counters::default();
        counters.files = 1;
        counters.dirs = 2;
        counters.bytes_counted = 4096;
        counters.bytes_logical = 4096;
        counters.bytes_alloc = 4096;
        let tree = TreeIndex::build(&ScanTree {
            top: Vec::new(),
            root,
            counters,
            volume: VolumeInfo {
                serial: 1,
                label: "t".into(),
                total_bytes: 1u64 << 62,
                free_bytes: 0,
            },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            mode: ScanMode::Walk,
            mft: None,
            elapsed_ms: 0,
        });
        Arc::new(Session {
            id: "s1".into(),
            root: "t".into(),
            control: ScanControl::new(),
        report_cache: Mutex::new(None),
        deleted_paths: Mutex::new(std::collections::BTreeSet::new()),
            state: Mutex::new(SessionState {
                status: Status::Completed,
                counters,
                current_path: String::new(),
                started_at_ms: None,
                finished_at_ms: None,
                tree: Some(std::sync::Arc::new(tree)),
                error: None,
                unaccounted: 0,
                scan_mode: "walk",
                view_excluded: Default::default(),
            }),
        })
    }

    fn state() -> AppState {
        let st = AppState::default();
        st.sessions.lock().unwrap().insert("s1".into(), session());
        st
    }

    /// 根下 `in` 那一格的 dirId（不是 -1、不是根）。
    fn child_dir_ids(state: &AppState) -> (i64, i64) {
        let s = state.sessions.lock().unwrap().get("s1").unwrap().clone();
        let st = s.state.lock().unwrap();
        let root = st.tree.as_ref().unwrap().dir(ROOT_DIR_ID).unwrap();
        (root.child_dirs[0], root.child_dirs[1])
    }

    #[test]
    fn the_refusals_are_said_out_loud() {
        let state = state();
        let (a, _) = child_dir_ids(&state);
        // 扫描根结构性地拒掉：排除根 = 给用户一张空图（这一轮再也没有任何一层可看）
        assert!(!set_excluded(&state, "s1", ROOT_DIR_ID, true), "根不许被排除");
        // id 不在这棵树上
        assert!(!set_excluded(&state, "s1", 9_999, true), "树上的查不到就该拒");
        // 会话没了
        assert!(!set_excluded(&state, "gone", a, true), "会话不在就该拒");
        assert!(!clear_exclusions(&state, "gone"));
        // 而正常那一条必须是 true（否则上面三个 false 只是"全都 false"的假绿灯）
        assert!(set_excluded(&state, "s1", a, true), "正常目录该被接受");
    }

    #[test]
    fn hiding_a_dir_changes_the_map_layer_and_clearing_puts_it_back() {
        let state = state();
        let (a, _) = child_dir_ids(&state);
        let shown = |st: &AppState| {
            let s = st.sessions.lock().unwrap().get("s1").unwrap().clone();
            let g = s.state.lock().unwrap();
            let t = session_excluded_totals_of(&g);
            g.tree.as_ref().unwrap().payload(ROOT_DIR_ID, 0, "completed", &g.view_excluded, t, SizeBasis::Allocated).unwrap()
        };

        let before = shown(&state);
        assert_eq!(before.children.len(), 2);
        assert_eq!(before.excluded_count, 0);

        assert!(set_excluded(&state, "s1", a, true));
        let after = shown(&state);
        assert_eq!(after.children.len(), 1, "被排除的那一格该从这一层消失");
        assert_eq!(after.excluded_count, 1);
        assert!(after.excluded_bytes > 0, "藏掉的容量要点名，不是消失");
        assert_eq!(after.total_children, before.total_children, "总条数仍是完整口径那一份");
        // 父级容量**没被扣掉**：扣了就会与计数器、与三轴对账同时分叉
        assert_eq!(after.size, before.size);

        // 恢复（右键菜单里那句「恢复」走的是同一格 excluded=false）
        assert!(set_excluded(&state, "s1", a, false));
        assert_eq!(shown(&state).children.len(), 2);

        // 再排两个，然后一句「清除全部排除」
        assert!(set_excluded(&state, "s1", a, true));
        assert!(set_excluded(&state, "s1", child_dir_ids(&state).1, true));
        assert_eq!(shown(&state).children.len(), 0);
        assert!(clear_exclusions(&state, "s1"));
        assert_eq!(shown(&state).children.len(), 2, "清完该回到原样");
    }

    #[test]
    fn the_banner_reads_the_session_totals_not_just_this_layer() {
        // 真机抓出来的缺口：载荷里少了这两格，侧栏那句「已排除 N 个目录（本轮累计）」永远出不来，
        // 而本层那两份一切正常 —— 单测只看本层的话，这条缺口是隐形的。
        let state = state();
        let (a, b) = child_dir_ids(&state);
        let shown = |st: &AppState| {
            let s = st.sessions.lock().unwrap().get("s1").unwrap().clone();
            let g = s.state.lock().unwrap();
            let t = session_excluded_totals_of(&g);
            let p = g
                .tree
                .as_ref()
                .unwrap()
                .payload(ROOT_DIR_ID, 0, "completed", &g.view_excluded, t, SizeBasis::Allocated)
                .unwrap();
            (p.excluded_count, p.excluded_bytes, (p.session_excluded_count, p.session_excluded_bytes))
        };
        assert_eq!(shown(&state).2, (0, 0), "一个都没排就该是 (0,0)，不是缺字段");
        assert!(set_excluded(&state, "s1", a, true));
        let (per_layer, per_layer_bytes, session) = shown(&state);
        assert_eq!((per_layer, per_layer_bytes), (1, session.1));
        assert_eq!(session.0, 1);
        assert!(session.1 > 0, "被排除那一格的容量要点名进累计");
        // 排到**另一层**去：本层那一份是 0，累计那一份仍然带着它（横幅不许随层级消失）
        assert!(set_excluded(&state, "s1", b, true));
        assert_eq!(session_excluded_totals_of(&state.sessions.lock().unwrap().get("s1").unwrap().state.lock().unwrap()).0, 2);
        let deep = {
            let s = state.sessions.lock().unwrap().get("s1").unwrap().clone();
            let g = s.state.lock().unwrap();
            let kid = g.tree.as_ref().unwrap().dir(ROOT_DIR_ID).unwrap().child_dirs[0];
            let t = session_excluded_totals_of(&g);
            let p = g
                .tree
                .as_ref()
                .unwrap()
                .payload(kid, 0, "completed", &g.view_excluded, t, SizeBasis::Allocated)
                .unwrap();
            (p.excluded_count, p.session_excluded_count)
        };
        assert_eq!(deep.0, 0, "钻进子层不该在本层看到排除");
        assert_eq!(deep.1, 2, "但本轮累计那一份必须还在这一层的载荷里");
    }

    #[test]
    fn the_exclusion_never_reaches_the_pricing_caliber() {
        // 这条是本文件存在的理由。把装着 `.tmp` 的那个目录从地图上藏起来之后，
        // 清理预估**必须照旧**把它算进去 —— 否则就是「藏起来的那块照样会被删」。
        let state = state();
        let (a, _) = child_dir_ids(&state);
        let preview = |st: &AppState| {
            build_preview(
                st,
                "s1",
                // 真勾选一条才有合计：空勾选时 `total_bytes` 本来就该是 0，拿它当"夹具喂出了东西"
                // 的判据是写错的形状（本棒第一次就错在这）。
                json!({ "items": [{ "ruleId": "windows-temp" }] }),
                None,
                None,
                None,
            )
            .unwrap()
            .expect("有树就该有预估")
        };
        let before = preview(&state);
        assert!(before.preview.total_bytes > 0, "夹具没喂出可回收字节，下面那句相等是空转");

        assert!(set_excluded(&state, "s1", a, true));
        let after = preview(&state);
        assert_eq!(
            after.preview.total_bytes, before.preview.total_bytes,
            "视图排除漏进计价口径了 —— 那正是隐藏式误删的形状"
        );
        assert_eq!(after.preview.items.len(), before.preview.items.len());
    }
}

#[cfg(test)]
mod auto_clean_tests {
    //! M6 免确认清理档的两道选区闸（[`super::app_is_running`] / [`super::auto_clean_selection`]）
    //! 的子单元测试 —— 用构造的 finding 跑，不起真进程、不碰真盘。

    use super::*;
    use deepclean_rules::engine::{PathHit, RuleFinding};

    /// 三根都指到 D 盘沙箱（项目纪律：测试绝不写 C:），且不带 `DC_ENV_ROOT` ——
    /// 这把判据测的是 app_is_running 自己的键提取，不是领地重定向。
    fn env_roots() -> RuleEnv {
        let map: HashMap<String, String> = [
            ("LOCALAPPDATA", r"D:\u\local"),
            ("APPDATA", r"D:\u\roam"),
            ("PROGRAMDATA", r"D:\pdata"),
        ]
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect();
        rule_env_from(|k| map.get(k).cloned())
    }

    /// 造一个「在跑进程」的段集合：与 [`super::running_process_segments`] 同一形状
    /// （按 `\` `/` 拆段、小写），但原料由测试给，不采真机镜像。
    fn running_of(process_images: &[&str]) -> std::collections::BTreeSet<String> {
        let mut out = std::collections::BTreeSet::new();
        for img in process_images {
            for seg in img.split(['\\', '/']) {
                let seg = seg.trim();
                if !seg.is_empty() {
                    out.insert(seg.to_lowercase());
                }
            }
        }
        out
    }

    fn hit(path: &str, size: u64) -> PathHit {
        PathHit { path: path.to_string(), size }
    }

    fn finding(rule_id: &str, total: u64, sample: Vec<PathHit>, all: Option<Vec<PathHit>>) -> RuleFinding {
        RuleFinding {
            rule_id: rule_id.to_string(),
            name: rule_id.to_string(),
            category: deepclean_rules::types::RuleCategory::AppTransient,
            risk_level: Risk::Caution,
            clean_strategy: deepclean_rules::types::CleanStrategy::DeleteAll,
            recoverable: true,
            matched_roots: vec![],
            sample_paths: sample,
            sample_truncated: false,
            file_count: 1,
            total_bytes: total,
            all_paths: all,
        }
    }

    fn empty_report(findings: Vec<RuleFinding>) -> RuleReport {
        RuleReport {
            findings,
            exclusions: vec![],
            rejected_rules: vec![],
            forbidden_roots: vec![],
            report_only_roots: vec![],
            territories: vec![],
            bytes_by_risk: Default::default(),
            reclaimable_bytes: 0,
            safety_blocked: false,
            claimed_paths: None,
        }
    }

    /// 应用键 = 三根之下第一段；撞在跑进程段 ⇒ 在跑（不删）；
    /// 路径不在三根之下 ⇒ 取不出键 ⇒ **当作在跑**（fail-safe：宁少删）。
    #[test]
    fn the_cache_gate_judges_by_the_first_segment_under_the_three_roots() {
        let env = env_roots();
        let running = running_of(&[r"D:\tools\Code\Code.exe"]);

        // 首段 "code" 撞上在跑进程的目录段 → 在跑
        assert!(app_is_running(r"D:\u\local\Code\Cache", &env, &running));
        // 大小写与正反斜杠都被 normalize_key 抹平（真机路径两种写法都会出现）
        assert!(app_is_running(r"D:/U/LOCAL/Code/cache", &env, &running));
        // 首段不在段集合里 → 不在跑（这条这次可以删）
        assert!(!app_is_running(r"D:\u\local\OtherApp\Cache", &env, &running));
        // 三个根都试：PROGRAMDATA 之下同样判
        assert!(!app_is_running(r"D:\pdata\SharedTool\Cache", &env, &running));
        // 不在任何一根之下 → 键取不出来 → **当作在跑**
        assert!(app_is_running(r"D:\elsewhere\GhostApp\Cache", &env, &running));
        // 进程镜像里带 ".exe" 的段不该误伤同名目录：段集合里是 "code.exe" 与 "code" 两个段，
        // 而应用键是首段 "code" —— 判据查的是目录段，这正是上面第一条存在的原因。
    }

    /// 进程闸逐路径过滤 `app-cache-data`：`all_paths` 在时用它（全量），不在时退回 sample。
    #[test]
    fn the_cache_gate_filters_paths_one_by_one_and_falls_back_to_samples() {
        let env = env_roots();
        // 进程镜像要带目录段：段集合是按 `\` 拆的（{d:, tools, code, code.exe}），
        // 只写 "Code.exe" 的话集合里没有 "code"，闸就永远拦不住 —— 那测的是空转。
        let running = running_of(&[r"D:\tools\Code\Code.exe"]);

        let keep = hit(r"D:\u\local\OtherApp\Cache\a", 10);
        let drop = hit(r"D:\u\local\Code\Cache\b", 20);
        let f = finding(
            "app-cache-data",
            30,
            vec![keep.clone(), drop.clone()],
            Some(vec![keep.clone(), drop.clone(), hit(r"D:\u\roam\Code\junk", 5)]),
        );
        assert_eq!(
            auto_clean_app_cache_paths(&f, &env, &running),
            vec![keep.path.clone()],
            "all_paths 里的在跑路径被滤掉，其余保留"
        );

        // 没挂 all_paths（collect_all_paths 没点名的那批规则）→ 退回 sample_paths，
        // 不会因为清单缺失就整条放弃或整条放行
        let f2 = finding("app-cache-data", 30, vec![keep.clone(), drop], None);
        assert_eq!(auto_clean_app_cache_paths(&f2, &env, &running), vec![keep.path]);
    }

    /// 选区只认免确认名单；0 字节不进；app-cache-data 逐路径过闸，全被滤掉就整条不出现。
    #[test]
    fn the_selection_takes_only_the_named_list_and_skips_zero_byte_findings() {
        let env = env_roots();
        let running = running_of(&[r"D:\tools\Code\Code.exe"]);

        let report = empty_report(vec![
            finding("windows-temp", 100, vec![hit(r"D:\u\local\Temp\a", 100)], None),
            // 不在名单里（🔴 也好、不在 AUTO_CLEAN_RULE_IDS 的普通条也好）——都不进
            finding("recycle-bin", 500, vec![hit(r"D:\$RECYCLE.BIN\x", 500)], None),
            finding("dev-tool-cache", 60, vec![hit(r"D:\u\local\.cache\x", 60)], None),
            // 0 字节：删它没有任何收益，却要占一条执行项
            finding("thumbnail-cache", 0, vec![], None),
            // app-cache-data：两条路径一留一滤
            finding(
                "app-cache-data",
                10,
                vec![hit(r"D:\u\local\OtherApp\Cache\a", 10)],
                Some(vec![hit(r"D:\u\local\OtherApp\Cache\a", 10), hit(r"D:\u\local\Code\Cache\b", 0)]),
            ),
        ]);
        let got = auto_clean_selection(&report, &env, &running);
        let ids: Vec<&str> = got.iter().filter_map(|v| v["ruleId"].as_str()).collect();
        assert_eq!(ids, vec!["windows-temp", "app-cache-data"], "名单之外与 0 字节全不进：{got:?}");

        let cache = got.iter().find(|v| v["ruleId"] == "app-cache-data").unwrap();
        let paths: Vec<&str> = cache["paths"].as_array().unwrap().iter().filter_map(|p| p.as_str()).collect();
        assert_eq!(paths, vec![r"D:\u\local\OtherApp\Cache\a"], "进程闸只滤路径，不弃整条");

        // 整条 app-cache-data 全被进程闸滤掉 ⇒ 这条规则**整条**不进选区
        // （只剩在跑应用的缓存时，选区为空不是失败，是「这次没得删」）
        let only_running = empty_report(vec![finding(
            "app-cache-data",
            10,
            vec![],
            Some(vec![hit(r"D:\u\local\Code\Cache\b", 10)]),
        )]);
        assert!(
            auto_clean_selection(&only_running, &env, &running).is_empty(),
            "全滤光 → 空选区，run_auto_clean 会以 E_AUTO_CLEAN_NOTHING 收场"
        );
    }
}

#[cfg(test)]
mod license_tests {
    use super::*;
    // 这三条只在测试里**造失败输入**，生产代码不认得它们（wire 只把 `Display` 抄进错误串）。
    use deepclean_license::{KeyStoreError, LicenseFileError, TableError};
    use std::collections::BTreeSet;

    /// 取一个 JSON 对象的键集合（判据只认"闭合键集"，见下面那条测试的理由）。
    fn keys(v: &serde_json::Value) -> BTreeSet<String> {
        v.as_object()
            .expect("wire 必须是对象")
            .keys()
            .cloned()
            .collect()
    }

    const DOC_KEYS: [&str; 5] = ["state", "activatedAtMs", "deviceId", "problem", "problemReason"];

    /// **界面上「有效 / 无效 / 没激活过」是同一个可见结论，三个 wire 必须同键集。**
    ///
    /// 为什么钉键集而不是钉值：值那半边下面几条测试各自钉着，而**多一个字段**才是这条链
    /// 唯一的漏法 —— 授权 wire 一旦被顺手加上「私钥种子」「清单原文」「码本身」这类字段，
    /// 它就顺着 IPC 到了渲染进程，而渲染进程是能读 DOM、能写日志、能被扩展看的地方。
    /// 闭合键集 = 想加新字段必须同时改这条判据，改的人就看得见它在跨哪条线。
    #[test]
    fn the_status_wire_field_set_is_closed() {
        let want: BTreeSet<String> = DOC_KEYS.iter().map(|s| s.to_string()).collect();
        for s in all_statuses() {
            assert_eq!(keys(&status_wire(&s)), want, "{s:?}");
        }
    }

    /// **失败关闭在 wire 这一层也要成立**：crate 里 `Invalid` 是「有文件但不可信」，
    /// 而界面拿的是字符串。把 `Invalid` 映射成 `"licensed"`（或漏掉 `activatedAtMs` 置空）
    /// 是一条只在真机上才看得出来、且方向是**放行**的错。
    #[test]
    fn an_untrusted_license_never_reads_as_licensed() {
        for (s, label) in all_invalid() {
            let w = status_wire(&s);
            assert_eq!(w["state"], "invalid", "{label} 不许读成别的状态");
            assert_eq!(w["activatedAtMs"], serde_json::Value::Null, "{label} 不可信的记录不许带时间戳");
            assert_eq!(w["deviceId"], serde_json::Value::Null, "{label}");
            assert!(
                w["problem"].as_str().map(|s| !s.is_empty()).unwrap_or(false),
                "{label} 必须有具名原因，否则界面只能说「不对」而说不出哪里不对"
            );
        }
    }

    /// 六条具名原因必须**互不相同**：两条并成一句（比如 `NoDeviceKey` 与 `LicenseUnreadable`
    /// 都写成「文件读不了」），运维就分不开「没私钥」与「文件坏了」这两件完全不同的事。
    #[test]
    fn each_status_problem_names_a_distinct_readable_reason() {
        let mut seen = BTreeSet::new();
        for (s, label) in all_invalid() {
            let w = status_wire(&s);
            let code = w["problem"].as_str().unwrap();
            let reason = w["problemReason"].as_str().unwrap();
            assert!(reason.chars().count() >= 6, "{label} 的中文原因太短，说不清：{reason}");
            assert!(seen.insert(code.to_string()), "具名原因重号：{code}");
        }
        assert_eq!(seen.len(), 6);
    }

    /// 没有 `license.dat` = **没激活过**（`unlicensed`），不是「文件坏了」（`invalid`）。
    /// 两者混起来会把首次使用说成授权损坏，而这是用户第一眼看到的那句话。
    #[test]
    fn a_missing_license_reads_as_unlicensed_not_invalid() {
        let w = status_wire(&LicenseStatus::Unlicensed);
        assert_eq!(w["state"], "unlicensed");
        assert_eq!(w["problem"], serde_json::Value::Null);
        assert_eq!(w["activatedAtMs"], serde_json::Value::Null);
    }

    /// 有效那一条必须带上时间戳与设备公钥（界面上「绑定到哪台机器」要念得出）。
    #[test]
    fn a_valid_license_carries_the_timestamp_and_device_id() {
        let w = status_wire(&LicenseStatus::Licensed { activated_at_ms: 1_700_000_000_000, device_id: "ab".into() });
        assert_eq!(w["state"], "licensed");
        assert_eq!(w["activatedAtMs"], 1_700_000_000_000u64);
        assert_eq!(w["deviceId"], "ab");
        assert_eq!(w["problem"], serde_json::Value::Null);
    }

    /// 「这次激活了」与「本来就在这台机器上、幂等没重写」是两句不同的话 —— 规格验收行里
    /// 「重复激活不产生第二份」全靠这个区分，并成一个布尔就看不见了。
    #[test]
    fn the_activate_wire_distinguishes_a_fresh_activation_from_a_repeat() {
        let fresh = activation_wire(&ActivationOutcome::Activated { activated_at_ms: 11, device_id: "d1".into() });
        let again = activation_wire(&ActivationOutcome::AlreadyActive { activated_at_ms: 9, device_id: "d2".into() });
        assert_eq!(fresh["activation"], "activated");
        assert_eq!(again["activation"], "already-active");
        assert_eq!(fresh["activatedAtMs"], 11u64);
        assert_eq!(again["activatedAtMs"], 9u64, "幂等这条要报的是**原来那次**的时间，不是这一次");
        assert_eq!(keys(&fresh), keys(&again));
        let want: BTreeSet<String> = ["activation", "activatedAtMs", "deviceId"].iter().map(|s| s.to_string()).collect();
        assert_eq!(keys(&fresh), want);
    }

    /// 四条失败各给一个**稳定的 `E_` 码**。缺表与错码必须分家：把「清单没交付」报成
    /// 「激活码无效」，用户会对着抄了三遍的码怀疑自己手抖，而真因是这一台机器上根本没有清单。
    #[test]
    fn every_activation_failure_has_its_own_stable_code() {
        let cases = [
            (
                ActivationError::Table(TableError::Io {
                    path: "D:\\nope\\codes.sha256".into(),
                    message: "系统找不到指定的文件。".into(),
                }),
                "E_LICENSE_TABLE",
            ),
            (ActivationError::InvalidCode, "E_LICENSE_INVALID_CODE"),
            (
                ActivationError::DeviceKey(KeyStoreError::Io {
                    path: "D:\\nope\\device.key".into(),
                    message: "x".into(),
                }),
                "E_LICENSE_DEVICE_KEY",
            ),
            (
                ActivationError::LicenseFile(LicenseFileError::Io {
                    path: "D:\\nope\\license.dat".into(),
                    message: "x".into(),
                }),
                "E_LICENSE_FILE_WRITE",
            ),
        ];
        let mut seen = BTreeSet::new();
        for (e, want) in cases {
            let msg = activation_error_string(&e);
            assert!(msg.starts_with(want), "{want} 没出现在串首：{msg}");
            assert!(msg.len() > want.len() + 4, "只有码没有话：{msg}");
            assert!(seen.insert(want), "错误码重号：{want}");
        }
        assert_eq!(seen.len(), 4);
    }

    /// 三份文件的落点：一份清单 + 两份运行期状态，**同一个目录**（清单要与状态同处一处，
    /// 交付/更新才有唯一的一条路可走）。文件名在这条钉死，写进文档的命令才对得上。
    #[test]
    fn the_three_license_files_live_under_one_directory() {
        let p = license_paths_in(Path::new("D:/some/dir"));
        assert_eq!(p.table_path, PathBuf::from("D:/some/dir").join("codes.sha256"));
        assert_eq!(p.device_key_path, PathBuf::from("D:/some/dir").join("device.key"));
        assert_eq!(p.license_path, PathBuf::from("D:/some/dir").join("license.dat"));
    }

    /// dev-only 的整目录覆盖：给就用它，不给就用应用数据目录下的 `license`。
    ///
    /// 这条存在的理由不是方便：那 1000 个真码**不在仓库**（M4 验收 §3.1），所以真机上
    /// 「点一次激活」在今天必然失败关闭。留一个只在 `debug_assertions` 里编译进去的覆盖口，
    /// 才能让开发构建指向夹具清单跑通整条链 —— 而打包版拿不到它。
    #[test]
    fn the_dev_override_moves_the_whole_license_dir() {
        let app_data = PathBuf::from("C:/Users/K/AppData/Roaming/com.deepclean.app");
        assert_eq!(license_dir(Some("D:/dc-license-dev".into()), app_data.clone()), PathBuf::from("D:/dc-license-dev"));
        assert_eq!(license_dir(None, app_data.clone()), app_data.join("license"));
        assert_eq!(license_dir(Some("   ".into()), app_data.clone()), app_data.join("license"), "空串不许当成有效覆盖");
    }

    fn all_statuses() -> Vec<LicenseStatus> {
        vec![
            LicenseStatus::Unlicensed,
            LicenseStatus::Licensed { activated_at_ms: 1, device_id: "aa".into() },
            LicenseStatus::Invalid { problem: StatusProblem::NoDeviceKey },
            LicenseStatus::Invalid { problem: StatusProblem::LicenseUnreadable },
            LicenseStatus::Invalid { problem: StatusProblem::DeviceMismatch },
            LicenseStatus::Invalid { problem: StatusProblem::BadSignature },
            LicenseStatus::Invalid { problem: StatusProblem::CodeNotInTable },
            LicenseStatus::Invalid { problem: StatusProblem::TableUnavailable },
        ]
    }

    /// 六个 `Invalid` 原因，各配一个**测试自己给的标签**。
    ///
    /// 为什么不直接用 `{p:?}` 当消息：`StatusProblem` 没有 `Copy`，移进枚举之后原变量就没了，
    /// 于是「哪一条红的」这个信息会在编译期先丢掉。标签不参与判定，只负责让失败可读。
    fn all_invalid() -> Vec<(LicenseStatus, &'static str)> {
        [
            (StatusProblem::NoDeviceKey, "no-device-key"),
            (StatusProblem::LicenseUnreadable, "license-unreadable"),
            (StatusProblem::DeviceMismatch, "device-mismatch"),
            (StatusProblem::BadSignature, "bad-signature"),
            (StatusProblem::CodeNotInTable, "code-not-in-table"),
            (StatusProblem::TableUnavailable, "table-unavailable"),
        ]
        .into_iter()
        .map(|(p, label)| (LicenseStatus::Invalid { problem: p }, label))
        .collect()
    }

    /* ---------- 下面这批碰真文件系统（含真 DPAPI），但一律落在 %TEMP% 的独立目录 ---------- */

    /// 一个**夹具**激活码（`DC-FIX-0001`）。这是 `codes.fixture.txt` 里的假码，
    /// **不是那 1000 个真码**（真码不在仓库，M4 验收 §3.1）。
    const FIXTURE_CODE: &str = "DC-FIX-0001";
    const FIXTURE_CODE_B: &str = "DC-FIX-0003";
    /// 表内没有的近失码（夹具交叉对账那条测试也用它证明比对不是恒真）。
    const WRONG_CODE: &str = "DC-FIX-9999";

    static SEQ: AtomicU64 = AtomicU64::new(0);

    /// 独立临时目录。**进程号 + 计数器**两个都要：同一二进制里的用例是并行跑的，
    /// 只拿 `process::id()` 会让两条用例互删对方的夹具（M3-A 栽过一次：单跑绿、workspace 红）。
    fn temp_root(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("deepclean-m4-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    /// 造一份「清单在位」的授权目录：把**夹具清单**逐字写进去（它就是 `gen-license-codes.mjs`
    /// 从 `codes.fixture.txt` 生成的那一份，与 crate 的交叉对账测试同源）。
    fn dir_with_table(tag: &str) -> (PathBuf, LicensePaths) {
        let dir = temp_root(tag);
        let paths = license_paths_in(&dir);
        std::fs::write(
            &paths.table_path,
            include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/crates/license/tests/data/codes.sha256")),
        )
        .expect("写夹具清单");
        (dir, paths)
    }

    /// **缺表必须报成「清单不可用」，不许报成「激活码无效」**。
    /// 后半条判据是顺序：crate 先查表再生成密钥，所以这里两份文件都不该存在 ——
    /// 一旦有人把顺序倒了，一台没拿到清单的机器上会留下一把孤零零的设备私钥。
    #[test]
    fn a_missing_table_is_refused_as_a_table_problem_not_a_bad_code() {
        let dir = temp_root("notable");
        let paths = license_paths_in(&dir);
        let err = run_license_activate_at(&paths, FIXTURE_CODE).unwrap_err();
        assert!(err.starts_with("E_LICENSE_TABLE"), "缺表报错了码：{err}");
        assert!(err.contains("codes.sha256"), "缺表这条必须点名是哪个文件读不动：{err}");
        assert!(!paths.device_key_path.exists(), "清单都不可用就不许先生成本机设备密钥");
        assert!(!paths.license_path.exists(), "清单都不可用就不许先落激活记录");
        assert!(std::fs::remove_dir_all(&dir).is_ok());
    }

    /// 表内的码才配往下走；错码不留任何痕迹。
    #[test]
    fn a_code_that_is_not_in_the_table_is_refused() {
        let (dir, paths) = dir_with_table("badcode");
        let err = run_license_activate_at(&paths, WRONG_CODE).unwrap_err();
        assert!(err.starts_with("E_LICENSE_INVALID_CODE"), "错码这条的码不对：{err}");
        assert!(!paths.license_path.exists(), "错码不许留下激活记录");
        assert!(std::fs::remove_dir_all(&dir).is_ok());
    }

    /// **整条链真的通**：夹具码 → 真 DPAPI 写 `device.key` → 真 `license.dat` →
    /// 回读状态是 `licensed` 且带得出设备公钥。这一条不是 mock，是本机上跑出来的。
    #[test]
    fn a_real_activation_round_trips_through_the_wire_as_licensed() {
        let (dir, paths) = dir_with_table("roundtrip");
        let w = run_license_activate_at(&paths, FIXTURE_CODE).expect("夹具码应当激活成功");
        assert_eq!(w["activation"], "activated");
        assert!(paths.device_key_path.exists(), "私钥必须落到 DPAPI 保护的那份文件");
        let s = read_license_status_at(&paths);
        assert_eq!(s["state"], "licensed", "{s}");
        assert!(!s["deviceId"].as_str().unwrap().is_empty(), "得念得出绑到哪台机器");
        let ts = s["activatedAtMs"].as_u64().expect("时间戳必须是整数");
        let now = now_unix_ms();
        assert!(ts > 0 && ts <= now && now - ts < 60_000, "时间戳不在刚才这一分钟内：{ts} vs {now}");
        assert!(std::fs::remove_dir_all(&dir).is_ok());
    }

    /// 「同一机重复不产生第二份」在 **IO 层**的形态：文件一字未动，报的还是原来那次的时间。
    #[test]
    fn activating_the_same_code_twice_writes_one_record_and_says_already_active() {
        let (dir, paths) = dir_with_table("idem");
        let first = run_license_activate_at(&paths, FIXTURE_CODE).unwrap();
        let before = std::fs::read(&paths.license_path).unwrap();
        let again = run_license_activate_at(&paths, FIXTURE_CODE).unwrap();
        let after = std::fs::read(&paths.license_path).unwrap();
        assert_eq!(again["activation"], "already-active");
        assert_eq!(before, after, "幂等这条必须**一字未动**（重写就等于换了时间戳）");
        assert_eq!(again["activatedAtMs"], first["activatedAtMs"]);
        assert!(std::fs::remove_dir_all(&dir).is_ok());
    }

    /// **另一个目录 = 另一把设备私钥 = 另一台机器**（DPAPI 是用户作用域，同机能解开自己的那份，
    /// 所以这条唯一分得开的坐标就是公钥）。把 A 的记录拷进 B 必须读成 `device-mismatch`，
    /// 而且不许带时间戳 —— 这一条是「拷过来就失效」在界面侧的最终落点。
    #[test]
    fn a_license_copied_from_another_device_is_not_licensed() {
        let (da, a) = dir_with_table("devA");
        run_license_activate_at(&a, FIXTURE_CODE).unwrap();
        let (db, b) = dir_with_table("devB");
        run_license_activate_at(&b, FIXTURE_CODE_B).unwrap();
        std::fs::copy(&a.license_path, &b.license_path).expect("拷授权文件");
        let s = read_license_status_at(&b);
        assert_eq!(s["state"], "invalid", "拷来的记录不许读成有效：{s}");
        assert_eq!(s["problem"], "device-mismatch");
        assert_eq!(s["activatedAtMs"], serde_json::Value::Null, "不可信的记录不许带激活时间");
        let _ = std::fs::remove_dir_all(&da);
        let _ = std::fs::remove_dir_all(&db);
    }

    /// 查状态是**只读**的：连目录都不许替我建出来，更不许生成设备密钥 ——
    /// 后者会让一份外来 `license.dat` 在本机「变成本机的」，把设备绑定整个绕过去。
    #[test]
    fn status_never_creates_a_device_key_or_the_directory() {
        let dir = std::env::temp_dir().join(format!(
            "deepclean-m4-readonly-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let paths = license_paths_in(&dir);
        let s = read_license_status_at(&paths);
        assert_eq!(s["state"], "unlicensed");
        assert!(!dir.exists(), "只读的一条写出了东西：{}", dir.display());
    }

    /// crate 自己不建父目录（`save_device_key` 直接 `fs::write`），所以**这一层必须建**。
    /// 不建的话失败要等到写私钥那一刻才现形，而那份错误会被报成设备密钥不可用 —— 一个误导人
    /// 的码。这里故意用一份不存在的清单，只为看目录有没有被建出来。
    #[test]
    fn activate_creates_the_directory_it_needs_before_writing() {
        let root = temp_root("nested-parent");
        let dir = root.join("license");
        assert!(!dir.exists());
        let paths = license_paths_in(&dir);
        let err = run_license_activate_at(&paths, FIXTURE_CODE).unwrap_err();
        assert!(err.starts_with("E_LICENSE_TABLE"), "{err}");
        assert!(dir.exists(), "父目录没建出来，成功那条路会死在写 device.key 上");
        assert!(std::fs::remove_dir_all(&root).is_ok());
    }
}
