import { describe, expect, it } from 'vitest'
import { Semaphore } from '../../core/scan/semaphore'
import { setTimeout as sleep } from 'node:timers/promises'

describe('Semaphore', () => {
  it('并发从不超过 n（§6 并发数量必须受到限制）', async () => {
    const s = new Semaphore(4)
    let live = 0,
      peak = 0
    await Promise.all(
      Array.from({ length: 50 }, () =>
        s.run(async () => {
          live++
          peak = Math.max(peak, live)
          await sleep(1)
          live--
        })
      )
    )
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })
  it('任务抛错也释放许可', async () => {
    const s = new Semaphore(1)
    await expect(s.run(async () => { throw new Error('x') })).rejects.toThrow('x')
    expect(await s.run(async () => 'ok')).toBe('ok')
  })
})
