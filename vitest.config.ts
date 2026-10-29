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
    testTimeout: 20000
  }
})
