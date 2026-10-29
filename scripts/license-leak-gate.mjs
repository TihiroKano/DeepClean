#!/usr/bin/env node
// 发布前判据：**明文激活码不许以任何文本形态进版本库**。
//
// 为什么需要它（不是"再加一道保险"）：2026-10-11 一天里同一条边界被踩了两次，两次都在
// **没人想到的那面**：① 真机验收脚本把 typed 的真码留在输入框里，被 `CopyFromScreen` 拍进
// `docs/acceptance/assets/*.png`；② 写这一节更正的人（我）把整串真码当字面量抄进了验收文档。
// 两条都不是"忘了规则"，而是**规则的覆盖面**只写了 stdout。所以这里把覆盖面换成"仓库里所有文本"。
//
// ## 判据为什么是「哈希在不在表里」而不是「形状对不对」
//
// 形状 `DC-[0-9A-F]{32}` 在仓库里**合法地存在**：`LicenseCard.tsx` 的占位符就是这一形制
// （`DC-0123456789ABCDEF0123456789ABCDEF`，一条刻意编出来的示例码）。按形状一刀切会让这条闸
// 一上线就红在自己的正例上，然后被人加豁免、再然后就不看了。
// 真正的泄密定义是：**这个串归一化后的 SHA-256 在随应用交付的那份清单里** —— 那才是一个能用它激活的码。
//
// 顺带这条判据自带**正对照**：占位符那一处形状命中必须 ≥1，否则说明扫描器根本没在读文件
// （路径写错、编码吃掉、`git ls-files` 空返回都是这种静默失败）。所以输出里两个数都要看：
//   shapeMatches 必须 > 0（扫描器活着），inTable 必须 == 0（没泄密）。
//
// ## 它量不到的那一维
//
// **像素**。PNG 里的字是渲染出来的，不是文本，这条闸看不见 —— 那一面靠
// `scripts/m4-delivery-e2e.ps1` 的 `Clear-Code`（截图前证明输入框为空）+ 人眼过一遍图。
// 两维各自有闸，别拿这条去背书截图。
//
// 用法：node scripts/license-leak-gate.mjs   （exit 0 = 干净；exit 1 = 有真码以文本形态进仓）

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const MANIFEST = 'src-tauri/resources/codes.sha256'
const SHAPE = /DC-[0-9A-F]{32}/g

/** 与 Rust `normalize_code` 逐字一致：只去首尾 ASCII 空白 + 只大写 ASCII 字母。 */
const normalize = (s) => s.replace(/^[\t\n\v\f\r ]+/, '').replace(/[\t\n\v\f\r ]+$/, '').replace(/[a-z]/g, (c) => c.toUpperCase())
const sha256Hex = (s) => createHash('sha256').update(Buffer.from(normalize(s), 'utf8')).digest('hex')

const manifest = readFileSync(resolve(REPO, MANIFEST), 'utf8')
const table = new Set(manifest.split(/\r?\n/).filter((l) => /^[0-9a-f]{64}$/.test(l.trim())).map((l) => l.trim()))
if (table.size !== 1000) {
  console.error(`清单 ${MANIFEST} 里只解析出 ${table.size} 个哈希（应为 1000）—— 判据的输入就是坏的，先修那个`)
  process.exit(2)
}

// 跟踪的 + 未跟踪且未被忽略的：只扫 `git ls-files` 会漏掉"正要 add 进去"的那批，
// 而那恰好是唯一还来得及拦的一批。
const listed = execFileSync('git', ['ls-files', '-o', '--exclude-standard', '-c', '-z'], { cwd: REPO, encoding: 'utf8' })
const files = listed.split('\0').filter(Boolean)
const fileSet = new Set(files)
// **覆盖面判据不用"文件数够不够大"这种直觉**（363 个文件是本仓的真实规模，写 500 会让这条
// 闸一上线就红在自己的算术上）。改成点名：这几处**必须**在扫描集合里，少一个就是范围漏了。
const CANARIES = [
  MANIFEST,
  'src/renderer/components/LicenseCard.tsx', // 占位符 = 正对照的落点
  'src-tauri/crates/license/tests/data/codes.fixture.txt',
  'scripts/license-leak-gate.mjs',
]
for (const c of CANARIES) {
  if (!fileSet.has(c)) {
    console.error(`FAIL: 扫描集合里没有 ${c}（共 ${files.length} 个文件）—— 范围不对，这条判据没有归因力`)
    process.exit(2)
  }
}

let shapeMatches = 0
let placeholderHits = 0
const leaks = []
const unreadable = []
// `git ls-files -c` 会连**工作树里已经删掉、只是还没 commit** 的文件一起列出来（重建前端产物
// 之后旧哈希名的 bundle 就是这种）。它不是"读不了"，是"已经不在了"，混在一起会让这条闸在
// 每次改完 UI 之后都红一次假警报。分开点名。
const gone = files.filter((p) => !existsSync(resolve(REPO, p)))
const present = files.filter((p) => existsSync(resolve(REPO, p)))
for (const rel of present) {
  let text
  try {
    text = readFileSync(resolve(REPO, rel))
  } catch {
    unreadable.push(rel) // **点名**而不是只计数：一个读不了的文件就是一条能让真码藏过去的缝
    continue
  }
  // 二进制按字节找形状串：明文码是 ASCII，不需要解码成字符串，也免得整文件 toString 撑爆内存
  const s = text.toString('latin1')
  for (const m of s.matchAll(SHAPE)) {
    shapeMatches += 1
    if (rel === 'src/renderer/components/LicenseCard.tsx') placeholderHits += 1
    if (table.has(sha256Hex(m[0]))) leaks.push(`${rel}:${m.index ?? 0}  ${m[0].slice(0, 9)}…${m[0].slice(-5)}`)
  }
}

console.log(`扫描 ${present.length} 个文件（索引里另有 ${gone.length} 个已从工作树删除：${gone.join(', ') || '—'}；读不了 ${unreadable.length}${unreadable.length ? '：' + unreadable.join(', ') : ''}）：形状命中 ${shapeMatches}，其中**在表里的** ${leaks.length}`)
// 顺序是**先报泄密**：这条闸存在的唯一理由就是把真码的位置指出来，任何前置检查都不许把它挡在后面。
if (leaks.length > 0) {
  console.error('FAIL: 下面这些是**能激活的真码**，以文本形态出现在仓库里（上面已掩码，原文请就地删掉，别改判据）：')
  for (const l of leaks) console.error('  ' + l)
  process.exit(1)
}
if (shapeMatches === 0 || placeholderHits === 0) {
  console.error(`FAIL: 形状命中 ${shapeMatches}（其中 LicenseCard 占位符 ${placeholderHits}）—— 占位符本身就是一条合法命中，` +
    '为 0 说明扫描器没在读到东西。这是判据自己坏了，不是"真干净"')
  process.exit(1)
}
// 读不了的东西**默认放行是错的**：那正是能让一条真码藏过去的缝。文本形制的读不了 = 直接失败；
// 二进制（图标 / exe）读不了只点名，因为这一维本来就不归这条闸管（见顶部"量不到的那一维"）。
const TEXTY = /\.(md|markdown|ts|tsx|js|mjs|cjs|rs|json|txt|ps1|sh|html|css|toml|lock|yml|yaml|editorconfig|gitignore)$/i
const blindText = unreadable.filter((p) => TEXTY.test(p))
if (blindText.length > 0) {
  console.error('FAIL: 这些**文本**文件读不了，扫描对它们是瞎的，不能算通过：')
  for (const p of blindText) console.error('  ' + p)
  process.exit(2)
}
console.log('OK: 没有任何一条真码以文本形态进仓；形状命中全部来自表外的示例/夹具串')
