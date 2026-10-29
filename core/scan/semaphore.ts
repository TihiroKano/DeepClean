/**
 * 计数信号量：把同时 in-flight 的文件 I/O 卡在 n 以内。
 * §6 的两条强制要求——异步并发 + 并发受限——由它和 walk 一起满足。
 */
export class Semaphore {
  private avail: number
  private readonly waiters: Array<() => void> = []
  private _peak = 0
  private _live = 0

  constructor(n: number) {
    this.avail = Math.max(1, n)
  }

  /** resolve 出释放函数；重复调用释放函数无害（done 守卫）。 */
  async acquire(): Promise<() => void> {
    if (this.avail > 0) {
      this.avail--
      this._live++
      this._peak = Math.max(this._peak, this._live)
      let done = false
      return () => {
        if (done) return
        done = true
        this._live--
        this.avail++
        this.waiters.shift()?.()
      }
    }
    await new Promise<void>((res) => this.waiters.push(res))
    return this.acquire()
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /** 历史峰值并发，用来在测试里证明「确实并发了但没超上限」。 */
  peak(): number {
    return this._peak
  }

  live(): number {
    return this._live
  }
}
