/**
 * §3.6 AI 那一行要的「检测到 N 个大模型文件（共 X GB）」。
 *
 * 这个模块只做两件纯事：**口径清单**，以及**把数配上它的出身**。
 * 数本身不在这里数 —— 它是在扫描途中由 `TreeStore.addFilesToDir` 顺带累加的
 * （`core/scan/tree-store.ts` 的 `countExts` / `extTotals()`），理由是一条实测而不是感觉：
 * 备选方案"点开页面时现扫一遍内存树"（`runAnalysis` 配 `topK: 0`）在同一棵 **30 万文件 /
 * 3 万目录**的树上要 **0.72–1.49 秒**，而这趟跑在**主进程**上（扫描事件流、Treemap 每 400 ms
 * 的 `childrenOf` 轮询、所有 IPC 处理器的宿主）。顺带累加的代价则落在噪声里：同一棵树建完，
 * 注入与不注入的建树耗时 2.44–2.66 s 对 2.69–2.74 s。两个读数都出自
 * `scripts/_bench-model-tally.mjs` —— 那是本地探针（仓库规矩是 `scripts/_*.mjs` 不入库），
 * 所以这一句是"现场引用"而不是"随克隆可复现"，换机器请重跑，别抄这里的名词。
 * 100 万文件那一档是**线性外推**（约 2.4–5 s），不是量到的数 —— 本机空闲内存不足以撑住那棵树。
 *
 * ### 为什么计数不是从榜里数出来的
 *
 * `topHeap` 容量 100（`core/scan/scanner.ts` 的 `topN ?? 100`），从榜里数出来的"个数"
 * 在一个装了 400 个权重的目录里会稳定念 100。所以这一格 V0.7 收工时是故意空着的。
 * 现在这条链与榜彻底无关：`addFilesToDir` 每见一个匹配的文件加一次，
 * 且在 `maxFiles` 截断闸**之前** —— 由 `tests/unit/tree-store-ext-counter.test.ts` 钉着。
 *
 * ### 口径：按扩展名，且刻意不含 `.bin`
 *
 * `.bin` 不是模型专属 —— `data.bin`、各类安装包、numpy 缓存都叫这个名，把它算进来，
 * 那一格的「共 X GB」就变成一堆不相干字节的合订本，而那正是本项目全程在躲的虚报形状。
 * **代价是少报**：早期 HF 检查点惯用的 `pytorch_model.bin` 不进这一格。
 * 宁可少报并把口径点名给用户（`extensions` 字段就是为这句话存在的），不可虚报。
 *
 * ### 扩展名判据不在这里重写
 *
 * 大小写归一、多重扩展名取最后一段，全部沿用 `extOf`（`core/fs/pathutil`）—— 也就是与
 * §3 文件类型统计表、`topHeap` 同一户口径。这里再造一份 `lastIndexOf('.')` 等于让两张表
 * 对"什么是 .gguf"各说一套，而它们会同屏出现。
 *
 * 本文件零 `node:` import（`tests/unit/analysis-engine.test.ts` 有一条覆盖 `core/analyze/`
 * 全部 .ts 的静态断言）。
 */
import type { ModelTallyWire, ScanStatus } from '../../shared/types'

/**
 * 哪些扩展名算"大模型文件"。带点小写、不重复 —— 三条各由用例钉着，因为 `extOf` 的产物就是
 * 小写带点串，这里破任何一条都会**静默漏计**（漏计在界面上长得像"这台机器没有"）。
 */
export const MODEL_FILE_EXTENSIONS: readonly string[] = [
  '.safetensors',
  '.gguf',
  '.ckpt',
  '.pt',
  '.pth',
  '.onnx',
  '.h5',
  '.tflite'
]

/** 扫描层交回来的两个数（`TreeStore.extTotals()` 的形状）。 */
export interface ExtTotals {
  count: number
  bytes: number
}

/** 这两个数是在什么处境下数出来的 —— 没有这一半，前面那两个数就是无主的两位数。 */
export interface ModelTallyEnv {
  /** 被扫的那棵树的根。未完 #4 那句「要说是哪棵树量的」用的就是它。 */
  rootPath: string
  /** 这棵树里见过的**全部**文件条数（分母：N 个权重是从 M 个文件里数出来的）。 */
  filesSeen: number
  /** 存储层因 `maxFiles` 丢过记录：条数仍是全量，但"这棵树"只是磁盘的一部分。 */
  truncated: boolean
  /**
   * 扫描状态**原样**带过去，不在这一层压成"完没完"一个布尔：
   * running / paused 与 cancelled / failed 在界面上是两句不同的话（前者还在长，后者已经不会长了），
   * 而 completed 是唯一能让那一格念成结论的一档。
   */
  scanStatus: ScanStatus
}

/** 线格式的形状住在 `shared/types.ts`（只有一个事实源），这里只沿用名字。 */
export type ModelTally = ModelTallyWire

/**
 * 坏数挡在这里，不在界面挡：`formatBytes(NaN)` 会印出 `NaN GB`，而那一格长得跟一句真话一模一样。
 * 与 `core/analyze/engine.ts` 对 `size` 的处理同一 posture（先验后计，坏值点名而不是静默吞）。
 */
const whole = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)

export function modelTallyFrom(totals: ExtTotals, env: ModelTallyEnv): ModelTally {
  return {
    count: whole(totals.count),
    bytes: whole(totals.bytes),
    rootPath: env.rootPath,
    filesSeen: env.filesSeen,
    truncated: env.truncated,
    scanStatus: env.scanStatus,
    extensions: MODEL_FILE_EXTENSIONS
  }
}
