/**
 * Task 16 —— 规则登记表（§26 Phase 4 首批：Temp / Browser Cache / Thumbnail Cache /
 * Shader Cache / Recycle Bin / Error Reporting，外加「逐步增加」里的 npm / pip / Gradle / VS Code）。
 *
 * 这里守的是**数据**的底线：规则是声明式数据（§15「规则不是直接写死删除路径，而是定义规则」），
 * 所以①字段齐全、②风险等级符合 §16、③通得过 §28 原则四的叶子路径校验、
 * ④没有任何函数字段（= 结构上不可能自带删除行为）。
 */
import { describe, expect, it } from 'vitest'
import { TreeStore } from '../../core/scan/tree-store'
import { parentOf } from '../../core/fs/pathutil'
import { BUILTIN_RULES, FORBIDDEN_PATH_PATTERNS, REPORT_ONLY_ROOT_PATTERNS, RULE_ENV_KEYS } from '../../core/rules/registry'
import { FENCE_MINIMUM_DENY_PATTERNS } from '../../core/rules/types'
import { defaultUnselectableRuleIds } from '../../core/rules/registry'
import { ruleShapeProblems, type Rule, type RuleEnv } from '../../core/rules/types'
import { evaluateRules, validateRuleSet } from '../../core/rules/engine'
import { classifyPath, RISK_BY_GROUP } from '../../shared/classify'

/** 合成机器：单测里唯一的 env 来源（约束 7）。用户名故意用 Kano，与真机无关。
 * M5-P1 T3a 起补 `PROGRAMFILES`（`RULE_ENV_KEYS` 的第 8 键，plan §4.1）：表尾三条是容器入口规则，
 * 围栏的 denyRoots 必须能点名 `%PROGRAMFILES%\*`。缺这个键它们会被声明层 fail-closed 整条拒掉 ——
 * 那时"整表自检"绿在十五条上，而三条根本没上线（假绿），下面的字节合计也会跟着假平。 */
const SYNTH_ENV: RuleEnv = {
  SYSTEMDRIVE: 'C:\\',
  WINDIR: 'C:\\Windows',
  TEMP: 'C:\\Users\\Kano\\AppData\\Local\\Temp',
  LOCALAPPDATA: 'C:\\Users\\Kano\\AppData\\Local',
  APPDATA: 'C:\\Users\\Kano\\AppData\\Roaming',
  PROGRAMDATA: 'C:\\ProgramData',
  PROGRAMFILES: 'C:\\Program Files',
  USERPROFILE: 'C:\\Users\\Kano'
}

const DAY = 86_400_000
const NOW = 1_700_000_000_000

function storeFrom(spec: Record<string, Array<{ name: string; size: number; attrs?: number }>>): TreeStore {
  // 补齐祖先链：树上没有中间层目录，规则就没法逐级钻到叶子（真实扫描出来的树天然带全祖先）
  const keys = Object.keys(spec)
  const dirs = new Set<string>(keys)
  for (const k of keys) {
    let cur = parentOf(k)
    while (cur !== null && !dirs.has(cur)) {
      dirs.add(cur)
      cur = parentOf(cur)
    }
  }
  const ordered = [...dirs].sort(
    (a, b) => a.split('\\').filter(Boolean).length - b.split('\\').filter(Boolean).length
  )
  const store = new TreeStore({ rootPath: ordered[0]!, maxFiles: 1_000_000 })
  for (const dir of ordered) {
    const id = store.beginDir(dir)
    const p = parentOf(dir)
    if (p !== null) {
      const pid = store.dirIdByPath(p)
      if (pid !== undefined) store.attachChild(pid, id)
    }
    store.addFilesToDir(
      id,
      (spec[dir] ?? []).map((f) => ({ name: f.name, size: f.size, mtimeMs: NOW - 30 * DAY, birthtimeMs: NOW - 60 * DAY, attrs: f.attrs ?? 0 }))
    )
  }
  store.finalizeDir(store.rootId)
  return store
}

/** 一个「像真的」的用户目录树：首批六类规则的目标目录全在里面，另外埋着 🔴 陷阱。 */
const profileTree = (): TreeStore =>
  storeFrom({
    'C:\\': [{ name: 'pagefile.sys', size: 100 }],
    'C:\\$Recycle.Bin': [],
    'C:\\$Recycle.Bin\\S-1-5-21-404': [
      { name: '$Ireport.docx', size: 4000 },
      { name: '$Rreport.docx', size: 60_000 }
    ],
    'C:\\Windows': [],
    'C:\\Windows\\System32': [{ name: 'ntoskrnl.exe', size: 9_000_000 }],
    'C:\\Windows\\System32\\CatRoot2': [{ name: 'cat.cat', size: 8_000_000 }],
    'C:\\Windows\\WinSxS': [{ name: 'folder1.bin', size: 7_000_000 }],
    'C:\\Windows\\Installer': [{ name: 'a1b2c3.msi', size: 6_000_000 }],
    'C:\\Users\\Kano\\AppData\\Local\\Temp': [
      { name: '~DF01.tmp', size: 1000 },
      { name: 'setup.log', size: 200 }
    ],
    'C:\\Users\\Kano\\AppData\\Local\\Temp\\WinRAR$R01': [{ name: 'payload.bin', size: 5000 }],
    'C:\\Users\\Kano\\AppData\\Local\\Microsoft\\Windows\\Explorer': [
      { name: 'thumbcache_idx.db', size: 100 },
      { name: 'thumbcache_256.db', size: 9000 },
      { name: 'iconcache_256.db', size: 8000 },
      { name: 'ED16D50E9C168890', size: 10 }
    ],
    'C:\\Users\\Kano\\AppData\\Local\\Microsoft\\Windows\\WER\\ReportQueue': [{ name: 'Report.wer', size: 300 }],
    'C:\\Users\\Kano\\AppData\\Local\\Microsoft\\Windows\\WER\\ReportArchive': [{ name: 'Report2.wer', size: 400 }],
    'C:\\Users\\Kano\\AppData\\Local\\Microsoft\\Windows\\WER\\Temp': [{ name: 'x.tmp', size: 50 }],
    'C:\\ProgramData\\Microsoft\\Windows\\WER\\ReportQueue': [{ name: 'sys.wer', size: 700 }],
    'C:\\Users\\Kano\\AppData\\Local\\D3DSCache': [{ name: 'D3DSCache.idx', size: 2000 }],
    'C:\\Users\\Kano\\AppData\\Local\\NVIDIA\\DXCache': [{ name: 'nv_.bin', size: 3000 }],
    'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache': [
      { name: 'f_00000a', size: 4000 }
    ],
    'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache\\Cache_Data': [
      { name: 'index', size: 400 }
    ],
    'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Code Cache': [
      { name: 'f_00000b', size: 500 }
    ],
    'C:\\Users\\Kano\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache': [
      { name: 'f_00000c', size: 600 }
    ],
    'C:\\Users\\Kano\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Code Cache': [
      { name: 'f_00000d', size: 700 }
    ],
    // —— 开发环境批次（§16 🟡）：地盘外的邻居文件故意放进来，规则一律不许顺手扫走
    'C:\\Users\\Kano\\AppData\\Local\\npm-cache\\_cacache\\index-v5': [{ name: 'shasum', size: 1200 }],
    'C:\\Users\\Kano\\AppData\\Local\\pip\\Cache': [{ name: 'numpy.whl', size: 300 }],
    'C:\\Users\\Kano\\.gradle\\caches\\modules-2': [{ name: 'dep.jar', size: 900 }],
    'C:\\Users\\Kano\\.gradle': [{ name: 'gradle.properties', size: 77 }],
    'C:\\Users\\Kano\\AppData\\Roaming\\Code\\Cache': [{ name: 'data', size: 110 }],
    'C:\\Users\\Kano\\AppData\\Roaming\\Code\\CachedData': [{ name: 'bundle.js', size: 40 }],
    'C:\\Users\\Kano\\AppData\\Roaming\\Code\\User': [{ name: 'settings.json', size: 512 }],
    // —— §21 后半批（Maven / pnpm / Yarn / Hugging Face / Android）：每条目盘外都埋一个"看着像缓存其实不是"的邻居
    'C:\\Users\\Kano\\.m2\\repository\\org\\a\\1.0': [{ name: 'a.jar', size: 800 }],
    'C:\\Users\\Kano\\.m2': [{ name: 'settings.xml', size: 200 }],
    'C:\\Users\\Kano\\AppData\\Local\\pnpm-store\\v3\\files\\aa': [{ name: 'blob', size: 600 }],
    'C:\\Users\\Kano\\AppData\\Local\\Yarn\\Cache\\v6': [{ name: 'yarn-1.tgz', size: 400 }],
    'C:\\Users\\Kano\\.cache\\huggingface\\hub\\models': [{ name: 'f.bin', size: 1000 }],
    'C:\\Users\\Kano\\.cache\\something-else': [{ name: 'other.bin', size: 300 }],
    'C:\\Users\\Kano\\AppData\\Local\\Android\\Sdk\\.temp': [{ name: 'installer.zip', size: 500 }],
    'C:\\Users\\Kano\\AppData\\Local\\Android\\Sdk\\platform-tools': [{ name: 'adb.exe', size: 700 }],
    'C:\\Users\\Kano\\Documents': [{ name: 'thesis.docx', size: 500_000 }]
  })

const byId = (id: string): Rule => {
  const r = BUILTIN_RULES.find((x) => x.id === id)
  if (!r) throw new Error(`注册表缺规则 ${id}`)
  return r
}
const ids = BUILTIN_RULES.map((r) => r.id)

describe('§15 规则形状：九字段齐全且是纯数据', () => {
  it('每条规则的 id / name / category / description / paths / scanner / riskLevel / cleanStrategy / recoverable 都在位', () => {
    expect(BUILTIN_RULES.length).toBeGreaterThanOrEqual(6)
    for (const r of BUILTIN_RULES) {
      expect(ruleShapeProblems(r), `规则 ${r.id} 形状不合格`).toEqual([])
      expect(r.id).toBeTruthy()
      expect(r.description.length, `${r.id} 得对外说明白这是什么`).toBeGreaterThan(10)
      expect(r.paths.length).toBeGreaterThan(0)
    }
  })

  it('id 唯一（否则 §17 预览的选择态会串台）', () => {
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('规则里一个函数都没有 —— 结构上不可能自带删除/执行能力（约束 4）', () => {
    const walk = (v: unknown, path: string): string[] => {
      if (typeof v === 'function') return [path]
      if (Array.isArray(v)) return v.flatMap((x, i) => walk(x, `${path}[${i}]`))
      if (v !== null && typeof v === 'object')
        return Object.entries(v).flatMap(([k, x]) => walk(x, `${path}.${k}`))
      return []
    }
    for (const r of BUILTIN_RULES) expect(walk(r, r.id), `${r.id} 含函数字段`).toEqual([])
  })

  it('paths 里的 %VAR% 全在已登记的环境变量名单内（拼错的变量不许静默零命中）', () => {
    for (const r of BUILTIN_RULES) {
      for (const p of r.paths) {
        for (const m of p.matchAll(/%([A-Za-z0-9_]+)%/g)) {
          expect(RULE_ENV_KEYS, `${r.id} 用了未登记变量 %${m[1]}%`).toContain(m[1]!)
        }
      }
    }
  })
})

describe('§26 Phase 4 首批覆盖面 + §16 风险等级', () => {
  it('§26 首批六类（Temp / 浏览器缓存 / 缩略图 / Shader / 错误报告 / 回收站）都在表上', () => {
    const cats = new Set(BUILTIN_RULES.map((r) => r.category))
    for (const c of ['temp', 'browser-cache', 'thumbnail-cache', 'shader-cache', 'error-reporting', 'recycle-bin'] as const)
      expect([...cats], `缺 category ${c}`).toContain(c)
    // 表上不允许出现清单之外的野 category。
    // M5-P1 T3a：追加两个新类别 —— `app-transient`（5.1/5.2 缓存与轮转日志）、
    // `installer-leftover`（5.3 更新包）。
    // M5-P2 P2-T4：再加 `orphan-data`（plan §2.6 第 22 条）—— 它**不是**并进 `app-transient`
    // 的那一种：那一族说"运行期产物、能再生"，这一条的地盘是应用本体的设置与数据（spec §4.3）。
    // 这份闭集与 `rules-types.test.ts` 的 `RULE_CATEGORIES`（十一个成员的线格式闭集）
    // **不是一张表**：这里数的是"表上真出现了哪几类"，那边数的是"类型系统允许哪几类"。
    // `duplicate` 仍然留在那边（§20 的重复文件不是规则表里的条目）。
    expect([...cats].sort()).toEqual(
      [
        'app-transient',
        'browser-cache',
        'dev-cache',
        'error-reporting',
        'installer-leftover',
        'orphan-data',
        'recycle-bin',
        'shader-cache',
        'temp',
        'thumbnail-cache'
      ].sort()
    )
  })

  it('M5-P1 T3a 三条容器入口规则各自的声明在位（plan §5.1–§5.3）', () => {
    // 相对顺序，不写下标：M5-P3 把第 22 条插进了这一段，`slice(15, 18)` 会红在产品正确的那句话上。
    // 这六条**彼此**的次序才是 `claimed` 计账要钉的东西，区间上下界归 P3 那条位置判据管。
    const ids = BUILTIN_RULES.map((r) => r.id)
    const at = (id: string) => {
      const n = ids.indexOf(id)
      expect(n, `表上没有 ${id}`).toBeGreaterThanOrEqual(0)
      return n
    }
    expect(at('android-sdk-temp'), '容器入口那一族排到了既有 15 条之前').toBeLessThan(at('app-cache-data'))
    expect(at('app-cache-data')).toBeLessThan(at('app-rotated-logs'))
    expect(at('app-rotated-logs')).toBeLessThan(at('installer-artifacts'))
    const ROOTS = ['%LOCALAPPDATA%', '%APPDATA%', '%PROGRAMDATA%']
    for (const id of ['app-cache-data', 'app-rotated-logs', 'installer-artifacts']) {
      const r = byId(id)
      expect(r.paths, `${id} 的入口就是 AppData 三根`).toEqual(ROOTS)
      expect(r.riskLevel, `${id} 是 🟡`).toBe('caution')
      expect(r.cleanStrategy).toBe('delete-all')
      expect(r.requiresDetector, `${id} 不挂探测器`).toBeUndefined()
      expect(r.excludedFromDefaultSelection, `${id} 默认勾选`).toBeUndefined()
      // 容器入口三件套：paths + leaf* + scopeFence，缺任一样声明层就整条拒
      const fence = r.scanner.scopeFence
      expect(fence, `${id} 没有 scopeFence：leaf 判据裸奔会吃到 Program Files（plan §0.1）`).toBeDefined()
      expect(fence!.allowRoots).toEqual(ROOTS)
      // 围栏的地板（spec §2.3 / plan §4.2）：禁止根全集由 `%WINDIR%\*` 覆盖，两处 Program Files 点名
      for (const d of ['%WINDIR%\\*', '%PROGRAMFILES%\\*', '%SYSTEMDRIVE%\\Program Files (x86)\\*', '%SYSTEMDRIVE%\\System Volume Information', '%PROGRAMDATA%\\Microsoft\\Windows Defender\\*'])
        expect(fence!.denyRoots, `${id} 的 denyRoots 少了 ${d}`).toContain(d)
      expect(
        [...r.scanner.leafDirs ?? [], ...r.scanner.leafFiles ?? []].length,
        `${id} 没有 leaf 判据 = 容器地盘`
      ).toBeGreaterThan(0)
      // 裁定 1：leafDirs 与 leafFiles 互斥
      expect(
        [r.scanner.leafDirs?.length ?? 0, r.scanner.leafFiles?.length ?? 0].filter((n) => n > 0).length,
        `${id} 同时给了 leafDirs 与 leafFiles`
      ).toBe(1)
    }
    expect(byId('app-cache-data').recoverable).toBe(true)
    expect(byId('app-rotated-logs').recoverable, '日志删了就没了，不像缓存能再生').toBe(false)
    expect(byId('installer-artifacts').recoverable).toBe(true)
    expect(byId('app-cache-data').category).toBe('app-transient')
    expect(byId('app-rotated-logs').category).toBe('app-transient')
    expect(byId('installer-artifacts').category).toBe('installer-leftover')
    // 名单内容比**字面量**，不比 registry 里那些常量本身 —— 拿常量比常量是自我印证，
    // 放宽判据时两边一起变，这条照样绿（Rust 侧 `builtin.rs` 同一个姿态）。
    expect([...(byId('app-cache-data').scanner.leafDirs ?? [])], 'plan §5.1 的 12 个名字，逐字同序').toEqual([
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
    ])
    expect(
      [...(byId('app-rotated-logs').scanner.leafFiles ?? [])],
      'plan §5.2 只认轮转件：`*.?.log` 放宽成 `*.log` 就是把在写的日志吃掉（plan §7 变异 4）'
    ).toEqual(['*.?.log', '*.log.??', '*.etl'])
    expect(
      [...(byId('installer-artifacts').scanner.leafDirs ?? [])],
      'plan §5.3 的更新目录名单：**没有 Packages**（plan §7 变异 3）'
    ).toEqual(['*updater', '*Updater', 'pending', 'Update', 'updates'])
    expect([...(byId('installer-artifacts').scanner.filePatterns ?? [])], 'plan §5.3 的安装包形状').toEqual([
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
    ])
    expect(byId('app-cache-data').scanner.filePatterns, '全收（plan §5.1）').toEqual([])
    // plan §5 第一条排除项的 TS 半边：`Packages` 不许是任何一条规则的 leafDirs 整名。
    // 这里只能按整名比 —— `nameMatches` 住在 engine.ts 里没导出，测试自己抄一把 glob
    // 就是第二把尺子（plan 的「不许新增第二把 glob」同样管到测试）。行为面的证明在
    // `rules-engine.test.ts` 的 UWP Packages 用例，那边吃的是真表。
    for (const r of BUILTIN_RULES) {
      for (const d of r.scanner.leafDirs ?? [])
        expect(d.toLowerCase(), `${r.id} 的 leafDirs 命中了 UWP 的 Packages`).not.toBe('packages')
    }
  })

  it('M5-P1 T3b-i 两条规则各自的声明在位：dev-tool-cache 走显式模板、crash-dumps 走容器入口（plan §5.4–§5.5，表 23 条）', () => {
    expect(BUILTIN_RULES.length).toBe(23)
    // 同 T3a 那条：比相对次序，不比下标（M5-P3 的第 22 条就插在这个区间里）
    const ids = BUILTIN_RULES.map((r) => r.id)
    const at = (id: string) => {
      const n = ids.indexOf(id)
      expect(n, `表上没有 ${id}`).toBeGreaterThanOrEqual(0)
      return n
    }
    expect(at('installer-artifacts')).toBeLessThan(at('dev-tool-cache'))
    expect(at('dev-tool-cache'), 'dev-tool-cache 与 crash-dumps 换了次序 = 换了两条规则的计账先后').toBeLessThan(at('crash-dumps'))
    const by = (id: string) => byId(id)

    // 期望值写死在断言行里，不指回 registry 里的那些串 —— 拿实现比实现是自我印证（Rust 侧同姿态）
    expect(by('dev-tool-cache').paths, 'plan §5.4 的六个显式模板，逐字同序').toEqual([
      '%LOCALAPPDATA%\\electron\\Cache',
      '%LOCALAPPDATA%\\electron-builder\\Cache',
      '%LOCALAPPDATA%\\NuGet\\v3-cache',
      '%LOCALAPPDATA%\\NuGet\\Cache',
      '%PROGRAMDATA%\\USOShared',
      '%PROGRAMDATA%\\USOPrivate'
    ])
    expect(by('dev-tool-cache').category).toBe('app-transient')
    expect(by('dev-tool-cache').riskLevel, 'plan §5.4 是 🟡').toBe('caution')
    expect(by('dev-tool-cache').cleanStrategy).toBe('delete-all')
    expect(by('dev-tool-cache').recoverable, '缓存删了能重新下载').toBe(true)
    expect(by('dev-tool-cache').requiresDetector, 'dev-tool-cache 不许挂探测器').toBeUndefined()
    expect(by('dev-tool-cache').excludedFromDefaultSelection, '🟡 默认勾选').toBeUndefined()
    expect(by('dev-tool-cache').scanner.filePatterns, '全收：这条不靠扩展名过滤').toEqual([])
    expect(by('dev-tool-cache').scanner.recursive).toBe(true)
    expect(by('dev-tool-cache').scanner.olderThanDays).toBeNull()
    // 这一族**不是** leaf 那一族：显式模板本身就是判据，没有 basename 名单，也就没有围栏
    expect(by('dev-tool-cache').scanner.leafDirs ?? [], '不走 leaf 机制').toEqual([])
    expect(by('dev-tool-cache').scanner.leafFiles ?? [], '不走 leaf 机制').toEqual([])
    expect(by('dev-tool-cache').scanner.scopeFence, '显式模板规则不该带围栏').toBeUndefined()

    // T6 真机对账之后 crash-dumps 改成容器入口 + 目录名判据：原先写死 %LOCALAPPDATA%\CrashDumps，
    // 于是 %PROGRAMDATA%\...\werdump 里那 72 MiB 转储既无 finding 也无排除记录（根本没试过）。
    expect(by('crash-dumps').paths).toEqual(['%LOCALAPPDATA%', '%APPDATA%', '%PROGRAMDATA%'])
    expect(by('crash-dumps').scanner.filePatterns, 'plan §5.5 只收转储，不端目录').toEqual(['*.dmp'])
    expect(by('crash-dumps').scanner.recursive, 'plan §5.5：递归').toBe(true)
    expect(by('crash-dumps').category).toBe('app-transient')
    expect(by('crash-dumps').riskLevel, 'plan §5.5 是 🟡').toBe('caution')
    expect(by('crash-dumps').cleanStrategy).toBe('delete-all')
    expect(by('crash-dumps').recoverable, '转储是崩溃那一次的现场，删了没有第二份').toBe(false)
    expect(by('crash-dumps').requiresDetector, 'crash-dumps 不许挂探测器').toBeUndefined()
    expect(by('crash-dumps').excludedFromDefaultSelection, '🟡 默认勾选').toBeUndefined()
    expect(by('crash-dumps').scanner.olderThanDays).toBeNull()
    expect(by('crash-dumps').scanner.leafDirs, '目录名判据，与 Rust CRASH_DUMP_LEAF_DIRS 同序同串').toEqual([
      'CrashDumps',
      'werdump',
      'DumpFolder',
      'Dumps'
    ])
    expect(by('crash-dumps').scanner.leafFiles ?? [], '这条走目录名那一族，不走 leafFiles').toEqual([])
    expect(by('crash-dumps').scanner.scopeFence, '容器入口必须带围栏（plan §0.1）').toBeDefined()
  })

  /**
   * M5-P1 T3b-ii（plan §5.6）—— 表上**第一档 🟠**。期望值一律写**字面量**，不指回 registry
   * 里的那些串（拿实现比实现是自我印证 —— T3a 偏离 8 那条纪律，Rust 侧同一个姿态）。
   */
  it('M5-P1 T3b-ii 那条 🟠 下载目录规则各自的声明在位（plan §5.6，表 23 条）', () => {
    // 比相对次序而不是下标（原来的 `slice(20, 21)` 绿在「这条恰好是倒数第二条」，M5-P3 之后那个下标
    // 归了第 22 条 —— 判据要的是「这条 🟠 仍在那两条之后」，不是它是第几号）
    const ids = BUILTIN_RULES.map((r) => r.id)
    const at = (id: string) => {
      const n = ids.indexOf(id)
      expect(n, `表上没有 ${id}`).toBeGreaterThanOrEqual(0)
      return n
    }
    expect(at('crash-dumps'), 'user-downloads-installers 排到了 crash-dumps 之前 = 换了这两条的计账先后').toBeLessThan(at('user-downloads-installers'))
    const r = byId('user-downloads-installers')
    expect(r.paths).toEqual(['%USERPROFILE%\\Downloads'])
    expect(r.category, 'plan §5.6 与 5.3 同一类别').toBe('installer-leftover')
    expect(r.riskLevel, 'plan §5.6 是 🟠 —— 表上第一档').toBe('high')
    expect(r.cleanStrategy).toBe('delete-all')
    expect(r.recoverable, '那是用户自己下载的文件，删了不会重新生成').toBe(false)
    expect(r.requiresDetector, '这条不依赖任何工具，不许挂探测器').toBeUndefined()
    expect(r.excludedFromDefaultSelection, '§3.5：一键全选点不到它').toBe(true)
    expect(r.scanner.recursive, 'plan §5.6：只顶层').toBe(false)
    expect(r.scanner.olderThanDays).toBeNull()
    // 十种包形状与第 18 条 `installer-artifacts` 逐字同序（plan §5.6「filePatterns 同 5.3」）
    expect([...(r.scanner.filePatterns ?? [])], 'plan §5.6 的十种包形状，逐字同序').toEqual([
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
    ])
    // 这一族**不是** leaf 那一族：地盘已经落到 Downloads 这一个叶子，没有 basename 名单，也就没有围栏
    expect(r.scanner.leafDirs ?? [], '不走 leaf 机制').toEqual([])
    expect(r.scanner.leafFiles ?? [], '不走 leaf 机制').toEqual([])
    expect(r.scanner.scopeFence, '显式叶子路径不该带围栏').toBeUndefined()
    // description 必须把"删了会失去什么"说明白 —— 这条失去的是用户自己的文件，不是缓存
    expect(r.description).toContain('不会自动重新生成')
    expect(r.description).toContain('子目录')
  })

  /**
   * M5-P2 P2-T4（plan §2.6 / spec §3 3.5 + §4.3）第 22 条的**声明在位**，逐字段比**字面量** ——
   * 期望值写死在这一行里，不指回 registry 里的那些串（拿实现比实现是自我印证：把 denyRoots 里
   * 那条 Defender 删掉时，两边一起变、这条照样绿；T3a 偏离 8 那条纪律，Rust `builtin.rs` 同姿态）。
   *
   * 这条钉的是**安全方向那三个值**（🟠 + 不进默认勾选 + `recoverable: false`，spec §4.3 定死）
   * 与 `requiresAbsentAppFact` 的**互斥形状**：两份 leaf 名单必须空 —— P2-T3 的声明层闸把混给判成
   * `ambiguous-leaf-mode` 整条拒，真混了这条用例先红，而那条红意味着这规则根本进不了报告。
   * 类别是新的一格 `orphan-data` 而不是 `app-transient`（理由逐字见 `types.ts` 那个成员与 Rust 那侧）。
   */
  it('第 22 条排在既有 15 条之后、六条形状规则之前（M5-P3：顺序即 claimed 计账顺序）', () => {
    const ids = BUILTIN_RULES.map((r) => r.id)
    const at = (id: string) => {
      const n = ids.indexOf(id)
      expect(n, `名单里的 ${id} 不在表上`).toBeGreaterThanOrEqual(0)
      return n
    }
    const orphan = at('orphan-app-data')
    // 两份名单抄自 harness 侧的既有分组（src-tauri/src/golden.rs:30-56），不指回 BUILTIN_RULES
    // 自己的顺序 —— 拿被测方的顺序当期望集，这条判据就退化成「顺序等于顺序」。
    const BASELINE_15 = [
      'windows-temp', 'browser-cache', 'thumbnail-cache', 'shader-cache', 'error-reporting',
      'recycle-bin', 'npm-cache', 'pip-cache', 'gradle-cache', 'vscode-cache', 'maven-repository',
      'pnpm-store', 'yarn-cache', 'huggingface-cache', 'android-sdk-temp'
    ]
    const SHAPE_6 = [
      'app-cache-data', 'app-rotated-logs', 'installer-artifacts', 'dev-tool-cache',
      'crash-dumps', 'user-downloads-installers'
    ]
    for (const id of BASELINE_15)
      expect(at(id), `基线条目 ${id} 排到了第 22 条之后 —— 它会从 🟢🟡 嘴里抢地盘（plan §1.3）`).toBeLessThan(orphan)
    for (const id of SHAPE_6)
      expect(at(id), `形状规则 ${id} 仍排在第 22 条之前 —— plan §2.5 那 201.56 MiB 就还是 🟡`).toBeGreaterThan(orphan)
  })

  it('orphan-app-data 是 🟠、不进默认勾选、不可再生，且是全表唯一带 requiresAbsentAppFact 的一条（plan §2.6 / spec §4.3）', () => {
    expect(BUILTIN_RULES.length).toBe(23)
    const r = byId('orphan-app-data')
    expect(r.category, '新类别 orphan-data，不并进 app-transient').toBe('orphan-data')
    expect(r.name).toBe('卸载残留的应用数据')
    expect(r.paths, 'spec §3 3.5：三根容器，候选是它们的顶层一项').toEqual([
      '%LOCALAPPDATA%',
      '%APPDATA%',
      '%PROGRAMDATA%'
    ])
    expect(r.requiresAbsentAppFact, '不声明这个字段 = 这条规则按普通地盘收').toBe(true)
    expect(
      BUILTIN_RULES.filter((x) => x.requiresAbsentAppFact !== undefined).map((x) => x.id),
      '带机器事实闸的规则必须恰好只有那一条（它在表上排在哪由上一条判据管，这里不比位置）'
    ).toEqual(['orphan-app-data'])
    expect(r.scanner.leafDirs ?? [], '与 requiresAbsentAppFact 互斥（P2-T3 的闸会整条拒）').toEqual([])
    expect(r.scanner.leafFiles ?? [], '同上').toEqual([])
    const f = r.scanner.scopeFence
    expect(f, '带机器事实闸的规则必须容器入口 + 围栏（plan §2.5）').toBeDefined()
    expect([...f!.allowRoots], 'allowRoots = 采集面本身').toEqual(['%LOCALAPPDATA%', '%APPDATA%', '%PROGRAMDATA%'])
    // CLEANUP-RULES §6 之后这份围栏从 5 条长到 19 条（地板 5 + 落在 allowRoots 内的禁止根 12
    // + 容器族补充 2）。用**展开**而不是手抄：表涨了这里自动跟上，与 Rust
    // `builtin.rs::orphan_app_data_is_high_and_not_in_default_selection` 同一写法。
    expect([...f!.denyRoots].slice(0, 5), '地板四条 + Defender 一条必须在最前面').toEqual([
      '%WINDIR%\\*',
      '%SYSTEMDRIVE%\\System Volume Information',
      '%PROGRAMFILES%\\*',
      '%SYSTEMDRIVE%\\Program Files (x86)\\*',
      '%PROGRAMDATA%\\Microsoft\\Windows Defender\\*'
    ])
    // 覆盖判据：每一条禁止根与地板都必须在 denyRoots 里能找到"自己那一格"或被祖先罩住。
    // 断言写成"覆盖"而不是"逐字相等"：围栏可以比地
    // 板更宽（`%WINDIR%\*` 盖住五条组件根），逐字比会把合法的加宽判成缺陷。
    const covers = (root: string, deny: readonly string[]): boolean =>
      deny.some((d) => {
        const base = d.replace(/\\\*$/, '')
        return root === base || root.toLowerCase().startsWith(base.toLowerCase() + '\\')
      })
    for (const req of [...FORBIDDEN_PATH_PATTERNS, ...FENCE_MINIMUM_DENY_PATTERNS]) {
      expect(covers(req, f!.denyRoots), `围栏漏了 ${req}（少一条就被 validateFence 整条拒）`).toBe(true)
    }
    expect([...(r.scanner.filePatterns ?? [])], '全收：这条按目录收，不靠扩展名过滤').toEqual([])
    expect(r.scanner.recursive, '候选目录内部递归（残留数据整棵子树都是它的）').toBe(true)
    expect(r.scanner.olderThanDays, '规则不读时钟').toBeNull()
    expect(r.riskLevel, 'spec §4.3：命中项永远 🟠').toBe('high')
    expect(r.excludedFromDefaultSelection, 'spec §4.3：永远不进默认勾选').toBe(true)
    expect(r.recoverable, 'spec §4.3：「可再生」这个词它不配 —— 应用没了，谁再生成这些设置？').toBe(false)
    expect(r.cleanStrategy).toBe('delete-all')
    expect(r.requiresDetector, 'plan §0.3：requiresDetector 的方向与此相反，不许复用').toBeUndefined()
    // 文案必须把「这是推断、不是事实」与「丢了什么」都说白：§5 那句「删了会失去什么」搬运的就是它
    for (const want of ['推断', '不是事实', '设置', '不会再', '还在用的应用'])
      expect(r.description.replace(/ /g, ''), `description 少了「${want}」这一层`).toContain(want)
  })

  /**
   * 🟠 的两个方向合起来才是这条规则的完整意思，缺一个是半句话（Rust `engine.rs` 同名用例）：
   * ① 字节**进** `reclaimableBytes`（§16 只把 🔴 排除在合计之外，`engine.ts` 那句
   *    `if (f.riskLevel !== 'forbidden')`）—— 用户要能看见那块地值多少；
   * ② 默认勾选**点不到**它 —— `defaultUnselectableRuleIds()` 是这条豁免的唯一派生处。
   * 只有①就是"一键全选替用户勾掉自己的下载目录"；只有②就是那块地盘从预估里静默消失。
   */
  it('a high rule 的字节进 reclaimableBytes，却进不了默认勾选（plan §5.6 的两个方向）', () => {
    const report = evaluateRules({
      source: storeFrom({
        'C:\\Users\\Kano\\Downloads': [{ name: 'setup.exe', size: 900 }]
      }),
      env: SYNTH_ENV,
      rules: BUILTIN_RULES,
      forbiddenPatterns: FORBIDDEN_PATH_PATTERNS,
      nowMs: NOW
    })
    const f = report.findings.find((x) => x.ruleId === 'user-downloads-installers')!
    expect(f, '规则没上线（被声明层拒了？）').toBeDefined()
    expect(f.riskLevel, '🟠 上了表却没进报告，界面那一侧就永远看不见它').toBe('high')
    expect([f.fileCount, f.totalBytes]).toEqual([1, 900])
    // ① 这张树上唯一那 900 字节就是 🟠 的 —— 合计里必须有它
    expect(report.bytesByRisk.high, '🟠 那一格第一次有了非零值').toBe(900)
    expect(report.bytesByRisk.forbidden).toBe(0)
    expect(report.reclaimableBytes).toBe(
      report.bytesByRisk.safe + report.bytesByRisk.caution + report.bytesByRisk.high
    )
    expect(report.reclaimableBytes, '🟠 的字节没进合计 = 那块地盘从预估里静默消失').toBe(900)
    // ② 同一批字节不许被一键全选顺手勾走
    const exempt = defaultUnselectableRuleIds(BUILTIN_RULES)
    expect(exempt).toContain('user-downloads-installers')
    const defaultSelectedBytes = report.findings
      .filter((x) => !exempt.includes(x.ruleId))
      .reduce((a, x) => a + x.totalBytes, 0)
    expect(defaultSelectedBytes, '一键全选点上了那条 🟠 的 900 字节').toBe(0)
  })

  /**
   * `recursive: false` = 只碰 `Downloads` 顶层。三个文件各钉一件事：顶层 `.exe` 收、
   * 顶层照片不收、子目录 `.exe` 不收。最后那组**同一棵树换成递归**的对照不是装饰 ——
   * 没有它，"子目录没收到"可能只是引擎走不到那里（夹具形状不对也能绿）。
   */
  it('recursive:false 只认领 Downloads 顶层 —— 子目录里的 .exe 不收，顶层的照片也不收', () => {
    const spec: Record<string, Array<{ name: string; size: number }>> = {
      'C:\\Users\\Kano\\Downloads': [
        { name: 'thing.exe', size: 700 },
        { name: 'holiday.jpg', size: 3000 }
      ],
      'C:\\Users\\Kano\\Downloads\\sub': [{ name: 'nested.exe', size: 8000 }]
    }
    const run = (rules: readonly Rule[]) =>
      evaluateRules({
        source: storeFrom(spec),
        env: SYNTH_ENV,
        rules,
        forbiddenPatterns: FORBIDDEN_PATH_PATTERNS,
        nowMs: NOW
      })
    const report = run(BUILTIN_RULES)
    const f = report.findings.find((x) => x.ruleId === 'user-downloads-installers')!
    expect([f.fileCount, f.totalBytes], '只顶层、只包形状').toEqual([1, 700])
    expect(f.matchedRoots).toEqual(['C:\\Users\\Kano\\Downloads'])
    const claimed = report.findings.flatMap((x) => x.samplePaths.map((p) => p.path))
    expect(claimed.some((p) => p.endsWith('thing.exe')), '顶层的 .exe 必须被收走，否则下面两条反例是空的').toBe(
      true
    )
    for (const keep of ['sub\\nested.exe', 'holiday.jpg'])
      expect(
        claimed.some((p) => p.endsWith(keep)),
        `${keep} 被认领了 —— 前者是越界进子目录（recursive 被改成 true），后者是扩展名判据松了`
      ).toBe(false)
    // 对照组：同一条声明改成递归，同一棵树就必须吃到子目录
    const flipped = byId('user-downloads-installers')
    const r2 = run([{ ...flipped, scanner: { ...flipped.scanner, recursive: true } }])
    expect(
      r2.findings.find((x) => x.ruleId === 'user-downloads-installers')!.totalBytes,
      '递归对照失效：子目录那 8000 走不到，上面那两条「没收到」就什么都没证明'
    ).toBe(8700)
  })

  it('§26「逐步增加」的开发环境批次也在表上（Docker 与通用 Electron 故意没有：它们不是路径能表达的）', () => {
    expect(BUILTIN_RULES.filter((r) => r.category === 'dev-cache').map((r) => r.id).sort()).toEqual([
      'android-sdk-temp',
      'gradle-cache',
      'huggingface-cache',
      'maven-repository',
      'npm-cache',
      'pip-cache',
      'pnpm-store',
      'vscode-cache',
      'yarn-cache'
    ])
    // §16 🟡 的判据：谨慎级项目必须如实带 caution，不许为了"看着安全"降级成 safe
    for (const id of ['npm-cache', 'pip-cache', 'gradle-cache', 'vscode-cache', 'maven-repository', 'pnpm-store', 'yarn-cache', 'huggingface-cache', 'android-sdk-temp'])
      expect(byId(id).riskLevel, `${id} 的等级`).toBe('caution')
  })

  it('§16 🟢 名单里的项目风险等级确为 safe', () => {
    for (const id of ['windows-temp', 'browser-cache', 'thumbnail-cache', 'shader-cache']) {
      expect(byId(id).riskLevel, `${id} 的等级`).toBe('safe')
    }
  })

  it('回收站标 🔴 且 cleanStrategy 是 manual-only（§16：禁止通过普通清理按钮直接删除）', () => {
    const rb = byId('recycle-bin')
    expect(rb.riskLevel).toBe('forbidden')
    expect(rb.cleanStrategy).toBe('manual-only')
    expect(rb.recoverable, '未清空前回收站里的东西本来就还能还原').toBe(true)
  })

  it('错误报告按 recoverable=false 记账（删了就没了，不许假装能还原）', () => {
    expect(byId('error-reporting').recoverable).toBe(false)
  })

  it('🔴 禁止路径清单覆盖 §16 点名的 System32 / WinSxS / Windows Installer', () => {
    const joined = FORBIDDEN_PATH_PATTERNS.join('|').toLowerCase()
    expect(joined).toContain('system32')
    expect(joined).toContain('winsxs')
    expect(joined).toContain('installer')
  })

  /**
   * 两套「什么算 🔴」的口径是**故意分开的**（人类伙伴 2026-09-26 复核后确认保留）。
   *
   * `classifyPath` 按路径段配色，`...\Microsoft\Windows\Explorer` 因为含 `windows` 段被判 `system` → 🔴；
   * 若让规则引擎直接吃这个等级，缩略图缓存规则会**恒为 0 命中** —— 于是这条测试就是那枚报警铃：
   * 谁把 Explorer（或整个 windows 段口径）并进 FORBIDDEN_PATH_PATTERNS，下面 9,100 字节立刻变 0，当场红。
   * 代价也写清楚：同一个文件在 Treemap 上按系统着色、在清理预览里却是 🟢 可删，这是已知且已接受的分歧。
   */
  it('配色口径与门禁口径的分歧钉在这里：classifyPath 判缩略图缓存为 system/🔴，引擎必须照样认领 9,100 字节', () => {
    const thumb = 'C:\\Users\\Kano\\AppData\\Local\\Microsoft\\Windows\\Explorer\\thumbcache_256.db'
    expect(classifyPath(thumb)).toBe('system')
    expect(RISK_BY_GROUP[classifyPath(thumb)]).toBe('forbidden')
    // 门禁那张表里没有 Explorer —— 这正是两套口径必须分开的原因
    expect(FORBIDDEN_PATH_PATTERNS.some((p) => p.toLowerCase().includes('explorer'))).toBe(false)
    const report = evaluateRules({
      source: profileTree(),
      env: SYNTH_ENV,
      rules: BUILTIN_RULES,
      forbiddenPatterns: FORBIDDEN_PATH_PATTERNS,
      nowMs: NOW
    })
    expect(report.findings.find((x) => x.ruleId === 'thumbnail-cache')!.totalBytes).toBe(9100)
  })

  it('回收站：不在禁止根（要照常报告占用），但在「只上报不可删」根（任何规则都删不掉）', () => {
    expect(FORBIDDEN_PATH_PATTERNS.some((p) => p.toLowerCase().includes('$recycle.bin'))).toBe(false)
    // 用 `toContain` 而不是 `toEqual`：CLEANUP-RULES §6 之后只上报根从 1 条涨到 12 条。
    // 本条量的是「回收站在只上报表里」，不是「只上报表恰好只有一条」。
    expect(REPORT_ONLY_ROOT_PATTERNS).toContain('%SYSTEMDRIVE%\\$Recycle.Bin')
    const report = evaluateRules({
      source: profileTree(),
      env: SYNTH_ENV,
      rules: BUILTIN_RULES,
      forbiddenPatterns: FORBIDDEN_PATH_PATTERNS,
      nowMs: NOW
    })
    // CLEANUP-RULES §6 之后只上报根从 1 条涨到 12 条，用包含断言（见本文件另一处同款说明）
    expect(report.reportOnlyRoots).toContain('C:\\$Recycle.Bin')
    // 占用如实报告（64,000），但一分都不进可释放合计
    expect(report.findings.find((x) => x.ruleId === 'recycle-bin')!.totalBytes).toBe(64000)
    expect(report.bytesByRisk.forbidden).toBe(64000)
    expect(report.reclaimableBytes).toBe(report.bytesByRisk.safe + report.bytesByRisk.caution + report.bytesByRisk.high)
  })
})

describe('整表自检：注册表必须整体通过 §28 原则四校验', () => {
  it('没有任何规则被自己的叶子/祖先判据拒掉', () => {
    const v = validateRuleSet(BUILTIN_RULES, { env: SYNTH_ENV, forbiddenPatterns: FORBIDDEN_PATH_PATTERNS })
    expect(v.problems, v.problems.map((p) => `${p.ruleId}: ${p.reason} ${p.detail}`).join('\n')).toEqual([])
    expect(v.valid.length).toBe(BUILTIN_RULES.length)
  })

  it('每条规则的字面路径都不是宽容器，且落在禁止路径之外', () => {
    for (const r of BUILTIN_RULES) {
      for (const p of r.paths) {
        const last = p.replace(/\\+$/, '').split('\\').pop()!
        expect(['*', '?'], `${r.id} 以通配收尾`).not.toBe(last)
        expect(['appdata', 'local', 'roaming', 'users', 'windows', 'programdata', 'program files'], last.toLowerCase()).not.toContain(last.toLowerCase())
      }
    }
  })
})

describe('首批规则跑在合成树上（不碰真机 C:\\）', () => {
  const run = () =>
    evaluateRules({
      source: profileTree(),
      env: SYNTH_ENV,
      rules: BUILTIN_RULES,
      forbiddenPatterns: FORBIDDEN_PATH_PATTERNS,
      nowMs: NOW
    })

  it('首批六类规则全部命中真实存在的目录，字节数就是那些目录里合法文件的和', () => {
    const report = run()
    expect(report.safetyBlocked).toBe(false)
    const f = (id: string) => report.findings.find((x) => x.ruleId === id)!
    // Temp: 1000 + 200 + 5000（递归进 WinRAR 自建的解压目录）
    expect(f('windows-temp').totalBytes).toBe(6200)
    // 缩略图：只收 thumbcache_*.db（100 + 9000），不碰 iconcache 和随机名目录项
    expect(f('thumbnail-cache').totalBytes).toBe(9100)
    // Shader: D3DSCache 2000 + NVIDIA DXCache 3000
    expect(f('shader-cache').totalBytes).toBe(5000)
    // 浏览器缓存：Chrome Default Cache(4000) + Cache_Data(400) + Code Cache(500) + Edge Cache(600) + Code Cache(700)
    expect(f('browser-cache').totalBytes).toBe(6200)
    // 错误报告：本地 WER 的 ReportQueue(300) + ReportArchive(400) + ProgramData 的 ReportQueue(700)。
    // WER\Temp(50) 谁都不许认领：它既不在 %TEMP% 的地盘里，也不在错误报告规则的地盘里。
    expect(f('error-reporting').totalBytes).toBe(1400)
    expect(report.findings.some((x) => x.samplePaths.some((p) => p.path.endsWith('WER\\Temp\\x.tmp')))).toBe(false)
    expect(f('recycle-bin').totalBytes).toBe(64000)
  })

  it('🟡 开发环境批次只认缓存叶子，地盘外的邻居（gradle.properties / settings.json）一字节都不碰', () => {
    const report = run()
    const f = (id: string) => report.findings.find((x) => x.ruleId === id)!
    expect(f('npm-cache').totalBytes).toBe(1200)
    expect(f('pip-cache').totalBytes).toBe(300)
    expect(f('gradle-cache').totalBytes).toBe(900)
    expect(f('vscode-cache').totalBytes).toBe(150)
    expect(f('maven-repository').totalBytes).toBe(800)
    expect(f('pnpm-store').totalBytes).toBe(600)
    expect(f('yarn-cache').totalBytes).toBe(400)
    expect(f('huggingface-cache').totalBytes).toBe(1000)
    expect(f('android-sdk-temp').totalBytes).toBe(500)
    expect(f('npm-cache').matchedRoots).toEqual(['C:\\Users\\Kano\\AppData\\Local\\npm-cache'])
    expect(f('vscode-cache').matchedRoots).toEqual([
      'C:\\Users\\Kano\\AppData\\Roaming\\Code\\Cache',
      'C:\\Users\\Kano\\AppData\\Roaming\\Code\\CachedData'
    ])
    const claimed = report.findings.flatMap((x) => x.samplePaths.map((p) => p.path))
    expect(claimed.some((p) => p.endsWith('gradle.properties'))).toBe(false)
    expect(claimed.some((p) => p.endsWith('settings.json'))).toBe(false)
    // 新批次同样的地盘纪律：配置、SDK 组件本体、别人的缓存都不许被顺手扫走
    expect(claimed.some((p) => p.endsWith('settings.xml')), '.m2\\settings.xml 是配置不是缓存').toBe(false)
    expect(claimed.some((p) => p.endsWith('adb.exe')), 'SDK 组件本体不是安装残留').toBe(false)
    expect(claimed.some((p) => p.includes('.cache\\something-else')), '只认 huggingface 那一支').toBe(false)
    // npm 规则的第二条地盘（自定义全局前缀）在这台机器上不存在 → 点名 not-scanned，不许静默
    const r = report.exclusions.find((e) => e.ruleId === 'npm-cache' && e.reason === 'not-scanned')
    expect(r?.path).toContain('.npm-global')
  })

  it('🔴 System32 / WinSxS / Installer 在整表评估下依旧 0 进账，并且被登记为禁止根', () => {
    const report = run()
    const all = report.findings.flatMap((f) => f.samplePaths.map((p) => p.path))
    expect(all.filter((p) => /\\(system32|winsxs|installer)\\/i.test(p))).toEqual([])
    // 生效中的禁止根如实回显在报告里（Task 17 预览要能把它们列出来）。
    // CLEANUP-RULES §6 之后这张表从 6 条涨到 17 条，所以用**包含**断言这六条老根仍在，
    // 并用「条数 = 表长」钉住"一条都没漏解析"（`FORBIDDEN_PATH_PATTERNS` 里那些 `%USERPROFILE%`
    // 系条目在这台合成机上解析成 `C:\Machine\...`，逐条写死会把夹具绑到路径写法上）。
    for (const root of [
      'C:\\Windows\\System32',
      'C:\\Windows\\SysWOW64',
      'C:\\Windows\\WinSxS',
      'C:\\Windows\\Installer',
      'C:\\Windows\\Servicing',
      'C:\\System Volume Information'
    ]) {
      expect(report.forbiddenRoots, `禁止根 ${root} 没落地`).toContain(root)
    }
    expect(
      report.forbiddenRoots.length,
      `禁止根条数 ${report.forbiddenRoots.length} ≠ 表长 ${FORBIDDEN_PATH_PATTERNS.length}（有模板没解析出来）`
    ).toBe(FORBIDDEN_PATH_PATTERNS.length)
    // 逐条「点名排除」由引擎用例负责（需要一条会拐进去的 glob）；这里补一条现场证据：
    // 往整表里塞一条会拐进 System32 的通配规则，它必须被点名而不是被"匹配后滤掉"。
    const sweep: Rule = {
      id: 'what-if-sweep',
      name: '假设性宽规则（只为证明禁止根不可达）',
      category: 'temp',
      description: '测试用：通配清扫 C:\\Windows 下任意一层的 CatRoot2',
      paths: ['%WINDIR%\\*\\CatRoot2'],
      scanner: { filePatterns: [], olderThanDays: null, recursive: true },
      riskLevel: 'safe',
      cleanStrategy: 'delete-all',
      recoverable: false
    }
    const r2 = evaluateRules({
      source: profileTree(),
      env: SYNTH_ENV,
      rules: [sweep],
      forbiddenPatterns: FORBIDDEN_PATH_PATTERNS,
      nowMs: NOW
    })
    const f2 = r2.findings.find((x) => x.ruleId === 'what-if-sweep')!
    expect(f2.totalBytes).toBe(0)
    expect(f2.matchedRoots).toEqual([])
    expect(r2.exclusions.filter((e) => e.reason === 'forbidden-root').map((e) => e.path)).toContain(
      'C:\\Windows\\System32'
    )
  })

  it('合计口径：🔴 回收站那 64,000 字节绝不混进 reclaimableBytes，🟢/🟡 分账清楚', () => {
    const report = run()
    const sum = report.findings.reduce((a, f) => a + f.totalBytes, 0)
    expect(report.bytesByRisk.forbidden).toBe(64000)
    expect(report.bytesByRisk.safe).toBe(27900)
    // 🟡 = 1200 npm + 300 pip + 900 gradle + 150 vscode + 800 maven + 600 pnpm + 400 yarn + 1000 hf + 500 android = 5850
    expect(report.bytesByRisk.caution).toBe(5850)
    // ⚠️ 这句里的 0 是**这棵树**的形状，不是"表上没有 🟠"：M5-P1 T3b-ii 起表上有一条 🟠
    //（`user-downloads-installers`），而 `profileTree()` 里没有 `%USERPROFILE%\Downloads` 这个形状，
    // 所以它 0 进账、这一格照旧是 0。🟠 那一格**非零**时进不进取 `reclaimableBytes` 由
    // 「a high rule 的字节进 reclaimableBytes，却进不了默认勾选」那条用例判（那边自己建树）。
    expect(report.bytesByRisk.high).toBe(0)
    // reclaimable = 除 🔴 之外的全部（§16：禁止通过普通清理按钮直接删除）
    expect(report.reclaimableBytes).toBe(sum - 64000)
    expect(report.reclaimableBytes).toBe(27900 + 5850)
    expect(sum).toBe(97750)
    // 用户文档与根上的系统文件不在任何规则地盘里，一字节都不该被认领
    expect(report.findings.some((f) => f.samplePaths.some((p) => p.path.includes('thesis.docx')))).toBe(false)
    expect(report.findings.some((f) => f.samplePaths.some((p) => p.path.includes('pagefile.sys')))).toBe(false)
    expect(report.findings.some((f) => f.samplePaths.some((p) => p.path.includes('ntoskrnl.exe')))).toBe(false)
  })

  it('评估是纯读操作：跑完一遍 TreeStore 的 files/dirs/bytes 一字不动', () => {
    const store = profileTree()
    const before = { ...store.stats(), rootSize: store.sizeOf(store.rootId) }
    evaluateRules({
      source: store,
      env: SYNTH_ENV,
      rules: BUILTIN_RULES,
      forbiddenPatterns: FORBIDDEN_PATH_PATTERNS,
      nowMs: NOW
    })
    expect({ ...store.stats(), rootSize: store.sizeOf(store.rootId) }).toEqual(before)
  })
})

/**
 * §3.5「AI 模型文件本体不进一键清理的默认勾选」。
 *
 * 这条判据必须从**规则声明**派生，而不是从界面的某处 if 里冒出来：声明住在 registry，
 * 派生是个纯函数，预览只是搬运工 —— 于是"一键全选点不到它"这件事在结构上成立，
 * 改界面改不掉它。（计划书 Step 5 明写要的是这个，不是"UI 少渲染一个复选框"。）
 */
describe('§3.5 默认勾选豁免从规则声明派生', () => {
  it('豁免名单逐条点名：huggingface-cache + 两条 🟠（M5-P2 P2-T4 起三条，不是两条）', () => {
    expect(defaultUnselectableRuleIds(BUILTIN_RULES)).toEqual([
      'huggingface-cache',
      'orphan-app-data',
      'user-downloads-installers'
    ])
    // 表上的两档 🟠（`user-downloads-installers` / `orphan-app-data`）让这个方向成为可判的事实：
    // **每条 🟠 都不许进默认勾选**。反向不成立（`huggingface-cache` 是 🟡 也豁免），
    // 所以只写这一半 —— 别把「🟠 才有豁免」写成判据，那是表上并没有的耦合。
    for (const r of BUILTIN_RULES)
      if (r.riskLevel === 'high')
        expect(r.excludedFromDefaultSelection, `${r.id} 是 🟠 却没被豁免：一键全选会替用户勾掉它`).toBe(true)
  })

  it('派生结果升序、可复现（同一张表跑两次逐字节相同）', () => {
    const a = defaultUnselectableRuleIds(BUILTIN_RULES)
    const b = defaultUnselectableRuleIds([...BUILTIN_RULES].reverse())
    expect(b).toEqual(a)
    expect(a).toEqual([...a].sort())
  })

  it('派生出的每个 id 都真存在于表里（拼错的声明不会悄悄多摘一条，也不会少摘）', () => {
    const ids = new Set(BUILTIN_RULES.map((r) => r.id))
    for (const id of defaultUnselectableRuleIds(BUILTIN_RULES)) expect(ids.has(id)).toBe(true)
  })

  it('它同时也是一条探测器规则：huggingface 既要求探测，又不进默认全选 —— 两件事各自独立成立', () => {
    const hf = BUILTIN_RULES.find((r) => r.id === 'huggingface-cache')!
    expect(hf.requiresDetector).toBe('huggingface')
    expect(hf.excludedFromDefaultSelection).toBe(true)
  })
})
