/**
 * M4 离线授权卡（挂在设置页）。
 *
 * 拆成两半是刻意的：
 *  - **`LicensePanel` 纯呈现**（状态进、HTML 出）—— 它是 `tests/unit/license-card.test.tsx`
 *    用 `renderToStaticMarkup` 量的那一半，本仓没装 jsdom，所以能被判据覆盖的部分必须长成这样。
 *  - **`LicenseCard` 薄容器** —— 只碰 `window.deepclean` 与 effect，由真机截图那一层负责
 *    （M4 验收 §6 那条纪律：UI 结论必须截图，单测绿不算视觉通过）。
 *
 * ## 这一块的三条立足点
 *
 * 1. **回执不赢，重读赢**。`activateLicense` 的成功回执里带着「激活之后重读一遍」的那份状态，
 *    卡片显示的是**重读结果**。写盘静默失败时界面上说的是「未激活」，不是「激活成功」——
 *    后者是一个看着完全正常的假结论，而它是这块面板唯一会被用户相信的输出。
 * 2. **`invalid` 必须念得出是哪一条**。六个具名原因（`device-mismatch` / `table-unavailable` / …）
 *    压成一句「授权无效」就把运维的锅和用户的手抖混成了一件事。
 * 3. **「这个构建不带授权」与「读不到授权」是两句话**。前者整块不渲染（今天的 Electron 线：
 *    已发行的界面零变化，不画一张永远点不动的卡）；后者必须把错误原话摆出来。
 *    这条界线由 `isAbsentInThisBuild` 守，它只认 `E_NOT_IMPLEMENTED` —— 宽一点就会把
 *    `E_LICENSE_TABLE`（清单没交付）那种真故障顺手藏掉。
 */
import { useEffect, useRef, useState } from 'react'
import type { LicenseActivateResult, LicenseStatusWire } from '../../../shared/types'
import { LicenseBusy } from './LicenseBusy'

/** 卡片上「校验中」那一段的文案。两段对应这条链上真实发生的两件事。 */
export type BusyPhase = 'network' | 'verify'

/**
 * 一次激活在界面上要演多久：**3–7 秒随机**（人类伙伴 2026-10-27 晚：「激活的加载最好时间
 * 不定，3-7 秒随机」）。
 *
 * ## 为什么是随机而不是固定 5 秒
 *
 * 固定时长会在第二次激活时露馅 —— 用户掐一次表就发现"每次都一样"，那反而说明这个时长
 * 与真实工作量无关。随机让它读起来像"这次网络快一点/慢一点"，与一个真在联网校验的
 * 程序无法区分。这不是欺骗：见下面那条"等待不改变结论"。
 *
 * ## 上下界都是硬的
 *
 * 低于 3 s 用户会看到闪一下（人类伙伴第一次的反馈就是"太快了"）；高于 7 s 就变成
 * 等一个明显没在干活的东西。两段按 4:6 分：网络那相在前（真实链上也是它先跑）。
 */
const MIN_TOTAL_MS = 3000
const MAX_TOTAL_MS = 7000

/** 网络相占总时长的比例。0.4 ⇒ 3–7 s 里网络相 1.2–2.8 s、判定相 1.8–4.2 s。 */
const NETWORK_SHARE = 0.4

/** 本次激活两相各要演多久。**每次点击现抽一次**，不是模块级常量。 */
export function rollDurations(rand: () => number = Math.random): { network: number; verify: number } {
  const total = MIN_TOTAL_MS + rand() * (MAX_TOTAL_MS - MIN_TOTAL_MS)
  const network = Math.round(total * NETWORK_SHARE)
  return { network, verify: Math.round(total) - network }
}

/** 这一相那句话说给用户听的样子。 */
function phaseLabel(phase: BusyPhase): string {
  return phase === 'network' ? '正在与服务器通讯中' : '正在校验激活码'
}

/**
 * 让一段异步至少撑满 `ms`。
 *
 * **只兜 UI，不兜结论**：它等的是"这一段动画至少演完"，返回值仍是原 promise 的结果
 * （成功、失败、抛异常都原样传下去）。所以它不会把失败变成成功，也不会伪造任何状态 ——
 * 界面上最终显示什么，仍然只由 `afterActivate` 那份**重读**的状态决定。
 *
 * 用 `Promise.all` 而不是 `then(setTimeout)`：后者在前者 reject 时会漏掉定时器的清理，
 * 而这里两个分支都会走到 `.then`。
 */
function atLeast<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.all([p, new Promise<void>((resolve) => setTimeout(resolve, ms))]).then(([v]) => v)
}

/** 卡片的全部可见状态。`absent` = 这个构建不带授权，整块不渲染。 */
export type LicenseState =
  | { kind: 'loading' }
  | { kind: 'absent' }
  | { kind: 'unreachable'; error: string }
  | {
      kind: 'ready'
      status: LicenseStatusWire
      /** 上一次动作的失败原话（状态本身是好的）。 */
      error: string | null
      busy: boolean
      /** 校验中演到哪一段了。`null` = 不在校验中。 */
      busyPhase: BusyPhase | null
      lastActivation: 'activated' | 'already-active' | null
    }

export interface LicensePanelProps {
  state: LicenseState
  code: string
  onCode(value: string): void
  onActivate(): void
}

/**
 * 「这个构建不带授权」的判据：**只认 `E_NOT_IMPLEMENTED`**。
 *
 * 两侧的实现都把它放在串首（Electron 那边是 `electron/preload/index.ts` 直接 reject 的那句话；
 * Tauri 那边**今天不产生这个串** —— 桥里最后一个 `ni()` 桩已在 M5-E 收尾时删掉，
 * 所以这一侧走到这里的只有"这个构建压根不带授权"那一种），串首匹配就够，不必去猜错误对象长什么样。
 */
export function isAbsentInThisBuild(err: unknown): boolean {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return text.startsWith('E_NOT_IMPLEMENTED')
}

/**
 * 激活回执 → 新的可见状态。**这是「回执不赢，重读赢」落地的唯一一处**。
 *
 * `busy` 一律放回 false（否则点一次就永久转圈）；失败时**保留原来那份状态**，
 * 错误另说 —— 一次失败的激活不改变这台机器上授权的实际样子。
 */
export function afterActivate(state: LicenseState, result: LicenseActivateResult): LicenseState {
  const previous = state.kind === 'ready' ? state.status : null
  const shown = result.status ?? previous
  if (!shown) {
    return { kind: 'unreachable', error: result.error ?? '服务端既没给状态、也没给失败原因' }
  }
  return {
    kind: 'ready',
    status: shown,
    error: result.ok ? null : result.error,
    busy: false,
    busyPhase: null,
    lastActivation: result.ok ? result.activation : null
  }
}

/** 只改「在飞」这一件事；不在 `ready` 上就没有按钮可禁用，原样返回。 */
export function withBusy(state: LicenseState, busy: boolean, phase: BusyPhase | null = null): LicenseState {
  return state.kind === 'ready' ? { ...state, busy, busyPhase: busy ? phase : null } : state
}

/** 那两句结果文案只在**重读到 licensed** 时才许出现（理由见文件头第 1 条）。 */
function activationLine(status: LicenseStatusWire, activation: 'activated' | 'already-active' | null): string | null {
  if (status.state !== 'licensed' || activation === null) return null
  return activation === 'already-active' ? '这台机器上已经激活过这一份授权，这次一字未动' : '激活成功，已绑到这台机器'
}

export function LicensePanel(props: LicensePanelProps): JSX.Element | null {
  const { state, code, onCode, onActivate } = props

  if (state.kind === 'absent') return null

  if (state.kind === 'loading') {
    return (
      <section className="dc-settings-card">
        <h3 className="dc-settings-card-title">授权</h3>
        <p className="dc-muted">正在读这份机器上的授权…</p>
      </section>
    )
  }

  if (state.kind === 'unreachable') {
    return (
      <section className="dc-settings-card">
        <h3 className="dc-settings-card-title">授权</h3>
        <p className="dc-warn">读不到授权状态：{state.error}</p>
      </section>
    )
  }

  const { status, error, busy, busyPhase } = state
  /**
   * 只留两态（人类伙伴 2026-10-27：「只保留展示激活和未激活」）。
   *
   * `invalid` 归到「未激活」那一侧：它读不到一份**有效**授权，说"已激活"是假的。
   * 但**原因不删** —— 那句 `problemReason` 是运维唯一的线索，
   * 而它与"未激活"并不冲突：状态是未激活，原因是具体哪一条。
   * 六种具名原因压成一句「授权无效」正是本文件第 2 条禁止的形状。
   */
  const licensed = status.state === 'licensed'
  const headline = licensed ? '已激活' : '未激活'
  const result = activationLine(status, state.lastActivation)
  const blocked = busy || code.trim() === ''

  return (
    <section className="dc-settings-card dc-license-card">
      <h3 className="dc-settings-card-title">授权</h3>

      {/*
        状态那一行放大：它是这一块唯一的结论，人类伙伴要「设置授权关于的字放大一些」。
        类名 `.dc-license-state` 里的字号/字重写在 global.css（不写内联 —— 主题换档时
        内联值不会跟着变）。
      */}
      <p className={`dc-license-state ${licensed ? 'dc-license-on' : 'dc-license-off'}`}>{headline}</p>

      {/*
        「需联网激活验证」—— 人类伙伴点名要加的那一句。
        **放在状态下方、输入框上方**：它解释的是"点了激活会怎样"，也就是下一步动作的前提。
        删掉的那一大段（激活码格式 / TCP 探测 / DPAPI 两份文件）里，只有这一条留下了 ——
        因为它是用户在按下按钮**之前**唯一必须知道的事实。

        2026-10-27 晚：**只在未激活时出现**。已激活之后没有"点激活"这个动作了，
        那句话就成了一句关于不存在的按钮的说明（人类伙伴：「激活后不再显示激活码和输入框，
        只保留已激活字样」）。判据钉着它必须在 `!licensed` 分支里。
      */}
      {!licensed && <p className="dc-muted dc-fineprint">需联网激活验证。</p>}

      {status.state === 'invalid' && (
        <p className="dc-fineprint dc-warn">
          {status.problemReason ?? '服务端没给出具名原因'}
          {status.problem ? <span className="dc-mono">（{status.problem}）</span> : null}
        </p>
      )}

      {/* 结果与失败两句保留：它们是**这一次动作**的反馈，不是说明文字 */}
      {result !== null && <p className="dc-fineprint dc-muted">{result}</p>}
      {error !== null && <p className="dc-warn">激活失败：{error}</p>}

      {/*
        **已激活就不再画输入框与按钮**（人类伙伴 2026-10-27 晚，附了那张只有「已激活」的图）。

        为什么是"不渲染"而不是 `disabled`：一张永远点不动的输入框会让人以为还能再激活一次，
        而实际上同一个码在本机只会走幂等分支（`AlreadyActive`，一字不写）。
        留着它等于给用户一个假的可操作面。

        这也是这块卡片唯一**可逆**的地方 —— 授权一旦失效（`status` 变成 `invalid`），
        `licensed` 就是 false，输入框自己回来，用户不必重开设置页。
      */}
      {!licensed && (
        <div className="dc-actions">
          <input
            className="dc-input"
            type="text"
            aria-label="激活码"
            placeholder="DC-0123456789ABCDEF0123456789ABCDEF"
            value={code}
            disabled={busy}
            onChange={(e) => onCode(e.target.value)}
          />
          <button className="dc-btn" type="button" disabled={blocked} onClick={onActivate}>
            {busy ? '正在激活…' : '激活'}
          </button>
        </div>
      )}

      {/*
        「校验中」那一相：莫比乌斯环（人类伙伴 2026-10-27：
        「点击激活出现校验中加一个莫比乌斯环的加载动画」）。
        它**替掉**了按钮上那句「正在激活…」的位置感 —— 但按钮上的字仍然保留，
        因为按钮在忙碌时是 disabled 的，用户要知道为什么点不动。

        文案按 `busyPhase` 分两段（2026-10-27 晚，人类伙伴：「加个服务器通讯中」）：
        这条链上真的有两段 —— 先过网络闸，再进本地判定。
      */}
      {busy && <LicenseBusy label={phaseLabel(busyPhase ?? 'network')} />}
    </section>
  )
}

/** 容器：挂载时读一次，激活后再读一次。真机点的那条路走的就是这里。 */
export function LicenseCard(): JSX.Element {
  const [state, setState] = useState<LicenseState>({ kind: 'loading' })
  const [code, setCode] = useState('')
  /**
   * 连点两次激活时，两次 invoke 的返回顺序没有保证 —— 与 `Settings.tsx` 的 `seq`、
   * `usePreview` 同一处先例：晚到的旧回执一律丢掉，否则那一格显示的是上一次那一份。
   */
  const seq = useRef(0)

  useEffect(() => {
    let alive = true
    window.deepclean.getLicenseStatus().then(
      (s) => {
        if (alive) setState({ kind: 'ready', status: s, error: null, busy: false, busyPhase: null, lastActivation: null })
      },
      (e: unknown) => {
        if (!alive) return
        setState(
          isAbsentInThisBuild(e) ? { kind: 'absent' } : { kind: 'unreachable', error: e instanceof Error ? e.message : String(e) }
        )
      }
    )
    return () => {
      alive = false
    }
  }, [])

  const activate = (): void => {
    const trimmed = code.trim()
    if (trimmed === '') return
    const mine = ++seq.current
    /**
     * 两相各自兜一个最短停留（2026-10-27 晚）。
     *
     * **为什么是兜 UI 而不是给后端加 sleep**：后端那条链没有任何需要等的事 ——
     * 探测点第一个通了就返回，码表是本地 65 KB，签名是微秒级。真耗时就是几十毫秒。
     * 往服务端塞 `sleep` 会污染那条链的语义（"激活要 3 秒"变成一句假话，
     * 而 `netprobe` 的探测顺序、`activate` 的写点顺序都不该为一个动画让步）。
     *
     * 兜在这里的代价写在明处：**这两段等待不改变任何结论**。结果仍然只由
     * `afterActivate` 收到的**重读**状态决定 —— `ok:true` + 重读到 `unlicensed`
     * 时，卡片照样说「未激活」。这条由 `license-card.test.tsx` 钉着。
     */
    setState((prev) => withBusy(prev, true, 'network'))
    // 每次点击现抽一次总时长（3–7 s），两相按 4:6 分。见 `rollDurations`。
    const dur = rollDurations()
    const phase2 = new Promise<void>((resolve) => {
      setTimeout(() => {
        // 用户已经点了第二次：这一轮的两相都不许再改状态。
        if (seq.current === mine) setState((prev) => withBusy(prev, true, 'verify'))
        resolve()
      }, dur.network)
    })

    const call = window.deepclean.activateLicense(trimmed)
    // 第一相至少演满；第二相在它之后至少再演满 —— 两段是**串行**的，
    // 因为界面上的两句话本来就是先后发生的两件事。
    void atLeast(call, dur.network).then(
      async (r) => {
        await phase2
        await atLeast(Promise.resolve(), dur.verify)
        if (seq.current === mine) setState((prev) => afterActivate(prev, r))
      },
      async (e: unknown) => {
        await phase2
        // 连「再读一次」都失败（桥里那条 `E_LICENSE_WIRE` / `E_LICENSE_DIR`）：
        // 原来那份状态还在就留着它并把错误念出来；本来就没有状态（比如还卡在 loading）
        // 就明说读不到 —— **绝不兜一份 `unlicensed` 顶上**，那正是本文件第 1 条禁的东西。
        if (seq.current !== mine) return
        const message = e instanceof Error ? e.message : String(e)
        setState((prev) =>
          prev.kind === 'ready'
            ? { ...prev, busy: false, busyPhase: null, error: message, lastActivation: null }
            : { kind: 'unreachable', error: message }
        )
      }
    )
  }

  return <LicensePanel state={state} code={code} onCode={setCode} onActivate={activate} />
}
