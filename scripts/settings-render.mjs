// 设置页的离屏渲染截图（2026-10-27）。
//
// 为什么不走真机 CDP：见 `wording-render.mjs` 文件头 —— WebView2 的用户数据目录是单实例的，
// 人类伙伴开着窗口时再起一个进程会报 `0x8007139F`。
//
// 这条渲染的是**产品自己的组件**（`LicensePanel` / `LicenseBusy` / `GLASS_SLIDERS`），
// 配上产品自己的 `global.css` / `tokens.css`，用 Edge 无头截。
// ⚠️ 不许"抄一份 JSX"—— 那验的是我抄的那份，不是产品。
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i > -1 ? argv[i + 1] : d
}
const OUTDIR = arg('outdir', join(process.cwd(), 'node_modules', '.settings-shots'))
mkdirSync(OUTDIR, { recursive: true })
const abs = (p) => JSON.stringify(join(process.cwd(), p).replace(/\\/g, '/'))

const entry = join(OUTDIR, 'entry.tsx')
writeFileSync(
  entry,
  `
import { renderToStaticMarkup } from 'react-dom/server'
import { LicensePanel } from ${abs('src/renderer/components/LicenseCard.tsx')}
import { LicenseBusy } from ${abs('src/renderer/components/LicenseBusy.tsx')}
import { GLASS_SLIDERS, wallpaperLabel } from ${abs('src/renderer/pages/Settings.tsx')}
import { DEFAULT_SETTINGS } from ${abs('shared/settings.ts')}

const status = (over) => ({ state: 'unlicensed', activatedAtMs: null, deviceId: null, problemReason: null, problem: null, ...over })
const ready = (over, extra) => ({ kind: 'ready', status: status(over), error: null, busy: false, lastActivation: null, ...(extra || {}) })

function slider(spec, v) {
  return (
    <div className="dc-settings-row">
      <div className="dc-settings-row-head">
        <label className="dc-settings-row-label">{spec.label}</label>
        <span className="dc-settings-row-value dc-mono">{spec.format(v)}</span>
      </div>
      <input className="dc-slider" type="range" min={spec.min} max={spec.max} step={spec.step} defaultValue={v} />
      <p className="dc-fineprint dc-muted">{spec.hint}</p>
    </div>
  )
}

// 三块竖排卡片（与 Settings.tsx 的 JSX 顺序一致）
export function renderSettings({ busy, licensed }) {
  const s = DEFAULT_SETTINGS
  return renderToStaticMarkup(
    <div className="dc-page dc-settings">
      <h2 className="dc-page-title">设置</h2>
      <section className="dc-settings-card">
        <h3 className="dc-settings-card-title">外观</h3>
        <div className="dc-settings-row">
          <div className="dc-settings-row-head">
            <span className="dc-settings-row-label">背景壁纸</span>
            <span className="dc-settings-row-value dc-mono">{wallpaperLabel(s.wallpaper)}</span>
          </div>
          <p className="dc-fineprint dc-muted">
            选一张本地图片（png / jpg / jpeg / webp / bmp）。选中之后会复制进本程序的数据目录，原文件删掉也不影响。
          </p>
          <div className="dc-actions">
            <button className="dc-btn" type="button">选择图片…</button>
            <button className="dc-btn" type="button" disabled>恢复默认壁纸</button>
          </div>
        </div>
        <hr className="dc-settings-sep" />
        <p className="dc-muted dc-fineprint">毛玻璃四格。改一下立刻生效 —— 它们直接落成 CSS 变量，不重启、不刷新。</p>
        {GLASS_SLIDERS.map((spec) => (
          <div className="dc-settings-row" key={spec.key}>
            <div className="dc-settings-row-head">
              <label className="dc-settings-row-label">{spec.label}</label>
              <span className="dc-settings-row-value dc-mono">{spec.format(s[spec.key])}</span>
            </div>
            <input className="dc-slider" type="range" min={spec.min} max={spec.max} step={spec.step} defaultValue={s[spec.key]} />
            <p className="dc-fineprint dc-muted">{spec.hint}</p>
          </div>
        ))}
        <button className="dc-btn dc-btn-xs" type="button">恢复外观默认</button>
      </section>
      <LicensePanel
        state={ready(licensed ? { state: 'licensed', activatedAtMs: 1, deviceId: 'aabbccddee' } : {}, { busy })}
        code={busy ? 'DC-0123456789ABCDEF0123456789ABCDEF' : ''}
        onCode={() => {}}
        onActivate={() => {}}
      />
      <section className="dc-settings-card">
        <h3 className="dc-settings-card-title">关于</h3>
        <p className="dc-fineprint dc-muted">DeepClean 版本：<code className="dc-mono">1.0.0</code></p>
        <p className="dc-fineprint dc-muted">扫描 ≠ 删除。这一页不改任何文件，也不清理任何东西。</p>
      </section>
    </div>
  )
}

export function renderBusyOnly() {
  return renderToStaticMarkup(<LicenseBusy label="正在校验激活码…" />)
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
  loader: { '.jpg': 'dataurl', '.png': 'dataurl' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent'
})

const mod = await import(pathToFileURL(bundle).href)

const css = readFileSync(join(process.cwd(), 'src/renderer/styles/global.css'), 'utf8')
const tokens = readFileSync(join(process.cwd(), 'src/renderer/styles/glass/tokens.css'), 'utf8')
const fonts = readFileSync(join(process.cwd(), 'src/renderer/styles/fonts.css'), 'utf8')

// 字体：把 woff2 内联进 CSS（离屏截图没有 dist 目录的相对路径）
const fontsInlined = fonts.replace(/url\(['"]?\.\.\/assets\/fonts\/([^)'"]+)['"]?\)/g, (m, file) => {
  const p = join(process.cwd(), 'src/renderer/assets/fonts', file)
  if (!existsSync(p)) return 'url()'
  const b64 = readFileSync(p).toString('base64')
  return `url(data:font/woff2;base64,${b64})`
})

// 夜山图内联成 data URL（探针产出的 HTML 要能被 Edge 直接打开，不留相对路径依赖）
const mountainB64 = readFileSync(join(process.cwd(), 'src/renderer/assets/mountain-bg.jpg')).toString('base64')
const mountainDataUrl = `data:image/jpeg;base64,${mountainB64}`

const page = (body) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>${fontsInlined}</style>
<style>${tokens}</style>
<style>${css}</style>
<style>
  /* 复刻窗口：内容区 880 宽（1080 窗宽 − 200 侧栏），深蓝底 + 玻璃卡的 backdrop 要有东西可糊 */
  html, body { margin: 0; padding: 0; }
  body {
    width: 940px; box-sizing: border-box; padding: 22px 26px;
    background-color: #081d4a;
    /* 用产品那张真夜山图当底 —— 玻璃是"糊身后"的东西，背景不对就判断不了卡片对不对 */
    background-image: url("${mountainDataUrl}");
    background-size: cover;
    background-position: center;
    background-attachment: fixed;
    color: #f2f6fc;
    font-family: 'DM Sans', 'Microsoft YaHei UI', sans-serif;
  }
  .dc-settings { max-width: 860px; }
  .dc-page-title { font-family: 'DM Serif Display', sans-serif; font-size: 26px; margin: 0 0 18px; }
</style>
</head><body>${body}</body></html>`

const cases = {
  // 未激活那一相（默认）
  settings: mod.renderSettings({ busy: false }),
  // 已激活那一相 —— 人类伙伴要「只保留展示激活和未激活」，两相都得看一眼
  'settings-licensed': mod.renderSettings({ busy: false, licensed: true }),
  // 校验中那一相（莫比乌斯环）
  'settings-busy': mod.renderSettings({ busy: true })
}
for (const [name, body] of Object.entries(cases)) {
  writeFileSync(join(OUTDIR, name + '.html'), page(body))
}

const EDGE = arg('edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
if (!existsSync(EDGE)) throw new Error('找不到 Edge：' + EDGE)
const shots = {}
for (const name of Object.keys(cases)) {
  const png = join(OUTDIR, name + '.png')
  execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=940,1700', `--screenshot=${png}`, pathToFileURL(join(OUTDIR, name + '.html')).href], { stdio: 'pipe', timeout: 90000 })
  shots[name] = png
}

// 判据：渲染出来的文本
const text = (h) => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const t = text(cases.settings)
for (const want of ['设置', '外观', '背景壁纸', '模糊半径', '饱和度', '亮度', '透明度', '授权', '未激活', '需联网激活验证', '关于']) {
  if (!t.includes(want)) throw new Error(`设置页缺「${want}」：${t.slice(0, 300)}`)
}
const lt = text(cases['settings-licensed'])
if (!lt.includes('已激活')) throw new Error('已激活那一相没念出来')
if (lt.includes('未激活')) throw new Error('已激活那一相里冒出了「未激活」')
const bt = text(cases['settings-busy'])
if (!bt.includes('正在校验激活码')) throw new Error('busy 那一相没有校验中那行字')

console.log('SETTINGS_TEXT ' + JSON.stringify(t.slice(0, 260)))
console.log('SHOTS ' + JSON.stringify(shots))
console.log('SETTINGS_RENDER_OK')
