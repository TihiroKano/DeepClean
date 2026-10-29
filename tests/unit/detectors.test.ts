/**
 * V0.7 Task 3 Step 1–3 —— 「工具装没装」的探测器层（`core/rules/detectors.ts`）。
 *
 * 这一层存在的理由：`core/rules/registry.ts` 那 15 条规则全是静态路径模板，没装 Gradle 的机器
 * 上 `gradle-cache` 照样进评估流程 —— 报出来的是「这机器上有 8 GB Gradle 缓存」，而真相是没装。
 *
 * 本文件三条硬轴：
 * 1. **只报告**：探测器不许携带任何删除/执行能力，也不许携带勾选策略（那是 Step 5 的事）。
 * 2. **判据只有两级**：命令可用性 + 已知目录存在性，两级都是问注入的 `probe`，
 *    本层看不见真机、看不见注册表（裁定 2），单测里更不许去问真机（E 条 5）。
 * 3. **两级是"或"**：任一级命中就算已装。方向性选择 —— 误判"未装"会把真容量静默藏起来，
 *    比多报一条缓存坏得多（同一个理由见引擎里"探测表缺 id 按已装处理"那条裁定）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEV_ENV_DETECTORS,
  collectInstallStatus,
  detectorForRule,
  type DetectorProbe,
  type IDevEnvDetector
} from '../../core/rules/detectors'
import { BUILTIN_RULES, RULE_ENV_KEYS } from '../../core/rules/registry'

/** §16 🟡 / §21 那批「依赖某个工具才存在」的规则 —— 探测器必须逐个覆盖。 */
const TOOL_DEPENDENT_RULE_IDS = [
  'maven-repository',
  'pnpm-store',
  'yarn-cache',
  'huggingface-cache',
  'android-sdk-temp',
  'npm-cache',
  'pip-cache',
  'gradle-cache',
  'vscode-cache'
]

/** 假探针：只记账不查真机。calls 用来反证探测器没问出第三种问题。 */
function fakeProbe(o: { commands?: readonly string[]; dirs?: readonly string[] } = {}) {
  const gotCommands = new Set(o.commands ?? [])
  const gotDirs = new Set((o.dirs ?? []).map((d) => d.toLowerCase()))
  const calls: Array<{ kind: 'command' | 'dir'; arg: string }> = []
  const probe: DetectorProbe = {
    commandAvailable(command) {
      calls.push({ kind: 'command', arg: command })
      return gotCommands.has(command)
    },
    pathExists(pathTemplate) {
      calls.push({ kind: 'dir', arg: pathTemplate })
      return gotDirs.has(pathTemplate.toLowerCase())
    }
  }
  return { probe, calls }
}

const byId = (id: string): IDevEnvDetector => {
  const d = DEV_ENV_DETECTORS.find((x) => x.id === id)
  if (d === undefined) throw new Error(`探测器表里没有 id=${id}`)
  return d
}

describe('DEV_ENV_DETECTORS —— 覆盖面与形状（只报告，不带删除能力）', () => {
  it('九条工具依赖型规则逐条被把关，缺一个都不行（少一个就还是"没装也照样报缓存"）', () => {
    const covered = new Set(DEV_ENV_DETECTORS.flatMap((d) => d.ruleIds))
    for (const ruleId of TOOL_DEPENDENT_RULE_IDS) {
      expect(covered, `规则 ${ruleId} 没有探测器把关`).toContain(ruleId)
    }
  })

  it('ruleIds 里必须是注册表真存在的 id —— 拼错的把关关系等于没把关，而且静默', () => {
    const known = new Set(BUILTIN_RULES.map((r) => r.id))
    for (const d of DEV_ENV_DETECTORS) {
      expect(d.ruleIds.length, `探测器 ${d.id} 一条规则都没把关，它是谁？`).toBeGreaterThan(0)
      for (const ruleId of d.ruleIds) expect(known, `${d.id} 把关了不存在的规则 ${ruleId}`).toContain(ruleId)
    }
  })

  it('一条规则只许一个探测器把关（两级判据不能长成两套真相）', () => {
    const seen = new Map<string, string>()
    for (const d of DEV_ENV_DETECTORS) {
      for (const ruleId of d.ruleIds) {
        expect(seen.has(ruleId), `规则 ${ruleId} 同时被 ${seen.get(ruleId)} 和 ${d.id} 把关`).toBe(false)
        seen.set(ruleId, d.id)
      }
    }
  })

  it('探测器只有数据 + 一个 isInstalled：结构上进不了删除这条路', () => {
    const allowed = ['id', 'displayName', 'ruleIds', 'commands', 'knownDirs', 'isInstalled'].sort()
    for (const d of DEV_ENV_DETECTORS) {
      expect(Object.keys(d).sort(), `${d.id} 的键不在白名单里`).toEqual(allowed)
      const fns = Object.keys(d).filter((k) => typeof (d as unknown as Record<string, unknown>)[k] === 'function')
      expect(fns, `${d.id} 多带了函数（识别归识别，删除归删除）`).toEqual(['isInstalled'])
    }
  })

  it('探测表里没有勾选策略：Step 5 的 AI 模型结构性豁免不住在这一层', () => {
    const banned = /select|checked|default|exclude|delete|remove|clean|prune|confirm/i
    for (const d of DEV_ENV_DETECTORS) {
      for (const key of Object.keys(d)) expect(banned.test(key), `${d.id} 带了策略字段 ${key}`).toBe(false)
    }
    expect(detectorForRule('huggingface-cache')?.id).toBe('huggingface')
  })

  it('knownDirs 一律是 %VAR% 模板且变量在 RULE_ENV_KEYS 里，commands 一律是裸命令名', () => {
    for (const d of DEV_ENV_DETECTORS) {
      expect(d.commands.length + d.knownDirs.length, `${d.id} 两级判据都是空的，它凭什么说未安装？`).toBeGreaterThan(0)
      for (const dir of d.knownDirs) {
        const m = /^%([A-Za-z0-9_]+%)$/.exec(dir.split('\\')[0] ?? '')
        expect(m, `${d.id} 的地盘提示 ${dir} 没以 %VAR% 开头（写死绝对路径就是把开发机用户名带进判据）`).not.toBeNull()
        expect(
          RULE_ENV_KEYS,
          `${d.id} 用了未登记的变量 ${dir}：探针永远拿不到路径 → 会被静默判成未安装、把真容量藏起来`
        ).toContain((m as RegExpExecArray)[1]!.slice(0, -1))
      }
      for (const cmd of d.commands) {
        expect(cmd, `${d.id} 的命令名 ${cmd} 不能带路径或扩展名（命令可用性只认名字）`).not.toMatch(/[\\/]|\.exe$/i)
        expect(cmd.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('isInstalled —— 两级判据（命令可用性 + 已知目录存在性）', () => {
  it('命令命中即算已装，哪怕目录一个都不在', () => {
    const d = byId('gradle')
    const { probe, calls } = fakeProbe({ commands: d.commands })
    expect(d.isInstalled(probe)).toBe(true)
    expect(calls.some((c) => c.kind === 'command')).toBe(true)
  })

  it('命令不在 PATH 但地盘目录在 → 仍然算已装（工具跑过没进 PATH 是真事：IDE 内置 gradle wrapper）', () => {
    const d = byId('gradle')
    const { probe } = fakeProbe({ dirs: [d.knownDirs[0]!] })
    expect(d.isInstalled(probe)).toBe(true)
  })

  it('命令与目录双双落空 → 未安装', () => {
    for (const d of DEV_ENV_DETECTORS) {
      expect(d.isInstalled(fakeProbe().probe), `${d.id} 在什么都不存在的机器上必须报未安装`).toBe(false)
    }
  })

  it('每个探测器只问命令与目录这两件事，没问出第三种', () => {
    for (const d of DEV_ENV_DETECTORS) {
      const { probe, calls } = fakeProbe()
      d.isInstalled(probe)
      expect(
        calls.every((c) => c.kind === 'command' || c.kind === 'dir'),
        `${d.id} 问了第三种问题`
      ).toBe(true)
      const asked = new Set(calls.map((c) => c.arg))
      for (const c of d.commands) expect(asked, `${d.id} 没问命令 ${c}`).toContain(c)
      for (const dir of d.knownDirs) expect(asked, `${d.id} 没问目录 ${dir}`).toContain(dir)
    }
  })

  it('判据不看机器上真实有什么：同一份表换两个假探针得到两个相反结论', () => {
    const d = byId('npm')
    const absent = d.isInstalled(fakeProbe().probe)
    const present = d.isInstalled(fakeProbe({ commands: ['npm'] }).probe)
    expect(absent).toBe(false)
    expect(present).toBe(true)
  })
})

describe('collectInstallStatus —— 喂给引擎那张表', () => {
  it('键是探测器 id（= Rule.requiresDetector 填的值），值逐条落结论', () => {
    const installed = new Set(['npm', 'pip'])
    const status = collectInstallStatus({
      commandAvailable: (c) => installed.has(c),
      pathExists: () => false
    })
    expect([...status.keys()].sort()).toEqual(DEV_ENV_DETECTORS.map((d) => d.id).sort())
    expect(status.get('npm')).toBe(true)
    expect(status.get('gradle')).toBe(false)
  })

  it('表里不许出现没有对应探测器的键（引擎按"缺 id 当已装"兜底，多写一个假 id 就永远兜不到）', () => {
    const status = collectInstallStatus(fakeProbe().probe)
    for (const key of status.keys()) expect(byId(key).id).toBe(key)
  })

  it('detectorForRule 按规则 id 反查把关它的探测器', () => {
    expect(detectorForRule('gradle-cache')?.id).toBe('gradle')
    expect(detectorForRule('vscode-cache')?.id).toBe('vscode')
    expect(detectorForRule('windows-temp')).toBeUndefined()
  })
})
