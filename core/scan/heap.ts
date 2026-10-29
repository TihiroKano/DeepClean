/**
 * 定容量 Top-N 最小堆（§14 大文件榜）。
 * 堆顶是「当前 Top-N 里最小的那个」，满了之后新元素只跟堆顶比：
 * 更大才换掉堆顶并下沉，否则直接丢弃 → 内存恒定 O(N)，push O(log N)。
 */
export class MinHeap<T> {
  private readonly a: T[] = []

  constructor(
    private readonly capacity: number,
    private readonly score: (t: T) => number
  ) {}

  get size(): number {
    return this.a.length
  }

  push(item: T): void {
    if (this.capacity <= 0) return
    if (this.a.length < this.capacity) {
      // 先入数组、再对刚放进去的下标上滤：up() 读的是 this.a[i]，顺序反了会读到空洞
      this.a.push(item)
      this.up(this.a.length - 1)
      return
    }
    const worst = this.a[0]!
    if (this.score(item) > this.score(worst)) {
      this.a[0] = item
      this.down(0)
    }
  }

  /** 无序快照（堆序 ≠ 排序），调用方按需再排。 */
  entries(): T[] {
    return this.a.slice()
  }

  private up(i: number): void {
    let c = i
    while (c > 0) {
      const p = (c - 1) >> 1
      if (this.score(this.a[p]!) <= this.score(this.a[c]!)) break
      ;[this.a[p], this.a[c]] = [this.a[c]!, this.a[p]!]
      c = p
    }
  }

  private down(i: number): void {
    let p = i
    for (;;) {
      const l = 2 * p + 1,
        r = l + 1
      let m = p
      if (l < this.a.length && this.score(this.a[l]!) < this.score(this.a[m]!)) m = l
      if (r < this.a.length && this.score(this.a[r]!) < this.score(this.a[m]!)) m = r
      if (m === p) break
      ;[this.a[p], this.a[m]] = [this.a[m]!, this.a[p]!]
      p = m
    }
  }
}
