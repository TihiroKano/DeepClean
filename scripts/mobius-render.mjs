// 莫比乌斯环的放大截图（2026-10-27）。
//
// 为什么要单独一张：46 px 的环在整页截图里只占几十个像素，
// **看不出它是一条扭了半圈的带子还是一根歪掉的圆环** —— 而那正是这个组件唯一的要求。
// 这里把同一个组件放大到 260 px、深色底，用 Edge 无头截三帧（初始 / 转 90° / 转 180°）。
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const OUTDIR = join(process.cwd(), 'node_modules', '.settings-shots')
mkdirSync(OUTDIR, { recursive: true })
const abs = (p) => JSON.stringify(join(process.cwd(), p).replace(/\\/g, '/'))

const entry = join(OUTDIR, 'mobius-entry.tsx')
writeFileSync(
  entry,
  `
import { renderToStaticMarkup } from 'react-dom/server'
import { MobiusSpinner } from ${abs('src/renderer/components/MobiusSpinner.tsx')}

export function render({ size, deg }) {
  const html = renderToStaticMarkup(<MobiusSpinner size={size} label="莫比乌斯环" />)
  // 把动画停在某个角度上拍静态帧：无头截图不保证逮到动画中间态，
  // 而"它到底是不是一条扭了半圈的带子"必须从三个角度都看得见。
  return html.replace('<g class="dc-mobius-ring">', '<g class="dc-mobius-ring" style="animation:none;transform:rotate(' + deg + 'deg)">')
}
`
)

const bundle = join(OUTDIR, 'mobius-bundle.mjs')
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

// 环的 CSS 从 global.css 里抠出来（不手抄 —— 手抄就验不到产品里那几条）
const cssFile = join(process.cwd(), 'src/renderer/styles/global.css')
const allCss = (await import('node:fs')).readFileSync(cssFile, 'utf8')
/**
 * 抠一条规则。**剥掉块内注释**：`global.css` 里 `.dc-mobius-face` 那条带一段很长的
 * `/* … *\/` 说明，直接用 `/\.dc-mobius-face \{[\s\S]*?\n\}/` 匹配时，
 * 非贪婪会在注释里的第一个 `}` 处收口 —— 于是抠出来的规则**只有注释、没有声明**，
 * 截图里那一片就是继承来的黑色。
 *
 * 2026-10-27 踩过这一次：48 片全黑，而 `opacity` 属性个个都对。
 */
const pick = (re) => {
  const m = re.exec(allCss)
  if (!m) throw new Error('从 global.css 里抠不到那条规则：' + re)
  return m[0].replace(/\/\*[\s\S]*?\*\//g, '')
}
const mobiusCss = [
  pick(/\.dc-mobius \{[\s\S]*?\n\}/),
  pick(/\.dc-mobius-svg \{[\s\S]*?\n\}/),
  pick(/\.dc-mobius-ring \{[\s\S]*?\n\}/),
  pick(/\.dc-mobius-body \{[\s\S]*?\n\}/),
  pick(/\.dc-mobius-seam \{[\s\S]*?\n\}/),
  pick(/\.dc-mobius-label \{[\s\S]*?\n\}/)
].join('\n')

// 抠出来的每一条都必须真的带声明（否则上面那条"被注释吃掉"的坑会静默复发）
for (const name of ['body', 'seam', 'ring', 'label']) {
  const block = new RegExp(`\\.dc-mobius-${name}\\s*\\{([^}]*)\\}`).exec(mobiusCss)
  if (!block || block[1].trim() === '') {
    throw new Error(`抠出来的 .dc-mobius-${name} 没有声明 —— 多半又被块内注释吃掉了`)
  }
}

const page = (body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  :root { --accent: #4d8ff5; --accent-2: #6fb0ff; --fg-dim: #a9bdd8; }
  body { margin: 0; background: #0b1b36; display: grid; place-items: center; height: 100vh; }
  ${mobiusCss}
</style></head><body>${body}</body></html>`

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
if (!existsSync(EDGE)) throw new Error('找不到 Edge')

const shots = {}
for (const deg of [0, 90, 180]) {
  const name = `mobius-${deg}`
  writeFileSync(join(OUTDIR, name + '.html'), page(mod.render({ size: 260, deg })))
  const png = join(OUTDIR, name + '.png')
  execFileSync(EDGE, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=420,420', `--screenshot=${png}`, pathToFileURL(join(OUTDIR, name + '.html')).href], { stdio: 'pipe', timeout: 90000 })
  shots[name] = png
}
console.log('SHOTS ' + JSON.stringify(shots))
console.log('MOBIUS_RENDER_OK')
