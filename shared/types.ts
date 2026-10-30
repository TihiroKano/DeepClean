import type { Risk } from './classify'
import type { AppSettings } from './settings'

export type FsNodeType = 'file' | 'directory' | 'drive'

export interface DriveInfo {
  root: string
  label: string
  totalBytes: number
  freeBytes: number
  usedBytes: number
}

export interface ScanInput {
  root: string
  maxFiles?: number
  maxDepth?: number
}

export type ScanStatus = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'

export interface ScanCounters {
  files: number
  dirs: number
  totalBytes: number
  denied: number
  missing: number
  busy: number
  otherErrors: number
  skipped: number
}

export interface ScanSnapshot extends ScanCounters {
  scanId: string
  root: string
  status: ScanStatus
  currentPath: string
  /** 净工作毫秒（暂停不计）。**它是"时长"不是"时刻"**：拿 `Date.now() - elapsedMs` 反推
   *  结束时间会随提问时刻一直往后漂（扫完一小时后再问，推出的就是"一小时前扫完的"），
   *  所以"什么时候扫完的"只能读下面那两个字段。 */
  elapsedMs: number
  /** 本次扫描按下启动的墙上时刻；`null` = 还没开始（`startedAt` 是 `private` 且初值 0，别退化成 0） */
  startedAtMs: number | null
  /** 进入 `completed` / `cancelled` / `failed` 的时刻；`null` = 还在跑或还没跑 */
  finishedAtMs: number | null
  truncated: boolean
  /** 产出这棵树的扫描档位。`mft` = NTFS $MFT 直读（管理员 + 盘符根 + NTFS 才有，
   *  会多看见 meta 记录与 ADS）；`walk` = 目录遍历兜底档。缺省（旧桥）按 walk 解释。 */
  scanMode?: 'walk' | 'mft'
}

export interface ScanEvent {
  kind: 'progress' | 'done'
  snapshot: ScanSnapshot
}

/**
 * §15「部分数据无法访问 · 共跳过 N 个」的那一份（Task 9）。
 *
 * 为什么不塞进 `ScanSnapshot`：快照每 250ms 推一次、每条进度事件都完整结构化克隆一遍，
 * 而这里最多挂 200 条绝对路径（≈24 KB）。把它放进快照等于给扫描全程的事件流乘上这个常数，
 * 而清单只在"扫描结束/取消后有人来问一句"时才需要。计数器留在快照里（HUD 要用），
 * 清单单独走一条按需的只读查询（`IPC.ScanSkipped`）。
 *
 * 三条口径：
 * - `total` = 四类错误之和，与 `ScanSnapshot.skipped` **同一个数**（两个读面，一个真值源）；
 * - `sample` 只收 `denied`（哪些目录没被计量），按发生顺序，最多 `MAX_DENIED_SAMPLE` 条；
 * - `sampleOverflow` = `denied − sample.length`：**计数永不因清单截断而变少**，截断只发生在"能点名哪些"这一侧。
 *   没溢出时它是 0，UI 不许把这一句 0 印成一句话。
 */
export interface SkippedWire {
  total: number
  denied: number
  missing: number
  busy: number
  otherErrors: number
  sample: string[]
  sampleOverflow: number
}

export interface ChildView {
  kind: FsNodeType
  name: string
  path: string
  dirId?: number
  /** 本项体积，口径跟随所属载荷的 `sizeBasis`。 */
  size: number
  /**
   * 表观（逻辑）大小 —— 与 SpaceSniffer 同口径，硬链接按名重复计。
   * **可选**：Electron 侧的老载荷与大量测试夹具只有 `size` 一个数，
   * 缺这一格时语义是「与 `size` 同值」（那些来源本来就不分两套口径）。
   */
  sizeApparent?: number
  /** 分配大小且硬链接已去重 —— 「占了多少盘」的真值。理由同上，可选。 */
  sizeAllocated?: number
  mtimeMs: number
  fileCount: number
  dirCount: number
  scanning?: boolean
  /**
   * 已证明的 FILE_ATTRIBUTE_* 位（见 shared/classify 的 WIN_ATTR / attrsFromStatMode）。
   * `null` = **本节点没采属性**：目录本轮不走 stat（为目录多花一次 lstat ≈ C 盘 7.3 万次额外 I/O），
   * 这是刻意的设计边界，不是"目录没有属性"。文件的 attrs 允许为 0，含义是"这次 stat 没证明出任何属性位"
   * —— 当前运行时只能证明 READONLY，所以 0 不代表"不是隐藏/系统文件"。
   */
  attrs: number | null
  /** 创建时间；`null` = 本节点没采（目录本轮不 stat），与 `attrs` 的三态同构。 */
  birthtimeMs: number | null
}

export interface ChildrenPayload {
  dirId: number
  rootId: number
  path: string
  /** 本层体积，口径由 `sizeBasis` 决定。 */
  size: number
  /**
   * 同一层的表观（逻辑）大小 —— **SpaceSniffer 显示的就是这一套**：硬链接按名重复计、
   * 不含 NTFS 压缩收益。它与 SpaceSniffer 逐格可比，但可能大于卷容量。
   *
   * **可选**：Electron 侧与测试夹具只有一套数，缺这一格时语义是「与 `size` 同值」。
   */
  sizeApparent?: number
  /** 同一层的分配大小（硬链接已按 (卷序列号, 文件 ID) 去重）。只许与卷容量比。可选，同上。 */
  sizeAllocated?: number
  children: ChildView[]
  status: ScanStatus
  /** 根节点（本次扫描的盘）的总大小：tooltip 的「占 C 盘 %」要它，渲染端自己算不出。 */
  rootSize: number
  rootSizeApparent?: number
  rootSizeAllocated?: number
  /** 收窄**之前**这一层到底有多少子项 —— 用户有权知道地图省略了多少东西。 */
  totalChildren: number
  foldedCount: number
  /**
   * 没回给渲染端的那部分容量。
   *
   * 契约（Task 2/5/6/7 按这条用）：等式两端都走 `childrenOf` 这一个口径，
   * `Σchildren + foldedBytes + excludedBytes == ΣchildrenOf(dirId)`，且
   * `children.length + foldedCount + excludedCount == totalChildren` —— 视图收窄与视图排除
   * 各管各的容量，两份都要点名，任何一份被并进真块头上都算这张图说谎。
   *
   * 它**不**等于 `payload.size`（= `sizeOf(dirId)`，本层真实直属 + 子树合计）：视图折叠 ≠ maxFiles
   * 截断，后者（`core/scan/tree-store.ts` 的 `addFilesToDir`）丢的是**存储里**的文件记录而容量照计，那部分字节
   * 既不进 `children` 也不进 `foldedBytes`，`totalChildren` / `foldedCount` 同样偏小。截断由
   * `truncated` 标志点名，不在这条等式里 —— 别拿 `foldedBytes` 去和 `size` 对账。
   */
  foldedBytes: number
  /**
   * Task 7「排除该目录」在本层藏掉了几个**直属子项**（视图口径，`childrenOf` 一个字都没少）。
   * 0 = 这一层没有被排除项：UI 不许把 0 印成一句"已排除 0 个"冒充有过这一栏。
   */
  excludedCount: number
  /**
   * 字节数的口径。**缺省 = `'apparent'`**（Electron 侧现行实现的行为）；
   * Tauri 侧的 Rust 内核回 `'allocated'`（占用、硬链接已去重）。
   * 界面上的标签（"表观大小"/"占用大小"）从它读，不许写死 —— 写死就有一条链在撒谎。
   */
  sizeBasis?: 'apparent' | 'allocated'
  /** 那些被排除子项的合计容量。容量必须点名，不许悄悄从地图上消失。 */
  excludedBytes: number
  /**
   * Task 7 修订 Fix 2：**本轮累计**的排除个数（跨层），口径与上面两个**不同**，两者都要在。
   *
   * `excludedCount` 按构造只数本层直属子项，所以在 `C:\b` 里排除一个目录、退回根之后它是 0 ——
   * 而过滤器整轮都还在生效。侧栏那句「已排除 N 个目录」与「清除全部排除」这个唯一撤销入口
   * 必须挂在这个跨层的数上，否则过滤器的唯一指示器会随层级消失（"看不见但生效中"）。
   * 折叠那句「本层共 X 项」仍按 `excludedCount` 走：它讲的必须是这一层的账。
   *
   * 已去掉被更上层排除吞掉的那些（祖先整块藏掉时子级不额外少一块面积），见 `TreeStore.excludedTotals`。
   */
  sessionExcludedCount: number
  /** 那些目录的完整子树合计（`sizeOf` 口径，与 `payload.size` 同源）：地图上此刻少了这么多字节。 */
  sessionExcludedBytes: number
}

export interface FileHit {
  name: string
  path: string
  size: number
  mtimeMs: number
  ext: string
}

/* ------------------------------------------------------------------ *
 * §9 目录统计（线格式；遍历算法在 `core/analyze/dir-stats.ts`）
 *
 * 定义在 shared 的理由与 §17/§18 线格式同源：`tsconfig.web` 是 composite 项目，
 * 只允许 import 自己 include 列表里的文件（`core/analyze/dir-stats.ts` 不在其中，也不许改那份白名单），
 * 而渲染进程必须能拿到这份契约。两边各存一份同构定义 = 改字段时迟早分叉。
 * ------------------------------------------------------------------ */

/** 「最大文件」/「最大子目录」的那一条命中。`path` 是完整路径：它同 size 并列时就是定序键。 */
export interface DirStatHit {
  name: string
  path: string
  size: number
}

/**
 * §9 选中目录后的那一组数字。两条**口径**别混：
 * - `largestSubDir` = **直属**子目录里最大的那个（用户的"下一步该进哪个"）；
 * - `largestFile` = **整个子树**里最大的那个（要点进好几层才找得到，所以带 `path`）。
 */
export interface DirStats {
  /** 目录总大小（子树合计），与 `sizeOf(dirId)` 同一个数。 */
  size: number
  /** 子树文件数（= `DirRecord.fileCount`；扫描中是中间值）。 */
  files: number
  /** 子树目录数（= `DirRecord.dirCount`，不含本目录自己）。 */
  dirs: number
  /** null = 这一项压根没有（空目录 / 子树里没有文件），UI 显示「—」而不是 0 字节。 */
  largestFile: DirStatHit | null
  largestSubDir: DirStatHit | null
  /**
   * true = 节点预算用尽，下面两个 largest 只覆盖已访问的部分。UI 必须把它显示出来。
   * 注意它**不**表示"目录还在扫描中"：后者由面板上那句「该目录仍在扫描中，数字是中间值」负责。
   */
  partial: boolean
  /** 本次实际访问了多少个目录节点（预算判据的凭证，也是 partial 那句里要点名的 N）。 */
  visited: number
}

/** 跨 IPC 边界的那一份（线格式本体与 `DirStats` 同形）。 */
export type DirStatsWire = DirStats

/* ------------------------------------------------------------------ *
 * §17 清理预览（扫描 → 发现可清理项目 → 用户选择 → 预估释放空间 → 确认）
 *
 * 这里是**线格式（wire shape）**，算法在 `core/rules/preview.ts`：
 * 之所以定义在 shared，是因为 tsconfig.web 是 composite 项目，
 * 它只允许 import 自己 include 列表里的文件（core/rules/** 不在其中，也不许改 include 列表），
 * 而渲染进程必须能拿到这份契约。`category` / `cleanStrategy` 因此在边界上落成 string：
 * 值仍然来自 core 的字面量联合（赋进 string 是安全方向），渲染进程当展示键用。
 * **风险等级保持 `Risk` 类型** —— 🔴 门禁是整个预览的承重墙，不能用 string 糊过去。
 * ------------------------------------------------------------------ */

/** 拒绝原因。前两条就是 §16 那句「禁止通过普通清理按钮直接删除」在预览层的落点。 */
export type PreviewRefusalReason =
  /** 勾选的项目本身是 🔴（riskLevel='forbidden'） */
  | 'forbidden-risk'
  /** 勾选的具体路径落在 §16 禁止根之内（复用引擎的 isForbiddenPath，不另立定义） */
  | 'forbidden-root'
  /** 勾选的路径落在「只上报不可删」根之内（回收站那一类）：占用如实报告，但任何规则都勾不动 */
  | 'report-only-root'
  /** 报告的 🔴 保护没落地（safetyBlocked / 禁止根为空）→ 整份预览不出结论 */
  | 'safety-blocked'
  /** 勾了报告里没有的 ruleId（渲染进程拿不到根级目录，也不许它凭空报名字） */
  | 'unknown-rule'
  /** 该规则在 §15 声明层就被 validateRuleSet 拒了 */
  | 'item-rejected'
  /** 报告只枚举了采样路径，这条不在其中 → 无法定价，不猜也不重新走盘 */
  | 'path-not-enumerated'
  /** 重复勾选：同一项/同一路径第二次出现，不重复计价 */
  | 'duplicate-selection'

export type PreviewRefusalScope = 'item' | 'path'

export interface PreviewRefusal {
  scope: PreviewRefusalScope
  ruleId: string | null
  path: string | null
  reason: PreviewRefusalReason
  detail: string
  /** 被挡在预估之外的字节（项级 = 该项大小，路径级 = 该路径大小；重复勾选类记 0，因为已经在数过的那次里了） */
  bytes: number
}

/** §17 的「用户选择」：按项勾选，或按报告里已枚举的路径逐条勾选。 */
export interface PreviewSelectionItem {
  ruleId: string
  /** 省略 = 整项勾选；给出 = 只勾这些路径（无法定价的会被拒绝并点名） */
  paths?: readonly string[]
}

export interface PreviewSelection {
  items: readonly PreviewSelectionItem[]
}

export interface PreviewItem {
  ruleId: string
  name: string
  /**
   * 这一项**自己的规则文案**（M5-P1 T5a，spec §5「删了会失去什么」那句话）。
   *
   * 来源是**规则表那一份**（`BUILTIN_RULES` / Rust 的 `builtin_rules()`，按 `ruleId` 取）；
   * 预览层只查表、不写文案，界面拿到的就是被哈希过的那一份。
   *
   * ⚠️ 它**进 digest 的覆盖字段**，两份口径都进（`core/rules/preview.ts` 的 `digestOf`、
   * Rust `digest.rs`）：不进的话服务端把某条规则的文案改软一次，旧回执照样能执行 ——
   * 那是 T4 用 `ack=` 关掉的后门，不许从文案这一侧重新打开。
   *
   * 表外的 `ruleId`（夹具里的自定义规则集）取不到规则 ⇒ **空串**。
   * 空是事实，不是待办：**不许在显示层编一句"通用说明"补上去**（那句没有出处，却又被哈希进过执行凭据）。
   */
  description: string
  category: string
  riskLevel: Risk
  cleanStrategy: string
  recoverable: boolean
  /** 用户勾了没有（§17 第三步） */
  selected: boolean
  /** 是否计入预估。🔴 永不为 true。 */
  included: boolean
  /** 计入预估的字节 */
  bytes: number
  files: number
  /** 勾选粒度：整项 / 只有已枚举的路径 */
  scope: 'rule' | 'paths'
  /** scope='paths' 时被选中且完成定价的路径（升序） */
  paths: { path: string; size: number }[]
  /** 未勾选或未计入时，这一项本来的全量口径 —— 两者之差就是「没算进来的部分」 */
  findingBytes: number
  findingFiles: number
  /** 报告的采样清单被截断过：路径级勾选只能覆盖已枚举部分，差额见 findingBytes */
  sampleTruncated: boolean
  /** 这一项覆盖的目录（来自报告 matchedRoots，UI 要能说明范围） */
  matchedRoots: string[]
  /** 这一项自己被拒的原因；null = 没被拒 */
  refusal: PreviewRefusal | null
}

export interface PreviewRiskCell {
  items: number
  files: number
  bytes: number
}

/**
 * §3.6 未完 #2 / #4b 的底账：一条工具规则的**地盘与这棵被扫的树**的关系。
 * 住在 shared 是因为两侧都要读（`core/rules/types.ts` 的报告与 `PreviewModel` 用的是同一份形状，
 * 手抄第二份就是"两次声明迟早分叉"那一族错）。判定与含义见 `core/rules/engine.ts` 的 `territoryLedger`。
 */
export interface TerritoryFact {
  ruleId: string
  /** 探测器判这台机器没装它依赖的工具 → 这块地盘不计入可回收，但占用要能单独报给用户 */
  detectorAbsent: boolean
  /** 这棵树上**看到**的地盘目录；`bytes = null` 是第三种状态「目录看到了、字节没量过」，不许退成 0 */
  present: readonly { path: string; bytes: number | null }[]
  /** 这次扫描没覆盖到的地盘条数 —— 与"缓存真空"分开数，那两个 0 才分得开 */
  notScanned: number
}

export interface PreviewModel {
  /** 报告里的**全部**可清理项目（含未勾选的），顺序与报告 findings 一致 —— §17「发现可清理项目」的数据源 */
  items: PreviewItem[]
  /** 所有被拒的勾选 + 原因，一条都不静默吞掉 */
  refusals: PreviewRefusal[]
  /** 预计释放空间（§17 的合计数）= 已计入 items 的 bytes 之和 */
  totalBytes: number
  totalFiles: number
  /** 风险分解：只统计**已计入**的项目，所以 forbidden 恒为 0 */
  riskBreakdown: Record<Risk, PreviewRiskCell>
  /** 被拒的字节合计：用户勾了但没进预估的量 */
  refusedBytes: number
  /** true = 🔴 保护不在线（报告 safetyBlocked 或禁止根为空）→ 整份预估为 0，不许确认 */
  blocked: boolean
  /** 与报告对账用：报告自己的 🟢🟡🟠 合计。全量勾选时 totalBytes 必须与它相等 */
  reportReclaimableBytes: number
  reportForbiddenBytes: number
  /** 本次生效的禁止根（从报告透传，确认步骤拿它复核） */
  forbiddenRoots: string[]
  /** 本次生效的「只上报不可删」根（回收站那一类）。UI 用它解释"这行报了占用但永远勾不动" */
  reportOnlyRoots: string[]
  reportExclusionCount: number
  /**
   * §3.6 未完 #2 / #4b：工具规则的**地盘与这棵被扫的树**的关系，原样从 `RuleReport` 抄过来。
   *
   * 预览这一层不做任何判定（一旦在这里重新算"哪条地盘没扫到"就有了第二份事实源）。
   * 它**不参与** `digest`，理由与 `defaultUnselectableRuleIds` 同一族：底账改的是"这句话怎么说"，
   * 而 digest 是 §18 的执行授权凭据，只绑账目。由 `tests/unit/rules-preview.test.ts` 钉着。
   */
  territories: TerritoryFact[]
  /**
   * §3.5：这些规则**不进「一键全选」**（AI 模型文件本体那一类）。由服务端从规则声明派生后搬进来，
   * 渲染端只读不判 —— 界面少画一个复选框不叫"结构性豁免"，改一次界面就没了。
   * 恒为数组（没有豁免时是 `[]`，不是 `undefined`），让渲染端不必处理第三种状态。
   * 它**不参与** `digest`：默认勾选取舍不是账目，而 digest 是 §18 的执行授权凭据。
   */
  defaultUnselectableRuleIds: string[]
  /** 诚实说明：🟠 提示、不可再生提示、路径级勾选的覆盖上限等 */
  notes: string[]
  /** 这份预估是什么时候算的（由调用方注入，预览自己不读时钟） */
  generatedAtMs: number
  /** 模型指纹：确认必须绑定在这一份预估上（改过一个数字就对不上） */
  digest: string
}

/**
 * 确认被拦下的原因。**声明次序 = 判定次序**（M5-P1 T4）：
 * `risk-not-acknowledged` 坐在两道复核（指纹、内容）之后、`safety-blocked` 之前 ——
 * 次序本身是行为，界面按这个次序逐条措辞（与 Rust `PreviewConfirmBlocker` 逐字同名）。
 */
export type PreviewConfirmBlocker =
  | 'not-acknowledged'
  | 'nothing-to-confirm'
  | 'safety-blocked'
  | 'forbidden-included'
  /** 已计入预估的项里有**高于**用户按下档位的档（M5-P1 T4，spec §5：「你确认过」≠「你看见 🟠 了」） */
  | 'risk-not-acknowledged'
  | 'stale-model'

/**
 * §17 第五步「确认」的回执：**纯数据，且不含路径清单**。
 * §18 落地后它是**执行凭据**：`dc:clean:execute` 必须带回这个 digest 才能领到工作单，
 * 而工作单（具体路径）只在主进程内部生成与保存，从不写进这份回执。
 */
export interface PreviewConfirmation {
  kind: 'dc-preview-confirmation'
  acknowledged: boolean
  /**
   * M5-P1 T4：用户**按下的档位**（与 Rust `PreviewConfirmation::acknowledged_risk` 同字段）。
   * 它同时进 `digest` 的覆盖集 —— 不进的话同一份模型换个档出的是同一个凭据，
   * 一张 🟢 档领到的旧回执就能顶着一份含 🟠 的预估重放。
   */
  acknowledgedRisk: Risk
  confirmed: boolean
  blockers: PreviewConfirmBlocker[]
  ruleIds: string[]
  items: number
  files: number
  totalBytes: number
  refusalCount: number
  /**
   * **执行凭据**：模型决策字段 + `acknowledgedRisk`（`previewDigest(model, acknowledgedRisk)`）。
   * 所以它**不等于** `PreviewModel.digest`（那一份是档位无关的模型指纹，用来复核 stale）。
   */
  digest: string
  /**
   * 这份回执**绑定的那一份模型的指纹**（= `PreviewModel.digest`，档位无关那一份）。
   *
   * 为什么必须由服务端一并盖进回执，而不是让渲染端拿 `digest` 去比 `model.digest`：
   * 渲染端**没法**自己重算带档位的那一份 —— 重算要走 `core/rules/preview.ts` 的
   * `previewDigest`，而 `tsconfig.web.json` 只允许 import 自己 include 列表里的文件
   * （`core/rules/**` 不在其中，见本文件 §18 段首那段注释）。缺了这一格，界面只能拿
   * 带档位的 `digest` 去比不带档位的模型指纹，两者按设计永不相等 ⇒「开始清理」永远灰。
   *
   * 归属判据因此落在服务端陈述的事实上：`modelDigest === model.digest` ⇔ 回执属于当前这份预估。
   */
  modelDigest: string
  confirmedAtMs: number
  note: string
}

export interface PreviewRequest {
  selection: PreviewSelection
  /**
   * §12「加入清理列表」：从 Treemap 上点进来的**具体文件路径**。
   * 渲染进程只报路径，不报"它属于哪条规则" —— 归属由服务端用规则引擎自己的认领表
   * （`RuleReport.claimedPaths`）反查，查不到的原样退回 `unclaimedTilePaths`，绝不猜。
   */
  tilePaths?: string[]
  /**
   * 带上它 = 请求一步「确认」回执（仍然只产数据，不产动作）。
   *
   * `acknowledgedRisk` 是**用户按下的那一档**，不是服务端替他算的：界面必须把已计入项里的最高档
   * 原样报上来，档位不够时主进程回 `risk-not-acknowledged`（M5-P1 T4/T5b）。
   * 缺省按 🟡 的口径见 `service.rs` 那段注释 —— 缺省不许替用户承认「我看见 🟠 了」。
   */
  confirm?: { acknowledged: boolean; acknowledgedRisk: Risk }
}

/**
 * 预览构建选项：`nowMs` 由调用方注入（§17 预估本身不读时钟，只记录这份预估是什么时候算的） */
/**
 * §3.6 开发环境页的线格式。判据住在 `core/rules/devenv-view.ts`（纯函数、主进程调用），
 * 这里只定义"算完了长什么样"，好让渲染端拿到的是**结论**而不是需要它自己判的数据。
 */
export type DevEnvGroupId = 'node' | 'java' | 'python' | 'ide' | 'android' | 'ai' | 'container'

/** 一行上允许出现的动作。渲染端只照画，不许在这里之外加减。 */
export type DevEnvRowAction = 'group-select-all' | 'toggle-include' | 'detail' | 'go-large-files' | 'view' | 'prune-hint'

export interface DevEnvRowWire {
  ruleId: string
  name: string
  /** 三格各说各的事：unknown = 没问过探测器，not-installed = 探测说没装 —— 界面上是两句话 */
  installState: 'installed' | 'not-installed' | 'unknown'
  /** null = 这一格没量过（没扫过 / 未安装而不该给数）；0 是「量过且真是 0」 */
  displayBytes: number | null
  displayFiles: number | null
  excludedFromDefaultSelection: boolean
  actions: readonly DevEnvRowAction[]
  /**
   * §3.6 未完 #2：探测器判未装、但这块地盘在扫到的树上**看到了**占用时的残留清单。
   * `null` = 没有残留可报（装了 / 没扫过 / 这块地压根没看到）。
   * `bytes = null` 是第三种状态「目录看到了、字节没量过」—— 界面必须能把它和「0 字节」分开念。
   * 它**不带来任何控件**：`actions` 由这张表的另一列决定，残留只是说明（用例钉着这两列互不越界）。
   */
  residual: { bytes: number | null; paths: readonly string[] } | null
  /**
   * §3.6 未完 #4b：这一行的地盘**整条都不在这棵被扫的树上**。
   * 到了这一步，那一格的 `0 B` 才不再是同一句话：「缓存是空的」与「这次没扫到那块地」必须两种措辞，
   * 而后者还要点名量的是哪棵树（`DevEnvViewWire.scannedRoot`）。
   */
  territoryMissing: boolean
  /** 仅 Docker 行有值：那句要交给用户自己执行的命令（DeepClean 不代它跑，也不持有它的删除路径） */
  pruneCommand?: string
}

/**
 * §3.6「AI 模型与权重」那一格的计数（`core/analyze/model-files.ts` 的产物）。
 *
 * 三个设计决定各自都挡着一种谎：
 * - `count` 来自**扫描途中**的顺带累加，与 `topHeap` 的 100 条容量无关；
 * - 出身三件套（`rootPath` / `filesSeen` / `scanStatus`）与数同生共死：
 *   没扫完的树只能念"已扫到 N 个"，而那一句必须说得出量的是哪棵树；
 * - `extensions` 是口径的原样回声，渲染层不许手抄一份名单（抄了就两份会漂）。
 */
export interface ModelTallyWire {
  count: number
  bytes: number
  /** 被量的那棵树的根。 */
  rootPath: string
  /** 这棵树里见过的**全部**文件条数（N 个权重是从 M 个文件里数出来的）。 */
  filesSeen: number
  /** 存储层因 `maxFiles` 丢过记录：条数仍是全量，但"这棵树"只是磁盘的一部分。 */
  truncated: boolean
  /** 原样带出，不在这一层压成布尔 —— running / cancelled / completed 在界面上是三句话。 */
  scanStatus: ScanStatus
  extensions: readonly string[]
}

export interface DevEnvGroupWire {
  id: DevEnvGroupId
  label: string
  rows: readonly DevEnvRowWire[]
  /**
   * 只有需要「模型本体归大文件」那条路由的分组才有这一格（判据在 `devenv-view.ts`）。
   * `null` = 还没扫过，界面念「还没扫过」；`undefined` = 这个生态不问这个问题。
   */
  modelFiles?: ModelTallyWire | null
}

export interface DevEnvViewWire {
  groups: readonly DevEnvGroupWire[]
  /** 内置 dev-cache 规则数。页面用它自证「一条都没漏」，而不是只念分组数 */
  declaredRuleCount: number
  /**
   * §3.6 未完 #4b：这些占用数字**是从哪棵树量到的**。null = 还没扫过。
   * 那一格念「0 B」之前要说清量的是哪棵树，否则"我这台机器上没有缓存"会被当成结论。
   */
  scannedRoot: string | null
}

export interface PreviewBuildOptions {
  nowMs: number
  /** 调用方从 `core/rules/registry.ts` 的 `defaultUnselectableRuleIds()` 取来交进去；不传按空表 */
  defaultUnselectableRuleIds?: readonly string[]
}

export interface PreviewPayload {
  scanId: string
  /** 扫描没跑完时预览只是部分事实，UI 必须据此提示（不是静默低估） */
  scanStatus: ScanStatus
  preview: PreviewModel
  confirmation: PreviewConfirmation | null
  /** 请求里带了 tilePaths 时回：这些文件不在任何规则的地盘里，所以没进勾选（点名，不静默丢） */
  unclaimedTilePaths?: string[]
}

/* ------------------------------------------------------------------ *
 * §18 清理任务系统 + §19 清理后验证（线格式；算法在 `core/clean/executor.ts`）
 *
 * 定义在 shared 的理由与 §17 线格式同源：`tsconfig.web` 是 composite 项目，
 * 只允许 import 自己 include 列表里的文件（core/clean/** 不在其中）。
 * ------------------------------------------------------------------ */

/** §18 的 status。`refused` = 一根手指都没动（授权根校验没过 / 整批越界），区别于删了一些之后的 completed。 */
export type CleanTaskStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'refused' | 'failed'

export type CleanRefusalReason =
  /** 不在 authorizedRoot 之内（§28 原则四） */
  | 'out-of-scope'
  /** 与一条越界请求重叠：整批里这部分一起拒，绝不"只删看起来安全的部分" */
  | 'overlaps-out-of-scope'
  | 'equals-authorized-root'
  /** 含 `..` / `\\?\` / 通配 —— 拒绝，且不做二次 normalize 后放行 */
  | 'parent-traversal'
  /** 命中 Task 16 的 FORBIDDEN_PATH_PATTERNS（复用引擎判据） */
  | 'forbidden-root'
  /** 命中 REPORT_ONLY_ROOT_PATTERNS（回收站那一类）：规则把它算进来了，执行层照样拒 —— 与禁止根同一条段边界判据，只是名单不同 */
  | 'report-only-root'
  /** 禁止根模板解析不出来 → fail-safe，整批不动 */
  | 'forbidden-roots-unresolved'
  /** 最后一段是重解析点 */
  | 'reparse-point'
  /** 中间某段是重解析点（文本上没出界、物理上已出界） */
  | 'reparse-ancestor'
  /** lstat 就 ENOENT：跳过文件（§29），不冒充删除失败 */
  | 'not-found'
  | 'unstatable'
  | 'malformed-path'
  | 'not-a-deletable-entry'
  /** M6（免确认清理档，Rust 侧通道）：`permanent`（真删）上下文缺确认回执 → 整批拒绝。TS 基线执行器没有真删通道，这一格只由 Tauri 侧产出 */
  | 'permanent-without-confirmation'

export type CleanBlockerReason =
  | 'root-malformed'
  | 'root-not-absolute'
  | 'root-is-drive-root'
  | 'root-missing'
  | 'root-not-a-directory'
  | 'root-is-reparse-point'
  | 'root-unstatable'
  | 'root-forbidden'
  /** authorizedRoot 自己落在「只上报不可删」根之内（例如有人想把回收站整棵当授权根）→ 整批拒绝 */
  | 'root-report-only'
  | 'root-ancestor-of-forbidden'
  | 'root-forbidden-unresolved'
  | 'root-denied-by-caller'

export interface CleanBlocker {
  reason: CleanBlockerReason
  detail: string
}

export interface CleanRefusal {
  path: string
  reason: CleanRefusalReason
  detail: string
  bytes: number
  /** reason='overlaps-out-of-scope' 时点名它是因为哪条越界请求被连带拒的 */
  overlapOf?: string
}

/** 逐条删除结果（§29 的「删除成功 / 删除失败 / 权限错误」都从这里出）。 */
export interface CleanDeletion {
  path: string
  kind: 'file' | 'dir'
  bytes: number
  ok: boolean
  errno?: string
  detail?: string
  /** §26 Phase 5「失败重试」：这条实际试了几次（1 = 没重试，或失败得不属于可重试的瞬态错误） */
  attempts?: number
  /**
   * §1.7 裁定 2：**仅呈现用**的结局标签，让「重试退避期间收到取消」那一条不再只能靠 detail 里
   * 那句中文（「→ 停手（§28 原则六）」）认出来 —— 措辞一改日志口径就会悄悄变掉。
   *
   * 三条纪律：
   * - **只写不读**：全仓库**生产代码**（`core/` `electron/` `src/` `shared/`）里任何判定路径都不许读它
   *   （`successCount` / `failedCount` / `status` 的算法一字不动）。唯一的读面是 `core/clean/journal.ts`。
   *   扫描面为什么含 `src/`：`CleanEvent.task` 与 `CleanExecuteResult.task` 把整个 `CleanTask` 送过桥，
   *   「没人读它」必须在全仓库成立。这条由 `tests/unit/clean-journal.test.ts` 末尾的静态 + 动态两道闸门钉着，
   *   静态那道是**默认拒绝**：提到 `outcome` 的行必须落在文件里那张逐句点名的豁免清单上
   *   （豁免只有执行器 `tryRemove` 局部返回值的十处既有判定，扩大豁免面要显式加行）。
   * - 值域**没有** `'vanished'`：「删到一半发现 ENOENT」不进 `deleted[]`，它走 `refusals[]`
   *   的 `reason='not-found'`（§9 / §29 的「跳过文件」口径），别在这里造第二个出口。
   * - 可选：加字段之前落盘/在内存里的任务没有它。读的人不许拿它当唯一判据 ——
   *   缺席时 `ok===false` 一律按 `failed` 处理，不猜「它当年可能是取消」。
   */
  outcome?: 'ok' | 'failed' | 'cancelled'
}

/** §19：清理前后各测一次授权根总字节，预估与实际**两个数字都报**，不一致照实说不一致。 */
export interface CleanVerification {
  rootBytesBefore: number
  rootBytesAfter: number
  /** before − after（可为负：清理期间别人在写） */
  actualFreedBytes: number
  /** 预估释放 = 被接受路径里文件字节之和（删除前 lstat 读到的） */
  predictedFreedBytes: number
  /** 实际 unlink 成功的那些文件的字节和 */
  deletedBytes: number
  deltaBytes: number
  filesBefore: number
  filesAfter: number
  /** §19「并重新计算可用空间」：调用方没接这个读数时为 undefined，读不到为 null —— 不猜 */
  freeBytesBefore?: number | null
  freeBytesAfter?: number | null
  note: string
}

export interface CleanExecuteRequest {
  authorizedRoot: string
  paths: string[]
}

/** §18 每个任务的六字段（status/progress/totalSize/cleanedSize/successCount/failedCount）+ 全部留痕。 */
export interface CleanTask {
  id: string
  status: CleanTaskStatus
  progress: number
  totalSize: number
  cleanedSize: number
  successCount: number
  failedCount: number
  authorizedRoot: string
  requestedPaths: string[]
  acceptedPaths: string[]
  blockers: CleanBlocker[]
  refusals: CleanRefusal[]
  deleted: CleanDeletion[]
  dirsRemoved: string[]
  verification: CleanVerification | null
  digest: string
  /**
   * §1.7 裁定 T2-1：**仅呈现**。「确认」那一刻用的那个 digest（= `CleanExecuteIpcRequest.confirmationDigest`
   *  = `executions` 的键 = 归属表所在的那份工作单的键）。
   *
   * 为什么归属表**不能**按 `digest` 反查：上面那个 `digest` 是执行器按 `acceptedPaths` 现算的
   * `executionDigest`，而 `executions` 的键是 `confirmPreview()` 的**确认 digest**（只覆盖决策字段、
   * 显式不含 `generatedAtMs`）。两者**只在"没收窄、没被拒"时相等** —— 一旦用了
   * `CleanExecuteIpcRequest.paths` 子集，或有路径落在六道闸外被拒（`acceptedPaths ⊊ work.paths`），
   * 两个 digest 就分叉，按 `task.digest` 查归属表会**整列静默变「未知」**。
   * 所以 `CleanService.execute()` 在它手里还握着 `work` 的那一刻把这个值写到任务视图上，
   * 记录页一律按它查表；查不到必须 `log.error` 点名，不许静默成「未知」。
   *
   * 三条纪律与 `CleanDeletion.outcome` 同源：**只写不读**（六道闸 / `successCount` / `failedCount`
   * 一个字都不看它）、可选（加字段之前的任务与整批被拒的路径没有它）、缺席时口径是「未知」而不是猜。
   */
  confirmationDigest?: string
  startedAtMs: number
  finishedAtMs: number
}

/**
 * 主进程在「确认」通过的那一刻物化出来的**执行工作单**。
 *
 * 为什么要有它（§18 与 IPC 的承重点）：`PreviewConfirmation` 刻意不含路径清单，
 * 而 §18 的执行器又必须拿到具体路径。所以路径清单只在主进程内部生成、内部保存，
 * 渲染进程**永远只能凭 digest 领用它** —— 它自己报上来的路径一律不作数。
 */
export interface ConfirmedExecution {
  /** = `confirmPreview()` 返回的 digest：执行时必须原样带回来 */
  digest: string
  /** 执行路径集合自己的指纹（服务端复核工作单没被改过） */
  pathDigest: string
  scanId: string
  /** 这次扫描的根：请求没给 authorizedRoot 时就用它 */
  scanRoot: string
  paths: string[]
  files: number
  totalBytes: number
  ruleIds: string[]
  confirmedAtMs: number
  /**
   * §1.7 裁定 1 的**归属表**：`normalizeKey(path) → {ruleId, risk, bytes}`。
   *
   * 它是 `recordExecution()` 沿自己那条既有的 `preview.items` 循环顺手记下来的一张表 ——
   * 不新开遍历、不做第二套路径匹配、不查注册表：`item.ruleId` / `item.riskLevel` 就挂在那个循环上，
   * `bytes` 是预览给这一条定过的价（确认那一刻 lstat 出来的）。**风险等级因此与界面勾选框旁边
   * 那个颜色同源**，不会出现"预览说🟢、日志说🟠"这种两张嘴。
   *
   * 三条纪律：
   * - **仅呈现**：没有任何一条判定/授权路径读它（`CleanService` 的收窄、`pathDigest` 自证、
   *   执行器的六道闸一律不看它）。它查不到 ⇒ 页面显示「未知」，**绝不兜底成某条规则的风险**。
   * - 键是 `normalizeKey` 之后的（大小写与斜杠写法归一），值只有三个短字段，量级与 `paths` 相同。
   * - 可选：这张表之前落在工作单里的条目没有它。消费方（`core/clean/journal.ts`）对缺席的口径
   *   是 `null`，不是"当作没有这一条"。
   *
   * **它的寿命只有一个 `done` 那么长**（裁定 T2-2 + 评审 I-5 的裁定）：`CleanService.recordJournal()`
   * 用它派生完账本就把这个字段从工作单上摘掉，那张表本身挪进 `CleanService` 里**只此一格**的
   * "最近一份归属表"槽位 —— 于是驻留是"峰值一份"而不是"会话内无上限累加"，而**同一份确认第二次
   * 执行**（`execute()` 不消费工作单，这是条真存在的用户路径）照样查得到风险等级，不再整轮变「未知」。
   * 槽位被另一个 digest 换掉之后再回头执行旧 digest，才是真的查不到（那时会 `log.error` 点名）。
   */
  attribution?: Map<string, PathAttribution>
}

/** 归属表的一条（见 `ConfirmedExecution.attribution`）。`bytes` = 确认那一刻给这一条定过的价。 */
export interface PathAttribution {
  ruleId: string
  risk: Risk
  bytes: number
}

/* ------------------------------------------------------------------ *
 * §1.7 清理日志的一行（派生算法在 `core/clean/journal.ts`，纯函数）
 *
 * 与 §17/§18 线格式同一条理由放在 shared：`tsconfig.web` 是逐文件白名单的 composite 项目，
 * `core/clean/**` 不在其中（裁定 6：渲染端一个 `core/clean` 都不许 import，因为那里住着真的
 * `unlink`/`rmdir`），而记录页必须拿得到这一行的契约。
 * ------------------------------------------------------------------ */

/**
 * 清理日志（2026-10-25 重做）—— **一次清理一条**。
 *
 * 旧的一套（`JournalStatus` / `JournalEntry` / `JournalFilter` / `JournalTotals` / `JournalPage`）
 * 整体删掉了：那是一个文件一行、只在内存、三维筛选的账本。现在列表的单位是「一次清理」，
 * 排序只有时间一维，详情才展开到文件，且**只有成功的那些**会进日志。
 *
 * 对应 Rust 侧 `deepclean_cleaner::journal::CleanRun`（`#[serde(rename_all="camelCase")]`）。
 */
export interface JournalFileWire {
  /** 原样路径（给人看，不归一化） */
  path: string
  sizeBytes: number
}

export interface CleanRun {
  /** 复用 `task.id` */
  id: string
  /** 清理**结束**时刻（毫秒）。30 天保留窗口从这里算 */
  endedAtMs: number
  /** 实际涉及的盘，升序去重（如 `["C:\\", "D:\\"]`）；UNC 推不出盘符 ⇒ 不计入 */
  drives: string[]
  /** 成功释放的字节合计（与 `task.cleanedSize` 同口径） */
  freedBytes: number
  /** 成功删除的文件数 */
  fileCount: number
  /** 详情：成功的那些文件。**存扁平**，折叠在服务端算 */
  files: JournalFileWire[]
}

/**
 * 详情页第一层：一条 run 里每个顶层目录的汇总。
 *
 * 对应 Rust `deepclean_cleaner::journal_view::DirSummary`。
 */
export interface JournalDirSummary {
  /** 目录的原样路径 */
  dir: string
  fileCount: number
  bytes: number
}

/**
 * 详情页某一层的子项：一个子目录或一个直属文件。
 *
 * 对应 Rust `deepclean_cleaner::journal_view::DirEntry`。
 * 目录的 `sizeBytes` / `fileCount` 是**它整棵子树**的合计，不是它自己那一层。
 */
export interface JournalDirEntry {
  name: string
  /** 原样路径（文件是完整路径，目录也是） */
  path: string
  isDir: boolean
  sizeBytes: number
  fileCount: number
}

/** `dc:clean:execute` 的入参：digest 是唯一的授权凭据。 */
export interface CleanExecuteIpcRequest {
  /** 必须是 `confirmPreview()` 成功回执里的那个 digest；没有确认过的预估就没有执行这回事 */
  confirmationDigest: string
  authorizedRoot?: string
  /**
   * 渲染进程**只能收窄**已确认的清单（子集），不能新增。
   * 越出工作单之外的任何一条路径 = 整个请求被拒（篡改信号，不是"过滤掉就行"）。
   */
  paths?: string[]
}

/** `dc:clean:execute` 的回执：只回任务视图，不回路径清单。 */
export interface CleanExecuteResult {
  ok: boolean
  /** 拒绝整个请求的原因（未确认 / 过期 / 越出工作单 / 授权根不合格）；ok=true 时为 null */
  error: string | null
  task: CleanTask | null
}

/** 清理进度事件（§18「正在清理 + 已释放 X」）。事件里同样只有任务视图，没有工作单。 */
export interface CleanEvent {
  kind: 'progress' | 'done'
  task: CleanTask
}

/**
 * 清理的**逐条**进度（2026-10-24）。`dc://clean-progress` 的载荷。
 *
 * 与 `CleanEvent` 的分工是刻意的：那条带**整份** `CleanTask`（`deleted[]` 能长到几万条），
 * 只在收尾发一次；这条只带"刚刚落下的那一条 + 几个计数"，是固定大小，按 40 ms / 64 条节流。
 * 清理弹窗里那串滚动的文件路径读的就是它。
 *
 * 三条纪律：
 * 1. **全是已发生的事实**（这条删了没删掉、多大、第几条/共几条），不是预估；
 * 2. `done` / `total` 与 `task.progress` 同一个分母，所以进度条与滚出来的行数对得上 ——
 *    不会出现"列表 300 行而进度条说 12%"那种两套账；
 * 3. `bytes` 在 `ok=false` 时恒为 0（没删掉就没有释放），与 `CleanDeletion.bytes` 同口径。
 */
export interface CleanProgressEvent {
  /** 界面按它过滤：两次清理并存时不许串台。 */
  taskId: string
  /** 刚刚落下的那一条（绝对路径，与 `CleanTask.deleted[].path` 同源）。 */
  path: string
  /** 这条是不是真删掉了。`false` = 失败（**不是**拒绝 —— 拒绝发生在动手之前，不进进度）。 */
  ok: boolean
  /** 成功 = 量到的表观大小；失败 = 0。 */
  bytes: number
  /** 已经处理完几条。 */
  done: number
  /** 这一批一共几条（文件 + 目录）。 */
  total: number
  /** 累计释放字节（= `task.cleanedSize` 的当时值）。 */
  cleanedSize: number
}

/**
 * M4 离线授权：`dc_license_status` 的 wire（Rust 侧 `service.rs` 的 `status_wire` 是唯一的生成处）。
 *
 * **只有这五个键**，由 `the_status_wire_field_set_is_closed` 钉着：授权相关的 wire 一旦多出一个
 * 字段，它就是往渲染进程递东西 —— 而这一层能递出去的最坏的东西是设备私钥种子。
 * `state` 三值之外不许有第四种；`invalid` 必须带 `problem`（具名机器码）与 `problemReason`（中文）。
 */
export interface LicenseStatusWire {
  state: 'licensed' | 'unlicensed' | 'invalid'
  /** 不可信与未激活一律 null：一份不该被当真的记录不许带时间戳。 */
  activatedAtMs: number | null
  /** 绑定的设备公钥（hex）。未激活/不可信时是 null。 */
  deviceId: string | null
  /** 六个具名机器码之一；非 `invalid` 时为 null。 */
  problem: string | null
  /** 与 `problem` 同条的中文原因，界面直接念。 */
  problemReason: string | null
}

/**
 * M4：激活的回执。
 *
 * **`status` 是激活之后重读一遍拿到的那一份**，不是「刚才那句成功」的复述 ——
 * 界面那格显示的是重读结果，所以写盘静默失败时界面说「未激活」，而不是说「激活成功」。
 * `ok=false` 时 `status` 是失败前那一份（不许伪造）。
 */
export interface LicenseActivateResult {
  ok: boolean
  /** 稳定的 `E_` 码 + 那句真话；`ok=true` 时为 null。 */
  error: string | null
  /**
   * `already-active` = 同一个码在本机已经绑着，这次一字未动。与 `activated` 是两句话。
   *
   * **这个名字不叫 `outcome`**：`outcome` 在本仓库是清理日志那个**仅呈现字段**的保留名，
   * `tests/unit/clean-journal.test.ts` 有一道默认拒绝的静态闸（`core/` `electron/` `src/` `shared/`
   * 里任何提到它的行都必须落在点名豁免清单上，因为判定路径一律不许读它）。
   * 复用同一个词只有两种下场：要么把那条闸的豁免面撑大（等于削弱它），要么让后来人分不清
   * 自己读到的是哪一个 `outcome`。所以授权这边一律叫 **`activation`**。
   */
  activation: 'activated' | 'already-active' | null
  status: LicenseStatusWire
}

export interface DeepCleanApi {
  listDrives(): Promise<DriveInfo[]>
  startScan(input: ScanInput): Promise<{ scanId: string }>
  cancelScan(scanId: string): Promise<{ ok: boolean }>
  /** v0.1 暂停 / 继续（暂停不丢树、不丢计数；暂停中按取消照样生效） */
  pauseScan(scanId: string): Promise<{ ok: boolean }>
  resumeScan(scanId: string): Promise<{ ok: boolean }>
  /** v0.1：导出标准化 JSON 扫描报告（主进程弹保存框；取消也回 ok:false） */
  exportScanReport(scanId: string): Promise<{ ok: boolean; path?: string; error?: string }>
  getSnapshot(scanId: string): Promise<ScanSnapshot | null>
  /**
   * §15：这次扫描跳过了哪些路径（有界清单 + 四类计数）。**只读查询**，吃主进程内存里的记账，
   * 零 syscall。取消掉的那趟照样问得出（清单跟着扫描任务活到任务本身结束）。
   */
  getSkipped(scanId: string): Promise<SkippedWire | null>
  getChildren(scanId: string, dirId: number, sizeBasis?: string): Promise<ChildrenPayload | null>
  /**
   * Task 7「排除该目录」：**只改视图**。它让那个目录从地图相应的那一层消失，
   * 不停止扫描、不删任何东西、也不改清理预估读的完整口径（`childrenOf`）—— 这条由
   * `tests/unit/rules-engine.test.ts` 末尾的安全哨兵钉着：排除前后三条计价口径每个数字一字不变。
   * `ok:false` = 这条没被接受（扫描根不许排除、id 不在树上、会话没了），渲染端据此不重画、并如实说。
   */
  setExcluded(scanId: string, dirId: number, excluded: boolean): Promise<{ ok: boolean }>
  /** 一次性清掉本轮全部排除（侧栏那句「清除全部排除」）。 */
  clearExclusions(scanId: string): Promise<{ ok: boolean }>
  /**
   * §9 目录统计（最大文件 / 最大子目录）。**只读查询**：它吃的是主进程内存里那棵树，
   * 零 syscall，也不给渲染进程任何新的执行能力。未知 dirId 回落到根；扫描会话没了才回 null。
   */
  getDirStats(scanId: string, dirId: number): Promise<DirStatsWire | null>
  /** §17：报告 + 用户选择 → 预估释放空间（可选同时给出「确认」回执）。只读，没有执行入口。 */
  /**
   * §3.6 开发环境页的只读视图：谁装了、每行允许出现哪些控件、这一行量到了多少字节。
   * `scanId` 为 null（还没扫过）时只回装没装与动作面，字节格一律 null —— 而不是回一排 0 骗人。
   * 没有任何执行入口跟着它：删不删仍只走 `previewCleanup` → `executeCleanup` 那条链。
   */
  getDevEnvView(scanId: string | null): Promise<DevEnvViewWire>
  previewCleanup(scanId: string, req: PreviewRequest): Promise<PreviewPayload | null>
  /**
   * §18：执行一次**已确认**的预览。`confirmationDigest` 必须是 `previewCleanup` 回执里的 digest，
   * 路径由服务端从工作单取；渲染进程自己报的路径一律不作数（只能收窄成子集）。
   */
  executeCleanup(req: CleanExecuteIpcRequest): Promise<CleanExecuteResult>
  /**
   * 一键清理（2026-10-24 改口径）：**调用方报勾选，服务端报结局**。
   *
   * 与旧版（M6）的差别，三条都要记住：
   * 1. **不再有设置开关**（`autoCleanEnabled` 已删）。旧的那道总闸会让这次调用
   *    直接回 `E_AUTO_CLEAN_DISABLED`，而那句话渲染在页面底部 —— 滚出屏幕之后
   *    与「按钮坏了」长得一模一样，那正是本次要修的症状。
   * 2. **名单从调用方来**（`selection.items` 的 ruleId + `tilePaths`），不再是服务端固定名单。
   *    但报的仍然只是「勾了哪几条规则」—— 具体路径由服务端从报告里按认领表取，
   *    渲染端一个字节的清单都插不进来，这条边界与 `executeCleanup` 完全一致。
   * 3. **仍然是真删**（不进回收站）。
   *
   * 逐条进度走 `onCleanProgress`（`dc://clean-progress`），收尾结果走 `onCleanEvent`。
   */
  runAutoClean(
    scanId: string,
    selection: PreviewSelection,
    tilePaths?: readonly string[]
  ): Promise<CleanExecuteResult>
  /**
   * 设置：读那份**已经过 `sanitizeSettings` 清洗**的值。主进程保证回的是合法区间内的整份对象，
   * 所以渲染端拿到 `NaN` / `undefined` 这一件事不可能发生 —— 界面那一格不许再自己兜一次底，
   * 兜底散在两处就是两套口径（判据只有 `shared/settings.ts` 那一份）。
   */
  getSettings(): Promise<AppSettings>
  /**
   * 设置：写半个 patch，回**存下来之后的整份值**（不是 `ok:true`）。
   *
   * 为什么回执是整份：那一格控件显示的必须是服务端真正记住的那个数。服务端把 99999 夹成 1024
   * 之后如果界面照显示 99999，用户看到的就是一个文件里并不存在的值 —— 本仓点名的
   * 「看着接上了其实没有」正是这个形状。写失败时这条是 **reject**（`E_SETTINGS_WRITE`），
   * 不返回一个"看起来存好了"的对象：设置页那句「保存失败」全靠它。
   */
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  /**
   * 选一张图当背景壁纸（2026-10-27）。
   *
   * 回三态，**每一态在界面上的说法都不一样**：
   * - `{ok:true, cancelled:false, wallpaper:'file:<名>', name}` —— 已复制进应用数据目录并落盘；
   * - `{ok:true, cancelled:true}` —— 用户按了取消。**不是错误**，界面一个字都不该变；
   * - `{ok:false, cancelled:false, error:'E_WALLPAPER_…'}` —— 真失败（类型不对/读不到/复制失败）。
   *
   * 为什么不 reject 取消：设置页那条 `.catch` 会说「操作失败」，
   * 而那正是"我点了取消"被念成"程序坏了"的形状。
   */
  pickWallpaper(): Promise<
    | { ok: true; cancelled: true }
    | { ok: true; cancelled: false; wallpaper: string; name: string }
    | { ok: false; cancelled: false; error: string }
  >
  /**
   * M4 离线授权：读那份**只读**的状态。服务端不建目录、不生成设备密钥 ——
   * 后者不是洁癖：一次「查状态」要是能把私钥生出来，一份外来 `license.dat` 就会在本机
   * 变成本机的，设备绑定整个被绕过去。
   *
   * 不带这个功能的构建（今天的 Electron 线）**reject `E_NOT_IMPLEMENTED: …`**，
   * 而不是回一个 `{state:'unlicensed'}`：后者会让授权卡画出一句假话「这台机器还没激活」。
   */
  getLicenseStatus(): Promise<LicenseStatusWire>
  /**
   * M4：用一个激活码激活本机。这条**会写两个文件**（DPAPI 保护的 `device.key` + `license.dat`），
   * 是授权那一侧唯一的写入口。失败不抛、回 `ok:false` + 那句具名原因（界面上「激活失败」
   * 那一行全靠它），并带回失败前那一份状态。
   */
  activateLicense(code: string): Promise<LicenseActivateResult>
  /**
   * 「关于」那一块的数据源：**只有版本号**（`app.getVersion()`）。
   * 这一条是在给那块地方划边界 —— 往那一块加的每一行都得是当场取得到的事实。
   * 已注册清理规则数今天拿不到（`BUILTIN_RULES` 住在主进程侧，没有任何通道把它报出去），
   * 所以界面上不许出现那一行。
   */
  getAppVersion(): Promise<string>
  /**
   * 这台机器的并行能力（2026-10-29）。今天是 `{ logicalCores }`。
   *
   * **真读者**是设置页「删除速率」那格滑块 —— 它要拿逻辑核数当**阈值**：
   * 拉到阈值之外弹一句、然后自动拉回。渲染端自己算不出来
   * （`navigator.hardwareConcurrency` 是 WebView2 那个进程看到的数，与 Rust
   * `available_parallelism` 不是同一个来源，在开了 CPU 组的机器上会给出两个答案）。
   *
   * **读不到时不抛**：回 `{ logicalCores: 1 }`（最保守那一档）。
   * 那一格读不到核数不该让整页设置白屏。
   */
  getHardware(): Promise<{ logicalCores: number }>
  /** §28 原则六：批中途取消。已删的不复活，剩下的不再碰。 */
  cancelCleanup(taskId: string): Promise<{ ok: boolean }>
  getCleanupTask(taskId: string): Promise<CleanTask | null>
  listCleanupTasks(): Promise<CleanTask[]>
  /**
   * 清理日志（2026-10-25 重做）：**一次清理一条**，倒序，30 天窗口外的不回。
   *
   * 旧的 `getCleanJournal(filter) -> JournalPage` 已删：那一版的数据源是
   * 「一个文件一行、只在内存」的账本，整套换掉了。
   */
  journalRuns(): Promise<CleanRun[]>
  /**
   * 详情页**第一层**目录汇总（懒加载第一段）。
   *
   * 为什么不一次给全部文件：那趟 750.9 MB 的真实清理删了 17,143 个，
   * 一次拉会让首屏等好几秒，而用户第一眼只需要知道「哪些目录被清了、各多大」。
   */
  journalDirTree(runId: string): Promise<JournalDirSummary[]>
  /** 某个目录的**下一层**（懒加载：点开一层拉一层）。 */
  journalDirChildren(runId: string, dir: string): Promise<JournalDirEntry[]>
  onCleanEvent(cb: (e: CleanEvent) => void): () => void
  /**
   * 清理的**逐条**进度（2026-10-24）。清理弹窗靠它滚那串文件路径。
   * 与 `onCleanEvent` 同时订：进度用这条、收尾结果用那条。
   */
  onCleanProgress(cb: (e: CleanProgressEvent) => void): () => void
  revealInExplorer(absPath: string): Promise<void>
  openItem(absPath: string): Promise<void>
  onScanEvent(cb: (e: ScanEvent) => void): () => void
}
