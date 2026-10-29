/**
 * Task 17 —— §17 清理预览（选择 → 预估释放空间 → 确认），**只到确认为止，没有执行**。
 *
 * 本文件的三条硬断言（任何一条红了都要当事故看）：
 * 1. 🔴 项目**永远进不了预估**：勾选它 = 留下一条 refusal，`riskBreakdown.forbidden.items` 恒为 0。
 *    拒绝用的还是 Task 16 那两层（`validateRuleSet` 的声明层 + `isForbiddenPath` 的枚举层），
 *    预览没有第三套「禁止」定义 —— 所以把 `isForbiddenPath` 阉掉，本文件必须变红。
 * 2. 预估的字节只能来自报告（= 已扫好的树），预览不重新走盘：`buildPreviewModel` 的入参里根本没有 source。
 * 3. 模块**不导出任何执行入口**（下面 `没有执行入口` 那条用例按名字把关，防止哪天有人塞一个 executeCleanup 进来）。
 */
import { describe, expect, it } from 'vitest'
import { TreeStore } from '../../core/scan/tree-store'
import { parentOf } from '../../core/fs/pathutil'
import { evaluateRules, isForbiddenPath, type RuleTreeSource } from '../../core/rules/engine'
import { BUILTIN_RULES } from '../../core/rules/registry'
import type { Rule, RuleEnv, RuleFinding, RuleReport } from '../../core/rules/types'
import { buildPreviewModel, confirmPreview, previewDigest } from '../../core/rules/preview'
import * as previewModule from '../../core/rules/preview'
import type { PreviewModel, PreviewSelection } from '../../shared/types'
import type { Risk } from '../../shared/classify'

const DAY = 86_400_000
const NOW = 1_700_000_000_000

const ENV = {
  SYSTEMDRIVE: 'C:\\',
  WINDIR: 'C:\\Windows',
  TEMP: 'C:\\Users\\Kano\\AppData\\Local\\Temp',
  LOCALAPPDATA: 'C:\\Users\\Kano\\AppData\\Local',
  APPDATA: 'C:\\Users\\Kano\\AppData\\Roaming',
  PROGRAMDATA: 'C:\\ProgramData',
  USERPROFILE: 'C:\\Users\\Kano'
} satisfies RuleEnv

const FORBIDDEN = [
  '%WINDIR%\\System32',
  '%WINDIR%\\WinSxS',
  '%WINDIR%\\Installer',
  '%SYSTEMDRIVE%\\System Volume Information'
]

interface FileSpec {
  name: string
  size: number
  mtimeMs?: number
}

/** 与 rules-engine.test.ts 同一套合成树：补齐祖先链，按深度建树，绝不碰磁盘。 */
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
        attrs: 0
      }))
    )
  }
  store.finalizeDir(store.rootId)
  return store
}

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
 * 包一层「枚举禁止目录 = throw」的 source（与 Task 16 同一条结构闸）。
 * 预览若偷偷去走树/走盘，这里会当场炸 —— 约束 3。
 */
function guarded(store: TreeStore): RuleTreeSource {
  const src: RuleTreeSource = {
    rootId: store.rootId,
    dirIdByPath: (p) => store.dirIdByPath(p),
    childrenOf: (id) => {
      const path = store.pathOf(id)
      const hit = isForbiddenPath(path, resolvedForbidden())
      if (hit !== null) throw new Error(`预览/引擎枚举了禁止目录 ${path}（命中 ${hit}）`)
      return store.childrenOf(id)
    }
  }
  return src
}

/** 禁止根模板按合成 env 落地成绝对路径（预览读的是报告里同名的那份）。 */
function resolvedForbidden(): string[] {
  return ['C:\\Windows\\System32', 'C:\\Windows\\WinSxS', 'C:\\Windows\\Installer', 'C:\\System Volume Information']
}

/** 合成机器：🟢 Temp 2 个文件、🟢 浏览器缓存 1 个、🟡 npm 1 个、🔴 回收站 2 个。 */
const FIXTURE: Record<string, FileSpec[]> = {
  'C:\\': [{ name: 'pagefile.sys', size: 10 }],
  'C:\\Users': [],
  'C:\\Users\\Kano': [],
  'C:\\Users\\Kano\\AppData': [],
  'C:\\Users\\Kano\\AppData\\Local': [],
  'C:\\Users\\Kano\\AppData\\Local\\Temp': [
    { name: 'a.tmp', size: 1_000 },
    { name: 'b.log', size: 250 }
  ],
  'C:\\Users\\Kano\\AppData\\Local\\Google': [],
  'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome': [],
  'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data': [],
  'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Default': [],
  'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache': [{ name: 'data_1', size: 300 }],
  'C:\\Users\\Kano\\AppData\\Local\\npm-cache': [{ name: 'pkg.tgz', size: 400 }],
  'C:\\Users\\Kano\\AppData\\Local\\D3DSCache': [{ name: 'shader.bin', size: 700 }],
  'C:\\Users\\Kano\\AppData\\Roaming': [],
  'C:\\Users\\Kano\\AppData\\Roaming\\Code': [],
  'C:\\ProgramData': [],
  'C:\\$Recycle.Bin': [],
  'C:\\$Recycle.Bin\\S-1-5-21-100': [
    { name: '$I photo.jpg', size: 5_000 },
    { name: '$R photo.jpg', size: 9_000 }
  ]
}

function reportOf(rules: readonly Rule[] = BUILTIN_RULES, store = storeFrom(FIXTURE)): RuleReport {
  return evaluateRules({
    source: guarded(store),
    env: ENV,
    rules,
    forbiddenPatterns: FORBIDDEN,
    nowMs: NOW
  })
}

const select = (...ruleIds: string[]): PreviewSelection => ({ items: ruleIds.map((ruleId) => ({ ruleId })) })
const pick = (ruleId: string, ...paths: string[]): PreviewSelection => ({ items: [{ ruleId, paths }] })
const item = (m: PreviewModel, ruleId: string): PreviewModel['items'][number] =>
  m.items.find((i) => i.ruleId === ruleId)!

/** 手搓一条 finding（只为构造引擎不可能产出的畸形输入：🟢 规则的地盘里出现禁止路径）。 */
function finding(over: Partial<RuleFinding> & { ruleId: string; riskLevel: Risk }): RuleFinding {
  return {
    name: over.ruleId,
    category: 'temp',
    cleanStrategy: 'delete-all',
    recoverable: false,
    matchedRoots: [],
    samplePaths: [],
    sampleTruncated: false,
    fileCount: 0,
    totalBytes: 0,
    ...over
  }
}

function bareReport(over: Partial<RuleReport> = {}): RuleReport {
  const bytesByRisk: Record<Risk, number> = { safe: 0, caution: 0, high: 0, forbidden: 0 }
  for (const f of over.findings ?? []) bytesByRisk[f.riskLevel] += f.totalBytes
  return {
    findings: [],
    exclusions: [],
    /** §3.6 地盘底账：手搭的报告默认空表（要验它得显式覆盖），保持 `RuleReport` 是全覆盖契约 */
    territories: [],
    rejectedRules: [],
    forbiddenRoots: resolvedForbidden(),
    /** 默认不带「只上报」根：只有专门验回收站的用例才覆盖它 */
    reportOnlyRoots: [],
    safetyBlocked: false,
    bytesByRisk,
    reclaimableBytes: 0,
    ...over
  }
}

describe('§17 预览：预估释放空间由报告算出（不重新走盘）', () => {
  const report = reportOf()

  it('全选可清理项 → 预估等于报告的 reclaimableBytes，且 🔴 一个字节都不在里面', () => {
    const m = buildPreviewModel(report, select('windows-temp', 'browser-cache', 'shader-cache', 'npm-cache'), { nowMs: NOW })
    expect(m.totalBytes).toBe(1_000 + 250 + 300 + 700 + 400)
    expect(m.totalFiles).toBe(5)
    expect(m.riskBreakdown.safe.bytes).toBe(1_000 + 250 + 300 + 700)
    expect(m.riskBreakdown.caution.bytes).toBe(400)
    expect(m.riskBreakdown.forbidden.bytes).toBe(0)
    expect(m.riskBreakdown.forbidden.items).toBe(0)
    expect(m.blocked).toBe(false)
    expect(m.refusals).toEqual([])
  })

  it('items 的顺序与报告的 findings 一致（UI 不需要自己排序，结果可复现）', () => {
    const m = buildPreviewModel(report, select('npm-cache'), { nowMs: NOW })
    expect(m.items.map((i) => i.ruleId)).toEqual(report.findings.map((f) => f.ruleId))
    expect(m.items.filter((i) => i.included).map((i) => i.ruleId)).toEqual(['npm-cache'])
  })

  it('没勾选的项照常出现在模型里（selected=false），但一字节都不计入', () => {
    const m = buildPreviewModel(report, select('windows-temp'), { nowMs: NOW })
    const cache = item(m, 'browser-cache')
    expect(cache.selected).toBe(false)
    expect(cache.included).toBe(false)
    expect(cache.bytes).toBe(0)
    expect(cache.findingBytes).toBe(300)
    expect(m.totalBytes).toBe(1_250)
  })

  it('连跑两次逐字节相同（不依赖对象迭代顺序）', () => {
    const a = buildPreviewModel(report, select('windows-temp', 'npm-cache', 'browser-cache'), { nowMs: NOW })
    const b = buildPreviewModel(report, select('browser-cache', 'windows-temp', 'npm-cache'), { nowMs: NOW })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('模型是纯数据：能原样过 IPC（structuredClone 语义 = JSON 往返后完全相等）', () => {
    const m = buildPreviewModel(report, select('windows-temp', 'recycle-bin'), { nowMs: NOW })
    expect(JSON.parse(JSON.stringify(m))).toEqual(m)
    // 树里不许出现 undefined / 函数 / Map / Set —— 它们过不了 contextBridge 的结构化克隆
    const walk = (v: unknown): void => {
      expect(v === undefined || typeof v === 'function' || v instanceof Map || v instanceof Set).toBe(false)
      if (Array.isArray(v)) for (const x of v) walk(x)
      else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x)
    }
    walk(m)
    walk(confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'safe', nowMs: NOW }))
  })

  it('勾了一条这次 0 命中的规则：照常计入 0 字节，不编造排除理由', () => {
    const m = buildPreviewModel(report, select('thumbnail-cache'), { nowMs: NOW })
    const t = item(m, 'thumbnail-cache')
    expect(t.included).toBe(true)
    expect(t.bytes).toBe(0)
    expect(t.refusal).toBeNull()
    expect(m.refusals).toEqual([])
  })
})

describe('§16 → §17：🔴 项目不可能被选中（三层拒绝，全部点名留痕）', () => {
  const report = reportOf()

  it('第一层：勾选 🔴 的回收站 → 拒绝并留痕，预估总额一字节不变', () => {
    const free = buildPreviewModel(report, select('windows-temp'), { nowMs: NOW })
    const m = buildPreviewModel(report, select('windows-temp', 'recycle-bin'), { nowMs: NOW })
    const bin = item(m, 'recycle-bin')
    expect(bin.selected).toBe(true)
    expect(bin.included).toBe(false)
    expect(bin.bytes).toBe(0)
    expect(bin.riskLevel).toBe('forbidden')
    expect(bin.refusal?.reason).toBe('forbidden-risk')
    expect(bin.refusal?.bytes).toBe(14_000)
    expect(m.totalBytes).toBe(free.totalBytes)
    expect(m.refusedBytes).toBe(14_000)
    expect(m.riskBreakdown.forbidden.items).toBe(0)
    expect(m.riskBreakdown.forbidden.bytes).toBe(0)
  })

  it('第二层：即便 🟢 规则的地盘里冒出禁止路径，那条路径也被 isForbiddenPath 拒掉', () => {
    // 引擎结构上产不出这种报告（禁止目录根本不会被枚举），所以手搓畸形输入验证预览自己的那道闸
    const malformed = bareReport({
      findings: [
        finding({
          ruleId: 'windows-temp',
          riskLevel: 'safe',
          totalBytes: 1_000 + 8_000,
          fileCount: 2,
          samplePaths: [
            { path: 'C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp', size: 1_000 },
            { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts', size: 8_000 }
          ]
        })
      ]
    })
    const m = buildPreviewModel(
      malformed,
      pick(
        'windows-temp',
        'C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp',
        'C:\\Windows\\System32\\drivers\\etc\\hosts'
      ),
      { nowMs: NOW }
    )
    const r = m.refusals.find((x) => x.reason === 'forbidden-root')
    expect(r?.detail).toContain('C:\\Windows\\System32')
    expect(m.totalBytes).toBe(1_000)
    expect(m.refusedBytes).toBe(8_000)
    expect(item(m, 'windows-temp').paths.map((p) => p.path)).toEqual(['C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp'])
  })

  /**
   * 只上报根（回收站那一类）在预览层的同一道闸。
   * 与 forbidden-root 的分工：这里的地盘**被枚举、被如实报告**，所以预览上会有那一行字节数；
   * 但它不属于任何可清理项 —— 整项勾选、逐路径勾选、事后伪造各挡一次，用的还是引擎那一个 isForbiddenPath。
   */
  it('第二层补：🟢 项名下挂着回收站路径（畸形报告）→ 逐路径勾选照样拒，字节不进预估', () => {
    const malformed = bareReport({
      reportOnlyRoots: ['C:\\$Recycle.Bin'],
      findings: [
        finding({
          ruleId: 'windows-temp',
          riskLevel: 'safe',
          totalBytes: 1_000 + 9_000,
          fileCount: 2,
          samplePaths: [
            { path: 'C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp', size: 1_000 },
            { path: 'C:\\$Recycle.Bin\\S-1-5-21-100\\$R photo.jpg', size: 9_000 }
          ]
        })
      ]
    })
    const m = buildPreviewModel(
      malformed,
      pick('windows-temp', 'C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp', 'C:\\$Recycle.Bin\\S-1-5-21-100\\$R photo.jpg'),
      { nowMs: NOW }
    )
    const r = m.refusals.find((x) => x.reason === 'report-only-root')
    expect(r?.detail, '拒绝必须点名到那根，不许只说"不能删"').toContain('C:\\$Recycle.Bin')
    expect(m.totalBytes).toBe(1_000)
    expect(m.refusedBytes).toBe(9_000)
    expect(item(m, 'windows-temp').paths.map((p) => p.path)).toEqual(['C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp'])
    expect(m.reportOnlyRoots).toEqual(['C:\\$Recycle.Bin'])
  })

  it('真报告里回收站那行的字节看得见，但整项勾选进不了预估（🔴 项级 + 只上报根双重）', () => {
    const m = buildPreviewModel(reportOf(), select('recycle-bin'), { nowMs: NOW })
    const rb = item(m, 'recycle-bin')
    expect(rb.included).toBe(false)
    expect(rb.refusal?.reason).toBe('forbidden-risk')
    expect(m.totalBytes).toBe(0)
    // 占用没有消失：它只是不进「可释放」
    expect(m.refusedBytes).toBe(14_000)
    expect(m.reportForbiddenBytes).toBe(14_000)
  })

  it('有人伪造一份把回收站算成 🟢 已计入的模型 → 确认拿不出来（forbidden-included）', () => {
    const m = buildPreviewModel(reportOf(), select('windows-temp'), { nowMs: NOW })
    const forged: typeof m = {
      ...m,
      reportOnlyRoots: ['C:\\$Recycle.Bin'],
      items: [
        ...m.items,
        {
          ...m.items[0]!,
          ruleId: 'bin-as-safe',
          name: 'bin-as-safe',
          riskLevel: 'safe' as Risk,
          selected: true,
          included: true,
          bytes: 9_000,
          files: 1,
          paths: [{ path: 'C:\\$Recycle.Bin\\S-1-5-21-100\\$R photo.jpg', size: 9_000 }],
          matchedRoots: ['C:\\$Recycle.Bin'],
          refusal: null
        }
      ]
    }
    const c = confirmPreview(forged, { acknowledged: true, acknowledgedRisk: 'safe', nowMs: NOW })
    expect(c.confirmed).toBe(false)
    expect(c.blockers).toContain('forbidden-included')
    expect(c.ruleIds).toEqual([])
  })

  it('第三层：报告的 🔴 保护没落地（safetyBlocked）→ 整份预览不出结论', () => {
    const blocked = bareReport({
      safetyBlocked: true,
      forbiddenRoots: [],
      findings: [],
      rejectedRules: [{ ruleId: 'windows-temp', name: 'Windows 临时文件', problems: [] }]
    })
    const m = buildPreviewModel(blocked, select('windows-temp'), { nowMs: NOW })
    expect(m.blocked).toBe(true)
    expect(m.totalBytes).toBe(0)
    expect(m.items).toEqual([])
    expect(m.refusals.map((r) => r.reason)).toEqual(['safety-blocked'])
  })

  it('禁止根清单是空的（等于没有保护）也按 blocked 处理，不许把「不知道」说成「可以清」', () => {
    const naked = bareReport({ findings: [finding({ ruleId: 'x', riskLevel: 'safe', totalBytes: 500, fileCount: 1 })] })
    const m = buildPreviewModel({ ...naked, forbiddenRoots: [] }, select('x'), { nowMs: NOW })
    expect(m.blocked).toBe(true)
    expect(m.totalBytes).toBe(0)
    expect(m.refusals[0]?.reason).toBe('safety-blocked')
  })
})

describe('§17 预览：逐路径勾选（只能给报告里已枚举的路径定价）', () => {
  const report = reportOf()

  it('勾了 2 个 Temp 文件里的 1 个 → 预估只算这 1 个，差额在 findingBytes 里看得见', () => {
    const m = buildPreviewModel(report, pick('windows-temp', 'C:\\Users\\Kano\\AppData\\Local\\Temp\\b.log'), { nowMs: NOW })
    const t = item(m, 'windows-temp')
    expect(t.scope).toBe('paths')
    expect(t.bytes).toBe(250)
    expect(t.files).toBe(1)
    expect(t.findingBytes).toBe(1_250)
    expect(t.paths).toEqual([{ path: 'C:\\Users\\Kano\\AppData\\Local\\Temp\\b.log', size: 250 }])
    expect(m.totalBytes).toBe(250)
  })

  it('报告没枚举出来的路径：拒绝定价（不猜、不重新走盘），并点名', () => {
    const truncated = bareReport({
      findings: [
        finding({
          ruleId: 'windows-temp',
          riskLevel: 'safe',
          totalBytes: 1_000,
          fileCount: 500,
          sampleTruncated: true,
          samplePaths: [{ path: 'C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp', size: 1_000 }]
        })
      ]
    })
    const m = buildPreviewModel(
      truncated,
      pick('windows-temp', 'C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp', 'C:\\Users\\Kano\\AppData\\Local\\Temp\\z.tmp'),
      { nowMs: NOW }
    )
    expect(m.totalBytes).toBe(1_000)
    const r = m.refusals.find((x) => x.reason === 'path-not-enumerated')
    expect(r?.path).toBe('C:\\Users\\Kano\\AppData\\Local\\Temp\\z.tmp')
    expect(r?.detail).toContain('采样')
    expect(m.notes.join(' ')).toContain('已枚举')
  })

  it('路径大小写/斜杠差异不影响认账（同一份树，同一份钱）', () => {
    const m = buildPreviewModel(
      report,
      pick('windows-temp', 'c:/Users/Kano/AppData/Local/Temp/B.LOG'),
      { nowMs: NOW }
    )
    expect(m.totalBytes).toBe(250)
  })

  it('同一项重复勾选不翻倍：第二次拒绝并留痕', () => {
    const m = buildPreviewModel(report, select('windows-temp', 'windows-temp'), { nowMs: NOW })
    expect(m.totalBytes).toBe(1_250)
    expect(m.refusals.map((r) => r.reason)).toEqual(['duplicate-selection'])
    expect(m.refusals[0]?.detail).toContain('已按整项勾选')
  })

  it('同一批路径重复勾选不翻倍', () => {
    const m = buildPreviewModel(
      report,
      {
        items: [
          { ruleId: 'windows-temp', paths: ['C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp'] },
          { ruleId: 'windows-temp', paths: ['C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp'] }
        ]
      },
      { nowMs: NOW }
    )
    expect(m.totalBytes).toBe(1_000)
    expect(m.refusals.map((r) => r.reason)).toEqual(['duplicate-selection'])
  })

  it('整项 + 逐路径同时勾选：逐路径不再重复计价', () => {
    const m = buildPreviewModel(report, {
      items: [
        { ruleId: 'windows-temp' },
        { ruleId: 'windows-temp', paths: ['C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp'] }
      ]
    }, { nowMs: NOW })
    expect(item(m, 'windows-temp').scope).toBe('rule')
    expect(m.totalBytes).toBe(1_250)
    expect(m.refusals[0]?.reason).toBe('duplicate-selection')
    expect(m.refusals[0]?.bytes).toBe(0)
  })

  it('先逐路径再整项：结果与勾选顺序无关（整项吸收掉逐路径，仍然只计一次）', () => {
    const m = buildPreviewModel(report, {
      items: [
        { ruleId: 'windows-temp', paths: ['C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp'] },
        { ruleId: 'windows-temp' }
      ]
    }, { nowMs: NOW })
    expect(item(m, 'windows-temp').scope).toBe('rule')
    expect(m.totalBytes).toBe(1_250)
    expect(m.refusals.map((r) => r.reason)).toEqual(['duplicate-selection'])
    expect(m.refusals[0]?.bytes).toBe(0)
    // 与反过来的勾选顺序给出同一份账（唯一差别是留痕顺序）
    const flipped = buildPreviewModel(report, {
      items: [
        { ruleId: 'windows-temp' },
        { ruleId: 'windows-temp', paths: ['C:\\Users\\Kano\\AppData\\Local\\Temp\\a.tmp'] }
      ]
    }, { nowMs: NOW })
    expect(flipped.totalBytes).toBe(m.totalBytes)
    expect(flipped.digest).toBe(m.digest)
  })
})

describe('§17 预览：勾了个报告里没有的东西 → 点名拒绝，不许静默吞掉', () => {
  const report = reportOf()

  it('未知 ruleId → unknown-rule（带 bytes=0，不影响预估）', () => {
    const m = buildPreviewModel(report, select('made-up-rule'), { nowMs: NOW })
    expect(m.totalBytes).toBe(0)
    expect(m.refusals.map((r) => r.reason)).toEqual(['unknown-rule'])
    expect(m.refusals[0]?.detail).toContain('made-up-rule')
  })

  it('被 §15 校验拒掉的规则 → item-rejected，并把拒绝理由转述出来', () => {
    // **按 id 点名取规则**，不按表序：这条用例要的是「一条 🟢 temp 规则被换成容器入口路径」那个形状，
    // 拿 `BUILTIN_RULES[0]` 表达的是"它此刻恰好在第 1 位"。T3b-ii 跑 §7 变异 5（把新规则插到表头）时
    // 这条用例红过一次 —— 红的原因不是判据有牙，是夹具按位置取货（`select('windows-temp')` 报了
    // unknown-rule）。断言的意图逐字不变，改的只是取货方式。
    const temp = BUILTIN_RULES.find((r) => r.id === 'windows-temp')
    expect(temp, '内置表里必须还有 windows-temp 这条 🟢 规则').toBeDefined()
    const bad: Rule = { ...temp!, paths: ['%LOCALAPPDATA%'] }
    expect(bad.id).toBe('windows-temp')
    const rejected = evaluateRules({
      source: guarded(storeFrom(FIXTURE)),
      env: ENV,
      rules: [bad],
      forbiddenPatterns: FORBIDDEN,
      nowMs: NOW
    })
    expect(rejected.rejectedRules.length).toBe(1)
    const m = buildPreviewModel(rejected, select('windows-temp'), { nowMs: NOW })
    expect(m.refusals.map((r) => r.reason)).toEqual(['item-rejected'])
    expect(m.refusals[0]?.detail).toContain(rejected.rejectedRules[0]!.problems[0]!.reason)
    expect(m.totalBytes).toBe(0)
  })

  it('空勾选 → 预估 0，但 items 仍是完整清单（§17「发现可清理项目」这一步的数据源）', () => {
    const m = buildPreviewModel(report, { items: [] }, { nowMs: NOW })
    expect(m.totalBytes).toBe(0)
    expect(m.items.length).toBe(report.findings.length)
    expect(m.items.every((i) => !i.included)).toBe(true)
  })

  it('渲染进程递来的垃圾选择（缺 ruleId / items 不是数组）→ 点名拒绝，不崩也不静默放行', () => {
    const m = buildPreviewModel(
      report,
      { items: [{ ruleId: '' }, { ruleId: 42 as unknown as string }, { ruleId: 'windows-temp', paths: 'nope' as unknown as string[] }] },
      { nowMs: NOW }
    )
    expect(m.totalBytes).toBe(0)
    expect(m.refusals.map((r) => r.reason)).toEqual(['unknown-rule', 'unknown-rule', 'path-not-enumerated'])
    const junk = buildPreviewModel(report, null as unknown as PreviewSelection, { nowMs: NOW })
    expect(junk.totalBytes).toBe(0)
    expect(junk.blocked).toBe(false)
    expect(junk.refusals.map((r) => r.reason)).toEqual(['unknown-rule'])
  })
})

describe('§17 预览：合计与分解的自洽（数字必须互相咬合）', () => {
  const report = reportOf()

  it('totalBytes = 各项 included 之和 = riskBreakdown 之和；🟠/不可再生会写进 notes', () => {
    const high = finding({ ruleId: 'risky', riskLevel: 'high', totalBytes: 77, fileCount: 3 })
    const rep = bareReport({
      findings: [
        finding({ ruleId: 'safe1', riskLevel: 'safe', totalBytes: 10, fileCount: 1, recoverable: true }),
        high,
        finding({ ruleId: 'gone', riskLevel: 'forbidden', totalBytes: 999, fileCount: 9 })
      ]
    })
    const m = buildPreviewModel(rep, select('safe1', 'risky', 'gone'), { nowMs: NOW })
    expect(m.totalBytes).toBe(10 + 77)
    expect(m.totalFiles).toBe(1 + 3)
    const sum = (['safe', 'caution', 'high', 'forbidden'] as Risk[]).reduce((a, k) => a + m.riskBreakdown[k].bytes, 0)
    expect(sum).toBe(m.totalBytes)
    expect(m.items.filter((i) => i.included).reduce((a, i) => a + i.bytes, 0)).toBe(m.totalBytes)
    expect(m.riskBreakdown.high).toEqual({ items: 1, files: 3, bytes: 77 })
    expect(m.refusedBytes).toBe(999)
    expect(m.notes.join(' ')).toContain('高风险')
    expect(m.notes.join(' ')).toContain('不可再生')
  })

  it('matchedRoots 透传自报告（UI 要说清「这项覆盖哪些目录」）', () => {
    const m = buildPreviewModel(report, select('windows-temp'), { nowMs: NOW })
    expect(item(m, 'windows-temp').matchedRoots).toEqual([ENV.TEMP])
    expect(item(m, 'browser-cache').matchedRoots).toEqual([
      'C:\\Users\\Kano\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache'
    ])
  })
})

describe('§17 确认：只回执数据，没有任何执行入口', () => {
  const report = reportOf()

  it('确认一份干净的预览 → 得到数据回执，字段是钉死的白名单（不含任何路径清单/可执行语义）', () => {
    const m = buildPreviewModel(report, select('windows-temp', 'npm-cache'), { nowMs: NOW })
    const c = confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'caution', nowMs: NOW })
    expect(c.kind).toBe('dc-preview-confirmation')
    expect(c.confirmed).toBe(true)
    expect(c.blockers).toEqual([])
    expect(c.totalBytes).toBe(m.totalBytes)
    // M5-P1 T4：回执的指纹**不再等于**模型指纹 —— 它是「模型决策字段 + 按下的档位」。
    expect(c.acknowledgedRisk).toBe('caution')
    expect(c.digest).toBe(previewDigest(m, 'caution'))
    expect(c.digest).not.toBe(m.digest)
    // 归属凭据：回执另外记下**它绑定的模型指纹**。渲染端没法自己重算带档位的 digest
    // （`tsconfig.web` 不许 import `core/rules/**`），所以这条等式是界面唯一的归属判据。
    expect(c.modelDigest).toBe(m.digest)
    expect(c.ruleIds).toEqual(['windows-temp', 'npm-cache'])
    expect(c.refusalCount).toBe(0)
    expect(c.note).toContain('不含路径清单')
    expect(Object.keys(c).sort()).toEqual(
      [
        'acknowledged',
        'acknowledgedRisk',
        'blockers',
        'confirmed',
        'confirmedAtMs',
        'digest',
        'files',
        'items',
        'kind',
        'modelDigest',
        'note',
        'refusalCount',
        'ruleIds',
        'totalBytes'
      ].sort()
    )
  })

  it('取消（acknowledged=false）→ confirmed=false，一条字节都没确认', () => {
    const m = buildPreviewModel(report, select('windows-temp'), { nowMs: NOW })
    const c = confirmPreview(m, { acknowledged: false, acknowledgedRisk: 'safe', nowMs: NOW })
    expect(c.confirmed).toBe(false)
    expect(c.blockers).toEqual(['not-acknowledged'])
    expect(c.totalBytes).toBe(0)
    expect(c.ruleIds).toEqual([])
  })

  it('什么都没勾 → 不许确认（nothing-to-confirm）', () => {
    const m = buildPreviewModel(report, { items: [] }, { nowMs: NOW })
    expect(confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'safe', nowMs: NOW }).blockers).toEqual(['nothing-to-confirm'])
  })

  it('blocked 的预览不许确认（safety-blocked）', () => {
    const m = buildPreviewModel(bareReport({ safetyBlocked: true, forbiddenRoots: [] }), select('windows-temp'), {
      nowMs: NOW
    })
    expect(confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'safe', nowMs: NOW }).blockers).toContain('safety-blocked')
  })

  it('确认必须绑定在这一份预估上：模型被改过（字节数或勾选项）→ stale-model', () => {
    const m = buildPreviewModel(report, select('windows-temp'), { nowMs: NOW })
    const tampered = { ...m, totalBytes: m.totalBytes + 1 }
    const c = confirmPreview(tampered, { acknowledged: true, acknowledgedRisk: 'safe', nowMs: NOW })
    expect(c.confirmed).toBe(false)
    expect(c.blockers).toEqual(['stale-model'])
    expect(c.digest).toBe(previewDigest(tampered, 'safe'))
    // 原始那份仍然确认得下来
    expect(confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'safe', nowMs: NOW }).confirmed).toBe(true)
  })

  it('有人手工把 🔴 项目塞进 included → 确认当场拒绝（forbidden-included），并且不留可执行清单', () => {
    const m = buildPreviewModel(report, select('windows-temp'), { nowMs: NOW })
    const forged: typeof m = {
      ...m,
      items: m.items.map((i) =>
        i.ruleId === 'recycle-bin' ? { ...i, selected: true, included: true, bytes: 14_000, refusal: null } : i
      )
    }
    const c = confirmPreview(forged, { acknowledged: true, acknowledgedRisk: 'safe', nowMs: NOW })
    expect(c.confirmed).toBe(false)
    expect(c.blockers).toContain('forbidden-included')
    expect(JSON.stringify(c)).not.toContain('System32')
    expect(Object.keys(c)).not.toContain('paths')
  })

  it('预览模块不导出任何执行入口（§17 到确认为止，§18 才谈执行）', () => {
    const names = Object.keys(previewModule)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => /execute|delete|remove|apply|perform|run|clean|wipe|prune|unlink|destroy/i.test(n))).toEqual(
      []
    )
    // 导出的全是纯函数：没有任何句柄 / 队列 / 任务型对象能被后续调用去"干活"
    for (const v of Object.values(previewModule)) expect(typeof v).toBe('function')
  })

  it('digest 只由决策字段决定：同选择同报告 → 同指纹', () => {
    const a = buildPreviewModel(report, select('windows-temp', 'npm-cache'), { nowMs: NOW })
    const b = buildPreviewModel(report, select('npm-cache', 'windows-temp'), { nowMs: NOW })
    expect(a.digest).toBe(b.digest)
    const c = buildPreviewModel(report, select('windows-temp'), { nowMs: NOW })
    expect(a.digest).not.toBe(c.digest)
  })
})

/* ------------------------------------------------------------------ *
 * M5-P1 T4：确认**按最高风险档**。
 *
 * `acknowledged` 那句「我了解这些文件将被删除」说的只是"点了一下"，
 * 说明不了用户看见过 🟠 —— 那正是 spec §5 要关的门。
 * 这一族判据用**内置表上真实存在的那条 🟠**（`user-downloads-installers`，T3b-ii 上表）造模型，
 * 不手搓风险等级：手搓的话，红了分不清是规则表的事还是判据的事。
 * ------------------------------------------------------------------ */
describe('§17 确认按档（M5-P1 T4）：档位盖不住已计入项就出不了回执', () => {
  /** 同一棵合成树：🟢 Temp 一个文件 + 🟠 Downloads 一个安装包（顶层，规则本身不递归）。 */
  const tree = () =>
    storeFrom({
      ...FIXTURE,
      'C:\\Users\\Kano\\Downloads': [{ name: 'setup.exe', size: 900 }, { name: 'holiday.jpg', size: 3_000 }]
    })
  const rep = () => reportOf(BUILTIN_RULES, tree())
  /** 一份既有 🟢 又有 🟠 的预估：混档才是真实形态（全选时 🟠 会被界面挡住，逐行勾才进得来）。 */
  const mixed = () => buildPreviewModel(rep(), select('windows-temp', 'user-downloads-installers'), { nowMs: NOW })

  it('夹具确实在造"🟠 那一行已被计入"这件事（否则下面整族判据都是空转）', () => {
    const m = mixed()
    const dl = item(m, 'user-downloads-installers')
    expect(dl.riskLevel).toBe('high')
    expect(dl.included, '🟠 项没进 included ⇒ 这一族判据量的是别的东西').toBe(true)
    expect(dl.bytes).toBe(900)
    expect(m.riskBreakdown.high.bytes).toBe(900)
    // 顶层只收安装器：同目录那张照片不许被顺手计进来（钉 plan §5.6 的 recursive:false）
    expect(m.totalBytes).toBe(1_000 + 250 + 900)
  })

  it('含 🟠 已计入项：按 high 才出得来回执，按 caution 只出 risk-not-acknowledged', () => {
    const m = mixed()
    const low = confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'caution', nowMs: NOW })
    expect(low.confirmed).toBe(false)
    expect(low.blockers).toEqual(['risk-not-acknowledged'])
    // **没有回执**：没过闸就不许带出清单与合计（只断言 confirmed=false 会放过"填好清单顺手打个标记"那种形态）
    expect(low.ruleIds).toEqual([])
    expect(low.items).toBe(0)
    expect(low.files).toBe(0)
    expect(low.totalBytes).toBe(0)
    expect(low.acknowledgedRisk, '回执如实带用户按下的那一档，不许服务端替他升档').toBe('caution')

    const high = confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'high', nowMs: NOW })
    expect(high.confirmed).toBe(true)
    expect(high.blockers).toEqual([])
    expect(high.ruleIds).toEqual(['windows-temp', 'user-downloads-installers'])
    expect(high.totalBytes).toBe(m.totalBytes)
  })

  it('🟡 档够得着 🟡 的预估；🟢 的预估按 🟡 也照样过（不许过度询问）', () => {
    const cautionOnly = buildPreviewModel(reportOf(), select('npm-cache'), { nowMs: NOW })
    expect(item(cautionOnly, 'npm-cache').riskLevel).toBe('caution')
    const c = confirmPreview(cautionOnly, { acknowledged: true, acknowledgedRisk: 'caution', nowMs: NOW })
    expect(c.confirmed).toBe(true)
    expect(c.blockers).toEqual([])

    // 反半边：全 🟢 的预估按 🟡 档确认 —— 按得高不是错，判据只拦"按得不够"
    const safeOnly = buildPreviewModel(reportOf(), select('windows-temp'), { nowMs: NOW })
    expect(safeOnly.items.filter((i) => i.included).every((i) => i.riskLevel === 'safe')).toBe(true)
    const over = confirmPreview(safeOnly, { acknowledged: true, acknowledgedRisk: 'caution', nowMs: NOW })
    expect(over.confirmed).toBe(true)
    expect(over.blockers).toEqual([])
  })

  it('没被勾选的 🟠 行不抬档：只勾 🟢 那一行时按 safe 就够', () => {
    const m = buildPreviewModel(rep(), select('windows-temp'), { nowMs: NOW })
    const dl = item(m, 'user-downloads-installers')
    expect(dl.included).toBe(false)
    const c = confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'safe', nowMs: NOW })
    expect(c.confirmed, c.blockers.join('、')).toBe(true)
  })

  it('同一份模型换档位 ⇒ 凭据必须换（否则旧回执能换个档重放）', () => {
    const m = mixed()
    const bySafe = confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'safe', nowMs: NOW }).digest
    const byCaution = confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'caution', nowMs: NOW }).digest
    const byHigh = confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'high', nowMs: NOW }).digest
    expect(new Set([bySafe, byCaution, byHigh]).size).toBe(3)
    // 模型那一份指纹是**档位无关**的：build 写进去的、复核 stale 用的都是它
    expect(m.digest).toBe(previewDigest(m))
    expect(byHigh).toBe(previewDigest(m, 'high'))
    expect(byHigh).not.toBe(m.digest)
  })

  it('新 blocker 坐在指纹与内容复核之后、safety-blocked 之前（顺序即行为）', () => {
    const base = mixed()
    const m: PreviewModel = {
      ...base,
      blocked: true,
      digest: 'tampered',
      reportOnlyRoots: ['C:\\$Recycle.Bin'],
      items: [
        ...base.items,
        {
          ...item(base, 'windows-temp'),
          ruleId: 'bin-as-safe',
          name: 'bin-as-safe',
          riskLevel: 'safe',
          selected: true,
          included: true,
          bytes: 9_000,
          files: 1,
          paths: [{ path: 'C:\\$Recycle.Bin\\S-1-5-21-100\\$R photo.jpg', size: 9_000 }],
          matchedRoots: ['C:\\$Recycle.Bin'],
          refusal: null
        }
      ]
    }
    const c = confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'safe', nowMs: NOW })
    expect(c.blockers).toEqual(['stale-model', 'forbidden-included', 'risk-not-acknowledged', 'safety-blocked'])
  })

  it('回归轴：既有三条 blocker 的次序与可达性逐字不变', () => {
    const m = buildPreviewModel(reportOf(), select('windows-temp'), { nowMs: NOW })

    // ① stale-model：只改一个字节（档位按的是 🟡，比这份全 🟢 的预估要求的档还高 ⇒ 不许顺手多出一条）
    const tampered = { ...m, totalBytes: m.totalBytes + 1 }
    expect(confirmPreview(tampered, { acknowledged: true, acknowledgedRisk: 'caution', nowMs: NOW }).blockers).toEqual([
      'stale-model'
    ])

    // ② forbidden-included：把 🔴 回收站算成 included，**并把指纹重算对**
    //    （与 Rust `forbidden_included_fires_even_when_the_fingerprint_is_consistent` 同形：
    //    这条只许由内容复核拦，出现 stale-model 就是判据换人了）
    const forgedItems = m.items.map((i) =>
      i.ruleId === 'recycle-bin' ? { ...i, selected: true, included: true, bytes: 14_000, refusal: null } : i
    )
    const forged: PreviewModel = { ...m, items: forgedItems }
    forged.digest = previewDigest(forged)
    const f = confirmPreview(forged, { acknowledged: true, acknowledgedRisk: 'caution', nowMs: NOW })
    expect(f.blockers).toEqual(['forbidden-included'])

    // ③ safety-blocked：blocked 的模型里没有任何项被计入 ⇒ 档位那一条不参与（🔴 抬不了档，见 requiredTier）
    const blocked = buildPreviewModel(bareReport({ safetyBlocked: true, forbiddenRoots: [] }), select('windows-temp'), {
      nowMs: NOW
    })
    expect(confirmPreview(blocked, { acknowledged: true, acknowledgedRisk: 'caution', nowMs: NOW }).blockers).toEqual([
      'safety-blocked'
    ])
  })
})

describe('§17 预览 × 真实规则表：把整张报告的账对平', () => {
  it('全量勾选（含 🔴）→ 预估 = 报告 reclaimableBytes，refusedBytes = 报告 bytesByRisk.forbidden', () => {
    const report = reportOf()
    const m = buildPreviewModel(report, select(...report.findings.map((f) => f.ruleId)), { nowMs: NOW })
    expect(m.totalBytes).toBe(report.reclaimableBytes)
    expect(m.refusedBytes).toBe(report.bytesByRisk.forbidden)
    expect(m.riskBreakdown.safe.items).toBe(report.findings.filter((f) => f.riskLevel === 'safe' && f.totalBytes >= 0).length)
    expect(m.riskBreakdown.forbidden.items).toBe(0)
    for (const i of m.items) if (i.included) expect(i.riskLevel).not.toBe('forbidden')
  })
})

/**
 * §3.5 的默认勾选豁免住在服务端：`registry` 声明 → `defaultUnselectableRuleIds()` 派生 →
 * 调用方交给 `buildPreviewModel` → 模型带着它出 IPC。预览这一层只做"抄一遍"，
 * 因为一旦在这里重新判定，就有了第二份「哪些算模型文件」的事实源。
 */
describe('§3.5 默认全选豁免表：抄进模型，但不进授权串', () => {
  const report = reportOf()

  it('调用方交来的那张表原样出现在模型上（渲染端不必自己认哪条是模型文件）', () => {
    const m = buildPreviewModel(report, select('windows-temp', 'huggingface-cache'), {
      nowMs: NOW,
      defaultUnselectableRuleIds: ['huggingface-cache']
    })
    expect(m.defaultUnselectableRuleIds).toEqual(['huggingface-cache'])
  })

  it('不传那张表时是空数组而不是 undefined（渲染端不必处理"缺这个字段"第三种状态）', () => {
    const m = buildPreviewModel(report, select('windows-temp'), { nowMs: NOW })
    expect(m.defaultUnselectableRuleIds).toEqual([])
  })

  /**
   * 这条是刻意的边界，不是遗漏：`digest` 是**确认授权**的凭据，它要绑的是账目
   * （哪些项计入、多少字节、哪些路径），不是"界面默认替用户勾了哪几行"。
   * 把它塞进 digest 的后果：同一份账会因为一个呈现字段而换一个授权串，
   * 而 §18 的执行入口只认那串。
   */
  it('豁免表内容变化不改 digest —— 默认勾选取舍不构成新的授权', () => {
    const withFlag = buildPreviewModel(report, select('windows-temp'), {
      nowMs: NOW,
      defaultUnselectableRuleIds: ['huggingface-cache']
    })
    const withoutFlag = buildPreviewModel(report, select('windows-temp'), {
      nowMs: NOW,
      defaultUnselectableRuleIds: []
    })
    const inherited = buildPreviewModel(report, select('windows-temp'), { nowMs: NOW })
    expect(withFlag.digest).toBe(withoutFlag.digest)
    expect(withFlag.digest).toBe(inherited.digest)
    // 而账目一侧照旧是敏感的（反向对照：不许 digest 因为压根没参与计算而对一切都"不变"）
    const differentSelection = buildPreviewModel(report, select('windows-temp', 'browser-cache'), { nowMs: NOW })
    expect(differentSelection.digest).not.toBe(withFlag.digest)
  })
})

/**
 * §3.6 未完 #2 / #4b：地盘底账要能穿过预览这一层走到 `devenvView`，
 * 但它**绝不进授权串** —— `digest` 是 §18 执行入口唯一认的东西，
 * 而"这块地在哪棵树上看到、有多少字节、没扫到几条"改的是**说明**，不是账目。
 * 与上面 §3.5 那条豁免表完全同构，连反向对照（换勾选必须换串）都照抄，
 * 否则"对一切都不变"这种假绿会一路混到交付。
 */
describe('§3.6 地盘底账：抄进模型，但不进授权串', () => {
  it('引擎那张表原样出现在模型上（预览不重新判定哪条规则归探测管）', () => {
    const report = reportOf()
    const m = buildPreviewModel(report, select('windows-temp'), { nowMs: NOW })
    expect(m.territories).toEqual(report.territories)
    // 反向半边：这张表确实不是空的，否则上一条是在证明一件没发生的事
    expect(report.territories.length).toBeGreaterThan(0)
  })

  it('报告没带这张表时是空数组而不是 undefined（下游不必处理第三种状态）', () => {
    const m = buildPreviewModel(bareReport({ findings: [finding({ ruleId: 'windows-temp', riskLevel: 'safe' })] }), select('windows-temp'), {
      nowMs: NOW
    })
    expect(m.territories).toEqual([])
  })

  it('底账内容变化不改 digest，而账目一侧照旧敏感', () => {
    const report = reportOf()
    const plain = buildPreviewModel(report, select('windows-temp'), { nowMs: NOW })
    const edited = buildPreviewModel(
      { ...report, territories: [{ ruleId: 'pnpm-store', detectorAbsent: true, present: [{ path: 'X', bytes: 1 }], notScanned: 3 }] },
      select('windows-temp'),
      { nowMs: NOW }
    )
    expect(edited.territories.length).toBe(1)
    expect(edited.digest).toBe(plain.digest)
    const differentSelection = buildPreviewModel(report, select('windows-temp', 'browser-cache'), { nowMs: NOW })
    expect(differentSelection.digest).not.toBe(plain.digest)
  })
})

/* ------------------------------------------------------------------ *
 * M5-P1 T5a：规则文案必须到得了界面，而且必须在**被哈希的那一层**。
 *
 * 与 T4 那一族同构，只是变量从"档位"换成"文案"：
 * `description` 是用户在确认框里读到的「删了会失去什么」（spec §5），
 * 它在任何人确认之前就已经挂在这份模型上 ⇒ 它属于**模型指纹**那一半。
 * 只把它塞进凭据（`Some(tier)`）那一支的话：服务端把某条规则的文案改软一次，
 * `buildPreviewModel` 写进 `model.digest` 的那一份逐字不变 → 用户重开预估照样过 stale 复核、
 * 旧回执照样对得上重算出来的凭据。那扇门 T4 刚从档位那一侧关掉，不许从文案这侧重开。
 * ------------------------------------------------------------------ */
describe('M5-P1 T5a：每一项都带着它自己那条规则的文案，且文案在 digest 覆盖字段里', () => {
  /**
   * 把**整张内置表**一条条合成成 finding（合成树口径 —— 预览的入参本来就是报告不是树，
   * 见本文件头约束 2）。用真树反而覆盖不齐：`requiresDetector` 那一族在没有对应探测器状态的
   * 树上一条 finding 都不产，于是"每项都有文案"会退化成"恰好有的那几项有文案"。
   */
  const findingsOfTable = (): RuleFinding[] =>
    BUILTIN_RULES.map((r, n) =>
      finding({
        ruleId: r.id,
        name: r.name,
        category: r.category,
        riskLevel: r.riskLevel,
        cleanStrategy: r.cleanStrategy,
        recoverable: r.recoverable,
        matchedRoots: [`C:\synth\${n}`],
        samplePaths: [{ path: `C:\synth\${n}\f${n}.tmp`, size: 100 + n }],
        fileCount: 1,
        totalBytes: 100 + n
      })
    )

  it('every_item_carries_its_rule_description —— 空一条即红，且要点名是哪几条', () => {
    const m = buildPreviewModel(bareReport({ findings: findingsOfTable() }), select(...BUILTIN_RULES.map((r) => r.id)), {
      nowMs: NOW
    })
    // ① 条数：项少了，下面"每条非空"就是在空过（🔴 也照样是一条项，只是不计入）
    expect(m.items.length, '预览模型里的项数与内置表条数对不上 ⇒ 「每条都有文案」会空过').toBe(BUILTIN_RULES.length)
    // ② 非空，并点名空的那几条
    const empty = m.items.filter((i) => i.description.trim() === '').map((i) => i.ruleId)
    expect(empty, `这些项的 description 是空的，「删了会失去什么」这句话到不了界面：${empty.join(', ')}`).toEqual([])
    // ③ 逐字等于规则那一份 —— 预览层一旦自己写句子，两侧就开始分叉，而被哈希的是分叉后的那份
    m.items.forEach((i, n) => {
      const rule = BUILTIN_RULES[n]!
      expect(i.ruleId, '项序与表序错位，下面的逐条比对就没有意义').toBe(rule.id)
      expect(i.description, `项「${rule.id}」的文案不是规则那一份（预览层自己写了句子？）`).toBe(rule.description)
    })
  })

  it('表外的 ruleId（dup:* 伪项 / 夹具自定义规则集）留空串，而不是显示层编的一句', () => {
    const m = buildPreviewModel(
      bareReport({ findings: [finding({ ruleId: 'dup:3823da', riskLevel: 'high', totalBytes: 100, fileCount: 1 })] }),
      select('dup:3823da'),
      { nowMs: NOW }
    )
    expect(m.items[0]!.included, '对照组：这一项确实进了预估，红不是走错分支红出来的').toBe(true)
    expect(m.items[0]!.description).toBe('')
  })

  it('digest_changes_when_an_items_description_changes —— 两份口径都要跟着换号', () => {
    const rep = bareReport({
      findings: [
        finding({
          ruleId: 'windows-temp',
          riskLevel: 'safe',
          matchedRoots: ['C:\Temp'],
          samplePaths: [{ path: 'C:\Temp\a.tmp', size: 100 }],
          fileCount: 1,
          totalBytes: 100
        })
      ]
    })
    const m = buildPreviewModel(rep, select('windows-temp'), { nowMs: NOW })
    const rule = BUILTIN_RULES.find((r) => r.id === 'windows-temp')!
    expect(m.items[0]!.description, '夹具得真带上表里那句话，否则下面比的是两段凭空写的文本').toBe(rule.description)

    // 唯一变量：那一条项的文案。字节、文件数、勾选、档位一个字都没动。
    const reworded: typeof m = {
      ...m,
      items: m.items.map((i) => (i.ruleId === 'windows-temp' ? { ...i, description: '放心删，这些都是没用的垃圾文件' } : i))
    }
    expect(reworded.totalBytes).toBe(m.totalBytes)
    expect(reworded.items[0]!.bytes).toBe(m.items[0]!.bytes)

    // 模型指纹那一半（`undefined` 支）—— 只进凭据的话，这一句就是绿不起来的
    expect(previewDigest(reworded)).not.toBe(previewDigest(m))
    // 凭据那一半（传档位的支）同样必须换
    expect(previewDigest(reworded, 'safe')).not.toBe(previewDigest(m, 'safe'))
    // 行为半边：文案换过之后，那份**旧**预估的确认必须当场 stale —— 这只有"进的是模型指纹"才做得到
    const stale = confirmPreview(reworded, { acknowledged: true, acknowledgedRisk: 'safe', nowMs: NOW })
    expect(stale.blockers).toEqual(['stale-model'])
    // 反向对照：同一条文案两次算出的串逐字相同（排除"多加了一段就对所有输入都敏感"这种假绿）
    const again: typeof m = { ...m, items: m.items.map((i) => ({ ...i, description: rule.description })) }
    expect(previewDigest(again)).toBe(previewDigest(m))
  })

  it('字段白名单：`description` 在**项**那一份上（+1），回执那一份仍然一个字的文案都不带', () => {
    const m = buildPreviewModel(reportOf(), select('windows-temp', 'browser-cache'), { nowMs: NOW })
    expect(Object.keys(m.items[0]!).sort()).toEqual(
      [
        'ruleId',
        'name',
        'description',
        'category',
        'riskLevel',
        'cleanStrategy',
        'recoverable',
        'selected',
        'included',
        'bytes',
        'files',
        'scope',
        'paths',
        'findingBytes',
        'findingFiles',
        'sampleTruncated',
        'matchedRoots',
        'refusal'
      ].sort()
    )
    // 回执侧：T4 的白名单（上面那条用例）不加 `description` —— 回执带的是 ruleIds + 合计，
    // 文案是**间接**绑上去的：它进了 digest 覆盖字段，所以改文案换凭据，但回执本身不复制那句话。
    const c = confirmPreview(m, { acknowledged: true, acknowledgedRisk: 'caution', nowMs: NOW })
    expect(Object.keys(c)).not.toContain('description')
    expect(c.digest).toBe(previewDigest(m, 'caution'))
  })
})
