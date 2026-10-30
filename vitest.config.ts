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
     * CI 上 OOM 的修复（2026-10-30）：默认 pool=threads 且 maxWorkers=CPU 数，
     * 每个**测试文件**一个 worker 线程。GitHub runner 2 核 ⇒ 76 个文件排 2 路并发，
     * 但 vitest 5 会**预先 fork 全部 worker 线程**（每个 ~100MB RSS），2 核机上
     * 76 × 100MB ≈ 7.6GB 直接顶到 runner 的 7GB 内存条 —— 一个 worker 被 OOM kill，
     * vitest 退出 1。本机 8 核 + 空闲内存足够，所以本地怎么跑都绿。
     *
     * 修法：**maxWorkers 压到 4**。worker 是复用的（跑完一个文件换下一个），
     * 4 个足够让 2 核 runner 饱和；8 核本机也几乎不慢（fork 的固定开销
     * 从 76 次降到 4 次，反而省启动时间）。CI 两次失败（fd653c0 / 7199941）
     * 都在这一处，与测试内容无关。
     *
     * ⚠️ 只有 maxWorkers、没有 minWorkers —— vitest 5 的 InlineConfig 不认
     * minWorkers（TS2769，CI 上第一个修复版就是被它顶掉的）。
     */
    maxWorkers: 4
  }
})
