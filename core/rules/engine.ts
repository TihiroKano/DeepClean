/**
 * §15 规则引擎 —— **只识别，不删除**。
 *
 * 两条设计上的硬约束（都在这里落地，不在文档里承诺）：
 *
 * 1. 输入是**已经扫好的树**（`RuleTreeSource`，TreeStore 结构上就满足它）。
 *    本文件里没有任何 `node:fs` / `electron` import，物理上不可能重新走盘 ——
 *    §28 原则一要求那一次扫描是唯一权威遍历，重走一遍等于把 I/O 翻倍。
 * 2. §16 🔴 禁止路径与 `protectedByAttrs()` 认可的条目**不可达**：
 *    所有目录访问都必须经过 `openDir()`，它在调用 `source.childrenOf()` **之前**判禁止路径。
 *    所以禁止目录连"被列举"都不会发生，不是"列举完再过滤"。
 *    `tests/unit/rules-engine.test.ts` 用一个「枚举禁止目录就 throw」的 source 把这条钉死。
 *
 * 输出（`RuleReport`）除了命中清单，还有一张**独立的排除清单**：每条被排除的路径都点名，
 * 并写清是哪个原因（`ExclusionReason`）。§17 预览要能如实告诉用户"这些我们没算进去，因为…"。
 *
 * 3. V0.7 §3.2 的"工具装没装"到这里已经不是一个判断，而是一份**注入的结论**
 *    （`EvaluateOptions.detectorStatus`：探测器 id → 装没装）。本文件因此既不 import
 *    `core/rules/detectors.ts`，也不读机器 —— 引擎拿到的是布尔表，不是一个能继续问问题的入口。
 *    否则"只识别、不走盘"这两条约束会从侧面被探测器捅穿。
 */
import { joinWin, normalizeKey } from '../fs/pathutil'
import { protectedByAttrs } from '../../shared/classify'
import {
  BROAD_LEAF_NAMES,
  CONTAINER_VARS,
  FENCE_MINIMUM_DENY_PATTERNS,
  PACKAGE_TREE_NAMES,
  ruleShapeProblems,
  USER_DATA_LEAF_NAMES,
  USER_DATA_LEAF_RELATIVE,
  type AppFact,
  type Exclusion,
  type ExclusionReason,
  type MatchedPath,
  type RejectedRule,
  type Rule,
  type RuleEnv,
  type RuleFinding,
  type RuleProblem,
  type RuleReport,
  type RuleScopeFence
} from './types'
import type { ChildView } from '../../shared/types'
import type { Risk } from '../../shared/classify'
import { REPORT_ONLY_ROOT_PATTERNS } from './registry'

const DAY_MS = 86_400_000
/**
 * 单次目录展开的最深深度：树本身受 scan maxDepth 约束，这里只是防自环之外的兜底。
 * **全仓唯一一把评估层的尺子**（plan Global Constraints：不许出现第二个上限常量），
 * M5-P1 T2 的任意深度 leaf 遍历复用的就是它 —— 超限一律记 `not-scanned` 并点名目录，
 * 不许静默截断（静默截断与"这棵子树是空的"在报告里长得一样）。
 */
const MAX_WALK_DEPTH = 200
/** `FILE_ATTRIBUTE_REPARSE_POINT`（与 `crates/scanner/src/enumerate.rs` 同一个位）。 */
const ATTR_REPARSE_POINT = 0x400

/**
 * 重解析点目录（junction / symlink）—— spec §2.2 要求"跳过、不跟进去"，与扫描器同口径
 * （`crates/scanner/src/accounting.rs` 的 `SkipReason::Reparse` 本来就不让这类目录进树）。
 *
 * ⚠️ **两侧可达性不对称，登记在 plan §10**：`TreeStore` 的目录项 `attrs` 恒为 `null`
 * （TS 侧不为目录 stat，见 `shared/types.ts:88` 那段），所以这条判据在 TS 的生产取数面上今天
 * **走不到**；Rust 的 `TreeSource` 给的是真 attrs（`tree_source.rs:60-68`），那边可达。
 * 代码两侧都写：一是 fail-safe 方向（多跳一次 = 可能删到链接目标），二是哪天 TS 也开始采目录属性，
 * 不必再回来补这一段。它只由"能给出目录 attrs 的取数面"触发 —— 单测用一个手搓 source 验它。
 */
function isReparsePoint(k: ChildView): boolean {
  return k.kind === 'directory' && k.attrs !== null && (k.attrs & ATTR_REPARSE_POINT) !== 0
}

/**
 * 这个子目录名是不是**第三方代码树**的整名？命中就返回命中的那个名单项（`null` = 不是）。
 *
 * 口径与 `BROAD_LEAF_NAMES` 那一条完全相同（basename 小写后**整名相等**，与 `validateRuleSet`
 * 里 `BROAD_LEAF_NAMES.has(last.toLowerCase())` 同一法），
 * **不是**第二把 glob —— 名单里没有通配字符，整名相等也正好排掉 `dist-types`、`node_modules2`
 * 这类近失形状。与 Rust `engine.rs::package_tree_hit` 逐字同判据。
 */
function packageTreeHit(name: string): string | null {
  const lower = name.toLowerCase()
  return PACKAGE_TREE_NAMES.find((n) => n === lower) ?? null
}

/**
 * 这个目录名是不是**用户数据容器里的缓存同名物**？命中就返回命中的那个路径片段。
 *
 * 两条同时成立才算（cleanup-rules.md §6 的 guard，逐字见 `types.ts::USER_DATA_LEAF_RELATIVE`）：
 * basename 命中 `USER_DATA_LEAF_NAMES` ∧ 路径里**含** `USER_DATA_LEAF_RELATIVE` 的某一段。
 *
 * 为什么是"含某一段"而不是"落在某条禁止根里"：`%LOCALAPPDATA%\Microsoft` 整棵禁止会顺手关掉
 * `thumbnail-cache` 与 `error-reporting` 两条已上线规则（理由逐字在 `types.ts` 那张表的文档里）。
 * 口径与 `packageTreeHit` 同一法：basename 小写后**整名相等**，不新增第二把 glob。
 * 与 Rust `engine.rs::user_data_leaf_hit` 逐字同判据。
 */
function userDataLeafHit(name: string, path: string): string | null {
  const lower = name.toLowerCase()
  if (!USER_DATA_LEAF_NAMES.some((n) => n.toLowerCase() === lower)) return null
  const p = path.replaceAll('/', '\\').toLowerCase()
  return USER_DATA_LEAF_RELATIVE.find((seg) => p.includes(seg.toLowerCase())) ?? null
}

/** 引擎唯一依赖的读取面。`TreeStore` 结构上直接满足，所以调用方传 `scanner.store` 即可。 */
export interface RuleTreeSource {
  rootId: number
  dirIdByPath(path: string): number | undefined
  childrenOf(dirId: number): ChildView[]
  /**
   * 目录 → 子树合计（`finalizeDir` 自底向上算好的那个数）。**只服务 §3.6 那张地盘底账**：
   * 引擎其余部分一次都不用它，`findings` 的字节始终来自逐文件累加，所以它不参与任何可回收口径。
   * 做成可选是照 `AnalysisSource` 那套分工：缺了它 `present[].bytes` 退成 `null`（"没量过"），
   * 绝不退成 0 —— 0 会被界面念成"这个目录是空的"。
   */
  sizeOf?(dirId: number): number
}

interface St {
  source: RuleTreeSource
  env: RuleEnv
  nowMs: number
  forbiddenRoots: readonly string[]
  /**
   * 「只上报不可删」根（回收站那一类）。与 forbiddenRoots 不同，这里的目录**会被枚举**，
   * 判据只用在认领那一刻：非 🔴 规则不许把它的文件算进自己名下。
   */
  reportOnlyRoots: readonly string[]
  /** 文件路径（normalizeKey）→ 已认领它的规则 id：防止两条规则抢同一个文件把总量翻倍 */
  claimed: Map<string, string>
  exclusions: Exclusion[]
  seenExclusion: Set<string>
  /**
   * §3.6 地盘底账的**累加态**（ruleId → 台账）。只有 `requiresDetector` 的规则会在这里出现条目，
   * 由 `resolveTerritory()` 顺带填 —— 它本来就要逐条问过 `dirIdByPath`，多记一笔是零额外遍历。
   * 故意不做成"要用时再排一遍 resolveTerritory"：那会产生第二份 exclusions（同一条路径点两次名）。
   */
  territories: Map<string, { ruleId: string; detectorAbsent: boolean; present: Map<string, number | null>; notScanned: number }>
  listCap: number
  /** 见 `EvaluateOptions.collectPathsFor` */
  collectPathsFor?: ReadonlySet<string>
  /** 见 `EvaluateOptions.detectorStatus` —— 只读一张结论表，引擎不问机器 */
  detectorStatus?: ReadonlyMap<string, boolean>
  /**
   * 当前这条规则的围栏（已解析成具体根），由 `beginRule()` 每条规则换一次。
   * `active = false` = 这条规则没带 `scopeFence` ⇒ `fenceAllows` 一律放行，
   * 既有 15 条因此一个字节都不变（回归轴 `no_leaf_rules_means_byte_identical_findings`）。
   */
  fence: Fence
  /**
   * M5-P1 T2（spec §4.2）/ **P2-T3 起真的被读**：注入的机器事实表。缺省 = 空表 ⇒ 声明
   * `requiresAbsentAppFact` 的规则一个候选都判不出 `absent` ⇒ 整条不提议（方向是**少删**）。
   * 键 = 候选目录 basename 的小写；采集面 = 入口的**直属子目录**（见 `collectAppFactEntry`）。
   */
  appFacts: ReadonlyMap<string, AppFact>
  /**
   * M5-P2 P2-T3（plan §5 交接的硬事实 7）：`unknown` 那一档的**弃权理由原话**（同一把键）。
   * 规则侧的 `AppFact` 是三态字符串（与 Rust 的 fieldless `Copy` 枚举同线格式），装不下
   * `core/facts/appfacts.ts` 那份 `AppFact{state,why}` 的 `why` ⇒ 接线时一次交出两张表。
   */
  appFactWhys: ReadonlyMap<string, string>
}

/** 一条规则的围栏根，解析后的具体路径。见 `St.fence`。 */
interface Fence {
  active: boolean
  allow: string[]
  deny: string[]
}

/** 一条规则的一本账（与 Rust `engine.rs::RuleAgg` 同形）。 */
interface RuleAgg {
  agg: Agg
  roots: string[]
  /** leaf 遍历的去重集：两个入口套住同一棵子树时，`claimed` 只挡跨规则，同规则重收它不挡 */
  walked: Set<string>
}

/* ------------------------------------------------------------------ *
 * 路径工具（段边界，绝不做子串匹配）
 * ------------------------------------------------------------------ */

function segsOf(p: string): string[] {
  return p.replace(/\//g, '\\').split('\\').filter((s) => s.length > 0)
}

function normSegs(p: string): string[] {
  return segsOf(p).map((s) => s.toLowerCase())
}

/** child 是否等于或在 parent 之下（按**段边界**，`C:\Windows\Temples` 不算 `C:\Windows\Temp` 的子孙）。 */
export function pathIsUnder(child: string, parent: string): boolean {
  const c = normSegs(child)
  const p = normSegs(parent)
  if (p.length === 0 || c.length < p.length) return false
  for (let i = 0; i < p.length; i++) if (c[i] !== p[i]) return false
  return true
}

/** 命中哪个禁止根（返回它自己，好让排除记录点名到根）；没命中返回 null。 */
export function isForbiddenPath(path: string, forbiddenRoots: readonly string[]): string | null {
  if (path.length === 0) return null
  for (const f of forbiddenRoots) if (pathIsUnder(path, f)) return f
  return null
}

/** 把段拼回绝对路径；盘符单段（`C:`）补回尾斜杠，否则 normalizeKey 与树上的 `c:\` 对不上。 */
function tokensToPath(tokens: readonly string[]): string {
  if (tokens.length === 0) return ''
  if (tokens.length === 1 && /^[A-Za-z]:$/.test(tokens[0]!)) return `${tokens[0]}\\`
  let out = tokens[0]!
  for (let i = 1; i < tokens.length; i++) out = joinWin(out, tokens[i]!)
  return out
}

/** 规则路径里的变量段（`%TEMP%`）—— 只从注入的 env 取值，绝不读 `process.env`（约束 7）。 */
function lookupEnv(env: RuleEnv, name: string): string | null {
  const keys = Object.keys(env)
  const upper = name.toUpperCase()
  for (const k of keys) if (k.toUpperCase() === upper) return env[k] ?? null
  return null
}

interface ResolvedPattern {
  /** 通配之前的字面前缀（已解析成绝对路径）；变量取不到值时为 null */
  base: string | null
  /** base 之后的段（可能含 `*`） */
  rest: string[]
  unresolvedVar?: string
  /** 整条路径都是字面量时给出的完整绝对路径，否则 null */
  concrete: string | null
}

export function resolvePattern(pattern: string, env: RuleEnv): ResolvedPattern {
  const tokens = segsOf(pattern)
  const head = tokens[0] ?? ''
  let baseSegs: string[]
  let rest: string[]
  if (/^%[A-Za-z0-9_]+%$/.test(head)) {
    const name = head.slice(1, -1).toUpperCase()
    const val = lookupEnv(env, name)
    if (val === null) return { base: null, rest: tokens.slice(1), unresolvedVar: name, concrete: null }
    baseSegs = normKeep(val)
    rest = tokens.slice(1)
  } else {
    // 盘符绝对写法（`C:\Users\...`）：`C:` 当 base，其余进 rest —— 与 %VAR% 走同一条展开逻辑
    baseSegs = /^[A-Za-z]:$/.test(tokens[0] ?? '') ? [tokens[0]!] : []
    rest = baseSegs.length === 0 ? tokens : tokens.slice(1)
  }
  const wild = rest.some((s) => s.includes('*') || s.includes('?'))
  const concrete = wild ? null : tokensToPath([...baseSegs, ...rest])
  return { base: tokensToPath(baseSegs) || null, rest, concrete }
}

/** 保留原大小写的段切分（`C:\Users\Kano` → ['C:','Users','Kano']）。 */
function normKeep(p: string): string[] {
  return segsOf(p)
}

/* ------------------------------------------------------------------ *
 * 文件名 glob（`*` / `?`，整名、大小写不敏感）
 * ------------------------------------------------------------------ */

function globToRe(glob: string): RegExp {
  let src = '^'
  for (const ch of glob) {
    if (ch === '*') src += '.*'
    else if (ch === '?') src += '.'
    else src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${src}$`, 'i')
}

function nameMatches(name: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true
  return patterns.some((g) => globToRe(g).test(name))
}

/* ------------------------------------------------------------------ *
 * 静态校验（§28 原则四）
 * ------------------------------------------------------------------ */

export interface ValidateOptions {
  env: RuleEnv
  forbiddenPatterns: readonly string[]
  /** 「只上报不可删」清单，默认 = registry 的 `REPORT_ONLY_ROOT_PATTERNS` */
  reportOnlyPatterns?: readonly string[]
}

/** 段序列 a 是否是 b 的**严格前缀**（`*` 恰好匹配一段）—— 即 a 的地盘整个套住 b。 */
function isStrictTerritoryPrefix(a: readonly string[], b: readonly string[]): boolean {
  if (a.length >= b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!.toLowerCase()
    if (x === '*') continue
    if (x !== b[i]!.toLowerCase()) return false
  }
  return true
}

/**
 * 不碰树、不碰磁盘的规则把关（= §17 之前的"能不能上表"检查）。
 * 每条被拒规则只报**第一个**命中问题（判据顺序固定，结果可复现）：
 * 非法形状 →（M5-P1 T1：leaf 语义混用 → leaf 缺围栏 → 围栏结构/覆盖）→
 * 通配收尾 / 落在禁止路径里 / 是禁止根的地盘祖先 / 是别条规则的地盘祖先 / 宽容器。
 *
 * M5-P1 T1 起的**容器入口模式**（与 Rust `validate.rs::validate_rule_set` 逐条同序同判据）：
 * `leaf*` 判据与合法 `scopeFence` 同时在场时，`paths` 降级为遍历入口/围栏锚点 ——
 * 宽容器与通配收尾两条地盘判据、以及规则间祖先判据对该规则放行（边界由围栏根 + basename
 * 名单守；评估层"不枚举"是 T2）。只带围栏不带 leaf 的容器入口换用 `container-without-predicate`；
 * 两者都不带的旧规则，判据名与逐字节行为一字不改（回归轴）。
 */
/** 与 Rust `validate.rs::is_absolute_template` 同判据：`%VAR%` 开头，或 `X:\` / `X:/` 盘符绝对。 */
function isAbsoluteTemplate(p: string): boolean {
  return p.startsWith('%') || (p.length >= 3 && p[1] === ':' && (p[2] === '\\' || p[2] === '/'))
}

/** 围栏根 → 解析后的具体根。`deny=true` 时允许**恰好一个收尾通配段**（`%WINDIR%\*` —— deny 的
 * 语义天然是"整棵子树"）；通配出现在中间、或 allow 侧出现通配，一律拒。返回错误理由串。
 * 与 Rust `validate.rs::fence_root` 逐条同。 */
function fenceRoot(p: string, env: RuleEnv, deny: boolean): { path: string } | { detail: string } {
  if (!isAbsoluteTemplate(p)) return { detail: `围栏根 ${p} 必须以 %VAR% 或盘符绝对路径开头` }
  const segs = segsOf(p)
  if (deny && (segs[segs.length - 1] === '*' || segs[segs.length - 1] === '?')) segs.pop()
  if (segs.length === 0) return { detail: `围栏根 ${p} 只有一个通配段，落不到具体目录` }
  for (const s of segs) {
    if (s.includes('*') || s.includes('?'))
      return deny
        ? { detail: `围栏根 ${p} 的通配只许作收尾整段（\`%WINDIR%\\*\` 这种），中间段带通配指不到具体子树` }
        : { detail: `围栏根 ${p} 不许含通配字符：allowRoots 是采集入口，必须落到具体目录` }
  }
  const res = resolvePattern(tokensToPath(segs), env)
  if (res.unresolvedVar !== undefined)
    return { detail: `围栏根 ${p} 的 %${res.unresolvedVar}% 在注入 env 里解析不出来 —— 围栏不许有解不出来的根` }
  const path = res.concrete ?? res.base
  if (path === null || path === undefined || path === '') return { detail: `围栏根 ${p} 解析不出具体路径` }
  const ps = segsOf(path)
  if (ps.length === 1 && /^[A-Za-z]:$/.test(ps[0]!)) return { detail: `围栏根解析到盘符根 ${path}：围栏不许落在盘符根上` }
  return { path }
}

/**
 * `scopeFence` 的结构闸。
 *
 * ⚠️ **§4.3 的不对称是刻意的，不许"顺手统一"**：本函数**不走** `broad-container` /
 * `pattern-not-leaf` 那两条**地盘**判据 —— 围栏天然就要点名 `programdata`、`program files (x86)`
 * 这些容器（它们就在 `BROAD_LEAF_NAMES` 里），复用地盘校验会让 `denyRoots: ["%PROGRAMDATA%"]`
 * 被自己拒掉，围栏**静默失效**。它只查三件事：解析后绝对、非盘符根、通配形态
 * （allow 不许、deny 只许收尾整段）—— 再加一条覆盖判据：`denyRoots` 必须 ⊇
 * 禁止根全集 ∪ `FENCE_MINIMUM_DENY_PATTERNS`。返回错误理由串；null = 围栏合格。
 * 与 Rust `validate.rs::validate_fence` 同序同判据（deny 先解析、allow 后解析、覆盖最后逐条）。
 */
function validateFence(
  fence: RuleScopeFence,
  env: RuleEnv,
  forbiddenPatterns: readonly string[]
): string | null {
  if (fence.allowRoots.length === 0) return '围栏必须有 allowRoots：leaf 采集根的边界不能是空的'
  const denyRoots: string[] = []
  for (const p of fence.denyRoots) {
    const r = fenceRoot(p, env, true)
    if ('detail' in r) return r.detail
    denyRoots.push(r.path)
  }
  for (const p of fence.allowRoots) {
    const r = fenceRoot(p, env, false)
    if ('detail' in r) return r.detail
  }
  for (const req of [...forbiddenPatterns, ...FENCE_MINIMUM_DENY_PATTERNS]) {
    // 必需覆盖项自己解析不出来 = 覆盖无法证明 = 拒（fail-closed，与"禁止根解不出来出 safetyBlocked"同方向）
    const r = fenceRoot(req, env, true)
    if ('detail' in r) return `围栏覆盖判据无法解析必需项 ${req}：${r.detail}`
    if (!denyRoots.some((d) => pathIsUnder(r.path, d)))
      return `denyRoots 必须覆盖 ${req}：禁止根全集 + %WINDIR%\\* + %PROGRAMFILES%\\* + %SYSTEMDRIVE%\\Program Files (x86)\\* 是围栏的地板（spec §2.3 / plan §4.2）`
  }
  return null
}

export function validateRuleSet(rules: readonly Rule[], o: ValidateOptions): { valid: Rule[]; problems: RuleProblem[] } {
  const forbidden = resolvePatterns(o.forbiddenPatterns, o.env)
  const reportOnly = resolvePatterns(o.reportOnlyPatterns ?? REPORT_ONLY_ROOT_PATTERNS, o.env)
  const valid: Rule[] = []
  const problems: RuleProblem[] = []

  for (const r of rules) {
    const problem = (path: string, reason: ExclusionReason, detail: string): void => {
      problems.push({ ruleId: r.id, path, reason, detail })
    }
    const shape = ruleShapeProblems(r)
    if (shape.length > 0) {
      problem(r.id, 'invalid-shape', `§15 形状不合格：${shape.join('；')}`)
      continue
    }

    // ── M5-P1 T1 扫描器/围栏闸（顺序即行为，与 Rust `validate.rs` 逐条同序）──
    const leafDirs = r.scanner.leafDirs ?? []
    const leafFiles = r.scanner.leafFiles ?? []
    // §10 裁定 1：两种采集根语义混在一条规则里会产出无法解释的命中 —— 混给就拒，围栏齐与否不问
    if (leafDirs.length > 0 && leafFiles.length > 0) {
      problem(
        r.id,
        'ambiguous-leaf-mode',
        'leafDirs 与 leafFiles 互斥（§10 裁定 1）：前者收"名字像缓存/更新目录的子树"，后者收"任意深度名字像轮转件的文件"，混在一条规则里产出无法解释的命中'
      )
      continue
    }
    const hasLeaf = leafDirs.length > 0 || leafFiles.length > 0
    // M5-P2 P2-T3（plan §2.5）：机器事实闸是**第三种采集模式**，与 `leaf*` 那两种互斥
    const appFactMode = r.requiresAbsentAppFact === true
    if (appFactMode && hasLeaf) {
      problem(
        r.id,
        'ambiguous-leaf-mode',
        `requiresAbsentAppFact 与 ${(leafDirs.length > 0 ? 'leafDirs' : 'leafFiles')} 互斥（plan §2.5）：机器事实闸自己就是一种**采集模式** —— 采集根 = 入口目录的直属子目录、逐格查表、只有 Absent 才收；leaf* 的采集根由 basename 名单在任意深度命中决定。两者同时给就没有"这一层是谁定的"了：同一条路径既能被表批准、又能被名单命中，字节算在哪一档说不清，而这条规则后面接的是删除`
      )
      continue
    }
    const fence = r.scanner.scopeFence
    // 围栏是这块能力的全部风险所在（plan §0.1）：`leafDirs: ["Cache"]` 无围栏会任意深度吃到
    // Program Files 里应用自带运行时资源 —— 缺围栏整条拒，不在评估时悄悄滤命中（plan §0.2）
    if (hasLeaf && fence === undefined) {
      problem(
        r.id,
        'inadequate-fence',
        'leaf* 采集根必须同时声明 scopeFence：无围栏的 basename 判据（如 Cache）会任意深度吃到 Program Files 里应用自带运行时资源（plan §0.1）'
      )
      continue
    }
    // P2-T3（plan §2.5）：带 `requiresAbsentAppFact` 的规则**必须容器入口 + 覆盖齐全的围栏** ——
    // 它的采集根是入口的**全部直属子目录**，没有围栏就等于让一张机器事实表去批准整个用户目录树。
    // 位置与 Rust 逐字同序：缺围栏这一条排在 `validateFence` 之前（两者互斥，但顺序即文档）。
    if (appFactMode && fence === undefined) {
      problem(
        r.id,
        'inadequate-fence',
        'requiresAbsentAppFact 的规则必须带 scopeFence：它的采集根是入口目录的全部直属子目录，没有围栏就等于让一张机器事实表去批准整个用户目录树（%LOCALAPPDATA% 底下几百个目录逐格问表）—— 表错一格，收进来的就是别人家的运行时资源（plan §2.5「带它的规则必须容器入口 + 围栏」）'
      )
      continue
    }
    if (fence !== undefined) {
      const bad = validateFence(fence, o.env, o.forbiddenPatterns)
      if (bad !== null) {
        problem(r.id, 'inadequate-fence', bad)
        continue
      }
    }
    // leaf 判据 + 合法围栏齐全 = **容器入口模式**：`paths` 是遍历入口而不是地盘叶子，
    // ②通配收尾 / ⑥宽容器 / ⑦规则间祖先这三条地盘判据对它放行（边界由围栏 + basename 名单在
    // 评估层守，T2 落地"不枚举"）。没 leaf 只带围栏的容器入口不豁免 —— 换成
    // container-without-predicate 这个更准的理由；两者都没有的旧规则，判据名逐字不变（回归轴）。
    //
    // M5-P2 P2-T3：`requiresAbsentAppFact` 走的是**同一个容器入口模式**（`paths` 就是
    // `%LOCALAPPDATA%` 这一类容器，候选是它们的直属子目录 —— spec §3 3.5「顶层一项」），
    // 所以豁免条件从"有 leaf"变成"有 leaf **或** 带机器事实闸"。上面两条闸已经保证这里
    // 不会同时为真（混用 = ambiguous-leaf-mode）。
    const containerMode = (hasLeaf || appFactMode) && fence !== undefined

    let rejected = false
    for (const pattern of r.paths) {
      if (rejected) break
      const tokens = segsOf(pattern)
      const last = tokens[tokens.length - 1] ?? ''
      if (!containerMode && (last === '*' || last === '?')) {
        problem(
          pattern,
          fence !== undefined ? 'container-without-predicate' : 'pattern-not-leaf',
          fence !== undefined
            ? '容器入口没有配套的 leaf 形状判据：围栏只收窄"在哪找"，判据必须落在 basename 上（spec §2.3）'
            : '路径以通配收尾，落不到具体叶子目录（§28 原则四）'
        )
        rejected = true
        break
      }
      const res = resolvePattern(pattern, o.env)
      // 禁止路径相关判据只在字面路径（无通配）且变量都能解析时才算 —— 通配展开出来的具体地盘由评估时逐条把关
      if (res.concrete !== null && res.base !== null) {
        const hit = isForbiddenPath(res.concrete, forbidden.roots)
        if (hit !== null) {
          problem(pattern, 'forbidden-root', `规则路径落在 §16 🔴 禁止路径 ${hit} 之内，声明层即不可达`)
          rejected = true
          break
        }
        const swept = forbidden.roots.find((f) => pathIsUnder(f, res.concrete!) && normalizeKey(f) !== normalizeKey(res.concrete!))
        if (swept !== undefined) {
          problem(pattern, 'ancestor-of-protected', `规则路径 ${res.concrete} 是禁止路径 ${swept} 的祖先，宽容器清理会顺手扫走它`)
          rejected = true
          break
        }
        // 只上报根：🔴 规则可以把它当地盘（要如实报占用），别的规则不行 —— 这条与评估层/执行层同一个判据
        if (r.riskLevel !== 'forbidden') {
          const roHit = isForbiddenPath(res.concrete, reportOnly.roots)
          if (roHit !== null) {
            problem(pattern, 'report-only-root', `规则路径落在只上报根 ${roHit} 之内 → 该目录只许报告占用、不许被非 🔴 规则清理，声明层即拒绝`)
            rejected = true
            break
          }
        }
      }
      // ⑥ 裸容器变量 / 宽容器收尾（容器入口模式下放行：paths 是遍历入口，边界由围栏守）
      const headIsVar = /^%[A-Za-z0-9_]+%$/.test(tokens[0] ?? '')
      const varName = headIsVar ? tokens[0]!.slice(1, -1).toUpperCase() : null
      const bare = tokens.length === 1
      if (!containerMode) {
        if (bare && varName !== null && CONTAINER_VARS.has(varName)) {
          problem(
            pattern,
            fence !== undefined ? 'container-without-predicate' : 'broad-container',
            fence !== undefined
              ? `容器入口 %${varName}% 没有配套的 leaf 形状判据：它本身是容器目录，围栏不能替代判据（spec §2.3）`
              : `%${varName}% 本身是容器目录，不构成叶子级清理范围（§28 原则四）`
          )
          rejected = true
          break
        }
        if (BROAD_LEAF_NAMES.has(last.toLowerCase())) {
          problem(
            pattern,
            fence !== undefined ? 'container-without-predicate' : 'broad-container',
            fence !== undefined
              ? `路径落在宽容器「${last}」上且没有 leaf 判据：围栏只收窄范围，判据必须落在 basename 上（spec §2.3）`
              : `路径落在宽容器「${last}」上，清理范围必须精确到叶子路径（§28 原则四）`
          )
          rejected = true
          break
        }
      }
    }
    if (rejected) continue

    // ⑦ 规则之间的地盘包含：A 的段序列是 B 的严格前缀 → A 不算精确到叶子。
    //    容器入口模式跳过 —— 它的 `paths` 是围栏锚点而不是地盘，T3 六条的 `%LOCALAPPDATA%`
    //    入口与既有 15 条的地盘重叠是设计使然（claimed 先声明者计账兜双计）。
    if (!containerMode) {
      const other = rules.find(
        (b) =>
          b.id !== r.id &&
          r.paths.some((rp) =>
            b.paths.some((bp) => isStrictTerritoryPrefix(segsOf(rp), segsOf(bp)))
          )
      )
      if (other !== undefined) {
        problem(r.paths[0] ?? r.id, 'ancestor-of-protected', `本规则的地盘整体套住了规则 ${other.id}，宽容器会顺手扫走别家叶子（§28 原则四）`)
        continue
      }
    }
    valid.push(r)
  }
  return { valid, problems }
}

interface ResolvedForbidden {
  roots: string[]
  unresolved: string[]
}

function resolvePatterns(patterns: readonly string[], env: RuleEnv): ResolvedForbidden {
  const roots: string[] = []
  const unresolved: string[] = []
  for (const p of patterns) {
    const res = resolvePattern(p, env)
    if (res.concrete !== null) roots.push(res.concrete)
    else if (res.base !== null) roots.push(res.base)
    else unresolved.push(p)
  }
  return { roots, unresolved }
}

/** 确定序：按小写整串比码位，不用 localeCompare（ICU 会把 `\` `.` 这类标点当零权重，排序结果不稳定）。 */
function cmpPath(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

/* ------------------------------------------------------------------ *
 * 评估
 * ------------------------------------------------------------------ */

export interface EvaluateOptions {
  /** 已扫好的树（`scanner.store` 直接可用）—— 引擎不会重新走盘（约束 1） */
  source: RuleTreeSource
  /** 环境路径表：只能由调用方注入（约束 7） */
  env: RuleEnv
  rules: readonly Rule[]
  /** §16 🔴 清单（`%VAR%` 模板或绝对路径），由 registry 的 `FORBIDDEN_PATH_PATTERNS` 提供 */
  forbiddenPatterns: readonly string[]
  /**
   * 「只上报不可删」清单，默认 = registry 的 `REPORT_ONLY_ROOT_PATTERNS`。
   * 与 forbiddenPatterns 的分工：这张表**不拦枚举**（回收站的占用字节要如实报出来），
   * 只拦认领 —— 所以它挡的是"别的规则把它算成可清理"，不是"看不见它"。
   */
  reportOnlyPatterns?: readonly string[]
  /** 时间基准（`olderThanDays` 用）：注入而非读时钟，单测才可复现 */
  nowMs: number
  /** 每条规则回显的采样路径上限；`fileCount` / `totalBytes` 不受它影响 */
  maxListedPaths?: number
  /**
   * 给点名的规则带上 `allPaths`（= 该 finding 认领的**全部**文件，与 fileCount/totalBytes 同一口径）。
   *
   * 为什么必须有：§18 的执行器只能删具体路径，而报告默认只回显 `maxListedPaths` 条采样 ——
   * 让调用方"自己去重走一遍磁盘补齐清单"直接违反 §28 原则一，自己另写一套过滤器又会和规则口径分叉。
   * 所以这里把引擎**已经算过**的全量路径交出去（`agg.paths` 本来就在内存里，只是默认被 slice 掉了），
   * 零额外遍历、零额外 syscall，口径与预估字节严格同源。
   * 只有确认要执行时才按 ruleId 点名开启，避免平时把几十万条路径挂在报告上。
   */
  collectPathsFor?: ReadonlySet<string>
  /** 见 `RuleReport.claimedPaths`：把防双计那张表交出去（引用，零额外遍历），供 §12 的逐文件勾选定位规则。 */
  reportClaims?: boolean
  /**
   * V0.7 §3.2：探测器给出的结论表 —— 键 = 探测器 id（= `Rule.requiresDetector` 填的值），值 = 装没装。
   * 由 `electron/services/detect-env.ts` 在真机上跑出来，经调用方注入；缺省 = 不启用这条闸，
   * 于是行为与 V0.7 之前逐字节一致（这也是本次改动唯一的回归轴，`rules-engine.test.ts` 钉着）。
   */
  detectorStatus?: ReadonlyMap<string, boolean>
  /**
   * M5-P1 T2（spec §4.2）：机器事实表 —— 键 = 候选目录 basename 的小写归一化，值 = 三态结论。
   *
   * 缺省 = 一张空表，于是声明 `requiresAbsentAppFact` 的规则一个候选都判不出 `Absent` ⇒
   * 整条不提议（fail-safe 的方向是**少删**，不是多删）。填它的是 M5-P2 的 `crates/appfacts`
   * （注册表 / Appx / 进程 / 安装目录六路证据），基准侧是 `core/facts/appfacts.ts`。
   * 引擎读的还是注入的表，一次都不碰系统 —— 「只识别、不走盘」那两条硬约束不变。
   */
  appFacts?: ReadonlyMap<string, AppFact>
  /**
   * M5-P2 P2-T3：`unknown` 那一档的弃权理由原话（`core/facts/appfacts.ts` 的 `whyOf()` 交出来的
   * 那张副表，同一把键）。规则侧的三态字符串装不下 `why`，所以接线时**两张表一起交** ——
   * 排除记录要把"探针为什么没判"那句原话带进报告，那是这一档唯一有用的信息。
   */
  appFactWhys?: ReadonlyMap<string, string>
}

interface Agg {
  count: number
  bytes: number
  paths: MatchedPath[]
}

function emptyReport(forbiddenRoots: string[], reportOnlyRoots: string[]): RuleReport {
  return {
    findings: [],
    exclusions: [],
    territories: [],
    rejectedRules: [],
    forbiddenRoots: [...forbiddenRoots].sort(),
    reportOnlyRoots: [...reportOnlyRoots].sort(),
    safetyBlocked: false,
    bytesByRisk: { safe: 0, caution: 0, high: 0, forbidden: 0 },
    reclaimableBytes: 0
  }
}

/**
 * 每条规则开工前把**它自己**的围栏换进来。必须整体替换、不许残留：
 * 留着上一条的围栏等于给这一条套了一层别人的边界 —— 那是"看着有保护、实际拦错了地方"。
 * 声明层（`validateFence`）已经保证这些根解析得出来；万一这里解不出来（同一份 env 下不该发生），
 * 处置是 **fail-closed**：allow 侧一条都没补上 ⇒ 什么都进不去，而不是什么都进得来。
 */
function beginRule(rule: Rule, st: St): void {
  const fence: Fence = { active: false, allow: [], deny: [] }
  const declared = rule.scanner.scopeFence
  if (declared !== undefined) {
    fence.active = true
    for (const p of declared.denyRoots) {
      const r = fenceRoot(p, st.env, true)
      if ('path' in r) fence.deny.push(r.path)
    }
    for (const p of declared.allowRoots) {
      const r = fenceRoot(p, st.env, false)
      if ('path' in r) fence.allow.push(r.path)
    }
  }
  st.fence = fence
}

/** 这个路径命中哪条 deny 根 —— 回**那个根**，让排除记录同时点名"哪个目录被拦"和"是谁拦的"。 */
function fenceDenies(path: string, st: St): string | null {
  if (!st.fence.active) return null
  return st.fence.deny.find((d) => pathIsUnder(path, d)) ?? null
}

/** 这个路径在不在采集面之内。没带围栏的规则一律允许（回归轴的那一半保证）。 */
function fenceAllows(path: string, st: St): boolean {
  if (!st.fence.active) return true
  return st.fence.allow.some((a) => pathIsUnder(path, a))
}

/** 声明了机器事实闸的规则？只有 `=== true` 算声明（与 `excludedFromDefaultSelection` 同方向）。 */
function wantsAbsentAppFact(rule: Rule): boolean {
  return rule.requiresAbsentAppFact === true
}

/**
 * 机器事实闸（spec §4.2 / plan §2.4）：把**一个候选目录**（= 入口的直属子目录）交进表里查。
 * 三档不批准的理由**各自一条、各自点名**，而且两两能被读者分开：
 * `present` = 「看了，本体还在」；`unknown` = 「看了，但取证取不全，原话是 …」；
 * **缺键** = 「这张表没被交代看过它」。最后那条绝不能读成"看过了、什么都没有"。
 * 只有 `absent` 返回 true。P2-T1 那半边把三档折成一条 `app-fact-unknown` 的写法已作废。
 * 与 Rust `engine.rs::app_fact_approves` 逐句同措辞（两侧的报告要能逐条对着读）。
 */
function appFactApproves(dir: string, rule: Rule, st: St): boolean {
  const key = baseOf(dir).toLowerCase()
  const tail = (what: string): string =>
    `${what}（查的键 =「${key}」，候选目录 ${dir} 的 basename 小写）→ 本条地盘不提议：0 字节、不进可回收，也不许静默消失`
  const fact = st.appFacts.get(key)
  if (fact === 'absent') return true
  if (fact === 'present') {
    exclude(
      st,
      rule.id,
      dir,
      'app-fact-present',
      tail(
        '注入的机器事实**证出了本体在场**（Present）：卸载表条目 / MSIX 包目录 / 安装根 / 进程镜像至少一路命中 ⇒ 这个应用还在这台机器上，它的目录不是残留'
      )
    )
    return false
  }
  if (fact === 'unknown') {
    // 把探针的 `why` 原话带进报告（这就是 `appFactWhys` 那张副表存在的全部理由）
    const why = st.appFactWhys.get(key) ?? `表里「${key}」这一格是 unknown 却没带 why —— 弃权理由缺失，按最保守档处理`
    exclude(
      st,
      rule.id,
      dir,
      'app-fact-unknown',
      `注入的机器事实自己弃了权（Unknown），原话是：${why} —— 这**不是**「查了说没装」，而是「没能把两半都证出来」（查的键 =「${key}」，候选目录 ${dir}）→ 本条地盘不提议：0 字节、不进可回收，也不许静默消失`
    )
    return false
  }
  exclude(
    st,
    rule.id,
    dir,
    'app-fact-key-missing',
    tail(
      '注入的机器事实表里**没有这个键**（缺键）：探针根本没被交代看过这个目录 —— 这既不是「查过、查无」也不是「查了查不动」，而是「什么都没发生过」。spec §4.2 定死缺键 = Unknown 同向（不许提议），但理由必须与那两条分开写，否则「把候选交给探针」这件事永远不会出现在报告里'
    )
  )
  return false
}

/**
 * **第三种采集模式**（plan §2.4，与既有两种并列：非 leaf 的地盘直收、leaf 的任意深度命中）。
 * 与 Rust `engine.rs::collect_app_fact_entry` 同判据同顺序：
 *  · **入口自己不是候选**（拿容器名 `local` 去查表永远缺键 ⇒ 整条规则从报告里静默消失）；
 *  · 候选 = 入口的**直属子目录**（spec §3 3.5「顶层一项」），按归一化路径先排后处理，
 *    两次跑必须同序；
 *  · 围栏在先、查表在后：被 deny 掉的候选连 `matchedRoots` 都不进（`fenceBlocks` 只判定不枚举）；
 *  · 重解析点目录既不当候选也不跟进，与 `walkLeaf` / 扫描器 `SkipReason::Reparse` 同一口径；
 *  · 只有表批准（`absent`）的那一棵才交给 `collectTerritory` —— 没批准的候选里面一个文件都不枚举。
 */
function collectAppFactEntry(entry: string, rule: Rule, st: St, out: RuleAgg): void {
  if (out.walked.has(normalizeKey(entry))) return // 两个 `paths` 条目解析到同一个入口
  out.walked.add(normalizeKey(entry))
  const kids = openDir(entry, rule.id, st)
  if (kids === null) return
  const dirs = kids.filter((k) => k.kind === 'directory').sort((a, b) => cmpPath(a.path, b.path))
  for (const k of dirs) {
    if (isReparsePoint(k)) {
      exclude(
        st,
        rule.id,
        k.path,
        'not-scanned',
        `目录 ${k.path} 是重解析点（FILE_ATTRIBUTE_REPARSE_POINT）→ 不作为机器事实的候选，也不跟进去（与 walkLeaf / 扫描器 SkipReason::Reparse 同一口径）`
      )
      continue
    }
    if (fenceBlocks(k.path, rule.id, st)) continue
    if (!appFactApproves(k.path, rule, st)) continue
    if (!out.roots.some((r) => normalizeKey(r) === normalizeKey(k.path))) out.roots.push(k.path)
    collectTerritory(k.path, rule, st, out.agg)
  }
}

/**
 * 禁止分支与越栏分支**都根本不枚举** —— 同一个形状（spec §2.3 点名的就是这件事：围栏要是有漏洞，
 * 漏的就是"任意深度 basename 判据"整块能力）。顺序也是判据的一部分：先禁止根（既有口径逐字不变），
 * 再围栏 deny，最后 allow。
 *
 * 这一份**只做判定与记账，不碰取数面**（`dirIdByPath` / `childrenOf` 都不在这里）。把它从
 * `openDir()` 抽出来，是因为第三种采集模式（`collectAppFactEntry`）要在**枚举之前**问一句
 * "这个候选目录在不在栏内"：让它直接调 `openDir` 就会把没批准的候选也列一遍 —— 而
 * "一条都没批准的目录里面一个文件都不枚举"这句话，0 字节只是结果、不枚举才是结构。
 * 两处共用这一份判据，就不存在"围栏在两个地方口径不一样"的那种漏（漏的那一边永远是**多删**那一侧）。
 * 与 Rust `engine.rs::fence_blocks` 逐条同。
 */
function fenceBlocks(path: string, ruleId: string | null, st: St): boolean {
  const hit = isForbiddenPath(path, st.forbiddenRoots)
  if (hit !== null) {
    exclude(st, ruleId, path, 'forbidden-root', `命中 §16 🔴 禁止路径 ${hit} → 整条分支不可达，未枚举`)
    return true
  }
  const deniedBy = fenceDenies(path, st)
  if (deniedBy !== null) {
    exclude(
      st,
      ruleId,
      path,
      'outside-fence',
      `目录 ${path} 命中围栏 denyRoots ${deniedBy} → 整棵子树不可达，未枚举（plan §0.1：leaf 判据不许伸进应用自带的运行时资源）`
    )
    return true
  }
  if (!fenceAllows(path, st)) {
    exclude(
      st,
      ruleId,
      path,
      'outside-fence',
      `目录 ${path} 不在围栏 allowRoots [${st.fence.allow.join('、')}] 之内 → 不是这条规则的采集面，未枚举`
    )
    return true
  }
  return false
}

/**
 * 唯一被允许触碰树的入口：**先判禁止路径，再判围栏，最后才决定要不要枚举**。
 * 返回 null = 这条分支不可达/不可知，且已经留下点名到具体路径的排除记录。
 *
 * M5-P1 T2 起这里同时拦三样，而且**三样都是"不枚举"**（判定那一段抽成了 `fenceBlocks()`），
 * 所以围栏外的目录连"被列举"都不会发生，不是"列举完再过滤命中"。
 */
function openDir(path: string, ruleId: string | null, st: St): ChildView[] | null {
  if (fenceBlocks(path, ruleId, st)) return null
  const id = st.source.dirIdByPath(path)
  if (id === undefined) {
    exclude(st, ruleId, path, 'not-scanned', '本次扫描没有覆盖该目录（没扫到 ≠ 不存在，按未知处理）')
    return null
  }
  return st.source.childrenOf(id)
}

/**
 * 这条规则能不能把 `path` 算进自己名下？
 * 「只上报不可删」根（回收站那一类）只对 🔴 规则开放 —— 它要如实报告占用，
 * 但 🟢/🟡 规则把它认领走就等于把回收站摆上清理清单，而认领一旦发生在报告里，预览与执行器吃的就是那份清单。
 * 判据复用 `isForbiddenPath`（同一个段边界比较），不另立第三套"禁止"语义。
 */
function reportOnlyBlock(path: string, rule: Rule, st: St): string | null {
  if (rule.riskLevel === 'forbidden') return null
  return isForbiddenPath(path, st.reportOnlyRoots)
}

/**
 * 记一条排除。**返回它是否真的落了账**（同 `ruleId + reason + 路径` 已记过时去重，不算新条）。
 * 这个返回值只为 §3.6 地盘底账服务：那边的 `notScanned` 必须与 `exclusions` 里点名的条数**相等**，
 * 而"相等"要钉得住就得两边各自数一遍 —— 让底账直接去数 exclusions 是自我印证，不算验证。
 */
function exclude(st: St, ruleId: string | null, path: string, reason: ExclusionReason, detail: string): boolean {
  const key = `${ruleId ?? '-'}\u0000${reason}\u0000${normalizeKey(path)}`
  if (st.seenExclusion.has(key)) return false
  st.seenExclusion.add(key)
  st.exclusions.push({ ruleId, path, reason, detail })
  return true
}

/**
 * 这条规则依赖的工具在这台机器上没装？（V0.7 §3.2）
 *
 * **只有明确收到 false 才算没装**：`requiresDetector` 没写 → 不归探测管；写了但表里没有这个 id
 * （探测器接线写错、id 拼错、调用方压根没跑探测）→ 一律按已安装照旧评估。
 * 这是一条裁定的落地，代价也一起记着：接线出问题时退回 V0.7 之前的"全量误报"形态而不是崩掉 ——
 * 选这个方向是因为反过来的兜底（缺 id 当没装）会让一条真存在、真有几个 GB 的规则
 * 从一个坏掉的引用手里**静默消失**，而读报告的人看不出任何东西坏过。
 */
function absentDetector(rule: Rule, st: St): string | null {
  const det = rule.requiresDetector
  if (typeof det !== 'string' || det.length === 0) return null
  return st.detectorStatus?.get(det) === false ? det : null
}

/**
 * 没装的工具：一条 finding 都不出，但它解析出的每条地盘都要在 `exclusions[]` 里点名。
 *
 * 为什么不能只是"跳过"：跳过之后那块地盘从 `reclaimableBytes` 里消失，而这份报告和
 * "这机器上根本没有这块缓存"长得一模一样 —— 静默消失和误报同样坏，用户会以为工具没缓存，
 * 而不是没探测到。
 * 仍然要走 `resolveTerritory()` 而不是凭空写一条规则级记录：点名的必须是**这棵树上真解析出来的路径**
 * （`types.ts` 那条「excluded 记录必须点名到具体路径」），而且解析过程自己产生的
 * not-scanned / unresolved-env 之类原因要照常留着 —— 两条原因是两件事，不许互相顶掉。
 * 不碰 `collectTerritory()`：地盘里的文件一次都不枚举，所以 0 字节是结构性的，不是加完总再抹掉。
 */
function excludeRuleAsNotInstalled(rule: Rule, detectorId: string, st: St): void {
  const detail =
    `探测器「${detectorId}」判定「${rule.name}」依赖的工具未安装 → 本条地盘不计入可回收（0 字节）。` +
    '这是探测结论，不等于盘上没有东西；判据见 core/rules/detectors.ts'
  // 底账要记下"这块地是被探测结论摘掉的"，界面才分得开「未装但盘上有」与「装了、缓存是空的」
  const led = territoryLedger(rule, st)
  if (led !== null) led.detectorAbsent = true
  for (const pattern of rule.paths) {
    for (const territory of resolveTerritory(pattern, rule, st)) {
      exclude(st, rule.id, territory, 'not-installed', detail)
    }
  }
}

/** 通配展开：`*` 恰好一层目录名，取值一律来自扫描树（不碰磁盘）。 */
function expandStep(dir: string, seg: string, ruleId: string, st: St): string[] {
  const kids = openDir(dir, ruleId, st)
  if (kids === null) return []
  const out: string[] = []
  for (const k of kids) {
    if (k.kind !== 'directory') continue
    // 禁止目录在这里就被点名剔除，连 childrenOf 都不会为它发生 —— 「不可达」的落点
    if (isForbiddenPath(k.path, st.forbiddenRoots) !== null) {
      exclude(st, ruleId, k.path, 'forbidden-root', '命中 §16 🔴 禁止路径 → 不作为候选地盘，未枚举')
      continue
    }
    if (seg === '*') out.push(k.path)
    else if (globToRe(seg).test(baseOf(k.path))) out.push(k.path)
  }
  return out
}

function baseOf(p: string): string {
  const t = segsOf(p)
  return t[t.length - 1] ?? ''
}

/**
 * §3.6 地盘底账的开账处：**只有声明了 `requiresDetector` 的规则进这张表**。
 * 不给别的规则开账不是省内存，是省掉一条谎言 —— 一条与"装没装"无关的规则被记成
 * "残留"，用户读到的是"这个工具没装但还有东西占着"，而那根本不是它的地盘归属语义。
 */
function territoryLedger(rule: Rule, st: St) {
  const det = rule.requiresDetector
  if (typeof det !== 'string' || det.length === 0) return null
  let cur = st.territories.get(rule.id)
  if (cur === undefined) {
    cur = { ruleId: rule.id, detectorAbsent: false, present: new Map(), notScanned: 0 }
    st.territories.set(rule.id, cur)
  }
  return cur
}

/** 一条 paths 模板 → 扫描树上真实存在的地盘清单（可能 0 条）。 */
function resolveTerritory(pattern: string, rule: Rule, st: St): string[] {
  const led = territoryLedger(rule, st)
  const res = resolvePattern(pattern, st.env)
  if (res.base === null && res.unresolvedVar !== undefined) {
    exclude(st, rule.id, pattern, 'unresolved-env', `环境变量 %${res.unresolvedVar}% 未注入，无法定位该路径（不猜、不读真机）`)
    return []
  }
  let frontier: string[] = res.base === null ? [] : [res.base]
  for (const seg of res.rest) {
    if (frontier.length === 0) break
    const next: string[] = []
    for (const dir of frontier) {
      if (seg === '*' || seg.includes('*') || seg.includes('?')) {
        for (const c of expandStep(dir, seg, rule.id, st)) if (!next.includes(c)) next.push(c)
      } else {
        const cand = joinWin(dir, seg)
        const hit = isForbiddenPath(cand, st.forbiddenRoots)
        if (hit !== null) {
          exclude(st, rule.id, cand, 'forbidden-root', `命中 §16 🔴 禁止路径 ${hit} → 不作为候选地盘`)
          continue
        }
        if (st.source.dirIdByPath(cand) === undefined) {
          // 底账只在**真的落了一条排除**时加一格：exclude 会去重，两边必须数同一件事
          if (exclude(st, rule.id, cand, 'not-scanned', '本次扫描没有覆盖该目录（没扫到 ≠ 不存在，按未知处理）') && led !== null) led.notScanned++
          continue
        }
        if (!next.includes(cand)) next.push(cand)
      }
    }
    frontier = next
  }
  // 收尾统一把关：禁止路径 / 禁止根的地盘祖先 / 树上确实存在
  const out: string[] = []
  for (const dir of frontier) {
    const hit = isForbiddenPath(dir, st.forbiddenRoots)
    if (hit !== null) {
      exclude(st, rule.id, dir, 'forbidden-root', `命中 §16 🔴 禁止路径 ${hit} → 地盘不可达`)
      continue
    }
    const swept = st.forbiddenRoots.find(
      (f) => pathIsUnder(f, dir) && normalizeKey(f) !== normalizeKey(dir)
    )
    if (swept !== undefined) {
      exclude(st, rule.id, dir, 'ancestor-of-protected', `地盘 ${dir} 套住了禁止路径 ${swept}，宽容器一律不认（§28 原则四）`)
      continue
    }
    if (st.source.dirIdByPath(dir) === undefined) {
      if (exclude(st, rule.id, dir, 'not-scanned', '本次扫描没有覆盖该目录（没扫到 ≠ 不存在，按未知处理）') && led !== null) led.notScanned++
      continue
    }
    const roHit = reportOnlyBlock(dir, rule, st)
    if (roHit !== null) {
      exclude(st, rule.id, dir, 'report-only-root', `地盘 ${dir} 落在只上报根 ${roHit} 之内 → 非 🔴 规则不许把它当清理范围（要报告占用请走 🔴 规则）`)
      continue
    }
    if (!out.includes(dir)) {
      out.push(dir)
      /**
       * 这块地盘在这棵树上**看到了**。字节取 `sizeOf`（`finalizeDir` 算好的子树合计），
       * 一次文件都不枚举；读面没给 `sizeOf` 时记 `null` = "看到了但没量过"，不是 0。
       * 注意这个数是**整个目录子树**的占用：里面可能有别的规则已认领的文件、也可能有 🔴 路径，
       * 所以界面只能念"这个目录里共 X"，绝不能把它当"可回收"。
       */
      if (led !== null && !led.present.has(dir)) {
        const id = st.source.dirIdByPath(dir)
        led.present.set(dir, id === undefined ? null : st.source.sizeOf?.(id) ?? null)
      }
    }
  }
  return out.sort(cmpPath)
}

/** 在一个地盘里收文件：显式栈遍历（递归会把深树变成栈溢出），禁止目录永不 open。 */
function collectTerritory(root: string, rule: Rule, st: St, agg: Agg): void {
  const stack: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const cur = stack.pop()!
    const key = normalizeKey(cur.path)
    if (visited.has(key)) continue // 树按构造无环，这一层是兜底：任何情况下都不许无限转圈
    visited.add(key)
    const kids = openDir(cur.path, rule.id, st)
    if (kids === null) continue
    for (const k of kids) {
      if (k.kind === 'directory') {
        if (!rule.scanner.recursive) continue
        // 整棵子树按目录级拦掉（而不是逐文件拒绝）：一条宽路径规则套住回收站时，
        // 排除记录只有一条点名到那个目录，不会变成几万条噪声把真正的排除淹没。
        const roHit = reportOnlyBlock(k.path, rule, st)
        if (roHit !== null) {
          exclude(st, rule.id, k.path, 'report-only-root', `整棵子树落在只上报根 ${roHit} 之内 → 不作为本规则的地盘，不认领其中任何文件`)
          continue
        }
        if (cur.depth + 1 > MAX_WALK_DEPTH) {
          exclude(st, rule.id, k.path, 'not-scanned', `超过评估深度上限 ${MAX_WALK_DEPTH}，按未知处理`)
          continue
        }
        stack.push({ path: k.path, depth: cur.depth + 1 })
        continue
      }
      if (k.kind !== 'file') continue
      takeFile(k, rule, st, agg)
    }
  }
}

function takeFile(k: ChildView, rule: Rule, st: St, agg: Agg): void {
  const hit = isForbiddenPath(k.path, st.forbiddenRoots)
  if (hit !== null) {
    // 走到这里说明上层已经漏判（例如禁止根位于文件与目录之间），仍然兜住
    exclude(st, rule.id, k.path, 'forbidden-root', `命中 §16 🔴 禁止路径 ${hit} → 0 字节计入`)
    return
  }
  // §28 原则二的真属性判据：属性证得出 SYSTEM 就保护，与路径长什么样无关
  if (protectedByAttrs(k.attrs)) {
    exclude(st, rule.id, k.path, 'protected-attrs', '文件属性已证明 SYSTEM（§28 原则二）→ 即使路径合法也不进任何清理地盘')
    return
  }
  if (!nameMatches(k.name, rule.scanner.filePatterns)) return
  if (rule.scanner.olderThanDays !== null && k.mtimeMs > st.nowMs - rule.scanner.olderThanDays * DAY_MS) return
  // 「只上报不可删」的兜底闸（上层已按目录拦过，这里是防认领漏判的最后一道）
  const roHit = reportOnlyBlock(k.path, rule, st)
  if (roHit !== null) {
    exclude(st, rule.id, k.path, 'report-only-root', `落在只上报根 ${roHit} 之内 → 占用如实报告，但非 🔴 规则不许认领`)
    return
  }
  const owner = st.claimed.get(normalizeKey(k.path))
  if (owner !== undefined && owner !== rule.id) {
    exclude(st, rule.id, k.path, 'claimed-by-other-rule', `已由规则 ${owner} 计入，不双计（§17 的预估释放空间必须是真的）`)
    return
  }
  st.claimed.set(normalizeKey(k.path), rule.id)
  agg.count++
  agg.bytes += k.size
  agg.paths.push({ path: k.path, size: k.size })
}

/**
 * 任意深度找 leaf（spec §2.2，与 Rust `engine.rs::walk_leaf` 逐条同判据）。五条规矩都在这一段：
 *  · 目录 basename 命中 `leafDirs` → 它就是采集根，收文件走**既有的** `collectTerritory`
 *    （`filePatterns` / `recursive` / `olderThanDays` 一套判据一个都不另立），并且**不再深入**
 *    找第二个命中 —— 里面再有一个 `Cache` 也是同一棵子树，分开收就是同一条规则计两次；
 *  · 文件 basename 命中 `leafFiles` → 就地计，认领判据还是 `takeFile` 那五道
 *    （`nameMatches` 是全仓唯一的一份 glob，plan Global Constraints）；
 *  · 都没命中 → 继续下钻。深度上限只有 `MAX_WALK_DEPTH` 这一把尺子，超限**记下来**而不是静默截掉；
 *  · 重解析点目录跳过、不跟进；围栏在 `openDir()` 那一层拦，所以越栏目录连"被列举"都不发生；
 *  · 子目录 basename 整名命中 `PACKAGE_TREE_NAMES`（第三方代码树）→ **不进入**、记一条
 *    `package-tree` 点名那个目录（M5-P2 P2-T5 裁定 1）。这一条与围栏**同一个形状**：
 *    包树目录不被打开，其中任何东西都不可能被认领 —— 两种 leaf 模式都吃这条判据。
 */
function walkLeaf(dir: string, rule: Rule, depth: number, st: St, out: RuleAgg): void {
  if (out.walked.has(normalizeKey(dir))) return // 两个入口套住同一棵子树 / 某个入口正是上一条命中的 leaf
  out.walked.add(normalizeKey(dir))
  const dirsMode = (rule.scanner.leafDirs ?? []).length > 0
  const filesMode = (rule.scanner.leafFiles ?? []).length > 0
  // 入口自己就命中名单（`paths` 直接写到一个 `Cache` 上）也照收 —— 收完就停，不再往里找
  if (dirsMode && nameMatches(baseOf(dir), rule.scanner.leafDirs ?? [])) {
    if (!out.roots.some((r) => normalizeKey(r) === normalizeKey(dir))) out.roots.push(dir)
    collectTerritory(dir, rule, st, out.agg)
    return
  }
  const kids = openDir(dir, rule.id, st)
  if (kids === null) return
  for (const k of kids) {
    if (k.kind === 'directory') {
      if (isReparsePoint(k)) {
        exclude(
          st,
          rule.id,
          k.path,
          'not-scanned',
          `目录 ${k.path} 是重解析点（FILE_ATTRIBUTE_REPARSE_POINT）→ 不跟进去，与扫描器 SkipReason::Reparse 同一口径`
        )
        continue
      }
      if (depth + 1 > MAX_WALK_DEPTH) {
        exclude(
          st,
          rule.id,
          k.path,
          'not-scanned',
          `超过评估深度上限 ${MAX_WALK_DEPTH}，按未知处理（点名到这一个目录，不是把整条分支静默截掉）`
        )
        continue
      }
      // M5-P2 P2-T5 裁定 1：**包树不进 leaf 采集**（plan §5 末节）。
      // 排在 leafDirs 命中**之前**、`openDir()` 之前 —— 与 `fenceBlocks` 同一个形状：
      // 那一棵子树连"被列举"都不发生，不是"列举完再把里面的命中滤掉"（plan §0.2）。
      // 判据对 `leafDirs` 与 `leafFiles` 两种模式**同时**生效（轮转件与安装包 glob 一样会撞进代码树）。
      const pkgHit = packageTreeHit(k.name)
      if (pkgHit !== null) {
        exclude(
          st,
          rule.id,
          k.path,
          'package-tree',
          `目录 ${k.path} 是第三方代码树（basename 整名命中包树名单 ${pkgHit}）→ 整棵子树不进 leaf 采集，未枚举`
        )
        continue
      }
      if (dirsMode && nameMatches(k.name, rule.scanner.leafDirs ?? [])) {
        // **§6 的 guard**：名字像缓存、但长在用户数据容器里 —— 不枚举、不认领。
        // 排在 leafDirs 命中之后（命中即收）是刻意的：命中之前拦是"不枚举"，命中之后拦是"枚举完再滤"。
        const udl = rule.category === 'app-transient' ? userDataLeafHit(k.name, k.path) : null
        if (udl !== null) {
          exclude(
            st,
            rule.id,
            k.path,
            'user-data-leaf',
            `目录 ${k.path} 的名字是约定缓存名，但它长在用户数据容器里（路径含「${udl}」）→ ` +
              `按 §6 R-DENY-USERDATA / R-DENY-MSACTIVITY 的 guard 整棵不进采集，未枚举：这里装的是登录态 / 配置 / 会话，删掉不是「重下就能回来」`
          )
          continue
        }
        if (!out.roots.some((r) => normalizeKey(r) === normalizeKey(k.path))) out.roots.push(k.path)
        collectTerritory(k.path, rule, st, out.agg)
        continue // 命中即停
      }
      walkLeaf(k.path, rule, depth + 1, st, out)
      continue
    }
    if (k.kind !== 'file') continue
    if (filesMode && nameMatches(k.name, rule.scanner.leafFiles ?? [])) takeFile(k, rule, st, out.agg)
  }
}

function evaluateRule(rule: Rule, st: St): RuleFinding {
  const out: RuleAgg = { agg: { count: 0, bytes: 0, paths: [] }, roots: [], walked: new Set() }
  const dirsMode = (rule.scanner.leafDirs ?? []).length > 0
  const filesMode = (rule.scanner.leafFiles ?? []).length > 0
  const leafMode = dirsMode || filesMode
  // 第三种采集模式（plan §2.4）：声明了机器事实闸的规则，采集根 = 入口的直属子目录。
  // 声明层（`validateRuleSet`）已经保证它**不可能**同时带 `leaf*`（混用 = ambiguous-leaf-mode），
  // 所以这三判据在这里不必再排优先级。与 Rust `engine.rs::evaluate_rule` 同。
  const appFactMode = wantsAbsentAppFact(rule)
  for (const pattern of rule.paths) {
    for (const t of resolveTerritory(pattern, rule, st)) {
      if (appFactMode) {
        collectAppFactEntry(t, rule, st, out)
        continue
      }
      if (leafMode) {
        // leaf 模式的采集面由 `walkLeaf` 决定：
        //  · `leafDirs` → `matchedRoots` 就是命中的那些目录（入口容器不是地盘，
        //    把它列进去等于对用户宣布"我要清整个 AppData\Local"）；
        //  · `leafFiles` → 没有"命中目录"这层概念，根就是被搜过的那一层入口，
        //    次序沿用 `paths` 表序 —— 与非 leaf 规则的 `matchedRoots` 同一个姿态。
        walkLeaf(t, rule, 0, st, out)
        if (!dirsMode && !out.roots.includes(t)) out.roots.push(t)
        continue
      }
      if (!out.roots.includes(t)) out.roots.push(t)
      collectTerritory(t, rule, st, out.agg)
    }
  }
  if (dirsMode || appFactMode) {
    // 命中次序是遍历次序，不是判据；按归一化排一次，两次跑必须同序
    // （多个入口时这一条不是装饰：`paths` 写三条容器根，根数组原本是**按入口分组**的）
    out.roots.sort((a, b) => (normalizeKey(a) < normalizeKey(b) ? -1 : normalizeKey(a) > normalizeKey(b) ? 1 : 0))
  }
  const agg = out.agg
  agg.paths.sort((a, b) => cmpPath(a.path, b.path))
  const listed = agg.paths.slice(0, st.listCap)
  return {
    ruleId: rule.id,
    name: rule.name,
    category: rule.category,
    riskLevel: rule.riskLevel,
    cleanStrategy: rule.cleanStrategy,
    recoverable: rule.recoverable,
    matchedRoots: out.roots,
    samplePaths: listed,
    sampleTruncated: agg.paths.length > listed.length,
    fileCount: agg.count,
    totalBytes: agg.bytes,
    // §18 执行器要的具体清单：只在点名开启时挂上（默认不改变报告形状，Task 16/17 的断言不受影响）
    allPaths: st.collectPathsFor?.has(rule.id) ? agg.paths : undefined
  }
}

export function evaluateRules(o: EvaluateOptions): RuleReport {
  const forbidden = resolvePatterns(o.forbiddenPatterns, o.env)
  const reportOnly = resolvePatterns(o.reportOnlyPatterns ?? REPORT_ONLY_ROOT_PATTERNS, o.env)
  const st: St = {
    source: o.source,
    env: o.env,
    nowMs: o.nowMs,
    forbiddenRoots: forbidden.roots,
    reportOnlyRoots: reportOnly.roots,
    claimed: new Map(),
    exclusions: [],
    seenExclusion: new Set(),
    territories: new Map(),
    listCap: o.maxListedPaths && o.maxListedPaths > 0 ? o.maxListedPaths : 50,
    collectPathsFor: o.collectPathsFor,
    detectorStatus: o.detectorStatus,
    // 每条规则开工前由 `beginRule()` 换成它自己的围栏；这里给的是"还没有规则在看"的那个初值
    fence: { active: false, allow: [], deny: [] },
    appFacts: o.appFacts ?? new Map<string, AppFact>(),
    appFactWhys: o.appFactWhys ?? new Map<string, string>()
  }
  const report = emptyReport(forbidden.roots, reportOnly.roots)

  // fail-safe：🔴 清单自己落不了地，就等于引擎处于"看不见禁止路径"的状态。
  // 这时不许给出任何「可清理」结论 —— 宁可整份报告空着，也不能把 System32 说成能清。
  // 「只上报不可删」那张表没落地也算同一种失明：回收站一旦看不见，宽路径规则就会把它当成普通文件认领。
  const unresolvedAll = [...forbidden.unresolved, ...reportOnly.unresolved]
  if (unresolvedAll.length > 0) {
    const detail = `禁止路径模板无法解析（环境变量缺失）：${unresolvedAll.join('、')} → 保护失效，本次不出结论`
    for (const p of unresolvedAll)
      report.exclusions.push({ ruleId: null, path: p, reason: 'forbidden-root-unresolved', detail })
    report.safetyBlocked = true
    report.rejectedRules = o.rules.map((r) => ({
      ruleId: r.id,
      name: r.name,
      problems: [{ ruleId: r.id, path: unresolvedAll.join('、'), reason: 'forbidden-root-unresolved' as ExclusionReason, detail }]
    }))
    return report
  }

  const v = validateRuleSet(o.rules, {
    env: o.env,
    forbiddenPatterns: o.forbiddenPatterns,
    reportOnlyPatterns: o.reportOnlyPatterns ?? REPORT_ONLY_ROOT_PATTERNS
  })
  const validIds = new Set(v.valid.map((r) => r.id))
  const rejected: RejectedRule[] = []
  for (const p of v.problems) {
    const r = o.rules.find((x) => x.id === p.ruleId)
    if (r === undefined || validIds.has(r.id)) continue
    const owner = rejected.find((x) => x.ruleId === p.ruleId)
    if (owner) owner.problems.push(p)
    else rejected.push({ ruleId: r.id, name: r.name, problems: [p] })
    st.exclusions.push({ ruleId: r.id, path: p.path, reason: 'rule-rejected', detail: `规则被拒（${p.reason}）：${p.detail}` })
  }
  report.rejectedRules = rejected

  const bytesByRisk: Record<Risk, number> = { safe: 0, caution: 0, high: 0, forbidden: 0 }
  for (const rule of v.valid) {
    // 围栏是**按规则**生效的：换规则就得换围栏（带着上一条的围栏跑这一条 = 别人的边界）
    beginRule(rule, st)
    // V0.7 §3.2：工具没装 → 不出 finding、不占字节，但地盘逐条进排除清单（不许静默消失）
    const absent = absentDetector(rule, st)
    if (absent !== null) {
      excludeRuleAsNotInstalled(rule, absent, st)
      continue
    }
    const gated = wantsAbsentAppFact(rule)
    const f = evaluateRule(rule, st)
    // 机器事实一个候选都没批下来：**不出 finding**（与 `not-installed` 同一个形状 ——
    // `findings` 的条数是"哪些规则上表了"这件事，一侧出 0 字节 finding 一侧不出就是两套事实源）。
    // 弃权的原因已经逐条落在 `exclusions[]` 里点名了，这里不是静默消失。
    if (gated && f.matchedRoots.length === 0 && f.fileCount === 0) continue
    report.findings.push(f)
    bytesByRisk[f.riskLevel] += f.totalBytes
    // §16：🔴 禁止的项目照常识别容量，但绝不进「可回收」合计
    if (f.riskLevel !== 'forbidden') report.reclaimableBytes += f.totalBytes
  }
  report.bytesByRisk = bytesByRisk
  // §12「加入清理列表」要按具体文件定位是哪条规则认领了它 —— 用引擎自己那张防双计表，不另立口径
  if (o.reportClaims) report.claimedPaths = st.claimed
  // 排除清单是报告的一等公民（约束 2）：每条都点名到具体路径 + 原因
  report.exclusions = st.exclusions.sort(
    (a, b) =>
      cmpPath(a.ruleId ?? '', b.ruleId ?? '') || cmpPath(a.reason, b.reason) || cmpPath(a.path, b.path)
  )
  /**
   * §3.6 地盘底账收尾：按 ruleId 升序、`present` 按路径升序 —— 同一棵树跑两次必须逐字节相同，
   * 否则"两次报告不一样"会被读成盘上真变了。
   */
  report.territories = [...st.territories.values()]
    .sort((a, b) => cmpPath(a.ruleId, b.ruleId))
    .map((t) => ({
      ruleId: t.ruleId,
      detectorAbsent: t.detectorAbsent,
      present: [...t.present.entries()]
        .sort((a, b) => cmpPath(a[0], b[0]))
        .map(([path, bytes]) => ({ path, bytes })),
      notScanned: t.notScanned
    }))
  return report
}
