/**
 * NTFS `$MFT` 记录解析器 —— **纯函数，零 `node:fs`**。
 *
 * ## 为什么要走 MFT
 *
 * 2026-10-09 实测：`C:\pagefile.sys` 一个文件 **9.27 GB**，而地图合计比盘上已用少 9.3 GB ——
 * 缺口就是它。原因不是权限：`fs.stat` 在 Windows 上会先 `CreateFile(FILE_READ_ATTRIBUTES)`
 * **打开**目标再问大小，页面文件被系统独占，打开即 EPERM；而 `FindFirstFile`/`FindNextFile`
 * （父目录枚举）根本不打开文件，大小就在目录项里 —— PowerShell 能读到，Node 的 `readdir`
 * 也走了这条路，只是 Node 没把大小交给我们。
 *
 * MFT 是同一件事的彻底版：**每条文件记录里直接写着大小**，不需要对每个文件发一次 syscall。
 * 所以它同时解决"看不见"（pagefile、WindowsApps、System Volume Information 全在 MFT 里）
 * 和"慢"（实测每条 `stat` 0.233 ms，真盘 45 万条 ≈ 105 s，占净扫描 164.9 s 的六成）。
 * 对标工具 SpaceSniffer 的快与全就是这个来源。
 *
 * ## 三条设计约束
 *
 * 1. **这一层不碰文件系统。** 读字节是 `volume.ts` 的事。纯函数才可能在没有管理员权限的机器上
 *    被单测覆盖 —— 而本机实测 `\\.\C:` 打开就是 EPERM，**拿不到一条真记录**，所以能测的部分
 *    只能靠手搓字节测（`tests/unit/ntfs-mft.test.ts`）。
 * 2. **口径是"表观大小"，与全仓一致。** 文件的 `apparentSize` 取 **`$DATA` 的 `ActualLength`**，
 *    不是 `$FILE_NAME` 里那份 real size。两者可以不一致（`$FILE_NAME` 那份是索引项里的缓存，
 *  取证领域是已知会陈旧的），而 `readdir` 路线给出的 `stat().size` 就是 `$DATA` 那一族，
 *    所以只有取 `$DATA` 才和现有扫描**可比**。目录恒 0（NTFS 的目录大小无意义，
 *    Explorer 也显示 0）。
 * 3. **硬链接按记录去重，且只归给一个父。** 一条记录可以带多个 `$FILE_NAME`（不同父目录 =
 *    真硬链接）。按记录数大小就天然不重复 —— 这正是 `readdir` 路线做不到、V0.6 要靠
 *    `(dev,ino)` 补的那件事。但聚合到目录树时必须**只挑一个父**记账，其余记成 alias，
 *    否则两个目录都算它一份、合计就翻倍。
 *
 * ## 还没做、也故意不假装做了的
 *
 * - **压缩文件（LZNT1）**：`$DATA` 的 `ActualLength` 是**逻辑**大小，磁盘占用另算。
 *   本项目口径就是表观大小，所以逻辑大小是对的 —— 但"压缩单元/稀疏"相关的分支没测过，
 *   遇到 `NONSECURE`/压缩标志时这里不报错、也不声称准。
 * - **`$DATA` 多流**：只取**无名**那条（`$DATA` 带名字的是备用数据流，不该算进文件大小）。
 * - **文件扩展记录**（base record 引用非自身的记录，常见于超长文件名）：本层只解析单条记录，
 *   跨记录拼接在 `tree.ts` 里以"取到大小就认，取不到退回 `$FILE_NAME` 那份"的方式兜住，
 *   没有实现完整的 attribute list 重组。**这一条在对账时必须盯**，它是 MFT 侧偏小的合法来源。
 */

/** `$FILE_NAME` 里名字段的命名空间。3 = Win32 与 DOS 都可用，是我们要的那一条。 */
export const NS_POSIX = 0
export const NS_WIN32_AND_DOS = 1
export const NS_DOS = 2
export const NS_WIN32 = 3

/** `$FILE_NAME` 值里的属性标志位（与文件属性同源，不是记录头的 flags）。 */
const FN_FLAG_DIRECTORY = 0x10
/** 目录索引视图里的那一条名字（"." / ".." 就属于这类），不是文件在父目录里的真名。 */
const FN_FLAG_INDEX_VIEW = 0x40

const ATTR_END = 0xffffffff
const ATTR_STANDARD_INFO = 0x10
/**
 * `$ATTRIBUTE_LIST`：一条记录的属性装不下（>1024 字节）时，溢出的属性搬去**别的记录**，
 * 本记录里留这张"清单"。清单条目 24/32/40 字节，头 24 字节固定：
 * `+0x00 类型 u32 / +0x04 条目长 u16 / +0x06 名长 u8 / +0x07 名是否驻留 u8 /
 *  +0x08 起始 VCN u64 / +0x10 所在记录号 u48 + sequence u16`。
 * 本机真卷实测：#13120 的头 +0x20 低 48 位 = 3370、高 16 位 = 14，与 #3370 的
 * 记录号与 sequence 逐位吻合 ⇒ 基记录引用在头 +0x20（不是 +0x28，那格是下一个属性 ID）。
 */
const ATTR_ATTRIBUTE_LIST = 0x20
const ATTR_FILE_NAME = 0x30
const ATTR_DATA = 0x80

/**
 * 记录头 flags（offset 0x16）。名字照 Microsoft `FILE_RECORD_SEGMENT_HEADER` 的文档写：
 * `FILE_RECORD_SEGMENT_IN_USE` (0x0001) 与 `FILE_FILE_NAME_INDEX_PRESENT` (0x0002)。
 * 后者就是各解析器实际当"是目录"用的那一位 —— 只有带文件名索引的记录才是目录。
 */
const REC_FLAG_IN_USE = 0x01
const REC_FLAG_DIRECTORY = 0x02

/** `$FILE_NAME` 值内部的偏移。 */
const FN_PARENT = 0x00
const FN_REAL_SIZE = 0x30
const FN_FLAGS = 0x38
const FN_NAME_LEN = 0x40
const FN_NAME_NS = 0x41
const FN_NAME_TEXT = 0x42

/**
 * 非驻留属性头里 **real/size（= 表观大小）** 的偏移。**2026-10-09 由本机真卷纠正：0x2c 是错的。**
 *
 * 原先按"属性头 0x10 + 0x20 + 0x0C = 0x2C"推出来一个不存在的格 —— 那里横跨两个 u64
 * （allocated 的高 4 字节 + real 的低 4 字节），从记录 #0 解出的 `$MFT` 长度成了
 * 3,901,243,177,209,692,000 字节。`scripts/_mft-rec0.mjs`（提权）把非驻留头逐 8 字节打出来后：
 *
 * ```
 *   +0x10 StartingVcn   +0x18 LastVcn   +0x20 数据运行偏移(实测恒为 64=0x40)
 *   +0x28 allocated     +0x30 real      +0x38 initialized
 * ```
 *
 * 三条独立证据，不是照文档抄的：
 *  1. 扫 100,344 条记录里 56,194 个非驻留 `$DATA`：**+0x28 有 56,194 个是 4096 的整数倍，
 *     +0x30 只有 3,133 个** ⇒ 簇整数倍那一格是 allocated，另一格才是文件大小。
 *  2. `#4 $AttrDef` 读作 allocated=4096 / real=**2560**，而 `$AttrDef` 的已知大小就是 2560。
 *  3. `#0 $MFT` 的 +0x28/+0x30 = **908,328,960**，与 `fsutil fsinfo ntfsinfo C:` 独立报出的
 *     `Mft Valid Data Length : 866.25 MB` 同值；`$MFTMirr` 那一格 = 4096 = 它的 4 条记录。
 *
 * 口径仍然取 real（表观大小），与全仓"表观大小"一致；allocated 那一格只用于对账，不拿来记账。
 */
const NR_REAL_SIZE = 0x30
/** 同一头的 +0x10 = 该片段覆盖的起始 VCN（真卷实测：头一段为 0，其后各段递增）。 */
const NR_STARTING_VCN = 0x10
/**
 * 同一头的 +0x28 = **簇分配大小**。上面那三条独立证据里"56,194 个非驻留 `$DATA` 的 +0x28
 * 全是 4096 的整数倍"就是它。
 *
 * 它只服务对账，**绝不进任何界面数字**（`apparentSize` 才是全仓口径）。存在的理由是
 * 表观大小与占用大小在 Compact OS / 压缩 / 稀疏文件上能差出一个数量级，而"扫描总数比卷还大"
 * 这类超额必须能拆到具体哪一类，不能停在"大概是压缩吧"。
 */
const NR_ALLOCATED_SIZE = 0x28

export interface MftFileName {
  /** 父目录的记录号（`$FILE_NAME` 引用低 48 位） */
  parentFileNumber: number
  /** 父目录的 sequence（高 16 位）。**它参与身份判断**：记录号会被回收复用。 */
  parentSequence: number
  name: string
  namespace: number
  flags: number
  /** 索引项里缓存的那份大小 —— 只用于和 `$DATA` 对账，不作为口径。 */
  fileNameRealSize: number
}

export interface MftAttrRef {
  /** 被搬走的那个属性的类型号 */
  type: number
  /** 该片段覆盖的起始 VCN。多片段流里**只有 0 那一段带真实大小**，其余段的大小不可用。 */
  lowerVcn: bigint
  /** 这个属性现在住在哪条记录里 */
  recordNumber: number
  recordSequence: number
}

export interface MftRecord {
  fileNumber: number
  sequence: number
  /** `false` = 已删除/未使用的记录。**上层必须整条跳过**，否则会把已删文件算进目录。 */
  inUse: boolean
  isDir: boolean
  /** 该记录在哪些父目录的哪些名字下出现。已滤掉 "." / ".." 与 index-view 条目。 */
  names: MftFileName[]
  /** 表观大小。目录恒 0。 */
  apparentSize: number
  /**
   * 簇分配大小（磁盘占用口径），**只用于对账，不作为记账口径** —— 见 `NR_ALLOCATED_SIZE`。
   * 目录恒 0；**驻留流恒 0**（字节就住在 MFT 记录里，不另占簇，所以卷级已用空间里它的这一份
   * 已经算在 `$MFT` 自己的分配里了，再给它记一次就是双计）；
   * 只有非驻留 `$DATA` 才取头段的 +0x28。大小取不到时同为 0。
   */
  allocatedSize: number
  /** 大小是从 `$DATA` 拿的（`true`）还是退回 `$FILE_NAME` 那份（`false`）。 */
  sizeFromData: boolean
  /**
   * 大小的来源是**哪个 VCN 的片段**：非驻留 `$DATA` 头 +0x10 那个起始 VCN。
   * 大小来自驻留 `$DATA` 或 `$FILE_NAME` 时为 `null`。
   * 合并扩展记录时靠它决定"这一段才算大小"，否则碎片记录会把大小读成该片段自己的零头。
   */
  dataStartingVcn: bigint | null
  /**
   * `$ATTRIBUTE_LIST` 里指向**别的记录**的条目（指向本记录的那些已滤掉 —— 真卷上
   * #3370 的清单确实会列出它自己已有的 0x10/0x30）。空数组 = 这条记录没溢出。
   */
  attributeList: MftAttrRef[]
}

/** 记录头的最小校验：签名对不对。不对就返回 null，让上层跳过而不是猜。 */
export function looksLikeFileRecord(buf: Buffer, at = 0): boolean {
  return buf.length >= at + 48 && buf.readUInt32LE(at) === 0x45_4c_49_46 /* 'FILE' 小端 */
}

/**
 * 应用 update sequence array 修正。
 *
 * NTFS 把每条记录按扇区切开，**每个扇区最后 2 字节被替换成同一个 USN**，真正的原值存在
 * update sequence array 里。不修正的话，落在扇区边界上的字段（1024 字节记录 = 2 扇区
 * ⇒ 偏移 0x1FE / 0x3FE 附近）会读到错值 —— 而"下一个属性的偏移"正好是一条 u16，
 * 读错就是整条记录解析错位，且**不会报错**，只会算错大小。
 *
 * ## ⚠️ USN 放在哪儿，有两种约定 —— 所以这里不猜，改成"试 + 验"
 *
 * `MULTI_SECTOR_HEADER` 文档上只有 `SigAlgn / FixOffset / FixLength / ClientInUseSequenceNumber`
 * 四个字段，社区实现分两派：
 *  · **A 派**：USA[0] 就是 USN，USA[1..] 是各扇区尾的原值（于是第 i 个扇区尾取 USA[i]）；
 *  · **B 派**：USN 单独在记录头 0x08，USA[0..] 全是扇区尾原值（于是第 i 个扇区尾取 USA[i-1]）。
 *
 * 挑错派的后果不是崩溃而是**静默把 2 字节写进错位置**。所以这一版把两种读法都算一遍，
 * **只接受"所有扇区尾当前值确实等于它该等于的 USN"那一种**；两种都对不上就返回 false，
 * 让调用方跳过这条记录 —— 跳过是可发现的损失，写错位置不是。
 * 拿到第一条真记录之后应该回来把这一节改成"实测只有一种成立"，并把另一种删掉。
 */
export function applyUpdateSequence(buf: Buffer, sectorSize: number): boolean {
  if (!looksLikeFileRecord(buf)) return false
  const usaOffset = buf.readUInt16LE(4)
  const usaCount = buf.readUInt16LE(6) // 单位：字（2 字节）
  if (sectorSize < 2 || usaCount < 1 || usaOffset < 8) return false

  /**
   * 要修的扇区尾是**每一个扇区的最后 2 字节**，包括记录的最后一扇 —— 也就是
   * `i = 1 .. floor(len/sectorSize)`，共 `n` 个。
   * （第一版在这里写成 `i < usaCount`，于是 1024/512 的记录只修了第 1 扇、漏掉第 2 扇，
   *  被 B 派那条单测抓出来了：漏修的那 2 字节仍是 USN，读出来是 11031 而不是原值。）
   */
  const n = Math.floor(buf.length / sectorSize)
  if (n < 1) return false
  const tails: number[] = []
  for (let i = 1; i <= n; i++) tails.push(i * sectorSize - 2)

  // A 派要 n+1 个字（第 0 个是 USN），B 派要 n 个字（USN 在记录头 0x08）
  const candidates: Array<{ usn: number; readAt: (i: number) => number } | null> = [
    usaOffset + (n + 1) * 2 <= buf.length ? { usn: buf.readUInt16LE(usaOffset), readAt: (i) => usaOffset + (i + 1) * 2 } : null,
    usaOffset + n * 2 <= buf.length ? { usn: buf.readUInt16LE(8), readAt: (i) => usaOffset + i * 2 } : null
  ]
  for (const c of candidates) {
    if (c === null || c.usn === 0) continue
    let ok = true
    for (let i = 0; i < tails.length; i++) {
      // 扇区尾上此刻必须正好是 USN；不是就说明这一派约定不成立（或扇区大小给错了）
      if (buf.readUInt16LE(tails[i]!) !== c.usn) {
        ok = false
        break
      }
    }
    if (!ok) continue
    // 全部校验通过才真的写 —— 上面那一轮只读不写，就是为了不在"两种都不对"时留下半改的缓冲
    for (let i = 0; i < tails.length; i++) buf.writeUInt16LE(buf.readUInt16LE(c.readAt(i)), tails[i]!)
    return true
  }
  return false
}

/** 低 48 位 = 记录号，高 16 位 = sequence。NTFS 文件引用就是这么打包的。 */
function splitReference(v: bigint): { fileNumber: number; sequence: number } {
  return { fileNumber: Number(v & 0xffff_ffff_ffffn), sequence: Number(v >> 48n) }
}

/**
 * 解析一条 MFT 记录。
 *
 * `buf` 必须是一条记录的长度（通常 1024，由 `$Boot` 的"每记录扇区数"决定），
 * **且已经过 `applyUpdateSequence`**。没过也能解，但扇区边界上的字段不可信。
 *
 * 返回 `null` 只有一种情况：签名不是 `FILE`（缓冲不是记录起点）。
 * "记录未在使用"不是 null —— 它返回 `inUse: false`，让上层自己决定怎么记账，
 * 因为"跳过"这件事的口径属于聚合层，不属于解析层。
 */
export function parseMftRecord(buf: Buffer, fileNumber: number): MftRecord | null {
  if (!looksLikeFileRecord(buf)) return null

  const sequence = buf.readUInt16LE(0x10)
  const flags = buf.readUInt16LE(0x16)
  let at = buf.readUInt16LE(0x14)
  if (at < 42 || at >= buf.length) return null // 属性表起点不合理：不是能信的记录

  const names: MftFileName[] = []
  const attributeList: MftAttrRef[] = []
  let dataSize: number | null = null
  let dataAlloc: number | null = null
  let dataVcn: bigint | null = null
  let fileNameSize: number | null = null
  let dirFromHeader = (flags & REC_FLAG_DIRECTORY) !== 0

  while (at + 8 <= buf.length) {
    const type = buf.readUInt32LE(at)
    if (type === ATTR_END || type === 0) break
    const len = buf.readUInt32LE(at + 4)
    if (len < 8 || at + len > buf.length) break // 长度不合理 ⇒ 停在这里，不越界猜

    const nonResident = buf.readUInt8(at + 8) === 1
    const nameLen = buf.readUInt8(at + 9)
    const nameOff = buf.readUInt16LE(at + 10)
    // 属性名必须整个落在本属性之内。它越界就说明这条记录不可信，而 `nameLen === 0`
    // 正是"这是不是无名 $DATA（还是 ADS）"的判据 —— 拿一个错位的名长去判会把备用流当主数据。
    if (nameLen > 0 && (nameOff < 8 || nameOff + nameLen * 2 > len)) break
    const valueOff = buf.readUInt16LE(at + (nonResident ? 0x20 : 0x14))
    const valueStart = at + valueOff
    const valueEnd = nonResident ? at + len : at + buf.readUInt32LE(at + 0x10) + valueOff

    if (type === ATTR_FILE_NAME && !nonResident && valueStart < valueEnd && valueEnd <= buf.length) {
      const fnFlags = buf.readUInt32LE(valueStart + FN_FLAGS)
      const rawLen = buf.readUInt8(valueStart + FN_NAME_LEN)
      const namespace = buf.readUInt8(valueStart + FN_NAME_NS)
      const nameStart = valueStart + FN_NAME_TEXT
      // 名字必须整个落在值里：越界的一律不认，宁可少一个名字也不要读进下一个属性
      if (rawLen > 0 && nameStart + rawLen * 2 <= valueEnd) {
        const name = buf.toString('utf16le', nameStart, nameStart + rawLen * 2)
        const ref = splitReference(buf.readBigUInt64LE(valueStart + FN_PARENT))
        // "." 与 ".." 是目录自引用与父引用，不是"这个文件在父目录里的名字"。
        // index-view 那一条是索引投影，同一对 (父,名) 会出现两次，也滤掉。
        const isIndexView = (fnFlags & FN_FLAG_INDEX_VIEW) !== 0
        const isSelfOrParent = name === '.' || name === '..'
        if (!isIndexView && !isSelfOrParent) {
          names.push({
            parentFileNumber: ref.fileNumber,
            parentSequence: ref.sequence,
            name,
            namespace,
            flags: fnFlags,
            fileNameRealSize: Number(buf.readBigUInt64LE(valueStart + FN_REAL_SIZE))
          })
          if ((fnFlags & FN_FLAG_DIRECTORY) !== 0) dirFromHeader = true
        }
      }
      if (fileNameSize === null) fileNameSize = Number(buf.readBigUInt64LE(valueStart + FN_REAL_SIZE))
    } else if (type === ATTR_DATA && nameLen === 0) {
      // 只认**无名** $DATA。带名字的是备用数据流（ADS），不该并进这个文件的大小。
      if (nonResident) {
        dataSize = Number(buf.readBigUInt64LE(at + NR_REAL_SIZE))
        dataAlloc = Number(buf.readBigUInt64LE(at + NR_ALLOCATED_SIZE))
        dataVcn = buf.readBigUInt64LE(at + NR_STARTING_VCN)
      } else {
        dataSize = buf.readUInt32LE(at + 0x10) // 驻留：值长度就是大小（小文件直接塞在记录里）
        dataAlloc = 0 // 驻留流不另占簇 —— 见 MftRecord.allocatedSize 的口径说明
        dataVcn = null // 驻留流没有 VCN —— 它的大小本来就在本记录里
      }
    } else if (type === ATTR_ATTRIBUTE_LIST && !nonResident && valueStart < valueEnd && valueEnd <= buf.length) {
      // 溢出清单：条目头部定长 24 字节，之后是属性名与（驻留属性的）原属性头，所以整条
      // 长度按 +0x04 那格读。**整条必须落在值内**，越界就停 —— 和上面所有边界判据同一个立场：
      // 宁可少跟一条属性，也不要读进下一个条目去编出假记录号。
      let p = valueStart
      while (p + 24 <= valueEnd) {
        const entryLen = buf.readUInt16LE(p + 4)
        if (entryLen < 24 || p + entryLen > valueEnd) break
        const ref = splitReference(buf.readBigUInt64LE(p + 16))
        // 指向本记录的条目丢掉：真卷上 #3370 的清单会把它自己的 0x10/0x30 也列出来，
        // 跟着读就是自己读自己，白跑一次随机 IO。
        if (ref.fileNumber !== fileNumber) {
          attributeList.push({
            type: buf.readUInt32LE(p),
            lowerVcn: buf.readBigUInt64LE(p + 8),
            recordNumber: ref.fileNumber,
            recordSequence: ref.sequence
          })
        }
        p += entryLen
      }
    } else if (type === ATTR_STANDARD_INFO) {
      // 目前不取里面的大小 —— 它是"另一份缓存"，口径上不如 $DATA。
      // 留着这一支是为了让遍历完整：新加属性类型时不会在这里断掉。
    }

    at += len
  }

  const isDir = dirFromHeader
  // 目录没有 $DATA，大小按口径就是 0；文件优先 $DATA，取不到才退回 $FILE_NAME 那份并如实标注。
  const apparentSize = isDir ? 0 : dataSize !== null ? dataSize : fileNameSize !== null ? fileNameSize : 0

  return {
    fileNumber,
    sequence,
    inUse: (flags & REC_FLAG_IN_USE) !== 0,
    isDir,
    names,
    apparentSize,
    allocatedSize: isDir ? 0 : dataAlloc ?? 0,
    sizeFromData: dataSize !== null,
    dataStartingVcn: dataSize !== null ? dataVcn : null,
    attributeList
  }
}

/**
 * 把扩展记录合并进基记录，返回**新的**记录对象（不改入参 —— 改了就分不清哪条是盘上原样）。
 *
 * 需要它的原因不是理论，是实测：本机扫 100,344 条记录，**925 条带 `$ATTRIBUTE_LIST`，
 * 其中 923 条本记录内没有非驻留 `$DATA`** —— 不跟扩展记录，这批文件的大小就只能取
 * `$FILE_NAME` 里那份（pagefile.sys 因此报成 0 字节，而它的 `$DATA` 在 #13120：
 * real 9,714,868,224）。偏偏这批就是又大又碎的文件，正是一个清理工具最不能算错的那一批。
 *
 * 三条合并规则各挡一种真实错法：
 *  1. **大小只认起始 VCN = 0 的那一段。** 流按 VCN 切成片段散在多条记录里，只有头一段带
 *     真实大小，其余段的大小是那一段自己的 —— 拿来用就是把碎片当全量。
 *  2. 基记录已经有 `$DATA` 时**不覆盖**，扩展只补名字。
 *  3. 名字按 (父记录号, 名) 去重：硬链接的其余名字就住在扩展记录里，不跟就漏链接
 *     （漏了会把同一份字节数记多次）。
 */
export function applyExtensions(base: MftRecord, exts: readonly MftRecord[]): MftRecord {
  if (exts.length === 0) return base

  const seen = new Set(base.names.map((n) => n.parentFileNumber + '/' + n.name))
  const names = [...base.names]
  let apparentSize = base.apparentSize
  let allocatedSize = base.allocatedSize
  let sizeFromData = base.sizeFromData
  let dataStartingVcn = base.dataStartingVcn
  let isDir = base.isDir

  for (const ext of exts) {
    for (const n of ext.names) {
      const key = n.parentFileNumber + '/' + n.name
      if (seen.has(key)) continue
      seen.add(key)
      names.push(n)
    }
    if (!sizeFromData && ext.sizeFromData && ext.dataStartingVcn === 0n) {
      apparentSize = ext.apparentSize
      // 分配大小跟着大小走同一段：碎片流里只有头一段带全量，取碎片自己那格就是把零头当全量。
      allocatedSize = ext.allocatedSize
      sizeFromData = true
      dataStartingVcn = ext.dataStartingVcn
    }
    if (ext.isDir) isDir = true
  }

  // "目录恒 0"这条口径在合并后仍要成立（isDir 有可能是刚从扩展记录补上来的）。
  return {
    ...base,
    isDir,
    names,
    apparentSize: isDir ? 0 : apparentSize,
    allocatedSize: isDir ? 0 : allocatedSize,
    sizeFromData,
    dataStartingVcn: isDir ? null : dataStartingVcn
  }
}
