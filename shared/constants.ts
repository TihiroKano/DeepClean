export const IPC = {
  DriveList: 'dc:drive:list',
  ScanStart: 'dc:scan:start',
  ScanCancel: 'dc:scan:cancel',
  /** v0.1 暂停 / 继续：协作式门，暂停期间已发现的树照常可看 */
  ScanPause: 'dc:scan:pause',
  ScanResume: 'dc:scan:resume',
  /** v0.1 导出标准化 JSON 扫描报告（主进程弹保存框并写文件） */
  ScanExport: 'dc:scan:export',
  ScanSnapshot: 'dc:scan:snapshot',
  /**
   * §15：这次扫描跳过了哪些路径（有界清单 + 四类计数）。只读查询，吃主进程内存里的记账，零 syscall。
   * 单独一条而不是塞进快照：清单最多 200 条绝对路径，快照每 250ms 推一次，两者频率差两个数量级。
   */
  ScanSkipped: 'dc:scan:skipped',
  TreeChildren: 'dc:tree:children',
  /**
   * Task 7「排除该目录」：**视图**开关（`excluded=false` 即取消）。它改的只是 `levelOf` 回什么，
   * 与 `ScanSkipped`（§15 那趟扫描压根没进去的路径）是两件事，两个面板、两套措辞，不许混用。
   */
  TreeExclude: 'dc:tree:exclude',
  /** 一次清掉本轮全部视图排除（侧栏那句「清除全部排除」）。 */
  TreeExcludeClear: 'dc:tree:exclude:clear',
  /** §9 目录统计（最大文件 / 最大子目录）：只读查询，吃主进程内存里那棵树，零 syscall。 */
  TreeStats: 'dc:tree:stats',
  /** §17 清理预览：报告 + 用户选择 → 预估释放空间（可附带「确认」回执）。只读，没有执行入口。 */
  RulesPreview: 'dc:rules:preview',
  /**
   * §18 清理执行：**必须带 confirmPreview() 的 digest**。
   * 通道本身不含"随便删点什么"的能力 —— 服务端只认已确认的工作单，路径由服务端自己取。
   */
  CleanExecute: 'dc:clean:execute',
  /** §28 原则六 */
  CleanCancel: 'dc:clean:cancel',
  CleanTask: 'dc:clean:task',
  CleanTasks: 'dc:clean:tasks',
  /**
   * §1.7 清理记录：只读查询主进程内存里那本账（筛选在服务端跑，回有界的一页）。
   * 它与 `CleanTasks` 的分工同 `ScanSkipped`：一条是"每次切视图都拉一遍"的粗粒度状态，
   * 一条是"最多 20 万行、只在打开那一页时按需筛"的账本，频率与载荷都差两个数量级。
   */
  CleanJournal: 'dc:clean:journal',
  RevealPath: 'dc:shell:reveal',
  /**
   * §3.6 开发环境页：只读查询「这台机器装了什么工具链 + 每行允许出现哪些控件」。
   * 判据在主进程（`core/rules/devenv-view.ts` 的纯函数），渲染端拿到的是算好的 `actions` ——
   * 它自己不认识哪一行该有删除按钮，所以也画不出一个多余的删除按钮。
   */
  DevEnvView: 'dc:devenv:view',
  /**
   * 设置：全仓唯一一条会写盘的通道。
   *
   * 2026-10-24：原来那一格开关（`autoCleanEnabled`）随本次改动删了 —— 它不再有任何读者。
   * 这条通道**先留着**（读写两端都还在、都验过），下一件"真事"长出来时直接用；
   * 但任何往 `AppSettings` 加字段的人必须同时给那一格控件和真读者，三者缺一是本仓
   * 反复点名的那种"看着接上了其实没有"。
   *
   * 单独两条通道而不是 `getSettings` 带回一个"能不能写"的标志：读是每次打开那一页都要做的，
   * 写只在用户真的动了一格之后做一次，两者的频率与后果都不同（与 `ScanSkipped` / `CleanJournal`
   * 那些拆分是同一条理由）。
   */
  SettingsGet: 'dc:settings:get',
  /**
   * 收的是 **partial patch**，回的是**清洗后整份存下来的值**（不是 `ok:true`）——
   * 界面必须按回执画那一格，否则"服务端把野值按 fail-safe 兜成关"这件事在屏幕上看不见。
   * 判据只有 `sanitizeSettings` 一份，主进程与渲染端都不许自己再兜一次。
   */
  SettingsSet: 'dc:settings:set',
  /**
   * 「关于」那一块。**只回 `app.getVersion()`** —— 因为它是当场就取得到的东西。
   * 这一条的存在是为了给那一块划边界：往里加的每一行都必须是一个真读得到的数或一段真事实，
   * "扫描时自动检查更新""已为您节省 X GB"那一类句子不属于它（本 app 既不检查更新，
   * 也不留存任何历史累计）。
   */
  AppVersion: 'dc:app:version',
  OpenItem: 'dc:shell:open',
  ProgressEvent: 'dc:scan:progress',
  DoneEvent: 'dc:scan:done'
} as const

export const SCAN_EVENT_CHANNEL = 'dc:event'
/** §18 清理进度事件单独一条通道：别把「正在删」混进扫描事件流里，UI 与日志都要能分清（§29）。 */
export const CLEAN_EVENT_CHANNEL = 'dc:clean:event'

export const SCAN_PROGRESS_INTERVAL_MS = 250
export const DEFAULT_MAX_FILES = 3_000_000
export const DEFAULT_MAX_DEPTH = 64
export const SCAN_CONCURRENCY = 16

/**
 * 单层最多回这么多子节点。1200 这个数是渲染侧定的：`MAX_TILES` 早就是 1200，
 * 主进程回得比它更多只会被渲染端丢掉 —— 收窄放在主进程，才有"一条 IPC 消息
 * 从 10 万个对象变成 1200 个"这个收益。
 */
export const LEVEL_CAP = 1200

/**
 * §1.7 记录页的账本上界（主进程内存里最多留多少行）。
 *
 * 这个数**只约束"能点名哪些"**：装不下的那些一律进 `JournalPage.droppedRows` 计数，
 * 界面据此如实标"上限 N 行，另有 M 行没记进来"（与 `MAX_DENIED_SAMPLE` 同一条纪律）。
 * 淘汰从队头走 —— 没留下的那些是**更早**的记录，最近一批永远在（一次大清理之后把用户刚删掉
 * 的那一批挤出账本，等于把这一页的存在理由反过来；评审 I-3）。
 * 5000 × 平均 ~150 字节 ≈ 750 KB，且**取代的是那张 35–40 MB 的归属表**（裁定 T2-2），
 * 所以这本账的净效果是让删除之后的驻留掉一个量级，而不是再加一份。
 * 逐条删除的完整留痕在文件日志里（`[CLEAN]` 那些行），这一页从来不是唯一的那本账。
 */
export const MAX_JOURNAL_ROWS = 5_000

/**
 * 一条 `dc:clean:journal` 回给渲染端多少行。
 *
 * 与 `MAX_JOURNAL_ROWS` 是**两件不同的截断**：那一个是"账上没记这几行"，这里是"这一页没显示这几行"。
 * 界面必须分开说 —— 混成一个 `truncated` 就等于把"我们没记"粉饰成"你没翻到"。
 */
export const JOURNAL_PAGE_LIMIT = 500
