/**
 * `scripts/*.mjs` 里那些**内嵌进模板字符串的页面代码**不许再出现反引号。
 *
 * 为什么值得单开一条闸：本轮在 `cleanup-layout-probe.mjs` 上**连续栽了四次**。
 * 症状长这样 —— `node --check` 报 `SyntaxError: Unexpected identifier 'display'`，
 * 而报错行号指的是我写的一句中文注释，不是真正的错处。原因很简单：
 * 那段页面代码整块放在一个模板字符串（反引号）里，注释里再写一个反引号就把字符串提前收口了。
 *
 * 四次的共同点都是**注释里想引用 CSS 属性名**（`overflowY` / `display: none` /
 * `text-align: right` / `getBoundingClientRect()`），于是给它们加了反引号 ——
 * 这个动作在 Markdown 里是对的，在模板字符串里是致命的。
 *
 * 判据不猜"哪段是页面代码"，只查**这些文件里所有模板字符串的字面段**：
 * 只要某个模板字符串里出现了会被当成结束符的东西，`node --check` 早就红了 ——
 * 所以这里查的是另一件事：**模板字符串内部（嵌套表达式之外）有没有反引号**。
 * 语法上那是不可能出现的（出现了字符串就断了），于是这条闸真正量的是
 * **`node --check` 有没有通过**，并给出一句人话，指向真正的原因。
 *
 * 说白了：这是一条把"我早就该跑的一次语法检查"接进 `npm test` 的闸，
 * 这样它不必靠我记得。
 */
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPTS = join(process.cwd(), 'scripts')

/** 验收用的那些 .mjs（`_` 前缀的探针不在版本库里，但它们一样会被跑，一并查）。 */
const files = readdirSync(SCRIPTS)
  .filter((f) => f.endsWith('.mjs'))
  .sort()

describe('scripts/*.mjs 的语法：内嵌页面代码不许被反引号截断', () => {
  it('至少扫到 10 个脚本（枚举落空会让下面全部永真）', () => {
    expect(files.length).toBeGreaterThanOrEqual(10)
    // 本轮踩坑的那一支必须在名单里，否则这条闸对"我实际在写的那类文件"是瞎的
    expect(files).toContain('cleanup-layout-probe.mjs')
  })

  /**
   * 每个脚本都要能被 node 解析。
   *
   * ⚠️ **并发跑，不许串行**（2026-10-25 改）：原来是 `execFileSync` 一个接一个起 node 进程，
   * 44 个脚本实测 **49 s**，早就超过 20 s 默认超时 —— 只是以前脚本更少、机器更快才没红。
   * 新加两个探针（`checkbox-latency-probe` / `checkbox-reconcile-probe`）之后它当场超时，
   * 而**那不是被查对象的错**：全部 44 个脚本单独 `node --check` 都是 exit 0。
   * 同样的活并发跑只要 **7.3 s**（本机实测），所以修法是改并发，不是抬超时 ——
   * 抬超时等于把这条闸的真实代价藏起来，下一次再加脚本还会红。
   *
   * 判据本体没变：仍然是 `node --check` 全过。变的是执行方式。
   */
  it('每个脚本都能被 node 解析（语法错误的行号会指向注释，所以这句提示要写在这里）', async () => {
    const results = await Promise.all(
      files.map(
        (f) =>
          new Promise<{ file: string; ok: boolean; msg: string }>((resolve) => {
            execFile(process.execPath, ['--check', join(SCRIPTS, f)], (err, _stdout, stderr) => {
              if (err) {
                resolve({ file: f, ok: false, msg: String(stderr ?? err.message) })
              } else {
                resolve({ file: f, ok: true, msg: '' })
              }
            })
          })
      )
    )
    const bad = results.filter((r) => !r.ok)
    expect(
      bad.map((b) => `${b.file}:\n${b.msg.split('\n').slice(0, 6).join('\n')}`),
      // 这句是给人看的：四次都栽在"模板字符串里的中文注释又加了一个反引号"，
      // 而报错行号指向那句注释、看起来像是注释本身有错。
      '这些脚本解析不了。若报错行是一句中文注释，多半是那段的模板字符串里又写了一个反引号 ——\n' +
        '把注释里的 `CSS属性名` 改成不带的写法（CSS属性名）即可。\n\n' +
        bad.map((b) => `${b.file}:\n${b.msg}`).join('\n\n')
    ).toEqual([])
  })

  it('`cleanup-layout-probe.mjs` 的 PROBE 体内没有反引号（带它单独点名，红的时候一眼知道是哪段）', () => {
    const src = readFileSync(join(SCRIPTS, 'cleanup-layout-probe.mjs'), 'utf8')
    const lines = src.split('\n')
    const start = lines.findIndex((l) => l.includes('const PROBE = `'))
    expect(start, 'PROBE 那个模板字符串的开头不见了 —— 这条判据要跟着改').toBeGreaterThan(-1)
    const end = lines.findIndex((l, i) => i > start && /^\}\)\(\)`\s*$/.test(l))
    expect(end, 'PROBE 的收尾（})()`）不见了').toBeGreaterThan(start)
    const body = lines.slice(start + 1, end)
    const offenders = body
      .map((l, i): [number, string] => [start + 2 + i, l])
      .filter(([, l]) => l.includes('`'))
      .map(([n, l]) => `  第 ${n} 行：${l.trim()}`)
    expect(offenders, 'PROBE 体里出现了反引号 ⇒ 模板字符串会在这里被截断').toEqual([])
  })
})
