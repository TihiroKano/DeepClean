import { useCallback, useEffect, useState } from 'react'
import { useT } from '../i18n'
import { formatBytes, formatCount } from '../../../shared/format'
import type { DevEnvGroupWire, DevEnvRowWire, DevEnvViewWire, ScanStatus } from '../../../shared/types'

/**
 * §3.6 开发环境页。
 *
 * 这一页唯一值得写下来的规矩是：**它不判定任何东西**。哪一行归哪个生态、哪一行能出现「全选」、
 * 哪一行根本不该有删除控件、哪一格该念「未检测到」而不是 0 B —— 全部由主进程的
 * `core/rules/devenv-view.ts` 算好送过来，这里只把 `row.actions` 照画。
 * 所以本页找不到一个 `if (ruleId === 'huggingface-cache')`：那种写法在 V0.7 之前已经犯过一次
 * （判据散在渲染层，改一次界面就没了一次）。
 *
 * 三条界面对照（`--shot` 硬判据逐条盯着，写在 `electron/main/index.ts`）：
 * ① 探测说没装的分类念「未检测到」，且不出现 `0 B`；
 * ② AI 模型那一行点不出「全选」；
 * ③ Docker 行只有一个「查看」与那句要用户自己去执行的命令，没有一个能触发删除的控件。
 */

/** 装没装的那句话。三种状态三句话，不许互换（`unknown` 念「没探测过」，不是「未检测到」）。 */
export function devEnvInstallText(row: DevEnvRowWire): string {
  if (row.installState === 'installed') return '已检测到'
  if (row.installState === 'not-installed') return '未检测到'
  return '没探测过'
}

/**
 * 字节那一格。`null` 与 `0` 必须是两句话 —— 这是本项目反复出现的那类错：
 * 把"没量到"印成一个测量结果。0 只在真量到 0 的时候出现。
 *
 * `null` 那句刻意写成"这次没量到"而不是"还没扫过这棵树"：这一格有两种成因（压根没扫 /
 * 扫了但这份报告里没有这一项），而这一层只拿到行数据、分不出是哪一种。
 * 念成后者就是对其中一半用户说谎 —— 靶场上跑的就是"扫过了、这项是空的"那一支。
 *
 * `territoryMissing` 是第三种 0：**这块地盘压根不在这棵被扫的树上**。
 * 那一格光念 `0 B` 会被读成"这台机器上的这个缓存是空的"，而真实情况是"这次没扫到那块地"，
 * 所以这句必须把量的是哪棵树一起念出来（未完 #4b 点名的就是这个）。
 */
export function devEnvBytesText(row: DevEnvRowWire, scannedRoot: string | null, formatBytes: (n: number) => string): string {
  if (row.installState === 'not-installed') return '未检测到该工具'
  if (row.installState === 'unknown') return '不确定装没装'
  if (row.territoryMissing) return `这棵树上没有它的地盘（扫的是 ${scannedRoot ?? '未知根'}）`
  if (row.displayBytes === null) return '这次没量到'
  return formatBytes(row.displayBytes)
}

/**
 * §3.6 未完 #2：探测器判未装、但那块地盘在扫到的树上看到占用时的那句「还躺着 X」。
 *
 * 三条都是刻意的：
 * - 空目录（0 字节）不报：「这里还躺着 0 B 你可能想手动删」既没信息量，又会把
 *   「未安装的分类不许出现 `0 B`」那条截图判据踩红（那一格本来就是为了诚实才立的）。
 * - `bytes === null` 念"没量过"，不印数字：读面没给子树合计时，任何数字都是猜的。
 * - 这句**只报占用**，明说"不计入可回收、要删请自己去" —— 深删那条路仍然只有 §17→§18 一道门。
 */
export function devEnvResidualText(row: DevEnvRowWire, fmt: (n: number) => string = formatBytes): string {
  const t = row.residual
  if (t === null || t.paths.length === 0) return ''
  if (t.bytes === null) return `未安装，但这些目录里还有东西（字节没量过）：${t.paths.join('、')} —— 不计入可回收，要删请自己确认`
  if (t.bytes <= 0) return ''
  return `未安装，但这些目录还躺着 ${fmt(t.bytes)}：${t.paths.join('、')} —— 不计入可回收，要删请自己确认`
}

/** 这行有没有任何一种能把文件送进工作单的控件 —— §3.6 第三条判据的机器版本。 */
export function devEnvHasDeleteControl(row: DevEnvRowWire): boolean {
  return row.actions.includes('toggle-include') || row.actions.includes('group-select-all')
}

/**
 * 「检测到 N 个大模型文件（共 X GB）」那一格（§3.6 未完 #1）。
 *
 * 句子开头跟着**扫描状态**变，这不是修辞洁癖：`count` 是扫描途中顺带数出来的，
 * 所以没跑完的那一趟给出的只是个下界。把它念成"检测到"就是替一台还没看完的机器作证 ——
 * 与本项目一路在躲的那族错（把"没量到"印成一个测量结果）是同一族，只是方向相反。
 * `idle` 单独提前返回：那一档压根没有树，"只数到 0 个"会是一句有主语的假话。
 */
const MODEL_LEAD: Record<Exclude<ScanStatus, 'idle'>, string> = {
  completed: '检测到',
  running: '扫描进行中，已数到',
  paused: '扫描暂停中，已数到',
  cancelled: '扫描被取消，只数到',
  failed: '扫描失败了，只数到'
}

export function devEnvModelText(group: DevEnvGroupWire, fmt: (n: number) => string): string {
  const t = group.modelFiles
  if (t === undefined) return ''
  if (t === null || t.scanStatus === 'idle') return '还没扫过 —— 这一格要扫过一棵树才知道'
  return `${MODEL_LEAD[t.scanStatus]} ${formatCount(t.count)} 个大模型文件（共 ${fmt(t.bytes)}）`
}

/**
 * 口径那一句：数的是哪些扩展名、量的是哪棵树、从多少个文件里数出来的。
 *
 * `extensions` 是主进程原样带过来的回声，这里**只照抄它**，不另写一份名单 ——
 * 手抄一份"含不含 .bin"的声明早晚会和真的口径分叉，而这一格专门用来防止分叉被读成准数。
 * 截断那句必须出现：`count` 对它走过的那部分树仍是全量，但那棵树本身只是磁盘的一部分。
 */
export function devEnvModelScopeText(group: DevEnvGroupWire): string {
  const t = group.modelFiles
  if (t === null || t === undefined) return ''
  const parts = [
    `只数这些扩展名：${t.extensions.join(' · ')}`,
    `量的是 ${t.rootPath} 这棵树`,
    `从 ${formatCount(t.filesSeen)} 个文件里数出来`
  ]
  if (t.truncated) parts.push('这棵树在 maxFiles 处截断过，它只是磁盘的一部分')
  return parts.join(' · ')
}

/**
 * 那一格本身。**故意做成一个能被单独渲染的函数组件**：`tests/unit/devenv-page.test.tsx` 用
 * `renderToStaticMarkup` 断言句子的真的进了 HTML，而不是只在源码里存在（本仓没有 jsdom，
 * effect 跑不起来，所以"整页渲染后再看那一格"这条更强的路在这里走不通）。
 *
 * 它没有自己的 state，也没有任何判定 —— 两句话都由上面那两个纯函数算出来。
 * `modelFiles === undefined`（这个生态不问这个问题）时画空，绝不画一个"检测到 0 个"。
 */
export function DevEnvModelNote({ group }: { group: DevEnvGroupWire }): JSX.Element | null {
  if (group.modelFiles === undefined) return null
  return (
    <>
      <div className="dc-devenv-models">{devEnvModelText(group, formatBytes)}</div>
      <div className="dc-muted">{devEnvModelScopeText(group)}</div>
    </>
  )
}

/**
 * 「全选本组」到底扫进哪几行。**两道都要过**：
 * `toggle-include` 说这一行允许被勾；`excludedFromDefaultSelection` 说它**不进批量勾选**。
 * 只过前一道就会把 AI 模型那一行扫进"全选本组" —— 那是 §3.5 那条豁免在页面上的复活路径，
 * 而这一句正是我手搓 JSX 时真写错的形状，所以判据抽出来留在这里给用例钉。
 */
export function groupIncludeIds(rows: readonly DevEnvRowWire[]): string[] {
  return rows.filter((r) => r.actions.includes('toggle-include') && !r.excludedFromDefaultSelection).map((r) => r.ruleId)
}

export function DevEnv({
  scanId,
  selected,
  onSelectedChange
}: {
  scanId: string | null
  selected: string[]
  onSelectedChange(next: string[] | ((prev: string[]) => string[])): void
}): JSX.Element {
  const t = useT()
  const [view, setView] = useState<DevEnvViewWire | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.deepclean
      .getDevEnvView(scanId)
      .then((v) => {
        if (alive) setView(v)
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [scanId])

  const includeRule = useCallback(
    (ruleId: string): void => {
      onSelectedChange((prev) => (prev.includes(ruleId) ? prev.filter((x) => x !== ruleId) : [...prev, ruleId]))
    },
    [onSelectedChange]
  )

  return (
    <div className="dc-page">
      <h2 className="dc-page-title">{t('开发环境')}</h2>
      <div className="dc-muted">
        按生态分组。这一页只报告装没装与占了多少，勾选仍然归「垃圾清理」页那条确认链 —— 删除走的是
        §17 → §18 那一道门，这里没有第二条。
      </div>
      {error !== null && <div className="dc-warn">{t('读不到探测结论：{err}', { err: error })}</div>}
      {view === null && error === null && <div className="dc-muted">{t('正在问这台机器装了哪些工具链…')}</div>}

      {view !== null && (
        <>
          {view.groups.map((g) => (
            <section key={g.id} className="dc-devenv-group">
              <h3 className="dc-devenv-group-title">{g.label}</h3>
              {g.modelFiles !== undefined && <DevEnvModelNote group={g} />}
              <div className="dc-table-wrap">
                <table className="dc-table">
                  <thead>
                    <tr>
                      <th>{t('分类')}</th>
                      <th>{t('检测')}</th>
                      <th className="dc-num">{t('占用')}</th>
                      <th>{t('动作')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((row) => {
                      const canInclude = row.actions.includes('toggle-include')
                      const on = selected.includes(row.ruleId)
                      return (
                        <tr key={row.ruleId}>
                          <td>{row.name}</td>
                          <td>{devEnvInstallText(row)}</td>
                          <td className="dc-num">{devEnvBytesText(row, view.scannedRoot, formatBytes)}</td>
                          <td>
                            <span className="dc-devenv-actions">
                              {devEnvResidualText(row) !== '' && <span className="dc-muted">{devEnvResidualText(row)}</span>}
                              {/* 动作完全由服务端那张表决定：这里没有一条按 ruleId 写的分支 */}
                              {row.actions.includes('group-select-all') && (
                                <button
                                  className="dc-btn"
                                  onClick={() =>
                                    onSelectedChange((prev) => Array.from(new Set([...prev, ...groupIncludeIds(g.rows)])))
                                  }
                                >
                                  全选本组
                                </button>
                              )}
                              {canInclude && (
                                <button className="dc-btn" onClick={() => includeRule(row.ruleId)}>
                                  {on ? '取消勾选这一项' : '勾上这一项'}
                                </button>
                              )}
                              {row.actions.includes('go-large-files') && <span className="dc-muted">{t('模型本体不在这张表里 · 只报占用，不在这里删')}</span>}
                              {row.actions.includes('view') && <span className="dc-muted">{t('只读查询，DeepClean 不代它清理。')}</span>}
                              {row.pruneCommand !== undefined && (
                                <span className="dc-muted">
                                  要释放这部分空间，请自己在终端执行：<code>{row.pruneCommand}</code>
                                </span>
                              )}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
          <div className="dc-muted">
            本页覆盖内置开发环境规则 {view.declaredRuleCount} 条 · 「未检测到」是探测结论，不等于那台机器上没有对应文件。
          </div>
        </>
      )}
    </div>
  )
}
