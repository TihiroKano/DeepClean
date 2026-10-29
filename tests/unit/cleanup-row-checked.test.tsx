/**
 * `rowChecked` —— 「勾选框该不该显示成已勾」的判据。
 *
 * ## 它挡住的那件事（人类伙伴 2026-10-25 的原话）
 *
 * > 「点击勾选后会出现延迟，勾没显示出来，也未计入。」
 *
 * 截图里那 6 行全都没勾、全都没计入 —— 与这句话逐字对得上。
 *
 * 读代码读出来的时序：复选框原来写 `checked={i.selected}`，而 `i.selected` 是**服务端
 * 按 `selection` 算出来的**（`core/rules/preview.ts:218`）。于是点击之后：
 *
 * ```
 * onChange → toggle() → App.selected 变 → usePreview 发 dc_preview → 等回包
 *        → payload 换成新模型 → checked 才变
 * ```
 *
 * 中间那一段屏幕上没有任何变化。回包一慢，用户读到的就是「点了没反应」。
 *
 * ## 为什么不是简单改成 `selected.includes(ruleId)`
 *
 * 那会把服务端那份 `selected` 整个丢掉，而它有两个地方还在用：
 *  · `modelMatchesSelection` 逐条对账服务端字段判"模型是否已反映勾选"（
 *    `cleanup-settling.test.tsx` 那一组）—— 混掉它，"模型还没回来"与"模型说没勾"会变成一件事；
 *  · 首屏那一相：模型回来前 `selected` 可能已是自动打勾的结果。
 *
 * 所以只改**显示**这一层：本地优先，服务端兜底。
 */
import { describe, expect, it } from 'vitest'
import { rowChecked } from '../../src/renderer/pages/Cleanup'
import type { PreviewItem } from '../../shared/types'

const item = (over: Partial<PreviewItem> & { ruleId: string }): PreviewItem => ({
  name: over.ruleId,
  description: '',
  category: 'temp',
  riskLevel: 'safe',
  cleanStrategy: 'delete-all',
  recoverable: true,
  selected: false,
  included: false,
  bytes: 4096,
  files: 3,
  scope: 'rule',
  paths: [],
  findingBytes: 4096,
  findingFiles: 3,
  sampleTruncated: false,
  matchedRoots: [],
  refusal: null,
  ...over
})

describe('rowChecked：勾选框以本地勾选为准，不等服务端回包', () => {
  it('① 本地勾了、服务端还没回包（selected=false）⇒ 立刻显示已勾', () => {
    // 这就是缺陷本体的那一帧：点了，但模型还是旧的
    expect(rowChecked(item({ ruleId: 'a', selected: false }), ['a'])).toBe(true)
  })

  it('② 本地没勾、服务端也说不勾 ⇒ 不勾（稳态）', () => {
    expect(rowChecked(item({ ruleId: 'a', selected: false }), [])).toBe(false)
  })

  it('③ 本地没勾、服务端说勾了 ⇒ 听服务端的（回包刚到、本地还没点的那一瞬）', () => {
    // 首屏自动打勾走这一格：selected 里先有它，模型回来前也要显示成勾上
    expect(rowChecked(item({ ruleId: 'a', selected: true }), [])).toBe(true)
  })

  it('④ 两边一致时答案唯一（不许因为合并逻辑出现第三种状态）', () => {
    expect(rowChecked(item({ ruleId: 'a', selected: true }), ['a'])).toBe(true)
    expect(rowChecked(item({ ruleId: 'a', selected: false }), [])).toBe(false)
  })

  it('⑤ 逐条独立：勾一条不影响另一行', () => {
    // 两条的服务端字段都跟着本地走 —— 这里要量的是"逐条独立"，
    // 不是服务端兜底（那由 ③ 单独量）
    const a = item({ ruleId: 'a', selected: true })
    const b = item({ ruleId: 'b', selected: false })
    expect(rowChecked(a, ['a'])).toBe(true)
    expect(rowChecked(b, ['a'])).toBe(false)
  })

  it('⑥ 列表里没有的 id 也不该把任何一行点亮（反向半边）', () => {
    expect(rowChecked(item({ ruleId: 'a', selected: false }), ['zzz'])).toBe(false)
  })

  /**
   * 反面对照：这条判据必须**真的看本地那一格**。
   * 如果它其实只返回 `item.selected`（也就是修之前的形状），① 会变 false ——
   * 而 ① 正是整件事的要害：点了之后勾不显示。
   */
  it('对照：只翻本地勾选、服务端字段不动，答案必须换', () => {
    const serverSaysNo = item({ ruleId: 'a', selected: false })
    expect(rowChecked(serverSaysNo, [])).toBe(false)
    expect(rowChecked(serverSaysNo, ['a'])).toBe(true)
  })

  it('对照：只翻服务端字段、本地不动，答案也要换（否则它没在看服务端兜底）', () => {
    expect(rowChecked(item({ ruleId: 'a', selected: false }), [])).toBe(false)
    expect(rowChecked(item({ ruleId: 'a', selected: true }), [])).toBe(true)
  })
})
