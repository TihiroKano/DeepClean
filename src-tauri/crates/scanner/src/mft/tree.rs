//! 树重建 + 计数 —— **MFT 档全部「口径裁定」集中在这一个文件里**。
//!
//! 从 [`MftStream`] 交出的原始记录字节到与 walk 档同构的
//! [`crate::model::ScanTree`]，中间是四个阶段：
//!
//! 1. **顺序扫**：`next_raw` 逐条交出未 fixup 的字节 → fixup（失败=损坏报数）→
//!    `parse_record` → 按 `base_ref` 分拣：基记录进 arena，扩展记录进 ext_map。
//!    reparse / 已删除 / 空闲记录在这里就出局，各自报数。
//! 2. **合并**：扩展记录按 `base_ref` 并回基记录（[`apply_extensions`] 的三条规则）；
//!    找不到基的扩展报 `extension_missed` —— 它携带的 $DATA 片段随它丢掉。
//! 3. **挂链**：每条记录的 `$FILE_NAME` 按**命名空间优先级**（Win32&DOS > POSIX >
//!    Win32）稳定排序，逐名解析父引用（父在 arena 且 sequence 相符且是目录）；
//!    硬链接 = 一条记录多名，每个可解析父位各挂一条边，但字节只记在主名上。
//! 4. **消费**：从根（记录 5）DFS 折出 [`ScanNode`]；元记录 0-15 收进 `$METADATA`，
//!    从根不可达的（父引用失效/环）收进 `$ORPHANS` —— **两者的字节照常计入**，
//!    它们是真实占用，漏了就进「未计入」。
//!
//! ## 本档口径（与 walk 档的差异都写在这里，报告 `scan_mode` 字段负责解释）
//!
//! · **meta 记录 0-15 计入**：$MFT/$LogFile/$UsnJrnl 是 walk 档永远看不见的
//!   「未计入」大户。`$BadClus`（记录 8）的无名 $DATA real = 整卷容量（稀疏覆盖），
//!   logical 特判置 0，alloc 照常（坏簇真实占用的那部分该算）。
//! · **硬链接按记录号计一次**：一条记录只在 arena 出现一次，
//!   [`FileAccounting`] 走一遍即是全额；每个父目录仍各放一条 [`ScanFile`]，
//!   非主名 `counted = 0` —— 与 walk 档产出语义对齐。
//! · **目录恒 0 字节**：目录的数据在 `$INDEX_ALLOCATION`，解析层不读它；
//!   ADS 若有进 allocated（真实占用）。
//! · **驻留文件 alloc = 0**：驻留流的字节住在 MFT 记录里，不另占簇；
//!   walk 档取整到簇反而系统性多报。
//! · **ADS 计入 allocated 并单独报数**：walk 档的目录项里没有 ADS，看不见。
//! · **SKIP_ALWAYS 不按名跳**：walk 档跳 `System Volume Information` 是因为它
//!   必被拒、只剩 denied 噪声；MFT 档没有 denied，跳过反而漏算。
//! · **扩展名计数按记录一次**（主名口径）：walk 档按目录项计，硬链接按路径多计。
//!
//! ## 确定性
//!
//! 同一卷两次扫描必须产出逐字段相等的树：边按名排序、`$METADATA` 按记录号、
//! `$ORPHANS` 按 arena 序（= 记录号序）、扩展合并前按记录号排序。HashMap 只用于
//! 查找，任何遍历序都不进结果。

use std::collections::HashMap;
use std::path::Path;

use super::boot::BootGeometry;
use super::rawvol::VolumeRead;
use super::record::{
    apply_extensions, apply_update_sequence, looks_like_file_record, parse_record, MftRecord,
    NS_POSIX, NS_WIN32, NS_WIN32_AND_DOS,
};
use super::stream::{MftStream, StreamError};
use super::MftFailure;
use crate::accounting::FileAccounting;
use crate::model::{ext_of, Counters, MftStats, ScanFile, ScanNode, TopHit};
use crate::scan::{ScanControl, ScanOptions};

/// 根目录固定是记录 5 —— NTFS 的格式常量，不是约定俗成。
const ROOT_RECORD: u64 = 5;
/// `$BadClus`（记录 8）：带名 `$BAD` 流 sparse 覆盖整个卷，logical 与 alloc
/// 都必须整条归 0（见 [`rec_alloc`]）—— 少算的坏簇字节（通常为 0，至多几簇）
/// 与 walk 档"看不见它"的口径一致。
const BAD_CLUS_RECORD: u64 = 8;

/// 记录的分配字节口径（占簇数 × 簇大小）。
///
/// · **run list 重算优先**：解析层解出的真实占簇（sparse 段剔除）—— 普通流与
///   +0x28 头字段相等，sparse 流（`$UsnJrnl:$J`、`$BadClus:$BAD`）头字段报名义值，
///   只有重算才是真占用。解不动的流回落头字段。
/// · `$BadClus`（记录 8）整条归 0 兜底：它的 `$BAD` 流名义映射整个卷（D 盘实测
///   411,592,290,304 = 卷容量）。重算本应自动归零（全段 sparse），这里显式拦一道
///   —— 解码回落时也不许漏。
fn rec_alloc(rec: &MftRecord, cluster_bytes: u64) -> u64 {
    if rec.number == BAD_CLUS_RECORD {
        return 0;
    }
    let data = rec
        .data_alloc_clusters
        .map(|c| c * cluster_bytes)
        .or(rec.data_alloc)
        .unwrap_or(0);
    let ads = rec.ads_alloc_clusters.map(|c| c * cluster_bytes).unwrap_or(rec.ads_alloc);
    data + ads
}

/// ADS 报数口径（同 [`rec_alloc`] 的 ADS 半边）。
fn ads_alloc_of(rec: &MftRecord, cluster_bytes: u64) -> u64 {
    rec.ads_alloc_clusters.map(|c| c * cluster_bytes).unwrap_or(rec.ads_alloc)
}
/// 元记录区间 0..16（含 0 与 15）。除根（5）外全部收进 `$METADATA`。
const META_RECORDS: u64 = 16;
/// 合成节点名。真文件名可以含 `$`，撞名的概率不为零 —— 撞了就并进同名节点，
/// 字节不少算；名字只是展示，账在 Counters 里。
const META_NODE: &str = "$METADATA";
const ORPHANS_NODE: &str = "$ORPHANS";
/// 进度回调节奏：每 512 条记录一次（约 512 KiB 的 $MFT 流量一次，足够顺滑）。
const PROGRESS_EVERY: u64 = 512;

/// 树重建的产物。哨兵检查与 [`crate::model::ScanTree`] 组装在 `mod.rs`
/// （编排层）—— 本层只管把树和账算对。
#[derive(Debug)]
pub struct TreeBuild {
    pub root: ScanNode,
    pub counters: Counters,
    pub stats: MftStats,
    pub top: Vec<TopHit>,
}

/// 消费期从 arena 记录里**拷出来**的字段。消费动作全是 `&mut self`
/// （counters / top / children），借着 `&self.arena` 的引用走不下去 ——
/// 一次快照把借检边界变成一行，不是设计洁癖。
struct RecSnapshot {
    number: u64,
    is_dir: bool,
    /// 第一个 `$FILE_NAME` 的名字（展示用；挂链名在各边上）
    name: Option<String>,
    file_id: u64,
    /// $BadClus 特判后的表观大小
    logical: u64,
    /// data_alloc + ads_alloc
    alloc: u64,
    mtime_ms: i64,
    creation_ms: i64,
    attrs: u32,
}

/// 一条挂链边：记录 i 在**这个父目录**下叫这个名字，记这么多字节。
/// 同一记录的多条边（硬链接）里只有主名的 `counted` 非 0。
struct Edge {
    record: usize,
    name: String,
    counted: u64,
}

struct Builder<'a> {
    arena: Vec<MftRecord>,
    /// 父记录号 → 它的孩子们。消费时 `remove` —— 每条边恰好消费一次。
    children: HashMap<u64, Vec<Edge>>,
    /// 被消费过的记录（根/meta/任何进过树的）—— 孤儿判定的第二道闸
    visited: Vec<bool>,
    /// 有至少一条可解析挂链边的记录 —— 孤儿判定的第一道闸
    placed: Vec<bool>,
    /// 每条记录 [`FileAccounting::count_file`] 的裁定值（全额或 0）
    counted_of: Vec<u64>,
    counters: Counters,
    stats: MftStats,
    top: crate::heap::TopHeap,
    max_files_per_dir: usize,
    count_exts: Option<&'a std::collections::HashSet<String>>,
    control: &'a ScanControl,
    /// 占簇数 → 字节的换算系数（引导扇区几何）。
    cluster_bytes: u64,
}

/// 命名空间优先级：主名取值序。Win32&DOS(1) 最优，POSIX(0) 次之，Win32(3) 再次，
/// 其它（不该出现）垫底。稳定排序 → 同优先级保持属性序。
fn ns_rank(ns: u8) -> u8 {
    match ns {
        NS_WIN32_AND_DOS => 0,
        NS_POSIX => 1,
        NS_WIN32 => 2,
        _ => 3,
    }
}

fn pack_ref(number: u64, seq: u16) -> u64 {
    ((seq as u64) << 48) | number
}

/// 记录的主名（优先级最高的那条）。名字清单为空 → None（元文件常态）。
fn main_name(rec: &MftRecord) -> Option<String> {
    let mut best: Option<(u8, &str)> = None;
    for n in &rec.names {
        let r = ns_rank(n.namespace);
        if best.map_or(true, |(br, _)| r < br) {
            best = Some((r, n.name.as_str()));
        }
    }
    best.map(|(_, n)| n.to_string())
}

/// 元记录的展示名：真 `$FILE_NAME` 优先（$Extend 有真名），否则按格式常量报。
fn meta_name(number: u64) -> String {
    const NAMES: [&str; 16] = [
        "$MFT", "$MFTMirr", "$LogFile", "$Volume", "$AttrDef", "(root)", "$Bitmap", "$Boot",
        "$BadClus", "$Secure", "$UpCase", "$Extend", "$Reserved12", "$Reserved13", "$Reserved14",
        "$Reserved15",
    ];
    NAMES
        .get(number as usize)
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("$meta{number}"))
}

/// 顺序扫阶段的临时记账：给进度回调一个"正在长"的数。扩展记录并入前基记录的
/// 大小是缺的（pagefile 形态），所以**扫描途中略偏低、聚合期归真** ——
/// 与 walk 并行档（MS5）"done 后归真"同一立场。哨兵检查只看最终值。
fn provisional_bump(c: &mut Counters, rec: &MftRecord, cluster_bytes: u64) {
    if rec.is_dir {
        c.dirs += 1;
    } else {
        c.files += 1;
    }
    let logical = if rec.number == BAD_CLUS_RECORD { 0 } else { rec.data_size.unwrap_or(0) };
    let alloc = rec_alloc(rec, cluster_bytes);
    c.bytes_logical += logical;
    c.bytes_alloc += alloc;
    // 无去重：一条记录一个号，全额即真值
    c.bytes_counted += alloc;
}

pub(super) fn map_stream(e: StreamError) -> MftFailure {
    match e {
        StreamError::Io(5) => MftFailure::NeedsElevation,
        StreamError::Io(c) => MftFailure::ReadFailed(c),
        // 流层这四种都意味着"几何/结构与盘上事实对不上"，回退是上层的事
        StreamError::GeometryUnverified
        | StreamError::NoMftData
        | StreamError::BadRuns(_)
        | StreamError::BeyondEnd => MftFailure::GeometryUnverified,
    }
}

/// 取消/暂停检查点。与 walk 档同一立场：暂停是**真**暂停（不发新 I/O），
/// 取消整轮作废。
fn checkpoint(control: &ScanControl) -> Result<(), MftFailure> {
    while control.is_paused() && !control.is_cancelled() {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if control.is_cancelled() {
        return Err(MftFailure::Cancelled);
    }
    Ok(())
}

fn absorb_node(parent: &mut ScanNode, child: &ScanNode) {
    parent.size_logical += child.size_logical;
    parent.size_alloc += child.size_alloc;
    parent.size_counted += child.size_counted;
    parent.file_count += child.file_count;
    parent.dir_count += child.dir_count;
    parent.errors.merge(child.errors);
}

/// 从 [`MftStream`] 重建整卷的树。泛型在 [`VolumeRead`] 上：
/// 真卷（`mod.rs` 的编排）与合成镜像（本文件测试）同一条路。
#[allow(clippy::too_many_arguments)]
pub fn build_tree<V: VolumeRead>(
    mut stream: MftStream<V>,
    geo: &BootGeometry,
    opts: &ScanOptions,
    volume_serial: u32,
    root_name: &str,
    root_path: &str,
    control: &ScanControl,
    mut progress: impl FnMut(&Counters),
) -> Result<TreeBuild, MftFailure> {
    let record_bytes = stream.record_size() as usize;
    let cluster_bytes = geo.cluster_bytes();
    let mut buf = vec![0u8; record_bytes];
    let mut stats = MftStats { records_total: stream.total_records(), ..Default::default() };
    let mut provisional = Counters::default();
    let mut skipped_reparse_total: u64 = 0;
    let mut accounting = FileAccounting::new();

    // ---------- 阶段一：顺序扫全卷 ----------
    let mut arena: Vec<MftRecord> = Vec::new();
    let mut by_number: HashMap<u64, usize> = HashMap::new();
    let mut ext_map: HashMap<u64, Vec<MftRecord>> = HashMap::new();

    loop {
        let n = match stream.next_raw(&mut buf) {
            Ok(Some(n)) => n,
            Ok(None) => break,
            Err(e) => return Err(map_stream(e)),
        };
        if looks_like_file_record(&buf) {
            if !apply_update_sequence(&mut buf, geo.bytes_per_sector) {
                stats.records_corrupt += 1;
            } else if let Some(rec) = parse_record(&buf, n) {
                if !rec.in_use {
                    // 已删除：簇已属自由空间，计入就会跟「卷已用」对不上
                    stats.records_deleted += 1;
                } else if rec.has_reparse {
                    // 与 walk 档同语义：跳过 + 报数。样本不带 —— 路径要等树挂好才知道，
                    // 而计数才是承重的那半（样本是有界诊断，不是账本）。
                    skipped_reparse_total += 1;
                    provisional.skipped_reparse += 1;
                } else if rec.base_ref != 0 {
                    // 扩展记录：等基记录并账，不单独成文件
                    ext_map.entry(rec.base_ref).or_default().push(rec);
                } else {
                    provisional_bump(&mut provisional, &rec, cluster_bytes);
                    by_number.insert(n, arena.len());
                    arena.push(rec);
                }
            } else {
                stats.records_corrupt += 1;
            }
        } else {
            // 全零（空闲）或非记录垃圾 —— TS 立场：不是记录，跳过，不算损坏
            stats.records_free += 1;
        }
        if (n + 1) % PROGRESS_EVERY == 0 {
            checkpoint(control)?;
            progress(&provisional);
        }
    }
    // 流读完补一发：不足 512 条的小卷也有进度，HUD 不闪零
    progress(&provisional);

    // ---------- 阶段二：扩展记录并入基记录 ----------
    // base_ref 是权威指针（record.rs 注释：比反查 attr_list 可靠）。
    for (base_no, mut exts) in ext_map {
        exts.sort_by_key(|r| r.number); // 流序本已升序，HashMap 打乱过 —— 恢复确定性
        match by_number.get(&base_no) {
            Some(&i) => {
                let base = arena[i].clone();
                arena[i] = apply_extensions(base, &exts);
            }
            None => stats.extension_missed += exts.len() as u64,
        }
    }

    // ---------- 阶段三：记账 + 挂链 ----------
    let n_rec = arena.len();
    let mut b = Builder {
        arena,
        children: HashMap::new(),
        visited: vec![false; n_rec],
        placed: vec![false; n_rec],
        counted_of: vec![0; n_rec],
        // 阶段一的 reparse 报数搬进来 —— provisional 只是进度近似，最终账在 counters
        counters: Counters { skipped_reparse: skipped_reparse_total, ..Default::default() },
        stats,
        top: crate::heap::TopHeap::new(opts.top_n),
        max_files_per_dir: opts.max_files_per_dir,
        count_exts: opts.count_exts.as_ref(),
        control,
        cluster_bytes,
    };

    let mut meta: Vec<usize> = Vec::new();
    let mut root_idx: Option<usize> = None;
    for i in 0..b.arena.len() {
        let rec = &b.arena[i];
        let logical = if rec.number == BAD_CLUS_RECORD { 0 } else { rec.data_size.unwrap_or(0) };
        let alloc = rec_alloc(rec, cluster_bytes);
        // ADS 报数：$BadClus 的 $BAD 流是名义流（见 rec_alloc），不进报数口径
        if rec.ads_count > 0 && rec.number != BAD_CLUS_RECORD {
            b.stats.ads_streams += rec.ads_count;
            b.stats.ads_bytes += ads_alloc_of(rec, cluster_bytes);
        }
        // MFT 档一条记录只在 arena 出现一次 —— FileAccounting 按记录号走一遍即是
        // 全额；walk 档"同 inode 第二条路径计 0"的语义在这里由主名/非主名承担。
        let packed = pack_ref(rec.number, rec.sequence);
        b.counted_of[i] = accounting.count_file(volume_serial, packed, alloc);
        // 扩展名计数：每条记录一次（主名口径）。walk 档按目录项计，硬链接按路径多计
        // —— 档间已知差异，scan_mode 字段可解释。
        if let Some(set) = b.count_exts {
            if let Some(main) = main_name(rec) {
                if set.contains(ext_of(&main).as_str()) {
                    b.counters.ext_count += 1;
                    b.counters.ext_bytes += logical;
                }
            }
        }
        if rec.number == ROOT_RECORD {
            root_idx = Some(i);
            continue;
        }
        if rec.number < META_RECORDS {
            meta.push(i);
            continue;
        }
        // 挂链：名字按命名空间优先级稳定排序，逐名解析父引用。
        // 父必须在 arena 里（在用、非扩展）、sequence 相符（记录号会被回收复用，
        // 陈旧引用的序号对不上）、且确实是目录 —— 三者缺一，这条父位不成立。
        let rec_number = rec.number;
        let rec_is_dir = rec.is_dir;
        let mut order: Vec<usize> = (0..rec.names.len()).collect();
        order.sort_by_key(|&k| ns_rank(rec.names[k].namespace));
        for &k in &order {
            let nm = &rec.names[k];
            let ok = match by_number.get(&nm.parent) {
                Some(&p) => {
                    b.arena[p].sequence == nm.parent_seq
                        && b.arena[p].is_dir
                        && nm.parent != rec_number
                }
                None => false,
            };
            if !ok {
                continue;
            }
            let counted = if b.placed[i] { 0 } else { b.counted_of[i] };
            b.placed[i] = true;
            let parent = nm.parent;
            let name = nm.name.clone();
            b.children.entry(parent).or_default().push(Edge { record: i, name, counted });
            if rec_is_dir {
                // 目录不硬链接：只认优先级最高的那一个可解析父位
                break;
            }
        }
    }

    let root_idx = match root_idx {
        Some(i) if b.arena[i].is_dir => i,
        _ => return Err(MftFailure::NoRootRecord),
    };

    // ---------- 阶段四：DFS 消费 ----------
    let mut root_node = ScanNode::dir(root_name.to_string(), root_path.to_string());
    b.consume(root_idx, &mut root_node, Path::new(root_path))?;

    // $METADATA：记录 0-15（除根）。$Extend 一类的目录元文件真名在 $FILE_NAME 里
    // （parent 指根，但元文件不挂根 —— 它们的家在这里）。
    if !meta.is_empty() {
        b.stats.meta_records = meta.len() as u64;
        let meta_path = Path::new(root_path).join(META_NODE);
        let mut node = ScanNode::dir(META_NODE.to_string(), meta_path.to_string_lossy().into_owned());
        for &i in &meta {
            let s = b.snapshot(i);
            b.visited[i] = true;
            let name = s.name.clone().unwrap_or_else(|| meta_name(s.number));
            if s.is_dir {
                b.counters.dirs += 1;
                node.dir_count += 1;
                let p = meta_path.join(&name);
                let mut child = ScanNode::dir(name, p.to_string_lossy().into_owned());
                b.consume(i, &mut child, &p)?;
                absorb_node(&mut node, &child);
                node.children.push(child);
            } else {
                b.push_file(&s, &name, b.counted_of[i], &mut node, &meta_path);
            }
        }
        node.files.sort_by(|a, b| a.name.cmp(&b.name));
        node.children.sort_by(|a, b| a.name.cmp(&b.name));
        absorb_node(&mut root_node, &node);
        root_node.children.push(node);
    }

    // $ORPHANS：从根不可达的记录 —— 父引用失效（号被回收后序号对不上）与环都落这里。
    // 字节照常计入：它们是真实占用，漏了就进「未计入」。孤儿目录的子树跟着它走
    // （孩子的父引用解析到孤儿本身，consume 会把它们挂回孤儿节点下）。
    let orphan_path = Path::new(root_path).join(ORPHANS_NODE);
    let mut orphan_node =
        ScanNode::dir(ORPHANS_NODE.to_string(), orphan_path.to_string_lossy().into_owned());
    for i in 0..b.arena.len() {
        // 判据是 visited（从根 / 从 $METADATA 真的走到过），**不是 placed**：
        // 环成员每一条都有可解析父位（placed=true），却从根不可达 —— 按 placed 判
        // 它们就整环逃进「未计入」。环的终止由 consume 里的 visited 守卫负责。
        if b.visited[i] {
            continue;
        }
        b.stats.orphan_records += 1;
        let s = b.snapshot(i);
        b.visited[i] = true;
        let name = s.name.clone().unwrap_or_else(|| format!("$orphan-{}", s.number));
        if s.is_dir {
            b.counters.dirs += 1;
            orphan_node.dir_count += 1;
            let p = orphan_path.join(&name);
            let mut child = ScanNode::dir(name, p.to_string_lossy().into_owned());
            b.consume(i, &mut child, &p)?;
            absorb_node(&mut orphan_node, &child);
            orphan_node.children.push(child);
        } else {
            b.push_file(&s, &name, b.counted_of[i], &mut orphan_node, &orphan_path);
        }
    }
    if orphan_node.file_count > 0 || orphan_node.dir_count > 0 {
        orphan_node.files.sort_by(|a, b| a.name.cmp(&b.name));
        orphan_node.children.sort_by(|a, b| a.name.cmp(&b.name));
        absorb_node(&mut root_node, &orphan_node);
        root_node.children.push(orphan_node);
    }

    // 根的 children 是 consume（边序）+ $METADATA/$ORPHANS（后补）两路拼的 ——
    // 终排一次，两次扫描同序。
    root_node.children.sort_by(|a, b| a.name.cmp(&b.name));

    // counters 与根节点是两条独立累加路径，必须相等（walk 档同款闸）。
    debug_assert_eq!(
        b.counters.bytes_counted, root_node.size_counted,
        "占用合计：counters 与根节点两条累加路径不相等",
    );
    debug_assert_eq!(b.counters.dirs, root_node.dir_count, "目录数两条累加路径不相等");
    debug_assert_eq!(b.counters.files, root_node.file_count, "文件数两条累加路径不相等");

    // 收口：精确值归真（扫描途中的 provisional 是缺扩展合并的近似）
    progress(&b.counters);

    Ok(TreeBuild {
        root: root_node,
        counters: b.counters,
        stats: b.stats,
        top: b.top.entries().to_vec(),
    })
}

impl Builder<'_> {
    fn snapshot(&self, i: usize) -> RecSnapshot {
        let r = &self.arena[i];
        RecSnapshot {
            number: r.number,
            is_dir: r.is_dir,
            name: r.names.first().map(|n| n.name.clone()),
            file_id: pack_ref(r.number, r.sequence),
            logical: if r.number == BAD_CLUS_RECORD { 0 } else { r.data_size.unwrap_or(0) },
            alloc: rec_alloc(r, self.cluster_bytes),
            mtime_ms: r.std_mtime_ms,
            creation_ms: r.std_creation_ms,
            attrs: r.std_attrs,
        }
    }

    /// 文件落地：ScanFile 进父节点 + 节点/全树两条累加路径 + 「最大的 N」堆。
    /// `counted` 由调用方裁定（主名 = count_file 的值，非主名 = 0）。
    fn push_file(&mut self, s: &RecSnapshot, name: &str, counted: u64, node: &mut ScanNode, dir: &Path) {
        // 「最大的 N 个文件」：0 字节不进堆 —— walk 同规（满盘树里 0 字节文件
        // 能有几万个，进堆会把真候选挤光）
        if s.logical > 0 && self.top.wants(s.logical) {
            self.top.push(TopHit {
                name: name.to_string(),
                path: dir.join(name).to_string_lossy().into_owned(),
                size: s.logical,
                mtime_ms: s.mtime_ms,
            });
        }
        // 截断只砍存储，计数照常（TS maxFiles 的教训）
        if node.files.len() < self.max_files_per_dir {
            node.files.push(ScanFile {
                name: name.to_string(),
                size: s.logical,
                alloc: s.alloc,
                counted,
                file_id: s.file_id,
                mtime_ms: s.mtime_ms,
                creation_ms: s.creation_ms,
                attrs: s.attrs,
            });
        } else {
            node.files_truncated = true;
        }
        node.file_count += 1;
        node.size_logical += s.logical;
        node.size_alloc += s.alloc;
        node.size_counted += counted;
        self.counters.files += 1;
        self.counters.bytes_logical += s.logical;
        self.counters.bytes_alloc += s.alloc;
        self.counters.bytes_counted += counted;
    }

    /// 消费一个目录记录：自身字节（ADS）→ 逐边处理孩子（文件/目录）。
    /// 返回 Err 仅当取消。
    fn consume(&mut self, idx: usize, node: &mut ScanNode, path: &Path) -> Result<(), MftFailure> {
        checkpoint(self.control)?;
        self.visited[idx] = true;
        let number = self.arena[idx].number;
        let (attrs, ctime, mtime) = {
            let r = &self.arena[idx];
            (r.std_attrs, r.std_creation_ms, r.std_mtime_ms)
        };
        node.attrs = attrs;
        node.creation_ms = ctime;
        node.mtime_ms = mtime;
        // 目录自身：无名 $DATA 恒无（索引数据在 $INDEX_ALLOCATION，解析层不读），
        // ADS 若有进 allocated —— 真实占用。
        let own = self.arena[idx].ads_alloc;
        if own > 0 {
            self.counters.bytes_alloc += own;
            self.counters.bytes_counted += own;
            node.size_alloc += own;
            node.size_counted += own;
        }

        let mut edges = self.children.remove(&number).unwrap_or_default();
        // 枚举顺序由我们定，**必须排序** —— 与 walk 档同一立场：
        // 同一棵树两次扫描的节点顺序不同，派生的一切都不稳定。
        edges.sort_by(|a, b| a.name.cmp(&b.name));
        for e in edges {
            let s = self.snapshot(e.record);
            if s.is_dir {
                if self.visited[e.record] {
                    // 环：目录只消费一次（28↔29 互指时，第二次见到彼此就闭嘴）。
                    // 文件边不跳 —— 硬链接的第二个父位照样要出现，那是 visited 的正当复用。
                    continue;
                }
                // 无论有无孩子，它都是一个**存在**的目录 —— 与 walk 档同口径
                self.counters.dirs += 1;
                node.dir_count += 1;
                let child_path = path.join(&e.name);
                let mut child = ScanNode::dir(e.name, child_path.to_string_lossy().into_owned());
                self.consume(e.record, &mut child, &child_path)?;
                absorb_node(node, &child);
                node.children.push(child);
            } else {
                self.visited[e.record] = true;
                self.push_file(&s, &e.name, e.counted, node, path);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mft::record::{ATTR_DATA, REC_FLAG_DIRECTORY, REC_FLAG_IN_USE, NS_WIN32_AND_DOS};
    use crate::mft::testutil::{
        attr_list_attr, file_name_attr, file_record, index_root_attr, named_nonresident_data,
        nonresident_data, resident_attr, reparse_attr, run_list, standard_info_attr,
        volume_fixture, AttrListEntry, NonResidentSpec, RunSpec, RecordSpec, VolumeFixture,
    };
    use crate::scan::{ScanControl, ScanOptions};

    const SECTOR: u32 = 512;
    const RB: usize = 1024;

    fn pack(number: u64, seq: u16) -> u64 {
        ((seq as u64) << 48) | number
    }

    fn si() -> Vec<u8> {
        standard_info_attr(1_000, 2_000, 0x20)
    }

    fn res(v: &[u8]) -> Vec<u8> {
        resident_attr(ATTR_DATA, v)
    }

    fn fname(parent: u64, real: u64, alloc: u64, name: &str) -> Vec<u8> {
        file_name_attr(parent, real, alloc, 0, name, NS_WIN32_AND_DOS)
    }

    fn nonres(real: u64, alloc: u64, clusters: u64, delta: i64) -> Vec<u8> {
        nonresident_data(&NonResidentSpec {
            start_vcn: 0,
            last_vcn: clusters - 1,
            alloc,
            real,
            initialized: real,
            runs: run_list(&[RunSpec::Data { delta, clusters }]),
        })
    }

    fn dir_record(parent: u64, name: &str) -> Vec<u8> {
        file_record(&RecordSpec {
            sequence: 1,
            flags: REC_FLAG_IN_USE | REC_FLAG_DIRECTORY,
            base_ref: 0,
            usa_b: false,
            attrs: vec![si(), fname(parent, 0, 0, name), index_root_attr()],
            record_bytes: RB,
            sector: SECTOR,
        })
    }

    fn file_spec(attrs: Vec<Vec<u8>>) -> Vec<u8> {
        file_record(&RecordSpec {
            sequence: 1,
            flags: REC_FLAG_IN_USE,
            base_ref: 0,
            usa_b: false,
            attrs,
            record_bytes: RB,
            sector: SECTOR,
        })
    }

    fn ext_record(base: u64, real: u64, alloc: u64, clusters: u64, delta: i64) -> Vec<u8> {
        file_record(&RecordSpec {
            sequence: 1,
            flags: REC_FLAG_IN_USE,
            base_ref: base,
            usa_b: false,
            attrs: vec![nonres(real, alloc, clusters, delta)],
            record_bytes: RB,
            sector: SECTOR,
        })
    }

    /// 全景夹具：32 条记录（0-31），覆盖 meta / 硬链接 / 扩展记录 / 孤儿（父缺失、
    /// 序号不符、环、孤儿子树）/ 损坏 / 已删除 / 空闲 / reparse / ADS / 驻留文件。
    /// 记录号 ↔ 内容的注释就是期望账本的索引。
    fn main_fixture() -> VolumeFixture {
        let root = pack(5, 1);
        let sub = pack(16, 1);
        let extend = pack(11, 1);
        let records = vec![
            /* 1  $MFTMirr */ file_spec(vec![si(), nonres(1024, 1024, 2, 1000)]),
            /* 2  $LogFile  */ file_spec(vec![si(), nonres(4096, 4096, 8, 1100)]),
            /* 3  $Volume  */ file_spec(vec![si()]),
            /* 4  $AttrDef */ file_spec(vec![si(), res(&[0u8; 256])]),
            /* 5  根       */
            file_record(&RecordSpec {
                sequence: 1,
                flags: REC_FLAG_IN_USE | REC_FLAG_DIRECTORY,
                base_ref: 0,
                usa_b: false,
                attrs: vec![si(), fname(root, 0, 0, "."), index_root_attr()],
                record_bytes: RB,
                sector: SECTOR,
            }),
            /* 6  $Bitmap  */ file_spec(vec![si(), nonres(8192, 8192, 16, 1200)]),
            /* 7  $Boot    */ file_spec(vec![si(), res(&[7u8; 100])]),
            /* 8  $BadClus：真机形态 —— 带名 `$BAD` 流 sparse 覆盖"整卷"，
               allocated = 卷容量（D 盘实测 411,592,290,304，与卷大小一位不差）。
               logical 与 alloc 都必须整条归 0（rec_alloc），否则整卷双计。 */
            file_spec(vec![
                si(),
                named_nonresident_data("$BAD", &NonResidentSpec {
                    start_vcn: 0,
                    last_vcn: 97_655,
                    alloc: 400_000_000,
                    real: 400_000_000,
                    initialized: 0,
                    runs: run_list(&[RunSpec::Sparse { clusters: 97_656 }]),
                }),
            ]),
            /* 9  $Secure  */ file_spec(vec![si(), nonres(65536, 65536, 128, 1300)]),
            /* 10 $UpCase   */ file_spec(vec![si(), res(&[9u8; 256])]),
            /* 11 $Extend（目录元文件）*/ dir_record(root, "$Extend"),
            /* 12 空闲      */ vec![0u8; RB],
            /* 13 已删除    */
            file_record(&RecordSpec {
                sequence: 1,
                flags: 0,
                base_ref: 0,
                usa_b: false,
                attrs: vec![si(), fname(root, 5, 4096, "old.txt")],
                record_bytes: RB,
                sector: SECTOR,
            }),
            /* 14 损坏：扇区尾被掰掉一个位，fixup 验证必须失败 */
            {
                let mut r = file_spec(vec![si(), fname(root, 9, 4096, "torn.txt")]);
                r[0x1FE] ^= 0xFF;
                r
            },
            /* 15 空闲      */ vec![0u8; RB],
            /* 16 sub       */ dir_record(root, "sub"),
            /* 17 a.txt（驻留：alloc 0）*/ file_spec(vec![si(), fname(root, 5, 4096, "a.txt"), res(b"hello")]),
            /* 18 big.bin 基记录（$DATA 在扩展里 —— pagefile 真机形态）*/
            file_spec(vec![
                si(),
                fname(root, 7_999_000, 8_000_000, "big.bin"),
                attr_list_attr(&[AttrListEntry { attr_type: ATTR_DATA, lower_vcn: 0, record_ref: pack(19, 1) }]),
            ]),
            /* 19 扩展记录：VCN=0 的 $DATA */
            ext_record(pack(18, 1), 7_999_000, 8_000_000, 15_625, 5000),
            /* 20 硬链接：根下 hard_a + sub 下 hard_b */
            file_spec(vec![
                si(),
                fname(root, 11, 4096, "hard_a.txt"),
                fname(sub, 11, 4096, "hard_b.txt"),
                nonres(11, 4096, 8, 9000),
            ]),
            /* 21 孤儿：父 999 不存在 */
            file_spec(vec![si(), fname(pack(999, 1), 7, 4096, "orphan.txt"), res(b"orphan!")]),
            /* 22 孤儿：父序号 42 对不上根的 1 */
            file_spec(vec![si(), fname(pack(5, 42), 9, 4096, "seq.txt"), res(b"seqseqseq")]),
            /* 23 reparse：跳过 + 报数 */
            file_spec(vec![si(), fname(root, 0, 0, "link.lnk"), reparse_attr()]),
            /* 24 $UsnJrnl：挂在 $Extend（元目录）下 */
            file_spec(vec![si(), fname(extend, 4096, 8192, "$UsnJrnl"), nonres(4096, 8192, 16, 6000)]),
            /* 25 $Reparse（元文件，不是 reparse 点）*/
            file_spec(vec![si(), fname(extend, 100, 0, "$Reparse"), res(&[3u8; 100])]),
            /* 26 ads.txt：驻留主流 + 非驻留 ADS */
            file_spec(vec![
                si(),
                fname(sub, 3, 4096, "ads.txt"),
                res(b"abc"),
                named_nonresident_data("zone", &NonResidentSpec {
                    start_vcn: 0,
                    last_vcn: 1,
                    alloc: 1024,
                    real: 600,
                    initialized: 600,
                    runs: run_list(&[RunSpec::Data { delta: 7000, clusters: 2 }]),
                }),
            ]),
            /* 27 z.bin */ file_spec(vec![si(), fname(sub, 4096, 4608, "z.bin"), nonres(4096, 4608, 9, 8000)]),
            /* 28 环 a → 29 */ dir_record(pack(29, 1), "cyc_a"),
            /* 29 环 b → 28 */ dir_record(pack(28, 1), "cyc_b"),
            /* 30 孤儿目录 lost：父 999 不存在 */
            dir_record(pack(999, 1), "lost"),
            /* 31 inside.txt：挂在孤儿目录 lost 下 */
            file_spec(vec![si(), fname(pack(30, 1), 20, 4096, "inside.txt"), res(&[5u8; 20])]),
        ];
        volume_fixture(&[RunSpec::Data { delta: 8, clusters: 64 }], &records)
    }

    fn run(
        fx: VolumeFixture,
        opts: &ScanOptions,
        control: &ScanControl,
        progress: impl FnMut(&Counters),
    ) -> Result<TreeBuild, MftFailure> {
        let stream = MftStream::open(fx.volume, &fx.geo).expect("夹具必须能开流");
        build_tree(
            stream,
            &fx.geo,
            opts,
            7, // volume_serial
            "C:",
            "C:\\",
            control,
            progress,
        )
    }

    fn find<'a>(node: &'a ScanNode, name: &str) -> &'a ScanNode {
        node.children.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("缺子节点 {name}"))
    }

    fn file<'a>(node: &'a ScanNode, name: &str) -> &'a ScanFile {
        node.files.iter().find(|f| f.name == name).unwrap_or_else(|| panic!("缺文件 {name}"))
    }

    /// 端到端：整卷账本逐字段。期望值全部手算自夹具注释 —— 改夹具先改注释再改断言。
    #[test]
    fn full_volume_end_to_end() {
        let fx = main_fixture();
        let mut opts = ScanOptions::new("C:\\");
        opts.top_n = 10;
        opts.count_exts = Some(crate::scan::normalize_count_exts(["bin"]));
        let mut calls: Vec<Counters> = Vec::new();
        let t = run(fx, &opts, &ScanControl::new(), |c| calls.push(*c)).expect("全景夹具必须建树成功");

        // ---- 全树计数 ----
        assert_eq!(t.counters.files, 21, "文件数 = meta 12 + 根 3 + sub 3 + 孤儿 3（孤儿子树里的 inside.txt 也算）");
        assert_eq!(t.counters.dirs, 5, "$Extend + sub + 三个孤儿目录（根不计）");
        assert_eq!(t.counters.bytes_logical, 8_119_586);
        assert_eq!(t.counters.bytes_alloc, 8_133_632, "含硬链接第二父位的 alloc（walk 档同口径）");
        assert_eq!(t.counters.bytes_counted, 8_129_536, "hard_b 记 0；三个孤儿文件全驻留 alloc 0");
        assert_eq!(t.counters.skipped_reparse, 1);
        assert_eq!(t.counters.deduped_hardlinks, 0, "记录号唯一 —— 去重在 arena 里天然完成");
        assert_eq!(t.counters.ext_count, 2, "big.bin + z.bin");
        assert_eq!(t.counters.ext_bytes, 7_999_000 + 4096);

        // ---- 报数字段 ----
        assert_eq!(t.stats.records_total, 32);
        assert_eq!(t.stats.records_free, 2, "记录 12、15 全零");
        assert_eq!(t.stats.records_deleted, 1, "记录 13");
        assert_eq!(t.stats.records_corrupt, 1, "记录 14 扇区尾掰坏");
        assert_eq!(t.stats.meta_records, 11, "0-15 在用（除根 5）");
        assert_eq!(t.stats.orphan_records, 4, "直接收进的：21、22、28、30 —— 29 经父引用挂在 cyc_a 下（子树不算）");
        assert_eq!(t.stats.extension_missed, 0);
        assert_eq!(t.stats.ads_streams, 1);
        assert_eq!(t.stats.ads_bytes, 1024);

        // ---- 根 ----
        assert_eq!(t.root.name, "C:");
        assert_eq!(t.root.file_count, 21);
        assert_eq!(t.root.dir_count, 5);
        assert_eq!(t.root.size_counted, 8_129_536);
        assert_eq!(t.root.size_logical, 8_119_586);
        let kids: Vec<&str> = t.root.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(kids, vec!["$METADATA", "$ORPHANS", "sub"]);
        let names: Vec<&str> = t.root.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["a.txt", "big.bin", "hard_a.txt"]);

        // ---- 驻留文件：alloc 0（walk 档会多报一个簇 —— 档间已知差异）----
        let a = file(&t.root, "a.txt");
        assert_eq!(a.size, 5);
        assert_eq!(a.alloc, 0);
        assert_eq!(a.counted, 0);

        // ---- 扩展记录合并：大小落在基记录名下 ----
        let big = file(&t.root, "big.bin");
        assert_eq!(big.size, 7_999_000);
        assert_eq!(big.alloc, 8_000_000);
        assert_eq!(big.counted, 8_000_000);

        // ---- 硬链接：两个父位都在，字节只记主位 ----
        assert_eq!(file(&t.root, "hard_a.txt").counted, 4096, "主名记全额");
        let sub_node = find(&t.root, "sub");
        let sub_files: Vec<&str> = sub_node.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(sub_files, vec!["ads.txt", "hard_b.txt", "z.bin"]);
        assert_eq!(file(sub_node, "hard_b.txt").counted, 0, "非主名记 0");
        assert_eq!(file(sub_node, "hard_b.txt").size, 11, "但大小照常展示");
        assert_eq!(file(sub_node, "ads.txt").alloc, 1024, "ADS 进 allocated");
        assert_eq!(file(sub_node, "ads.txt").counted, 1024);
        assert_eq!(sub_node.size_counted, 1024 + 0 + 4608);

        // ---- $METADATA ----
        let meta = find(&t.root, "$METADATA");
        assert_eq!(meta.file_count, 12, "10 个文件元记录 + $UsnJrnl + $Reparse");
        assert_eq!(meta.dir_count, 1, "$Extend");
        assert_eq!(meta.size_logical, 116_424, "$BadClus 的 5000 万必须被特判掉");
        assert_eq!(meta.size_alloc, 119_808);
        let meta_names: Vec<&str> = meta.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            meta_names,
            vec!["$AttrDef", "$BadClus", "$Bitmap", "$Boot", "$LogFile", "$MFT", "$MFTMirr", "$Secure", "$UpCase", "$Volume"]
        );
        assert_eq!(file(meta, "$BadClus").size, 0, "$BadClus logical 置 0");
        assert_eq!(file(meta, "$MFT").size, 32768, "32 条记录 × 1024B");
        let extend_node = find(meta, "$Extend");
        assert_eq!(extend_node.file_count, 2, "$UsnJrnl + $Reparse 挂在元目录下");

        // ---- $ORPHANS ----
        let orphans = find(&t.root, "$ORPHANS");
        let orphan_kids: Vec<&str> = orphans.children.iter().map(|c| c.name.as_str()).collect();
        // cyc_b 的父引用解析到 cyc_a（记录 28 在 arena 且是目录）—— 挂它下面，不直接挂 $ORPHANS
        assert_eq!(orphan_kids, vec!["cyc_a", "lost"]);
        let orphan_files: Vec<&str> = orphans.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(orphan_files, vec!["orphan.txt", "seq.txt"]);
        let lost = find(orphans, "lost");
        assert_eq!(lost.file_count, 1, "孤儿子树跟着孤儿走");
        assert_eq!(file(lost, "inside.txt").name, "inside.txt");
        assert_eq!(orphans.size_counted, 0, "三个孤儿文件全驻留 —— alloc 0（驻留口径）");
        assert_eq!(orphans.file_count, 3, "2 直属 + inside.txt 随 lost 吸收");
        assert_eq!(orphans.dir_count, 3);

        // ---- 「最大的 N」----
        assert_eq!(t.top.len(), 10);
        assert_eq!(t.top.iter().map(|h| h.size).max(), Some(7_999_000));

        // ---- 进度：收口一发必须是精确值 ----
        assert!(calls.len() >= 2, "流读完 + 收口至少两发");
        assert_eq!(calls.last().unwrap().files, 21);
    }

    /// 扩展记录的基不在了：片段随它丢，报数，不许静默也不许崩。
    #[test]
    fn extension_missed_when_base_is_gone() {
        // 根必须是记录 5 —— 前面垫 4 条空闲记录
        let root = file_record(&RecordSpec {
            sequence: 1,
            flags: REC_FLAG_IN_USE | REC_FLAG_DIRECTORY,
            base_ref: 0,
            usa_b: false,
            attrs: vec![si(), fname(pack(5, 1), 0, 0, "."), index_root_attr()],
            record_bytes: RB,
            sector: SECTOR,
        });
        let records = vec![
            vec![0u8; RB], // 1-4 空闲
            vec![0u8; RB],
            vec![0u8; RB],
            vec![0u8; RB],
            root,                                        // 5
            ext_record(pack(50, 1), 4096, 8192, 16, 5000), // 6：基 50 不存在
        ];
        let fx = volume_fixture(&[RunSpec::Data { delta: 8, clusters: 16 }], &records);
        let t = run(fx, &ScanOptions::new("C:\\"), &ScanControl::new(), |_| {}).expect("必须成功");
        assert_eq!(t.stats.extension_missed, 1);
        assert_eq!(t.stats.records_total, 7);
        assert_eq!(t.stats.records_free, 4, "垫片空闲记录");
        assert_eq!(t.stats.meta_records, 1, "只有 $MFT 自己");
        assert_eq!(t.counters.files, 1, "只有 $MFT（在 $METADATA 里）；扩展记录不是文件");
        assert_eq!(t.counters.bytes_counted, 8192, "只有 $MFT 的 16 簇 × 512B");
        let kids: Vec<&str> = t.root.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(kids, vec!["$METADATA"], "没有孤儿也没有别的");
    }

    /// 取消：检查点每 512 条一个，置位后在下一检查点整轮作废。
    #[test]
    fn cancel_returns_cancelled() {
        let records: Vec<Vec<u8>> = (0..600).map(|_| vec![0u8; RB]).collect();
        let fx = volume_fixture(&[RunSpec::Data { delta: 8, clusters: 1300 }], &records);
        let control = ScanControl::new();
        control.cancel();
        let r = run(fx, &ScanOptions::new("C:\\"), &control, |_| {});
        assert!(matches!(r, Err(MftFailure::Cancelled)), "必须是 Cancelled，实际 {r:?}");
    }

    /// 环不炸栈：28↔29 互指，都被收进 $ORPHANS 恰好一次（全景夹具已断言数字，
    /// 这条单独钉「没有爆栈、没有双计、环的挂载形状」这三件事本身）。
    #[test]
    fn cycle_is_collected_once_not_forever() {
        let fx = main_fixture();
        let t = run(fx, &ScanOptions::new("C:\\"), &ScanControl::new(), |_| {}).expect("必须成功");
        assert_eq!(t.stats.orphan_records, 4, "直接条数：21、22、28、30（29 挂 cyc_a 下）");
        assert_eq!(t.counters.bytes_counted, 8_129_536, "环成员不许双计");
        let orphans = find(&t.root, "$ORPHANS");
        let cyc_a = find(orphans, "cyc_a");
        let kids: Vec<&str> = cyc_a.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(kids, vec!["cyc_b"], "cyc_b 经父引用挂在 cyc_a 下，整环只此一份");
    }
}
