/**
 * `modelMatchesSelection` —— 「这一份模型是否已反映当前勾选」的判据。
 *
 * ## 它要挡住的那件事（人类伙伴 2026-10-21 的原话）
 *
 * > 「点击垃圾清理出现 loading，然后界面出来了，loading，自动清理执行自动打勾。
 * >  我需要优化成首次打开 Loading 加特效放中间放大些，然后界面出来就是自动打勾的页面。」
 *
 * 拆开是两个瞬间：
 *  ① 第一次 `previewCleanup` 发出去时 `selected` 是空的 ⇒ 回包是**全未勾选**的模型；
 *  ② 自动打勾 effect 把可清理项填进 `selected` ⇒ 第二次请求 ⇒ 回包才是该看到的那一页。
 *
 * 中间那份模型如果被画出来，用户先看到"什么都不勾"的页面（错的），再看到"都勾上了"（对的），
 * 外加第二段 Loading。这个函数的职责就是**认出中间那份**，让界面继续显示居中 Loading。
 *
 * ## 判据为什么用逐条对账，而不是拿 digest 比
 *
 * `PreviewModel.digest` 是**账目**的指纹（`core/rules/preview.ts` 的 `digestOf`），它覆盖的是
 * 字节/文件数那些字段，**不覆盖"谁被勾了"** —— 拿它比会得到"勾选变了而 digest 没变"，
 * 于是过渡态永远认不出来。`PreviewItem.selected` 才是服务端按 `selection` 算出来的那一格
 * （`preview.ts:218` 的 `selected = selectedRules.has(f.ruleId)`），逐条对账它才是真判据。
 */
import { describe, expect, it } from 'vitest'
import { modelMatchesSelection } from '../../src/renderer/pages/Cleanup'
import type { PreviewItem, PreviewModel } from '../../shared/types'

const item = (over: Partial<PreviewItem> & { ruleId: string }): PreviewItem => ({
  name: over.ruleId,
  description: '',
  category: 'temp',
  riskLevel: 'safe',
  cleanStrategy: 'delete-all',
  recoverable: true,
  selected: false,
  included: false,
  bytes: 0,
  files: 0,
  scope: 'rule',
  paths: [],
  findingBytes: 100,
  findingFiles: 1,
  sampleTruncated: false,
  matchedRoots: [],
  refusal: null,
  ...over
})

const model = (items: PreviewItem[], over: Partial<PreviewModel> = {}): PreviewModel =>
  ({
    items,
    refusals: [],
    totalBytes: 0,
    totalFiles: 0,
    riskBreakdown: {
      safe: { items: 0, files: 0, bytes: 0 },
      caution: { items: 0, files: 0, bytes: 0 },
      high: { items: 0, files: 0, bytes: 0 },
      forbidden: { items: 0, files: 0, bytes: 0 }
    },
    refusedBytes: 0,
    blocked: false,
    reportReclaimableBytes: 0,
    reportForbiddenBytes: 0,
    forbiddenRoots: ['C:\\Windows\\System32'],
    reportOnlyRoots: [],
    reportExclusionCount: 0,
    territories: [],
    defaultUnselectableRuleIds: [],
    notes: [],
    generatedAtMs: 0,
    digest: 'd',
    ...over
  }) as PreviewModel

const TWO = [item({ ruleId: 'a' }), item({ ruleId: 'b' })]

describe('modelMatchesSelection：认出"还没反映勾选"的那一份', () => {
  it('① 过渡态：模型里全未勾选，而勾选集合里有两个 ⇒ **不算对上**（这就是要被挡住的中间物）', () => {
    expect(modelMatchesSelection(model(TWO), ['a', 'b'])).toBe(false)
  })

  it('② 终态：模型的 selected 与勾选集合逐条一致 ⇒ 对上', () => {
    const m = model([item({ ruleId: 'a', selected: true }), item({ ruleId: 'b', selected: true })])
    expect(modelMatchesSelection(m, ['a', 'b'])).toBe(true)
  })

  it('③ 部分勾选也要对上（不是"必须全勾"才算）', () => {
    const m = model([item({ ruleId: 'a', selected: true }), item({ ruleId: 'b', selected: false })])
    expect(modelMatchesSelection(m, ['a'])).toBe(true)
    expect(modelMatchesSelection(m, ['a', 'b'])).toBe(false)
  })

  it('④ 取消勾选之后：模型仍标记 a 为 selected，而勾选集合是空的 ⇒ 不算对上', () => {
    const m = model([item({ ruleId: 'a', selected: true })])
    expect(modelMatchesSelection(m, [])).toBe(false)
  })

  it('⑤ 零命中：没有可勾的行 ⇒ 第一次回包就是终态，不许白等第二次', () => {
    expect(modelMatchesSelection(model([]), [])).toBe(true)
    // 但勾选集合里有东西而模型是空的 ⇒ 那份模型不是按它算的
    expect(modelMatchesSelection(model([]), ['a'])).toBe(false)
  })

  it('⑥ blocked 时一律算对上：那种模型整份不出结论，勾选状态没有意义', () => {
    // blocked 的模型 totalBytes 恒 0、items 可能全未勾选，但那不是"过渡态"
    expect(modelMatchesSelection(model(TWO, { blocked: true }), ['a', 'b'])).toBe(true)
  })

  it('⑦ payload 还没到（null / undefined）⇒ 不算对上（那是 Loading 态，另走分支）', () => {
    expect(modelMatchesSelection(null, ['a'])).toBe(false)
    expect(modelMatchesSelection(undefined, [])).toBe(false)
  })

  /**
   * 反面对照：这条判据必须**真的看 `selected`**。
   * 如果它其实只检查"两边 id 集合相等"（一个很容易写出来的错法），① 就会变成 true ——
   * 而 ① 正是整件事的要害。
   */
  it('对照：只改 `selected` 这一个字段就必须换答案（否则它没在看勾选状态）', () => {
    const unselected = model([item({ ruleId: 'a', selected: false })])
    const selected = model([item({ ruleId: 'a', selected: true })])
    expect(modelMatchesSelection(unselected, ['a'])).toBe(false)
    expect(modelMatchesSelection(selected, ['a'])).toBe(true)
  })

  it('对照：id 集合相同但勾选状态相反，两条判据必须分得开', () => {
    const m = model([item({ ruleId: 'a', selected: false })])
    // 这一条如果通过，说明"集合相等"就够了 —— 那样 ① 永远漏过去
    expect(modelMatchesSelection(m, ['a'])).toBe(false)
    expect(modelMatchesSelection(m, [])).toBe(true)
  })
})
