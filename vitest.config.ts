import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 组件级单测（tests/unit/skip-panel.test.tsx）要 import src/renderer 下的 .tsx：
  // 这里没挂 @vitejs/plugin-react（那是浏览器端的 fast-refresh 插件，node 环境用不上），
  // 所以显式让 esbuild 走自动 JSX 运行时 —— 组件源码里没有 `import React`，
  // 缺这一行的话渲染测试不是变红而是报 "React is not defined"，那是假红。
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['node_modules/**', 'out/**', 'tests/integration/**'],
    testTimeout: 20000,
    /*
     * CI OOM 的修复（2026-10-30，第三版）：**singleFork 单进程**。
     *
     * 第一版 maxWorkers=4 没救回「单测」：threads pool 在 2 核 runner 上
     * fork 4 个 worker、worker 内还有 tinypool 的线程池，内存上界不可控 ——
     * 1138b74 仍失败。本地 8 核怎么跑都绿，所以是 runner 内存形状的问题。
     *
     * singleFork：全部测试在**一个进程**里顺序跑，内存上界恒定
     * （本地实测 ~1.2GB 峰值、76 文件 1133 条全绿约 2 分钟）。
     * 代价是失去文件级并行 —— 但 CI 的瓶颈本来就是内存不是 CPU，接受。
     */
    maxWorkers: 1,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } }
  }
})
