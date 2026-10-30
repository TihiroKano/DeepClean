import { useEffect, useRef, useState } from 'react'
import { useScan } from './hooks/useScan'
import { Cleanup } from './pages/Cleanup'
import { Home } from './pages/Home'
import { CleanHistory } from './pages/CleanHistory'
import { CleanJournalDetail } from './pages/CleanJournalDetail'
import { DevEnv } from './pages/DevEnv'
import { SpaceMap } from './pages/SpaceMap'
import { CodeIcon, HomeIcon, JournalIcon, MapIcon, SettingsIcon, TrashIcon } from './components/icons'
import { Settings } from './pages/Settings'
import { WindowControls } from './components/WindowControls'
import type { IconProps } from './components/icons'
import type { View } from './view'
import { LocaleContext, useT } from './i18n'
import { useSettings } from './hooks/useSettings'
import { LOCALE_HTML_LANG } from '../../shared/i18n'
// 左上角品牌位（人类伙伴 2026-10-23 第六轮：主 logo 精修版）。两张图拆开摆：
// 图标（抠底、带镂空）+ 字标。Vite 会把它们换成产物里的哈希文件名，随 dist 进二进制。
import appIcon from './assets/app-icon.png'
import brandLogo from './assets/deepclean-wordmark.png'

const NAV: { id: View | null; label: string; note?: string; icon: (p: IconProps) => JSX.Element }[] = [
  { id: 'home', label: '首页', icon: HomeIcon },
  { id: 'map', label: '空间地图', icon: MapIcon },
  { id: 'cleanup', label: '垃圾清理', note: '§17 逐项勾选 → 预估 → 确认，才有 §18 的执行', icon: TrashIcon },
  // V0.7 §3.6：这条占位换成了真视图。页内不判定任何事（判据在 `core/rules/devenv-view.ts`），
  // 所以侧栏这里出现的"开发环境"四个字不是一条装饰 —— 它后面有探测器、有分组、有动作面。
  { id: 'devenv', label: '开发环境', note: '§3.2 探测装没装 · 勾选仍归垃圾清理那条确认链', icon: CodeIcon },
  // §1.7：这一条从"后续阶段"的占位变成真视图
  { id: 'journal', label: '清理日志', note: '每次清理一条 · 落盘保留 30 天 · 点详情看删了哪些文件', icon: JournalIcon }
]

export function App(): JSX.Element {
  const scan = useScan()
  /*
   * 界面语言（2026-10-29）。
   *
   * `App` 自己读一次设置来决定语言，而不是让 `Settings` 页那个 `useSettings` 反过来喂给外面 ——
   * 那样语言会在"进设置页之前"一直是默认值，而用户可能上次就选了日语。
   *
   * 代价如实登记：这一层与设置页各有一份 `useSettings()`（两条独立的读盘与写盘）。
   * 为什么可以接受：`useSettings` 的"回执赢"是**每次写盘回执都重新采纳服务端那份**，
   * 所以两条各自持有一份时，A 写完之后 B 下一次写会把 A 的改动叠上去（它写的是 patch，
   * 而基线是服务端当前值）—— 不产生"互相覆盖成对方没改过"的那一族缺陷。
   * 真要合并成一条得把设置提到更外层；那是更大的重构，与这一轮要修的五条无关。
   */
  const { value: settingsValue } = useSettings()
  const [view, setView] = useState<View>('home')
  /**
   * 清理日志详情页看的是**哪一次**清理（`null` = 不在详情页，显示列表）。
   *
   * 为什么不把 `'journal-detail'` 加进 `View` 联合类型：`View` 是**导航项**的 id，
   * 而六格导航里没有这一页；加进去会让 `NAV` 那张表多出一条它不该有的项。
   * 参数型子视图挂在父视图的 state 上，比塞进类型联合更贴现有结构。
   * （另外 `glass-inventory` 用 `/view === '([a-z]+)' &&/g` 抓页面并断言恰好六页，
   *  新起一个驼峰 id 会让那条判据静默解析不到。）
   */
  const [journalRunId, setJournalRunId] = useState<string | null>(null)
  /**
   * 清理完成后的**预览刷新计数**，与 `tilePaths` / `cleanSelected` 同一个理由放在这里：
   *
   * 它原先住在 `Cleanup` 里（`useState`）。而 `Cleanup` 是条件渲染、切页即卸载 ——
   * 于是「清完 A 页 → 切到清理日志看一眼 → 切回来」这条路里，nonce 从 1 归 0，
   * 缓存键 `[scanId, 勾选, tilePaths, scanStatus, nonce]` 与**清理前那一份逐字相同**，
   * 模块级 `previewCache` 直接命中 ⇒ 用户看到的是清理前的旧数。
   *
   * 症状正是人类伙伴 2026-10-25 报的「清完那个 4 MB 条目还在」。
   * 它属于**这一轮会话**，不属于某个组件实例 —— 与勾选同一条纪律。
   */
  const [cleanRefreshNonce, setCleanRefreshNonce] = useState(0)
  /** §12「加入清理列表」的落点：只存路径，归属由服务端用规则引擎的认领表反查 */
  const [tilePaths, setTilePaths] = useState<string[]>([])
  /**
   * §17 清理页的规则勾选。**为什么放在这里而不是 `Cleanup` 里面**：
   * 下面的视图是条件渲染的 —— 切一次视图就把 `Cleanup` 整个卸载，组件内的 state 随之清零。
   * 勾选住在组件里时，真人走「垃圾清理 → 勾好 → 点清理记录看一眼 → 点回来」这一条再自然不过的
   * 路，回来就是「已勾 0 项」、两个按钮置灰，而且一个字都不提示（评审 I-1，`9b2dad7` 一度拿
   * harness 重放全选把它盖了过去）。勾选属于**这一轮会话**，不属于某个组件实例。
   */
  const [cleanSelected, setCleanSelected] = useState<string[]>([])

  // 换一次扫描，上一轮从地图加进来的路径与勾选都不该再跟着走
  useEffect(() => {
    setTilePaths([])
    setCleanSelected([])
  }, [scan.scanId])

  /**
   * 规格书 §2：「启动扫描完成后自动进入空间地图」。
   * 两条自我约束：
   *   1. 只在用户还停在首页时跳 —— 人已经在清理页时把窗口拽走，是替用户做决定；
   *   2. 每个 scanId 只跳一次 —— 否则从地图返回首页后会被再次弹走。
   */
  const autoEntered = useRef<string | null>(null)
  useEffect(() => {
    if (scan.status !== 'completed' || !scan.scanId) return
    if (autoEntered.current === scan.scanId) return
    autoEntered.current = scan.scanId
    setView((v) => (v === 'home' ? 'map' : v))
  }, [scan.status, scan.scanId])

  /*
   * 切回**首页**时重读一次盘容量（2026-10-30 修 bug）。
   *
   * 用户报的原话：「我日志记录了我刚刚进行了一次删除，但是主页面的值和我实际 C 盘
   * 剩余的值不一样，还是显示清理前的数值」（实际空闲 3.31 GB，界面还写 1.0 GB）。
   *
   * 根因是 `listDrives()` 只在 `useScan` 首次挂载时读过一次 —— 整个进程生命周期里
   * 盘容量都是那一次的快照。清理删掉 2 GB 之后没有任何地方重新读盘。
   *
   * 三处补上（这一处是第三处，另两处在 `useScan` 里）：
   *  ① 清理完成 → `onCleanDone` 那一行；
   *  ② 扫描进入终态 → `useScan` 自己的 effect；
   *  ③ **切回首页** → 这里。用户可能是在别的程序里删的东西（回收站、资源管理器），
   *     DeepClean 没有任何事件能知道；"回到首页时看一眼"是唯一诚实的那一档。
   */
  useEffect(() => {
    if (view === 'home') scan.refreshDrives()
    // `scan.refreshDrives` 是 useCallback 稳定引用，进依赖不会造成循环
  }, [view, scan.refreshDrives])

  // dev-only 截图脚手架（main/index.ts 的 --shot）。打包版拿不到这个入口。
  useEffect(() => {
    const w = window as unknown as {
      __dc?: {
        start: (r: string) => void
        view: (v: View) => void
        status: () => string
        skipped: () => Promise<unknown>
        scanId: () => string | null
      }
    }
    // skipped()：§15 那一栏（--shot 的第 32 步）要拿**主进程**的读数与 DOM 上的数字对账 ——
    // 没有这一条，"整栏没渲染"和"这次真的一个都没跳过"在截图里长得一模一样。
    // scanId()：CDP 探针要用它调桥上的预览/清理通道（与页面同一份会话）。
    w.__dc = {
      // 扫描被主进程拒掉（根路径非法、会话数超限）时，`void` 会把拒绝吞成一次静默的空跑：
      // status() 诚实地停在 'idle'，而 --shot 的轮询循环以为已经跑完了，后面三十几步全在空树上拍。
      start: (r: string) =>
        void scan.start(r).catch?.((e: unknown) => console.error('[dc] start 被拒绝，后面每一步都跑在空树上：', e)),
      view: (v: View) => setView(v),
      status: () => scan.status,
      skipped: () => window.deepclean.getSkipped(scan.scanId ?? ''),
      scanId: () => scan.scanId
    }
  })

  /**
   * 哪几页顶部自带一条工具条（`.dc-bar`）—— 那几页的 40 px 独立标题行是浪费，
   * 三颗窗控浮到工具条右端即可（见 `global.css` 的 `.dc-titlebar-inline`）。
   *
   * 地图页与清理记录页有 `.dc-bar`（面包屑行 / 筛选器行）；其余页没有，
   * 无条件收掉会让「一键清理」那种右上角主按钮被窗控压住、点不动。
   */
  const hasInlineBar = view === 'map'

  /*
   * `<html lang>` 与 `<html data-dc-locale>` 跟着设置走（2026-10-29）。
   *
   * 两个属性各有一件真事：
   *  - `lang` —— 屏幕阅读器按它挑发音、浏览器按它挑**字形**。`lang="zh-CN"` 下
   *    日语汉字会走简体中文字形（「直」「骨」那几笔不一样），那是"看着像没译对"
   *    的一半来源，所以切到日语时必须真的换掉它；
   *  - `data-dc-locale` —— CSS 按它调各自的排版（见 `global.css` 末尾那一节：
   *    日语的 `line-height` 与韩语的断词规则与中文不同）。
   *
   * 这个 effect 挂在 App 上而不是 tauri-main 里：它要跟着设置变，
   * 而入口那一层只在启动时跑一次。
   */
  useEffect(() => {
    document.documentElement.lang = LOCALE_HTML_LANG[settingsValue.locale]
    document.documentElement.dataset.dcLocale = settingsValue.locale
  }, [settingsValue.locale])

  return (
    <LocaleContext.Provider value={settingsValue.locale}>
      <AppShell
        scan={scan}
        view={view}
        setView={setView}
        hasInlineBar={hasInlineBar}
        journalRunId={journalRunId}
        setJournalRunId={setJournalRunId}
        cleanRefreshNonce={cleanRefreshNonce}
        setCleanRefreshNonce={setCleanRefreshNonce}
        tilePaths={tilePaths}
        setTilePaths={setTilePaths}
        cleanSelected={cleanSelected}
        setCleanSelected={setCleanSelected}
      />
    </LocaleContext.Provider>
  )
}

/** 外壳本体。**拆出来是因为 `t()` 必须在 `LocaleContext.Provider` 里面才拿得到当前语言** ——
 *  同一个组件里既挂 Provider 又调 `useT()`，拿到的是外层的值（默认简体），
 *  于是切了语言侧栏还是一动不动。这是 React context 的一条经典形状缺陷。 */
function AppShell({
  scan,
  view,
  setView,
  hasInlineBar,
  journalRunId,
  setJournalRunId,
  cleanRefreshNonce,
  setCleanRefreshNonce,
  tilePaths,
  setTilePaths,
  cleanSelected,
  setCleanSelected
}: {
  scan: ReturnType<typeof useScan>
  view: View
  setView: (v: View) => void
  hasInlineBar: boolean
  journalRunId: string | null
  setJournalRunId: (v: string | null) => void
  cleanRefreshNonce: number
  setCleanRefreshNonce: (f: (n: number) => number) => void
  tilePaths: string[]
  setTilePaths: (f: string[] | ((prev: string[]) => string[])) => void
  cleanSelected: string[]
  setCleanSelected: (v: string[] | ((prev: string[]) => string[])) => void
}): JSX.Element {
  const t = useT()

  return (
    <div className="dc-app">
      <aside className="dc-side">
        {/*
          品牌位 = **应用图标 + 字标**（人类伙伴 2026-10-23 第六轮：「主 logo 精修版用于左上角」）。

          精修版是一张 `图标 + DeepClean` 的横向组合，所以这里拆成两张图摆：
          左边 `app-icon.png`（抠掉深蓝底、保留镂空的透明图标），右边 `deepclean-wordmark.png`
          （白 Deep + 青 Clean 的透明字标）。**不把整张宣传图塞进来** —— 那张是带深蓝底
          与装饰光弧的宣传稿，铺进 200px 侧栏会把那一块变成"贴了一张图"，与周围玻璃材质割裂。

          三条不许含糊的地方：
          ① **alt 只在字标上给 "DeepClean"**，图标那个 `alt=""` + `aria-hidden`：
             组合图的语义就是一次品牌陈述，读屏念两遍 "DeepClean" 是噪声；
          ② 尺寸走 CSS（`.dc-brand-*`），不在 JSX 写死宽高 —— DPR 变了不会糊；
          ③ 原来那串渐变文字（`.dc-brand-name`）已经整条撤掉，不留"看不见但还在"的 DOM 节点。
        */}
        <div className="dc-brand">
          <img className="dc-brand-icon" src={appIcon} alt="" aria-hidden="true" draggable={false} />
          <img className="dc-brand-logo" src={brandLogo} alt="DeepClean" draggable={false} />
        </div>
        <nav>
          {NAV.map((n) => (
            <button
              key={n.label}
              className={`dc-nav ${n.id === view ? 'dc-nav-on' : ''}`}
              disabled={n.id === null}
              title={n.note === undefined ? undefined : t(n.note)}
              onClick={() => n.id && setView(n.id)}
            >
              {/* 中文标签必须是按钮自己的 textContent，**不许换成 CSS `content`**：
                  `--shot` 有四处靠 `.dc-side button` + `textContent.includes(导航名)` 找入口
                  （main/index.ts 的 1288/1291/1380/1610 一带），生成内容不进 textContent 那四步会全红；
                  读屏软件也念不出 `content` 里的字。第四轮侧栏变宽、标签常驻可见，
                  这条约束一个字没变 —— §23 那条 `navLabels` 判据继续守着它。

                  ⚠️ 2026-10-29 加了界面语言之后，`textContent` 里是**译过的那一条**
                  （简体中文下逐字等于原文，那四条 `--shot` 判据一字未改照旧成立）。
                  靠 `textContent.includes('首页')` 找入口的验收脚本只在简体下有效 ——
                  这是那条判据的边界，记在 `.dc-nav-label` 那段注释旁边。 */}
              <span className="dc-nav-ic">
                <n.icon size={19} />
              </span>
              <span className="dc-nav-label">{t(n.label)}</span>
            </button>
          ))}
        </nav>
        <p className="dc-side-slogan">
          <i>让电脑</i>
          <b>更干净 · 更高效</b>
        </p>
        {/* 设置钉在栏底：它是"调这台机器"的入口，不是第七个看数据的页面。文字标签的规则同上。 */}
        <button
          className={`dc-nav dc-nav-rail-foot ${view === 'settings' ? 'dc-nav-on' : ''}`}
          title="设置 · 只有一件能设的事，因为它有真逻辑在读"
          onClick={() => setView('settings')}
        >
          <span className="dc-nav-ic">
            <SettingsIcon size={19} />
          </span>
          <span className="dc-nav-label">设置</span>
        </button>
      </aside>

      <main className="dc-main">
        {/* 标题条 = 40 px 拖拽区 + 右上角三颗窗控（decorations:false 之后系统不管了，
            由 WindowControls 自己画；字标在左侧栏那一行）。按钮的 no-drag 由
            `.dc-titlebar button` 那条统一兜住。
            `dc-titlebar-inline` = 这一页顶部自带一条工具条（`.dc-bar`），三颗窗控可以
            浮到那条工具条的右端、省掉整个 40 px 的独立标题行。哪一页要用由下面按 view
            直接决定 —— 不用 `:has()`：那个选择器依赖 DOM 深度，实测在这棵树上匹配不到
            （标题条收起来了、窗控却没浮出来，右侧空出 200 px 纯蓝）。 */}
        <div className={`dc-titlebar${hasInlineBar ? ' dc-titlebar-inline' : ''}`}>
          <WindowControls />
        </div>
        <div className="dc-view">
          {view === 'home' && <Home scan={scan} onOpenMap={() => setView('map')} />}
          {view === 'map' && (
            <SpaceMap
              scanId={scan.scanId}
              status={scan.status}
              truncated={scan.snapshot?.truncated === true}
              onAddToCleanup={(p) => {
                setTilePaths((prev) => (prev.includes(p) ? prev : [...prev, p]))
                setView('cleanup')
              }}
            />
          )}
          {view === 'cleanup' && (
            <Cleanup
              scanId={scan.scanId}
              snapshot={scan.snapshot}
              tilePaths={tilePaths}
              selected={cleanSelected}
              onSelectedChange={setCleanSelected}
              onRemoveTilePath={(p) => setTilePaths((prev) => prev.filter((x) => x !== p))}
              onClearTilePaths={() => setTilePaths([])}
              refreshNonce={cleanRefreshNonce}
              onCleanDone={() => {
                setCleanRefreshNonce((n) => n + 1)
                /*
                 * **清理完成立刻重读盘容量**（2026-10-30 修 bug）。
                 *
                 * 这一条是那个缺陷的正面：删完 2 GB，首页的「已使用 / 剩余 / 环」
                 * 必须当场变。`cleanRefreshNonce` 管的是**清理预览**的缓存键
                 * （`usePreview` 那一份），与盘容量是两回事 —— 原来只有前者被
                 * 递增，后者一个字节都没动。
                 */
                scan.refreshDrives()
              }}
            />
          )}
          {view === 'devenv' && (
            <DevEnv scanId={scan.scanId} selected={cleanSelected} onSelectedChange={setCleanSelected} />
          )}
          {view === 'journal' &&
            (journalRunId === null ? (
              <CleanHistory onOpenDetail={setJournalRunId} />
            ) : (
              <CleanJournalDetail runId={journalRunId} onBack={() => setJournalRunId(null)} />
            ))}
          {view === 'settings' && <Settings />}
        </div>
      </main>
    </div>
  )
}
