/**
 * Tauri 侧的 `window.deepclean` 适配器。
 *
 * **为什么零新依赖**：本项目运行时依赖只有 react / react-dom，这是刻意的（手写图标集那条注释
 * 记着同样的理由）。所以这里不装 `@tauri-apps/api`，而是用 Tauri 注入的全局对象
 * `window.__TAURI__`（`tauri.conf.json` 里 `app.withGlobalTauri: true` 打开）。
 *
 * **将来若有方法还没接上：一律 reject 一个 `E_NOT_IMPLEMENTED: …`，不许回一个空的成功值。**
 * 理由不是洁癖：`previewCleanup` 回 `null` 会让清理页显示「没有可清理的东西」——一个**看起来正常的假结论**。
 * 本项目为这事付过学费（"看着接上了其实没有"）。今天（M5-E 收尾后）**这个文件里没有任何桩**，
 * 所以这句话是给下一个往 `DeepCleanApi` 上加方法的人留的规矩，不是对现状的描述。
 *
 * M2 只实现 9 个（扫描与地图那一条链）；其余的一路接上来，**M5-E 收尾时 `DeepCleanApi` 上
 * 32 个成员全部接完**（数目以 `shared/types.ts` 里那个 interface 为准 —— 这里曾写"20 个"，
 * 那是接口还在长的时候留下的数，它过期了而没人回来改，因为没有任何一道闸量过它）。
 * 注册表 ↔ 桥 的 1:1 由 `src-tauri/src/commands.rs` 的 `registration_tests` 钉着。
 * 接完不等于接对 —— 每条通道的判据与真机验收看
 * `docs/acceptance/2026-10-12-tauri-m5-e.md` 与它前面那几份。
 */

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

// 只引类型（编译期擦除），所以这条不破坏上面那句「零新依赖」：`shared/types` 在仓内。
import type { AppSettings } from '../../shared/settings'
import { sanitizeScanWorkers, sanitizeWallpaper } from '../../shared/settings'
import { sanitizeLocale } from '../../shared/i18n'
import type {
  CleanEvent,
  CleanProgressEvent,
  CleanTask,
  DeepCleanApi,
  DevEnvViewWire,
  CleanRun,
  JournalDirEntry,
  JournalDirSummary,
  LicenseStatusWire,
  PreviewRequest,
  ScanEvent,
} from '../../shared/types'

interface TauriGlobal {
  core: { invoke: InvokeFn }
  event: {
    listen: (name: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>
  }
}

function tauri(): TauriGlobal {
  const t = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
  if (!t) throw new Error('E_NO_TAURI：Tauri 全局对象不存在（是不是跑在浏览器里？）')
  return t
}

const invoke: InvokeFn = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  tauri().core.invoke(cmd, args) as Promise<T>

/**

/**
 * `dc_journal_runs` 的返回校验（2026-10-25 重做后换成这个形状）。
 *
 * 为什么还要这道：旧版的教训在那儿 —— 泛型那条是 **cast**，服务端回裸数组也会过，
 * 到页面里 `run.files` 才是 `undefined`。形状要当场验。
 *
 * 现在要验的只有「是个数组、每个元素有那六个键、类型对」—— 比旧版简单，因为
 * 旧版有十个标量字段 + 一次跨字段对账（`entries.length <= matchedCount`）。
 */
function asJournalRuns(raw: unknown): CleanRun[] {
  if (!Array.isArray(raw)) {
    throw new Error(`E_JOURNAL_WIRE: dc_journal_runs 回的不是数组：${JSON.stringify(raw).slice(0, 120)}`)
  }
  for (const it of raw) {
    const o = it as Record<string, unknown> | null
    if (!o || typeof o !== 'object') throw new Error('E_JOURNAL_WIRE: 列表里有一项不是对象')
    for (const k of ['id', 'endedAtMs', 'freedBytes', 'fileCount'] as const) {
      if (typeof o[k] !== 'string' && typeof o[k] !== 'number') {
        throw new Error(`E_JOURNAL_WIRE: ${k} 类型不对（${typeof o[k]}）`)
      }
    }
    for (const k of ['endedAtMs', 'freedBytes', 'fileCount'] as const) {
      if (typeof o[k] !== 'number') throw new Error(`E_JOURNAL_WIRE: ${k} 不是数字（${typeof o[k]}）`)
    }
    if (!Array.isArray(o.drives)) throw new Error('E_JOURNAL_WIRE: drives 不是数组')
    if (!Array.isArray(o.files)) throw new Error('E_JOURNAL_WIRE: files 不是数组')
  }
  return raw as CleanRun[]
}

/**
 * 【纪律，不是待办】桥里**任何一条通道**的失败都必须回成"异步失败"，不许同步抛。
 *
 * 这一条是拿真机纠出来的：契约写的是 `Promise<T>`，而渲染端的钩子都是防御式的
 * （`usePreview` 有 `.catch`、`useTreeNav` 有 try/catch）。**同步抛会绕过 `.catch`**，
 * 在 effect 里抛出直接把 React 树整棵卸载 —— 地图页因此白屏，而错误信息看起来像
 * "previewCleanup 没实现"，其实是"失败形状和契约不一致"。
 *
 * M5-E 收尾（2026-10-12）：`DeepCleanApi` 上 32 个成员**全部接完**，这里不再有 `ni()` 桩，
 * 所以上面那两个函数被删掉了 —— 留着它们只会诱使下一个接通道的人忘记写真的失败形状。
 * 新接的方法如果可能失败（判据拒、写不进去、会话没了），照 `previewCleanup` / `dc_export_report`
 * 的办法：让 `invoke` 的 rejection 原样出去，别在桥里吞成 `{ok:true}`。
 */


/**
 * `dc_license_status` 的返回校验（M4）。
 *
 * 为什么校验而不是 `as LicenseStatusWire`：`invoke` 的静态类型是 `unknown`，一个 cast 等于把
 * 「服务端到底给了什么」这件事取消资格 —— 给了个 `null`、给了个 `{state:'active'}`（四值的第四种），
 * cast 之后界面照样渲染，而那是**一句看起来正常的假授权结论**。这里不合格就抛，
 * 让界面走「读不到」那一格把原话念出来。
 *
 * 只查形状（五键齐不齐、`state` 在三值之内），**不补默认值**：缺一个键是抛，不是填 `null` ——
 * 兜底散在两处就是两套口径（与 `getSettings` 那条同一纪律）。
 */
function asStatus(raw: unknown): LicenseStatusWire {
  const o = raw as Record<string, unknown> | null
  const keys = ['state', 'activatedAtMs', 'deviceId', 'problem', 'problemReason']
  if (!o || typeof o !== 'object') throw new Error(`E_LICENSE_WIRE: 授权状态不是一个对象：${JSON.stringify(raw)}`)
  const given = Object.keys(o)
  if (given.length !== keys.length || !keys.every((k) => k in o)) {
    throw new Error(`E_LICENSE_WIRE: 授权状态的键不对（要 ${keys.join('/')}，给的是 ${given.join('/')}）`)
  }
  if (o.state !== 'licensed' && o.state !== 'unlicensed' && o.state !== 'invalid') {
    throw new Error(`E_LICENSE_WIRE: 授权状态不是那三种之一：${JSON.stringify(o.state)}`)
  }
  return raw as LicenseStatusWire
}

/**
 * `dc_dev_env_view` 的返回校验。理由与 `asStatus` 同一条，只是风险换了形状：
 * `DevEnv.tsx` 直接 `view.groups.map(...)`，服务端给成 `null` 或给成半个对象时，
 * 一个 `as DevEnvViewWire` 会让整棵 React 树在渲染期抛掉（白屏），而那一页本来只是**少一格数据**。
 * 不合格就抛，让页面的 `.catch` 念「读不到探测结论」。
 *
 * 只查顶层三键，**不补默认值**：行与分组里那些 `null`（「没量过」）与 `undefined`（「这个生态不问」）
 * 的分别是这一页的判据本体，在这里兜底等于把它们抹平。
 */
function asDevEnvView(raw: unknown): DevEnvViewWire {
  const o = raw as Record<string, unknown> | null
  if (!o || typeof o !== 'object') throw new Error(`E_DEVENV_WIRE: 开发环境视图不是一个对象：${JSON.stringify(raw)}`)
  if (!Array.isArray(o.groups)) throw new Error('E_DEVENV_WIRE: 视图里没有 groups 数组')
  if (typeof o.declaredRuleCount !== 'number') throw new Error('E_DEVENV_WIRE: declaredRuleCount 不是数字')
  if (typeof o.scannedRoot !== 'string' && o.scannedRoot !== null) {
    throw new Error(`E_DEVENV_WIRE: scannedRoot 既不是字符串也不是 null：${JSON.stringify(o.scannedRoot)}`)
  }
  return raw as DevEnvViewWire
}

/**
 * `dc_settings_get` / `dc_settings_set` 的返回校验。
 *
 * 只查形状（是对象、`dupMinSizeMb` 是个数字），**不补默认值** —— 缺键是抛，不是填 4：
 * 兜底散在两处就是两套口径（与 `getLicenseStatus` 那条同一纪律）。
 *
 * 为什么**不**用 `sanitizeSettings`：那一份会把坏值夹成合法值，而这里要的是"坏值就报错"。
 * 两者的分工是：桥负责说"服务端给了一个我不能理解的东西"，`sanitizeSettings` 负责
 * 说"这个值在合法区间里该是多少"。混成一件事之后，「服务端坏了」与「值被夹住了」
 * 在界面上长得一样。
 *
 * 2026-10-24：`autoCleanEnabled` 那一格随字段一起删了（它已经没有任何读者）。
 * 老服务端若还回它，这里**不管** —— 不认识的键不进结构，也就不会有人拿它去决定
 * 「画不画一键清理按钮」。
 */
function asSettings(raw: unknown): AppSettings {
  const o = raw as Record<string, unknown> | null
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    throw new Error(`E_SETTINGS_WIRE: 设置不是一个对象：${JSON.stringify(raw)}`)
  }
  if (typeof o.dupMinSizeMb !== 'number' || !Number.isFinite(o.dupMinSizeMb)) {
    throw new Error(`E_SETTINGS_WIRE: dupMinSizeMb 不是一个有限数：${JSON.stringify(o.dupMinSizeMb)}`)
  }
  // 2026-10-27：外观四格也必须验。少验一格的表现是那一格滑块拿到 `undefined`
  // → `input[type=range].value = "undefined"` → 滑轨跳到最左且**没有任何提示**，
  // 用户读到的是"我的模糊半径丢了"，而错在服务端少回一个键。
  //
  // 写成一个小 helper 而不是循环：`o[key]` 的类型是 `unknown`，
  // 循环里的字符串字面量联合不对索引签名收窄，写成循环会在返回处报四条 TS2322。
  // helper 的返回类型是 `number`，收窄就发生在它里面 —— 那是这一格唯一该发生的地方。
  const finite = (key: string): number => {
    const v = o[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`E_SETTINGS_WIRE: ${key} 不是一个有限数：${JSON.stringify(v)}`)
    }
    return v
  }
  const glassBlurPx = finite('glassBlurPx')
  const glassSaturate = finite('glassSaturate')
  const glassBrightness = finite('glassBrightness')
  const glassOpacity = finite('glassOpacity')
  if (typeof o.wallpaper !== 'string' || o.wallpaper === '') {
    throw new Error(`E_SETTINGS_WIRE: wallpaper 不是一个非空串：${JSON.stringify(o.wallpaper)}`)
  }
  // 壁纸引用过一遍**渲染端**的消毒：认不出就回默认（那张内置图），
  // 而不是把一个来路不明的串塞进 `url()`。
  //
  // 2026-10-29 两格新增，两条都**不抛**：
  //  - `scanWorkers` 缺了 → 0（用推荐值）。这一格是"调优"，老服务端不回它时
  //    用推荐值正是最安全的那一档；为它抛错会让整个设置页读不出来（连带语言、壁纸全丢）；
  //  - `locale` 缺了 → 默认语言。同理。
  // 这**不等于**放宽了上面那几条校验：`dupMinSizeMb` 与外观四格仍然是因为
  // "拿到 undefined 会画出假控件"才必须抛，而这两格的缺省值是有效且安全的行为。
  const scanWorkers = typeof o.scanWorkers === 'number' && Number.isFinite(o.scanWorkers) ? o.scanWorkers : 0
  return {
    dupMinSizeMb: o.dupMinSizeMb,
    glassBlurPx,
    glassSaturate,
    glassBrightness,
    glassOpacity,
    wallpaper: sanitizeWallpaper(o.wallpaper),
    scanWorkers: sanitizeScanWorkers(scanWorkers),
    locale: sanitizeLocale(o.locale)
  }
}

export function installTauriBridge(): void {
  // **`as DeepCleanApi` 之前这里是一个没有标注的对象字面量**，而 `window.deepclean` 那边写的是
  // `as unknown` —— 于是"方法名对、能 invoke 成功、跑起来才发现形状不对"没人拦。
  // M3-C 的 `dc_clean_journal` 就是这么漏过去的：契约要 `JournalPage`，我给的是裸数组。
  // 标注挂上之后这类错在编译期就红，不必等真机点一次。
  const api: DeepCleanApi = {
    listDrives: () => invoke('dc_drives'),

    startScan: async (input: { root: string }) => {
      const scanId = await invoke('dc_start', { root: input.root })
      // 前端要的是 `{ scanId }`；Rust 命令回的是裸 id 串 —— 形状在这里对齐，
      // 不让两端各记一种（回错形状只会在用的时候炸，而且是在很远的地方炸）。
      return { scanId: String(scanId) }
    },

    cancelScan: async (scanId: string) => ({ ok: Boolean(await invoke('dc_cancel', { scanId })) }),
    pauseScan: async (scanId: string) => ({ ok: Boolean(await invoke('dc_pause', { scanId })) }),
    resumeScan: async (scanId: string) => ({ ok: Boolean(await invoke('dc_resume', { scanId })) }),

    getSnapshot: (scanId: string) => invoke('dc_snapshot', { scanId }),
    getChildren: (scanId: string, dirId: number, sizeBasis?: string) =>
      invoke('dc_children', { scanId, dirId, sizeBasis }),
    getDirStats: (scanId: string, dirId: number) => invoke('dc_dir_stats', { scanId, dirId }),
    getSkipped: (scanId: string) => invoke('dc_skipped', { scanId }),

    onScanEvent: (cb: (e: ScanEvent) => void) => {
      let unlisten: (() => void) | null = null
      let dead = false
      void tauri()
        .event.listen('dc://scan', (e) => cb(e.payload as ScanEvent))
        .then((u) => {
          // 订阅还没落地就卸载了：立刻退订，否则切页面会漏 listener
          if (dead) u()
          else unlisten = u
        })
      return () => {
        dead = true
        if (unlisten) unlisten()
      }
    },

    // ── v0.1 扫描报告导出 ──
    exportScanReport: async (scanId: string) =>
      // 这一条**不返回内容、只返回落到哪儿了**，界面那句「已导出：<路径>」照抄回来。
      // 但与 Electron 那侧不同：位置不是用户在原生保存框里选的 —— 本机的保存框弹不出来
      // （探针事实与代价都登记在 `commands.rs::dc_export_report` 与验收文档 §⑤ 的"偏离"一节），
      // 落点由服务端定。因此也没有"取消"这一支：`{ok:false, error:'E_NO_SCAN：…'}` 是**失败**，
      // 界面那句 `导出未完成：<原话>`（`Home.tsx:264`，与成功那句同一个 muted 小字样式，不是红字 ——
      // 分辨靠那句话本身的措辞）。别在这里补一个"大概是取消了"，那是第二个口径。
      invoke<{ ok: boolean; path?: string; error?: string }>('dc_export_report', { scanId }),
    // ── §7 视图排除：只改"这一层看不看"，不改任何数字 ──
    // 回的是 `{ ok }`，`false` = 这一条**没被接受**（扫描根 / id 不在树上 / 会话没了）。
    // 不许在这里补一个"大概成功了吧"：`SpaceMap` 靠这一格决定要不要重画，
    // 而它那句横幅「没有生效」的全部价值就是把静默失败说出口。
    setExcluded: async (scanId: string, dirId: number, excluded: boolean) => ({
      ok: await invoke<boolean>('dc_set_excluded', { scanId, dirId, excluded })
    }),
    clearExclusions: async (scanId: string) => ({
      ok: await invoke<boolean>('dc_clear_exclusions', { scanId })
    }),
    getDevEnvView: async (scanId: string | null) =>
      // §3.6 的只读视图：渲染端只报「哪一趟扫描」（`null` = 一趟都没有）。字节那一列、
      // 地盘底账、模型计数全部由服务端从**既有**预估与扫描计数里取（`service.rs` 的
      // `assemble_dev_env_view`），这里一个数字都不算 —— 在桥里另算一遍就是第二个口径。
      asDevEnvView(await invoke<unknown>('dc_dev_env_view', { scanId })),
    previewCleanup: async (scanId: string, req: PreviewRequest) => {
      // §12 的 `tilePaths`（地图上「加入清理列表」点进来的具体文件）转给服务端。
      // 渲染端**只报路径**：归属（"这个文件算哪条规则的地盘"）由服务端拿引擎自己那张
      // 防双计表反查，查不到的原样退回 `unclaimedTilePaths` 点名 —— 猜一条规则当归属，
      // 或在壳层另写一套路径匹配，都是开第二个口径。
      //
      // 形参类型写契约本体 `PreviewRequest` 而不是手敲一遍内联字面量：TS 对方法是双变的，
      // 手敲那份漏一个键照样编得过、跑得通，而用户点的那一下被**静默丢掉**。
      return invoke('dc_preview', {
        scanId,
        selection: req?.selection,
        confirm: req?.confirm?.acknowledged ?? null,
        // M5-P1 T4 的按档确认吃这一个键：漏了它，壳层 `service.rs` 会按 `unwrap_or(Caution)` 兜底，
        // 于是任何含 🟠 的预估在界面上**永远确认不动**（真机 2026-10-14 抓出来的，
        // 而屏幕上只有底部那行小字）。缺键与"给了 null"在服务端是两种状态，所以这里恒给一个键。
        acknowledgedRisk: req?.confirm?.acknowledgedRisk ?? null,
        tilePaths: req?.tilePaths ?? []
      })
    },
    executeCleanup: async (req) => {
      // 只送指纹。路径清单由主进程在确认那一刻从已扫好的树里另取 ——
      // 渲染端报上来的清单一律不作数（§17/§18 那条链的立足点就在这）。
      try {
        const task = await invoke<CleanTask>('dc_execute', { confirmationDigest: req.confirmationDigest })
        return { ok: true as const, error: null, task }
      } catch (e) {
        return { ok: false as const, error: String(e), task: null }
      }
    },
    runAutoClean: async (scanId, selection, tilePaths) => {
      // 一键清理（2026-10-24 改口径）：**只清勾选的内容**。
      //
      // 送的仍然只是「勾了哪几条规则」+「从地图加进来的那几条路径」，**不是路径清单** ——
      // 具体删哪些文件由服务端从上一轮报告里按规则认领表取（`executable_batches`）。
      // 渲染端能报的只有"选了什么"，报不了"删哪些"，这条边界与手动档完全一致。
      try {
        const task = await invoke<CleanTask>('dc_auto_clean', {
          scanId,
          selection,
          tilePaths
        })
        return { ok: true as const, error: null, task }
      } catch (e) {
        return { ok: false as const, error: String(e), task: null }
      }
    },
    getSettings: async () => asSettings(await invoke<unknown>('dc_settings_get')),
    setSettings: async (patch) => asSettings(await invoke<unknown>('dc_settings_set', { patch })),
    /**
     * 选一张图当背景壁纸（2026-10-27）。
     *
     * 回三态，**每一态在界面上的说法都不一样**（服务端那边的注释写着同一条）：
     * - `{ok:true, wallpaper:'file:<名>', name:'<源名>'}` —— 已复制并落盘；
     * - `{ok:true, cancelled:true}` —— 用户按了取消。**不是错误**，界面不该弹任何红字；
     * - `{ok:false, error:'E_WALLPAPER_…'}` —— 真失败。
     *
     * 为什么取消不抛：抛出去会让设置页那条 `.catch` 说「操作失败」，
     * 而那正是"我点了取消"被念成"程序坏了"的形状。
     */
    pickWallpaper: async () => {
      const raw = (await invoke('dc_pick_wallpaper')) as {
        ok?: unknown
        cancelled?: unknown
        wallpaper?: unknown
        name?: unknown
      }
      if (raw?.cancelled === true) return { ok: true as const, cancelled: true as const }
      if (raw?.ok !== true) {
        return { ok: false as const, cancelled: false as const, error: 'E_WALLPAPER：服务端没有说明原因' }
      }
      // 壁纸引用过一遍**渲染端**的消毒：服务端理论上已经清过，但界面要显示的是
      // `sanitizeWallpaper` 认得的那个形状 —— 认不出就回默认（并让界面显示默认那张），
      // 而不是把一个来路不明的串塞进 `url()`。
      return {
        ok: true as const,
        cancelled: false as const,
        wallpaper: sanitizeWallpaper(raw.wallpaper),
        name: typeof raw.name === 'string' ? raw.name : ''
      }
    },

    /**
     * M4：授权状态。`invoke` 的返回是 `unknown`，而这里**不写 `as LicenseStatusWire`** ——
     * 直接 cast 等于把「服务端给了什么」这件事取消资格。`asStatus` 校验的是那五个键在不在、
     * `state` 是不是三值之一；不合格就 **抛**，界面走「读不到」那一格把原话念出来。
     * （Rust 侧的键集由 `the_status_wire_field_set_is_closed` 钉死，这里那道校验是它的对面。）
     */
    getLicenseStatus: async () => asStatus(await invoke('dc_license_status')),
    /**
     * M4：激活。**这条不许把激活回执当结论**：写完之后重读一次状态，界面显示的是重读那一份
     * （所以 `ok:true` + 重读到 `unlicensed` 时，卡片说的是「未激活」而不是「激活成功」）。
     *
     * 重读自己失败 ⇒ 直接抛。造一份 `{state:'unlicensed'}` 带回去就是编一个结论，
     * 而那种形状恰好长得像「还没激活」。
     */
    activateLicense: async (code: string) => {
      let ok = true
      let error: string | null = null
      let activation: 'activated' | 'already-active' | null = null
      try {
        const raw = (await invoke('dc_license_activate', { code })) as { activation?: unknown }
        activation = raw?.activation === 'activated' ? 'activated' : raw?.activation === 'already-active' ? 'already-active' : null
      } catch (e) {
        ok = false
        error = String(e)
      }
      return { ok, error, activation, status: asStatus(await invoke('dc_license_status')) }
    },
    getAppVersion: () => invoke<string>('dc_app_version'),
    // 这台机器的并行能力（2026-10-29）。设置页「删除速率」那格的阈值 = `logicalCores`。
    // 读不到时回一个**保守的** 1，而不是抛：那一格读不到核数不该让整页设置白屏。
    getHardware: async () => {
      try {
        return await invoke<{ logicalCores: number }>('dc_hardware')
      } catch {
        return { logicalCores: 1 }
      }
    },
    cancelCleanup: async (taskId: string) => ({ ok: Boolean(await invoke('dc_cancel_cleanup', { taskId })) }),
    getCleanupTask: (taskId: string) => invoke('dc_clean_task', { taskId }),
    listCleanupTasks: () => invoke('dc_list_clean_tasks'),
    // 清理日志（2026-10-25 重做）：一次清理一条 + 详情懒加载两层
    journalRuns: async () => asJournalRuns(await invoke('dc_journal_runs')),
    journalDirTree: (runId: string) => invoke<JournalDirSummary[]>('dc_journal_dir_tree', { runId }),
    journalDirChildren: (runId: string, dir: string) =>
      invoke<JournalDirEntry[]>('dc_journal_dir_children', { runId, dir }),
    onCleanEvent: (cb: (e: CleanEvent) => void) => {
      let unlisten: (() => void) | null = null
      let dead = false
      void tauri()
        .event.listen('dc://clean', (e) => cb(e.payload as CleanEvent))
        .then((u) => {
          if (dead) u()
          else unlisten = u
        })
      return () => {
        dead = true
        if (unlisten) unlisten()
      }
    },
    /**
     * 清理的**逐条**进度（2026-10-24 新增）。清理弹窗里那串滚动的文件路径就是它。
     *
     * 与 `onCleanEvent` 分工：那条发**整份任务快照**、只在收尾时发一次（`kind:'done'`）；
     * 这条发"刚刚落下的那一条 + 几个计数"，按 40 ms / 64 条节流。
     * 弹窗同时订两条：进度用这条滚，收尾结果用那条。
     */
    onCleanProgress: (cb: (e: CleanProgressEvent) => void) => {
      let unlisten: (() => void) | null = null
      let dead = false
      void tauri()
        .event.listen('dc://clean-progress', (e) => cb(e.payload as CleanProgressEvent))
        .then((u) => {
          if (dead) u()
          else unlisten = u
        })
      return () => {
        dead = true
        if (unlisten) unlisten()
      }
    },
    // ── §28 白名单那两条：判据在服务端，桥这里**一条都不判** ──
    // 渲染端报来的任意字符串不能直接交给 `explorer` / `ShellExecuteW`，否则这两条就成了
    // 「让渲染进程以用户权限启动任意路径」。`dc_reveal_path` / `dc_open_item` 各自先问一遍
    // 「这是不是某一轮已扫会话真见过的东西」，不是就 `E_UNTRUSTED_PATH` 且什么都不做。
    // 消费点（`FileTable` / `SpaceMap` 的右键）今天全是 `void invoke(...)`，没有 `.catch` ——
    // 所以这里必须回 rejected promise 而不是同步抛（同文件头那条纪律），否则一次拒绝
    // 会把整棵 React 树带走，症状是"右键点了没反应，然后页面白屏"。
    revealInExplorer: async (absPath: string) => {
      await invoke('dc_reveal_path', { absPath })
    },
    openItem: async (absPath: string) => {
      await invoke('dc_open_item', { absPath })
    }
  }

  // 断言式安装：漏一个方法就是运行时才炸，而这里当场说得清是谁漏了
  ;(window as unknown as { deepclean: unknown }).deepclean = api
}
