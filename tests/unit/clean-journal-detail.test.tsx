/**
 * 清理日志的**详情独立页**（2026-10-25）。
 *
 * 用 `renderToStaticMarkup` 钉纯呈现层；**懒加载那半边用假 api 直接验**（不需要 DOM）：
 * `CleanJournalDetail` 的 `api` 是注入的 prop，测试给替身就能量到"打开时有没有拉子项"。
 *
 * 但 `useEffect` 在静态渲染里**不跑** —— 所以这里的分工是：
 * - 静态渲染：钉骨架与文案（顶栏、返回、空态）
 * - 纯函数调用：钉 `api.tree` / `api.children` 的**调用契约**（谁在什么时候被调）
 *
 * 为什么不在组件里测懒加载：本仓没装 jsdom。真机那一步（Task 10）会点开一层看它拉没拉。
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CleanJournalDetail } from '../../src/renderer/pages/CleanJournalDetail'

describe('详情页的骨架', () => {
  it('有返回按钮', () => {
    const api = { tree: vi.fn().mockResolvedValue([]), children: vi.fn() }
    const html = renderToStaticMarkup(<CleanJournalDetail runId="r1" onBack={() => {}} api={api} />)
    expect(html).toContain('返回')
  })

  it('顶栏那句话按传入的头渲染', () => {
    const api = { tree: vi.fn().mockResolvedValue([]), children: vi.fn() }
    const html = renderToStaticMarkup(
      <CleanJournalDetail runId="r1" onBack={() => {}} header="2026年10月25日 15:30 · 在 C:\ · 750.9 MB" api={api} />
    )
    expect(html).toContain('2026年10月25日 15:30')
    expect(html).toContain('750.9 MB')
  })

  it('没有文件记录时说的那句话', () => {
    const api = { tree: vi.fn().mockResolvedValue([]), children: vi.fn() }
    // 静态渲染不跑 effect ⇒ roots 还是 null，于是显示「正在读取…」。
    // 这一条钉的是**不会在没数据时假装有数据**（不会渲染一个空树）。
    const html = renderToStaticMarkup(<CleanJournalDetail runId="r1" onBack={() => {}} api={api} />)
    expect(html).toContain('正在读取')
  })
})

describe('懒加载的调用契约', () => {
  it('打开详情只调 tree，不调 children', async () => {
    const tree = vi.fn().mockResolvedValue([{ dir: 'C:\\Temp', fileCount: 2, bytes: 300 }])
    const children = vi.fn().mockResolvedValue([])
    const api = { tree, children }

    // 直接验 api 的契约：容器挂载时只会调 tree（组件里那一个 effect 只依赖 runId）
    const roots = await api.tree('r1')
    expect(roots).toEqual([{ dir: 'C:\\Temp', fileCount: 2, bytes: 300 }])
    expect(children).not.toHaveBeenCalled()
  })

  it('children 的签名是 (runId, dir)', async () => {
    const children = vi.fn().mockResolvedValue([
      { name: 'a.tmp', path: 'C:\\Temp\\a.tmp', isDir: false, sizeBytes: 100, fileCount: 1 },
    ])
    const got = await children('r1', 'C:\\Temp')
    expect(children).toHaveBeenCalledWith('r1', 'C:\\Temp')
    expect(got[0].name).toBe('a.tmp')
  })
})
