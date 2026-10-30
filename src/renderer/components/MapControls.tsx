import { MAX_SCALE, MIN_SCALE } from '../../../core/analyze/treemap-view'
import { useT } from '../i18n'

/**
 * 视图工具条：倍率读数 + 放大/缩小/{t('适应窗口')}/{t('重新布局')}（§13）。
 * 倍率直接读 `View.scale`（真实状态），不是"换算出来的假读数"；
 * 到上下限后按钮置灰与 `clampScale` 同源（MIN_SCALE/MAX_SCALE），UI 和实现不会各说各话。
 */
export function MapControls({
  scale,
  onZoomIn,
  onZoomOut,
  onFit,
  onRelayout
}: {
  scale: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  onRelayout: () => void
}): JSX.Element {
  const t = useT()
  return (
    <span className="dc-mapctl">
      <button className="dc-btn" onClick={onZoomOut} disabled={scale <= MIN_SCALE} title={t('缩小（滚轮向下）')}>－</button>
      <span className="dc-mapctl-scale dc-mono">{Math.round(scale * 100)}%</span>
      <button className="dc-btn" onClick={onZoomIn} disabled={scale >= MAX_SCALE} title={t('放大（滚轮向上）')}>＋</button>
      <button className="dc-btn" onClick={onFit} title={t('恢复 100% 并回到左上角')}>适应窗口</button>
      <button className="dc-btn" onClick={onRelayout} title={t('重新读取本层并重排（Squarified 是确定性的，同一份数据布局不会变）')}>重新布局</button>
    </span>
  )
}
