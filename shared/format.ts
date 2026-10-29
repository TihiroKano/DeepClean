const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  let v = n
  let i = 0
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(digits)} ${UNITS[i]}`
}

export function formatCount(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0'
}

const p2 = (n: number): string => String(n).padStart(2, '0')

export function formatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const d = new Date(ms)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/**
 * 本地日历日 `YYYY-MM-DD`（无效输入回空串，让"拿它去比"自然失配）。
 *
 * 为什么要有独立的一个函数、而不是各处自己 `slice(0,10)`：「清理记录」页的**日期筛选条件**（服务端
 * `core/clean/journal-view.ts` 用它）与**那一列显示的日子**（渲染端用它）必须是同一个定义 ——
 * 否则会出现"界面上这行写着 10-28，按 10-28 筛却筛不出来"，而那种不一致只在跨时区/跨午夜的机器上才现。
 */
export function formatDay(ms: number): string {
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/**
 * 耗时显示。当前有「亚秒」这一档，**它不是 0s 的补丁，而是同级的一档**。
 *
 * 为什么必须补这一档：`Math.round(ms/1000)` 把 0–499 ms 全压成 `0s`，
 * 而这一档在本产品里是**常态而不是边角** —— M6 验收实测十万级夹具
 * `elapsedMs=938` / `677`，都是真扫完一趟、只差半秒不到一秒。
 * 界面于是对一个刚跑完的扫描显示「用时 0s」，用户读到的是"根本没扫"。
 *
 * 取舍（**没有四舍五入到秒**，那是错的）：把 938 ms 显示成 `1s` 是**编的** ——
 * 那一秒里的 62 ms 没有发生。宁可显示 `0.94s` 这个真数。
 * 反过来 >1000 ms 也不改成 `1.2s`：`0.94s` 到 `45s` 之间跨度是两个数量级，
 * 小数位固定会让 `<1s` 看起来像 `<0.001s` 一样精确，所以**只在亚秒档给两位小数**。
 *
 * 因此这一档的形状是「真秒以下的毫秒数，两位小数」，进 `1s` 之后回到整秒。
 * 反向半边钉在测试里：`0` 与负值仍回 `0s`（`0.00s` 会像是漏了什么）。
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) {
    // 两位小数，末位的 0 去掉：`0.94s` / `0.5s` / `0.10s` → `0.1s`。
    // 不这样做会得到 `0.90s` 这种看起来比真数更准的形状。
    const s = (ms / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
    return `${s}s`
  }
  const s = Math.round(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${p2(m)}m`
  return m > 0 ? `${m}m ${p2(sec)}s` : `${sec}s`
}
