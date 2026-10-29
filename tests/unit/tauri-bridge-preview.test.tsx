/**
 * Tauri 桥的 `previewCleanup` 那一段转发（M5-B §20 + M5-C §12）。
 *
 * **文件名后缀是 `.tsx` 而不是 `.ts`，这是刻意的**：`tsconfig.node.json` 收了 tests 目录下所有
 * `.ts`，而那一份程序没有 DOM lib —— 一个 `.ts` 的测试引 `src/renderer/tauri-bridge.ts`
 * 会把桥拖进 node 程序，`window` 当场报 TS2304。`.tsx` 归 `tsconfig.web.json`（带 DOM），
 * 与本仓 `clean-history.test.tsx` / `license-card.test.tsx` 同一套路由。**别"顺手"改回 `.ts`。**
 *
 * 为什么这一格值得单独钉：上一版这里的手敲内联形参类型**漏了 `dupExclusions`**
 * （只写了 `selection / confirm / tilePaths / dupGroupIds`）。TS 对方法是双变（bivariant）的，
 * 漏字段编得过、也跑得通 —— 于是用户点的「这份别删」在桥上被**静默丢掉**：界面按摘过算价钱，
 * 服务端按没摘算工作单，**方向是多删**。这是本仓点过名的一类错："看着接上了其实没有"。
 *
 * 处置：形参换成契约本体 `PreviewRequest`（漏字段在编译期就红），并由下面几条钉住
 * "三个键都真在路上"。变异对照：V8 = 丢掉 `dupExclusions`（红 2 条）、
 * V9' = 丢掉 `tilePaths` 转发（红第 3 条）。
 *
 * 环境是 node（本仓不装 jsdom）：桥只在函数体里读 `window`，挂一个假的全局对象就够。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { installTauriBridge } from '../../src/renderer/tauri-bridge'
import type { DeepCleanApi, PreviewRequest } from '../../shared/types'

type Call = { cmd: string; args?: Record<string, unknown> }

const calls: Call[] = []

function api(): DeepCleanApi {
  return (globalThis as unknown as { window: { deepclean: DeepCleanApi } }).window.deepclean
}

/** `noUncheckedIndexedAccess` 之下 `calls[0]` 是 `Call | undefined` —— 不明确判"有没有发命令"，
 *  判据就会在"根本没调用"的情况下拿着 `undefined` 继续比，那是恒真的比较。 */
function firstCall(): Call {
  const c = calls[0]
  if (!c) throw new Error('一个命令都没发')
  return c
}

beforeEach(() => {
  calls.length = 0
  ;(globalThis as unknown as { window: unknown }).window = {
    __TAURI__: {
      core: {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          calls.push({ cmd, args })
          return null
        }
      },
      event: { listen: async () => () => {} }
    }
  }
  installTauriBridge()
})

describe('tauri-bridge previewCleanup', () => {
  it('§12 的 tilePaths 转发给 dc_preview —— 渲染端只报路径，归属由服务端反查', async () => {
    const req: PreviewRequest = {
      selection: { items: [{ ruleId: 'windows-temp' }] },
      tilePaths: ['C:\\f\\a.bin', 'C:\\f\\b.bin']
    }
    await api().previewCleanup('s1', req)

    expect(calls).toHaveLength(1)
    expect(firstCall().cmd).toBe('dc_preview')
    const args = firstCall().args as Record<string, unknown>
    expect(args.scanId).toBe('s1')
    expect(args.selection).toEqual(req.selection)
    expect(args.tilePaths).toEqual(['C:\\f\\a.bin', 'C:\\f\\b.bin'])
  })

  it('没给 tilePaths 时那个键照样在，取空值而不是缺键', async () => {
    await api().previewCleanup('s1', { selection: { items: [] } })
    const args = firstCall().args as Record<string, unknown>
    // 键必须在：服务端才不会把"没给"读成"给了但没给全"（与旧版三键同形状那条纪律同源，
    // 只是重复文件检测下线后这里只剩一条通道）
    expect(args.tilePaths).toEqual([])
    expect(args.confirm).toBeNull()
    expect(args.acknowledgedRisk, '档位键不许缺 —— 缺键会被服务端读成「没给」而不是「给了但没给全」').toBeNull()
  })

  /**
   * M5-P3 之后真机抓出来的那条（`docs/acceptance/2026-10-14-tauri-m5-p3.md` 之后补）：
   * 界面算出了「这次要按 🟠」并把它交给 `requestConfirmation`，但桥只把 `acknowledged` 送出去，
   * **档位从来没上链** ⇒ 壳层按 `unwrap_or(Caution)` 兜底 ⇒ 任何含 🟠 的预估**永远确认不动**，
   * 而屏幕上只有底部那行小字。M5-P1 T5b 那句「🟠 不再永远确认不动」就是红在这一格上。
   */
  it('确认档位必须上链 —— 只送 acknowledged 会让 🟠 永远确认不动', async () => {
    await api().previewCleanup('s1', {
      selection: { items: [{ ruleId: 'orphan-app-data' }] },
      confirm: { acknowledged: true, acknowledgedRisk: 'high' }
    })
    const args = firstCall().args as Record<string, unknown>
    expect(args.confirm).toBe(true)
    expect(args.acknowledgedRisk, '桥把档位丢了：服务端只会按 🟡 兜底，🟠 出不了回执').toBe('high')
  })

  it('只带 selection 的请求不再抛 —— 空勾选是合法输入', async () => {
    await expect(api().previewCleanup('s1', { selection: { items: [] } })).resolves.toEqual(null)
    expect(calls).toHaveLength(1)
  })
})
