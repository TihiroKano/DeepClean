/**
 * 2026-10-24 存档：原来那份「canExecuteReceipt 必须认得带档位回执」的 UI 侧判据
 * 随手动档整块删掉了（一键清理合并成唯一入口，界面不再持有确认回执）。
 *
 * 它钉的那件事没有消失，只是消费方搬到了服务端：
 * 「确认回执的 digest 是带档位那一份、与模型指纹按设计不相等」仍由
 * `src-tauri/crates/cleaner/src/confirm.rs` 与 `digest.rs` 的单测钉着 ——
 * `run_auto_clean` 内部 confirm 之后走的就是那条链，所以这道闸在服务端依然全量在。
 *
 * 本文件留着作归档，不再 import 任何被删的 UI 函数。
 */
import { describe, expect, it } from 'vitest'
import { buildPreviewModel, confirmPreview, previewDigest } from '../../core/rules/preview'
import type { RuleFinding, RuleReport } from '../../core/rules/types'
import type { PreviewSelection } from '../../shared/types'

const NOW = 1_700_000_000_000

function pricedFinding(size = 123): RuleFinding {
  return {
    ruleId: 'npm-cache',
    name: 'npm 缓存',
    category: 'dev-cache',
    riskLevel: 'caution',
    cleanStrategy: 'delete-all',
    recoverable: true,
    matchedRoots: ['C:\\Local\\npm-cache'],
    samplePaths: [{ path: 'C:\\Local\\npm-cache\\_cacache\\pkg.bin', size }],
    fileCount: 1,
    totalBytes: size,
    sampleTruncated: false
  }
}

function report(findings: RuleFinding[]): RuleReport {
  const bytesByRisk = { safe: 0, caution: 0, high: 0, forbidden: 0 }
  for (const f of findings) bytesByRisk[f.riskLevel] += f.totalBytes
  return {
    findings,
    exclusions: [],
    territories: [],
    rejectedRules: [],
    forbiddenRoots: ['C:\\Windows\\System32'],
    reportOnlyRoots: [],
    safetyBlocked: false,
    bytesByRisk,
    reclaimableBytes: findings.reduce((a, f) => a + f.totalBytes, 0)
  }
}

const select = (...ruleIds: string[]): PreviewSelection => ({ items: ruleIds.map((ruleId) => ({ ruleId })) })

const model = buildPreviewModel(report([pricedFinding()]), select('npm-cache'), { nowMs: NOW })
const receipt = confirmPreview(model, { acknowledged: true, acknowledgedRisk: 'high', nowMs: NOW })

describe('回执链的**服务端半边**仍在（UI 半边已随手动档删除）', () => {
  it('这份模型真的出得了回执（否则下面全是空过）', () => {
    expect(model.items.some((i) => i.ruleId === 'npm-cache' && i.included), '🟠 项没进 included').toBe(true)
    expect(receipt.confirmed, `回执没通过：${receipt.blockers.join(', ')}`).toBe(true)
  })

  it('带档位的回执 digest 与模型指纹**按设计不相等** —— 那道易错点仍然钉住', () => {
    expect(receipt.digest).toBe(previewDigest(model, 'high'))
    expect(receipt.digest, '带档位的回执 digest 竟然等于模型指纹 —— 那 T4 那半就白做了').not.toBe(model.digest)
    expect(receipt.modelDigest, '回执必须记下它绑定的是哪一份模型').toBe(model.digest)
  })

  it('确认被拒时出不了回执（服务端 run_auto_clean 会把它整条拒绝）', () => {
    const refused = confirmPreview(model, { acknowledged: false, acknowledgedRisk: 'safe', nowMs: NOW })
    expect(refused.confirmed).toBe(false)
  })
})
