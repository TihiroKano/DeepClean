/**
 * 清理日志列表（2026-10-25 重做后；2026-10-27 保留窗口那句话搬家）。
 *
 * 与 `license-card.test.tsx` 同一条路子：node 环境 + `renderToStaticMarkup` 渲染**纯呈现层**，
 * 断言真实 HTML 文本（本仓没装 jsdom，也不为这件事引新依赖）。
 *
 * 容器 `CleanHistory`（带 `useEffect` 取数）不在这里测 —— 它由真机验收那一层负责。
 * 这里钉的是**那几句会被用户读到的话**：
 *
 * 1. 格式：「某年某月某日 某时 在 X 盘 清理 XX 大小」—— 人类伙伴原话。
 * 2. 空态说的是「清理日志」。
 * 3. **保留窗口那句话在单独一块**（`JournalRetentionNote`），不在空态里 ——
 *    2026-10-27 人类伙伴要求「清理日志下方加一段话：日志仅保留30天，自动删除」。
 *    位置从"只在空态说"改成"列表下方两块共用"：塞在空态里等于**只有还没有日志的人知道**，
 *    而真正需要知道的是已经有几十条、正指望它当长期记录的那位。
 * 4. 单盘不写「与」、多盘才写。
 *
 * 时间一律用**本地**构造（`new Date(y, m, d, h, min)`），不用 ISO 字符串 ——
 * 后者按 UTC 解析，测试机换个时区就差几个小时，那是测试环境的问题不是产品的。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  JournalEmpty,
  JournalRetentionNote,
  JournalRow,
  formatDrives,
  formatWhen,
  formatRunHeader,
} from '../../src/renderer/pages/CleanHistory'
import type { CleanRun } from '../../shared/types'

const run = (over: Partial<CleanRun> = {}): CleanRun => ({
  id: 'r1',
  endedAtMs: new Date(2026, 9, 25, 15, 30).getTime(),
  drives: ['C:\\', 'D:\\'],
  freedBytes: 787400211,
  fileCount: 17143,
  files: [],
  ...over,
})

describe('清理日志的一行', () => {
  it('格式是「日期 在 两个盘 清理 大小」，并带文件数', () => {
    const html = renderToStaticMarkup(<JournalRow run={run()} onOpenDetail={() => {}} />)
    expect(html).toContain('2026年10月25日 15:30')
    expect(html).toContain('在')
    expect(html).toContain('C:\\ 与 D:\\')
    expect(html).toContain('清理')
    expect(html).toContain('750.9 MB')
    expect(html).toContain('17,143 个')
    expect(html).toContain('详情')
  })

  it('只有一个盘时不写「与」', () => {
    const html = renderToStaticMarkup(
      <JournalRow run={run({ drives: ['C:\\'] })} onOpenDetail={() => {}} />
    )
    expect(html).toContain('C:\\')
    expect(html).not.toContain('与')
  })

  it('推不出盘符（UNC）时不硬编那句话', () => {
    const html = renderToStaticMarkup(
      <JournalRow run={run({ drives: [] })} onOpenDetail={() => {}} />
    )
    expect(html).not.toContain('在')
    expect(html).toContain('750.9 MB')
  })
})

describe('空态与保留窗口那句话', () => {
  it('空态说的是「还没有清理日志」，且不再重复保留窗口（那句话搬到列表下方）', () => {
    const html = renderToStaticMarkup(<JournalEmpty />)
    expect(html).toContain('还没有清理日志')
    // 反面对照：30 天不许再出现在空态里 —— 否则两处各说一遍，改一处另一处会静默不动
    expect(html).not.toContain('30 天')
  })

  it('列表下方那一块必须说清「仅保留 30 天」与「自动删除」', () => {
    const html = renderToStaticMarkup(<JournalRetentionNote />)
    expect(html).toContain('30 天')
    expect(html).toContain('自动删除')
    // 人类伙伴 2026-10-27 原话是「日志仅保留30天，自动删除」——
    // 「仅」字是这句话的分量所在（"会删"与"只留 30 天"是两种预期）
    expect(html).toContain('仅保留')
  })

  it('对照：两个组件说的是两件事，不许互相包含', () => {
    const empty = renderToStaticMarkup(<JournalEmpty />)
    const note = renderToStaticMarkup(<JournalRetentionNote />)
    expect(empty).not.toBe(note)
    expect(note).not.toContain('还没有清理日志')
  })
})

describe('格式化的纯函数', () => {
  it('单盘不加「与」', () => {
    expect(formatDrives(['C:\\'])).toBe('C:\\')
  })

  it('两个盘用「与」，三个盘用顿号加与', () => {
    expect(formatDrives(['C:\\', 'D:\\'])).toBe('C:\\ 与 D:\\')
    expect(formatDrives(['C:\\', 'D:\\', 'E:\\'])).toBe('C:\\、D:\\ 与 E:\\')
  })

  it('没有盘就不说那句话', () => {
    expect(formatDrives([])).toBe('')
  })

  it('时间按本地日历拆，不是 UTC', () => {
    const ms = new Date(2026, 0, 2, 3, 4).getTime()
    expect(formatWhen(ms)).toBe('2026年1月2日 03:04')
  })

  it('坏时间回「时间未知」而不是 Invalid Date', () => {
    expect(formatWhen(Number.NaN)).toBe('时间未知')
  })

  it('详情顶栏那句包含时间、盘与大小', () => {
    const h = formatRunHeader(run())
    expect(h).toContain('2026年10月25日 15:30')
    expect(h).toContain('C:\\ 与 D:\\')
    expect(h).toContain('750.9 MB')
  })
})
