/**
 * M4 授权卡（设置页那块）的判据。
 *
 * 与 `clean-history.test.tsx` 同一条路子：node 环境 + `renderToStaticMarkup` 渲染**纯呈现层**
 * `LicensePanel`，断言真实 HTML 文本（没装 jsdom，也不引新依赖）。容器 `LicenseCard`（碰
 * `window.__dc` 与 effect）不在这里测 —— 它由真机截图那一层负责。
 *
 * 为什么这块值得单独钉：
 * 1. **「不可信」必须念得出是哪一条**。`invalid` 有六个原因，压成一句「授权无效」就等于让
 *    用户自己猜是拷错了机器还是清单没交付 —— 而后者是运维的锅，界面必须替用户说清。
 * 2. **回执不赢，重读赢**。`activateLicense` 的成功回执里带着「激活后重读一遍」的状态；
 *    界面那格必须显示**重读到的那一份**，而不是显示「激活成功」这句话。写盘静默失败时，
 *    一句「激活成功」就是一个看着正常的假结论。
 * 3. **这个构建不带授权 ⇒ 整块不渲染**（不是渲染一句「未激活」）。已发行的 Electron 界面
 *    今天没有授权这件事，画一张永远点不动的卡就是虚增功能。
 * 4. 反过来，**读状态真失败**（目录建不出来、清单读不动）不许退化成上面那种「没授权」的平静，
 *    也不许被 `E_NOT_IMPLEMENTED` 那条判据顺手藏掉 —— 所以 3 与 4 之间必须有一条明确的界线。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  afterActivate,
  isAbsentInThisBuild,
  LicensePanel
} from '../../src/renderer/components/LicenseCard'
import type { LicenseActivateResult, LicenseStatusWire } from '../../shared/types'

const status = (over: Partial<LicenseStatusWire> = {}): LicenseStatusWire => ({
  state: 'unlicensed',
  activatedAtMs: null,
  deviceId: null,
  problem: null,
  problemReason: null,
  ...over
})

const licensed = status({ state: 'licensed', activatedAtMs: 1_760_000_000_000, deviceId: 'aabbccddeeff001122334455' })
const invalid = status({
  state: 'invalid',
  problem: 'device-mismatch',
  problemReason: '这份授权绑的是别的设备（多半是把授权文件从另一台机器拷过来的）'
})

const panel = (over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    LicensePanel({
      state: { kind: 'ready', status: status(), error: null, busy: false, busyPhase: null, lastActivation: null },
      code: 'DC-TEST-0001',
      onCode: () => undefined,
      onActivate: () => undefined,
      ...over
    })
  )

describe('授权卡：三态各说各的话', () => {
  /**
   * 2026-10-27 改口径（人类伙伴：「授权下方所有文字删掉，只保留展示激活和未激活」）。
   * 原来这条断言的是「已激活」+ 激活日期 + 设备指纹；现在后两者**被显式要求删掉**。
   *
   * 所以判据改成：状态那两个字必须在，而那一行（激活于 / 设备指纹）**必须不在**。
   * 这不是放宽 —— 它从"两件事都念出来"变成"只念这一件，别的不许回来"，
   * 反面那半边比原来更严。
   */
  it('licensed → 只念「已激活」；激活日期与设备指纹那两格已被删掉，不许回来', () => {
    const out = panel({ state: { kind: 'ready', status: licensed, error: null, busy: false, busyPhase: null, lastActivation: null } })
    expect(out, '状态那两个字必须在').toContain('已激活')
    expect(out, '「已激活」后面不再带「（本机）」').not.toContain('已激活（本机）')
    expect(out, '激活日期那格已被删掉').not.toContain('2025-10-09')
    expect(out, '设备指纹那格已被删掉').not.toContain('aabbccddee')
    expect(out, '「激活于」这三个字不许回来').not.toContain('激活于')
    expect(out).not.toContain('未激活')
  })

  it('unlicensed → 给得出输入框与「激活」按钮，且不许提前出现任何成功文案', () => {
    const out = panel()
    expect(out).toContain('未激活')
    expect(out).toContain('<input')
    expect(out).toContain('激活')
    expect(out).not.toContain('激活成功')
    expect(out).not.toMatch(/已激活[^：]/)
  })

  it('invalid → 必须把六条具名原因里的那一条原文念出来，不许压成「授权无效」', () => {
    const out = panel({ state: { kind: 'ready', status: invalid, error: null, busy: false, busyPhase: null, lastActivation: null } })
    expect(out).toContain('这份授权绑的是别的设备')
    expect(out).toContain('device-mismatch')
  })

  it('invalid 但 problemReason 缺失（服务端给了个没名目的 invalid）→ 不许渲染成空白，念 machine 码', () => {
    const bare = status({ state: 'invalid', problem: 'table-unavailable', problemReason: null })
    const out = panel({ state: { kind: 'ready', status: bare, error: null, busy: false, busyPhase: null, lastActivation: null } })
    expect(out).toContain('table-unavailable')
    expect(out.trim()).not.toBe('')
  })
})

describe('授权卡：这个构建不带授权，与读不到是两件事', () => {
  it('absent（E_NOT_IMPLEMENTED）→ 整块不渲染，已发行的 Electron 界面零变化', () => {
    expect(panel({ state: { kind: 'absent' } }).trim()).toBe('')
  })

  it('读状态真失败 → 念错误原文，且不许伪装成「未激活」那种平静', () => {
    const out = panel({ state: { kind: 'unreachable', error: 'E_LICENSE_DIR: 授权目录建不出来（C:\\x）：拒绝访问' } })
    expect(out).toContain('E_LICENSE_DIR')
    expect(out).not.toContain('未激活')
  })

  it('藏与不藏的界线只认 E_NOT_IMPLEMENTED：清单读不动那一条不许被顺手藏掉', () => {
    expect(isAbsentInThisBuild('E_NOT_IMPLEMENTED: 这个构建不带离线授权')).toBe(true)
    expect(isAbsentInThisBuild('E_LICENSE_TABLE: 激活码清单读不动')).toBe(false)
    expect(isAbsentInThisBuild(new Error('E_NOT_IMPLEMENTED: x'))).toBe(true)
    expect(isAbsentInThisBuild(null)).toBe(false)
  })
})

describe('授权卡：回执不赢，重读赢', () => {
  const result = (over: Partial<LicenseActivateResult> = {}): LicenseActivateResult => ({
    ok: true,
    error: null,
    activation: 'activated',
    status: licensed,
    ...over
  })

  it('ok=true 而重读到 unlicensed（写盘静默失败那个形状）→ 界面必须显示未激活', () => {
    const next = afterActivate(
      { kind: 'ready', status: status(), error: null, busy: false, busyPhase: null, lastActivation: null },
      result({ status: status() })
    )
    expect(next).toMatchObject({ kind: 'ready', status: { state: 'unlicensed' } })
    const out = panel({ state: next })
    expect(out).toContain('未激活')
    expect(out).not.toContain('激活成功')
  })

  it('ok=true 且重读到 licensed → 显示已激活，并留住这一次的结果文案', () => {
    const next = afterActivate({ kind: 'ready', status: status(), error: null, busy: false, busyPhase: null, lastActivation: null }, result())
    const out = panel({ state: next })
    expect(out).toContain('已激活')
    expect(out).toContain('激活成功')
  })

  it('already-active 不许念成「激活成功」—— 这台机器上本来就有这一份', () => {
    const next = afterActivate(
      { kind: 'ready', status: licensed, error: null, busy: false, busyPhase: null, lastActivation: null },
      result({ activation: 'already-active' })
    )
    const out = panel({ state: next })
    expect(out).toContain('这台机器上已经激活过')
    expect(out).not.toContain('激活成功')
  })

  it('激活失败 → 保留原来那一份状态，错误单独念，busy 必须放回去', () => {
    const before = { kind: 'ready', status: licensed, error: null, busy: true, busyPhase: null, lastActivation: null } as const
    const next = afterActivate(before, result({ ok: false, error: 'E_LICENSE_INVALID_CODE: 激活码无效', status: null as unknown as LicenseStatusWire }))
    expect(next).toMatchObject({ kind: 'ready', status: { state: 'licensed' }, busy: false })
    const out = panel({ state: next })
    expect(out).toContain('激活码无效')
    expect(out).toContain('已激活')
  })
})

describe('授权卡：点不动的时候要说清为什么点不动', () => {
  it('正在激活 → 按钮 disabled 并念「正在激活…」', () => {
    const out = panel({ state: { kind: 'ready', status: status(), error: null, busy: true, busyPhase: null, lastActivation: null } })
    expect(out).toContain('disabled')
    expect(out).toContain('正在激活')
  })

  it('空码（含只有空格）→ 按钮 disabled：不发一次注定失败的 IPC', () => {
    for (const code of ['', '   ', '\t']) {
      const out = panel({ code })
      expect(out).toMatch(/<button[^>]*disabled/)
    }
  })

  it('取状态还在路上 → 不许先摆一个「未激活」当作结论', () => {
    const out = panel({ state: { kind: 'loading' } })
    expect(out).toContain('正在读这份机器上的授权…')
    expect(out).not.toContain('未激活')
  })
})

describe('在线激活（M4 改版）：网络这一关说的话要准', () => {
  /// 没网与出不去是两条码，界面必须各念各的 —— 与 `netprobe.rs` 那两条判据同一轴，
  /// 只是这一层管的是"到了界面上还是不是一句"。
  it('网络不可用 → 念出网络那条码，且不许拐到「激活码无效」上', () => {
    const next = afterActivate(
      { kind: 'ready', status: status(), error: null, busy: true, busyPhase: null, lastActivation: null },
      { ok: false, error: 'E_LICENSE_NO_NETWORK: 这台设备没有连上任何网络 —— 激活需要先能连上公网', activation: null, status: status() }
    )
    const out = panel({ state: next })
    expect(out).toContain('E_LICENSE_NO_NETWORK')
    expect(out).toContain('激活失败')
    expect(out).not.toContain('激活码无效')
    expect(out).not.toContain('激活成功')
  })

  /**
   * **这条曾经给"离线"那套旧文案上过棺钉**，2026-10-27 又被人类伙伴删掉了它钉的那些句子
   * （「授权下方所有文字删掉」）。现在它钉的是**新那句话**，以及"旧的那几句一个字都不许回来"。
   *
   * ⚠️ 这不是把红改绿：`TCP` / `不发送任何数据` / `激活码不上传` 这三句在**这一页**上是被
   * 显式要求删掉的。它们仍然是真的（服务端 `netprobe.rs` 那条链还在跑），只是不再摆在
   * 授权卡上。真正的口径判据搬到了服务端那几条（`netprobe` 的单测），
   * 而"用户在这一页看到什么"由下面这条钉。
   */
  it('只说「需联网激活验证」，旧的实现解释一句都不许回来', () => {
    const out = panel()
    // 正面：那一句必须在
    expect(out).toContain('需联网激活验证')
    // 反面：被删掉的那四句一个字都不许回来（否则等于"删了又长出来"）
    expect(out, '「整个判定是离线」不许回来').not.toContain('整个判定是离线')
    expect(out, 'TCP 探测那段已被删掉').not.toContain('TCP')
    expect(out, '「不发送任何数据」已被删掉').not.toContain('不发送任何数据')
    expect(out, '「激活码不上传」已被删掉').not.toContain('激活码不上传')
  })

  /**
   * **这条钉的是输入框的示例码与随应用交付的那份清单是不是同一个形制。**
   *
   * 起因：占位符一度写作 `DC-XXXX-XXXX-XXXX`（14 个字符），而生成脚本产出的真码是
   * `DC-` + 32 位大写十六进制（35 个字符）。用户照着界面上那串样子去理解自己的码，就会
   * 在第一步把码打错 —— 而这条链上「码打错」的回执是一句 `激活码无效`，看起来像"你的码
   * 过期了/被人用了"，运维根本查不到是占位符把人带偏的。
   *
   * 2026-10-27：那句解释（「32 位十六进制」「整段粘贴」）随「授权下方所有文字删掉」一起走了，
   * 但**占位符本身还在** —— 它是这条判据里真正防事故的那一半，所以留着它、删掉那两条断言。
   */
  it('输入框的示例码必须是真码的形制（DC- + 32 位十六进制 = 35 个字符）', () => {
    const out = panel()
    const placeholder = /placeholder="([^"]*)"/.exec(out)?.[1] ?? ''
    expect(placeholder, '占位符不见了或形状不对 —— 用户会照着它理解自己的码').toMatch(/^DC-[0-9A-F]{32}$/)
    expect(placeholder).toHaveLength(35)
    // 反向半边：那句解释已被删除（它属于"授权下方所有文字"那一批）
    expect(out).not.toContain('32 位十六进制')
    expect(out).not.toContain('整段粘贴')
  })
})
