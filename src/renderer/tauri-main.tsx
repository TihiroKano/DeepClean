/**
 * Tauri 侧的渲染端入口。
 *
 * 与 `index.tsx`（Electron 侧）**只差一行**：这里先装 `window.deepclean` 的 Tauri 适配器。
 * 两份入口刻意分开而不是加一个 `if (isTauri)` 分支 —— Electron 那份今天仍然要能跑，
 * 混在一起会让"哪边坏了"这件事变成运行时才知道的事。
 *
 * CSS 的加载顺序与 `index.tsx` 一致（fonts 最先、global 次之、tokens 最后），那条顺序本身是判据的一部分：
 * `@font-face` 必须早于任何用到那几个族的声明出现，否则首批元素会先按回退字形排版再重排。
 *
 * **启动失败必须看得见**：白屏 + 一个吞掉的异常，"界面没渲染"与"渲染了但内容是空的"
 * 在截图里长得一模一样，而这两件事的排查方向完全相反。所以这里把任何启动期的异常
 * 直接画到屏幕上（本项目吃过"看着正常其实没有"的亏）。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installTauriBridge } from './tauri-bridge'
import { App } from './App'
import './styles/fonts.css'
import './styles/global.css'
import './styles/glass/tokens.css'

function fatal(where: string, err: unknown): void {
  const root = document.getElementById('root')
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const hasTauri = typeof (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== 'undefined'
  if (root) {
    root.innerHTML =
      `<pre style="margin:0;padding:24px;color:#ffd7d7;font:13px/1.7 ui-monospace,Consolas,monospace;white-space:pre-wrap">` +
      `DeepClean 启动失败（${where}）\n\n${msg}\n\n__TAURI__ 存在：${hasTauri}\n` +
      `location: ${location.href}</pre>`
  }
  // eslint-disable-next-line no-console
  console.error(`[dc] 启动失败（${where}）`, err)
}

let mounted = false

try {
  // 给 body 打上"这是 Tauri 壳"的标记。给 CSS 用来关掉只对 Electron 系统胶囊
  // 才有意义的那笔让位（`.dc-bar` 的 `padding-right: 152px`，见 global.css 那段注释）。
  // 打在 body 上而不是某个组件的 className：这是**壳层**的事实，不是某一页的样式。
  document.body.classList.add('dc-tauri')
  installTauriBridge()
  const el = document.getElementById('root')
  if (!el) throw new Error('#root 不存在（tauri.html 的 DOM 被换过？）')
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
  mounted = true
} catch (e) {
  fatal('挂载', e)
}

// **只接住"还没挂上"那一段的异常**。挂上之后再出的事归应用自己管 ——
// 一个瞬时错误把整棵树换成错误页，是把小毛病升级成"整个界面没了"。
window.addEventListener('error', (e) => {
  if (!mounted) fatal('window.error', e.error ?? e.message)
  else console.error('[dc] 运行时错误', e.error ?? e.message)
})
window.addEventListener('unhandledrejection', (e) => {
  if (!mounted) fatal('unhandledrejection', e.reason)
  else console.error('[dc] 未处理的 rejection', e.reason)
})
