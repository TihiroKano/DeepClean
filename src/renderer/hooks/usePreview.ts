import { useEffect, useRef, useState } from 'react'
import type { PreviewPayload, ScanStatus } from '../../../shared/types'

/**
 * 服务端回 `null` 时界面该说什么。**两条不同的话，因为那是两件不同的事**：
 * 还在扫 = 这棵树上现在没有可评估的完整数据；会话没了 = 得重新扫一次才要得到预估。
 * 塌成一句「会话已失效（请重新扫描）」会在扫描途中指控用户做了一件他没做的事
 * （M5-F 真机扫查抓到的：`docs/acceptance/2026-10-12-tauri-m5-f.md` §4）。
 * 抽成纯函数是为了能被单测反复验 —— 界面上那一格只走得到"还在扫"那一条。
 */
export function previewNullMessage(status?: ScanStatus | null): string {
  return status === 'running' || status === 'paused'
    ? '这一轮还在扫 · 扫完才有预估（这棵树上现在没有可评估的完整数据）'
    : '扫描会话已失效（请重新扫描）'
}

/**
 * `loading` 到底该表示什么 —— 抽成纯函数，因为它的语义变过一次，而这次变化有代价要写清楚。
 *
 * **2026-10-21 人类伙伴**：「首次取消勾选都会重新进入 loading……只在第一次进入垃圾清理页面加载就好。」
 *
 * 之前它表示「这一次请求正在等」。于是每勾选/取消一条，页面上就闪一次 Loading ——
 * 而一次重新计价是**单条内存 IPC（毫秒级）**，那条 Loading 的寿命常常比一次渲染还短，
 * 用户看到的只是"画面抖了一下"。抖的那一下恰好发生在刚点完复选框之后，读起来像卡了。
 *
 * 现在它表示「**这一页还没有任何预估可显示**」：
 *  · 有 cache 命中 ⇒ 永远 false（切页回来、勾选来回点都不闪）；
 *  · 首次进页面（`payload` 还是 null）⇒ true，直到第一份预估回来；
 *  · 已经有 `payload` 之后再重算 ⇒ false（旧数继续显示，新数算完直接替换）。
 *
 * **代价如实写着**：勾选之后，统计带与「计入预估」那一列会有几十到几百毫秒的滞后 ——
 * 那段时间屏幕上没有任何"在等"的提示。这是选定的取舍（人类伙伴 2026-10-21 选 A）：
 * 宁可数字慢半拍，也不要在勾选框旁边闪一个动画。
 * 真出问题时（服务端异常慢）它表现为"勾了但数字没变"，由 `.catch` 那条错误提示兜住。
 *
 * @param hadAnyPreview 这一页此前是否已经拿到过预估（`payload !== null`）
 * @param isPending     当前这一次请求是否还在飞
 * @param cacheHit      这次要的键是否已经在缓存里
 */
export function shouldShowLoading(hadAnyPreview: boolean, isPending: boolean, cacheHit: boolean): boolean {
  if (cacheHit) return false
  if (hadAnyPreview) return false
  return isPending
}

/**
 * §17 预览的唯一取数入口。
 *
 * 为什么每次都回主进程要，而不是渲染进程自己累加：预估的口径（哪些字节算可释放、🔴 怎么排除、
 * 只上报根怎么记账）由 `core/rules` 负责，复制一份到渲染进程就等于造出第二套「能清多少」，
 * 而那正是 §17 要避免的事故形态。服务端每次重跑 `evaluateRules` 是纯内存树遍历，毫秒级。
 *
 * `seq` 用来丢弃过期响应：勾选连点时，晚到的旧预估不许盖掉新勾选的结果。
 */

/**
 * 预估结果缓存，**模块级**：`Cleanup` 页是条件渲染的，切走就卸载，
 * 放在组件里等于每次回来都重算一遍（人类伙伴 2026-10-20 要求「保存本次记录」）。
 *
 * 键里含 `scanId` —— 换一次扫描必然重算，绝不允许把上一轮的账套到这一轮上。
 * 上限 8 份（见写入处），勾选来回点不会无限增长。
 */
const previewCache = new Map<string, PreviewPayload>()

export function usePreview(
  scanId: string | null,
  selectedRuleIds: readonly string[],
  tilePaths: readonly string[],
  /**
   * 传进来的是**这一轮扫描的状态**。它有两个用处，缺一个都会出事：
   *  1. effect 的依赖 —— 扫描从 running 变 completed 时必须重算一次（少了它，预估会永远停在
   *     "刚开始、树上还没东西"的那一刻，实测截图里首页因此显示 0 B）；
   *  2. 决定 `payload === null` 那一句怎么说 —— 服务端那一格 `null` 是**两件事**塌成的一个值：
   *     会话真没了，和"这一轮还在扫、树还没 publish"。以前两种都念「会话已失效（请重新扫描）」，
   *     于是扫描途中的清理页在指控用户做了一件他没做的事（M5-F 真机扫查抓到，见
   *     `docs/acceptance/2026-10-12-tauri-m5-f.md` §4）。
   */
  scanStatus?: ScanStatus | null,
  /**
   * **刷新计数**（2026-10-24 第二轮：清理完成后数字要变）。调用方每次要**作废缓存
   * 重取一次**时把它 +1 —— 它进缓存键，键变 ⇒ 模块缓存不命中 ⇒ effect 重新发请求。
   *
   * 为什么不放在键里而是单独参数：它表达的是「同一份勾选，但答案可能变了」，
   * 与 `scanStatus` 的语义分开 —— 两者混在一起会让「扫描完成」与「清理完成」
   * 变成同一个不可分辨的触发源。
   */
  refreshNonce?: number
) {
  const [payload, setPayload] = useState<PreviewPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const seq = useRef(0)
  /**
   * 「这一页此前是否已经拿到过预估」。用 ref 而不是从 `payload` 推：
   * `payload` 会在换扫描时被清成 null，而"清成 null 之后又进来一次"应当**重新**显示 Loading
   * （那是新的一轮，屏幕上确实什么都没有）。所以这个标记在 `scanId` 变化时重置，
   * 与 `payload` 的生命周期对齐，但不参与渲染。
   */
  const hadPreview = useRef(false)
  if (!scanId) hadPreview.current = false

  /**
   * 上一次请求的**键 → 结果**缓存（人类伙伴 2026-10-20：「每次重新点击垃圾清理会重新计价，
   * 实现保存本次记录」）。
   *
   * 缓存的是「键相同就别再问一趟」，不是「永远不重算」。键由三样组成：
   * `scanId`（换一次扫描必须重算）、勾选集合、`tilePaths`。**`scanStatus` 也进键**：
   * 扫描从 `running` 变 `completed` 时树上多了东西，同一份勾选的答案会变 ——
   * 少了这一项，切页回来会拿到"扫描中"那一刻的旧账（正是下面那条注释记过的坑）。
   *
   * 为什么放在 hook 里而不是提升到 App：切走 `Cleanup` 页组件会卸载，本 hook 的 state 一起没，
   * 缓存就没意义了。所以缓存**必须活在组件之外**（模块级），并按 `scanId` 隔离 ——
   * 两个会话的键不同，不会互相污染；会话过期后服务端会回 null，界面照常显示那一句。
   */
  const key = previewCacheKey(scanId, selectedRuleIds, tilePaths, scanStatus, refreshNonce ?? 0)
  if (previewCache.has(key)) {
    const hit = previewCache.get(key)!
    if (hit !== payload) {
      // 命中缓存时**同步**把值摆正，不留一次 loading 闪烁。
      // 直接 setState 在渲染期调用是允许的：React 会丢掉本次渲染并立刻重渲染。
      setPayload(hit)
      hadPreview.current = true
    }
  }

  useEffect(() => {
    let alive = true
    if (!scanId) {
      setPayload(null)
      setError(null)
      setPending(false)
      hadPreview.current = false // 换扫描 = 新的一轮，下次进来该重新显示 Loading
      return
    }
    const mine = ++seq.current
    // 命中过缓存就不发请求，也不闪 loading。
    if (previewCache.has(key)) {
      setPending(false)
      return
    }
    /**
     * `pending` 只表示"有请求在飞"，**不是**给界面看的 loading。
     * 界面那个 Loading 由 `shouldShowLoading(hadPreview, pending, false)` 决定 ——
     * 也就是"还没有任何预估"时才算。两者分开，是因为"在飞"与"该不该显示"不再是同一件事
     * （勾选后的重算一直在飞，但它不该在界面上闪）。
     */
    const showFirstLoading = shouldShowLoading(hadPreview.current, true, false)
    setPending(showFirstLoading)
    window.deepclean
      .previewCleanup(scanId, {
        selection: { items: selectedRuleIds.map((ruleId) => ({ ruleId })) },
        tilePaths: [...tilePaths]
      })
      .then((p) => {
        if (!alive || mine !== seq.current) return
        setPayload(p)
        setError(p === null ? previewNullMessage(scanStatus) : null)
        if (p !== null) {
          hadPreview.current = true
          previewCache.set(key, p)
          // 只留最近 8 份：勾选来回点不该把整棵树的历史都攒在内存里。
          if (previewCache.size > 8) {
            const oldest = previewCache.keys().next().value
            if (oldest !== undefined) previewCache.delete(oldest)
          }
        }
      })
      .catch((e: unknown) => {
        if (alive && mine === seq.current) setError(String(e))
      })
      .finally(() => {
        if (alive && mine === seq.current) setPending(false)
      })
    return () => {
      alive = false
    }
    // scanStatus 在依赖里：扫描从 running 变成 completed 时必须重算一次。少了它，预估会永远停在
    // "刚开始、树上还没东西"的那一刻 —— 实测截图里首页因此显示 0 B，而同一份扫描在清理页显示 47.7 MB。
  }, [key])

  /**
   * 对外的 `loading` = **这一页还没有任何预估**（决定语义见 `shouldShowLoading` 那段注释）。
   * `pending` 是内部事实（请求在飞），不往外送 —— 送出去就会有人拿它画 spinner，
   * 而那正是这次要消掉的东西。
   *
   * 2026-10-24：`requestConfirmation` 随手动档一起删了（一键清理合并成唯一入口，
   * 界面不再单独走「确认预估」那一步 —— 服务端 `run_auto_clean` 内部 confirm）。
   * 预览通道本身不变，仍由下面这个 effect 驱动。
   */
  const loading = shouldShowLoading(hadPreview.current, pending, false)

  return { payload, error, loading }
}

/**
 * 预览缓存的键。**抽成纯函数是为了能被单测钉住**（2026-10-25）。
 *
 * 为什么值得单独钉：这条键的每一格都是「键变了才会重算」的一个理由，少一格就是
 * 那一种变化被静默吞掉。`refreshNonce` 那一格是 2026-10-25 那个缺陷的正中央 ——
 * 它当时住在 `Cleanup` 的本地 state 里，切页归零，键与清理前逐字相同 ⇒ 命中旧缓存，
 * 用户看到清理前的旧数。
 *
 * 现在 nonce 由 `App` 持有，但「键里必须有它」这一条不该只靠注释守着。
 */
export function previewCacheKey(
  scanId: string | null,
  selectedRuleIds: readonly string[],
  tilePaths: readonly string[],
  scanStatus: string | null | undefined,
  refreshNonce: number
): string {
  return JSON.stringify([scanId, [...selectedRuleIds].sort(), [...tilePaths], scanStatus, refreshNonce])
}