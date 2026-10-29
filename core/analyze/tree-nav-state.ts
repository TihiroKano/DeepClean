import type { ChildView } from '../../shared/types'

/**
 * `useTreeNav` 的**纯派生段**（Task 6 评审 Fix 1）。
 *
 * 为什么从 hook 文件里搬出来：hook 本体要用 `window.deepclean` 与 React，只有 `tsconfig.web.json`
 * （lib DOM）编得动，而本仓库的 vitest 是 `environment: 'node'`、include 只收 `tests` 目录下的
 * 测试文件、没有 jsdom（计划禁止新增依赖）—— 真组件挂载跑不起来。环路的收敛点（见 `NO_CHILDREN`）
 * 必须能被单测钉住，所以把它放进这份和 `treemap-data.ts` / `top-rows.ts` 同先例的模块：
 * `core` 目录被 node 与 web 两套配置同时编译，渲染端照常 import，测试也 import 得动。
 */

/** 栈里的一层 = 主进程 `ChildrenPayload` 的一次快照（`useTreeNav` 的 `useState<Level[]>` 存的就是它）。 */
export interface Level {
  dirId: number
  path: string
  children: ChildView[]
  size: number
  /**
   * 这一层字节数的口径。**缺省 = `'apparent'`**（Electron 侧不带这个字段 ⇒ 老行为逐字不变）；
   * Tauri 的 Rust 内核回 `'allocated'`（占用、硬链接已去重）。界面上的「表观/占用」标签读它。
   */
  sizeBasis?: 'apparent' | 'allocated'
  /** 以下四个来自 ChildrenPayload（Task 1）：折叠与全盘分母，缺一个 tooltip 就会显示假数。 */
  totalChildren: number
  foldedCount: number
  foldedBytes: number
  /** Task 7：这一层被「排除该目录」藏掉的直属子项个数与合计容量（同样来自 ChildrenPayload）。 */
  excludedCount: number
  excludedBytes: number
  /**
   * Task 7 修订 Fix 2：**本轮累计**的排除记账（跨层），与上面那两个是本层口径**互不替换**。
   * 横幅与「清除全部排除」读这一份，折叠那句读上面那份。
   */
  sessionExcludedCount: number
  sessionExcludedBytes: number
  rootSize: number
}

/**
 * 空栈（还没有任何一层被拉到）时的 `children`。**必须是模块级常量、引用恒定**，不许写成 `?? []`：
 *
 * `TreemapCanvas` 的 `tiles` 是 `useMemo([items, ...])` 的产物，空层的 `toTiles` 每次返回**新的** `[]`
 * （它按构造就是 fresh array），effect `[tiles, onTiles]` 于是每圈都把新引用喂给页面的 `setTiles` →
 * 页面重渲染 → 若 `nav.children` 也是新数组，`items` 变 → memo 重算 → 又一个新 `[]` → **无界自旋**。
 * 依赖里其余项（size、mode、foldedCount、foldedBytes、levelSize、rootSize）都是原始值，所以 `items` 是这条链上唯一的
 * 收敛点：它一稳定，第二圈就不存在。第一次挂载（`App.tsx` 一进地图就是空栈）与 `scanId` 变化
 * （`setStack([])`）都会命中这条路径，`scan-service` 的 `children()` 在会话已销毁时回 `null`，
 * `pull` 的 `if (!p) return` 更会让栈**永远**为空。钉它的测试：`tests/unit/tree-nav-state.test.ts`。
 */
export const NO_CHILDREN: ChildView[] = []

/** 渲染状态里由栈派生的那部分（`useTreeNav` 返回值中除 stack、head、stats 与那几个回调之外的全部字段）。 */
export interface NavView {
  children: ChildView[]
  size: number
  path: string
  totalChildren: number
  foldedCount: number
  foldedBytes: number
  /**
   * Task 7 的视图排除记账（**本层**被藏掉的直属子项）。
   *
   * 两个都是 0 = 这一层没有被排除项。0 不是"这一栏存在且为空"：侧栏那句必须整段缺席，
   * 不许印成「已排除 0 个目录」（全局口径：不显示没算过的数字）。
   */
  excludedCount: number
  excludedBytes: number
  /**
   * Task 7 修订 Fix 2 的跨层那份（本轮累计的排除个数与容量）。
   * 侧栏那句「已排除 N 个目录」与「清除全部排除」这一唯一撤销入口**必须**读这一份：
   * 上面那两个是本层口径，钻到别的层就变 0，横幅会连同撤销入口一起消失。
   */
  sessionExcludedCount: number
  sessionExcludedBytes: number
  rootSize: number
  /** 本次扫描的根路径（栈底那一层的 path 就是它，主进程 `pathOf(rootId)` 给的）。 */
  rootPath: string
  canBack: boolean
}

/** 栈顶那一层；`null` = 还没有任何一层（首次挂载、换 scanId、或主进程把会话收了）。 */
export function topOf(stack: readonly Level[]): Level | null {
  return stack.length > 0 ? stack[stack.length - 1]! : null
}

/**
 * 从栈导出渲染状态。**同一份栈进来，返回的 `children` 必须是同一个引用**：
 * 非空栈时它是那一层自己的数组（存在 `Level` 对象里，`setStack` 换层才会换引用），
 * 空栈时它是 `NO_CHILDREN`。这条引用恒定性就是 `TreemapCanvas` 那个上抛 effect 不成环的依据。
 */
export function navView(stack: readonly Level[]): NavView {
  const head = topOf(stack)
  return {
    // 空态一律回落到模块级常量：这里新造一个 [] 就是上面那条无界自旋的起点
    children: head ? head.children : NO_CHILDREN,
    size: head?.size ?? 0,
    path: head?.path ?? '',
    totalChildren: head?.totalChildren ?? 0,
    foldedCount: head?.foldedCount ?? 0,
    foldedBytes: head?.foldedBytes ?? 0,
    // 排除记账同折叠记账一样是原始值：新增这几个字段不碰 `children` 的引用恒定性
    excludedCount: head?.excludedCount ?? 0,
    excludedBytes: head?.excludedBytes ?? 0,
    // 跨层那份来自**每一次** payload（主进程现算），所以空栈给 0 就是"还没拉到、什么都不说"
    sessionExcludedCount: head?.sessionExcludedCount ?? 0,
    sessionExcludedBytes: head?.sessionExcludedBytes ?? 0,
    rootSize: head?.rootSize ?? 0,
    /**
     * 「占全盘」那一行只认它：`C:\Users\你` 当根时分母不是整盘，就不能说"全盘"。
     */
    rootPath: stack[0]?.path ?? '',
    canBack: stack.length > 1
  }
}

/* ------------------------------------------------------------------ *
 * Task 7 修订 Fix 3：排除动作之后"视图该做什么"的决策，从 hook 与页面里抽出来。
 *
 * 为什么又走一遍 Task 6 的路子（`navView` 的先例）：这三条分支是本功能里唯一"错了不会被发现"的地方
 * —— 驱逐错层 = 把人扔到莫名其妙的目录里，漏清统计 = 屏上的数字讲的是屏幕上已经没有的那一格。
 * 而本仓库的 vitest 是 node 环境、没有 jsdom、不收 effects 与真点击，组件挂载测不了（见
 * `tests/unit/skip-panel.test.tsx` 文件头）。留在 hook / 页面里 = 只能靠截图；抽出来才有真值表。
 * ------------------------------------------------------------------ */

/** `navAfterExclude` 的返回值：一次成功的排除 / 取消排除之后，视图侧该做的四件事（全部是决定，不是副作用）。 */
export interface ExcludeNav {
  /** 导航栈保留前几层。**只由驱逐决定** —— 等于 `stack.length` 就是"栈不动"。 */
  keepDepth: number
  /** 该重新水合哪一层（null = 这一轮还没有任何一层可画）。驱逐时是**新的栈顶**，不是被藏掉那一层。 */
  redrawDirId: number | null
  /** 该不该清掉屏上那份统计与选中（= 详情里那一格已经不是屏幕上存在的东西了）。 */
  dropStats: boolean
  /** 该不该解除钉住。`dropStats` 为真时钉着的那个对象已经消失，所以必然一起解。 */
  unpin: boolean
}

/**
 * 「排除该目录」（或撤销一次排除）**成功之后**，视图该做的决定。纯函数：吃点击那一刻的状态快照，
 * 吐四个决定，副作用仍由调用方（`useTreeNav` 与 `SpaceMap`）各自执行。
 *
 * 真值表（`tests/unit/tree-nav-state.test.ts` 逐条钉，且跑过变异）：
 *
 * | 情形 | keepDepth | redrawDirId | dropStats / unpin |
 * | --- | --- | --- | --- |
 * | 排除的不在栈上（今天菜单唯一可达的形状） | 栈不动 | 当前栈顶 | 仅当详情里那一格就是它 |
 * | 排除的是栈上第 `i>0` 层（当前层或它的祖先） | `i`：连同更深的层一起退出去 | **驱逐后**的新栈顶 | 一律 true（那份详情属于已退出地图的那一层） |
 * | 排除的是栈底（`i===0`，扫描根） | 栈不动 | 当前栈顶 | 仅当详情里那一格就是它 |
 * | 撤销一次排除（`excluded === false`） | 栈不动 | 当前栈顶 | 一律 false（那一格回来了，什么都没丢） |
 * | 还没有任何一层（空栈） | 0 | null | 仅当详情里那一格就是它 |
 *
 * 两条刻意的选择：
 * 1. **驱逐到空是禁止的**：`i === 0` 那一支什么都不做，因为把用户留在一层"刚刚被自己从地图上抹掉"的
 *    空图，比原地留着危险（空图会被读成"盘是空的"）。store 那头的 `canExclude` 已经先拒了排除根，
 *    这里是第二道构造性防线（导航栈是被多个动作复用的状态，新入口将来照样能把 id 递进来）。
 * 2. `unpin` 不是独立判断，就是 `dropStats`（钉住的定义就是"这一格的详情一直在屏上"）。
 *    这里保留两个字段而不是一个，是为了让「钉住」与「选中 + 统计」这两个**调用方各自持有的状态**
 *    在同一个真值表里被回答，而不是让 `SpaceMap` 自己去猜另一半。
 *
 * @param stack         点击那一刻的导航栈（在 `await` 之前取，两个调用方取的是同一次渲染的同一份快照）
 * @param excludedDirId 这次动作针对的那个 dirId
 * @param activeDirId   详情面板当前那一格的 dirId（折叠合计块没有 dirId → 传 null）
 * @param excluded      true = 排除；false = 撤销排除
 */
export function navAfterExclude(
  stack: readonly Level[],
  excludedDirId: number,
  activeDirId: number | null | undefined,
  excluded = true
): ExcludeNav {
  const i = stack.findIndex((l) => l.dirId === excludedDirId)
  const evicted = excluded && i > 0
  const keepDepth = evicted ? i : stack.length
  const drawn = evicted ? stack[i - 1]! : stack[stack.length - 1]
  const dropStats = excluded && (evicted || activeDirId === excludedDirId)
  return { keepDepth, redrawDirId: drawn ? drawn.dirId : null, dropStats, unpin: dropStats }
}
