import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 浮层的独立层级（计划书 §4 line 484：下拉菜单一定要 Portal 到独立层级，否则与卡片发生层级穿透、文字重叠）。
 *
 * 为什么需要它：`.dc-menu` 现在是 `position: fixed; z-index: 40`，看着已经"浮在最上面"了 ——
 * 但 fixed 只保证**视口**坐标系，不保证**层叠上下文**：祖先一旦有 transform / filter / will-change
 * （V0.8 上玻璃之后每个浮层卡片都会带 `filter`），它就会在那个祖先内部重新参与排序，
 * 于是"最高的 z-index"输给一个更外层的堆叠。Portal 到 body 是唯一不靠记性的解法。
 *
 * SSR 那一支不是防御性编程：本仓库大量用 `renderToStaticMarkup` 渲染组件做判据
 * （`dup-render` / `skip-panel` / `spacemap-menu`），而 `createPortal` 在服务端渲染器里**直接抛**。
 * 没有这一支，任何把带菜单的页面拉进静态渲染的用例都会以一句看不懂的错误失败。
 */
export function Portal({ children }: { children: ReactNode }): JSX.Element {
  const [host] = useState((): HTMLElement | null => {
    if (typeof document === 'undefined') return null
    const existing = document.getElementById('dc-portal-root')
    if (existing !== null) return existing
    const el = document.createElement('div')
    el.id = 'dc-portal-root'
    document.body.appendChild(el)
    return el
  })
  useEffect(() => {
    // 容器留着复用，不随单个浮层卸载而删：删早了会把同一帧里另一个刚挂上去的浮层一起带走
    if (host === null) return
    host.style.position = 'relative'
    host.style.zIndex = '1000'
  }, [host])
  if (host === null) return <>{children}</>
  return createPortal(children, host)
}
