import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Tauri 侧的渲染端构建。产物落 `src-tauri/dist/`，被 `tauri.conf.json` 的 `frontendDist`
 * **在编译期**嵌进二进制（改了 dist 不重新 `cargo build`，跑的还是旧页面 —— M0 记过这条）。
 *
 * 与 `electron.vite.config.ts` 是两份配置、共用同一个 `src/renderer` 源：
 * 入口不同（`tauri.html` vs `index.html`），别的都一样。**不要合并成一份** ——
 * Electron 那份今天仍然要能跑，合并之后改一边会顺手弄坏另一边。
 *
 * `base: './'` 不是可选项：Tauri 用自定义协议（`tauri://localhost`）提供资源，
 * 绝对路径 `/assets/x.js` 在那里解析不出来。
 */
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'src-tauri/dist'),
    emptyOutDir: true,
    // 入口文件的键名决定产物文件名：`index` ⇒ 产出 `dist/index.html`。
    // Tauri 默认就找 `index.html`，这样不用去动 tauri.conf.json 的窗口 url
    //（少依赖一个配置字段，就少一处"配错了但窗口还开着、只是白屏"）。
    rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/tauri.html') } }
  }
})
