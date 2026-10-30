import { useEffect, useMemo, useRef, useState } from 'react'
import { dictFor, useT, type TranslateFn } from '../i18n'
import { translate } from '../i18n/dict'
import { DEFAULT_LOCALE } from '../../../shared/i18n'
import { type ColorMode, type Tile } from '../../../core/analyze/treemap-data'
import { navAfterExclude, type NavView } from '../../../core/analyze/tree-nav-state'
import { FIT, type View } from '../../../core/analyze/treemap-view'
import { topRows, type TopRow } from '../../../core/analyze/top-rows'
import { formatBytes } from '../../../shared/format'
import type { ScanStatus, SkippedWire } from '../../../shared/types'
import { Breadcrumb } from '../components/Breadcrumb'
import { SizeBasisProvider, type SizeBasis } from '../lib/size-basis'
import { ContextMenu, type MenuSpec } from '../components/ContextMenu'
import { DetailPanel } from '../components/DetailPanel'
import { SkipPanel } from '../components/SkipPanel'
import { TopPanel } from '../components/TopPanel'
import { TreemapCanvas, type TreemapCanvasHandle } from '../components/TreemapCanvas'
import { useTreeNav } from '../hooks/useTreeNav'
import type { Level } from '../hooks/useTreeNav'

export function SpaceMap({
  scanId,
  status,
  truncated,
  onAddToCleanup
}: {
  scanId: string | null
  status: ScanStatus
  /** `ScanSnapshot.truncated`：文件清单撞到存储上限。地图页没有 `ScanHud`，这句 caveat 只能自己带。 */
  truncated: boolean
  onAddToCleanup: (absPath: string) => void
}): JSX.Element {
  const t = useT()
  /**
   * 字节口径：**默认表观**，与 SpaceSniffer、与资源管理器「大小」列同一套数。
   *
   * 两套数在扫描时就都算好了（见 Rust `tree_index::SizeBasis`），切这里只是换个字段，
   * **不重扫、不改任何清理计价**（`children_of` 永远是分配去重口径，有测试钉着）。
   */
  const [sizeBasis, setSizeBasis] = useState<SizeBasis>('apparent')
  const nav = useTreeNav(scanId, status, sizeBasis)
  const [colorMode, setColorMode] = useState<ColorMode>('type')
  const [active, setActive] = useState<Tile | null>(null)
  /**
   * Task 7「查看详情」= 把详情面板**钉住**。它要回答的是"这一格我要一直看着"，
   * 与单击选中（悬浮式，下一次点别处就换）是两种意图，所以这里必须是一个真的状态而不是同一个：
   * - 钉住时点**空白处**（`onPick(null)` = 取消选中）不许顺手把这份详情抹掉 —— 那是这一项唯一的用处；
   * - 钉住时点另一格 = 明确的"改看那个"意图，正常换并回到悬浮式；
   * - 钉住的那一格被「排除该目录」从地图上藏掉时一律松手（格子都没了，没有可钉的东西，
   *   面板继续挂着它的数字就是张冠李戴）。
   */
  const [pinned, setPinned] = useState(false)
  /**
   * 上一次「清除全部排除」**没生效**（主进程拒了，或 IPC 压根抛了）。Task 7 修订 Fix 1。
   *
   * 为什么这个状态必须存在、还必须上横幅：撤销一个正在隐藏容量的过滤器，失效形状是"用户以为已经
   * 全部还给你了，而地图实际上还少着一块" —— 那是这一版最不该无声失败的动作。
   * hook 在失败时**故意不重画**（见 `useTreeNav.clearExclusions`），于是 `nav.sessionExcludedCount`
   * 仍是排除生效中的那个数，横幅不消失也不假装清空，只把这句改成"没清掉"。
   * 复位只有两处：下一次清除成功，或用户又改动了排除集（那时这句话讲的已经不是现在这张图）。
   */
  const [clearFailed, setClearFailed] = useState(false)
  /** 钉住时把侧栏滚到详情那一段（详情在侧栏最上方，但画布占满时它可能已在滚动区外）。 */
  const detailRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ tile: Tile; x: number; y: number } | null>(null)
  /**
   * §13 视图状态在这里持有（不在 TreemapCanvas 里）：Top 面板的「定位」、面包屑换层、
   * 截图脚本都要能改它。换层一律回 FIT —— 带着上一层的缩放进新层，等于把新层画歪。
   */
  const [view, setView] = useState<View>(FIT)
  /** Task 5 的句柄：视图几何（画布尺寸）只有 canvas 自己知道，定位必须由它来算。 */
  const canvasRef = useRef<TreemapCanvasHandle>(null)
  /**
   * 画布的布局结果（canvas 经 onTiles 上抛）。不在这里重算 toTiles —— 两处布局两处真相。
   * 上抛 effect 不成环的依据不是"setter 引用恒定"那一半，而是另一半：`nav.children` 在空栈时
   * 也是恒定引用（core/analyze/tree-nav-state.ts 的 NO_CHILDREN）—— 否则 items 每渲染都变，
   * 空层的 toTiles 又永远给出新的 []，这个 setTiles 就会把自己点着（无界自旋）。
   */
  const [tiles, setTiles] = useState<Tile[]>([])
  /**
   * §10：本层榜单 —— 最多 10 个真项，外加至多一行合计块（预算见 topRows 的注释，一共 ≤ 11 行）。
   * 分母 total 用 nav.size —— payload 给的本层容量，没算出来就显示「—」，不回退成"画出来的这些块之和"。
   */
  const rows = useMemo(
    () => topRows(nav.children, 10, { foldedCount: nav.foldedCount, foldedBytes: nav.foldedBytes }),
    [nav.children, nav.foldedCount, nav.foldedBytes]
  )

  /**
   * §15：这一趟扫描有哪些路径没被计量（清单 + 四类计数）。
   *
   * 走一条**按需的只读查询**，不搭快照的顺风车：清单最多 200 条绝对路径，而快照每 250ms 推一次，
   * 挂在快照上等于给整轮扫描的事件流白乘一个常数（账写在 `SkippedWire` 的注释里）。
   *
   * 拉取时机只有两类，都是原始需求点名的：
   * 1. 进图 / 换 `scanId` 那一下（`status` 是 running 也拉，先给一个"截至目前"的答案）；
   * 2. 落到**任何终态**时再拉一次 —— 含 `cancelled`：用户刚按过取消，最想问的就是"那你没算进来的是哪些"，
   *    所以清单住在 `TreeStore`（跟着扫描任务活到任务本身结束），而不住在已经不再有人发的事件流里。
   * 运行中不重复拉：那一串数字本来就在长，而面板上方挂着「扫描中」那句；终态这一次才是最终答案。
   *
   * 它和 Task 4 的 `truncated` 是**两件不同的事**，措辞也不许互相借用：
   * 截断 = 为了保内存只丢文件名、容量照计（`DetailPanel` 那句）；这里 = 整棵子目录压根没进去、容量没计。
   */
  const [skipped, setSkipped] = useState<SkippedWire | null>(null)
  /** 这一轮扫描的非终态那次拉取（进图那一下）发生过没有 —— 有就不再重复问。 */
  const skipPulled = useRef('')
  useEffect(() => {
    if (!scanId) {
      skipPulled.current = ''
      setSkipped(null)
      return
    }
    const terminal = status === 'completed' || status === 'cancelled' || status === 'failed'
    if (!terminal && skipPulled.current === scanId) return
    skipPulled.current = scanId
    let alive = true
    void window.deepclean.getSkipped(scanId).then(
      (s) => {
        // 换过 scanId 之后的迟到回包一律丢掉：否则上一轮的清单会落到这一轮的面板上（与 statsFor 同一条纪律）
        if (alive) setSkipped(s)
      },
      (err: unknown) => {
        // 问不到就整栏不渲染：这里没有"上一份正确的清单"可退，留旧的等于把上一轮的名单挂在这一轮头上。
        // 但"藏起来"不许等于"什么都不说"（本文件 locate 那条纪律）：这一栏的作用是如实说明少了什么，
        // 它自己拉取失败了却静默消失，用户分不清"没有跳过项"和"问不出跳过项"。
        if (alive) {
          console.warn('[skip] 拉取 skipped() 失败，这一轮的「部分数据无法访问」那一栏不显示（不等于没有跳过项）', scanId, err)
          setSkipped(null)
        }
      }
    )
    return () => {
      alive = false
    }
  }, [scanId, status])

  /**
   * 榜单行 → 地图块：按 key 找回那格并聚焦。走 `pickTile` 而不是裸 `setActive`：
   * 「选中那一格」的统计口径必须和单击一致（见 pickTile 上的注释），否则面板会变成 A 的名字 + Z 的统计。
   * 找不到只有一种合法情况：这一层刚换过、tiles 还是旧的。点名，别静默什么都不做。
   */
  const locate = (row: TopRow): void => {
    const t = tiles.find((x) => x.key === row.key)
    if (!t) {
      console.warn('[map] Top 榜点到的项不在当前布局里，可能刚换层', row.key)
      return
    }
    pickTile(t)
    canvasRef.current?.focus(t)
  }

  // dev-only 截图脚手架用（main/index.ts 的 --shot）；打包版不挂这个全局
  useEffect(() => {
    const w = window as unknown as { __dcMap?: typeof nav }
    w.__dcMap = nav
  })

  // dev-only 截图脚手架（Task 5 的 25-zoom-4x / 26-pan-offscreen）：视图是 React state，
  // DOM 里没有入口 —— 不挂这个，截图脚本就没法把画布摆到 4×。卸载必须擦掉：
  // 切页后 setView 会写进一个已经不存在的页面状态。
  useEffect(() => {
    const w = window as unknown as { __dcView?: { set: (v: View) => void; get: () => View } }
    w.__dcView = { set: (v) => setView(v), get: () => view }
    return () => {
      delete w.__dcView
    }
  }, [view])

  // §13：ESC —— 先关右键菜单，再回上一层（回层同样复位视图，理由同面包屑）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (menu) {
        setMenu(null)
        return
      }
      if (nav.canBack) {
        setView(FIT)
        nav.back()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, nav])

  /**
   * 换层（钻取 / 后退 / 面包屑 / ESC 全走 `nav.path` 这一个事实）一律松开钉住：钉住的那份详情讲的是
   * **上一层**的某一格，人已经不在那一层了还把它钉在屏上，等于说"这一层有这一格"。
   * 依赖里只有 path：同层重画（扫描期间的 400ms 轮询、排除与清除后的那次重取）不换层，
   * 钉着的详情必须留着 —— 挂错依赖会让「查看详情」刚点完就被自己松开。
   *
   * ## 2026-10-27 晚：这里原先**只**松开钉住，漏了选中（人类伙伴截图报的 bug）
   *
   * 症状：右键某个方块 → 它被选中（蓝框）→ 返回上一级 → 蓝框还在，但框住的是这一层的
   * **别的东西**（截图里：在 `C:\Users` 这一层，框却落在 AppData 那一格的位置上）。
   *
   * 根因不是"没清"，而是 **`active` 里存的是一个 `Tile` 对象**，它带着 `x/y/w/h`
   * 这一套**上一层的布局坐标**。`TreemapCanvas` 的高亮层照样拿它去 `project(t, view)`
   * 画框 —— 于是框画在了新一层的坐标系里。清得掉是唯一正确的处置：
   * 一个跨层的 `Tile` 在新层里没有任何意义（它既不是这层的格子，`child.dirId` 也可能不在树上）。
   *
   * 统计一起清（`clearStats`）：它和 `active` 是同一个动作拉的（见 `pickTile` 的注释），
   * 只清一半会让面板变成"没有名字 + 有统计"。
   *
   * **为什么用 `prev =>` 的写法读 path**：这个 effect 的依赖是 `nav.path`，而 `setActive(null)`
   * 是幂等的 —— 同层重画（依赖没变）不会走到这里，换层时清一次就够。
   */
  useEffect(() => {
    setPinned(false)
    setActive(null)
    nav.clearStats()
  }, [nav.path])

  /**
   * 「选中那一格」有四个入口（单击 / 右键 / 榜单定位 / 查看详情），所以 §9 的目录统计必须
   * 跟着同一个动作走：只换 active 不换统计，面板上就会出现「A 格的名字 + Z 格的统计」这种错配 —— 比不显示更糟。
   * 折叠块没有 dirId（磁盘上没这条目录），文件也不是目录：两者一律清掉统计，不去问主进程要假 id。
   *
   * `pin` 只由「查看详情」给 true：其余三个入口都是悬浮式（下一次点别处就换）。
   * 统计与选中仍是**同一个动作**拉的，钉住不改这条 —— 钉住只改"它会不会被下一个动作换掉"。
   */
  const pickTile = (t: Tile | null, pin = false): void => {
    setActive(t)
    setPinned(pin)
    const dirId = t === null || t.folded === true ? undefined : t.child.dirId
    if (t !== null && t.child.kind === 'directory' && dirId !== undefined) void nav.statsFor(dirId)
    else nav.clearStats()
  }

  /**
   * Task 7「查看详情」：钉住详情面板 + 拉一次目录统计。
   * 右键菜单打开时已经 `pickTile` 过一次，这里必须再走一次同一条路径 ——
   * 「拉统计」这件事只允许有一个地方做（两处各写一半，将来加字段必漏一处）。
   */
  const pinDetail = (t: Tile): void => {
    pickTile(t, true)
    // 'nearest' 而不是 'start'：侧栏最顶上那句「已排除 N 个目录」比这份详情更需要不被滚走，
    // 详情本来就在面板可见区时这一句应当什么都不做（硬滚到顶会把它推出视野）。
    detailRef.current?.scrollIntoView({ block: 'nearest' })
  }

  /**
   * Task 7「排除该目录」：**只影响这张地图**。主进程那边只改 `levelOf` 回什么，
   * 计价读的 `childrenOf` 一个字不少（`tests/unit/rules-engine.test.ts` 末尾那条哨兵守着）。
   *
   * 「被排除的格子如果正是详情里那一格，选中与统计一律清掉」这条决定**不写在 JSX 里**：
   * 它是一条真值表（栈上第几层 / 详情里是哪格 / 是排除还是撤销），由 `navAfterExclude`
   * （core/analyze 的纯函数，Task 6 的 `navView` 同一条路子）给 —— 那样它才测得动、也才变得了红。
   * 数字留在屏上就成了"看不见的东西还在报账"。
   */
  const exclude = async (dirId: number): Promise<void> => {
    // 状态快照在 await **之前**取：与 hook 里那次是同一轮渲染的同一份栈，两处的决定不会漂。
    const d = navAfterExclude(nav.stack, dirId, active?.child.dirId ?? null, true)
    const ok = await nav.setExcluded(dirId, true)
    if (!ok) {
      // 拒了只有这几种解释（`TreeStore.canExclude` + IPC 那一层）：扫描根不许排除、id 不在树上、
      // 会话没了、或这条动作根本没送到主进程。静默 return 会让用户以为"点了没用"，所以点名到 console。
      console.warn(
        '[map] 排除该目录没生效（被拒或 IPC 抛错）：扫描根不许排除、该目录已不在本轮扫描的树上，或主进程没有回应',
        scanId,
        dirId
      )
      return
    }
    setClearFailed(false) // 排除集刚变过，上一句「清除没有生效」讲的已经不是这张图
    if (d.dropStats) {
      setActive(null)
      nav.clearStats()
    }
    if (d.unpin) setPinned(false)
  }

  /**
   * 「清除全部排除」的返回值**必须被消费**（Task 7 修订 Fix 1）。
   *
   * 「撤销一个隐藏了容量的过滤器」是这一版最不允许无声失败的动作：撤销没生效而那句横幅消失，
   * 用户看到的就是"我明明点了清除，地图还是少了一块"，而这一句都不会被说出来。
   * 三步一起才算说出来：① console 点名（诊断）；② 横幅改口说"没清掉"（界面上看得见，
   * 见 `excludedLine` 的第三个入参）；③ 按钮换成「重试清除全部排除」，让撤销入口在失败之后仍然可达，
   * 而且字面仍留着"清除全部排除"那五个字（截图脚本按它找按钮，找不到会变成假通过）。
   * 横幅不会消失也不是靠这里兜 —— hook 在失败时故意不重画，跨层那份计数因此仍是生效中的那个数。
   */
  const clearAll = async (): Promise<void> => {
    const ok = await nav.clearExclusions()
    setClearFailed(!ok)
    if (!ok) console.warn('[map] 「清除全部排除」没有生效：主进程拒绝或 IPC 抛错，本轮的排除集仍然挂在这张地图上', scanId)
  }

  if (!scanId) {
    return (
      <div className="dc-empty">
        <p>{t('尚未扫描。回首页点「开始深度扫描」。')}</p>
        <p className="dc-muted">{t('扫描本身不动任何文件；要清理得走「垃圾清理」页的勾选 → 预估 → 确认。')}</p>
      </div>
    )
  }

  /**
   * 这一轮挂着过滤器的证据（null = 一个都没有，那句连同「清除全部排除」整段不出现）。
   * 整个 `nav` 递进去：那句读哪一份口径（本层 / 本轮累计）由 `excludedLine` 自己负责，
   * 于是"横幅读错份"这件事测得出（见那个函数的注释）。
   */
  const excludeNote = excludedLine(nav, clearFailed, t)

  return (
    // 口径 provider：本页所有字节标签（表观/占用）都从这里读，不许各组件写死。
    // 值是**用户选中的那个口径**：载荷里的 `size` 已经按它取好了，标签必须跟上 ——
    // 否则切到"表观"而标签仍写"占用"，就是让界面撒谎。
    <SizeBasisProvider value={sizeBasis}>
    <div className="dc-map">
      <Breadcrumb
        stack={nav.stack}
        currentSize={nav.size}
        canBack={nav.canBack}
        colorMode={colorMode}
        onGoto={(i) => {
          setView(FIT)
          nav.gotoCrumb(i)
        }}
        onBack={() => {
          setView(FIT)
          nav.back()
        }}
        onColorMode={setColorMode}
        sizeBasis={sizeBasis}
        onSizeBasis={setSizeBasis}
      />
      <div className="dc-map-body">
        <div className="dc-map-canvas">
          {/*
            DeepClean 自己的 treemap。**空间地图始终由它画** —— 数据与清理计价同源，
            不引第二个进程的窗口（那会带来"地图与判定两份账"的风险，且无法用单测钉住）。
          */}
          <TreemapCanvas
              ref={canvasRef}
              items={nav.children}
              mode={colorMode}
              active={active}
              view={view}
              levelSize={nav.size}
              foldedCount={nav.foldedCount}
              foldedBytes={nav.foldedBytes}
              rootSize={nav.rootSize}
              rootPath={nav.rootPath}
              onTiles={setTiles}
              onPick={(t) => {
                // 钉住时点**空白处**（`null` = 取消选中）不许把「查看详情」要的那份详情抹掉，
                // 那正是这一项与单击唯一的区别；点另一格则是明确的"改看那个"，照常换、并回到悬浮式。
                if (t === null && pinned) return
                pickTile(t)
              }}
              onOpen={(t) => {
                if (t.child.dirId !== undefined) {
                  setView(FIT)
                  nav.enter(t.child.dirId)
                  setActive(null)
                  nav.clearStats() // 钉住由上面那个"换层"effect 统一松开，这里不重复写第二处
                }
              }}
              onMenu={(t, x, y) => {
                pickTile(t)
                setMenu({ tile: t, x, y })
              }}
              onView={setView}
              onRelayout={() => {
                // Squarified 是确定性的：重排不会给出另一种布局（按钮 title 如实写着），
                // 所以这一项做的是真话版本 —— 重读本层（可能已经变了的容量）+ 复位视图。
                setView(FIT)
                nav.refresh()
              }}
            />
          {menu && (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              items={menuFor(menu.tile, { onAddToCleanup, onDetail: pinDetail, onExclude: (id) => void exclude(id) }, t)}
              onClose={() => setMenu(null)}
            />
          )}
        </div>
        <aside className="dc-side-panel">
          {/*
            Task 7 的「这一轮少看了什么」。放在侧栏**最顶**（详情之前）：它讲的是这张图的边界，
            排在详情后面就等于要人滚到底才知道地图被自己过滤过。
            门是 `excludedLine` 那道（个数 > 0 才出现，全局口径：不许印一句没算过的话），
            数字是**跨层的本轮累计**（修订 Fix 2）：本层那份一钻层级就归 0，那样这一栏会连同
            「清除全部排除」这个唯一撤销入口一起消失 —— 一个坐在真删除链路旁边的视图过滤器，
            "看不见但生效中"就是它最坏的状态。被排除的容量始终要点名，不许悄悄从地图上消失。
            上一次清除没生效时这句改口（修订 Fix 1），按钮同时换成「重试清除全部排除」——
            撤销入口在失败之后必须仍然可达，而且那句 label 里仍留着"清除全部排除"五个字，
            截图脚本按它找按钮的那条判据不会因为改口而找不到（找不到 = 假通过）。
          */}
          {excludeNote && (
            <p className="dc-warn">
              {excludeNote}
              <button className="dc-link" onClick={() => void clearAll()}>
                {clearFailed ? t('重试清除全部排除') : t('清除全部排除')}
              </button>
            </p>
          )}
          <div ref={detailRef}>
            <DetailPanel
              child={active?.child ?? null}
              parentSize={nav.size}
              rootSize={nav.rootSize}
              rootPath={nav.rootPath}
              folded={active?.folded === true}
              stats={nav.stats}
              truncated={truncated}
              pinned={pinned && active !== null}
              onUnpin={() => setPinned(false)}
            />
          </div>
          {/* §10：本层空间榜。挂在详情之后 —— 详情是"这一格是什么"，榜单是"该看哪几格"，读序先具体后全局。 */}
          <TopPanel rows={rows} total={nav.size} onLocate={locate} />
          {/* §15：最后是"有什么没算进来"。放在最底下不是次要 —— 它讲的是这张图的边界，
              但读的人得先看完"这一格/这一层"才会需要它；而且 total 为 0 时整块不出现，正常盘零噪声。 */}
          <SkipPanel data={skipped} />
          {status === 'running' && <p className="dc-live">{t('扫描中 · 当前层每 400ms 重新水合')}</p>}
          {nav.foldedCount > 0 && (
            <p className="dc-warn">{foldedLine(nav, t)}</p>
          )}
        </aside>
      </div>
    </div>
    </SizeBasisProvider>
  )
}

/**
 * §12 右键六项。「加入清理列表」只对文件开放：归属反查用的是规则引擎认领过的**文件**清单。
 *
 * 折叠块（`Tile.folded`）是**合成**的一格：它代表主进程没回传的那 N 项的合计容量，
 * 磁盘上没有叫这个名字的条目，`path` 是空串。空串过不了 `knownPath` 白名单（`parentOf('')` 为 null），
 * 两个 shell 通道会直接抛 `E_UNTRUSTED_PATH`，而这里 `void` 掉了 Promise —— 用户点的每一格都"没反应"，
 * 看起来像菜单坏了。所以四项一律置灰（打开 / 所在位置 / 复制路径 / 查看详情：它没有目录可拉统计），
 * 并把原因写在 note / hint 里。「排除该目录」同样置灰：藏一个不存在的条目没有意义，
 * 而且那一格的容量已经在 `foldedBytes` 里点过名了。
 *
 * 导出只为让单测能钉住那两句诚实文案（`tests/unit/spacemap-menu.test.tsx`）—— 组件本身不导出任何东西。
 */
export interface MenuHandlers {
  onAddToCleanup: (absPath: string) => void
  /** 「查看详情」：钉住详情面板并拉目录统计（`SpaceMap` 的 `pinDetail`）。 */
  onDetail: (t: Tile) => void
  /** 「排除该目录」：视图动作，主进程只改 `levelOf` 回什么。 */
  onExclude: (dirId: number) => void
}

/**
 * 本文件里那几个**纯函数**（`foldedLine` / `excludedLine` / `menuFor`）不能调 `useT()`
 * —— 它们不是组件，没有组件树可挂。默认值取简体那份词典，正是 `t()` 在组件里逐字回原文的那个口，
 * 所以单测直接调用这些函数时，拿到的句子与界面上一模一样（`tests/unit/spacemap-menu.test.tsx`）。
 *
 * 为什么不在这些函数里 `import { dictFor }` 现查一次：那会绕开 Provider，设置页切了语言
 * 而它们仍读默认那份 —— 调用点（组件体里）把 `t` 递进来，才和界面跟着一起换。
 */
const tDefault: TranslateFn = (source, vars) => translate(dictFor(DEFAULT_LOCALE), source, vars)

/**
 * 「排除该目录」那一句。整句都是要传的：这一项最容易被误解成"把它从扫描/清理里去掉"，
 * 而它唯一的效果就是这一层少画一块。最后一句点的是那条哨兵用例（它真的在，见 rules-engine.test.ts）。
 *
 * 为什么断开成两段常量：`EXCLUDE_HINT` 是单测逐字比对的契约（`spacemap-menu.test.tsx`），
 * 而翻译时一句话越长越容易把语气断歪 —— 两段各自登记、拼回来仍是逐字那两句，不多不少一个标点。
 */
const EXCLUDE_HINT_HEAD = '只影响这张地图：该目录本轮从这一层消失，容量按「已排除」单独点名。'
const EXCLUDE_HINT_TAIL = '不会停止扫描、不会删除任何东西，清理预估仍按完整的树计价（有哨兵用例守着）'

export const EXCLUDE_HINT = EXCLUDE_HINT_HEAD + EXCLUDE_HINT_TAIL

/** `EXCLUDE_HINT` 的译文版，按同一处断句拼回（两段共用上面那两个常量，改文案只改一处）。 */
function excludeHint(t: TranslateFn): string {
  return t(EXCLUDE_HINT_HEAD) + t(EXCLUDE_HINT_TAIL)
}

/**
 * 侧栏那一句实话（`null` = 这一轮没有被排除项，那句话**整段不出现**）。
 *
 * 为什么做成函数而不是 JSX 里写一串 `&&`：这一句的三个数字必须互相咬合
 * （个数、容量、以及"父级显示的 size 没有被改"这件事），而它的失效形状恰好是"0 也印一次"
 * —— 全局口径：不显示没算过的数字。做成纯函数才有单测可钉（`tests/unit/spacemap-menu.test.tsx`）。
 *
 * **入参是整个 nav 视图而不是两个裸数字**，这一点是修订 Fix 2 的一半：那句「已排除 N 个目录」
 * 读哪一份口径（本层 `excludedCount` 还是本轮累计 `sessionExcludedCount`）本来就是这个 bug 本身 ——
 * 写在调用点上是测不到的（把 `nav.excludedCount` 传进来，函数照样给出一句格式完美的话）。
 * 让函数自己从对象里取，"读错份"就变成一条能跑红的断言。
 *
 * 两份口径的分工：横幅与「清除全部排除」这个唯一撤销入口读**本轮累计**那份（主进程在每一次
 * payload 上现算，见 `ChildrenPayload.sessionExcluded*`）；折叠那句「本层共 X 项」仍读本层那份，
 * 因为它讲的必须是这一层的账。本层那份一钻层级就归 0，所以它不能当横幅的门。
 *
 * 第三个入参是修订 Fix 1：上一次「清除全部排除」**没生效**时这句必须改口。撤销一个正在隐藏容量的
 * 过滤器，最坏的失效形状就是"横幅消失了、地图却还少着一块"—— 那等于界面宣称已经全部还给你了。
 * 所以这一支把个数、容量、「仍然被藏着」三件事一起说，并且给得出重试入口。
 */
export function excludedLine(
  nav: Pick<NavView, 'excludedCount' | 'excludedBytes' | 'sessionExcludedCount' | 'sessionExcludedBytes'>,
  clearFailed = false,
  t: TranslateFn = tDefault
): string | null {
  if (nav.sessionExcludedCount <= 0) return null
  const head = t('已排除 {count} 个目录（本轮累计）· {bytes} 不计入地图', {
    count: nav.sessionExcludedCount,
    bytes: formatBytes(nav.sessionExcludedBytes)
  })
  if (clearFailed) {
    return (
      head +
      ' —— ' +
      t('「清除全部排除」没有生效（主进程拒了这条，或这条 IPC 压根没送到）：') +
      t('这些目录此刻仍然被藏着，这张地图显示的容量仍然少了 {bytes}。', {
        bytes: formatBytes(nav.sessionExcludedBytes)
      }) +
      t('清理预估不受影响（它一直按完整的树计价），再点一次右边那个按钮可以重试。')
    )
  }
  return head + t('：被排除那一层显示的目录大小仍是完整子树合计，清理预估也仍按完整的树计价。')
}

/**
 * 折叠那一句（`nav.foldedCount > 0` 才出现）：本层共几项、画了几项、其余多少项合计多少。
 *
 * 整句只占**一个**键，不拆成三段拼接 —— 语序在日语/韩语里与中文不同（「其余 N 项合计 X」
 * 那半句在韩语里要整句重排），拆开之后译者就没法把它摆回去了（见 `i18n/dict.ts` 文件头）。
 * 括号里那句「其中 N 项已被本轮排除」是**条件片段**，单独一个键由调用点决定要不要拼进去。
 */
function foldedLine(
  nav: Pick<NavView, 'totalChildren' | 'excludedCount' | 'children' | 'foldedCount' | 'foldedBytes'>,
  t: TranslateFn = tDefault
): string {
  const excluded =
    nav.excludedCount > 0 ? t('（其中 {count} 项已被本轮排除）', { count: nav.excludedCount }) : ''
  return t(
    '本层共 {total} 项{excluded}，图中只画最大的 {shown} 项；其余 {folded} 项合计 {bytes}，已单独画成一格「其它 {folded} 项」—— 容量没丢，但那一格不是磁盘上的某一项，进不去。',
    {
      total: nav.totalChildren,
      excluded,
      shown: nav.children.length,
      folded: nav.foldedCount,
      bytes: formatBytes(nav.foldedBytes)
    }
  )
}

export function menuFor(tile: Tile, h: MenuHandlers, t: TranslateFn = tDefault): MenuSpec[] {
  const p = tile.child.path
  const isFile = tile.child.kind === 'file'
  const fold = tile.folded === true
  const foldNote = fold ? t('合计块') : undefined
  const foldHint = fold
    ? t('这一格装的是主进程没有下发给渲染端的那批子项的合计容量，磁盘上没有对应条目：没有路径可打开、可定位，也没有路径可复制')
    : undefined
  // 排除只对"真实存在的目录"有意义：文件不是地图的一层，合计块磁盘上压根没有这一项。
  const excludable = !fold && !isFile && tile.child.dirId !== undefined
  return [
    { label: t('打开'), disabled: fold, note: foldNote, hint: foldHint, run: () => void window.deepclean.openItem(p) },
    { label: t('打开所在位置'), disabled: fold, note: foldNote, hint: foldHint, run: () => void window.deepclean.revealInExplorer(p) },
    { label: t('复制路径'), disabled: fold, note: foldNote, hint: foldHint, run: () => void navigator.clipboard.writeText(p) },
    {
      label: t('查看详情'),
      disabled: fold,
      note: foldNote,
      hint: fold
        ? t('合计块不是磁盘上的条目，没有目录统计可看：它的容量与两个百分比已经在侧栏那句「其它 N 项」里点名了')
        : t('钉住右侧详情面板：这一格会一直显示在这里，直到你取消固定或换了一层'),
      run: () => h.onDetail(tile)
    },
    {
      label: t('加入清理列表'),
      disabled: !isFile,
      note: isFile ? undefined : t('只按文件'),
      hint: isFile
        ? t('交给规则引擎反查它属于哪条清理规则；不属于任何规则地盘的文件会被点名退回')
        : t('清理按文件计价 —— 目录请进入后对具体文件用这一项，或在「垃圾清理」页整项勾选'),
      run: () => h.onAddToCleanup(p)
    },
    {
      label: t('排除该目录'),
      disabled: !excludable,
      note: fold ? foldNote : excludable ? undefined : t('只按目录'),
      hint: fold ? foldHint : excludeHint(t),
      run: () => {
        if (tile.child.dirId !== undefined) h.onExclude(tile.child.dirId)
      }
    }
  ]
}

export type { Level }
