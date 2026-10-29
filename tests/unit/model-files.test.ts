/**
 * §3.6 AI 那一行要的「检测到 N 个大模型文件（共 X GB）」—— **判据与出身**那一半。
 *
 * 取数通道为什么不是"点开页面时现扫一遍树"：这条实测跑过
 * （`scripts/_bench-model-tally.mjs`，内存树、零 syscall）
 * —— 30 万文件 / 3 万目录的一次全树遍历要 **1.3–2.1 秒**，而且它跑在**主进程**上，
 * 那正是扫描事件流、Treemap 每 400ms 的 `childrenOf` 轮询、以及所有 IPC 处理器的宿主。
 * 为一格文案把主进程钉住两秒是拿整app换一句话，所以计数改成**扫描途中顺带数**
 * （`TreeStore.addFilesToDir` 那条唯一的文件入口，`tests/unit/tree-store-ext-counter.test.ts` 盯着它），
 * 这里只剩两件纯事：口径清单、以及把计数配上"它是从哪棵树、什么状态下数出来的"。
 *
 * ### 口径：按扩展名，且刻意不含 `.bin`
 *
 * `.bin` 不是模型专属 —— `data.bin`、各类安装包、numpy 缓存都叫这个名，把它算进来，
 * 那一格的「共 X GB」就变成一堆不相干字节的合订本，而那正是本项目全程在躲的虚报形状。
 * **代价是少报**：早期 HF 检查点惯用的 `pytorch_model.bin` 不进这一格。
 * 宁可少报并把口径点名给用户（`extensions` 字段就是为这句话存在的），不可虚报。
 *
 * ### 扩展名判据不在这里重写
 *
 * 大小写归一、多重扩展名取最后一段，全部沿用 `extOf`（`core/fs/pathutil`）—— 也就是与
 * §3 文件类型统计表、`topHeap` 同一户口径。这里再造一份 `lastIndexOf('.')` 等于让两张表
 * 对"什么是 .gguf"各说一套，而它们会同屏出现。
 */
import { describe, expect, it } from 'vitest'
import { MODEL_FILE_EXTENSIONS, modelTallyFrom } from '../../core/analyze/model-files'

describe('MODEL_FILE_EXTENSIONS —— 口径本身', () => {
  it('口径里点名带点、小写、不重复（这三条只要破一条，扫描途中的过滤就会静默漏计）', () => {
    for (const e of MODEL_FILE_EXTENSIONS) {
      expect(e.startsWith('.'), `${e} 没带点`).toBe(true)
      expect(e, `${e} 不是小写`).toBe(e.toLowerCase())
    }
    expect(new Set(MODEL_FILE_EXTENSIONS).size).toBe(MODEL_FILE_EXTENSIONS.length)
  })

  it('`.bin` 刻意不在口径里：它不是模型专属，代价是早期 pytorch_model.bin 少报 —— 这条用例钉的是决定，不是实现', () => {
    expect(MODEL_FILE_EXTENSIONS).not.toContain('.bin')
    expect(MODEL_FILE_EXTENSIONS).not.toContain('.json')
    expect(MODEL_FILE_EXTENSIONS).not.toContain('.gz')
  })

  it('当代常见的权重格式都在口径里（少一条就是那一格当着用户的面少数一种模型）', () => {
    for (const e of ['.safetensors', '.gguf', '.ckpt', '.pt', '.pth', '.onnx', '.h5', '.tflite']) {
      expect(MODEL_FILE_EXTENSIONS, `口径漏了 ${e}`).toContain(e)
    }
  })
})

describe('modelTallyFrom —— 把计数配上它的出身', () => {
  /** 一份典型处境：12 万文件、扫描已完成、没截断。 */
  const snap = (o: Partial<Parameters<typeof modelTallyFrom>[1]> = {}) => ({
    rootPath: 'D:\\scan\\root',
    filesSeen: 120_000,
    truncated: false,
    scanStatus: 'completed' as const,
    ...o
  })

  it('字节与条数原样带出，并配上"量的是哪棵树"—— rootPath 是那句「按扩展名在 D:\\… 这棵树里数的」唯一的数据来源', () => {
    const t = modelTallyFrom({ count: 3, bytes: 9 * 1024 ** 3 }, snap())
    expect(t.count).toBe(3)
    expect(t.bytes).toBe(9 * 1024 ** 3)
    expect(t.rootPath).toBe('D:\\scan\\root')
    expect(t.filesSeen).toBe(120_000)
  })

  it('扫描状态原样带出，不许在这一层被压成一个布尔 —— running / cancelled / completed 是三句话，不是两句', () => {
    expect(modelTallyFrom({ count: 40, bytes: 1 }, snap({ scanStatus: 'running' })).scanStatus).toBe('running')
    expect(modelTallyFrom({ count: 40, bytes: 1 }, snap({ scanStatus: 'cancelled' })).scanStatus).toBe('cancelled')
    expect(modelTallyFrom({ count: 40, bytes: 1 }, snap({ scanStatus: 'completed' })).scanStatus).toBe('completed')
  })

  it('存储层因 maxFiles 丢过记录 → truncated=true：条数仍是全量（计数在截断闸之前），但"这棵树"本身只是磁盘的一部分', () => {
    const t = modelTallyFrom({ count: 7, bytes: 7 }, snap({ truncated: true }))
    expect(t.truncated).toBe(true)
    expect(t.count).toBe(7)
  })

  it('extensions 把本次口径原样带出：界面那句「按扩展名统计，未计入 .bin」得有数据背书，不能是渲染层手抄的一份名单', () => {
    const t = modelTallyFrom({ count: 0, bytes: 0 }, snap())
    expect([...t.extensions]).toEqual([...MODEL_FILE_EXTENSIONS])
  })

  it('零命中是一句真话而不是缺字段：count=0、bytes=0，但出身三件套照样带得齐', () => {
    const t = modelTallyFrom({ count: 0, bytes: 0 }, snap())
    expect(t.count).toBe(0)
    expect(t.bytes).toBe(0)
    expect(t.rootPath).toBe('D:\\scan\\root')
    expect(t.scanStatus).toBe('completed')
  })

  it('同一份输入跑两次逐字节相同（可复现性：这一版全程的硬要求）', () => {
    const a = modelTallyFrom({ count: 5, bytes: 500 }, snap())
    const b = modelTallyFrom({ count: 5, bytes: 500 }, snap())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('负数或 NaN 的字节不许穿过去：那是 `f.size` 坏了，而 -1 GB 会被渲染成一句看起来正常的谎', () => {
    expect(modelTallyFrom({ count: 2, bytes: Number.NaN }, snap()).bytes).toBe(0)
    expect(modelTallyFrom({ count: 2, bytes: -5 }, snap()).bytes).toBe(0)
    expect(modelTallyFrom({ count: -1, bytes: 10 }, snap()).count).toBe(0)
  })
})
