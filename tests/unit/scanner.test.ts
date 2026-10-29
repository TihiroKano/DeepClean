import { describe, expect, it } from 'vitest'
import { Scanner, buildSeeds } from '../../core/scan/scanner'
import type { DirentLite, FsLike } from '../../core/fs/fslike'
import type { ScanEvent } from '../../shared/types'

interface Node {
  ents?: DirentLite[]
  size?: number
  attrs?: number
  fail?: string
}

const tree: Record<string, Node> = {
  // root.bin 直接挂在根上、mid.bin 挂在中间层 R:\Users 上：
  // 这两条是回归哨兵。seed 只覆盖深度 2 的子树，浅层目录的直属文件曾经整批被漏掉
  // （真实盘上表现为 electron.exe / pagefile.sys 这种根下大文件凭空消失）。
  'R:\\': { ents: [{ name: 'Users', kind: 'dir' }, { name: 'Windows', kind: 'dir' }, { name: 'root.bin', kind: 'file' }] },
  'R:\\root.bin': { ents: [], size: 7000 },
  'R:\\Users': { ents: [{ name: 'Kano', kind: 'dir' }, { name: 'Public', kind: 'dir' }, { name: 'mid.bin', kind: 'file' }] },
  'R:\\Users\\mid.bin': { ents: [], size: 6000 },
  'R:\\Users\\Kano': { ents: [{ name: 'a.bin', kind: 'file' }] },
  'R:\\Users\\Kano\\a.bin': { ents: [], size: 1000 },
  'R:\\Users\\Public': { ents: [{ name: 'b.bin', kind: 'file' }] },
  'R:\\Users\\Public\\b.bin': { ents: [], size: 2000 },
  'R:\\Windows': { ents: [{ name: 'System32', kind: 'dir' }] },
  'R:\\Windows\\System32': { ents: [{ name: 'c.dll', kind: 'file' }] },
  'R:\\Windows\\System32\\c.dll': { ents: [], size: 5000 }
}

const fs: FsLike = {
  async readdir(p: string) {
    const n = tree[p]
    if (!n) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (n.fail) throw Object.assign(new Error(n.fail), { code: n.fail })
    return n.ents ?? []
  },
  async stat(p: string) {
    const n = tree[p]
    if (!n) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    if (n.fail) throw Object.assign(new Error(n.fail), { code: n.fail })
    return { size: n.size ?? 0, mtimeMs: 1, birthtimeMs: 2, attrs: n.attrs ?? 0 }
  }
}

const mk = (over: Partial<{ concurrency: number; progressIntervalMs: number; maxFiles: number }> = {}): Scanner =>
  new Scanner({
    fs,
    concurrency: over.concurrency ?? 4,
    progressIntervalMs: over.progressIntervalMs ?? 10,
    maxFiles: over.maxFiles ?? 1_000_000,
    maxDepth: 64
  })

describe('buildSeeds', () => {
  it('展开到深度 2 作为并发单元（长尾单元切细，§6）', async () => {
    const plan = await buildSeeds('R:\\', { fs, maxDepth: 2 })
    expect([...plan.seeds].sort()).toEqual(['R:\\Users\\Kano', 'R:\\Users\\Public', 'R:\\Windows\\System32'])
  })

  it('被展开过的目录单独记进 shallow：它们的直属文件不属于任何 seed（回归哨兵）', async () => {
    const plan = await buildSeeds('R:\\', { fs, maxDepth: 2 })
    expect([...plan.shallow].sort()).toEqual(['R:\\', 'R:\\Users', 'R:\\Windows'])
    // 交集必须为空，否则浅层文件会被 seed 子树再收一遍 → 双计
    expect(plan.seeds.some((s) => plan.shallow.includes(s))).toBe(false)
  })

  it('中间层目录不可读时，把它的兄弟继续当下钻单元而不是放弃整次扫描（§8）', async () => {
    const t: Record<string, Node> = {
      'R:\\': { ents: [{ name: 'ok', kind: 'dir' }, { name: 'locked', kind: 'dir' }] },
      'R:\\ok': { ents: [{ name: 'deep', kind: 'dir' }] },
      'R:\\ok\\deep': { ents: [] },
      'R:\\locked': { fail: 'EPERM' }
    }
    const f: FsLike = {
      async readdir(p: string) {
        const n = t[p]
        if (!n) throw Object.assign(new Error('x'), { code: 'ENOENT' })
        if (n.fail) throw Object.assign(new Error(n.fail), { code: n.fail })
        return n.ents ?? []
      },
      async stat() {
        return { size: 0, mtimeMs: 0, birthtimeMs: 1, attrs: 0 }
      }
    }
    const plan = await buildSeeds('R:\\', { fs: f, maxDepth: 2 })
    expect(plan.seeds).toContain('R:\\ok\\deep')
    expect(plan.seeds).toContain('R:\\locked')
  })
})

describe('Scanner', () => {
  it('完成后：总数、目录聚合、Top100 全对（§2.1 / §14）', async () => {
    const sc = mk()
    const events: ScanEvent['kind'][] = []
    const done = await sc.start('R:\\', (e) => events.push(e.kind))
    expect(done.status).toBe('completed')
    // 7000(root.bin) + 6000(mid.bin) + 1000(a.bin) + 2000(b.bin) + 5000(c.dll)
    expect(done.totalBytes).toBe(21000)
    expect(done.files).toBe(5)
    // dirs 含被扫描的根本身：R:\ + Users + Windows + Kano + Public + System32
    expect(done.dirs).toBe(6)
    // 根下与中间层的直属文件必须各就各位，不能被 seed 子树吞掉也不能丢
    expect(sc.children(sc.store.rootId).children.map((c) => c.name)).toContain('root.bin')
    // 「大文件」页下线后，Top-N 只剩扫描报告在用（`core/report/scan-report.ts` 的 topFiles 格）。
    // 这里改量**堆本身**（`topRaw` 是它的唯一出口）：排序与路径仍在同一处，判据没有变松。
    const top = sc.topRaw()
    expect(top.map((f) => [f.name, f.size])).toEqual([
      ['root.bin', 7000],
      ['mid.bin', 6000],
      ['c.dll', 5000],
      ['b.bin', 2000],
      ['a.bin', 1000]
    ])
    expect(top[2]?.path).toBe('R:\\Windows\\System32\\c.dll')
    expect(events).toContain('done')
  })

  it('属性从 scanner 一路带到 ChildView：文件有 attrs，目录是 null（本轮不采）', async () => {
    const t: Record<string, Node> = {
      ...tree,
      'R:\\root.bin': { ents: [], size: 7000, attrs: 1 },
      'R:\\Users\\Kano\\a.bin': { ents: [], size: 1000, attrs: 1 | 2 | 4 | 32 }
    }
    const f: FsLike = {
      async readdir(p: string) {
        const n = t[p]
        if (!n) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (n.fail) throw Object.assign(new Error(n.fail), { code: n.fail })
        return n.ents ?? []
      },
      async stat(p: string) {
        const n = t[p]
        if (!n) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        if (n.fail) throw Object.assign(new Error(n.fail), { code: n.fail })
        return { size: n.size ?? 0, mtimeMs: 1, birthtimeMs: 2, attrs: n.attrs ?? 0 }
      }
    }
    const sc = new Scanner({ fs: f, concurrency: 4, progressIntervalMs: 10, maxFiles: 1e6, maxDepth: 64 })
    await sc.start('R:\\', () => undefined)

    const rootKids = sc.children(sc.store.rootId).children
    // shallow 目录（R:\）的直属文件也要带属性，不只是 seed 子树里的
    expect(rootKids.find((c) => c.name === 'root.bin')?.attrs).toBe(1)
    expect(rootKids.find((c) => c.name === 'Users')?.attrs, '目录不 stat → 属性必须是 null，不是 0').toBeNull()

    const kanoId = sc.store.dirIdByPath('R:\\Users\\Kano')
    expect(kanoId).toBeDefined()
    const kano = sc.children(kanoId!).children
    expect(kano.find((c) => c.name === 'a.bin')?.attrs).toBe(1 | 2 | 4 | 32)
    const pubId = sc.store.dirIdByPath('R:\\Users\\Public')
    expect(sc.children(pubId!).children.find((c) => c.name === 'b.bin')?.attrs, '没带任何属性位的文件 attrs = 0（不是 null）').toBe(0)
  })

  it('零额外 syscall：整次扫描的 stat 调用次数恰好等于文件数，目录一次都不 stat（§4.1 的成本红线）', async () => {
    const statCalls: string[] = []
    const f: FsLike = {
      async readdir(p: string) {
        const n = tree[p]
        if (!n) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return n.ents ?? []
      },
      async stat(p: string) {
        statCalls.push(p)
        const n = tree[p]
        if (!n) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return { size: n.size ?? 0, mtimeMs: 1, birthtimeMs: 2, attrs: 0 }
      }
    }
    const sc = new Scanner({ fs: f, concurrency: 4, progressIntervalMs: 10, maxFiles: 1e6, maxDepth: 64 })
    const s = await sc.start('R:\\', () => undefined)
    // 5 个文件 / 6 个目录：属性是"顺带"读出来的，多一次 stat 就等于给 C 盘加 7.3 万次 I/O
    expect(s.files).toBe(5)
    // 默认字典序（大写字母目录名排在 'root.bin' 前面），不是按路径深度
    expect(statCalls.sort()).toEqual([
      'R:\\Users\\Kano\\a.bin',
      'R:\\Users\\Public\\b.bin',
      'R:\\Users\\mid.bin',
      'R:\\Windows\\System32\\c.dll',
      'R:\\root.bin'
    ])
    expect(s.dirs).toBe(6)
  })

  it('进度事件按 interval 节流，不出现 IPC 洪水（§7）', async () => {
    const sc = mk({ progressIntervalMs: 100 })
    const stamps: number[] = []
    await sc.start('R:\\', (e) => {
      if (e.kind === 'progress') stamps.push(Date.now())
    })
    expect(stamps.length).toBeLessThanOrEqual(3)
    expect(stamps.length).toBeGreaterThan(0)
  })

  it('取消：status=cancelled，已建好的中间层仍可用于出图（§28 原则六）', async () => {
    // 从进度回调里取消，而不是 setTimeout：fake fs 的 Promise 全在微任务里就 resolve 了，
    // 宏任务的定时器永远来不及在扫描中途插入 —— 那样这条测试根本没在测取消。
    const sc = mk({ concurrency: 1, progressIntervalMs: 0 })
    let seen = 0
    const pending = sc.start('R:\\', () => {
      if (++seen === 2) sc.cancel()
    })
    const s = await pending
    expect(s.status).toBe('cancelled')
    expect(seen).toBeGreaterThan(2)
    // 第 2 个事件就取消了，三个种子单元不可能全部扫完
    expect(s.files).toBeLessThan(3)
    // 取消前 ensureChain 已把中间层挂上树 → 取消后仍能出图
    expect(sc.children(sc.store.rootId).children.length).toBeGreaterThan(0)
  })

  it('根目录本身不可读 → status=failed 并计一笔 denied，不抛异常', async () => {
    const bad: FsLike = {
      async readdir() {
        throw Object.assign(new Error('x'), { code: 'EPERM' })
      },
      async stat() {
        return { size: 0, mtimeMs: 0, birthtimeMs: 1, attrs: 0 }
      }
    }
    const sc = new Scanner({ fs: bad, concurrency: 4, progressIntervalMs: 10, maxFiles: 1e6, maxDepth: 64 })
    const s = await sc.start('R:\\', () => undefined)
    expect(s.status).toBe('failed')
    expect(s.denied).toBeGreaterThan(0)
  })

  it('子目录 EPERM / 文件 ENOENT 只记数，任务照常完成（§8 §9）', async () => {
    // Kano 整个子目录不可读（丢 1000B），System32\c.dll 扫描中被删（丢 5000B）
    // → 只有 Public\b.bin 的 2000B 入账，但扫描必须正常收尾
    const t: Record<string, Node> = {
      ...tree,
      'R:\\Users\\Kano': { ents: [], fail: 'EPERM' },
      'R:\\Windows\\System32\\c.dll': { ents: [], fail: 'ENOENT' }
    }
    const f: FsLike = {
      async readdir(p: string) {
        const n = t[p]
        if (!n) throw Object.assign(new Error('x'), { code: 'ENOENT' })
        if (n.fail) throw Object.assign(new Error(n.fail), { code: n.fail })
        return n.ents ?? []
      },
      async stat(p: string) {
        const n = t[p]
        if (!n) throw Object.assign(new Error('x'), { code: 'ENOENT' })
        if (n.fail) throw Object.assign(new Error(n.fail), { code: n.fail })
        return { size: n.size ?? 0, mtimeMs: 1, birthtimeMs: 2, attrs: n.attrs ?? 0 }
      }
    }
    const sc = new Scanner({ fs: f, concurrency: 4, progressIntervalMs: 10, maxFiles: 1e6, maxDepth: 64 })
    const s = await sc.start('R:\\', () => undefined)
    expect(s.status).toBe('completed')
    expect(s.denied).toBe(1)
    expect(s.missing).toBe(1)
    expect(s.skipped).toBe(2)
    // 浅层的 root.bin(7000) + mid.bin(6000) 与 Public\b.bin(2000) 仍要全部入账
    expect(s.totalBytes).toBe(15000)
    expect(s.files).toBe(3)
  })

  it('扫描嵌套目录时不得在根之上造出父链节点（§5.1 树形）', async () => {
    // 回归：ensureChain 早期版本从盘符开始拼路径，扫 D:\a\b\c 会在树上凭空长出
    // D:\ 与 D:\a 两个假目录，并把真子目录挂到假链下 —— 总量对得上，钻取全废。
    const sc = mk()
    const s = await sc.start('R:\\Users', () => undefined)
    const root = sc.children(sc.store.rootId)
    expect(root.children.map((c) => c.name).sort()).toEqual(['Kano', 'Public', 'mid.bin'])
    // R:\Users(根) + Kano + Public，不含 R:\ 也不含任何上级
    expect(s.dirs).toBe(3)
    expect(s.totalBytes).toBe(6000 + 1000 + 2000)
    expect(s.files).toBe(3)
  })

  it('knowsPath 只认真实存在的节点（shell 白名单，§28）', async () => {
    const sc = mk()
    await sc.start('R:\\', () => undefined)
    expect(sc.knowsPath('R:\\Users\\Kano\\a.bin')).toBe(true)
    expect(sc.knowsPath('R:\\root.bin')).toBe(true)
    expect(sc.knowsPath('R:\\Users\\mid.bin')).toBe(true)
    expect(sc.knowsPath('R:\\Users\\Kano')).toBe(true)
    expect(sc.knowsPath('R:\\Users\\Kano\\evil.exe')).toBe(false)
    expect(sc.knowsPath('C:\\Windows\\System32\\cmd.exe')).toBe(false)
  })

  it('maxFiles 截断时 truncated=true，但 totalBytes 与 files 仍完整（§28 原则五）', async () => {
    const big: FsLike = {
      async readdir(p: string) {
        if (p === 'R2:\\') return Array.from({ length: 500 }, (_, i) => ({ name: `f${i}`, kind: 'file' as const }))
        return []
      },
      async stat() {
        return { size: 2, mtimeMs: 0, birthtimeMs: 1, attrs: 0 }
      }
    }
    const sc = new Scanner({ fs: big, concurrency: 8, progressIntervalMs: 10, maxFiles: 100, maxDepth: 64 })
    const s = await sc.start('R2:\\', () => undefined)
    expect(s.truncated).toBe(true)
    expect(s.totalBytes).toBe(1000)
    expect(s.files).toBe(500)
  })

  it('children() 的四个记账字段各就各位：全是 number，交叉赋值也测得出（Task 1 契约）', async () => {
    const sc = mk()
    await sc.start('R:\\', () => undefined)
    const users = sc.store.dirIdByPath('R:\\Users')
    expect(users).toBeDefined()
    // cap=2：本层三项（mid.bin 6000 / Public 2000 / Kano 1000），折掉最小的 Kano。
    // 五个数字 3 / 1 / 1000 / 9000 / 21000 两两不等 → 任何一处赋错（如 foldedCount: page.foldedBytes）都红。
    const p = sc.children(users!, 2)
    expect(p.children.map((c) => c.name)).toEqual(['mid.bin', 'Public'])
    expect(p.totalChildren).toBe(3) // 收窄**之前**这一层有几项
    expect(p.foldedCount).toBe(1) // 没回传的那几项
    expect(p.foldedBytes).toBe(1000) // 它们的合计容量
    expect(p.size).toBe(9000) // R:\Users 自身
    expect(p.rootSize).toBe(21000) // 本次扫描的根 —— 与 size 是两个数，别互换
    // 视图折叠不吞容量：Σchildren + foldedBytes == ΣchildrenOf
    expect(p.children.reduce((s, c) => s + c.size, 0) + p.foldedBytes).toBe(9000)
    // 没超上限时记账全为 0，但 totalChildren 照实报（渲染端要据此说明"这一层没折叠"）
    const all = sc.children(users!)
    expect(all.totalChildren).toBe(3)
    expect([all.foldedCount, all.foldedBytes]).toEqual([0, 0])
  })

  it('扫描期间 children 就能看到中间层与 live 大小（§7 增量出图）', async () => {
    const sc = mk({ concurrency: 1, progressIntervalMs: 1 })
    let midTreeSize = -1
    await sc.start('R:\\', () => {
      if (midTreeSize < 0) {
        const kids = sc.children(sc.store.rootId).children
        if (kids.length > 0) midTreeSize = kids.reduce((s, k) => s + k.size, 0)
      }
    })
    expect(midTreeSize).toBeGreaterThanOrEqual(0)
    expect(sc.children(sc.store.rootId).rootId).toBe(sc.store.rootId)
  })

  /**
   * Task 7「排除该目录」的 store↔IPC 那一段：`children()` 是唯一带排除集的读面，
   * 它拒了什么必须回话（根 / 未知 id），否则渲染端会先重画再发现什么都没变。
   * 计价口径没在这里测 —— 那条在 `tests/unit/rules-engine.test.ts` 末尾的哨兵（三条路都在）。
   */
  it('视图排除只改 children()：项消失、容量点名，而 size 与 childrenOf 一字不动', async () => {
    const sc = mk()
    await sc.start('R:\\', () => undefined)
    const users = sc.store.dirIdByPath('R:\\Users')
    const pub = sc.store.dirIdByPath('R:\\Users\\Public')
    if (users === undefined || pub === undefined) throw new Error('夹具没建出 Users\\Public')
    const before = sc.children(users, 5)
    expect(before.children.map((c) => c.name)).toEqual(['mid.bin', 'Public', 'Kano'])
    // 没有排除时这两项是 0：UI 拿它当"没有这一栏"，所以数字必须真为 0 而不是缺席
    expect([before.excludedCount, before.excludedBytes]).toEqual([0, 0])

    expect(sc.setExcluded(pub, true)).toBe(true)
    const after = sc.children(users, 5)
    expect(after.children.map((c) => c.name)).toEqual(['mid.bin', 'Kano'])
    expect([after.excludedCount, after.excludedBytes]).toEqual([1, 2000])
    // 面积诚实：父级显示的 size 仍是完整子树合计，"这一层本来有几项"也不因排除变小
    expect(after.size).toBe(before.size)
    expect(after.totalChildren).toBe(before.totalChildren)
    // 完整口径（计价路径）一个字都不少
    expect(sc.store.childrenOf(users).map((c) => c.name)).toEqual(['mid.bin', 'Public', 'Kano'])

    // 扫描根不许排除（排除根 = 给用户一张空图）；未知 id 也不许回"成功"
    expect(sc.setExcluded(sc.store.rootId, true)).toBe(false)
    expect(sc.setExcluded(987_654, true)).toBe(false)
    expect(sc.children(sc.store.rootId).excludedCount).toBe(0)
    expect(sc.store.excludedIds()).toEqual([pub]) // 上面两次拒绝都没落进集合

    // 取消排除 = 它回来；clearExcluded 一次清完本轮全部
    expect(sc.setExcluded(pub, false)).toBe(true)
    expect(sc.children(users, 5).excludedCount).toBe(0)
    sc.setExcluded(pub, true)
    const win = sc.store.dirIdByPath('R:\\Windows')
    if (win === undefined) throw new Error('夹具没建出 Windows')
    sc.setExcluded(win, true)
    expect(sc.children(sc.store.rootId).excludedCount).toBe(1) // Windows 是根的直属子项
    expect(sc.children(users, 5).excludedCount).toBe(1) // Public 在它父亲那一层被藏掉
    sc.clearExcluded()
    expect(sc.store.excludedIds()).toEqual([])
    expect(sc.children(users, 5).children).toHaveLength(3)
    expect(sc.children(sc.store.rootId).children).toHaveLength(3)
  })

  /**
   * Task 7 修订 Fix 2 的 payload 半边：**本轮累计**那两个字段必须在**每一次** payload 上都在场，
   * 而且与本层那两个是**两个口径**（不是别名，也不是替换）。
   *
   * 这条是「横幅 + 清除入口随层级消失」那个 bug 在自动化这边的下游断点：站在根上问本层，
   * `excludedCount` 按构造就是 0，横幅如果只挂它就没有撤销入口了。变异（把 `scanner.children()`
   * 里那两个 `session*` 改回 `page.excluded*`）红在这三条断言上，红输出见 task-7 报告的修订记录。
   */
  it('children() 同时带两份排除口径：深层那一排在祖父层看不见，本轮累计那份照样报', async () => {
    const sc = mk()
    await sc.start('R:\\', () => undefined)
    const kano = sc.store.dirIdByPath('R:\\Users\\Kano')
    const users = sc.store.dirIdByPath('R:\\Users')
    const sys32 = sc.store.dirIdByPath('R:\\Windows\\System32')
    if (kano === undefined || users === undefined || sys32 === undefined) throw new Error('夹具没建出 Users\\Kano / System32')
    // 没有排除时四份都是 0（横幅的门与跨层那份同源，不许"缺席"也不许"残留"）
    expect(sc.children(sc.store.rootId)).toMatchObject({
      excludedCount: 0,
      excludedBytes: 0,
      sessionExcludedCount: 0,
      sessionExcludedBytes: 0
    })

    expect(sc.setExcluded(kano, true)).toBe(true)
    // 站在 Kano 的父亲（Users）那一层：此刻两份口径重合（它确实是本层直属子项）—— 这正是原实现唯一覆盖得到的形状
    expect(sc.children(users)).toMatchObject({
      excludedCount: 1,
      excludedBytes: 1000,
      sessionExcludedCount: 1,
      sessionExcludedBytes: 1000
    })
    // 退回根：本层那份归 0，而横幅要读的那一份仍是 1 / 1000
    const atRoot = sc.children(sc.store.rootId)
    expect(atRoot.excludedCount).toBe(0)
    expect(atRoot.excludedBytes).toBe(0)
    expect(atRoot.sessionExcludedCount).toBe(1)
    expect(atRoot.sessionExcludedBytes).toBe(1000)
    // 跨层那份的容量口径 = `sizeOf`（完整子树合计，与 payload.size 同源），且父级 size 不因排除变小
    expect(atRoot.sessionExcludedBytes).toBe(sc.store.sizeOf(kano))
    expect(atRoot.size).toBe(21000)

    // 再排到另一条支上去：本轮累计那份是和，每一层的本层那份仍各管各的账
    expect(sc.setExcluded(sys32, true)).toBe(true)
    expect(sc.children(sc.store.rootId)).toMatchObject({ excludedCount: 0, sessionExcludedCount: 2, sessionExcludedBytes: 6000 })
    expect(sc.children(users).excludedCount).toBe(1)
    expect(sc.children(users).sessionExcludedCount).toBe(2)
    // 一句全清：两份同时归零 —— 撤销入口清的是**本轮**，不是这一层
    sc.clearExcluded()
    expect(sc.children(sc.store.rootId)).toMatchObject({
      excludedCount: 0,
      excludedBytes: 0,
      sessionExcludedCount: 0,
      sessionExcludedBytes: 0
    })
  })
})

describe('Scanner 时间戳（首页「最近一次扫描」的数据源）', () => {
  it('还没开跑：两个时刻都是 null，不是 0', () => {
    const s = mk().snapshot()
    expect(s.startedAtMs).toBeNull()
    expect(s.finishedAtMs).toBeNull()
  })

  it('完成后 finishedAtMs 钉住不动，而 Date.now() - elapsedMs 会一直漂（这条就是新字段存在的理由）', async () => {
    const sc = mk()
    const done = await sc.start('R:\\', () => {})
    expect(done.status).toBe('completed')
    expect(done.startedAtMs).not.toBeNull()
    expect(done.finishedAtMs).not.toBeNull()
    expect((done.finishedAtMs ?? 0)).toBeGreaterThanOrEqual(done.startedAtMs ?? Infinity)

    const first = done.finishedAtMs ?? 0
    const derivedFirst = Date.now() - done.elapsedMs
    await new Promise((r) => setTimeout(r, 40))
    const again = sc.snapshot()
    // 真时刻：两次问必须是同一个数
    expect(again.finishedAtMs).toBe(first)
    // 反推出来的"时刻"：两次问必然不是同一个数（差至少 30ms，留了时钟粒度余量）
    expect(Math.abs(Date.now() - again.elapsedMs - derivedFirst)).toBeGreaterThanOrEqual(30)
  })
})

describe('Scanner 的目录枚举兜底：浅层与 seed 子树两条路都要覆盖', () => {
  // R:\pagefile.sys 走 collectShallowFiles，R:\Users\mid\deep.bin 走 walkSubtree ——
  // 同一个"被 ACL 挡住"在两套代码里各有一份接线，只测一条就会留下另一条静默少算。
  const t: Record<string, Node> = {
    'R:\\': { ents: [{ name: 'pagefile.sys', kind: 'file' }, { name: 'Users', kind: 'dir' }] },
    'R:\\pagefile.sys': { fail: 'EPERM' },
    'R:\\Users': { ents: [{ name: 'mid', kind: 'dir' }] },
    // far.bin 在 seed 根**再下一层**：只有兜底计数真的向上聚合了，它才会出现在总数里。
    // 少了这一步，界面上引用的就是"只算了一半的来源数"，比没有这个数更坏。
    'R:\\Users\\mid': { ents: [{ name: 'deep.bin', kind: 'file' }, { name: 'sub2', kind: 'dir' }] },
    'R:\\Users\\mid\\deep.bin': { fail: 'EPERM' },
    'R:\\Users\\mid\\sub2': { ents: [{ name: 'far.bin', kind: 'file' }] },
    'R:\\Users\\mid\\sub2\\far.bin': { fail: 'EPERM' }
  }
  const f: FsLike = {
    async readdir(p: string) {
      const n = t[p]
      if (!n) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (n.fail) throw Object.assign(new Error(n.fail), { code: n.fail })
      return n.ents ?? []
    },
    async stat(p: string) {
      const n = t[p]
      if (!n) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (n.fail) throw Object.assign(new Error(n.fail), { code: n.fail })
      return { size: n.size ?? 0, mtimeMs: 1, birthtimeMs: 2, attrs: 0 }
    }
  }
  const FOUND = new Map<string, { size: number; mtimeMs: number; birthtimeMs: number; attrs: number }>([
    ['pagefile.sys', { size: 9_714_868_224, mtimeMs: 1, birthtimeMs: 2, attrs: 38 }],
    ['deep.bin', { size: 4096, mtimeMs: 3, birthtimeMs: 4, attrs: 32 }],
    ['far.bin', { size: 8192, mtimeMs: 5, birthtimeMs: 6, attrs: 32 }]
  ])
  const ALL = 9_714_868_224 + 4096 + 8192

  it('注入兜底 ⇒ 三个被拒的文件都进地图（含 seed 再下一层那个），来源计数覆盖两条路', async () => {
    const asked: string[] = []
    const sc = new Scanner({
      fs: f,
      concurrency: 4,
      progressIntervalMs: 10,
      maxFiles: 1e6,
      maxDepth: 64,
      findData: async (dir) => {
        asked.push(dir)
        return FOUND
      }
    })
    const s = await sc.start('R:\\', () => undefined)
    expect(s.files).toBe(3)
    expect(s.totalBytes).toBe(ALL)
    expect(sc.findDataRecovery()).toEqual({ files: 3, bytes: ALL })
    expect(asked.sort()).toEqual(['R:\\', 'R:\\Users\\mid', 'R:\\Users\\mid\\sub2']) // 三条路各自问到自己的目录
  })

  it('不注入 ⇒ 逐字退回今天的行为（0 个文件、0 字节，而不是编出一个假的 0 字节条目）', async () => {
    const sc = new Scanner({ fs: f, concurrency: 4, progressIntervalMs: 10, maxFiles: 1e6, maxDepth: 64 })
    const s = await sc.start('R:\\', () => undefined)
    expect(s.files).toBe(0)
    expect(s.totalBytes).toBe(0)
    expect(sc.findDataRecovery()).toEqual({ files: 0, bytes: 0 })
  })

  it('浅层目录收完直属文件后 release —— 与 walk 同一条生命周期；buildSeeds 的预读不欠释放', async () => {
    const released: string[] = []
    const fsWithRelease: FsLike = {
      readdir: (p) => fs.readdir(p),
      stat: (p) => fs.stat(p),
      release: (p) => {
        released.push(p)
      }
    }
    const sc = new Scanner({
      fs: fsWithRelease,
      concurrency: 4,
      progressIntervalMs: 10,
      maxFiles: 1_000_000,
      maxDepth: 8
    })
    await sc.start('R:\\', () => undefined)
    // 该树里 readdir 过的目录：buildSeeds 预读 3 个（不释放）+ collectShallow 重读 3 个（释放）
    // + walk 三个种子各 1 个（释放）= 恰好 6 个释放，逐一比对
    expect(released.sort()).toEqual(
      [
        'R:\\',
        'R:\\Users',
        'R:\\Windows',
        'R:\\Users\\Kano',
        'R:\\Users\\Public',
        'R:\\Windows\\System32'
      ].sort()
    )
  })
})
