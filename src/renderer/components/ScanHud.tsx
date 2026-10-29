import { formatBytes, formatCount, formatElapsed } from '../../../shared/format'
import type { ScanSnapshot } from '../../../shared/types'

/** §7 的四行 + §8 完成后要求的四项统计。扫描中与完成后共用同一组件。
 *
 *  `variant`：
 *  - `'bar'`（默认）= 整宽横条（三列）；
 *  - `'card'` = 首页右栏卡片形态（V0.9 第六轮，用户裁定：「空间概览」整块删除，
 *    「正在扫描」搬进这一格）——窄栏里六格改 2 列 × 3 行，只由 CSS 收窄，数字与措辞两形态逐字相同。 */
export function ScanHud({ s, variant = 'bar' }: { s: ScanSnapshot | null; variant?: 'bar' | 'card' }): JSX.Element | null {
  if (!s) return null
  return (
    <section className={`dc-hud${variant === 'card' ? ' dc-hud--card' : ''}`}>
      <div className="dc-hud-line">
        <b>{s.status === 'paused' ? '已暂停' : s.status === 'running' ? '正在扫描' : '扫描结束'}</b>
        {/* 档位徽标只对 MFT 直读档亮出：walk 是兜底常态，无须占一行；
            mft 档的口径差异（meta 记录、ADS、驻留 alloc=0）都解释在悬停里，
            报告里的 scanMode 字段是同一句话在数据面的落点。 */}
        {s.scanMode === 'mft' && (
          <i
            className="dc-badge dc-badge-mode"
            title="NTFS $MFT 直读（记录级精度）：管理员权限 + 盘符根 + NTFS 卷时启用，系统元文件与备用数据流一并计入"
          >
            MFT 直读
          </i>
        )}
        <span className="dc-mono dc-ell" title={s.currentPath}>
          {s.currentPath || '准备中…'}
        </span>
      </div>
      <div className="dc-hud-grid">
        <Cell label="已扫描文件" value={formatCount(s.files)} />
        <Cell label="已扫描目录" value={formatCount(s.dirs)} />
        <Cell label="已发现空间" value={formatBytes(s.totalBytes)} />
        <Cell label="耗时" value={formatElapsed(s.elapsedMs)} />
        <Cell label="跳过项目" value={formatCount(s.skipped)} />
        <Cell label="权限错误" value={formatCount(s.denied)} />
      </div>
      {/* §15：HUD 只把"跳过"这一栏里最要紧的那一类点出来，而把"点名"这件事交给地图 ——
          清单最多 200 条绝对路径，在首页重复一遍既占屏又会出现两份真相（要留要删都只该有一个地方）。
          这句与下面那句 truncated 各管一件事：那句是"文件名没存进内存、容量照计"，
          这一句是"这些路径压根没读进来、容量没计"，措辞不许互相借用。 */}
      {s.denied > 0 && (
        <p className="dc-muted">其中 {formatCount(s.denied)} 个是权限拒绝，它们的容量没算进上面的数字，详见地图「部分数据无法访问」那一栏。</p>
      )}
      {s.truncated && (
        <p className="dc-warn">文件清单已达上限，仅折叠文件列表以保护内存；大小仍完整统计。</p>
      )}
    </section>
  )
}

function Cell({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="dc-cell">
      <i>{label}</i>
      <b className="dc-mono">{value}</b>
    </div>
  )
}
