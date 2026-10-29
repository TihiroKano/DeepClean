/**
 * 「扫描范围」那三格（选盘 / `drive`↔`custom` / 那行路径）必须住在 `useScan`，不许住回 Home。
 *
 * 缺陷长这样：扫完应用会自己跳到空间地图，用户点回首页时 Home **重新挂载**，
 * 局部 `useState` 回到初值 ⇒ 同一屏下方写着「扫描 89,801 个文件」（来自快照，跨视图活着），
 * 右边却写着「本地磁盘 Windows」（局部 state，已经死了）。两处各自成立、合起来互相矛盾，
 * 用户会以为刚才扫的是 C 盘。证据见 `docs/acceptance/2026-10-15-m6-packaging-gate.md` §4.1
 * 那两张图（`m6-gate-2-typed.png` 选中的是「指定位置」，`m6-gate-3-done.png` 变回「本地磁盘」）。
 *
 * 为什么是两半而不是一个行为用例：本仓**没有 React 挂载测试设施**（渲染端一律测抽出来的纯判定，
 * 见 `cleanup-default-selection.test.tsx` 文件头那段理由），所以：
 *  ① 口径本身用纯函数 `resolveScanTarget` 钉（这部分是行为断言，强）；
 *  ② "状态不许住回 Home" 用读源码的结构闸钉（与 `commands.rs` 的注册面判据、
 *     `analysis-engine.test.ts:374` 的 import 闸同一先例）。**这半比行为断言弱** ——
 *     它挡的是"字面量搬回去"，挡不住"在别的组件里另起一份 state"。
 *     要升级成真行为用例，得先给仓里装一套 mount 设施，那是另一批的事。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveScanTarget } from '../../src/renderer/hooks/useScan'

describe('resolveScanTarget —— 下一次扫什么的唯一口径', () => {
  it('指定位置那一档吃掉首尾空白；纯空白等于没填（首页那颗按钮就靠它保持灰）', () => {
    expect(resolveScanTarget('custom', '  D:\\deepclean-fixture\\f100k  ', 'C:\\')).toBe(
      'D:\\deepclean-fixture\\f100k'
    )
    expect(resolveScanTarget('custom', '    ', 'C:\\')).toBe('')
  })

  it('整盘那一档忽略输入框里的残留文字，送的是选中的盘根', () => {
    // 用户填过路径又切回「本地磁盘」时，输入框里的字**还在**（这是跨视图保留的代价）。
    // 口径必须按档位选，不能"哪个非空送哪个" —— 后者会扫一个界面上没显示的目标。
    expect(resolveScanTarget('drive', 'D:\\随便填的', 'C:\\')).toBe('C:\\')
  })
})

describe('状态归属 —— 那三格不许住回 Home', () => {
  const home = readFileSync('src/renderer/pages/Home.tsx', 'utf8')
  const hook = readFileSync('src/renderer/hooks/useScan.ts', 'utf8')

  it('Home 不再自己声明 scope / 路径 / 选盘', () => {
    expect(home, 'Home 又自己拿 useState 存扫描范围了 ⇒ 切视图回来会与实际扫的树矛盾').not.toContain(
      "useState<'drive' | 'custom'>('drive')"
    )
    expect(home, '选盘那格同理，它必须与 scope 同一层活着').not.toContain("useState('C:\\\\')")
    expect(home).not.toContain('const [custom, setCustom] = useState')
  })

  it('声明处只有 useScan 一处，且三格与算好的 startTarget 一起交出去', () => {
    expect(hook).toContain("useState<ScanScope>('drive')")
    // Home 从 props 里的 scan 解构，而不是自己算
    expect(home).toMatch(/const \{[^}]*customPath: custom[^}]*startTarget[^}]*\} = scan/)
  })

  it('startTarget 在 Home 里只被消费、不再被就地推导', () => {
    // 页面里再写一遍 `scope === 'custom' ? ... : root` 就是第二份口径 —— 它会与 hook 那份漂移
    expect(home).not.toMatch(/scope === 'custom' \?/)
    expect(home).toContain('scan.start(startTarget)')
  })
})
