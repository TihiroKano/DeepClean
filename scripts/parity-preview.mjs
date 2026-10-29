/**
 * M3-B 预览层的零容差对账 —— **TS 半边**：同一份夹具、同一棵树，
 * 跑 `evaluateRules` → `buildPreviewModel`，把**原始**模型吐成 JSON 到 stdout。
 *
 *   node D:/DeepClean/node_modules/esbuild/bin/esbuild scripts/parity-preview.mjs \
 *     --bundle --platform=node --format=esm --outfile=.scan-cache/parity-preview.mjs
 *   node .scan-cache/parity-preview.mjs src-tauri/crates/cleaner/tests/data/preview-parity.json
 *
 * 对面是 `src-tauri/crates/cleaner/tests/preview_parity.rs` —— 它起这个脚本、投影两侧、逐字段比。
 * **本脚本不比较、不归一化**：归一化只在一处发生（Rust 那侧），否则"两侧各自归一化到一致"
 * 会把真差异抹平。
 */
import { readFileSync } from 'node:fs'
import { evaluateRules } from '../core/rules/engine.ts'
import { BUILTIN_RULES, FORBIDDEN_PATH_PATTERNS, REPORT_ONLY_ROOT_PATTERNS } from '../core/rules/registry.ts'
import { buildPreviewModel } from '../core/rules/preview.ts'
import { buildSource } from './parity-tree.mjs'

const fixturePath = process.argv[2]
if (!fixturePath) {
  console.error('usage: parity-preview.mjs <fixture.json>')
  process.exit(2)
}
const fx = JSON.parse(readFileSync(fixturePath, 'utf8'))

function rulesOf(c) {
  if (c.rules === 'builtin') return BUILTIN_RULES
  return typeof c.rules === 'string' ? fx.ruleSets[c.rules] : c.rules
}

const out = {}
for (const c of fx.cases) {
  const env = c.env ?? fx.env
  const maxListedPaths = c.maxListedPaths ?? fx.maxListedPaths
  const collectPathsFor = new Set(c.collectAllPathsFor ?? [])
  const report = evaluateRules({
    source: buildSource(fx.trees[c.tree]),
    env,
    rules: rulesOf(c),
    forbiddenPatterns: FORBIDDEN_PATH_PATTERNS,
    reportOnlyPatterns: REPORT_ONLY_ROOT_PATTERNS,
    nowMs: fx.nowMs,
    maxListedPaths,
    collectPathsFor,
    detectorStatus: c.detectorStatus ? new Map(Object.entries(c.detectorStatus)) : undefined
  })
  out[c.id] = buildPreviewModel(report, c.selection, {
    nowMs: fx.nowMs,
    defaultUnselectableRuleIds: c.defaultUnselectableRuleIds ?? []
  })
}
process.stdout.write(JSON.stringify(out))
