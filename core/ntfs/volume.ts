/**
 * 从裸卷读 `$MFT` —— **这一层是唯一碰 `node:fs` 的 NTFS 代码**。
 *
 * ## 它必须能"猜错就响"
 *
 * 默认进程没有管理员（`fsutil fsinfo ntfsinfo C:` 与 `\\.\C:` 都是 Access denied / EPERM），
 * 只有提权那一次读得到真字节 —— 那一次也确实把 `boot.ts` 的偏移纠正了两轮（现每字段与
 * `fsutil` 同值）。这一层的职责因此不只是"读字节"，
 * 而是"在读到任何一条被当成事实的记录之前，先证明几何推断是对的"：
 *
 *  1. 扇区 0 必须是 NTFS 引导扇区（OEM 标识 + 0x55AA）；
 *  2. 按 `$Boot` 算出的 MFT 起始偏移上，第一条记录签名必须是 `FILE`；
 *  3. 而且它的 update sequence 必须自洽（`applyUpdateSequence` 返回 true）——
 *     这一条尤其值钱：扇区大小猜错的话，签名可能碰巧还对得上（'FILE' 只有 4 字节，
 *     落在别处也可能撞上），但 USA 对不上的概率高得多。
 *
 * 三条里任何一条不成立 ⇒ 返回 `geometry-unverified`，**一个字节都不当作数据交出去**。
 * 这比"读出一堆看起来像记录的东西、目录大小偏了 3%"要诚实得多，而后者正是错偏移会产生的症状。
 *
 * ## 为什么用记录 0 自己的大小来定上界
 *
 * `$MFT` 的第 0 条记录描述的就是 `$MFT` 这个文件，它的未命名 `$DATA` 的 ActualLength
 * 就是 MFT 的字节长度。所以不需要额外去解 `$Bitmap` 或猜卷尾 —— 读多少由 MFT 自己说。
 * 顺带这也第三次验证了偏移：如果 `$MFT` 大小算出来是 0 或一个荒谬的数，几何就是错的。
 */
import { closeSync, openSync, readSync } from 'node:fs'
import { parseBootSector, type MftLocation } from './boot'
import { applyExtensions, applyUpdateSequence, looksLikeFileRecord, parseMftRecord, type MftRecord } from './mft'

/** 一次最多读多少条记录。1024 字节记录 × 512 = 512 KB，够小也够摊薄 syscall。 */
const RECORDS_PER_CHUNK = 512

/** MFT 声明的最大记录大小。超过它说明 `$Boot` 读错了，不是这个卷真有这么大的记录。 */
const MAX_RECORD_BYTES = 64 * 1024

export type MftFailure =
  /** 打不开卷 —— 本机实测就是这个：需要管理员 */
  | 'needs-elevation'
  /** 不是 NTFS，或扇区 0 根本不是引导扇区 */
  | 'not-ntfs'
  /** 几何推断了但第一条记录不认 —— 偏移或扇区大小猜错 */
  | 'geometry-unverified'
  /** 读操作本身失败（卷被卸载、位图损坏、短读等） */
  | 'read-failed'

export interface MftGeometry {
  location: MftLocation
  /** `$MFT` 自身的字节长度（从记录 0 的未命名 `$DATA` 读来） */
  mftBytes: number
  /** 将要遍历的记录条数上界 */
  recordCount: number
}

export type MftOpen = { ok: true; fd: number; geometry: MftGeometry } | { ok: false; reason: MftFailure; detail: string }

/**
 * 把盘符根 `C:\` 换成裸卷路径 `\\.\C:`；**不是盘符根的一律拒**（返回 null）。
 *
 * 为什么不退一步"取它所在的卷"：MFT 路线拿到的是**整个卷**的记录。若放 `D:\Projects` 进来，
 * 读的是 D: 的全部 MFT 却标成"扫的是 D:\Projects" —— 那个数字不是"多读了点"，是错的。
 * 子目录扫描继续走现有 readdir 路线。
 *
 * 正则必须整串匹配（`^X:[\\/]?$`）。写成 `^X:` 那种前缀匹配就会把子目录放进来 ——
 * 而它放进来之后什么都不会报，只会安静地给出一个偏大的总数。
 */
export function volumePathOf(root: string): string | null {
  const m = /^([A-Za-z]):[\\/]?$/.exec(root.trim())
  if (m === null || m[1] === undefined) return null
  return `\\\\.\\${m[1].toUpperCase()}:`
}

/** 扇区对齐地读一段。裸卷读要求偏移与长度都是扇区的整数倍。 */
function readAt(fd: number, offset: number, length: number, bytesPerSector: number, what: string): Buffer | string {
  if (offset % bytesPerSector !== 0 || length % bytesPerSector !== 0) {
    return `${what}：请求未扇区对齐（offset=${offset} length=${length} sector=${bytesPerSector}）`
  }
  const buf = Buffer.alloc(length)
  try {
    let done = 0
    while (done < length) {
      const n = readSync(fd, buf, done, length - done, offset + done)
      if (n <= 0) break // 短读：到卷尾或被拒，交给调用方判
      done += n
    }
    if (done < length) return `${what}：只读到 ${done}/${length} 字节`
  } catch (e) {
    return `${what} 读取失败：${e instanceof Error ? e.message : String(e)}`
  }
  return buf
}

/**
 * 打开卷并**验证**几何。不验证通过就不会返回 fd。
 *
 * 注意这里刻意不 catch-then-guess：任何一步不确定都返回失败原因，
 * 因为下游拿到的每一个字节都会被当成"盘上真实有什么"来记账。
 */
export function openMft(root: string): MftOpen {
  const vol = volumePathOf(root)
  if (vol === null) return { ok: false, reason: 'not-ntfs', detail: `扫描根不是盘符根（${root}），MFT 路线只支持本地 NTFS 卷` }

  let fd: number
  try {
    fd = openSync(vol, 'r')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // EPERM/EACCES 就是"没提权"。这一条必须和"不是 NTFS"分开报 —— 界面上要说的话不一样：
    // 前者是"以管理员身份重启可以扫全"，后者是"这个卷本来就扫不了"。
    if (code === 'EPERM' || code === 'EACCES')
      return { ok: false, reason: 'needs-elevation', detail: `${vol} 打不开（${code}）：裸卷读需要管理员权限` }
    return { ok: false, reason: 'read-failed', detail: `${vol} 打不开：${code ?? String(e)}` }
  }

  const close = (): void => {
    try {
      closeSync(fd)
    } catch {
      /* 已经要返回失败了，别用第二个错误盖掉第一个 */
    }
  }

  const s0 = readAt(fd, 0, 512, 512, '$Boot 扇区 0')
  if (typeof s0 === 'string') return failAnd(close, 'read-failed', s0)
  const location = parseBootSector(s0)
  if (location === null) return failAnd(close, 'not-ntfs', `${vol} 的扇区 0 不是 NTFS 引导扇区（可能不是 NTFS，或扇区大小不是 512）`)
  if (location.bytesPerFileRecord > MAX_RECORD_BYTES)
    return failAnd(close, 'geometry-unverified', `每条记录 ${location.bytesPerFileRecord} 字节，超出合理上界 ${MAX_RECORD_BYTES}`)

  // 验证一/二/三：MFT 起点上必须是 FILE 签名、且 USA 自洽
  const first = readAt(fd, location.mftByteOffset, location.bytesPerFileRecord, location.bytesPerSector, '$MFT 首记录')
  // 失败必须自带几何 —— 2026-10-09 第一次提权跑就撞上了"读到 0 字节"，
  // 而当时那句只说"读失败"，看不出是偏移错、长度错还是对齐错。补上之后一眼能判：
  // 偏移超出卷尾 ⇒ 偏移错；偏移没超而长度是奇怪的数 ⇒ 记录大小错。
  const ctx = `几何 sector=${location.bytesPerSector} 簇=${location.sectorsPerCluster}扇区 记录=${location.bytesPerFileRecord}字节 MFT偏移=${location.mftByteOffset} 卷=${location.totalSectors}扇区`
  if (typeof first === 'string')
    return failAnd(
      close,
      'read-failed',
      `${first}｜${ctx}｜卷尾字节=${location.totalSectors * location.bytesPerSector}${
        location.mftByteOffset >= location.totalSectors * location.bytesPerSector ? ' ⇒ **MFT 偏移超出卷尾，$Boot 的起始簇号或簇大小解析错了**' : ''
      }`
    )
  if (!looksLikeFileRecord(first))
    return failAnd(
      close,
      'geometry-unverified',
      `按 $Boot 算出的 MFT 偏移 ${location.mftByteOffset} 上没有 FILE 签名（前 4 字节 ${first.subarray(0, 4).toString('hex')}）—— 偏移或扇区大小推断不成立`
    )
  if (!applyUpdateSequence(first, location.bytesPerSector))
    return failAnd(close, 'geometry-unverified', `MFT 首记录的 update sequence 不自洽（sector=${location.bytesPerSector}）—— 扇区大小读错了`)

  const rec0 = parseMftRecord(first, 0)
  if (rec0 === null || !rec0.sizeFromData || rec0.apparentSize <= 0)
    return failAnd(close, 'geometry-unverified', 'MFT 首记录解析不出 $MFT 自身的长度，无法确定遍历上界')

  const mftBytes = rec0.apparentSize
  const recordCount = Math.floor(mftBytes / location.bytesPerFileRecord)
  return { ok: true, fd, geometry: { location, mftBytes, recordCount } }
}

function failAnd(close: () => void, reason: MftFailure, detail: string): { ok: false; reason: MftFailure; detail: string } {
  close()
  return { ok: false, reason, detail }
}

/**
 * 流式遍历 `$MFT`。每读到一条**签名合法**的记录就回调一次；未使用的记录也会回调
 * （`inUse: false`），**跳过与否由调用方决定** —— 解析层与遍历层都不替聚合层做口径决定。
 *
 * 带 `$ATTRIBUTE_LIST` 的记录会当场随机读它指向的扩展记录并合并（见 `applyExtensions`）。
 * **只跟一层**：基记录的清单已经列出了属于这个文件的全部属性，扩展记录里再套清单的情况
 * 由 `extensionHasList` 计数报出来，非零就说明这一层不够、得改成迭代闭包，别静默少算。
 *
 * `onRecord` 抛出的错误原样上抛（不吞），因为那通常是聚合层的 bug，
 * 吞掉就会变成"扫完但少了一半目录"那种最难查的症状。
 */
export function eachMftRecord(
  open: { fd: number; geometry: MftGeometry },
  onRecord: (r: MftRecord) => void
): { visited: number; unparsable: number; blank: number; extensionReads: number; extensionMissed: number; extensionHasList: number } {
  const { location, recordCount } = open.geometry
  const recSize = location.bytesPerFileRecord
  const sector = location.bytesPerSector
  let visited = 0
  /** 开头是 `FILE` 却解不出来（USA 不过 / 属性表荒谬）。这一类是**真在丢记录**，必须和 blank 分开。 */
  let unparsable = 0
  /** 从没写过的槽位（全零）。MFT 是按区预分配的，尾部大量这种空洞，属正常。 */
  let blank = 0
  let extensionReads = 0
  let extensionMissed = 0
  let extensionHasList = 0

  /** 判"从没写过的槽位"用整块 memcmp，不用逐字节 JS 循环（尾部有几十万个这种槽位要过）。 */
  const ZERO = Buffer.alloc(recSize)

  /**
   * 随机读一条记录并过与顺序读同样的三道校验。读不出来返回 null，由调用方计数。
   *
   * 长度不用考虑"凑整扇区"：`bytesPerFileRecord` 来自 `$Boot` 的记录因子，
   * 那一支要么是 2 的幂字节数、要么是"簇数 × 簇大小"，两种都天然是扇区的整数倍。
   */
  const readRecord = (n: number): MftRecord | null => {
    // 不校验 n 是否落在 recordCount 内：越界会读进 MFT 之外的空洞或卷尾之外，readAt 自己
    // 就把它变成短读/异常字符串返回，下面一律按 null 计一笔 missed。清单损坏时真正伤人的
    // 不是越界，而是**指向了别的文件的记录**（那会读回一条合法的 FILE 并把别人的大小并进来）——
    // 要挡那个得校验扩展记录头 +0x20 的基引用是否指回本记录，真卷上没观察到这种损坏，
    // 先不在此设卡，但这一句必须留在这儿，别让下一位以为范围检查就是安全性。
    const buf = readAt(open.fd, location.mftByteOffset + n * recSize, recSize, sector, `$MFT 扩展记录 #${n}`)
    if (typeof buf === 'string') return null
    if (!looksLikeFileRecord(buf) || !applyUpdateSequence(buf, sector)) return null
    return parseMftRecord(buf, n)
  }

  for (let start = 0; start < recordCount; start += RECORDS_PER_CHUNK) {
    const want = Math.min(RECORDS_PER_CHUNK, recordCount - start)
    const got = readAt(open.fd, location.mftByteOffset + start * recSize, want * recSize, sector, `$MFT 记录块 @${start}`)
    if (typeof got === 'string') throw new Error(`${got}｜记录=${recSize} 扇区=${sector} 请求=${want * recSize}`)
    for (let i = 0; i < want; i++) {
      const slice = got.subarray(i * recSize, (i + 1) * recSize)
      if (slice.equals(ZERO)) {
        blank++
        continue
      }
      if (!looksLikeFileRecord(slice) || !applyUpdateSequence(slice, sector)) {
        unparsable++
        continue
      }
      const rec = parseMftRecord(slice, start + i)
      if (rec === null) {
        unparsable++
        continue
      }
      visited++

      if (rec.attributeList.length === 0) {
        onRecord(rec)
        continue
      }
      const exts: MftRecord[] = []
      for (const ref of rec.attributeList) {
        if (exts.some((e) => e.fileNumber === ref.recordNumber)) continue
        const ext = readRecord(ref.recordNumber)
        if (ext === null) {
          extensionMissed++
          continue
        }
        extensionReads++
        if (ext.attributeList.length > 0) extensionHasList++
        exts.push(ext)
      }
      onRecord(applyExtensions(rec, exts))
    }
  }
  return { visited, unparsable, blank, extensionReads, extensionMissed, extensionHasList }
}

export function closeMft(open: { fd: number }): void {
  try {
    closeSync(open.fd)
  } catch {
    /* 已经读完了，关不掉不影响结果 */
  }
}
