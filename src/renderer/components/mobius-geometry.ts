/**
 * 莫比乌斯环的几何 —— **纯函数，抽出来是为了能被判据钉住**。
 *
 * ## 为什么最后是"一条闭合轮廓 + 渐变"，而不是几百个分片
 *
 * 前四版都被真机截图否掉了，每次都换个失败形状，记在这里免得下一个人重走：
 *
 * | 版 | 做法 | 截图读出来 |
 * | --- | --- | --- |
 * | ① | `(R + \|w·cos(u/2)\|)·(cos u, sin u)` 两条描边 | 「两个偏心的套环」，转起来像偏心轮 |
 * | ② | 去掉绝对值让两条边在 u=π 相交 | 「一个被切成八份的环」—— 没有面，"带子"只能靠脑补 |
 * | ③ | 三维 + 画家算法 + 48 片填充 | 有面了，但**每片的 opacity 不同** ⇒ 48 条抗锯齿缝 ⇒ 一圈放射状条纹 |
 * | ④ | 片间重叠 + 平滑明暗 | 条纹变成深浅交替的扇贝 —— 重叠把"缝"换成"亮度台阶"，一样难看 |
 *
 * **根因（③④ 同一件事）**：把一个本该连续的明暗场切成了有限片，
 * 每片一个 `opacity`，片边界必然可见。片越细，边界越多。
 *
 * ## 所以这一版：**一条路径 + 一个渐变**
 *
 * 1. 计算整条带子的**外轮廓**（一条闭合路径：沿 u 走一圈描外侧边，再走回来描内侧边）；
 * 2. 用 `linearGradient` 表达"立起来的那半圈更亮"——渐变是连续的，**结构上没有缝**；
 * 3. 交叉处（`u = π`，带子翻面）用第二条细路径补一道暗线，读出来是"它拧了一下"。
 *
 * 判据仍然钉那三个数学事实（见 `tests/unit/mobius-geometry.test.ts`）：
 *  ① 带宽项 `cos(u/2)` 在整圈上**翻一次号**；
 *  ② `u=0` 与 `u=2π` 处带面法向**相反**（"只有一个面"）；
 *  ③ `z` 在整圈上**取到正负两侧**（带子真的立起来，不是平躺）。
 */

export interface Mobius3D {
  /** 中径 */
  R: number
  /** 半带宽 */
  halfWidth: number
  /** 斜投影系数：z 每单位折算成多少屏幕 y。0 就是正投影（等于丢掉"扭"）。 */
  tilt: number
  /** 圆心 */
  cx: number
  cy: number
}

/** 三维上的一点。`z` 就是"带子立起来多少"。 */
export interface P3 {
  x: number
  y: number
  z: number
}

/** 带宽项：`w·cos(u/2)`。**这是整个莫比乌斯环的唯一秘密**，所以它被单独命名。 */
export function halfWidthAt(u: number, halfWidth: number): number {
  return halfWidth * Math.cos(u / 2)
}

/**
 * 带面上一点的三维坐标。`v` 是**带宽比例**（−1…1，不是像素），`u` 弧度沿圈。
 *
 * ```
 * r = R + w·cos(u/2)·v
 * x = r·cos u,  y = r·sin u,  z = w·v·sin(u/2)
 * ```
 *
 * `z` 那一项是关键：它正是"带子绕过半圈时立起来"。
 */
export function point3(m: Pick<Mobius3D, 'R' | 'halfWidth'>, u: number, v: number): P3 {
  const { R, halfWidth } = m
  const r = R + halfWidth * Math.cos(u / 2) * v
  return {
    x: r * Math.cos(u),
    y: r * Math.sin(u),
    z: halfWidth * v * Math.sin(u / 2)
  }
}

/**
 * 斜投影到屏幕：`(x, y, z) → (cx + x, cy + y + z·tilt)`。
 *
 * `tilt = 0.55` 是试出来的：太小（< 0.35）带子看起来仍然平；
 * 太大（> 0.8）整圈被压成一条竖着的椭圆。0.55 在 46 px 上"看得出它立着"且不破形。
 */
export function project(m: Mobius3D, p: P3): [number, number] {
  return [m.cx + p.x, m.cy + p.y + p.z * m.tilt]
}

/**
 * 整条带子的**外轮廓**：一条闭合路径。
 *
 * 走法：`v = +1` 沿 u 从 0 到 2π 描一侧，然后 `v = −1` 沿 u 从 2π 回到 0 描另一侧，闭合。
 * 这样得到的是一条**单一路径** —— 它没有内部边界，所以不可能出现"片与片之间的缝"。
 */
export function outlinePath(m: Mobius3D, segments: number): string {
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= segments; i++) {
    const u = (i / segments) * Math.PI * 2
    pts.push(project(m, point3(m, u, 1)))
  }
  for (let i = segments; i >= 0; i--) {
    const u = (i / segments) * Math.PI * 2
    pts.push(project(m, point3(m, u, -1)))
  }
  // `pts` 在两条分支里都至少有一个点（循环至少跑一次），但 TS 不知道 —— 显式收口
  if (pts.length === 0) return ""
  const [first, ...rest] = pts as [[number, number], ...Array<[number, number]>]
  const head = `M ${first[0].toFixed(2)} ${first[1].toFixed(2)}`
  const tail = rest.map(([x, y]) => `L ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
  return `${head} ${tail} Z`
}

/**
 * 带子侧面那条"翻面脊"：`u = π` 附近把两侧连起来的一道线。
 *
 * 为什么需要它：单一路径填充之后整条带子是一个色块，`u ≈ π` 处的**扭**看不出来。
 * 这道线是那个扭的唯一视觉锚点 —— 没有它，读起来是一个歪掉的实心环。
 *
 * 从 `u = π − span` 到 `u = π + span`，横跨整条带宽。
 */
export function twistSeamPath(m: Mobius3D, span = 0.35, steps = 8): string {
  const pts: Array<[number, number]> = []
  const from = Math.PI - span
  const to = Math.PI + span
  for (let i = 0; i <= steps; i++) {
    const u = from + ((to - from) * i) / steps
    pts.push(project(m, point3(m, u, -1)))
  }
  for (let i = steps; i >= 0; i--) {
    const u = from + ((to - from) * i) / steps
    pts.push(project(m, point3(m, u, 1)))
  }
  // `pts` 在两条分支里都至少有一个点（循环至少跑一次），但 TS 不知道 —— 显式收口
  if (pts.length === 0) return ""
  const [first, ...rest] = pts as [[number, number], ...Array<[number, number]>]
  const head = `M ${first[0].toFixed(2)} ${first[1].toFixed(2)}`
  const tail = rest.map(([x, y]) => `L ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ')
  return `${head} ${tail} Z`
}

/**
 * 带宽项在整圈上的**符号翻转次数** —— 莫比乌斯环应当是 **1**。
 *
 * 这条判据比"路径非空"有力得多：一个普通的圆环（`cos(u)` 换成常数）翻转 0 次，
 * 一个双扭环（`cos(u)`）翻转 2 次，而莫比乌斯环正好 1 次。
 */
export function halfWidthSignFlips(halfWidth: number, segments: number): number {
  let flips = 0
  let prev = Math.sign(halfWidthAt(0, halfWidth))
  for (let i = 1; i <= segments; i++) {
    const u = (i / segments) * Math.PI * 2
    const cur = Math.sign(halfWidthAt(u, halfWidth))
    // 0 跳过（带子在 u=π 处正好穿过中心线，那一处不算翻转）
    if (cur !== 0 && prev !== 0 && cur !== prev) flips += 1
    if (cur !== 0) prev = cur
  }
  return flips
}
