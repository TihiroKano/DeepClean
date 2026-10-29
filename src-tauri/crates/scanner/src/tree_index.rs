//! 把 `ScanNode` 树折成**带稳定 id 的 arena**，供界面按层取数。
//!
//! **两条口径必须分开，这是本项目付过学费的红线**：
//!  · `children_of` = **计价口径**（清理预估、重复检测、扫描报告都靠它取完整清单）；
//!  · `level_of`   = **视图口径**（"每层只回 N 项"，收窄只发生在这里）。
//! 把收窄做进 `children_of` ⇒ 第 N+1 项之后的文件从清理预估里**静默消失**。有哨兵钉着。
//!
//! id 语义沿用现行前端的约定：**根是 `-1`**（`getChildren(scanId, -1)` 取根层），
//! 其余目录的 id 是它在 arena 里的下标。

use crate::model::{ErrorTally, ScanFile, ScanNode, ScanTree, SkippedItem};
use crate::volume::VolumeInfo;
use serde::Serialize;

/// 根目录的 id。**不许改成 0** —— 前端全篇都在传 `-1`。
pub const ROOT_DIR_ID: i64 = -1;

#[derive(Debug, Clone)]
pub struct DirRecord {
    pub id: i64,
    pub parent: i64,
    pub name: String,
    pub path: String,
    pub size_logical: u64,
    pub size_alloc: u64,
    pub size_counted: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub errors: ErrorTally,
    pub child_dirs: Vec<i64>,
    pub files: Vec<ScanFile>,
    pub files_truncated: bool,
    pub attrs: u32,
    pub creation_ms: i64,
    pub mtime_ms: i64,
}

/// 线格式（与 `shared/types.ts` 的 `ChildView` 逐字段对齐，camelCase）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChildView {
    /// `FsNodeType` 只有三个值：`'file' | 'directory' | 'drive'`
    pub kind: &'static str,
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir_id: Option<i64>,
    /// 本项的体积，口径由所属载荷的 `size_basis` 决定。
    pub size: u64,
    /// 表观（逻辑）大小 —— **SpaceSniffer 显示的就是这一套**：硬链接按名重复计、
    /// 不含压缩收益。它可能大于卷容量，所以只许与同口径的数比。
    pub size_apparent: u64,
    /// 分配大小且硬链接已去重 —— 「占了多少盘」的真值，只许与卷容量比。
    pub size_allocated: u64,
    pub mtime_ms: i64,
    pub file_count: u64,
    pub dir_count: u64,
    /// **有值**（目录也采了 —— 见 `ScanNode.attrs` 的注释）；`null` 才表示"本节点没采"
    pub attrs: Option<u32>,
    pub birthtime_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChildrenPayload {
    pub dir_id: i64,
    pub root_id: i64,
    pub path: String,
    /// 本层体积，口径由 `size_basis` 决定。
    pub size: u64,
    /// 同一层的表观大小（无论 `size_basis` 选哪边都给）。
    pub size_apparent: u64,
    /// 同一层的分配大小（硬链接已去重）。
    pub size_allocated: u64,
    pub children: Vec<ChildView>,
    pub status: String,
    pub root_size: u64,
    pub root_size_apparent: u64,
    pub root_size_allocated: u64,
    /// 收窄**之前**这一层有多少子项 —— 用户有权知道地图省略了多少
    pub total_children: usize,
    pub folded_count: usize,
    /// 没回给渲染端的那部分容量。等式：`Σchildren + folded_bytes == Σchildren_of(dir_id)`
    pub folded_bytes: u64,
    /// 视图排除藏掉了几个直属子项（只有目录能被排除）。M5-E③ 起是真数。
    /// 这是**本层**那一份。
    pub excluded_count: usize,
    /// **本轮累计**那两份（跨层）：横幅靠它，所以任何一层的载荷都带着它 ——
    /// 撤销入口不许随层级消失（TS 侧 `scanner.ts:493-494` 同一分工）。
    /// 由调用方经 `payload` 的 `session_totals` 传进来 —— 做成**必填参数**，
    /// 是因为让壳层"记得在拿到载荷之后再覆盖两格"会静默漏（真机第一次就是这么漏的）。
    pub session_excluded_count: usize,
    pub session_excluded_bytes: u64,
    pub excluded_bytes: u64,
    pub truncated: bool,
    /// 字节数的口径。**这个字段是给界面读标签用的**：不带它，标签就会对着
    /// 占用数字说"表观"（或反过来）。由调用方经 `payload` 的 `basis` 传入。
    pub size_basis: &'static str,
}

/// 字节数的口径。**两套数在 arena 里都存着**，这里只决定这一份载荷用哪套当 `size`。
///
/// · [`SizeBasis::Apparent`] —— 表观（逻辑）大小之和：硬链接按名重复计、不含压缩收益。
///   **SpaceSniffer 显示的就是这一套**，也是前端 `size-basis.tsx` 的缺省值
///   （Electron 侧老行为）。它与 SpaceSniffer 逐格可比，但**可能大于卷容量**。
/// · [`SizeBasis::Allocated`] —— 分配大小且硬链接按 (卷序列号, 文件 ID) 去重。
///   这是「占了多少盘」的真值，**只许与卷容量比** —— 清理预估、容量对账读它。
///
/// 切换口径**不重扫**：两个数在扫描时已经一起算出来了，这里只挑一个当 `size`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SizeBasis {
    /// 缺省：与 SpaceSniffer、与资源管理器「大小」列同一口径
    #[default]
    Apparent,
    Allocated,
}

impl SizeBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            SizeBasis::Apparent => "apparent",
            SizeBasis::Allocated => "allocated",
        }
    }

    /// 解析前端传来的口径。**认不出的一律回缺省**而不是报错 ——
    /// 一个拼错的口径名不该让整页地图打不开，它会退回表观并有标签说明。
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("allocated") => SizeBasis::Allocated,
            _ => SizeBasis::Apparent,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LevelView {
    pub children: Vec<ChildView>,
    /// `children_of` 会回的那一份条数（**含被排除的**）—— 守恒等式的右半边靠它。
    pub total_children: usize,
    pub folded_count: usize,
    pub folded_bytes: u64,
    /// 视图排除藏掉的**直属子项**（只有目录能被排除：文件没有 `dirId`）。
    /// 被排除的容量**点名**进这里，绝不并进任何真块的 `size`（那是「让地图冒充它变大了」）。
    pub excluded_count: usize,
    pub excluded_bytes: u64,
}

#[derive(Debug, Clone)]
pub enum ChildRef<'a> {
    Dir(&'a DirRecord),
    File(&'a ScanFile),
}

impl<'a> ChildRef<'a> {
    /// 这一格对应哪个 `dirId`（能被排除的只有目录）。文件返回一个**不可能存在**的 id，
    /// 于是"文件能不能被排除"这件事不必在调用处再判一次。
    pub fn dir_id(&self) -> i64 {
        match self {
            ChildRef::Dir(d) => d.id,
            ChildRef::File(_) => i64::MIN,
        }
    }

    /// 这一项在本口径下的体积。**排序、收窄、folded 求和都走它** ——
    /// 若只改 `size` 字段而排序仍用分配口径，地图上会出现"格子按 A 排、数字按 B 显示"。
    pub fn size_by(&self, basis: SizeBasis) -> u64 {
        match (self, basis) {
            (ChildRef::Dir(d), SizeBasis::Apparent) => d.size_logical,
            (ChildRef::Dir(d), SizeBasis::Allocated) => d.size_counted,
            (ChildRef::File(f), SizeBasis::Apparent) => f.size,
            (ChildRef::File(f), SizeBasis::Allocated) => f.counted,
        }
    }

    pub fn size(&self) -> u64 {
        self.size_by(SizeBasis::Allocated)
    }
}

pub struct TreeIndex {
    dirs: Vec<DirRecord>,
    pub volume: VolumeInfo,
    pub root_path: String,
    pub skipped: Vec<SkippedItem>,
    pub skipped_overflowed: bool,
    pub elapsed_ms: u64,
    /// 「最大的 N 个文件」的原料，从 `ScanTree` 原样带过来（**无序**，堆序不是排序）。
    /// 它是扫描途中顺带记的那一份，不是这棵树的第二次遍历 —— 查询端因此零走盘。
    pub top: Vec<crate::model::TopHit>,
}

impl TreeIndex {
    pub fn build(tree: &ScanTree) -> Self {
        let mut idx = TreeIndex {
            dirs: Vec::new(),
            top: tree.top.clone(),
            volume: tree.volume.clone(),
            root_path: tree.root.path.clone(),
            skipped: tree.skipped_sample.clone(),
            skipped_overflowed: tree.skipped_sample_overflowed,
            elapsed_ms: tree.elapsed_ms,
        };
        idx.push_node(&tree.root, ROOT_DIR_ID);
        idx
    }

    /// 深度优先建 arena。父节点先入，所以子的下标一定大于父的下标。
    fn push_node(&mut self, node: &ScanNode, parent: i64) -> i64 {
        let id = self.dirs.len() as i64; // 0 = 根
        let id = if id == 0 { ROOT_DIR_ID } else { id };
        self.dirs.push(DirRecord {
            id,
            parent,
            name: node.name.clone(),
            path: node.path.clone(),
            size_logical: node.size_logical,
            size_alloc: node.size_alloc,
            size_counted: node.size_counted,
            file_count: node.file_count,
            dir_count: node.dir_count,
            errors: node.errors,
            child_dirs: Vec::new(),
            files: node.files.clone(),
            files_truncated: node.files_truncated,
            attrs: node.attrs,
            creation_ms: node.creation_ms,
            mtime_ms: node.mtime_ms,
        });
        let ids: Vec<i64> = node.children.iter().map(|c| self.push_node(c, id)).collect();
        self.dirs[Self::slot(id)].child_dirs = ids;
        id
    }

    fn slot(id: i64) -> usize {
        if id == ROOT_DIR_ID {
            0
        } else {
            id as usize
        }
    }

    pub fn dir(&self, id: i64) -> Option<&DirRecord> {
        if id == ROOT_DIR_ID {
            return self.dirs.first();
        }
        let i = id as usize;
        if id < 0 || i >= self.dirs.len() || self.dirs[i].id != id {
            return None;
        }
        Some(&self.dirs[i])
    }

    /// 无序快照。排序、过滤、截断全在消费方（`apply_top_query`），
    /// 与 TS 的 `topRaw()` 同一分工（那边也是 `entries().sort(by size desc)`）。
    pub fn top_files(&self) -> &[crate::model::TopHit] {
        &self.top
    }

    pub fn dirs_len(&self) -> usize {
        self.dirs.len()
    }

    /// 遍历全部目录记录（含根）。**只读** —— 给需要自建索引的消费方用
    /// （M3 的 `RuleSource` 适配器要用它建一张「归一化路径 → id」表）。
    ///
    /// 为什么不直接暴露 `dirs` 切片：arena 的下标与 id 差一位（`slot(ROOT_DIR_ID) == 0`），
    /// 让每个消费方各自处理这个例外 = 迟早有人写错。这里一次封住。
    pub fn iter_dirs(&self) -> impl Iterator<Item = &DirRecord> {
        self.dirs.iter()
    }

    /// **计价口径**：这一层的完整清单（目录 + 直属文件），容量降序。
    /// 任何"每层只回 N 项"的收窄都**不许**落在这里（见模块头红线）。
    pub fn children_of(&self, dir_id: i64) -> Vec<ChildRef<'_>> {
        self.children_of_with(dir_id, SizeBasis::Allocated)
    }

    /// 同一份清单，但按 `basis` 排序。**看地图要的是这个**：若排序仍按分配口径，
    /// 表观口径下最大的那一项可能排在第 cap 位之外被折掉 —— 用户就看不到它。
    pub fn children_of_with(&self, dir_id: i64, basis: SizeBasis) -> Vec<ChildRef<'_>> {
        let Some(d) = self.dir(dir_id) else {
            return Vec::new();
        };
        let mut out: Vec<ChildRef<'_>> = d
            .child_dirs
            .iter()
            .filter_map(|&c| self.dir(c))
            .map(ChildRef::Dir)
            .chain(d.files.iter().map(ChildRef::File))
            .collect();
        out.sort_by(|a, b| b.size_by(basis).cmp(&a.size_by(basis)));
        out
    }

    /// 这一层完整清单的容量之和 —— §19/§17 那一族的"完整口径"。
    pub fn sum_children_of(&self, dir_id: i64) -> u64 {
        self.children_of(dir_id).iter().map(|c| c.size()).sum()
    }

    /// **视图口径**：只回前 `cap` 项，其余折进 `folded_*`；`excluded` 里的那些**从这一层消失**。
    ///
    /// 三条不许越界（与 TS `levelOf` 同一分工）：
    /// 1. **不改任何数字**：`size` / `file_count` / `dir_count` 照旧是完整子树口径 —— 父级容量
    ///    若被扣掉，地图就会与计数器、与三轴对账同时分叉；
    /// 2. **不碰 `children_of`**：那是计价路径（规则引擎 / 重复检测 / 报告都读它），漏进去就是
    ///    「把目录从地图上藏起来、清理预估照旧删它的文件」这种**隐藏式误删**；
    /// 3. **不是「扫描时跳过」**：那要重扫、会改计数、还会动跳过账。
    ///
    /// 守恒等式（有测试钉着）：
    ///   `children.len() + folded_count + excluded_count == total_children`
    ///   `Σchildren + folded_bytes + excluded_bytes == sum_children_of(dir_id)`
    pub fn level_of(&self, dir_id: i64, cap: usize, excluded: &std::collections::BTreeSet<i64>) -> LevelView {
        self.level_of_with(dir_id, cap, excluded, SizeBasis::Allocated)
    }

    /// 带口径的 `level_of`。**排序、`size`、`folded_bytes`、`excluded_bytes` 全用同一个 `basis`**
    /// —— 混用会让守恒等式（`Σchildren + folded_bytes + excluded_bytes == 本层总和`）
    /// 当场不成立，而那种不成立只在两个口径差得多的机器上才看得见。
    pub fn level_of_with(
        &self,
        dir_id: i64,
        cap: usize,
        excluded: &std::collections::BTreeSet<i64>,
        basis: SizeBasis,
    ) -> LevelView {
        // 文件子项的 `path` 在这里现拼：arena 里的 `ScanFile` 只存名字（给每个文件背一份父路径，
        // 正是 M2-A 折 arena 时要省掉的那份开销）。
        // 这里以前交的是空串 ⇒ 地图上文件的「打开 / 打开所在位置 / 复制路径 / 加入清理列表」
        // 全拿到 `""`，而 §12 的归属反查收到 `[""]` 什么也查不到（2026-10-12 真机抓出来的，
        // 单测与对账全绿了 20 多个里程碑，因为没人拿真文件点过一次那四颗按钮）。
        let parent = self.dir(dir_id).map(|d| d.path.clone()).unwrap_or_default();
        let full = self.children_of_with(dir_id, basis);
        let total = full.len();
        // 先按"没被排除"的那一份算 cap：被排除的项**不占**名额（否则排掉几个就少看几个）。
        let kept: Vec<&ChildRef<'_>> = full.iter().filter(|c| !excluded.contains(&c.dir_id())).collect();
        let excluded_count = total - kept.len();
        let excluded_bytes: u64 =
            full.iter().filter(|c| excluded.contains(&c.dir_id())).map(|c| c.size_by(basis)).sum();
        let take = if cap == 0 { kept.len() } else { cap.min(kept.len()) };

        let mut children = Vec::with_capacity(take);
        let mut folded_bytes = 0u64;
        for (i, c) in kept.iter().enumerate() {
            if i < take {
                children.push(self.to_view(c, &parent, basis));
            } else {
                folded_bytes += c.size_by(basis);
            }
        }
        LevelView {
            children,
            total_children: total,
            excluded_count,
            excluded_bytes,
            // 折进去的只算"留下的那些里超出 cap 的"：被排除的项走 `excluded_*` 那一份账，
            // 用 `total - take` 会把它们重复计一次（守恒等式当场多出一格）。
            folded_count: kept.len() - take,
            folded_bytes,
        }
    }

    /// 父目录 + 文件名 → 全路径。根是 `C:\` 这种带尾分隔符的形式时不能拼出 `C:\\a.bin`
    /// —— 多一个反斜杠会让 §12 的归属反查、禁止根判据与 `revealInExplorer` 全都差一个字符。
    fn join_child(parent: &str, name: &str) -> String {
        if parent.is_empty() {
            return name.to_string();
        }
        format!("{}\\{}", parent.trim_end_matches('\\'), name)
    }

    fn to_view(&self, c: &ChildRef<'_>, parent_path: &str, basis: SizeBasis) -> ChildView {
        match c {
            ChildRef::Dir(d) => ChildView {
                kind: "directory",
                name: d.name.clone(),
                path: d.path.clone(),
                dir_id: Some(d.id),
                size: c.size_by(basis),
                size_apparent: d.size_logical,
                size_allocated: d.size_counted,
                mtime_ms: d.mtime_ms,
                file_count: d.file_count,
                dir_count: d.dir_count,
                attrs: Some(d.attrs),
                birthtime_ms: Some(d.creation_ms),
            },
            ChildRef::File(f) => ChildView {
                kind: "file",
                name: f.name.clone(),
                // 与 `dir_stats` 里那条 `path: format!("{}\\{}", cur.path.trim_end_matches('\\'), f.name)`
                // 同一个拼法（`tree_index.rs:344`）—— 两处两种拼法就是两套真相。
                path: Self::join_child(parent_path, &f.name),
                dir_id: None,
                size: c.size_by(basis),
                size_apparent: f.size,
                size_allocated: f.counted,
                mtime_ms: f.mtime_ms,
                file_count: 1,
                dir_count: 0,
                // 真实属性位（对应 TS `tree-store.ts:125` 的 `attrs: f.attrs`）。
                // 原先这里硬写 `Some(0)`，对带 SYSTEM 的文件是一句谎 ——
                // 而 §28 原则二的判据（`shared/classify` 的 `protectedByAttrs`）正是读它。
                attrs: Some(f.attrs),
                birthtime_ms: Some(f.creation_ms),
            },
        }
    }

    pub fn payload(
        &self,
        dir_id: i64,
        cap: usize,
        status: &str,
        excluded: &std::collections::BTreeSet<i64>,
        session_totals: (usize, u64),
        basis: SizeBasis,
    ) -> Option<ChildrenPayload> {
        let d = self.dir(dir_id)?;
        let root = self.dir(ROOT_DIR_ID)?;
        let lv = self.level_of_with(dir_id, cap, excluded, basis);
        Some(ChildrenPayload {
            dir_id: d.id,
            root_id: ROOT_DIR_ID,
            path: d.path.clone(),
            size: size_of(d, basis),
            size_apparent: d.size_logical,
            size_allocated: d.size_counted,
            children: lv.children,
            status: status.to_string(),
            root_size: size_of(root, basis),
            root_size_apparent: root.size_logical,
            root_size_allocated: root.size_counted,
            total_children: lv.total_children,
            folded_count: lv.folded_count,
            folded_bytes: lv.folded_bytes,
            excluded_count: lv.excluded_count,
            excluded_bytes: lv.excluded_bytes,
            session_excluded_count: session_totals.0,
            session_excluded_bytes: session_totals.1,
            truncated: self.dirs.iter().any(|x| x.files_truncated),
            size_basis: basis.as_str(),
        })
    }
}

/// 目录记录在某一口径下的体积。`DirRecord` 三个数都在，这里只挑一个 ——
/// 挑法与 [`ChildRef::size_by`] 同一条，两处不许各写一份。
fn size_of(d: &DirRecord, basis: SizeBasis) -> u64 {
    match basis {
        SizeBasis::Apparent => d.size_logical,
        SizeBasis::Allocated => d.size_counted,
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirStatHit {
    pub name: String,
    pub path: String,
    pub size: u64,
}

/// §9 选中目录后的那一组数字。**两条口径别混**：
///  · `largest_sub_dir` = **直属**子目录里最大的那个（用户的"下一步该进哪个"）；
///  · `largest_file` = **整个子树**里最大的那个（要点进好几层才找得到，所以带 path）。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirStats {
    pub size: u64,
    pub files: u64,
    pub dirs: u64,
    pub largest_file: Option<DirStatHit>,
    pub largest_sub_dir: Option<DirStatHit>,
    /// true = 节点预算用尽：两个 largest 只覆盖了已访问的部分。**UI 必须把它显示出来。**
    pub partial: bool,
    pub visited: usize,
}

/// `getDirStats` 的节点预算。一次点击要在这条预算内返回，否则大目录上会卡住界面。
pub const DIR_STATS_BUDGET: usize = 200_000;

impl TreeIndex {
    /// §9：最大文件（子树）+ 最大子目录（直属）。`size`/`files`/`dirs` 直接读聚合值，零遍历。
    pub fn dir_stats(&self, dir_id: i64) -> Option<DirStats> {
        let d = self.dir(dir_id)?;

        let largest_sub_dir = d
            .child_dirs
            .iter()
            .filter_map(|&c| self.dir(c))
            .max_by_key(|c| c.size_counted)
            .map(|c| DirStatHit { name: c.name.clone(), path: c.path.clone(), size: c.size_counted });

        // 子树里最大的文件：显式栈 DFS（递归在这里不安全 —— 大目录树可以很深）
        let mut best: Option<DirStatHit> = None;
        let mut visited = 0usize;
        let mut stack = vec![dir_id];
        let mut partial = false;
        while let Some(id) = stack.pop() {
            if visited >= DIR_STATS_BUDGET {
                partial = true;
                break;
            }
            visited += 1;
            let Some(cur) = self.dir(id) else { continue };
            for f in &cur.files {
                if best.as_ref().is_none_or(|b| f.counted > b.size) {
                    best = Some(DirStatHit {
                        name: f.name.clone(),
                        // 文件节点不存路径（M1 按目录聚合），这里拼回完整路径：
                        // `path` 是并列时的定序键，缺了它两条同大的文件就分不出谁是谁
                        path: format!("{}\\{}", cur.path.trim_end_matches('\\'), f.name),
                        size: f.counted,
                    });
                }
            }
            stack.extend(cur.child_dirs.iter().copied());
        }

        Some(DirStats {
            size: d.size_counted,
            files: d.file_count,
            dirs: d.dir_count,
            largest_file: best,
            largest_sub_dir,
            partial,
            visited,
        })
    }
}

#[cfg(test)]
mod tests {
    /// 没有排除集时的那一份（每个用例都要写一遍 `&BTreeSet::new()` 会淹没重点）。
    fn empty() -> std::collections::BTreeSet<i64> {
        std::collections::BTreeSet::new()
    }

    use super::*;
    use crate::model::{Counters, ScanFile, ScanNode, ScanTree};
    use crate::volume::VolumeInfo;

    fn file(name: &str, counted: u64) -> ScanFile {
        ScanFile {
            name: name.into(),
            size: counted,
            alloc: counted,
            counted,
            file_id: 1,
            mtime_ms: 0,
            creation_ms: 0,
            attrs: 0,
        }
    }

    /// 一棵手搭的树：
    ///   root: f_root(10)
    ///     ├ a/ : a1(100) a2(50)
    ///     └ b/ : b1(30)
    fn tree() -> TreeIndex {
        let mut root = ScanNode::dir("C:".into(), r"C:\".into());
        root.files.push(file("f_root", 10));
        root.size_counted = 190;
        root.file_count = 4;
        root.dir_count = 2;

        let mut a = ScanNode::dir("a".into(), r"C:\a".into());
        a.files.push(file("a1", 100));
        a.files.push(file("a2", 50));
        a.size_counted = 150;
        a.file_count = 2;

        let mut b = ScanNode::dir("b".into(), r"C:\b".into());
        b.files.push(file("b1", 30));
        b.size_counted = 30;
        b.file_count = 1;

        root.children = vec![a, b];
        let t = ScanTree {
            top: Vec::new(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 1000, free_bytes: 500 },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            elapsed_ms: 0,
            mode: crate::model::ScanMode::Walk,
            mft: None,
        };
        TreeIndex::build(&t)
    }

    #[test]
    fn root_id_is_minus_one_and_resolves() {
        assert_eq!(ROOT_DIR_ID, -1);
        let idx = tree();
        assert_eq!(idx.dir(ROOT_DIR_ID).unwrap().path, r"C:\");
        assert!(idx.dir(9999).is_none(), "越界 id 必须回 None，不许 panic");
        assert!(idx.dir(-7).is_none());
    }

    #[test]
    fn children_of_is_the_full_accounting_list_sorted_by_size() {
        let idx = tree();
        let names: Vec<String> = idx
            .children_of(ROOT_DIR_ID)
            .iter()
            .map(|c| match c {
                ChildRef::Dir(d) => d.name.clone(),
                ChildRef::File(f) => f.name.clone(),
            })
            .collect();
        assert_eq!(names, vec!["a", "b", "f_root"], "容量降序：150 / 30 / 10");
        assert_eq!(idx.sum_children_of(ROOT_DIR_ID), 190, "与根的合计相等");
    }

    #[test]
    fn level_of_folds_the_tail_and_the_equation_holds() {
        let idx = tree();
        let lv = idx.level_of(ROOT_DIR_ID, 2, &empty());
        assert_eq!(lv.children.len(), 2);
        assert_eq!(lv.total_children, 3);
        assert_eq!(lv.folded_count, 1);
        assert_eq!(lv.folded_bytes, 10, "被折掉的是最小的 f_root");
        let kept: u64 = lv.children.iter().map(|c| c.size).sum();
        assert_eq!(
            kept + lv.folded_bytes,
            idx.sum_children_of(ROOT_DIR_ID),
            "Σchildren + folded_bytes 必须等于完整清单的合计 —— 这条等式就是地图不说谎的凭据"
        );
    }

    /// **红线哨兵**：视图收窄前后，计价口径**一字不变**。
    /// 把收窄做进 `children_of` 会让这条红 —— 那就是"第 N+1 项之后的文件从清理预估里消失"。
    /// §7 视图排除（M5-E③）：被排除的那一份容量**点名**进 `excluded_bytes`，
    /// 既不并进别的格子，也不动计价口径。
    #[test]
    fn an_excluded_dir_moves_its_bytes_into_the_named_bucket_and_nothing_else() {
        let idx = tree();
        let root = idx.dir(ROOT_DIR_ID).unwrap();
        let a_id = root.child_dirs[0];
        let a_bytes = idx.dir(a_id).unwrap().size_counted;
        let mut excluded = std::collections::BTreeSet::new();
        excluded.insert(a_id);

        let full_sum: u64 = idx.children_of(ROOT_DIR_ID).iter().map(|c| c.size()).sum();
        let lv = idx.level_of(ROOT_DIR_ID, 0, &excluded);
        assert_eq!(lv.excluded_count, 1, "排掉一个目录就要点名一个");
        assert_eq!(lv.excluded_bytes, a_bytes, "藏掉的容量要落在 excluded_bytes 上，不是消失");
        assert_eq!(lv.total_children, 3, "总条数是 children_of 那一份，含被排除的");
        assert_eq!(lv.children.len(), 2);
        assert!(!lv.children.iter().any(|c| c.dir_id == Some(a_id)), "被排除的那一格还在图上");
        // 守恒等式的**新**形状：三条加起来才等于计价口径
        let shown: u64 = lv.children.iter().map(|c| c.size).sum();
        assert_eq!(shown + lv.folded_bytes + lv.excluded_bytes, full_sum);
        assert_eq!(lv.children.len() + lv.folded_count + lv.excluded_count, lv.total_children);

        // 红线：视图怎么收窄，计价口径一个字都不动（漏进 `children_of` 就是隐藏式误删）
        assert_eq!(idx.children_of(ROOT_DIR_ID).len(), 3, "计价清单被视图排除了 —— 这条越界");
        assert_eq!(idx.children_of(ROOT_DIR_ID).iter().map(|c| c.size()).sum::<u64>(), full_sum);

        // cap 的名额只算"留下的那些"：排掉最大的一格之后，第一名额给次大的
        let capped = idx.level_of(ROOT_DIR_ID, 1, &excluded);
        assert_eq!(capped.children.len(), 1);
        assert_eq!(capped.folded_count, 1, "被排除的不占 cap 名额，也不进 folded");
        assert_eq!(capped.excluded_count, 1);
    }

    #[test]
    fn narrowing_the_view_does_not_touch_the_accounting_total() {
        let idx = tree();
        let before = idx.sum_children_of(ROOT_DIR_ID);
        for cap in [0usize, 1, 2, 3, 100] {
            let _ = idx.level_of(ROOT_DIR_ID, cap, &empty());
        }
        assert_eq!(idx.sum_children_of(ROOT_DIR_ID), before);
    }

    #[test]
    fn cap_zero_means_no_cap() {
        let idx = tree();
        let lv = idx.level_of(ROOT_DIR_ID, 0, &empty());
        assert_eq!(lv.children.len(), 3);
        assert_eq!(lv.folded_count, 0);
        assert_eq!(lv.folded_bytes, 0);
    }

    #[test]
    fn payload_fills_every_field_the_frontend_reads() {
        let idx = tree();
        let p = idx.payload(ROOT_DIR_ID, 2, "completed", &empty(), (0, 0), SizeBasis::Allocated).unwrap();
        assert_eq!(p.dir_id, ROOT_DIR_ID);
        assert_eq!(p.root_id, ROOT_DIR_ID);
        assert_eq!(p.root_size, 190);
        assert_eq!(p.size, 190);
        assert_eq!(p.status, "completed");
        assert_eq!(p.total_children, 3);
        assert_eq!(p.folded_count, 1);
        assert_eq!(p.folded_bytes, 10);
        assert_eq!(p.excluded_count, 0);
        assert_eq!((p.session_excluded_count, p.session_excluded_bytes), (0, 0));
        // 线格式必须是 camelCase（前端读 dirId / rootSize / totalChildren）
        let j = serde_json::to_string(&p).unwrap();
        for k in ["\"dirId\"", "\"rootId\"", "\"rootSize\"", "\"totalChildren\"", "\"foldedBytes\""] {
            assert!(j.contains(k), "缺字段 {k}：{j}");
        }
        assert!(j.contains("\"kind\":\"directory\""));
    }

    #[test]
    fn a_file_child_carries_no_dir_id() {
        let idx = tree();
        let f = idx
            .children_of(ROOT_DIR_ID)
            .into_iter()
            .find(|c| matches!(c, ChildRef::File(_)))
            .map(|c| idx.to_view(&c, &idx.dir(ROOT_DIR_ID).unwrap().path, SizeBasis::Allocated))
            .unwrap();
        assert_eq!(f.kind, "file");
        assert!(f.dir_id.is_none(), "文件没有可进入的 id");
    }

    /// **文件子项必须带全路径**。这里曾经交的是空串：地图右键的四项
    /// （打开 / 打开所在位置 / 复制路径 / 加入清理列表）对文件全拿到 `""`，
    /// 而 §12 的归属反查收到 `[""]` 什么也查不到 —— 界面不报错，只是"点了没反应"。
    #[test]
    fn a_file_child_carries_a_full_path_under_its_dir() {
        let idx = tree();
        let root_path = idx.dir(ROOT_DIR_ID).unwrap().path.clone();
        let children = idx.level_of(ROOT_DIR_ID, 0, &empty()).children;
        let files: Vec<&ChildView> = children.iter().filter(|c| c.kind == "file").collect();
        assert!(!files.is_empty(), "这棵夹具树一个文件都没有 = 这条判据恒真");
        for f in &files {
            assert!(!f.path.is_empty(), "文件 {name} 的 path 是空的", name = f.name);
            assert_eq!(
                f.path,
                format!("{}\\{}", root_path.trim_end_matches('\\'), f.name),
                "文件路径要拼成 父目录\\名字"
            );
            assert!(!f.path.contains(r"\\"), "拼出了双分隔符：{}", f.path);
        }
        // 目录子项照旧带自己的路径（这条没被这次改动碰过）
        let dirs: Vec<&ChildView> = children.iter().filter(|c| c.kind == "directory").collect();
        assert!(dirs.iter().all(|d| d.path.starts_with(root_path.trim_end_matches('\\'))));

        // 红线哨兵：视图口径怎么改，计价口径的合计一字不许动
        let before = idx.sum_children_of(ROOT_DIR_ID);
        let shown: u64 = idx.level_of(ROOT_DIR_ID, 1, &empty()).children.iter().map(|c| c.size).sum();
        let lv = idx.level_of(ROOT_DIR_ID, 1, &empty());
        assert_eq!(shown + lv.folded_bytes, before, "折叠等式被碰坏了");
    }

    #[test]
    fn every_payload_size_matches_the_dir_record() {
        let idx = tree();
        for id in [ROOT_DIR_ID, 1, 2] {
            let p = idx.payload(id, 1, "completed", &empty(), (0, 0), SizeBasis::Allocated).unwrap();
            assert_eq!(p.size, idx.dir(id).unwrap().size_counted);
        }
    }

    /// 两套口径的夹具：**表观与分配刻意差得很大**（硬链接重复 + 压缩）。
    ///
    /// 用 `tree()` 那种 `logical == counted` 的树测口径切换是假绿 —— 两边相等时
    /// "切了"和"没切"给出同一个数，断言永远成立。这棵树就是为了让下面几条有判别力。
    ///
    /// 结构：root 直属两条硬链接（各 100 表观、第二条分配计 0）+ 子目录 a(500 表观/100 分配)
    /// + 子目录 b(50/50)。
    /// · 表观合计 = 200 + 500 + 50 = 750
    /// · 分配合计 = 100 + 100 + 50 = 250
    fn two_basis_tree() -> TreeIndex {
        let mut f1 = file("dup_link_a", 100);
        f1.size = 100;
        let mut f2 = file("dup_link_b", 0);
        f2.size = 100; // 表观：同一份数据按名再计一次
        f2.alloc = 0;

        let mut root = ScanNode::dir("C:".into(), r"C:\".into());
        root.files.push(f1);
        root.files.push(f2);

        let mut a = ScanNode::dir("a".into(), r"C:\a".into());
        let mut fa = file("a1", 100);
        fa.size = 500; // 压缩：逻辑 500，实际占 100（CompactOS 的真实形状）
        fa.alloc = 100;
        a.files.push(fa);
        a.size_logical = 500;
        a.size_counted = 100;

        let mut b = ScanNode::dir("b".into(), r"C:\b".into());
        b.size_logical = 50;
        b.size_counted = 50;

        root.children = vec![a, b];
        root.size_logical = 750;
        root.size_counted = 250;
        let t = ScanTree {
            top: Vec::new(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 1000, free_bytes: 500 },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            elapsed_ms: 0,
            mode: crate::model::ScanMode::Walk,
            mft: None,
        };
        TreeIndex::build(&t)
    }

    /// 口径切换：`size` 跟着 `size_basis` 走，且两套数**都**原样带着。
    #[test]
    fn size_basis_switches_the_number_and_keeps_both() {
        let idx = two_basis_tree();
        let ap = idx.payload(ROOT_DIR_ID, 0, "completed", &empty(), (0, 0), SizeBasis::Apparent).unwrap();
        let al = idx.payload(ROOT_DIR_ID, 0, "completed", &empty(), (0, 0), SizeBasis::Allocated).unwrap();

        assert_eq!(ap.size_basis, "apparent");
        assert_eq!(al.size_basis, "allocated");
        assert_eq!(ap.size, 750, "表观 = 200(两条硬链接) + 500(a) + 50(b)");
        assert_eq!(al.size, 250, "分配 = 100(去重后) + 100(a) + 50(b)");
        // 切到哪边，另一套数都还在
        assert_eq!(ap.size_allocated, 250);
        assert_eq!(al.size_apparent, 750);
        assert_eq!(ap.root_size, 750);
        assert_eq!(al.root_size, 250);
    }

    /// 两个口径各自守恒：`Σchildren + folded_bytes` 必须等于**本层子项**之和。
    ///
    /// 右边取"这一层子项之和"而不是 `root.size_logical` —— 后者还含根目录自己的直属
    /// 文件，而 `children_of(root)` 只回子目录/文件项，两者本就不该相等（第一版就写错在这）。
    ///
    /// 这条防的是「排序/`size` 用 A 口径、`folded_bytes` 用 B 口径」那种混用。
    #[test]
    fn conservation_holds_in_both_bases() {
        let idx = two_basis_tree();
        for basis in [SizeBasis::Apparent, SizeBasis::Allocated] {
            let total: u64 =
                idx.level_of_with(ROOT_DIR_ID, 0, &empty(), basis).children.iter().map(|c| c.size).sum();
            for cap in [0usize, 1, 2] {
                let lv = idx.level_of_with(ROOT_DIR_ID, cap, &empty(), basis);
                let shown: u64 = lv.children.iter().map(|c| c.size).sum();
                assert_eq!(
                    shown + lv.folded_bytes,
                    total,
                    "cap={cap} basis={basis:?}：折叠等式在这个口径下不成立"
                );
            }
        }
    }

    /// 排序跟着口径走：每个口径下 children 都必须是降序。
    ///
    /// 若排序写死分配口径而 `size` 用表观，表观口径下的最大项可能被 `cap` 折掉。
    #[test]
    fn ordering_follows_the_chosen_basis() {
        let idx = two_basis_tree();
        for basis in [SizeBasis::Apparent, SizeBasis::Allocated] {
            let lv = idx.level_of_with(ROOT_DIR_ID, 0, &empty(), basis);
            let sizes: Vec<u64> = lv.children.iter().map(|c| c.size).collect();
            let mut sorted = sizes.clone();
            sorted.sort_by(|a, b| b.cmp(a));
            assert_eq!(sizes, sorted, "{basis:?} 口径下 children 不是降序：{sizes:?}");
        }
    }

    /// **红线**：计价口径那条 API 不许被口径开关带偏。
    ///
    /// `children_of` / `sum_children_of` 是清理预估与容量对账的输入，必须**永远**是
    /// 分配且去重的口径 —— 用户切到表观看地图，不许顺手让清理预估也跟着变大。
    #[test]
    fn accounting_api_stays_allocated_regardless_of_view_basis() {
        let idx = two_basis_tree();
        assert_eq!(idx.sum_children_of(ROOT_DIR_ID), 250, "计价口径被表观污染了");
        assert_eq!(idx.children_of(ROOT_DIR_ID).iter().map(|c| c.size()).sum::<u64>(), 250);
    }
}

#[cfg(test)]
mod dir_stats_tests {
    use super::*;
    use crate::model::{Counters, ScanFile, ScanNode, ScanTree};
    use crate::volume::VolumeInfo;

    fn f(name: &str, counted: u64) -> ScanFile {
        ScanFile { name: name.into(), size: counted, alloc: counted, counted, file_id: 1, mtime_ms: 0, creation_ms: 0, attrs: 0 }
    }

    fn idx() -> TreeIndex {
        let mut root = ScanNode::dir("C:".into(), r"C:\".into());
        root.files.push(f("small.bin", 5));
        let mut a = ScanNode::dir("a".into(), r"C:\a".into());
        a.files.push(f("big.bin", 900));
        let mut deep = ScanNode::dir("deep".into(), r"C:\a\deep".into());
        deep.files.push(f("huge.bin", 5000));
        a.children = vec![deep];
        a.size_counted = 5900;
        let mut b = ScanNode::dir("b".into(), r"C:\b".into());
        b.files.push(f("mid.bin", 300));
        b.size_counted = 300;
        root.children = vec![a, b];
        root.size_counted = 6205;
        let t = ScanTree {
            top: Vec::new(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 99999, free_bytes: 1 },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            elapsed_ms: 0,
            mode: crate::model::ScanMode::Walk,
            mft: None,
        };
        TreeIndex::build(&t)
    }

    #[test]
    fn largest_sub_dir_is_direct_only_and_largest_file_is_subtree() {
        let s = idx().dir_stats(ROOT_DIR_ID).unwrap();
        assert_eq!(s.size, 6205);
        // 直属最大子目录是 a（5900），不是子树里的 deep
        assert_eq!(s.largest_sub_dir.as_ref().unwrap().name, "a");
        // 最大文件在整个子树里：huge.bin（在 a\deep 下，要点进去才找得到）
        let lf = s.largest_file.as_ref().unwrap();
        assert_eq!(lf.name, "huge.bin");
        assert_eq!(lf.size, 5000);
        assert!(lf.path.ends_with(r"a\deep\huge.bin"), "路径要拼全：{}", lf.path);
        assert!(!s.partial);
    }

    #[test]
    fn empty_dir_reports_none_not_zero() {
        let mut root = ScanNode::dir("e".into(), r"C:\e".into());
        root.size_counted = 0;
        let t = ScanTree {
            top: Vec::new(),
            root,
            counters: Counters::default(),
            volume: VolumeInfo { serial: 1, label: "t".into(), total_bytes: 1, free_bytes: 0 },
            skipped_sample: Vec::new(),
            skipped_sample_overflowed: false,
            elapsed_ms: 0,
            mode: crate::model::ScanMode::Walk,
            mft: None,
        };
        let s = TreeIndex::build(&t).dir_stats(ROOT_DIR_ID).unwrap();
        assert!(s.largest_file.is_none(), "空目录回 null，UI 显示「—」而不是 0 字节");
        assert!(s.largest_sub_dir.is_none());
    }

    #[test]
    fn unknown_dir_is_none() {
        assert!(idx().dir_stats(4242).is_none());
    }
}
