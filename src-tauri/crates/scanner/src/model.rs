//! 扫描树的内部模型 + 对外报告类型。
//!
//! **两个口径同时留着**：`size_logical`（表观）与 `size_alloc`/`size_counted`（占用）。
//! 现行 TS 实现只有前者，于是"80G 的盘扫出 90G+"；而 UI 那边"表观 vs 占用"的欠账也一直
//! 挂着，所以两个数都带上，谁也不许只剩一个。

use crate::winerr::ScanErrorKind;
pub use crate::accounting::SkipReason;
use serde::{Deserialize, Serialize};

/// 本棵扫描树由哪一档产出。两档的口径差异（meta 记录、驻留 alloc、ADS、SKIP_ALWAYS）
/// 集中记录在 `mft/mod.rs` 头注「档间已知差异」—— 这个枚举就是那份解释在报告里的落点。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScanMode {
    /// 目录遍历档（Win32 枚举，任何卷任何权限都能跑）
    #[default]
    Walk,
    /// NTFS `$MFT` 直读档（盘符根 + 管理员 + NTFS）
    Mft,
}

/// MFT 档的记账细节。**全部是报数性质的量**：数字大不等于错，但必须被看见 ——
/// 「为什么 MFT 档比 walk 档多出这几个 G」的答案就拆在这些字段里。
/// walk 档没有对应物，`ScanTree.mft` 恒 `None`（报告里恒 0）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct MftStats {
    /// 流里名义上的记录总数（$MFT real size ÷ 记录大小；进度分母）
    pub records_total: u64,
    /// 全零 / 无 `FILE` 魔数 —— 空闲记录，跳过，**不算**损坏
    pub records_free: u64,
    /// 有 `FILE` 魔数但未 in_use —— 已删除文件，其簇已属自由空间，不计字节
    pub records_deleted: u64,
    /// `FILE` 魔数在但 fixup / 解析失败 —— 扇区尾对不上 USN 的真实损坏
    pub records_corrupt: u64,
    /// 记录 0-15（除根 5）收进 `$METADATA` 节点的条数
    pub meta_records: u64,
    /// 从根不可达（父引用失效 / 环）被收进 `$ORPHANS` 的**直接**条数（其子树不算）
    pub orphan_records: u64,
    /// `base_ref` 指向的基记录不存在 —— 扩展记录携带的 $DATA 片段随它丢掉
    pub extension_missed: u64,
    /// 备用数据流条数与分配字节合计。walk 档的目录项里没有 ADS —— 这是档间已知差异
    pub ads_streams: u64,
    pub ads_bytes: u64,
}

/// 七个类目的计数。四桶是展示口径，七个是分类口径 —— 两者都在，别只留一个。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct ErrorTally {
    pub denied: u64,
    pub missing: u64,
    pub busy: u64,
    pub too_many_handles: u64,
    pub not_dir: u64,
    pub cycle: u64,
    pub unknown: u64,
}

impl ErrorTally {
    pub fn bump(&mut self, kind: ScanErrorKind) {
        match kind {
            ScanErrorKind::Denied => self.denied += 1,
            ScanErrorKind::Missing => self.missing += 1,
            ScanErrorKind::Busy => self.busy += 1,
            ScanErrorKind::TooManyHandles => self.too_many_handles += 1,
            ScanErrorKind::NotDir => self.not_dir += 1,
            ScanErrorKind::Cycle => self.cycle += 1,
            ScanErrorKind::Unknown => self.unknown += 1,
        }
    }

    pub fn merge(&mut self, o: ErrorTally) {
        self.denied += o.denied;
        self.missing += o.missing;
        self.busy += o.busy;
        self.too_many_handles += o.too_many_handles;
        self.not_dir += o.not_dir;
        self.cycle += o.cycle;
        self.unknown += o.unknown;
    }

    /// 四桶口径里的 otherErrors，与 TS `core/scan/tree-store.ts:495` 同义。
    pub fn other_errors(&self) -> u64 {
        self.too_many_handles + self.not_dir + self.cycle + self.unknown
    }
}

/// 全树累计量。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counters {
    pub files: u64,
    pub dirs: u64,
    pub bytes_logical: u64,
    pub bytes_alloc: u64,
    pub bytes_counted: u64,
    pub errors: ErrorTally,
    pub skipped_reparse: u64,
    pub skipped_always: u64,
    pub deduped_hardlinks: u64,
    /// 超过深度上限而没进去的目录数（**不是 0 就得在报告里说出来**）
    pub depth_capped: u64,
    /// 注入过的那几个扩展名（`ScanOptions::with_count_exts`）在这棵树里的**条数**。
    /// 没注入时恒 0 —— 「没要过」与「数出来是零」是两句话，那句话由调用方带着
    /// `count_exts` 存不存在来回答，不住在这一层。
    pub ext_count: u64,
    /// 同上，字节口径 = **表观（逻辑）大小**，与 TS `TreeStore.extTotals()` 的 `f.size` 同一边。
    /// 不是分配大小，也不是硬链接去重后的计入量。
    pub ext_bytes: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScanFile {
    pub name: String,
    /// 表观（逻辑）大小 —— 只展示
    pub size: u64,
    /// 分配大小 —— 聚合用
    pub alloc: u64,
    /// 实际计入的字节数；同 inode 的第二条路径起为 0
    pub counted: u64,
    pub file_id: u64,
    pub mtime_ms: i64,
    pub creation_ms: i64,
    /// `FILE_ATTRIBUTE_*` 位掩码原值，来自**父目录那一条目录项**（`FileIdBothDirectoryInfo`
    /// 的 `FileAttributes`），零额外 syscall。
    ///
    /// 为什么必须有：§28 原则二的真判据是「属性证得出 SYSTEM 就保护」，
    /// 而那要求逐文件拿到属性位。原先 `ScanFile` 不带它，规则引擎就只能把每个文件
    /// 当成"没采到属性"—— 一个真带 SYSTEM 的缓存文件会被 Rust 侧认领、被 TS 侧拒绝，
    /// **方向是多删**。逐文件属性本来就在手上，没有理由丢。
    pub attrs: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ScanNode {
    pub name: String,
    pub path: String,
    pub size_logical: u64,
    pub size_alloc: u64,
    pub size_counted: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub errors: ErrorTally,
    pub files: Vec<ScanFile>,
    pub children: Vec<ScanNode>,
    /// 文件清单被截断（只影响**存储**，计数与聚合照常累加）
    pub files_truncated: bool,
    /// 目录自身的属性位与时间 —— 从**父目录的那一条目录项**里就有，不需要额外 stat。
    /// 现行 TS 实现从不为目录 stat，所以那边的 `attrs`/`birthtime` 恒为 `null`；这是新实现顺手补上的。
    pub attrs: u32,
    pub creation_ms: i64,
    pub mtime_ms: i64,
}

impl ScanNode {
    pub fn dir(name: String, path: String) -> Self {
        ScanNode {
            name,
            path,
            size_logical: 0,
            size_alloc: 0,
            size_counted: 0,
            file_count: 0,
            dir_count: 0,
            errors: ErrorTally::default(),
            files: Vec::new(),
            children: Vec::new(),
            files_truncated: false,
            attrs: 0,
            creation_ms: 0,
            mtime_ms: 0,
        }
    }
}

/// 扫描途中顺带记下的"目前最大的几个文件"之一。基准是 TS 侧 `tree-store.ts:398-404`
/// 推给 `topHeap` 的那个 `{name, path, size, mtimeMs}`。
///
/// `path` 在这里是**完整的**：`ScanFile` 只存名字（arena 折掉的那份开销），
/// 而这一格要能被表格直接打开/定位，所以推入时就把父路径拼上。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TopHit {
    pub name: String,
    pub path: String,
    /// 表观（逻辑）大小 —— 与 `ext_bytes` 同一把尺子，也是堆的比较分。
    pub size: u64,
    pub mtime_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SkippedItem {
    pub path: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone)]
pub struct ScanTree {
    pub root: ScanNode,
    pub counters: Counters,
    /// 「最大的 N 个文件」那一张表的原料（容量 = `ScanOptions::top_n`，默认 100）。
    /// **无序**：堆序不是排序，消费方（`apply_top_query`）自己排。
    pub top: Vec<TopHit>,
    pub volume: crate::volume::VolumeInfo,
    /// **有界**样本（默认 200 条，与 TS 侧 `MAX_DENIED_SAMPLE` 同口径）。
    /// 计数是无界的，清单是有界的 —— 所以读这个清单时不许把它当全集。
    pub skipped_sample: Vec<SkippedItem>,
    pub skipped_sample_overflowed: bool,
    pub elapsed_ms: u64,
    /// 本棵树由哪一档产出（walk / mft）—— 口径解释权在 `mft/mod.rs` 头注。
    pub mode: ScanMode,
    /// MFT 档的记账细节；walk 档恒 `None`。
    pub mft: Option<MftStats>,
}

/// 取扩展名：最后一个点起（含点）、小写；**点在首字符（`.bashrc`）或压根没点 → 空串**。
///
/// 基准是 `core/fs/pathutil.ts` 的 `extOf`（先 `baseName` 再 `lastIndexOf('.')`，`i <= 0` 回空）。
/// 传进来的本来就是文件名（目录项的 `name`，不含分隔符），所以这里省掉 `baseName` 那一步 ——
/// 不是「顺手优化」，是这一步在唯一调用点上恒等。闸
/// 因此比两条：无分隔符的语料上两份实现逐字相等；含分隔符的路径上「本份 ∘ 父名」等于 devenv 那份
/// （闸在 `src-tauri/src/dev_env.rs` 的 `the_two_ext_of_implementations_agree` —— 壳层是唯一同时依赖两个 crate 的一层）。
///
/// **本仓有两份 `ext_of`**（这一份与 `deepclean_devenv::model_files::ext_of`），因为两侧都要在
/// 自己的热路径上用，而 crates 之间不许为这一个函数拉依赖边。分叉的症状不是报错而是**静默漏计**：
/// 一个不认 `.gguf` 的计数口径在界面上长得和「这台机器上没有」一模一样。所以那条相等性闸
/// 不是礼仪，是这一处分叉的唯一定价方式。
pub fn ext_of(name: &str) -> String {
    match name.rfind('.') {
        // `i <= 0`：没点，或点就是第一个字符（那是文件名，不是扩展名）
        Some(i) if i > 0 => name[i..].to_lowercase(),
        _ => String::new(),
    }
}
