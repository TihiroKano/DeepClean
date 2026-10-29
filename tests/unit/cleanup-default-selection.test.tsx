/**
 * §3.5「一键全选永远不包含 AI 模型文件」—— 这条要的是**结构性**，不是"界面上少画一个复选框"。
 *
 * 形状与 V0.6/V0.7 那几条同一个先例：判据住在服务端（`core/rules/registry.ts` 声明 +
 * `core/rules/preview.ts` 抄进模型），渲染端只消费一份算好的清单。所以这里测的是
 * `selectableRuleIds()` 这个纯函数**确实把那张表当输入**，而不是 grep 一句 `Cleanup.tsx` 里
 * 有没有写 huggingface —— 后者只证明字面量还在文件里，不证明它参与了判定。
 *
 * 第三条用例守的是这次改动最容易犯的错：新加的过滤器把两条**既有**的排除条件顶掉
 * （🔴 不可达、以及被豁免表点名的那一族）。那一旦从这段逻辑里掉出去，
 * 后果是"全选"能选中一个永远删不掉的行。
 *
 * ~~`dup:` 前缀由重复文件页单点控制~~ —— 重复文件检测（§20）下线后那一族行不再存在，
 * 这条反面对照跟着撤；🔴 不可达那一条与豁免表精确匹配那一条一字未动。
 */
import { describe, expect, it } from 'vitest'
import { selectableRuleIds } from '../../src/renderer/pages/Cleanup'
import type { PreviewItem } from '../../shared/types'

const item = (over: Partial<PreviewItem> & { ruleId: string }): PreviewItem => ({
  name: over.ruleId,
  // M5-P1 T5a：这一族用例测的是「哪些行能被一键全选点上」，读的是 ruleId/riskLevel/exemption，
  // 不读文案 —— 空串是**这条用例没有文案**，不是"文案为空也能显示"。文案到不到得了界面由
  // `rules-preview.test.ts` 的 `every_item_carries_its_rule_description` 钉，T5b 才轮到渲染端。
  description: over.description ?? '',
  category: 'dev-cache',
  riskLevel: 'caution',
  cleanStrategy: 'delete-all',
  recoverable: true,
  selected: false,
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

describe('§3.5 默认全选的豁免表是判定输入，不是渲染细节', () => {
  const items = [
    item({ ruleId: 'windows-temp' }),
    item({ ruleId: 'huggingface-cache' }),
    item({ ruleId: 'npm-cache' })
  ]

  it('被点名的规则进不了全选清单，其余一条不少', () => {
    expect(selectableRuleIds(items, ['huggingface-cache'])).toEqual(['windows-temp', 'npm-cache'])
  })

  it('豁免表为空时与今天逐条相同（一个都不误伤）', () => {
    expect(selectableRuleIds(items, [])).toEqual(['windows-temp', 'huggingface-cache', 'npm-cache'])
  })

  it('既有的排除不许被新过滤器顶掉：🔴 仍然勾不动', () => {
    const mixed = [...items, item({ ruleId: 'recycle-bin', riskLevel: 'forbidden' })]
    expect(selectableRuleIds(mixed, [])).toEqual(['windows-temp', 'huggingface-cache', 'npm-cache'])
    // 反向半边：豁免表里写一个 🔴 规则，不改变它本来就被排除的事实（不许因此变成"可选"）
    expect(selectableRuleIds(mixed, ['recycle-bin'])).toEqual(['windows-temp', 'huggingface-cache', 'npm-cache'])
  })

  it('豁免表按 ruleId 精确匹配，不做前缀 / 大小写模糊匹配（拼错的 id 不许顺手多摘一条）', () => {
    expect(selectableRuleIds(items, ['huggingface'])).toEqual([
      'windows-temp',
      'huggingface-cache',
      'npm-cache'
    ])
    expect(selectableRuleIds(items, ['HUGGINGFACE-CACHE'])).toEqual([
      'windows-temp',
      'huggingface-cache',
      'npm-cache'
    ])
  })
})
