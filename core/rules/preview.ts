/**
 * §17 清理预览 —— 「点击清理 ↓ 直接删除」的反面。
 *
 * 项目书要的是一条链：扫描 → 发现可清理项目 → 用户选择 → 预估释放空间 → 确认 → 执行。
 * **本文件实现到「确认为止」**：产出的全是可序列化数据，没有任何删除、没有任务队列、
 * 也没有留给执行方的桩函数（一个 `executeCleanup()` 都不写 —— 桩会招调用者）。
 * §18 的执行入口在 `core/clean/executor.ts` + `electron/services/clean-service.ts`：
 * 它**只认这份回执的 digest**，具体清单由主进程从已扫好的树里另取，本文件不向那边交任何东西。
 *
 * 三条硬约束（都在 `tests/unit/rules-preview.test.ts` 里被证伪过）：
 *
 * 1. **🔴 不可能被选中。** 用的是 Task 16 已有的那两层，不另立第三套「禁止」定义：
 *    - 声明层：规则进不了报告（`validateRuleSet`）→ 这里的 `item-rejected` 只是转述。
 *    - 枚举层：`isForbiddenPath`（本文件 import 它，不重写它）→ 逐项勾选时再判一次，
 *      所以即便报告里出现「🟢 项目名下挂着 System32 路径」这种畸形数据，也照样拒。
 *    被拒的勾选**全部点名留痕**（`PreviewRefusal`），并单独汇总成 `refusedBytes`。
 * 2. **预估只来自已经扫好的树。** 入参是 `RuleReport`（引擎从 `TreeStore` 算出来的）+ 用户选择；
 *    本文件里没有 `node:fs`、没有 `electron`，物理上不可能重新走盘（§28 原则一）。
 *    代价是：逐路径勾选只能给「报告里已枚举的路径」定价，采样的截断由报告如实带出 `sampleTruncated`，
 *    定价不了的记 `path-not-enumerated`，绝不靠再走一次磁盘补齐。
 * 3. **时钟靠注入**（`generatedAtMs` / `confirmedAtMs`），本模块不读 `Date.now()`，结果可复现。
 */
import { normalizeKey } from '../fs/pathutil'
import { isForbiddenPath } from './engine'
// M5-P1 T5a：查规则文案要读表。registry 只 import `./types`（不 import 本文件、也不 import engine），
// 所以这一条边不会成环 —— 与 Rust 侧 `preview.rs` 调 `deepclean_rules::builtin_rules()` 同一姿势。
import { BUILTIN_RULES } from './registry'
import type { RuleFinding, RuleReport } from './types'
import type { Risk } from '../../shared/classify'
import type {
  PreviewBuildOptions,
  PreviewConfirmBlocker,
  PreviewConfirmation,
  PreviewItem,
  PreviewModel,
  PreviewRefusal,
  PreviewRefusalReason,
  PreviewRiskCell,
  PreviewSelection
} from '../../shared/types'

const RISKS: readonly Risk[] = ['safe', 'caution', 'high', 'forbidden']

/** 确认回执里那句实话：回执是**凭据**，不是工作单。 */
const CONFIRM_NOTE =
  '确认回执不含路径清单（一份能直接喂给删除循环的工作单才是危险的东西）；§18 的执行入口只认这份 digest，' +
  '具体清单由主进程从「已扫好的树」里另取，且每条都要重新过 authorizedRoot 的闸'

/**
 * 报告 + 用户选择 → 预览模型。**纯计算**。
 *
 * M5-P1 T5a：每一项都带上**它自己那条规则的文案**（`PreviewItem.description`）。
 * 这句话是「删了会失去什么」的唯一出处（spec §5），两个硬性后果：
 * 1. **只查表、不写文案** —— 查的是 `BUILTIN_RULES`，与 Rust 侧 `builtin_rules()` 同一张表；
 *    表外的 id（`dup:*` 伪项、夹具自定义规则集）留空串。
 * 2. **它进 digest 的覆盖字段**，两份口径都进 —— 见 `digestOf` 上面那段。
 */
export function buildPreviewModel(
  report: RuleReport,
  selection: PreviewSelection,
  o: PreviewBuildOptions
): PreviewModel {
  // 规则文案表：按 ruleId 取，整次构建查一遍。同一 id 只认第一条 —— 与下面 byRule 对 findings 同口径。
  const ruleDescriptions = new Map<string, string>()
  for (const r of BUILTIN_RULES) if (!ruleDescriptions.has(r.id)) ruleDescriptions.set(r.id, r.description)

  const forbiddenRoots = report.forbiddenRoots ?? []
  /**
   * 「只上报不可删」根（回收站那一类）。注意它**不参与** `blocked` 判据：
   * 这张表为空只意味着这份报告没带第二类防护，而真正兜住删除的是执行器 —— 它永远按 registry 默认名单再判一次，
   * 所以这里不许因为报告缺字段就宣布整份预览无效（那会把 Task 17 已有的断言全冲掉）。
   */
  const reportOnlyRoots = report.reportOnlyRoots ?? []
  /**
   * 🔴 保护是否真的在线。`safetyBlocked` 是引擎自己承认「禁止根落不了地」；
   * 禁止根为空则等价于「这台报告根本没带保护」——两种情况都不许给出可清理结论。
   */
  const blocked = report.safetyBlocked || forbiddenRoots.length === 0
  const blockedDetail = report.safetyBlocked
    ? '报告处于 safetyBlocked 状态：§16 🔴 禁止路径没能落地（环境变量缺失）→ 预览不给出任何「可清理」结论'
    : '报告的禁止根清单为空 = 🔴 保护不在线 → 预览不给出任何「可清理」结论（宁可说 0，也不猜能清）'

  const findings = report.findings
  const byRule = new Map<string, RuleFinding>()
  for (const f of findings) if (!byRule.has(f.ruleId)) byRule.set(f.ruleId, f)

  const refusals: PreviewRefusal[] = []
  const refuse = (
    scope: PreviewRefusal['scope'],
    ruleId: string | null,
    path: string | null,
    reason: PreviewRefusalReason,
    detail: string,
    bytes: number
  ): PreviewRefusal => {
    const r: PreviewRefusal = { scope, ruleId, path, reason, detail, bytes }
    refusals.push(r)
    return r
  }

  /** 每个 ruleId 的第一条拒绝挂回 item 上，让 UI 能在该行说明为什么没算进去 */
  const itemRefusal = new Map<string, PreviewRefusal>()
  const selectedRules = new Set<string>()
  const ruleScope = new Set<string>()
  /** 逐路径勾选的候选，保留用户勾选顺序（拒绝记录的顺序因此也可复现） */
  const pathEntries: Array<{ ruleId: string; paths: readonly string[] }> = []

  const entries = Array.isArray(selection?.items) ? selection.items : []
  if (!Array.isArray(selection?.items))
    refuse('item', null, null, 'unknown-rule', '选择结构非法：PreviewSelection.items 必须是数组 → 整份选择被忽略', 0)

  for (const raw of entries) {
    const ruleId = typeof raw?.ruleId === 'string' && raw.ruleId.length > 0 ? raw.ruleId : null
    if (ruleId === null) {
      refuse('item', null, null, 'unknown-rule', '勾选项缺少合法的 ruleId（渲染进程只能按报告里给出的项来勾选）', 0)
      continue
    }
    const f = byRule.get(ruleId)
    selectedRules.add(ruleId)

    if (blocked) {
      const first = !itemRefusal.has(ruleId)
      const r = refuse(
        'item',
        ruleId,
        null,
        'safety-blocked',
        `${blockedDetail}；项目「${f?.name ?? ruleId}」的 ${f?.totalBytes ?? 0} 字节没有算进预估`,
        first ? (f?.totalBytes ?? 0) : 0
      )
      if (first) itemRefusal.set(ruleId, r)
      continue
    }

    if (f === undefined) {
      const rej = report.rejectedRules.find((x) => x.ruleId === ruleId)
      if (rej !== undefined) {
        const why = rej.problems.map((p) => p.reason).join('、') || '未记录具体原因'
        refuse(
          'item',
          ruleId,
          null,
          'item-rejected',
          `规则「${rej.name}」在 §15 声明层就被 validateRuleSet 拒了（${why}），报告里没有它 → 不计入预估`,
          0
        )
      } else {
        refuse(
          'item',
          ruleId,
          null,
          'unknown-rule',
          `报告里没有 id 为「${ruleId}」的可清理项目（勾选必须点名到报告里的项）→ 不计入预估`,
          0
        )
      }
      continue
    }

    // §16：🔴 项目照常识别容量，但禁止通过普通清理按钮直接删除 → 勾选即拒绝
    if (f.riskLevel === 'forbidden') {
      const first = !itemRefusal.has(ruleId)
      const paths = Array.isArray(raw.paths) ? raw.paths : []
      const r = refuse(
        'item',
        ruleId,
        null,
        'forbidden-risk',
        `「${f.name}」是 §16 🔴 禁止项目：${f.totalBytes} 字节 / ${f.fileCount} 个文件照常识别，但不进预估、不可通过普通清理勾选（策略 ${f.cleanStrategy}）`,
        first ? f.totalBytes : 0
      )
      if (first) itemRefusal.set(ruleId, r)
      for (const p of paths)
        refuse('path', ruleId, p, 'forbidden-risk', `整项已被拒为 🔴 禁止项目，这条路径同样不计入预估`, 0)
      continue
    }

    const paths = raw.paths
    if (paths === undefined || paths === null) {
      if (ruleScope.has(ruleId)) {
        refuse(
          'item',
          ruleId,
          null,
          'duplicate-selection',
          `「${f.name}」已按整项勾选，重复勾选不重复计价（已计入 ${f.totalBytes} 字节）`,
          0
        )
      } else {
        ruleScope.add(ruleId)
      }
      continue
    }
    if (!Array.isArray(paths)) {
      refuse(
        'item',
        ruleId,
        null,
        'path-not-enumerated',
        `「${f.name}」的 paths 字段不是数组 → 这次勾选无法定价（不猜、不重新走盘）`,
        0
      )
      continue
    }
    if (paths.length > 0) pathEntries.push({ ruleId, paths })
  }

  /* ---------------- 逐项组装（顺序 = 报告 findings 顺序，可复现） ---------------- */

  /** 全局去重：同一路径在整个预览里只计一次钱（引擎的 claimed 表已保证，这是第二道保险） */
  const pricedKeys = new Set<string>()
  const items: PreviewItem[] = []
  const riskBreakdown = emptyBreakdown()
  let totalBytes = 0
  let totalFiles = 0

  for (const f of findings) {
    const selected = selectedRules.has(f.ruleId)
    const entry = pathEntries.filter((e) => e.ruleId === f.ruleId)
    const whole = !blocked && ruleScope.has(f.ruleId)
    const scope: PreviewItem['scope'] = whole ? 'rule' : 'paths'
    let bytes = 0
    let files = 0
    const priced: Array<{ path: string; size: number }> = []

    if (whole) {
      bytes = f.totalBytes
      files = f.fileCount
      // ⚠ 已知分叉（2026-10-13 量出并只修了 Rust 侧）：上面那行按整项发价时
      // 不看 `pricedKeys`，所以「整项勾选的一条路径又被逐路径勾选表达一次」在这里会**各计一次钱**。
      // 这一形制在 §12（地图「加入清理列表」）+ §20（重复组）同时勾选时是真会发生的：
      // §20 的伪项不参与引擎的 claimed 表，它的一份待删路径可以同时是某条规则地盘里的文件。
      // 真机量实的是同一个 5 MiB 文件被算成 10.0 MB / 2 个文件。Rust 侧（`crates/cleaner/src/preview.rs`
      // 的 `if whole`）已改成"让给先计价那次并留 duplicate-selection 痕"，本文件**故意没跟**。
      // 方向：虚高不是多删 —— 工作单去重后盘上只会少一次，坏的是 §19「预估 = 实删」那句承诺。
      //
      // 2026-10-13 同日更正：下面这句原本写"Electron 那半是在发行的产品"，当天下午 Electron 壳
      // 已整体删除（`docs/acceptance/2026-10-13-electron-shell-removal.md`）。本文件现在的身份是
      // **对账基准**，不是产品；这条分叉因此不再伤任何用户，但它仍然是一个真实的口径差 ——
      // 谁把本文件当"第二套实现"复用（而不是当基准跑），就会把那个虚高一起带走。
      // 整项已经覆盖全部路径，逐路径勾选只是重复表达同一个意图：不重复计价，但要留痕
      for (const e of entry)
        for (const p of e.paths)
          refuse(
            'path',
            f.ruleId,
            p,
            'duplicate-selection',
            `「${f.name}」已按整项勾选（${f.totalBytes} 字节），逐路径勾选不再重复计价`,
            0
          )
    } else if (!blocked) {
      const sample = new Map<string, { path: string; size: number }>()
      // 定价用的清单：引擎挂了**全量认领清单**（allPaths）时用它，否则退回 50 条采样。
      // 两个来源都是规则引擎自己认领过的文件 —— 所以"客户端报了个路径"绝不等于"它就能被定价"：
      // 不在该规则地盘里的文件照样走 path-not-enumerated 拒绝，这条纪律没被放宽。
      for (const sp of f.allPaths ?? f.samplePaths) sample.set(normalizeKey(sp.path), sp)
      for (const e of entry) {
        for (const p of e.paths) {
          if (typeof p !== 'string' || p.length === 0) {
            refuse('path', f.ruleId, null, 'path-not-enumerated', '路径必须是绝对路径字符串 → 这条勾选无法定价', 0)
            continue
          }
          const key = normalizeKey(p)
          if (pricedKeys.has(key)) {
            refuse('path', f.ruleId, p, 'duplicate-selection', '该路径已在本次勾选里计过一次，不重复计价', 0)
            continue
          }
          pricedKeys.add(key)
          // 枚举层的第二道闸：报告里挂着禁止路径（畸形数据）也照样拒掉，用的还是引擎那一个 isForbiddenPath
          const hit = isForbiddenPath(p, forbiddenRoots)
          if (hit !== null) {
            refuse(
              'path',
              f.ruleId,
              p,
              'forbidden-root',
              `命中 §16 🔴 禁止路径 ${hit} → 即使它挂在 🟢 项目名下也不给定价、不计入预估`,
              sample.get(key)?.size ?? 0
            )
            continue
          }
          // 只上报根：占用如实报告，但它在任何勾选下都不可删 —— 与 forbidden-root 并列的第二类拒绝，
          // 用的还是同一个 isForbiddenPath（不另立判据），区别只在名单。
          const roHit = isForbiddenPath(p, reportOnlyRoots)
          if (roHit !== null) {
            refuse(
              'path',
              f.ruleId,
              p,
              'report-only-root',
              `落在只上报根 ${roHit} 之内 → 大小照常报告，但它不属于任何可清理项，勾了也不计入预估`,
              sample.get(key)?.size ?? 0
            )
            continue
          }
          const sp = sample.get(key)
          if (sp === undefined) {
            refuse(
              'path',
              f.ruleId,
              p,
              'path-not-enumerated',
              `报告只枚举了本项的采样路径（本项共 ${f.fileCount} 个文件${f.sampleTruncated ? '，采样已截断' : ''}）→ 这条给不出大小，不猜也不重新走盘（§28 原则一）`,
              0
            )
            continue
          }
          priced.push({ path: sp.path, size: sp.size })
          bytes += sp.size
          files += 1
        }
      }
      priced.sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : a.path.toLowerCase() > b.path.toLowerCase() ? 1 : 0))
    }

    const included = selected && !blocked && f.riskLevel !== 'forbidden' && (whole || files > 0)
    const refusal = itemRefusal.get(f.ruleId) ?? null
    const item: PreviewItem = {
      ruleId: f.ruleId,
      name: f.name,
      // 查表，不写文案：表里没有这个 id ⇒ 空串（见 `shared/types.ts` 那个字段的注释）。
      description: ruleDescriptions.get(f.ruleId) ?? '',
      category: f.category,
      riskLevel: f.riskLevel,
      cleanStrategy: f.cleanStrategy,
      recoverable: f.recoverable,
      selected,
      included,
      bytes: included ? bytes : 0,
      files: included ? files : 0,
      scope,
      paths: included && scope === 'paths' ? priced : [],
      findingBytes: f.totalBytes,
      findingFiles: f.fileCount,
      sampleTruncated: f.sampleTruncated,
      matchedRoots: [...f.matchedRoots],
      refusal
    }
    items.push(item)
    if (!included) continue
    const cell = riskBreakdown[f.riskLevel]
    cell.items += 1
    cell.files += item.files
    cell.bytes += item.bytes
    totalBytes += item.bytes
    totalFiles += item.files
  }

  const notes: string[] = []
  if (blocked) notes.push(blockedDetail)
  if (riskBreakdown.high.items > 0)
    notes.push('§16 🟠 高风险项目：清理后可能导致软件重新下载数据或重新生成缓存，必须向用户明确提示')
  if (items.some((i) => i.included && !i.recoverable))
    notes.push('含不可再生项目（recoverable=false）：删掉不会像缓存那样自动长回来，与缓存类不同（§15）')
  if (items.some((i) => i.included && i.scope === 'paths'))
    notes.push(
      findings.some((f) => f.allPaths !== undefined && selectedRules.has(f.ruleId))
        ? '路径级勾选按该规则认领的「全部」文件定价（引擎已把全量清单交给预览），不在其地盘里的路径会被点名拒绝。'
        : '路径级勾选只能对报告已枚举的路径定价（本项未挂全量清单，「已枚举」上限来自报告的采样条数）；其余部分见各行的 findingBytes 与 path-not-enumerated 记录'
    )
  if (items.some((i) => i.included && i.scope === 'rule' && i.sampleTruncated))
    notes.push('整项勾选按报告的全量口径计价（totalBytes），与采样清单是否截断无关')

  const base: Omit<PreviewModel, 'digest' | 'generatedAtMs'> = {
    items,
    refusals,
    totalBytes,
    totalFiles,
    riskBreakdown,
    refusedBytes: refusals.reduce((a, r) => a + r.bytes, 0),
    blocked,
    reportReclaimableBytes: report.reclaimableBytes,
    reportForbiddenBytes: report.bytesByRisk.forbidden,
    forbiddenRoots: [...forbiddenRoots],
    reportOnlyRoots: [...reportOnlyRoots],
    reportExclusionCount: report.exclusions.length,
    // §3.6：搬运，不判定。预览这一层一旦重新数"哪条地盘没扫到"，就有了第二份事实源。
    territories: [...report.territories],
    // §3.5：搬运，不判定。派生长 in `registry.ts`，界面那一侧只消费这张表。
    defaultUnselectableRuleIds: [...(o.defaultUnselectableRuleIds ?? [])],
    notes
  }
  return { ...base, generatedAtMs: o.nowMs, digest: digestOf(base) }
}

function emptyBreakdown(): Record<Risk, PreviewRiskCell> {
  const out = {} as Record<Risk, PreviewRiskCell>
  for (const k of RISKS) out[k] = { items: 0, files: 0, bytes: 0 }
  return out
}

/* ------------------------------------------------------------------ *
 * 确认（§17 倒数第二步 —— 到此为止）
 * ------------------------------------------------------------------ */

export interface ConfirmOptions {
  acknowledged: boolean
  /**
   * M5-P1 T4：用户**按到哪一档**（`'safe' | 'caution' | 'high'`）。
   * `acknowledged` 只说「我点了确认」；这一项说的是「我看见 🟠 了」。
   * 判据：已计入项里的最高档 > 这一档 → `risk-not-acknowledged`，**出不了回执**。
   * 必填（没有默认值）：给默认值等于替用户按一次档 —— 那正是这扇门的原样。
   */
  acknowledgedRisk: Risk
  /** 时间基准注入（同引擎的 nowMs 口径），本模块不读时钟 */
  nowMs: number
}

/** 风险档的序（🟢 < 🟡 < 🟠 < 🔴）：直接取 `RISKS` 那张既有名单的下标，不另立第二份排序口径。 */
const tierRank = (risk: Risk): number => RISKS.indexOf(risk)

/**
 * 这份预估**要求**按到哪一档 = 已计入项里的最高档（与 Rust `confirm.rs::required_tier` 同判据）。
 * 一项都没计入 → `null`（没有档可要求，那种情况由 `nothing-to-confirm` 那道闸管）。
 * 只看 `included`：未勾选的 🟠 行用户还没决定要删，不该逼他按 🟠。
 * 🔴 不参与抬档：它永不可能合法地出现在 `included` 里，那份模型由 `forbidden-included` 拦。
 */
function requiredTier(model: PreviewModel): Risk | null {
  let best: Risk | null = null
  for (const i of model.items) {
    if (!i.included || i.riskLevel === 'forbidden') continue
    if (best === null || tierRank(i.riskLevel) > tierRank(best)) best = i.riskLevel
  }
  return best
}

/**
 * 「确认」的回执：**纯数据，且不含路径清单**。
 * 刻意的三件事：
 * - 不出具工作单：只列 ruleId 与合计，因为 §18 的执行入口本轮不存在，
 *   一份能直接喂给删除循环的路径清单才是危险的东西。
 * - 指纹必须对得上：确认的是用户看见的那一份预估，改过一个字节都算 stale。
 * - 档位必须按得够：见 `ConfirmOptions.acknowledgedRisk`。
 * 判据次序固定（顺序即行为，界面按这个次序念）：
 * `stale-model` → `forbidden-included` → `risk-not-acknowledged` → `safety-blocked` → `not-acknowledged` → `nothing-to-confirm`。
 */
export function confirmPreview(model: PreviewModel, o: ConfirmOptions): PreviewConfirmation {
  const blockers: PreviewConfirmBlocker[] = []
  // ① 指纹复核用**模型那一份**（档位无关）：预估产出时还没有任何人确认过
  const digest = previewDigest(model)
  if (digest !== model.digest) blockers.push('stale-model')
  // 内容复核与指纹复核彼此独立：就算有人把指纹也重新算对了，🔴 计入 / blocked 的模型照样确认不了
  const forged = model.items.some(
    (i) =>
      i.included &&
      (i.riskLevel === 'forbidden' ||
        isForbiddenPathOf(i, model.forbiddenRoots) !== null ||
        // 只上报根同样复核：有人手工拼出一份把回收站算成 🟢 的模型，这份确认也不许出具
        isForbiddenPathOf(i, model.reportOnlyRoots ?? []) !== null)
  )
  if (forged) blockers.push('forbidden-included')
  // ③ 档位复核：只拦「按得不够」，按得高不是错（过度询问是渲染端的纪律，不在这里罚）
  const required = requiredTier(model)
  if (required !== null && tierRank(required) > tierRank(o.acknowledgedRisk)) blockers.push('risk-not-acknowledged')
  if (model.blocked) blockers.push('safety-blocked')
  if (!o.acknowledged) blockers.push('not-acknowledged')

  const hasSomething = model.totalBytes > 0 && model.items.some((i) => i.included)
  if (blockers.length === 0 && !hasSomething) blockers.push('nothing-to-confirm')

  const included = blockers.length === 0 ? model.items.filter((i) => i.included) : []
  return {
    kind: 'dc-preview-confirmation',
    acknowledged: o.acknowledged,
    acknowledgedRisk: o.acknowledgedRisk,
    confirmed: blockers.length === 0,
    blockers,
    ruleIds: included.map((i) => i.ruleId),
    items: included.length,
    files: included.reduce((a, i) => a + i.files, 0),
    totalBytes: included.reduce((a, i) => a + i.bytes, 0),
    refusalCount: model.refusals.length,
    // 执行凭据：模型决策字段 **+ 这一项按下的档位**（同一份预估按 🟡 与按 🟠 必须是两个串）
    digest: previewDigest(model, o.acknowledgedRisk),
    // 归属凭据：本回执绑定的那一份**模型指纹**（档位无关）。渲染端没法自己重算带档位那一份
    // （`tsconfig.web.json` 不允许 import `core/rules/**`），所以归属判据只能靠服务端在这里陈述。
    modelDigest: model.digest,
    confirmedAtMs: o.nowMs,
    note: CONFIRM_NOTE
  }
}

function isForbiddenPathOf(i: PreviewItem, forbiddenRoots: readonly string[]): string | null {
  for (const p of i.paths) {
    const hit = isForbiddenPath(p.path, forbiddenRoots)
    if (hit !== null) return hit
  }
  for (const r of i.matchedRoots) {
    const hit = isForbiddenPath(r, forbiddenRoots)
    if (hit !== null) return hit
  }
  return null
}

/**
 * 模型指纹（不含 digest 自身与时间戳）：确认步骤用它守住「确认的就是这一份预估」。
 *
 * M5-P1 T4 起有**两份口径**，区别只在那一个参数（与 Rust `digest.rs::preview_digest` 逐字同）：
 * - 不传（`undefined`）—— **模型指纹**：`buildPreviewModel` 写进 `model.digest` 的那一份，
 *   `confirmPreview` 复核 `stale-model` 用的也是它（那一刻档位还不存在）。
 * - 传档位 —— **回执 / 执行凭据**：`ack=<tier>` 进授权串，
 *   同一份模型按 🟡 与按 🟠 出来必须是两个串（否则旧回执能换个档重放）。
 */
export function previewDigest(
  model: PreviewModel | Omit<PreviewModel, 'digest'>,
  acknowledgedRisk?: Risk
): string {
  const base: Omit<PreviewModel, 'digest' | 'generatedAtMs'> = {
    items: model.items,
    refusals: model.refusals,
    totalBytes: model.totalBytes,
    totalFiles: model.totalFiles,
    riskBreakdown: model.riskBreakdown,
    refusedBytes: model.refusedBytes,
    blocked: model.blocked,
    reportReclaimableBytes: model.reportReclaimableBytes,
    reportForbiddenBytes: model.reportForbiddenBytes,
    forbiddenRoots: model.forbiddenRoots,
    reportOnlyRoots: model.reportOnlyRoots,
    reportExclusionCount: model.reportExclusionCount,
    notes: model.notes,
    /**
     * 同上：带着它只是为了满足 `Omit<PreviewModel,…>` 这个类型，`digestOf()` **不读它**。
     * §3.6 那张底账改的是"这块地盘在哪棵树上看到、有多少字节、几条没扫到"，全是说明；
     * 把它读进授权串的后果是同一份账会因为一次界面措辞而换一个 §18 执行凭据。
     */
    territories: model.territories,
    /**
     * 带着它只是为了满足 `Omit<PreviewModel,…>` 这个类型，`digestOf()` **不读它**。
     * §3.5 那张表改的是"界面默认替用户勾了哪几行"，不是账目；而 digest 是 §18 的执行授权凭据。
     * 会不会哪天被误读进授权串，由 `tests/unit/rules-preview.test.ts` 那条「豁免表内容变化不改 digest」钉着。
     */
    defaultUnselectableRuleIds: model.defaultUnselectableRuleIds
  }
  return digestOf(base, acknowledgedRisk)
}

/**
 * 决策字段的规范化串（items 按 ruleId 排序、refusals 按内容排序）→ FNV-1a 双轮 64bit 十六进制。
 *
 * M5-P1 T5a：每条项的段末尾多了 `\u0000${i.description}`（与 Rust `digest.rs` 的
 * `"{}:{}:{}:{}:{}:{}\u{0}{}"` 逐字同形）。放在**最后一个字段、用 `\u{0}` 隔开**，与 `refs` 的段同一条姿势：
 * 规则文案是中文散文，里面出现 `:` 很正常，不该看起来像是多出来的账目字段。
 * 这一句加在**两份口径共用的那一段**上（不是 `ack=` 那种只在 `Some` 才挂的尾段），
 * 所以模型指纹也换了号 —— 反面（只进凭据那一份）等于「服务端改文案、旧回执照样有效」。
 */
function digestOf(m: Omit<PreviewModel, 'digest' | 'generatedAtMs'>, acknowledgedRisk?: Risk): string {
  const items = [...m.items]
    .sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0))
    .map(
      (i) =>
        `${i.ruleId}:${i.included ? 1 : 0}:${i.bytes}:${i.files}:${i.scope}:${i.paths
          .map((p) => normalizeKey(p.path))
          .sort()
          .join(',')}\u0000${i.description}`
    )
    .join('|')
  const refs = m.refusals
    .map((r) => `${r.reason}\u0000${r.ruleId ?? ''}\u0000${r.path ? normalizeKey(r.path) : ''}\u0000${r.bytes}`)
    .sort()
    .join('|')
  const src = [
    m.blocked ? 'B' : '-',
    m.totalBytes,
    m.totalFiles,
    m.refusedBytes,
    m.reportReclaimableBytes,
    m.reportForbiddenBytes,
    RISKS.map((k) => `${k}=${m.riskBreakdown[k].bytes}`).join(','),
    items,
    refs,
    // M5-P1 T4：确认按下的档位**是**授权串的一部分（只有传了才挂这一段）。
    // 段名 `ack=`、取值就是那个 kebab 串 ⇒ 与 Rust `format!("ack={}", enum_name(risk))` 逐字同形；
    // 不传 ⇒ 这一段根本不存在 ⇒ 档位那一格只进凭据、不进模型指纹。
    // ⚠ 但这**不等于**"模型指纹从 T4 起没换号"：T5a 把每条项的 `description` 加进了上面那段
    //   **共用**的 items 串里，所以 `preview-parity.json` 里所有历史 digest 都重录过一次（§9.7 写的那笔代价，实测兑现）。
    ...(acknowledgedRisk === undefined ? [] : [`ack=${acknowledgedRisk}`])
  ].join('\u0001')
  return fnv1a(src, 0x811c9dc5).toString(16).padStart(8, '0') + fnv1a(src, 0x1000193).toString(16).padStart(8, '0')
}

function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
