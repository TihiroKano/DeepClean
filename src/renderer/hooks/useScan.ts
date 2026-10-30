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
  /*
   * **本轮真正扫的那棵树**（2026-10-29 修 bug ②）。
   *
   * 症状（人类伙伴报的）：「当清理位置选择为其他盘时，主页面数据应该也跟着改变，
   * 而不是依旧显示 Windows 占用」。
   *
   * 根因不是布局，是**两处各自算了一遍"扫的是谁"**：
   *  - 快照（文件数 / 用时 / 可清理）来自主进程，说的是**真扫过的那棵树**；
   *  - 环 / 已使用 / 总容量 / 剩余 来自 `drives.find((d) => d.root === root)`，
   *    而 `root` 是**盘符下拉那一格**，与 `customPath` 是两个独立的 state。
   *
   * 于是「扫描范围 = 选择位置、选了 D:」时，`startTarget` 是 `D:\`、扫描也真的扫了 D:，
   * 但盘符下拉还停在 `C:\` ⇒ 左半边画的是 C 盘的用量，右半边与下排说的是 D 盘那次扫描。
   * 两处各自成立、合起来矛盾，而用户会以为清理估的是 C 盘。
   *
   * 修法：**以快照自带的 `root` 为准**（那是主进程说的话，签名里本来就有，
   * 不需要客户端再记一份 —— 客户端记的那份只是它的猜测）。
   * 首页所有"这块盘"的读数都读它；下拉那两格回归本分：**下一次**扫什么。
   *
   * 没有快照时回 `null`（没扫过就不该画出任何一块盘的数据）。
   */

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

  /*
   * 盘容量读数（`listDrives`）的**重新取数入口**（2026-10-30 修 bug）。
   *
   * ⚠️ 原来它只有一个 `useEffect(..., [])` —— **整个进程生命周期里只读一次盘**。
   * 于是清理删掉 2 GB 之后，首页的「已使用 / 总容量 / 剩余 / 环」全是清理前的数：
   * 用户报的原话是「我日志记录了我刚刚进行了一次删除，但是主页面的值和我实际 C 盘
   * 剩余的值不一样，还是显示清理前的数值」（实际空闲 3.31 GB，界面还写 1.0 GB）。
   *
   * 三个触发点都要打这个 `refresh`：
   *  ① 清理完成（`App` 的 `onCleanDone`）；
   *  ② 一次扫描跑完 —— 扫描本身不改盘，但它跑那几十秒里盘会变，而首页正好要重画；
   *  ③ 用户切回首页（`App` 切 view 时）—— 他在别的程序里删了东西也该看到。
   *
   * **不是轮询**：一秒一次 `GetDiskFreeSpaceExW` 听着便宜，但它会让"这个数什么时候更新过"
   * 变成没人说得清的事，而"清理完立刻准"才是用户能感知的那一件事。
   */
  const refreshDrives = useCallback((): void => {
    window.deepclean
      .listDrives()
      .then((d) => {
        setDrives(d)
        // 读到了就清掉上一次的错 —— 否则"读磁盘列表失败"会一直挂在那儿，
        // 而它可能只是开机那一下盘还没就绪。
        setDrivesError(null)
      })
      .catch((e: unknown) => setDrivesError(String(e)))
  }, [])

  useEffect(() => {
    refreshDrives()
  }, [refreshDrives])

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

  /*
   * 扫描进入终态那一帧，顺手把盘容量重读一次（2026-10-30）。
   *
   * 判据是**终态**（completed / cancelled / failed），不是 `running === false`：
   * 后者在"还没开始"时也成立，会在挂载那一刻多打一次 IPC。
   *
   * 为什么扫描完要重读：扫描本身一个文件都不动，但它跑那几十秒里盘会变
   * （别的程序在写、缓存被回收），而此刻首页正好要重画整块盘 —— 不重读就是
   * "扫完了但数字还是启动时那次读的"。
   */
  const scanStatus = snapshot?.status
  useEffect(() => {
    if (scanStatus === 'completed' || scanStatus === 'cancelled' || scanStatus === 'failed') {
      refreshDrives()
    }
  }, [scanStatus, refreshDrives])

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
  /*
   * 首页"这块盘"的读数该读哪个根 —— **两级口径**（2026-10-29 修回归）。
   *
   * ⚠️ 第一版写成 `snapshot?.root ?? null`，于是**首次进入时整块盘都是空的**：
   * 没扫过就没有快照，没有快照就没有驱动盘 → 环是 0.0%、已使用与总容量都是「—」。
   * 而用户报的症状正是「首次进入应该默认显示 C 盘数据啊，怎么全是 0」。
   *
   * 正确的口径是**两件事分开**：
   *  - 扫过（`snapshot.root` 有值）→ 读它。它说的是"刚才真扫了哪"，不会因为下拉改了而跳。
   *  - 没扫过 → 读 `startTarget`，那是"下次要扫哪"，也就是首页上那个下拉此刻选着的盘。
   *    用户就是要在没扫之前先看见 C/D 盘的容量 —— 那个数来自 `listDrives()`，
   *    与扫描无关，**从来没有"没扫过所以不显示"的理由**。
   *
   * 为什么 `startTarget` 可以在这里用而上一版不敢用：上一版担心"下拉改了、正在报扫描结果的
   * 那半张卡跟着跳"。现在两级口径把这个担心消掉了 —— 只要**有快照**就一律读快照，
   * 下拉怎么改都影响不到它。`startTarget` 只在"还没扫过"时参与，而那时没有扫描结果可跳。
   */
  const scannedRoot: string = snapshot?.root ?? startTarget
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
    /** 重新读一次盘容量（2026-10-30）。清理完成 / 切回首页 / 扫描收尾时打。 */
    refreshDrives,
    startError,
    root,
    setRoot,
    scope,
    setScope,
    customPath,
    setCustomPath,
    startTarget,
    scannedRoot,
    running: status === 'running' || status === 'paused',
    paused: status === 'paused'
  }
}

export type Scan = ReturnType<typeof useScan>
