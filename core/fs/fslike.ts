import { opendir, stat as nodeStat } from 'node:fs/promises'
import { attrsFromStatMode } from '../../shared/classify'
import { toFsPath } from './pathutil'

export interface DirentLite {
  name: string
  kind: 'dir' | 'file' | 'other'
}

export interface StatLite {
  size: number
  mtimeMs: number
  /**
   * 创建时间。**必需字段**：它和 size/mtime/attrs 出自同一次 `stat`，
   * 给 optional 等于允许下游写 `?? 0`，那会把「没采到」画成 1970-01-01。
   * 诚实边界：NTFS 上它是真的；跨到网络盘/非 NTFS 卷可能为 0，UI 按 `<=0 → 未采集` 处理。
   */
  birthtimeMs: number
  /**
   * 已证明的 FILE_ATTRIBUTE_* 位（WIN_ATTR，见 shared/classify 的实测说明）。
   * **必需字段**：真文件系统里它永远免费附带（就是同一次 stat 的 st_mode），
   * 所以不给它留 optional —— 一旦可选，全链路就会长出 `?.` 的谎。
   * 诚实边界：Windows 上 stat 只能证明 READONLY；HIDDEN/SYSTEM/ARCHIVE 判不出（attrs=0 也不代表"不是隐藏文件"）。
   */
  attrs: number
}

/**
 * 扫描器唯一依赖的 I/O 抽象：
 * 传入 fake 实现即可在纯内存下测 walk，未来换 worker 池也不动算法。
 */
export interface FsLike {
  readdir(p: string): Promise<DirentLite[]>
  stat(p: string): Promise<StatLite>
  /**
   * 目录条目消费完毕后的释放钩子（只对缓存型实现有意义，比如 winFs）。
   * **可选**：nodeFs 与全部测试 fake 都不实现 —— 不实现时行为与从前逐字相同。
   * walk 在 `Promise.all(fileJobs)` 之后对每个 readdir 过的目录调一次；
   * scanner.collectShallowFiles 在收完直属文件后同样调一次。
   */
  release?(p: string): void
}

export const nodeFs: FsLike = {
  /**
   * 用 opendir + 流式 for await 而不是 readdir(withFileTypes)：
   * 后者会把整个目录名表一次性攒在内存里，opendir 让 libuv 分批返回，
   * 超大目录（WinSxS / node_modules）内存更平。
   * 注意 isDirectory() 不跟随重解析点，junction / 软链接天然落到 'other' 被跳过。
   */
  async readdir(p: string): Promise<DirentLite[]> {
    const dh = await opendir(toFsPath(p))
    const out: DirentLite[] = []
    try {
      for await (const e of dh) {
        out.push({ name: e.name, kind: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other' })
      }
    } finally {
      await dh.close().catch(() => undefined)
    }
    return out
  },
  /**
   * 属性、创建时间与 size/mtime 来自**同一次** stat → 零额外 syscall（§4.1 的成本红线）。
   * mode 在这里就地解码成"已证明的属性位"，往下游传的永远是语义而不是 raw mode，
   * 因为 raw mode 的 bit 2/4/32 是 POSIX 权限位，直接当属性用会把每个可写文件报成隐藏文件。
   */
  async stat(p: string): Promise<StatLite> {
    const s = await nodeStat(toFsPath(p))
    return { size: s.size, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs, attrs: attrsFromStatMode(s.mode) }
  }
}
