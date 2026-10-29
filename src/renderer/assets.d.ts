/**
 * 渲染端可以 `import url from './x.png'`，Vite 会把它换成产物里的资源名。
 *
 * 为什么单独开一个文件而不是塞进 `global.d.ts`：那个文件顶部有 `import type`、
 * 底部有 `export {}`，它因此是一个**模块**，而模块里的 `declare module '*.png'`
 * 不生效（TS2307 照旧报）。通配模块声明要住在**全局脚本**文件里 —— 所以这个文件
 * 一个 import 都不许加。
 *
 * 为什么不改去引 `vite/client`：它会把 `import.meta.env` 等一批全局一起开进来，
 * 而那批东西在 Electron 主进程侧不成立。本项目宁可只声明用到的这一行。
 */
declare module '*.png' {
  const url: string
  export default url
}

/**
 * 2026-10-27：背景壁纸换了实现，`useSettings` 要把 `assets/mountain-bg.jpg` 的产物 URL
 * 塞进 `--dc-wallpaper`（那张内置夜山）。少这一行就是 TS2307 —— 而它指向的是
 * "我引了一个图片"这件事，与"壁纸功能坏了"看起来完全无关。
 */
declare module '*.jpg' {
  const url: string
  export default url
}
