/**
 * Task 16 —— §15 规则的形状（types.ts）。
 * 规则是**声明式数据**，将来会从 JSON/配置文件里读进来，所以形状校验必须是运行时的，
 * 不能只靠 TS 类型（`as Rule` 一 cast 就绕过了）。
 */
import { describe, expect, it } from 'vitest'
import {
  BROAD_LEAF_NAMES,
  CONTAINER_VARS,
  RULE_CATEGORIES,
  RULE_CLEAN_STRATEGIES,
  RULE_FIELDS,
  RULE_OPTIONAL_FIELDS,
  RULE_RISK_LEVELS,
  ruleShapeProblems,
  type Rule
} from '../../core/rules/types'
import { BUILTIN_RULES } from '../../core/rules/registry'

const ok: Rule = {
  id: 'windows-temp',
  name: 'Windows 临时文件',
  category: 'temp',
  description: '用户 %TEMP% 目录里的临时文件，应用重启后通常可再生',
  paths: ['%TEMP%'],
  scanner: { filePatterns: [], olderThanDays: null, recursive: true },
  riskLevel: 'safe',
  cleanStrategy: 'delete-all',
  recoverable: false
}

const bad = (over: Partial<Rule>): string[] => ruleShapeProblems({ ...ok, ...over })

describe('ruleShapeProblems —— §15 九字段逐项把关', () => {
  it('合规规则零问题', () => {
    expect(ruleShapeProblems(ok)).toEqual([])
  })

  it('九字段少任何一个都不行（category/riskLevel/cleanStrategy/recoverable 一个都不能缺）', () => {
    for (const key of [
      'id',
      'name',
      'category',
      'description',
      'paths',
      'scanner',
      'riskLevel',
      'cleanStrategy',
      'recoverable'
    ] as const) {
      const stripped = { ...ok } as Record<string, unknown>
      delete stripped[key]
      expect(ruleShapeProblems(stripped as unknown as Rule).length, `缺 ${key} 必须报错`).toBeGreaterThan(0)
    }
  })

  it('枚举值只能是声明过的那几个（防止将来 JSON 规则里冒出第五种风险等级）', () => {
    // 加 'duplicate' 不是为了让哪条测试变绿：§20 重复文件是一类新的清理建议项（删的是同内容的多余副本，
    // 不是可重下的缓存），套不进现有七个 category。依据是项目书 §20 本身。
    // M5-P1 T1 起闭集是 10 个：尾部追加 'app-transient'、'installer-leftover'（plan §3 签名，
    // 与 Rust `RuleCategory` 同序同串 —— Rust 侧钉在 types.rs 的 rule_categories_list_has_eleven_members）。
    // M5-P2 P2-T4 起是 11 个：再加 'orphan-data'（plan §2.6 第 22 条 `orphan-app-data`）。
    // **为什么不复用 'app-transient'**：那一族的名字承诺"运行期产物、能被产品自己的动作再生"，
    // 而这一条的地盘是被判定"应用已经不在了"之后留下的设置与数据本体 —— 没有任何产品动作能把它
    // 再生成一遍。并进那一族与给它 `recoverable: true` 是同一个方向的撒谎（spec §4.3）。
    expect([...RULE_CATEGORIES].sort()).toEqual(
      [
        'app-transient',
        'browser-cache',
        'dev-cache',
        'duplicate',
        'error-reporting',
        'installer-leftover',
        'orphan-data',
        'recycle-bin',
        'shader-cache',
        'temp',
        'thumbnail-cache'
      ].sort()
    )
    expect(RULE_CATEGORIES.length).toBe(11)
    // 三个新类别必须被运行时形状闸认下（不认 = 上表即被 invalid-shape 静默拒）
    expect(ruleShapeProblems({ ...ok, category: 'app-transient' })).toEqual([])
    expect(ruleShapeProblems({ ...ok, category: 'installer-leftover' })).toEqual([])
    expect(ruleShapeProblems({ ...ok, category: 'orphan-data' })).toEqual([])
    expect([...RULE_RISK_LEVELS].sort()).toEqual(['caution', 'forbidden', 'high', 'safe'].sort())
    expect([...RULE_CLEAN_STRATEGIES].sort()).toEqual(
      ['delete-all', 'delete-older-than', 'empty-folder', 'manual-only'].sort()
    )
    expect(bad({ riskLevel: 'kinda-safe' as Rule['riskLevel'] })).toContain('riskLevel 非法: kinda-safe')
    expect(bad({ category: 'downloads' as Rule['category'] })).toContain('category 非法: downloads')
    expect(bad({ cleanStrategy: 'yolo' as Rule['cleanStrategy'] })).toContain('cleanStrategy 非法: yolo')
  })

  it('recoverable 必须是真布尔（"1"/"yes" 不算）', () => {
    expect(bad({ recoverable: 'yes' as unknown as boolean })).toContain('recoverable 必须是 boolean')
    expect(bad({ recoverable: undefined as unknown as boolean })).toContain('recoverable 必须是 boolean')
  })

  it('paths 必须非空、每条都是字符串、且落在 %VAR% 或盘符绝对路径上', () => {
    expect(bad({ paths: [] })).toContain('paths 不能为空')
    expect(bad({ paths: [''] })).toContain('paths[0] 不能为空')
    expect(bad({ paths: ['Users/Kano/AppData'] })).toContain('paths[0] 必须以 %VAR% 或盘符绝对路径开头')
    expect(bad({ paths: ['%TEMP%'] , scanner: { ...ok.scanner, filePatterns: [null as unknown as string] } })).toContain(
      'scanner.filePatterns 必须是字符串数组'
    )
  })

  it('scanner 的三条判据各自把关：olderThanDays 非负、recursive 是布尔', () => {
    expect(bad({ scanner: { ...ok.scanner, olderThanDays: -1 } })).toContain('scanner.olderThanDays 必须是非负数或 null')
    expect(bad({ scanner: { ...ok.scanner, recursive: 'yes' as unknown as boolean } })).toContain(
      'scanner.recursive 必须是 boolean'
    )
    expect(ruleShapeProblems({ ...ok, scanner: { ...ok.scanner, olderThanDays: null } })).toEqual([])
  })

  it('M5-P1 三个新 scanner 字段：缺省合规；写了就必须是对的形状（serde 侧同判据）', () => {
    // 缺省（不写）= 既有 15 条的逐字节现状，一条新问题都不许多出来
    expect(ruleShapeProblems(ok)).toEqual([])
    // leafDirs / leafFiles：写了就必须是字符串数组 —— 脏值一旦放行，T2 的 basename 匹配会静默不中
    expect(bad({ scanner: { ...ok.scanner, leafDirs: 'Cache' as unknown as string[] } })).toContain(
      'scanner.leafDirs 必须是字符串数组'
    )
    expect(bad({ scanner: { ...ok.scanner, leafFiles: [7] as unknown as string[] } })).toContain(
      'scanner.leafFiles 必须是字符串数组'
    )
    // scopeFence：对象 + allowRoots/denyRoots 两份字符串名单；多余键 = 塞行为，同 Rule 顶层一个方向
    expect(
      bad({
        scanner: {
          ...ok.scanner,
          scopeFence: { allowRoots: ['%LOCALAPPDATA%'], denyRoots: 'x' } as unknown as Rule['scanner']['scopeFence']
        }
      })
    ).toContain('scanner.scopeFence.denyRoots 必须是字符串数组')
    expect(
      bad({
        scanner: {
          ...ok.scanner,
          scopeFence: { allowRoots: ['%LOCALAPPDATA%'], denyRoots: ['%WINDIR%\\*'], extra: true } as unknown as Rule['scanner']['scopeFence']
        }
      }).join('\n')
    ).toContain('非法字段 scanner.scopeFence.extra')
    expect(
      ruleShapeProblems({
        ...ok,
        scanner: { ...ok.scanner, leafDirs: ['Cache'], scopeFence: { allowRoots: ['%LOCALAPPDATA%'], denyRoots: ['%WINDIR%\\*'] } }
      })
    ).toEqual([])
  })

  it('规则里不许出现函数字段（识别归识别，删除归删除：§28 原则一）', () => {
    const withFn = { ...ok, execute: () => 0 } as unknown as Rule
    expect(ruleShapeProblems(withFn).join('\n')).toContain('非法字段 execute')
  })
})

describe('宽容器名单（§28 原则四的数据侧）', () => {
  it('AppData / Local / Roaming / Users / Windows 这类容器不能当清理范围，但 Temp 可以', () => {
    for (const n of ['appdata', 'local', 'roaming', 'users', 'windows', 'programdata', 'program files']) {
      expect([...BROAD_LEAF_NAMES]).toContain(n)
    }
    expect([...BROAD_LEAF_NAMES]).not.toContain('temp')
    expect([...BROAD_LEAF_NAMES]).not.toContain('explorer')
    expect([...BROAD_LEAF_NAMES]).not.toContain('cache')
  })

  it('裸的环境变量容器（%LOCALAPPDATA% / %USERPROFILE% / %WINDIR%）被点名，%TEMP% 不在其列', () => {
    for (const v of ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'WINDIR', 'PROGRAMDATA', 'SYSTEMDRIVE']) {
      expect([...CONTAINER_VARS]).toContain(v)
    }
    expect([...CONTAINER_VARS]).not.toContain('TEMP')
  })
})

/**
 * V0.7 Task 3 —— `requiresDetector`（规则 ↔ 探测器的那根线）。
 *
 * 这组用例钉的是 `ruleShapeProblems` 里那两个循环**各看一份名单**：
 * 「缺字段」只看必填九个，「非法字段」看必填 + 可选两份。把可选字段塞进 `RULE_FIELDS`
 * 会让 15 条内置规则每条都被判「缺字段」；只把它写进 `Rule` 类型而不进可选名单，
 * 会让带它的规则被判 `invalid-shape` → 整条被拒 → 它的地盘从 reclaimableBytes 里**静默消失**。
 * 两种翻车都不报错，只是数字变小 —— 所以这条轴必须有名字点着。
 */
describe('RULE_OPTIONAL_FIELDS —— 可选字段白名单（V0.7 requiresDetector）', () => {
  const withDetector: Rule = { ...ok, requiresDetector: 'gradle' }

  it('带 requiresDetector 的规则不许被判非法字段（那是静默消失的入口）', () => {
    expect(ruleShapeProblems(withDetector)).toEqual([])
  })

  it('没写它的规则照旧合规 —— 可选字段一旦变成必填，15 条内置规则会整体被判 invalid-shape', () => {
    expect(ruleShapeProblems(ok)).toEqual([])
    for (const r of BUILTIN_RULES) {
      expect(ruleShapeProblems(r), `内置规则 ${r.id} 现在被形状闸拒了`).toEqual([])
    }
  })

  it('显式写 undefined 等于没写（TS 的可选在运行时必须同义，否则调用方 spread 一下就报废）', () => {
    expect(ruleShapeProblems({ ...ok, requiresDetector: undefined })).toEqual([])
  })

  it('可选名单与必填名单不相交，且必填仍然是那九个（塞进必填就等于要求每条规则都写它）', () => {
    expect([...RULE_OPTIONAL_FIELDS]).toContain('requiresDetector')
    for (const f of RULE_OPTIONAL_FIELDS) expect(RULE_FIELDS, `${f} 是可选字段，不许进必填名单`).not.toContain(f)
    expect([...RULE_FIELDS].sort()).toEqual(
      ['category', 'cleanStrategy', 'description', 'id', 'name', 'paths', 'recoverable', 'riskLevel', 'scanner'].sort()
    )
  })

  it('拼错的字段名照旧报非法字段（加白名单不等于把闸抬起来）', () => {
    expect(ruleShapeProblems({ ...ok, requiresDetecter: 'gradle' }).join('\n')).toContain('非法字段 requiresDetecter')
    expect(ruleShapeProblems({ ...ok, detector: 'gradle' }).join('\n')).toContain('非法字段 detector')
    expect(ruleShapeProblems({ ...ok, isInstalled: () => true } as unknown as Rule).join('\n')).toContain(
      '非法字段 isInstalled'
    )
  })

  it('九个必填字段少任何一个都不行 —— 即使这条规则写了可选字段', () => {
    for (const key of RULE_FIELDS) {
      const stripped = { ...withDetector } as Record<string, unknown>
      delete stripped[key]
      expect(ruleShapeProblems(stripped as unknown as Rule), `缺 ${key} 必须报错`).toContain(`缺 ${key} 字段`)
    }
  })

  it('requiresDetector 的值必须是非空字符串（写个探测器对象进来就是把行为塞进数据）', () => {
    expect(bad({ requiresDetector: '' })).toContain('requiresDetector 必须是非空字符串')
    expect(bad({ requiresDetector: 7 as unknown as string })).toContain('requiresDetector 必须是非空字符串')
    expect(bad({ requiresDetector: { id: 'gradle' } as unknown as string })).toContain(
      'requiresDetector 必须是非空字符串'
    )
  })
})

/**
 * §3.5 的第二个可选字段走同一道门 —— 它和 `recoverable` 是同一类形状（真布尔才算结论），
 * 因为 `"1"` / `"yes"` 这类假值一旦被接受，"这条不进默认全选"就会随 JSON 写法漂移。
 * 单独开一个 describe 而不是塞进上面那个：守的坑不同（那一条守的是探测器引用）。
 */
describe('excludedFromDefaultSelection —— 可选字段第二例，形状把关与 recoverable 同轴', () => {
  const base = BUILTIN_RULES[0] as unknown as Record<string, unknown>
  const bad = (over: Record<string, unknown>): string[] =>
    ruleShapeProblems({ ...base, id: 'x', requiresDetector: undefined, ...over })

  it('带真布尔的声明不报非法字段（并进必填名单会让 15 条规则集体被判 invalid-shape）', () => {
    expect(ruleShapeProblems({ ...base, excludedFromDefaultSelection: true })).toEqual([])
    expect(ruleShapeProblems({ ...base, excludedFromDefaultSelection: false })).toEqual([])
  })

  it('非真布尔一律拒（"1" / "yes" / 字符串 true 都不算），与 recoverable 同一条判据', () => {
    expect(bad({ excludedFromDefaultSelection: 1 })).toContain('excludedFromDefaultSelection 必须是 boolean')
    expect(bad({ excludedFromDefaultSelection: 'yes' })).toContain('excludedFromDefaultSelection 必须是 boolean')
    expect(bad({ excludedFromDefaultSelection: 'true' })).toContain('excludedFromDefaultSelection 必须是 boolean')
  })

  it('它确实登记在可选名单里，且没有混进必填九个', () => {
    expect(RULE_OPTIONAL_FIELDS).toContain('excludedFromDefaultSelection')
    expect(RULE_FIELDS).not.toContain('excludedFromDefaultSelection')
    for (const f of RULE_OPTIONAL_FIELDS) expect(RULE_FIELDS).not.toContain(f)
  })
})
