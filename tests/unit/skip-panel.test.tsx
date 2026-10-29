/**
 * SkipPanel 展开体的那两句文案（Task 9 评审 Finding 1 / Finding 2）。
 *
 * 这一栏的作用是"如实说明哪些东西没被计量"，所以它**自己不许多说话**。两个可复现的假话：
 * 1. 清单只从 `denied` 里填，而 `total` 是四类之和 —— 一趟全是 `missing` 的正常扫描
 *    （真盘上随手就是：消失的临时文件 ENOENT → missing）会落到 `total > 0 / sample 为空`，
 *    门放在 `total === 0` 上挡不住它，于是 `<ul>` 上方写着「下列为前 0 个…」= 凭空捏造一份名单；
 * 2. `denied` 里真混着**文件**（单个文件 stat 撞 EPERM 也分类成 denied），所以那一行的名词
 *    必须是「项目」而不是「目录」，也不能带「及其子目录」这种对文件根本不成立的断言。
 *
 * 两条都是**渲染**层面的事，所以这里渲染真组件（`renderToStaticMarkup`），断言真实 HTML 文本：
 * 单测跑的是截图判据看不见的第 0 步，而截图那一层的判据本轮也跟着改成能区分「没有 denied」与
 * 「有 denied 但清单空」（见 electron/main/index.ts 第 32 步）。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SkipPanel, SkipPanelBody } from '../../src/renderer/components/SkipPanel'
import type { SkippedWire } from '../../shared/types'

const wire = (over: Partial<SkippedWire> = {}): SkippedWire => ({
  total: 0,
  denied: 0,
  missing: 0,
  busy: 0,
  otherErrors: 0,
  sample: [],
  sampleOverflow: 0,
  ...over
})

const body = (data: SkippedWire): string => renderToStaticMarkup(<SkipPanelBody data={data} />)

describe('SkipPanel 的展开体：没有可点名的东西就一个字都不许承诺', () => {
  /**
   * Finding 1 的现场：全 missing、零 denied（真实扫描的常规结果），旧代码在这里渲染出
   * 「下列为前 0 个无法进入的目录」+ 一个空 `<ul>`。
   */
  it('全 missing、零 denied：分账照实说，但绝不出现「下列为前 N 个」那句，也不立清单', () => {
    const html = body(wire({ total: 7, missing: 7 }))
    expect(html).toContain('权限拒绝 0')
    expect(html).toContain('文件消失 7')
    expect(html).not.toContain('下列为前')
    expect(html).not.toContain('未能读取')
    expect(html).not.toContain('<ul')
    // 「另有 M 个未列出」同理：一个都没有就不许出现（0 冒充说过话）
    expect(html).not.toContain('未列出')
  })

  it('有 denied 有清单：那句介绍与清单同时出现，条数取自清单长度而不是计数器', () => {
    const html = body(wire({ total: 3, denied: 3, sample: ['C:\\a', 'C:\\b', 'C:\\c'] }))
    expect(html).toContain('下列为前 3 个未能读取的项目')
    expect(html).toContain('<li')
    expect(html.match(/<li/g)).toHaveLength(3)
    expect(html).toContain('C:\\a')
  })

  it('溢出：「另有 M 个未列出」在清单被截断时点名剩下的那些', () => {
    const html = body(wire({ total: 250, denied: 250, sample: ['C:\\a'], sampleOverflow: 249 }))
    expect(html).toContain('另有 249 个未列出')
    expect(html).toContain('下列为前 1 个')
  })

  /**
   * 修订 2：「另有 M 个未列出」预设前面有一份名单，所以它和介绍句、`<ul>` 挂同一道
   * `sample.length > 0` 的门。今天这一状态走扫描链到不了（scanner 的每处 `count()` 都带 path），
   * 但 `addError` 的 `path` 是可选兼容面 —— 防御钉。截图判据对"有 denied 却没名字"那一支
   * 本来就 FAIL，这一条让单测侧钉住同一件事。
   */
  it('零名字时「另有 M 个未列出」也不许单独悬在半空（预设了不存在的那份名单）', () => {
    const html = body(wire({ total: 3, denied: 3, sample: [], sampleOverflow: 3 }))
    expect(html).toContain('权限拒绝 3') // 分账照实说
    expect(html).not.toContain('下列为前')
    expect(html).not.toContain('<ul')
    expect(html).not.toContain('未列出')
  })

  /**
   * Finding 2：`core/fs/errors.ts` 把文件 stat 的 EPERM/EACCES 也记成 `denied`，
   * `walk.ts` 与 `scanner.ts` 都拿文件路径调过 `addError` —— 所以清单里出现文件路径是常态，
   * 而名词写成「目录」就等于对着一个没有子目录的东西断言「它们及其子目录的容量没有计入地图」。
   * 这一条钉住名词，也钉住"不许用阉割数据来迁就名词"（文件路径必须照样列出来）。
   *
   * 措辞断言**只 scope 在介绍句那一段 `<p>` 上**（修订 2）：整份 HTML 一律 `not.toContain('目录')`
   * 会误伤两样合法的东西 —— 样本里真实存在含「目录」的路径（下面故意留了一条，若判据铺满全文
   * 这条用例就为一个非缺陷长红），以及 Task 11 计划追加的「太深而未进入」那一类新句子。
   */
  it('名词是「未能读取的项目」，不是「目录」；也不出现「子目录」这种对文件不成立的断言', () => {
    const html = body(
      wire({
        total: 2,
        denied: 2,
        sample: ['C:\\Users\\me\\AppData\\SomeFile.lock', 'C:\\Users\\me\\用户目录\\LockedDir']
      })
    )
    const intro = (html.match(/<p[^>]*>[^<]*下列为前[^<]*<\/p>/) ?? [''])[0]
    // intro 没渲染出来时这里是空串，toContain 直接红 —— 不会退化成"断言了个寂寞"
    expect(intro, '介绍句没渲染出来，措辞断言就成了空话').toContain('未能读取的项目')
    expect(intro).not.toContain('目录')
    expect(intro).not.toContain('及其子目录')
    // 数据一个字都不少：文件路径照样点名，含「目录」的合法路径也不该被措辞判据误伤
    expect(html).toContain('SomeFile.lock')
    expect(html).toContain('用户目录\\LockedDir')
  })

  it('收起态：total=0 时整栏不存在（这一条不变，门从 total 挪到 sample 不等于把栏门撤了）', () => {
    expect(renderToStaticMarkup(<SkipPanel data={wire()} />)).toBe('')
    expect(renderToStaticMarkup(<SkipPanel data={null} />)).toBe('')
    expect(renderToStaticMarkup(<SkipPanel data={wire({ total: 3, missing: 3 })} />)).toContain('共跳过 3 个')
  })
})
