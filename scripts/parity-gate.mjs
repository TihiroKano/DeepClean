/**
 * M3-C-1 授权闸的零容差对账 —— **TS 半边**。
 *
 * 读 `src-tauri/crates/cleaner/tests/data/gate-parity.json`，
 * 用 esbuild bundle 后 node 运行，把 TS 基准输出 JSON 到 stdout。
 *
 * TS 基准严格对应 Rust `gate.rs` 的当前范围：
 * - `guardAuthorizedRoot` 同步三关 + 注入式 `probe`（对标 `guard_authorized_root`）
 * - `classifyPath` 第一道逐条闸（对标 `classify_path`）
 *
 * 本脚本不比较、不归一化；归一化在 Rust 测试侧做。
 */
import { readFileSync } from 'node:fs'
import { isForbiddenPath, pathIsUnder, resolvePattern } from '../core/rules/engine.ts'
import { normalizeKey } from '../core/fs/pathutil.ts'

const fixturePath = process.argv[2]
if (!fixturePath) {
  console.error('usage: parity-gate.mjs <fixture.json>')
  process.exit(2)
}
const fx = JSON.parse(readFileSync(fixturePath, 'utf8'))

/* ------------------------------------------------------------------ *
 * 路径工具（从 executor.ts:154-178 复制，保持与 Rust gate.rs 同口径）
 * ------------------------------------------------------------------ */

const segsOf = (p) => p.replace(/\//g, '\\').split('\\').filter((s) => s.length > 0)

function isStrictlyInside(key, rootKey) {
  const prefix = rootKey.endsWith('\\') ? rootKey : `${rootKey}\\`
  return key.length > prefix.length - 1 && key.startsWith(prefix)
}

function pathShapeProblem(p) {
  if (p.startsWith('\\\\?\\')) return '扩展长度前缀（\\\\?\\）不是合法请求路径'
  if (/["*?<>|]/.test(p)) return '含 shell 通配/引号字符'
  if (segsOf(p).some((s) => s === '.' || s === '..')) return '含 . 或 .. 段'
  return null
}

function isDriveRootLike(p) {
  const t = p.replace(/\//g, '\\').replace(/\\+$/, '')
  return /^[A-Za-z]:$/.test(t)
}

function resolveForbidden(patterns, env) {
  const roots = []
  const unresolved = []
  for (const p of patterns) {
    const res = resolvePattern(p, env)
    if (res.concrete !== null) roots.push(res.concrete)
    else if (res.base !== null) roots.push(res.base)
    else unresolved.push(p)
  }
  return { roots, unresolved }
}

/* ------------------------------------------------------------------ *
 * guardAuthorizedRoot（executor.ts:600-645 + probe 关，对标 Rust guard_authorized_root）
 * ------------------------------------------------------------------ */

function guardAuthorizedRoot(root, forbidden, deny, reportOnly, probe) {
  const blockers = []
  const push = (reason, detail) => {
    blockers.push({ reason, detail })
    return blockers
  }
  if (typeof root !== 'string' || root.trim() === '') {
    return push('root-malformed', 'authorizedRoot 必须是非空字符串')
  }
  const p = root.trim()
  const shape = pathShapeProblem(p)
  if (shape !== null) return push('root-malformed', `authorizedRoot ${shape} → 拒绝`)
  const slashed = p.replace(/\//g, '\\')
  const isDriveAbs = /^[A-Za-z]:\\/.test(slashed)
  const isUnc = /^\\\\[^\\]+\\[^\\]+/.test(slashed)
  if (!isDriveAbs && !isUnc) {
    if (isDriveRootLike(p)) return push('root-is-drive-root', `authorizedRoot「${p}」是盘符根 → 整批拒绝，零删除`)
    return push('root-not-absolute', `authorizedRoot「${p}」不是盘符绝对路径或 UNC 共享 → 拒绝（§28 原则四）`)
  }
  if (isDriveRootLike(p)) return push('root-is-drive-root', `authorizedRoot「${p}」是盘符根 → 整批拒绝，零删除`)

  const unresolvedGuards = [...forbidden.unresolved, ...reportOnly.unresolved]
  if (unresolvedGuards.length > 0) {
    return push(
      'root-forbidden-unresolved',
      `禁止根模板解析不出来（${unresolvedGuards.join('、')}）→ 无法证明 ${p} 不在 System32/WinSxS/回收站里，宁可什么都不删`
    )
  }
  const deniedHit = isForbiddenPath(p, deny.roots)
  if (deniedHit !== null) {
    return push('root-denied-by-caller', `authorizedRoot ${p} 落在调用方追加的围栏 ${deniedHit} 之内 → 拒绝（单独点名，不与 §16 🔴 混写）`)
  }
  const forbiddenHit = isForbiddenPath(p, forbidden.roots)
  if (forbiddenHit !== null) {
    return push('root-forbidden', `authorizedRoot ${p} 命中 §16 🔴 禁止路径 ${forbiddenHit} → 整批拒绝`)
  }
  const roHit = isForbiddenPath(p, reportOnly.roots)
  if (roHit !== null) {
    return push('root-report-only', `authorizedRoot ${p} 落在只上报根 ${roHit} 之内 → 回收站这类目录只许报告占用，整批拒绝（§16 🔴）`)
  }
  const all = [...forbidden.roots, ...deny.roots, ...reportOnly.roots]
  const swept = all.find((f) => pathIsUnder(f, p) && normalizeKey(f) !== normalizeKey(p))
  if (swept !== undefined) {
    return push('root-ancestor-of-forbidden', `authorizedRoot ${p} 套住了禁止/只上报路径 ${swept}，宽容器一律不认（§28 原则四）`)
  }

  // probe 关：Rust 用注入 probe 保持这一层纯函数；TS 侧用 fixture 指定的 kind 模拟。
  switch (probe) {
    case 'ReparsePoint':
      return push('root-is-reparse-point', `authorizedRoot ${p} 本身是重解析点 → 跟随它等于把授权根搬到别处`)
    case 'NotADirectory':
      return push('root-not-a-directory', `authorizedRoot ${p} 存在但不是目录`)
    case 'Missing':
      return push('root-missing', `authorizedRoot ${p} 不存在（ENOENT）→ 零删除`)
    case 'Unstatable':
      return push('root-unstatable', `authorizedRoot ${p} 读不到属性 → 无法证明安全性，零删除`)
    case 'Directory':
    default:
      return null
  }
}

/* ------------------------------------------------------------------ *
 * classifyPath（executor.ts:310-342 第一道闸，对标 Rust classify_path）
 *
 * 范围说明：本函数只处理单路径第一道闸（形状 → 等于授权根 → 越界 forbidden/report-only → out-of-scope）。
 * `denyRoots` 不在这里处理：Rust `classify_path` 签名不收 deny，TS 执行器对 deny 的处理在 blocker 阶段
 * 与授权根内第二道闸； fixture 如需覆盖 deny 应在 blockerCases 里测 `root-denied-by-caller`。
 * ------------------------------------------------------------------ */

function classifyPath(path, authorizedRoot, forbidden, reportOnly) {
  const refuse = (reason, detail, bytes = 0, overlapOf = null) => ({
    path,
    reason,
    detail,
    bytes,
    overlapOf
  })

  const p = path.trim()
  if (p === '') return refuse('malformed-path', '路径必须是非空字符串 → 这条不处理')
  const shape = pathShapeProblem(p)
  if (shape !== null) {
    return refuse('parent-traversal', `${shape} → 拒绝，且**不做二次 normalize 后放行**（§28 原则四）`)
  }
  const rootKey = normalizeKey(authorizedRoot)
  const key = normalizeKey(p)
  if (key === rootKey) {
    return refuse('equals-authorized-root', '请求删除授权根本身 = 无上限的删除范围，一律拒绝（§28 原则四）')
  }
  const forbiddenHit = isForbiddenPath(p, forbidden.roots)
  if (forbiddenHit !== null && !isStrictlyInside(key, rootKey)) {
    return refuse('forbidden-root', `命中 §16 🔴 禁止路径 ${forbiddenHit}（且不在授权根 ${authorizedRoot} 内）→ 拒绝`)
  }
  const roHit = isForbiddenPath(p, reportOnly.roots)
  if (roHit !== null && !isStrictlyInside(key, rootKey)) {
    return refuse('report-only-root', `命中只上报根 ${roHit}（且不在授权根 ${authorizedRoot} 内）→ 拒绝`)
  }
  if (!isStrictlyInside(key, rootKey)) {
    return refuse('out-of-scope', `不在授权根 ${authorizedRoot} 之内 → 拒绝（§28 原则四：清理范围必须明确）`)
  }
  return null
}

/* ------------------------------------------------------------------ *
 * 主循环
 * ------------------------------------------------------------------ */

const env = fx.env
const forbidden = resolveForbidden(fx.forbiddenPatterns, env)
const reportOnly = resolveForbidden(fx.reportOnlyPatterns, env)

const out = {
  blockerCases: {},
  refusalCases: {}
}

for (const c of fx.blockerCases) {
  const deny = resolveForbidden(c.denyRoots ?? [], env)
  const f = c.forbiddenPatterns ? resolveForbidden(c.forbiddenPatterns, env) : forbidden
  const r = c.reportOnlyPatterns ? resolveForbidden(c.reportOnlyPatterns, env) : reportOnly
  const guard = guardAuthorizedRoot(c.root, f, deny, r, c.probe ?? 'Directory')
  out.blockerCases[c.id] = { blockers: guard ?? [] }
}

for (const c of fx.refusalCases) {
  const f = c.forbiddenPatterns ? resolveForbidden(c.forbiddenPatterns, env) : forbidden
  const r = c.reportOnlyPatterns ? resolveForbidden(c.reportOnlyPatterns, env) : reportOnly
  const refusal = classifyPath(c.path, c.authorizedRoot, f, r)
  out.refusalCases[c.id] = { refusals: refusal ? [refusal] : [] }
}

process.stdout.write(JSON.stringify(out))
