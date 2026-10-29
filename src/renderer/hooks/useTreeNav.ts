import { useCallback, useEffect, useRef, useState } from 'react'
import { navAfterExclude, navView, topOf, type Level } from '../../../core/analyze/tree-nav-state'
import type { DirStatsWire, ScanStatus } from '../../../shared/types'

/** 扫描进行中重新拉当前层的间隔。§7 要的是"看得见在动"，比 250ms 的主进程节流粗一档即可。 */
const POLL_MS = 400

export type { Level }

/** dirId 传 -1 = 向主进程要根节点（主进程对未知 id 一律回落到 root，渲染端不必自己存哨兵值）。 */
export function useTreeNav(scanId: string | null, status: ScanStatus, sizeBasis: 'apparent' | 'allocated' = 'apparent') {
  const [stack, setStack] = useState<Level[]>([])
  const busy = useRef(false)
  /** §9 目录统计：只跟着"当前单击的那格目录"走，null = 这一格没有目录统计可言（文件 / 折叠块）。 */
  const [stats, setStats] = useState<DirStatsWire | null>(null)
  /**
   * 统计查询的自增序号，用途是**丢弃已经过期的回包**，别把它当冗余简化掉。
   *
   * 它守的**不是**"两次回包乱序到达"：`IPC.TreeStats` 的 handler 是同步的
   * （`electron/main/ipc-register.ts:48` → 主进程一趟内存遍历，立即 resolve），
   * 所以点 B 之前 A 的回包必然已经落地，连点两格之间不存在交错。
   * 真正常驻的窗口是 **`await` 还挂着、界面已经被别的动作改走**：
   * 双击进入（`onOpen` 里 `clearStats()`）、点空白处取消选中、换 `scanId` 触发的那个 effect ——
   * 这些都不 await 在途的那次查询。没有序号这条判据，A 的统计就会落到刚清空、或刚换走的面板上，
   * 于是「A 格的数字」出现在「B 格」下面 —— 张冠李戴的数字比少一行数字糟得多。
   */
  const statsSeq = useRef(0)

  const statsFor = useCallback(
    async (dirId: number) => {
      const seq = ++statsSeq.current
      try {
        const s = await window.deepclean.getDirStats(scanId ?? '', dirId)
        if (seq === statsSeq.current) setStats(s)
      } catch {
        // 调用方是 `void statsFor(...)`（点格子的动作里不 await），不接住就是一条 unhandled rejection。
        // 更要紧的是**不能什么都不做**：setStats 走不到，上一格留下的统计会原样钉在刚选中的这一格下面。
        // 所以失败一律清空（面板整段不渲染 = "没算出来"，而不是显示别人的数字）。
        if (seq === statsSeq.current) setStats(null)
      }
    },
    [scanId]
  )

  const clearStats = useCallback(() => {
    statsSeq.current++
    setStats(null)
  }, [])

  const pull = useCallback(
    async (dirId: number) => {
      if (!scanId || busy.current) return
      busy.current = true
      try {
        const p = await window.deepclean.getChildren(scanId, dirId, sizeBasis)
        if (!p) return
        setStack((prev) => {
          const level: Level = {
            dirId: p.dirId,
            path: p.path,
            children: p.children,
            size: p.size,
            sizeBasis: p.sizeBasis,
            totalChildren: p.totalChildren,
            foldedCount: p.foldedCount,
            foldedBytes: p.foldedBytes,
            excludedCount: p.excludedCount,
            excludedBytes: p.excludedBytes,
            sessionExcludedCount: p.sessionExcludedCount,
            sessionExcludedBytes: p.sessionExcludedBytes,
            rootSize: p.rootSize
          }
          const i = prev.findIndex((l) => l.dirId === p.dirId)
          return i === -1 ? [...prev, level] : [...prev.slice(0, i), level]
        })
      } finally {
        busy.current = false
      }
    },
    // 口径进依赖：切换口径要**重新拉当前层**，否则地图上的数字还是旧口径的
    // （两个口径的数在 Rust 侧都已算好，这一次只是重取，不重扫）。
    [scanId, sizeBasis]
  )

  useEffect(() => {
    setStack([])
    clearStats()
    if (scanId) void pull(-1)
  }, [scanId, pull, clearStats])

  // §7 增量：扫描没结束就一直重新水合当前层
  const top = stack[stack.length - 1]
  useEffect(() => {
    if (status !== 'running' || !top) return
    const t = setInterval(() => void pull(top.dirId), POLL_MS)
    return () => clearInterval(t)
  }, [status, top?.dirId, pull])

  const enter = useCallback((dirId: number) => void pull(dirId), [pull])

  const back = useCallback(() => {
    setStack((prev) => {
      if (prev.length <= 1) return prev
      const next = prev.slice(0, -1)
      void pull(next[next.length - 1]!.dirId)
      return next
    })
  }, [pull])

  const gotoCrumb = useCallback(
    (i: number) => {
      setStack((prev) => {
        const next = prev.slice(0, i + 1)
        if (next.length !== prev.length) void pull(next[next.length - 1]!.dirId)
        return next
      })
    },
    [pull]
  )

  /**
   * Task 7「排除该目录」= **纯视图**动作（主进程那边只改 `levelOf` 回什么，计价读的 `childrenOf` 不动）。
   * 成功后必须做的两件事，缺一不可 —— 而**该做哪两件**由 `navAfterExclude`
   * （core/analyze/tree-nav-state.ts，纯函数，真值表有单测且跑过变异）决定，这里只执行它的两个决定：
   *
   * 1. **重画当前层**：被藏掉的那一块要立刻从地图上消失，侧栏那句「已排除 N 个目录 · X」也要当场出现。
   *    不重画就是"点了没反应"。
   * 2. **把人从被藏起来的目录里带出来**：若被排除的那个 id 正踩在导航栈上（它就是当前层，或是当前层的
   *    祖先），那一层连同更深的层一起退出，停在最近一个还在图上的层。一个能把"你正在看的这一层"
   *    从地图上抹掉的过滤器，静默留在那儿就是空视图 bug —— 而空视图比报错危险，因为用户会以为盘空了。
   *    今天从菜单点不出这种组合（「排除该目录」只对当前层的直属子项开放，见 `SpaceMap` 的 `menuFor`），
   *    但导航栈是被多个动作复用的状态，这一条按构造防御，不给它留"以后加了新入口就漏"的余地。
   *
   * 回 `false` = 主进程拒了这条（扫描根不许排除 / id 不在树上 / 会话没了）或**根本没问到主进程**
   * （IPC 抛错）。调用方必须据此什么都不改，而不是先清选中再发现没排除成。
   * 两种情况在协议上同一个形状，所以这里一律点名到 console —— 静默换 false 会让人以为"点了没用"，
   * 而真相是"这条动作根本没送到主进程"，那是两条不同的诊断路径。
   */
  const setExcluded = useCallback(
    async (dirId: number, excluded: boolean): Promise<boolean> => {
      if (!scanId) return false
      let ok = false
      try {
        ok = (await window.deepclean.setExcluded(scanId, dirId, excluded))?.ok === true
      } catch (err) {
        console.warn('[nav] setExcluded 的 IPC 调用抛错，这次排除/撤销没有送到主进程', { scanId, dirId, excluded, err })
        ok = false
      }
      if (!ok) return false
      // 该驱逐哪一层、该重画哪一层：交给 core/analyze 的纯函数（有真值表单测 + 跑过变异）。
      // `activeDirId` 不在这里传 —— 详情面板那份选中与钉住住在 `SpaceMap`，它自己用同一个函数问一遍。
      const d = navAfterExclude(stack, dirId, null, excluded)
      if (d.keepDepth < stack.length) {
        const kept = stack.slice(0, d.keepDepth)
        setStack(kept)
        clearStats() // 退出去的那一层留下的统计不许钉在这一层下面（与 statsFor 的序号同一条纪律）
      }
      if (d.redrawDirId !== null) void pull(d.redrawDirId)
      return true
    },
    [scanId, stack, pull, clearStats]
  )

  /**
   * 一句「清除全部排除」= 本轮整张地图回到未排除状态（排除是 per-scan 的内存状态，没有"只清这一层"）。
   *
   * 回 `false` 时**故意不重画**：撤销没生效却把屏上那句「已排除 N 个目录」抹掉，等于让界面宣称
   * "已经全部还给你了"—— 而地图实际上还少着一块。留着旧数字（那正是"仍然挂着过滤器"的真相）+
   * 由调用方（`SpaceMap` 的横幅）改说「清除没有生效」，才是这句谎的解毒剂。
   * 这里也不重画：拉一次只会用"上一份旧数字"覆盖，不会多知道任何事（真正的状态变化要等下一次成功动作）。
   */
  const clearExclusions = useCallback(async (): Promise<boolean> => {
    if (!scanId) return false
    let ok = false
    try {
      ok = (await window.deepclean.clearExclusions(scanId))?.ok === true
    } catch (err) {
      console.warn('[nav] clearExclusions 的 IPC 调用抛错，本轮的排除集可能仍然生效', { scanId, err })
      ok = false
    }
    if (!ok) return false
    // 用 `top`（声明在上面的 §7 轮询 effect 那里）而不是下面的 `head`：
    // `head` 在这个回调**之后**才声明，回调里引用它就是 TDZ 错误。
    if (top) void pull(top.dirId)
    return true
  }, [scanId, top, pull])

  /** 栈顶那一层；null = 还没有任何一层（首次挂载、换 scanId、或会话被主进程收了）。 */
  const head = topOf(stack)
  return {
    stack,
    head,
    /**
     * 派生字段整体交给 `navView`（core/analyze/tree-nav-state.ts，纯函数）—— 空栈时的 `children`
     * 因此是那个模块级常量 `NO_CHILDREN`，引用恒定。这一条不是风格问题：这里曾经写着
     * `children: head?.children ?? []`，每次渲染新造一个数组 → canvas 里 `tiles` 的 useMemo 重算 →
     * `onTiles` 的 effect 把新的 `[]` 喂回 `setTiles` → 页面重渲染 → 又一个新 `[]` → 无界自旋
     * （React dev 会打「Maximum update depth exceeded」，生产构建没这个检查 = 静默烧 CPU）。
     * 依赖里只有 items 是对象，收敛点唯一；钉它的测试在 `tests/unit/tree-nav-state.test.ts`。
     */
    ...navView(stack),
    /**
     * 当前这一层的字节**口径**（`'apparent' | 'allocated'`）。界面上的「表观/占用」标签读它。
     * 缺省 `'apparent'`：Electron 侧现行实现不带这个字段，行为必须与从前逐字相同。
     */
    payloadBasis: (head?.sizeBasis ?? 'apparent') as 'apparent' | 'allocated',
    /** §9 那两行（最大文件 / 最大子目录）的数据源；null = 当前选中的不是真实目录。 */
    stats,
    statsFor,
    clearStats,
    enter,
    back,
    up: back,
    gotoCrumb,
    /** Task 7 视图排除：`setExcluded(dirId, true|false)` / 一句全清。两个都回"主进程收下了没有"。 */
    setExcluded,
    clearExclusions,
    refresh: () => head && void pull(head.dirId)
  }
}
