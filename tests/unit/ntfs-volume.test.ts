/**
 * `core/ntfs/volume.ts` 里**遍历器**那一层的单测（`eachMftRecord`）。
 *
 * `openMft` 走裸卷、要提权，本机默认进程一条字节都读不到；但 `eachMftRecord` 只要一个
 * 能 `readSync` 的 fd —— 所以把它喂给一个手搓的合成 `$MFT` 临时文件，遍历、空槽分类、
 * `$ATTRIBUTE_LIST` 跟随这些行为就全都能在不开 UAC 的情况下测到。
 * 这一层的价值恰恰在"要不要多跑一次随机读、读不到时算哪种账"，而那些正是
 * 提权探针只能看总数、看不出来判据。
 *
 * 记录形状（USA 在 0x30、属性表在 0x38、非驻留大小在 +0x30）按 2026-10-09 本机真卷转储摆，
 * 与 `ntfs-mft.test.ts` 同一套事实来源。
 */
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { eachMftRecord, type MftGeometry } from '../../core/ntfs/volume'
import type { MftRecord } from '../../core/ntfs/mft'

const RECORD = 1024
const SECTOR = 512
const USA_AT = 0x30
const ATTRS_AT = 0x38

function residentAttr(type: number, value: Buffer): Buffer {
  const head = Buffer.alloc(0x18)
  head.writeUInt32LE(type, 0x00)
  head.writeUInt32LE(0x18 + value.length, 0x04)
  head.writeUInt8(0, 0x08) // 驻留
  head.writeUInt32LE(value.length, 0x10)
  head.writeUInt16LE(0x18, 0x14)
  return Buffer.concat([head, value])
}

/** 非驻留 `$DATA`：allocated 在 +0x28、real 在 +0x30、起始 VCN 在 +0x10（真卷读数）。 */
function dataAttr(real: number, allocated: number, startingVcn = 0n): Buffer {
  const a = Buffer.alloc(0x48)
  a.writeUInt32LE(0x80, 0x00)
  a.writeUInt32LE(0x48, 0x04)
  a.writeUInt8(1, 0x08)
  a.writeBigUInt64LE(startingVcn, 0x10)
  a.writeUInt16LE(0x40, 0x20)
  a.writeBigUInt64LE(BigInt(allocated), 0x28)
  a.writeBigUInt64LE(BigInt(real), 0x30)
  a.writeBigUInt64LE(BigInt(real), 0x38)
  return a
}

/** `$FILE_NAME` 用档案命名空间（0x40 那一位是 index-view，置上就会被解析器滤掉）。 */
function fnAttr(parentFileNumber: number, name: string, realSize = 0): Buffer {
  const nb = Buffer.from(name, 'utf16le')
  const v = Buffer.alloc(0x42 + nb.length)
  v.writeBigUInt64LE((1n << 48n) | BigInt(parentFileNumber), 0x00)
  v.writeBigUInt64LE(BigInt(realSize), 0x30)
  v.writeUInt32LE(0x20, 0x38)
  v.writeUInt8(nb.length / 2, 0x40)
  v.writeUInt8(3, 0x41)
  nb.copy(v, 0x42)
  return residentAttr(0x30, v)
}

/** `$ATTRIBUTE_LIST`：每条 24 字节头，无名属性到此为止。 */
function alAttr(entries: { type: number; lowerVcn?: bigint; recordNumber: number; recordSequence?: number }[]): Buffer {
  const v = Buffer.alloc(entries.length * 24)
  entries.forEach((e, i) => {
    const p = i * 24
    v.writeUInt32LE(e.type, p + 0)
    v.writeUInt16LE(24, p + 4)
    v.writeBigUInt64LE(e.lowerVcn ?? 0n, p + 8)
    v.writeBigUInt64LE((BigInt(e.recordSequence ?? 1) << 48n) | BigInt(e.recordNumber), p + 16)
  })
  return residentAttr(0x20, v)
}

function record(attrs: Buffer[], flags = 0x01): Buffer {
  const buf = Buffer.alloc(RECORD)
  buf.write('FILE', 0x00, 'latin1')
  buf.writeUInt16LE(USA_AT, 0x04)
  buf.writeUInt16LE(3, 0x06) // USA 字数 = 扇区数(2) + 1
  buf.writeUInt16LE(1, USA_AT) // USA[0] = USN，两个扇区尾此刻都必须是 1
  buf.writeUInt16LE(ATTRS_AT, 0x14)
  buf.writeUInt16LE(flags, 0x16)
  let at = ATTRS_AT
  for (const a of attrs) {
    a.copy(buf, at)
    at += a.length
  }
  buf.writeUInt16LE(1, SECTOR - 2)
  buf.writeUInt16LE(1, RECORD - 2)
  return buf
}

/** 把若干条记录写成一个临时"卷"，只覆盖 MFT 那一段。 */
function withMft(records: Buffer[], run: (fd: number, geometry: MftGeometry) => void): void {
  const file = join(tmpdir(), `deepclean-mft-${process.pid}-${Math.random().toString(36).slice(2)}.bin`)
  writeFileSync(file, Buffer.concat(records))
  const fd = openSync(file, 'r')
  try {
    const geometry: MftGeometry = {
      location: {
        bytesPerSector: SECTOR,
        sectorsPerCluster: 8,
        bytesPerFileRecord: RECORD,
        mftByteOffset: 0,
        totalSectors: records.length * 8
      },
      mftBytes: records.length * RECORD,
      recordCount: records.length
    }
    run(fd, geometry)
  } finally {
    closeSync(fd)
    unlinkSync(file)
  }
}

describe('eachMftRecord：空槽分类与 $ATTRIBUTE_LIST 跟随', () => {
  it('全零槽算 blank、不算"解不出"；带清单的记录会读扩展记录并合并大小与名字', () => {
    const base = record([fnAttr(5, 'big.bin'), alAttr([{ type: 0x80, lowerVcn: 0n, recordNumber: 2 }])])
    const ext = record([fnAttr(9, 'link.bin'), dataAttr(9_714_868_224, 9_951_739_904)])
    withMft([base, Buffer.alloc(RECORD), ext, Buffer.alloc(RECORD)], (fd, geometry) => {
      const out: MftRecord[] = []
      const stats = eachMftRecord({ fd, geometry }, (r) => out.push(r))
      expect(stats).toEqual({
        visited: 2,
        unparsable: 0,
        blank: 2,
        extensionReads: 1,
        extensionMissed: 0,
        extensionHasList: 0
      })
      const merged = out.find((r) => r.fileNumber === 0)!
      expect(merged.apparentSize).toBe(9_714_868_224) // 来自 #2 的 $DATA，而不是清单里 $FILE_NAME 的 0
      expect(merged.sizeFromData).toBe(true)
      expect(merged.names.map((n) => n.name)).toEqual(['big.bin', 'link.bin'])
    })
  })

  it('清单指向记录数之外 ⇒ 记一笔 extensionMissed，不 throw、大小不许被编出来', () => {
    // 越界本身不是危险（readAt 会把它变成短读字符串）；这一条钉的是**账**：读不出来就如实
    // 记 missed 并保持 sizeFromData:false，既不崩整次扫描，也不拿别的字节凑一个大小出来。
    const base = record([fnAttr(5, 'ghost.bin'), alAttr([{ type: 0x80, recordNumber: 99 }])])
    withMft([base, Buffer.alloc(RECORD)], (fd, geometry) => {
      const out: MftRecord[] = []
      const stats = eachMftRecord({ fd, geometry }, (r) => out.push(r))
      expect(stats.extensionReads).toBe(0)
      expect(stats.extensionMissed).toBe(1)
      expect(out[0]!.apparentSize).toBe(0)
      expect(out[0]!.sizeFromData).toBe(false) // 如实标注：没拿到 $DATA 就是没拿到
    })
  })

  it('没有清单的记录一条随机读都不发（热路径没被拖慢）', () => {
    const plain = record([fnAttr(5, 'a.bin'), dataAttr(1234, 4096)])
    withMft([plain, plain, Buffer.alloc(RECORD)], (fd, geometry) => {
      const stats = eachMftRecord({ fd, geometry }, () => {})
      expect(stats).toMatchObject({ visited: 2, extensionReads: 0, extensionMissed: 0 })
    })
  })

  it('扩展记录是 VCN>0 的碎片 ⇒ 大小不许拿它顶替', () => {
    const base = record([fnAttr(5, 'frag.bin'), alAttr([{ type: 0x80, lowerVcn: 2429n, recordNumber: 1 }])])
    const frag = record([fnAttr(5, 'frag.bin'), dataAttr(4096, 4096, 2429n)])
    withMft([base, frag], (fd, geometry) => {
      const out: MftRecord[] = []
      eachMftRecord({ fd, geometry }, (r) => out.push(r))
      const merged = out.find((r) => r.fileNumber === 0)!
      expect(merged.sizeFromData).toBe(false)
      expect(merged.apparentSize).toBe(0)
    })
  })

  it('USA 对不上的记录进 unparsable，不进 blank', () => {
    const broken = record([fnAttr(5, 'x.bin')])
    broken.writeUInt16LE(0x9999, SECTOR - 2) // 扇区尾不是 USN ⇒ 两种约定都验不过
    withMft([broken, Buffer.alloc(RECORD)], (fd, geometry) => {
      const stats = eachMftRecord({ fd, geometry }, () => {})
      expect(stats).toMatchObject({ visited: 0, unparsable: 1, blank: 1 })
    })
  })
})
