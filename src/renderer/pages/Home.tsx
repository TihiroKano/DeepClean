import { useEffect, useState } from 'react'
import { formatBytes, formatCount, formatDay, formatElapsed } from '../../../shared/format'
import { OVERVIEW_BUCKET_LABELS, summarizeGroups, toOverviewRows, type GroupSummary } from '../../../shared/group-summary'
import type { Scan } from '../hooks/useScan'
import { usePreview } from '../hooks/usePreview'
import { ScanHud } from '../components/ScanHud'
import { Donut } from '../components/Donut'
import { ChevronDownIcon, ChevronRightIcon, ClockIcon, DriveIcon, FolderIcon, PieIcon, SparkleIcon } from '../components/icons'

const NO_SELECTION: readonly string[] = []
const NO_TILE_PATHS: readonly string[] = []
// 首页那一格只是"报告口径的合计"，勾选不归它管 —— 两个默认值都必须是模块级常量，
// 否则每次渲染换新引用，usePreview 的 effect 就会无限重发预估

/**
 * 「可清理」这个数的口径。
 *
 * 它必须有人能读到（否则界面上一句"7.0 MB"是在承诺一个没人核过的算法），但不占版面 ——
 * 挂 `title` 悬停看得到。第五轮那个 `title` 从主面板的「本次可清理」挪到了「最近一次扫描」卡
 * 里那句话上：面板上那一格被这张图撤掉了，而这个数只剩这一处显示（口径不能跟着那一格一起没）。
 */
const RECLAIM_BASIS =
  '可清理 = 安全 / 谨慎 / 高风险三档之和；禁止级不计入，只报告占用。四档由扫描到的真实分类归并而来，映射见 shared/group-summary.ts。'

/**
 * 「最近一次扫描」那一行的时间怎么说。
 *
 * 只吃 `finishedAtMs`（墙上时刻），**不吃 `elapsedMs`**：后者是时长，
 * 拿 `Date.now() - elapsedMs` 反推会随提问时刻一直往后漂。
 * 日历日一律引 `formatDay` —— 那是本项目对"同一天"的唯一定义（清理记录页的筛选与显示都靠它），
 * 在这里自己比 year/month/date 就是造第二份，而第二份只在跨时区的机器上才和那边分叉。
 * 昨天用**日期分量减一**算，不用 `ms - 86400000`：后者在有夏令时的时区会跳错一天。
 */
function lastScanLabel(ms: number, now: Date): { when: string; clock: string } {
  const t = new Date(ms)
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  const day = formatDay(ms)
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  if (day === formatDay(now.getTime())) return { when: '今天', clock: hhmm }
  if (day === formatDay(yesterday)) return { when: '昨天', clock: hhmm }
  return { when: day, clock: hhmm }
}

/** 把 `formatBytes` 的 "76.4 GB" 拆成数字与单位两段，好让单位能用小字号挂在大数后面。 */
function splitBytes(s: string): { num: string; unit: string } {
  const i = s.lastIndexOf(' ')
  return i < 0 ? { num: s, unit: '' } : { num: s.slice(0, i), unit: s.slice(i + 1) }
}

/**
 * 下排卡中间那幅插画：玻璃文件夹 + 对勾（验收图的"完成态"暗示）。
 *
 * **为什么是手绘 SVG 不是生成位图**：它要浮在半透明玻璃卡上 —— 位图没有真 alpha，
 * 一贴就是一块矩形色斑；SVG 的每个形状自己带透明度，还能直接引 `--accent-*` 跟色板走。
 * 纯装饰，`aria-hidden`，`pointer-events: none` 由 `.dc-home-art` 兜住。
 */
function FolderArt(): JSX.Element {
  return (
    <svg width="150" height="126" viewBox="0 0 150 126" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="dc-art-folder" x1="0.2" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#7fb4f8" stopOpacity="0.72" />
          <stop offset="0.55" stopColor="#3d7fe8" stopOpacity="0.5" />
          <stop offset="1" stopColor="#1a3f96" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id="dc-art-front" x1="0.3" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#a9ceff" stopOpacity="0.5" />
          <stop offset="1" stopColor="#2c62c4" stopOpacity="0.62" />
        </linearGradient>
        <linearGradient id="dc-art-paper" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#eaf3ff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#9ec2f2" stopOpacity="0.5" />
        </linearGradient>
        <linearGradient id="dc-art-badge" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#cfe6ff" />
          <stop offset="1" stopColor="#5a9cf6" />
        </linearGradient>
        <radialGradient id="dc-art-glow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#4d8ff5" stopOpacity="0.38" />
          <stop offset="1" stopColor="#4d8ff5" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* 底部那摊环境光晕 */}
      <ellipse cx="75" cy="100" rx="64" ry="17" fill="url(#dc-art-glow)" />
      {/* 后面那张纸（微微右倾，探出夹口） */}
      <g transform="rotate(7 84 40)">
        <rect x="58" y="10" width="52" height="62" rx="7" fill="url(#dc-art-paper)" stroke="rgba(235,245,255,0.5)" strokeWidth="1" />
        <path d="M66 24h34M66 33h34M66 42h22" stroke="rgba(40,80,160,0.35)" strokeWidth="2.4" strokeLinecap="round" />
      </g>
      {/* 文件夹后壁（带夹耳） */}
      <path
        d="M16 46c0-6 4.4-10 10.4-10h27.2l10.4 11.6h59.6c6 0 10.4 4 10.4 10v38c0 6.6-5.4 12-12 12h-94c-6.6 0-12-5.4-12-12Z"
        fill="url(#dc-art-folder)"
        stroke="rgba(214,234,255,0.5)"
        strokeWidth="1.2"
      />
      {/* 文件夹前壁：更亮的一条玻璃面，光从上面来 */}
      <path
        d="M16 62h118v33.6c0 6.6-5.4 12-12 12h-94c-6.6 0-12-5.4-12-12Z"
        fill="url(#dc-art-front)"
        stroke="rgba(226,240,255,0.45)"
        strokeWidth="1"
      />
      <path d="M20 66h110" stroke="rgba(255,255,255,0.4)" strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
      {/* 对勾徽标 */}
      <circle cx="116" cy="92" r="15" fill="url(#dc-art-badge)" stroke="rgba(255,255,255,0.65)" strokeWidth="1.2" />
      <path d="m109.5 92 4.6 4.8 8.4-9" stroke="#0c3a86" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </svg>
  )
}

/**
 * 首页（V0.9 第七轮：填满一屏 + 下排收成一栏）。
 *
 * 这一屏仍然只围绕**分析并清理当前这一块盘**，版面收成两层：上排"主面板 + 扫描过程"等高；
 * 下排**一栏** —— 一张卡，中间一根竖线隔开「最近一次扫描」与「扫描范围」。
 * 上半屏撑满内容区（`.dc-home-grid { flex: 1 }`），上/排间/下三处留白一律 `--sp-4`。
 *
 * 与第四轮相比的三处改动，连同代价：
 * ① 问候行整条删掉 —— 图里没有它。代价：那 56 px 的品牌图标砖是全窗唯一还画着图标的品牌位
 *    （侧栏只有字标），删掉之后整窗再无品牌图标；这是图要的，记在这里。
 * ② 快速入口六格与「磁盘管理」卡一起删掉 —— 图里下排只有两块卡。代价：**能力一个没少**，
 *    那六格本来就是侧栏六项的第二个入口，侧栏仍在；切盘改成标题行右侧那颗下拉。
 * ③ 切盘入口**仍然只有一处**：标题行右侧的下拉。第四轮那张「磁盘管理」卡（唯一的切盘入口）
 *    随图撤掉，入口换成这颗下拉 —— 换的是画法，不是又冒出第二个控件写同一份 `root`。
 *    （"同屏两个控件写同一份 state"是本项目定过的形状缺陷，这条不许破。）
 */
export function Home({ scan, onOpenMap }: { scan: Scan; onOpenMap: () => void }): JSX.Element {
  /*
   * 扫描范围那三格（选盘 / 指定位置 / 那行路径）**不在这里 state** —— 它们住在 `useScan`，
   * 因为扫完应用会自己跳到空间地图，Home 重新挂载会把局部 state 打回初值，
   * 于是同一屏下方写着「扫描 89,801 个文件」（快照，跨视图活着）、右边却写着「本地磁盘 Windows」
   * （局部 state，已经死了）：两处各自成立、合起来互相矛盾，用户会以为刚才扫的是 C 盘。
   * 见 2026-10-15 验收 §4.1。这里只做别名解构，下面的 JSX 一行都不用改。
   */
  const { root, setRoot, scope, setScope, customPath: custom, setCustomPath: setCustom, startTarget } = scan
  const [exportNote, setExportNote] = useState<string | null>(null)
  const [overview, setOverview] = useState<GroupSummary | null>(null)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const { payload } = usePreview(scan.scanId, NO_SELECTION, NO_TILE_PATHS, scan.status)

  /*
   * 「空间概览」走根层：`getChildren(scanId, -1)` 的 `-1` 是让主进程替我们解析根 id
   * （`core/scan/scanner.ts` 的 `children()` 里那一句），渲染端从来拿不到 rootId。
   * V0.9 第六轮它曾被整块撤下（当时用户裁定"扫描时这格要看过程"）；第八轮照验收图恢复，
   * 分工不变：**扫描进行中归 HUD，停下归概览** —— 两件事共用一格，不同时上屏。
   */
  useEffect(() => {
    const { scanId, status } = scan
    const done = status === 'completed' || status === 'cancelled'
    if (!scanId || scan.running || !done) {
      setOverview(null)
      setOverviewError(null)
      return
    }
    let alive = true
    void window.deepclean
      .getChildren(scanId, -1)
      .then((p) => {
        if (!alive) return
        // `null` 是真的会发生的：扫描任务被主进程回收了就回 null，而不是抛错。
        // 把它当成"空的一层"画，会得到一张 0 档的概览卡，看着像"这盘什么都没占"。
        if (p === null) {
          setOverview(null)
          setOverviewError('这次扫描的树已经不在了（任务被回收），概览取不到。')
          return
        }
        setOverview(summarizeGroups(p.children, p.foldedBytes, p.excludedBytes, p.size))
      })
      .catch((e: unknown) => {
        if (!alive) return
        setOverview(null)
        setOverviewError(String(e))
      })
    return () => {
      alive = false
    }
  }, [scan.scanId, scan.status, scan.running])

  const drive = scan.drives.find((d) => d.root === root)
  const pct = drive && drive.totalBytes > 0 ? (drive.usedBytes / drive.totalBytes) * 100 : 0
  const reclaimable = payload && payload.scanStatus === 'completed' ? payload.preview.reportReclaimableBytes : null
  const used = splitBytes(drive ? formatBytes(drive.usedBytes) : '—')
  const total = splitBytes(drive ? formatBytes(drive.totalBytes) : '—')
  const free = drive ? formatBytes(Math.max(0, drive.totalBytes - drive.usedBytes)) : '—'

  // 概览那四档的百分数按**四档之和**求，不按盘容量：折叠/排除/未计入那部分不在四档里，
  // 按盘容量算会得到四个加起来不到 100% 的数，而界面没说为什么 —— 那是能看出来的假数。
  const overviewRows = overview === null ? [] : toOverviewRows(overview.buckets)
  const bucketTotal = overviewRows.reduce((s, r) => s + r.bytes, 0)
  const residual = overview === null ? 0 : overview.foldedBytes + overview.excludedBytes + overview.unaccountedBytes

  const snap = scan.snapshot

  return (
    <div className="dc-home">
      <div className="dc-home-grid">
        <section className="dc-card dc-panel-main">
          {/* 标题行：盘符图标 + 「本地磁盘 (C:)」+ 右侧那颗切盘下拉（全窗唯一的切盘入口）。 */}
          <div className="dc-panel-h">
            <span className="dc-panel-h-ic">
              <DriveIcon size={18} />
            </span>
            <h2 className="dc-panel-h-title">{drive ? `本地磁盘 (${drive.label})` : '本地磁盘'}</h2>
            {/* 切盘：`<select>` 是这一屏唯一的 `root` 写入点。它同时是标题行右侧那颗药丸，
                不是标题行下拉 + 别处再来一个 —— 一个控件一种画法不是缺陷，两个控件才是。 */}
            <label className="dc-drive-pick" title="要分析的磁盘 —— 全窗唯一的切盘入口">
              <DriveIcon size={14} />
              <select
                className="dc-drive-select"
                value={root}
                disabled={scan.running}
                onChange={(e) => setRoot(e.target.value)}
                aria-label="选择要分析的磁盘"
              >
                {scan.drives.length === 0 ? (
                  <option value={root}>{'—'}</option>
                ) : (
                  scan.drives.map((d) => (
                    <option key={d.root} value={d.root}>
                      {d.label}
                    </option>
                  ))
                )}
              </select>
              <ChevronDownIcon size={13} className="dc-drive-caret" />
            </label>
          </div>

          <div className="dc-gauge-row">
            <Donut pct={pct} sub="已使用" ariaLabel={drive ? `${drive.label} 已使用 ${pct.toFixed(1)}%` : '磁盘用量'} />
            <div className="dc-gauge-meta">
              {/* 两个大数中间立一根分隔线（图上就是一根竖线），不是"两个数 + 右挂可清理"那套。 */}
              <div className="dc-stats">
                <div className="dc-stat">
                  <b>
                    {used.num}
                    {used.unit && <small>{used.unit}</small>}
                  </b>
                  <i>已使用</i>
                </div>
                <span className="dc-stat-sep" aria-hidden="true" />
                <div className="dc-stat">
                  <b>
                    {total.num}
                    {total.unit && <small>{total.unit}</small>}
                  </b>
                  <i>总容量</i>
                </div>
              </div>

              {/* 线性用量条挂在两个大数**下面**（图上条子只在数字那一列里，不横穿环）。
                  恒蓝 —— 严不严重由百分比数字与"环几乎满了"这件事说，红色在本项目里已经有主了
                  （`--risk-*` = 风险等级），首页百分比不占它。 */}
              <div className="dc-usage">
                <div className="dc-meter">
                  <div className="dc-meter-fill" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                </div>
                <div className="dc-usage-legend">
                  <span className="dc-legend-item">
                    <i className="dc-dot" />已使用 {used.num} {used.unit}
                  </span>
                  <span className="dc-legend-item">
                    <i className="dc-dot dc-dot-free" />剩余 {free}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="dc-cta-row">
            {!scan.running ? (
              <button
                className="dc-cta"
                disabled={startTarget.length === 0}
                title={startTarget.length === 0 ? '先在「扫描范围」里选一个磁盘' : undefined}
                onClick={() => void scan.start(startTarget)}
              >
                <SparkleIcon size={17} />
                开始深度扫描
                <ChevronRightIcon size={16} />
              </button>
            ) : (
              <div className="dc-cta-stack">
                <button className="dc-btn" onClick={() => void (scan.paused ? scan.resume() : scan.pause())}>
                  {scan.paused ? '继续扫描' : '暂停扫描'}
                </button>
                <button className="dc-btn dc-btn-danger" onClick={() => void scan.cancel()}>
                  取消扫描
                </button>
                <span className="dc-live">{scan.paused ? '已暂停（已发现的树照常能看）' : '扫描中…'}</span>
              </div>
            )}
            {/* 扫描范围已搬出主面板，落在下排那块卡里（图上它在下排右侧）。 */}
          </div>

          <div className="dc-panel-notes">
            {scan.drivesError && <p className="dc-warn dc-fineprint">读取磁盘列表失败：{scan.drivesError}</p>}
            {scan.startError && <p className="dc-warn">{scan.startError}</p>}
            {scan.status === 'failed' && <p className="dc-warn">扫描失败：根目录不可读。试试换一个盘或提权运行。</p>}
            {scan.snapshot && scan.status !== 'running' && (
              <p className="dc-muted dc-fineprint">
                {scan.status === 'completed' ? '扫描完成' : '扫描已取消'}，用时 {formatElapsed(scan.snapshot.elapsedMs)} ·
                共 {formatBytes(scan.snapshot.totalBytes)}
              </p>
            )}
            <p className="dc-muted dc-fineprint dc-notes-tail">扫描 ≠ 删除 · 清理须逐项确认</p>
          </div>
        </section>

        <aside className="dc-card dc-card--quiet dc-panel-side">
          {/*
            右栏分工（V0.9 第八轮照验收图恢复「空间概览」，第六轮"扫描时这格要看过程"的裁定保留）：
            扫描进行中 → HUD 实时读数（保持第六轮的整卡形态，不加栏头）；
            停下 → 概览四档；没扫过 → 一句真话，不留白也不印没算过的数字。
          */}
          {scan.running ? (
            snap ? (
              <ScanHud s={snap} variant="card" />
            ) : (
              <p className="dc-muted dc-fineprint dc-side-empty">正在准备扫描…</p>
            )
          ) : (
            <>
              <div className="dc-panel-head">
                <span className="dc-panel-head-ic">
                  <PieIcon size={16} />
                </span>
                <h2 className="dc-panel-title">空间概览</h2>
                {drive && <span className="dc-panel-tag">{drive.label}</span>}
              </div>
              {overview !== null ? (
                <>
                  <ul className="dc-ov-rows">
                    {overviewRows.map((r) => (
                      <li key={r.bucket} className={`dc-ov-row dc-ov-${r.bucket}`}>
                        <div className="dc-ov-row-head">
                          <i className={`dc-dot dc-dot-${r.bucket}`} />
                          <span className="dc-ov-name">{OVERVIEW_BUCKET_LABELS[r.bucket]}</span>
                          <span className="dc-ov-pct">
                            {bucketTotal > 0 ? `${((r.bytes / bucketTotal) * 100).toFixed(0)}%` : '—'}
                          </span>
                        </div>
                        <span className="dc-ov-bar">
                          <i style={{ width: `${bucketTotal > 0 ? Math.min(100, (r.bytes / bucketTotal) * 100) : 0}%` }} />
                        </span>
                      </li>
                    ))}
                  </ul>
                  {residual > 0 && (
                    <p className="dc-muted dc-fineprint">
                      另有 {formatBytes(residual)} 没能归类，未计入上面四档。
                      {scan.snapshot?.truncated ? '（本轮被条数上限截断）' : ''}
                    </p>
                  )}
                </>
              ) : (
                <p className="dc-muted dc-fineprint dc-side-empty">
                  {overviewError !== null
                    ? overviewError
                    : scan.snapshot
                      ? '正在向主进程取根层分类…'
                      : '还没有扫描记录。点上面「开始深度扫描」，这里会把磁盘空间按类别摊开。'}
                </p>
              )}
            </>
          )}
        </aside>
      </div>

      {/* 下排是**一张卡、一根竖线**（图上就是一条横贯的玻璃）：左半「最近一次扫描」、
          中间一幅玻璃文件夹插画（完成态的暗示，纯装饰）、右半「扫描范围」，
          那根线由 `.dc-home-half:last-child` 的 `border-left` 画，随两半一起撑满整卡高度。 */}
      <section className="dc-card dc-card--quiet dc-home-cards">
        <div className="dc-home-half dc-recent">
          <div className="dc-tile-head">
            <span className="dc-tile-head-ic">
              <ClockIcon size={15} />
            </span>
            最近一次扫描
          </div>
          {scan.snapshot?.finishedAtMs != null ? (
            <>
              {(() => {
                const w = lastScanLabel(scan.snapshot.finishedAtMs!, new Date())
                return (
                  <div className="dc-recent-when">
                    {w.when} {w.clock}
                  </div>
                )
              })()}
              <div className="dc-recent-row">
                <span className="dc-recent-v">扫描 {formatCount(scan.snapshot.files)} 个文件</span>
                <span className="dc-recent-sep">·</span>
                {/* 全窗唯一还写着「可清理」的地方 —— 口径挂在 `title` 上，悬停才看得到。 */}
                <span className="dc-recent-v" title={RECLAIM_BASIS}>
                  发现 {reclaimable === null ? '—' : formatBytes(reclaimable)} 可清理
                </span>
              </div>
              <button className="dc-btn" onClick={onOpenMap}>
                查看扫描结果 <ChevronRightIcon size={12} />
              </button>
              <button
                className="dc-link"
                disabled={!scan.scanId}
                title="v0.1：带 schema 版本的扫描报告（计数 / 错误分账 / 净速度 / 目录摘要）"
                onClick={() => {
                  if (!scan.scanId) return
                  void window.deepclean
                    .exportScanReport(scan.scanId)
                    .then((r) => setExportNote(r.ok ? `已导出：${r.path}` : `导出未完成：${r.error}`))
                    .catch((e: unknown) => setExportNote(String(e)))
                }}
              >
                导出 JSON 报告
              </button>
              {exportNote && <p className="dc-muted dc-fineprint">{exportNote}</p>}
            </>
          ) : (
            <span className="dc-recent-v dc-muted">
              {scan.running
                ? '这一轮还在扫，扫完这里会给出时刻与合计。'
                : '还没有完成的扫描。跑一次之后，这里会给出时刻、文件数与可清理合计。'}
            </span>
          )}
        </div>

        {/* 插画：骑在两半之间，随卡高等高居中 —— 窄窗下它是最先被牺牲的装饰，不占语义位 */}
        <div className="dc-home-art" aria-hidden="true">
          <FolderArt />
        </div>

        {/* 扫描范围：图里它在右半、radio 竖排。搬出主面板只是换位置，能力一字未减。 */}
        <div className="dc-home-half">
          <div className="dc-tile-head">
            <span className="dc-tile-head-ic">
              <FolderIcon size={15} />
            </span>
            扫描范围
          </div>
          <fieldset className="dc-scope">
            <legend className="dc-sr-only">扫描范围</legend>
            <div className="dc-scope-opts">
              <label className="dc-radio">
                <input type="radio" name="dc-scope" checked={scope === 'drive'} onChange={() => setScope('drive')} disabled={scan.running} />
                <span>{drive ? `本地磁盘 ${drive.label}` : '当前磁盘'}</span>
              </label>
              <label className="dc-radio">
                <input type="radio" name="dc-scope" checked={scope === 'custom'} onChange={() => setScope('custom')} disabled={scan.running} />
                <span>选择位置</span>
              </label>
            </div>
            {/*
              选择位置：**盘符下拉**，不是自由文本框（人类伙伴 2026-10-20：图一那个输入框
              超出容器右缘，且要求「选择位置改为磁盘选项（DEF 等）」）。

              为什么不退化成"还能手填"：下拉把目标限定在 `listDrives()` 给出的盘根上，
              既治了越界（`min-width: 280px` 的文本框是元凶），也保证了扫的目标一定存在 ——
              手填一个拼错的路径只会换来一次"根目录不可读"。

              值写进 `customPath`：`resolveScanTarget` 的口径一字未动（它 trim 后把
              `D:\` 当普通字符串送），`scan-scope-ownership` 那三条断言因此不用改。
            */}
            {scope === 'custom' && (
              <div className="dc-scope-custom">
                <span className="dc-scope-custom-ic">
                  <FolderIcon size={15} />
                </span>
                <select
                  className="dc-select dc-scope-drive"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  disabled={scan.running}
                  aria-label="选择要扫描的磁盘"
                >
                  <option value="">选择磁盘…</option>
                  {scan.drives.map((d) => (
                    <option key={d.root} value={d.root}>
                      磁盘 ({d.label}) · {formatBytes(d.freeBytes)} 可用
                    </option>
                  ))}
                </select>
              </div>
            )}
          </fieldset>
        </div>
      </section>
    </div>
  )
}
