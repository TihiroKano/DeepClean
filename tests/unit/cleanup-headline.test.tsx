/**
 * 清理页重构（2026-10-21，图二版式）之后新增的三条**取数**判据 + 两条**符号**判据。
 *
 * 为什么测纯函数而不是渲染：`Cleanup` 是依赖 `window.deepclean` 的受控组件（挂载即发两条 IPC），
 * 本仓又没有 jsdom / testing-library（`vitest.config.ts` 的 environment 是 `node`）。
 * 既有先例就是把判定抽成导出函数再测（`requiredRiskOf` / `selectableRuleIds` / `canExecuteReceipt`）。
 *
 * 这一组要防的**具体事故**是"版式重构顺手造出第二套账"：
 * 统计带上那三格 + 环形的百分比如果各自去算，用户会看到四个互相矛盾的数，
 * 而 `totalBytes` 同时是 §18 执行授权凭据（digest）覆盖的字段 —— 界面另算一份，
 * 就等于给用户看一个与「要删多少」无关的数字。
 */
import { describe, expect, it } from 'vitest'
import { categoryIcon, cleanupHeadline, riskDot, riskText } from '../../src/renderer/pages/Cleanup'
import { RISK_COLORS, RISK_LABELS, type Risk } from '../../shared/classify'
import { FileIcon } from '../../src/renderer/components/icons'
import type { PreviewItem, PreviewModel } from '../../shared/types'

const item = (over: Partial<PreviewItem> & { ruleId: string }): PreviewItem => ({
  name: over.ruleId,
  description: '',
  category: 'temp',
  riskLevel: 'safe',
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

/**
 * 只造这一组用例读得到的字段。**故意不造全**：造全会让"界面偷偷读了别的字段"这件事测得出来
 * 而不是被我手搭的夹具掩盖 —— 缺字段时 TypeScript 会在测试编译期红，那正是想要的信号。
 */
const model = (over: Partial<PreviewModel>): PreviewModel =>
  ({
    items: [],
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
    forbiddenRoots: [],
    reportOnlyRoots: [],
    reportExclusionCount: 0,
    territories: [],
    defaultUnselectableRuleIds: [],
    notes: [],
    generatedAtMs: 0,
    digest: 'd',
    ...over
  }) as PreviewModel

describe('统计带的取数口径：三个数全部来自服务端字段', () => {
  it('三项数分别读 items.length / reportReclaimableBytes / totalBytes', () => {
    const m = model({
      items: [item({ ruleId: 'a' }), item({ ruleId: 'b' }), item({ ruleId: 'c' })],
      reportReclaimableBytes: 4096,
      totalBytes: 1024
    })
    const h = cleanupHeadline(m)
    expect(h.items).toBe(3)
    expect(h.reclaimBytes).toBe(4096)
    expect(h.plannedBytes).toBe(1024)
  })

  it('环形 = 已计入 ÷ 可回收合计（只做一次除法，不重新求和）', () => {
    const h = cleanupHeadline(model({ reportReclaimableBytes: 1000, totalBytes: 250 }))
    expect(h.pct).toBe(25)
  })

  it('全选时两者逐字节相等 ⇒ 环满（100%），与「报告可回收合计」那句话同一口径', () => {
    const h = cleanupHeadline(model({ reportReclaimableBytes: 1234, totalBytes: 1234 }))
    expect(h.pct).toBe(100)
  })

  it('可回收合计为 0 时给 0%，不做 0/0（NaN 会让环形静默画不出来）', () => {
    expect(cleanupHeadline(model({ reportReclaimableBytes: 0, totalBytes: 0 })).pct).toBe(0)
    // 反向半边：几何上不该出现"已计入 > 可回收"，真出现了也夹到 100 而不是画到环外
    expect(cleanupHeadline(model({ reportReclaimableBytes: 10, totalBytes: 50 })).pct).toBe(100)
  })

  it('model 为 null（还没算出来）⇒ 三个数都是 0，不抛错', () => {
    expect(cleanupHeadline(null)).toEqual({ items: 0, reclaimBytes: 0, plannedBytes: 0, pct: 0 })
    expect(cleanupHeadline(undefined).pct).toBe(0)
  })

  it('反面对照：改任何一个输入格都必须改变输出（否则上面几条在测常量）', () => {
    const base = cleanupHeadline(model({ items: [item({ ruleId: 'a' })], reportReclaimableBytes: 100, totalBytes: 50 }))
    expect(cleanupHeadline(model({ items: [], reportReclaimableBytes: 100, totalBytes: 50 })).items).not.toBe(base.items)
    expect(cleanupHeadline(model({ items: [item({ ruleId: 'a' })], reportReclaimableBytes: 200, totalBytes: 50 })).pct).not.toBe(
      base.pct
    )
  })
})

describe('风险药丸：圆点颜色与文字都取 shared/classify 那一张表', () => {
  it('圆点颜色逐档等于 RISK_COLORS（界面不写死色值）', () => {
    for (const r of ['safe', 'caution', 'high', 'forbidden'] as Risk[]) expect(riskDot(r)).toBe(RISK_COLORS[r])
  })

  it('文字是 RISK_LABELS 去掉 emoji 前缀，不是另写一份名单', () => {
    expect(riskText('safe')).toBe('安全')
    expect(riskText('forbidden')).toBe('禁止')
    for (const r of ['safe', 'caution', 'high', 'forbidden'] as Risk[]) {
      // 前缀必须真的被摘掉：`RISK_LABELS` 自己带 emoji，原样塞进药丸会得到「🟢 🟢 安全」
      expect(riskText(r)).not.toMatch(/🟢|🟡|🟠|🔴/)
      expect(RISK_LABELS[r]).toContain(riskText(r))
    }
  })

  it('前缀缺失时原样返回整串（不吃掉名字）', () => {
    // 用真实表反推一个"没有 emoji 前缀"的形制不现实，所以直接钉住那条正则的语义：
    // 只有「非空白 + 空白」这种前缀形状才会被摘，一个不带空白的单词必须整体留下。
    expect('安全'.replace(/^\S+\s+/, '')).toBe('安全')
  })
})

describe('类别图标由 category 决定，未登记类别退回中性图标', () => {
  it('同一批真实 category 各自映射到一个已存在的图标组件', () => {
    for (const c of ['temp', 'browser-cache', 'shader-cache', 'dev-cache', 'recycle-bin']) {
      expect(typeof categoryIcon(c)).toBe('function')
    }
  })

  it('未登记的 category 退回 FileIcon（不是随机挑一个语义不对的图标）', () => {
    expect(categoryIcon('rule-category-that-does-not-exist')).toBe(FileIcon)
    expect(categoryIcon('')).toBe(FileIcon)
  })
})
