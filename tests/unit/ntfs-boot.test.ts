/**
 * `$Boot` 解析与裸卷路径推导的单测。
 *
 * 和 `ntfs-mft.test.ts` 同一立场：提权之外一条真卷字节都读不到，所以**能被造出来测的部分
 * 必须先测干净**。这一组里第 2 条（签名字节序）就是
 * 写 `boot.ts` 时当场写错的那个位置 —— 盘上是 `0x55 0xAA`，小端读出来是 `0xAA55`；
 * 当时比较的是 `0x55AA`，真接上卷的第一秒就会把每个合法卷都判成"不是 NTFS"。
 * 那种错误没有别的抓法，只能把字节序本身钉进断言。
 */
import { describe, expect, it } from 'vitest'
import { parseBootSector } from '../../core/ntfs/boot'
import { volumePathOf } from '../../core/ntfs/volume'

/** 造一张 NTFS 引导扇区。默认值取本机这种常见格式：512 字节扇区、8 扇区一簇、记录 1024 字节。 */
function bootSector(o?: {
  bytesPerSector?: number
  sectorsPerCluster?: number
  mftLcn?: number
  /** 0x38 处：`$MFTMirr` 的起始簇号。解析器不读它，但夹具要摆对位置 —— 上一版把整套偏移写早了 8 字节，
   *  正是这一格被当成记录因子读成了 2，才得到荒谬的 8192 字节/记录。 */
  mirrorLcn?: number
  /** 0x40 处：负数 = 2^|值| **字节**，正数 = 簇数。NTFS 默认格式是 **-10 ⇒ 1024 字节** */
  recFactor?: number
  totalSectors?: number
  oem?: string
  signature?: number
}): Buffer {
  const b = Buffer.alloc(512)
  b.writeUInt16LE(0xfeeb, 0x00) // 跳转指令，内容无所谓但不能全 0
  b.write(o?.oem ?? 'NTFS    ', 0x03, 8, 'ascii')
  b.writeUInt16LE(o?.bytesPerSector ?? 512, 0x0b)
  b.writeUInt8(o?.sectorsPerCluster ?? 8, 0x0d)
  b.writeUInt32LE(0, 0x18) // 隐藏扇区
  b.writeBigUInt64LE(BigInt(o?.totalSectors ?? 167_772_159), 0x28) // 总扇区：×512 B = 80.0 GB，与真卷逐位吻合
  b.writeBigUInt64LE(BigInt(o?.mftLcn ?? 786_432), 0x30) // $MFT 起始簇
  b.writeBigUInt64LE(BigInt(o?.mirrorLcn ?? 2), 0x38) // $MFTMirror 在簇 2 = NTFS 标准位置
  b.writeInt8(o?.recFactor ?? -10, 0x40) // -10 ⇒ 2^10 = 1024 字节，NTFS 默认格式。**写最低字节**：真卷就是零扩展的 signed char
  b.writeUInt8((o?.signature ?? 0xaa55) & 0xff, 0x1fe)
  b.writeUInt8(((o?.signature ?? 0xaa55) >> 8) & 0xff, 0x1ff)
  return b
}

describe('parseBootSector', () => {
  it('常见格式：512 扇区 / 8 扇区一簇 / 记录 1024 字节 / MFT 偏移 = 起始簇 × 簇大小', () => {
    // recFactor 故意取 -10 而不是随手一个负数：NTFS 格式化默认就是 -10 ⇒ 1024。
    // 夹具第一版写成 -2（= 4 字节），被解析器的下界正确地拒了 —— 那次红的是夹具不是代码，
    // 所以下面把"默认值 ⇒ 1024"钉成断言，不让它再飘回去。
    const g = parseBootSector(bootSector())!
    expect(g.bytesPerSector).toBe(512)
    expect(g.sectorsPerCluster).toBe(8)
    expect(g.bytesPerFileRecord).toBe(1024)
    expect(g.mftByteOffset).toBe(786_432 * 8 * 512)
    expect(g.totalSectors).toBe(167_772_159)
  })

  it('签名的**盘上字节序**钉死为 0x55 0xAA（小端读出来是 0xAA55）', () => {
    const b = bootSector()
    expect(b[0x1fe]).toBe(0x55)
    expect(b[0x1ff]).toBe(0xaa)
    expect(parseBootSector(b)).not.toBeNull()
    // 反向：把它按大端摆 ⇒ 必须被拒。这一条就是当初写错的方向。
    expect(parseBootSector(bootSector({ signature: 0x55aa }))).toBeNull()
  })

  it('recFactor 为正数时按"簇数"解释，不是字节数', () => {
    const g = parseBootSector(bootSector({ recFactor: 1 }))!
    expect(g.bytesPerFileRecord).toBe(8 * 512) // 1 簇 = 4096 字节
  })

  it('4Kn 卷：扇区 4096、1 扇区一簇，recFactor -10 仍是 1024 字节记录', () => {
    const g = parseBootSector(bootSector({ bytesPerSector: 4096, sectorsPerCluster: 1, recFactor: -10 }))!
    expect(g.bytesPerFileRecord).toBe(1024)
    expect(g.mftByteOffset).toBe(786_432 * 1 * 4096)
  })

  it('不是 NTFS / 不是引导扇区 / 几何荒谬 ⇒ 一律 null，不猜', () => {
    expect(parseBootSector(bootSector({ oem: 'exFAT   ' }))).toBeNull()
    expect(parseBootSector(Buffer.alloc(512))).toBeNull()
    expect(parseBootSector(Buffer.alloc(256))).toBeNull()
    expect(parseBootSector(bootSector({ bytesPerSector: 0 }))).toBeNull()
    expect(parseBootSector(bootSector({ bytesPerSector: 700 }))).toBeNull() // 非 2 的幂
    expect(parseBootSector(bootSector({ sectorsPerCluster: 3 }))).toBeNull() // 非 2 的幂
    expect(parseBootSector(bootSector({ sectorsPerCluster: 0 }))).toBeNull()
    expect(parseBootSector(bootSector({ mftLcn: 0 }))).toBeNull() // MFT 不可能在簇 0
    expect(parseBootSector(bootSector({ recFactor: 0 }))).toBeNull()
    expect(parseBootSector(bootSector({ recFactor: -2 }))).toBeNull() // 2^2=4 字节，荒谬 ⇒ 拒
  })

  it('偏移回归：0x20 那格不管摆什么都不能被当成总扇区数；总扇区数荒谬 ⇒ 整张拒', () => {
    // 上一版整套偏移早 8 字节。这张夹具按正确布局摆，然后把 0x20 那 8 字节也填成一个
    // 看起来合理的扇区数 —— 解析器必须仍然报出**正确**的那个值，而不是先读到哪个算哪个。
    const b = bootSector()
    b.writeBigUInt64LE(999_999_999n, 0x20)
    expect(parseBootSector(b)!.totalSectors).toBe(167_772_159)
    // 反向一：只把 0x28 清零 ⇒ 总扇区变成 0，几何不可信，必须整张拒
    const z = bootSector()
    z.writeBigUInt64LE(0n, 0x28)
    expect(parseBootSector(z)).toBeNull()
    // 反向二：把上一版**实际读到过**的那个数摆进正确格子 —— 3.6e16 越过 MAX_SAFE_INTEGER，
    // 不是任何真卷能给出的总扇区数。这一条让解析层自己就拒，不必等 volume.ts 读到 0 字节才发现。
    const huge = bootSector()
    huge.writeBigUInt64LE(36_029_346_774_777_856n, 0x28)
    expect(parseBootSector(huge)).toBeNull()
    // 反向三：MFT 起点落在卷尾之外 ⇒ 起始簇号或簇大小至少一个错，同样整张拒
    expect(parseBootSector(bootSector({ totalSectors: 1_000_000 }))).toBeNull()
  })

  it('真卷黄金样本：本机 C: 的 $Boot 前 0x54 字节，五个读数逐个钉死', () => {
    // 2026-10-09 由 `scripts/_bpb-dump.mjs`（提权）从 \\.\C: 逐字抄回；0x54 之后与解析无关，置 0，
    // 0x1fe 那两字节是真值 55 aa。这段字节里**同时**摆着两轮错法的现场：
    //   0x20 = 00 00 00 00 80 00 80 00 ⇒ 按 u64 读 = 3.6e16（第一版靠它才发现整套早了 8 字节）
    //   0x40 = f6 00 00 00            ⇒ 按 i32 读 = 246，按 i8 读 = -10（第二错）
    // 对账走的独立口径不是本文档：`fsutil fsinfo ntfsinfo C:` 给 Total Sectors 167,772,159 (80.0 GB)、
    // Bytes Per Cluster 4096、Bytes Per FileRecord Segment 1024、Mft Start Lcn 0x00000000000c0000。
    const real = Buffer.alloc(512)
    const bpb = Buffer.from(
      'eb52904e544653202020200002080000' + // 0x00 跳转 + OEM "NTFS    "；0x0b 扇区 512；0x0d 每簇 8 扇区
        '0000000000f80000' + // 0x10 保留段
        '3f00ff0000a80300' + // 0x18 保留 + 0x1c 分区前的隐藏扇区 239,616
        '0000000080008000' + // 0x20 ← 上一版误读成总扇区数的那格
        'ffffff0900000000' + // 0x28 总扇区 = 0x09ffffff = 167,772,159（fsutil 同值）
        '00000c0000000000' + // 0x30 $MFT 起始簇 = 0xc0000（fsutil "Mft Start Lcn" 同值）
        '0200000000000000' + // 0x38 $MFTMirr 起始簇 = 2（fsutil "Mft2 Start Lcn" 同值；本层不读它）
        'f600000001000000' + // 0x40 记录因子 f6 = -10 ⇒ 1024（fsutil 同值）；0x44 索引因子 01，本层不读
        '687b57b69e57b618' + // 0x48 卷序列号（fsutil "NTFS Volume Serial Number" 同值）
        '00000000',
      'hex'
    )
    expect(bpb.length).toBe(0x54) // 抄错一位就整条红 —— 长度是最便宜的转储校验
    bpb.copy(real, 0)
    real[0x1fe] = 0x55
    real[0x1ff] = 0xaa

    const g = parseBootSector(real)
    expect(g).not.toBeNull()
    expect(g!.bytesPerSector).toBe(512)
    expect(g!.sectorsPerCluster).toBe(8)
    expect(g!.totalSectors).toBe(167_772_159)
    expect(g!.bytesPerFileRecord).toBe(1024) // 与 fsutil 的 "Bytes Per FileRecord Segment" 同值
    expect(g!.mftByteOffset).toBe(0xc0000 * 4096) // 与 fsutil 的 "Mft Start Lcn" 换算到字节同值
  })
})

describe('volumePathOf：只接盘符根', () => {
  it('盘符根换成裸卷路径，大小写都认', () => {
    expect(volumePathOf('C:\\')).toBe('\\\\.\\C:')
    expect(volumePathOf('c:')).toBe('\\\\.\\C:')
    expect(volumePathOf('D:/')).toBe('\\\\.\\D:')
    expect(volumePathOf('  E:  ')).toBe('\\\\.\\E:')
  })

  it('子目录、UNC、非路径一律拒 —— 放进来会得到一个偏大且没人怀疑的总数', () => {
    expect(volumePathOf('C:\\Users')).toBeNull()
    expect(volumePathOf('D:\\DeepClean\\tmp-ui-demo\\drive')).toBeNull()
    expect(volumePathOf('C:\\Users\\Kano\\')).toBeNull()
    expect(volumePathOf('\\\\nas\\share')).toBeNull()
    expect(volumePathOf('')).toBeNull()
    expect(volumePathOf('C')).toBeNull()
    // 反斜杠转义别写错：上面几条里只要有一条其实被匹配上了，就说明正则松了
    expect(volumePathOf('CC:\\')).toBeNull()
  })
})
