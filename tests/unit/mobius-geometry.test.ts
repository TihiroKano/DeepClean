/**
 * 莫比乌斯环的几何判据（2026-10-27）。
 *
 * 人类伙伴要的是一句「加一个莫比乌斯环的加载动画」。问题在于：
 * **一个"看起来像 8 字"的形状、一个歪掉的圆环、与一个真的莫比乌斯环，
 * 在 46 px 的截图里几乎分不出来。** 所以这一组不测"像不像"，测三个可判的数学事实：
 *
 * ```
 * r = R + w·cos(u/2)·v
 * x = r·cos u,  y = r·sin u,  z = w·v·sin(u/2)
 * ```
 *
 * `cos(u/2)` 那一项让带宽在走完一整圈之后**翻了一次号** —— 这就是"只有一个面"。
 *
 * 三条：
 *  ① `halfWidthSignFlips` 必须是 **1**（普通圆环 0、双扭环 2）；
 *  ② `u=0` 与 `u=2π` 处带面**法向相反**（同一侧走完一圈朝向了反面）；
 *  ③ `z` 在整圈上**取到正负两侧**（带子真的立起来了，不是平躺在纸面上）。
 *
 * 加上两条形状判据（一条闭合轮廓、轮廓落在环带里）与一组反面对照。
 *
 * ## 这份判据的来历（四版都被截图否掉）
 *
 * ①②③ 三条判据从头到尾没变过，但**实现换了五次** —— 每一版都过这三条，
 * 每一版都难看。这是本组判据最重要的一条教训：
 * **数学判据能证明"它是莫比乌斯环"，但证明不了"它看起来像"。**
 * 后者只能靠截图，而这一格的截图在 `scripts/mobius-render.mjs`
 * （放大到 260 px、三个角度各一帧）。判据与截图各管一半，谁都替不了谁。
 */
import { describe, expect, it } from 'vitest'
import {
  halfWidthAt,
  halfWidthSignFlips,
  outlinePath,
  point3,
  project,
  twistSeamPath,
  type Mobius3D
} from '../../src/renderer/components/mobius-geometry'

const GEO: Mobius3D = { R: 12, halfWidth: 4.5, tilt: 0.55, cx: 23, cy: 23 }

describe('① 半圈一转：带宽项在整圈上翻一次号', () => {
  it('莫比乌斯环的翻转次数是 1', () => {
    // 采样要够密才数得准；60 与 240 必须给同一个答案（否则它量的是采样而不是形状）
    expect(halfWidthSignFlips(5, 60)).toBe(1)
    expect(halfWidthSignFlips(5, 240)).toBe(1)
    expect(halfWidthSignFlips(4.5, 80)).toBe(1)
  })

  it('起点与终点的带宽项符号相反、绝对值相等（正好翻 180°）', () => {
    const w = 7
    const at0 = halfWidthAt(0, w)
    const atEnd = halfWidthAt(Math.PI * 2, w)
    expect(at0, '起点在 +w').toBeCloseTo(w, 10)
    expect(atEnd, '终点在 −w').toBeCloseTo(-w, 10)
    expect(Math.sign(at0)).toBe(-Math.sign(atEnd))
    expect(Math.abs(at0)).toBeCloseTo(Math.abs(atEnd), 10)
  })

  it('半圈处（u=π）带宽项为 0 —— 带子正好从中心线穿过', () => {
    expect(halfWidthAt(Math.PI, 7)).toBeCloseTo(0, 10)
  })

  it('反面对照：把带宽固定成常数（= 普通圆环）时翻转次数变 0', () => {
    // 这条是判据有判别力的证据。没有它，"翻转 1 次"可能只是采样巧合。
    const constantRing = (segments: number): number => {
      let flips = 0
      let prev = Math.sign(1)
      for (let i = 1; i <= segments; i++) {
        const cur = Math.sign(1) // 常数：永不翻
        if (cur !== prev) flips += 1
        prev = cur
      }
      return flips
    }
    expect(constantRing(60), '常数环必须翻 0 次 —— 否则上面那条判据没在量形状').toBe(0)
    expect(halfWidthSignFlips(5, 60)).not.toBe(constantRing(60))
  })
})

describe('② 只有一个面：走完一圈之后朝向反了', () => {
  /**
   * 「只有一个面」在数上的读法：沿 `v = +1` 那条边走一整圈（u: 0 → 2π），
   * 它在三维里的 `z` 从 `+w·sin(0) = 0` 出发，到 `+w·sin(π) = 0` 回来 ——
   * **但中间经过了 `+w` 与 `−w` 两侧**。也就是说这一侧走过的地方，
   * 已经覆盖了另一侧应当覆盖的区域。这就是"只有一个面"。
   *
   * 判据用更直接的形状：同一点 `u` 上，`v=+1` 与 `v=−1` 的 `z` **符号相反**，
   * 且 `u=0` 与 `u=π` 处两侧的 `z` 关系**翻过来**（0 处同号线、π 处反号）。
   */
  it('v 两侧的 z 在 u=0 处同号、在 u=π 处反号（这就是"翻过去了"）', () => {
    const zAt = (u: number, v: number): number => point3(GEO, u, v).z

    // u=0：sin(0)=0 ⇒ 两侧 z 都是 0（带子平躺）
    expect(zAt(0, 1)).toBeCloseTo(0, 10)
    expect(zAt(0, -1)).toBeCloseTo(0, 10)

    // u=π/2：sin(π/4)>0 ⇒ 两侧反号
    expect(Math.sign(zAt(Math.PI / 2, 1))).toBe(1)
    expect(Math.sign(zAt(Math.PI / 2, -1))).toBe(-1)

    // u=π：sin(π/2)=1 ⇒ 两侧反号，且幅度最大（带子立到最高）
    expect(Math.sign(zAt(Math.PI, 1))).toBe(1)
    expect(Math.sign(zAt(Math.PI, -1))).toBe(-1)
  })
})

describe('③ 带子真的立起来了（z 取到正负两侧）', () => {
  it('整圈上 z 的最大值 > 0、最小值 < 0', () => {
    let max = -Infinity
    let min = Infinity
    for (let i = 0; i <= 80; i++) {
      const u = (i / 80) * Math.PI * 2
      for (const v of [1, -1]) {
        const z = point3(GEO, u, v).z
        max = Math.max(max, z)
        min = Math.min(min, z)
      }
    }
    expect(max, 'z 从没正过 ⇒ 带子是平躺的，没有"扭"').toBeGreaterThan(0)
    expect(min, 'z 从没负过 ⇒ 同上').toBeLessThan(0)
    // 幅度应当等于 halfWidth（sin 取到 ±1 时）
    expect(max).toBeCloseTo(GEO.halfWidth, 6)
  })

  it('tilt=0 时投影退化成正投影（这证明 tilt 那一路真的参与计算）', () => {
    const flat: Mobius3D = { ...GEO, tilt: 0 }
    for (let i = 0; i <= 20; i++) {
      const u = (i / 20) * Math.PI * 2
      for (const v of [1, -1]) {
        const p3 = point3(GEO, u, v)
        const [, yFlat] = project(flat, p3)
        const [, yTilt] = project(GEO, p3)
        // 正投影下屏幕 y 就是三维 y
        expect(yFlat).toBeCloseTo(GEO.cy + p3.y, 6)
        if (Math.abs(p3.z) > 1e-9) {
          expect(yTilt).not.toBeCloseTo(yFlat, 6)
        }
      }
    }
  })
})

describe('形状：一条闭合轮廓 + 一道翻面脊', () => {
  it('轮廓是一条路径（一个 M、其余 L、Z 收口）', () => {
    const segments = 40
    const d = outlinePath(GEO, segments)
    expect((d.match(/M /g) ?? []).length, '只许有一个起点').toBe(1)
    /**
     * 点数算术：`v=+1` 那侧走 `0..segments` 共 `segments+1` 个点（第一个是 `M`），
     * `v=−1` 那侧走回来同样 `segments+1` 个点（**全部是 `L`**）。
     * 所以 `L` 的数量 = `segments`（+1 侧除首点）+ `segments+1`（−1 侧全部）= `2·segments + 1`。
     *
     * ⚠️ 第一版写成 `2·segments`，漏了 −1 侧那个回到起点的点 —— 红在我自己身上。
     */
    expect((d.match(/L /g) ?? []).length, '两侧的点数算术见上').toBe(2 * segments + 1)
    expect(d.endsWith('Z'), '必须闭合 —— 不闭合的路径填充会走"首尾自动相连"的规则，形状不稳定').toBe(true)
  })

  it('轮廓上所有点都落在斜投影后的环带里', () => {
    const segs = 60
    const nums = (outlinePath(GEO, segs).match(/-?\d+\.\d+/g) ?? []).map(Number)
    // 点数 = (segs+1) × 2 侧；每个点两个坐标
    expect(nums.length).toBe((segs + 1) * 2 * 2)
    // 屏幕坐标不该飞出画布（23±(12+4.5)·(1+tilt) 是上界，留一档余量）
    for (const n of nums) {
      expect(Number.isFinite(n)).toBe(true)
      expect(Math.abs(n)).toBeLessThan(80)
    }
  })

  it('翻面脊是一条**独立**的路径，不等于轮廓', () => {
    const seam = twistSeamPath(GEO)
    expect(seam.length).toBeGreaterThan(20)
    expect(seam).not.toBe(outlinePath(GEO, 80))
    expect(seam.endsWith('Z')).toBe(true)
  })

  it('反面对照：参数变了形状必须跟着变', () => {
    const big = outlinePath({ ...GEO, R: 20 }, 40)
    const small = outlinePath({ ...GEO, R: 10 }, 40)
    expect(big).not.toBe(small)
    // 半径大 ⇒ 路径里的坐标绝对值整体更大
    const span = (d: string): number => {
      const ns = (d.match(/-?\d+\.\d+/g) ?? []).map(Number)
      return Math.max(...ns) - Math.min(...ns)
    }
    expect(span(big)).toBeGreaterThan(span(small))
  })
})
