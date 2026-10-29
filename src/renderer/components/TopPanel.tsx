import { formatBytes } from '../../../shared/format'
import type { TopRow } from '../../../core/analyze/top-rows'

/** §10：当前层的空间榜。刻意只做「本层」—— 规格书的例子（Users / Program Files / Windows）
 *  就是 C:\ 这一层，跨层的全局榜会把用户的注意力从"我现在在看什么"上拽走。 */
export function TopPanel({
  rows,
  total,
  onLocate
}: {
  rows: TopRow[]
  total: number
  onLocate: (row: TopRow) => void
}): JSX.Element {
  return (
    <section className="dc-top">
      <h3 className="dc-panel-title">空间占用 Top</h3>
      {rows.length === 0 && <p className="dc-muted">本层没有可绘制的内容。</p>}
      <ol className="dc-top-list">
        {rows.map((r, i) => (
          <li key={r.key}>
            <button
              className={`dc-top-row ${r.kind === 'folded' ? 'dc-top-folded' : ''}`}
              disabled={r.kind === 'folded'}
              title={r.kind === 'folded' ? '合计块，未逐一绘制，无法定位' : r.path}
              // 连接键写进 DOM：dev 截图脚本（--shot 的 28）按它找回地图块，
              // 而不是按 name 猜 —— 按 name 匹配等于没在验「点行定位」真正依赖的那个 join。
              data-key={r.key}
              onClick={() => onLocate(r)}
            >
              <span className="dc-top-rank dc-mono">{String(i + 1).padStart(2, '0')}</span>
              <span className="dc-top-name dc-ell">{r.name}</span>
              <span className="dc-top-size dc-mono">{formatBytes(r.size)}</span>
              <span className="dc-top-pct dc-mono dc-muted">{total > 0 ? `${((r.size / total) * 100).toFixed(1)}%` : '—'}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}
