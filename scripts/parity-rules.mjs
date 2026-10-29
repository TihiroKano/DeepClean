/**
 * M3-A 零容差对账的 **TS 半边**：把 `core/rules` 的引擎跑在同一份共享夹具上，吐 JSON 到 stdout。
 *
 *   node scripts/parity-rules.mjs <fixture.json>            # 用 esbuild 打好的包跑
 *   npx vite-node scripts/parity-rules.mjs <fixture.json>   # 装了 vite-node 时
 *
 * 对面是 `src-tauri/crates/rules/tests/parity_with_ts.rs` —— 它负责把两份报告逐字段比。
 * **这个脚本不做任何比较、也不做归一化**：它只吐 TS 引擎的原始报告。
 * 比较与归一化只在一处（Rust 那侧），否则"两侧各自归一化到一致"会把真差异抹平。
 *
 * 为什么要经 esbuild/vite-node：`core/rules/engine.ts` 是 TS 且用**无扩展名**相对导入，
 * 裸 `node` 的 type-stripping 解不开（Node 24 实测）。
 */
import { readFileSync } from 'node:fs'
import { evaluateRules } from '../core/rules/engine.ts'
import { BUILTIN_RULES, FORBIDDEN_PATH_PATTERNS, REPORT_ONLY_ROOT_PATTERNS } from '../core/rules/registry.ts'
import { buildSource } from './parity-tree.mjs'

function runCase(c, env, nowMs, maxListedPaths) {
  const rules = c.rules === 'builtin' ? BUILTIN_RULES : c.rules
  const report = evaluateRules({
    source: buildSource(c.root),
    // 逐 case 可以覆盖 env：fail-safe 那条路要一个"禁止根解析不出来"的环境
    env: c.env ?? env,
    rules,
    forbiddenPatterns: FORBIDDEN_PATH_PATTERNS,
    reportOnlyPatterns: REPORT_ONLY_ROOT_PATTERNS,
    nowMs,
    maxListedPaths,
    detectorStatus: c.detectorStatus ? new Map(Object.entries(c.detectorStatus)) : undefined
  })
  return {
    findings: report.findings.map((f) => ({
      ruleId: f.ruleId,
      category: f.category,
      cleanStrategy: f.cleanStrategy,
      recoverable: f.recoverable,
      fileCount: f.fileCount,
      totalBytes: f.totalBytes,
      samplePaths: f.samplePaths,
      sampleTruncated: f.sampleTruncated,
      matchedRoots: f.matchedRoots
    })),
    exclusions: report.exclusions.map((e) => ({ ruleId: e.ruleId, path: e.path, reason: e.reason })),
    // 原来只投影 id，于是 `name` 与逐条 `reason` 这两格**没人比过** —— 而它们正是
    // §17 预览那句 item-rejected 要念给用户的东西。`detail` 仍不比（散文，两侧各写一遍，
    // 与排除项同一 posture：比结构不比措辞）。
    rejectedRules: report.rejectedRules
      .map((r) => ({ ruleId: r.ruleId, name: r.name, problems: r.problems.map((q) => ({ reason: q.reason })) }))
      .sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)),
    bytesByRisk: report.bytesByRisk,
    forbiddenRoots: report.forbiddenRoots,
    reportOnlyRoots: report.reportOnlyRoots,
    territories: report.territories,
    reclaimableBytes: report.reclaimableBytes,
    safetyBlocked: report.safetyBlocked
  }
}

const fixturePath = process.argv[2]
if (!fixturePath) {
  console.error('usage: parity-rules.mjs <fixture.json>')
  process.exit(2)
}
const fx = JSON.parse(readFileSync(fixturePath, 'utf8'))
const out = {}
for (const c of fx.cases) out[c.id] = runCase(c, fx.env, fx.nowMs, fx.maxListedPaths)
process.stdout.write(JSON.stringify(out))
