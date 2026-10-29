/**
 * V0.7 Task 3「接线①」的守卫 —— `core/rules/registry.ts` 写的每个探测器 id 都逐个对照探测器表。
 *
 * 为什么这条测试必须有，而不是"看一眼就知道没拼错"：
 * `engine.ts` 的 `absentDetector()` 兜的是「表里查不到这个 id → 按**已装**评估」（方向写在它自己的注释里：
 * 宁可退回 V0.7 之前的全量误报，也不让一条真有几个 GB 的规则从一个坏掉的引用手里静默消失）。
 * 于是 `requiresDetector: 'huggingFacce'` 这种拼错**不报错、不变红、不减字节** ——
 * 那条规则永远按已装评估，而读代码的人会以为闸已经生效了。
 * 唯一能抓住它的地方就是"拿规则写的 id 去探测器表里点一次名"，所以这张表就是本文件。
 *
 * 三条轴：
 * 1. 正向：九条工具依赖型规则各自写的 id = 期望的那个 id（逐条点名，拼错就红）。
 * 2. 反向：探测器说「我把关这条规则」，规则也必须说「我需要这个探测器」—— 单向声明 = 静默失效。
 * 3. 形状闸：带了可选字段的九条**必须**照常通过 `validateRuleSet`
 *    （`types.ts` 那个坑：可选字段并进必填名单 → 没写的十五条全被拒 → 地盘从合计里静默消失）。
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_RULES, FORBIDDEN_PATH_PATTERNS, RULE_ENV_KEYS } from '../../core/rules/registry'
import { DEV_ENV_DETECTORS, detectorForRule } from '../../core/rules/detectors'
import { validateRuleSet } from '../../core/rules/engine'

/** 唯一一份期望值：规则 id → 探测器 id。改这里必须同时改 registry 与 detectors.ts，两边不一致当场红。 */
const EXPECTED: Readonly<Record<string, string>> = {
  'npm-cache': 'npm',
  'pnpm-store': 'pnpm',
  'yarn-cache': 'yarn',
  'pip-cache': 'pip',
  'maven-repository': 'maven',
  'gradle-cache': 'gradle',
  'huggingface-cache': 'huggingface',
  'android-sdk-temp': 'android-sdk',
  'vscode-cache': 'vscode'
}

/** 不依赖任何工具、因此**不许**挂探测器的那几条。
 * M5-P1 T3a：表尾三条也在这一列 —— 它们判的是 AppData 三根下的**形状**（缓存目录名、轮转日志名、
 * 更新目录名），与"某个工具有没有装"无关；挂上探测器就等于让一条形状规则被一个工具探测结论吃掉地盘。
 * M5-P1 T3b-i：再加两条（`dev-tool-cache` / `crash-dumps`）—— 同一个理由：判的是固定模板与 `*.dmp`
 * 这个扩展名，不是"某个工具有没有装"。`dev-tool-cache` 这个名字里有 dev，类别是 `app-transient`
 * 而**不是** `dev-cache`，正是为了不落到探测器那一支里去。
 * M5-P1 T3b-ii：再加 `user-downloads-installers`（plan §5.6）—— 判的是「下载目录顶层的名字像安装包」，
 * 同样与工具有没有装无关；它挂的是 §3.5 那道默认勾选豁免，不是探测器闸。
 * M5-P2 P2-T4：再加 `orphan-app-data`（plan §2.6）—— 这条**有闸**，但那是机器事实闸
 * （`requiresAbsentAppFact`），方向与 `requiresDetector` **正好相反**：探测器说的是"依赖的工具没装
 * ⇒ 整条规则消失"（`engine.ts` 的 `absentDetector`），而卸载残留要的是"这台机器上查到了安装痕迹、
 * 却没查到本体 ⇒ 这一格才可以提议"。plan §0.3 明写这两个字段不许复用，混用会让一条规则在两种
 * 语义下都能被解释。所以它进的是**不挂探测器**这一侧。 */
const UNGUARDED = [
  'windows-temp',
  'browser-cache',
  'thumbnail-cache',
  'shader-cache',
  'error-reporting',
  'recycle-bin',
  'app-cache-data',
  'app-rotated-logs',
  'installer-artifacts',
  'dev-tool-cache',
  'crash-dumps',
  'user-downloads-installers',
  'orphan-app-data'
]

const DETECTOR_IDS = new Set(DEV_ENV_DETECTORS.map((d) => d.id))
const ruleById = (id: string) => BUILTIN_RULES.find((r) => r.id === id)

/** 把关检查用的合成机器（本文件不碰真机，也不评估任何路径 —— 只问形状与归属）。
 * `PROGRAMFILES` 是 M5-P1 T3a 补的第 8 键：表尾三条容器入口规则的围栏要能点名 `%PROGRAMFILES%\*`，
 * 缺它则那三条被声明层整条拒 —— 下面那条"问题清单为空"就会绿在十五条上（假绿）。 */
const ENV = {
  SYSTEMDRIVE: 'C:\\',
  WINDIR: 'C:\\Windows',
  TEMP: 'C:\\Machine\\AppData\\Local\\Temp',
  LOCALAPPDATA: 'C:\\Machine\\AppData\\Local',
  APPDATA: 'C:\\Machine\\AppData\\Roaming',
  PROGRAMDATA: 'C:\\ProgramData',
  PROGRAMFILES: 'C:\\Program Files',
  USERPROFILE: 'C:\\Machine'
}

describe('requiresDetector 逐个对照探测器表（拼错不会报错，所以只能靠这条）', () => {
  it('九条工具依赖型规则写的探测器 id 逐条等于期望值（红的时候直接点名是哪条、写成了什么）', () => {
    for (const [ruleId, detectorId] of Object.entries(EXPECTED)) {
      const rule = ruleById(ruleId)
      expect(rule, `注册表里根本没有规则 ${ruleId}`).toBeDefined()
      expect(
        rule?.requiresDetector,
        `规则 ${ruleId} 的 requiresDetector 写成了 ${JSON.stringify(rule?.requiresDetector)}，期望 ${JSON.stringify(detectorId)}`
      ).toBe(detectorId)
    }
  })

  it('规则写的每一个 id 都真存在于 DEV_ENV_DETECTORS（新增规则拼错也照样被这条抓住）', () => {
    for (const rule of BUILTIN_RULES) {
      const det = rule.requiresDetector
      if (det === undefined) continue
      expect(
        DETECTOR_IDS.has(det),
        `${rule.id} 引用了探测器表里不存在的 id「${det}」：引擎会按「已装」兜底，于是这条规则的闸永远不生效`
      ).toBe(true)
    }
  })

  it('恰好九条声明了探测器，一条都不许多（未受管辖的规则不许被挂上闸）', () => {
    const declared = BUILTIN_RULES.filter((r) => r.requiresDetector !== undefined).map((r) => r.id).sort()
    expect(declared).toEqual(Object.keys(EXPECTED).sort())
    for (const ruleId of UNGUARDED) {
      expect(ruleById(ruleId)?.requiresDetector, `${ruleId} 不依赖任何工具，却挂了探测器`).toBeUndefined()
    }
  })

  it('双向闭合：探测器的 ruleIds 与规则的 requiresDetector 必须互相指认', () => {
    for (const d of DEV_ENV_DETECTORS) {
      for (const ruleId of d.ruleIds) {
        expect(
          ruleById(ruleId)?.requiresDetector,
          `探测器「${d.id}」以为自己在把关「${ruleId}」，但那条规则没写它 → 闸实际是空的`
        ).toBe(d.id)
      }
    }
    for (const rule of BUILTIN_RULES) {
      if (rule.requiresDetector === undefined) continue
      expect(
        detectorForRule(rule.id)?.id,
        `${rule.id} 写了「${rule.requiresDetector}」，可探测器表里没有任何探测器认领这条规则`
      ).toBe(rule.requiresDetector)
    }
  })

  it('声明探测器把规则从 validateRuleSet 里挤出去了吗？没有 —— 二十三条（九条带闸 + 十四条不带）照常有效，问题清单为空', () => {
    const res = validateRuleSet(BUILTIN_RULES, { env: ENV, forbiddenPatterns: FORBIDDEN_PATH_PATTERNS })
    expect(
      res.problems.map((p) => `${p.ruleId}:${p.reason}:${p.detail}`),
      `带 requiresDetector 的规则被把关拒了 —— 那它的地盘会从 reclaimableBytes 里静默消失`
    ).toEqual([])
    expect(res.valid.length, '二十三条全部上线').toBe(BUILTIN_RULES.length)
    expect(BUILTIN_RULES.length, '表本身是二十三条（探测器那侧九条，不带的那侧十四条）').toBe(23)
    expect(res.valid.map((r) => r.id).sort()).toEqual(BUILTIN_RULES.map((r) => r.id).sort())
  })

  it('探测器 id 的拼写与规则 id 的落点都在登记表声明过的变量族里（这条只管 id，路径真相仍只有 Rule.paths）', () => {
    for (const key of RULE_ENV_KEYS) expect(typeof key).toBe('string')
    for (const d of DEV_ENV_DETECTORS) {
      expect(d.id.length, '空 id 会撞进"没声明探测器"那一支（absentDetector 只认非空串）').toBeGreaterThan(0)
      expect(d.id).not.toMatch(/^\s|\s$/)
    }
  })
})
