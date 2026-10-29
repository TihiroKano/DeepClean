/**
 * 三条文案的**位置**闸（2026-10-27 人类伙伴改口径）。
 *
 * 这一轮改的全是字面量，而字面量最容易"改了一处、漏了另一处" ——
 * 尤其第二段那句在 `Cleanup.tsx` 里**出现两次**（空状态一条路、有数据一条路），
 * 它们必须逐字相同：两处不一致时，用户第一次进页面看到的是一种说法，
 * 扫完之后看到另一种，读起来像两个程序。
 *
 * 为什么是源码闸而不是渲染闸：`Cleanup` 是受控组件，挂载即发两条 IPC；
 * 而这里要钉的东西在 JSX 里就是字面量（与 `cleanup-layout-contract.test.ts` 同一处先例）。
 *
 * 三条：
 *  ① 空状态那句话是「暂未进行扫描，请先前往首页执行扫描。」
 *  ② 提权那句是「本程序已使用管理员权限。删除后无法找回；部分被占用的文件无法删除属于正常现象。」，
 *     且**两处逐字相同**；
 *  ③ 清理日志页的「日志仅保留 30 天，过期自动删除」挂在列表**下方**（两条分支共用），
 *     不在空态里。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CleanupEmptyState } from '../../src/renderer/pages/Cleanup'
import { JournalEmpty, JournalRetentionNote } from '../../src/renderer/pages/CleanHistory'

/** 剥注释：判据量的是实现，一句写着"旧文案是……"的注释不该把它喂饱。 */
function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CLEANUP = src('src/renderer/pages/Cleanup.tsx')
const HISTORY = src('src/renderer/pages/CleanHistory.tsx')

/** 渲染结果 → 用户读到的纯文本（去掉标签、压缩空白），与真机上眼睛看到的是同一串。 */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

const ADMIN_LINE = '本程序已使用管理员权限。删除后无法找回；部分被占用的文件无法删除属于正常现象。'

describe('2026-10-27 的三条文案与它们的位置', () => {
  it('① 空状态渲染出来的文本就是新那两句（渲染产品本体，不是抄一份）', () => {
    const text = visibleText(renderToStaticMarkup(<CleanupEmptyState />))
    expect(text, '缺新第一句').toContain('暂未进行扫描，请先前往首页执行扫描。')
    expect(text, '缺新第二句').toContain(ADMIN_LINE)
    // 反面对照：旧那两句一个字都不许留（两句并存时用户看走哪一条路）
    expect(text, '旧那句「还没有扫描会话」还在').not.toContain('还没有扫描会话')
    expect(text, '旧那句「已以管理员身份运行」还在').not.toContain('已以管理员身份运行')
    expect(text, '旧那句「不计入释放空间」还在').not.toContain('不计入释放空间')
  })

  it('①b 源码里旧文案也不许残留（防止它藏在没被渲染到的分支里）', () => {
    expect(CLEANUP, '旧那句「还没有扫描会话」还在源码里').not.toContain('还没有扫描会话')
    expect(CLEANUP, '旧那句「已以管理员身份运行」还在源码里').not.toContain('已以管理员身份运行')
    expect(CLEANUP, '旧那句「失败的条目会逐条列出」还在源码里').not.toContain('失败的条目会逐条列出')
    // ⚠️ 不许写成全文 `not.toContain('不计入释放空间')` —— 确认弹窗里**另有一句**
    // 「删不掉的条目会标成失败并逐条列出，它们不计入释放空间。」，它讲的是"这一次按下去会怎样"，
    // 与页面那条常驻事实是两件事（`Cleanup.tsx` 那段注释写着）。全文否定会把那句误伤。
  })

  it('② 提权那句两处逐字相同（空状态一条路、有数据一条路）', () => {
    const hits = CLEANUP.split(ADMIN_LINE).length - 1
    expect(hits, `「${ADMIN_LINE}」该出现 2 次（空状态 + 有数据），实际 ${hits} 次`).toBe(2)
    // 「无法找回」是这一句的分量所在：它讲的是不可恢复，不是"删不掉"
    expect(CLEANUP).toContain('删除后无法找回')
  })

  it('③ 清理日志的保留窗口那句话挂在列表下方，两条分支共用', () => {
    expect(HISTORY, '保留窗口那句话不见了').toContain('日志仅保留 30 天，过期自动删除。')
    // 它必须是一个独立组件，且在两分支**之外**被渲染一次
    const afterBranch = /<\/ul>\s*\)\}\s*\{?\/?\*?[\s\S]{0,240}?<JournalRetentionNote \/>/.exec(HISTORY)
    expect(afterBranch, '`<JournalRetentionNote />` 不在两分支之外（列表下方）— 塞进某一条分支就只有一半人看得到').not.toBeNull()
    // 空态组件里不许再重复 30 天（两处各说一遍，改一处另一处会静默不动）
    const emptyBlock = /export function JournalEmpty\(\)[\s\S]*?\n\}/.exec(HISTORY)
    expect(emptyBlock, '找不到 JournalEmpty').not.toBeNull()
    expect(emptyBlock![0], '空态里又写了 30 天 —— 那句话已经搬到列表下方了').not.toContain('30 天')
    // 渲染层面再说一遍：空态那句话不含 30 天，保留提示那块含
    expect(visibleText(renderToStaticMarkup(<JournalEmpty />))).not.toContain('30 天')
    expect(visibleText(renderToStaticMarkup(<JournalRetentionNote />))).toContain('30 天')
  })

  it('反面对照：把旧文案装回去，①②必须红', () => {
    // `String.replace` 只换第一处 —— 两条路都要装回旧文案才等价于"整份退回"，
    // 所以这里用 `split/join`（全量替换）。只用 replace 会留下一处新文案，
    // 那条对照就变成"改了一半"，证明不了判据对整份退回有判别力。
    const reverted = CLEANUP.split(ADMIN_LINE).join('本程序已以管理员身份运行。仍有部分文件删不掉。')
    expect(reverted).not.toBe(CLEANUP)
    expect(reverted.split(ADMIN_LINE).length - 1, '全量替换之后新文案还在 ⇒ 对照没装干净').toBe(0)
    expect(reverted).toContain('已以管理员身份运行')
    // 空状态那句也装回去
    const fullyReverted = reverted
      .split('暂未进行扫描，请先前往首页执行扫描。')
      .join('还没有扫描会话。先回首页扫描一个目录 —— 清理只针对「已经扫到」的文件计价，本工具不会为了算数字再走一遍磁盘。')
    expect(fullyReverted).toContain('还没有扫描会话')
    expect(fullyReverted).not.toContain('暂未进行扫描')
  })
})
