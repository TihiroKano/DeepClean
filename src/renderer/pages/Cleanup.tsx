import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { formatBytes } from '../../../shared/format'
import { RISK_COLORS, RISK_LABELS, type Risk } from '../../../shared/classify'
import type {
  CleanProgressEvent,
  CleanTask,
  PreviewItem,
  PreviewModel,
  ScanSnapshot
} from '../../../shared/types'
import { usePreview } from '../hooks/usePreview'
import { Donut } from '../components/Donut'
import { Portal } from '../components/Portal'
import {
  ChevronRightIcon,
  ClockIcon,
  CodeIcon,
  FileIcon,
  FolderIcon,
  ImageIcon,
  LayersIcon,
  MapIcon,
  SparkleIcon,
  TrashIcon
} from '../components/icons'
import type { IconProps } from '../components/icons'

/**
 * 2026-10-24 存档：原来那个 `canExecuteReceipt`（「开始清理」能不能按的判据）随手动档
 * 整块删掉了 —— 一键清理合并成唯一入口之后，界面不再持有确认回执，也就没有
 * 「这份回执属于当前这份预估」可判。那条链的服务端半边（digest → ConfirmedPlan → 执行）
 * 原样还在：`run_auto_clean` 走的就是它，只是「按下按钮」这一步替代了界面上的确认动作。
 */

/**
 * 「全选可清理项」到底能选到哪几行 —— §17 的勾选面与 §3.5 的默认豁免在这里汇合。
 *
 * 抽成模块级纯函数有两个原因，都不是"看起来更干净"：
 * 1. 判据要能被单测直接喂一张表跑（`tests/unit/cleanup-default-selection.test.ts`），
 *    而不是 grep 这个文件里有没有写 huggingface —— 后者只证明字面量还在，不证明它参与了判定。
 * 2. `defaultUnselectableRuleIds` 是**服务端算好交下来的**（派生见 `core/rules/registry.ts`）。
 *    界面少画一个复选框不叫结构性豁免；这里只允许"读那张表"，不允许在这里重新判定。
 *
 * 两条排除各自独立，且方向不可交换：🔴 永远勾不动（§16），§3.5 的表只改**默认**勾选、
 * 不改这一行能不能被手动勾上。
 */
export function selectableRuleIds(
  items: readonly PreviewItem[],
  defaultUnselectableRuleIds: readonly string[]
): string[] {
  const exempt = new Set(defaultUnselectableRuleIds)
  return items
    .filter((i) => i.riskLevel !== 'forbidden' && !exempt.has(i.ruleId))
    .map((i) => i.ruleId)
}

/**
 * M5-P1 T5b：确认时该按下哪一档 = **已计入项里的最高档**。
 *
 * 与主进程 `required_tier(model)` 同口径，两边不一致时回执带 `risk-not-acknowledged` ——
 * 那句文案就是这条口径漂移的探针。三条不许含糊的地方：
 *  - 只看 `included`，不看 `selected`：勾了但没计价（被拒、被截断）的行不该抬高档位；
 *  - 🔴 永不 `included`，所以返回值最高到 `high`，不会把「禁止」当成一个可确认的档位；
 *  - 空集合返回 `safe`，与主进程 `required_tier` 返回 `None`（不罚）同一方向。
 */
export function requiredRiskOf(items: readonly PreviewItem[]): Risk {
  const included = items.filter((i) => i.included)
  if (included.some((i) => i.riskLevel === 'high')) return 'high'
  if (included.some((i) => i.riskLevel === 'caution')) return 'caution'
  return 'safe'
}

/**
 * 页头统计带那三格数 + 环形的百分比 —— **界面只做一次除法，不重新求和**。
 *
 * 三个数全部来自服务端已经算好的字段，一个都不在这里加：
 *  · `items`   = `model.items.length`，即「这一趟扫到几条规则命中」；
 *  · `reclaim` = `model.reportReclaimableBytes`，报告自己的 🟢🟡🟠 合计（全量勾选时可释放的上限）；
 *  · `planned` = `model.totalBytes`，**已勾选并计入**的合计 —— 表格「计入预估」列加起来就是它。
 *
 * 为什么环形取 `planned / reclaim` 而不是别的：`planned` 恒 ≤ `reclaim`（可回收上限那句话由
 * `core/rules/preview.ts` 保证，全选时逐字节相等），比值天然落在 0–1 里，正好是图二环形的语义
 * ——「这一趟的清单装了可清理空间的多少」。**不做第二种除法**（比如拿它比整盘容量）：盘的总量
 * 不在这份模型里，硬凑就得在界面上另立一套口径。
 *
 * `reclaim === 0`（本机零命中、或报告自己就是 0）时百分比按 0 处理，不做 0/0：
 * 分母没有意义时给 0% 是诚实的读法（那条空态文案会单独说明为什么是空的）。
 */
export function cleanupHeadline(model: PreviewModel | null | undefined): {
  items: number
  reclaimBytes: number
  plannedBytes: number
  pct: number
} {
  const items = model?.items.length ?? 0
  const reclaimBytes = model?.reportReclaimableBytes ?? 0
  const plannedBytes = model?.totalBytes ?? 0
  const pct = reclaimBytes > 0 ? Math.max(0, Math.min(100, (plannedBytes / reclaimBytes) * 100)) : 0
  return { items, reclaimBytes, plannedBytes, pct }
}

/**
 * 这一页此刻该画**哪一相** —— 抽成纯函数，因为它是"两段加载"那个缺陷的判据所在。
 *
 * ## 人类伙伴 2026-10-21 指出的现象
 *
 * > 「点击垃圾清理出现 loading，然后界面出来了，loading，自动清理执行自动打勾。」
 *
 * 拆开是两段：
 *  ① 进页面 → 发一次 `previewCleanup`（此时 `selected` 是空的）→ 回包 ⇒ **画出一个全未勾选的页面**；
 *  ② 那个页面上的"自动打勾"effect 触发 → 又发一次 `previewCleanup`（这次带着可清理项）
 *     → 回包 ⇒ 才变成真正该看到的那一页。
 *
 * 也就是说用户先看到一版**错的勾选状态**、外加第二次 Loading。中间那一版不但多余，
 * 还会让人以为"清理页默认什么都不勾"。
 *
 * ## 修法
 *
 * 把「这一份模型是否已反映当前勾选」变成一个**可判的事实**，没反映就不画内容：
 * `PreviewItem.selected` 是服务端按 `selection` 算出来的（`core/rules/preview.ts:218`），
 * 于是"模型里每一条的 `selected` 都等于 `selected` 里含不含它"就是逐条对得上的判据。
 * 对不上 ⇒ 这是**过渡态那一份**，界面上应当继续显示居中的 Loading，而不是把它画出来。
 *
 * 三条边界：
 *  · `blocked` 时不判 —— 那种模型整份不出结论（`totalBytes` 恒 0），勾选状态没有意义；
 *  · 零命中时立刻算"对上"—— 没有可勾的行，第一次回包就是终态，不该白等第二次；
 *  · `payload === null`（还没回包 / 会话失效）不算"对上"—— 那是 Loading 或错误态，另走分支。
 */
export function modelMatchesSelection(
  model: PreviewModel | null | undefined,
  selectedRuleIds: readonly string[]
): boolean {
  if (!model) return false
  if (model.blocked) return true
  const want = new Set(selectedRuleIds)
  // 逐条对账：每一条的 `selected` 必须与"勾选集合里有没有它"一致
  for (const item of model.items) {
    if (item.selected !== want.has(item.ruleId)) return false
  }
  // 反向半边：勾选集合里出现模型里没有的 id，说明这份模型不是按它算的（或已过期）
  const have = new Set(model.items.map((i) => i.ruleId))
  for (const id of want) if (!have.has(id)) return false
  return true
}

/**
 * 这一行此刻该不该显示成「已勾」—— **本地勾选优先，服务端字段只做兜底**。
 *
 * ## 为什么不能只读 `item.selected`
 *
 * 复选框原来写的是 `checked={i.selected}`，而 `i.selected` 是**服务端按 `selection` 算出来的**
 * （`core/rules/preview.ts:218`）。于是点一下复选框的时序是：
 *
 * ```
 * 点击 → onChange → toggle() → App 的 selected 变 → usePreview 发 dc_preview
 *      →（等回包）→ payload 换成新模型 → checked 才跟着变
 * ```
 *
 * 中间那一段屏幕上**没有任何变化**：勾还是没勾、行还是没高亮、「计入预估」还是「—」。
 * 回包一慢（几十到几百毫秒），用户读到的就是「点了没反应」。
 * 10-22 把服务端从 490 ms 降到个位数毫秒，但只要还走"等服务端"这一跳，
 * 慢一次就复现一次 —— 而清理过一次之后缓存会失效（那条已另行修掉），那时正好最慢。
 *
 * ## 为什么不是 `checked={selected.includes(i.ruleId)}`
 *
 * 那会把服务端那份 `selected` 整个丢掉，而它有两个地方还在用：
 *  · `modelMatchesSelection`（判"这份模型是否已反映勾选"）—— 它必须逐条对账服务端字段，
 *    否则"模型还没回来"与"模型说这一行没勾"会被混成一件事；
 *  · 首屏那一相：模型回来前 `selected` 可能已经是自动打勾的结果，而行还没画出来。
 *
 * 所以这里只把**显示**这一层改成本地优先：`selected` 里有它 ⇒ 勾（不等服务端）；
 * `selected` 里没有它，才看服务端怎么说（那正是"回包刚到、本地还没点"的那一瞬）。
 *
 * 纯函数是为了能被单测直接喂两种组合跑，而不是靠截图证明"看起来变了"。
 */
export function rowChecked(item: PreviewItem, selectedRuleIds: readonly string[]): boolean {
  if (selectedRuleIds.includes(item.ruleId)) return true
  // 本地没勾 ⇒ 听服务端。`blocked` 时服务端一律给 false，这一行本来也勾不动。
  return item.selected
}

/**
 * 风险 → 那个实心圆点的颜色。**取的就是 `RISK_COLORS` 同一张表**，不另立一套色。
 *
 * 图二那一列是「🟢 安全」这样的小药丸；本项目的 `RISK_LABELS` 自带 emoji 前缀，
 * 直接当药丸文字会得到「🟢 🟢 安全」那种重复。所以文字用去掉 emoji 的部分，
 * 颜色由这里给 —— 两个都从 `shared/classify.ts` 来，界面不写死任何一个色值。
 */
export function riskDot(risk: Risk): string {
  return RISK_COLORS[risk]
}

/**
 * 风险药丸里那两个字 —— **`RISK_LABELS` 去掉它自带的 emoji 前缀**。
 *
 * 为什么不是另写一张表：`RISK_LABELS` 是 `shared/classify.ts` 里与 `RISK_COLORS` 同一处声明的
 * 唯一真相，另写一份「安全 / 谨慎 / 高风险 / 禁止」就等于把风险名复制成两份，
 * 将来改一处另一处会静默不动。
 *
 * 为什么必须去掉 emoji：图二的药丸是「● 安全」——圆点已经由 `riskDot` 上色表达档位，
 * 再保留「🟢」会变成「🟢 🟢 安全」。去法按**第一个空白**切，不按具体 emoji 删：
 * emoji 的码位数会随字体与平台变，而 `RISK_LABELS` 的形制（一个前缀 + 空白 + 名字）是稳定的。
 * 前缀缺失时（将来某条标签不带 emoji）原样返回整串，不会把名字吃掉。
 */
export function riskText(risk: Risk): string {
  return (RISK_LABELS[risk] ?? '').replace(/^\S+\s+/, '')
}

/**
 * 规则类别 → 图标。**输入是 `PreviewItem.category`（服务端那条规则的声明），
 * 不是界面按名字猜** —— 猜的话给规则改名就会悄悄换一个图标，而这里根本不知道。
 *
 * 未登记的类别退回 `FileIcon`（一个中性的"有条目"），不是随机挑一个：
 * 挑一个语义不对的图标比一个中性图标更会误导人。表外类别在下面 `describeCategory` 里
 * 也照原样吐出 category 本身，两处同一策略。
 */
const CATEGORY_ICON: Record<string, (p: IconProps) => JSX.Element> = {
  temp: ClockIcon,
  'browser-cache': ImageIcon,
  'thumbnail-cache': ImageIcon,
  'shader-cache': LayersIcon,
  'error-reporting': FileIcon,
  'recycle-bin': TrashIcon,
  'dev-cache': CodeIcon,
  'app-transient': FolderIcon,
  'installer-leftover': FolderIcon,
  'orphan-data': MapIcon
}

export function categoryIcon(category: string): (p: IconProps) => JSX.Element {
  return CATEGORY_ICON[category] ?? FileIcon
}

/**
 * 行内那一句话的**最简模式**（人类伙伴 2026-10-23）：一段话概况核心内容，其余全部进「查看详情」。
 *
 * 取的是**规则表自己那句话的第一句**（`PreviewItem.description`，服务端给的、进过 digest 的那一份）：
 * 按 `；` 或 `。` 切第一段。三条不许含糊的地方：
 *
 * 1. **一个字都不现编**。切分只做截断，不做改写 —— 文案的出处仍在那张规则表里，
 *    digest 盖住的也是那一句。界面把「A；B」显示成「A」是排版，把「A」改成「A（可安全删除）」
 *    就是第二套口径。
 * 2. **表外规则的 `description` 是空串**（`shared/types.ts` 那段契约：`dup:*` 伪项、夹具自定义规则集）。
 *    空串是事实，**不许补一句"通用说明"** —— 那句没有出处，却被哈希进过执行凭据。
 *    这时退回**已经算出来的事实**：命中了几个目录。
 * 3. 不在这里做长度截断：超出列宽由 CSS 省略号负责。多截一刀会让"最简"变成"看不出是什么"。
 */
export function firstSentence(text: string): string {
  const cut = Math.min(
    ...[text.indexOf('；'), text.indexOf('。')].filter((i) => i > 0).concat([Number.POSITIVE_INFINITY])
  )
  const head = Number.isFinite(cut) ? text.slice(0, cut) : text
  return head.trim()
}

export function itemSummary(item: PreviewItem): string {
  const head = firstSentence(item.description)
  if (head !== '') return head
  return item.matchedRoots.length > 0 ? `${item.matchedRoots.length} 个目录` : '无命中目录'
}

/**
 * 「还没有可用内容」时的 Loading（人类伙伴 2026-10-21 三轮要求，逐版记录）：
 *
 *  1. 不确定态进度条 + 旋转环 + 「正在重新计价」—— **本质上什么也没表达**（单条内存 IPC，
 *     期间没有任何进度可上报），还占一整行、跟着列表抖。
 *  2. 只留一个环 + `Loading` —— 短了，但环是通用的，看不出这一页在做什么。
 *  3. 换成他给的 **16 颗点跳动**动画，仍挂在工具栏里。
 *  4. **现在：挪到页面正中、放大、文字改白**（人类伙伴：「首次打开 Loading 加特效放中间放大些，
 *     loading 用白色字体」）。它出现的位置也从"工具栏一格"变成**整块内容区**：
 *     首次打开时页面上还没有任何东西可看，一个居中的大 Loading 才是对的读法。
 *
 * 出现时机由 `showCenteredLoading` 决定（`!model || settling`）—— 后者是这一轮的关键：
 * 它把"第一次回包（全未勾选）"到"自动打勾后的第二次回包"之间那一相**盖住**，
 * 于是用户看到的第一次画面就是已打勾的页面（人类伙伴 2026-10-21 原话里那第二段 Loading 就没了）。
 *
 * ⚠️ 三根不能动的线：
 *  · 根节点必须继续带 `.dc-revalue`（`role="status"` 在它身上）：验收脚本靠
 *    `document.querySelector('.dc-revalue')` 判"这一页有没有在等"。
 *  · 16 颗点用 `Array.from` 生成，**不是手写 16 个 `<div>`**：手写会让"少画一颗"
 *    变成静默的视觉缺陷，而 `dots.length === 16` 是可断言的。
 *  · 文案必须仍是 `Loading`（`m3b-screenshot.ps1` 按这个词等它消失）。
 */
const LOADING_DOTS = 16

function RevalueLoading(): JSX.Element {
  return (
    <div className="dc-revalue dc-revalue-loading dc-revalue-centered" role="status" aria-live="polite">
      <span className="dc-jump" aria-hidden="true">
        {Array.from({ length: LOADING_DOTS }, (_, i) => (
          <i key={i} className="dc-jump-dot" />
        ))}
      </span>
      Loading
    </div>
  )
}

/** 拒绝原因的对外说法。代码（`report-only-root` 等）不外泄给用户，但也不能含糊成"不能删"。 */
const REFUSAL_LABEL: Record<string, string> = {
  'forbidden-risk': '🔴 禁止项目 · 不在可清理范围',
  'forbidden-root': '命中 §16 禁止路径',
  'report-only-root': '只报告占用 · 任何规则都不可清理',
  'safety-blocked': '🔴 保护未落地 · 整份预估不出结论',
  'unknown-rule': '勾选了报告里没有的项目',
  'item-rejected': '该规则在声明层被拒',
  'path-not-enumerated': '报告只给了采样路径，这条无法定价',
  'duplicate-selection': '重复勾选 · 未重复计价'
}

/**
 * 「查看详情」那个浮层（人类伙伴 2026-10-23：详情内容走最简模式，点击再开一个详情框）。
 *
 * 四条纪律，每条都对应一件具体的事：
 *
 * 1. **它不新增任何数字**。框里每一格都直接读 `PreviewItem`（服务端给的那一份，且多数进过 digest）；
 *    界面对数字只做 `formatBytes`，不做加减。另算一个合计就是第二套真相。
 * 2. **`description` 空串时不画那一行**。`shared/types.ts` 明写表外规则留空串是事实，
 *    不许在显示层编一句"通用说明"补上去 —— 那句没有出处，却被哈希进过执行凭据。
 * 3. **关闭动作三条路都要有**：× 按钮、点遮罩、Esc。只给一条就会有人在截图里找不到出口，
 *    而这是**浮在最上层**的东西，点不到底下任何一行。
 * 4. **`role="dialog"` + `aria-modal`**：它是模态的，读屏与 UIA 都该知道底下那棵树此刻不可交互。
 *
 * 为什么挂在 `Portal` 里：这页每一块卡都带 `backdrop-filter`，它会造出新的层叠上下文，
 * 留在原地的话浮层会被后面某一块玻璃压住（本仓 `.dc-menu` 那段注释记的是同一件事）。
 */
function ItemDetail({ item, onClose }: { item: PreviewItem; onClose: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <Portal>
      <div className="dc-modal-mask" onClick={onClose} role="presentation">
        <div
          className="dc-modal dc-clean-detail"
          role="dialog"
          aria-modal="true"
          aria-label={`${item.name} 的详情`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="dc-modal-head">
            <div className="dc-clean-detail-title">
              <span
                className="dc-clean-row-ic"
                style={{ borderColor: riskDot(item.riskLevel), color: riskDot(item.riskLevel) }}
                aria-hidden="true"
              >
                {(() => {
                  const Icon = categoryIcon(item.category)
                  return <Icon size={17} />
                })()}
              </span>
              <h3 className="dc-modal-title">{item.name}</h3>
              {/* 药丸与列表那一格同源：文字取 `RISK_LABELS` 去 emoji，颜色取 `RISK_COLORS` */}
              <span className="dc-badge dc-badge-risk" style={{ borderColor: riskDot(item.riskLevel) }}>
                <i className="dc-risk-dot" style={{ background: riskDot(item.riskLevel) }} aria-hidden="true" />
                {(riskText(item.riskLevel))}
              </span>
            </div>
            <button className="dc-modal-x" onClick={onClose} aria-label="关闭详情">
              ×
            </button>
          </div>

          {/* 规则表自己那句「删了会失去什么」——完整一句，不截断。空串是事实，不补话。 */}
          {item.description !== '' && <p className="dc-clean-detail-desc">{item.description}</p>}

          <dl className="dc-dl dc-clean-detail-grid">
            <dt>占用</dt>
            <dd className="dc-mono">
              {formatBytes(item.findingBytes)} / {item.findingFiles} 个文件
            </dd>
            <dt>计入预估</dt>
            <dd className="dc-mono">
              {item.included ? `${formatBytes(item.bytes)} / ${item.files} 个文件` : '未计入（未勾选或未定价）'}
            </dd>
            <dt>是否可再生</dt>
            <dd>{item.recoverable ? '可再生：删掉之后系统或应用会重新生成' : '不可再生：删掉不会自动长回来'}</dd>
            <dt>清理方式</dt>
            <dd className="dc-mono">{item.cleanStrategy}</dd>
            <dt>勾选粒度</dt>
            <dd>{item.scope === 'paths' ? '按已枚举路径逐条计价' : '整项计价'}</dd>
          </dl>

          <div className="dc-clean-detail-roots">
            <div className="dc-clean-detail-caption">
              目录（{item.matchedRoots.length} 个）
              {item.sampleTruncated && ' · 报告的路径清单被截断过，以上只是已枚举的部分'}
            </div>
            {item.matchedRoots.length > 0 ? (
              <ul className="dc-clean-detail-list">
                {item.matchedRoots.map((r) => (
                  <li key={r}>
                    <code className="dc-mono">{r}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dc-muted dc-fineprint">这条规则本次没有命中任何目录。</p>
            )}
          </div>

          {/* 被拒的那条路径/整项的原因 —— 与列表里那一行同源（同一个 REFUSAL_LABEL 表） */}
          {item.refusal && (
            <p className="dc-clean-refused dc-fineprint">
              {REFUSAL_LABEL[item.refusal.reason] ?? item.refusal.reason}：{item.refusal.detail}
            </p>
          )}
        </div>
      </div>
    </Portal>
  )
}

/**
 * 「还没有扫描会话」那一整块（2026-10-27 抽成导出组件）。
 *
 * **为什么值得单独存在**：抽出来之前这两句话只能由"真机截图"或"源码里有这串字"来验，
 * 而前者需要开窗口、后者只证明字面量在文件里。抽成组件之后
 * `cleanup-retention-wording.test.ts` 可以用 `renderToStaticMarkup` 渲染**产品本体**，
 * 断言用户真正读到的文本 —— 不是断言"我抄了一份在测试里"。
 *
 * 两条文案的口径（2026-10-27 人类伙伴改的）：
 *  ① 第一句只说**要做什么**：「暂未进行扫描，请先前往首页执行扫描。」——
 *     原句拖了一句"本工具不会为了算数字再走一遍磁盘"，那是实现解释，不是用户此刻要的下一动作；
 *  ② 第二句先说**不可恢复**再说失败预期：「本程序已使用管理员权限。删除后无法找回；
 *     部分被占用的文件无法删除属于正常现象。」——原句把"提权 / 删不掉"讲成两件事，
 *     读起来像免责声明；而"删了找不回"才是用户按下按钮前要下的决心。
 *
 * ⚠️ 第二句在**有数据那条路**上也有一份（同一个 `.dc-clean-admin-hint`），两处必须逐字相同。
 * `cleanup-retention-wording.test.ts` 的 ② 就是钉这件事的（数它出现两次）。
 */
export function CleanupEmptyState(): JSX.Element {
  return (
    <div className="dc-clean">
      <h2 className="dc-page-title">垃圾清理</h2>
      <p className="dc-muted">暂未进行扫描，请先前往首页执行扫描。</p>
      <p className="dc-muted dc-fineprint dc-clean-admin-hint">
        本程序已使用管理员权限。删除后无法找回；部分被占用的文件无法删除属于正常现象。
      </p>
    </div>
  )
}

export function Cleanup({
  scanId,
  snapshot,
  tilePaths,
  selected,
  onSelectedChange,
  onRemoveTilePath,
  onClearTilePaths,
  refreshNonce,
  onCleanDone
}: {
  scanId: string | null
  snapshot: ScanSnapshot | null
  tilePaths: readonly string[]
  /** §17 的勾选：由 `App` 持有（与 `tilePaths` 同一处），切视图不会把它带走 */
  selected: readonly string[]
  onSelectedChange: Dispatch<SetStateAction<string[]>>
  onRemoveTilePath: (absPath: string) => void
  onClearTilePaths: () => void
  /**
   * 清理完成后的刷新计数 —— **由 App 持有**（2026-10-25 修）。
   *
   * 它原先是一个本地 useState。而本组件是条件渲染、切页即卸载：用户清完 → 切到
   * 清理日志 → 切回来，nonce 从 1 归 0，缓存键与**清理前那一份逐字相同** ⇒
   * 模块级 previewCache 命中 ⇒ 显示清理前的旧数（「清完那个 4 MB 条目还在」）。
   * 挂在 App 上之后，它活过切页，键不再相同。
   */
  refreshNonce: number
  /** 任务收尾时通知 App 把 nonce +1。 */
  onCleanDone: () => void
}): JSX.Element {
  const [task, setTask] = useState<CleanTask | null>(null)
  const [autoError, setAutoError] = useState<string | null>(null)
  /** 一键清理的**过程弹窗**开着没有（2026-10-24）。 */
  const [dialogOpen, setDialogOpen] = useState(false)
  /**
   * 「查看详情」打开的是哪一条（`ruleId`），null = 没开。
   *
   * 为什么按 id 而不是把那条 `PreviewItem` 整个存进 state：勾选一变模型就会重算，
   * 存下来的对象是**旧那一份**的快照 —— 详情框会显示一个已经被替换掉的读数。
   * 存 id，渲染时从当前模型里现取，详情框与列表永远是同一份事实。
   */
  const [detailOf, setDetailOf] = useState<string | null>(null)
  /**
   * `loading` = 「这一页还没有任何预估」（语义见 `usePreview` 的 `shouldShowLoading`）。
   * 它现在**只用于**"要不要显示居中 Loading"这一个判断 —— 不再挂到工具栏那一行。
   * 与 `settling` 是两件事：`loading` 管"第一次回包还没到"，`settling` 管"回包了但还没反映勾选"。
   * 两者都该显示居中 Loading，所以下面用它们的并集。
   */
  const { payload, error, loading } = usePreview(
    scanId,
    selected,
    tilePaths,
    snapshot?.status,
    refreshNonce
  )
  const model = payload?.preview ?? null
  const blocked = model?.blocked ?? false

  useEffect(
    () =>
      window.deepclean.onCleanEvent((e) => {
        setTask(e.task)
        // 任务收尾（completed / failed / cancelled / refused 都是"这一趟结束"）⇒
        // 图二数字必须跟着磁盘现实走。done 事件带的是任务最终快照，此刻服务端
        // 已把已删文件记进 Session.deleted_paths（`execute_plan` 收尾），重拉拿到的
        // 就是「删完之后」的那份报告。
        if (e.kind === 'done') onCleanDone()
      }),
    []
  )

  /**
   * 标记"用户手动动过勾选"（2026-10-25）。
   *
   * 必须在 `toggle` 之前声明：`toggle` 与工具栏那两个按钮都要调它，
   * 而它们都定义在 `userTouched` 那段注释的下方。
   */
  const userTouched = useRef(false)
  const touch = useCallback((): void => {
    userTouched.current = true
  }, [])

  const toggle = useCallback(
    (ruleId: string): void => {
      touch()
      onSelectedChange((prev) => (prev.includes(ruleId) ? prev.filter((x) => x !== ruleId) : [...prev, ruleId]))
    },
    [onSelectedChange, touch]
  )

  const selectableIds = useMemo(
    () => selectableRuleIds(model?.items ?? [], model?.defaultUnselectableRuleIds ?? []),
    [model]
  )

  /**
   * 首次拿到模型时**自动勾上可清理项**（人类伙伴 2026-10-20：「一键清理的直接自动打勾」）。
   *
   * 三条边界，每条都有理由：
   * 1. **只在用户还没动过勾选时自动填一次**（`autoFilled.current` 一旦置位就不再抢）。
   *    否则用户手动取消一条、估值重算回来又给勾上 —— 那是替用户按按钮。
   * 2. **填的就是 `selectableIds`**，不是「全部 items」：🔴 禁止项与 §3.5 的默认豁免
   *    在这条纯函数里已经排掉了（它读的是服务端算好的 `defaultUnselectableRuleIds`），
   *    自动勾选因此**不可能**越权勾到一条本来勾不动的行。
   * 3. 这一条**只改默认值**，不改任何判定 —— 一键清理清的就是这份勾选
   *    （2026-10-24 起它的名单不再由服务端固定，见 `runAuto` 那段注释）。
   */
  const autoFilled = useRef(false)
  useEffect(() => {
    if (autoFilled.current) return
    if (!model || selectableIds.length === 0) return
    autoFilled.current = true
    onSelectedChange(selectableIds)
  }, [model, selectableIds, onSelectedChange])

  /**
   * **用户有没有手动动过勾选**（2026-10-25）。
   *
   * 它与 `autoFilled` 是两件不同的事，而 `settling` 该门的是这一格、不是那一格：
   *  · `autoFilled` = "程序已经自动填过一次勾选" —— 它在 effect 里与 `onSelectedChange`
   *    **同一拍**置位，所以自动打勾之后它立刻为真；
   *  · `userTouched` = "人点过复选框 / 全选 / 清空" —— 只有 `toggle` 与那两个按钮会置位。
   *
   * 曾经 `settling` 门的是 `!autoFilled.current`，结果是：自动打勾发的第二次请求回包之前，
   * 中间相（勾是勾着的、但「计入预估」全是「—」、「计入 0 项」）**不再被 Loading 盖住**，
   * 直接画给用户看。真机复现到的就是这一相：19 行 `checked:true` 而 `计入 0 项`，
   * 页面停在那里不动，直到用户点一下触发新的回包才恢复 —— 读起来正是
   * 「勾选有延迟、勾没显示、也未计入」。
   */
  /**
   * **首次落定中**：这一页第一次拿到模型、但那份模型还没反映自动打勾。
   *
   * 人类伙伴 2026-10-21：「点击垃圾清理出现 loading，然后界面出来了，loading，自动清理执行自动打勾」
   * —— 那句话描述的就是这一相被**画出来**了。它只是"第一次回包（全未勾选）"与
   * "自动打勾后的第二次回包"之间的中间物，不该给用户看见。
   *
   * ⚠️ **只在"用户还没手动动过勾选"时生效**（`!userTouched.current`）。这一条是必须的，
   * 不是保守：`modelMatchesSelection` 是"模型与当前勾选逐条对得上"，而用户每点一次复选框，
   * 模型都会短暂地对不上 —— 若不加这个门，居中 Loading 就会**在每次勾选时盖回来**。
   * 真机实测过一次：`flashes=3`，正是这个形状。
   *
   * 所以两段各有各的门：
   *  · 首屏（自动打勾那一次）→ `settling` 生效，盖住中间物；
   *  · 用户手动勾选之后 → `settling` 不再参与，旧数字继续显示，新数算完直接替换
   *    （与 `shouldShowLoading` 那条"勾选后不闪"是同一个取舍）。
   */
  const settling = Boolean(model) && !userTouched.current && !modelMatchesSelection(model, selected)

  /**
   * 居中大 Loading 的条件：**还没有可用内容可画**。
   *
   * 两半各管一件事，缺一都会漏出空壳：
   *  · `loading`（`usePreview` 给的）= 第一次回包还没到 ⇒ 连模型都没有；
   *  · `settling` = 回包了，但那份模型是按"还没打勾"的勾选算的 ⇒ 画出来就是错的勾选状态。
   * 并集才是"用户不该看见的内容"。
   */
  const showCenteredLoading = loading || settling

  /** 页头统计带那三格数 + 环形的百分比。取数口径见 `cleanupHeadline` 那段注释。 */
  const headline = useMemo(() => cleanupHeadline(model), [model])

  /**
   * 详情框要显示的那一条 —— **按 id 从当前模型里现取**（见 `detailOf` 那段注释）。
   * 取不到（规则在重算后消失）就当没开，不留一个空框。
   */
  const detailItem = useMemo(
    () => (detailOf === null ? null : (model?.items.find((i) => i.ruleId === detailOf) ?? null)),
    [detailOf, model]
  )

  const running = task?.status === 'running' || task?.status === 'pending'

  /**
   * 一键清理（2026-10-24 改口径，同日加确认阶段）：
   * 点按钮 → 弹窗先显示「预计删除 X / N 项」→ 用户点「确定」才真删。
   *
   * 与旧版的差别都在一条调用上：
   *  · 名单 = 当前勾选（`selected`）+ 从地图加进来的路径（`tilePaths`），不再由服务端固定；
   *  · 没有设置开关；仍然是**真删**（不进回收站），那一条口径没变。
   *
   * 弹窗的责任链：点按钮 → 开弹窗（确认阶段）→ 点确定 → 弹窗订 `dc://clean-progress`
   * 滚列表 → 服务端逐批删。`onDone` 回填 `task` 给页面。
   */
  const executeAuto = useCallback((): void => {
    if (!scanId) return
    setAutoError(null)
    void window.deepclean
      .runAutoClean(
        scanId,
        { items: selected.map((ruleId) => ({ ruleId })) },
        [...tilePaths]
      )
      .then((r) => {
        if (!r.ok) setAutoError(r.error ?? '一键清理被拒')
        if (r.task) setTask(r.task)
      })
      .catch((e: unknown) => setAutoError(String(e)))
  }, [scanId, selected, tilePaths])

  const openDialog = (): void => {
    if (!scanId) return // 没有会话时按钮根本不渲染；这一条只是让类型与事实对齐
    if (!model || model.items.length === 0 || model.totalBytes === 0) return
    setDialogOpen(true)
  }

  if (!scanId || !snapshot) return <CleanupEmptyState />

  return (
    <div className="dc-clean">
      {/* 标题行：左侧标题 + 右侧那颗主行动按钮。与首页「开始深度扫描」同一套样式与视觉权重
          （`.dc-cta`，见 `styles/global.css` 的 `ctaBlue` 判据），所以它在这一页也是最响的东西。 */}
      {/*
        标题行：左侧「清理预览」+ **紧随其后的预计释放量**（人类伙伴 2026-10-20：
        「一键清理下方没有预计释放多少空间，本次清理预计共释放多少」）。
        释放量放在标题这一行而不是表格底下：它是这一页唯一的结论数字，
        读的人第一眼就该看到"这一趟能省多少"，而不是滚到底才看见。

        数字来自 `model.totalBytes` —— 与统计带那格「预计可释放」、与表格「计入预估」列
        是**同一个字段**，不另算一份（另算一份就是第二套真相）。
      */}
      <div className="dc-clean-head">
        <div className="dc-clean-headline">
          <h2 className="dc-page-title dc-clean-title">清理预览</h2>
          {model && (
            <span className="dc-clean-release">
              预计释放 <b className="dc-mono">{formatBytes(model.totalBytes)}</b>
            </span>
          )}
        </div>
        {/*
          一键清理（2026-10-24 改口径）：清**勾选的内容**，点下去开弹窗、边删边滚。
          名单不再由服务端固定，也不再读设置开关 —— 点一下就走。

          两个禁用条件是**同一份事实**的两种说法，不是两种猜：
          - 扫描没完成 ⇒ 报告不完整，此时清理等于按半份清单删；
          - 正在清理 ⇒ 一个会话同时只跑一批。
        */}
        <button
          className="dc-cta dc-clean-cta"
          disabled={running || snapshot.status !== 'completed' || blocked || model === null || model.totalBytes === 0}
          title={
            running
              ? '正在清理，一个会话同时只跑一批'
              : snapshot.status !== 'completed'
                ? '等这一轮扫描完成 —— 没扫完时的报告不完整，此时清理等于按半份清单删'
                : blocked
                  ? '保护未落地，这份预估不许执行'
                  : model !== null && model.totalBytes === 0
                    ? '没有计入预估的项目可清理'
                    : '清理勾选的内容（直接删、不进回收站），过程在弹窗里逐条显示'
          }
          onClick={openDialog}
        >
          <SparkleIcon size={17} />
          一键清理
          <ChevronRightIcon size={16} />
        </button>
      </div>

      {/* 「扫描根 C:\ …」这句按人类伙伴 2026-10-20 的要求删掉了 —— 标题行已经说明这是哪一趟
          清理的预览，而那一行在窄窗上还会把它挤成两行。
          但**扫描没完成那句警告必须留**：它讲的是"下面的数字不等于全盘"，
          删掉它就会让人把半份账当成全份。所以这句现在只在真需要时说。 */}
      {snapshot.status !== 'completed' && (
        <p className="dc-warn">
          本次扫描状态是「{snapshot.status}」，下面的数字只是已扫到的部分，不等于全盘
        </p>
      )}

      {/* 提权与失败原因（2026-10-25 人类伙伴：「清理界面加个提示（部分清理可能需要管理员权限）」）。
          **放在页面上而不是只放确认弹窗里**：用户在这一页就要决定勾哪些、点不点「一键清理」，
          而"有些东西删不掉"这件事会影响他怎么读那个「预计释放」。等到弹窗才说已经晚了一步。
          措辞按本程序的**真实状态**写：manifest 已是 `requireAdministrator`，启动就带管理员令牌，
          所以对用户说「可能需要管理员权限」会让他去找一个不存在的按钮。真正还会失败的是另外两类
          （实测：2167 条里 14 条被在跑的进程锁着、3 条只有 TrustedInstaller 能删），
          这两类提权也救不回来 —— 所以这句话承诺的是「逐条列出」，不是「都能删掉」。
          2026-10-27 人类伙伴改口径（与空状态那段同一句，两处必须逐字相同）。 */}
      <p className="dc-muted dc-fineprint dc-clean-admin-hint">
        本程序已使用管理员权限。删除后无法找回；部分被占用的文件无法删除属于正常现象。
      </p>

      {/*
        居中大 Loading（人类伙伴 2026-10-21：「首次打开 Loading 加特效放中间放大些，用白色字体」）。

        **只在"还没有可用内容"时出现**：`!model`（还没回包）或 `settling`（回包了但还没反映
        自动打勾 —— 那一相一旦被画出来，就是人类伙伴说的"界面出来了，loading，自动打勾"）。
        两者都盖住 ⇒ 用户看到的第一屏就是**已打勾**的那一页。

        它独占整块内容区（`.dc-revalue-stage`），不再是工具栏里的一格：
        首次打开时页面上本来什么都没有，居中放大才是对的读法。
      */}
      {showCenteredLoading && !error && (
        <div className="dc-revalue-stage">
          <RevalueLoading />
        </div>
      )}

      {error && <p className="dc-warn">{error}</p>}

      {model && !showCenteredLoading && model.items.length === 0 && (
        <p className="dc-empty">
          本次扫描范围内没有任何规则命中。不是「坏了」：登记表的地盘都在扫描根之外，或那些目录本来就是空的。
          {model.reportExclusionCount > 0 && <> 另有 {model.reportExclusionCount} 条排除记录在报告里点名。</>}
        </p>
      )}

      {model && !showCenteredLoading && (
        <>
          {blocked && (
            <p className="dc-warn">
              🔴 保护没有落地（禁止根解析不出来）→ 这份预估一律给 0，也不会给出任何「可以清」的结论。
            </p>
          )}

          {/* 统计带（图二那一条）：左边一个环，右边三格数。
              三个数**全部读服务端字段**，界面只做一次除法（见 `cleanupHeadline` 那段注释）。 */}
          <div className="dc-clean-stats">
            <div className="dc-clean-stats-ring">
              <Donut
                size={104}
                variant="sm"
                pct={headline.pct}
                label={formatBytes(headline.plannedBytes)}
                sub="可清理"
                ariaLabel={`预计释放 ${formatBytes(headline.plannedBytes)}，占报告可回收合计 ${formatBytes(headline.reclaimBytes)} 的 ${headline.pct.toFixed(0)}%`}
              />
            </div>
            <div className="dc-clean-stats-cells">
              <div className="dc-clean-stat">
                <span className="dc-clean-stat-ic">
                  <LayersIcon size={16} />
                </span>
                <div>
                  <div className="dc-clean-stat-label">扫描项</div>
                  <div className="dc-clean-stat-value dc-mono">{headline.items} 项</div>
                </div>
              </div>
              <div className="dc-clean-stat">
                <span className="dc-clean-stat-ic">
                  <FileIcon size={16} />
                </span>
                <div>
                  <div className="dc-clean-stat-label">可回收（报告合计）</div>
                  <div className="dc-clean-stat-value dc-mono">{formatBytes(headline.reclaimBytes)}</div>
                </div>
              </div>
              <div className="dc-clean-stat dc-clean-stat-accent">
                <span className="dc-clean-stat-ic">
                  <SparkleIcon size={16} />
                </span>
                <div>
                  <div className="dc-clean-stat-label">预计可释放</div>
                  <div className="dc-clean-stat-value dc-mono">{formatBytes(headline.plannedBytes)}</div>
                </div>
              </div>
            </div>
          </div>

          {/* 工具栏：勾选的全选 / 清空 / 计数。放在卡片上方而不是再画一颗按钮在别处，
              因为列头那一行要留给「项目 / 风险 / 占用 / 文件 / 计入预估」这五格 ——
              它们必须与下面每一行的格线对齐。

              ⚠️ 这里**不再挂 Loading**。上一版挂在计数与按钮之间，理由是"勾选时不闪"；
              而人类伙伴 2026-10-21 最终要的是「首次打开放中间放大」——
              一个页面只该有一个加载位置，两处各画一个会让人以为有两件事在跑。
              勾选之后的重算本来就不显示 Loading（`shouldShowLoading` 已经保证），
              所以这一行现在永远是纯工具栏。 */}
          <div className="dc-clean-toolbar">
            <span className="dc-muted dc-clean-toolbar-count">
              已勾 {selected.length} 项 · 计入 {model.items.filter((i) => i.included).length} 项
            </span>
            <button
              className="dc-btn dc-btn-xs"
              disabled={blocked || running || selectableIds.length === 0}
              onClick={() => {
                touch()
                onSelectedChange(selectableIds)
              }}
            >
              全选可清理项
            </button>
            <button
              className="dc-btn dc-btn-xs"
              disabled={running || selected.length === 0}
              onClick={() => {
                touch()
                onSelectedChange([])
              }}
            >
              清空勾选
            </button>
          </div>

          {/* 条目区：一张卡片装所有行。勾选框仍然由 `.dc-clean-check` 包着、仍然是 15×15 ——
              `--shot` 有二十多步点它并读 `checked`，尺寸与命中面积都不许动。 */}
          <div className="dc-clean-list">
            <div className="dc-clean-list-head">
              <span className="dc-clean-list-head-title">项目</span>
              <span className="dc-clean-list-head-risk">风险</span>
              {/* 三个数字列**装在一格里**（`.dc-clean-list-head-nums`）而不是三格：
                  窄窗装不下七列时，整组能一起换到第二行，而"占用/文件/计入预估"三个标签
                  仍然各自对在自己那列数字之上。三条独立格子做不到这件事 ——
                  第一版就是三条独立格子，572 px 视口下描述列被压成 0 宽，整行只剩 6 格。 */}
              <span className="dc-clean-list-head-nums">
                <span>占用</span>
                <span>文件</span>
                <span>计入预估</span>
              </span>
            </div>

            <ul className="dc-clean-rows">
              {model.items.map((i) => {
                const untouchable = i.riskLevel === 'forbidden' || blocked
                // 勾选框的显示**以本地勾选为准**（`rowChecked` 那段注释）：点击立刻反映，
                // 不等服务端回包。服务端那份 `i.selected` 只做兜底，并继续喂
                // `modelMatchesSelection` 判"这份模型是否已反映当前勾选"。
                const checked = rowChecked(i, selected)
                const Icon = categoryIcon(i.category)
                return (
                  <li key={i.ruleId} className={`dc-clean-row${i.included || checked ? ' dc-clean-row-on' : ''}`}>
                    <span className="dc-clean-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={untouchable || running}
                        title={untouchable ? '🔴 项目不可勾选（§16：禁止通过普通清理按钮直接删除）' : undefined}
                        onChange={() => toggle(i.ruleId)}
                        aria-label={`${i.name}（${RISK_LABELS[i.riskLevel as Risk]}）`}
                      />
                    </span>
                    {/* 图标砖：颜色跟着风险走，形状跟着 category 走 —— 两者都不是界面猜的。 */}
                    <span
                      className="dc-clean-row-ic"
                      style={{ borderColor: riskDot(i.riskLevel), color: riskDot(i.riskLevel) }}
                      aria-hidden="true"
                    >
                      <Icon size={17} />
                    </span>
                    <div className="dc-clean-row-main">
                      <div className="dc-clean-row-title">
                        <span className="dc-clean-name">{i.name}</span>
                        {/* 一句话概况（最简模式）。其余全部进「查看详情」—— 人类伙伴 2026-10-23：
                            「详情内容为最简模式(一段话概况核心内容)，加入查看详情，点击出现详情框」。 */}
                        <button
                          className="dc-link dc-clean-more"
                          onClick={() => setDetailOf(i.ruleId)}
                          aria-label={`查看 ${i.name} 的详情`}
                        >
                          查看详情
                        </button>
                      </div>
                      <div className="dc-muted dc-clean-row-desc">
                        {itemSummary(i)}
                        {i.scope === 'paths' && i.included && ' · 按已枚举路径计价'}
                        {i.sampleTruncated && !i.included && ' · 报告只回显了采样路径'}
                      </div>
                      {i.refusal && (
                        <div className="dc-muted dc-fineprint dc-clean-refused">
                          {REFUSAL_LABEL[i.refusal.reason] ?? i.refusal.reason}
                        </div>
                      )}
                    </div>
                    <span className="dc-clean-row-risk">
                      {/* 文字用去掉 emoji 的 `RISK_LABELS`，圆点颜色取 `RISK_COLORS` 同一张表 */}
                      <span className="dc-badge dc-badge-risk" style={{ borderColor: riskDot(i.riskLevel) }}>
                        <i className="dc-risk-dot" style={{ background: riskDot(i.riskLevel) }} aria-hidden="true" />
                        {(riskText(i.riskLevel as Risk))}
                      </span>
                    </span>
                    <span className="dc-clean-row-nums">
                      <span className="dc-clean-row-num dc-mono">{formatBytes(i.findingBytes)}</span>
                      <span className="dc-clean-row-num dc-mono">{i.findingFiles}</span>
                      {/* 「计入预估」仍然只认服务端的 `included` —— 它必须与「预计释放」
                          那个总数字同源（都来自 `model.totalBytes` 的逐行拆分），
                          本地勾上而模型还没回包时这里显示「—」是诚实的：
                          那一格的字节数还没算出来，先画一个数就是编。 */}
                      <span className="dc-clean-row-num dc-mono dc-clean-row-est">
                        {i.included ? formatBytes(i.bytes) : '—'}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>

          {/* 详情框：按 `detailOf` 从**当前模型**里现取那一条（不存快照，见那个 state 的注释）。
              挂在 Portal 里而不是这一棵树的某处：它是浮层，祖先一旦带 `backdrop-filter`
              （这页到处都是玻璃卡）就会在那一层内部重排，浮不到最上面。 */}
          {detailItem && <ItemDetail item={detailItem} onClose={() => setDetailOf(null)} />}

          {tilePaths.length > 0 && (
            <div className="dc-clean-tiles">
              <div className="dc-clean-tiles-head">
                <span>从空间地图加入的 {tilePaths.length} 个文件</span>
                <button className="dc-link" onClick={onClearTilePaths}>
                  全部移除
                </button>
              </div>
              <ul className="dc-clean-tiles-list">
                {tilePaths.map((p) => {
                  const priced = model?.items.flatMap((i) => i.paths).find((x) => x.path === p)
                  return (
                    <li key={p}>
                      <code className="dc-mono">{p}</code>
                      <span className="dc-muted">{priced ? formatBytes(priced.size) : '未定价'}</span>
                      <button className="dc-link" onClick={() => onRemoveTilePath(p)}>
                        移除
                      </button>
                    </li>
                  )
                })}
              </ul>
              {(payload?.unclaimedTilePaths?.length ?? 0) > 0 && (
                <p className="dc-warn">
                  其中 {payload?.unclaimedTilePaths?.length} 个不属于任何清理规则的地盘，没有进勾选（归属由规则引擎自己的认领表反查，不靠路径猜）：
                  {payload?.unclaimedTilePaths?.map((p) => (
                    <code className="dc-mono" key={p}>
                      {' '}
                      {p}{' '}
                    </code>
                  ))}
                </p>
              )}
            </div>
          )}

          {/* 「全选可清理项 / 清空勾选 / 已勾 N 项」搬到了列表列头那一行（图二正好有那一行）。
              这里不再画第二组 —— 同屏两个控件写同一份 state 是本项目定过的形状缺陷。 */}

          <p className="dc-muted dc-fineprint">
            页头那颗「一键清理」清的是**当前勾选的内容**（含从空间地图加入的路径），
            直接删除、不进回收站，过程在弹窗里逐条显示，明细看「记录」页。
          </p>
          {autoError && <p className="dc-warn">{autoError}</p>}

          {/*
            总量条：**保留原来的形状**（大号数字在前，紧跟「预计释放 · N 个文件」）。
            不是舍不得它，是这里有一条别人在量的契约：`scripts/m5n-tile-dup-e2e.ps1` 的
            `Read-Total` 用「`([0-9.]+ ?(?:B|KB|MB|GB|TB))预计释放`」这一条正则读预估的字节数，
            而全页只有这一格是"数字在前、那句话在后"。把它改成统计带那种"标签在前"的形状，
            那一棒会在没有任何产品缺陷的情况下红在"读不出预估那两个数"上。
            （`m5-preview` / `m5c-tile` 只等「预计释放」「清理预览」这几个字当页面地标，不受影响。）

            数字仍然来自 `model.totalBytes` —— 与页头那句、与统计带那格是**同一个字段**。
            三处同源不是第二套真相；另算一份才是。
          */}
          <div className="dc-clean-total">
            <div className="dc-clean-total-num dc-mono">{formatBytes(model.totalBytes)}</div>
            <div className="dc-muted">
              预计释放 · {model.totalFiles} 个文件
              {model.refusedBytes > 0 && <> · 另有 {formatBytes(model.refusedBytes)} 被拒，没算进来</>}
            </div>
            {/* 人类伙伴 2026-10-20：「加入预计释放多少 G 的空间」。上面那格已经是释放量，
                但它是 `formatBytes` 的自动单位（可能显示成 412.3 MB），而用户问的是「几个 G」。
                这里补一句**同一口径**的 G 读数，不是第二套算法：分母就是上面那个 totalBytes。
                只在够 1 GB 时出现 —— 0.02 GB 那种数字读起来像噪声，反而让人以为没清出东西。 */}
            {model.totalBytes >= 1024 ** 3 && (
              <div className="dc-muted dc-mono">
                约 {(model.totalBytes / 1024 ** 3).toFixed(2)} GB
              </div>
            )}
          </div>

          <div className="dc-badges">
            {(['safe', 'caution', 'high', 'forbidden'] as Risk[]).map((r) => (
              <span key={r} className="dc-badge dc-badge-risk" style={{ borderColor: RISK_COLORS[r] }}>
                {RISK_LABELS[r]} {formatBytes(model.riskBreakdown[r].bytes)} / {model.riskBreakdown[r].files} 文件
              </span>
            ))}
          </div>
          <p className="dc-muted dc-fineprint">
            风险分账只统计「已计入」的项目，所以 🔴 恒为 0 —— 它出现在上面的表格里是为了如实报告占用，不是「可以清」。
            {model.totalBytes === model.reportReclaimableBytes && selected.length > 0 && (
              <> 当前预估与报告的可回收合计（{formatBytes(model.reportReclaimableBytes)}）逐字节相等。</>
            )}
          </p>

          {model.notes.length > 0 && (
            <ul className="dc-clean-notes">
              {model.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}

          {model.refusals.length > 0 && (
            <details className="dc-clean-details">
              <summary>被拒的勾选（{model.refusals.length} 条，逐条点名）</summary>
              <ul>
                {model.refusals.slice(0, 30).map((r, idx) => (
                  <li key={`${r.reason}-${r.path ?? 'item'}-${idx}`}>
                    {REFUSAL_LABEL[r.reason] ?? r.reason} · {r.path ?? r.ruleId ?? '整项'} · {formatBytes(r.bytes)}
                  </li>
                ))}
                {model.refusals.length > 30 && <li className="dc-muted">…其余 {model.refusals.length - 30} 条见日志</li>}
              </ul>
            </details>
          )}

          {(model.forbiddenRoots.length > 0 || model.reportOnlyRoots.length > 0) && (
            <p className="dc-muted dc-fineprint">
              本次生效的 🔴 禁止根：{model.forbiddenRoots.join('、') || '（无）'}。
              {model.reportOnlyRoots.length > 0 && (
                <> 只报告占用、任何规则都不可清理的目录：{model.reportOnlyRoots.join('、')}。</>
              )}
            </p>
          )}

          {/*
            2026-10-24：手动档那一整块（🟠 高风险清单 / 确认预估 / 开始清理 / 取消清理）删掉了。
            人类伙伴当天定的是「合并成一颗」—— 现在唯一的执行入口是页头那颗「一键清理」。
            底下的旧按钮与它写同一份勾选、同一份 task state，正是本仓反复点名的形状缺陷。
            风险档位那套确认在服务端仍全量在（`build_preview` + `required_tier` 口径），
            只是界面上不再有一个"确认预估"的步骤 —— 按下那颗按钮就是确认。
          */}
        </>
      )}

      {task && <TaskPanel task={task} />}

      {/*
        过程弹窗（2026-10-24，同日加确认阶段）。挂在 Portal：它要浮在整页玻璃之上。
        打开的条件是 `dialogOpen`（点按钮那一刻置位）。确认前只显示「将删多少」，
        点「确定」才由 `executeAuto` 开删；任务 id 由弹窗从第一条事件里认领。
      */}
      {dialogOpen && (
        <CleanProgressDialog
          onClose={() => setDialogOpen(false)}
          onDone={(t) => setTask(t)}
          start={executeAuto}
          plannedBytes={model?.totalBytes ?? 0}
          plannedItems={model?.items.filter((i) => i.included).length ?? 0}
        />
      )}
    </div>
  )
}

/**
 * §18 任务态 + §19 清理后验证。所有数字都来自服务端任务视图，本页不做任何加减。
 *
 * 导出的原因和 `SkipPanelBody` 一样：这一格的措辞是**呈现层唯一会替 §19 背书的地方**
 * （旧那句「（完全吻合）」），不导出就渲染不到、也就测不到。
 */
/**
 * 一键清理的**过程弹窗**（2026-10-24，人类伙伴：「点击清理后出现弹窗显示清理的文件列表
 * （类似扫盘时出现的文件列表一样）下方是清理进度条（百分比），完成后提示清理完成释放 XX 空间」）。
 *
 * 数据流分两条，各管一半：
 *  · 逐条进度（`dc://clean-progress`）→ 滚列表 + 进度条。列表里的行**只从这里来**，
 *    不是从 `task.deleted[]` 一次性画出来 —— 那样的话"边清边滚"就不成立，
 *    弹窗打开的第一帧和最后一帧长得一样（M6 之前的真机就是那个样子）。
 *  · 收尾快照（`dc://clean` 的 done）→ 完成那一行"清理完成，共释放 XX 空间"。
 *
 * 已滚出来的行不随重渲染回滚：行缓冲在 effect 闭包外的局部数组里，逐帧灌进 state；
 * 组件卸载前会 unsubscribe，行数上限防一万一（`MAX_LINES`）。
 *
 * 三条边界：
 *  · 弹窗开着的时候下面那个按钮**仍按原样走**（它已经进入 running 态），
 *    弹窗只读、不写任何 state 回页面 —— 页面的 state 由 `Cleanup` 组件自己收事件；
 *  · `done` 之后弹窗**不自动关**：人类伙伴要的是"完成后提示"，用户自己点「关闭」。
 *    自动关掉会把那行"释放 XX 空间"从人眼前拿走；
 *  · 关闭弹窗 ≠ 取消任务。取消是另一个动作（现在执行链路里没有取消按钮了），
 *    关闭只是"不看过程"，结果照常在页面上出。
 */
export function CleanProgressDialog({
  onClose,
  onDone,
  start,
  plannedBytes,
  plannedItems
}: {
  onClose: () => void
  /** 收尾快照到了（`kind:'done'`）—— 调用方用它把 `task` 落进页面 state。 */
  onDone: (task: CleanTask) => void
  /**
   * 真正开删的动作，由**调用方**注入（`runAuto` 那份，含选区拼装）。
   * 为什么不在弹窗里自己拼：选区是调用方的 state（`selected` / `tilePaths`），
   * 弹窗只做「先确认、再执行」这一层 —— 判断与执行分开，弹窗没有自己的第二份勾选。
   * 注入而不是在弹窗里重新实现，还省掉一次"选区从哪来"的第二套真相。
   */
  start: () => void
  /** 确认阶段那句「预计删除 X / N 项」—— 数字由调用方从当前模型读，弹窗不另算。 */
  plannedBytes: number
  plannedItems: number
}): JSX.Element {
  /** 确认阶段：false = 显示「将删除 N 项 / X」，等用户点「确定」。 */
  const [confirmed, setConfirmed] = useState(false)
  const [lines, setLines] = useState<CleanProgressEvent[]>([])
  const [done, setDone] = useState<CleanTask | null>(null)
  const [pct, setPct] = useState(0)
  const [liveCleaned, setLiveCleaned] = useState(0)
  /** 列表的 DOM 引用：新行灌进来后自动滚到底（否则用户只能看见最上面几行不动）。 */
  const listRef = useRef<HTMLUListElement | null>(null)

  /**
   * 认领到的任务 id。挂载时**不知道**（`dc_auto_clean` 要等删完才回 taskId），
   * 第一条进度事件或 done 事件到了才认领。认领之前**接受全部事件**：
   * 本应用单窗口、一次只跑一批清理，弹窗打开期间的事件只可能属于这一趟。
   */
  const runningIdRef = useRef<string | null>(null)
  /** `onDone` 的身份每次父渲染都会变，effect 不能把它写进依赖 —— 放进 ref。 */
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  /**
   * 订阅必须用 `useLayoutEffect` 而不是 `useEffect`：点击 → `setDialogOpen(true)` →
   * `invoke('dc_auto_clean')` 在同一拍发生，而 React 的 passive effect 要等绘制之后才跑。
   * 服务端删第一批文件只要几十毫秒，被动 effect 有真实风险错过开头几条进度事件。
   * `useLayoutEffect` 在提交阶段同步执行 —— 早于 invoke 的 Promise 链、更早于任何
   * 跨 IPC 的事件到达，所以第一条也不会漏。
   *
   * 确认之前**不订阅进度**（也没有事件可收 —— `start` 都还没被调）。
   * 订阅只在 `confirmed` 置位后建立：这样"点确定之前的任何残留事件"都不会被吞进本弹窗。
   */
  useLayoutEffect(() => {
    if (!confirmed) return
    // 行缓冲区**必须**活在 effect 外面：事件以 40ms 一条的速度进来，
    // 而 `setLines` 是异步批量 —— 直接 `setLines(prev => [...prev, e])` 在快速批里
    // 会丢行（React 18 的批处理只保证最后状态正确，不保证中间那批全加进去）。
    // 局部缓冲 + 一个"还没把缓冲灌进 state"的记号，才能保证不丢。
    const buf: CleanProgressEvent[] = []
    let flushing = false
    const flush = (): void => {
      if (flushing) return
      flushing = true
      // 下一帧统一灌一次：既不掉行，也不每 40ms 触发几十次渲染
      requestAnimationFrame(() => {
        setLines((prev) => [...prev, ...buf.splice(0)].slice(-MAX_LINES))
        // 灌完滚到底：新行在底部出现，列表看起来是"边删边滚"而不是"顶部几行动都不动"。
        // 放同一帧里，滚动与渲染合并成一次绘制。
        if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
        flushing = false
      })
    }

    const offProgress = window.deepclean.onCleanProgress((e) => {
      if (runningIdRef.current !== null && e.taskId !== runningIdRef.current) return
      if (runningIdRef.current === null) runningIdRef.current = e.taskId
      buf.push(e)
      setPct(e.total > 0 ? Math.min(100, (e.done / e.total) * 100) : 0)
      setLiveCleaned(e.cleanedSize)
      flush()
    })
    const offDone = window.deepclean.onCleanEvent((e) => {
      if (runningIdRef.current !== null && e.task.id !== runningIdRef.current) return
      if (runningIdRef.current === null) runningIdRef.current = e.task.id
      if (e.kind === 'done') {
        setDone(e.task)
        setPct(100)
        setLiveCleaned(e.task.cleanedSize)
        onDoneRef.current(e.task)
      }
    })
    return () => {
      offProgress()
      offDone()
      buf.length = 0
    }
  }, [confirmed])

  return (
    <Portal>
      <div className="dc-modal-mask" role="presentation">
        <div
          className="dc-modal dc-clean-progress-modal"
          role="dialog"
          aria-modal="true"
          aria-label="正在清理"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="dc-modal-head">
            <div className="dc-clean-detail-title">
              <span className="dc-clean-row-ic" aria-hidden="true">
                <TrashIcon size={17} />
              </span>
              <h3 className="dc-modal-title">
                {!confirmed ? '确认清理' : done ? '清理完成' : '正在清理'}
              </h3>
            </div>
            <button className="dc-modal-x" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>

          {!confirmed ? (
            /* 确认阶段（人类伙伴 2026-10-24：「加入这个提示，确定后执行清理」）。
               只显示"将删多少"，不订事件、不显示列表 —— 用户还没说删。 */
            <div className="dc-clean-confirm-stage">
              <p className="dc-clean-confirm-desc">
                将按当前勾选执行清理，删除的文件<strong>不进回收站、无法恢复</strong>。
              </p>
              {/* 确认阶段这句**不重复页面上那条**（2026-10-25）：页面那条讲的是"本程序以管理员运行、
                  但仍有两类删不掉"这个常驻事实；这里讲的是"这一次按下去会怎样"。
                  两处说的是不同的东西，不是同一句话说两遍。 */}
              <p className="dc-muted dc-fineprint dc-clean-admin-hint">
                删不掉的条目会标成失败并逐条列出，它们不计入释放空间。
              </p>
              <div className="dc-clean-confirm-summary">
                预计删除 <b className="dc-mono">{formatBytes(plannedBytes)}</b> · {plannedItems} 项
              </div>
              <div className="dc-clean-confirm-actions">
                <button className="dc-btn" onClick={onClose}>
                  取消
                </button>
                <button
                  className="dc-primary dc-clean-confirm-go"
                  onClick={() => {
                    setConfirmed(true)
                    // 订阅 effect 由 `confirmed` 触发、在提交阶段建立 —— 之后才开删，
                    // 第一条进度事件不会漏（与 useLayoutEffect 那段注释同一条理由）。
                    start()
                  }}
                >
                  确定，开始清理
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* 文件列表：与扫盘时的列表同一读法 —— 一行一条路径，按删除发生的那一刻滚进来。
                  只渲染**最后 `VISIBLE_LINES` 行**（2026-10-24：滚动卡顿的修法）。
                  列表滚得飞快时全量重渲 400 行 `<li>` 会让弹窗掉帧 —— 截尾渲染 + 自动
                  滚到底，视觉上就是"文件一条条往上冒"，而 DOM 永远是常数级。 */}
              <ul className="dc-clean-progress-list" ref={listRef}>
                {lines.slice(-VISIBLE_LINES).map((l, i) => (
                  <li key={`${l.path}-${i}`} className={l.ok ? '' : 'dc-clean-progress-fail'}>
                    <code className="dc-mono">{l.path}</code>
                    {!l.ok && <span className="dc-warn"> · 失败</span>}
                  </li>
                ))}
                {lines.length === 0 && !done && (
                  <li className="dc-muted">正在准备清单…</li>
                )}
                {done && lines.length === 0 && <li className="dc-muted">没有文件被处理。</li>}
              </ul>

              {/* 进度条 + 百分比（人类伙伴：下方是清理进度条（百分比））。 */}
              <div className="dc-clean-progress-bar">
                <div className="dc-meter">
                  <div
                    className="dc-meter-fill"
                    style={{ width: `${Math.min(100, Math.max(0, pct)).toFixed(1)}%` }}
                  />
                </div>
                <span className="dc-mono dc-clean-progress-pct">{pct.toFixed(0)}%</span>
              </div>

              {done ? (
                <p className="dc-clean-progress-done">
                  清理完成，共释放 <b className="dc-mono">{formatBytes(done.cleanedSize)}</b>
                  {done.failedCount > 0 && ` · ${done.failedCount} 条失败`}
                  {done.refusals.length > 0 && ` · ${done.refusals.length} 条被拒`}
                </p>
              ) : (
                <p className="dc-muted dc-fineprint">
                  已释放 <b className="dc-mono">{formatBytes(liveCleaned)}</b> · 处理中的文件会逐条出现在上面
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </Portal>
  )
}

const MAX_LINES = 400
/** 列表一次渲染的最多行数（截尾：只画最新的这一批）。 */
const VISIBLE_LINES = 60

export function TaskPanel({ task }: { task: CleanTask }): JSX.Element {
  const v = task.verification
  /**
   * 卷的可用空间前后两格是不是都有数。§19 那句"磁盘上真省了多少去看可用空间"必须跟着它走 ——
   * 把用户指到一个写着「未采集」的格子前，比不指路更糟（评审 5b Minor）。
   */
  const freeCollected = v?.freeBytesBefore != null && v?.freeBytesAfter != null
  const done = task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed'
  return (
    <section className="dc-clean-task">
      <h3 className="dc-panel-title">
        {task.status === 'running' ? '正在清理' : task.status === 'refused' ? '整批拒绝' : done ? '清理结束' : '清理中'}
        <span className="dc-muted dc-fineprint"> · 任务 {task.id}</span>
      </h3>

      <div className="dc-meter">
        <div className="dc-meter-fill" style={{ width: `${Math.min(100, Math.max(0, task.progress * 100)).toFixed(1)}%` }} />
      </div>
      <p className="dc-muted">
        已释放 {formatBytes(task.cleanedSize)} / 共 {formatBytes(task.totalSize)} · 成功 {task.successCount} · 失败 {task.failedCount} · 拒绝{' '}
        {task.refusals.length} · 状态 {task.status}
      </p>

      {task.blockers.length > 0 && (
        <ul className="dc-clean-refusal-list">
          {task.blockers.map((b, i) => (
            <li key={`b${i}`}>
              授权根：{b.reason} · {b.detail}
            </li>
          ))}
        </ul>
      )}

      {task.refusals.length > 0 && (
        <details className="dc-clean-details" open={task.status === 'refused' || task.status === 'failed'}>
          <summary>被拒绝的条目（{task.refusals.length} 条）</summary>
          <ul className="dc-clean-refusal-list">
            {task.refusals.slice(0, 30).map((r, i) => (
              <li key={`r${i}`}>
                <code className="dc-mono">{r.path}</code> · {r.reason} · {r.detail}
              </li>
            ))}
          </ul>
        </details>
      )}

      {v && (
        <div className="dc-clean-verify">
          <h4 className="dc-panel-title">清理后验证（§19）</h4>
          <dl className="dc-dl">
            <dt>清理前</dt>
            <dd className="dc-mono">{formatBytes(v.rootBytesBefore)}（{v.filesBefore} 个文件）</dd>
            <dt>清理后</dt>
            <dd className="dc-mono">{formatBytes(v.rootBytesAfter)}（{v.filesAfter} 个文件）</dd>
            <dt>预估释放</dt>
            <dd className="dc-mono">{formatBytes(v.predictedFreedBytes)}</dd>
            <dt>实际释放</dt>
            <dd className="dc-mono">{formatBytes(v.actualFreedBytes)}</dd>
            <dt>差额</dt>
            <dd className="dc-mono">
              {formatBytes(Math.abs(v.deltaBytes))}
              {/* 旧文案在这里念「（完全吻合）」—— 可 deltaBytes 量的是两笔"逐路径表观大小之和"的差，
                  两边同口径所以硬链接参与时它照样等于 0。所以这一句只说自己比了什么：表观一致，
                  不是"磁盘真省了这么多被核实过"。口径的盲点与磁盘那一侧的读数由下面那句加注指路。 */}
              {v.deltaBytes === 0 ? '（表观大小一致）' : ''}
            </dd>
            <dt>可用空间</dt>
            <dd className="dc-mono">
              {v.freeBytesBefore === undefined || v.freeBytesBefore === null ? '清理前未采集' : formatBytes(v.freeBytesBefore)} →{' '}
              {v.freeBytesAfter === undefined || v.freeBytesAfter === null ? '未采集' : formatBytes(v.freeBytesAfter)}
            </dd>
          </dl>
          {/*
            评审 5b Minor：这张卡片原本把同一段免责讲两遍 —— 本地写死一段 + 服务端 `v.note` 一段。
            现在只留一份：**口径那句话归服务端**（它和被验的那三个数算在同一处，改口径时一起改），
            本地只在它没给话时兜底。指路那半句单独成段，因为它讲的是"去哪看"，不是口径。
          */}
          <p className="dc-muted dc-fineprint">
            {v.note && v.note.length > 0
              ? v.note
              : '上面「预估释放 / 实际释放 / 差额」三格都是逐路径表观大小之和，不含硬链接的 inode 去重：删掉一个硬链接名字，表观照样少一份而盘上那份字节一个没动。'}
          </p>
          <p className="dc-muted dc-fineprint">
            {freeCollected
              ? '磁盘上真省了多少，看「可用空间」那一格的前后差。'
              : '这次没采到卷的可用空间，所以磁盘那一侧没有独立读数 —— 上面那句就是唯一的口径依据。'}
          </p>
        </div>
      )}
    </section>
  )
}
