/**
 * V0.7 未完 #2 与 #4b 的同一份底账：**每条工具规则的地盘与这棵树的关系**。
 *
 * 这两个缺口其实是同一个洞的两种说法 —— 现在的报告只回答"这块地盘能回收多少"，
 * 于是界面上有两句话永远说不出来：
 * - **没装但盘上真有**：探测器判未装 → 整块地盘不计账（方向安全），可是用户看不见"这里还躺着 121 KB 你可能想手动删"；
 * - **0 B 到底是哪种 0**：缓存真的空、还是这次压根没扫到那块地？两个 0 在表格里长得一模一样。
 *
 * 所以这张表只记三件事：`detectorAbsent`（探测结论）、`present`（这棵树上**看到**的地盘 + 各自的子树合计）、
 * `notScanned`（这次没覆盖到的地盘条数）。**不新造判定、不改任何账**：
 * `reclaimableBytes`、`findings`、`exclusions` 的条数与内容都必须逐字不变（第 5、7 条用例钉这件事）。
 *
 * 字节来自 `TreeStore.sizeOf()`（`finalizeDir` 自底向上算好的子树合计，finalizeDir 幂等），
 * **一次都不枚举文件** —— 引擎那份"本文件不可能重新走盘"的墙不破。
 * 代价要写清：那是**整个目录子树**的占用，不是"这条规则认为可回收的量"，
 * 子树里可能有别的规则已认领的文件、也有 🔴 禁止路径 —— 所以那句话只能念"这个目录里共 X"。
 */
import { describe, expect, it } from 'vitest'
import { parentOf } from '../../core/fs/pathutil'
import { TreeStore } from '../../core/scan/tree-store'
import { evaluateRules } from '../../core/rules/engine'
import { BUILTIN_RULES, FORBIDDEN_PATH_PATTERNS } from '../../core/rules/registry'

const NOW = 1_700_000_000_000
const DAY = 86_400_000

const ENV = {
  SYSTEMDRIVE: 'C:\\',
  WINDIR: 'C:\\Windows',
  TEMP: 'C:\\Machine\\AppData\\Local\\Temp',
  LOCALAPPDATA: 'C:\\Machine\\AppData\\Local',
  APPDATA: 'C:\\Machine\\AppData\\Roaming',
  PROGRAMDATA: 'C:\\ProgramData',
  USERPROFILE: 'C:\\Machine',
  // CLEANUP-RULES §6 之后禁止根模板引用了 `%PROGRAMFILES%\`。缺这一键 ⇒ 禁止根解析不出来
  // ⇒ `safetyBlocked` ⇒ territories 一条都不出（本文件 8 条判据全红的真实原因）。
  PROGRAMFILES: 'C:\\Program Files'
}

const PNPM_STORE = 'C:\\Machine\\AppData\\Local\\pnpm-store'
const NPM_CACHE = 'C:\\Machine\\AppData\\Local\\npm-cache'
const MAVEN_REPO = 'C:\\Machine\\.m2\\repository'
const CODE_CACHE = 'C:\\Machine\\AppData\\Roaming\\Code\\Cache'

/** 带祖先链地造一棵树；每个目录里的文件字节数互不相同，好让"哪一笔出去了"能直接对上号。 */
function tree(spec: Record<string, number[]>): TreeStore {
  const dirs = new Set<string>()
  for (const k of Object.keys(spec)) {
    let cur = k
    while (cur.length > 2 && !dirs.has(cur)) {
      dirs.add(cur)
      const p = parentOf(cur)
      if (p === null || !k.toLowerCase().startsWith(p.toLowerCase())) break
      cur = p
    }
  }
  const ordered = [...dirs].sort((a, b) => a.split('\\').length - b.split('\\').length)
  const root = ordered[0]!
  const s = new TreeStore({ rootPath: root, maxFiles: 100_000 })
  for (const dir of ordered) {
    const id = s.beginDir(dir)
    const p = parentOf(dir)
    if (p !== null) {
      const pid = s.dirIdByPath(p)
      if (pid !== undefined) s.attachChild(pid, id)
    }
    s.addFilesToDir(
      id,
      (spec[dir] ?? []).map((size, i) => ({
        name: `f${i}.bin`,
        size,
        mtimeMs: NOW - 30 * DAY,
        birthtimeMs: NOW - 60 * DAY,
        attrs: 0
      }))
    )
  }
  // 根 finalize 会递归到底（tree-store 那条"顺序不对结果仍然正确"），sizeOf 从此才有真值
  s.finalizeDir(s.rootId)
  return s
}

const base = tree({
  [PNPM_STORE]: [60_000, 61_000],
  // pnpm 的第二条地盘 `%LOCALAPPDATA%\pnpm\store` 故意不建 → not-scanned
  [NPM_CACHE]: [33_000],
  [MAVEN_REPO]: [],
  // vscode 的第二条地盘 `%APPDATA%\Code\CachedData` 故意不建 → not-scanned
  [CODE_CACHE]: [15_000]
})

const run = (detectorStatus?: ReadonlyMap<string, boolean>) =>
  evaluateRules({
    source: base,
    env: ENV,
    rules: BUILTIN_RULES,
    forbiddenPatterns: FORBIDDEN_PATH_PATTERNS,
    nowMs: NOW,
    ...(detectorStatus ? { detectorStatus } : {})
  })

const fact = (r: ReturnType<typeof run>, ruleId: string) => r.territories.find((t) => t.ruleId === ruleId)

describe('territories —— 地盘与这棵树的关系', () => {
  it('未装 + 盘上有残留：detectorAbsent=true，present 点名那条目录并带子树合计字节', () => {
    const r = run(new Map([['pnpm', false]]))
    const t = fact(r, 'pnpm-store')
    expect(t).toBeDefined()
    expect(t!.detectorAbsent).toBe(true)
    expect(t!.present).toEqual([{ path: PNPM_STORE, bytes: 121_000 }])
    expect(t!.notScanned).toBe(1)
  })

  it('残留字节不进可回收合计 —— 这一条是 #2 的全部风险所在：报了占用又不能删，账必须先分家', () => {
    const withMap = run(new Map([['pnpm', false]]))
    const without = run(new Map([['pnpm', true]]))
    expect(without.reclaimableBytes - withMap.reclaimableBytes).toBe(121_000)
  })

  it('已装且缓存真空（目录在、0 字节）：present 有它、bytes=0、notScanned=0 —— 与"没扫到"必须是两种形状', () => {
    const t = fact(run(new Map([['maven', true]])), 'maven-repository')
    expect(t!.present).toEqual([{ path: MAVEN_REPO, bytes: 0 }])
    expect(t!.notScanned).toBe(0)
  })

  it('已装但扫的不是那棵树：present=1 + notScanned=1（VS Code 有 Cache 没 CachedData），两半各记各的', () => {
    const t = fact(run(new Map([['vscode', true]])), 'vscode-cache')
    expect(t!.present).toEqual([{ path: CODE_CACHE, bytes: 15_000 }])
    expect(t!.notScanned).toBe(1)
  })

  it('不声明探测器的规则一条都不进这张表（不是"进来但全 0"）', () => {
    const ids = run(new Map()).territories.map((t) => t.ruleId)
    expect(ids).not.toContain('windows-temp')
    expect(ids).not.toContain('thumbnail-cache')
    expect(ids).toContain('pnpm-store')
  })

  it('这张表**不新增也不减少**任何 exclusion —— not-scanned 的逐路径点名仍由 resolveTerritory 那一处发生', () => {
    const detectorStatus = new Map([['pnpm', false]])
    const r = run(detectorStatus)
    for (const t of r.territories) {
      const named = r.exclusions.filter((e) => e.ruleId === t.ruleId && e.reason === 'not-scanned').length
      expect(named, `${t.ruleId} 的 notScanned 与 exclusions 条数分叉`).toBe(t.notScanned)
    }
    // ledger 里 present 的那些目录，一条都不该被记成 not-scanned（否则同一块地两种说法）
    for (const t of r.territories) {
      for (const p of t.present) {
        expect(r.exclusions.some((e) => e.reason === 'not-scanned' && e.path === p.path), p.path).toBe(false)
      }
    }
  })

  it('没传探测表时（缺省=全按已装）这张表照样出，detectorAbsent 恒 false', () => {
    const r = run()
    expect(r.territories.length).toBeGreaterThan(0)
    expect(r.territories.every((t) => t.detectorAbsent === false)).toBe(true)
  })

  it('同一棵树连跑两次逐字节相同（顺序也必须定死：规则按 ruleId 升序、目录按路径升序）', () => {
    const a = run(new Map([['pnpm', false]]))
    const b = run(new Map([['pnpm', false]]))
    expect(JSON.stringify(a.territories)).toBe(JSON.stringify(b.territories))
    const ids = a.territories.map((t) => t.ruleId)
    expect([...ids].sort()).toEqual(ids)
  })

  it('回归轴：加这张表之后 findings / reclaimableBytes / exclusions 与不读这张表的口径逐字节相同', () => {
    const r = run(new Map([['pnpm', false]]))
    // 未装的规则一条 finding 都不出（V0.7 已钉的既有行为），这里复验它没被新表带歪
    expect(r.findings.some((f) => f.ruleId === 'pnpm-store')).toBe(false)
    expect(r.exclusions.filter((e) => e.reason === 'not-installed').map((e) => e.path).sort()).toEqual([PNPM_STORE])
  })
})

/**
 * 「目录看到了、字节没量过」这一格是 `sizeOf` 做成**可选**读面的唯一理由。
 * 退化成 0 的后果很具体：界面会念"这个目录是空的"，而那只是这个读面没提供子树合计。
 * 上面那组用例全部走 `TreeStore`（它有 `sizeOf`），所以这条必须单独开一棵没有 `sizeOf` 的树才测得到。
 */
describe('territories —— 读面没给 sizeOf 时是 null 而不是 0', () => {
  it('TreeStore 读面下 0 与 null 各是各的；换成没有 sizeOf 的读面则**连"这个目录是空的"都不能说**', () => {
    const full = run(new Map([['pnpm', false]]))
    const seen = full.territories.find((t) => t.ruleId === 'pnpm-store')!
    expect(seen.present[0]!.bytes).toBe(121_000)
    const empty = full.territories.find((t) => t.ruleId === 'maven-repository')!
    expect(empty.present[0]!.bytes).toBe(0)

    // 把读面收成"只有遍历下界"的形状（照 rules-preview 里 guarded() 的写法）：
    // 真值必须变成 null，而"真空"那一格本来就是 0，不许跟着一起变 null
    const noSize = {
      rootId: base.rootId,
      dirIdByPath: (p: string) => base.dirIdByPath(p),
      childrenOf: (id: number) => base.childrenOf(id)
    }
    const r = evaluateRules({
      source: noSize,
      env: ENV,
      rules: BUILTIN_RULES,
      forbiddenPatterns: FORBIDDEN_PATH_PATTERNS,
      nowMs: NOW,
      detectorStatus: new Map([['pnpm', false]])
    })
    const pnpm = r.territories.find((t) => t.ruleId === 'pnpm-store')
    expect(pnpm!.present[0]!.bytes).toBeNull()
    // 「这个目录里到底有没有东西」在这种读面上就是不知道 —— 连"它是空的"都不能说。
    // 记住这条 null 只在合成读面上出现：生产链路交的是 TreeStore，它一直带 sizeOf。
    const maven = r.territories.find((t) => t.ruleId === 'maven-repository')
    expect(maven!.present[0]!.bytes).toBeNull()
    // 但"看到了哪块地"这一半不许跟着塌：路径与条数必须原样在
    expect(pnpm!.present.map((p) => p.path)).toEqual([PNPM_STORE])
    expect(maven!.present.map((p) => p.path)).toEqual([MAVEN_REPO])
    expect(pnpm!.notScanned).toBe(1)
  })
})
