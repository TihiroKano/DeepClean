import type { ColorMode } from '../../../core/analyze/treemap-data'
import { formatBytes } from '../../../shared/format'
import type { Level } from '../hooks/useTreeNav'
import { basisHint, basisWord, useSizeBasis, type SizeBasis } from '../lib/size-basis'

const MODE_LABELS: Record<ColorMode, string> = { type: '按类型', size: '按大小', dir: '按目录' }

/**
 * 口径选择器的两个选项。**标签与 `basisWord` 同字**：下拉里写「表观」、旁边读数也写「表观」，
 * 两处各写一份文案就会出现"选了占用、读数说表观"那种自相矛盾。
 */
const BASIS_LABELS: Record<SizeBasis, string> = { apparent: '表观大小', allocated: '占用空间' }

export function Breadcrumb({
  stack,
  currentSize,
  canBack,
  colorMode,
  sizeBasis,
  onGoto,
  onBack,
  onColorMode,
  onSizeBasis
}: {
  stack: Level[]
  currentSize: number
  canBack: boolean
  colorMode: ColorMode
  sizeBasis: SizeBasis
  onGoto: (i: number) => void
  onBack: () => void
  onColorMode: (m: ColorMode) => void
  onSizeBasis: (b: SizeBasis) => void
}): JSX.Element {
  const basis = useSizeBasis()
  return (
    <div className="dc-bar">
      <button className="dc-btn" disabled={!canBack} onClick={onBack} title="返回上一级">
        ←
      </button>
      <nav className="dc-crumbs">
        {stack.map((l, i) => {
          const label = i === 0 ? l.path : l.path.slice(l.path.lastIndexOf('\\') + 1)
          return (
            <span key={l.dirId} className="dc-crumb-wrap">
              {i > 0 && <span className="dc-sep">›</span>}
              <button className="dc-crumb" title={l.path} onClick={() => onGoto(i)}>
                {label || l.path}
              </button>
            </span>
          )
        })}
      </nav>
      <span className="dc-spacer" />
      {/* 口径标签不许省，而且**不许写死**：这个数挂在盘符旁边，读起来就是"这块盘用了这么多"。
          Electron 侧给表观大小（硬链接按名重复计，实测能超过整块卷的物理容量 93.78 vs 80.00 GiB），
          Tauri 的 Rust 内核给占用大小（已去重、按簇计，不会超容量）—— 同一个位置两种含义，
          所以字从数据里读（见 `lib/size-basis.tsx`）。 */}
      <span className="dc-muted dc-mono" title={basisHint(basis)}>
        {basisWord(basis)} {formatBytes(currentSize)}
      </span>
      {/* 口径开关。**两套数在扫描时就都算好了**，切这里只是换一个当 `size`，不重扫。
          为什么值得一个开关：SpaceSniffer 与资源管理器「大小」列给的是表观（硬链接按名
          重复计），而"这块盘占了多少"只有去重后的占用口径答得对。两句话都真，
          所以让用户自己选，而不是我们替他挑一个然后让另一边看起来是错的。 */}
      <select
        className="dc-select"
        value={sizeBasis}
        onChange={(e) => onSizeBasis(e.target.value as SizeBasis)}
        title={basisHint(sizeBasis)}
      >
        {(Object.keys(BASIS_LABELS) as SizeBasis[]).map((b) => (
          <option key={b} value={b}>
            {BASIS_LABELS[b]}
          </option>
        ))}
      </select>
      <select className="dc-select" value={colorMode} onChange={(e) => onColorMode(e.target.value as ColorMode)}>
        {(Object.keys(MODE_LABELS) as ColorMode[]).map((m) => (
          <option key={m} value={m}>
            {MODE_LABELS[m]}
          </option>
        ))}
      </select>
    </div>
  )
}
