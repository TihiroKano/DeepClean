import { describe, expect, it } from 'vitest'
import { walkSubtree } from '../../core/scan/walk'
import type { FsLike, DirentLite } from '../../core/fs/fslike'
import type { FindDataEntry } from '../../core/fs/finddata'
import { setTimeout as sleep } from 'node:timers/promises'

const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

function fakeFs(
  tree: Record<string, { ents?: DirentLite[]; size?: number; attrs?: number; fail?: string }>,
  opts: { delayMs?: number; instrument?: (live: () => number) => void } = {}
): FsLike & { peak: () => number; statCalls: () => string[] } {
  let live = 0,
    peak = 0
  const statCalls: string[] = []
  opts.instrument?.(() => live)
  const bump = async (): Promise<void> => {
    live++
    peak = Math.max(peak, live)
    if (opts.delayMs) await sleep(opts.delayMs)
    live--
  }
  const f: FsLike & { peak: () => number; statCalls: () => string[] } = {
    async readdir(p: string): Promise<DirentLite[]> {
      const node = tree[p]
      await bump()
      if (!node) throw err('ENOENT')
      if (node.fail) throw err(node.fail)
      return node.ents ?? []
    },
    async stat(p: string) {
      const node = tree[p]
      statCalls.push(p)
      await bump()
      if (!node) throw err('ENOENT')
      if (node.fail) throw err(node.fail)
      const mtimeMs = 1700000000000
      // birthtime 刻意与 mtime **不同**、且随 size 变化：
      // 下游「把 mtime 抄成 birthtime」或「所有文件共用一个时间」都会被抓到。
      return { size: node.size ?? 0, mtimeMs, birthtimeMs: mtimeMs + (node.size ?? 0) + 1, attrs: node.attrs ?? 0 }
    },
    peak: () => peak,
    statCalls: () => statCalls
  }
  return f
}

const FLAT: Record<string, { ents?: DirentLite[]; size?: number; attrs?: number; fail?: string }> = {
  'R:\\': { ents: [{ name: 'a.txt', kind: 'file' }, { name: 'sub', kind: 'dir' }, { name: 'lnk', kind: 'other' }] },
  'R:\\a.txt': { size: 10 },
  'R:\\sub': { ents: [{ name: 'b.txt', kind: 'file' }] },
  'R:\\sub\\b.txt': { size: 20 }
}

const base = { concurrency: 4, maxDepth: 64, isCancelled: () => false }

describe('walkSubtree', () => {
  it('属性从同一次 stat 里带出来，逐文件独立（§4.1「属性」）', async () => {
    const tree: typeof FLAT = {
      'R:\\': { ents: [{ name: 'a.txt', kind: 'file' }, { name: 'b.txt', kind: 'file' }] },
      'R:\\a.txt': { size: 10, attrs: 1 },
      'R:\\b.txt': { size: 20, attrs: 0 }
    }
    const r = await walkSubtree('R:\\', { ...base, fs: fakeFs(tree) })
    // 不依赖文件 job 的完成顺序（并发下 push 顺序本来就不可保证）
    expect(Object.fromEntries(r.files.map((f) => [f.name, f.attrs]))).toEqual({ 'a.txt': 1, 'b.txt': 0 })
  })

  it('零额外 syscall：每个文件恰好一次 stat，目录一次都没有', async () => {
    const fs = fakeFs(FLAT)
    const r = await walkSubtree('R:\\', { ...base, fs })
    // FLAT 里 2 个文件 / 2 个目录（R:\ 和 R:\sub）→ 只允许出现 2 次 stat
    expect(fs.statCalls().sort()).toEqual(['R:\\a.txt', 'R:\\sub\\b.txt'])
    expect(r.fileCount).toBe(2)
    expect(r.dirCount).toBe(1)
  })

  it('birthtime 与 size/mtime/attrs 出自同一次 stat：加了它也不许多要一次 stat（§4.1 成本红线）', async () => {
    const fs = fakeFs(FLAT)
    const r = await walkSubtree('R:\\', { ...base, fs })
    expect(fs.statCalls().sort()).toEqual(['R:\\a.txt', 'R:\\sub\\b.txt']) // stat 次数一字不变
    expect(r.files.every((f) => typeof f.birthtimeMs === 'number' && f.birthtimeMs > 0)).toBe(true)
    // 逐文件对上 fakeFs 那个「与 mtime 不同、且随 size 变」的值：抄 mtime / 串到兄弟文件上都红
    const seen: Record<string, number> = {}
    for (const f of r.files) seen[f.name] = f.birthtimeMs
    for (const d of r.dirs) for (const f of d.files) seen[f.name] = f.birthtimeMs
    expect(seen).toEqual({ 'a.txt': 1700000000011, 'b.txt': 1700000000021 })
    // birthtime 只做展示，**不参与后序聚合**：目录 mtime 仍是 stat 的 mtime，而不是更大的那个 birthtime
    expect(r.mtimeMs).toBe(1700000000000)
  })

  it('属性不参与任何聚合：全树 size / fileCount / dirCount / mtimeMs 与 attrs 无关', async () => {
    const plain = await walkSubtree('R:\\', { ...base, fs: fakeFs(FLAT) })
    const loaded: typeof FLAT = {
      'R:\\': { ...FLAT['R:\\']! },
      'R:\\a.txt': { size: 10, attrs: 1 | 2 | 4 | 32 },
      'R:\\sub': { ...FLAT['R:\\sub']! },
      'R:\\sub\\b.txt': { size: 20, attrs: 1 | 2 | 4 | 32 }
    }
    const withAttrs = await walkSubtree('R:\\', { ...base, fs: fakeFs(loaded) })
    expect(withAttrs.size).toBe(plain.size)
    expect(withAttrs.fileCount).toBe(plain.fileCount)
    expect(withAttrs.dirCount).toBe(plain.dirCount)
    expect(withAttrs.mtimeMs).toBe(plain.mtimeMs)
    // §35.2 的对账数字必须一字不动，靠的就是这条
    expect(withAttrs.size).toBe(30)
  })

  it('后序聚合：父 size = 子孙之和，fileCount 递推正确', async () => {
    const r = await walkSubtree('R:\\', { ...base, fs: fakeFs(FLAT) })
    expect(r.size).toBe(30)
    expect(r.fileCount).toBe(2)
    expect(r.dirCount).toBe(1)
    expect(r.files.map((f) => f.name)).toEqual(['a.txt'])
    expect(r.dirs[0]!.path).toBe('R:\\sub')
  })

  it('目录 readdir 被 EPERM 拒绝：记为 denied、跳过、整体不失败（§8）', async () => {
    const tree = { ...FLAT, 'R:\\sub': { fail: 'EPERM' } }
    const r = await walkSubtree('R:\\', { ...base, fs: fakeFs(tree) })
    expect(r.errors.denied).toBe(1)
    expect(r.dirs).toHaveLength(0)
    expect(r.size).toBe(10)
  })

  it('文件 stat 遇 ENOENT（扫描中被删）：跳过并记录，继续扫（§9）', async () => {
    const tree = { ...FLAT, 'R:\\a.txt': { fail: 'ENOENT' } }
    const r = await walkSubtree('R:\\', { ...base, fs: fakeFs(tree) })
    expect(r.errors.missing).toBe(1)
    expect(r.size).toBe(20)
    expect(r.files).toHaveLength(0)
    expect(r.dirs).toHaveLength(1)
  })

  it('软链接/设备节点 kind=other 被忽略，不参与递归（防跟随链接死循环）', async () => {
    const r = await walkSubtree('R:\\', { ...base, fs: fakeFs(FLAT) })
    expect(r.files.some((f) => f.name === 'lnk')).toBe(false)
    expect(r.dirs.some((d) => d.name === 'lnk')).toBe(false)
  })

  it('SKIP_ALWAYS 名单内的目录直接跳过并计 skipped', async () => {
    const tree: typeof FLAT = {
      'R:\\': { ents: [{ name: 'System Volume Information', kind: 'dir' }] },
      'R:\\System Volume Information': { ents: [] }
    }
    const r = await walkSubtree('R:\\', { ...base, fs: fakeFs(tree) })
    expect(r.dirs).toHaveLength(0)
    expect(r.errors.denied).toBe(0)
  })

  it('并发不超上限（in-flight 探针）', async () => {
    const fs = fakeFs(FLAT, { delayMs: 2 })
    await walkSubtree('R:\\', { ...base, concurrency: 2, fs })
    expect(fs.peak()).toBeLessThanOrEqual(2)
  })

  it('取消：isCancelled 翻真后立刻停止，返回已完成部分（§28 原则六）', async () => {
    let tick = 0
    const cancelled = (): boolean => tick++ > 3
    const fs = fakeFs(FLAT, { delayMs: 1 })
    const r = await walkSubtree('R:\\', { concurrency: 2, maxDepth: 64, isCancelled: cancelled, fs })
    expect(r.size).toBeLessThan(30)
  })

  it('深度限制生效，不无限递归', async () => {
    const deep: typeof FLAT = { 'R:\\': { ents: [] } }
    let p = 'R:\\'
    for (let i = 0; i < 100; i++) {
      deep[p] = { ents: [{ name: 'x', kind: 'dir' }], size: 0 }
      p = `${p}\\x`
    }
    deep[p] = { ents: [] }
    const r = await walkSubtree('R:\\', { concurrency: 4, maxDepth: 5, isCancelled: () => false, fs: fakeFs(deep) })
    let d = 0,
      cur: WalkNodeShape = r
    while (cur.dirs.length) {
      cur = cur.dirs[0]!
      d++
    }
    expect(d).toBeLessThanOrEqual(5)
  })

  it('onEvent 上报每个文件（供主进程实时聚合与 Top-N）', async () => {
    const seen: number[] = []
    await walkSubtree('R:\\', { ...base, fs: fakeFs(FLAT), onEvent: (e) => { if (e.kind === 'file') seen.push(e.size) } })
    expect(seen.sort()).toEqual([10, 20])
  })

  it('消费完一个目录就 release 一次 —— 缓存型 fs 的生命周期钩子', async () => {
    const released: string[] = []
    const fs: FsLike = {
      async readdir(p) {
        const n = FLAT[p]
        if (!n) throw err('ENOENT')
        return n.ents ?? []
      },
      async stat(p) {
        const n = FLAT[p]
        if (!n) throw err('ENOENT')
        return { size: n.size ?? 0, mtimeMs: 1700000000000, birthtimeMs: 1700000000001, attrs: 0 }
      },
      release: (p) => {
        released.push(p)
      }
    }
    await walkSubtree('R:\\', { ...base, fs })
    // FLAT：R:\ 与 R:\sub 两个目录都 readdir 过；lnk 是 other 不递归、stat 也不落在目录上
    expect(released.sort()).toEqual(['R:\\', 'R:\\sub'])
  })
})

describe('walkSubtree 的目录枚举兜底（不需要管理员，§见 core/fs/finddata.ts）', () => {
  /** stat 一律被拒的两个文件；大小只有"查找记录"那条路能给出。 */
  const BLOCKED: Record<string, { ents?: DirentLite[]; size?: number; attrs?: number; fail?: string }> = {
    'R:\\': { ents: [{ name: 'pagefile.sys', kind: 'file' }, { name: 'swapfile.sys', kind: 'file' }] },
    'R:\\pagefile.sys': { fail: 'EPERM' },
    'R:\\swapfile.sys': { fail: 'EPERM' }
  }
  const FOUND = new Map<string, FindDataEntry>([
    ['pagefile.sys', { size: 9_714_868_224, mtimeMs: 1_700_000_000_000, birthtimeMs: 1_600_000_000_000, attrs: 38 }],
    ['swapfile.sys', { size: 16_777_216, mtimeMs: 1_700_000_000_001, birthtimeMs: 1_600_000_000_001, attrs: 38 }]
  ])

  it('stat 被拒 ⇒ 用查找记录计入，并且不再记 denied（否则界面会同时说"算进了"和"没算进"）', async () => {
    const calls: string[] = []
    const r = await walkSubtree('R:\\', {
      ...base,
      fs: fakeFs(BLOCKED),
      findData: async (dir) => {
        calls.push(dir)
        return FOUND
      }
    })
    expect(r.files.map((f) => [f.name, f.size])).toEqual([
      ['pagefile.sys', 9_714_868_224],
      ['swapfile.sys', 16_777_216]
    ])
    expect(r.errors.denied).toBe(0)
    expect(calls).toEqual(['R:\\', 'R:\\']) // 每个被拒的文件恰好问一次，不重试
    // 兜底带来的属性与时间必须是同一条查找记录里的，不许拿 mtime 冒充 birthtime
    const pf = r.files.find((f) => f.name === 'pagefile.sys')!
    expect(pf.birthtimeMs).toBe(1_600_000_000_000)
    expect(pf.attrs).toBe(38)
  })

  it('兜底计数向上聚合：再下一层救回来的文件也算进 root 的那份账', async () => {
    const tree: typeof BLOCKED = {
      'R:\\': { ents: [{ name: 'near.bin', kind: 'file' }, { name: 'sub', kind: 'dir' }] },
      'R:\\near.bin': { fail: 'EPERM' },
      'R:\\sub': { ents: [{ name: 'far.bin', kind: 'file' }] },
      'R:\\sub\\far.bin': { fail: 'EPERM' }
    }
    const found = new Map<string, FindDataEntry>([
      ['near.bin', { size: 1000, mtimeMs: 1, birthtimeMs: 2, attrs: 32 }],
      ['far.bin', { size: 2224, mtimeMs: 3, birthtimeMs: 4, attrs: 32 }]
    ])
    const r = await walkSubtree('R:\\', { ...base, fs: fakeFs(tree), findData: async () => found })
    expect(r.findDataFiles).toBe(2) // 只数自己那一层的话这里会是 1 —— 而 1 会被当成总数引用
    expect(r.findDataBytes).toBe(3224)
    expect(r.fileCount).toBe(2)
  })

  it('兜底也拿不到 ⇒ 逐字退回今天的行为（记 denied，不编造大小）', async () => {
    const r = await walkSubtree('R:\\', { ...base, fs: fakeFs(BLOCKED), findData: async () => null })
    expect(r.files).toHaveLength(0)
    expect(r.errors.denied).toBe(2)
  })

  it('清单里没有这个文件 ⇒ 仍然记 denied，不许把"缺项"当 0 字节算进去', async () => {
    const r = await walkSubtree('R:\\', { ...base, fs: fakeFs(BLOCKED), findData: async () => new Map([['别的文件', FOUND.get('pagefile.sys')!] ]) })
    expect(r.files).toHaveLength(0)
    expect(r.errors.denied).toBe(2)
  })

  it('只有 denied 才走兜底：ENOENT（文件刚被删）一次都不该起子进程', async () => {
    let listerCalls = 0
    const tree: typeof BLOCKED = {
      'R:\\': { ents: [{ name: 'gone.txt', kind: 'file' }] },
      'R:\\gone.txt': { fail: 'ENOENT' }
    }
    const r = await walkSubtree('R:\\', {
      ...base,
      fs: fakeFs(tree),
      findData: async () => {
        listerCalls++
        return FOUND
      }
    })
    expect(listerCalls).toBe(0) // 一次子进程 150–460 ms，花在"文件已经没了"上是纯亏
    expect(r.errors.missing).toBe(1)
  })

  it('没注入兜底 ⇒ 一个字节都不变（默认关，行为与今天一致）', async () => {
    const r = await walkSubtree('R:\\', { ...base, fs: fakeFs(BLOCKED) })
    expect(r.files).toHaveLength(0)
    expect(r.errors.denied).toBe(2)
  })
})

type WalkNodeShape = { dirs: WalkNodeShape[] }
