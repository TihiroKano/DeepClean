/**
 * classify —— 路径 → 类型分组（§13 Treemap 配色）+ 分组 → 清理风险（§16）
 *
 * 纯函数：禁止 import 任何 `node:*` / `electron` / DOM API
 * （本文件同时被 tsconfig.node 与 tsconfig.web 编译并在渲染端 import）。
 *
 * 本 MVP 只读：这里产出的 Risk **只用于配色和把右键菜单项置灰**，
 * 文件里没有任何 fs 调用，不可能触发删除（§28 原则一）。
 *
 * 匹配一律走「分段边界」：路径切段后整段相等，不做子串正则 ——
 * 子串匹配会把 `C:\Temples\x` 误判成 temp。规则**顺序即优先级**：
 * 系统关键目录 → 临时 → 开发环境 → 缓存 → 应用 → Windows → 模型 → 用户目录 → 扩展名。
 */

export type NodeGroup =
  | 'system'
  | 'app'
  | 'user'
  | 'cache'
  | 'temp'
  | 'archive'
  | 'video'
  | 'image'
  | 'audio'
  | 'dev'
  | 'model'
  | 'document'
  | 'other'

export type Risk = 'safe' | 'caution' | 'high' | 'forbidden'

/** 切成小写段：`c:/users/Kano/AppData` → ['c:','users','kano','appdata']（`\\?\` 前缀不特殊处理，多余的 '?' 段不会命中任何规则）。 */
function segments(path: string): string[] {
  return path.toLowerCase().replace(/\//g, '\\').split('\\').filter((s) => s.length > 0)
}

const has = (segs: string[], names: readonly string[]): boolean => names.some((n) => segs.includes(n))

/** a 段之后（任意深度）出现 b 段之一：用于 `pip\Cache`、`windows\Installer` 这类父子限定。 */
function hasAfter(segs: string[], a: string, bs: readonly string[]): boolean {
  const i = segs.indexOf(a)
  return i >= 0 && segs.slice(i + 1).some((s) => bs.includes(s))
}

const SYSTEM_CRITICAL = [
  'system32', 'syswow64', 'winsxs', 'servicing', 'boot', 'ehdebug',
  'system volume information', '$recycle.bin', 'perflogs'
] as const

const TEMP_DIRS = ['temp', 'tmp', 'temp~1', 'tmp~1'] as const

/** §21 的开发环境目录（AI 模型另说，见 MODEL_DIRS）。 */
const DEV_DIRS = [
  'node_modules', '.npm', '.pnpm-store', '.yarn', '.nuget', '.gradle', '.m2', '.cache',
  '.venv', 'venv', 'site-packages', '.rustup', '.cargo', '.dotnet', '.conda', '.virtualenvs',
  '.pub-cache', '.cocoapods'
] as const

/** 包管理器缓存：父段之后出现 cache/caches 段才算 dev（`AppData\Local\pip\Cache`）。 */
const DEV_PKG_CACHE_PARENTS = ['pip'] as const
const CACHE_LEAVES = ['cache', 'caches', 'localcache'] as const

/** 名字里含 cache 但整体是一个专用缓存目录，需整段匹配（不是子串）。
 *  注意：`AppData\LocalLow` 故意**不**列在这里 —— 它含浏览器插件/游戏的真实存档，
 *  不是缓存，判成 cache 会被 §16 标成 🟢 安全，属于危险误判。 */
const NAMED_CACHES = [
  'd3dscache', 'gpucache', 'shadercache', 'iconcache', 'cachedfiles', 'inetcache', 'fontcache'
] as const

const APP_DIRS = ['program files', 'program files (x86)', 'programfiles', 'programdata', 'windowsapps'] as const

/** §21：模型权重目录/扩展名。必须归 model → Risk 'high'，永不被自动清理。 */
const MODEL_DIRS = [
  'models', 'model_zoo', 'checkpoints', 'loras', 'huggingface', 'modelscope', 'stable-diffusion'
] as const

const WINDOWS_DIRS = ['windows', 'winnt'] as const

const EXT_GROUP: Record<string, NodeGroup> = {
  '.zip': 'archive', '.7z': 'archive', '.rar': 'archive', '.tar': 'archive', '.gz': 'archive',
  '.iso': 'archive', '.vhd': 'archive', '.vhdx': 'archive', '.wim': 'archive', '.cab': 'archive',
  '.mp4': 'video', '.mkv': 'video', '.avi': 'video', '.mov': 'video', '.flv': 'video', '.webm': 'video', '.ts': 'video',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.bmp': 'image', '.webp': 'image', '.psd': 'image', '.heic': 'image',
  '.mp3': 'audio', '.flac': 'audio', '.wav': 'audio', '.m4a': 'audio', '.aac': 'audio', '.ogg': 'audio',
  '.docx': 'document', '.doc': 'document', '.xlsx': 'document', '.xls': 'document', '.pptx': 'document',
  '.pdf': 'document', '.md': 'document', '.txt': 'document', '.csv': 'document',
  '.safetensors': 'model', '.gguf': 'model', '.ckpt': 'model', '.pt': 'model', '.onnx': 'model',
  '.bin': 'model', '.pkl': 'model', '.npy': 'model', '.joblib': 'model'
}

/** 只看叶子名的扩展名；目录（无点号）返回 null。 */
export function extGroup(name: string): NodeGroup | null {
  const i = name.lastIndexOf('.')
  if (i <= 0) return null
  return EXT_GROUP[name.slice(i).toLowerCase()] ?? null
}

/**
 * 顺序敏感：先系统/临时/开发，再缓存/应用，最后才看扩展名。
 * 两条最要紧的次序（都有单测锁着）：
 *  - temp/dev 在 cache 之前：`AppData\Local\Temp`、`.gradle\caches`、`pip\Cache` 不能被泛缓存规则抢走；
 *  - cache 在 users 之前：Chrome 的 `User Data\Default\Cache` 同样在 `Users` 下，必须先判成 cache。
 */
export function classifyPath(path: string): NodeGroup {
  const segs = segments(path)
  if (segs.length === 0) return 'other'
  const leaf = segs[segs.length - 1] ?? ''
  const isWin = has(segs, WINDOWS_DIRS)

  if (has(segs, SYSTEM_CRITICAL) || (isWin && segs.includes('installer'))) return 'system'
  if (has(segs, TEMP_DIRS)) return 'temp'
  if (has(segs, DEV_DIRS) || DEV_PKG_CACHE_PARENTS.some((p) => hasAfter(segs, p, CACHE_LEAVES))) return 'dev'
  if (has(segs, CACHE_LEAVES) || has(segs, NAMED_CACHES)) return 'cache'
  if (has(segs, APP_DIRS) || hasAfter(segs, 'appdata', ['packages'])) return 'app'
  if (isWin) return 'system'
  if (has(segs, MODEL_DIRS) || extGroup(leaf) === 'model') return 'model'
  if (segs.includes('users')) return extGroup(leaf) ?? 'user'
  return extGroup(leaf) ?? 'other'
}

/* ------------------------------------------------------------------ *
 * 文件属性（§4.1「扫描内容含属性 / 隐藏文件 / 系统文件」+ §28 原则二）
 * ------------------------------------------------------------------ */

/** Win32 FILE_ATTRIBUTE_* 的位值（与 `GetFileAttributes` / `WIN32_FIND_DATA.dwFileAttributes` 同值）。 */
export const WIN_ATTR = { readonly: 1, hidden: 2, system: 4, archive: 32 } as const
export type WinAttrKey = keyof typeof WIN_ATTR

/**
 * 单个属性的三态结论。**unknown ≠ clear**：
 * §28 原则二要求「系统文件默认保护」，把读不到的属性当成"没有该属性"，
 * 就等于把系统文件当可清理文件 —— 那是这个只读工具最贵的一类错误。
 */
export type AttrState = 'set' | 'clear' | 'unknown'

/**
 * 当前属性源（`fs.stat` 的 `st_mode`）真正**能证明**的属性位。
 *
 * 计划 Task 15 假设「Node 在 Windows 把 READONLY/HIDDEN/SYSTEM/ARCHIVE 映射进 stats.mode 的
 * bit 1/2/4/32」—— 本机实测**推翻**了它（Node 24.19 / Electron 44 内 node 24.20 / libuv 1.52.1，
 * 同一目录逐个设属性后测）：
 *   Attributes=Normal(无任何属性) / Archive / Hidden,Archive / System,Archive / Hidden,System,Archive
 *     → mode 全部是 33206 (0o100666)
 *   Attributes=ReadOnly,Archive 与 ReadOnly,Hidden,System,Archive
 *     → mode 全部是 33060 (0o100444)
 * 真实盘对照（PowerShell 为权威）：`C:\Users\Public\Desktop\desktop.ini` = Hidden,System
 * 而它的 mode 同样是 33206。也就是说 0o100666 里的 bit 2/4/32 是 **POSIX 权限位**，
 * 与 FILE_ATTRIBUTE 的 HIDDEN/SYSTEM/ARCHIVE 撞位但毫无关系；bit 1 恒为 0。
 * 结论：**一次 stat 只能判出 READONLY**（判据 = 写权限位被抹掉）。
 * 若照假设直接 `mode & 2`，10 万夹具里 89,801 个普通可写文件会被全部报成隐藏文件。
 *
 * 想补齐 HIDDEN/SYSTEM/ARCHIVE 只有两条路，都不在本轮范围内：
 *  N-API 原生模块在 readdir 的 FindNextFileW 里顺手取 dwFileAttributes（真·零额外 syscall，
 *  但违反「零原生依赖」锁定决策），或每文件多一次 GetFileAttributesEx（成本红线，见 §4.1 的
 *  「目录不 stat」同源理由）。所以这里把它做成一个**接口位**：属性源换了，只改本函数与这一行常量。
 */
export const PROVABLE_WIN_ATTR: number = WIN_ATTR.readonly

/** `fs.stat().mode` → 已证明的 FILE_ATTRIBUTE 位（不在 PROVABLE 名单里的一位都不会被置上）。 */
export function attrsFromStatMode(mode: number): number {
  // READONLY 在 st_mode 里的真实表现：可读、不可写（libuv 只做这一次转换）
  return (mode & 0o222) === 0 ? WIN_ATTR.readonly : 0
}

/**
 * 三态判定。契约是那个 **已证明属性位掩码**（`attrsFromStatMode` 或未来原生属性源产出）：
 *  - 位被置上 → 'set'（有属性源证明过它，来源是谁由 attrs 的生产者负责）；
 *  - 位没置上且该属性**可判** → 'clear'；
 *  - 位没置上且该属性**当前判不了** → 'unknown'，绝不允许猜成 'clear'。
 * 今天 `PROVABLE_WIN_ATTR` 只覆盖 READONLY，所以 hidden/system/archive 恒为 'unknown'。
 */
export function attrState(attrs: number, key: WinAttrKey): AttrState {
  const bit = WIN_ATTR[key]
  if ((attrs & bit) !== 0) return 'set'
  return (PROVABLE_WIN_ATTR & bit) !== 0 ? 'clear' : 'unknown'
}

/**
 * §28 原则二的**真判据**版本：带 SYSTEM 属性的条目一律保护，与它的路径长什么样无关。
 * `attrs === null` = 该节点根本没采属性（目录本轮不 stat）→ 不保护，交给路径规则。
 * 注意：当前属性源证明不了 SYSTEM，所以真实扫描里恒为 false；这不是死代码，
 * 而是等属性源补齐即生效的判据位（`attrs.test.ts` 用合成位值锁这条规则本身）。
 */
export function protectedByAttrs(attrs: number | null): boolean {
  return attrs !== null && attrState(attrs, 'system') === 'set'
}

/** 路径规则 + 真属性规则的唯一入口：属性只收紧、不放松路径判据。Treemap 配色与详情面板同源。 */
export function classifyEntry(path: string, attrs: number | null): NodeGroup {
  return protectedByAttrs(attrs) ? 'system' : classifyPath(path)
}

/** 详情面板的四行顺序（§12）。 */
const ATTR_ROWS: ReadonlyArray<{ key: WinAttrKey; label: string }> = [
  { key: 'hidden', label: '隐藏' },
  { key: 'system', label: '系统' },
  { key: 'readonly', label: '只读' },
  { key: 'archive', label: '存档' }
]

export const ATTR_STATE_TEXT: Record<AttrState, string> = {
  set: '是',
  clear: '否',
  unknown: '未知（stat 读不到）'
}

/** 「未采集」专用于目录：它连 stat 都没走，与"采了但读不出该属性"是两件事。 */
export const ATTRS_NOT_COLLECTED = '未采集'

export interface AttrRow {
  key: WinAttrKey
  label: string
  state: AttrState
  text: string
}

/** 详情面板数据：隐藏 / 系统 / 只读 / 存档 四行，属性判不出的如实标出来。 */
export function attrRows(attrs: number | null): AttrRow[] {
  return ATTR_ROWS.map(({ key, label }) => {
    if (attrs === null) return { key, label, state: 'unknown' as AttrState, text: ATTRS_NOT_COLLECTED }
    const state = attrState(attrs, key)
    return { key, label, state, text: ATTR_STATE_TEXT[state] }
  })
}

export const GROUP_LABELS: Record<NodeGroup, string> = {
  system: 'Windows 系统', app: '应用程序', user: '用户文件', cache: '缓存', temp: '临时文件',
  archive: '压缩文件', video: '视频', image: '图片', audio: '音频', dev: '开发环境',
  model: '模型文件', document: '文档', other: '其他'
}

export const GROUP_COLORS: Record<NodeGroup, string> = {
  system: '#4b6cb7', app: '#7b5ea7', user: '#2f9e79', cache: '#c9a227', temp: '#c2603f',
  archive: '#8d6748', video: '#d1495b', image: '#00a6a6', audio: '#7fb069', dev: '#5d5fef',
  model: '#b5651d', document: '#3a86ff', other: '#6b7280'
}

/** §16 四级风险。**MVP 只用于标记与置灰，不执行任何删除。** */
export const RISK_BY_GROUP: Record<NodeGroup, Risk> = {
  system: 'forbidden', temp: 'safe', cache: 'safe', dev: 'caution', model: 'high',
  archive: 'high', video: 'high', image: 'high', audio: 'high', document: 'high',
  app: 'forbidden', user: 'forbidden', other: 'high'
}

export const RISK_COLORS: Record<Risk, string> = {
  safe: '#3fb950', caution: '#d4a72c', high: '#f85149', forbidden: '#a8071a'
}

export const RISK_LABELS: Record<Risk, string> = {
  safe: '🟢 安全', caution: '🟡 谨慎', high: '🟠 高风险', forbidden: '🔴 禁止'
}
