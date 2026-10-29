/**
 * V0.3 分析层的告警账（Task 1，规格书 §13「异常数据不中断分析」+ §15「AnalysisWarning」）。
 *
 * 这里只有一条设计决定，但它是最容易出事故的那条：**先无条件计数，再考虑清单放不放得下。**
 * 清单只是计数器的前若干项，绝不允许反过来决定计数长多大 —— 与
 * `core/scan/tree-store.ts` 的 `addError`（`this.c[kind]++` 在判长度**之前**）同一份纪律，
 * 那条的先例注释写着：一个被截断的计数比没有计数更坏，因为它看起来像结论。
 * 所以 `total = 5,000 / sample.length = 200 / sampleOverflow = 4,800` 是正确状态；
 * 把 `total++` 挪进 `if (sample.length < MAX)` 里面就是这份文件存在的理由被反过来用
 * （`tests/unit/analysis-accumulators.test.ts` 的 WarningSink 那组用例守的就是这一条，Step 8 变异 #2 打它）。
 *
 * 四类告警都指向"分析层读到的树与自己预期不一致"，**都不改变已算出来的数**：
 * - `missing-node`：`childIds` / `ChildView.dirId` 指向树上不存在的节点 —— 只可能是内存树自己坏了
 *   （扫描层从不删节点），所以它点名的是"这一轮扫描不可信"，不是"某个目录没权限"；
 * - `bad-child`：`childrenOf` 抛错，或同一目录被两个父引用（疑似环 / 重复挂载）；
 * - `negative-size`：`size` 不是有限非负数（NaN / 负数 / Infinity），未计入求和；
 * - `budget-exhausted`：节点预算用尽，剩余子树未分析 —— 与 `AnalysisResult.partial` 同源，
 *   区别是这里能点名断在哪条路径上。
 *
 * 本文件零 `node:` import（`tests/unit/analysis-engine.test.ts` 有一条静态断言）。
 */

/** 清单上限。照 `MAX_DENIED_SAMPLE` 的先例：有界的是**名字**，不是**计数**。 */
export const MAX_WARNING_SAMPLE = 200

export type AnalysisWarningKind = 'missing-node' | 'bad-child' | 'negative-size' | 'budget-exhausted'

export interface AnalysisWarnings {
  total: number
  byKind: Record<AnalysisWarningKind, number>
  sample: Array<{ kind: AnalysisWarningKind; path: string; why: string }>
  sampleOverflow: number
}

export class WarningSink {
  private readonly s: AnalysisWarnings

  constructor() {
    this.s = { total: 0, byKind: { 'missing-node': 0, 'bad-child': 0, 'negative-size': 0, 'budget-exhausted': 0 }, sample: [], sampleOverflow: 0 }
  }

  add(kind: AnalysisWarningKind, path: string, why: string): void {
    // 顺序不许倒：计数先走，清单是它的前若干项（见文件头那段）
    this.s.total++
    this.s.byKind[kind]++
    if (this.s.sample.length < MAX_WARNING_SAMPLE) this.s.sample.push({ kind, path, why })
    else this.s.sampleOverflow = this.s.total - MAX_WARNING_SAMPLE
  }

  get total(): number {
    return this.s.total
  }

  /** 给 `AnalysisResult` 的那一份：**副本**，这份要过 IPC。 */
  snapshot(): AnalysisWarnings {
    return { ...this.s, byKind: { ...this.s.byKind }, sample: this.s.sample.slice() }
  }
}
