/**
 * §19 那一格的措辞 —— 「两个数相等」被宣布成"磁盘真省了这么多"之前先停一步。
 *
 * 靶场上量出来的事实（写在 `docs/superpowers/plans/2026-09-28-deepclean-v0.5-v0.8.md` 的
 * 「§19 的 actualFreedBytes 也是 inode 盲的」那一节）：`predictedFreedBytes` 是执行器对每条
 * 被接受路径 `lstat` 求来的和，`actualFreedBytes` 是 `measureRoot` 重扫两棵树的表观差 ——
 * **两边都是"逐路径表观大小之和"，谁都不看 inode**。于是有硬链接参与时两个错口径互相印证，
 * `deltaBytes` 正好等于 0，而界面在旁边补一句「（完全吻合）」。
 *
 * 本轮只动措辞：口径本身（那三个数怎么算出来的）在冻结面里，一个字没碰。
 * 措辞的要害是**只说自己量到的东西**：`deltaBytes` 量的是两笔表观账的差，不是磁盘占用变化；
 * 磁盘那一侧这一张卡片上真有的读数是「可用空间」前后两格，所以那句加注要把用户指到那里去。
 *
 * 断言打在真实渲染的 HTML 上（与 `skip-panel.test.tsx` / `dup-render.test.tsx` 同先例）——
 * 这一格是纯呈现，源码里留着那句字面量而没进那一格等于没改。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskPanel } from '../../src/renderer/pages/Cleanup'
import { formatBytes } from '../../shared/format'
import type { CleanTask, CleanVerification } from '../../shared/types'

const verification = (over: Partial<CleanVerification> = {}): CleanVerification => ({
  rootBytesBefore: 40 * 1024 * 1024,
  rootBytesAfter: 32 * 1024 * 1024,
  actualFreedBytes: 8 * 1024 * 1024,
  predictedFreedBytes: 8 * 1024 * 1024,
  deletedBytes: 8 * 1024 * 1024,
  deltaBytes: 0,
  filesBefore: 10,
  filesAfter: 8,
  freeBytesBefore: 1024,
  freeBytesAfter: 1024,
  // 服务端 `executor.ts:541` 的两个分支各有各的话。这里默认取"相等"那一支的原文形状
  // （含「逐路径表观大小之和」与点名的"硬链接"）；夹具以前写成占位句，于是"卡片要说清表观口径"
  // 那条判据其实测的是本地写死的那一段，而不是服务端那一份。
  note:
    '§19 对账：预估与前后差在这套「逐路径表观大小之和」的口径下相等 —— 相等只证明两笔表观账互相吻合，' +
    '不证明磁盘真省下了这些字节：硬链接的名字删掉只减链接计数、表观照样少一份',
  ...over
})

const task = (v: CleanVerification | null): CleanTask => ({
  id: 'task-1',
  status: 'completed',
  progress: 1,
  totalSize: 8 * 1024 * 1024,
  cleanedSize: 8 * 1024 * 1024,
  successCount: 2,
  failedCount: 0,
  authorizedRoot: 'D:\\t',
  requestedPaths: [],
  acceptedPaths: [],
  blockers: [],
  refusals: [],
  deleted: [],
  dirsRemoved: [],
  verification: v,
  digest: 'abc',
  startedAtMs: 1,
  finishedAtMs: 2
})

const html = (v: CleanVerification | null): string => renderToStaticMarkup(<TaskPanel task={task(v)} />)

describe('§19 措辞：deltaBytes = 0 只许说"两笔表观账一致"', () => {
  it('差额为 0：念成表观口径，不再念「完全吻合」', () => {
    const out = html(verification({ deltaBytes: 0 }))
    expect(out, '旧那句"完全吻合"是把表观相等宣布成磁盘核实过').not.toContain('完全吻合')
    expect(out).toContain('表观')
    expect(out).toContain('0 B')
    // 反空跑：这一格必须真的渲染出差额，否则上面两句都是在跟空气比
    expect(out).toContain('差额')
  })

  it('差额不为 0：报那个数，不许顺手加任何"一致/吻合"的话', () => {
    // 服务端在"不相等"那一支给的是另一句话（它不写"吻合"），所以夹具也得换成那一支的原文形状，
    // 否则这条判据测的是我给的占位串，不是产品真会说出口的话。
    const out = html(
      verification({
        deltaBytes: -80,
        actualFreedBytes: 120,
        note:
          '§19 对账：工作单表观合计 200 字节，授权根表观大小前后差 120 字节（差额 -80）。 两个数字都如实报告，' +
          '而它们都是「逐路径表观大小之和」—— 磁盘簇占用、备用数据流、清理期间的并发写入都会造成差，' +
          '硬链接则会造成反方向的假性一致（两边同样都不看 inode）'
      })
    )
    expect(out).toContain(formatBytes(80))
    /**
     * 判据的范围是**差额那一格**，不是整张卡片。服务端在"不相等"那一支的说明里合法地写了
     * 「硬链接则会造成反方向的假性一致」—— 那是一句正确的解释，不是给差额签的口供。
     * 以前这条扫全卡之所以能过，是因为夹具的 `note` 是个占位串；换成真实话之后范围必须收窄，
     * 否则判据会红在产品说对了的那句话上（而下一步就会是有人去把那句解释删掉）。
     */
    const deltaCell = /<dt>差额<\/dt>\s*<dd[^>]*>([^<]*)<\/dd>/.exec(out)?.[1] ?? ''
    expect(deltaCell, '差额那一格没找到 = 切片错了，下面两条断言是空过').toContain(formatBytes(80))
    expect(deltaCell).not.toContain('吻合')
    expect(deltaCell).not.toMatch(/一致/)
  })

  it('卡片里要把"磁盘那一侧看哪一格"说明白：表观合计 ≠ 磁盘占用变化，硬链接去重不含在内', () => {
    const out = html(verification({}))
    expect(out).toMatch(/逐路径表观大小之和|表观大小之和/)
    expect(out, '硬链接是这个口径唯一的盲点，加注必须点名').toContain('硬链接')
    expect(out, '要把用户指到真的那一格去，不是只泼一句"这不准"').toContain('可用空间')
  })

  it('verification 为 null：整块不渲染（没有读数就没有话）', () => {
    const out = html(null)
    expect(out).not.toContain('差额')
    expect(out).not.toContain('表观')
  })

  it('note 原样带出服务端那句话，本页不改写也不加码', () => {
    const out = html(verification({ note: '§19 对账：这一句由执行器给' }))
    expect(out).toContain('§19 对账：这一句由执行器给')
  })

  it('用户看得见地方不许出现 markdown 星号', () => {
    expect(html(verification({}))).not.toContain('**')
    expect(html(verification({ deltaBytes: -80 }))).not.toContain('**')
  })
  /**
   * 评审 5b Minor 的两条：这张卡片以前把同一段免责讲两遍（本地写死一段 + 服务端 `v.note` 一段），
   * 并且无条件让用户"去看可用空间那一格"，而那一格是允许「未采集」的。
   */
  it('口径那句话只念一遍：服务端给了 note 就用它，本地兜底句不许同时在场', () => {
    const h = html(verification({ note: '服务端那份口径说明：三格同为逐路径表观大小之和' }))
    expect(h).toContain('服务端那份口径说明')
    expect(h, '两遍免责 = 用户读到两段措辞略不同的话，然后开始猜哪一段算数').not.toContain(
      '上面「预估释放 / 实际释放 / 差额」三格都是逐路径表观大小之和'
    )
  })

  it('服务端没给话时本地兜底 —— 口径说明不能没有主人', () => {
    const h = html(verification({ note: '' }))
    expect(h).toContain('逐路径表观大小之和')
  })

  it('卷可用空间采到了才指路；没采到时不许把人指到一个写着「未采集」的格子前', () => {
    const collected = html(verification({}))
    expect(collected).toContain('看「可用空间」那一格的前后差')
    const missing = html(verification({ freeBytesBefore: null, freeBytesAfter: null }))
    expect(missing).not.toContain('看「可用空间」那一格的前后差')
    expect(missing).toContain('没采到卷的可用空间')
    // 反空跑：两种输入必须真的念出不同的话，否则上面那两条断言里有一条是空过
    expect(collected).not.toBe(missing)
  })

})
