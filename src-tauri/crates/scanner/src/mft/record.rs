//! MFT 记录解析 —— **纯函数，零 unsafe**。
//!
//! 偏移与判据全部承袭 TS 参考实现 `core/ntfs/mft.ts`，那边每一处都被真机实测纠正过
//! （2026-10-09 本机 C:，100,344 条记录对账）。本文件不新赌任何一个偏移。
//!
//! ## 承重偏移速查（全部钉死在测试里）
//!
//! 记录头：`+0x04 USA 偏移 / +0x06 USA 字数 / +0x10 sequence / +0x14 首属性偏移 /
//! +0x16 flags / +0x20 base 引用`。
//! 属性头：`+0x00 类型 / +0x04 长度 / +0x08 非驻留位 / +0x09 名长 / +0x0A 名偏移`；
//! 驻留值 `+0x10 值长 / +0x14 值偏移`；非驻留 `+0x10 起始 VCN / +0x28 allocated /
//! +0x30 real`。
//!
//! **+0x2C 是错的** —— TS 版按"属性头 0x10 + 0x20 + 0x0C"推出过一个不存在的格，
//! 从记录 #0 解出 `$MFT` 长度 3.9e18 字节。真卷证据三条（TS 注释原文）：
//! 扫 100,344 条记录里 56,194 个非驻留 `$DATA` 的 +0x28 全是簇整数倍；`#4 $AttrDef`
//! 读作 allocated=4096 / real=2560 与已知大小吻合；`#0 $MFT` 的 +0x28/+0x30 与
//! `fsutil fsinfo ntfsinfo` 的 `Mft Valid Data Length` 同值。
//!
//! ## fixup「试 + 验」（TS 版立场原样搬来）
//!
//! NTFS 把每条记录按扇区切开，**每个扇区最后 2 字节被替换成同一个 USN**，原值存在
//! update sequence array 里。USN 放在哪儿有两种约定（A 派：USA[0] 是 USN；
//! B 派：USN 在记录头 +0x08）——挑错派的后果不是崩溃而是静默把 2 字节写进错位置。
//! 所以两种读法都算一遍，**只接受"所有扇区尾当前值确实等于 USN"那一种**；
//! 都对不上就失败，让调用方跳过这条记录 —— 跳过是可发现的损失，写错位置不是。
//! 1024 字节记录要修**两个**扇区尾（0x1FE / 0x3FE）—— TS 第一版只修第一个，
//! 被 B 派那条单测抓出来过。

use crate::mft::runs::decode_runs;

/// `$FILE_NAME` 名字段的命名空间。
pub const NS_POSIX: u8 = 0;
pub const NS_WIN32_AND_DOS: u8 = 1;
pub const NS_DOS: u8 = 2;
pub const NS_WIN32: u8 = 3;

/// 属性类型号（本解析器关心的那几个）。
pub const ATTR_STANDARD_INFO: u32 = 0x10;
pub const ATTR_ATTRIBUTE_LIST: u32 = 0x20;
pub const ATTR_FILE_NAME: u32 = 0x30;
pub const ATTR_DATA: u32 = 0x80;
pub const ATTR_INDEX_ROOT: u32 = 0x90;
pub const ATTR_REPARSE_POINT: u32 = 0xC0;
const ATTR_END: u32 = 0xFFFF_FFFF;

/// 记录头 flags（+0x16）。
pub const REC_FLAG_IN_USE: u16 = 0x0001;
/// `FILE_FILE_NAME_INDEX_PRESENT` —— 只有带文件名索引的记录才是目录。
pub const REC_FLAG_DIRECTORY: u16 = 0x0002;

/// `$FILE_NAME` 值里的目录位（与文件属性同源，不是记录头的 flags）。
const FN_FLAG_DIRECTORY: u32 = 0x10;
/// 目录索引视图里的那一条名字（"." / ".." 属于这类），不是文件在父目录里的真名。
const FN_FLAG_INDEX_VIEW: u32 = 0x40;

/// `$FILE_NAME` 值内部偏移。
const FN_PARENT: usize = 0x00;
const FN_REAL_SIZE: usize = 0x30;
const FN_FLAGS: usize = 0x38;
const FN_NAME_LEN: usize = 0x40;
const FN_NAME_NS: usize = 0x41;
const FN_NAME_TEXT: usize = 0x42;

/// 非驻留属性头：+0x10 起始 VCN / +0x28 allocated / +0x30 real（见模块头「+0x2C 是错的」）。
const NR_STARTING_VCN: usize = 0x10;
const NR_DATA_RUNS_OFFSET: usize = 0x20;
const NR_ALLOCATED_SIZE: usize = 0x28;
const NR_REAL_SIZE: usize = 0x30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileNameAttr {
    /// 父目录记录号（`$FILE_NAME` 引用低 48 位）
    pub parent: u64,
    /// 父目录 sequence（高 16 位）。**它参与身份判断**：记录号会被回收复用。
    pub parent_seq: u16,
    pub name: String,
    pub namespace: u8,
    /// `$FILE_NAME` 值 flags 原值（FN_FLAG_DIRECTORY / FN_FLAG_INDEX_VIEW）
    pub flags: u32,
    /// 索引项里缓存的那份大小 —— 只作 `$DATA` 取不到时的回退，不作为口径
    /// （取证领域已知它会陈旧）。
    pub real_size: u64,
}

/// `$ATTRIBUTE_LIST` 的一个条目：某个属性被搬到了哪条记录。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttrListRef {
    /// 被搬走的那个属性的类型号
    pub attr_type: u32,
    /// 该片段覆盖的起始 VCN。多片段流里**只有 0 那段带真实大小**。
    pub lower_vcn: u64,
    pub record: u64,
    pub record_seq: u16,
}

/// 一条 MFT 记录的解析产物。**大小口径裁定（目录恒 0、驻留 alloc 恒 0）不在这里做**
/// —— 解析层只如实交出字段，聚合层（tree.rs）做口径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MftRecord {
    pub number: u64,
    pub sequence: u16,
    /// `false` = 已删除/未使用。**上层必须整条跳过**，否则会把已删文件算进目录。
    pub in_use: bool,
    pub is_dir: bool,
    /// 出现在哪些父目录的哪些名字下（硬链接）。已滤 "." / ".." 与 index-view、DOS 别名。
    pub names: Vec<FileNameAttr>,
    /// 无名 `$DATA` 的表观（逻辑）大小。`None` = 这条记录没有无名 `$DATA`。
    pub data_size: Option<u64>,
    /// 无名 `$DATA` 的簇分配大小。非驻留 → 头 +0x28；**驻留 → Some(0)**：
    /// 驻留流的字节就住在 MFT 记录里，不另占簇，卷级已用空间里它这一份已经算在
    /// `$MFT` 自己的分配里，再记一次就是双计。
    pub data_alloc: Option<u64>,
    /// 无名 `$DATA` 的起始 VCN（非驻留才有）。合并扩展记录时靠它决定"哪段才算大小"。
    pub data_starting_vcn: Option<u64>,
    pub size_from_data: bool,
    /// 带名 `$DATA`（备用数据流 ADS）合计。**只进 allocated 口径**（非驻留 ADS 的簇是
    /// 真实占用），不进 logical —— 表观口径只认无名流，与 walk 档目录项同边。
    pub ads_count: u64,
    pub ads_logical: u64,
    pub ads_alloc: u64,
    /// run list 重算的**真实占簇数**（Σ 有 LCN 的段；sparse 段 lcn=None 不占簇，剔除）。
    /// `None` = run list 不可解码（或该流是驻留）—— 上层回落 +0x28 头字段。
    /// 2026-10-18 D 盘实测：头字段对 sparse 流报**名义值**（`$UsnJrnl:$J` 报 3.88GB，
    /// 实占近 0），这就是 802GB 超额里 $BadClus 之外的另一半。字节换算在上层（有簇大小）。
    pub data_alloc_clusters: Option<u64>,
    /// ADS 的同款重算合计（多条流全解成功才 Some；任一条失败整组回落 +0x28 合计）。
    pub ads_alloc_clusters: Option<u64>,
    /// `$STANDARD_INFORMATION` 里的时间与属性位（+0x00 创建 / +0x08 修改 / +0x20 属性）。
    /// 与 walk 档 `ScanFile.mtime_ms/creation_ms/attrs` 一一对位。
    pub std_creation_ms: i64,
    pub std_mtime_ms: i64,
    pub std_attrs: u32,
    /// 有 `$INDEX_ROOT` 属性 —— 目录的第二判据（与记录头 DIRECTORY 位互为印证）。
    pub has_index_root: bool,
    /// 有 `$REPARSE_POINT` —— 与 walk 档同语义：上层跳过、报 `skipped_reparse`。
    /// （MFT 里目标实体就在同一卷的同一条流里，跟了就是双计。）
    pub has_reparse: bool,
    /// `$ATTRIBUTE_LIST` 里指向**别的记录**的条目（指向自己的已滤掉）。
    pub attr_list: Vec<AttrListRef>,
    /// 记录头 +0x20 的 base 引用（低 48 位）。**非 0 = 这是一条扩展记录**，
    /// 比"反查谁的 attr_list 指向我"可靠（后者要在全部记录读完后才可能知道）。
    pub base_ref: u64,
    pub base_seq: u16,
}

/// 记录头的最小校验：签名是不是 `FILE`（0x454C4946 小端）。
/// 不对就返回 false，让上层跳过而不是猜。
pub fn looks_like_file_record(buf: &[u8]) -> bool {
    buf.len() >= 48 && u32::from_le_bytes(buf[0..4].try_into().unwrap()) == 0x454C_4946
}

/// 应用 update sequence 修正。返回 false = 两种约定都对不上（或签名不对），
/// 调用方应把这条记录按损坏计 —— **绝对不许拿着没修正的缓冲继续解析**，
/// 扇区边界上的字段（1024 记录的 0x1FE / 0x3FE 附近正是"下一个属性偏移"这种 u16）
/// 读错就是整条记录解析错位，且不会报错。
pub fn apply_update_sequence(buf: &mut [u8], sector_size: u32) -> bool {
    if !looks_like_file_record(buf) {
        return false;
    }
    let usa_offset = u16::from_le_bytes([buf[4], buf[5]]) as usize;
    let usa_count = u16::from_le_bytes([buf[6], buf[7]]) as usize; // 单位：字
    if sector_size < 2 || usa_count < 1 || usa_offset < 8 {
        return false;
    }
    let sector = sector_size as usize;
    // 要修的扇区尾是**每一个**扇区的最后 2 字节，包括最后一扇 —— i = 1..=n 共 n 个。
    // TS 第一版写成 i < usaCount，1024/512 的记录只修了第一扇、漏掉第二扇，
    // 被 B 派那条单测抓出来：漏修的 2 字节仍是 USN，读出来 11031 而不是原值。
    let n = buf.len() / sector;
    if n < 1 {
        return false;
    }
    let tails: Vec<usize> = (1..=n).map(|i| i * sector - 2).collect();

    // A 派：USA[0] 是 USN，USA[i+1] 是第 i 个扇区尾的原值（要 n+1 个字）。
    // B 派：USN 在记录头 +0x08，USA[i] 是第 i 个扇区尾的原值（要 n 个字）。
    let a_ok = usa_offset + (n + 1) * 2 <= buf.len();
    let b_ok = usa_offset + n * 2 <= buf.len();
    let usn_a = if a_ok {
        u16::from_le_bytes([buf[usa_offset], buf[usa_offset + 1]])
    } else {
        0
    };
    let usn_b = if b_ok {
        u16::from_le_bytes([buf[8], buf[9]])
    } else {
        0
    };

    // 只读一轮验证：两种约定里必须恰有一种"所有扇区尾当前值确实等于它的 USN"。
    let check = |usn: u16| -> bool {
        usn != 0 && tails.iter().all(|&t| u16::from_le_bytes([buf[t], buf[t + 1]]) == usn)
    };
    let use_a = a_ok && check(usn_a);
    let use_b = b_ok && check(usn_b);
    if use_a == use_b {
        // 两种都不成立，或两种同时成立（说明扇区大小给错了）—— 都不修。
        return false;
    }
    // 全部校验通过才真的写 —— 上面那一轮只读不写，就是为了不在失败时留下半改的缓冲。
    for (i, &t) in tails.iter().enumerate() {
        let src = if use_a { usa_offset + (i + 1) * 2 } else { usa_offset + i * 2 };
        let orig = u16::from_le_bytes([buf[src], buf[src + 1]]);
        buf[t..t + 2].copy_from_slice(&orig.to_le_bytes());
    }
    true
}

/// 低 48 位 = 记录号，高 16 位 = sequence。NTFS 文件引用就是这么打包的。
fn split_reference(v: u64) -> (u64, u16) {
    ((v & 0x0000_FFFF_FFFF_FFFF), (v >> 48) as u16)
}

/// 解析一条 MFT 记录。`buf` 必须是一条记录的长度（通常 1024）
/// **且已经过 [`apply_update_sequence`]**。
///
/// 返回 `None` 的情形：签名不是 `FILE`，或首属性偏移不合理 —— 都按损坏记录计。
/// "记录未使用"**不是** None：它返回 `in_use: false`，让上层决定怎么记账
/// （"跳过"的口径属于聚合层，不属于解析层 —— 与 TS 同一立场）。
pub fn parse_record(buf: &[u8], number: u64) -> Option<MftRecord> {
    if !looks_like_file_record(buf) {
        return None;
    }
    let sequence = u16::from_le_bytes([buf[0x10], buf[0x11]]);
    let flags = u16::from_le_bytes([buf[0x16], buf[0x17]]);
    let (base_ref, base_seq) = split_reference(u64::from_le_bytes(buf[0x20..0x28].try_into().unwrap()));
    let mut at = u16::from_le_bytes([buf[0x14], buf[0x15]]) as usize;
    // 首属性偏移不合理：不是能信的记录（TS 同款下界 42）
    if at < 42 || at >= buf.len() {
        return None;
    }

    let mut names: Vec<FileNameAttr> = Vec::new();
    let mut attr_list: Vec<AttrListRef> = Vec::new();
    let mut data_size: Option<u64> = None;
    let mut data_alloc: Option<u64> = None;
    let mut data_vcn: Option<u64> = None;
    let mut size_from_data = false;
    let mut file_name_size: Option<u64> = None;
    let mut ads_count: u64 = 0;
    let mut ads_logical: u64 = 0;
    let mut ads_alloc: u64 = 0;
    let mut data_alloc_clusters: Option<u64> = None;
    let mut ads_alloc_clusters: Option<u64> = None;
    let mut std_creation_ms = 0i64;
    let mut std_mtime_ms = 0i64;
    let mut std_attrs = 0u32;
    let mut has_index_root = false;
    let mut has_reparse = false;
    let mut dir_from_name = false;

    let len = buf.len();
    while at + 8 <= len {
        let attr_type = u32::from_le_bytes(buf[at..at + 4].try_into().unwrap());
        if attr_type == ATTR_END || attr_type == 0 {
            break;
        }
        let alen = u32::from_le_bytes(buf[at + 4..at + 8].try_into().unwrap()) as usize;
        if alen < 8 || at + alen > len {
            break; // 长度不合理 ⇒ 停在这里，不越界猜
        }
        let non_resident = buf[at + 8] == 1;
        let name_len = buf[at + 9] as usize;
        let name_off = u16::from_le_bytes([buf[at + 10], buf[at + 11]]) as usize;
        // 属性名必须整个落在本属性之内。越界说明这条记录不可信；而 `name_len == 0`
        // 正是"无名 $DATA（还是 ADS）"的判据 —— 拿一个错位的名长去判会把备用流当主数据。
        if name_len > 0 && (name_off < 8 || name_off + name_len * 2 > alen) {
            break;
        }

        let (value_len, value_off) = if non_resident {
            (0usize, u16::from_le_bytes([buf[at + 0x20], buf[at + 0x21]]) as usize)
        } else {
            (
                u32::from_le_bytes(buf[at + 0x10..at + 0x14].try_into().unwrap()) as usize,
                u16::from_le_bytes([buf[at + 0x14], buf[at + 0x15]]) as usize,
            )
        };
        let value_start = at + value_off;
        let value_end = if non_resident { at + alen } else { at + value_off + value_len };

        if attr_type == ATTR_FILE_NAME && !non_resident && value_start < value_end && value_end <= len {
            // $FILE_NAME 必须驻留。值内偏移见模块头速查表。
            if value_start + FN_NAME_TEXT <= value_end {
                let fn_flags = u32::from_le_bytes(buf[value_start + FN_FLAGS..value_start + FN_FLAGS + 4].try_into().unwrap());
                let raw_len = buf[value_start + FN_NAME_LEN] as usize;
                let namespace = buf[value_start + FN_NAME_NS];
                let name_start = value_start + FN_NAME_TEXT;
                // 名字必须整个落在值里：越界的一律不认，宁可少一个名字也不要读进下一个属性。
                if raw_len > 0 && name_start + raw_len * 2 <= value_end {
                    let name = String::from_utf16_lossy(
                        &buf[name_start..name_start + raw_len * 2]
                            .chunks_exact(2)
                            .map(|c| u16::from_le_bytes([c[0], c[1]]))
                            .collect::<Vec<u16>>(),
                    );
                    let (parent, parent_seq) =
                        split_reference(u64::from_le_bytes(buf[value_start + FN_PARENT..value_start + FN_PARENT + 8].try_into().unwrap()));
                    // "." 与 ".." 是目录自引用与父引用；index-view 那条是索引投影；
                    // DOS 8.3 别名（ns=2）是同一 (父,名) 的冗余投影 —— 三者都滤掉，
                    // 否则一个文件会被数成两个名字。POSIX / Win32&DOS / Win32 都保留。
                    let is_index_view = fn_flags & FN_FLAG_INDEX_VIEW != 0;
                    let is_self_or_parent = name == "." || name == "..";
                    let is_dos_alias = namespace == NS_DOS;
                    if !is_index_view && !is_self_or_parent && !is_dos_alias {
                        if fn_flags & FN_FLAG_DIRECTORY != 0 {
                            dir_from_name = true;
                        }
                        names.push(FileNameAttr {
                            parent,
                            parent_seq,
                            name,
                            namespace,
                            flags: fn_flags,
                            real_size: u64::from_le_bytes(buf[value_start + FN_REAL_SIZE..value_start + FN_REAL_SIZE + 8].try_into().unwrap()),
                        });
                    }
                }
                if file_name_size.is_none() {
                    file_name_size = Some(u64::from_le_bytes(buf[value_start + FN_REAL_SIZE..value_start + FN_REAL_SIZE + 8].try_into().unwrap()));
                }
            }
        } else if attr_type == ATTR_DATA && name_len == 0 {
            // 只认**无名** $DATA。带名的是备用数据流（ADS），走下面那支单独记账。
            if non_resident {
                data_size = Some(u64::from_le_bytes(buf[at + NR_REAL_SIZE..at + NR_REAL_SIZE + 8].try_into().unwrap()));
                data_alloc = Some(u64::from_le_bytes(buf[at + NR_ALLOCATED_SIZE..at + NR_ALLOCATED_SIZE + 8].try_into().unwrap()));
                data_vcn = Some(u64::from_le_bytes(buf[at + NR_STARTING_VCN..at + NR_STARTING_VCN + 8].try_into().unwrap()));
                // run list 重算占簇（sparse 段剔除）。解不动回落头字段 —— 一条
                // 畸形流不配毁掉整卷扫描。
                data_alloc_clusters = runs_alloc_clusters(buf, at, alen);
            } else {
                // 驻留：值长度就是大小（小文件直接塞在记录里）；alloc 恒 0（不另占簇）。
                data_size = Some(value_len as u64);
                data_alloc = Some(0);
                data_vcn = None;
            }
            size_from_data = true;
        } else if attr_type == ATTR_DATA && name_len > 0 {
            // ADS：非驻留 → real/allocated 从非驻留头取；驻留 → 值长/0。
            if non_resident {
                ads_logical += u64::from_le_bytes(buf[at + NR_REAL_SIZE..at + NR_REAL_SIZE + 8].try_into().unwrap());
                ads_alloc += u64::from_le_bytes(buf[at + NR_ALLOCATED_SIZE..at + NR_ALLOCATED_SIZE + 8].try_into().unwrap());
                // 重算本条 ADS 的占簇。任一条解不动 → 整组回落头字段合计。
                ads_alloc_clusters = match (ads_alloc_clusters, runs_alloc_clusters(buf, at, alen)) {
                    (acc, Some(c)) => Some(acc.unwrap_or(0) + c),
                    (_, None) => None,
                };
            } else {
                ads_logical += value_len as u64;
            }
            ads_count += 1;
        } else if attr_type == ATTR_ATTRIBUTE_LIST && !non_resident && value_start < value_end && value_end <= len {
            // 溢出清单：条目头定长 24 字节，其后是属性名与（驻留属性的）原属性头，
            // 所以整条长度按 +0x04 读。**整条必须落在值内**，越界就停。
            let mut p = value_start;
            while p + 24 <= value_end {
                let entry_len = u16::from_le_bytes([buf[p + 4], buf[p + 5]]) as usize;
                if entry_len < 24 || p + entry_len > value_end {
                    break;
                }
                let (record, record_seq) = split_reference(u64::from_le_bytes(buf[p + 0x10..p + 0x18].try_into().unwrap()));
                // 指向本记录的条目丢掉：真卷上 #3370 的清单会列出它自己已有的属性，
                // 跟着读就是自己读自己，白跑一次随机 IO。
                if record != number {
                    attr_list.push(AttrListRef {
                        attr_type: u32::from_le_bytes(buf[p..p + 4].try_into().unwrap()),
                        lower_vcn: u64::from_le_bytes(buf[p + 8..p + 16].try_into().unwrap()),
                        record,
                        record_seq,
                    });
                }
                p += entry_len;
            }
        } else if attr_type == ATTR_STANDARD_INFO && !non_resident && value_start + 0x24 <= value_end && value_end <= len {
            // $STANDARD_INFORMATION：+0x00 创建 / +0x08 修改 / +0x20 属性位。
            // 时间经现成 `filetime_to_unix_ms` 转换，与 walk 档同一把尺子。
            let created = u64::from_le_bytes(buf[value_start..value_start + 8].try_into().unwrap());
            let modified = u64::from_le_bytes(buf[value_start + 8..value_start + 16].try_into().unwrap());
            std_creation_ms = crate::enumerate::filetime_to_unix_ms(created as i64);
            std_mtime_ms = crate::enumerate::filetime_to_unix_ms(modified as i64);
            std_attrs = u32::from_le_bytes(buf[value_start + 0x20..value_start + 0x24].try_into().unwrap());
        } else if attr_type == ATTR_INDEX_ROOT {
            has_index_root = true;
        } else if attr_type == ATTR_REPARSE_POINT {
            has_reparse = true;
        }

        at += alen;
    }

    // 目录判据取位或：记录头 DIRECTORY 位 ∨ $INDEX_ROOT 存在 ∨ 任意 $FILE_NAME 目录位。
    // 三个判据都要收（tree.rs 的测试钉它们在夹具上恒一致），扩展记录合并后仍成立。
    let is_dir = flags & REC_FLAG_DIRECTORY != 0 || has_index_root || dir_from_name;

    Some(MftRecord {
        number,
        sequence,
        in_use: flags & REC_FLAG_IN_USE != 0,
        is_dir,
        names,
        data_size,
        data_alloc,
        data_starting_vcn: if size_from_data { data_vcn } else { None },
        size_from_data,
        ads_count,
        ads_logical,
        ads_alloc,
        data_alloc_clusters,
        ads_alloc_clusters,
        std_creation_ms,
        std_mtime_ms,
        std_attrs,
        has_index_root,
        has_reparse,
        attr_list,
        base_ref,
        base_seq,
    })
}

/// 无名非驻留 `$DATA` 的（起始 VCN，run list 原始字节）。
///
/// 只有 `$MFT` 流读取（`stream.rs`）用它：记录 0 的这份 run list 就是 **$MFT 自身的
/// 盘区映射** —— TS 版按"$MFT 起始簇 + 记录号 × 记录大小"线性推偏移，隐含"$MFT 连续"
/// 假设，真机只读到 12%（`docs/benchmarks/results.md` §10.4），根治点全在这。
/// 返回 `None` = 没有无名非驻留 `$DATA`（真卷记录 0 必有；夹具写错会在这里响）。
pub fn unnamed_data_runs(buf: &[u8]) -> Option<(u64, &[u8])> {
    if !looks_like_file_record(buf) {
        return None;
    }
    let mut at = u16::from_le_bytes([buf[0x14], buf[0x15]]) as usize;
    if at < 42 || at >= buf.len() {
        return None;
    }
    let len = buf.len();
    while at + 8 <= len {
        let attr_type = u32::from_le_bytes(buf[at..at + 4].try_into().unwrap());
        if attr_type == ATTR_END || attr_type == 0 {
            break;
        }
        let alen = u32::from_le_bytes(buf[at + 4..at + 8].try_into().unwrap()) as usize;
        if alen < 8 || at + alen > len {
            break;
        }
        // $MFT 的 $DATA 恒无名且非驻留；驻留的（或带名的）说明这根本不是记录 0 的形状。
        if attr_type == ATTR_DATA && buf[at + 8] == 1 && buf[at + 9] == 0 {
            let start_vcn =
                u64::from_le_bytes(buf[at + NR_STARTING_VCN..at + NR_STARTING_VCN + 8].try_into().unwrap());
            let run_off = u16::from_le_bytes([buf[at + 0x20], buf[at + 0x21]]) as usize;
            // run list 占 [run_off, alen)；起点必须落在属性头之后才可信
            if run_off >= 0x10 && run_off < alen {
                return Some((start_vcn, &buf[at + run_off..at + alen]));
            }
            return None;
        }
        at += alen;
    }
    None
}

/// 非驻留流的 run list 重算：Σ **有 LCN** 的段簇数（sparse 段 `lcn=None` 不占簇）。
///
/// 头 +0x28 的 allocated 对 sparse 流报**名义值**（含 sparse 段），只有 run list
/// 才是"真占了哪些簇"的权威。普通流（无 sparse 段）重算值与头字段相等 —— 统一走
/// 重算无损。切片覆盖 `[at+runs_off, at+alen)`：run list 以终止符结束，8 对齐的
/// 尾垫在终止符之后，`decode_runs` 停在终止符不吞垫。解不动 → `None`（回落头字段）。
fn runs_alloc_clusters(buf: &[u8], at: usize, alen: usize) -> Option<u64> {
    if alen <= NR_DATA_RUNS_OFFSET {
        return None;
    }
    let run_off = u16::from_le_bytes([buf[at + NR_DATA_RUNS_OFFSET], buf[at + NR_DATA_RUNS_OFFSET + 1]]) as usize;
    if run_off < NR_DATA_RUNS_OFFSET || at + run_off > at + alen || at + alen > buf.len() {
        return None;
    }
    let (runs, _) = decode_runs(&buf[at + run_off..at + alen]).ok()?;
    Some(runs.iter().filter(|r| r.lcn.is_some()).map(|r| r.clusters).sum())
}

/// 把扩展记录合并进基记录，返回**新的**记录对象（不改入参 —— 改了就分不清哪条是盘上原样）。
///
/// 需要它的原因不是理论，是实测（TS 注释原文）：真机 100,344 条记录里 925 条带
/// `$ATTRIBUTE_LIST`，其中 923 条本记录内没有非驻留 `$DATA` —— 不跟扩展记录，这批文件的
/// 大小只能取 `$FILE_NAME` 里那份缓存（pagefile.sys 因此报 0 字节，而它的 `$DATA` 在
/// #13120：real 9,714,868,224）。偏偏这批就是又大又碎的文件。
///
/// 三条合并规则各挡一种真实错法：
///  1. **大小只认起始 VCN = 0 的那一段。** 流按 VCN 切成片段散在多条记录里，只有头一段带
///     真实大小，其余段的大小是那一段自己的 —— 拿来用就是把碎片当全量。（这是**头字段**
///     的规则；run list 重算恰好相反，必须分片求和 —— 见函数尾。）
///  2. 基记录已有 `$DATA` 时**不覆盖**，扩展只补名字。
///  3. 名字按 (父记录号, 名) 去重：硬链接的其余名字往往就住在扩展记录里，不跟就漏链接。
pub fn apply_extensions(base: MftRecord, exts: &[MftRecord]) -> MftRecord {
    if exts.is_empty() {
        return base;
    }
    let mut merged = base.clone();
    let mut seen: std::collections::HashSet<(u64, &str)> =
        base.names.iter().map(|n| (n.parent, n.name.as_str())).collect();

    for ext in exts {
        for n in &ext.names {
            if seen.insert((n.parent, n.name.as_str())) {
                merged.names.push(n.clone());
            }
        }
        // 大小：基记录没从 $DATA 拿到、扩展从 VCN=0 那段拿到了 → 才接。alloc 跟着同段走
        // （碎片流里只有头一段带全量，取碎片自己那格就是把零头当全量）。
        if !merged.size_from_data && ext.size_from_data && ext.data_starting_vcn == Some(0) {
            merged.data_size = ext.data_size;
            merged.data_alloc = ext.data_alloc;
            merged.data_alloc_clusters = ext.data_alloc_clusters;
            merged.data_starting_vcn = ext.data_starting_vcn;
            merged.size_from_data = true;
        }
        merged.is_dir = merged.is_dir || ext.is_dir;
        merged.has_index_root = merged.has_index_root || ext.has_index_root;
        merged.has_reparse = merged.has_reparse || ext.has_reparse;
        merged.ads_count += ext.ads_count;
        merged.ads_logical += ext.ads_logical;
        merged.ads_alloc += ext.ads_alloc;
        // 重算合计跟着 ADS 合计走：双方都解成功才继续 Some，任一 None 整组回落。
        merged.ads_alloc_clusters = match (merged.ads_alloc_clusters, ext.ads_alloc_clusters) {
            (Some(a), Some(b)) => Some(a + b),
            _ => None,
        };
    }
    // ── 无名 $DATA 的 run list 重算：分片求和 ──
    // 「VCN=0 段 +0x28 报全量」是**头字段**的事实；run list 重算只盖**本记录**里那段
    // VCN —— 流被 $ATTRIBUTE_LIST 切进扩展记录时（大而碎的文件常态），每条记录只解出
    // 自己那部分，逐段求和（各段 VCN 不相交）才是全流真占用。任一段解不动 → None，
    // 上层回落 VCN=0 段的 +0x28 头字段（它仍报全流总量）。ADS 逐条累加天然成立，不在此列。
    let mut vcn0: Option<Option<u64>> = None;
    let mut continued: Vec<Option<u64>> = Vec::new();
    match base.data_starting_vcn {
        Some(0) => vcn0 = Some(base.data_alloc_clusters),
        Some(_) => continued.push(base.data_alloc_clusters),
        None => {}
    }
    for e in exts {
        match e.data_starting_vcn {
            Some(0) => vcn0 = Some(e.data_alloc_clusters),
            Some(_) => continued.push(e.data_alloc_clusters),
            None => {}
        }
    }
    if let Some(v0) = vcn0 {
        merged.data_alloc_clusters = if continued.is_empty() {
            v0
        } else {
            let parts = std::iter::once(v0).chain(continued.iter().copied());
            if parts.clone().all(|p| p.is_some()) {
                Some(parts.filter_map(|p| p).sum())
            } else {
                None
            }
        };
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mft::testutil::{
        attr_list_attr, file_name_attr, file_record, index_root_attr, nonresident_data,
        resident_attr, reparse_attr, standard_info_attr, RunSpec, RecordSpec,
    };

    const SECTOR: u32 = 512;
    const RECORD_BYTES: usize = 1024;

    /// 双 $FILE_NAME（Win32&DOS 主名 + DOS 别名）+ 驻留数据，未过 USA 编码的最简记录体。
    fn simple_file_record() -> Vec<u8> {
        file_record(&RecordSpec {
            sequence: 7,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(1_000, 2_000, 0x20),
                file_name_attr(pack_ref(5, 3), 100, 4096, 0, "报告.txt", NS_WIN32_AND_DOS),
                file_name_attr(pack_ref(5, 3), 100, 4096, 0, "REPORT~1.TXT", NS_DOS),
                resident_attr(ATTR_DATA, b"hello world"),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        })
    }

    fn pack_ref(number: u64, seq: u16) -> u64 {
        ((seq as u64) << 48) | number
    }

    fn parse_ok(raw: &[u8], number: u64) -> MftRecord {
        let mut buf = raw.to_vec();
        assert!(apply_update_sequence(&mut buf, SECTOR), "夹具记录必须过 fixup");
        parse_record(&buf, number).expect("夹具记录必须能解析")
    }

    #[test]
    fn update_sequence_fixes_both_sector_tails() {
        let raw = simple_file_record();
        let mut buf = raw.clone();
        assert!(apply_update_sequence(&mut buf, SECTOR));
        // 两个扇区尾都必须被修回原值（0），不能还留着 USN。
        assert_eq!(&buf[0x1FE..0x200], &[0, 0], "第一扇区尾要修");
        assert_eq!(&buf[0x3FE..0x400], &[0, 0], "第二扇区尾也要修 —— TS 第一版只修了第一个");
        // 修正后能正常解析出两个名字 + 大小。
        let rec = parse_record(&buf, 42).unwrap();
        assert_eq!(rec.number, 42);
        assert_eq!(rec.sequence, 7);
        assert!(rec.in_use);
        assert!(!rec.is_dir);
        assert_eq!(rec.names.len(), 1, "DOS 别名必须被滤掉");
        assert_eq!(rec.names[0].name, "报告.txt");
        assert_eq!(rec.names[0].parent, 5);
        assert_eq!(rec.names[0].parent_seq, 3);
        assert_eq!(rec.data_size, Some(11), "驻留 $DATA 的值长就是大小");
        assert_eq!(rec.data_alloc, Some(0), "驻留流不另占簇");
    }

    #[test]
    fn b_convention_fixup_is_also_accepted() {
        // B 派：USN 在记录头 +0x08，USA[0..] 全是扇区尾原值。
        let raw = file_record(&RecordSpec {
            sequence: 1,
            flags: 0x0001,
            base_ref: 0,
            usa_b: true,
            attrs: vec![resident_attr(ATTR_DATA, b"x")],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let mut buf = raw;
        assert!(apply_update_sequence(&mut buf, SECTOR), "B 派约定必须被接受");
        assert_eq!(&buf[0x1FE..0x200], &[0, 0]);
        assert_eq!(&buf[0x3FE..0x400], &[0, 0]);
    }

    #[test]
    fn mismatched_tails_are_rejected_not_rewritten() {
        let raw = simple_file_record();
        let mut buf = raw;
        // 把第一个扇区尾的 USN 改掉 → A 派验证失败 → 整条拒。
        buf[0x1FE] ^= 0xFF;
        assert!(!apply_update_sequence(&mut buf, SECTOR));
        // 拒绝时**不许有半改的缓冲**：第二扇区尾仍是 USN 原样。
        assert_eq!(u16::from_le_bytes([buf[0x3FE], buf[0x3FF]]), 0xAAAA);
    }

    #[test]
    fn zero_usn_is_never_a_valid_convention() {
        // USA[0] = 0：A 派判据里 usn == 0 不成立（真卷 USN 不会是 0）。
        let raw = file_record(&RecordSpec {
            sequence: 1,
            flags: 0,
            base_ref: 0,
            usa_b: false,
            attrs: vec![],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let mut buf = raw;
        buf[0x30] = 0;
        buf[0x31] = 0;
        assert!(!apply_update_sequence(&mut buf, SECTOR));
    }

    #[test]
    fn non_magic_buffer_is_rejected() {
        let mut buf = vec![0u8; RECORD_BYTES];
        assert!(!apply_update_sequence(&mut buf, SECTOR));
        assert_eq!(parse_record(&buf, 1), None);
    }

    /// 非驻留 $DATA：+0x28 = allocated、+0x30 = real。夹具两值不同，
    /// 实现若读了 +0x2C（TS 第一错的格子）读到的是横跨两字段的错值，这条当场红。
    #[test]
    fn nonresident_sizes_come_from_0x28_and_0x30() {
        let runs = crate::mft::testutil::run_list(&[RunSpec::Data { delta: 100, clusters: 10 }]);
        let data = nonresident_data(&crate::mft::testutil::NonResidentSpec {
            start_vcn: 0,
            last_vcn: 9,
            alloc: 10 * 512,
            real: 3_917,
            initialized: 3_917,
            runs,
        });
        let raw = file_record(&RecordSpec {
            sequence: 2,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                file_name_attr(pack_ref(5, 1), 3_917, 10 * 512, 0, "big.bin", NS_WIN32_AND_DOS),
                data,
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let rec = parse_ok(&raw, 9);
        assert_eq!(rec.data_size, Some(3_917), "real 来自 +0x30");
        assert_eq!(rec.data_alloc, Some(5_120), "allocated 来自 +0x28");
        assert_eq!(rec.data_starting_vcn, Some(0));
        assert!(rec.size_from_data);
    }

    /// sparse 混合流：头 +0x28 报**名义值**（全段合计），run list 重算剔除 sparse 段。
    /// `$UsnJrnl:$J`（Trim 后实占≈0）与 `$BadClus:$BAD`（名义映射整卷）的口径修正，
    /// 都靠 `data_alloc_clusters` 这一格 —— 2026-10-18 D 盘 802GB 事故的根治点。
    #[test]
    fn sparse_runs_are_excluded_from_alloc_clusters() {
        let runs = crate::mft::testutil::run_list(&[
            RunSpec::Sparse { clusters: 10 },
            RunSpec::Data { delta: 100, clusters: 5 },
        ]);
        let data = nonresident_data(&crate::mft::testutil::NonResidentSpec {
            start_vcn: 0,
            last_vcn: 14,
            alloc: 15 * 512,
            real: 5 * 512,
            initialized: 5 * 512,
            runs,
        });
        let raw = file_record(&RecordSpec {
            sequence: 2,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                file_name_attr(pack_ref(5, 1), 5 * 512, 15 * 512, 0, "sparse.bin", NS_WIN32_AND_DOS),
                data,
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let rec = parse_ok(&raw, 7);
        assert_eq!(rec.data_alloc, Some(15 * 512), "头字段如实交出（名义值）");
        assert_eq!(rec.data_alloc_clusters, Some(5), "重算剔除 sparse 段 —— 上层按簇大小换算");
    }

    /// 硬链接：一条记录两个合法 Win32 名、不同父目录 → 都要收（去重是聚合层按记录号做的事）。
    #[test]
    fn hardlink_names_are_all_kept() {
        let raw = file_record(&RecordSpec {
            sequence: 3,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                file_name_attr(pack_ref(5, 1), 10, 4096, 0, "a.txt", NS_WIN32_AND_DOS),
                file_name_attr(pack_ref(6, 1), 10, 4096, 0, "b.txt", NS_WIN32_AND_DOS),
                resident_attr(ATTR_DATA, b"12345"),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let rec = parse_ok(&raw, 77);
        assert_eq!(rec.names.len(), 2);
        assert_eq!(rec.names[0].parent, 5);
        assert_eq!(rec.names[1].parent, 6);
    }

    /// index-view 位与 "." / ".." 全部滤掉 —— 同一对 (父,名) 在索引里会出现两次。
    #[test]
    fn index_view_and_self_names_are_filtered() {
        let raw = file_record(&RecordSpec {
            sequence: 4,
            flags: 0x0003, // 目录位也带上
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                file_name_attr(pack_ref(5, 1), 0, 0, FN_FLAG_INDEX_VIEW, ".", NS_WIN32_AND_DOS),
                file_name_attr(pack_ref(5, 1), 0, 0, FN_FLAG_INDEX_VIEW, "..", NS_WIN32_AND_DOS),
                file_name_attr(pack_ref(5, 1), 0, 0, 0, "真实目录", NS_WIN32_AND_DOS),
                index_root_attr(),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let rec = parse_ok(&raw, 5);
        assert_eq!(rec.names.len(), 1);
        assert_eq!(rec.names[0].name, "真实目录");
        assert!(rec.is_dir, "记录头目录位");
        assert!(rec.has_index_root, "$INDEX_ROOT 在场");
    }

    /// 目录判据三条位或：只有 $INDEX_ROOT（记录头无目录位）也要判成目录。
    #[test]
    fn index_root_alone_makes_a_directory() {
        let raw = file_record(&RecordSpec {
            sequence: 5,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                file_name_attr(pack_ref(5, 1), 0, 0, 0, "odd.dir", NS_WIN32_AND_DOS),
                index_root_attr(),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let rec = parse_ok(&raw, 500);
        assert!(rec.is_dir);
    }

    /// ADS 分账：带名 $DATA 不混进 data_size，但 allocated 要记。
    #[test]
    fn ads_is_accounted_separately() {
        let raw = file_record(&RecordSpec {
            sequence: 6,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                file_name_attr(pack_ref(5, 1), 5, 4096, 0, "with-ads.txt", NS_WIN32_AND_DOS),
                resident_attr(ATTR_DATA, b"12345"),
                crate::mft::testutil::named_resident_attr(ATTR_DATA, "Zone.Identifier", b"[ZoneTransfer]"),
                // 非驻留 ADS：类型仍是 $DATA 但带名 —— named_nonresident_data 就是干这个的
                crate::mft::testutil::named_nonresident_data(
                    "Zone.Identifier",
                    &crate::mft::testutil::NonResidentSpec {
                        start_vcn: 0,
                        last_vcn: 1,
                        alloc: 1024,
                        real: 600,
                        initialized: 600,
                        runs: crate::mft::testutil::run_list(&[RunSpec::Data { delta: 50, clusters: 2 }]),
                    },
                ),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let rec = parse_ok(&raw, 88);
        assert_eq!(rec.data_size, Some(5), "无名流不受 ADS 影响");
        assert_eq!(rec.ads_count, 2, "驻留 ADS 一条 + 非驻留 ADS 一条");
        assert_eq!(rec.ads_alloc, 1024, "ADS 只进 allocated 口径");
        assert_eq!(rec.ads_logical, 14 + 600, "14 = b\"[ZoneTransfer]\" 的长度");
    }

    /// $ATTRIBUTE_LIST：条目解出、指向自己的滤掉。
    #[test]
    fn attribute_list_entries_are_parsed_and_self_refs_dropped() {
        let entries = vec![
            crate::mft::testutil::AttrListEntry { attr_type: ATTR_DATA, lower_vcn: 0, record_ref: pack_ref(13120, 14) },
            crate::mft::testutil::AttrListEntry { attr_type: ATTR_FILE_NAME, lower_vcn: 0, record_ref: pack_ref(88, 1) }, // 自己
        ];
        let raw = file_record(&RecordSpec {
            sequence: 9,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                file_name_attr(pack_ref(5, 1), 9_714_868_224, 9_714_937_856, 0, "pagefile.sys", NS_WIN32_AND_DOS),
                attr_list_attr(&entries),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let rec = parse_ok(&raw, 88);
        assert_eq!(rec.attr_list.len(), 1, "指向自己的条目要滤");
        assert_eq!(rec.attr_list[0].record, 13120);
        assert_eq!(rec.attr_list[0].record_seq, 14);
        assert_eq!(rec.attr_list[0].lower_vcn, 0);
    }

    /// 扩展记录合并三条规则。
    #[test]
    fn extension_merge_follows_the_three_rules() {
        let mut base = parse_ok(
            &file_record(&RecordSpec {
                sequence: 9,
                flags: 0x0001,
                base_ref: 0,
                usa_b: false,
                attrs: vec![
                    standard_info_attr(0, 0, 0),
                    file_name_attr(pack_ref(5, 1), 9_714_868_224, 0, 0, "pagefile.sys", NS_WIN32_AND_DOS),
                ],
                record_bytes: RECORD_BYTES,
                sector: SECTOR,
            }),
            88,
        );
        base.attr_list = vec![AttrListRef { attr_type: ATTR_DATA, lower_vcn: 0, record: 13120, record_seq: 14 }];
        assert!(!base.size_from_data, "基记录没有 $DATA（正是 pagefile 的真机形态）");

        // 扩展记录：VCN=0 的 $DATA（9.05 GB）+ 硬链接别名
        let ext_vcn0 = parse_ok(
            &file_record(&RecordSpec {
                sequence: 14,
                flags: 0x0001,
                base_ref: pack_ref(88, 9),
                usa_b: false,
                attrs: vec![
                    file_name_attr(pack_ref(6, 1), 0, 0, 0, "pagefile.sys", NS_WIN32_AND_DOS),
                    nonresident_data(&crate::mft::testutil::NonResidentSpec {
                        start_vcn: 0,
                        last_vcn: 999,
                        alloc: 9_714_937_856,
                        real: 9_714_868_224,
                        initialized: 9_714_868_224,
                        runs: crate::mft::testutil::run_list(&[RunSpec::Data { delta: 5000, clusters: 2000 }]),
                    }),
                ],
                record_bytes: RECORD_BYTES,
                sector: SECTOR,
            }),
            13120,
        );
        // 另一条扩展：VCN=2 的碎片段（大小是那一段自己的零头，不许当全量）
        let ext_vcn2 = parse_ok(
            &file_record(&RecordSpec {
                sequence: 15,
                flags: 0x0001,
                base_ref: pack_ref(88, 9),
                usa_b: false,
                attrs: vec![nonresident_data(&crate::mft::testutil::NonResidentSpec {
                    start_vcn: 2,
                    last_vcn: 3,
                    alloc: 4096,
                    real: 4096,
                    initialized: 4096,
                    runs: crate::mft::testutil::run_list(&[RunSpec::Data { delta: 7000, clusters: 2 }]),
                })],
                record_bytes: RECORD_BYTES,
                sector: SECTOR,
            }),
            13121,
        );

        let merged = apply_extensions(base, &[ext_vcn2, ext_vcn0]);
        assert_eq!(merged.data_size, Some(9_714_868_224), "大小只认 VCN=0 段");
        assert_eq!(merged.data_alloc, Some(9_714_937_856), "allocated 跟着同段走");
        assert_eq!(
            merged.data_alloc_clusters,
            Some(2000 + 2),
            "run list 重算必须分片求和：VCN=0 段 2000 簇 + VCN=2 段 2 簇 —— 头字段规则的反面"
        );
        assert_eq!(merged.names.len(), 2, "扩展里的硬链接名要收");
        assert!(merged.size_from_data);
    }

    /// 基记录自带 VCN=0 段、续段在扩展记录里 —— 真机 11.03GB 欠账的形态。
    /// 重算合并前基记录只解出自己那段；合并后必须等于全流（分片之和），
    /// 且续段解不动时回落 VCN=0 段头字段（报全流总量）而不是拿碎片凑数。
    #[test]
    fn fragmented_stream_sums_recalc_and_falls_back_to_vcn0_header() {
        // 基记录：VCN=0 段 3 簇，头字段报全流 5 簇（NTFS：头段带全量）
        let base = parse_ok(
            &file_record(&RecordSpec {
                sequence: 3,
                flags: 0x0001,
                base_ref: 0,
                usa_b: false,
                attrs: vec![
                    standard_info_attr(0, 0, 0),
                    file_name_attr(pack_ref(5, 1), 5 * 512 - 100, 0, 0, "big.bin", NS_WIN32_AND_DOS),
                    nonresident_data(&crate::mft::testutil::NonResidentSpec {
                        start_vcn: 0,
                        last_vcn: 4,
                        alloc: 5 * 512,
                        real: 5 * 512 - 100,
                        initialized: 5 * 512 - 100,
                        runs: crate::mft::testutil::run_list(&[RunSpec::Data { delta: 100, clusters: 3 }]),
                    }),
                ],
                record_bytes: RECORD_BYTES,
                sector: SECTOR,
            }),
            20,
        );
        assert_eq!(base.data_alloc_clusters, Some(3), "合并前基记录只解出自己那段");

        // 续段：VCN=3..5 的 2 簇
        let ext = parse_ok(
            &file_record(&RecordSpec {
                sequence: 4,
                flags: 0x0001,
                base_ref: pack_ref(20, 3),
                usa_b: false,
                attrs: vec![nonresident_data(&crate::mft::testutil::NonResidentSpec {
                    start_vcn: 3,
                    last_vcn: 4,
                    alloc: 2 * 512,
                    real: 2 * 512,
                    initialized: 2 * 512,
                    runs: crate::mft::testutil::run_list(&[RunSpec::Data { delta: 900, clusters: 2 }]),
                })],
                record_bytes: RECORD_BYTES,
                sector: SECTOR,
            }),
            21,
        );
        let merged = apply_extensions(base.clone(), &[ext.clone()]);
        assert_eq!(
            merged.data_alloc_clusters,
            Some(5),
            "3 + 2 = 全流 5 簇 —— 真机 11.03GB 欠账的根治点"
        );
        assert_eq!(merged.data_alloc, Some(5 * 512), "头字段保持 VCN=0 段的全流口径");

        // 续段 run list 解不动（空 run list）→ 整组回落头字段，不许拿基础段 3 簇凑数
        let broken = parse_ok(
            &file_record(&RecordSpec {
                sequence: 4,
                flags: 0x0001,
                base_ref: pack_ref(20, 3),
                usa_b: false,
                attrs: vec![nonresident_data(&crate::mft::testutil::NonResidentSpec {
                    start_vcn: 3,
                    last_vcn: 4,
                    alloc: 2 * 512,
                    real: 2 * 512,
                    initialized: 2 * 512,
                    runs: Vec::new(),
                })],
                record_bytes: RECORD_BYTES,
                sector: SECTOR,
            }),
            21,
        );
        assert_eq!(broken.data_alloc_clusters, None, "空 run list 解不出任何段");
        let merged_fallback = apply_extensions(base, &[broken]);
        assert_eq!(
            merged_fallback.data_alloc_clusters, None,
            "续段解不动 → 重算整组失效"
        );
        assert_eq!(
            merged_fallback.data_alloc,
            Some(5 * 512),
            "回落 VCN=0 段头字段 —— 它仍报全流总量"
        );
    }

    #[test]
    fn base_data_wins_over_extension() {
        let mut base = parse_ok(
            &file_record(&RecordSpec {
                sequence: 1,
                flags: 0x0001,
                base_ref: 0,
                usa_b: false,
                attrs: vec![
                    standard_info_attr(0, 0, 0),
                    file_name_attr(pack_ref(5, 1), 11, 4096, 0, "own.bin", NS_WIN32_AND_DOS),
                    resident_attr(ATTR_DATA, b"hello there"),
                ],
                record_bytes: RECORD_BYTES,
                sector: SECTOR,
            }),
            10,
        );
        base.attr_list = vec![AttrListRef { attr_type: ATTR_DATA, lower_vcn: 0, record: 11, record_seq: 1 }];
        let ext = parse_ok(
            &file_record(&RecordSpec {
                sequence: 1,
                flags: 0x0001,
                base_ref: pack_ref(10, 1),
                usa_b: false,
                attrs: vec![nonresident_data(&crate::mft::testutil::NonResidentSpec {
                    start_vcn: 0,
                    last_vcn: 0,
                    alloc: 999_999,
                    real: 999_999,
                    initialized: 999_999,
                    runs: crate::mft::testutil::run_list(&[RunSpec::Data { delta: 900, clusters: 3 }]),
                })],
                record_bytes: RECORD_BYTES,
                sector: SECTOR,
            }),
            11,
        );
        let merged = apply_extensions(base, &[ext]);
        assert_eq!(merged.data_size, Some(11), "基记录已有 $DATA 时不覆盖");
    }

    /// $STANDARD_INFORMATION 的时间要转成 unix 毫秒（与 walk 档同一把尺子）。
    #[test]
    fn std_info_times_are_unix_ms() {
        let raw = file_record(&RecordSpec {
            sequence: 1,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(1_767_225_600_000, 1_800_000_000_000, 0x2020),
                file_name_attr(pack_ref(5, 1), 0, 0, 0, "t.txt", NS_WIN32_AND_DOS),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let rec = parse_ok(&raw, 300);
        assert_eq!(rec.std_creation_ms, 1_767_225_600_000);
        assert_eq!(rec.std_mtime_ms, 1_800_000_000_000);
        assert_eq!(rec.std_attrs, 0x2020);
    }

    #[test]
    fn reparse_point_is_flagged() {
        let raw = file_record(&RecordSpec {
            sequence: 1,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                file_name_attr(pack_ref(5, 1), 0, 0, 0, "link", NS_WIN32_AND_DOS),
                reparse_attr(),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let rec = parse_ok(&raw, 400);
        assert!(rec.has_reparse);
        assert!(!rec.is_dir);
    }

    #[test]
    fn base_ref_is_parsed_from_header() {
        let raw = file_record(&RecordSpec {
            sequence: 14,
            flags: 0x0001,
            base_ref: pack_ref(88, 9),
            usa_b: false,
            attrs: vec![resident_attr(ATTR_DATA, b"ext")],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let rec = parse_ok(&raw, 13120);
        assert_eq!(rec.base_ref, 88);
        assert_eq!(rec.base_seq, 9);
    }

    #[test]
    fn deleted_record_is_not_in_use() {
        let raw = file_record(&RecordSpec {
            sequence: 1,
            flags: 0x0000, // 无 IN_USE 位
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                file_name_attr(pack_ref(5, 1), 5, 4096, 0, "ghost.txt", NS_WIN32_AND_DOS),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let rec = parse_ok(&raw, 999);
        assert!(!rec.in_use, "上层必须整条跳过");
        assert_eq!(rec.names.len(), 1, "解析层照常交出字段，口径归聚合层");
    }

    #[test]
    fn absurd_attribute_offset_is_none() {
        let mut buf = vec![0u8; RECORD_BYTES];
        buf[0..4].copy_from_slice(b"FILE");
        buf[0x14..0x16].copy_from_slice(&3u16.to_le_bytes()); // < 42
        assert_eq!(parse_record(&buf, 1), None);
    }

    /// $MFT 流读取的入口：记录 0 的无名非驻留 $DATA run list 能被原样取出并解码。
    /// 碎片两段（相对增量 +8、+4）钉住解码结果 —— stream.rs 的盘区映射就吃这份字节。
    #[test]
    fn mft_record0_run_list_is_extractable() {
        use crate::mft::runs::{decode_runs, Run};
        let runs = crate::mft::testutil::run_list(&[
            crate::mft::testutil::RunSpec::Data { delta: 8, clusters: 2 },
            crate::mft::testutil::RunSpec::Data { delta: 4, clusters: 3 },
        ]);
        let raw = file_record(&RecordSpec {
            sequence: 1,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                nonresident_data(&crate::mft::testutil::NonResidentSpec {
                    start_vcn: 0,
                    last_vcn: 4,
                    alloc: 5 * 512,
                    real: 5 * RECORD_BYTES as u64,
                    initialized: 5 * RECORD_BYTES as u64,
                    runs: runs.clone(),
                }),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let mut buf = raw;
        assert!(apply_update_sequence(&mut buf, SECTOR));
        let (start_vcn, run_bytes) = unnamed_data_runs(&buf).expect("记录 0 必须有非驻留 $DATA");
        assert_eq!(start_vcn, 0);
        let (decoded, used) = decode_runs(run_bytes).expect("取出的 run list 要能解");
        assert_eq!(
            decoded,
            vec![
                Run { lcn: Some(8), clusters: 2 },
                Run { lcn: Some(12), clusters: 3 },
            ]
        );
        assert_eq!(used, runs.len(), "终止符必须取出来（切片可能带 8 对齐的尾垫）");
    }

    /// 驻留或带名的 $DATA 都不是 $MFT 的形状 —— 必须回 None 而不是猜。
    #[test]
    fn resident_or_named_data_is_not_mft_runs() {
        let raw = file_record(&RecordSpec {
            sequence: 1,
            flags: 0x0001,
            base_ref: 0,
            usa_b: false,
            attrs: vec![
                standard_info_attr(0, 0, 0),
                resident_attr(ATTR_DATA, b"tiny"),
            ],
            record_bytes: RECORD_BYTES,
            sector: SECTOR,
        });
        let mut buf = raw;
        assert!(apply_update_sequence(&mut buf, SECTOR));
        assert_eq!(unnamed_data_runs(&buf), None, "驻留 $DATA 不是盘区映射");
    }
}
