/**
 * §3.6 开发环境页的三个呈现助手 + 「全选本组」的扫入范围。
 *
 * 为什么单开一个 `.tsx` 文件测页面助手（而不是并进 `devenv-view.test.ts`）：
 * 判据本身住在主进程那层，界面上的文字与"批量勾选扫进哪几行"是第二层 —— 两层各自能被单独跑红，
 * 才分得清"分组算错了"和"分组对了但界面念错"。
 *
 * 其中 `groupIncludeIds` 那一条不是设计出来的用例：我第一版 JSX 里就写成只过 `toggle-include`，
 * 于是 AI 模型那一行会被"全选本组"扫进去 —— §3.5 刚立的那道豁免在页面上原地复活。
 * 抽成函数 + 钉住它，是为了让同一个错第二次犯的时候是红的，不是静默的。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DevEnvModelNote,
  devEnvBytesText,
  devEnvHasDeleteControl,
  devEnvInstallText,
  devEnvModelScopeText,
  devEnvModelText,
  devEnvResidualText,
  groupIncludeIds
} from '../../src/renderer/pages/DevEnv'
import { formatBytes } from '../../shared/format'
import type { DevEnvGroupWire, DevEnvRowWire, ModelTallyWire, ScanStatus } from '../../shared/types'

const row = (over: Partial<DevEnvRowWire> & { ruleId: string }): DevEnvRowWire => ({
  name: over.ruleId,
  installState: 'installed',
  displayBytes: 1024,
  displayFiles: 2,
  excludedFromDefaultSelection: false,
  residual: null,
  territoryMissing: false,
  actions: ['detail', 'toggle-include', 'group-select-all'],
  ...over
})

describe('§3.6 「全选本组」不许扫进默认豁免那一行', () => {
  const rows = [
    row({ ruleId: 'npm-cache' }),
    row({ ruleId: 'pnpm-store' }),
    row({ ruleId: 'huggingface-cache', excludedFromDefaultSelection: true, actions: ['detail', 'toggle-include', 'go-large-files'] })
  ]

  it('只扫允许被勾且没被默认豁免的那两行', () => {
    expect(groupIncludeIds(rows)).toEqual(['npm-cache', 'pnpm-store'])
  })

  it('反向半边：手动勾这一行的路还在（它只是不进批量）', () => {
    const hf = rows[2]!
    expect(hf.actions).toContain('toggle-include')
    expect(hf.actions).not.toContain('group-select-all')
  })
})

describe('§3.6 三句话必须是三句话（未检测到 / 没探测过 / 还没扫过）', () => {
  it('未安装的分类念「未检测到」，界面上一个字节数字都不许出现', () => {
    const r = row({ ruleId: 'gradle-cache', installState: 'not-installed', displayBytes: null })
    expect(devEnvInstallText(r)).toBe('未检测到')
    expect(devEnvBytesText(r, null, formatBytes)).toBe('未检测到该工具')
    expect(devEnvBytesText(r, null, formatBytes)).not.toContain('0')
  })

  it('量过且真是 0 → 就印 0，这一格不是 hedge 的地方', () => {
    const r = row({ ruleId: 'npm-cache', displayBytes: 0, displayFiles: 0 })
    expect(devEnvBytesText(r, null, formatBytes)).toBe(formatBytes(0))
  })

  it('装了但这份报告没覆盖到 → 念「这次没量到」，不许写死成"还没扫过"（成因有两种，这一层分不出）', () => {
    const r = row({ ruleId: 'pip-cache', displayBytes: null })
    expect(devEnvBytesText(r, null, formatBytes)).toBe('这次没量到')
  })

  it('没探测过 → 「没探测过」，不许冒充「未检测到」', () => {
    const r = row({ ruleId: 'maven-repository', installState: 'unknown', displayBytes: null })
    expect(devEnvInstallText(r)).toBe('没探测过')
    expect(devEnvBytesText(r, null, formatBytes)).toBe('不确定装没装')
  })
})

describe('§3.6 Docker 行没有任何能触发删除的控件', () => {
  /**
   * 这里刻意**不**引 `core/rules/devenv-view.ts`：`tsconfig.web.json` 的 include 是逐文件白名单
   * （V0.5 为了"渲染端拿不到删除能力"砌的那堵墙），测试把 core 拽进 web 工程就等于自己拆墙。
   * 分组与动作怎么算出来的，由 `devenv-view.test.ts` 在主进程那一侧钉；
   * 这一格只钉"界面拿到这样一张表之后，认不认得出哪一行没有删除控件"。
   */
  const rows: DevEnvRowWire[] = [
    row({ ruleId: 'npm-cache' }),
    row({ ruleId: 'huggingface-cache', excludedFromDefaultSelection: true, actions: ['detail', 'toggle-include', 'go-large-files'] }),
    row({
      ruleId: 'docker',
      installState: 'not-installed',
      displayBytes: null,
      displayFiles: null,
      excludedFromDefaultSelection: true,
      actions: ['view', 'prune-hint']
    })
  ]

  it('Docker 行的判据是 false，普通开发环境行是 true', () => {
    expect(devEnvHasDeleteControl(rows.find((r) => r.ruleId === 'docker')!)).toBe(false)
    expect(devEnvHasDeleteControl(rows.find((r) => r.ruleId === 'npm-cache')!)).toBe(true)
  })

  it('整页只有 Docker 那一行不带任何批量或单条勾选控件；AI 那行仍然可手动勾', () => {
    expect(rows.filter((r) => !devEnvHasDeleteControl(r)).map((r) => r.ruleId)).toEqual(['docker'])
    expect(groupIncludeIds(rows)).toEqual(['npm-cache'])
  })
})

describe('§3.6 未完 #1：AI 分组那一格「检测到 N 个大模型文件」', () => {
  /**
   * 这一组用例钉的不是文案好不好看，而是**扫描状态必须改变那句话的身份**：
   * 没跑完的扫描数出来的 N 只是个下界，把它念成"检测到 N 个"就是替一台还没看完的机器作证。
   * 六个 `ScanStatus` 逐个点名，漏一个就会念成空串（界面上"空"与"没有这句话"同形，肉眼分不出）。
   */
  const tally = (over: Partial<ModelTallyWire>): ModelTallyWire => ({
    count: 150,
    bytes: 150 * 1024,
    rootPath: 'C:\\Users\\Kano',
    filesSeen: 120_000,
    truncated: false,
    scanStatus: 'completed',
    extensions: ['.ckpt', '.gguf', '.safetensors'],
    ...over
  })
  const g = (modelFiles: ModelTallyWire | null | undefined): DevEnvGroupWire => ({
    id: 'ai',
    label: 'AI 模型与权重',
    rows: [],
    ...(modelFiles === undefined ? {} : { modelFiles })
  })

  it('扫完的树念「检测到 N 个大模型文件（共 X）」', () => {
    expect(devEnvModelText(g(tally({})), formatBytes)).toBe('检测到 150 个大模型文件（共 150.0 KB）')
  })

  it('六种扫描状态各有句子，一条都不许念成空串', () => {
    const all: ScanStatus[] = ['idle', 'running', 'paused', 'completed', 'cancelled', 'failed']
    for (const s of all) {
      expect(devEnvModelText(g(tally({ scanStatus: s })), formatBytes), `${s} 念不出话`).not.toBe('')
    }
  })

  it('没扫完的三态（running / paused / cancelled+failed）不许借用「检测到」那个完成时态', () => {
    const done = devEnvModelText(g(tally({ scanStatus: 'completed' })), formatBytes)
    expect(done.startsWith('检测到')).toBe(true)
    for (const s of ['running', 'paused', 'cancelled', 'failed'] as const) {
      const txt = devEnvModelText(g(tally({ scanStatus: s })), formatBytes)
      expect(txt, `${s} 偷了完成时态`).not.toMatch(/^检测到/)
      expect(txt).toContain('150')
    }
  })

  it('modelFiles=null（压根没扫过）念的是"要扫过才知道"，不是一排 0', () => {
    const txt = devEnvModelText(g(null), formatBytes)
    expect(txt).toContain('还没扫过')
    expect(txt).not.toContain('0 个')
  })

  it('这一格不属于这个分组时是空串（渲染层据此什么都不画），而不是"检测到 0 个"', () => {
    expect(devEnvModelText(g(undefined), formatBytes)).toBe('')
    expect(devEnvModelScopeText(g(undefined))).toBe('')
  })

  it('口径那一句把扩展名清单、被量的树、分母三样都点名', () => {
    const s = devEnvModelScopeText(g(tally({})))
    expect(s).toContain('.ckpt')
    expect(s).toContain('.gguf')
    expect(s).toContain('C:\\Users\\Kano')
    expect(s).toContain('120,000')
  })

  it('maxFiles 截断过就必须在口径那一句里说出来；没截断时不许凭空冒出来', () => {
    expect(devEnvModelScopeText(g(tally({ truncated: true })))).toContain('截断')
    expect(devEnvModelScopeText(g(tally({ truncated: false })))).not.toContain('截断')
  })
})

describe('§3.6 那一格真的被画出来（render 断言，不是源码字符串）', () => {
  const tally: ModelTallyWire = {
    count: 1234,
    bytes: 26 * 1024 ** 3,
    rootPath: 'D:\\DeepClean\\tmp-ui-demo\\drive\\Users\\Kano',
    filesSeen: 98765,
    truncated: false,
    scanStatus: 'completed',
    extensions: ['.gguf', '.safetensors']
  }
  const groupWith = (modelFiles: ModelTallyWire | null | undefined): DevEnvGroupWire => ({
    id: 'ai',
    label: 'AI 模型与权重',
    rows: [],
    ...(modelFiles === undefined ? {} : { modelFiles })
  })

  it('renderToStaticMarkup 出来的 HTML 里能读到那句话与口径行，数字带千分位', () => {
    const html = renderToStaticMarkup(DevEnvModelNote({ group: groupWith(tally) }))
    expect(html).toContain('检测到 1,234 个大模型文件')
    expect(html).toContain('26.0 GB')
    expect(html).toContain('只数这些扩展名')
    expect(html).toContain('98,765')
  })

  it('不属于模型分组时什么都不画（空 HTML，而不是画出一个"检测到 0 个"）', () => {
    expect(renderToStaticMarkup(DevEnvModelNote({ group: groupWith(undefined) }))).toBe('')
  })

  it('idle 那一档念的是"还没扫过"，而不是把 0 冒充成数出来的结果', () => {
    expect(devEnvModelText(groupWith({ ...tally, count: 0, scanStatus: 'idle' }), formatBytes)).toContain('还没扫过')
  })
})

/**
 * §3.6 未完 #4b 与 #2 的界面半边。两条各钉一种谎：
 * - 「0 B」有两种成因（缓存真空 / 这次没扫到那块地），后者必须点名量的是哪棵树；
 * - 未装工具的残留只能"报占用"，一旦它长出任何勾选形状，#2 就变成第二条删除入口。
 * 断言一律打在文字上（`renderToStaticMarkup`），不打在源码字符串上。
 */
describe('§3.6 占用那一格的两种 0，与残留那一句', () => {
  it('地盘不在这棵被扫的树上 → 不许念 0 B，要点名量的是哪棵树', () => {
    const t = devEnvBytesText(row({ ruleId: 'gradle-cache', displayBytes: 0, territoryMissing: true }), 'C:/Machine', formatBytes)
    expect(t).toContain('没有它的地盘')
    expect(t).toContain('C:/Machine')
    expect(t).not.toContain('0 B')
  })

  it('反面半边：地盘在树上且真是空的，照旧念 0 B —— 这条不许被新分支顺手吃掉', () => {
    expect(devEnvBytesText(row({ ruleId: 'maven-repository', displayBytes: 0 }), 'C:/Machine', formatBytes)).toBe('0 B')
  })

  it('未装 / 没探测过的两句话仍然排在最前（新分支不许抢它们的顺序）', () => {
    expect(devEnvBytesText(row({ ruleId: 'x', installState: 'not-installed', displayBytes: null, territoryMissing: true }), null, formatBytes)).toBe('未检测到该工具')
    expect(devEnvBytesText(row({ ruleId: 'x', installState: 'unknown', displayBytes: null, territoryMissing: true }), null, formatBytes)).toBe('不确定装没装')
  })

  it('残留那句要带得出目录与字节，并且明确"不计入可回收"', () => {
    const t = devEnvResidualText(row({ ruleId: 'pnpm-store', installState: 'not-installed', residual: { bytes: 26 * 1024 ** 3, paths: ['C:/Machine/AppData/Local/pnpm-store'] } }))
    expect(t).toContain('26.0 GB')
    expect(t).toContain('C:/Machine/AppData/Local/pnpm-store')
    expect(t).toContain('不计入可回收')
  })

  it('字节没量过时念"没量过"，不许印成一个数字（0 尤其会被读成"这里其实没东西"）', () => {
    const t = devEnvResidualText(row({ ruleId: 'yarn-cache', installState: 'not-installed', residual: { bytes: null, paths: ['C:/Machine/AppData/Local/Yarn/cache'] } }))
    expect(t).toContain('没量过')
    expect(t).not.toMatch(/\d/)
    // 两个分支都得点名是哪几个目录，否则"这里还有东西"会指向一个看不见的地方
    expect(t).toContain('C:/Machine/AppData/Local/Yarn/cache')
  })

  it('残留目录是空的 → 什么都不报（"这里还躺着 0 B 你可能想手动删"是一句蠢话，也会破掉「未装不许出现 0 B」那条截图判据）', () => {
    expect(devEnvResidualText(row({ ruleId: 'pnpm-store', installState: 'not-installed', residual: { bytes: 0, paths: ['C:/a'] } }))).toBe('')
  })

  it('没有残留可报的行是空串，不是"0 个文件"', () => {
    expect(devEnvResidualText(row({ ruleId: 'npm-cache' }))).toBe('')
  })
})
