#!/usr/bin/env node
// DeepClean 激活码 → SHA-256 哈希清单生成器。
//
// 为什么需要它：规格书说的是「预生成 1000 个激活码，只存 SHA-256 哈希表」。**应用只装载哈希清单、
// 从不接触明文码**，所以这里把「明文码 → 哈希清单」这条转换固定下来。
//
// ## 2026-10-11 已经跑过一次，那一跑就是交付的那份（别重跑）
//
//   # 在仓库根目录下跑（当时就是这一条）
//   node src-tauri/crates/license/tools/gen-license-codes.mjs --generate 1000 --prefix DC- \
//     --codes-out D:/dc-license-vault/codes-2026-10-11-1000.txt \
//     --out src-tauri/resources/codes.sha256
//
// 明文清单在仓库外（发用户用的那份；`.gitignore` 里 `codes-*` 挡它进仓），哈希清单是
// `src-tauri/resources/codes.sha256`，由壳层 `license_table.rs` 内嵌进二进制、首启落到授权目录。
//
// ⚠️ **`--generate` 是一次性动作**：它用随机数现造码，重跑得到的是**另一份毫不相干**的表，
// 拿新表发包会让所有已按旧表激活的用户变成 `code-not-in-table`（离线没有服务器能把旧码补进去）。
// 要往表里**加**码走 `--from`（把新码并进旧明文清单后整表重生成，旧哈希一个不变）；
// 想**撤销**某个码则没有离线办法 —— 这是「完全离线」的既定代价，写在 `activate.rs` 顶部。
//
// ## 归一化契约（必须与 Rust 侧 `code_table::normalize_code` 逐字一致）
//   1. 去掉**首尾 ASCII 空白**（\t \n \v \f \r 空格）；
//   2. 只把 **ASCII 字母**转大写；
//   3. 对结果的 UTF-8 字节做 SHA-256，输出 64 位小写十六进制。
// **不折叠中间的空格/连字符** —— 折了会把两个不同的码映射成同一个哈希（等于悄悄扩大授权）。
// Rust 侧有一条交叉对账落盘测试（`lib.rs::fixture_manifest_agrees_with_rust_normalization`）
// 会读本脚本产出的夹具清单 + 夹具明文码重算一遍；两侧归一化一旦分叉，那条测试立刻红。
//
// 用法：
//   # 由已有明文码清单生成哈希清单（交付用；明文码清单由持有真码的人提供）
//   node gen-license-codes.mjs --from <codes.txt> --out <codes.sha256>
//
//   # 生成 N 个随机码：一份明文清单（发给用户）+ 一份哈希清单（随应用交付）
//   node gen-license-codes.mjs --generate <N> --prefix DC- --codes-out <codes.txt> --out <codes.sha256>
//
// 明文清单格式：一行一个码，`#` 开头为注释，空行忽略。

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

/** 与 Rust `normalize_code` 逐字一致：只去首尾 ASCII 空白 + 只大写 ASCII 字母。 */
function normalizeCode(s) {
  const trimmed = s.replace(/^[\t\n\v\f\r ]+/, '').replace(/[\t\n\v\f\r ]+$/, '')
  return trimmed.replace(/[a-z]/g, (c) => c.toUpperCase())
}

const sha256Hex = (s) => createHash('sha256').update(Buffer.from(normalizeCode(s), 'utf8')).digest('hex')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
      out[key] = val
    }
  }
  return out
}

function readCodes(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const codes = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    codes.push(line)
  }
  return codes
}

/** 计算哈希并检查重号（两个不同明文归一化后相同 ⇒ 拒绝，与 Rust `from_codes` 同一判据）。 */
function hashAll(codes) {
  const seen = new Map()
  const hashes = []
  for (let i = 0; i < codes.length; i++) {
    const h = sha256Hex(codes[i])
    if (seen.has(h)) {
      throw new Error(`第 ${i + 1} 行与第 ${seen.get(h) + 1} 行的码归一化后相同（哈希重号）：${codes[i]}`)
    }
    seen.set(h, i)
    hashes.push(h)
  }
  return hashes
}

function writeManifest(path, hashes, note) {
  const body = [`# DeepClean 激活码哈希清单（SHA-256，一行一个）`, `# ${note}`, ...hashes, ''].join('\n')
  writeFileSync(path, body, 'utf8')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.from && args.out) {
    const codes = readCodes(args.from)
    const hashes = hashAll(codes)
    writeManifest(args.out, hashes, `由 ${args.from} 生成（共 ${codes.length} 个码；明文码不在清单里）`)
    console.log(`写清单 ${args.out}：${hashes.length} 个哈希`)
    return
  }
  if (args.generate && args.out) {
    const n = Number.parseInt(args.generate, 10)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--generate 需要一个正整数，实得 ${args.generate}`)
    const prefix = args.prefix || 'DC-'
    const codes = []
    const used = new Set()
    // 24 字节熵 → 32 位十六进制；足够避免碰撞，也让码不可猜。
    while (codes.length < n) {
      const c = prefix + randomBytes(16).toString('hex').toUpperCase()
      if (!used.has(c)) {
        used.add(c)
        codes.push(c)
      }
    }
    const hashes = hashAll(codes)
    if (args['codes-out']) {
      writeFileSync(
        args['codes-out'],
        [`# DeepClean 明文激活码（${n} 个）—— 发给用户用的那份，务必保密、别进版本库`, ...codes, ''].join('\n'),
        'utf8',
      )
      console.log(`写明文码 ${args['codes-out']}：${n} 个（**不要提交进版本库**）`)
    }
    writeManifest(args.out, hashes, `随机生成 ${n} 个码（前缀 ${prefix}）`)
    console.log(`写清单 ${args.out}：${hashes.length} 个哈希`)
    return
  }
  console.error(
    '用法：\n' +
      '  node gen-license-codes.mjs --from <codes.txt> --out <codes.sha256>\n' +
      '  node gen-license-codes.mjs --generate <N> [--prefix DC-] [--codes-out <codes.txt>] --out <codes.sha256>',
  )
  process.exit(2)
}

main()
