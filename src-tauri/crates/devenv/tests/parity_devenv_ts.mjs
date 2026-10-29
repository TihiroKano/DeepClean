/**
 * 派工单 D1 §4-C：把 TS 的**判定层**（`core/rules/devenv-view.ts` + `core/rules/detectors.ts` +
 * `core/analyze/model-files.ts`，规则表用 `core/rules/registry.ts` 的 `BUILTIN_RULES`）跑在
 * `tests/data/d1-parity.json` 上，输出**归一化投影**。Rust 侧 `tests/parity_with_ts.rs` 跑同一份
 * 夹具、同一份投影清单，逐字段比。
 *
 * 用法（在工作树根目录，用主树的打包器把本工作树里的 core/** 打进去 —— 与 `parity_ts.mjs` 同一套）：
 *   node D:/DeepClean/node_modules/esbuild/bin/esbuild \
 *     src-tauri/crates/devenv/tests/parity_devenv_ts.mjs \
 *     --bundle --platform=node --format=esm \
 *     --outfile=src-tauri/crates/devenv/tests/parity_devenv_ts.bundle.mjs
 *   node src-tauri/crates/devenv/tests/parity_devenv_ts.bundle.mjs \
 *     src-tauri/crates/devenv/tests/data/d1-parity.json \
 *     src-tauri/crates/devenv/tests/data/d1-parity.expected.json
 *   rm src-tauri/crates/devenv/tests/parity_devenv_ts.bundle.mjs     # 中间产物不落仓
 *
 * ⚠️ golden 会静默过期：**跑 `parity_with_ts.rs` 之前先重生成并与入库那份 `cmp`**。
 *
 * 归一化**只在本文件的 `project()` 一处**（Rust 侧 `project_case` 与之逐字段对应）：
 *  · 零容差 —— 没有一格被抹平：判定层零 IO、零失败路径，两侧唯一的差异来源就是判据本身；
 *  · `installStatus` 从 Map 变成**按 key 升序**的对象（Rust 的 BTreeMap 天生升序）；
 *  · 数字：TS 的 `number` 与 Rust 的 `u64` 在 JSON 上都是无指数、无小数点的整数字面量，
 *    Rust 侧比对走 `serde_json::Value`（`Number` 按数值比）。
 *
 * harness 侧的塑形（两侧**同序同法**，不属于 crate 行为，写在 Rust 侧也有对应注释）：
 *  1. `installStatusOmit` / `installStatusForce`：先按表跑 `collectInstallStatus`，再删键 / 改值。
 *     删键是造「不知道」那一格的唯一办法 —— 「不知道」住在键的缺席里，不是 crate 的一个选项。
 *  2. 视图那一份的 `docker` 入参：夹具 `probe.docker === null`（探针压根没有那一格能力面）时
 *     交 `null`（= 壳层这次没查过），否则交 `readDockerDiskUsage` 的结果。
 *     注意 `dockerUsage` 那一格**照样输出**（没有能力面时是 unmeasurable），两侧都比。
 *  3. 求值次序固定：`collectInstallStatus` → `readDockerDiskUsage` → `DOCKER_DETECTOR.isInstalled`
 *     → `buildDevEnvView`。`askedCommands` / `askedDirs` 记的是这趟次序的**全序列**，
 *     它是「两级取或、不求短路」那条判据的证据（短路实现下结论会随命令表顺序变）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import {
  DEV_ENV_DETECTORS,
  DEV_ENV_DETECTORS_WITH_DOCKER,
  DOCKER_DETECTOR,
  collectInstallStatus,
  detectorForRule,
  readDockerDiskUsage
} from '../../../../core/rules/detectors.ts'
import { buildDevEnvView } from '../../../../core/rules/devenv-view.ts'
import { modelTallyFrom } from '../../../../core/analyze/model-files.ts'
import { BUILTIN_RULES } from '../../../../core/rules/registry.ts'

const fixturePath = process.argv[2]
const outPath = process.argv[3]
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

/** 投影的字段清单 = Rust `project_case` 的字段清单。两处必须同名同集合。 */
const PROJECTED = [
  'name',
  'installStatus',
  'dockerUsage',
  'dockerInstalled',
  'askedCommands',
  'askedDirs',
  'detectorByRule',
  'modelTally',
  'view'
]

function makeProbe(spec) {
  const commands = new Set(spec.commands ?? [])
  const dirs = new Set((spec.dirs ?? []).map((d) => d.toLowerCase()))
  const askedCommands = []
  const askedDirs = []
  const probe = {
    commandAvailable(command) {
      askedCommands.push(command)
      return commands.has(command)
    },
    pathExists(pathTemplate) {
      // 记账记**原样**的模板（证明这一层没改写它），比较才折叠大小写（Windows 口径住在探针）
      askedDirs.push(pathTemplate)
      return dirs.has(pathTemplate.toLowerCase())
    }
  }
  if (spec.docker !== null && spec.docker !== undefined) {
    probe.queryDockerDiskUsage = () => spec.docker
  }
  return { probe, askedCommands, askedDirs }
}

function sortedMap(m) {
  return Object.fromEntries([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)))
}

const cases = []
for (const c of fixture.cases) {
  const { probe, askedCommands, askedDirs } = makeProbe(c.probe ?? {})
  const table = c.detectorsTable === 'withDocker' ? DEV_ENV_DETECTORS_WITH_DOCKER : DEV_ENV_DETECTORS

  const installStatus = collectInstallStatus(probe, table)
  for (const k of c.installStatusOmit ?? []) installStatus.delete(k)
  for (const [k, v] of Object.entries(c.installStatusForce ?? {})) installStatus.set(k, v)

  const dockerUsage = readDockerDiskUsage(probe)
  const dockerInstalled = DOCKER_DETECTOR.isInstalled(probe)

  const ruleIds = [
    ...BUILTIN_RULES.filter((r) => r.category === 'dev-cache').map((r) => r.id),
    'windows-temp',
    'docker'
  ]
  const detectorByRule = {}
  for (const id of ruleIds) detectorByRule[id] = detectorForRule(id, table)?.id ?? null

  const modelTally = c.modelTallyInput
    ? modelTallyFrom(c.modelTallyInput.totals, c.modelTallyInput.env)
    : null

  const view = buildDevEnvView({
    rules: BUILTIN_RULES,
    installStatus,
    // 塑形 2：探针没有那一格能力面（夹具 `probe.docker === null`）= 壳层这次压根没查 → 交 null；
    // 查过就交 readDockerDiskUsage 的三格结论（哪怕是 unmeasurable）。Rust 侧同法。
    docker: c.probe?.docker == null ? null : dockerUsage,
    bytesByRule: c.bytesByRule ?? {},
    modelFiles: modelTally,
    territories: c.territories ?? [],
    scannedRoot: c.scannedRoot ?? null
  })

  const out = {
    name: c.name,
    installStatus: sortedMap(installStatus),
    dockerUsage,
    dockerInstalled,
    askedCommands,
    askedDirs,
    detectorByRule,
    modelTally,
    view
  }
  const projected = {}
  for (const k of PROJECTED) projected[k] = out[k] === undefined ? null : out[k]
  cases.push(projected)
}

const result = JSON.stringify({ cases }, null, 1)
if (outPath) writeFileSync(outPath, result + '\n')
else process.stdout.write(result + '\n')
