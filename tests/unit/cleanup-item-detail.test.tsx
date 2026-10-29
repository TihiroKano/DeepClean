/**
 * 清理页条目卡改版（2026-10-23）之后的**取数与文案契约**。
 *
 * 人类伙伴这一天给了四条：
 *  ① 每个选项的框大小一致 → 卡片等高（选中"卡片等高"那一档）；
 *  ② 详情内容走最简模式（一段话概况）；
 *  ③ 加「查看详情」，点了出现详情框；
 *  ④ 风险 / 占用等信息居中放置（原来偏上）。
 *  另有一句：页头那句「扫描到的可清理项 · 勾选后计入预估，确认之后才会删」删掉。
 *
 * ①②④ 落在 `Cleanup.tsx` + `global.css` 的形状上（本仓 vitest 是 `node` 环境，
 * 没有布局引擎，钉不住像素），所以这里分两层：
 *  · 纯函数层（`firstSentence` / `itemSummary`）真跑，钉住"截断但不改写"这条口径；
 *  · 源码层（与 `cleanup-layout-contract.test.ts` 同一先例）钉住结构，防止下一次重构把它悄悄拿掉。
 *
 * 为什么不测渲染：`Cleanup` 挂载即发两条 IPC（`usePreview` / `getSettings`），
 * 本仓又没有 jsdom。既有先例都是"把判定抽成导出函数再测"。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { firstSentence, itemSummary } from '../../src/renderer/pages/Cleanup'
import type { PreviewItem } from '../../shared/types'

const item = (over: Partial<PreviewItem> & { ruleId: string }): PreviewItem => ({
  name: over.ruleId,
  description: '',
  category: 'temp',
  riskLevel: 'safe',
  cleanStrategy: 'delete-all',
  recoverable: true,
  selected: true,
  included: true,
  bytes: 100,
  files: 1,
  scope: 'rule',
  paths: [],
  findingBytes: 100,
  findingFiles: 1,
  sampleTruncated: false,
  matchedRoots: [],
  refusal: null,
  ...over
})

/** 剥注释：判据量的是实现，一句写着"已经从列表里挪走了"的注释不该把它喂饱。 */
function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CLEANUP = src('src/renderer/pages/Cleanup.tsx')
const CSS = src('src/renderer/styles/global.css')

describe('① 最简模式：一段话概况核心内容', () => {
  it('取规则那句话的第一句（按「；」切），不是自己编一句', () => {
    expect(firstSentence('当前用户 %TEMP% 及其子目录里的临时文件；安装器、压缩软件留下的中间产物')).toBe(
      '当前用户 %TEMP% 及其子目录里的临时文件'
    )
  })

  it('「。」也当句末：整段没有分号时不许原样吐出一整段', () => {
    expect(firstSentence('第一句。第二句')).toBe('第一句')
  })

  it('只有一句时原样返回（不多切一刀）', () => {
    expect(firstSentence('删掉之后系统会重新生成')).toBe('删掉之后系统会重新生成')
  })

  it('句末标点落在第 0 位时不算句末（否则会返回空串）', () => {
    expect(firstSentence('；开头就是分号的一句话')).toBe('；开头就是分号的一句话')
  })

  it('表外规则的 description 是空串 → 退回已经算出来的事实（几个目录），**不补通用说明**', () => {
    const it0 = item({ ruleId: 'dup:a', description: '', matchedRoots: ['D:\\x', 'D:\\y'] })
    expect(itemSummary(it0)).toBe('2 个目录')
    expect(itemSummary(item({ ruleId: 'dup:b', description: '', matchedRoots: [] }))).toBe('无命中目录')
  })

  it('有文案时优先用文案，不用目录数', () => {
    const it0 = item({ ruleId: 'thumb', description: '资源管理器缩略图数据库；iconcache 不在范围内', matchedRoots: ['C:\\a'] })
    expect(itemSummary(it0)).toBe('资源管理器缩略图数据库')
  })
})

describe('②③ 列表给最简一句话，「查看详情」开详情框', () => {
  it('列表里调的是 `itemSummary`，而不是把整条 description 直接铺进去', () => {
    expect(CLEANUP, '列表那一行没有走最简模式').toMatch(/dc-clean-row-desc[^}]*\{itemSummary\(/)
    // 反面对照：整段 description 不许再出现在列表行里
    expect(CLEANUP, '列表行里还铺着完整 description').not.toMatch(/dc-clean-row-desc">\{i\.description\}/)
  })

  it('每行有「查看详情」，点它把该行 ruleId 交给详情框', () => {
    expect(CLEANUP, '「查看详情」不见了').toContain('查看详情')
    expect(CLEANUP, '点了没有把 ruleId 记下来 ⇒ 框打不开').toMatch(/onClick=\{\(\) => setDetailOf\(i\.ruleId\)\}/)
  })

  it('详情框是按 id 从**当前模型**现取，不是存一份快照', () => {
    // 存快照的坏法：勾选一变模型重算，框里显示的是已经被替换掉的旧读数
    expect(CLEANUP, '详情项不是从 model.items 现取的').toMatch(
      /model\?\.items\.find\(\(i\) => i\.ruleId === detailOf\)/
    )
  })

  it('详情框在 Portal 里，且是 role="dialog" + aria-modal', () => {
    expect(CLEANUP, '详情框还在原地渲染 —— 这页每一块卡都带 backdrop-filter，会被压住').toContain('<Portal>')
    expect(CLEANUP).toMatch(/role="dialog"/)
    expect(CLEANUP).toMatch(/aria-modal="true"/)
  })

  it('关闭出口三条都有：× 按钮、点遮罩、Esc', () => {
    expect(CLEANUP, '× 按钮不见了').toMatch(/aria-label="关闭详情"/)
    expect(CLEANUP, '点遮罩关不掉').toMatch(/dc-modal-mask" onClick=\{onClose\}/)
    expect(CLEANUP, "Esc 关不掉").toMatch(/e\.key === 'Escape'\) onClose\(\)/)
  })

  it('详情框里 description 是空串时**不渲染那一行**（空是事实，不补话）', () => {
    expect(CLEANUP).toMatch(/item\.description !== ''[^]{0,80}dc-clean-detail-desc/)
  })
})

describe('④ 风险 / 占用居中：由行上一处 align-items 负责，不许各格 padding-top 手工描', () => {
  it('`.dc-clean-row` 是 `align-items: center`', () => {
    const rule = /^\.dc-clean-row \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(rule, '找不到 `.dc-clean-row` 那条规则').not.toBeNull()
    expect(rule![1]!, '行内的纵向对齐不是居中').toMatch(/align-items:\s*center/)
    expect(rule![1]!, '还留着 align-items: start（数字会贴在顶上）').not.toMatch(/align-items:\s*start/)
  })

  it('三处曾经用来"补位"的 padding-top / margin-top 都撤掉了', () => {
    // 勾选位、图标砖、风险格各自微调一格像素 —— 那是"看起来居中"的近似做法，改行高就散
    expect(CSS, '勾选位还挂着 padding-top').not.toMatch(/\.dc-clean-check \{[^}]*padding-top/)
    expect(CSS, '图标砖还挂着 margin-top').not.toMatch(/\.dc-clean-row-ic \{[^}]*margin-top/)
    expect(CSS, '数字列还挂着 padding-top').not.toMatch(/\.dc-clean-row-num \{[^}]*padding-top/)
    expect(CSS, '风险格还挂着 padding-top').not.toMatch(/\.dc-clean-row-risk \{[^}]*padding-top/)
  })
})

describe('① 卡片等高：声明在**行容器**上（各行是彼此独立的 grid，只在行内改没用）', () => {
  it('`.dc-clean-rows` 是 grid 且隐式行等分', () => {
    const rule = /^\.dc-clean-rows \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(rule, '找不到 `.dc-clean-rows` 那条规则').not.toBeNull()
    expect(rule![1]!, '行容器不是 grid ⇒ 根本没有"行与行等高"这件事').toMatch(/display:\s*grid/)
    expect(rule![1]!, '没有写等高的隐式行').toMatch(/grid-auto-rows:\s*1fr/)
  })

  it('窄窗**也不撤销**等高：等高是一条口径，不分档（上一版这里写反了）', () => {
    /**
     * 第一版在 ≤780px 那档写了 `grid-auto-rows: auto`，理由是"数字组换行后统一行高会留死白"。
     * 那个理由是错的：留白就是等高本身，宽窗也一样 —— 两档各写一套会变成
     * "窗口一缩，卡片就又开始参差"，正是主人这次要消掉的东西。
     *
     * 判据只量 `.dc-clean-rows` 自己那一条：全局另有 `.dc-hud-grid` 的
     * `minmax(0, 1fr)`（首页 HUD，与本页无关），拿全文去数会把它一起算进来 ——
     * 第一版就是这么误红的（判据宽到量了别的组件）。
     */
    const base = /^\.dc-clean-rows \{([\s\S]*?)\n\}/m.exec(CSS)
    expect(base, '找不到 `.dc-clean-rows` 那条规则').not.toBeNull()
    expect(base![1]!).toMatch(/grid-auto-rows:\s*1fr/)

    // 窄窗那一段里不许再出现第二条覆盖它的 grid-auto-rows
    const media = CSS.slice(CSS.indexOf('@media (max-width: 780px)'))
    expect(media, '窄窗又把等高改回去了').not.toMatch(/grid-auto-rows/)
  })
})

describe('图二那一句副标题已删掉', () => {
  it('页头不再有 `.dc-clean-sub` 那句话（源码与样式两处都没有）', () => {
    expect(CLEANUP, '副标题还在 JSX 里').not.toContain('dc-clean-sub')
    expect(CLEANUP, '那句文案还在').not.toContain('勾选后计入预估，确认之后才会删')
    expect(CSS, '没有节点了，样式还留着（下次有人照着它把节点加回来）').not.toMatch(/\.dc-clean-sub\s*\{/)
  })
})

describe('反面对照：这组判据对"退回旧版式"是红的', () => {
  it('把 align-items 改回 start ⇒ 居中那条必须红', () => {
    const mutated = CSS.replace(/(\.dc-clean-row \{[^}]*?)align-items:\s*center/, '$1align-items: start')
    expect(mutated, '变异没落下去 —— 下面那条断言是空过').not.toBe(CSS)
    const rule = /^\.dc-clean-row \{([\s\S]*?)\n\}/m.exec(mutated)
    expect(/align-items:\s*start/.test(rule![1]!)).toBe(true)
  })

  it('把最简模式换回整段 description ⇒ ② 那条必须红', () => {
    const mutated = CLEANUP.replace('{itemSummary(i)}', '{i.description}')
    expect(mutated).not.toBe(CLEANUP)
    expect(/dc-clean-row-desc[^}]*\{itemSummary\(/.test(mutated)).toBe(false)
  })

  it('去掉 grid-auto-rows ⇒ 等高那条必须红', () => {
    const mutated = CSS.replace(/(\.dc-clean-rows \{[\s\S]*?)grid-auto-rows:\s*1fr;/, '$1')
    expect(mutated).not.toBe(CSS)
    expect(/grid-auto-rows:\s*1fr/.test(mutated)).toBe(false)
  })
})
