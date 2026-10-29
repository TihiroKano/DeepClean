import { describe, expect, it } from 'vitest'
import { toTiles } from '../../core/analyze/treemap-data'
import { navAfterExclude, navView, NO_CHILDREN, topOf, type Level } from '../../core/analyze/tree-nav-state'
import type { ChildView } from '../../shared/types'

/**
 * Task 6 评审 Fix 1 的守卫：`useTreeNav` 空栈时返回的 `children` 必须**引用恒定**。
 *
 * 为什么测的是纯函数而不是真组件：本仓库的 vitest 是 `environment: 'node'`、include 只收 `tests` 下的
 * 没装 jsdom 也没装 react-test-renderer（计划禁止新增依赖），`react-dom/client` 起不来 →
 * `useEffect` 根本不会执行 → 那条自旋在测试环境里**物理上无法复现**。所以把环路里唯一会变的那一环
 * （`nav.children` 的引用）连同它下游的行为抽成纯函数来钉，下面第三条测试按环逐圈手推。
 */

const BOX = { x: 0, y: 0, w: 1000, h: 640 }

let nextId = 1
const dir = (name: string, size: number): ChildView => ({
  kind: 'directory',
  name,
  path: `C:\\${name}`,
  dirId: nextId++,
  size,
  mtimeMs: 1,
  birthtimeMs: null,
  fileCount: 0,
  dirCount: 0,
  attrs: null
})

const level = (dirId: number, path: string, children: ChildView[], extra: Partial<Level> = {}): Level => ({
  dirId,
  path,
  children,
  size: children.reduce((s, c) => s + c.size, 0),
  totalChildren: children.length,
  foldedCount: 0,
  foldedBytes: 0,
  excludedCount: 0,
  excludedBytes: 0,
  sessionExcludedCount: 0,
  sessionExcludedBytes: 0,
  rootSize: 0,
  ...extra
})

describe('navView / 空栈的 children 引用恒定（否则 onTiles 上抛无界自旋）', () => {
  it('空栈：两次连续派生给出同一个数组引用，且它是那个模块级常量', () => {
    expect(navView([]).children).toBe(NO_CHILDREN)
    expect(navView([]).children).toBe(navView([]).children)
    expect(navView([]).children).toHaveLength(0)
    expect(topOf([])).toBeNull()
  })

  it('非空栈：children 就是那一层自己的数组（没被换成共享常量，也不该被复制）', () => {
    const l = level(1, 'C:\\', [dir('a', 5)])
    expect(navView([l]).children).toBe(l.children)
    expect(navView([l]).children).not.toBe(NO_CHILDREN)
    // 换层（新 Level）才会换引用；同一层重渲染不换
    expect(navView([l]).children).toBe(navView([l]).children)
  })

  it('反证（这条测试为什么有牙）：老写法 `head?.children ?? []` 每圈都给新引用，而下游没人兜得住', () => {
    const buggy = (stack: Level[]): ChildView[] => topOf(stack)?.children ?? []
    expect(buggy([])).not.toBe(buggy([]))
    // 环路下游那一环（tiles）本身就每次新数组 —— 空层的 toTiles 按构造返回字面量 []，
    // 所以下游不可依赖，收敛点只能是 items。这两行一起说明上面那条断言钉的是真问题。
    expect(toTiles([], BOX, 'type')).not.toBe(toTiles([], BOX, 'type'))
  })

  it('渲染环路模拟：空栈连跑 50 圈，上抛 effect 只许触发第 1 圈', () => {
    // 逐环复刻 TreemapCanvas + SpaceMap 那一圈（没有 jsdom，只能手推，链条与代码一一对应）：
    //   渲染 → items = navView(stack).children
    //       → tiles = useMemo(items, size, mode, foldedCount, foldedBytes, levelSize, rootSize)
    //       → effect [tiles, onTiles]：tiles 变引用就 setTiles(tiles)
    //       → 页面重渲染 → 回到第一行。
    // memo 依赖里除 items 之外全是原始值（size 是 useState 的产物、其余是 number），
    // 所以「memo 命中」等价于「items 引用没变」。修复前 items 每圈都是新 []，effectRuns = 51。
    let items = navView([]).children
    let tiles = toTiles(items, BOX, 'type')
    let effectRuns = 1
    for (let i = 0; i < 50; i++) {
      const nextItems = navView([]).children
      const nextTiles = nextItems === items ? tiles : toTiles(nextItems, BOX, 'type')
      if (nextTiles !== tiles) effectRuns++
      items = nextItems
      tiles = nextTiles
    }
    expect(effectRuns).toBe(1)
  })

  it('抽成 navView 没有改行为：派生字段与旧 hook 里那几行 `head?.x ?? 默认值` 逐项一致', () => {
    const root = level(1, 'C:\\', [dir('a', 5)], {
      totalChildren: 3,
      foldedCount: 2,
      foldedBytes: 9,
      excludedCount: 1,
      excludedBytes: 4,
      // 与上面那份**必须不同值**：本轮累计那份与本层那份是两个口径，
      // 写成一样的数就没哪条派生接错了（横幅读错成"本层那份"正是 Task 7 修订 Fix 2 修的那个 bug）
      sessionExcludedCount: 7,
      sessionExcludedBytes: 777,
      rootSize: 100
    })
    const sub = level(2, 'C:\\a', [dir('b', 5)])
    expect(navView([root])).toEqual({
      children: root.children,
      size: 5,
      path: 'C:\\',
      totalChildren: 3,
      foldedCount: 2,
      foldedBytes: 9,
      // Task 7 的四个排除记账：交叉赋值也测得出（9 / 4 / 100 / 3 / 7 / 777 两两不等）
      excludedCount: 1,
      excludedBytes: 4,
      sessionExcludedCount: 7,
      sessionExcludedBytes: 777,
      rootSize: 100,
      rootPath: 'C:\\',
      canBack: false
    })
    // 栈深两层：head 取栈顶，rootPath 取栈底，canBack = 栈长 > 1
    expect(navView([root, sub])).toMatchObject({ path: 'C:\\a', size: 5, rootPath: 'C:\\', canBack: true })
    expect(navView([])).toEqual({
      children: NO_CHILDREN,
      size: 0,
      path: '',
      totalChildren: 0,
      foldedCount: 0,
      foldedBytes: 0,
      excludedCount: 0,
      excludedBytes: 0,
      sessionExcludedCount: 0,
      sessionExcludedBytes: 0,
      rootSize: 0,
      rootPath: '',
      canBack: false
    })
  })

  /**
   * Task 7 修订 Fix 2 的派生半边：跨层那份与 head 的其它字段一样被带出来，且**空栈给 0**。
   *
   * 空栈那一支不是凑数：横幅的门是"个数 > 0"，而 `?? 0` 写成 `?? 上一份` 之类就会在
   * 换 scanId（`setStack([])`）那一瞬间把上一轮的数字留在屏上。
   */
  it('本轮累计那份独立派生：栈顶是谁就报谁的两份数，跨层与本层互不串味', () => {
    const root = level(1, 'C:\\', [dir('a', 5)], {
      excludedCount: 0,
      excludedBytes: 0,
      sessionExcludedCount: 2,
      sessionExcludedBytes: 777
    })
    const deep = level(2, 'C:\\a', [], { excludedCount: 1, excludedBytes: 640, sessionExcludedCount: 2, sessionExcludedBytes: 777 })
    // 站在根那一层：本层那份是 0（`a` 没被排除），本轮那份仍是 2 —— 横幅因此不会随层级消失
    expect(navView([root])).toMatchObject({ excludedCount: 0, excludedBytes: 0, sessionExcludedCount: 2, sessionExcludedBytes: 777 })
    // 站在 deep 那一层：两份数字**两两不等**，接错任何一根线都立刻看得见
    expect(navView([root, deep])).toMatchObject({ excludedCount: 1, excludedBytes: 640, sessionExcludedCount: 2, sessionExcludedBytes: 777 })
    // 会话换了（栈清空）：两份都归 0，横幅整段消失
    expect(navView([]).sessionExcludedCount).toBe(0)
    expect(navView([]).sessionExcludedBytes).toBe(0)
  })
})

/* ------------------------------------------------------------------ *
 * Task 7 修订 Fix 3：`navAfterExclude` —— 「排除成功之后视图该做什么」的真值表。
 *
 * 这三条分支今天**没有**任何自动化证据（原报告把 (a)(b) 登记成遗留项）：本仓库 vitest 是 node 环境、
 * 没有 jsdom，hook 挂不起来。抽成纯函数之后每一条都能逐分支钉，并且跑得动变异（M4/M5 见 task-7 报告）。
 * 剩下没抽走的那一条是「钉住后点画布空白处不换详情 / 换层解除固定」—— 那是真事件 + 真 effect，
 * node 环境里物理上复现不了，只能靠截图（报告里照实写着，这里不假造一条只断言实现细节的守卫）。
 * ------------------------------------------------------------------ */
describe('navAfterExclude：一次成功的排除/撤销之后，视图该做的四个决定（Task 7 修订 Fix 3）', () => {
  /** 三层栈：根(1) → C:\a(2) → C:\a\b(3)。dirId 就是导航栈上的位置，与被排除者/详情者对照用。 */
  const s3 = (): Level[] => [level(1, 'C:\\', [dir('a', 5)]), level(2, 'C:\\a', [dir('b', 4)]), level(3, 'C:\\a\\b', [])]

  it('(a) 被排除的是当前层的祖先（栈上第 1 层）：连同更深的层一起退出去，重画的是**新**栈顶', () => {
    const d = navAfterExclude(s3(), 2, 3)
    expect(d).toEqual({ keepDepth: 1, redrawDirId: 1, dropStats: true, unpin: true })
    // 停在最近一个还在图上的层：`3` 那一层在 `2` 里面，`2` 被藏了就没地方站了
    expect(s3().slice(0, d.keepDepth).map((l) => l.dirId)).toEqual([1])
  })

  it('(a) 被排除的是当前层自己（栈顶）：退一层，仍然重画剩下的那一层', () => {
    expect(navAfterExclude(s3(), 3, null)).toEqual({ keepDepth: 2, redrawDirId: 2, dropStats: true, unpin: true })
  })

  /**
   * 驱逐到空是禁止的：把用户留在一层"刚刚被自己从地图上抹掉"的空图，比原地留着危险
   * （空图会被读成"盘是空的"）。store 那头的 `canExclude` 已经先拒了排除根，
   * 这里是第二道构造性防线 —— 导航栈是被多个动作复用的状态，将来新入口照样能把根 id 递进来。
   */
  it('(a) 栈底（扫描根）那一支：栈一步都不退', () => {
    expect(navAfterExclude(s3(), 1, null)).toEqual({ keepDepth: 3, redrawDirId: 3, dropStats: false, unpin: false })
  })

  it('(a) 被排除的不在栈上（今天菜单唯一可达的形状）：栈不动，但当前层必须重画', () => {
    expect(navAfterExclude(s3(), 99, 5)).toEqual({ keepDepth: 3, redrawDirId: 3, dropStats: false, unpin: false })
  })

  it('(b) 排除掉当前显示统计的那个块：屏上那份数字必须跟着走（选中、统计、钉住三件一起）', () => {
    expect(navAfterExclude(s3(), 99, 99)).toMatchObject({ dropStats: true, unpin: true })
    // 详情里那一格没有 dirId（文件格 / 合计块）→ 谈不上"被排除掉了"，不许误清
    expect(navAfterExclude(s3(), 99, null).dropStats).toBe(false)
    expect(navAfterExclude(s3(), 99, undefined).dropStats).toBe(false)
    // 详情里是**另一格**：它还在屏上，数字与钉住都得留着
    expect(navAfterExclude(s3(), 99, 98).dropStats).toBe(false)
  })

  it('撤销一次排除（excluded=false）什么都没丢：栈、统计、钉住一律保持，只重画当前层', () => {
    expect(navAfterExclude(s3(), 2, 2, false)).toEqual({ keepDepth: 3, redrawDirId: 3, dropStats: false, unpin: false })
    expect(navAfterExclude(s3(), 99, 99, false)).toEqual({ keepDepth: 3, redrawDirId: 3, dropStats: false, unpin: false })
  })

  it('还没有任何一层（首次挂载 / 换 scanId 那一刻）：无层可重画，详情该清的仍要清', () => {
    expect(navAfterExclude([], 7, 7)).toEqual({ keepDepth: 0, redrawDirId: null, dropStats: true, unpin: true })
    expect(navAfterExclude([], 7, null)).toEqual({ keepDepth: 0, redrawDirId: null, dropStats: false, unpin: false })
  })
})
