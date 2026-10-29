/**
 * `TreeStore` 的**注入扩展名计数**（§3.6 AI 那一格的取数处）。
 *
 * 这一组用例只钉一件事：**这个数必须是"扫到一个数一个"顺带累加出来的**，
 * 于是它同时满足两条，而这两条各自都有对应的失效形状：
 *
 * 1. **与榜容量无关** —— `topHeap` 只有 100 条（`scanner.ts` 的 `topN ?? 100`），
 *    所以"从榜里数"的实现在一个 400 权重的目录上会稳定念 100。用例造 **150** 个，
 *    并先自证榜确实只有 100，免得这条用例在证明一件没发生的事。
 * 2. **与 `maxFiles` 截断无关** —— 截断丢的是 `d.files` 的存储记录，
 *    `directSize` / `directFileCount` 早就照常累加，这个计数必须站在同一侧。
 *    否则"内存吃紧 → 少了几个 G 的模型没被数"会伪装成"这台机器上没有"。
 *
 * 第三条是这一族判据最坏的失效：**注入的键形状不对（没点、大写）时静默数出 0**。
 * 0 在界面上是一句看起来完全可信的话，所以这里选择**当场归一**（与 `extOf` 同解），
 * 而不是要求调用方传对 —— 用例直接喂 `['GGUF']`。
 *
 * 口径清单（哪些扩展名算模型）住在 `core/analyze/model-files.ts`，扫描层只吃一串扩展名、
 * 不知道"模型"是什么 —— 依赖方向与约束 7 那一族保持不变（`core/scan/**` 不 import 分析层，
 * 集合由 `electron/services/scan-service.ts` 注入）。
 */
import { describe, expect, it } from 'vitest'
import { TreeStore } from '../../core/scan/tree-store'

const GB = 1024 * 1024 * 1024

const MODEL = ['.safetensors', '.gguf', '.onnx']

/** 一条 `addFilesToDir` 的入参。 */
const f = (name: string, size = GB) => ({ name, size, mtimeMs: 1, birthtimeMs: 1, attrs: 0 })

function store(o: { maxFiles?: number; countExts?: readonly string[] | undefined } = {}) {
  return new TreeStore({ rootPath: 'C:\\', maxFiles: o.maxFiles ?? 1_000_000, countExts: o.countExts })
}

describe('TreeStore 的注入扩展名计数 —— 全量口径', () => {
  it('150 个 .gguf 要念 150；同一次构造里 topHeap 只有 100 条（证明这个数不来自榜）', () => {
    const s = store({ countExts: MODEL })
    const d = s.beginDir('C:\\Models')
    s.attachChild(s.rootId, d)
    s.addFilesToDir(d, Array.from({ length: 150 }, (_, i) => f(`m-${i}.gguf`)))
    expect(s.topHeap.entries().length).toBe(100)
    expect(s.extTotals()).toEqual({ count: 150, bytes: 150 * GB })
  })

  it('只数注入的那几种：同层的 .dll / .txt / .json 一个不进', () => {
    const s = store({ countExts: MODEL })
    const d = s.beginDir('C:\\Mixed')
    s.attachChild(s.rootId, d)
    s.addFilesToDir(d, [f('a.gguf'), f('b.safetensors'), f('c.onnx'), f('d.dll'), f('e.txt'), f('f.json')])
    expect(s.extTotals()).toEqual({ count: 3, bytes: 3 * GB })
  })

  it('没注入扩展名清单时是零而不是"未初始化"：别的调用方（`maxFiles` 那一类）不该被这个特性牵连', () => {
    const s = store()
    const d = s.beginDir('C:\\Models')
    s.attachChild(s.rootId, d)
    s.addFilesToDir(d, [f('a.gguf')])
    expect(s.extTotals()).toEqual({ count: 0, bytes: 0 })
  })

  it('注入 `GGUF`（没点、大写）也照样数得到 —— 键形状不对时静默念 0 是这一族最坏的失效', () => {
    const s = store({ countExts: ['GGUF', 'safetensors'] })
    const d = s.beginDir('C:\\Models')
    s.attachChild(s.rootId, d)
    s.addFilesToDir(d, [f('a.gguf'), f('b.SAFETENSORS'), f('c.onnx')])
    expect(s.extTotals()).toEqual({ count: 2, bytes: 2 * GB })
  })

  it('`maxFiles` 截断后计数照常全量：丢的是存储记录，不是"这台机器上有没有"', () => {
    const s = store({ maxFiles: 1, countExts: MODEL })
    const d = s.beginDir('C:\\Models')
    s.attachChild(s.rootId, d)
    s.addFilesToDir(d, [f('a.gguf'), f('b.gguf'), f('c.gguf'), f('d.gguf'), f('e.gguf')])
    expect(s.truncated).toBe(true)
    expect(s.extTotals()).toEqual({ count: 5, bytes: 5 * GB })
    // 同一层里既有账必须还在原处：这个新计数不许动 directSize / directFileCount 任何一个
    s.finalizeDir(d)
    expect(s.childrenOf(s.rootId).find((c) => c.name === 'Models')?.size).toBe(5 * GB)
  })

  it('0 字节的权重也计数（`size > 0` 那道闸只管榜，管不到"有几个文件"这句话）', () => {
    const s = store({ countExts: MODEL })
    const d = s.beginDir('C:\\Models')
    s.attachChild(s.rootId, d)
    s.addFilesToDir(d, [f('a.gguf', 0), f('b.gguf', 0), f('c.gguf', GB)])
    expect(s.extTotals()).toEqual({ count: 3, bytes: GB })
  })

  it('扩展名判据与 `extOf` 同解：`weights.tar.gz` 不进、`x.bin.safetensors` 进', () => {
    const s = store({ countExts: MODEL })
    const d = s.beginDir('C:\\Models')
    s.attachChild(s.rootId, d)
    s.addFilesToDir(d, [f('weights.tar.gz', 4 * GB), f('x.bin.safetensors', 5 * GB)])
    expect(s.extTotals()).toEqual({ count: 1, bytes: 5 * GB })
  })

  it('多次 addFilesToDir 是累加而不是重置 —— 扫描有 shallow 与 seed-merge 两个入口，两条都得进同一个数', () => {
    const s = store({ countExts: MODEL })
    const a = s.beginDir('C:\\A')
    const b = s.beginDir('C:\\B')
    s.attachChild(s.rootId, a)
    s.attachChild(s.rootId, b)
    s.addFilesToDir(a, [f('a1.gguf'), f('a2.txt')])
    s.addFilesToDir(b, [f('b1.safetensors'), f('b2.onnx')])
    s.addFilesToDir(a, [f('a3.gguf')])
    // a1 + a3 + b1 + b2 = 4 个匹配，a2.txt 不进
    expect(s.extTotals()).toEqual({ count: 4, bytes: 4 * GB })
  })
})
