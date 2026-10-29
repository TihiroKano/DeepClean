/**
 * Task 16 —— 规则引擎（§15 Cleaner Rule Engine / §16 安全等级）。
 *
 * 本文件有两条安全哨兵，都不测"功能"、只测"漏没漏"：
 * 1. 🔴 **禁止路径不可达（unmatchable）**（第一条）。它不是「匹配上了再过滤掉」—— 测试用的 source
 *    一旦被要求枚举禁止目录就直接 throw，所以「引擎读过了 System32」这件事会以硬失败的形式暴露，
 *    而不是悄悄变成 0 字节看着像对。
 * 2. 🔴 **视图排除不许进计价口径**（文件末尾，Task 7）：`childrenOf` 是规则引擎 / 重复检测 /
 *    扫描报告共用的计价读取面，地图上的「排除该目录」只许改视图。
 *
 * 全部路径来自合成的 env（约束 7）：引擎在本文件里永远看不到真机 C:\，也看不到任何 fs 调用。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TreeStore } from '../../core/scan/tree-store'
import { joinWin, normalizeKey, parentOf } from '../../core/fs/pathutil'
import { buildScanReport } from '../../core/report/scan-report'
import {
  evaluateRules,
  isForbiddenPath,
  pathIsUnder,
  resolvePattern,
  validateRuleSet,
  type RuleTreeSource
} from '../../core/rules/engine'
import type { AppFact, Rule, RuleEnv, RuleScopeFence } from '../../core/rules/types'
import { FENCE_MINIMUM_DENY_PATTERNS, PACKAGE_TREE_NAMES } from '../../core/rules/types'
import { BUILTIN_RULES, FORBIDDEN_PATH_PATTERNS } from '../../core/rules/registry'
import type { ChildView, ScanSnapshot } from '../../shared/types'
import { WIN_ATTR } from '../../shared/classify'

/* ------------------------------------------------------------------ *
 * 合成环境：单测里所有 %VAR% 都指到这里，绝不读真机 process.env
 * ------------------------------------------------------------------ */
const ENV = {
  SYSTEMDRIVE: 'C:\\',
  WINDIR: 'C:\\Windows',
  TEMP: 'C:\\Users\\Kano\\AppData\\Local\\Temp',
  LOCALAPPDATA: 'C:\\Users\\Kano\\AppData\\Local',
  APPDATA: 'C:\\Users\\Kano\\AppData\\Roaming',
  PROGRAMDATA: 'C:\\ProgramData',
  USERPROFILE: 'C:\\Users\\Kano',
  // CLEANUP-RULES §6 之后禁止根模板引用了 `%PROGRAMFILES%\`；缺它会让禁止根解析不出来
  // ⇒ `safetyBlocked` ⇒ 量到的就不是各条用例想量的那件事。
  PROGRAMFILES: 'C:\\Program Files'
} satisfies RuleEnv

/**
 * 从另一侧源码里取出 `<decl> … [ … ]` 那一段的字面量，按**出现次序**（单双引号都认 ——
 * TS 用单引号、Rust 用双引号，同一份解析器两侧复用，免得"两侧各自一套"又漂一次）。
 * `=` 之后的那一个 `[` 才是值：Rust 的 `: [&str; 10]` 与 TS 的 `: readonly string[]`
 * 都发生在 `=` **之前**，按名字找第一个 `[` 会读到类型标注（Rust 侧同名用例第一版就是这么红的）。
 *
 * 找不到声明 / 找不到收尾 `]` / 一个字符串都没有 —— 一律 throw：静默返回空集合会把
 * `the_package_tree_list_is_identical_on_both_sides` 变成恒过的闸。
 * 与 Rust `engine.rs::parse_name_list` 同判据。
 */
function parseNameList(src: string, decl: string, path: string): string[] {
  const at = src.indexOf(decl)
  if (at < 0) throw new Error(`${path} 里找不到 ${decl} —— 那一侧漏了整份名单，这条判据不许退化成只比自己`)
  const eq = src.indexOf('=', at)
  const open = src.indexOf('[', eq + 1)
  const close = src.indexOf(']', open + 1)
  if (eq < 0 || open < 0 || close < 0) throw new Error(`${path} 里 ${decl} 的数组字面量解析不出来`)
  const body = src.slice(open + 1, close)
  const out: string[] = []
  for (let i = 0; i < body.length; i++) {
    const q = body[i]
    if (q !== "'" && q !== '"') continue
    const j = body.indexOf(q, i + 1)
    if (j < 0) throw new Error(`${path} 里 ${decl} 有一个没闭合的引号`)
    out.push(body.slice(i + 1, j))
    i = j
  }
  if (out.length === 0) throw new Error(`${path} 里 ${decl} 解析出空名单 —— 恒过的闸比没有闸更坏`)
  return out
}

/** §16 🔴 清单：System32 / WinSxS / Windows Installer（+ 静默名单里的 SVI）。 */const FORBIDDEN = [
  '%WINDIR%\\System32',
  '%WINDIR%\\WinSxS',
  '%WINDIR%\\Installer',
  '%SYSTEMDRIVE%\\System Volume Information'
]

const DAY = 86_400_000
const NOW = 1_700_000_000_000

interface FileSpec {
  name: string
  size: number
  attrs?: number
  mtimeMs?: number
}

/** 目录路径 → 该目录的直属文件。key 的顺序无所谓，helper 自己补齐祖先链并按深度建树。 */
function storeFrom(spec: Record<string, FileSpec[]>): TreeStore {
  const dirs = allDirs(Object.keys(spec))
  const root = dirs[0]
  if (root === undefined) throw new Error('storeFrom: 至少要有根目录')
  const store = new TreeStore({ rootPath: root, maxFiles: 1_000_000 })
  for (const dir of dirs) {
    const id = store.beginDir(dir)
    const p = parentOf(dir)
    if (p !== null) {
      const pid = store.dirIdByPath(p)
      if (pid !== undefined) store.attachChild(pid, id)
    }
    store.addFilesToDir(
      id,
      (spec[dir] ?? []).map((f) => ({
        name: f.name,
        size: f.size,
        mtimeMs: f.mtimeMs ?? NOW - 30 * DAY,
        birthtimeMs: NOW - 60 * DAY,
        attrs: f.attrs ?? 0
      }))
    )
  }
  store.finalizeDir(store.rootId)
  return store
}

/**
 * 补齐祖先链：真实扫描出来的树里，`C:\a\b` 存在则 `C:\`、`C:\a` 必然也在树上
 * （规则的地盘要靠中间层目录逐级钻下去）。测试里不补这一步等于造出一棵断头树。
 */
function allDirs(keys: string[]): string[] {
  const out = new Set<string>()
  for (const k of keys) {
    let cur = k
    while (cur.length > 0 && !out.has(cur)) {
      out.add(cur)
      const p = parentOf(cur)
      if (p === null || !k.toLowerCase().startsWith(p.toLowerCase())) break
      cur = p
    }
  }
  return [...out].sort((a, b) => depth(a) - depth(b))
}

function depth(p: string): number {
  return p.replace(/\\+$/, '').split('\\').filter(Boolean).length
}

/**
 * 包一层「枚举禁止目录 = 立刻 throw」的 source。
 * 这条断言力度的来源：约束 2 要求禁止路径**不可匹配**，而不是匹配后再滤掉。
 */
function guardedSource(store: TreeStore, forbiddenRoots: readonly string[]) {
  const opened: string[] = []
  const src: RuleTreeSource = {
    rootId: store.rootId,
    dirIdByPath: (p) => store.dirIdByPath(p),
    childrenOf: (id) => {
      const path = store.pathOf(id)
      const hit = isForbiddenPath(path, forbiddenRoots)
      if (hit !== null) throw new Error(`引擎枚举了禁止目录 ${path}（命中 ${hit}）—— 违反「不可达」要求`)
      opened.push(path)
      return store.childrenOf(id)
    }
  }
  return { src, opened }
}

const rule = (over: Partial<Rule> & { id: string; paths: readonly string[] }): Rule => ({
  name: over.id,
  category: 'temp',
  description: '测试规则',
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'safe',
  cleanStrategy: 'delete-all',
  recoverable: false,
  ...over
})

const finding = (report: ReturnType<typeof evaluateRules>, id: string) =>
  report.findings.find((f) => f.ruleId === id)

/**
 * **P2-T4 新增的记账判据**（Rust 侧同名同判据：`engine.rs::assert_every_rule_is_accounted_for`）：
 * 表 22 条、`findings` 却可能只有 21 条 —— 那一格差**必须是可解释的**，否则 `findings.length`
 * 就成了「有一条规则静默消失」的藏身处（本仓为这类失效记过账：被声明层拒掉的规则不出 finding、
 * 也不报错，只把地盘从合计里静默撤走）。
 *
 * 唯一合法的差来自 `engine.ts` 里那一条 `continue`：声明了 `requiresAbsentAppFact` 的规则在
 * **一个候选都没被机器事实表批准**时不出 finding（Rust 同一条 —— 一侧出 0 字节项、一侧不出，
 * 两套实现对"这条规则上没上表"就会给出不同答案）。
 *
 * 于是这里断言两件事，再把"没出 finding 的那几条 id"交回调用方点名：
 * ① 上线数 + 弃权数 == 表长（一条都不许多、也不许少）；
 * ② 掉出 findings 的那条**必须**声明了 `requiresAbsentAppFact`（别的规则掉出去＝静默消失）。
 * "弃权的那条有没有把每个候选都点名"是另一条判据（见
 * `an_empty_app_fact_table_leaves_rule_22_at_zero_bytes_while_naming_every_candidate`），
 * 这里不代它断言：那句只在"三根容器确实在扫描树上"的夹具里才成立。
 */
const assertRulesAccountedFor = (
  report: ReturnType<typeof evaluateRules>,
  rules: readonly Rule[]
): string[] => {
  expect(
    report.rejectedRules.length,
    `内置表被声明层拒了：${JSON.stringify(report.rejectedRules)}`
  ).toBe(0)
  const online = new Set(report.findings.map((f) => f.ruleId))
  expect(online.size, '有规则出了两条 finding（同一条规则计了两遍账）').toBe(report.findings.length)
  const missing = rules.map((r) => r.id).filter((id) => !online.has(id))
  for (const id of missing) {
    const r = rules.find((x) => x.id === id)!
    expect(
      r.requiresAbsentAppFact,
      `规则 ${id} 既没被声明层拒、也没出 finding —— 那就是静默消失，不是弃权`
    ).toBe(true)
  }
  expect(
    online.size + missing.length,
    `上线数 + 弃权数 ≠ 表长（findings=${report.findings.length}，弃权 ${JSON.stringify(missing)}，表 ${rules.length} 条）`
  ).toBe(rules.length)
  return missing
}

describe('🔴 禁止路径：不可达，而不是匹配后再过滤（约束 2 / §16）', () => {
  /**
   * 场景：一条**通配规则** `%WINDIR%\*\Temp`（Windows 下真有这种目录：`Assembly\Temp`、
   * `Microsoft.NET\Temp`），它在语法上完全有能力拐进
   * `C:\Windows\System32\Temp`、`WinSxS\Temp`、`Installer\Temp`，那三个目录下各埋着一个巨无霸文件。
   */
  const store = () =>
    storeFrom({
      'C:\\': [],
      'C:\\Windows': [],
      'C:\\Windows\\Assembly': [],
      'C:\\Windows\\Assembly\\Temp': [{ name: 'log.etl', size: 500 }],
      'C:\\Windows\\System32': [{ name: 'kernel32.dll', size: 900_000 }],
      'C:\\Windows\\System32\\Temp': [{ name: 'do-not-touch.dll', size: 8_000_000 }],
      'C:\\Windows\\System32\\Temp\\Nested': [{ name: 'deeper.dll', size: 700_000 }],
      'C:\\Windows\\WinSxS': [{ name: 'pile.manifest', size: 600_000 }],
      'C:\\Windows\\WinSxS\\Temp': [{ name: 'do-not-touch2.bin', size: 9_000_000 }],
      'C:\\Windows\\Installer': [{ name: 'setup.msi', size: 500_000 }],
      'C:\\Windows\\Installer\\Temp': [{ name: 'do-not-touch3.msp', size: 9_000_000 }],
      'C:\\Windows\\Microsoft.NET': [{ name: 'ok.tmp', size: 300 }],
      'C:\\Windows\\Microsoft.NET\\Temp': [{ name: 'fine.tmp', size: 200 }]
    })

  const sweep = rule({
    id: 'wildcard-sweep',
    name: '通配清扫（故意写得能拐进 System32 的形态）',
    paths: ['%WINDIR%\\*\\Temp'],
    description: '测试用：验证通配展开阶段就被禁止路径挡住'
  })

  it('通配规则伸进 System32 / WinSxS / Installer 的分支贡献 0 字节，被禁目录一次都没被枚举，且留下点名排除记录', () => {
    const s = store()
    const { src, opened } = guardedSource(s, ['C:\\Windows\\System32', 'C:\\Windows\\WinSxS', 'C:\\Windows\\Installer'])
    const report = evaluateRules({ source: src, env: ENV, rules: [sweep], forbiddenPatterns: FORBIDDEN, nowMs: NOW })

    // 1. 字节：只有合法的两个 Temp 分支进账（500 + 200），三个 9MB 陷阱一个字节都没有
    const f = finding(report, 'wildcard-sweep')
    expect(f).toBeDefined()
    expect(f!.totalBytes).toBe(700)
    expect(f!.fileCount).toBe(2)
    // matchedRoots 里绝不允许出现被禁目录的子孙
    expect(f!.matchedRoots).toEqual(['C:\\Windows\\Assembly\\Temp', 'C:\\Windows\\Microsoft.NET\\Temp'])
    // matchedRoots / samplePaths 都按路径升序（报告要可复现，不许依赖 Map 迭代顺序）
    expect(f!.samplePaths.map((p) => p.path)).toEqual([
      'C:\\Windows\\Assembly\\Temp\\log.etl',
      'C:\\Windows\\Microsoft.NET\\Temp\\fine.tmp'
    ])

    // 2. 结构性不可达：guardedSource 已经保证「枚举被禁目录 = throw」，这里再正面确认枚举清单干净
    expect(opened.filter((p) => p.toLowerCase().includes('system32'))).toEqual([])
    expect(opened.filter((p) => p.toLowerCase().includes('winsxs'))).toEqual([])
    expect(opened.filter((p) => p.toLowerCase().includes('installer'))).toEqual([])

    // 3. 点名排除记录：每一处被禁路径都要单独交代
    const excluded = report.exclusions.filter((e) => e.reason === 'forbidden-root').map((e) => e.path)
    expect(new Set(excluded)).toEqual(
      new Set(['C:\\Windows\\System32', 'C:\\Windows\\WinSxS', 'C:\\Windows\\Installer'])
    )
    // 排除记录必须挂着「哪条规则、为什么」
    for (const e of report.exclusions.filter((x) => x.reason === 'forbidden-root')) {
      expect(e.ruleId).toBe('wildcard-sweep')
      expect(e.detail).toContain('禁止')
    }
    expect(report.reclaimableBytes).toBe(700)
  })

  it('规则字面路径直接写在禁止目录里面 → 整条规则被拒绝，连 finding 都不产生（声明层就不可达）', () => {
    const s = store()
    const { src } = guardedSource(s, ['C:\\Windows\\System32'])
    const bad = rule({ id: 'in-system32', paths: ['%WINDIR%\\System32\\CatRoot2'], name: '错误报告缓存（假设性）' })
    const report = evaluateRules({ source: src, env: ENV, rules: [bad], forbiddenPatterns: FORBIDDEN, nowMs: NOW })
    expect(finding(report, 'in-system32')).toBeUndefined()
    expect(report.rejectedRules.map((r) => r.ruleId)).toContain('in-system32')
    const problem = report.rejectedRules[0]!.problems[0]!
    expect(problem.reason).toBe('forbidden-root')
    expect(problem.path).toBe('%WINDIR%\\System32\\CatRoot2')
  })

  it('被 SYSTEM 属性证明的文件即使路径完全合法也拿不到一个字节，并点名排除；只读/无属性的正常计入', () => {
    const s = storeFrom({
      'C:\\': [],
      'C:\\Users\\Kano\\AppData\\Local\\Temp': [
        { name: 'a.tmp', size: 1000 },
        { name: 'b.log', size: 2000 },
        { name: 'guard.sys', size: 999_999, attrs: WIN_ATTR.system },
        { name: 'hidden-sys.bin', size: 888_888, attrs: WIN_ATTR.hidden | WIN_ATTR.system },
        { name: 'readonly.txt', size: 3000, attrs: WIN_ATTR.readonly },
        { name: 'unknown-attrs.bin', size: 4000, attrs: 0 }
      ]
    })
    const { src } = guardedSource(s, ['C:\\Windows\\System32'])
    const report = evaluateRules({
      source: src,
      env: ENV,
      rules: [rule({ id: 'win-temp', paths: ['%TEMP%'], name: 'Windows 临时文件' })],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    const f = finding(report, 'win-temp')!
    // 只有两个 SYSTEM 位被证出来的文件出局（属性只收紧、不放松）；READONLY 与 0 都正常计入
    expect(f.totalBytes).toBe(1000 + 2000 + 3000 + 4000)
    expect(f.fileCount).toBe(4)
    const attrsEx = report.exclusions.filter((e) => e.reason === 'protected-attrs')
    expect(attrsEx.map((e) => e.path).sort()).toEqual([
      'C:\\Users\\Kano\\AppData\\Local\\Temp\\guard.sys',
      'C:\\Users\\Kano\\AppData\\Local\\Temp\\hidden-sys.bin'
    ])
    // 目录属性本轮不采（attrs=null）→ 不该被误判成受保护，也不该被当"已证明无属性"
    expect(f.matchedRoots).toEqual(['C:\\Users\\Kano\\AppData\\Local\\Temp'])
  })

  it('未知属性位（attrs=0）不等于「不是系统文件」：计入但不声称安全', () => {
    const s = storeFrom({
      'C:\\': [],
      'C:\\Users\\Kano\\AppData\\Local\\Temp': [{ name: 'plain.tmp', size: 10, attrs: 0 }]
    })
    const { src } = guardedSource(s, [])
    const report = evaluateRules({
      source: src,
      env: ENV,
      rules: [rule({ id: 'win-temp', paths: ['%TEMP%'] })],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    expect(finding(report, 'win-temp')!.totalBytes).toBe(10)
    // 排除记录里没有任何 protected-attrs —— 引擎没有拿"读不到"当"没有"
    expect(report.exclusions.filter((e) => e.reason === 'protected-attrs')).toEqual([])
  })
})

describe('§28 原则四：清理范围必须精确到叶子路径', () => {
  it('AppData / 用户目录根这类宽容器规则被拒绝，AppData\\Local\\Temp 这类叶子目录通过', () => {
    const bad = rule({ id: 'too-broad-appdata', paths: ['%LOCALAPPDATA%'], name: '整个 Local' })
    const bad2 = rule({ id: 'too-broad-roaming', paths: ['%APPDATA%'], name: '整个 Roaming' })
    const bad3 = rule({ id: 'too-broad-windir', paths: ['%WINDIR%'], name: '整个 Windows' })
    const bad4 = rule({ id: 'user-root', paths: ['%USERPROFILE%'], name: '整个用户目录' })
    const good = rule({ id: 'win-temp', paths: ['%TEMP%'], name: 'Windows 临时文件' })
    const v = validateRuleSet([bad, bad2, bad3, bad4, good], { env: ENV, forbiddenPatterns: FORBIDDEN })
    expect(v.valid.map((r) => r.id)).toEqual(['win-temp'])
    expect(v.problems.map((p) => p.ruleId).sort()).toEqual([
      'too-broad-appdata',
      'too-broad-roaming',
      'too-broad-windir',
      'user-root'
    ])
    for (const p of v.problems) {
      expect(p.reason === 'broad-container' || p.reason === 'ancestor-of-protected').toBe(true)
    }
    // 宽容器规则必须两条判据都覆盖：既是容器（AppData/Local/Roaming），又能当祖先（Windows）
    expect(v.problems.some((p) => p.reason === 'broad-container')).toBe(true)
    expect(v.problems.some((p) => p.reason === 'ancestor-of-protected')).toBe(true)
  })

  it('A 规则的地盘包含 B 规则的地盘 → A 被拒（宽容器会顺手扫走别人的精确叶子）', () => {
    const broad = rule({ id: 'microsoft-dir', paths: ['%LOCALAPPDATA%\\Microsoft'], name: 'Microsoft 整个目录' })
    const leaf = rule({ id: 'thumbcache', paths: ['%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer'], name: '缩略图缓存' })
    const v = validateRuleSet([broad, leaf], { env: ENV, forbiddenPatterns: FORBIDDEN })
    expect(v.valid.map((r) => r.id)).toEqual(['thumbcache'])
    const p = v.problems.find((x) => x.ruleId === 'microsoft-dir')!
    expect(p.reason).toBe('ancestor-of-protected')
    expect(p.detail).toContain('thumbcache')
  })

  it('通配地盘也算祖先：写在 %LOCALAPPDATA%\\Google 上会顺手扫走 Chrome 缓存的叶子 → 拒', () => {
    const greedy = rule({ id: 'google-dir', paths: ['%LOCALAPPDATA%\\Google'], name: 'Google 整个目录' })
    const chrome = rule({ id: 'chrome-cache', paths: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Cache'] })
    const v = validateRuleSet([greedy, chrome], { env: ENV, forbiddenPatterns: FORBIDDEN })
    expect(v.valid.map((r) => r.id)).toEqual(['chrome-cache'])
    const p = v.problems.find((x) => x.ruleId === 'google-dir')!
    expect(p.reason).toBe('ancestor-of-protected')
    expect(p.detail).toContain('chrome-cache')
  })

  it('以通配收尾的规则不落在叶子上 → 拒', () => {
    const ends = rule({ id: 'ends-star', paths: ['%LOCALAPPDATA%\\Microsoft\\Windows\\*'] })
    const v = validateRuleSet([ends], { env: ENV, forbiddenPatterns: FORBIDDEN })
    expect(v.valid).toEqual([])
    expect(v.problems[0]!.reason).toBe('pattern-not-leaf')
  })
})

/**
 * M5-P1 T1 —— 声明层围栏闸（plan §6-T1）。六条用例与 Rust `validate.rs` 的同名单测逐条对照，
 * kebab 理由串走 `rejectedRules` 线格式，由 `m3-parity.json` 的 `fence` 用例两侧点名。
 * 守的坑（plan §0.1）：`leafDirs: ["Cache"]` 无围栏会立刻吃到 Program Files 里应用自带运行时资源 ——
 * 围栏写进声明层闸，不靠约定；缺围栏的规则整条拒进 `rejectedRules`，不在评估时悄悄滤命中。
 */
describe('M5-P1 声明层围栏闸（leaf* + scopeFence 必须同时出现）', () => {
  const ENV8: RuleEnv = { ...ENV, PROGRAMFILES: 'C:\\Program Files' }
  /**
   * 一条覆盖足够的 denyRoots：**禁止根全集 ∪ 地板**。
   *
   * ⚠️ 2026-10-20：CLEANUP-RULES §6 之后 `FORBIDDEN` 从 6 条涨到 17 条、地板从 4 条涨到 5 条
   * （多出 `%LOCALAPPDATA%\Programs\*`）。手抄清单每涨一次就要跟着改，忘了就是一片
   * `inadequate-fence`（本条用例前身实测红过一次）。改成**展开**，让"表涨了、夹具没跟"不可能发生 ——
   * 与 Rust `validate.rs::tests::full_fence` 同一写法。去重是因为地板里那几条与禁止根同形。
   */
  const FULL_DENY = [...new Set([...FORBIDDEN, ...FENCE_MINIMUM_DENY_PATTERNS])]
  const fence = (deny: readonly string[] = FULL_DENY, allow: readonly string[] = ['%LOCALAPPDATA%']) => ({
    allowRoots: allow,
    denyRoots: deny
  })
  const leafScanner = (over: Record<string, unknown>) => ({
    filePatterns: [],
    olderThanDays: null,
    recursive: true,
    ...over
  })
  const check = (r: Rule) => validateRuleSet([r], { env: ENV8, forbiddenPatterns: FORBIDDEN })

  it('a_container_path_without_leaf_predicate_is_refused', () => {
    // 只给围栏、不给 leaf 判据：容器入口照样没有形状判据 ⇒ 整条拒（spec §2.3）
    const wide = rule({
      id: 'wide',
      paths: ['%LOCALAPPDATA%'],
      scanner: leafScanner({ scopeFence: fence() }) as Rule['scanner']
    })
    const v = check(wide)
    expect(v.valid).toEqual([])
    expect(v.problems[0]!.reason).toBe('container-without-predicate')
    // 通配收尾同样算"非叶子入口"
    const tail = rule({
      id: 'tail',
      paths: ['%LOCALAPPDATA%\\*'],
      scanner: leafScanner({ scopeFence: fence() }) as Rule['scanner']
    })
    expect(check(tail).problems[0]!.reason).toBe('container-without-predicate')
    // 反向半边：不带围栏也不带 leaf 的旧规则，理由必须逐字保留（不许被新名字顶掉）
    const legacy = rule({ id: 'legacy', paths: ['%LOCALAPPDATA%'] })
    expect(validateRuleSet([legacy], { env: ENV, forbiddenPatterns: FORBIDDEN }).problems[0]!.reason).toBe(
      'broad-container'
    )
  })

  it('a_leaf_rule_without_a_fence_is_refused', () => {
    const dirs = rule({ id: 'leaf-dirs', paths: ['%LOCALAPPDATA%\\app'], scanner: leafScanner({ leafDirs: ['Cache'] }) as Rule['scanner'] })
    const files = rule({ id: 'leaf-files', paths: ['%LOCALAPPDATA%\\app'], scanner: leafScanner({ leafFiles: ['*.?.log'] }) as Rule['scanner'] })
    for (const r of [dirs, files]) {
      const v = check(r)
      expect(v.problems[0]!.reason, r.id).toBe('inadequate-fence')
      expect(v.valid, r.id).toEqual([])
    }
  })

  it('a_fence_must_encompass_every_forbidden_root', () => {
    // 拿掉必需 deny 中的任何一条 → 覆盖判据失败 → inadequate-fence（整条拒，不是补默认值）。
    //
    // ⚠️ 靶子只取**独占**那几条：CLEANUP-RULES §6 之后 `FULL_DENY` 里有若干同根写法
    // （禁止根的 `%PROGRAMFILES%\` 与地板的 `%PROGRAMFILES%\*`），删掉其一仍被另一条覆盖 ——
    // 那不是漏洞（两条解析到同一目录、保护范围一样），但拿它当靶子会得到一条恒绿的空判据。
    // 与 Rust `validate.rs::a_fence_must_encompass_every_forbidden_root` 同一份靶子。
    const EXCLUSIVE = [
      '%WINDIR%\\*',
      '%SYSTEMDRIVE%\\System Volume Information',
      '%PROGRAMDATA%\\Microsoft\\Windows Defender\\*',
      '%LOCALAPPDATA%\\Programs\\*'
    ]
    for (const drop of EXCLUSIVE) {
      expect(FULL_DENY, `靶子 ${drop} 不在 FULL_DENY 里 = 这条判据是空转`).toContain(drop)
      const r = rule({
        id: `thin-${drop.length}`,
        paths: ['%LOCALAPPDATA%'],
        scanner: leafScanner({ leafDirs: ['Cache'], scopeFence: fence(FULL_DENY.filter((d) => d !== drop)) }) as Rule['scanner']
      })
      const v = check(r)
      expect(v.problems[0]!.reason, `drop ${drop}`).toBe('inadequate-fence')
    }
    // 空 allowRoots 的围栏等于没有采集口径
    const noAllow = rule({
      id: 'no-allow',
      paths: ['%LOCALAPPDATA%'],
      scanner: leafScanner({ leafDirs: ['Cache'], scopeFence: fence(FULL_DENY, []) }) as Rule['scanner']
    })
    expect(check(noAllow).problems[0]!.reason).toBe('inadequate-fence')
  })

  it('leaf_dirs_and_leaf_files_together_are_refused', () => {
    // §10 裁定 1：两种采集根语义混用 = 拒，围栏齐全也一样（这条闸排在围栏闸之前）
    const both = rule({
      id: 'both',
      paths: ['%LOCALAPPDATA%\\app'],
      scanner: leafScanner({ leafDirs: ['Cache'], leafFiles: ['*.?.log'], scopeFence: fence() }) as Rule['scanner']
    })
    const v = check(both)
    expect(v.problems[0]!.reason).toBe('ambiguous-leaf-mode')
    expect(v.valid).toEqual([])
  })

  /**
   * P2-T3（plan §2.5 / §3-P2-T3）Rust 侧同名两条闸的 TS 孪生
   * （`crates/rules/src/validate.rs::requires_absent_app_fact_with_leaf_dirs_is_refused` /
   * `an_app_fact_rule_must_be_a_container_entry_with_a_covering_fence`，`0ad9df2` 落的）。
   * 这两条闸守的都是**删除方向**：第三种采集模式的采集根 = 入口的全部直属子目录，
   * 让一张机器事实表去批准整棵用户目录树（表错一格就收走别人家的运行时资源）是它最坏的失效形状。
   */
  it('requires_absent_app_fact_with_leaf_dirs_is_refused', () => {
    // 机器事实闸自己就是一种采集模式 ⇒ 与 leafDirs/leafFiles 互斥，围栏齐全也一样
    const withDirs = check(
      rule({
        id: 'af-with-dirs',
        paths: ['%LOCALAPPDATA%'],
        requiresAbsentAppFact: true,
        scanner: leafScanner({ leafDirs: ['Cache'], scopeFence: fence() }) as Rule['scanner']
      })
    )
    expect(withDirs.problems[0]!.reason, 'leafDirs + requiresAbsentAppFact 混给必须整条拒').toBe('ambiguous-leaf-mode')
    expect(withDirs.valid).toEqual([])
    const withFiles = check(
      rule({
        id: 'af-with-files',
        paths: ['%LOCALAPPDATA%'],
        requiresAbsentAppFact: true,
        scanner: leafScanner({ leafFiles: ['*.?.log'], scopeFence: fence() }) as Rule['scanner']
      })
    )
    expect(withFiles.problems[0]!.reason, 'leafFiles 同样互斥').toBe('ambiguous-leaf-mode')
    // 顺序也钉：混用时先报「两种采集模式混给」而不是「缺围栏」（那条更准，且 Rust 同序）
    const bothWrong = check(
      rule({
        id: 'af-both-wrong',
        paths: ['%LOCALAPPDATA%'],
        requiresAbsentAppFact: true,
        scanner: leafScanner({ leafDirs: ['Cache'] }) as Rule['scanner']
      })
    )
    expect(bothWrong.problems[0]!.reason, '互斥闸排在围栏闸之前').toBe('ambiguous-leaf-mode')
    // 反向半边：只给闸、不给 leaf* 且围栏齐全 ⇒ 这两条闸都不许顺手拒掉它（否则 P2-T4 那条上不了表）
    const clean = check(
      rule({
        id: 'af-clean',
        paths: ['%LOCALAPPDATA%'],
        requiresAbsentAppFact: true,
        scanner: leafScanner({ scopeFence: fence() }) as Rule['scanner']
      })
    )
    expect(clean.problems, JSON.stringify(clean.problems)).toEqual([])
    expect(clean.valid.length).toBe(1)
  })

  it('an_app_fact_rule_must_be_a_container_entry_with_a_covering_fence', () => {
    const noFence = check(
      rule({
        id: 'af-no-fence',
        paths: ['%LOCALAPPDATA%'],
        requiresAbsentAppFact: true,
        scanner: leafScanner({}) as Rule['scanner']
      })
    )
    expect(noFence.problems[0]!.reason, '带机器事实闸却没有围栏 ⇒ 整条拒').toBe('inadequate-fence')
    expect(noFence.valid).toEqual([])
    expect(noFence.problems[0]!.detail, '理由要说清"没有围栏等于让表批准整个用户目录树"').toContain('scopeFence')
    // 围栏齐但 deny 覆盖不足 ⇒ 同一条 inadequate-fence（走 validateFence，口径与 leaf 那一族共用）
    const thinFence = check(
      rule({
        id: 'af-thin-fence',
        paths: ['%LOCALAPPDATA%'],
        requiresAbsentAppFact: true,
        scanner: leafScanner({
          scopeFence: fence(FULL_DENY.filter((d) => !d.includes('(x86)')))
        }) as Rule['scanner']
      })
    )
    expect(thinFence.problems[0]!.reason, '围栏覆盖不足也要整条拒').toBe('inadequate-fence')
  })

  it('fence_roots_are_not_held_to_the_broad_leaf_rule', () => {
    // §4.3 的不对称：`programdata` 在 BROAD_LEAF_NAMES 里、`%WINDIR%\*` 是通配收尾 ——
    // 按地盘判据两条都拒；围栏天然就要点名这些容器，validate_fence 不走那两条，只查
    // 绝对/非盘符根/通配形态 + deny 覆盖。若有人"顺手统一"，这条当场红。
    const r = rule({
      id: 'asym',
      paths: ['%LOCALAPPDATA%', '%PROGRAMDATA%'],
      scanner: leafScanner({
        leafDirs: ['Cache'],
        scopeFence: fence([...FULL_DENY, '%PROGRAMDATA%'], ['%LOCALAPPDATA%', '%PROGRAMDATA%'])
      }) as Rule['scanner']
    })
    const v = check(r)
    expect(v.problems, '围栏根被地盘判据拒了 —— §4.3 的不对称被"顺手统一"回去了').toEqual([])
    expect(v.valid.length).toBe(1)
  })

  it('a_parenthesised_literal_deny_root_passes_shape_check', () => {
    // §4.2 裁定：32 位根走 %SYSTEMDRIVE%\Program Files (x86)\*（括号不在形状判据的禁用字符集里），
    // 不新增带括号变量键。正反两半都钉：这条根认得下，且它不是装饰 —— 拿掉它，覆盖判据当场失效
    //（段边界上 `Program Files` 套不住 `Program Files (x86)`）。
    const ok = check(
      rule({
        id: 'paren',
        paths: ['%LOCALAPPDATA%'],
        scanner: leafScanner({ leafDirs: ['Cache'], scopeFence: fence() }) as Rule['scanner']
      })
    )
    expect(ok.problems).toEqual([])
    expect(ok.valid.length).toBe(1)
    const noParen = check(
      rule({
        id: 'no-paren',
        paths: ['%LOCALAPPDATA%'],
        scanner: leafScanner({
          leafDirs: ['Cache'],
          scopeFence: fence(FULL_DENY.filter((d) => !d.includes('(x86)')))
        }) as Rule['scanner']
      })
    )
    expect(noParen.problems[0]!.reason).toBe('inadequate-fence')
  })
})

describe('评估：命中集合与排除清单（约束 1：只吃已扫好的树）', () => {
  const tree = () =>
    storeFrom({
      'C:\\': [],
      'C:\\Users\\Kano\\AppData\\Local\\Temp': [
        { name: 'old.tmp', size: 1000, mtimeMs: NOW - 40 * DAY },
        { name: 'fresh.tmp', size: 2000, mtimeMs: NOW - 1 * DAY },
        { name: 'note.txt', size: 30 }
      ],
      'C:\\Users\\Kano\\AppData\\Local\\Temp\\sub': [{ name: 'deep.tmp', size: 400, mtimeMs: NOW - 40 * DAY }],
      'C:\\Users\\Kano\\AppData\\Local\\Microsoft\\Windows\\Explorer': [
        { name: 'thumbcache_1.db', size: 700 },
        { name: 'thumbcache_2.db', size: 800 },
        { name: 'iconcache_1.db', size: 900 },
        { name: 'desktop.ini', size: 10 }
      ],
      'C:\\Users\\Kano\\AppData\\Local\\D3DSCache': [{ name: 'shader.bin', size: 5000 }],
      'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache': [
        { name: 'f_000001', size: 6000 }
      ],
      'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 1\\Cache': [
        { name: 'f_000002', size: 600 }
      ],
      'C:\\$Recycle.Bin\\S-1-5-21-1': [{ name: '$Iabc.docx', size: 12345 }]
    })

  it('文件名 glob + recursive 一起生效：只收 thumbcache_*.db，不碰同目录的 iconcache / desktop.ini', () => {
    const { src } = guardedSource(tree(), ['C:\\Windows\\System32'])
    const report = evaluateRules({
      source: src,
      env: ENV,
      rules: [
        rule({
          id: 'thumbcache',
          paths: ['%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer'],
          scanner: { filePatterns: ['thumbcache_*.db'], olderThanDays: null, recursive: false }
        })
      ],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    const f = finding(report, 'thumbcache')!
    expect(f.totalBytes).toBe(1500)
    expect(f.samplePaths.map((p) => p.path).sort()).toEqual([
      'C:\\Users\\Kano\\AppData\\Local\\Microsoft\\Windows\\Explorer\\thumbcache_1.db',
      'C:\\Users\\Kano\\AppData\\Local\\Microsoft\\Windows\\Explorer\\thumbcache_2.db'
    ])
  })

  it('recursive=false 时子目录不进账；true 时子树进账', () => {
    const mk = (recursive: boolean): Rule =>
      rule({
        id: recursive ? 'rec' : 'nonrec',
        paths: ['%TEMP%'],
        scanner: { filePatterns: ['*.tmp'], olderThanDays: null, recursive }
      })
    const a = evaluateRules({
      source: guardedSource(tree(), []).src,
      env: ENV,
      rules: [mk(false)],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    const b = evaluateRules({
      source: guardedSource(tree(), []).src,
      env: ENV,
      rules: [mk(true)],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    expect(finding(a, 'nonrec')!.totalBytes).toBe(3000)
    expect(finding(b, 'rec')!.totalBytes).toBe(3400)
  })

  it('olderThanDays 按注入的 nowMs 判定，绝不在单测里读时钟', () => {
    const r = rule({
      id: 'stale-temp',
      paths: ['%TEMP%'],
      scanner: { filePatterns: ['*.tmp'], olderThanDays: 7, recursive: true },
      cleanStrategy: 'delete-older-than'
    })
    const report = evaluateRules({
      source: guardedSource(tree(), []).src,
      env: ENV,
      rules: [r],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    const f = finding(report, 'stale-temp')!
    expect(f.totalBytes).toBe(1000 + 400)
    expect(f.samplePaths.map((p) => p.path)).toContain('C:\\Users\\Kano\\AppData\\Local\\Temp\\old.tmp')
    // 被时间窗挡掉的不是"排除"而是"没命中"：报告里不该出现 fresh.tmp 的排除记录
    expect(report.exclusions.find((e) => e.path.endsWith('fresh.tmp'))).toBeUndefined()
  })

  it('env 里没这个变量 / 目录根本没扫到 → 各自留下点名的排除记录，字节为 0 而不是编造', () => {
    const { src } = guardedSource(tree(), [])
    const report = evaluateRules({
      source: src,
      // 故意只缺 PROGRAMDATA（这条用例要测的就是它）：**禁止根自己需要的变量必须给全**，
      // 否则 `%PROGRAMFILES%\` / `%USERPROFILE%\.codex` 一族解析不出 ⇒ `safetyBlocked`
      // ⇒ 报告整体不出结论，那时量到的就不是 `unresolved-env` 这条判据了
      // （CLEANUP-RULES §6 之后禁止根模板多引用了 PROGRAMFILES / USERPROFILE / APPDATA）。
      // 故意缺一个**规则自己用到的**变量（`HOMEDRIVE`），而**禁止根需要的变量必须给全**：
      // CLEANUP-RULES §6 之后 `%PROGRAMDATA%\Package Cache` 是禁止根，缺它会让禁止根解析不出来
      // → `forbidden-root-unresolved` 的 fail-safe 先把整份报告拦掉（正确的保护行为，
      // 但那时量到的就不是 `unresolved-env` 这条判据了）。
      env: {
        TEMP: ENV.TEMP,
        LOCALAPPDATA: ENV.LOCALAPPDATA,
        WINDIR: ENV.WINDIR,
        SYSTEMDRIVE: ENV.SYSTEMDRIVE,
        APPDATA: ENV.APPDATA,
        PROGRAMDATA: ENV.PROGRAMDATA,
        USERPROFILE: ENV.USERPROFILE,
        PROGRAMFILES: ENV.PROGRAMFILES
      },
      rules: [
        // 用 `HOMEDRIVE` 而不是 `%PROGRAMDATA%`：CLEANUP-RULES §6 之后 `%PROGRAMDATA%\Package Cache`
        // 是**禁止根**，缺它会让禁止根解析不出来 → `forbidden-root-unresolved` 的 fail-safe
        // 先把整份报告拦掉（那是正确的保护行为，但量到的就不是 `unresolved-env` 这条判据了）。
        // `HOMEDRIVE` 既不在禁止根里、也不在本台的注入表里，正好只触发规则自己那一条。
        rule({ id: 'no-var', paths: ['%HOMEDRIVE%\\No\\Such\\Var'] }),
        rule({ id: 'not-scanned', paths: ['%TEMP%\\NeverScanned'] }),
        rule({ id: 'missing-dir', paths: ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default\\Cache'] })
      ],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    // 先证这条规则**真的在了**（没 finding 时下面的逐条点名会退化成空转）
    const noVar = finding(report, 'no-var')
    expect(noVar, `no-var 没产生 finding；被拒的规则：${JSON.stringify(report.rejectedRules)}`).toBeDefined()
    expect(noVar!.totalBytes).toBe(0)
    const unresolved = report.exclusions.filter((e) => e.reason === 'unresolved-env')
    expect(unresolved.map((e) => e.path)).toEqual(['%HOMEDRIVE%\\No\\Such\\Var'])
    expect(unresolved[0]!.detail).toContain('HOMEDRIVE')
    const notScanned = report.exclusions.filter((e) => e.reason === 'not-scanned')
    expect(notScanned.length).toBeGreaterThanOrEqual(2)
    expect(notScanned.map((e) => e.ruleId).sort()).toEqual(['missing-dir', 'not-scanned'])
    // 没有任何一条 finding 凭空报出字节
    for (const f of report.findings) expect(f.totalBytes).toBe(0)
  })

  it('fail-safe：禁止路径自己解析不出来时整体不出结论，而不是"失去保护照旧开卖"', () => {
    const { src } = guardedSource(tree(), [])
    const report = evaluateRules({
      source: src,
      // WINDIR 缺失 → `%WINDIR%\System32` 这条保护根落不了地
      env: { TEMP: ENV.TEMP, SYSTEMDRIVE: ENV.SYSTEMDRIVE },
      rules: [rule({ id: 'win-temp', paths: ['%TEMP%'] })],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    expect(report.safetyBlocked).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.reclaimableBytes).toBe(0)
    expect(report.exclusions.filter((e) => e.reason === 'forbidden-root-unresolved').length).toBeGreaterThan(0)
    expect(report.rejectedRules[0]!.problems[0]!.reason).toBe('forbidden-root-unresolved')
  })

  it('两条规则抢同一个文件：先声明的规则计账，后者点名排除，总量不双计', () => {
    const { src } = guardedSource(tree(), [])
    const report = evaluateRules({
      source: src,
      env: ENV,
      rules: [
        rule({ id: 'first', paths: ['%LOCALAPPDATA%\\D3DSCache'] }),
        rule({ id: 'second', paths: ['%LOCALAPPDATA%\\D3DSCache'] })
      ],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    expect(finding(report, 'first')!.totalBytes).toBe(5000)
    expect(finding(report, 'second')!.totalBytes).toBe(0)
    const ex = report.exclusions.filter((e) => e.reason === 'claimed-by-other-rule')
    expect(ex.map((e) => e.path)).toEqual(['C:\\Users\\Kano\\AppData\\Local\\D3DSCache\\shader.bin'])
    expect(ex[0]!.ruleId).toBe('second')
    expect(ex[0]!.detail).toContain('first')
    expect(report.reclaimableBytes).toBe(5000)
  })

  it('通配展开按扫描树走：Chrome 两个 profile 的 Cache 都命中，且各自出现在 matchedRoots 里', () => {
    const { src } = guardedSource(tree(), [])
    const report = evaluateRules({
      source: src,
      env: ENV,
      rules: [
        rule({
          id: 'chrome-cache',
          paths: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Cache'],
          riskLevel: 'safe'
        })
      ],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    const f = finding(report, 'chrome-cache')!
    expect(f.totalBytes).toBe(6600)
    expect(f.matchedRoots).toEqual([
      'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache',
      'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 1\\Cache'
    ])
  })

  it('🔴 风险等级的规则照常识别容量，但不进 reclaimable 合计（§16：禁止走普通清理）', () => {
    const { src } = guardedSource(tree(), [])
    const report = evaluateRules({
      source: src,
      env: ENV,
      rules: [
        rule({ id: 'recycle', paths: ['%SYSTEMDRIVE%\\$Recycle.Bin'], riskLevel: 'forbidden', cleanStrategy: 'manual-only', recoverable: true }),
        rule({ id: 'win-temp', paths: ['%TEMP%'] })
      ],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    expect(finding(report, 'recycle')!.totalBytes).toBe(12345)
    expect(report.bytesByRisk.forbidden).toBe(12345)
    expect(report.bytesByRisk.safe).toBe(3430)
    expect(report.reclaimableBytes).toBe(3430)
  })

  it('引擎只读：评估前后 TreeStore 的三条计数一字不动（§35.2 口径不漂移）', () => {
    const s = tree()
    const before = { ...s.stats(), bytes: s.sizeOf(s.rootId) }
    const report = evaluateRules({
      source: s,
      env: ENV,
      rules: [
        rule({ id: 'win-temp', paths: ['%TEMP%'] }),
        rule({ id: 'thumbcache', paths: ['%LOCALAPPDATA%\\Microsoft\\Windows\\Explorer'], scanner: { filePatterns: ['*.db'], olderThanDays: null, recursive: false } })
      ],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    expect(report.findings.length).toBe(2)
    expect({ ...s.stats(), bytes: s.sizeOf(s.rootId) }).toEqual(before)
    // 传 TreeStore 本身当 source（结构满足 RuleTreeSource），不需要适配器
    expect(typeof s.childrenOf).toBe('function')
  })

  it('采样路径有条数上限，但 fileCount / totalBytes 始终是全量口径', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `f${i}.tmp`, size: 10 }))
    const { src } = guardedSource(storeFrom({ 'C:\\': [], 'C:\\Users\\Kano\\AppData\\Local\\Temp': many }), [])
    const report = evaluateRules({
      source: src,
      env: ENV,
      rules: [rule({ id: 'win-temp', paths: ['%TEMP%'] })],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW,
      maxListedPaths: 50
    })
    const f = finding(report, 'win-temp')!
    expect(f.fileCount).toBe(250)
    expect(f.totalBytes).toBe(2500)
    expect(f.samplePaths.length).toBe(50)
    expect(f.sampleTruncated).toBe(true)
  })
})

/* ------------------------------------------------------------------ *
 * 「只上报不可删」根（§16 回收站那处冲突的落地，人类伙伴 2026-09-26 定的口径）。
 *
 * 它和禁止根的区别只有一件事：**目录照常枚举、占用如实报告**，但没有任何非 🔴 规则能把它认领成自己的地盘。
 * 这条必须结构性成立 —— 在它之前，回收站不被清理靠的是「`recycle-bin` 规则自己 riskLevel='forbidden'
 * 且恰好排在 `BUILTIN_RULES` 第 6」，也就是声明顺序；把一条宽路径规则插在它前面就会退回去。
 * ------------------------------------------------------------------ */
describe('只上报不可删根：占用如实报告，认领一律拒绝（结构性，不依赖规则声明顺序）', () => {
  /** 回收站埋雷：两条规则都会走到它头上，🔴 那条要报告、🟢 那条必须一无所获。 */
  const binStore = () =>
    storeFrom({
      'C:\\': [],
      'C:\\$Recycle.Bin': [],
      'C:\\$Recycle.Bin\\S-1-5-21-1': [
        { name: '$Iabc.docx', size: 12345 },
        { name: '$Rabc.docx', size: 40000 }
      ],
      'C:\\Users\\Kano': [],
      'C:\\Users\\Kano\\AppData': [],
      'C:\\Users\\Kano\\AppData\\Local': [],
      'C:\\Users\\Kano\\AppData\\Local\\Temp': [{ name: 'junk.tmp', size: 1000 }]
    })

  it('非 🔴 规则把只上报根写成地盘 → 声明层即拒（不进入评估）', () => {
    const v = validateRuleSet(
      [
        rule({ id: 'recycle-sweep', paths: ['%SYSTEMDRIVE%\\$Recycle.Bin\\S-1-5-21-1'], riskLevel: 'caution' }),
        rule({ id: 'win-temp', paths: ['%TEMP%'] })
      ],
      { env: ENV, forbiddenPatterns: FORBIDDEN }
    )
    expect(v.valid.map((r) => r.id)).toEqual(['win-temp'])
    expect(v.problems.find((p) => p.ruleId === 'recycle-sweep')?.reason).toBe('report-only-root')
  })

  it('同一条规则改成 🔴 → 声明层放行，且如实报告 52,345 字节但不进 reclaimable（§16「要显示、要计容量、归 🔴」）', () => {
    const { src } = guardedSource(binStore(), [])
    const report = evaluateRules({
      source: src,
      env: ENV,
      rules: [rule({ id: 'recycle', paths: ['%SYSTEMDRIVE%\\$Recycle.Bin'], riskLevel: 'forbidden', cleanStrategy: 'manual-only' })],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    expect(finding(report, 'recycle')!.totalBytes).toBe(52345)
    expect(finding(report, 'recycle')!.fileCount).toBe(2)
    expect(report.bytesByRisk.forbidden).toBe(52345)
    expect(report.reclaimableBytes).toBe(0)
    // ⚠️ 用 `toContain` 而不是 `toEqual`：CLEANUP-RULES §6 之后只上报根从 1 条（回收站）
    // 涨到 12 条（+ 用户级 Programs + `%APPDATA%` / `%LOCALAPPDATA%` 下那一族）。
    // 本条量的是「回收站被当成只上报根」，不是「只上报根恰好只有一条」——
    // 后者由 Rust `engine.rs::protection_roots_are_reported_resolved_and_sorted` 逐条点名。
    expect(report.reportOnlyRoots).toContain('C:\\$Recycle.Bin')
  })

  it('🟢 规则排在 🔴 之前也抢不走回收站：它被拒，🔴 那条照旧报告全量（防护不再取决于谁先声明）', () => {
    const { src, opened } = guardedSource(binStore(), [])
    const report = evaluateRules({
      source: src,
      env: ENV,
      // 声明顺序刻意反过来：这条 🟢 规则与 🔴 那条**地盘完全相同**（相等允许共存，祖先关系才会互相拒），
      // 唯一区别就是它排在前面 —— 旧的顺序依赖在这里会退回去，新的结构闸不会
      rules: [
        rule({ id: 'bin-sweep', paths: ['%SYSTEMDRIVE%\\$Recycle.Bin'], riskLevel: 'safe' }),
        rule({ id: 'recycle', paths: ['%SYSTEMDRIVE%\\$Recycle.Bin'], riskLevel: 'forbidden', cleanStrategy: 'manual-only' })
      ],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    expect(finding(report, 'bin-sweep')).toBeUndefined()
    expect(report.rejectedRules.map((r) => r.ruleId)).toEqual(['bin-sweep'])
    expect(finding(report, 'recycle')!.totalBytes).toBe(52345)
    expect(report.reclaimableBytes).toBe(0)
    // 回收站里的字节只出现在 🔴 那条名下；opened 里出现过目录 ≠ 被认领
    expect(opened.some((p) => p.toLowerCase().includes('$recycle.bin'))).toBe(true)
    expect(report.findings.filter((f) => f.totalBytes > 0).map((f) => f.ruleId)).toEqual(['recycle'])
  })

  it('只上报根被 🟢 规则的地盘套住 → 整棵子树不认领，且那棵子树根本不会被下钻', () => {
    const store = storeFrom({
      'C:\\Users\\Kano\\AppData\\Local\\Temp': [{ name: 'a.tmp', size: 100 }],
      'C:\\Users\\Kano\\AppData\\Local\\Temp\\Protected': [{ name: 'do-not-claim.tmp', size: 900 }]
    })
    const { src, opened } = guardedSource(store, [])
    const report = evaluateRules({
      source: src,
      env: ENV,
      rules: [rule({ id: 'win-temp', paths: ['%TEMP%'] })],
      forbiddenPatterns: FORBIDDEN,
      reportOnlyPatterns: ['%TEMP%\\Protected'],
      nowMs: NOW
    })
    const f = finding(report, 'win-temp')!
    expect({ bytes: f.totalBytes, files: f.fileCount }).toEqual({ bytes: 100, files: 1 })
    expect(opened).not.toContain('C:\\Users\\Kano\\AppData\\Local\\Temp\\Protected')
    const ex = report.exclusions.filter((e) => e.reason === 'report-only-root')
    expect(ex.length).toBe(1)
    expect(ex[0]!.path).toBe('C:\\Users\\Kano\\AppData\\Local\\Temp\\Protected')
  })

  it('只上报根模板自己解析不出来（env 缺 SYSTEMDRIVE）→ 整份报告 safetyBlocked，不给任何可清理结论', () => {
    const { src } = guardedSource(binStore(), [])
    // SYSTEMDRIVE 整个键缺失 → `%SYSTEMDRIVE%\$Recycle.Bin` 这条只上报保护落不了地
    const env: RuleEnv = { TEMP: ENV.TEMP, WINDIR: ENV.WINDIR, LOCALAPPDATA: ENV.LOCALAPPDATA }
    const report = evaluateRules({
      source: src,
      env,
      rules: [rule({ id: 'recycle', paths: ['%SYSTEMDRIVE%\\$Recycle.Bin'], riskLevel: 'forbidden' })],
      forbiddenPatterns: ['%WINDIR%\\System32'],
      nowMs: NOW
    })
    expect(report.safetyBlocked).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.exclusions.some((e) => e.path === '%SYSTEMDRIVE%\\$Recycle.Bin')).toBe(true)
  })
})

describe('工具函数', () => {
  it('pathIsUnder 走段边界，C:\\Windows\\Temples 不算 C:\\Windows\\Temp 的子孙', () => {
    expect(pathIsUnder('C:\\Windows\\System32\\drivers', 'C:\\Windows\\System32')).toBe(true)
    expect(pathIsUnder('c:\\windows\\system32', 'C:\\WINDOWS\\System32\\')).toBe(true)
    expect(pathIsUnder('C:\\Windows\\Temples\\x', 'C:\\Windows\\Temp')).toBe(false)
    expect(pathIsUnder('C:\\Windows', 'C:\\Windows')).toBe(true)
    expect(pathIsUnder('D:\\Data', 'C:\\Windows')).toBe(false)
  })

  it('isForbiddenPath 回命中的禁止根，未命中回 null', () => {
    const roots = ['C:\\Windows\\System32', 'C:\\Windows\\WinSxS']
    expect(isForbiddenPath('C:\\Windows\\System32\\config\\sam', roots)).toBe('C:\\Windows\\System32')
    expect(isForbiddenPath('C:\\Windows\\WinSxS', roots)).toBe('C:\\Windows\\WinSxS')
    expect(isForbiddenPath('C:\\Windows\\Temp', roots)).toBeNull()
    expect(isForbiddenPath('', roots)).toBeNull()
  })
})

describe('§18 交给执行器的全量清单（collectPathsFor）', () => {
  /**
   * §18 的执行器只能吃**具体路径**，而报告默认只回显 `maxListedPaths` 条采样。
   * 补清单的两条路都不可接受：「再走一遍磁盘」违反 §28 原则一，
   * 「调用方自己另写一套过滤器」会和规则口径分叉 —— 所以由引擎把已经算过的那份交出去，
   * 本组用例钉死它的全量性质与「禁止路径不可达」性质。
   */
  const store = () =>
    storeFrom({
      'C:\\Users\\Kano\\AppData\\Local\\Temp': [
        { name: 'a.tmp', size: 10 },
        { name: 'b.tmp', size: 20 },
        { name: 'c.tmp', size: 30 }
      ],
      'C:\\Users\\Kano\\AppData\\Local\\Temp\\sub': [{ name: 'd.tmp', size: 40 }],
      'C:\\Windows': [],
      'C:\\Windows\\Assembly': [],
      'C:\\Windows\\Assembly\\Temp': [
        { name: 'log.etl', size: 500 },
        { name: 'do-not-touch.dll', size: 9_000_000 }
      ],
      'C:\\Windows\\System32': [{ name: 'kernel32.dll', size: 9_000_000 }]
    })
  const winTemp = rule({ id: 'win-temp', paths: ['%TEMP%'], name: 'Windows 临时文件' })

  it('默认不带 allPaths：报告形状与 Task 16/17 一字不差，日常预览不多挂一条路径', () => {
    const report = evaluateRules({ source: store(), env: ENV, rules: [winTemp], forbiddenPatterns: FORBIDDEN, nowMs: NOW })
    const f = finding(report, 'win-temp')!
    expect(f.fileCount).toBe(4)
    expect(f.allPaths).toBeUndefined()
  })

  it('点名后 allPaths 是全量：条数=fileCount、字节和=totalBytes，且不受采样上限影响', () => {
    const report = evaluateRules({
      source: store(),
      env: ENV,
      rules: [winTemp],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW,
      maxListedPaths: 1,
      collectPathsFor: new Set(['win-temp'])
    })
    const f = finding(report, 'win-temp')!
    expect(f.samplePaths.length).toBe(1)
    expect(f.sampleTruncated).toBe(true)
    expect(f.allPaths!.length).toBe(f.fileCount)
    expect(f.allPaths!.reduce((a, p) => a + p.size, 0)).toBe(f.totalBytes)
    expect(f.allPaths!.map((p) => p.path)).toEqual([
      'C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp',
      'C:\\Users\\Kano\\AppData\\Local\\Temp\\b.tmp',
      'C:\\Users\\Kano\\AppData\\Local\\Temp\\c.tmp',
      'C:\\Users\\Kano\\AppData\\Local\\Temp\\sub\\d.tmp'
    ])
  })

  it('没点名的规则拿不到清单；禁止目录里的文件结构性地进不了清单', () => {
    const s = store()
    const { src } = guardedSource(s, ['C:\\Windows\\System32'])
    const report = evaluateRules({
      source: src,
      env: ENV,
      // 通配一层：`%WINDIR%\*\Temp` —— 语法上能够到 System32\Temp，实际一条都到不了
      rules: [
        rule({ id: 'sweep', name: '宽扫', paths: ['%WINDIR%\\*\\Temp'], scanner: { filePatterns: ['*.etl'], olderThanDays: null, recursive: true } }),
        winTemp
      ],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW,
      collectPathsFor: new Set(['sweep'])
    })
    const swept = finding(report, 'sweep')!
    expect(swept.allPaths!.map((p) => p.path)).toEqual(['C:\\Windows\\Assembly\\Temp\\log.etl'])
    expect(swept.allPaths!.some((p) => /system32/i.test(p.path))).toBe(false)
    // 只点名的规则有清单，另一条没有 —— 不为没人要的东西占内存
    expect(finding(report, 'win-temp')!.allPaths).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ *
 * 🔴 Task 7 安全哨兵 —— 地图上的「排除该目录」是**视图**动作，永远不许碰计价口径。
 *
 * 为什么这条比那个功能本身重要：`TreeStore.childrenOf()` 是**计价**路径，两个消费者都靠它拿
 * **完整**子清单 —— 规则引擎（`core/rules/engine.ts:371`）、
 * 扫描 JSON 报告（`core/report/scan-report.ts:152`）。视图排除一旦漏进 `childrenOf`，
 * 用户就能「把某个目录从地图上藏掉」而清理预估照旧为它的文件计价并删除 ——
 * 那是隐藏式误删的形状，本 app 最坏的一种失败。所以本条在同一份 store 上把两条计价口径
 * 各跑两遍（排除前 / 排除后），要求**每个数字一字不变**，
 * 再用一句反证（视图口径确实少了一项、而 `childrenOf` 一项不少）钉住"排除真的生效了" ——
 * 否则那三个「相等」只是因为什么都没发生。
 *
 * 变异证明（写这条测试时真跑过，证据与还原记录见 task-7-report）：
 * - M1 把过滤从 `levelOf` 挪进 `childrenOf` → 本条 **5 处全红**（childrenOf 少了一项、排除记账变 0、
 *   三条计价口径的预估/报告/重复组数字全部改变）。
 * - M2 让排除什么都不做（`levelOf` 忽略入参）→ 本条红在**反证**那一处：三条「相等」在"什么都没发生"时
 *   是空话，所以那条反证不是装饰。
 * - M3 让扫描根也能被排除 → `tree-store-view` / `scanner` 那两条根用例红。
 * ------------------------------------------------------------------ */
describe('🔴 安全哨兵：视图排除不改变计价口径的任何一个数字（Task 7）', () => {
  /**
   * 夹具的三处设计都不是装饰：
   * - 规则地盘写成**通配** `%LOCALAPPDATA%\*\Temp`，而不是字面 `%TEMP%`。字面路径的规则拿
   *   `dirIdByPath` 直接落在地盘上，**不经过父亲的 children 清单** —— 那种夹具下"排除漏进 childrenOf"
   *   这一整类变异打不到规则引擎（本条就是这么改的：第一版用 `%TEMP%`，泄漏时前两条断言照样绿）。
   *   通配必须逐级下钻，藏掉中间层 `Microsoft` 就等于把 1,100 字节的预估抹成 0。
   * - 被排除的那个 `Microsoft` 里面有一份与 Documents 那份同尺寸的文件 → 重复检测会成组，
   *   第二条计价口径（它从根一路走下来）也看得见泄漏。
   * - 三条口径共用同一棵树、同一个 `nowMs`，所以两次跑出来的东西应当**逐字节相同**。
   */
  const pricedTree = (): TreeStore =>
    storeFrom({
      'C:\\': [],
      'C:\\Users\\Kano\\AppData\\Local\\Microsoft\\Temp': [
        { name: 'a.tmp', size: 100 },
        { name: 'copy.bin', size: 1000 }
      ],
      'C:\\Users\\Kano\\Documents': [{ name: 'original.docx', size: 1000 }]
    })

  const priceRules = (store: TreeStore): string => {
    const { src } = guardedSource(store, [])
    const report = evaluateRules({
      source: src,
      env: ENV,
      rules: [rule({ id: 'wild-temp', paths: ['%LOCALAPPDATA%\\*\\Temp'], name: '各应用 Temp（通配）' })],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW,
      maxListedPaths: 50,
      reportClaims: true
    })
    return JSON.stringify({
      reclaimableBytes: report.reclaimableBytes,
      bytesByRisk: report.bytesByRisk,
      claimedPaths: report.claimedPaths?.size ?? -1,
      findings: report.findings.map((f) => [
        f.ruleId,
        f.totalBytes,
        f.fileCount,
        f.matchedRoots,
        f.samplePaths.map((p) => [p.path, p.size])
      ]),
      exclusions: report.exclusions.map((e) => [e.ruleId, e.reason, e.path, e.detail])
    })
  }

  /**
   * 扫描 JSON 报告：整份比（`nowMs` / `elapsedMs` 都是注入的常量，所以两次跑出来应当逐字节相同）。
   * `maxDepth` 必须显式给到 6：默认那档只到 3 层，本夹具的地盘在 `C:\Users\Kano\AppData\Local\Microsoft\Temp`，
   * 按默认裁剪时那棵子树**根本不在报告的 tree 里**，泄漏也就打不到这条口径（第一版就是这么漏的）。
   */
  const priceReport = (store: TreeStore): string => {
    const snapshot: ScanSnapshot = {
      scanId: 'sentinel',
      root: 'C:\\',
      status: 'completed',
      currentPath: 'C:\\',
      elapsedMs: 1,
      startedAtMs: NOW - 1,
      finishedAtMs: NOW,
      truncated: store.truncated,
      ...store.stats()
    }
    return JSON.stringify(
      buildScanReport({ snapshot, source: store, topFiles: [], appVersion: 'test', nowMs: NOW, maxDepth: 6, topPerLevel: 12 })
    )
  }

  /**
   * ~~`ScanService.dupSource` 同款适配器~~ 重复文件检测（§20）下线后这一段跟着删：
   * 三条计价口径现在剩两条（规则引擎 + JSON 报告），判据本身一个字没松 ——
   * 「视图排除不许污染任何计价口径」这件事，剩下这两路照样量得出来。
   */

  it('排除一个藏着规则地盘的中间层：规则引擎 / JSON 报告两条计价口径每个数字都不动', async () => {
    const store = pricedTree()
    const midId = store.dirIdByPath('C:\\Users\\Kano\\AppData\\Local\\Microsoft')
    const localId = store.dirIdByPath('C:\\Users\\Kano\\AppData\\Local')
    if (midId === undefined || localId === undefined) throw new Error('夹具没建出 Local\\Microsoft')

    const rulesBefore = priceRules(store)
    const reportBefore = priceReport(store)
    // 排除**之前**先立底：这一份预估确实有东西可算（1,100 字节）。
    // 少了这一行，"两条路前后全为 0 且互相相等"那种空转夹具就能冒充通过。
    expect(JSON.parse(rulesBefore) as { reclaimableBytes: number }).toMatchObject({ reclaimableBytes: 1100 })

    store.setViewExcluded(midId, true)

    // —— 直接守卫：`childrenOf` 是计价读取面，视图集合不许出现在它里面（漏进去这条立刻红）。
    //    这一组也全用 soft：本条测试的读者要一次看全"漏进去之后到底坏了哪几件事"。
    expect.soft(store.childrenOf(localId).map((c) => c.name)).toContain('Microsoft')
    expect.soft(store.sizeOf(localId), '父级容量必须是完整子树合计，排除不许改写任何 size').toBe(1100)
    expect.soft(store.sizeOf(midId)).toBe(1100)
    // —— 反证：排除**确实生效了**，生效在视图口径上（`levelOf` 少一项）。
    //    少了这一段，下面两条「相等」会因为"什么都没发生"而空过。
    const view = store.levelOf(localId, 10, new Set([midId]))
    expect.soft(view.children.map((c) => c.name)).not.toContain('Microsoft')
    expect.soft([view.excludedCount, view.excludedBytes], '被藏掉的容量必须点名').toEqual([1, 1100])
    // —— 两条计价口径前后一字不变。用 soft：两条都要报，别在第一条红之后就停手，
    //    那样"哪几条消费者被污染了"这个信息就丢了（本条变异实测：M1 一次报出 5 处，三条口径全在其中）。
    const rulesAfter = priceRules(store)
    const reportAfter = priceReport(store)
    expect.soft(rulesAfter, '规则引擎预估（reclaimableBytes / bytesByRisk / claimedPaths / findings / exclusions）').toBe(rulesBefore)
    expect.soft(reportAfter, '扫描 JSON 报告（整份：counters + tree + 速度）').toBe(reportBefore)
  })
})

/**
 * V0.7 Task 3 Step 1–3 —— `requiresDetector` × `detectorStatus`：工具没装的规则不计账，
 * 但它每一条地盘都要在 `exclusions[]` 里点名。
 *
 * 这条轴真正的风险不是"少报"，是**静默**：少报一块容量和把整条规则弄丢，在读数上长得一样。
 * 所以下面每组都同时钉两件事 —— 账上没了（0 finding / 0 字节 / 不进 reclaimable），
 * 并且 exclusions 里逐路径多出一条 `not-installed`。
 *
 * 探针全是注入的假表（E 条 5）：本文件不许起进程、也不许碰真机 env。
 */
describe('V0.7 requiresDetector：未安装的规则不计账，但地盘逐条点名', () => {
  const tree = () =>
    storeFrom({
      'C:\\': [],
      'C:\\Users\\Kano\\.gradle\\caches': [{ name: 'dep.jar', size: 4000 }],
      'C:\\Users\\Kano\\.gradle\\caches\\modules': [{ name: 'deep.jar', size: 1000 }],
      'C:\\Users\\Kano\\AppData\\Roaming\\Code\\Cache': [{ name: 'f1', size: 700 }],
      'C:\\Users\\Kano\\AppData\\Roaming\\Code\\CachedData': [{ name: 'f2', size: 800 }],
      'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache': [{ name: 'c1', size: 600 }],
      'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 1\\Cache': [{ name: 'c2', size: 300 }],
      'C:\\Users\\Kano\\AppData\\Local\\Temp': [{ name: 't.tmp', size: 500 }]
    })

  const gradleRule = rule({
    id: 'gradle-cache',
    paths: ['%USERPROFILE%\\.gradle\\caches'],
    category: 'dev-cache',
    riskLevel: 'caution',
    requiresDetector: 'gradle'
  })
  /** 两条 paths → 未安装时必须出**两条**排除记录，一条"总数"不算（types.ts:166 那条注释） */
  const vscodeRule = rule({
    id: 'vscode-cache',
    paths: ['%APPDATA%\\Code\\Cache', '%APPDATA%\\Code\\CachedData'],
    category: 'dev-cache',
    riskLevel: 'caution',
    requiresDetector: 'vscode'
  })
  /** 通配展开出两个 profile 的地盘 → 未安装时仍然逐条点名，不许合并成"这条规则没装" */
  const chromeRule = rule({
    id: 'chrome-profile-cache',
    paths: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\Cache'],
    category: 'browser-cache',
    requiresDetector: 'chrome'
  })
  /** 本次改动最重要的对照组：一条**没写** requiresDetector 的规则。 */
  const plainTemp = rule({ id: 'windows-temp', paths: ['%TEMP%'] })

  const run = (rules: readonly Rule[], detectorStatus?: Map<string, boolean>) =>
    evaluateRules({
      source: guardedSource(tree(), []).src,
      env: ENV,
      rules,
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW,
      reportClaims: true,
      ...(detectorStatus ? { detectorStatus } : {})
    })

  const absent = new Map([
    ['gradle', false],
    ['vscode', false],
    ['chrome', false]
  ])

  it('未安装的规则一条 finding 都不出，字节一律不进账', () => {
    const report = run([gradleRule, vscodeRule, chromeRule, plainTemp], absent)
    expect(finding(report, 'gradle-cache')).toBeUndefined()
    expect(finding(report, 'vscode-cache')).toBeUndefined()
    expect(finding(report, 'chrome-profile-cache')).toBeUndefined()
    // 唯一进账的是没声明探测器的那条（500），🟡 那一档因为三条都被摘掉而归于 0
    expect(report.reclaimableBytes).toBe(500)
    expect(report.bytesByRisk.caution).toBe(0)
    expect(report.findings.map((f) => f.ruleId)).toEqual(['windows-temp'])
    // 防双计那张表里也不该有它们的地盘
    expect(report.claimedPaths?.size).toBe(1)
  })

  it('exclusions[] 逐路径点名 not-installed：两条 paths 出两条、通配展开几条出几条', () => {
    const report = run([gradleRule, vscodeRule, chromeRule, plainTemp], absent)
    const ex = report.exclusions.filter((e) => e.reason === 'not-installed')
    expect(ex.map((e) => e.path).sort()).toEqual(
      [
        'C:\\Users\\Kano\\.gradle\\caches',
        'C:\\Users\\Kano\\AppData\\Roaming\\Code\\Cache',
        'C:\\Users\\Kano\\AppData\\Roaming\\Code\\CachedData',
        'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache',
        'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 1\\Cache'
      ].sort()
    )
    expect(ex.map((e) => e.ruleId).sort()).toEqual(
      ['chrome-profile-cache', 'chrome-profile-cache', 'gradle-cache', 'vscode-cache', 'vscode-cache']
    )
    // 每条都点名是哪个探测器说的 —— 只写"这条没装"，下次就分不清是接线写错还是真没装
    const detectorIdOf = new Map([
      ['gradle-cache', 'gradle'],
      ['vscode-cache', 'vscode'],
      ['chrome-profile-cache', 'chrome']
    ])
    for (const e of ex) {
      expect(e.detail).toContain('未安装')
      expect(e.detail).toContain(detectorIdOf.get(e.ruleId!)!)
    }
    // 地盘里的文件根本没被枚举过（零字节不是"枚举完再丢弃"）
    expect(report.exclusions.some((e) => e.path.endsWith('dep.jar'))).toBe(false)
  })

  it('回归轴：没写 requiresDetector 的规则，带不带探测表整份报告逐字节相同', () => {
    const rules = [plainTemp, gradleRule, vscodeRule]
    const untouched = rules.filter((r) => r.requiresDetector === undefined)
    // ① 全是没写它的规则：探测表说什么都与不传表一字不差
    const base = JSON.stringify(run(untouched))
    expect(JSON.stringify(run(untouched, new Map([['gradle', false], ['vscode', false], ['npm', false]])))).toBe(base)
    // ② 关键的那一半：规则**写了** requiresDetector，但表里没这个 id → 与不传表逐字节相同
    expect(JSON.stringify(run(rules, new Map([['npm', false]])))).toBe(JSON.stringify(run(rules)))
    const report = run(rules, new Map([['npm', false]]))
    expect(finding(report, 'gradle-cache')?.totalBytes).toBe(5000)
    expect(finding(report, 'vscode-cache')?.totalBytes).toBe(1500)
  })

  it('探测表说已装 → 与不传表逐字节相同（评估路径上没有任何东西因探测器而改变）', () => {
    const rules = [gradleRule, vscodeRule, chromeRule, plainTemp]
    const installed = new Map([
      ['gradle', true],
      ['vscode', true],
      ['chrome', true]
    ])
    expect(JSON.stringify(run(rules, installed))).toBe(JSON.stringify(run(rules)))
  })

  it('表里缺这个 id 按已安装处理：宁可多报，也不让一条真容量被坏掉的探测器藏起来', () => {
    const report = run([gradleRule], new Map([['totally-unrelated', false]]))
    expect(finding(report, 'gradle-cache')?.totalBytes).toBe(5000)
    expect(report.findings.map((f) => f.ruleId)).toEqual(['gradle-cache'])
    expect(report.exclusions.filter((e) => e.reason === 'not-installed')).toEqual([])
  })

  it('未安装只摘掉声明了探测器的那几条，其余 finding 与字节一字不动', () => {
    const all = run([gradleRule, vscodeRule, chromeRule, plainTemp])
    const withoutGradle = run([gradleRule, vscodeRule, chromeRule, plainTemp], new Map([['gradle', false]]))
    expect(finding(withoutGradle, 'gradle-cache')).toBeUndefined()
    for (const id of ['vscode-cache', 'chrome-profile-cache', 'windows-temp']) {
      const before = finding(all, id)!
      const after = finding(withoutGradle, id)!
      expect([after.ruleId, after.totalBytes, after.fileCount, after.matchedRoots]).toEqual([
        before.ruleId,
        before.totalBytes,
        before.fileCount,
        before.matchedRoots
      ])
    }
    expect(withoutGradle.reclaimableBytes).toBe(all.reclaimableBytes - 5000)
  })

  /**
   * Step 4 补的第一条：`absent` 那组用例断言的是「没有 finding、字节少了」，可这两件事
   * **规则被形状闸整条拒掉**时也同样成立（变异 5b 就把 requiresDetector 当成非法字段 ——
   * 那一刻 6 条 V0.7 用例里只红 4 条，"不计账"那条反而照绿）。所以这里把原因钉死：
   * 账少是因为探测说不装，不是因为规则没进评估。
   */
  it('未安装的那份报告里一条规则都不许被拒：不计账的原因只能是探测结论', () => {
    const report = run([gradleRule, vscodeRule, chromeRule, plainTemp], absent)
    expect(report.rejectedRules.map((r) => r.ruleId)).toEqual([])
    expect(report.exclusions.filter((e) => e.reason === 'rule-rejected')).toEqual([])
    // 三条被摘掉的规则确实进过评估（被拒的话 validateRuleSet 那一层就把它们拦了）
    expect(report.exclusions.filter((e) => e.reason === 'not-installed').map((e) => e.ruleId).sort()).toEqual([
      'chrome-profile-cache',
      'chrome-profile-cache',
      'gradle-cache',
      'vscode-cache',
      'vscode-cache'
    ])
  })

  /**
   * Step 4 补的第二条（第 7 项裁定）：调用方**压根没跑探测**（`undefined`）与跑了一次拿到**空表**
   * （`new Map()`）必须逐字节同解 —— 都是"没有任何探测结论"，不许有隐式分支把其中一个当成未装。
   */
  it('不传探测表与传一张空 Map 是同一种状态：都按已装评估，报告逐字节相同', () => {
    const rules = [gradleRule, vscodeRule, chromeRule, plainTemp]
    const withoutTable = run(rules)
    const emptyTable = run(rules, new Map())
    expect(JSON.stringify(emptyTable)).toBe(JSON.stringify(withoutTable))
    expect(emptyTable.findings.map((f) => f.ruleId)).toEqual([
      'gradle-cache',
      'vscode-cache',
      'chrome-profile-cache',
      'windows-temp'
    ])
    expect(emptyTable.exclusions.filter((e) => e.reason === 'not-installed')).toEqual([])
    // 空表 ≠ 「全都判成未装」：字节合计必须与不传表完全一致
    expect(emptyTable.reclaimableBytes).toBe(withoutTable.reclaimableBytes)
  })
})

/**
 * M5-P1 T2 —— 任意深度 leaf 遍历 + 围栏在枚举边界上拦（plan §6-T2）。
 *
 * 与 Rust `crates/rules/src/engine.rs` 的 `mod tests` 同名用例逐条对照：同一棵树、同一份 env、
 * 同一组规则形状、同一套期望数字。**夹具里每条近失形状都不是装饰**，全部来自 plan §5 的三条排除项
 * 与 spec §6.2 的反例表 —— `Packages`（UWP 每应用状态）、`HiviewPlatform.log`（在写、无 `.N`）、
 * `.git\objects` 与无点前缀的 `git\objects`、`crx_cache` vs 名单里的 `component_crx_cache`、
 * `C:\Local\Programs\...`（用户级 Programs 里应用自带的运行时，围栏 deny 的那一条）、
 * 重解析点目录、一条 210 层的深链。少一条 = 那条判据没被钉住。
 *
 * 两条安全哨兵与本文件开头同源：`guardedSource` 一旦被要求枚举禁止目录就 throw，
 * 这里再把围栏外的目录一并交给它当"不可达"名单 —— 于是"越栏目录被枚举了"会以硬失败的形式暴露，
 * 而不是悄悄变成 0 字节看着像对。
 */
describe('M5-P1 T2：walk_leaf 任意深度 + 围栏不枚举 + 机器事实注入面', () => {
  /** 与 Rust `leaf_env()` 逐键同值 —— 回归轴的基线串两侧必须能各自复现。 */
  const LEAF_ENV: RuleEnv = {
    SYSTEMDRIVE: 'C:\\',
    WINDIR: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    LOCALAPPDATA: 'C:\\Local',
    APPDATA: 'C:\\Roam',
    PROGRAMDATA: 'C:\\ProgramData',
    PROGRAMFILES: 'C:\\Program Files',
    USERPROFILE: 'C:\\Users\\Kano'
  }
  /** §16 全集（从 registry 拿，避免测试自己抄一份就变成第三套口径）。 */
  const FORBIDDEN_ALL = [...FORBIDDEN_PATH_PATTERNS]

  /**
   * denyRoots ⊇ 禁止根全集 ∪ `FENCE_MINIMUM_DENY_PATTERNS`，外加用户级 `Programs`。
   *
   * ⚠️ 2026-10-20：CLEANUP-RULES §6 之后禁止根涨到 17 条（含 `%USERPROFILE%\.codex` 一族）。
   * 手抄清单会漏（前身实测漏掉 `Programs` 与 `.codex` 各红过一次），所以**展开**：
   * 与 Rust `engine.rs::tests::leaf_fence` 同一写法。
   */
  const LEAF_FENCE = (): RuleScopeFence => ({
    allowRoots: ['%LOCALAPPDATA%', '%APPDATA%', '%PROGRAMDATA%'],
    denyRoots: [...new Set([...FORBIDDEN_ALL, ...FENCE_MINIMUM_DENY_PATTERNS, '%LOCALAPPDATA%\\Programs\\*'])]
  })

  /** plan §5.1 那 12 个 Chromium/Electron 约定名（T3 才上表，这里当夹具输入用）。 */
  const CACHE_LEAVES = [
    'Cache',
    'Code Cache',
    'GPUCache',
    'ShaderCache',
    'GrShaderCache',
    'DawnCache',
    'DawnGraphiteCache',
    'DawnWebGPUCache',
    'CachedData',
    'blob_storage',
    'CacheStorage',
    'component_crx_cache'
  ]
  const UPDATER_LEAVES = ['*updater', '*Updater', 'pending', 'Update', 'updates']
  const INSTALLER_PATTERNS = [
    '*.exe',
    '*.msi',
    '*.msp',
    '*.nupkg',
    '*.appx',
    '*.msix',
    '*.zip',
    '*.7z',
    '*.rar',
    '*.iso'
  ]
  const ROTATED_PATTERNS = ['*.?.log', '*.log.??', '*.etl']

  const LEAF_PATHS = ['%LOCALAPPDATA%', '%APPDATA%', '%PROGRAMDATA%']

  const leafRule = (id: string, over: Record<string, unknown>): Rule =>
    rule({
      id,
      name: id,
      paths: LEAF_PATHS,
      category: 'app-transient',
      riskLevel: 'caution',
      recoverable: true,
      scanner: {
        filePatterns: [],
        olderThanDays: null,
        recursive: true,
        scopeFence: LEAF_FENCE(),
        ...over
      }
    })

  const cacheRule = (): Rule => leafRule('app-cache-data', { leafDirs: CACHE_LEAVES })
  const updaterRule = (): Rule =>
    leafRule('installer-artifacts', { leafDirs: UPDATER_LEAVES, filePatterns: INSTALLER_PATTERNS })
  const logsRule = (): Rule => leafRule('app-rotated-logs', { leafFiles: ROTATED_PATTERNS })

  /**
   * 第三种采集模式的规则（P2-T4 那条 `orphan-app-data` 的形状）：容器入口 + 围栏 + 机器事实闸。
   * 声明层那两条闸（`requires_absent_app_fact_with_leaf_dirs_is_refused` /
   * `an_app_fact_rule_must_be_a_container_entry_with_a_covering_fence` 的 TS 侧）认的就是这个形状。
   */
  const appFactRule = (id: string, paths: readonly string[]): Rule =>
    rule({
      id,
      name: id,
      paths,
      category: 'app-transient',
      riskLevel: 'high',
      recoverable: false,
      excludedFromDefaultSelection: true,
      requiresAbsentAppFact: true,
      scanner: { filePatterns: [], olderThanDays: null, recursive: true, scopeFence: LEAF_FENCE() }
    })

  /** 与 Rust `leaf_tree()` 同形状。`storeFrom` 自动补齐祖先目录（同一条构造纪律）。 */
  const LEAF_SPEC: Record<string, FileSpec[]> = {
    'C:\\': [],
    'C:\\Local': [{ name: 'loose.bin', size: 10 }],
    'C:\\Local\\SomeApp\\Cache': [{ name: 'c1.bin', size: 100 }, { name: 'c2.dat', size: 60 }],
    'C:\\Local\\SomeApp\\LocalCache': [{ name: 'look.bin', size: 33 }],
    'C:\\Local\\Deep\\Nest\\a\\b\\c\\Cache': [{ name: 'deep.bin', size: 70 }],
    'C:\\Local\\Twin\\Cache': [{ name: 'inner.bin', size: 30 }],
    'C:\\Local\\Twin\\Cache\\Cache': [{ name: 'nested.bin', size: 5 }],
    'C:\\Local\\Crx\\component_crx_cache': [{ name: 'crx.bin', size: 25 }],
    'C:\\Local\\Crx\\crx_cache': [{ name: 'lookalike.bin', size: 25 }],
    'C:\\Local\\Repo\\.git\\objects\\pack': [{ name: 'obj_1.idx', size: 90 }],
    'C:\\Local\\git\\objects': [{ name: 'abc.bin', size: 90 }],
    'C:\\Local\\git': [{ name: 'config', size: 7 }],
    'C:\\Local\\npm-cache\\_cacache': [{ name: 'pkg.bin', size: 80 }],
    'C:\\Local\\Hiview': [
      { name: 'HiviewPlatform.3.log', size: 400 },
      { name: 'HiviewPlatform.log', size: 1200 },
      { name: 'trace.log.01', size: 50 }
    ],
    'C:\\Local\\Hiview\\rot': [
      { name: 'HiviewService.1.log', size: 300 },
      { name: 'HiviewService.log', size: 500 }
    ],
    'C:\\Local\\Hiview\\etl': [{ name: 'monitor.etl', size: 60 }],
    'C:\\Local\\foo-updater\\pending': [{ name: 'setup.exe', size: 500 }, { name: 'notes.txt', size: 10 }],
    'C:\\Local\\Packages\\ExampleApp_1.0_x64__abc\\LocalCache\\Roaming': [
      { name: 'settings.zip', size: 700 }
    ],
    'C:\\Local\\Packages\\ExampleApp_1.0_x64__abc\\Settings': [{ name: 'roaming.lock', size: 10 }],
    'C:\\Local\\Programs\\Microsoft VS Code\\Resources\\app\\Cache': [
      { name: 'do-not-touch.bin', size: 9000 }
    ],
    'C:\\Local\\Junction\\Cache': [{ name: 'via-junction.bin', size: 400 }],
    'C:\\Local\\Ghost': [{ name: 'data.bin', size: 123 }],
    'C:\\Program Files\\Huawei\\PCManager\\Application\\Cache': [{ name: 'app.bin', size: 8000 }],
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\Cache': [{ name: 'edge.bin', size: 7000 }],
    'C:\\Windows\\System32\\Cache': [{ name: 'sys.bin', size: 111 }],
    'C:\\Temp\\Cache': [{ name: 'outside-allow.bin', size: 999 }],
    'C:\\Roam\\Another\\Cache': [{ name: 'roam.bin', size: 40 }],
    'C:\\ProgramData\\Vendor\\Cache': [{ name: 'pd.bin', size: 20 }]
  }

  /**
   * 手搓一棵**目录也带 attrs** 的取数面 —— 本组用例全都用它，原因有两个，都不是省事：
   *  1. Rust 侧同名用例跑的是 `FakeTree`（目录 attrs 是自己填的），它的对称替身就是这种手搓 source，
   *     而不是 `TreeStore`。用 TreeStore 会得到一棵"没有目录属性"的树，重解析点那一格永远走不到，
   *     两侧对同一棵树的结论就会**真的**分叉（leaf 遍历把 junction 后面的 400 字节计进去）。
   *  2. `TreeStore.dirView()` 的 attrs 恒为 `null` 是刻意的设计边界（TS 侧不为目录 stat，见
   *     `shared/types.ts:88`），所以"这条判据在 TS 生产取数面上今天走不到"这件事如实登记在 plan §10，
   *     而不是靠换夹具把它藏起来。
   * `unenumerable` 那份名单复刻 `guardedSource` 的姿态：**枚举到就 throw**，
   * 于是"围栏外的目录被列举了"以硬失败暴露，不会悄悄变成 0 字节看着像对。
   */
  function attrTree(
    spec: Record<string, FileSpec[]>,
    reparseDirs: readonly string[] = [],
    unenumerable: readonly string[] = []
  ): { src: RuleTreeSource; opened: string[] } {
    const dirs = allDirs(Object.keys(spec))
    const idOf = new Map<string, number>()
    dirs.forEach((d, i) => idOf.set(normalizeKey(d), i + 1))
    const reparse = new Set(reparseDirs.map((d) => normalizeKey(d)))
    const opened: string[] = []
    const base = (p: string): string => {
      const t = p.split('\\').filter((s) => s.length > 0)
      return t[t.length - 1] ?? ''
    }
    const src: RuleTreeSource = {
      rootId: 1,
      dirIdByPath: (p) => idOf.get(normalizeKey(p)),
      childrenOf: (id) => {
        const path = dirs[id - 1]
        if (path === undefined) throw new Error(`夹具没有 id ${id}`)
        const hit = unenumerable.find((g) => pathIsUnder(path, g))
        if (hit !== undefined) throw new Error(`枚举了围栏外/禁止的目录 ${path}（命中 ${hit}）—— 结构性不可达被打破了`)
        opened.push(path)
        const out: ChildView[] = []
        for (const d of dirs) {
          if (d === path) continue
          if (normalizeKey(parentOf(d) ?? '') !== normalizeKey(path)) continue
          out.push({
            kind: 'directory',
            name: base(d),
            path: d,
            dirId: idOf.get(normalizeKey(d)),
            size: 0,
            mtimeMs: 0,
            fileCount: 0,
            dirCount: 0,
            // 带得上 0x400 就是重解析点；其余目录给 0x10（FILE_ATTRIBUTE_DIRECTORY）
            attrs: reparse.has(normalizeKey(d)) ? 0x410 : 0x10,
            birthtimeMs: null
          })
        }
        for (const f of spec[path] ?? []) {
          out.push({
            kind: 'file',
            name: f.name,
            path: joinWin(path, f.name),
            size: f.size,
            mtimeMs: f.mtimeMs ?? NOW - 30 * DAY,
            fileCount: 0,
            dirCount: 0,
            attrs: f.attrs ?? 0,
            birthtimeMs: null
          })
        }
        return out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1))
      },
      // 子树合计：§3.6 地盘底账的 `present[].bytes` 要它，缺了会退成 null（"没量过"≠"0"）
      sizeOf: (id) => {
        const path = dirs[id - 1] ?? ''
        let total = 0
        for (const d of dirs) {
          if (!pathIsUnder(d, path)) continue
          for (const f of spec[d] ?? []) total += f.size
        }
        return total
      }
    }
    return { src, opened }
  }

  /**
   * 围栏外的两块 + 禁止根一起交给 `attrTree` 的 throw 名单。
   * 段边界判据顺带把 32 位那条也罩住 —— `C:\Program Files (x86)\…` 不是 `C:\Program Files`
   * 的字符串前缀，而是它的**子孙**。
   */
  const OUTSIDE = ['C:\\Local\\Programs', 'C:\\Program Files', 'C:\\Windows\\System32']
  const leafRun = (
    rules: readonly Rule[],
    opts: { appFacts?: ReadonlyMap<string, AppFact>; appFactWhys?: ReadonlyMap<string, string> } = {}
  ) => {
    const { src, opened } = attrTree(LEAF_SPEC, ['C:\\Local\\Junction'], OUTSIDE)
    const report = evaluateRules({
      source: src,
      env: LEAF_ENV,
      rules,
      forbiddenPatterns: FORBIDDEN_ALL,
      nowMs: NOW,
      ...opts
    })
    return { report, opened }
  }

  /**
   * 围栏根那一条「剥掉**唯一一个收尾通配段**再按同一套 `%VAR%` 解析」的口径（引擎 `fenceRoot(deny=true)`
   * 逐字同法：`%PROGRAMDATA%\Microsoft\Windows Defender\*` 的根是那个具体目录，不是整个 ProgramData）。
   * 解不出来直接抛 —— 哨兵不许建立在"解析失败就等于没这条"的那种根上。
   */
  const floorRootOf = (pattern: string): string => {
    const segs = pattern.split('\\').filter((s) => s.length > 0)
    const last = segs[segs.length - 1]
    if (last === '*' || last === '?') segs.pop()
    const res = resolvePattern(segs.join('\\'), LEAF_ENV)
    const path = res.concrete ?? res.base
    if (path === null || path === undefined || path === '') {
      throw new Error(`地板根 ${pattern} 在 LEAF_ENV 下解析不出来 —— 结构性哨兵不能建立在解不出来的根上`)
    }
    return path
  }

  /**
   * **内置表自己声明的不可达地板** = §16 `FORBIDDEN_PATH_PATTERNS` ∪ `FENCE_MINIMUM_DENY_PATTERNS`
   * （就是 `validateFence` 拿去要求每条围栏 `denyRoots ⊇` 的那两张表，从源码里拿，不在测试里抄第三份口径）。
   */
  const PRODUCT_UNREACHABLE: readonly string[] = [
    ...new Set([...FORBIDDEN_ALL, ...FENCE_MINIMUM_DENY_PATTERNS].map(floorRootOf))
  ]

  /**
   * 真表（`BUILTIN_RULES`）专用的「枚举到就 throw」装置 —— 与 `leafRun` **同一台 `attrTree`、
   * 同一份 `LEAF_SPEC`、同一个哨兵机制、同一句 throw**；唯一的差别是 throw 名单的来源：
   * `leafRun` 用 `OUTSIDE`（夹具围栏 `LEAF_FENCE` 的 deny 集合），真表用 `PRODUCT_UNREACHABLE`
   * （产品自己声明的地板）。
   *
   * 为什么不能把 `OUTSIDE` 原样扣在真表上：那三根里挂着 `C:\Local\Programs`，它是 `LEAF_FENCE`
   * **额外**多 deny 的一根，产品地板表里没有它。这件事不是本文件的新发现 ——
   * plan `2026-10-13-deepclean-tauri-m5-p1.md` §10 第 12 条原文登记过：
   * 「`leaf_fence()` 多 deny 了 `%LOCALAPPDATA%\Programs\*`，所以那台带 throw 装置的 `attrTree`
   * **不能直接跑真表**（会在"引擎没做错、只是围栏集合不同"的地方抛假红）」，
   * 同一条本文件上面第 1704 行那句 `builtinRun` 的注释也在说同一件事。
   * 同一条事实在 Rust 侧是**钉进 pre-change golden 的字节**：`crates/rules/src/engine.rs` 的
   * `BUILTIN_P2T3_GOLDEN` 里 `app-cache-data` 名下就有
   * `C:\Local\Programs\Microsoft VS Code\Resources\app\Cache\do-not-touch.bin` 那 9000 字节。
   * ⇒ 拿 `OUTSIDE` 跑真表 = 让内置表为一个它从未声明过的边界挨一下哨兵。那不是"结构性不可达被打破"，
   *   是哨兵被拿去断言了一件产品从未承诺过的事（下方那条"边界如实登记"的断言把这件事钉在明处）。
   *
   * 哨兵本身一处都没松：机制没动、`attrTree` 没动、`OUTSIDE` 没动、leaf 那一族的用例照旧吃 `OUTSIDE`。
   * P2-T5 只把这份装置**加严**了一层（`sentinelRun` 的第三、四个参数：换树 + 往 throw 名单里
   * **追加**条目，默认值就是本节原本那次调用）—— 名单只增不减，`builtinSentinelRun` 逐字走同一条路径。
   * 而且这份名单由声明推导 ⇒ 地板表哪天加严（把 `%LOCALAPPDATA%\Programs\*` 写进
   * `FENCE_MINIMUM_DENY_PATTERNS`），这里**自动跟上**，同一条用例当场变红要人复判 —— 不会退化成
   * "测试作者以为的边界"。
   */
  const sentinelRun = (
    rules: readonly Rule[],
    opts: { appFacts?: ReadonlyMap<string, AppFact>; appFactWhys?: ReadonlyMap<string, string> } = {},
    spec: Record<string, FileSpec[]> = LEAF_SPEC,
    extraUnenumerable: readonly string[] = []
  ) => {
    // `extraUnenumerable` **只追加、不替换**：产品地板一根都不许从名单里拿掉（P2-T5 用它把
    // 包树根交给哨兵）。默认两个参数 = 下面 `builtinSentinelRun` 一字未改的那次调用。
    const { src, opened } = attrTree(
      spec,
      ['C:\\Local\\Junction'],
      [...PRODUCT_UNREACHABLE, ...extraUnenumerable]
    )
    const report = evaluateRules({
      source: src,
      env: LEAF_ENV,
      rules,
      forbiddenPatterns: FORBIDDEN_ALL,
      nowMs: NOW,
      ...opts
    })
    return { report, opened }
  }

  const builtinSentinelRun = (
    rules: readonly Rule[],
    opts: { appFacts?: ReadonlyMap<string, AppFact>; appFactWhys?: ReadonlyMap<string, string> } = {}
  ) => sentinelRun(rules, opts)

  const claimedOf = (report: ReturnType<typeof evaluateRules>): string[] =>
    report.findings.flatMap((f) => f.samplePaths.map((p) => p.path))

  it('leaf_dirs_match_at_any_depth_within_the_fence', () => {
    const { report, opened } = leafRun([cacheRule()])
    const f = finding(report, 'app-cache-data')!
    expect(f.matchedRoots).toEqual([
      'C:\\Local\\Crx\\component_crx_cache',
      'C:\\Local\\Deep\\Nest\\a\\b\\c\\Cache',
      'C:\\Local\\SomeApp\\Cache',
      'C:\\Local\\Twin\\Cache',
      'C:\\ProgramData\\Vendor\\Cache',
      'C:\\Roam\\Another\\Cache'
    ])
    expect([f.fileCount, f.totalBytes]).toEqual([8, 350])
    // 命中即停：`Twin\Cache\Cache` 是同一个根里 recursive 收进来的，不是第二个命中
    expect(f.matchedRoots.some((p) => p.endsWith('Twin\\Cache\\Cache'))).toBe(false)
    // 容器上散着的文件不进账；`LocalCache` 这种整名不中的近失名也不进账
    const c = claimedOf(report)
    expect(c.some((p) => p.endsWith('loose.bin'))).toBe(false)
    expect(c.some((p) => p.endsWith('look.bin'))).toBe(false)
    // 遍历真的发生过（不是"整条规则空转所以什么都没命中"）
    expect(opened).toContain('C:\\Local')
  })

  it('a_denied_directory_is_never_enumerated_and_names_the_path', () => {
    const { report, opened } = leafRun([cacheRule()])
    const ex = report.exclusions.filter((e) => e.reason === 'outside-fence')
    expect(ex.length).toBeGreaterThan(0)
    const denied = ex.find((e) => e.path === 'C:\\Local\\Programs')
    expect(denied, '围栏外的目录必须点名到具体路径，不许只有总数').toBeDefined()
    expect(denied!.ruleId).toBe('app-cache-data')
    expect(denied!.detail).toContain('C:\\Local\\Programs')
    expect(denied!.detail).toContain('围栏')
    // 结构性不可达：`guardedSource` 已经保证「枚举围栏外的目录 = throw」，
    // 这里再正面确认枚举清单里没有它 —— 不是"列举完再过滤命中"。
    expect(opened.filter((p) => pathIsUnder(p, 'C:\\Local\\Programs'))).toEqual([])
    expect(finding(report, 'app-cache-data')!.samplePaths.some((p) => p.size === 9000)).toBe(false)

    // allow 侧同一个形状：入口本身落在 allowRoots 之外 → 整条分支出局 + 点名
    const outside = leafRule('outside-allow', { leafDirs: ['Cache'], scopeFence: LEAF_FENCE() })
    const run2 = leafRun([rule({ ...outside, id: 'outside-allow', paths: ['%TEMP%'] })])
    expect(finding(run2.report, 'outside-allow')!.totalBytes).toBe(0)
    const ex2 = run2.report.exclusions.filter((e) => e.reason === 'outside-fence')
    expect(ex2.some((e) => e.path === 'C:\\Temp' && e.detail.includes('allowRoots')), JSON.stringify(ex2)).toBe(
      true
    )
    expect(run2.opened.filter((p) => pathIsUnder(p, 'C:\\Temp'))).toEqual([])
  })

  it('near_miss_cache_under_program_files_is_not_claimed', () => {
    const { report, opened } = leafRun([cacheRule(), updaterRule(), logsRule()])
    const c = claimedOf(report)
    expect(c.some((p) => p.includes('do-not-touch'))).toBe(false)
    expect(c.some((p) => pathIsUnder(p, 'C:\\Program Files'))).toBe(false)
    expect(opened.filter((p) => pathIsUnder(p, 'C:\\Program Files'))).toEqual([])
    expect(opened.filter((p) => pathIsUnder(p, 'C:\\Local\\Programs'))).toEqual([])
    expect([
      finding(report, 'app-cache-data')!.totalBytes,
      finding(report, 'installer-artifacts')!.totalBytes,
      finding(report, 'app-rotated-logs')!.totalBytes
    ]).toEqual([350, 500, 810])
    expect(report.reclaimableBytes).toBe(1660)
  })

  it('git_objects_and_crx_cache_undotted_names_are_not_claimed', () => {
    const { report } = leafRun([cacheRule(), updaterRule()])
    const c = claimedOf(report)
    for (const p of c) {
      for (const banned of ['\\.git\\', 'C:\\Local\\git\\', '\\crx_cache\\', '\\npm-cache\\', '\\Packages\\']) {
        expect(p, `${banned} 那一族近失形状被认领了`).not.toContain(banned)
      }
    }
    // 反半边：名单里那个下划线名确实进账，否则上面那组断言只是"什么都没命中"的空转
    expect(c.some((p) => p.endsWith('component_crx_cache\\crx.bin'))).toBe(true)
    expect(finding(report, 'app-cache-data')!.totalBytes).toBe(350)
    // `Packages` 不许被更新目录名单当更新目录吃（plan §5 第一条排除项）：
    // 唯一进账的更新目录是 `foo-updater`，那 700 字节的 UWP `settings.zip` 一分都不算
    expect(finding(report, 'installer-artifacts')!.matchedRoots).toEqual(['C:\\Local\\foo-updater'])
    expect(finding(report, 'installer-artifacts')!.totalBytes).toBe(500)
  })

  it('leaf_walk_respects_the_single_depth_cap', () => {
    const seg = (i: number): string => `d${String(i).padStart(3, '0')}`
    let chain = 'C:\\Local'
    let capped = ''
    for (let i = 1; i <= 210; i++) {
      chain = joinWin(chain, seg(i))
      if (i === 201) capped = chain // 第 201 层：正好是越过 `MAX_WALK_DEPTH = 200` 的那一个
    }
    const spec: Record<string, FileSpec[]> = {
      'C:\\': [],
      [`${chain}\\Cache`]: [{ name: 'over.bin', size: 77 }],
      'C:\\Local\\Shallow\\Cache': [{ name: 'ok.bin', size: 11 }]
    }
    const { src, opened } = guardedSource(storeFrom(spec), [])
    const report = evaluateRules({
      source: src,
      env: LEAF_ENV,
      rules: [cacheRule()],
      forbiddenPatterns: FORBIDDEN_ALL,
      nowMs: NOW
    })
    const f = finding(report, 'app-cache-data')!
    expect([f.fileCount, f.totalBytes], '浅处那一格照常进账，深处那格不许进来').toEqual([1, 11])
    expect(f.matchedRoots).toEqual(['C:\\Local\\Shallow\\Cache'])
    const over = report.exclusions.find((e) => e.path === capped)
    expect(over, '超限必须点名到那一个目录，而不是静默截掉整条分支').toBeDefined()
    expect(over!.reason).toBe('not-scanned')
    expect(over!.detail).toContain('深度上限')
    expect(over!.detail).toContain('200')
    // 深链里 201 层往下的目录一次都没被枚举（尺子只有 `MAX_WALK_DEPTH` 这一把）
    expect(opened.some((p) => pathIsUnder(p, capped))).toBe(false)
  })

  it('reparse_point_dirs_are_skipped_not_followed', () => {
    // ⚠️ 这条用的不是 `TreeStore`：`dirView()` 给目录的 attrs 恒为 null（TS 侧不为目录 stat），
    // 所以"重解析点跳过"这一格只有能给出目录属性的取数面才触发得到 —— Rust 的 `TreeSource` 给真 attrs。
    // 两侧代码相同、可达性不同，这条不对称登记在 plan §10。
    const { src, opened } = attrTree(LEAF_SPEC, ['C:\\Local\\Junction'])
    const report = evaluateRules({
      source: src,
      env: LEAF_ENV,
      rules: [cacheRule()],
      forbiddenPatterns: FORBIDDEN_ALL,
      nowMs: NOW
    })
    const f = finding(report, 'app-cache-data')!
    expect(f.totalBytes, 'junction 后面那 400 字节一次都不进账').toBe(350)
    expect(claimedOf(report).some((p) => p.includes('via-junction'))).toBe(false)
    const ex = report.exclusions.find((e) => e.path === 'C:\\Local\\Junction')
    expect(ex, '重解析点要点名到那个目录').toBeDefined()
    expect(ex!.reason).toBe('not-scanned')
    expect(ex!.detail).toContain('重解析')
    expect(opened.some((p) => pathIsUnder(p, 'C:\\Local\\Junction'))).toBe(false)
  })

  it('empty_file_patterns_under_a_leaf_dir_collects_everything', () => {
    const { report } = leafRun([cacheRule()])
    const c = claimedOf(report)
    expect(c.some((p) => p.endsWith('SomeApp\\Cache\\c1.bin'))).toBe(true)
    expect(c.some((p) => p.endsWith('SomeApp\\Cache\\c2.dat'))).toBe(true)
    expect(c.some((p) => p.endsWith('Twin\\Cache\\Cache\\nested.bin'))).toBe(true)
    expect(c.some((p) => p.endsWith('loose.bin')), '容器层散着的文件不许认领').toBe(false)
    const f = finding(report, 'app-cache-data')!
    expect([f.fileCount, f.totalBytes]).toEqual([8, 350])
    expect(f.sampleTruncated).toBe(false)
  })

  /**
   * plan §5 第二条排除项：`*.?.log` 正好吃轮转件、不吃同名无后缀的在写文件。
   * 这条是 glob 语义的活证据（本机 `HiviewPlatform.log` 12.1 MiB 正在被写），必须有单测 ——
   * 把它放宽成 `*.log`（变异 3）立刻会红在"在写的日志被吃了"那一句。
   */
  it('leaf_files_match_at_any_depth_and_never_the_live_log', () => {
    const { report } = leafRun([logsRule()])
    const c = claimedOf(report)
    expect(c.some((p) => p.endsWith('HiviewPlatform.3.log'))).toBe(true)
    expect(c.some((p) => p.endsWith('rot\\HiviewService.1.log'))).toBe(true)
    expect(c.some((p) => p.endsWith('trace.log.01'))).toBe(true)
    expect(c.some((p) => p.endsWith('monitor.etl'))).toBe(true)
    expect(c.some((p) => p.endsWith('HiviewPlatform.log') || p.endsWith('HiviewService.log')), '在写的日志被吃了').toBe(
      false
    )
    const f = finding(report, 'app-rotated-logs')!
    expect([f.fileCount, f.totalBytes]).toEqual([4, 810])
    // leafFiles 模式不给目录当根（那是 leafDirs 的语义），根就是被搜过的那一层入口，
    // 次序沿用 paths 表序 —— 与非 leaf 规则的 matchedRoots 同一个姿态（不是字典序）
    expect(f.matchedRoots).toEqual(['C:\\Local', 'C:\\Roam', 'C:\\ProgramData'])
  })

  /* ---------------------------------------------------------------- *
   * M5-P1 T3a —— 下面三条吃的是**真表**（`BUILTIN_RULES`），不是上面那些测试自造的规则。
   * 区别就是变异清单跑不跑得出红：改 `registry.ts` 里那三条的字面量，自造替身一条都不会红。
   * Rust 侧同名同形状的用例在 `crates/rules/src/engine.rs`（plan §5 的三条排除项各一侧一份）。
   * ---------------------------------------------------------------- */

  const builtinRule = (id: string): Rule => {
    const r = BUILTIN_RULES.find((x) => x.id === id)
    if (!r) throw new Error(`内置表里没有 ${id} —— 它根本没上线`)
    return r
  }

  /**
   * 真表专用的跑法：`storeFrom` + LEAF_ENV，**不用**上面 `leafRun` 那台 `attrTree` 装置。
   * 不是省事 —— `attrTree` 的 throw 名单里挂着 `C:\Local\Programs`，那是 `LEAF_FENCE`（夹具围栏）
   * 额外 deny 的一根，**plan §4/§5 给产品规则定的 deny 集合里没有它**。拿那台装置跑真表会在
   * "引擎没做错、只是围栏集合不同"的地方抛错，把两条用例变成假红。
   * 这个差异本身是要紧的，已单独登记在 plan §10（golden §4 第三行 `%LOCALAPPDATA%\Programs`）。
   */
  const builtinRun = (spec: Record<string, FileSpec[]>, rules?: readonly Rule[]) => ({
    report: evaluateRules({
      source: storeFrom(spec),
      env: LEAF_ENV,
      rules: rules ?? BUILTIN_RULES,
      forbiddenPatterns: FORBIDDEN_ALL,
      nowMs: NOW
    })
  })

  /// plan §5 第二条排除项，产品侧：表里那条 `app-rotated-logs` 只吃轮转件，不吃在写的日志。
  it('the_builtin_rotated_log_rule_never_touches_a_live_log', () => {
    const { report } = builtinRun(
      {
        'C:\\Local\\Hiview': [
          { name: 'HiviewPlatform.3.log', size: 400 },
          { name: 'HiviewPlatform.log', size: 1200 },
          { name: 'trace.log.01', size: 50 }
        ],
        'C:\\Local\\Hiview\\rot': [
          { name: 'HiviewService.1.log', size: 300 },
          { name: 'HiviewService.log', size: 500 }
        ],
        'C:\\Local\\Hiview\\etl': [{ name: 'monitor.etl', size: 60 }]
      },
      [builtinRule('app-rotated-logs')]
    )
    const c = claimedOf(report)
    expect(c.some((p) => p.endsWith('HiviewPlatform.3.log')), '轮转件必须收到').toBe(true)
    expect(c.some((p) => p.endsWith('rot\\HiviewService.1.log')), '任意深度').toBe(true)
    expect(c.some((p) => p.endsWith('trace.log.01')), '*.log.?? 那一档').toBe(true)
    expect(c.some((p) => p.endsWith('monitor.etl')), '*.etl 那一档').toBe(true)
    for (const live of ['HiviewPlatform.log', 'HiviewService.log'])
      expect(c.some((p) => p.endsWith(live)), `表里这条规则把正在被写的日志吃了：${live}`).toBe(false)
    const f = finding(report, 'app-rotated-logs')!
    // 400 + 300 + 50 + 60；在写那两个（1200 + 500）一个都不许进账
    expect([f.fileCount, f.totalBytes]).toEqual([4, 810])
  })

  /// **双计契约**（plan §5 第三条排除项 / spec §2.2）：表尾的 `app-cache-data` 覆盖第 2、7 条的地盘，
  /// 靠 `claimed` 先声明者计账 + 追加在表尾这两件事才不会虚高。
  it('app cache data does not reclaim npm cache or browser cache', () => {
    const spec: Record<string, FileSpec[]> = {
      'C:\\Local\\npm-cache\\Cache': [{ name: 'pkg.bin', size: 80 }],
      'C:\\Local\\npm-cache\\_cacache': [{ name: 'index.bin', size: 459 }],
      'C:\\Local\\Google\\Chrome\\User Data\\Default\\Cache': [{ name: 'f_00000a.bin', size: 4000 }],
      'C:\\Local\\Google\\Chrome\\User Data\\Default\\Code Cache': [{ name: 'app.js', size: 500 }]
    }
    const report = evaluateRules({
      source: storeFrom(spec),
      env: LEAF_ENV,
      rules: BUILTIN_RULES,
      forbiddenPatterns: FORBIDDEN_ALL,
      nowMs: NOW
    })
    // 23 条表 ⇒ 22 条 finding：掉出去的那一条**必须**恰好是空表弃权的 `orphan-app-data`，
    // 不是任何一条既有规则（只看 22 这个数的话，真掉一条规则时它照样凑得出来）。
    // 第 23 条 gpu-driver-leftovers 的地盘（盘根 NVIDIA\ / AMD\）不在夹具里，照旧出 0 字节 finding。
    expect(assertRulesAccountedFor(report, BUILTIN_RULES)).toEqual(['orphan-app-data'])
    expect(report.findings.length, '既有二十二条都要上线').toBe(22)
    const f = (id: string) => finding(report, id)!
    expect([f('npm-cache').fileCount, f('npm-cache').totalBytes], 'npm-cache 那两条归第 7 条').toEqual([2, 539])
    expect([f('browser-cache').fileCount, f('browser-cache').totalBytes], '浏览器那两条归第 2 条').toEqual([2, 4500])
    expect(
      [f('app-cache-data').fileCount, f('app-cache-data').totalBytes],
      'app-cache-data 把已记账的地盘又算了一遍 = 预估虚高（M5-N 那类静默双计）'
    ).toEqual([0, 0])
    // 机制也要点名：**是 leaf 名单正命中**的那三个文件留下 claimed-by-other-rule，点名归属者。
    // `_cacache\index.bin` 不在这一列（`_cacache` 不是名单里的名字，那条规则根本没试过认领它）；
    // 它归 npm-cache 由上面那条 (2, 539) 判。
    const ex = report.exclusions.filter(
      (e) => e.ruleId === 'app-cache-data' && e.reason === 'claimed-by-other-rule'
    )
    for (const p of [
      'C:\\Local\\npm-cache\\Cache\\pkg.bin',
      'C:\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\f_00000a.bin',
      'C:\\Local\\Google\\Chrome\\User Data\\Default\\Code Cache\\app.js'
    ])
      expect(ex.some((e) => e.path === p), `${p} 没有 app-cache-data 名下的 claimed-by-other-rule`).toBe(true)
    expect(ex.some((e) => e.path.includes('_cacache')), '不该给根本没试过的文件记"别人计过账"').toBe(false)
    expect(report.reclaimableBytes, '合计里那 5,039 字节只被计了一次').toBe(539 + 4500)
  })

  /// plan §5 第一条排除项的行为半边（真表跑在 `LEAF_SPEC` 上）：`Packages` 本身不许成为任何
  /// 一条规则的采集根，其中那个 `settings.zip`（商店应用的登录态与设置）不许被认领。
  /// 判据**只到那个容器本身**，不是"Packages 底下一个字节都不许碰" —— 后者会把名单内的内层
  /// 缓存目录一并禁掉，那不是 plan 排除的东西，写成判据就是自行加严。
  /// 正向对照（`foo-updater\pending\setup.exe` 必须被收走）是这条的牙：没它整条会因"规则没上线"而照样绿。
  it('no_builtin_rule_treats_the_uwp_packages_dir_as_a_collection_root', () => {
    const { report } = builtinRun({
      'C:\\Local\\Packages\\ExampleApp_1.0_x64__abc\\LocalCache\\Roaming': [
        { name: 'settings.zip', size: 700 }
      ],
      'C:\\Local\\Packages\\ExampleApp_1.0_x64__abc\\Settings': [{ name: 'roaming.lock', size: 10 }],
      // 正向对照：更新目录 + 安装包形状，installer-artifacts 必须收走它
      'C:\\Local\\foo-updater\\pending': [{ name: 'installer.exe', size: 500 }]
    })
    const roots = report.findings.flatMap((f) => f.matchedRoots)
    expect(
      roots.some((m) => m.toLowerCase() === 'c:\\local\\packages'),
      `\`Packages\` 本身成了一条规则的采集根（leafDirs 里出现 Packages 或等价 glob）：${JSON.stringify(roots)}`
    ).toBe(false)
    const c = claimedOf(report)
    expect(c.some((p) => p.endsWith('foo-updater\\pending\\installer.exe')), '正向对照失效：installer-artifacts 一条都没收').toBe(true)
    for (const keep of ['settings.zip', 'roaming.lock'])
      expect(c.some((p) => p.endsWith(keep)), `UWP 每应用状态目录里的 ${keep} 被认领了`).toBe(false)
  })

  /**
   * **fail-safe 方向**（spec §4.2 / plan §0.5 / §2.4）：空表 = 一个候选都判不出 `absent` ⇒
   * 声明了 `requiresAbsentAppFact` 的规则一个候选都不提议，但每个候选目录都要点名（不许静默消失）。
   *
   * P2-T3 起这条走**第三种采集模式**（候选 = 入口的直属子目录），空表时那份理由是
   * `app-fact-key-missing`（探针没被交代看过它），不是 P2-T1 那半边折出来的 `app-fact-unknown`
   * （探针看了但说不清）。与 Rust `engine.rs::an_absent_app_fact_rule_proposes_nothing_while_the_table_is_empty` 同判据。
   */
  it('an_absent_app_fact_rule_proposes_nothing_while_the_table_is_empty', () => {
    const ghost = appFactRule('ghost-app-data', ['%LOCALAPPDATA%'])
    const empty = leafRun([ghost])
    expect(empty.report.findings).toEqual([])
    expect(empty.report.reclaimableBytes).toBe(0)
    const ex = empty.report.exclusions.find(
      (e) => e.reason === 'app-fact-key-missing' && e.path === 'C:\\Local\\Ghost'
    )
    expect(ex, '弃权必须点名到那个具体目录，不许静默消失').toBeDefined()
    expect(ex!.ruleId).toBe('ghost-app-data')
    expect(ex!.detail).toContain('ghost')
    expect(ex!.detail).toContain('键')

    // 覆盖面：`leaf_tree` 里 `C:\Local` 的 13 个直属子目录，`Programs` 走 deny 根、
    // `Junction` 走重解析点，剩下 **11** 个都该有一格缺键点名。写成等号：少一个是漏点名，
    // 多一个是把更深的层也当成了候选 —— 两种都是这条模式的失效形状。
    const named = empty.report.exclusions.filter((e) => e.reason === 'app-fact-key-missing').length
    expect(named).toBe(11)

    // 表里真给了 absent 才提议 —— 这条证明上面那段是**事实闸**，不是"把规则关掉"的开关
    const absentRun = leafRun([ghost], { appFacts: new Map([['ghost', 'absent' as AppFact]]) })
    expect(finding(absentRun.report, 'ghost-app-data')!.totalBytes).toBe(123)
    // 反过来：present（应用还在）不许提议 —— 本机审计就是靠这两半推翻过三次单路判据
    const presentRun = leafRun([ghost], { appFacts: new Map([['ghost', 'present' as AppFact]]) })
    expect(presentRun.report.findings).toEqual([])
    expect(presentRun.report.reclaimableBytes).toBe(0)

    // 回归轴：没声明这个字段的规则，带不带表整份报告逐字节相同
    const plain = rule({ id: 'plain', paths: ['%LOCALAPPDATA%\\Ghost'] })
    const withoutTable = JSON.stringify(leafRun([plain]).report)
    const withTable = JSON.stringify(
      leafRun([plain], {
        appFacts: new Map([
          ['ghost', 'present' as AppFact],
          ['nothing', 'absent' as AppFact]
        ])
      }).report
    )
    expect(withTable).toBe(withoutTable)
  })

  /**
   * **P2-T3 判据 ①（plan §2.4）**：`absent` 只收**入口目录的直属子目录**那一层。
   * 表里同时把 `cache` 判成 absent，深处那三棵 `Cache`（160 / 70 / 35）也一个字节都不许进账 ——
   * 这一格就是"第三种模式 ≠ leaf 模式"的正面证据。入口自己（basename `local`）不许当候选。
   * 与 Rust `absent_only_collects_direct_children_of_the_entry` 同判据。
   */
  it('absent_only_collects_direct_children_of_the_entry', () => {
    const { report } = leafRun([appFactRule('orphan-app-data', ['%LOCALAPPDATA%'])], {
      appFacts: new Map([
        ['ghost', 'absent' as AppFact],
        ['cache', 'absent' as AppFact], // 深处的命中：这一格必须收不到
        ['someapp', 'present' as AppFact]
      ])
    })
    const f = finding(report, 'orphan-app-data')!
    expect(f.matchedRoots).toEqual(['C:\\Local\\Ghost'])
    expect([f.fileCount, f.totalBytes]).toEqual([1, 123])
    expect(f.riskLevel).toBe('high')
    const c = claimedOf(report)
    for (const keep of ['c1.bin', 'c2.dat', 'deep.bin', 'inner.bin', 'nested.bin']) {
      expect(c.some((p) => p.endsWith(keep)), `任意深度的 ${keep} 被认领了 —— 第三种模式写成了 leaf 模式`).toBe(false)
    }
    expect(
      report.exclusions.some(
        (e) =>
          e.path === 'C:\\Local' &&
          ['app-fact-key-missing', 'app-fact-unknown', 'app-fact-present'].includes(e.reason)
      ),
      '拿容器名 `local` 去查了机器事实表 —— 入口自己成了候选'
    ).toBe(false)
  })

  /**
   * **P2-T3 判据 ②**：`present` / `unknown` / 缺键 三档各记**一条分名的**排除，
   * 三条**互相分得开**（reason 与 detail 都两两不同），每条点名到那个具体路径，
   * `unknown` 那条带上探针的 `why` 原话，而缺键**不许被读成 absent**。
   * 变异电池（plan §3-P2-T3）把"缺键 ⇒ unknown"装回成"缺键 ⇒ absent"时，这条必须红。
   * 与 Rust `present_and_unknown_and_missing_key_each_get_named_exclusion` 同判据。
   */
  it('present_and_unknown_and_missing_key_each_get_named_exclusion', () => {
    const rules = [appFactRule('orphan-app-data', ['%LOCALAPPDATA%'])]
    const facts = new Map<string, AppFact>([
      ['someapp', 'present'],
      ['hiview', 'unknown']
    ])
    const whys = new Map<string, string>([['hiview', 'C5 进程快照枚举到第 12 个进程时断了']])
    // `git`（`C:\Local\git`）不进表 —— 那一格就是要测的"缺键"
    const { report } = leafRun(rules, { appFacts: facts, appFactWhys: whys })
    const pick = (reason: string, path: string): string => {
      const e = report.exclusions.find((x) => x.reason === reason && x.path === path)
      expect(e, `少了 ${reason} 对 ${path} 的那一条：三档弃权理由必须各自分名`).toBeDefined()
      return e!.detail
    }
    const presentDetail = pick('app-fact-present', 'C:\\Local\\SomeApp')
    const unknownDetail = pick('app-fact-unknown', 'C:\\Local\\Hiview')
    const missingDetail = pick('app-fact-key-missing', 'C:\\Local\\git')

    // 三条措辞两两不同（只比 reason 不够：三个 reason 挂同一句话，读者还是分不开）
    expect(presentDetail).not.toBe(unknownDetail)
    expect(presentDetail).not.toBe(missingDetail)
    expect(unknownDetail).not.toBe(missingDetail)
    expect(presentDetail).toContain('Present')
    expect(unknownDetail).toContain('Unknown')
    expect(missingDetail).toMatch(/没有这个键|缺键/)
    // 探针的 `why` 原话进了报告 —— 这一格是"为什么没判"的唯一出处
    expect(unknownDetail).toContain('C5 进程快照枚举到第 12 个进程时断了')

    // 三档一条都不许进账
    expect(report.findings).toEqual([])
    expect(report.reclaimableBytes).toBe(0)
    const c = claimedOf(report)
    for (const p of ['C:\\Local\\SomeApp', 'C:\\Local\\Hiview', 'C:\\Local\\git']) {
      expect(c.some((x) => x.startsWith(p)), `${p} 的地盘被认领了 —— 三档弃权里有一档走漏`).toBe(false)
    }

    // 批准一格、弃权三格：进账只有 Ghost 那 123 字节，另外三条点名照旧在位
    const approved = leafRun(rules, {
      appFacts: new Map([...facts.entries(), ['ghost', 'absent' as AppFact]]),
      appFactWhys: whys
    })
    expect(finding(approved.report, 'orphan-app-data')!.totalBytes).toBe(123)
    for (const reason of ['app-fact-present', 'app-fact-unknown', 'app-fact-key-missing']) {
      expect(
        approved.report.exclusions.some((e) => e.reason === reason),
        `批准了一个候选之后另外三档的点名掉了：${reason}`
      ).toBe(true)
    }
  })

  /**
   * **P2-T3 判据 ③**：围栏对第三种模式照常生效，而且是在**枚举之前**判 ——
   * `attrTree` 对 `C:\Local\Programs` 是"敢枚举就 throw"的，所以这条用例的绿本身就证明
   * 结构上没走到那一层；被 deny 的候选还不许进 `matchedRoots`。
   * 另加一格重解析点（`C:\Local\Junction`）：表批准了也不当候选、不跟进。
   * 与 Rust `the_fence_still_applies_to_the_app_fact_collected_subtree` 同判据。
   */
  it('the_fence_still_applies_to_the_app_fact_collected_subtree', () => {
    const { report } = leafRun([appFactRule('orphan-app-data', ['%LOCALAPPDATA%'])], {
      appFacts: new Map([
        ['programs', 'absent' as AppFact],
        ['junction', 'absent' as AppFact]
      ])
    })
    expect(report.findings).toEqual([])
    const denied = report.exclusions.find((e) => e.reason === 'outside-fence' && e.path === 'C:\\Local\\Programs')
    expect(denied, '表批准了 Absent 也不许越过 denyRoots，且要留下点名到具体目录的 outside-fence').toBeDefined()
    expect(denied!.detail).toContain('denyRoots')
    const junction = report.exclusions.find(
      (e) => e.reason === 'not-scanned' && e.path === 'C:\\Local\\Junction'
    )
    expect(junction, '重解析点目录被当成了候选').toBeDefined()
    expect(junction!.detail).toContain('重解析点')
  })

  /**
   * **P2-T3 回归轴**（plan §3-P2-T3 立的，**P2-T4 换前提**）：原先这条的前提是「内置表还是 21 条、
   * 一条都不带 `requiresAbsentAppFact`」—— 那句从 P2-T4 起**按设计不再成立**（表尾第 22 条
   * `orphan-app-data` 带的就是它）。留着只会得到一条没有信息的红。
   *
   * 这里保留这条轴当初真正保护的那件事，并把前提换成**正面形式**：
   * 把表尾那条新规则摘掉 ⇒ 剩下的恰好是 P2-T4 动手之前那张表（21 条）⇒ 给它**挂满一张表**
   * （三档都有、还带 whys）也不许多变一个字节。而"带这个字段的规则恰好只有表尾那一条"这一格
   * 现在是被**断言**的，不是被假设 —— 它是那条摘除切片成立的前提：哪天多一条也带这个字段，
   * 切片就不再等于"动手之前那张表"，这条用例当场红，而不是安静地少比一条规则。
   * 第 22 条**自己**在空表下的那半（0 字节 + 每个候选点名 + 排除条数不封顶）住在
   * `an_empty_app_fact_table_leaves_rule_22_at_zero_bytes_while_naming_every_candidate`，
   * 两条各管一头，**不许合并成一句前提**（Rust `engine.rs` 那两个同名用例同一个拆分）。
   *
   * 这一条跑在 `builtinSentinelRun` 那台**带结构性哨兵**的装置上（不是 `builtinRun` 那台无哨兵的）：
   * 「内置表一次都没枚举过任何它自己声明为不可达的目录」这句话要由"枚举到就 throw"来保证，
   * 而不是由"字节为 0"来保证 —— 枚举本身就是违例，认领与否无关。
   *
   * ⚠️ 与 Rust 那条同名用例的差别如实登记：Rust 侧还额外钉了一份**动手之前**（`d671390`）
   * 录下的投影基线；TS 这一条是"改动前后两次跑的投影相等"（同进程、同夹具），
   * 没能在这一侧另存一份 pre-change 串 —— 两侧的内置表本来就由 `m3-parity.json` 逐字段对账。
   */
  it('the_builtin_table_without_the_new_rule_is_byte_identical', () => {
    expect(BUILTIN_RULES.length).toBe(23)
    expect(
      BUILTIN_RULES.filter((r) => r.requiresAbsentAppFact !== undefined).map((r) => r.id),
      '带机器事实闸的规则必须恰好只有表尾那一条'
    ).toEqual(['orphan-app-data'])
    // 切片 = 动手之前那张 21 条表。写成**谓词**而不是 slice：第 22 条排在哪儿都不该让这条判据失效，
    // 而 M5-P3 正好把它前移了 —— 留着 slice(0,21) 等于把判据钉在「它恰好在表尾」这个已经不成立的事实上。
    // M6 起第 23 条（gpu-driver-leftovers，显式路径模板族）同样用谓词点名排除，与 Rust 侧同款。
    const preExisting = BUILTIN_RULES.filter(
      (r) => r.requiresAbsentAppFact === undefined && r.id !== 'gpu-driver-leftovers'
    )
    expect(preExisting.length, '谓词取出的集合不是 21 条 —— 下面比的就不是动手之前那张表').toBe(21)

    // 哨兵自己不空转：名单要真点得出产品地板的那几根，夹具里也要真有它们的子孙当诱饵。
    // （少这一格，下面整条可以绿在"地板表解析出一片空集合、于是什么都没在防"上。）
    for (const root of ['C:\\Program Files', 'C:\\Windows', 'C:\\Windows\\System32']) {
      expect(PRODUCT_UNREACHABLE, `地板表解析不出 ${root}：${JSON.stringify(PRODUCT_UNREACHABLE)}`).toContain(root)
    }
    expect(
      Object.keys(LEAF_SPEC).some((d) => pathIsUnder(d, 'C:\\Program Files') || pathIsUnder(d, 'C:\\Windows')),
      '夹具里没有围栏外/禁止根之下的形状 —— 这台哨兵装置就是空跑'
    ).toBe(true)

    const facts = new Map<string, AppFact>([
      ['ghost', 'absent'],
      ['cache', 'absent'],
      ['someapp', 'present'],
      ['hiview', 'unknown'],
      ['local', 'absent']
    ])
    const whys = new Map<string, string>([['hiview', '夹具：这一格故意弃权']])
    const baseline = builtinSentinelRun(preExisting)
    const withTable = builtinSentinelRun(preExisting, { appFacts: facts, appFactWhys: whys })
    expect(projectReport(withTable.report)).toBe(projectReport(baseline.report))
    // 挂表之后枚举面也不许多出一处：两次跑被列举的目录逐条同（字节相同不代表没多走盘）
    expect(withTable.opened).toEqual(baseline.opened)
    expect(baseline.opened.length, '遍历根本没发生过').toBeGreaterThan(10)

    // **边界如实登记**（2026-10-20 更新）：原先 `app-cache-data` 会走进 `%LOCALAPPDATA%\Programs`
    // 并认领那 9000 字节 —— 那是内置表从未把 `%LOCALAPPDATA%\Programs\*` 放进任何一张地板表的结果
    // （plan M5-P1 §10 第 12 条把它作为"交给 T6 判的边界"登记在案，Rust 的 pre-change golden
    // 里同一格同样进账）。**CLEANUP-RULES §6 R-DENY-INSTALLDIR 把那一根升进地板之后**，
    // 这一格真机对账抓到的越界（VS Code 自带运行时的 `Cache`）终于被挡在门外 ——
    // 正是上面那句「哪天地板表加严，这两句会一起红」预告的复判，结论是**加严是对的**：
    //  `%LOCALAPPDATA%\Programs` 是**已装应用本体**，不是缓存。
    //
    // ⚠️ 所以「Programs 被枚举过」这句话今天**不再成立**（连枚举都不该发生，那才是这一根的语义）。
    // 用它当"哨兵不是空跑"的证明会变成一条恒假判据。改证**别的采集支路**确实被走到：
    // `C:\Local\SomeApp`（普通应用目录，任何地板都不碰）必须被枚举过。
    expect(baseline.opened.length, '遍历根本没发生过 —— 这台哨兵是空跑的').toBeGreaterThan(10)
    expect(
      baseline.opened.some((p) => pathIsUnder(p, 'C:\\Local\\SomeApp')),
      '普通应用目录也没被枚举 ⇒ 上面那些"没枚举 Programs"可以绿在"整棵分支压根没走到"上'
    ).toBe(true)
    expect(
      baseline.opened.some((p) => pathIsUnder(p, 'C:\\Local\\Programs')),
      '地板加严之后 Programs 仍然被枚举 —— R-DENY-INSTALLDIR 的"连枚举都不该发生"没生效'
    ).toBe(false)
    expect(
      finding(withTable.report, 'app-cache-data')!.samplePaths.some(
        (p) => p.path === 'C:\\Local\\Programs\\Microsoft VS Code\\Resources\\app\\Cache\\do-not-touch.bin'
      ),
      '地板加严之后那一格仍被认领 —— R-DENY-INSTALLDIR 的升级没落到评估层'
    ).toBe(false)

    // 第三半：装上字段就必须不一样（否则上面那条相等是恒成立的空话）
    const flagged = preExisting.map((r) =>
      (r.scanner.leafDirs ?? []).length === 0 &&
      (r.scanner.leafFiles ?? []).length === 0 &&
      r.scanner.scopeFence === undefined
        ? { ...r, riskLevel: 'high' as const, requiresAbsentAppFact: true, scanner: { ...r.scanner, scopeFence: LEAF_FENCE() } }
        : r
    )
    expect(flagged.filter((r) => r.requiresAbsentAppFact === true).length).toBeGreaterThan(0)
    const flaggedRun = builtinSentinelRun(flagged, { appFacts: facts, appFactWhys: whys })
    expect(projectReport(flaggedRun.report)).not.toBe(projectReport(baseline.report))

    // ── P2-T4 加的那一段：同一台哨兵跑**整张 22 条表**（空表 = 今天生产的默认形状）──────────
    // 第三种采集模式今天真的被走到了（`collectAppFactEntry` 要 open 三条容器根、把每个直属子目录
    // 过一遍围栏判定 + 查表），所以"从未枚举过地板根"这句话第一次不是成立在"没有规则用它"上。
    // 枚举面也比**去重后的集合**：第 22 条只许在容器规则已经打开过的那三根入口上列一次子项，
    // 一个目录都不许多碰（0 字节是结果，没多走盘才是结构）。
    const fullRun = builtinSentinelRun(BUILTIN_RULES)
    expect(
      assertRulesAccountedFor(fullRun.report, BUILTIN_RULES),
      '整张表在哨兵下的账目与 21 条那次对不上（第 22 条今天就该是弃权那一条）'
    ).toEqual(['orphan-app-data'])
    expect([...new Set(fullRun.opened)].sort()).toEqual([...new Set(baseline.opened)].sort())
  })

  /**
   * M5-P3 T1（plan `2026-10-14-deepclean-tauri-m5-p3.md` §2.5 / §3-T1 Step 2）——
   * **表序前移的正面证据**：同一个文件的赢家换成第 22 条，被抢的那两条形状规则各自收到
   * `claimed-by-other-rule` 并点名赢家。这条判据写在本轮改动**之前**，所以它今天必须红；
   * 红在「app-cache-data 没被挡住」那一格，而不是红在夹具搭不起来。
   *
   * 为什么吃整张 `BUILTIN_RULES` 而不是夹具单规则：这次改的就是**表序**，把规则拆出来单跑
   * 等于把被测的那一维拿掉（P2-T5 那节包树用例同样的处置）。
   */
  it('前移的正面证据：同一个文件的赢家换成第 22 条，形状规则收到 claimed-by-other-rule', () => {
    const facts = new Map<string, AppFact>([
      ['someapp', 'absent'],
      ['hiview', 'absent']
    ])
    const { report } = builtinSentinelRun(BUILTIN_RULES, { appFacts: facts, appFactWhys: new Map() })

    const orphan = finding(report, 'orphan-app-data')!
    expect(orphan.matchedRoots, '两个候选都没进采集根：先查表序之外的东西').toEqual(
      expect.arrayContaining(['C:\\Local\\SomeApp', 'C:\\Local\\Hiview'])
    )
    const stolenBy = (ruleId: string) =>
      report.exclusions
        .filter((e) => e.ruleId === ruleId && e.reason === 'claimed-by-other-rule')
        .map((e) => e.path)
        .sort()
    expect(stolenBy('app-cache-data'), 'app-cache-data 没被前移的第 22 条挡住 ⇒ 表序没生效').toEqual([
      'C:\\Local\\SomeApp\\Cache\\c1.bin',
      'C:\\Local\\SomeApp\\Cache\\c2.dat'
    ])
    expect(stolenBy('app-rotated-logs'), '轮转日志那四条没改姓').toEqual([
      'C:\\Local\\Hiview\\HiviewPlatform.3.log',
      'C:\\Local\\Hiview\\etl\\monitor.etl',
      'C:\\Local\\Hiview\\rot\\HiviewService.1.log',
      'C:\\Local\\Hiview\\trace.log.01'
    ])
    // 反向半边：赢家手里必须真有这两格 —— 否则上面两条可以绿在「谁都没认领」上
    const owned = orphan.samplePaths.map((p) => p.path)
    expect(owned, '第 22 条没认领这两格 ⇒ 排除记录可能绿在谁都没认领上').toEqual(
      expect.arrayContaining(['C:\\Local\\SomeApp\\Cache\\c1.bin', 'C:\\Local\\Hiview\\HiviewPlatform.3.log'])
    )
    expect(
      finding(report, 'app-cache-data')!.samplePaths.filter((p) => p.path.includes('SomeApp')),
      '掉出去的格子没掉干净'
    ).toEqual([])
  })

  /**
   * M5-P3 T1 Step 3 —— **15 条基线免疫**（这条今天绿，前移之后仍绿，只在「前移过头」那个变异下红）。
   * 它是 §0 安全边界的兑现：第 22 条可以抢六条形状规则的地盘，一个字节都不许从既有 15 条嘴里拿走。
   * 最后那句「第 22 条确实争过这个文件并被挡回来」是反空跑 —— 少了它，这条绿可能只是没走到。
   */
  it('边界：既有 15 条排在第 22 条之前，一个字节都不许被它抢走', () => {
    const facts = new Map<string, AppFact>([['npm-cache', 'absent']])
    const { report } = builtinSentinelRun(BUILTIN_RULES, { appFacts: facts, appFactWhys: new Map() })
    const npm = finding(report, 'npm-cache')!
    expect(npm.totalBytes, 'npm-cache 的地盘被第 22 条抢了 ⇒ 它排到了 15 条基线之前').toBe(80)
    expect(npm.samplePaths.map((p) => p.path)).toEqual(['C:\\Local\\npm-cache\\_cacache\\pkg.bin'])
    expect(
      report.exclusions.some(
        (e) =>
          e.ruleId === 'orphan-app-data' &&
          e.reason === 'claimed-by-other-rule' &&
          e.path === 'C:\\Local\\npm-cache\\_cacache\\pkg.bin' &&
          e.detail.includes('npm-cache')
      ),
      '第 22 条压根没碰过 pkg.bin ⇒ 这条用例什么都没钉'
    ).toBe(true)
  })

  /* ---------------------------------------------------------------- *
   * M5-P2 P2-T5（plan `2026-10-13-deepclean-tauri-m5-p2.md` §5 裁定 1）——
   * **包树不进 leaf 采集**，两侧同判据（Rust 同名同形状的 5 条在 `crates/rules/src/engine.rs`）。
   *
   * 夹具形状逐条来自真机报告 `src-tauri/target/m5-p-golden-report.json`（T6 那一次）里
   * `app-cache-data` 名下那 10 个地盘：`undici\lib\cache`、`hono\dist\middleware\cache`、
   * `npm\node_modules\make-fetch-happen\lib\cache` —— 都是 JavaScript 源码目录，名字恰好叫 `cache`。
   *
   * ⚠️ 这一组吃的是**内置表**（`BUILTIN_RULES` + 产品围栏），不是本文件上面那三条夹具规则：
   * `LEAF_FENCE()` 额外 deny 了 `%LOCALAPPDATA%\Programs\*`，而**产品地板里没有这一根**
   * （M5-P1 §10 第 12 条原文登记，本节 P2-T3 那条 `the_builtin_table_without_the_new_rule_is_byte_identical`
   * 里"边界如实登记"那两句钉的就是这件事）。
   * 拿夹具围栏跑这个形状 = 让那条从未声明过的边界顶掉包树判据去接断言，
   * 包树这一条今天根本没被走到（恒过的闸）。
   * ---------------------------------------------------------------- */

  /** 真机形状 + 每一棵包树**旁边**都留一个真缓存当非真空对照。 */
  const PKG_SPEC: Record<string, FileSpec[]> = {
    'C:\\': [],
    'C:\\Local': [{ name: 'loose.bin', size: 10 }],
    // ↓ 真机那 10 个地盘的形状
    'C:\\Local\\Programs\\nodejs\\node_modules\\undici\\lib\\cache': [
      { name: 'store.js', size: 500 },
      { name: 'cache.js', size: 700 }
    ],
    'C:\\Local\\Programs\\nodejs\\node_modules\\hono\\dist\\middleware\\cache': [{ name: 'index.js', size: 300 }],
    'C:\\Local\\Programs\\nodejs\\node_modules\\npm\\node_modules\\make-fetch-happen\\lib\\cache': [
      { name: 'entry.js', size: 250 }
    ],
    // 轮转件 glob 的同一形状（裁定 1 明写：这条判据不是只给 leafDirs 那一族）
    'C:\\Local\\Programs\\nodejs\\node_modules\\undici\\logs': [{ name: 'worker.1.log', size: 400 }],
    // Python 虚拟环境的既有形状：`venv\lib\site-packages\…\cache`
    'C:\\Local\\PyApp\\venv\\lib\\site-packages\\requests\\cache': [{ name: 'data.bin', size: 900 }],
    // `dist` 是名单里的名字，但它不是任何一条 leaf 规则的采集根，那一格里不该有东西被认领
    'C:\\Local\\WebApp\\dist\\assets': [{ name: 'chunk.js', size: 120 }],
    // ↓ 对照组：包树之外、同一条下降路径上的真缓存
    'C:\\Local\\Programs\\nodejs\\Cache': [{ name: 'real.bin', size: 800 }],
    'C:\\Local\\SomeApp\\Cache': [{ name: 'c1.bin', size: 100 }],
    'C:\\Local\\PyApp\\Cache': [{ name: 'real2.bin', size: 60 }],
    'C:\\Local\\WebApp\\Cache': [{ name: 'real3.bin', size: 70 }],
    // ↓ 回归轴那一半：这两格长在**模板地盘**（`dev-tool-cache` 的显式模板
    //   `%LOCALAPPDATA%\NuGet\v3-cache`）里，`lib` / `src` 只是模板根**下面**的目录名。
    //   模板通路走 `collectTerritory`，不经过 leaf 下降 ⇒ 那 700 字节必须照常进账。
    'C:\\Local\\NuGet\\v3-cache\\lib': [{ name: 'http.bin', size: 400 }],
    'C:\\Local\\NuGet\\v3-cache\\src': [{ name: 'feed.bin', size: 300 }],
    // ↓ 2026-10-20：`%LOCALAPPDATA%\Programs` 进了 REPORT_ONLY（cleanup-rules §6 R-DENY-INSTALLDIR）。
    //   于是上面 `Programs\nodejs` 那一整支从"包树判据在挡"变成"只上报根在挡" ——
    //   主判据与反向半边都要另找一个**不被任何新门挡住**的邻层。与 Rust
    //   `engine.rs::tests::package_tree_tree` 逐条同形。
    'C:\\Local\\Portable\\node_modules\\undici\\lib\\cache': [{ name: 'store.js', size: 500 }],
    'C:\\Local\\Portable\\node_modules\\undici\\logs': [{ name: 'worker.1.log', size: 400 }],
    // 这一支的非真空对照：同一条下降路径上、包树之外的真缓存
    'C:\\Local\\Portable\\Cache': [{ name: 'real.bin', size: 800 }]
  }

  /**
   * 交给哨兵的包树根（枚举到就 throw）—— 与 Rust `PACKAGE_TREE_SENTINEL_ROOTS` 同四条。
   *
   * 两条 `node_modules` 根都要在：`Programs\` 那一支现在还被 REPORT_ONLY 挡着
   * （cleanup-rules §6），只有 `Portable\` 这一支真能验到包树判据本身。
   */
  const PKG_ROOTS = [
    'C:\\Local\\Programs\\nodejs\\node_modules',
    'C:\\Local\\Portable\\node_modules',
    'C:\\Local\\PyApp\\venv',
    'C:\\Local\\WebApp\\dist'
  ]

  /** 真机点名那五个形状（"一个字节都没进账"必须是这五个，不是恰好没别的）。 */
  const PKG_SOURCE_FILES = [
    'C:\\Local\\Programs\\nodejs\\node_modules\\undici\\lib\\cache\\store.js',
    'C:\\Local\\Programs\\nodejs\\node_modules\\undici\\lib\\cache\\cache.js',
    'C:\\Local\\Programs\\nodejs\\node_modules\\hono\\dist\\middleware\\cache\\index.js',
    'C:\\Local\\Programs\\nodejs\\node_modules\\npm\\node_modules\\make-fetch-happen\\lib\\cache\\entry.js',
    'C:\\Local\\PyApp\\venv\\lib\\site-packages\\requests\\cache\\data.bin'
  ]

  it('a_source_directory_named_cache_under_a_package_tree_is_never_claimed', () => {
    const { report } = sentinelRun(BUILTIN_RULES, {}, PKG_SPEC)
    const c = claimedOf(report)
    for (const p of PKG_SOURCE_FILES)
      expect(c.some((x) => normalizeKey(x) === normalizeKey(p)), `${p} 被认领了 —— 那是已装应用的代码`).toBe(false)
    for (const g of PKG_ROOTS)
      expect(c.some((p) => pathIsUnder(p, g)), `认领了包树根 ${g} 之下的东西`).toBe(false)

    const ex = report.exclusions.filter((e) => e.reason === 'package-tree')
    expect(ex.length, '包树被跳过了却没留下任何一条 package-tree —— 报告读起来就像那棵子树不存在').toBeGreaterThan(0)
    // ⚠️ 找 `Portable` 那一支：`Programs\node_modules` 现在被 REPORT_ONLY 挡着
    // （cleanup-rules §6 R-DENY-INSTALLDIR），它的排除理由是 report-only-root，
    // 到不了 package-tree 这一步。
    const named = ex.find((e) => normalizeKey(e.path) === normalizeKey('C:\\Local\\Portable\\node_modules'))
    expect(named, '必须点名到 …\\Portable\\node_modules 那一个具体目录，不许只报总数').toBeDefined()
    expect(named!.ruleId).toBe('app-cache-data')
    expect(named!.detail).toContain('node_modules')
    // 排除记录点名的是**包树目录本身**，不是它下面那条源码路径
    expect(normalizeKey(named!.path)).toBe(normalizeKey('C:\\Local\\Portable\\node_modules'))
    expect(assertRulesAccountedFor(report, BUILTIN_RULES)).toEqual(['orphan-app-data'])
    expect(report.findings.length, '既有二十二条都要上线').toBe(22)
  })

  it('package_trees_are_not_enumerated_not_filtered', () => {
    // 同一台 `attrTree`、同一句 throw，只是把包树根**追加**进不可达名单。
    // 跑到最后没 throw 就是判据成立；下面四段是"这台哨兵不是空跑"的自证。
    const { report, opened } = sentinelRun(BUILTIN_RULES, {}, PKG_SPEC, PKG_ROOTS)

    // ① 活跑过：不是一上来整条规则被拒（那也会被误读成"一次都没枚举"）
    expect(report.rejectedRules.length, JSON.stringify(report.rejectedRules)).toBe(0)
    expect(report.findings.length).toBe(22)
    expect(opened.length, '遍历根本没发生过 —— 这台哨兵是空跑的').toBeGreaterThan(10)
    // ② 可复算的"没响"：被枚举的目录集合里一个包树根之下都没有
    for (const g of PKG_ROOTS) expect(opened.filter((p) => pathIsUnder(p, g)), `枚举了 ${g} 之下`).toEqual([])
    // ③ 反向半边：包树的**父层**必须被枚举过，否则上面两段可以绿在
    //    "整棵 Portable 分支压根没走到"上（那是别的门挡住的，不是包树这一条在起作用）。
    //    探针取 `Portable`（node_modules 的**父级**）：`Portable\node_modules` 本身正是
    //    包树判据要跳过的目录，要求它被枚举等于要求判据失效。
    //    （原来这条用 `Programs\nodejs`，同一形状；cleanup-rules §6 之后 Programs 整棵进了
    //     REPORT_ONLY，于是挪到 Portable 这一支。）
    expect(opened, '连 …\\Portable 都没枚举 ⇒ 判据其实没被走到').toContain('C:\\Local\\Portable')
    // ④ 这台装置真的认追加进来的名单（否则"没响"只等于"名单没生效"）
    const armed = attrTree(PKG_SPEC, [], PKG_ROOTS)
    const baitId = armed.src.dirIdByPath('C:\\Local\\Portable\\node_modules')
    expect(baitId, '夹具里根本没有那个目录 —— 诱饵没上树').toBeDefined()
    expect(() => armed.src.childrenOf(baitId!)).toThrow()
    // ⑤ 两种 leaf 模式都吃这条判据：`leafDirs` 与 `leafFiles` 名下都要各有 package-tree
    for (const id of ['app-cache-data', 'app-rotated-logs', 'installer-artifacts', 'crash-dumps'])
      expect(
        report.exclusions.some((e) => e.reason === 'package-tree' && e.ruleId === id),
        `规则 ${id} 的 leaf 下降没留下 package-tree —— 判据漏了它这一族`
      ).toBe(true)
  })

  it('a_real_cache_next_to_a_package_tree_is_still_found', () => {
    const { report } = sentinelRun(BUILTIN_RULES, {}, PKG_SPEC)
    const c = claimedOf(report)
    // 四棵真缓存：其中一棵与包树**同一个父目录**。
    // ⚠️ 探针用 `Portable` 那一支：`Programs\nodejs\Cache` 整棵在 REPORT_ONLY 里
    // （cleanup-rules §6 R-DENY-INSTALLDIR），照常枚举、照实报占用，但没有规则能认领它。
    for (const p of [
      'C:\\Local\\Portable\\Cache\\real.bin',
      'C:\\Local\\SomeApp\\Cache\\c1.bin',
      'C:\\Local\\PyApp\\Cache\\real2.bin',
      'C:\\Local\\WebApp\\Cache\\real3.bin'
    ])
      expect(c.some((x) => normalizeKey(x) === normalizeKey(p)), `${p} 没被认领 —— 采集整段坏了，上面两条『没认领』就是假绿`).toBe(true)
    const f = finding(report, 'app-cache-data')!
    expect(f.totalBytes, `实得 ${JSON.stringify(f.samplePaths)}`).toBe(800 + 100 + 60 + 70)
    expect(f.matchedRoots).toContain('C:\\Local\\Portable\\Cache')
    expect(f.matchedRoots).toContain('C:\\Local\\PyApp\\Cache')
  })

  it('plain_template_rules_are_unaffected_by_the_package_tree_list', () => {
    const { report } = sentinelRun(BUILTIN_RULES, {}, PKG_SPEC)
    // ① 模板地盘里的 `lib` / `src`：700 字节照常认领（少了这一半，"模板没受影响"
    //    可以绿在"模板通路压根没在这棵树上收到东西"上）
    const d = finding(report, 'dev-tool-cache')!
    expect([d.fileCount, d.totalBytes], `模板地盘下的包树名字目录被挡了 —— 判据越界到 collectTerritory：${JSON.stringify(d.samplePaths)}`).toEqual([2, 700])
    // ② 模板规则名下一条 package-tree 都不许出现（出现了就是判据伸进了模板通路）
    const byId = new Map(BUILTIN_RULES.map((r) => [r.id, r]))
    for (const e of report.exclusions.filter((x) => x.reason === 'package-tree')) {
      const r = e.ruleId === null ? undefined : byId.get(e.ruleId)
      expect(r, `package-tree 记在一条不存在的规则名下：${JSON.stringify(e)}`).toBeDefined()
      expect(
        (r!.scanner.leafDirs ?? []).length > 0 || (r!.scanner.leafFiles ?? []).length > 0,
        `非 leaf 规则 ${e.ruleId} 记了一条 package-tree（${e.path}）—— 判据作用域越界`
      ).toBe(true)
    }
    expect(report.exclusions.some((e) => e.reason === 'package-tree'), '这条回归轴什么都没比：一份 package-tree 都没有').toBe(true)
    // ③ 把 21 条的 leaf 判据全部摘成显式空值再跑同一棵树，模板那几条的 finding 逐字节相同
    const templated: Rule[] = BUILTIN_RULES.map((r) => ({
      ...r,
      scanner: { ...r.scanner, leafDirs: [], leafFiles: [] }
    }))
    const cleared = sentinelRun(templated, {}, PKG_SPEC)
    for (const id of ['dev-tool-cache', 'user-downloads-installers', 'windows-temp', 'npm-cache', 'browser-cache'])
      expect(JSON.stringify(finding(cleared.report, id)), `模板规则 ${id} 的产出因为包树名单变了`).toBe(
        JSON.stringify(finding(report, id))
      )
  })

  it('the_package_tree_list_is_identical_on_both_sides', () => {
    const rsPath = join(process.cwd(), 'src-tauri', 'crates', 'rules', 'src', 'types.rs')
    const src = readFileSync(rsPath, 'utf8')
    const rust = parseNameList(src, 'pub const PACKAGE_TREE_NAMES', rsPath)
    expect(rust, `Rust 侧包树名单与 TS 侧不同序或不同串（Rust 取自 ${rsPath}）`).toEqual([...PACKAGE_TREE_NAMES])
    expect(PACKAGE_TREE_NAMES.length).toBe(10)
    // 反向半边：判据的**串**与真机那三棵树的名字对得上（漏一个名字就是那条规则还在吃源码）
    for (const n of ['node_modules', 'site-packages', 'dist', 'lib', 'src', 'build', '.git', 'target', 'venv', '.venv'])
      expect(PACKAGE_TREE_NAMES, `名单里少了 ${n}`).toContain(n)
  })



  /* ---------------------------------------------------------------- *
   * 回归轴 —— 「不带新字段的规则，产出与改动前逐字段等」
   * ---------------------------------------------------------------- */

  /** 定序数组投影（与 Rust `engine.rs::project` 同一份元素与同一个次序）。 */
  const cmpRow = (a: string[], b: string[]): number => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1
    }
    return a.length - b.length
  }
  const projectReport = (report: ReturnType<typeof evaluateRules>): string => {
    const findings = report.findings.map((f) => [
      f.ruleId,
      String(f.fileCount),
      String(f.totalBytes),
      f.matchedRoots,
      f.samplePaths.map((p) => [p.path, String(p.size)]),
      f.sampleTruncated,
      f.riskLevel,
      f.category
    ])
    const exclusions = report.exclusions
      .map((e) => [e.ruleId ?? '', e.reason, e.path])
      .sort(cmpRow)
    const rejected = report.rejectedRules.map((r) => {
      const reasons = r.problems.map((p) => p.reason).sort()
      return [r.ruleId, ...reasons]
    })
    const territories = report.territories.map((t) => [
      t.ruleId,
      t.detectorAbsent,
      t.present.map((p) => [p.path, p.bytes === null || p.bytes === undefined ? '~' : String(p.bytes)]),
      String(t.notScanned)
    ])
    const b = report.bytesByRisk
    return JSON.stringify([
      findings,
      exclusions,
      rejected,
      territories,
      [String(b.safe), String(b.caution), String(b.high), String(b.forbidden)],
      String(report.reclaimableBytes),
      report.safetyBlocked
    ])
  }

  /** 三条不带新字段的规则 + 一条被声明层拒掉的 —— 覆盖 findings / 两种排除 / 底账 / 被拒四格。 */
  const legacyRules = (): Rule[] => [
    rule({ id: 'legacy-literal', paths: ['%LOCALAPPDATA%\\SomeApp'] }),
    rule({ id: 'legacy-wild', paths: ['%LOCALAPPDATA%\\*\\Cache'], riskLevel: 'caution' }),
    rule({
      id: 'legacy-nonrec',
      paths: ['%LOCALAPPDATA%\\Hiview'],
      scanner: { filePatterns: ['*.log'], olderThanDays: null, recursive: false }
    }),
    rule({ id: 'legacy-detector', paths: ['%TEMP%\\Nope'], riskLevel: 'caution', requiresDetector: 'npm' }),
    rule({ id: 'legacy-forbidden', paths: ['%WINDIR%\\System32'] })
  ]

  /**
   * 改动前（leaf 遍历 / 围栏不枚举 / 机器事实闸都还没落地那一份代码）录下的投影基线，
   * 与 Rust `engine.rs::NO_LEAF_GOLDEN` 是**同一个串** —— 两侧现在还能各自复现它，
   * 就是"不带新字段的规则一个字节都没被改动影响"这件事的证据。
   */
  const NO_LEAF_GOLDEN =
    '[[["legacy-literal","3","193",["C:\\\\Local\\\\SomeApp"],[["C:\\\\Local\\\\SomeApp\\\\Cache\\\\c1.bin","100"],["C:\\\\Local\\\\SomeApp\\\\Cache\\\\c2.dat","60"],["C:\\\\Local\\\\SomeApp\\\\LocalCache\\\\look.bin","33"]],false,"safe","temp"],["legacy-wild","3","435",["C:\\\\Local\\\\Junction\\\\Cache","C:\\\\Local\\\\SomeApp\\\\Cache","C:\\\\Local\\\\Twin\\\\Cache"],[["C:\\\\Local\\\\Junction\\\\Cache\\\\via-junction.bin","400"],["C:\\\\Local\\\\Twin\\\\Cache\\\\Cache\\\\nested.bin","5"],["C:\\\\Local\\\\Twin\\\\Cache\\\\inner.bin","30"]],false,"caution","temp"],["legacy-nonrec","2","1600",["C:\\\\Local\\\\Hiview"],[["C:\\\\Local\\\\Hiview\\\\HiviewPlatform.3.log","400"],["C:\\\\Local\\\\Hiview\\\\HiviewPlatform.log","1200"]],false,"safe","temp"],["legacy-detector","0","0",[],[],false,"caution","temp"]],[["legacy-detector","not-scanned","C:\\\\Temp\\\\Nope"],["legacy-forbidden","rule-rejected","%WINDIR%\\\\System32"],["legacy-wild","claimed-by-other-rule","C:\\\\Local\\\\SomeApp\\\\Cache\\\\c1.bin"],["legacy-wild","claimed-by-other-rule","C:\\\\Local\\\\SomeApp\\\\Cache\\\\c2.dat"],["legacy-wild","not-scanned","C:\\\\Local\\\\Crx\\\\Cache"],["legacy-wild","not-scanned","C:\\\\Local\\\\Deep\\\\Cache"],["legacy-wild","not-scanned","C:\\\\Local\\\\Ghost\\\\Cache"],["legacy-wild","not-scanned","C:\\\\Local\\\\Hiview\\\\Cache"],["legacy-wild","not-scanned","C:\\\\Local\\\\Packages\\\\Cache"],["legacy-wild","not-scanned","C:\\\\Local\\\\Programs\\\\Cache"],["legacy-wild","not-scanned","C:\\\\Local\\\\Repo\\\\Cache"],["legacy-wild","not-scanned","C:\\\\Local\\\\foo-updater\\\\Cache"],["legacy-wild","not-scanned","C:\\\\Local\\\\git\\\\Cache"],["legacy-wild","not-scanned","C:\\\\Local\\\\npm-cache\\\\Cache"]],[["legacy-forbidden","forbidden-root"]],[["legacy-detector",false,[],"1"]],["1793","435","0","0"],"2228",false]'

  it('no_leaf_rules_means_byte_identical_findings', () => {
    const { report } = leafRun(legacyRules())
    expect(projectReport(report)).toBe(NO_LEAF_GOLDEN)

    // 第二半：把三个新字段**显式写成空值**，与"根本没写"必须同一个投影 ——
    // 读空数组与读 undefined 不许分叉出第三种真相
    const spelled = legacyRules().map((r) => ({
      ...r,
      scanner: { ...r.scanner, leafDirs: [], leafFiles: [], scopeFence: undefined },
      requiresAbsentAppFact: undefined
    }))
    const second = leafRun(spelled)
    expect(projectReport(second.report)).toBe(NO_LEAF_GOLDEN)
  })
})
