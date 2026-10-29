/**
 * `core/facts/appfacts.ts` —— 「这台机器上到底装着什么」的**判据基准**（计划 §2.3，M5-P2 P2-T2）。
 *
 * 这一份与 Rust 的 `src-tauri/crates/appfacts` **同判据、同表形状**（计划 §Global Constraints
 * 那句「两份实现逐字段同」在这一层就落在这一张表上）。两侧的分工不是随意的：
 *
 * - **Rust 侧**是产品：它摸真机（注册表只读枚举、进程快照、`read_dir`），它的结论后面接的是删除；
 * - **这一侧**是对账基准：`collectAppFacts` 是**纯函数**，吃**注入的数据**
 *   （根清单 + 目录索引 + 注册表快照 + 进程快照 + 环境变量表），一次 IO 都不做。
 *   ⚠️ 这一侧**没有**注册表通路，也不许加：TS 读注册表只能靠起进程或引原生模块，
 *   两条都违反计划 §Global Constraints（不 spawn / 只读），而且会把「基准」变成第二个实现者。
 *
 * 判据本体（规格 §4.2 / 计划 §1.1）：
 *
 * ```text
 *   Absent := 有安装痕迹 ∧ 无本体
 *     痕迹（任一命中）   C2 厂商顶层键 ∨ C6 开始菜单 .lnk（∨ 未来的服务 / 计划任务）
 *     无本体（四条全证完）C1 卸载表 ∧ C3 MSIX 包 ∧ C4 安装根 ∧ C5 进程
 *   任一路取不到证据（没采集 / 权限拒 / 枚举中断 / 根没配上）→ Unknown + why
 * ```
 *
 * 三个方向性纪律，与 Rust 侧逐字同口径：
 * 1. `Unknown` 是**默认**，缺键也算 `Unknown`（[`factFor`]），不算「可以删」；
 * 2. C3（`Packages`）与 InstallLocation 反推的额外根是**单向**证据：见到就 `Present`，见不到不推定；
 * 3. **匹配口径按通道分两侧**（P2-T2 裁定，计划 §5）：本体通道（C1/C3/C4/C5）放宽到
 *    [`nameMatchesLoose`]，痕迹通道（C2/C6）留在字面 [`nameMatches`]。
 *    放宽痕迹 = 多发 `Absent` 的入场券 = 多删；放宽本体 = 多算 `Present` = 少删。
 *
 * §4.4 的反馈环也在这一侧实现（[`rootsWithFeedback`]）：卸载表的 `InstallLocation` 追加成 C4 的
 * 额外安装根。少这一步，装在别的盘上的应用会被判成残留 —— 那是多删方向，不是少删。
 * 额外根在不在，三个结局与 Rust 那句 `read_dir` 一一对应（目录 = 本体在 / 根本没有 = 看过且空的 /
 * 是一条文件 = **没取到证据**，见 [`installRootsScan`]）。而「这一路一个根都没配上」在两侧都走
 * [`probeChannel`] 的 `rootsConfigured === 0` 那一档 ⇒ 弃权，**绝不折成**「那个位置不存在 = 看过」：
 * 折过去就是替没看过的地方作证「这里没有本体」，多删的那一半。
 *
 * 对账：`tests/unit/appfacts.test.ts` 拿 Rust 侧同一份夹具
 * （`src-tauri/crates/appfacts/tests/data/reference-shapes.json`）跑这一份，
 * 逐格比夹具的 `expect`，再逐格比 Rust 的投影 `reference-shapes.rust-table.json`。
 */

export const MIN_MATCHABLE_KEY_CHARS = 3

/** 通道名（与 Rust 的 `CH_*` 一一对应；串本身也逐字相同，好让 `why` 两侧点同一一路。 */
export const CH_UNINSTALL = 'C1 卸载表三根（HKLM 64/32 + HKCU）'
export const CH_VENDOR_KEYS = 'C2 SOFTWARE 顶层厂商键'
export const CH_PACKAGES = 'C3 %LOCALAPPDATA%\\Packages 包目录'
export const CH_INSTALL_ROOTS = 'C4 安装根一级目录'
export const CH_PROCESSES = 'C5 进程镜像路径'
export const CH_START_MENU = 'C6 开始菜单 .lnk 文件名'

export const BODY_CHANNELS = [CH_UNINSTALL, CH_PACKAGES, CH_INSTALL_ROOTS, CH_PROCESSES] as const
export const TRACE_CHANNELS = [CH_VENDOR_KEYS, CH_START_MENU] as const

// ---------------------------------------------------------------- 三态与表

export type AppFact =
  | { readonly state: 'present' }
  | { readonly state: 'absent' }
  | { readonly state: 'unknown'; readonly why: string }

/** 注入给判定层的那张表。key = **候选目录 basename 的小写**（[`factKey`]）。 */
export type AppFactsTable = Readonly<Record<string, AppFact>>

export const PRESENT: AppFact = { state: 'present' }
export const ABSENT: AppFact = { state: 'absent' }

/** 构造一个弃权。**空 `why` 是缺陷**（与 Rust 的 `AppFact::unknown` 同一条纪律）。 */
export function unknown(why: string): AppFact {
  const trimmed = why.trim()
  if (trimmed === '') {
    return {
      state: 'unknown',
      why: '弃权理由缺失：探针没有记录是哪一路取不到证据 —— 按最保守档处理，不提议',
    }
  }
  return { state: 'unknown', why: trimmed }
}

export function whyOf(fact: AppFact): string | null {
  return fact.state === 'unknown' ? fact.why : null
}

export function isAbsent(fact: AppFact | undefined): boolean {
  return fact !== undefined && fact.state === 'absent'
}

/** 归一化候选目录名成表 key（绝对路径也接：取最后一段）。与 Rust 的 `fact_key` 同法。 */
export function factKey(candidate: string): string {
  const parts = candidate.replace(/\//g, '\\').split('\\').filter((s) => s !== '')
  return (parts[parts.length - 1] ?? '').toLowerCase()
}

/** 查表。**缺键 = `Unknown`**（带 why），不是「没有这条事实所以可以删」。 */
export function factFor(table: AppFactsTable, candidate: string): AppFact {
  const key = factKey(candidate)
  const hit = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
  if (hit !== undefined) return hit
  return unknown(
    `机器事实表里没有「${key}」这个键（取候选目录 basename 小写）—— 采集时没把这个目录交给探针，` +
      '而缺键不等于「已卸载」：两半一条都没证过',
  )
}

// ---------------------------------------------------------------- 单条通道

export type Probe =
  | { readonly probe: 'checked-no-hit' }
  | { readonly probe: 'hit'; readonly detail: string }
  | { readonly probe: 'unavailable'; readonly why: string }

export interface ChannelScan {
  entries: string[]
  failures: string[]
  emptyNotes: string[]
  /** 盲区：通道跑成功了，但有条目定位不出安装根（只对名字对得上的候选生效）。 */
  gaps: string[]
  rootsConfigured: number
  rootsVerified: number
  familyAware: boolean
  /** 本体通道 true / 痕迹通道 false —— 见模块文档那条裁定。 */
  looseMatch: boolean
}

export function emptyScan(over: Partial<ChannelScan> = {}): ChannelScan {
  return {
    entries: [],
    failures: [],
    emptyNotes: [],
    gaps: [],
    rootsConfigured: 0,
    rootsVerified: 0,
    familyAware: false,
    looseMatch: false,
    ...over,
  }
}

/** 通道对候选的结论。顺序是判据：命中 > 取不到 > 盲区 > 一个根都没配 > 证完了没有。 */
export function probeChannel(scan: ChannelScan, key: string): Probe {
  const hit = hitOf(scan, key)
  if (hit !== null) return { probe: 'hit', detail: hit }
  if (scan.failures.length > 0) {
    return {
      probe: 'unavailable',
      why:
        `${scan.rootsConfigured} 个根里 ${scan.failures.length}/${scan.rootsConfigured} 没取到证据：` +
        scan.failures.join('；'),
    }
  }
  const blind = scan.gaps.filter((g) => scanMatches(scan, key, g))
  if (blind.length > 0) {
    return {
      probe: 'unavailable',
      why:
        `通道整体跑成功了，但${blind.length}/${scan.gaps.length} 条条目定位不出安装根` +
        '（InstallLocation 是空的、还是相对路径、还是环境变量展不开）：' +
        `${blind.join('；')} —— 对本候选而言「没看见本体」可能是「根本没看到那个位置」，按弃权处理`,
    }
  }
  if (scan.rootsConfigured === 0) {
    return {
      probe: 'unavailable',
      why: '这条通道一个根都没配上 —— 覆盖面是空的，「没看见」推不出「没有」',
    }
  }
  return { probe: 'checked-no-hit' }
}

export function scanMatches(scan: ChannelScan, key: string, token: string): boolean {
  if (!scan.looseMatch) return nameMatches(key, token)
  // 本体侧的**角色词**闸（与 Rust `ChannelScan::matches` 同法）：条目整个就是个
  // 「update / temp / installer」这类角色词时，只有与候选名整串相等才算本体证据。
  // 方向是收窄本体（少 Present ⇒ 多弃权），换的是「`Program Files\update` 替任何具体应用
  // 作证」这条真机误判 —— 审计确认已卸载的 5 条 `*-updater`（1,063.9 MiB）全死在它上面。
  if (isGenericRoleName(token) && !sameIdentity(key, token)) return false
  return nameMatchesLoose(key, token)
}

export function hitOf(scan: ChannelScan, key: string): string | null {
  for (const e of scan.entries) {
    if (scanMatches(scan, key, e)) {
      return scan.familyAware ? `条目「${e}」（包族名「${packageFamily(e)}」）` : `条目「${e}」`
    }
    if (scan.familyAware && scanMatches(scan, key, packageFamily(e))) {
      return `包族名「${packageFamily(e)}」（原条目「${e}」）`
    }
  }
  return null
}

// ---------------------------------------------------------------- 匹配口径

/** 计划 §1.3 的字面口径：**双向包含**，两侧先小写归一。两侧都够 `MIN_MATCHABLE_KEY_CHARS` 才比。 */
export function nameMatches(key: string, token: string): boolean {
  const t = token.toLowerCase()
  const k = key.toLowerCase()
  // 条目侧的长度闸（与 Rust 同法）：卷根一级目录里那个名叫 `D` 的目录，双向包含之下
  // 替每一个含 `d` 的候选证成了在场。两侧同尺，不许各写一把。
  if ([...k].length < MIN_MATCHABLE_KEY_CHARS || [...t].length < MIN_MATCHABLE_KEY_CHARS) return false
  return t.includes(k) || k.includes(t)
}

/**
 * 本体通道那一侧的口径：字面双向包含 **或** 去掉分隔符（空格 / `-` / `_` / `.`）之后再比一次。
 * 与 Rust 的 `name_matches_loose` 同法。**痕迹通道不许用它**（模块文档第 3 条）。
 */
export function nameMatchesLoose(key: string, token: string): boolean {
  if (nameMatches(key, token)) return true
  const k = stripSeparators(key.toLowerCase())
  const t = stripSeparators(token.toLowerCase())
  // 归一之后再过一次同一把尺：`D B` 去掉分隔符就成了 `db`。
  if ([...k].length < MIN_MATCHABLE_KEY_CHARS || [...t].length < MIN_MATCHABLE_KEY_CHARS) return false
  return t.includes(k) || k.includes(t)
}

/**
 * **角色词**：描述「这个目录是干什么的」而不是「这是谁」。与 Rust `GENERIC_ROLE_NAMES`
 * **逐条相同**（对账闸 `tests/unit/appfacts-*.test.ts` 两侧同形比对）。
 *
 * ⚠️ 不许收进能证明「某个厂商/系统在场」的名字（`microsoft` / `windows` / `packages` …）：
 * 一旦进来，`%LOCALAPPDATA%\Microsoft` 就拿不到本体证据，而它有厂商键当痕迹 ⇒ 被判残留。
 */
export const GENERIC_ROLE_NAMES: readonly string[] = [
  'update', 'updates', 'upgrade', 'install', 'installer', 'installers', 'setup', 'uninstall',
  'temp', 'tmp', 'cache', 'caches', 'log', 'logs', 'data', 'common', 'files', 'backup',
  'backups', 'current', 'runtime', 'runtimes', 'tools', 'core',
]

/** 整条条目名就是个角色词（多词的 `Common Files` 不算 —— 只掐单名的吞并）。 */
export function isGenericRoleName(token: string): boolean {
  const t = token.toLowerCase()
  return GENERIC_ROLE_NAMES.includes(t)
}

/** 大小写与分隔符归一后**整串相等**：留给真叫 `update` 的应用。 */
export function sameIdentity(key: string, token: string): boolean {
  const k = stripSeparators(key.toLowerCase())
  const t = stripSeparators(token.toLowerCase())
  return k !== '' && k === t
}

function stripSeparators(s: string): string {
  return s.replace(/[ \-_.]/g, '')
}

/** MSIX 目录名 `<包族名>_<包哈希>` 的前半段；尾巴不是「定长 13 位 `[a-z0-9]`」就不切。 */
export function packageFamily(entry: string): string {
  const i = entry.lastIndexOf('_')
  if (i < 0) return entry
  const tail = entry.slice(i + 1)
  return /^[a-z0-9]{13}$/.test(tail) ? entry.slice(0, i) : entry
}

// ---------------------------------------------------------------- 证据包与判据

export interface ChannelProbe {
  channel: string
  probe: Probe
}

export interface CandidateEvidence {
  body: ChannelProbe[]
  traces: ChannelProbe[]
}

/**
 * **判据本体**（规格 §4.2 的伪码）。四步的顺序不可调：
 * ① 本体命中 → Present；② 任一路取不到证据 → Unknown 并逐条点名；
 * ③ 一条痕迹都没有 → Unknown；④ 才轮到 Absent。
 */
export function judge(ev: CandidateEvidence): AppFact {
  if (ev.body.some((c) => c.probe.probe === 'hit')) return PRESENT
  const missing = ev.body
    .concat(ev.traces)
    .filter((c) => c.probe.probe === 'unavailable')
    .map((c) => `${c.channel}：${(c.probe as { why: string }).why}`)
  if (missing.length > 0) {
    return unknown(`「有安装痕迹 ∧ 无本体」这两半里有一条取不到证据 → ${missing.join('；')}`)
  }
  const traceHits = ev.traces.filter((c) => c.probe.probe === 'hit')
  if (traceHits.length === 0) {
    return unknown(
      '本体四条通道都取证成功且全部没有命中，但安装痕迹一条都没有（查过的痕迹只有 C2 厂商顶层键与 C6 开始菜单快捷方式这两路，都没命中）——' +
        '「这台机器装过它」证不出来，两半只成立了一半，按弃权处理：无痕迹最可能的解释是探针' +
        '的覆盖面不够，而不是这个目录是残留',
    )
  }
  return ABSENT
}

/** 身份不明（名字太短）的候选：全通道弃权，两半都成立不了。 */
export function evidenceOfAmbiguousKey(why: string): CandidateEvidence {
  const mk = (channels: readonly string[]): ChannelProbe[] =>
    channels.map((channel) => ({ channel, probe: { probe: 'unavailable' as const, why } }))
  return { body: mk(BODY_CHANNELS), traces: mk(TRACE_CHANNELS) }
}

// ---------------------------------------------------------------- 注入面

export type ListingStatus = 'listed' | 'missing' | 'unavailable'

export interface FsRoot {
  channel: 'packages' | 'install' | 'startMenu'
  path: string
  status: ListingStatus
  /** install 通道专用：调用方指名「这就是某个应用的安装位置」。 */
  extra?: boolean
  why?: string
}

export interface FsEntry {
  name: string
  kind: 'dir' | 'file'
}

export interface UninstallEntry {
  key: string
  displayName: string | null
  installLocation: string | null
}

export interface RegistryRoot {
  path: string
  status: ListingStatus
  why?: string
  entries?: UninstallEntry[]
  keys?: string[]
}

export interface RegistrySnapshot {
  uninstall: RegistryRoot[]
  vendors: RegistryRoot[]
}

export interface ProcessRecord {
  exe: string
  image: string | null
}

export interface ProcessSnapshot {
  status: ListingStatus
  why?: string
  records: ProcessRecord[]
}

export interface MachineEvidence {
  /** 三条 FS 通道的根与各自结局（Rust 侧由 `ProbeRoots` + 真 `read_dir` 决定；这里全注入）。 */
  roots: FsRoot[]
  /** 目录索引：`目录路径 → 一级条目`。Rust 侧那棵树在 %TEMP% 下被建出来，这里就是它的全部机器。 */
  contents: Record<string, FsEntry[]>
  registry: RegistrySnapshot
  processes: ProcessSnapshot
  env: Record<string, string>
}

/** **一份「什么都没看成」的注入面**：两条注册表通道与进程通道都没有根 → 整表 `Unknown`。 */
export function nothingCollected(): MachineEvidence {
  return {
    roots: [],
    contents: {},
    registry: { uninstall: [], vendors: [] },
    processes: { status: 'unavailable', why: '进程快照压根没采集（默认值）—— 「没在进程表里看到它」不是「它没在跑」', records: [] },
    env: {},
  }
}

// ---------------------------------------------------------------- 注册表两路 + §4.4

export function uninstallScan(snap: RegistrySnapshot): ChannelScan {
  const cs = emptyScan({ looseMatch: true })
  for (const root of snap.uninstall) {
    cs.rootsConfigured += 1
    if (root.status === 'listed') {
      cs.rootsVerified += 1
      for (const e of root.entries ?? []) {
        cs.entries.push(e.key)
        const d = (e.displayName ?? '').trim()
        if (d !== '') cs.entries.push(d)
      }
      if ((root.entries ?? []).length === 0) {
        cs.emptyNotes.push(`卸载表根「${root.path}」枚举完了，一个条目都没有`)
      }
    } else if (root.status === 'missing') {
      cs.rootsVerified += 1
      cs.emptyNotes.push(`卸载表根「${root.path}」不存在`)
    } else {
      cs.failures.push(`卸载表根「${root.path}」：${root.why ?? '取不到证据'}`)
    }
  }
  cs.entries.sort()
  return cs
}

/** C2：痕迹通道 ⇒ `looseMatch` 留在 false，且证据串**只有键名**（不含路径段）。 */
export function vendorKeyScan(snap: RegistrySnapshot): ChannelScan {
  const cs = emptyScan()
  for (const root of snap.vendors) {
    cs.rootsConfigured += 1
    if (root.status === 'listed') {
      cs.rootsVerified += 1
      for (const k of root.keys ?? []) cs.entries.push(k)
    } else if (root.status === 'missing') {
      cs.rootsVerified += 1
      cs.emptyNotes.push(`厂商键根「${root.path}」不存在`)
    } else {
      cs.failures.push(`厂商键根「${root.path}」：${root.why ?? '取不到证据'}`)
    }
  }
  cs.entries.sort()
  return cs
}

/** 环境变量查表：大小写不敏感（与 Rust 的 `lookup_env` 同口径）。 */
export function lookupEnv(env: Record<string, string>, name: string): string | null {
  const upper = name.toUpperCase()
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper) return env[k] ?? null
  }
  return null
}

/** 一条卸载项的 `InstallLocation` → 可用的绝对路径（展不开给 null）。 */
export function installLocationOf(entry: UninstallEntry, env: Record<string, string>): string | null {
  return expandInstallLocation(entry.installLocation ?? '', env)
}

/** 与 Rust 的 `expand_install_location` 逐步同法：去引号 → 归一分隔符 → 展 `%VAR%` → 判绝对 + basename 长度。 */
export function expandInstallLocation(raw: string, env: Record<string, string>): string | null {
  const s = raw.trim().replace(/^"+|"+$/g, '').trim().replace(/\//g, '\\')
  if (s === '') return null
  const expanded = expandPercentVars(s, env)
  if (expanded === null) return null
  const noTail = expanded.replace(/\\+$/g, '')
  if (!looksAbsolute(noTail)) return null
  const base = basenameOf(noTail)
  if (base === '' || [...base].length < MIN_MATCHABLE_KEY_CHARS || base.endsWith(':')) return null
  return noTail
}

function expandPercentVars(s: string, env: Record<string, string>): string | null {
  let out = ''
  let rest = s
  for (;;) {
    const open = rest.indexOf('%')
    if (open < 0) return out + rest
    out += rest.slice(0, open)
    const after = rest.slice(open + 1)
    const close = after.indexOf('%')
    if (close < 0) return out + '%' + after
    const name = after.slice(0, close)
    if (name === '') {
      out += '%'
    } else {
      const v = lookupEnv(env, name)
      if (v === null) return null
      out += v
    }
    rest = after.slice(close + 1)
  }
}

function looksAbsolute(s: string): boolean {
  if (s.startsWith('\\\\')) return true
  return /^[A-Za-z]:/.test(s)
}

function basenameOf(s: string): string {
  const segs = s.split('\\').filter((x) => x !== '')
  return segs[segs.length - 1] ?? ''
}

/** §4.4 的反馈环：把 `InstallLocation` 展成 C4 的额外根（去重、排序）。 */
export function extraInstallLocations(snap: RegistrySnapshot, env: Record<string, string>): string[] {
  const out: string[] = []
  for (const root of snap.uninstall) {
    if (root.status !== 'listed') continue
    for (const e of root.entries ?? []) {
      const p = installLocationOf(e, env)
      if (p !== null && !out.some((q) => q.toLowerCase() === p.toLowerCase())) out.push(p)
    }
  }
  return out.sort()
}

/** 展不开的那些 ⇒ C4 的盲区 token（取那一串的最后一段；理由见 Rust 侧同名函数）。 */
export function unresolvableInstallLocations(snap: RegistrySnapshot, env: Record<string, string>): string[] {
  const out: string[] = []
  for (const root of snap.uninstall) {
    if (root.status !== 'listed') continue
    for (const e of root.entries ?? []) {
      const raw = (e.installLocation ?? '').trim()
      if (raw === '') continue
      if (installLocationOf(e, env) !== null) continue
      const token = locationBasenameToken(raw)
      if (token !== null && !out.includes(token)) out.push(token)
    }
  }
  return out.sort()
}

function locationBasenameToken(raw: string): string | null {
  const s = raw.trim().replace(/^"+|"+$/g, '').replace(/\//g, '\\')
  const segs = s.split('\\').filter((x) => x !== '')
  const last = segs[segs.length - 1]
  if (last === undefined) return null
  if ([...last].length < MIN_MATCHABLE_KEY_CHARS || last.endsWith(':')) return null
  return last
}

// ---------------------------------------------------------------- 进程一路

/** C5：本体通道 ⇒ `looseMatch` true。跑完但表是空的 ⇒ 折回 `unavailable`（与 Rust 同判据）。 */
export function processScan(snap: ProcessSnapshot): ChannelScan {
  const cs = emptyScan({ looseMatch: true })
  cs.rootsConfigured = 1
  if (snap.status === 'unavailable') {
    cs.failures.push(`进程快照：${snap.why ?? '取不到证据'}`)
    return cs
  }
  if (snap.records.length === 0) {
    cs.failures.push(
      '进程快照跑完了，但表里一个进程都没有 —— 这台机器不可能一个进程都没在跑，' +
        '按「快照没建起来」处理，不按「什么都没装着」处理',
    )
    return cs
  }
  cs.rootsVerified = 1
  let unnamed = 0
  for (const r of snap.records) {
    cs.entries.push(r.exe)
    if (r.image === null || r.image === '') {
      unnamed += 1
    } else {
      const parent = imageParentName(r.image)
      if (parent !== null) cs.entries.push(parent)
    }
  }
  cs.entries.sort()
  if (unnamed > 0) {
    cs.emptyNotes.push(
      `${unnamed}/${snap.records.length} 个进程的完整镜像路径拿不到（保护进程 / 别人的会话）—— ` +
        '名字这一格照样来自枚举本身，所以这一路仍然是「跑完了」',
    )
  }
  return cs
}

/** 镜像路径的上一级目录名（整条路径不进证据，理由见 Rust 侧 `image_parent_name`）。 */
export function imageParentName(image: string): string | null {
  const segs = image.replace(/\//g, '\\').replace(/\\+$/g, '').split('\\').filter((x) => x !== '')
  if (segs.length < 2) return null
  const parent = segs[segs.length - 2] ?? ''
  if ([...parent].length < MIN_MATCHABLE_KEY_CHARS || parent.endsWith(':')) return null
  return parent
}

// ---------------------------------------------------------------- 文件系统三路

/** 目录的一级条目：显式条目 ∪ 所有严格后代 key 的第一段（Rust 那侧是 `create_dir_all` 的自然结果）。 */
function effectiveChildren(contents: Record<string, FsEntry[]>, dir: string): FsEntry[] {
  const index = contentsIndex(contents)
  const canonical = normKey(dir)
  const byName = new Map<string, 'dir' | 'file'>()
  for (const e of index.get(canonical) ?? []) byName.set(e.name, e.kind)
  const prefix = canonical + '\\'
  for (const key of index.keys()) {
    if (!key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length)
    if (rest === '') continue
    const first = rest.split('\\')[0] as string
    if (first === '') continue
    if (!byName.has(first)) byName.set(first, 'dir')
  }
  return [...byName.entries()].map(([name, kind]) => ({ name, kind })).sort((a, b) => (a.name < b.name ? -1 : 1))
}

/** 夹具的 `contents` key 用正斜杠、`InstallLocation` 展完是反斜杠 —— 两侧必须先归一再查这个索引。 */
function contentsIndex(contents: Record<string, FsEntry[]>): Map<string, FsEntry[]> {
  const out = new Map<string, FsEntry[]>()
  for (const k of Object.keys(contents)) out.set(normKey(k), contents[k] ?? [])
  return out
}

/**
 * 注入树里这一条路径是什么：`dir` / `file` / `none`。
 *
 * 这是 Rust 那一次 `read_dir` 的镜像 —— `fs_probe::scan_install_roots` 的三个分支：
 * `Ok` = 目录、`Err(NotFound)` = 那个位置没有、其它 `Err` = **没取到证据**（对一条**文件**
 * 路径做 `read_dir` 报的正是「其它」那一支，不是 `NotFound`；Rust 那侧的 `unavailable`
 * 根在 `tests/common/mod.rs` 里也就是「在那条路径上建一个文件」）。
 *
 * 存在性不止查 `contents` 的 key：`materialize` 在 Rust 那侧把每一个 `kind:"dir"` 的**条目**
 * 都 `create_dir_all` 出来了，所以「某一个 listed key 下的一个 dir 条目」在那棵树里同样是
 * 一个存在的目录。只查 key 会把真实存在的额外根看成不存在 ⇒ 丢一条 Present ⇒
 * **多判 Absent**（删除方向）—— P2-T2 的 TS 半棒查出来的，理由记在计划 §5。
 */
function pathKindInTree(index: Map<string, FsEntry[]>, dir: string): 'dir' | 'file' | 'none' {
  const canonical = normKey(dir)
  if (canonical === '') return 'none'
  if (index.has(canonical)) return 'dir'
  const prefix = canonical + '\\'
  for (const key of index.keys()) {
    if (key.startsWith(prefix)) return 'dir'
  }
  const segs = canonical.split('\\').filter((s) => s !== '')
  const name = segs[segs.length - 1] ?? ''
  const parent = segs.slice(0, -1).join('\\')
  if (name === '' || parent === '') return 'none'
  if (pathKindInTree(index, parent) !== 'dir') return 'none'
  for (const e of index.get(parent) ?? []) {
    if (e.name === name) return e.kind
  }
  return 'none'
}

function normKey(p: string): string {
  return p.replace(/\//g, '\\').replace(/\\{2,}/g, '\\').replace(/\\+$/g, '')
}

/** C3：包目录一级目录名。方向 = Present，且**单向**（计划 §1.2）。 */
export function packagesScan(ev: MachineEvidence): ChannelScan {
  const cs = emptyScan({ familyAware: true, looseMatch: true })
  const roots = ev.roots.filter((r) => r.channel === 'packages')
  cs.rootsConfigured = roots.length
  for (const r of roots) {
    if (r.status === 'listed') {
      cs.rootsVerified += 1
      for (const e of effectiveChildren(ev.contents, r.path)) {
        if (e.kind === 'dir') cs.entries.push(e.name)
      }
    } else if (r.status === 'missing') {
      cs.rootsVerified += 1
      cs.emptyNotes.push(`包目录容器「${r.path}」不存在`)
    } else {
      cs.failures.push(`包目录容器「${r.path}」：${r.why ?? '取不到证据'}`)
    }
  }
  return cs
}

/**
 * **逐字相等、留第一份**的根去重 —— 与 Rust `crates/appfacts/src/lib.rs::ProbeRoots::dedup_roots`
 * 同一行为（`PathBuf` 逐字比较，不做大小写 / 分隔符归一）。P2-T2 登记的分歧 (b) 由 P2-T3 按
 * 主会话裁定收口：**Rust 是对的，TS 缺的是这一步**，不是反过来。
 *
 * 为什么"相等 ⇒ 降级成先插入的那一份"是设计而不是漏：`extra` 的语义是
 * 「调用方**点名**这里装着某个应用 ⇒ 这个位置的存在就是本体证据」（`lib.rs:307-312`）。
 * 标准根的 basename（`Program Files` / `Program Files (x86)`）不是应用名 —— 把它当本体证据会让
 * **每一个**装在 `C:\Program Files\Foo` 的应用都凭空拿到 `Program Files` 这个 token，
 * 反过来也让"标准根本身"被当成某个同名应用的安装位置。所以一条 `InstallLocation` 恰好等于
 * 某个标准根时（MSI 的脏值就这么写），它必须被去重掉、留下的那份 `extra = false`。
 *
 * ⚠️ 方向要写清楚：对齐之后基准在"候选名恰好等于标准根 basename"这种构造形状上
 * **更容易判 absent**（更偏删）。钉住那一格的用例是 `tests/unit/appfacts.test.ts` 里的
 * `a_standard_root_basename_is_not_body_evidence_p2_t3_ruling` —— 不许只对齐代码不钉边界。
 */
function dedupByVerbatimPath<T extends { path: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const it of items) {
    if (seen.has(it.path)) continue
    seen.add(it.path)
    out.push(it)
  }
  return out
}

/** C4：安装根一级目录 + §4.4 额外根（额外根的 basename 自己也算本体证据）。 */
export function installRootsScan(ev: MachineEvidence, extraRoots: string[]): ChannelScan {
  const cs = emptyScan({ looseMatch: true })
  const index = contentsIndex(ev.contents)
  const roots: { path: string; extra: boolean; status: ListingStatus; why?: string }[] = dedupByVerbatimPath(
    [
      ...ev.roots
        .filter((r) => r.channel === 'install')
        .map((r) => ({ path: r.path, extra: r.extra === true, status: r.status, why: r.why })),
      // 额外根**后插**（与 Rust `roots_with_feedback` 的 `push_extra_install_root` 同序），
      // 所以标准根赢：一条与标准根逐字相等的 `InstallLocation` 会被去重成"那份标准根"。
      ...extraRoots.map((p) => ({ path: p, extra: true, status: 'listed' as ListingStatus })),
    ]
  )
  cs.rootsConfigured = roots.length
  for (const r of roots) {
    // §4.4 反推出来的额外根：Rust 那侧要先真的 `read_dir` 得出目录，才把 basename 算作证据。
    // 三个结局与 `fs_probe::scan_install_roots` 一一对应（不存在 = 看过且空的；是文件 = 没取到证据；
    // 是目录 = 本体在）。陈旧的 `InstallLocation` 指在一个不存在的位置上，那是「看过、那里没有」，
    // 不是本体在。
    if (r.extra && r.status === 'listed') {
      const kind = pathKindInTree(index, r.path)
      if (kind === 'none') {
        cs.rootsVerified += 1
        cs.emptyNotes.push(`安装根「${r.path}」不存在`)
        continue
      }
      if (kind === 'file') {
        cs.failures.push(
          `安装根「${r.path}」：那条路径上是一个文件而不是目录 —— read_dir 给不出目录清单，这一路没取到证据`,
        )
        continue
      }
    }
    if (r.status === 'listed') {
      cs.rootsVerified += 1
      if (r.extra) {
        const base = basenameOf(r.path.replace(/\//g, '\\'))
        if (base !== '') cs.entries.push(base)
      }
      for (const e of effectiveChildren(ev.contents, r.path)) {
        if (e.kind === 'dir') cs.entries.push(e.name)
      }
    } else if (r.status === 'missing') {
      cs.rootsVerified += 1
      cs.emptyNotes.push(`安装根「${r.path}」不存在`)
    } else {
      cs.failures.push(`安装根「${r.path}」：${r.why ?? '取不到证据'}`)
    }
  }
  cs.entries.sort()
  return cs
}

/** C6：开始菜单 `.lnk` 文件名（深度 ≤ 2，只看文件名）。方向 = **只当痕迹**。 */
export function startMenuScan(ev: MachineEvidence): ChannelScan {
  const cs = emptyScan()
  // 与 Rust 的 `dedup_roots()` 同法（`start_menu_roots` 那半边也去重，逐字相等、留第一份）
  const roots = dedupByVerbatimPath(ev.roots.filter((r) => r.channel === 'startMenu'))
  cs.rootsConfigured = roots.length
  for (const r of roots) {
    if (r.status === 'missing') {
      cs.rootsVerified += 1
      cs.emptyNotes.push(`开始菜单根「${r.path}」不存在`)
      continue
    }
    if (r.status !== 'listed') {
      cs.failures.push(`开始菜单根「${r.path}」：${r.why ?? '取不到证据'}`)
      continue
    }
    cs.rootsVerified += 1
    for (const e of effectiveChildren(ev.contents, r.path)) {
      const stem = lnkStem(e.name)
      if (e.kind === 'file' && stem !== null) {
        cs.entries.push(stem)
        continue
      }
      if (e.kind === 'dir') {
        for (const sub of effectiveChildren(ev.contents, `${normKey(r.path)}\\${e.name}`)) {
          if (sub.kind !== 'file') continue
          const s2 = lnkStem(sub.name)
          if (s2 !== null) cs.entries.push(s2)
        }
      }
    }
  }
  cs.entries.sort()
  return cs
}

function lnkStem(name: string): string | null {
  const i = name.lastIndexOf('.')
  if (i <= 0) return null
  if (name.slice(i + 1).toLowerCase() !== 'lnk') return null
  const stem = name.slice(0, i)
  return stem === '' ? null : stem
}

// ---------------------------------------------------------------- FactScan 与采集

export type FactScan = Readonly<Record<string, ChannelScan>>

/** 没在表里的通道一律 `unavailable` —— 「这条通道忘了接」与「这条通道跑失败了」在判据眼里同向。 */
export function probeFor(scan: FactScan, channel: string, key: string): Probe {
  const cs = scan[channel]
  if (cs === undefined) {
    return {
      probe: 'unavailable',
      why: `内部缺陷：通道「${channel}」没有取证结果 —— 采集侧没接上，绝不等于「看过了、没有」`,
    }
  }
  return probeChannel(cs, key)
}

export function evidenceFor(scan: FactScan, key: string): CandidateEvidence {
  if ([...key].length < MIN_MATCHABLE_KEY_CHARS) {
    return evidenceOfAmbiguousKey(
      `候选名「${key}」只有 ${[...key].length} 个字符（双向包含的匹配口径要求 ≥ ${MIN_MATCHABLE_KEY_CHARS} 个）—— ` +
        '这么短的名字会被匹配到几乎一切身上，这种身份不明的名字计划 §4.1 定的是一律弃权：' +
        '它既当不了本体证据，也当不了痕迹证据，两半都成立不了',
    )
  }
  return {
    body: BODY_CHANNELS.map((c) => ({ channel: c, probe: probeFor(scan, c, key) })),
    traces: TRACE_CHANNELS.map((c) => ({ channel: c, probe: probeFor(scan, c, key) })),
  }
}

/** **§4.4 的反馈环**：把 C1 的 `InstallLocation` 追加成 C4 的额外根。 */
export function rootsWithFeedback(ev: MachineEvidence): string[] {
  return extraInstallLocations(ev.registry, ev.env)
}

export function scanAll(ev: MachineEvidence): FactScan {
  const extra = rootsWithFeedback(ev)
  const gaps = unresolvableInstallLocations(ev.registry, ev.env)
  const cs4 = installRootsScan(ev, extra)
  cs4.gaps = gaps
  const scan: Record<string, ChannelScan> = {
    [CH_PACKAGES]: packagesScan(ev),
    [CH_INSTALL_ROOTS]: cs4,
    [CH_START_MENU]: startMenuScan(ev),
    [CH_UNINSTALL]: uninstallScan(ev.registry),
    [CH_VENDOR_KEYS]: vendorKeyScan(ev.registry),
    [CH_PROCESSES]: processScan(ev.processes),
  }
  return scan
}

/**
 * **采集入口**：跑六条通道，对每个候选名出表。表里交得出的三档都在（`absent` 自 P2-T2 起可达）。
 *
 * 一次扫描只该调一次（计划 §2.7）；这条纪律住在调用方，这里只保证同一次调用内每条通道只算一遍。
 */
export function collectAppFacts(candidates: readonly string[], ev: MachineEvidence): AppFactsTable {
  const scan = scanAll(ev)
  const out: Record<string, AppFact> = {}
  const keys = candidates.map(factKey).filter((k) => k !== '')
  keys.sort()
  for (const key of keys) out[key] = judge(evidenceFor(scan, key))
  return out
}

/** 表 → 投影（对账用的形状：只有档位，`why` 不进等式判据）。 */
export function projectTable(table: AppFactsTable): Record<string, 'present' | 'absent' | 'unknown'> {
  const out: Record<string, 'present' | 'absent' | 'unknown'> = {}
  for (const k of Object.keys(table).sort()) {
    const f = table[k]
    out[k] = f === undefined ? 'unknown' : f.state
  }
  return out
}
