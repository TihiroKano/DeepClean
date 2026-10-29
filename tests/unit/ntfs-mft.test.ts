/**
 * `core/ntfs/mft.ts` 的单测。
 *
 * **为什么全靠手搓字节**：默认进程 `fs.open('\\\\.\\C:')` 返回 EPERM，不提权就一条真记录
 * 都读不到。所以能测的部分必须能被造出来测（这也正是把解析器写成纯函数、
 * 不碰 `node:fs` 的唯一理由）。拿到真记录之后这些用例仍然有效，因为它们钉的是
 * "我们承诺怎么解读这个格式"，不是"卷上恰好有什么"。
 *
 * 但**夹具的形状必须由真卷定，不能跟着代码一起错**：2026-10-09 之前这一组的
 * `nonResident()` 把 allocated/real/initialized 摆成 0x24/0x2C/0x34，与解析器的错读法
 * 严丝合缝 ⇒ 18 条全绿、一个真字节都没验过。现在的偏移（+0x28/+0x30/+0x38）与
 * `$DATA` 起始 VCN 都取自 `scripts/_mft-rec0.mjs`（提权）对本机 C: 的转储。
 *
 * 每一组都配了反向用例：只测"能解析出来"是不够的，还得测"不该算进去的没被算进去"
 * （已删记录、"." / ".."、备用数据流、index-view 名字、越界长度）。
 */
import { describe, expect, it } from 'vitest'
import { applyExtensions, applyUpdateSequence, looksLikeFileRecord, parseMftRecord } from '../../core/ntfs/mft'

const RECORD = 1024
const SECTOR = 512

/** 造一条驻留属性。`name` 非空 = 带名字的属性（ADS 那一族）。 */
function resident(type: number, value: Buffer, name?: string): Buffer {
  const nameBuf = name === undefined ? Buffer.alloc(0) : Buffer.from(name, 'utf16le')
  const head = Buffer.alloc(0x18)
  head.writeUInt32LE(type, 0x00)
  head.writeUInt32LE(0x18 + nameBuf.length + value.length, 0x04)
  head.writeUInt8(0, 0x08) // 驻留
  head.writeUInt8(name === undefined ? 0 : nameBuf.length / 2, 0x09)
  head.writeUInt16LE(name === undefined ? 0 : 0x18, 0x0a)
  head.writeUInt32LE(value.length, 0x10) // 值长度
  head.writeUInt16LE(0x18 + nameBuf.length, 0x14) // 值偏移
  return Buffer.concat([head, nameBuf, value])
}

/**
 * 造一条非驻留属性。偏移按 2026-10-09 本机真卷定死的形状（见 `core/ntfs/mft.ts` 的
 * `NR_REAL_SIZE` 注释）：allocated 在 +0x28、real 在 +0x30、initialized 在 +0x38。
 * 这一版夹具原先把三格整体往低挪了 4 字节（0x24/0x2c/0x34），正好和被验的错读法自洽 ——
 * **夹具跟着代码一起错，18 条单测才会一条都不红**。所以下面 allocated 与 real 一律取
 * 不相等的值，让"读错一格"必然被测出来。
 */
function nonResident(type: number, realSize: number, allocatedSize: number, startingVcn = 0n): Buffer {
  const a = Buffer.alloc(0x48)
  a.writeUInt32LE(type, 0x00)
  a.writeUInt32LE(0x48, 0x04)
  a.writeUInt8(1, 0x08) // 非驻留
  a.writeBigUInt64LE(startingVcn, 0x10) // startVcn：这一段从哪个簇号开始，头一段是 0
  a.writeBigUInt64LE(0n, 0x18) // endVcn（= allocated/簇 − 1，真卷如此；解析层不读它）
  a.writeUInt16LE(0x40, 0x20) // 数据运行表偏移：真卷实测恒为 64
  a.writeBigUInt64LE(BigInt(allocatedSize), 0x28)
  a.writeBigUInt64LE(BigInt(realSize), 0x30)
  a.writeBigUInt64LE(BigInt(realSize), 0x38)
  return a
}

/** 造一条 `$FILE_NAME` 的值。 */
function fileNameValue(o: {
  parentFileNumber: number
  parentSequence?: number
  name: string
  realSize?: number
  flags?: number
  namespace?: number
}): Buffer {
  const nameBuf = Buffer.from(o.name, 'utf16le')
  const v = Buffer.alloc(0x42 + nameBuf.length)
  v.writeBigUInt64LE((BigInt(o.parentSequence ?? 1) << 48n) | BigInt(o.parentFileNumber), 0x00)
  v.writeBigUInt64LE(BigInt(o.realSize ?? 0), 0x30)
  v.writeUInt32LE(o.flags ?? 0, 0x38)
  v.writeUInt8(nameBuf.length / 2, 0x40)
  v.writeUInt8(o.namespace ?? 3, 0x41)
  nameBuf.copy(v, 0x42)
  return v
}

/**
 * 造一条 `$ATTRIBUTE_LIST` 的值。条目头固定 24 字节，无名属性就到此为止（带名/驻留的
 * 条目会更长，解析层按 +0x04 那格的条目长跳，所以长条目也要能走通 —— 见下面那条用例）。
 * `entryLen` = 写进 +0x04 的数；`slot` = 实际占用的字节（默认跟 entryLen 一致，
 * 单独给它是为了摆出"条目长谎报"那种输入而不把记录撑爆）。
 */
function attrListValue(
  entries: { type: number; lowerVcn?: bigint; recordNumber: number; recordSequence?: number; entryLen?: number; slot?: number }[]
): Buffer {
  const size = entries.reduce((s, e) => s + (e.slot ?? e.entryLen ?? 24), 0)
  const v = Buffer.alloc(size)
  let p = 0
  for (const e of entries) {
    v.writeUInt32LE(e.type, p + 0)
    v.writeUInt16LE(e.entryLen ?? 24, p + 4)
    v.writeUInt8(0, p + 6) // 属性无名
    v.writeUInt8(0, p + 7) // 值驻留
    v.writeBigUInt64LE(e.lowerVcn ?? 0n, p + 8)
    v.writeBigUInt64LE((BigInt(e.recordSequence ?? 1) << 48n) | BigInt(e.recordNumber), p + 16)
    p += e.slot ?? e.entryLen ?? 24
  }
  return v
}

/**
 * 组装一条记录。`usaMode` 决定 update sequence array 按哪种约定摆：
 *  · 'A' —— USA[0] 就是 USN，USA[1..] 是各扇区尾原值；
 *  · 'B' —— USN 单独在记录头 0x08，USA[0..] 全是扇区尾原值；
 *  · 'bad' —— 扇区尾与两种候选都不符，修正必须拒绝（不能静默改错位置）。
 */
function makeRecord(o: {
  seq?: number
  flags?: number
  attrs?: Buffer[]
  usaMode?: 'A' | 'B' | 'bad'
}): Buffer {
  const usaOffset = 0x40
  const attrs = o.attrs ?? []
  const firstAttr = 0x60
  const buf = Buffer.alloc(RECORD)
  buf.writeUInt32LE(0x45_4c_49_46, 0x00) // 'FILE'
  buf.writeUInt16LE(usaOffset, 0x04)
  buf.writeUInt16LE(o.usaMode === 'B' ? 2 : 3, 0x06)
  buf.writeUInt16LE(o.usaMode === 'B' ? 0x2b17 : 0, 0x08) // B 派：USN 单独放在这里
  buf.writeUInt16LE(o.seq ?? 7, 0x10)
  buf.writeUInt16LE(firstAttr, 0x14)
  buf.writeUInt16LE(o.flags ?? 0x01, 0x16)
  let at = firstAttr
  for (const a of attrs) {
    if (at + a.length > RECORD) throw new Error('测试夹具：属性超出记录长度')
    a.copy(buf, at)
    at += a.length
  }
  buf.writeUInt32LE(0xffff_ffff, at) // $END

  // 扇区尾打戳：把每个扇区最后 2 字节换成 USN，原值存进 USA。
  // 原值故意写成**非零哨兵** —— 若原值是 0，"修回 0"和"根本没修"在断言里长得一模一样，
  // 那这条测试就只是在测打戳那一步有没有把 0 换成 USN。
  for (let i = 1; i * SECTOR <= RECORD; i++) buf.writeUInt16LE(0xd000 + i, i * SECTOR - 2)
  const usn = 0x2b17
  const saved: number[] = []
  for (let i = 1; i * SECTOR <= RECORD; i++) saved.push(buf.readUInt16LE(i * SECTOR - 2))
  const usa = Buffer.alloc(6)
  if (o.usaMode === 'B') {
    for (let i = 0; i < saved.length; i++) usa.writeUInt16LE(saved[i]!, i * 2)
  } else {
    usa.writeUInt16LE(usn, 0)
    for (let i = 0; i < saved.length; i++) usa.writeUInt16LE(saved[i]!, 2 + i * 2)
  }
  usa.copy(buf, usaOffset)
  for (let i = 1; i * SECTOR <= RECORD; i++) {
    buf.writeUInt16LE(o.usaMode === 'bad' ? usn ^ 0xffff : usn, i * SECTOR - 2)
  }
  return buf
}

/** 一条最小的 `$FILE_NAME`（挂在根目录 5 下），大小写进索引项那份缓存里。 */
const nameAttr = (realSize: number, name = 'pagefile.sys'): Buffer =>
  resident(0x30, fileNameValue({ parentFileNumber: 5, name, realSize }))

describe('记录头最小校验', () => {
  it('只认 FILE 签名，别的都拒', () => {
    expect(looksLikeFileRecord(makeRecord({}))).toBe(true)
    const bad = makeRecord({})
    bad.writeUInt32LE(0x58444e49, 0) // 'INDX'
    expect(looksLikeFileRecord(bad)).toBe(false)
    expect(parseMftRecord(bad, 12)).toBeNull()
    expect(parseMftRecord(Buffer.alloc(20), 12)).toBeNull()
  })
})

describe('applyUpdateSequence：两种约定都要认，认不出必须拒', () => {
  it('A 派（USN 在 USA[0]）修得回来', () => {
    const buf = makeRecord({ usaMode: 'A' })
    expect(applyUpdateSequence(buf, SECTOR)).toBe(true)
    // 两个扇区尾都必须换回各自的哨兵 —— 少修一个就是当初那个差一错误
    expect(buf.readUInt16LE(SECTOR - 2)).toBe(0xd001)
    expect(buf.readUInt16LE(2 * SECTOR - 2)).toBe(0xd002)
  })

  it('B 派（USN 在记录头 0x08）修得回来', () => {
    const buf = makeRecord({ usaMode: 'B' })
    expect(applyUpdateSequence(buf, SECTOR)).toBe(true)
    expect(buf.readUInt16LE(SECTOR - 2)).toBe(0xd001)
    expect(buf.readUInt16LE(2 * SECTOR - 2)).toBe(0xd002)
  })

  it('扇区尾与两种候选都对不上 ⇒ 返回 false 且**一个字节都不改**', () => {
    const buf = makeRecord({ usaMode: 'bad' })
    const before = Buffer.from(buf)
    expect(applyUpdateSequence(buf, SECTOR)).toBe(false)
    expect(buf.equals(before)).toBe(true)
  })

  it('扇区大小给错时不硬修', () => {
    const buf = makeRecord({ usaMode: 'A' })
    const before = Buffer.from(buf)
    expect(applyUpdateSequence(buf, 4096)).toBe(false)
    expect(buf.equals(before)).toBe(true)
  })
})

describe('parseMftRecord：大小口径', () => {
  it('驻留 $DATA：大小取值长度', () => {
    const r = parseMftRecord(makeRecord({ attrs: [nameAttr(4096), resident(0x80, Buffer.alloc(300))] }), 9001)!
    expect(r.apparentSize).toBe(300)
    expect(r.sizeFromData).toBe(true)
  })

  it('非驻留 $DATA：大小取 real size（+0x30），不是 allocated size（+0x28）', () => {
    // 两个数取自本机真卷（`scripts/_mft-rec0.mjs`，提权）：pagefile.sys 的 $DATA 在扩展记录
    // #13120，allocated = 9,951,739,904（4096 的整数倍）、real = 9,714,868,224（不是）。
    // **两值必须不相等**：上一版夹具让 allocated 与 real 同值，于是"读错一格"根本红不了 ——
    // 夹具跟着代码一起错，18 条单测全绿却一个字节都没验过。
    const r = parseMftRecord(makeRecord({ attrs: [nameAttr(1), nonResident(0x80, 9_714_868_224, 9_951_739_904)] }), 2)!
    expect(r.apparentSize).toBe(9_714_868_224)
    expect(r.sizeFromData).toBe(true)
    // 反向钉：real 那格清零、只留 allocated ⇒ 大小必须是 0，不许被 allocated 顶替
    const zeroed = parseMftRecord(makeRecord({ attrs: [nameAttr(1), nonResident(0x80, 0, 9_951_739_904)] }), 2)!
    expect(zeroed.apparentSize).toBe(0)
  })

  it('没有 $DATA 才退回 $FILE_NAME 那份，并如实标注来源', () => {
    const r = parseMftRecord(makeRecord({ attrs: [nameAttr(777)] }), 3)!
    expect(r.apparentSize).toBe(777)
    expect(r.sizeFromData).toBe(false)
  })

  it('带名字的 $DATA（备用数据流）不算进文件大小', () => {
    const ads = resident(0x80, Buffer.alloc(400), 'Secret')
    const r = parseMftRecord(makeRecord({ attrs: [nameAttr(42), ads] }), 4)!
    expect(r.apparentSize).toBe(42)
    expect(r.sizeFromData).toBe(false)
  })

  it('目录记录即使挂着 $DATA 也算 0', () => {
    const r = parseMftRecord(
      makeRecord({ flags: 0x03, attrs: [nameAttr(0), nonResident(0x80, 999, 4096)] }),
      5
    )!
    expect(r.isDir).toBe(true)
    expect(r.apparentSize).toBe(0)
  })

  it('0 字节文件与"没量到"分得开：前者 sizeFromData 为真', () => {
    const zero = parseMftRecord(makeRecord({ attrs: [nameAttr(0), resident(0x80, Buffer.alloc(0))] }), 6)!
    expect(zero.apparentSize).toBe(0)
    expect(zero.sizeFromData).toBe(true)
  })
})

describe('parseMftRecord：哪些记录/名字不该进账', () => {
  it('未在使用（flag bit0 缺）的记录被标出来，不是被静默当 0 大小', () => {
    const r = parseMftRecord(
      makeRecord({ flags: 0x00, attrs: [resident(0x30, fileNameValue({ parentFileNumber: 5, name: 'gone', realSize: 100 }))] }),
      7
    )!
    expect(r.inUse).toBe(false)
    expect(r.apparentSize).toBe(100) // 解析层不改值，跳过是聚合层的决定
  })

  it('"." / ".." 与 index-view 条目都不算"在父目录里的名字"', () => {
    const attrs = [
      resident(0x30, fileNameValue({ parentFileNumber: 5, name: 'real.txt' })),
      resident(0x30, fileNameValue({ parentFileNumber: 5, name: '.', flags: 0x40 })),
      resident(0x30, fileNameValue({ parentFileNumber: 5, name: '..', flags: 0x40 })),
      resident(0x30, fileNameValue({ parentFileNumber: 5, name: 'shadow', flags: 0x40 }))
    ]
    const r = parseMftRecord(makeRecord({ attrs }), 8)!
    expect(r.names.map((n) => n.name)).toEqual(['real.txt'])
  })

  it('一条记录两个父 = 硬链接，两个名字都带回来，大小只有一份', () => {
    const attrs = [
      resident(0x30, fileNameValue({ parentFileNumber: 5, name: 'a.txt', realSize: 10 })),
      resident(0x30, fileNameValue({ parentFileNumber: 24, name: 'b.txt', realSize: 10 })),
      nonResident(0x80, 10, 10)
    ]
    const r = parseMftRecord(makeRecord({ attrs }), 9)!
    expect(r.names.map((n) => [n.parentFileNumber, n.name])).toEqual([
      [5, 'a.txt'],
      [24, 'b.txt']
    ])
    expect(r.apparentSize).toBe(10)
  })

  it('父引用按低 48 位=记录号 / 高 16 位=sequence 拆', () => {
    const max48 = 2 ** 48 - 1 // 48 位全 1：再往上就要进到 sequence 那 16 位了
    const attrs = [resident(0x30, fileNameValue({ parentFileNumber: max48, parentSequence: 0xbeef, name: 'x' }))]
    const r = parseMftRecord(makeRecord({ attrs }), 10)!
    expect(r.names[0]!.parentFileNumber).toBe(max48)
    expect(r.names[0]!.parentSequence).toBe(0xbeef)
  })

  it('属性长度自相矛盾时停在原地，不越界、不抛', () => {
    const broken = Buffer.alloc(16)
    broken.writeUInt32LE(0x80, 0)
    broken.writeUInt32LE(1 << 20, 4) // 长度超出记录
    const r = parseMftRecord(makeRecord({ attrs: [broken] }), 11)!
    expect(r.apparentSize).toBe(0)
    expect(r.sizeFromData).toBe(false)
  })

  it('属性名越出本属性边界 ⇒ 整条停住，不拿错位的 nameLen 去判 ADS', () => {
    // 手搓一条"nameLen 说名字有 200 个字符、但属性本身只有 0x48 长"的 $DATA
    const a = Buffer.alloc(0x48)
    a.writeUInt32LE(0x80, 0x00) // $DATA
    a.writeUInt32LE(0x48, 0x04) // 本属性长 0x48
    a.writeUInt8(1, 0x08) // 非驻留
    a.writeUInt8(200, 0x09) // 谎称名字 200 个字符
    a.writeUInt16LE(0x40, 0x0a) // 名字偏移
    a.writeBigUInt64LE(9_000_000n, 0x30) // real size —— 若没被这道界检拦住，就会被算进去
    const r = parseMftRecord(makeRecord({ attrs: [nameAttr(42), a] }), 13)!
    expect(r.apparentSize).toBe(42) // 停在谎报的属性之前，保留前一条 $FILE_NAME 的兜底值
    expect(r.sizeFromData).toBe(false)
  })

  it('名字越出属性边界 ⇒ 宁可少一个名字', () => {
    const v = fileNameValue({ parentFileNumber: 5, name: 'ok' })
    v.writeUInt8(200, 0x40) // 谎称名字有 200 个字符
    const r = parseMftRecord(makeRecord({ attrs: [resident(0x30, v)] }), 12)!
    expect(r.names).toHaveLength(0)
  })
})

describe('$ATTRIBUTE_LIST：溢出清单的读取', () => {
  it('条目里的记录号与 sequence 拆得开，指向本记录的那条被滤掉', () => {
    // 真卷上 #3370 的清单确实会把它自己已有的 0x10/0x30 也列进来，所以自指必须滤掉，
    // 否则遍历器会对着自己来一次随机读。
    const r = parseMftRecord(
      makeRecord({
        attrs: [
          nameAttr(0),
          resident(0x20, attrListValue([
            { type: 0x10, recordNumber: 3370 }, // 自指 ⇒ 丢
            { type: 0x80, lowerVcn: 0n, recordNumber: 13120, recordSequence: 14 }
          ]))
        ]
      }),
      3370
    )!
    expect(r.attributeList).toEqual([{ type: 0x80, lowerVcn: 0n, recordNumber: 13120, recordSequence: 14 }])
  })

  it('条目长度不是 24 也得按 +0x04 跳（真卷实测有 32 字节的条目）', () => {
    const r = parseMftRecord(
      makeRecord({
        attrs: [
          nameAttr(0),
          resident(0x20, attrListValue([
            { type: 0x30, recordNumber: 7, entryLen: 32 },
            { type: 0x80, recordNumber: 9, lowerVcn: 12n, entryLen: 40 }
          ]))
        ]
      }),
      1
    )!
    expect(r.attributeList.map((e) => [e.type, e.recordNumber, e.lowerVcn])).toEqual([
      [0x30, 7, 0n],
      [0x80, 9, 12n]
    ])
  })

  it('条目长谎报到越出清单值 ⇒ 停在已读到的那些之后，不往下猜', () => {
    const r = parseMftRecord(
      makeRecord({
        attrs: [
          nameAttr(0),
          resident(0x20, attrListValue([{ type: 0x80, recordNumber: 5 }, { type: 0x80, recordNumber: 6, entryLen: 9999, slot: 24 }]))
        ]
      }),
      1
    )!
    expect(r.attributeList).toHaveLength(1)
    expect(r.attributeList[0]!.recordNumber).toBe(5)
  })
})

describe('applyExtensions：把扩展记录合并进基记录', () => {
  /** 基记录：只有 $FILE_NAME（大小兜底为 0）+ 一条指向 #13120 的清单。 */
  const spilledBase = () =>
    parseMftRecord(
      makeRecord({
        attrs: [
          nameAttr(0),
          resident(0x20, attrListValue([{ type: 0x80, lowerVcn: 0n, recordNumber: 13120, recordSequence: 14 }]))
        ]
      }),
      3370
    )!

  it('基记录没有 $DATA 时用扩展记录头一段（VCN 0）的大小', () => {
    const ext = parseMftRecord(
      makeRecord({ attrs: [nameAttr(0), nonResident(0x80, 9_714_868_224, 9_951_739_904)] }),
      13120
    )!
    expect(ext.dataStartingVcn).toBe(0n)
    const m = applyExtensions(spilledBase(), [ext])
    expect(m.apparentSize).toBe(9_714_868_224)
    expect(m.sizeFromData).toBe(true)
    // 基记录本身不许被改动（改了就分不清盘上原样）
    expect(spilledBase().apparentSize).toBe(0)
  })

  it('扩展记录是 VCN>0 的碎片 ⇒ 大小不许拿，保持如实的 sizeFromData:false', () => {
    const frag = parseMftRecord(
      makeRecord({ attrs: [nameAttr(0), nonResident(0x80, 4096, 4096, 2429n)] }),
      13121
    )!
    const m = applyExtensions(spilledBase(), [frag])
    expect(m.apparentSize).toBe(0)
    expect(m.sizeFromData).toBe(false)
  })

  it('基记录已经有 $DATA ⇒ 扩展只补名字，不覆盖大小', () => {
    const base = parseMftRecord(makeRecord({ attrs: [nameAttr(111), resident(0x80, Buffer.alloc(111))] }), 20)!
    expect(base.sizeFromData).toBe(true) // 前提：这条基记录自己就带着大小，下面才谈得上"不许被覆盖"
    const ext = parseMftRecord(
      makeRecord({ attrs: [resident(0x30, fileNameValue({ parentFileNumber: 88, name: 'other.txt', realSize: 0 })), nonResident(0x80, 9_999, 12_288)] }),
      21
    )!
    const m = applyExtensions(base, [ext])
    expect(m.apparentSize).toBe(111)
    expect(m.sizeFromData).toBe(true)
    expect(m.names.length).toBeGreaterThan(base.names.length)
  })

  it('硬链接的第二个名字从扩展记录补进来，同名同父不重复计', () => {
    const base = parseMftRecord(makeRecord({ attrs: [nameAttr(10)] }), 30)!
    const ext = parseMftRecord(
      makeRecord({
        attrs: [
          resident(0x30, fileNameValue({ parentFileNumber: 5, name: 'same.txt', realSize: 10 })),
          resident(0x30, fileNameValue({ parentFileNumber: 88, name: 'link.txt', realSize: 10 }))
        ]
      }),
      31
    )!
    // base 的名字是 nameAttr(10) 造的，父 = 5；把它的名字改成与 ext 第一条同名同父，验去重
    const baseWithSame = { ...base, names: [{ ...base.names[0]!, name: 'same.txt', parentFileNumber: 5 }] }
    const m = applyExtensions(baseWithSame, [ext])
    expect(m.names.map((n) => n.parentFileNumber + '/' + n.name)).toEqual(['5/same.txt', '88/link.txt'])
  })

  it('目录身份可以从扩展记录补上，补上之后大小口径回到恒 0', () => {
    const base = parseMftRecord(makeRecord({ attrs: [nameAttr(0), nonResident(0x80, 50, 4096)] }), 40)!
    const dirExt = parseMftRecord(
      makeRecord({ flags: 0x03, attrs: [resident(0x30, fileNameValue({ parentFileNumber: 5, name: 'd' }))] }),
      41
    )!
    expect(dirExt.isDir).toBe(true)
    const m = applyExtensions({ ...base, isDir: false }, [dirExt])
    expect(m.isDir).toBe(true)
    expect(m.apparentSize).toBe(0)
  })
})

/**
 * `allocatedSize` 是给"扫描总数比卷还大"这类超额做分解用的第二口径。它**不进任何界面数字**
 * （`apparentSize` 才是全仓口径），所以这里的判据全部围绕一件事：**取错格就必须红**。
 * 夹具的 `nonResident` 刻意让 allocated 与 real 不相等（真卷 pagefile.sys 的两个值），
 * 所以 +0x28 / +0x30 互换一定被这些用例抓到。
 */
describe('allocatedSize：簇分配口径只对账、不进账', () => {
  it('非驻留 $DATA 取 +0x28，与 apparentSize 各取各格', () => {
    const r = parseMftRecord(makeRecord({ attrs: [nameAttr(1), nonResident(0x80, 9_714_868_224, 9_951_739_904)] }), 2)!
    expect(r.allocatedSize).toBe(9_951_739_904)
    expect(r.apparentSize).toBe(9_714_868_224)
    // 反向钉：把 allocated 那格清零 ⇒ 表观大小不许跟着变 0
    const zeroed = parseMftRecord(makeRecord({ attrs: [nameAttr(1), nonResident(0x80, 9_714_868_224, 0)] }), 2)!
    expect(zeroed.allocatedSize).toBe(0)
    expect(zeroed.apparentSize).toBe(9_714_868_224)
  })

  it('驻留 $DATA 恒 0 —— 字节住在 MFT 记录里，再占一次簇就是双计', () => {
    const r = parseMftRecord(makeRecord({ attrs: [nameAttr(4096), resident(0x80, Buffer.alloc(300))] }), 9001)!
    expect(r.apparentSize).toBe(300)
    expect(r.allocatedSize).toBe(0)
  })

  it('没有 $DATA 时不许拿 $FILE_NAME 那份缓存冒充分配大小', () => {
    const r = parseMftRecord(makeRecord({ attrs: [nameAttr(777)] }), 3)!
    expect(r.sizeFromData).toBe(false)
    expect(r.apparentSize).toBe(777)
    expect(r.allocatedSize).toBe(0)
  })

  it('目录恒 0，即使挂着非驻留 $DATA', () => {
    const r = parseMftRecord(makeRecord({ flags: 0x03, attrs: [nameAttr(0), nonResident(0x80, 999, 4096)] }), 5)!
    expect(r.isDir).toBe(true)
    expect(r.allocatedSize).toBe(0)
  })

  it('合并扩展记录：allocated 跟大小取同一段（VCN 0），碎片段不许顶替', () => {
    const base = parseMftRecord(
      makeRecord({
        attrs: [
          nameAttr(0),
          resident(0x20, attrListValue([{ type: 0x80, lowerVcn: 0n, recordNumber: 13120, recordSequence: 14 }]))
        ]
      }),
      3370
    )!
    const ext = parseMftRecord(makeRecord({ attrs: [nameAttr(0), nonResident(0x80, 9_714_868_224, 9_951_739_904)] }), 13120)!
    expect(applyExtensions(base, [ext]).allocatedSize).toBe(9_951_739_904)

    const frag = parseMftRecord(makeRecord({ attrs: [nameAttr(0), nonResident(0x80, 4096, 8192, 2429n)] }), 13121)!
    const m = applyExtensions(base, [frag])
    expect(m.sizeFromData).toBe(false)
    expect(m.allocatedSize).toBe(0) // 碎片那格 8192 不许被当成全量
  })

  it('基记录自带 $DATA 时，扩展的分配大小不许覆盖', () => {
    const base = parseMftRecord(makeRecord({ attrs: [nameAttr(111), resident(0x80, Buffer.alloc(111))] }), 20)!
    const ext = parseMftRecord(makeRecord({ attrs: [nameAttr(0), nonResident(0x80, 9_999, 12_288)] }), 21)!
    const m = applyExtensions(base, [ext])
    expect(m.apparentSize).toBe(111)
    expect(m.allocatedSize).toBe(0)
  })
})
