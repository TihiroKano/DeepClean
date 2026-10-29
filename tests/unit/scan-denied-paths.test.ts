/**
 * §15「部分数据无法访问 · 共跳过 N 个」的那份**清单**（Task 9）。
 *
 * 上一版收口时记下的已知不足：扫描只给出计数器（真 C 盘实测 `denied 106 → skipped 106`），
 * 用户看不见**哪些**目录没被计量 —— 于是一张悄悄少画了几个 GB 的地图和一张量全了的地图长得一模一样。
 * 本文件钉的就是"能点名"这件事，以及围绕它的三条纪律：
 * 1. **计数与清单同源**：清单只是计数器的前若干项，绝不能反过来用清单长度冒充计数；
 * 2. **清单有界、计数无界**：真实盘一轮能撞上上千个 EPERM 目录，200 条是内存预算，
 *    而 `denied` 必须照样数到 100,000 —— 截断的是"看得见哪些"，不是"一共少了多少"；
 * 3. **溢出必须点名**（`sampleOverflow`），没溢出就不许给个 0 冒充说了句话。
 */
import { describe, expect, it } from 'vitest'
import { Scanner } from '../../core/scan/scanner'
import { MAX_DENIED_SAMPLE, TreeStore } from '../../core/scan/tree-store'
import type { FsLike } from '../../core/fs/fslike'

const mk = (): TreeStore => new TreeStore({ rootPath: 'C:\\', maxFiles: 100, topN: 10 })

describe('被拒路径清单（§15「部分数据无法访问」）', () => {
  it('计数与清单同源：记了 3 次 denied 就有 3 条路径', () => {
    const s = mk()
    for (const p of ['C:\\a', 'C:\\b', 'C:\\c']) s.addError('denied', p)
    const sk = s.skipped()
    expect(sk.denied).toBe(3)
    expect(sk.total).toBe(3)
    expect(sk.sample).toEqual(['C:\\a', 'C:\\b', 'C:\\c'])
    expect(sk.sampleOverflow).toBe(0)
  })

  it('清单有界（MAX_DENIED_SAMPLE）：真实盘上 denied 可能上千条，不能让它无界吃内存；溢出如实点名', () => {
    const s = mk()
    for (let i = 0; i < MAX_DENIED_SAMPLE + 50; i++) s.addError('denied', `C:\\d${i}`)
    const sk = s.skipped()
    expect(sk.sample).toHaveLength(MAX_DENIED_SAMPLE)
    expect(sk.denied).toBe(MAX_DENIED_SAMPLE + 50) // 计数绝不因为清单截断而少记
    expect(sk.sampleOverflow).toBe(50)
  })

  /**
   * 上面那条断言里的 `MAX_DENIED_SAMPLE` 是**自指**的：把上限改成 200,000 它照样全绿
   * （循环次数跟着变，两边一起长大）。所以这一条把预算钉在字面量上 —— 内存预算是 §16 定的，
   * 不是一个可以被"自我一致"糊过去的实现细节。
   */
  it('上限就是字面上的 200 条绝对路径（§16 内存预算，不随实现自我放宽）', () => {
    expect(MAX_DENIED_SAMPLE).toBe(200)
    const s = mk()
    for (let i = 0; i < 5000; i++) s.addError('denied', `D:\\盘\\目录\\${i}`)
    const sk = s.skipped()
    expect(sk.sample.length).toBe(200)
    expect(sk.denied).toBe(5000) // 计数继续走，不受清单截断影响
    expect(sk.sampleOverflow).toBe(4800)
  })

  it('100,000 次被拒：清单长度不增长，被拒计数照样数满（截断只许发生在清单这一侧）', () => {
    const s = mk()
    for (let i = 0; i < 100_000; i++) s.addError('denied', `C:\\windows\\system32\\config\\${i}`)
    const sk = s.skipped()
    expect(sk.sample).toHaveLength(MAX_DENIED_SAMPLE)
    expect(sk.denied).toBe(100_000)
    expect(sk.total).toBe(100_000)
    expect(sk.sampleOverflow).toBe(100_000 - MAX_DENIED_SAMPLE)
    // 清单自己也要能对上账：列出的 + 没列出的 == 一共少了的
    expect(sk.sample.length + sk.sampleOverflow).toBe(sk.denied)
  })

  it('missing/busy 也进 total，但 sample 只收 denied（用户要的是"哪些目录没算进来"）', () => {
    const s = mk()
    s.addError('denied', 'C:\\x')
    s.addError('missing', 'C:\\gone')
    const sk = s.skipped()
    expect(sk.total).toBe(2)
    expect(sk.sample).toEqual(['C:\\x'])
  })

  /**
   * 「共跳过」这一道加法有**两个读面**：快照计数器 `stats().skipped`（首页 HUD、报告用）与
   * `skipped().total`（地图那一栏用）。它们曾经各自把四类求和逐字写了一遍，于是加第五种错误种类时
   * 只改一处就会让两处静默分叉 —— 而分叉的正好是"少了多少"这个数。这一条钉住两者恒等。
   *
   * 三条断言各守一件事（上一轮只把 `stats()` 一侧接上了 `totalSkipped()`，`skipped()` 那侧还留着
   * 手写的四字段求和，于是第二条是全场唯一真正咬得住的守卫）：
   * - 第 1 条（跨读面恒等）：任何一侧的算式单独漂移就会红 —— 两个读面分叉是本 Task 在治的病；
   * - 第 2 条（钉死 5）：算式**整体**多算或漏数任何一类都会红 —— 两侧一起错时第 1 条照样成立，只有这条看得见；
   * - 第 3 条（四字段之和 == total）：守「唯一算式」与对外暴露的四个计数器同账。它在旧代码里是**空断言**
   *   （`total` 就是这四个字段的一行内联，构造上不可能不等）；`skipped().total` 改走 `totalSkipped()` 之后，
   *   它才第一次成为"helper 的算式不许偏离四类之和"的真守卫。
   */
  it('stats().skipped 与 skipped().total 是同一道加法（两个读面不许各写一份）', () => {
    const s = mk()
    s.addError('denied', 'C:\\d')
    s.addError('missing', 'C:\\m')
    s.addError('busy', 'C:\\b')
    s.addError('otherErrors', 'C:\\o')
    s.addError('otherErrors')
    expect(s.skipped().total).toBe(s.stats().skipped)
    expect(s.stats().skipped).toBe(5)
    expect(s.skipped().denied + s.skipped().missing + s.skipped().busy + s.skipped().otherErrors).toBe(s.skipped().total)
  })

  it('回给 IPC / 渲染端的是副本：外部改动画数组不许动到 store 自己的清单', () => {
    const s = mk()
    s.addError('denied', 'C:\\a')
    const first = s.skipped()
    first.sample.push('C:\\伪造')
    first.sample.length = 0
    const again = s.skipped()
    expect(again.sample).toEqual(['C:\\a'])
    expect(again.denied).toBe(1)
  })

  it('无 denied 时 sample 是空数组（"没有这一栏"由 UI/报告自己判），四个计数器都在', () => {
    const sk = mk().skipped()
    expect(sk).toEqual({
      total: 0,
      denied: 0,
      missing: 0,
      busy: 0,
      otherErrors: 0,
      sample: [],
      sampleOverflow: 0
    })
  })

  /**
   * 向后兼容：`path` 是可选参数，旧调用点（拿不到路径的兜底 catch）照样计数。
   * 这一条守的是不变式 `sample.length + sampleOverflow === denied` 在"没有路径可记"时也成立 ——
   * 否则清单短了就会伪装成"没发生那么多"。
   */
  it('拿不到路径的 addError 仍然计数，差额全部体现在 sampleOverflow 上（不静默少记）', () => {
    const s = mk()
    s.addError('denied')
    s.addError('denied', '')
    s.addError('denied', 'C:\\有路径')
    const sk = s.skipped()
    expect(sk.denied).toBe(3)
    expect(sk.sample).toEqual(['C:\\有路径'])
    expect(sk.sampleOverflow).toBe(2)
    expect(sk.sample.length + sk.sampleOverflow).toBe(sk.denied)
  })
})

/* ------------------------------------------------------------------ *
 * 扫描链：walk 的 error 事件本来就带 path，是**消费方**把它扔了（Task 26 记的不足）。
 * 下面两条钉的就是"路径一路走到清单"这条链，单靠 TreeStore 的单元测试钉不住它。
 * ------------------------------------------------------------------ */

const eacces = (code: string): FsLike => ({
  async readdir(p: string) {
    if (p === 'R:\\' || p === 'R:\\open') {
      return p === 'R:\\'
        ? [
            { name: 'open', kind: 'dir' as const },
            { name: 'locked', kind: 'dir' as const },
            { name: 'a.txt', kind: 'file' as const }
          ]
        : [{ name: 'b.txt', kind: 'file' as const }]
    }
    throw Object.assign(new Error(code), { code })
  },
  async stat() {
    return { size: 1, mtimeMs: 1, birthtimeMs: 2, attrs: 0 }
  }
})

describe('扫描链把被拒目录的路径带到清单里（scanner 不再扔掉它）', () => {
  it('一次真实扫描后被拒的那个目录能被点名，且与计数器一一对上', async () => {
    const sc = new Scanner({ fs: eacces('EACCES'), concurrency: 4, progressIntervalMs: 0, maxFiles: 1e6, maxDepth: 8 })
    const snap = await sc.start('R:\\', () => undefined)
    expect(snap.status).toBe('completed')
    const sk = sc.skipped()
    expect(sk.sample).toEqual(['R:\\locked'])
    expect(sk.denied).toBe(1)
    // 快照的计数器与清单同源：同一份 store 的两个读面
    expect(sk.total).toBe(snap.skipped)
    expect(sk.denied).toBe(snap.denied)
    // 清单不参与任何聚合：容量只有那个能读的目录里的两个文件
    expect(snap.files).toBe(2)
    expect(snap.totalBytes).toBe(2)
  })

  /**
   * 取消的那一趟也要能回答"刚才跳过了哪些"。所以清单住在 `TreeStore` 上、
   * 跟着扫描任务活到任务被回收为止（`ScanService.jobs` 从不提前删 job），
   * 而不是住在扫描进度事件里（事件在取消后就没人再发了）。
   */
  it('取消的扫描照样问得出清单：status=cancelled 时 denied 与 sample 仍然一致', async () => {
    const sc = new Scanner({ fs: eacces('EPERM'), concurrency: 4, progressIntervalMs: 0, maxFiles: 1e6, maxDepth: 8 })
    let cancelled = false
    const snap = await sc.start('R:\\', (e) => {
      // 用户是**看见**跳过计数才按的取消：第一个带 denied 的进度事件里按下去
      if (!cancelled && e.snapshot.denied > 0) {
        cancelled = true
        sc.cancel()
      }
    })
    expect(cancelled, '这趟扫描得先出现一次 denied，否则测不到"取消之后还能问"').toBe(true)
    expect(snap.status).toBe('cancelled')
    const sk = sc.skipped()
    expect(sk.denied).toBeGreaterThan(0)
    expect(sk.sample.length).toBe(sk.denied) // 未溢出：清单就是全量
    expect(sk.sampleOverflow).toBe(0)
    expect(sk.sample.every((p) => p === 'R:\\locked')).toBe(true)
  })
})
