/**
 * M5-E⑤ 报告导出的**零容差对账 —— TS 半边**。
 *
 * 同一份夹具（`tests/data/m5e-report-parity.json`）喂给 TS 的 `core/report/scan-report.ts`
 * 与 Rust 的 `src-tauri/src/report.rs`，把两份 `ScanReportJson` 逐字段比。
 * 这一步买的是「schema 串、字段名、键缺席规则、排序、裁剪、round2」这六件事**不是读源码读出来的**，
 * 而是真跑出来的 —— 文件头那句「与基准逐字对齐」如果只靠人眼比对两份代码，就不该写进验收文档。
 *
 * 用法（在工作树根目录）：
 *   node D:/DeepClean/node_modules/esbuild/bin/esbuild \
 *     src-tauri/tests/parity_report_ts.mjs \
 *     --bundle --platform=node --format=esm \
 *     --outfile=src-tauri/tests/parity_report_ts.bundle.mjs
 *   node src-tauri/tests/parity_report_ts.bundle.mjs \
 *     src-tauri/tests/data/m5e-report-parity.json \
 *     src-tauri/tests/data/m5e-report-parity.expected.json
 *   rm src-tauri/tests/parity_report_ts.bundle.mjs     # 中间产物不落仓
 *
 * ⚠️ golden 会静默过期：**跑 `report::tests::with_ts_zero_tolerance_on_the_same_tree` 之前
 * 先重生成并与入库那份 `cmp`**，不同就说明比的是「旧 TS」。
 *
 * 两侧同法、必须同序的两件 harness 事（Rust 侧 `fixture_tree` 有对应注释）：
 *  1. **目录大小自底上算**（本层文件 + 全部子目录），夹具里不写死 —— 这样报告读到的
 *     `DirRecord.size_counted` 与 TS 的 `ChildView.size` 是同一份算术的两次实现，
 *     谁算漏一层都会体现在报告数字上。
 *  2. `topFiles` **原序交出去**，两侧都不排序：报告那一格就是"谁排的序"的显形。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { buildScanReport } from '../../core/report/scan-report.ts'

const BS = '\\'
const joinWin = (...segs) => segs.join(BS)

const fixturePath = process.argv[2]
const outPath = process.argv[3]
if (!fixturePath || !outPath) {
  console.error('usage: parity_report_ts.mjs <fixture.json> <out.json>')
  process.exit(2)
}
const fx = JSON.parse(readFileSync(fixturePath, 'utf8'))

/** id 深度优先分配（与 Rust 侧 `TreeIndex::build` 的 push_node 同序）。 */
let nextId = 0
const byId = new Map()

function materialize(spec, path) {
  const id = nextId++
  const node = { id, path, name: spec.name, dirs: [], files: [] }
  for (const f of spec.files ?? []) {
    node.files.push({ kind: 'file', name: f.name, path: joinWin(path, f.name), size: f.size, mtimeMs: f.mtimeMs })
  }
  for (const d of spec.dirs ?? []) {
    node.dirs.push(materialize(d, joinWin(path, d.name)))
  }
  // 自底上算：本层文件 + 全部子目录（与 Rust 侧同一个算术，两侧都不写死）
  node.size = node.files.reduce((s, f) => s + f.size, 0) + node.dirs.reduce((s, d) => s + d.size, 0)
  byId.set(id, node)
  return node
}

const root = materialize(fx.root, fx.root.path)

function childrenOf(dirId) {
  const n = byId.get(dirId)
  if (!n) return []
  return [...n.dirs.map((d) => ({ kind: 'directory', name: d.name, path: d.path, size: d.size, dirId: d.id })), ...n.files]
}

const out = {
  note: '由 scripts/../src-tauri/tests/parity_report_ts.mjs 生成，勿手改；重生成命令写在该文件头上',
  cases: fx.cases.map((c) => {
    const source = { rootId: root.id, childrenOf }
    // 夹具的 skipped 为 null = 「这棵树压根没有清单这一格」⇒ source 上不给 skipped 方法
    if (c.skipped) source.skipped = () => ({ sample: c.skipped.sample, overflowed: c.skipped.overflowed })
    const report = buildScanReport({
      snapshot: c.snapshot,
      source,
      topFiles: fx.topFiles,
      appVersion: fx.appVersion,
      nowMs: fx.nowMs,
      maxDepth: fx.maxDepth,
      topPerLevel: fx.topPerLevel,
      // peakRssBytes 故意不给：Electron 的调用点（electron/main/ipc-register.ts:50）也传 null，
      // 两侧都在 null 这一格上比
    })
    return { name: c.name, report }
  }),
}

writeFileSync(outPath, JSON.stringify(out, null, 1) + '\n', 'utf8')
console.log(`wrote ${outPath}: ${out.cases.length} cases`)
