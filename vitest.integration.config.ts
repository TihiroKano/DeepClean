import { defineConfig } from 'vitest/config'

/**
 * 对账用集成测试专用配置（Task 13 Step 6）。
 *
 * 为什么单独一个 config：`vitest run --exclude ...` 的 CLI exclude 是**追加**到
 * vitest.config.ts 的 exclude 上的（实测打印出 `tests/integration/**` 仍在列表里），
 * 所以没法用命令行把集成测试从排除名单里放回来。
 *
 * 跑法（期望值一律现场取，禁止手写）：
 *   cd /d/DeepClean
 *   DC_ORACLE="$(node scripts/oracle.mjs 'D:/deepclean-fixture/f100k')" \
 *   DC_ORACLE_EXCLUDED="$(node scripts/oracle.mjs 'D:/deepclean-fixture/f100k/System Volume Information')" \
 *   npm run test:integration
 *
 * 这些用例要扫 10 万个真实文件 → 超时按分钟给，不用默认的 20s。
 * 没建夹具时它们整体 skip（skipIf），不会把 `npm test` 的绿灯变成红灯。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules/**', 'out/**'],
    testTimeout: 600_000,
    hookTimeout: 600_000
  }
})
