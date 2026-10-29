import { describe, expect, it } from 'vitest'
import { formatBytes, formatCount, formatDate, formatElapsed } from '../../shared/format'

describe('formatBytes（§7 82.3 GB 风格）', () => {
  it.each([
    [0, '0 B'],
    [999, '999 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 ** 2, '1.0 MB'],
    [1024 ** 3, '1.0 GB'],
    [82.3 * 1024 ** 3, '82.3 GB'],
    [1024 ** 4, '1.0 TB']
  ] as const)('%i -> %s', (n, s) => expect(formatBytes(n)).toBe(s))
  it('负数与 NaN 不抛', () => {
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})

describe('formatCount / formatDate', () => {
  it('千分位', () => expect(formatCount(1283492)).toBe('1,283,492'))
  it('时间戳', () =>
    expect(formatDate(new Date(2026, 8, 25, 22, 51, 0).getTime())).toBe('2026-09-25 22:51'))
  it('0 显示为占位', () => expect(formatDate(0)).toBe('—'))
})

// 计划 Step 1 的清单只覆盖 formatBytes/formatCount/formatDate，
// formatElapsed 同样是 §7 HUD 要用的公开出口，这里补齐表意。
describe('formatElapsed（§7 耗时显示）', () => {
  it.each([
    [0, '0s'],
    [-5000, '0s'],
    [45_000, '45s'],
    [65_000, '1m 05s'],
    [600_000, '10m 00s'],
    [3_723_000, '1h 02m']
  ] as const)('%i -> %s', (n, s) => expect(formatElapsed(n)).toBe(s))

  // 亚秒档：M6 验收实测十万级夹具 elapsedMs=938 / 677，
  // 旧口径 `Math.round(ms/1000)` 把这一档全压成 `0s` ⇒ 用户读到「用时 0s」，
  // 而那趟扫描是真的跑完了。三位小数位不许四舍五入到 `1s`（938ms 说成 1s 是编的）。
  it.each([
    [1, '0s'], // 1ms：两位小数下去是 0.00 ⇒ 落回 0s，不显示 `0.00s`
    [100, '0.1s'],
    [499, '0.5s'],
    [500, '0.5s'],
    [677, '0.68s'], // M6 实测值（新包内 exe 复跑闸那一趟）
    [938, '0.94s'], // M6 实测值（`elapsed_ms` 冻结那一格的修后读数）
    [999, '1s'], // 999ms 两位小数 = 1.00 ⇒ 进整秒档，与 `1s` 同形不重复
    [1000, '1s'],
    [1499, '1s'] // 边界：1499ms 仍按整秒显示，不越到 `2s`
  ] as const)('亚秒档 %i -> %s', (n, s) => expect(formatElapsed(n)).toBe(s))

  it('亚秒档不给假精度：永远不超过两位小数', () => {
    for (const ms of [7, 13, 99, 123, 456, 678, 999]) {
      const t = formatElapsed(ms)
      const dec = t.replace(/s$/, '').split('.')[1] ?? ''
      expect(dec.length, `${ms}ms 显示成 ${t}`).toBeLessThanOrEqual(2)
    }
  })

  it('非数字与 NaN 不抛', () => {
    expect(formatElapsed(Number.NaN)).toBe('0s')
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('0s')
  })
})
