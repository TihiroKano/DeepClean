import { describe, expect, it } from 'vitest'
import { computeDirStats, type DirStatsNode } from '../../core/analyze/dir-stats'
import { TreeStore, type FileEntry } from '../../core/scan/tree-store'

/** 手搓一棵：root(100) ├ A(60, 最大子目录) ├ B(10) └ 文件 x.dat(30)；A 里有 a1.bin(55) */
const tree: Record<number, DirStatsNode> = {
  1: { size: 100, fileCount: 1, dirCount: 2, path: 'C:\\r', name: 'r', childIds: [2, 3], files: [{ name: 'x.dat', size: 30 }] },
  2: { size: 60, fileCount: 1, dirCount: 0, path: 'C:\\r\\A', name: 'A', childIds: [], files: [{ name: 'a1.bin', size: 55 }] },
  3: { size: 10, fileCount: 0, dirCount: 0, path: 'C:\\r\\B', name: 'B', childIds: [], files: [] }
}
const nodeOf = (id: number): DirStatsNode | undefined => tree[id]

/** 测试用的目录节点：fileCount / dirCount 只为凑齐 DirStatsNode 的形状，口径本身不读它们。 */
const dir = (
  path: string,
  name: string,
  size: number,
  childIds: number[],
  files: { name: string; size: number }[] = []
): DirStatsNode => ({ size, fileCount: files.length, dirCount: childIds.length, path, name, childIds, files })

describe('computeDirStats（§9 目录统计）', () => {
  it('最大子目录取**直属**子目录里最大的那个，最大文件取**整个子树**里最大的那个', () => {
    const s = computeDirStats(nodeOf, 1)
    expect(s.largestSubDir).toEqual({ name: 'A', path: 'C:\\r\\A', size: 60 })
    expect(s.largestFile).toEqual({ name: 'a1.bin', path: 'C:\\r\\A\\a1.bin', size: 55 })
    expect(s.partial).toBe(false)
    expect(s.visited).toBe(3)
  })

  it('空目录：两个都是 null，不抛', () => {
    const s = computeDirStats(nodeOf, 3)
    expect(s.largestFile).toBeNull()
    expect(s.largestSubDir).toBeNull()
  })

  it('预算用尽必须点名 partial=true，并如实报已访问数（不许把截断结果冒充全量结论）', () => {
    const s = computeDirStats(nodeOf, 1, 2)
    expect(s.partial).toBe(true)
    expect(s.visited).toBeLessThanOrEqual(2)
  })

  it('同 size 的最大子目录按名字定序，两次调用结果一致（可复现）', () => {
    const t: Record<number, DirStatsNode> = {
      1: { size: 20, fileCount: 0, dirCount: 2, path: 'C:\\r', name: 'r', childIds: [3, 2], files: [] },
      2: { size: 10, fileCount: 0, dirCount: 0, path: 'C:\\r\\b', name: 'b', childIds: [], files: [] },
      3: { size: 10, fileCount: 0, dirCount: 0, path: 'C:\\r\\a', name: 'a', childIds: [], files: [] }
    }
    const a = computeDirStats((i) => t[i], 1)
    const b = computeDirStats((i) => t[i], 1)
    expect(a.largestSubDir?.name).toBe('a')
    expect(b.largestSubDir?.name).toBe(a.largestSubDir?.name)
  })

  /* ---- 以下四条是「可复现」这条全局约束的**判别式**：只比两次调用互等的那条抓不到缺陷 ---- */

  it('同 size 的最大子目录：结论不得取决于 childIds 的排列（定序键必须是全序）', () => {
    const mk = (childIds: number[]): Record<number, DirStatsNode> => ({
      1: dir('C:\\r', 'r', 20, childIds),
      2: dir('C:\\r\\b', 'b', 10, []),
      3: dir('C:\\r\\a', 'a', 10, [])
    })
    // 两种挂法都必须是 'a'：丢掉 path 这条 tie-break 时，先到先得的是 'b' → 这条立刻红
    expect(computeDirStats((i) => mk([2, 3])[i], 1).largestSubDir?.name).toBe('a')
    expect(computeDirStats((i) => mk([3, 2])[i], 1).largestSubDir?.name).toBe('a')
  })

  it('同 size 的最大文件按 path 字典序定序 —— DFS 用栈，遍历顺序不是定序依据', () => {
    const t: Record<number, DirStatsNode> = {
      1: dir('C:\\r', 'r', 14, [2, 3]),
      2: dir('C:\\r\\A', 'A', 7, [], [{ name: 'same.bin', size: 7 }]),
      3: dir('C:\\r\\B', 'B', 7, [], [{ name: 'same.bin', size: 7 }])
    }
    // 栈是后进先出：B 先被弹出，所以"先到的那个"是 B。全序判据必须把它换成 A。
    // 这条同时守着「输家跳过」那道闸的**严格小于**：写成 `<=` 的话 A 这条会被当成输家直接跳过，
    // 结果就变成先访问到的 B —— 见下面那条「输家不配一次路径拼接」。
    expect(computeDirStats((i) => t[i], 1).largestFile).toEqual({
      name: 'same.bin',
      path: 'C:\\r\\A\\same.bin',
      size: 7
    })
  })

  it('盘符根下的文件拼成 C:\\x.dat（不是 C:\\\\x.dat），且根自己的文件也参与「最大文件」', () => {
    const t: Record<number, DirStatsNode> = {
      1: dir('C:\\', 'C:\\', 99, [2], [{ name: 'big.dat', size: 90 }, { name: 'small.dat', size: 1 }]),
      2: dir('C:\\A', 'A', 9, [], [{ name: 'a.bin', size: 9 }])
    }
    const s = computeDirStats((i) => t[i], 1)
    expect(s.largestFile).toEqual({ name: 'big.dat', path: 'C:\\big.dat', size: 90 })
    expect(s.largestSubDir).toEqual({ name: 'A', path: 'C:\\A', size: 9 })
  })

  it('根路径写成 `D:\\foo\\`（带尾斜杠，`validateRoot` 收这种写法）：不得拼出双分隔符', () => {
    // 这条测的是「同一个文件在面板上有两个路径」那个 bug：
    // childrenOf 走 joinWin（认 `endsWith('\\')`）给出 `D:\foo\a.txt`，
    // 而手搓的 isRoot 只认 `endsWith(':\\')` → 根上的直属文件被拼成 `D:\foo\\a.txt`。
    // 悬停 `title` 显示的就是它，和列表里那条对不上。
    const t: Record<number, DirStatsNode> = {
      1: dir('D:\\foo\\', 'foo', 15, [2], [{ name: 'a.txt', size: 10 }, { name: 'z.txt', size: 2 }]),
      2: dir('D:\\foo\\bar', 'bar', 5, [], [{ name: 'b.bin', size: 5 }])
    }
    const s = computeDirStats((i) => t[i], 1)
    expect(s.largestFile).toEqual({ name: 'a.txt', path: 'D:\\foo\\a.txt', size: 10 })
    expect(s.largestFile!.path).not.toMatch(/\\\\/)
  })

  it('id 不在这棵树上：整份统计为空（0 / null），不抛也不冒充 partial', () => {
    expect(computeDirStats(nodeOf, 999)).toEqual({
      size: 0,
      files: 0,
      dirs: 0,
      largestFile: null,
      largestSubDir: null,
      partial: false,
      visited: 0
    })
  })

  it('病态图（环 / 误用）不得钉死主进程：到预算就停，visited 如实', () => {
    // 真实 TreeStore 走不到环（attachChild 拒自环与父子倒挂），所以这条护的不是树而是这个函数本身：
    // 删掉预算判据后这条**永远不返回**（同步死循环，计时器都抢不到），那正是 §28 说的"主进程被一次点击钉死"。
    const cyc: Record<number, DirStatsNode> = {}
    for (let i = 0; i < 40; i++) {
      cyc[i] = dir(`C:\\c${i}`, `c${i}`, 1, [(i + 1) % 40])
    }
    const s = computeDirStats((i) => cyc[i], 0, 7)
    expect(s.partial).toBe(true)
    expect(s.visited).toBe(7)
  })

  /* ---- 以下三条守的是「预算框住了什么」：预算必须框住真正随规模增长的那笔开销 ---- */

  it('预算按**入栈**计费：高扇出的环不能把栈撑爆（取节点次数被预算封死）', () => {
    // 40 格连环、每格 50 条 childIds —— attachChild 拒环，所以这是"第二道防线"的假想敌。
    // 弹出侧计费：每弹一格花 50 次取节点、往栈里放 50 个条目 → 总开销 O(预算 × 扇出) = 5000，
    // 栈峰值能长到 ~4900；换成真实预算 200 万、扇出几百，那就是上亿个条目 —— 防线自己先 OOM，
    // 交不出"有界的 partial"。入栈侧计费后 stack.length <= 取节点次数 <= 预算。
    // 栈长度拿不到（也不该为测试暴露内部状态），但**取节点次数是它的上界**：
    // 每一次入栈都要取一次节点，所以次数被钉住 ⇒ 栈不可能越过它长。
    const FANOUT = 50
    const BUDGET = 100
    const nodes: Record<number, DirStatsNode> = {}
    for (let i = 0; i < 40; i++) {
      nodes[i] = dir(`C:\\c${i}`, `c${i}`, 1, Array.from({ length: FANOUT }, () => (i + 1) % 40))
    }
    let lookups = 0
    const s = computeDirStats(
      (i) => {
        lookups++
        return nodes[i]
      },
      0,
      BUDGET
    )
    expect(s.partial).toBe(true)
    expect(s.visited).toBeLessThanOrEqual(BUDGET)
    // 上限的三项：1（取根）+ FANOUT（「最大子目录」那一趟直属子节点，刻意不占预算，见实现里的注释）
    // + BUDGET（入栈次数，栈长度的上界）。弹出侧计费下这一项是 1 + 50 + 100×50 = 5051。
    expect(lookups).toBeLessThanOrEqual(1 + FANOUT + BUDGET)
  })

  // vitest 5 不把 `%p` 塞进标题（五条会印成同一个名字，红了不知道是哪条），所以手写循环。
  const BAD_BUDGETS: ReadonlyArray<readonly [string, number]> = [
    ['NaN', NaN],
    ['0', 0],
    ['-1', -1],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity]
  ]
  for (const [label, bad] of BAD_BUDGETS) {
    it(`预算是 ${label} 时这道防线不许被"顺带关掉"（压到最小合法值 1）`, () => {
      // `visited >= NaN` 恒为 false：NaN / Infinity 不是"预算很大"，是"没有预算"。
      // 0 / 负数则相反 —— 连被点那格自己的直属文件都没看一眼就把 largestFile 报成 null。
      // 用的是**有穷**的菱形 DAG（i → i+1、i → i+2，无环）：防线被关掉时这一趟会走完整棵树
      //（17,710 次弹出），于是这条能红着回来，而不是把整个 vitest run 挂在同步死循环里。
      const N = 20
      const nodes: Record<number, DirStatsNode> = {}
      for (let i = 0; i < N; i++) {
        const kids: number[] = []
        if (i + 1 < N) kids.push(i + 1)
        if (i + 2 < N) kids.push(i + 2)
        nodes[i] = dir(`C:\\d${i}`, `d${i}`, 1, kids, [{ name: `d${i}.bin`, size: 100 - i }])
      }
      let lookups = 0
      const s = computeDirStats(
        (i) => {
          lookups++
          return nodes[i]
        },
        0,
        bad
      )
      expect(s.visited).toBe(1) // 只走被点那格自己
      expect(s.partial).toBe(true) // 它还有 childIds 没看完，必须点名
      expect(s.largestFile).toEqual({ name: 'd0.bin', path: 'C:\\d0\\d0.bin', size: 100 })
      // 取节点次数 = 1（取根）+ 2（root 那两条 childIds 的「最大子目录」一趟）+ 1（入栈一次就被闸住）。
      // 防线被关掉的话这一趟会走完整个菱形图（几万次取节点）。
      expect(lookups).toBeLessThanOrEqual(4)
    })
  }

  it('被预算拒掉的 childIds 可能一个都没入栈（悬空 id）：栈自然清空，partial 仍得由入栈那条点名', () => {
    // 弹出侧那条判据只在**栈非空**时说得上话。这里三条悬空 childIds 把 work 花光、
    // 又没往栈里放任何东西，于是栈是空的、`visited` 永远够不到预算 ——
    // 而入栈侧确实拒了第 4 条 childIds（那格有文件）。不点名就是"少算了却没说"。
    const t: Record<number, DirStatsNode> = {
      1: dir('C:\\r', 'r', 10, [9, 9, 9, 2]),
      2: dir('C:\\r\\A', 'A', 7, [], [{ name: 'a.bin', size: 7 }])
    }
    const s = computeDirStats((i) => t[i], 1, 3)
    expect(s.partial).toBe(true)
    expect(s.visited).toBe(1)
    expect(s.largestFile).toBeNull() // 被拒的那格确实没被访问到（这正是 partial 要说的事）
  })

  it('比当量冠军小的文件不配一次路径拼接（3M 条清单是在主进程上同步跑的）', () => {
    // maxFiles 上限 3,000,000 条：给每条都拼一次路径 + 分配一个对象，点一下根目录就不是"毫秒级"了。
    // 判据是严格小于，所以**等于**当量冠军的那些仍然要走完（还要比 path）。
    // 观测手段：把 name 做成 getter —— 实现只在"给这条文件构造命中"时才读 f.name，
    // 所以读名字的次数就是"拼了几次路径"。输家一次都不该读。
    let nameReads = 0
    const probe = (name: string, size: number): { name: string; size: number } => {
      const o: { name: string; size: number } = { name, size }
      // 把 name 换成 accessor：读一次 = 实现真的为这条文件构造过一次命中（拼了一次路径）
      Object.defineProperty(o, 'name', { get: () => (nameReads++, name), enumerable: true })
      return o
    }
    const files = [probe('champ.bin', 1000)]
    for (let i = 0; i < 999; i++) files.push(probe(`f${i}.dat`, 1))
    const t: Record<number, DirStatsNode> = { 1: dir('C:\\r', 'r', 1999, [], files) }
    const s = computeDirStats((i) => t[i], 1)
    expect(s.largestFile).toEqual({ name: 'champ.bin', path: 'C:\\r\\champ.bin', size: 1000 })
    expect(nameReads).toBeGreaterThan(0) // 探针是活的
    expect(nameReads).toBeLessThanOrEqual(2) // 只有冠军那一条：构造命中时 name 被读 1~2 次（闸没了是 2000）
  })
})

describe('TreeStore.dirStatsOf（同一套口径跑在真实内存树上，零 syscall）', () => {
  const f = (name: string, size: number): FileEntry => ({
    name,
    size,
    mtimeMs: 1,
    birthtimeMs: 1,
    attrs: 0
  })

  /** root(5) ├ A ├ Deep(900) └ B(10)：最大文件在孙层，最大子目录是 A。 */
  const build = (): TreeStore => {
    const store = new TreeStore({ rootPath: 'C:\\r', maxFiles: 1000 })
    const a = store.beginDir('C:\\r\\A')
    const deep = store.beginDir('C:\\r\\A\\Deep')
    const b = store.beginDir('C:\\r\\B')
    store.addFilesToDir(store.rootId, [f('root.dat', 5)])
    store.addFilesToDir(deep, [f('huge.bin', 900)])
    store.addFilesToDir(b, [f('small.bin', 10)])
    store.finalizeDir(store.rootId)
    expect(store.getDir(a)?.name).toBe('A') // 前置条件：三层都挂上了
    return store
  }

  it('最大文件取整棵子树、最大子目录只取直属，size/files/dirs 与 finalizeDir 同源', () => {
    const s = build().dirStatsOf(0)
    expect(s.largestFile).toEqual({ name: 'huge.bin', path: 'C:\\r\\A\\Deep\\huge.bin', size: 900 })
    expect(s.largestSubDir).toEqual({ name: 'A', path: 'C:\\r\\A', size: 900 })
    expect(s).toMatchObject({ size: 915, files: 3, dirs: 3, partial: false, visited: 4 })
  })

  it('同一个文件的完整路径：dirStatsOf 与 childrenOf 必须逐字相同（根带尾斜杠时尤其）', () => {
    // childrenOf / addFilesToDir 一直走 joinWin，dirStatsOf 曾经手搓过一次拼接判据。
    // 根写成 `E:\scan\` 时两者就分叉了：面板上方那行路径是 `E:\scan\at-root.bin`，
    // 而「最大文件」的 title 是 `E:\scan\\at-root.bin` —— 同一次点击给出两个路径，
    // 用户复制哪个、右键定位哪个都成了碰运气。这条测的是"两个口径必须同源"，不是字符串形状。
    const store = new TreeStore({ rootPath: 'E:\\scan\\', maxFiles: 1000 })
    const kid = store.beginDir('E:\\scan\\sub')
    store.addFilesToDir(store.rootId, [f('at-root.bin', 99)])
    store.addFilesToDir(kid, [f('in-kid.bin', 5)])
    store.finalizeDir(store.rootId)

    const rootFiles = new Map(store.childrenOf(store.rootId).map((c) => [c.name, c.path]))
    expect(rootFiles.get('at-root.bin')).toBe('E:\\scan\\at-root.bin')
    const stats = store.dirStatsOf(store.rootId)
    expect(stats.largestFile?.name).toBe('at-root.bin')
    expect(stats.largestFile?.path).toBe(rootFiles.get('at-root.bin'))

    // 对照：不带尾斜杠的那一层，两条口径本来就一致 —— 别把修成了另一处的 bug 当成这条过了
    const kidFiles = new Map(store.childrenOf(kid).map((c) => [c.name, c.path]))
    expect(kidFiles.get('in-kid.bin')).toBe('E:\\scan\\sub\\in-kid.bin')
    expect(store.dirStatsOf(kid).largestFile?.path).toBe(kidFiles.get('in-kid.bin'))
  })

  it('未知 dirId 回落到根：渲染端拿 -1 当哨兵是既有约定，不能回一份空统计', () => {
    const store = build()
    expect(store.dirStatsOf(-1)).toEqual(store.dirStatsOf(store.rootId))
  })

  it('仍在扫描的目录：给的是此刻内存里的快照，partial 仍为 false（partial 只说预算，不说"没扫完"）', () => {
    const store = new TreeStore({ rootPath: 'D:\\live', maxFiles: 1000 })
    const kid = store.beginDir('D:\\live\\Kid')
    store.addFilesToDir(kid, [f('one.bin', 40)])
    store.setLive(store.rootId, 40, 1, true)
    const s = store.dirStatsOf(store.rootId)
    expect(s).toMatchObject({ size: 40, files: 1, partial: false })
    expect(s.largestFile).toEqual({ name: 'one.bin', path: 'D:\\live\\Kid\\one.bin', size: 40 })
    expect(s.largestSubDir).toEqual({ name: 'Kid', path: 'D:\\live\\Kid', size: 0 })
  })
})
