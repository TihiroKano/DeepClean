// 三处文案的**离屏渲染**验收（2026-10-27）。
//
// 为什么不走真机 CDP：人类伙伴当时正开着 DeepClean 窗口（PID 9340，
// `MainWindowTitle: DeepClean`），而 WebView2 的用户数据目录是**单实例**的 ——
// 再起一个进程会报 `0x8007139F`（组或资源的状态不是执行请求操作的正确状态）。
// 那是"不能关用户正在用的窗口"这条纪律，不是产品缺陷。
//
// 所以这一格换一个独立口径：`renderToStaticMarkup` 渲染**产品自己的组件**
// （`CleanupEmptyState` / `JournalEmpty` / `JournalRetentionNote`），
// 配上产品自己的 `global.css` / `tokens.css`，用 Edge 无头截。
// ⚠️ 不许在这里"抄一份 JSX"—— 那验的是我抄的那份，不是产品。
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const OUTDIR = arg('outdir', join(process.cwd(), 'node_modules', '.wording-shots'))
mkdirSync(OUTDIR, { recursive: true })

// esbuild 的 `import` 只认路径、不认 `file://` URL；把仓库绝对路径正斜杠化即可
const absImport = (p) => JSON.stringify(join(process.cwd(), p).replace(/\\/g, '/'))

// ---- ① 入口只 import 产品组件，不自己写 JSX ----
const entry = join(OUTDIR, 'entry.tsx')
writeFileSync(
  entry,
  `
import { renderToStaticMarkup } from 'react-dom/server'
import { CleanupEmptyState } from ${absImport('src/renderer/pages/Cleanup.tsx')}
import { JournalEmpty, JournalRetentionNote } from ${absImport('src/renderer/pages/CleanHistory.tsx')}

export function renderCleanupEmpty(): string {
  return renderToStaticMarkup(<CleanupEmptyState />)
}

export function renderJournalEmpty(): string {
  return renderToStaticMarkup(
    <div className="dc-clean">
      <h2 className="dc-page-title">清理日志</h2>
      <JournalEmpty />
      <JournalRetentionNote />
    </div>
  )
}

export function renderJournalRuns(): string {
  return renderToStaticMarkup(
    <div className="dc-clean">
      <h2 className="dc-page-title">清理日志</h2>
      <ul className="dc-journal-list">
        <li className="dc-journal-row">
          <span className="dc-journal-row-when">2026年10月25日 15:30</span>
          <span className="dc-journal-row-body">
            在 <b className="dc-mono">C:\\\\ 与 D:\\\\</b> 清理 <b className="dc-mono">750.9 MB</b> 文件
            <span className="dc-muted dc-fineprint"> · 17,143 个</span>
          </span>
          <button className="dc-btn dc-btn-xs dc-journal-row-detail">详情</button>
        </li>
      </ul>
      <JournalRetentionNote />
    </div>
  )
}
`
)

const bundle = join(OUTDIR, 'bundle.mjs')
await build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent'
})

const mod = await import(pathToFileURL(bundle).href)

// ---- ② 配产品自己的样式 ----
const css = readFileSync(join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8')
const tokens = readFileSync(join(process.cwd(), 'src/renderer/styles/glass/tokens.css'), 'utf8')

const page = (body, title) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>${tokens}</style>
<style>${css}</style>
<style>
  /* 截图要看得清字，不复刻窗口 chrome。宽度取 1100 避开产品里的窄窗断点。 */
  html, body { margin: 0; padding: 0; background: #0b1b36; }
  body { width: 1100px; padding: 24px 28px; box-sizing: border-box; }
  .dc-page-title { color: #eaf2ff; }
</style>
</head><body>${body}</body></html>`

const cases = {
  'cleanup-empty': [mod.renderCleanupEmpty(), '清理页空状态'],
  'journal-empty': [mod.renderJournalEmpty(), '清理日志空态'],
  'journal-runs': [mod.renderJournalRuns(), '清理日志有数据']
}
for (const [name, [body, title]] of Object.entries(cases)) {
  writeFileSync(join(OUTDIR, name + '.html'), page(body, title))
}

// ---- ③ Edge 无头截图 ----
const EDGE = arg('edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
if (!existsSync(EDGE)) throw new Error('找不到 Edge：' + EDGE)
const shots = {}
for (const name of Object.keys(cases)) {
  const png = join(OUTDIR, name + '.png')
  execFileSync(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1150,340',
      `--screenshot=${png}`,
      pathToFileURL(join(OUTDIR, name + '.html')).href
    ],
    { stdio: 'pipe', timeout: 90000 }
  )
  shots[name] = png
}

// ---- ④ 判据：渲染出来的**文本**（不是源码字面量） ----
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const cleanupText = text(cases['cleanup-empty'][0])
const journalRunsText = text(cases['journal-runs'][0])

const wantCleanup = '暂未进行扫描，请先前往首页执行扫描。'
const wantAdmin = '本程序已使用管理员权限。删除后无法找回；部分被占用的文件无法删除属于正常现象。'
const wantNote = '日志仅保留 30 天，过期自动删除。'

if (!cleanupText.includes(wantCleanup)) throw new Error('清理页空状态缺新第一句：' + cleanupText)
if (!cleanupText.includes(wantAdmin)) throw new Error('清理页空状态缺新第二句：' + cleanupText)
if (cleanupText.includes('还没有扫描会话')) throw new Error('旧第一句还在：' + cleanupText)
if (cleanupText.includes('已以管理员身份运行')) throw new Error('旧第二句还在：' + cleanupText)
if (!journalRunsText.includes(wantNote)) throw new Error('清理日志下方缺保留提示：' + journalRunsText)

console.log('CLEANUP_TEXT ' + JSON.stringify(cleanupText))
console.log('JOURNAL_TEXT ' + JSON.stringify(journalRunsText))
console.log('SHOTS ' + JSON.stringify(shots))
console.log('WORDING_RENDER_OK')
