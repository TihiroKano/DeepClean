/**
 * `core/fs/finddata.ts` 的单测 —— 全部走注入的 `run`，不起真的 powershell。
 *
 * 这一层唯一"看起来安全"的失败模式是**把残缺当成 0**：少一个字段就用 0 顶上，界面上
 * 就是一个 0 字节的 pagefile.sys，比"没算进来"更难发现。所以下面每一段都围绕
 * 「形状不对就整条弃用 / 整个目录判失败」来钉。
 */
import { describe, expect, it } from 'vitest'
import { createFindDataLister, lookupFindDataEntry } from '../../core/fs/finddata'

/**
 * 2023-11-14T22:13:20Z ⇒ 1,700,000,000,000 ms；Windows 文件时间 = (ms + 11,644,473,600,000) × 10,000
 * = 133,444,736,000,000,000。这两个常量是手算的，所以下面专门有一条把它们钉回去。
 */
const FT_1700000000000 = '133444736000000000'
const FT_1600000000000 = '132444736000000000' // 2020-09-13T12:26:40Z ⇒ 1,600,000,000,000 ms

const line = (name: string, size: number, mt = FT_1700000000000, ct = FT_1600000000000, attrs = 38): string =>
  `${name}\t${size}\t${mt}\t${ct}\t${attrs}`

describe('createFindDataLister：解析与失败面', () => {
  it('五段齐全 ⇒ 大小、两个时间、属性位都落位，键一律小写', async () => {
    const lister = createFindDataLister({
      run: async () => [line('pagefile.sys', 9_714_868_224), line('楠楠.txt', 7, FT_1700000000000, FT_1600000000000, 32)].join('\n')
    })
    const map = await lister('C:\\')
    expect(map).not.toBeNull()
    // 键存成小写、查询也小写（大小写不敏感这层契约由 lookupFindDataEntry 那组测）
    expect(map!.get('pagefile.sys')).toEqual({ size: 9_714_868_224, mtimeMs: 1_700_000_000_000, birthtimeMs: 1_600_000_000_000, attrs: 38 })
    expect(map!.get('楠楠.txt')!.size).toBe(7)
    expect(map!.get('楠楠.txt')!.attrs).toBe(32)
  })

  it('文件时间换算钉死：133444473600000000 → 1700000000000 ms', async () => {
    const lister = createFindDataLister({ run: async () => line('a', 1) })
    expect((await lister('C:\\'))!.get('a')!.mtimeMs).toBe(1_700_000_000_000)
  })

  it('少一段 ⇒ 整条弃用，绝不拿 0 冒充采到过', async () => {
    const bad = `broken.txt\t99\t${FT_1700000000000}\t${FT_1600000000000}` // 没有属性位
    const lister = createFindDataLister({ run: async () => [line('ok.txt', 5), bad].join('\n') })
    const map = await lister('C:\\')
    expect([...map!.keys()]).toEqual(['ok.txt'])
    expect(map!.has('broken.txt')).toBe(false)
  })

  it('输出里一条都解不出来 ⇒ 整个目录返回 null（不是空 Map）', async () => {
    // 空 Map 会让调用方以为"这个目录里真的没有文件"，那是把失败洗成事实。
    const lister = createFindDataLister({ run: async () => '乱码或者语言模式的报错全文\n' })
    expect(await lister('C:\\')).toBeNull()
  })

  it('run 返回 null（没有 powershell / 超时 / 语言模式受限）⇒ null，且被记忆', async () => {
    let calls = 0
    const lister = createFindDataLister({
      run: async () => {
        calls++
        return null
      }
    })
    expect(await lister('C:\\x')).toBeNull()
    expect(await lister('C:\\x')).toBeNull()
    expect(calls).toBe(1) // 失败也记账：一个目录的权限形状是稳定的，不该每次都再花 300 ms
  })

  it('同一拼写的并发调用共享同一个在途枚举；换一种拼写就是另一个键', async () => {
    let calls = 0
    const lister = createFindDataLister({
      run: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 20))
        return line('a', 1)
      }
    })
    const [x, y] = await Promise.all([lister('C:\\p'), lister('C:\\P')]) // 大小写不同 ⇒ 同一个键
    expect(calls).toBe(1) // 扫描器同层并行，不去重就是同时起 N 个 powershell
    expect(x).toBe(y)
    await lister('C:\\p\\') // 尾反斜杠 ⇒ 另一个键，会再跑一次
    expect(calls).toBe(2)
    // 记忆按"目录字符串的小写"而不是"规范化路径"，这是已知的形状：调用方给的都是
    // 同一处拼法（walk/scanner 用 joinWin 产出的路径），所以实际命中；写下这条是免得
    // 下一位以为这里做了路径规范化。
  })

  it('空行与 CRLF 尾巴不影响解析', async () => {
    const lister = createFindDataLister({ run: async () => `\r\n${line('a.txt', 10)}\r\n\r\n` })
    expect((await lister('C:\\'))!.get('a.txt')!.size).toBe(10)
  })
})

describe('lookupFindDataEntry', () => {
  it('没注入兜底 ⇒ null（默认关，行为与今天逐字相同）', async () => {
    expect(await lookupFindDataEntry(undefined, 'C:\\', 'pagefile.sys')).toBeNull()
  })

  it('命中就返回条目，未命中返回 null', async () => {
    const e = { size: 1, mtimeMs: 2, birthtimeMs: 3, attrs: 4 }
    const lister = async (): Promise<Map<string, typeof e> | null> => new Map([['pagefile.sys', e]])
    expect(await lookupFindDataEntry(lister, 'C:\\', 'PageFile.SYS')).toBe(e)
    expect(await lookupFindDataEntry(lister, 'C:\\', '别的')).toBeNull()
  })
})
