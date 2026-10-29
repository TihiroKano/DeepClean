import { useCallback, useEffect, useState } from 'react'
import type { DriveInfo, ScanSnapshot, ScanStatus } from '../../../shared/types'

/** 扫描范围那一档：整块盘，还是用户手填的一个目录。 */
export type ScanScope = 'drive' | 'custom'

/** 下一次扫描要送的根。**口径只这一处** —— 页面里再算一遍就是给"两处各自成立、合起来矛盾"留门。 */
export function resolveScanTarget(scope: ScanScope, customPath: string, driveRoot: string): string {
  return scope === 'custom' ? customPath.trim() : driveRoot
}

/**
 * 全应用只调一次（在 App.tsx），往下用 props 传。
 * 各页面各自调会导致 onScanEvent 重复订阅 —— 返回的 cleanup 只在卸载时跑，切页面不卸载就漏。
 */
export function useScan() {
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [drivesError, setDrivesError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<ScanSnapshot | null>(null)
  const [scanId, setScanId] = useState<string | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  /*
   * 「扫描范围」这两格**必须住在这一层**，不能是 Home 的局部 state：扫完应用会自己跳到空间地图，
   * 切回来时 Home 重新挂载 ⇒ 局部 state 回到初值，于是同一屏下方写着「扫描 89,801 个文件」
   * （来自快照，跨视图活着），右边却写着「本地磁盘 Windows」（局部 state，已经死了）——
   * 两处各自成立、合起来互相矛盾，用户会以为刚才扫的是 C 盘。见 2026-10-15 验收 §4.1。
   * 提上来之后它就是一个普通的"下一次扫什么"的选择，跨视图保留，不碰计价也不碰快照。
   */
  const [scope, setScope] = useState<ScanScope>('drive')
  const [customPath, setCustomPath] = useState('')
  // 盘符选择同理：只提这一格而不提它，切一次视图回来会变成"选着 C: 而刚扫的是 D:"，同一个毛病
  const [root, setRoot] = useState('C:\\')

  useEffect(() => {
    if (drives.length === 0) return
    // 只在当前值**不在列表里**时才采纳默认盘：否则用户挑的盘会被每次 drives 刷新冲掉
    setRoot((prev) => {
      if (drives.some((d) => d.root === prev)) return prev
      const c = drives.find((d) => d.root === 'C:\\') ?? drives[0]
      return c ? c.root : prev
    })
  }, [drives])

  /** 下一次扫描真正要送的根。口径住在 `resolveScanTarget`，这里只是把当前三格喂进去。 */
  const startTarget = resolveScanTarget(scope, customPath, root)

  useEffect(() => {
    window.deepclean
      .listDrives()
      .then(setDrives)
      .catch((e: unknown) => setDrivesError(String(e)))
  }, [])

  useEffect(
    () =>
      window.deepclean.onScanEvent((e) => {
        setSnapshot(e.snapshot)
        // **采纳后端报上来的 scanId。** 扫描未必是这一份 `start()` 起的：Tauri 侧的
        // `DC_AUTOSCAN`（dev 截图用）就是后端自己开的，将来多窗口也一样。这时 `start()`
        // 从没跑过、`scanId` 一直是 `null` —— 于是「扫描完成后自动进空间地图」那一步
        // **静默不发生**，而首页看上去一切正常（数字都在，只是停在首页）。
        // 事件里本来就带着 scanId，采纳它不会与 `start()` 的返回值打架（同一会话同一个 id）。
        setScanId((prev) => (prev === e.snapshot.scanId ? prev : e.snapshot.scanId))
      }),
    []
  )

  /**
   * 一次「开始扫描」= 起 DeepClean 自己的扫描（清理/规则判定与空间地图读的是**同一棵树**）。
   *
   * 原先这里还并发拉起一个内嵌的 SpaceSniffer 窗口当画布，那一轮已经移除：
   * 它带来的是「地图一份账、判定另一份账」，而且那条端到端链路从未真正跑通过
   * （见 `docs/acceptance/2026-10-20-cleanup-rules-and-spacesniffer.md`）。
   * 现在地图用字节口径开关对齐 SpaceSniffer 的读数（表观/占用），数据仍然只有一份。
   */
  const start = useCallback(async (root: string) => {
    setStartError(null)
    setSnapshot(null)
    try {
      const r = await window.deepclean.startScan({ root })
      setScanId(r.scanId)
    } catch (e) {
      setStartError(String(e))
    }
  }, [])

  const cancel = useCallback(async () => {
    if (scanId) await window.deepclean.cancelScan(scanId)
  }, [scanId])

  const pause = useCallback(async () => {
    if (scanId) await window.deepclean.pauseScan(scanId)
  }, [scanId])

  const resume = useCallback(async () => {
    if (scanId) await window.deepclean.resumeScan(scanId)
  }, [scanId])

  const status: ScanStatus = snapshot?.status ?? 'idle'
  // running 的含义是"还在占着 I/O"，所以暂停中也算：输入框和按钮在此期间都该禁用
  return {
    drives,
    drivesError,
    snapshot,
    scanId,
    status,
    start,
    cancel,
    pause,
    resume,
    startError,
    root,
    setRoot,
    scope,
    setScope,
    customPath,
    setCustomPath,
    startTarget,
    running: status === 'running' || status === 'paused',
    paused: status === 'paused'
  }
}

export type Scan = ReturnType<typeof useScan>
