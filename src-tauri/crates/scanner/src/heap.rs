//! 扫描途中的「最大的 N 个文件」小顶堆。基准：`core/scan/heap.ts` 的 `MinHeap` +
//! `core/scan/tree-store.ts:398-404` 的推入点。
//!
//! ## 为什么是"途中数"而不是"事后扫"
//!
//! V0.7 就为这件事量过一轮：三十万文件的树里事后挑前 100 名，实测每次查询都要重新走一遍全树，
//! 而地图每 400 ms 轮一次 —— 懒扫那条路是被**实测**否掉的，不是被感觉否掉的。所以这里跟着扫描
//! 顺带维护一个容量 100 的堆，代价是每条文件一次比较，换来查询端零走盘。
//!
//! ## 三条形状，每条都对应一种会骗人的结果
//!
//! 1. **堆序 ≠ 排序**：`entries()` 交的是无序快照，调用方要自己排（`top_raw()` 那边按 size 降序）。
//!    忘了排的那一位会给出"前 100 名但顺序是乱的"，而它在表格里看着完全正常。
//! 2. **只在严格大于时替换**：`score(item) > score(worst)` 才换。写成 `>=` 的话，
//!    一堆同尺寸的文件会互相顶掉，最后留下的是"最后见到的那 100 个"而不是"最大的 100 个"——
//!    两者大小一样，所以**任何按 size 的对账都查不出来**。
//! 3. **`size > 0` 才入堆**（推入点那边判的，不是这里）：0 字节文件进堆会挤掉真候选，
//!    而一个满盘的树里 0 字节文件可以有几万个。

use crate::model::TopHit;

/// 容量固定的小顶堆，比较分就是 `size`（堆顶 = 当前"最不够格"的那一个）。
pub struct TopHeap {
    a: Vec<TopHit>,
    capacity: usize,
}

impl TopHeap {
    pub fn new(capacity: usize) -> Self {
        TopHeap { a: Vec::with_capacity(capacity.min(4096)), capacity }
    }

    pub fn len(&self) -> usize {
        self.a.len()
    }

    /// 这个尺寸**值不值得**为它造一个 `TopHit`（名字要 clone、路径要拼）。
    ///
    /// 堆满之后绝大多数文件都比堆顶小 —— 先问一句再分配，热路径上每条目录项就省下一次
    /// `String` clone 加一次 `Path::join`。TS 那边每个 `size > 0` 的文件都现造一个对象字面量，
    /// 这是本侧唯一一处"为了三十万条不卡"而比基准多做的判据，且**不改变结果**：
    /// `wants(s)` 与"推进去会被丢掉"恰好互补。
    pub fn wants(&self, size: u64) -> bool {
        if self.capacity == 0 {
            return false;
        }
        if self.a.len() < self.capacity {
            return true;
        }
        size > self.a[0].size
    }

    /// 与 TS 的 `capacity <= 0` 同形：容量 0 的堆什么都收不下（不是"无限收"）。
    pub fn push(&mut self, item: TopHit) {
        if self.capacity == 0 {
            return;
        }
        if self.a.len() < self.capacity {
            // 先放进数组、再对**刚放进去的这个下标**上滤：顺序反了会读到空洞
            self.a.push(item);
            self.up(self.a.len() - 1);
            return;
        }
        if item.size > self.a[0].size {
            self.a[0] = item;
            self.down(0);
        }
    }

    /// 无序快照。
    pub fn entries(&self) -> &[TopHit] {
        &self.a
    }

    fn up(&mut self, mut c: usize) {
        while c > 0 {
            let p = (c - 1) >> 1;
            if self.a[p].size <= self.a[c].size {
                break;
            }
            self.a.swap(p, c);
            c = p;
        }
    }

    fn down(&mut self, mut i: usize) {
        let n = self.a.len();
        loop {
            let (l, r) = (i * 2 + 1, i * 2 + 2);
            let mut smallest = i;
            if l < n && self.a[l].size < self.a[smallest].size {
                smallest = l;
            }
            if r < n && self.a[r].size < self.a[smallest].size {
                smallest = r;
            }
            if smallest == i {
                return;
            }
            self.a.swap(i, smallest);
            i = smallest;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(name: &str, size: u64) -> TopHit {
        TopHit { name: name.into(), path: format!(r"D:\t\{name}"), size, mtime_ms: 1 }
    }

    #[test]
    fn keeps_the_largest_n_and_the_heap_property_holds() {
        let mut h = TopHeap::new(3);
        for i in 1..=10u64 {
            h.push(hit(&format!("f{i}.bin"), i * 100));
        }
        assert_eq!(h.len(), 3);
        let mut sizes: Vec<u64> = h.entries().iter().map(|e| e.size).collect();
        sizes.sort_unstable();
        assert_eq!(sizes, vec![800, 900, 1000], "留下的必须是最大的三个");
        // 堆序 ≠ 排序：`entries()` 不许被当成"已排好"
        let raw: Vec<u64> = h.entries().iter().map(|e| e.size).collect();
        assert_eq!(raw[0], *raw.iter().min().unwrap(), "堆顶该是最小的那个");
    }

    #[test]
    fn equal_sizes_do_not_evict_each_other() {
        // 判据是**严格大于**。写成 `>=` 的话这里会留下 c/d/e（"最后见到的三个"），
        // 而按 size 对账两边都是 500 —— 那种错查不出来，所以直接钉顺序。
        let mut h = TopHeap::new(3);
        for n in ["a", "b", "c", "d", "e"] {
            h.push(hit(n, 500));
        }
        let names: Vec<String> = h.entries().iter().map(|e| e.name.clone()).collect();
        assert_eq!(names, vec!["a", "b", "c"], "同尺寸不许互相顶掉");
    }

    #[test]
    fn zero_capacity_holds_nothing() {
        let mut h = TopHeap::new(0);
        h.push(hit("x", 10));
        assert_eq!(h.len(), 0, "容量 0 是「收不下」，不是「无限收」");
    }

    #[test]
    fn a_full_heap_survives_a_long_stream_of_small_items() {
        let mut h = TopHeap::new(2);
        h.push(hit("big1", 9_000));
        h.push(hit("big2", 8_000));
        for i in 0..200 {
            h.push(hit(&format!("small{i}"), i));
        }
        assert_eq!(h.len(), 2);
        assert!(h.entries().iter().all(|e| e.size >= 8_000));
    }
}
