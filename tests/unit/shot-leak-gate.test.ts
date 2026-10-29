import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readPngSize, offenders, ALLOW_LIST, shotsDirExists } from '../../scripts/shot-leak-gate.mjs'

/**
 * 这道闸守的是 `docs/acceptance/` 下的验收截图。
 *
 * ## 2026-10-29：公开仓库里那个目录**不存在**
 *
 * 公开仓只放程序相关的文件（396 个 / 6.9 MB），`docs/acceptance/assets/` 那 93 张
 * 验收截图（97.83 MB）整个没进库。于是 CI 上 `offenders()` 会去 `readdirSync` 一个
 * 不存在的路径 —— 原来直接抛 ENOENT，把整条 `npm test` 判红（CI 第一次跑就栽在这）。
 *
 * **那 4 条红得没道理**：闸要防的是"把整屏桌面截图提交进版本库"，而公开仓里一张图都没有，
 * 它没有可防的对象。
 *
 * 所以四条用例改成 `skipIf(!shotsDirExists())`：**有图的环境里行为逐字不变**
 * （本地全量工作区仍然跑全部 4 条），没图的环境里明写"跳过"。
 *
 * ⚠️ 不许把这 4 条改成"断言更松的版本" —— 它们在本地跑的就是原样那 4 条。
 */
const HAS_SHOTS = shotsDirExists()

describe.skipIf(!HAS_SHOTS)('验收图不许是整块桌面', () => {
  it('PNG 尺寸读得出 IHDR —— 先证明判据不是恒空', () => {
    const s = readPngSize('docs/acceptance/assets/m6-off-3-done.png')
    expect(s.w).toBeGreaterThan(400)
    expect(s.h).toBeGreaterThan(300)
  })

  it('白名单之外的图全部窄于阈值', () => {
    const bad = offenders()
    expect(bad, `这些图宽度过大，只能是整屏：${JSON.stringify(bad)}`).toEqual([])
  })

  it('把阈值压到 100 时闸必须红，且白名单为空所以无一张图被豁免', () => {
    // 白名单必须为空。历史抹除（docs/acceptance/2026-10-17-tauri-history-scrub.md）把那三条
    // 整屏截图连同 66 张 DWM 修图前的图一起从版本库拿掉了；条目留着就是一扇指向日光下已不存在
    // 之物的大门 —— 谁再用同名文件提交一张整屏，这道闸会静默放过。要加项必须在这里写明理由。
    expect(Object.keys(ALLOW_LIST), '白名单应当为空').toEqual([])
    const bad = offenders(100)
    expect(bad.length).toBeGreaterThanOrEqual(3)
    expect(bad.some((x) => x.name.includes('m6-off-3-done'))).toBe(true)
  })

  it('CLI 退出码：干净时 0，阈值压到 100 时非 0', () => {
    const gate = join(process.cwd(), 'scripts', 'shot-leak-gate.mjs')
    expect(execFileSync(process.execPath, [gate], { encoding: 'utf8' })).toContain('SHOT_LEAK_OK')
    let code = 0
    let out = ''
    try {
      out = execFileSync(process.execPath, [gate, '--limit', '100'], { encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      const fail = e as { status?: number; stdout?: string }
      code = fail.status ?? 1
      out = String(fail.stdout ?? '')
    }
    expect(code).toBe(1)
    expect(out.split('\n').filter((l) => l.startsWith('LEAK ')).length).toBeGreaterThanOrEqual(3)
  })
})

/**
 * 没有图的时候仍然要钉两件事 —— 否则这个文件在公开仓里就是一片"全跳过"，
 * 等于把一条闸换成了零条闸。
 */
describe('没有验收图时的行为（公开仓的形状）', () => {
  it('`shotsDirExists()` 与目录实际存在性一致（不是写死的 true/false）', () => {
    const actual = existsSync(join(process.cwd(), 'docs', 'acceptance'))
    expect(shotsDirExists()).toBe(actual)
  })

  it('目录不在时 `offenders()` 回空数组，而不是抛 ENOENT', () => {
    if (HAS_SHOTS) {
      // 本地全量工作区：这条不适用（有图，扫的是真目录）
      expect(Array.isArray(offenders())).toBe(true)
      return
    }
    expect(() => offenders()).not.toThrow()
    expect(offenders()).toEqual([])
  })

  it('目录不在时 CLI 明写 SKIPPED 而不是冒充 OK', () => {
    if (HAS_SHOTS) {
      expect(execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'shot-leak-gate.mjs')], { encoding: 'utf8' })).toContain(
        'SHOT_LEAK_OK'
      )
      return
    }
    const out = execFileSync(process.execPath, [join(process.cwd(), 'scripts', 'shot-leak-gate.mjs')], { encoding: 'utf8' })
    // 「没东西可查」不许印成「查过且干净」—— 那是一个假闸
    expect(out).toContain('SHOT_LEAK_SKIPPED')
    expect(out).not.toContain('SHOT_LEAK_OK')
  })
})
