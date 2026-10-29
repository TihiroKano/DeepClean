import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { readPngSize, offenders, ALLOW_LIST } from '../../scripts/shot-leak-gate.mjs'

describe('验收图不许是整块桌面', () => {
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
