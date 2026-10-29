/**
 * 首页那块盘的环形用量表。
 *
 * **为什么是 SVG 不是 canvas**：地图那一层已经是 canvas，而 `glass/tokens.css` 末尾的
 * Treemap 豁免靠"canvas 上方不许压半透明层"活着，`--shot` 有八道闸盯着它的叠放。
 * 首页再开一块 canvas，就等于把那份豁免的假设搬到第二个现场去，而第二个现场没人守。
 * SVG 走普通 DOM，`getComputedStyle` 读得到，判据写得出来。
 *
 * **颜色一律引 token，不在这里写十六进制**：`stopColor="var(--accent)"` 这类写法在
 * Chromium 里会解析，但如果哪天不解析了，弧会**静默变成不可见** —— 那正是 V0.8 在地图上
 * 抓到的那族缺陷（画好了没人看得见，而判据全绿）。所以 `--shot` 里有一道闸直接读
 * 这两个 stop 的 computed `stop-color`，别拿"这块 SVG 在 DOM 里"当它画出来了。
 *
 * 第二轮的形制改动：笔画从 14 收到 9、半径放大、轨道退到几乎看不见、渐变末端换成青。
 * 目的是"细线 + 渐变蓝 + 柔和高光"，而不是第一代那个粗环配大色块的仪表盘读法。
 *
 * **第四轮把笔画放回去了，并且删掉了 `pctColor` 这个 prop。** 两个理由：
 * ① 验收图里那圈环是粗的（约 26 px 对 168 px 直径），细线在它旁边读不出"仪表"；
 * ② 图里环心那个 95.5% 是**白**的。上一轮"严不严重由数字的颜色说"这条设计撤掉之后，
 * 这个组件不再需要外部决定中心字的颜色 —— 少一个 prop 就少一处两端的口径分叉。
 * 代价：不读数字的人扫一眼看不出这块盘有多满，得看那个百分比本身。
 *
 * 第八轮照验收图再加一档：环加粗（22/200）、外发光由 `.dc-donut-arc` 的 drop-shadow 供给 ——
 * 图上那圈环自带一圈柔蓝辉光，是"全屏第二亮的东西"，细环配不出这个体量。
 */
/**
 * 环的几何**按 200 px 那一版的比例算**，所以 `size: 200`（默认）与旧实现逐像素相同：
 * `Math.round(200 * 0.11) = 22`、`Math.round(100 * 0.74) = 74` —— 正是原先写死的那两个数。
 * 只有清理页那种小环才传别的 size，首页一个数都没动。
 */
const RING_STROKE_RATIO = 0.11
const RING_RADIUS_RATIO = 0.74

export function Donut({
  pct,
  sub,
  ariaLabel,
  size = 200,
  label,
  variant
}: {
  pct: number
  sub: string
  ariaLabel: string
  /** 直径。不给 = 200（首页那一版）；给了就按同一套比例缩放笔画与半径。 */
  size?: number
  /** 环心大字。不给 = 百分比（首页那一版）；清理页要把**字节数**放上去，所以它是可覆盖的。 */
  label?: string
  /** `'sm'`：只把环心字号收小一档（两个类名都只影响排版，不影响任何判据）。 */
  variant?: 'sm'
}): JSX.Element {
  const c = size / 2
  const r = Math.round((size / 2) * RING_RADIUS_RATIO)
  const stroke = Math.round(size * RING_STROKE_RATIO)
  const circ = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className={`dc-donut${variant === 'sm' ? ' dc-donut-sm' : ''}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel}>
        <defs>
          {/* 渐变照验收图：环的上半亮（青蓝）、下半沉（主蓝），光从上面来 */}
          <linearGradient id="dc-donut-grad" x1="0.3" y1="0" x2="0.7" y2="1">
            <stop offset="0%" stopColor="var(--accent-3)" />
            <stop offset="100%" stopColor="var(--accent)" />
          </linearGradient>
        </defs>
        <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(180, 214, 255, 0.14)" strokeWidth={stroke} />
        {/* 内沿那道 1 px 的亮线是"柔和高光"：真实玻璃环的内侧会接住一点环境光。
            它故意不跟着 pct 走 —— 它是材质，不是数据。 */}
        <circle cx={c} cy={c} r={r - stroke / 2 - 1.5} fill="none" stroke="rgba(190, 222, 255, 0.1)" strokeWidth={1} />
        <circle
          className="dc-donut-arc"
          cx={c}
          cy={c}
          r={r}
          fill="none"
          stroke="url(#dc-donut-grad)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${((circ * clamped) / 100).toFixed(2)} ${circ.toFixed(2)}`}
          transform={`rotate(-90 ${c} ${c})`}
        />
      </svg>
      <div className="dc-donut-cap">
        <div className="dc-donut-pct">{label ?? `${clamped.toFixed(1)}%`}</div>
        <div className="dc-donut-sub">{sub}</div>
      </div>
    </div>
  )
}
