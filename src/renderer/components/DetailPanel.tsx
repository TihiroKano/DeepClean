import { Fragment } from 'react'
import { basisNoun, useSizeBasis } from '../lib/size-basis'
import { buildDetail } from '../../../core/analyze/detail'
import { GROUP_COLORS, RISK_COLORS, type Risk } from '../../../shared/classify'
import { formatBytes } from '../../../shared/format'
import type { ChildView, DirStatsWire } from '../../../shared/types'

const RISK_NOTE: Record<Risk, string> = {
  safe: '🟢 安全',
  caution: '🟡 谨慎',
  high: '🟠 高风险',
  forbidden: '🔴 系统关键区域 · DeepClean 永不清理'
}

export function DetailPanel({
  child,
  parentSize,
  rootSize,
  rootPath,
  folded,
  stats,
  truncated,
  pinned,
  onUnpin
}: {
  child: ChildView | null
  /** 本层总容量：「占当前目录」的分母。 */
  parentSize: number
  /** 本次扫描根容量：第二个百分比的分母。缺省 = 不知道 → 该行显示「—」。 */
  rootSize?: number
  /** 本次扫描的根路径：决定那一行叫「占全盘」（根就是盘符）还是「占扫描根」（根只是个子目录）。 */
  rootPath?: string
  /** 单击的那一格是 Task 2 的「其它 N 项」合计块：磁盘上没有对应条目，能说的字段只剩名称 / 合计容量 / 两个百分比。 */
  folded?: boolean
  /**
   * §9 的目录统计（主进程内存遍历出来的）。
   * `null` / `undefined` = 选中的那一格不是真实目录（文件、折叠块），或压根没选中 —— 整段不渲染，
   * 绝不渲染 0：那两个字节的"最大文件"是编出来的。
   */
  stats?: DirStatsWire | null
  /**
   * `ScanSnapshot.truncated`：本次扫描的文件清单撞到了 `maxFiles` 存储上限，
   * 之后的文件**名字**没往内存里放（容量照计）。它只让「最大文件」这一行变得不可信，
   * 所以这句话必须长在那两行底下 —— `ScanHud` 只挂在首页，地图页没有 HUD，写在那儿等于没说。
   * 文本由模型出（`buildDetail` 的 `truncatedNote`）：这样"三句 caveat 各管各的"那条能在 node 里被测。
   */
  truncated?: boolean
  /**
   * Task 7「查看详情」= 这份详情是被**钉住**的（不是"上一次鼠标碰过哪格"）。
   * true 时标题旁边给一个「已固定」标记 + 取消按钮：钉住这件事必须看得见，
   * 否则用户下次点空白处"详情没消失"就会以为界面坏了。
   */
  pinned?: boolean
  /** 取消固定。`pinned` 为 true 时必须给，否则那个标记就成了关不掉的状态。 */
  onUnpin?: () => void
}): JSX.Element {
  const basis = useSizeBasis()  // 口径从数据读，不写死（见 lib/size-basis.tsx）
  if (!child) return <p className="dc-muted">单击方块看详情；双击目录进入。</p>
  const d = buildDetail(child, parentSize, { folded, rootSize, rootPath, truncated })
  // 面板里每一行都由模型给：null / [] = 这一项不陈述该字段。
  // 折叠块的 fileCount/dirCount/path/mtime 是合成时的 0，不是采集结果 —— 那几行整行不出现（全局口径：不许用 0 冒充没算过的数字）。
  return (
    <div>
      {/* 标题那一行：名称 + 「已固定」。`.dc-panel-title` 里**只有**名称 —— 截图步骤按它读选中的是哪格。 */}
      <div className="dc-detail-head">
        <h3 className="dc-panel-title">{d.name}</h3>
        {pinned === true && (
          <span className="dc-pin" title="这份详情是被「查看详情」钉住的：点画布的空白处不会把它换掉">
            已固定
          </span>
        )}
        {pinned === true && onUnpin && (
          <button className="dc-link" onClick={onUnpin}>
            取消固定
          </button>
        )}
      </div>
      {d.foldedNote && <p className="dc-warn">{d.foldedNote}</p>}
      {d.path !== null && <p className="dc-path">{d.path}</p>}
      <dl className="dc-dl">
        {d.kind !== null && (
          <Fragment>
            <dt>类型</dt>
            {/* §8：要的是「PAK 资源包」这种话，不是「文件」；kind 为 null 时（折叠块）整行不出现 */}
            <dd>{d.typeLabel}</dd>
          </Fragment>
        )}
        <dt>{basisNoun(basis)}</dt>
        <dd>{d.sizeText}</dd>
        <dt>占当前目录</dt>
        <dd>{d.percentOfParent}</dd>
        <dt>{d.rootShareLabel}</dt>
        <dd>{d.percentOfRoot}</dd>
        {d.fileCountText !== null && (
          <Fragment>
            <dt>子树文件数</dt>
            <dd>{d.fileCountText}</dd>
          </Fragment>
        )}
        {d.dirCountText !== null && (
          <Fragment>
            <dt>子目录数</dt>
            <dd>{d.dirCountText}</dd>
          </Fragment>
        )}
        {d.modified !== null && (
          <Fragment>
            <dt>修改时间</dt>
            <dd>{d.modified}</dd>
          </Fragment>
        )}
        {d.created !== null && (
          <Fragment>
            <dt>创建时间</dt>
            <dd className={d.createdCollected ? undefined : 'dc-muted'}>{d.created}</dd>
          </Fragment>
        )}
        {d.attrs.map((a) => (
          <Fragment key={a.key}>
            <dt>{a.label}属性</dt>
            <dd className={a.state === 'unknown' ? 'dc-muted' : undefined}>{a.text}</dd>
          </Fragment>
        ))}
      </dl>
      {/* §9 的后两行。整段的存在与否就是"算过没有"：stats 为 null 时（选中文件 / 折叠块）一个字都不出。
          空目录的两个 largest 是 null → 「—」，不是 0 B。
          扫描中的目录由下面那句「该目录仍在扫描中，数字是中间值」一并覆盖（partial 不管这件事，只管预算）。
          这一屏最多同时出现三句 caveat，各管一件事、措辞不许互相借用（视图折叠 ≠ 预算 ≠ 截断 ≠ 没扫完）：
          partial = 节点预算用尽（遍历本身被截），truncatedNote = 清单撞到存储上限（遍历是全量的，缺的是文件名），
          dc-live = 还在扫（数字是中间值）。折叠块另有 foldedNote 那句，在标题下面。 */}
      {stats && (
        <>
          <dl className="dc-dl">
            <dt>最大文件</dt>
            <dd title={stats.largestFile?.path}>
              {stats.largestFile ? `${stats.largestFile.name} · ${formatBytes(stats.largestFile.size)}` : '—'}
            </dd>
            <dt>最大子目录</dt>
            <dd title={stats.largestSubDir?.path}>
              {stats.largestSubDir ? `${stats.largestSubDir.name} · ${formatBytes(stats.largestSubDir.size)}` : '—'}
            </dd>
          </dl>
          {/* partial 那句独立成 p：`.dc-dl` 是两列 grid，塞一个没有 dt 的 dd 会掉进标签列、把整栏撑歪 */}
          {stats.partial && <p className="dc-warn">仅统计前 {stats.visited} 个节点，结果可能不是全量最大</p>}
          {d.truncatedNote && <p className="dc-warn">{d.truncatedNote}</p>}
        </>
      )}
      <div className="dc-badges">
        <span className="dc-badge" style={{ background: GROUP_COLORS[d.group] }}>
          {d.groupLabel}
        </span>
        <span className="dc-badge dc-badge-risk" style={{ borderColor: RISK_COLORS[d.risk] }}>
          {RISK_NOTE[d.risk]}
        </span>
        {d.protectedByAttrs && <span className="dc-badge dc-badge-risk">🔒 属性保护（系统文件）</span>}
      </div>
      {d.scanning && <p className="dc-live">该目录仍在扫描中，数字是中间值。</p>}
      <p className="dc-muted dc-fineprint">
        {d.folded
          ? '这一格的名称、合计大小和上面两个百分比都是真的（分母来自扫描记账）；它装的是主进程没有下发给渲染端的那批子项的合计容量，磁盘上没有对应条目，所以文件数、子目录数、路径、类型、修改时间、创建时间、属性这些行整行不显示——那些数字从未为它采集过，写个 0 就是谎报。'
          : d.attrsCollected
            ? '「未知（stat 读不到）」不是漏实现：Windows 上 Node 的一次 stat 只带得出只读位，隐藏/系统/存档要原生属性源（实测见 docs/benchmarks/results.md §8）。'
            : '目录本轮不 stat，所以属性与创建时间都是「未采集」而不是「否」或 1970-01-01（多给每个目录一次 lstat ≈ C 盘 7.3 万次额外 I/O）。文件的创建时间来自扫描时那一次 stat，没有多要 I/O。'}
      </p>
      <p className="dc-muted dc-fineprint">
        风险等级只是这一条自身的判定。清理走「垃圾清理」页：逐项勾选 → 预估 → 确认，才有执行（§28 原则一：扫描 ≠ 删除）。
      </p>
    </div>
  )
}
