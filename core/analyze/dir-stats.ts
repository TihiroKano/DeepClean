import { joinWin } from '../fs/pathutil'
import type { DirStatHit, DirStats } from '../../shared/types'

/**
 * §9 的目录统计。刻意做成**纯函数 + 注入取节点**：
 * 真实实现挂在 TreeStore 上（内存遍历，零 syscall），但口径本身要能在没有扫描器的情况下被测。
 * 预算（budget）是硬要求：点一下根目录就遍历 37 万个节点是可以接受的（主进程、单次、毫秒级），
 * 但一个环或一次误用把主进程钉死是不可接受的。
 *
 * 线格式（`DirStats` / `DirStatHit`）定义在 `shared/types.ts` 并在下面原样 re-export：
 * `tsconfig.web` 是 composite 白名单项目，渲染进程只许引 shared，不引本文件（见那份 include）。
 *
 * 路径拼接用 `core/fs/pathutil` 的 `joinWin`，和 `TreeStore.childrenOf` / `addFilesToDir` 同一个函数。
 * 计划里那句「`joinWin` 走的是 `node:path` 的 win32 分支，所以本模块刻意不引它」是错的 ——
 * `pathutil.ts` 什么都不 import。手搓判据的代价也是真的：`endsWith(':\\')` 只认盘符根，
 * 而 `validateRoot` 收 `D:\foo\` 这种带尾斜杠的写法，于是根上的文件会被拼成 `D:\foo\\a.txt`，
 * 和同一格里 `childrenOf` 给的 `D:\foo\a.txt` 对不上（悬停 `title` 显示的那条就是它）。
 */
export type { DirStatHit, DirStats } from '../../shared/types'

/** `computeDirStats` 眼里的一个目录节点。`TreeStore.DirRecord` 结构上已满足它，不需要适配器。 */
export interface DirStatsNode {
  size: number
  fileCount: number
  dirCount: number
  path: string
  name: string
  childIds: readonly number[]
  files: ReadonlyArray<{ name: string; size: number }>
}

/** 同 size 时按 path 字典序 —— 定序键必须全序，否则同一棵树两次点会给出不同的「最大」。 */
const better = (a: DirStatHit, b: DirStatHit | null): boolean =>
  b === null || a.size > b.size || (a.size === b.size && a.path < b.path)

/** 归一后的最小预算：至少走完被点的那一格自己（它的直属文件也要看一眼）。 */
const MIN_BUDGET = 1

/**
 * 预算归一。判据必须是"非有限数一律压到 `MIN_BUDGET`"，而不是"看着像数字就收下"：
 * - `visited >= NaN` 恒为 false —— 一个手滑传进来的 NaN（`parseInt` 失败、配置缺字段）
 *   不会把预算调小，而是把这道防线**整条关掉**，等于在最坏的一档上按下"无上限"；
 * - `Infinity` 同理（`Number.isFinite` 为 false）。想要宽预算就显式传一个大整数
 *   （默认值 2,000,000 就是这么给的），不给 NaN / Infinity 开"无界"的后门；
 * - `0` / 负数在原来的判据下是"第一格就 partial"，被点那格的直属文件一条都没看就把
 *   `largestFile` 报成 null —— 那不是保守，那是漏报。压到 `MIN_BUDGET` 后至少走完本格。
 * 非整数按 `Math.floor` 走，为的是 `visited <= 预算` 这个 UI 会引用的不变量。
 *
 * V0.3 Task 1 起 `core/analyze/engine.ts` 共用这一份：**同一道防线不该有两个实现** ——
 * 这里改了判据（比如又发现一种"看着像数字其实是 NaN"的入口）而分析层没跟着改，
 * 坏的就是整盘分析，而且坏法是"悄悄无界"，测试里看不出来。
 */
export const normalizeBudget = (b: number): number => (Number.isFinite(b) && b >= 1 ? Math.floor(b) : MIN_BUDGET)

export function computeDirStats(
  nodeOf: (id: number) => DirStatsNode | undefined,
  rootId: number,
  budget: number = 2_000_000
): DirStats {
  const max = normalizeBudget(budget)
  const root = nodeOf(rootId)
  const out: DirStats = {
    size: root?.size ?? 0,
    files: root?.fileCount ?? 0,
    dirs: root?.dirCount ?? 0,
    largestFile: null,
    largestSubDir: null,
    partial: false,
    visited: 0
  }
  if (!root) return out

  // 「最大子目录」只看**直属**那一层，所以它是 O(子节点数) 的一趟，不进下面的预算计数：
  // 一个目录的直属子节点在真实盘上是"几百到几万"，不是"几百万"，且这一趟没有递归也没有栈。
  for (const cid of root.childIds) {
    const c = nodeOf(cid)
    if (!c) continue
    const hit: DirStatHit = { name: c.name, path: c.path, size: c.size }
    if (better(hit, out.largestSubDir)) out.largestSubDir = hit
  }

  // 「最大文件」要看**整个子树**：刻意用显式栈而不是递归 ——
  // 真实 C:\ 的聚合深度加上误挂的重解析点足以把递归栈打穿（`attachChild` 拒环，但不许只靠它）。
  //
  // 预算**按「取节点 / 入栈」次数**计（`work`），不按弹出次数计：一个被弹出的目录会往栈里
  // 放"它全部 childIds"那么多个条目，所以弹出侧计费下 `stack.length` 能长到 O(预算 × 扇出) ——
  // 环 + 几百扇出时那是上亿个条目，这道防线自己先 OOM，而不是交出一份有界的 partial。
  // 按入栈计费后 `stack.length <= work <= max`，两条一起封死。
  // 弹出侧那条判据（`visited >= max`）仍然留着：它守的是 `visited <= max`
  // （`partial` 那句要在 UI 上点名的 N），以及"被弹出的目录数"这个文件内层循环的轮数上限。
  const stack: DirStatsNode[] = [root]
  let work = 0
  while (stack.length > 0) {
    if (out.visited >= max) {
      out.partial = true
      break
    }
    const n = stack.pop()!
    out.visited++
    for (const f of n.files) {
      // 输家不配得一条拼好的路径：`maxFiles` 上限是 3,000,000 条文件记录，全给它们做
      // 「一次字符串拼接 + 一次对象分配」的话，点一下根目录就是同步 600 万次分配 —— 主进程、
      // 一次点击、不是注释里那句"毫秒级"。压到只剩当量冠军及其并列者之后，输家只是一次数值比较。
      // 判据必须是**严格小于**：size 相等时还要拿 path 比分出胜负（`better` 的第二条键），
      // 写成 `<=` 就把「最大文件」交回给访问顺序决定了 —— 那正是这条 tie-break 存在的理由。
      if (out.largestFile !== null && f.size < out.largestFile.size) continue
      const hit: DirStatHit = { name: f.name, path: joinWin(n.path, f.name), size: f.size }
      if (better(hit, out.largestFile)) out.largestFile = hit
    }
    for (const cid of n.childIds) {
      if (work >= max) {
        // 还有 childIds 没看完 = 有活被拒了，必须点名；不能只靠上面那条弹出判据（栈清空时就再也走不到它）
        out.partial = true
        break
      }
      work++
      const c = nodeOf(cid)
      if (c) stack.push(c)
    }
  }
  return out
}
