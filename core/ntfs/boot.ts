/**
 * NTFS `$Boot` 扇区解析 —— **纯函数，零 `node:fs`**。
 *
 * 要的东西只有四个：每扇区字节数、每簇扇区数、`$MFT` 的起始簇号、每条文件记录多少字节。
 * 有了它们才能算出"从卷的第几个字节开始读 MFT"。
 *
 * ## 为什么单独一个文件、而且不直接信自己
 *
 * 默认进程没有管理员（`fsutil fsinfo ntfsinfo C:` 与 `\\.\C:` 都是 Access denied / EPERM），
 * 只有提权那一次读得到真字节。所以这里的偏移**先按文档写、再拿一次提权跑对账**，
 * 而处理办法不是"赌它对"，而是：
 *
 *  1. 这一层把偏移集中起来，只暴露一个 `MftLocation`；
 *  2. `volume.ts` 拿这个偏移去读**第一条记录**，要求签名是 `FILE` **且** update sequence
 *     自洽（`applyUpdateSequence` 返回 true）。两个条件同时成立的概率极低，
 *     所以"偏移猜错"会在第一次运行就变成一条**有名有姓的失败**，而不是一个悄悄算错的大小。
 *
 * 换句话说：错的话会响，不会骗人。
 *
 * 2026-10-09 那次提权跑真的让它响了两次，本机 C: 的几何已逐字段与 `fsutil fsinfo ntfsinfo C:`
 * 对过（总扇区数、每簇字节、记录段大小、Mft Start Lcn 四项同值），见下方偏移块的注释。
 * **这套自检不许因此拆掉** —— 对过的是本机这张卷，4Kn 卷、别的格式化参数、
 * 以及"偏移又能安静算错"的那些情形全靠它兜住。
 */

/** 引导扇区签名所在偏移。盘上字节是 0x55 0xAA，按小端读出来是 0xAA55 —— **别写反**。 */
const BOOT_SIGNATURE_AT = 0x1fe

/**
 * ## 偏移与被纠正过两次的读数（2026-10-09，本机 C: 真卷）—— 别改回去
 *
 * **第一错：整套早 8 字节。** 第一版照记忆写成 0x20 总扇区 / 0x28 MFT / 0x30 镜像 /
 * 0x38 记录因子。第一次提权跑 `openMft` 撞上"MFT 首记录读到 0/8192 字节"，失败输出里
 * 带出的原始值当场摊开真相：
 *   0x28 = 167,772,159 扇区 × 512 B = **80.0 GB** ⇒ 与卷容量逐位吻合 ⇒ 那才是总扇区数
 *   0x30 = 786,432 (= 0xc0000) ⇒ MFT 起始簇
 *   0x38 = 2        ⇒ `$MFTMirr` 在簇 2
 * 正确布局是 0x28 / 0x30 / 0x38 / **0x40**。（第一版读 0x38 拿到镜像簇号的低 32 位 = 2，
 * 被当成正数"2 簇"⇒ 8192 字节/记录 —— 一个错得离谱、却能安静算错的值。）
 *
 * **第二错：`RECORD_FACTOR` 不能按 int32 读。** 真卷 0x40 处的 4 个字节是
 * `f6 00 00 00`。按 int32 读 = **246**（⇒ 246 簇 ⇒ 1,007,616 字节/记录），被下界拒了，
 * 于是 `openMft` 报"扇区 0 不是 NTFS 引导扇区"—— 一个和真因毫无关系的结论。按 **int8**
 * 读最低字节 = **-10** ⇒ 2^10 = **1024**，与 `fsutil fsinfo ntfsinfo C:` 独立报出的
 * `Bytes Per FileRecord Segment : 1024` 逐位吻合。也就是说这个字段宽 4 字节但
 * **符号只写在最低字节**（Windows 写的是零扩展的 signed char）。只读最低字节对两种
 * 编码（零扩展 / 符号扩展）都成立，所以下面按 `readInt8` 取。
 *
 * 值得记下来的不是"偏移写错了"，而是**这套自检为什么两次都能一次定位**：如果 `openMft`
 * 当时是"读不到就当没有"、继续往下走，我们会拿 8192 字节的记录边界去解析整张 MFT，
 * 产出一堆看起来像文件的垃圾，而不是那一行指名道姓的失败。
 */
const TOTAL_SECTORS = 0x28
const MFT_LCN = 0x30
const RECORD_FACTOR = 0x40
const BOOT_SIGNATURE = 0xaa55
/** OEM 标识 "NTFS    " 所在偏移。 */
const OEM_ID = 0x03

export interface MftLocation {
  /** 每扇区字节数（通常 512；512e/4Kn 卷上可能是 2048/4096） */
  bytesPerSector: number
  /** 每簇扇区数 */
  sectorsPerCluster: number
  /** 每条文件记录字节数。通常是 1024，也可能是 4096。 */
  bytesPerFileRecord: number
  /** `$MFT` 未命名 `$DATA` 的起始字节偏移 = 起始簇 × 簇大小 */
  mftByteOffset: number
  /** 卷总扇区数，用于把读取范围夹住（越界读卷会直接失败） */
  totalSectors: number
}

/**
 * 解析 `$Boot`。`sector` 必须至少 512 字节且是**第 0 个扇区**。
 *
 * 返回 `null` 的情况都是"这不是一张 NTFS 引导扇区"，不是"解析失败"：
 * 调用方应当据此报"这个卷不是 NTFS / 读到的不是引导扇区"，而不是继续往下算。
 */
export function parseBootSector(sector: Buffer): MftLocation | null {
  if (sector.length < 512) return null
  if (sector.readUInt16LE(BOOT_SIGNATURE_AT) !== BOOT_SIGNATURE) return null
  if (sector.toString('ascii', OEM_ID, OEM_ID + 7) !== 'NTFS   ') return null // 第 8 字节是空格，故取 7

  const bytesPerSector = sector.readUInt16LE(0x0b)
  const sectorsPerCluster = sector.readUInt8(0x0d)
  if (bytesPerSector < 512 || bytesPerSector > 4096 || (bytesPerSector & (bytesPerSector - 1)) !== 0) return null
  if (sectorsPerCluster === 0 || (sectorsPerCluster & (sectorsPerCluster - 1)) !== 0) return null

  const mftLcn = sector.readBigUInt64LE(MFT_LCN)
  /**
   * `RECORD_FACTOR` 处是"每条文件记录占多少簇/多少字节"，而且它是**带符号**的：
   * 正数 = 簇数；负数 = 2^|值| **字节**。格式化默认走负数那一支（-10 ⇒ 1024 字节）。
   * 符号取在最低字节（见上方注释），只按 int32 解释会得到 246 这种"正数簇"⇒ 一百万字节的记录。
   * 这一支写错，下面所有记录的边界全错。
   */
  const recFactor = sector.readInt8(RECORD_FACTOR)
  const bytesPerFileRecord =
    recFactor < 0 ? 1 << -recFactor : recFactor * sectorsPerCluster * bytesPerSector
  if (bytesPerFileRecord < 512 || bytesPerFileRecord > 65536) return null

  const clusterSize = sectorsPerCluster * bytesPerSector
  const mftByteOffset = Number(mftLcn) * clusterSize
  if (!Number.isSafeInteger(mftByteOffset) || mftByteOffset <= 0) return null

  /**
   * 总扇区数也要自己过一遍闸，不能原样交出去。两条各抓一种真实发生过的错：
   *  - **非安全整数**：2026-10-09 第一版偏移早 8 字节，`0x20` 读到 3.6e16 —— 那已经越过
   *    `Number.MAX_SAFE_INTEGER`，是个不可能出现在真卷上的数。这一条让解析层当场拒掉，
   *    不必等到 `volume.ts` 去读才撞上"0 字节"。
   *  - **MFT 起点不在卷内**：卷比 MFT 还短 ⇒ 起始簇号或簇大小至少有一个错。
   *    同一条判据现在也在 `volume.ts` 的失败文案里出现，那是给**已经放行的几何**做二次确认。
   */
  const totalSectors = Number(sector.readBigUInt64LE(TOTAL_SECTORS))
  if (!Number.isSafeInteger(totalSectors) || totalSectors <= 0) return null
  if (mftByteOffset >= totalSectors * bytesPerSector) return null

  return {
    bytesPerSector,
    sectorsPerCluster,
    bytesPerFileRecord,
    mftByteOffset,
    totalSectors
  }
}
