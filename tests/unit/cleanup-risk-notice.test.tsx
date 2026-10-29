/**
 * M5-P1 T5b：确认时按下的档位必须等于**已计入项里的最高档**。
 *
 * 为什么测纯函数而不是渲染：这个仓库没有 jsdom / testing-library（`vitest.config.ts` 的
 * environment 是 `node`），而既有先例就是把判定抽成导出函数再测（`selectableRuleIds` 同形）。
 * 渲染端只消费这一个数。
 *
 * 这条判据要防的事故很具体：T4 把 `acknowledged_risk` 上了服务端之后，界面**并没有**跟着把它送出去
 * （`usePreview` 只发 `{ acknowledged }`），于是主进程用 `unwrap_or(Caution)` 兜底 ——
 * 含 🟠 的预估会**永久**回 `risk-not-acknowledged`，用户看得见报错、却没有任何办法让它通过。
 * 那是"闸门装了、把手没接上"的形状。下面第 1 与第 4 条用例正是那两半。
 */
import { describe, expect, it } from 'vitest'
import { requiredRiskOf } from '../../src/renderer/pages/Cleanup'
import type { PreviewItem } from '../../shared/types'

const item = (over: Partial<PreviewItem> & { ruleId: string }): PreviewItem => ({
  name: over.ruleId,
  description: '',
  category: 'app-transient',
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true,
  selected: true,
  included: true,
  bytes: 100,
  files: 1,
  scope: 'rule',
  paths: [],
  findingBytes: 100,
  findingFiles: 1,
  sampleTruncated: false,
  matchedRoots: [],
  refusal: null,
  ...over
})

describe('T5b 确认档位 = 已计入项的最高档', () => {
  it('含一条已计入的 🟠 ⇒ 必须按 high（按低了主进程就不出回执）', () => {
    const items = [item({ ruleId: 'windows-temp', riskLevel: 'safe' }), item({ ruleId: 'user-downloads-installers', riskLevel: 'high' })]
    expect(requiredRiskOf(items)).toBe('high')
  })

  it('🟠 只勾上但没被计入（被拒/未定价）⇒ 不许抬档，只看 included', () => {
    const items = [item({ ruleId: 'npm-cache', riskLevel: 'caution' }), item({ ruleId: 'user-downloads-installers', riskLevel: 'high', included: false })]
    expect(requiredRiskOf(items)).toBe('caution')
  })

  it('只有 🟢 ⇒ safe；空集合 ⇒ safe（与主进程 required_tier 返回 None 同一方向）', () => {
    expect(requiredRiskOf([item({ ruleId: 'windows-temp', riskLevel: 'safe' })])).toBe('safe')
    expect(requiredRiskOf([])).toBe('safe')
  })

  it('🔴 不许成为一个可确认的档位（它永不 included，但判据本身也不许返回 forbidden）', () => {
    expect(requiredRiskOf([item({ ruleId: 'recycle-bin', riskLevel: 'forbidden' })])).toBe('safe')
  })

  /**
   * 反向对照：同一批行只改 `included` 这一个开关，答案必须变。
   * 没有这一条，上面第 2 条可能只是因为"函数根本没看 included"而恰好通过 —— 那才是这次真正
   * 可能犯的错（把 `selected` 当 `included` 用，或干脆取全表最大值，两种写法都能过前四条）。
   */
  it('对照：翻 included 这一个开关就必须换档（否则前几条在测一个不参与判定的字段）', () => {
    const withHigh = [item({ ruleId: 'npm-cache', riskLevel: 'caution' }), item({ ruleId: 'user-downloads-installers', riskLevel: 'high' })]
    const withoutHigh = withHigh.map((i) => (i.riskLevel === 'high' ? { ...i, included: false } : i))
    expect(requiredRiskOf(withHigh)).toBe('high')
    expect(requiredRiskOf(withoutHigh)).toBe('caution')
    // 再钉一种错法：取全表最大值（不看 included）会在 withoutHigh 上仍返回 high
    expect(requiredRiskOf(withoutHigh)).not.toBe('high')
  })
})
