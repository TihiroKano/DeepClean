/**
 * `previewNullMessage`：服务端那一格 `null` 是**两件事**塌成的一个值 ——
 * "这一轮还在扫、树上还没有完整数据" 与 "会话真没了"。
 * 以前两种都念「扫描会话已失效（请重新扫描）」，于是扫描途中的清理页在指控用户做了一件
 * 他没做的事（M5-F 真机扫查抓到，`docs/acceptance/2026-10-12-tauri-m5-f.md` §4：
 * 一趟 `C:\Windows` 跑到 9% 时打开那一页，顶上明明白白写着「本次扫描状态是「running」…」，
 * 同一屏下面却写着「会话已失效」—— 两句话互相打脸）。
 *
 * 三条判据：
 *  1. 在跑/暂停 → 那句"还在扫"，且**不许**出现"失效"；
 *  2. 其余每一态（含 `undefined` / `null`，即调用方压根没给状态）→ 那句"失效"，
 *     且不许出现"还在扫"（把两句话反过来写照样红，才是判据而不是文案）；
 *  3. 两句必须不同 —— 同串的话，上面两条都是空转。
 *
 * 文件名后缀是 `.tsx` 而不是 `.ts`：`tsconfig.node.json` 收 `tests/unit/*.ts`（没有 DOM lib），
 * `tsconfig.web.json` 才收 `tests/unit/*.tsx`。本文件 import 的是渲染层模块，落在 node 那半边
 * 会直接报 `Cannot find name 'window'` —— 与被测代码无关，纯粹是项目划分。
 */
import { describe, expect, it } from 'vitest'
import { previewNullMessage } from '../../src/renderer/hooks/usePreview'

describe('服务端回 null 时界面该说的话', () => {
  it('还在扫：说"还在扫"，不许说"失效"', () => {
    for (const s of ['running', 'paused'] as const) {
      const m = previewNullMessage(s)
      expect(m).toContain('还在扫')
      expect(m).not.toContain('失效')
    }
  })

  it('其余每一态：说"失效"，不许拿"还在扫"盖住真的没了', () => {
    for (const s of ['completed', 'cancelled', 'failed', 'idle', undefined, null] as const) {
      const m = previewNullMessage(s)
      expect(m).toContain('失效')
      expect(m).not.toContain('还在扫')
    }
  })

  it('两句必须不是同一句话（否则上面两条判据全是空转）', () => {
    expect(previewNullMessage('running')).not.toBe(previewNullMessage('completed'))
  })
})
