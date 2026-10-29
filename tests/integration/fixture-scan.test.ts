/**
 * Task 13 Step 6：把「扫描器 vs 独立事实源」的对账固化成测试。
 *
 * 跑法（DC_ORACLE / DC_ORACLE_EXCLUDED 一律用 `$(...)` 现场从 scripts/oracle.mjs 取，
 * **禁止手写一个「看起来对」的期望值** —— 手写数字等于让这条测试只证明代码和自己一致）：
 *
 *   cd /d/DeepClean
 *   DC_ORACLE="$(node scripts/oracle.mjs 'D:/deepclean-fixture/f100k')" \
 *   DC_ORACLE_EXCLUDED="$(node scripts/oracle.mjs 'D:/deepclean-fixture/f100k/System Volume Information')" \
 *   npx vitest run --exclude 'node_modules/**' --exclude 'out/**' tests/integration/fixture-scan.test.ts
 *
 * 三条坐标各自独立比对（Task 6 的教训：只看 totalBytes 会把树形错误洗白）：
 *   files / dirs / bytes 必须**逐项精确相等**，一条都不许合并、不许给容差。
 *   原稿的 `Math.abs(s.dirs - ORACLE.dirs) <= 1` 是错的：±1 容差正好能把
 *   bug②「凭空造出假父节点」（实测 dirs 6 vs 2）洗成 PASS。
 *
 * 已登记的口径差异（两条，都是读代码定的，不是调到绿的旋钮）：
 *   1. `System Volume Information` 在 core/fs/errors.ts 的 SKIP_ALWAYS 名单里，扫描器整棵子树不碰；
 *      夹具里它是我们自己建的可读目录，PowerShell 读得到 → 必须拿第二次 oracle 把这块量出来减掉。
 *      下面 `前提仍在` 那条用例守的就是「这个差异确实还是名单造成的」。
 *   2. dirs 的根约定：扫描器 TreeStore.beginDir 在构造 root 时就 `c.dirs++`（**根算一个目录**），
 *      而 oracle 用 `Get-ChildItem -Directory -Recurse`（**不含根自身**）。所以 scanner.dirs 比
 *      oracle.dirs 恰好多「根 1 个」、少「被跳过子树的 (根+子孙) 个」。
 */
import { describe, expect, it, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { Scanner } from '../../core/scan/scanner'
import { nodeFs } from '../../core/fs/fslike'
import { SKIP_ALWAYS } from '../../core/fs/errors'
import type { ScanSnapshot } from '../../shared/types'

interface Oracle {
  files: number
  dirs: number
  bytes: number
  enumErrors: number
  root: string
}

const FIXTURE = process.env.DC_FIXTURE ?? 'D:/deepclean-fixture/f100k'
const parse = (raw?: string): Oracle | null => {
  if (!raw) return null
  try {
    return JSON.parse(raw) as Oracle
  } catch {
    return null
  }
}
const ORACLE = parse(process.env.DC_ORACLE)
const EXCLUDED = parse(process.env.DC_ORACLE_EXCLUDED)

const win = (p: string): string => {
  let s = win32.resolve(p).replace(/\//g, '\\')
  if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1)
  return s
}
const ROOT = win(FIXTURE)
const SKIPPED_NAME = 'System Volume Information'
const SKIPPED_ROOT = join(ROOT, SKIPPED_NAME)

/** 差异闭合：期望值 = 全树 oracle − 被跳过子树 oracle，再按根的约定挪 1。 */
const expFiles = ORACLE && EXCLUDED ? ORACLE.files - EXCLUDED.files : -1
const expDirs =
  ORACLE && EXCLUDED
    ? ORACLE.dirs - (EXCLUDED.dirs + 1) + 1 /* -被跳过子树自身 +扫描器把根计入 */
    : -1
const expBytes = ORACLE && EXCLUDED ? ORACLE.bytes - EXCLUDED.bytes : -1

const ready = existsSync(ROOT) && !!ORACLE && !!EXCLUDED

describe('夹具对账的前置条件', () => {
  it('DC_ORACLE 与 DC_ORACLE_EXCLUDED 必须是现场跑 oracle 拿到的（缺一个就不算对过账）', () => {
    expect(ORACLE, `缺 DC_ORACLE：用 $(node scripts/oracle.mjs '${FIXTURE}') 现场取`).toBeTruthy()
    expect(EXCLUDED, `缺 DC_ORACLE_EXCLUDED：用 $(node scripts/oracle.mjs '${SKIPPED_ROOT}') 现场取`).toBeTruthy()
    expect(existsSync(ROOT), `夹具不存在：${ROOT}`).toBe(true)
    // 事实源自己必须承认这次枚举是完整的；残缺的数没有资格当期望值。
    expect(ORACLE!.enumErrors, 'oracle 枚举过程中有 PowerShell 报错 → 数字是少计，不可信').toBe(0)
    expect(EXCLUDED!.enumErrors).toBe(0)
  })
})

describe.skipIf(!ready)('扫描结果对账（§35.2，事实源=PowerShell）', () => {
  let snap: ScanSnapshot
  let sc: Scanner
  const opts = { fs: nodeFs, concurrency: 16, progressIntervalMs: 500, maxFiles: 3_000_000, maxDepth: 64 }

  beforeAll(async () => {
    sc = new Scanner(opts)
    snap = await sc.start(ROOT, () => undefined)
  }, 600_000)

  it('前提仍在：被减掉的那棵子树确实是静默名单造成的，不是随便挑的', () => {
    expect(SKIP_ALWAYS.has(SKIPPED_NAME.toLowerCase())).toBe(true)
  })

  it('files / dirs / bytes 与独立事实源（扣除已登记差异后）逐轴精确相等', async () => {
    expect(snap.status).toBe('completed')
    expect(snap.files).toBe(expFiles)
    expect(snap.dirs).toBe(expDirs)
    expect(snap.totalBytes).toBe(expBytes)
    // 树根聚合大小必须与计数器同值，否则「总量对、树错」还能蒙混过关
    expect(sc.store.sizeOf(sc.store.rootId)).toBe(expBytes)
  }, 600_000)

  it('长路径分支（>260）整条都在树上：漏掉它 = 少计两千多个文件', () => {
    let deep = join(ROOT, 'longpath')
    for (let i = 0; i < 12; i++) deep = join(deep, 'segment-with-many-chars')
    expect(deep.length).toBeGreaterThan(260)
    expect(sc.store.dirIdByPath(join(ROOT, 'longpath'))).toBeDefined()
    const id = sc.store.dirIdByPath(deep)
    expect(id, `最深那层目录没进树 → \\\\?\\ 前缀或深度分片有问题`).toBeDefined()
    expect(sc.store.getDir(id!)!.directFileCount).toBeGreaterThan(0)
  })

  it('空目录 / 0 字节文件不制造错误，也不被截断', () => {
    const emptyId = sc.store.dirIdByPath(join(ROOT, 'Empty'))
    expect(emptyId).toBeDefined()
    const empty = sc.store.getDir(emptyId!)!
    expect(empty.directFileCount).toBe(0)
    expect(empty.childIds.length).toBe(0)
    expect(snap.otherErrors).toBe(0)
    expect(snap.truncated).toBe(false)
    expect(snap.skipped, '名单跳过是静默的，不该记进错误计数').toBe(0)
  })

  it('被跳过名单目录根本没进树（连 readdir 都不该发）', () => {
    expect(sc.store.dirIdByPath(SKIPPED_ROOT)).toBeUndefined()
  })

  it('根目录自己的直属文件没有被 seed 分片漏掉（Task 6 bug① 回归哨兵）', () => {
    const root = sc.store.getDir(sc.store.rootId)!
    // 夹具在根上放了 pagefile.sys + .deepclean-ignore；具体条数由上面的 files/bytes 精确锁定，
    // 这里只守「一条都没丢」这个结构事实，避免把 2 手写成期望值。
    expect(root.directFileCount, '根直属文件被静默跳过 = C:\\pagefile.sys 那一类漏算').toBeGreaterThan(0)
    expect(root.parentId, 'Task 6 bug②：根不得有父节点').toBeNull()
    // bug② 的原始形态：ensureChain 从盘符开始拼，会凭空造出 `D:\` 与 `D:\deepclean-fixture` 两个假父节点。
    expect(sc.store.dirIdByPath(win32.parse(ROOT).root), '根之上不该有盘符节点').toBeUndefined()
    expect(sc.store.dirIdByPath(win32.dirname(ROOT)), '根之上不该有父链节点').toBeUndefined()
  })
})
