/**
 * §3.6 开发环境页的**视图判据**（纯函数层，本棒只做这一层）。
 *
 * 为什么这张"哪一行给哪些动作"的表要住在 `core/rules/`：计划书 §3.6 的三条硬要求
 * （AI 模型行不给清理按钮、Docker 行不给任何能触发删除的控件、未安装显示「未检测到」而不是 0 B）
 * 如果写成 `DevEnv.tsx` 里的 if，就变成"渲染层的自我约束" —— 下一次改界面的人看不见它，
 * 一行代码就能破。放在这里，界面只是把服务端算好的 `actions` 照着画。
 *
 * 第二条用例（每条 dev-cache 规则都必须在分组表里）是这个文件存在的主要理由：
 * 新增一条规则而忘了归组，默认行为必须是**测试红**，不能是"那一行不出现"——
 * 漏一行和少一个生态在页面上长得一模一样，没人会去数内置表有几条。
 */
import { describe, expect, it } from 'vitest'
import { buildDevEnvView, DEV_ENV_GROUP_LABELS } from '../../core/rules/devenv-view'
import { BUILTIN_RULES } from '../../core/rules/registry'

const devCacheRules = BUILTIN_RULES.filter((r) => r.category === 'dev-cache')

describe('§3.6 分组表覆盖内置规则，漏一条就红', () => {
  it('每条 dev-cache 规则都被归进某个生态，一条都没被静默丢掉', () => {
    const view = buildDevEnvView({ rules: devCacheRules, installStatus: new Map(), docker: null })
    const listed = view.groups.flatMap((g) => g.rows.map((r) => r.ruleId))
    // 表里会比内置规则多出一行 —— Docker 那行是**合成**的（它不在内置规则表里，V0.4 否掉了
    // 拿 FS 通配估它的字节），所以覆盖性判据要比的是"去掉合成行之后不多不少"。
    const ruleRows = listed.filter((id) => id !== 'docker')
    expect(listed).toContain('docker')
    for (const rule of devCacheRules) expect(ruleRows).toContain(rule.id)
    expect(ruleRows.length).toBe(devCacheRules.length)
  })

  it('分组 id 与标题一一对应，且顺序稳定（同一份输入跑两次逐字节相同）', () => {
    const a = buildDevEnvView({ rules: devCacheRules, installStatus: new Map(), docker: null })
    const b = buildDevEnvView({ rules: [...devCacheRules].reverse(), installStatus: new Map(), docker: null })
    expect(a.groups.map((g) => g.id)).toEqual(b.groups.map((g) => g.id))
    for (const g of a.groups) expect(DEV_ENV_GROUP_LABELS[g.id]).toBeTruthy()
  })
})

describe('§3.6 动作栏：结构性限制由数据决定，不由界面决定', () => {
  const view = buildDevEnvView({
    rules: devCacheRules,
    installStatus: new Map<string, boolean>([
      ['huggingface', true],
      ['npm', true],
      ['gradle', true],
      ['pnpm', false]
    ]),
    docker: null
  })
  const row = (ruleId: string) => view.groups.flatMap((g) => g.rows).find((r) => r.ruleId === ruleId)!

  it('AI 模型行拿不到「全选」这类动作，但**手动勾选这一行**这条路还在', () => {
    const hf = row('huggingface-cache')
    expect(hf.actions).not.toContain('group-select-all')
    expect(hf.actions).toContain('toggle-include')
    expect(hf.actions).toContain('go-large-files')
    expect(hf.excludedFromDefaultSelection).toBe(true)
  })

  it('已装且没被豁免的行照旧有整组全选 —— 不许为了摘 AI 那条把整个动作面收窄', () => {
    expect(row('npm-cache').actions).toContain('group-select-all')
    expect(row('gradle-cache').actions).toContain('group-select-all')
  })

  /**
   * 这一条是看图看出来的缺陷：第一版只按 `excludedFromDefaultSelection` 一个轴发动作，
   * 于是未装的行一边念「未检测到」、一边挂着「全选本组」与「勾上这一项」——
   * 那一行永远进不了工作单（引擎早把它摘成 0 finding），按钮是死的。
   */
  it('未检测到的行一个勾选动作都不给（只留「详情」），没探测过的也一样', () => {
    const absent = row('pnpm-store')
    expect(absent.installState).toBe('not-installed')
    expect(absent.actions).toEqual(['detail'])
    const unknown = row('pip-cache')
    expect(unknown.installState).toBe('unknown')
    expect(unknown.actions).toEqual(['detail'])
  })

  it('Docker 那一行没有任何能触发删除的控件，只给「查看」与那句 prune 说明', () => {
    const dockerRow = view.groups.flatMap((g) => g.rows).find((r) => r.ruleId === 'docker')!
    expect(dockerRow.actions).toEqual(['view', 'prune-hint'])
    expect(dockerRow.actions).not.toContain('toggle-include')
    expect(dockerRow.pruneCommand).toBe('docker system prune')
  })

  /**
   * 这三格各说一件事，界面上不许互换。
   * （上一版只测了 `docker: null`，于是 `verdict` 那两条分支完全没有判据看着 —— 一句
   * `docker === 'ok'` 的对象/字符串比错就是这么混过去的。）
   */
  const dockerRow = (docker: Parameters<typeof buildDevEnvView>[0]['docker']) =>
    buildDevEnvView({ rules: devCacheRules, installStatus: new Map(), docker })
      .groups.flatMap((g) => g.rows)
      .find((r) => r.ruleId === 'docker')!

  it('df 量到了 → 装着，且给出那个字节数', () => {
    const r = dockerRow({ verdict: 'measured', reclaimableBytes: 4096, categories: [{ name: 'layers', reclaimableBytes: 4096 }], detail: 'x' })
    expect(r.installState).toBe('installed')
    expect(r.displayBytes).toBe(4096)
  })

  it('df 报"这台机器没有 docker" → 未检测到，字节仍是 null 而不是 0', () => {
    const r = dockerRow({ verdict: 'absent', reclaimableBytes: null, categories: [], detail: 'x' })
    expect(r.installState).toBe('not-installed')
    expect(r.displayBytes).toBeNull()
  })

  it('CLI 报了错 / daemon 没起 → 算装着但「量不到」，两个都不许写成 0 或未检测到', () => {
    const r = dockerRow({ verdict: 'unmeasurable', reclaimableBytes: null, categories: [], detail: 'x' })
    expect(r.installState).toBe('installed')
    expect(r.displayBytes).toBeNull()
  })

  it('压根没查过 → unknown（不许冒充「未检测到」）', () => {
    expect(dockerRow(null).installState).toBe('unknown')
  })
})

describe('§3.6 「未检测到」与「0 B」必须是两句话', () => {
  const mk = (installed: Map<string, boolean>, bytes: number | null) =>
    buildDevEnvView({
      rules: [devCacheRules.find((r) => r.id === 'gradle-cache')!],
      installStatus: installed,
      docker: null,
      bytesByRule: bytes === null ? {} : { 'gradle-cache': { bytes, files: 3 } }
    }).groups[0]!.rows[0]!

  it('探测说没装 → 状态是 not-installed，界面该念「未检测到」而不是 0 B', () => {
    const r = mk(new Map([['gradle', false]]), null)
    expect(r.installState).toBe('not-installed')
    expect(r.displayBytes).toBeNull()
  })

  it('装了、盘上确实 0 字节 → 是 measured 的 0，与上一格不同一种话', () => {
    const r = mk(new Map([['gradle', true]]), 0)
    expect(r.installState).toBe('installed')
    expect(r.displayBytes).toBe(0)
  })

  it('没探测过（探测器缺席 / 表里没这个 id）→ unknown，不许冒充「未检测到」', () => {
    expect(mk(new Map(), null).installState).toBe('unknown')
  })

  it('一条规则声明了探测器但表里查不到 → unknown 而不是 not-installed（与引擎「缺 id 按已装」同一个方向）', () => {
    const r = buildDevEnvView({
      rules: [devCacheRules.find((x) => x.id === 'gradle-cache')!],
      installStatus: new Map([['npm', true]]),
      docker: null
    }).groups[0]!.rows[0]!
    expect(r.installState).toBe('unknown')
  })
})

/**
 * §3.6 未完 #2 与 #4b：视图层把引擎那张地盘底账换成**两句能对上的话**。
 *
 * 两条各挡一种谎：
 * - 未装的工具**盘上真有残留** → 要单独报出"这里还躺着 X"，但**绝不**因此长出删除控件
 *   （`actions` 那一路必须原样不动，这是第 4 条用例的存在理由）。
 * - 装了的规则念 `0 B` → 必须分得开"这块地是空的"与"这次压根没扫到那块地"，
 *   后者那句话还得说得出量的是哪棵树，否则用户以为自己那台机器上没有缓存。
 */
describe('§3.6 地盘底账进视图：残留要报出来、两个 0 要分家', () => {
  const pnpmAbsent = { ruleId: 'pnpm-store', detectorAbsent: true, present: [{ path: 'C:/Machine/AppData/Local/pnpm-store', bytes: 121_000 }], notScanned: 1 }
  const mavenEmpty = { ruleId: 'maven-repository', detectorAbsent: false, present: [{ path: 'C:/Machine/.m2/repository', bytes: 0 }], notScanned: 0 }
  const gradleMissing = { ruleId: 'gradle-cache', detectorAbsent: false, present: [], notScanned: 2 }
  const unmeasured = { ruleId: 'yarn-cache', detectorAbsent: true, present: [{ path: 'C:/Machine/AppData/Local/Yarn/cache', bytes: null }], notScanned: 0 }
  const all = [pnpmAbsent, mavenEmpty, gradleMissing, unmeasured]

  const mk = (over: Partial<Parameters<typeof buildDevEnvView>[0]> = {}) =>
    buildDevEnvView({
      rules: devCacheRules,
      installStatus: new Map([
        ['pnpm', false],
        ['maven', true],
        ['gradle', true],
        ['yarn', false]
      ]),
      docker: null,
      territories: all,
      scannedRoot: 'C:/Machine',
      ...over
    })

  const rowOf = (v: ReturnType<typeof mk>, ruleId: string) => {
    const r = v.groups.flatMap((g) => g.rows).find((x) => x.ruleId === ruleId)
    if (r === undefined) throw new Error(`行 ${ruleId} 没出现`)
    return r
  }

  it('未装 + 盘上看到残留 → 这一行带出字节与点名的目录', () => {
    const r = rowOf(mk(), 'pnpm-store')
    expect(r.residual).toEqual({ bytes: 121_000, paths: ['C:/Machine/AppData/Local/pnpm-store'] })
  })

  it('未装但残留句子的字节"没量过" → 传 null，不许退化成 0（0 会被念成"这里其实没东西"）', () => {
    expect(rowOf(mk(), 'yarn-cache').residual).toEqual({ bytes: null, paths: ['C:/Machine/AppData/Local/Yarn/cache'] })
  })

  it('装了（正常计账）的行没有残留可报 —— residual 恒 null', () => {
    expect(rowOf(mk(), 'maven-repository').residual).toBeNull()
    expect(rowOf(mk(), 'gradle-cache').residual).toBeNull()
  })

  it('探测器**压根没问过**（unknown）而底账写着 detectorAbsent → 也不报残留：没确认过"没装"就没资格说"还躺着"', () => {
    const v = mk({
      installStatus: new Map(),
      territories: [{ ruleId: 'pnpm-store', detectorAbsent: true, present: [{ path: 'C:/Machine/AppData/Local/pnpm-store', bytes: 121_000 }], notScanned: 0 }]
    })
    const r = rowOf(v, 'pnpm-store')
    expect(r.installState).toBe('unknown')
    expect(r.residual).toBeNull()
  })

  it('报残留**不长出任何控件**：actions 与没有残留时逐字相同，且一条勾选项都没有', () => {
    const withResidual = rowOf(mk(), 'pnpm-store')
    const noTerritories = rowOf(mk({ territories: [] }), 'pnpm-store')
    expect(withResidual.actions).toEqual(noTerritories.actions)
    expect(withResidual.actions).not.toContain('toggle-include')
    expect(withResidual.actions).not.toContain('group-select-all')
  })

  it('两个 0 分家：地盘整块不在这棵树上 → territoryMissing=true（"0 B" 那句要换掉）', () => {
    expect(rowOf(mk(), 'gradle-cache').territoryMissing).toBe(true)
    expect(rowOf(mk(), 'maven-repository').territoryMissing).toBe(false)
  })

  it('半截在地上、半截没扫到（present>0 且 notScanned>0）不算"没有它的地盘" —— 否则 pnpm 那行会两头都念', () => {
    const r = rowOf(mk(), 'pnpm-store')
    expect(r.territoryMissing).toBe(false)
    expect(r.residual).not.toBeNull()
  })

  it('没传底账时两边都是保守形状：residual=null、territoryMissing=false（不许凭"没有"就宣称没扫到）', () => {
    const v = mk({ territories: undefined })
    expect(rowOf(v, 'pnpm-store').residual).toBeNull()
    expect(rowOf(v, 'gradle-cache').territoryMissing).toBe(false)
  })

  it('被问到的那棵树原样带在视图上（那句话的落点是「量的是 C:/Machine」）', () => {
    expect(mk().scannedRoot).toBe('C:/Machine')
    expect(mk({ scannedRoot: null }).scannedRoot).toBeNull()
  })

  it('同一份输入跑两次逐字节相同（底账顺序不固定也不许漂）', () => {
    const a = mk({ territories: [...all].reverse() })
    const b = mk({ territories: all })
    expect(JSON.stringify(a.groups)).toBe(JSON.stringify(b.groups))
  })

  it('Docker 那行是合成的，底账里没有它 → residual/territoryMissing 走保守形状，不许崩', () => {
    const docker = rowOf(mk(), 'docker')
    expect(docker.residual).toBeNull()
    expect(docker.territoryMissing).toBe(false)
  })
})
