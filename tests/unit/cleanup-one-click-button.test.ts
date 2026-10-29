/**
 * 「一键清理」那颗按钮的**结构判据**（`src/renderer/pages/Cleanup.tsx`）。
 *
 * ## 为什么是源码闸，不是渲染闸
 *
 * `Cleanup` 是个**依赖 `window.deepclean` 的受控组件**：挂载即发 `usePreview()` 一条 IPC，
 * 渲染它要一整套假桥 + 假 payload。而这里要钉的四件事在 JSX 里就是字面量：
 *   ① 按钮用的是 `.dc-cta`（与首页「开始深度扫描」同一套视觉权重，不是另画一颗）；
 *   ② 它挂在页头那一行（`.dc-clean-head`）里，而不是行动区里再冒一颗；
 *   ③ 旧的两套入口（「一键清理（免确认档 · 直接删）」那颗 `.dc-btn`、手动档的
 *      「确认预估 → 开始清理」）**都已删** —— 2026-10-24 起这一页只有一个执行入口
 *      （人类伙伴：「合并成一颗」），同屏两个控件写同一份 state 是本项目定过的形状缺陷；
 *   ④ 禁用条件写在同一处，且 `title` 会说明为什么按不动。
 *
 * 真行为那半边（点下去真的走 `runAutoClean`）由本文件最后一条与
 * `tests/unit/cleanup-selection-ownership.test.tsx` 分担。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** 剥注释：判据量的是实现，注释里写着"旧按钮已删"不该把它喂饱。 */
function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CLEANUP = src('src/renderer/pages/Cleanup.tsx')

describe('清理页的「一键清理」按钮：结构、位置、唯一性', () => {
  it('用的是首页那颗 `.dc-cta`，不是另画一颗', () => {
    expect(CLEANUP, '页头那颗主按钮必须复用 `.dc-cta`（与「开始深度扫描」同一套样式）').toMatch(
      /className="dc-cta[^"]*"/
    )
    expect(CLEANUP, '它必须带 `一键清理` 这四个字').toContain('一键清理')
  })

  it('挂在页头那一行（`.dc-clean-head`）里，与标题同一行', () => {
    const headStart = CLEANUP.indexOf('className="dc-clean-head"')
    expect(headStart, '找不到 `.dc-clean-head` 那一行 —— 按钮被挪走了？').toBeGreaterThan(-1)
    const titleAt = CLEANUP.indexOf('dc-clean-title', headStart)
    expect(titleAt, '页头里找不到标题').toBeGreaterThan(headStart)
    const btnAt = CLEANUP.indexOf('一键清理', headStart)
    expect(btnAt, '按钮不在页头那一行里').toBeGreaterThan(titleAt)
    const headEnd = CLEANUP.indexOf('\n      </div>', headStart)
    expect(headEnd === -1 || btnAt < headEnd, '「一键清理」跑到了页头闭合之外').toBe(true)
  })

  it('旧的手动档（确认预估 / 开始清理）已经删掉 —— 同一页只留一个执行入口', () => {
    // 2026-10-24 修正：弹窗确认按钮文案是「确定，开始清理」，它也含「开始清理」四个字。
    // 旧的 `.dc-btn` 那颗叫「开始清理」（正好三个字边界），新弹窗那颗是
    // `.dc-primary dc-clean-confirm-go`。断言按"旧按钮的形状"判，而不是按子串误伤新按钮。
    expect(
      /className="dc-primary dc-clean-execute"/.test(CLEANUP),
      '旧的那颗 `.dc-clean-execute`「开始清理」必须删掉 —— 两个入口写同一份勾选是形状缺陷'
    ).toBe(false)
    expect(CLEANUP, '「确认预估」那一步必须删掉 —— 2026-10-24 起按下弹窗里的确定就是确认').not.toContain('确认预估')
  })

  it('禁用条件写在同一处，且 title 说得出为什么按不动', () => {
    // 扫描没完成 / 正在清理 / 保护未落地 / 零可清理 —— 全部是 `disabled`，
    // title 里各有各的说法，不许静默灰掉。
    expect(CLEANUP, '`running` 必须是禁用条件之一').toMatch(/disabled=\{running \|\| snapshot\.status !== 'completed'/)
    expect(CLEANUP, '按不动时 title 要给出原因').toMatch(/title=\{[\s\S]{0,400}等这一轮扫描完成/)
  })

  it('点下去走的是按勾选的一键清理，且带弹窗', () => {
    expect(CLEANUP, '必须调 `runAutoClean`').toContain('runAutoClean')
    // 名单必须由勾选拼出来（selected.map → ruleId），不是服务端固定名单
    expect(CLEANUP, '选区必须来自当前勾选').toMatch(/selected\.map\(\(ruleId\) => \(\{ ruleId \}\)\)/)
    // 弹窗必须挂出来
    expect(CLEANUP, '清理过程弹窗必须渲染').toContain('CleanProgressDialog')
    expect(
      /invoke\(['"]dc_execute/.test(CLEANUP),
      '一键清理不许绕到 `dc_execute` —— 那是已删的手动档执行路径'
    ).toBe(false)
  })
})
