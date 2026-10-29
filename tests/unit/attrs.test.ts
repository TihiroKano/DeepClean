import { describe, expect, it } from 'vitest'
import {
  attrRows,
  attrsFromStatMode,
  attrState,
  classifyEntry,
  PROVABLE_WIN_ATTR,
  protectedByAttrs,
  WIN_ATTR,
  RISK_BY_GROUP
} from '../../shared/classify'

/**
 * 这四个 mode 常量**不是编出来的**，是在本机（Win11 / Node 24.19 / Electron 44 内的 node 24.20 /
 * libuv 1.52.1）对同一份目录逐个 Set-ItemProperty 设属性后 `fs.statSync().mode` 量出来的：
 *
 *   Attributes = Normal（一个属性都没有）      → mode 33206 (0o100666)
 *   Attributes = Archive                       → mode 33206 (0o100666)
 *   Attributes = Hidden, Archive               → mode 33206 (0o100666)
 *   Attributes = System, Archive               → mode 33206 (0o100666)
 *   Attributes = Hidden, System, Archive       → mode 33206 (0o100666)
 *   Attributes = ReadOnly, Archive             → mode 33060 (0o100444)
 *   Attributes = ReadOnly, Hidden, System, A   → mode 33060 (0o100444)
 *
 * 结论：一次 stat 里 **只有 READONLY 判得出来**（表现为写权限位被抹掉），
 * HIDDEN / SYSTEM / ARCHIVE 在 st_mode 里不携带任何信息 —— 计划 Task 15 的
 * 「映射进 bit 1/2/4/32」假设被自己的测量推翻。本文件就是这条测量的守门测试。
 */
const MODE_WRITABLE = 0o100666
const MODE_READONLY = 0o100444

describe('WIN_ATTR 位值（Windows FILE_ATTRIBUTE_*）', () => {
  it('位值必须与 Win32 常量一致：R=1 H=2 S=4 A=32', () => {
    expect(WIN_ATTR).toEqual({ readonly: 1, hidden: 2, system: 4, archive: 32 })
  })
})

describe('attrsFromStatMode —— st_mode → 已证明属性位', () => {
  it('只读文件的 mode 判出 READONLY', () => {
    expect(attrsFromStatMode(MODE_READONLY)).toBe(WIN_ATTR.readonly)
  })
  it('可写文件判不出任何属性（0），而不是判成「有隐藏/系统属性」', () => {
    expect(attrsFromStatMode(MODE_WRITABLE)).toBe(0)
  })
  it('陷阱回归哨兵：0o100666 里 bit 2/4/32 本来是置位的（那是 POSIX 权限位），照抄「mode & 2」会把每一个可写文件都报成隐藏文件', () => {
    // 这条断言守的是「不许有人把 raw mode 当 attrs 用」——上面两行才是正确解码。
    expect(MODE_WRITABLE & WIN_ATTR.hidden).not.toBe(0)
    expect(MODE_WRITABLE & WIN_ATTR.system).not.toBe(0)
    expect(MODE_WRITABLE & WIN_ATTR.archive).not.toBe(0)
    expect(attrsFromStatMode(MODE_WRITABLE) & WIN_ATTR.hidden).toBe(0)
  })
  it('输出只能是 PROVABLE_WIN_ATTR 的子集', () => {
    for (const m of [MODE_WRITABLE, MODE_READONLY, 0o100644, 0o40444, 0o40666]) {
      expect(attrsFromStatMode(m) & ~PROVABLE_WIN_ATTR).toBe(0)
    }
  })
})

describe('attrState —— 三态判定，unknown ≠ clear', () => {
  it('READONLY 判得出是与否', () => {
    expect(attrState(WIN_ATTR.readonly, 'readonly')).toBe('set')
    expect(attrState(0, 'readonly')).toBe('clear')
  })
  it('HIDDEN / SYSTEM / ARCHIVE 在当前属性源下：位没置上就是 unknown，不许猜 clear', () => {
    for (const key of ['hidden', 'system', 'archive'] as const) {
      expect(attrState(0, key)).toBe('unknown')
    }
  })
  it('bitmask 是唯一契约：谁置上位就认谁（今天的 attrsFromStatMode 永远不置这几位，另有测试锁住）', () => {
    for (const key of ['hidden', 'system', 'archive'] as const) {
      expect(attrState(WIN_ATTR[key], key)).toBe('set')
    }
  })
})

describe('attrRows —— 详情面板的 隐藏/系统/只读/存档 四行', () => {
  it('文件：四个属性各一行，顺序固定为 隐藏/系统/只读/存档', () => {
    const rows = attrRows(WIN_ATTR.readonly)
    expect(rows.map((r) => r.label)).toEqual(['隐藏', '系统', '只读', '存档'])
    expect(rows.map((r) => r.state)).toEqual(['unknown', 'unknown', 'set', 'unknown'])
  })
  it('目录（attrs 未采集 = null）：四行全 unknown，不得出现 set/clear', () => {
    const rows = attrRows(null)
    expect(rows).toHaveLength(4)
    for (const r of rows) expect(r.state).toBe('unknown')
  })
})

describe('§28 原则二「系统文件默认保护」的真判据版本', () => {
  it('带 SYSTEM 属性位的条目即 protected，与路径长什么样无关', () => {
    const innocentPath = 'D:\\MyStuff\\photo.jpg'
    expect(protectedByAttrs(WIN_ATTR.system)).toBe(true)
    expect(classifyEntry(innocentPath, WIN_ATTR.system)).toBe('system')
    expect(RISK_BY_GROUP[classifyEntry(innocentPath, WIN_ATTR.system)]).toBe('forbidden')
  })
  it('路径规则仍走 classifyPath：属性没证明 system 时不得凭空保护', () => {
    expect(protectedByAttrs(0)).toBe(false)
    expect(protectedByAttrs(WIN_ATTR.readonly)).toBe(false)
    expect(classifyEntry('D:\\MyStuff\\photo.jpg', 0)).toBe('image')
    expect(classifyEntry('C:\\Windows\\System32\\drivers\\etc\\hosts', 0)).toBe('system')
  })
  it('目录（null = 本轮不采集属性）不参与属性保护，交给路径规则', () => {
    expect(protectedByAttrs(null)).toBe(false)
    expect(classifyEntry('C:\\Users\\Kano\\AppData\\Local\\Temp', null)).toBe('temp')
  })
})
