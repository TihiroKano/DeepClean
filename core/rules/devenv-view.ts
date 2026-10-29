/**
 * §3.6「开发环境」页的视图判据 —— **纯函数，零 fs、零进程、零 env 读取**（约束 7 同轴）。
 *
 * 这个文件存在的唯一理由：把「哪一行允许出现哪种控件」做成**数据**，而不是渲染层的自觉。
 * 计划书 §3.6 那三条硬要求（AI 模型行不给清理按钮、Docker 行不给任何能触发删除的控件、
 * 未安装要念「未检测到」而不是 0 B）一旦写成 `DevEnv.tsx` 里的 if，就变成了
 * "下一个改界面的人看不见的那条规矩"；放在这里，界面只负责把算好的 `actions` 照画。
 *
 * 三条各自的落点：
 * - `excludedFromDefaultSelection`（§3.5，声明在 registry）→ 这一行拿不到 `group-select-all`。
 * - Docker 不在内置规则表里（V0.4 否掉了拿 FS 通配估 Docker 字节那条路），所以它的行是**合成**的，
 *   动作固定只有 `view` + `prune-hint` —— 结构上写不出删除控件，而不是"UI 少画一个"。
 * - `installState === 'not-installed'` 时 `displayBytes` 恒为 null：0 B 会被读成"这个工具没缓存"，
 *   而事实是"没探测到它装没装"。这两句话在界面上必须是两种话。
 */
import type { Rule } from './types'
import type { DockerDiskUsage } from './detectors'
import type {
  DevEnvGroupId,
  DevEnvRowAction,
  DevEnvRowWire,
  DevEnvGroupWire,
  DevEnvViewWire,
  ModelTallyWire,
  TerritoryFact
} from '../../shared/types'

/**
 * 形状定义住在 `shared/types.ts`（线格式只有一个事实源），这里只沿用名字。
 * `DEV_ENV_GROUP_LABELS` 与分组判据仍然在这一层 —— 那是主进程的结论，不是传输格式。
 */
export type DevEnvRow = DevEnvRowWire
export type DevEnvGroup = DevEnvGroupWire
export type DevEnvView = DevEnvViewWire
export type { DevEnvGroupId, DevEnvRowAction }

export const DEV_ENV_GROUP_LABELS: Record<DevEnvGroupId, string> = {
  node: 'Node / 前端包管理',
  java: 'Java / JVM 构建',
  python: 'Python',
  ide: '编辑器与 IDE',
  android: 'Android SDK',
  ai: 'AI 模型与权重',
  container: '容器'
}

const GROUP_ORDER: readonly DevEnvGroupId[] = ['node', 'java', 'python', 'ide', 'android', 'ai', 'container']

/**
 * ruleId → 生态。**漏一条就是测试红**（`devenv-view.test.ts` 那条覆盖性判据），
 * 因为"页面上少一行"和"这台机器没这个生态"在肉眼看来完全同形，没人会去数内置表有几条。
 */
const GROUP_BY_RULE: Readonly<Record<string, DevEnvGroupId>> = {
  'npm-cache': 'node',
  'pnpm-store': 'node',
  'yarn-cache': 'node',
  'maven-repository': 'java',
  'gradle-cache': 'java',
  'pip-cache': 'python',
  'vscode-cache': 'ide',
  'android-sdk-temp': 'android',
  'huggingface-cache': 'ai'
}

/** 只有这一个分组里的行需要「模型本体归大文件」那条路由（§21 原文：模型文件本体不进清理表）。 */
const LARGE_FILES_ROUTE_GROUPS: readonly DevEnvGroupId[] = ['ai']

/** 只有这一份是输入形状：`bytesByRule` 由调用方从最近一次预估里挑出来（不重新走盘）。 */
export interface DevEnvViewInput {
  rules: readonly Rule[]
  /** 探测器 id → 装没装；缺键 = 没问过（`collectInstallStatus` 的产物） */
  installStatus: ReadonlyMap<string, boolean>
  /** Docker 那次只读查询的三格结论；null = 没查过（界面上念「不知道」，不念「未检测到」） */
  docker: DockerDiskUsage | null
  /** 规则 id → 报告里的占用（来自最近一次预估/报告的 finding），缺键 = 这份报告没覆盖到 */
  bytesByRule?: Readonly<Record<string, { bytes: number; files: number }>>
  /**
   * 扫描途中顺带数出来的模型权重计数（`core/analyze/model-files.ts`）；
   * `null` / 缺省 = 还没扫过。它挂在**分组**上而不是某条规则行上：这一句问的是
   * "这棵树上躺着几个权重"，而不是"这条规则的地盘里躺着几个" —— 把它接到 `huggingface-cache`
   * 那一行，就等于让一行"只管 `.cache\huggingface`"的规则替整棵树报数。
   */
  modelFiles?: ModelTallyWire | null
  /**
   * §3.6 未完 #2 / #4b：引擎那张地盘底账（`RuleReport.territories`，经 `PreviewModel` 原样搬运）。
   * 缺省 = 这份报告没带（没扫过）→ 下面那两句话都不许出现。
   */
  territories?: readonly TerritoryFact[]
  /** 这些占用数字是从哪棵树量到的；null = 还没扫过。 */
  scannedRoot?: string | null
}

/** Docker 行的固定形状。写死在这里，是为了让"这行没有删除控件"成为一句可测的话。 */
const DOCKER_ROW = (docker: DockerDiskUsage | null): DevEnvRow => ({
  ruleId: 'docker',
  name: 'Docker',
  // 'unmeasurable'（CLI 报了错、daemon 没起）算"装着"：那条 df 确实被回答过，只是这次量不到。
  // null（压根没查）才是 unknown —— 三个词各说各的事，界面上不许互换。
  installState: docker === null ? 'unknown' : docker.verdict === 'absent' ? 'not-installed' : 'installed',
  // 只有 'measured' 才给字节：`reclaimableBytes === null` 时这一格必须念「量不到」，
  // 印成 0 B 就是把"没量到"宣布成"省不下任何东西"（V0.6 §2.7 那条同一类错）。
  displayBytes: docker?.verdict === 'measured' ? docker.reclaimableBytes : null,
  displayFiles: null,
  excludedFromDefaultSelection: true,
  // Docker 没有"规则地盘"这个概念（V0.4 否掉了拿 FS 通配估它的字节），所以这两列恒是保守形状
  residual: null,
  territoryMissing: false,
  actions: ['view', 'prune-hint'],
  pruneCommand: 'docker system prune'
})

export function buildDevEnvView(input: DevEnvViewInput): DevEnvView {
  const { rules, installStatus, docker, bytesByRule = {}, modelFiles = null, scannedRoot = null } = input
  const byRule = new Map<string, TerritoryFact>()
  for (const t of input.territories ?? []) if (!byRule.has(t.ruleId)) byRule.set(t.ruleId, t)

  /**
   * 残留那一格。三条都是刻意的：
   * - 只在**探测判未装**时给：装了又在计账的规则，它的占用本来就在"占用"那一列里，
   *   同一笔字节出现两次就是重复上报（本项目最忌的那类）。
   * - 字节只要有一个"没量过"（null）就整体退成 null：把没量到的那部分当 0 加进去，
   *   念出来的是一个偏小的"共 X"，比念"没量过"更像准数。
   * - 它只进 `residual`，**不进 `actions`** —— 报占用与允许勾选是两条独立的列，越界就是加删除能力。
   */
  const residualOf = (rule: Rule, detected: boolean | null): DevEnvRowWire['residual'] => {
    if (detected !== false) return null
    const t = byRule.get(rule.id)
    if (t === undefined || !t.detectorAbsent || t.present.length === 0) return null
    let sum: number | null = 0
    for (const p of t.present) {
      if (p.bytes === null) sum = null
      else if (sum !== null) sum += p.bytes
    }
    return { bytes: sum, paths: t.present.map((p) => p.path) }
  }
  const byGroup = new Map<DevEnvGroupId, DevEnvRow[]>()

  for (const rule of rules) {
    if (rule.category !== 'dev-cache') continue
    const group = GROUP_BY_RULE[rule.id]
    // 故意抛而不是兜到一个"其它"分组：兜住就等于把漏归组变成静默少一行
    if (group === undefined) throw new Error(`§3.6 漏了生态归组：规则「${rule.id}」不在 GROUP_BY_RULE 里`)
    const detected = rule.requiresDetector === undefined ? null : installStatus.get(rule.requiresDetector) ?? null
    const priced = bytesByRule[rule.id]
    const t = byRule.get(rule.id)
    const installState: DevEnvRowWire['installState'] = detected === null ? 'unknown' : detected ? 'installed' : 'not-installed'
    const actions: DevEnvRowAction[] = ['detail']
    /**
     * 「这一行能不能被勾进工作单」跟着**检测结论**走，不跟着规则存不存在走。
     *
     * 这一条是看图看出来的：第一版按 `excludedFromDefaultSelection` 一个轴发动作，于是
     * 未装 / 没探测过的行照样挂着「全选本组」与「勾上这一项」—— 那一行永远进不了工作单
     * （引擎已经把它摘成 0 finding），按钮是死的，而它左边那一格正写着「未检测到」。
     * 一句诚实的话配一个误导的控件，等于把诚实又收回去一半。
     */
    if (installState === 'installed') {
      actions.push('toggle-include')
      if (rule.excludedFromDefaultSelection !== true) actions.push('group-select-all')
    }
    // 「前往大文件」不受 installState 管：那是一条路由，不是删除控件 —— 权重目录可以在
    // CLI 没装的情况下照样躺在盘上（下载完再卸载工具的人就是这么来的）。
    if (LARGE_FILES_ROUTE_GROUPS.includes(group)) actions.push('go-large-files')
    const row: DevEnvRow = {
      ruleId: rule.id,
      name: rule.name,
      // 没声明探测器的规则在这一格上就是"不知道"：少一个探测器不该变成"已装"或"未装"的假结论
      installState,
      // 未安装 / 没探测过都不给字节：那一格上的 0 会被读成"这工具没缓存"，而事实是我们没问过它装没装
      displayBytes: detected === true ? (priced?.bytes ?? null) : null,
      displayFiles: detected === true ? (priced?.files ?? null) : null,
      excludedFromDefaultSelection: rule.excludedFromDefaultSelection === true,
      residual: residualOf(rule, detected),
      /**
       * 「这次没扫到那块地」与「那块地是空的」是两个 0。只有底账真跑过（有这一条规则）
       * 且一条地盘都没看到、还有点名的没覆盖到，才敢说 missing ——
       * 缺底账时一律 false：宁可少说一句，也不凭"没有"就宣称知道。
       */
      territoryMissing: t !== undefined && t.present.length === 0 && t.notScanned > 0,
      actions
    }
    const list = byGroup.get(group)
    if (list === undefined) byGroup.set(group, [row])
    else list.push(row)
  }

  const containerRows = byGroup.get('container') ?? []
  byGroup.set('container', [...containerRows, DOCKER_ROW(docker)])

  const groups = GROUP_ORDER.filter((id) => (byGroup.get(id)?.length ?? 0) > 0).map<DevEnvGroupWire>((id) => {
    const g: DevEnvGroupWire = {
      id,
      label: DEV_ENV_GROUP_LABELS[id],
      // 行内按 ruleId 升序：同一份规则表跑两次必须逐字节相同（可复现性是这一版全程硬要求）
      rows: [...byGroup.get(id)!].sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0))
    }
    /**
     * 模型计数挂在**分组**上，不挂在那条规则行上 —— 那一格问的是"这次扫到的树里躺着多少个权重"，
     * 而 `huggingface-cache` 那条规则的地盘只有 `.cache\huggingface` 一个目录。
     * 把它印在行里那格"占用"旁边，等于宣布"这个目录里有 26 GB"，而数是从整棵树数出来的。
     * 与 `go-large-files` 同一个分组名单（§21：模型本体归大文件模块）。
     */
    if (LARGE_FILES_ROUTE_GROUPS.includes(id)) g.modelFiles = modelFiles ?? null
    return g
  })

  return { groups, declaredRuleCount: rules.filter((r) => r.category === 'dev-cache').length, scannedRoot }
}
