/**
 * v0.1 清单里的「暂停 / 取消」。两条各自有测试，因为它们的失败模式完全不同：
 * 暂停失效 = 数字还在涨，用户以为停住了；取消在暂停中失效 = **整个扫描挂死**，严重得多。
 *
 * 造一棵"够宽 + 每次 readdir 都让出一拍"的树：不然扫描在 `pause()` 被调用之前就跑完了，
 * 那"暂停后没有新的 readdir"这条断言就是空过的 —— 看着绿，什么都没测。
 */
import { describe, expect, it } from 'vitest'
import { Scanner } from '../../core/scan/scanner'
import type { DirentLite, FsLike } from '../../core/fs/fslike'
import type { ScanEvent } from '../../shared/types'

const DIRS = 40
const FILES_PER_DIR = 2

function wideTree(): Record<string, DirentLite[]> {
  const t: Record<string, DirentLite[]> = {
    'R:\\': Array.from({ length: DIRS }, (_, i) => ({ name: `d${i}`, kind: 'dir' as const }))
  }
  for (let i = 0; i < DIRS; i++) {
    t[`R:\\d${i}`] = Array.from({ length: FILES_PER_DIR }, (_, j) => ({ name: `f${j}.bin`, kind: 'file' as const }))
    t[`R:\\d${i}\\f0.bin`] = []
    t[`R:\\d${i}\\f1.bin`] = []
  }
  return t
}

interface SlowFs extends FsLike {
  readonly reads: string[]
}

function slowFs(tree: Record<string, DirentLite[]>): SlowFs {
  const reads: string[] = []
  return {
    reads,
    async readdir(p: string) {
      await new Promise((r) => setTimeout(r, 0)) // 让出一拍：给测试留出"在扫描中途按暂停"的窗口
      reads.push(p)
      const ents = tree[p]
      if (!ents) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return ents
    },
    async stat(p: string) {
      if (!(p in tree)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { size: 1000, mtimeMs: 1, birthtimeMs: 2, attrs: 0 }
    }
  }
}

const mk = (fs: FsLike): Scanner =>
  new Scanner({ fs, concurrency: 2, progressIntervalMs: 5, maxFiles: 1_000_000, maxDepth: 64 })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('v0.1 暂停 / 继续', () => {
  it('暂停后进度停止增长（协作式：允许一个在途窗口，与取消同一语义）；继续能跑完', async () => {
    const fs = slowFs(wideTree())
    const s = mk(fs)
    const events: ScanEvent[] = []
    const done = s.start('R:\\', (e) => events.push(e))

    await vi_poll(async () => (fs.reads.length > 6 ? true : undefined))
    s.pause()
    expect(s.snapshot().status, '前提：确实是在中途按下的暂停').toBe('paused')
    await sleep(150)
    const settled = fs.reads.length
    const filesAtPause = s.snapshot().files
    expect(filesAtPause).toBeLessThan(DIRS * FILES_PER_DIR)

    // 再等一拍：在途窗口 drain 完之后就该彻底停住。
    // 断言"停止增长"而不是"一次都不许多"：协作式暂停允许有限在途，说"瞬时掐断"是撒谎。
    await sleep(150)
    expect(fs.reads.length, '在途窗口 drain 完之后不该再发 readdir').toBe(settled)
    expect(s.snapshot().files, '暂停期间计数不该继续涨').toBe(filesAtPause)

    s.resume()
    const snap = await done
    expect(snap.status, '暂停要能被 UI 看见（走同一条事件流）').toBe('completed')
    expect(snap.files).toBe(DIRS * FILES_PER_DIR)
    expect(snap.totalBytes).toBe(DIRS * FILES_PER_DIR * 1000)
    expect(events.some((e) => e.snapshot.status === 'paused')).toBe(true)
  })

  it('暂停中按取消：立刻收尾，不挂死（挂死比不能暂停严重得多）', async () => {
    const fs = slowFs(wideTree())
    const s = mk(fs)
    const done = s.start('R:\\', () => undefined)
    await vi_poll(async () => (fs.reads.length > 4 ? true : undefined))
    s.pause()
    await sleep(30)
    s.cancel()

    const snap = await Promise.race([
      done,
      sleep(2000).then(() => 'TIMEOUT' as const)
    ])
    expect(snap, '取消在暂停状态下必须能结束扫描').not.toBe('TIMEOUT')
    expect((snap as Awaited<typeof done>).status).toBe('cancelled')
  })

  it('净工作时间：暂停那一段不计入 elapsedMs（否则速度数字被污染）', async () => {
    const fs = slowFs(wideTree())
    const s = mk(fs)
    const wallStart = Date.now()
    const done = s.start('R:\\', () => undefined)
    await vi_poll(async () => (fs.reads.length > 4 ? true : undefined))
    s.pause()
    const PAUSE_MS = 400
    await sleep(PAUSE_MS)
    s.resume()
    const snap = await done
    const wall = Date.now() - wallStart
    // 断言的是差值：墙钟里至少有一段（暂停那 400ms）没被算进净工作时间。
    // 不去比"净时间该等于多少"—— 那取决于机器快慢，比差值才稳。
    expect(snap.elapsedMs, '净工作时间必须把暂停扣掉').toBeLessThanOrEqual(wall - PAUSE_MS + 120)
    expect(snap.status).toBe('completed')
  })
})

/** 轮询到条件成立（拿到非 undefined 就返回）。比定长 sleep 可靠：慢机器上也不会误判。 */
async function vi_poll<T>(fn: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error('vi_poll: 超时，条件一直没成立')
    await sleep(5)
  }
}
