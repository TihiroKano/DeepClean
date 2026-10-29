/**
 * 清理日志（2026-10-25 重做，原名「清理记录」）。
 *
 * **一次清理一行**，不是「一个文件一行」。人类伙伴要的格式：
 *
 * ```text
 * 2026年10月25日 15:30   在 C:\ 与 D:\ 清理 750.9 MB 文件    [详情]
 * ```
 *
 * 旧版那套三维筛选（日期 / 风险 / 状态）整套删掉了：这一版按时间倒序，
 * 30 天保留窗口本身就是时间维。筛选是下一版的事（设计 §9 登记过）。
 *
 * 详情在**独立页**（`CleanJournalDetail`），不是弹窗也不是就地展开 ——
 * 一次清理可能删 1.7 万个文件，列表里塞不下。
 *
 * ⚠️ 本页**不引** `core/clean` 目录里的任何东西（那里面住着真的 unlink/rmdir，
 * 打包器会顺着 import 把它拖进渲染端产物）。要的类型只在 `shared/types.ts` 那一层。
 */
import { useEffect, useState } from 'react'
import type { CleanRun } from '../../../shared/types'
import { formatBytes } from '../../../shared/format'

/** 本地时区的「某年某月某日 某时某分」。**按本地日历拆**，不是按 UTC。 */
export function formatWhen(epochMs: number): string {
  const d = new Date(epochMs)
  if (Number.isNaN(d.getTime())) return '时间未知'
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 顶栏那句话：与列表行同一套口径，供详情页复用。 */
export function formatRunHeader(run: CleanRun): string {
  const when = formatWhen(run.endedAtMs)
  const drives = formatDrives(run.drives)
  const size = formatBytes(run.freedBytes)
  return drives === '' ? `${when} · ${size}` : `${when} · 在 ${drives} · ${size}`
}

/** `["C:\\","D:\\"]` → `C:\ 与 D:\`。空数组 ⇒ 那句话就不说盘。 */
export function formatDrives(drives: string[]): string {
  if (drives.length === 0) return ''
  const [first, ...rest] = drives
  if (first === undefined) return ''
  if (rest.length === 0) return first
  const last = rest[rest.length - 1]
  const head = drives.slice(0, -1).join('、')
  return `${head} 与 ${last ?? ''}`.trim()
}

/**
 * 一行（纯呈现，不取数、不带 state）—— 静态渲染测试直接钉它。
 * 容器 `CleanHistory` 负责取数，那部分由真机验收负责（本仓没装 jsdom）。
 */
export function JournalRow({ run, onOpenDetail }: { run: CleanRun; onOpenDetail: (id: string) => void }): JSX.Element {
  return (
    <li className="dc-journal-row">
      <span className="dc-journal-row-when dc-mono">{formatWhen(run.endedAtMs)}</span>
      <span className="dc-journal-row-what">
        {run.drives.length > 0 && (
          <>
            在 <b className="dc-mono">{formatDrives(run.drives)}</b>{' '}
          </>
        )}
        清理 <b className="dc-mono">{formatBytes(run.freedBytes)}</b> 文件
        <span className="dc-muted dc-fineprint"> · {run.fileCount.toLocaleString()} 个</span>
      </span>
      <button className="dc-btn dc-btn-xs dc-journal-row-detail" onClick={() => onOpenDetail(run.id)}>
        详情
      </button>
    </li>
  )
}

/** 空态那一句（纯呈现）。 */
export function JournalEmpty(): JSX.Element {
  return (
    <p className="dc-muted">
      还没有清理日志。清理之后，这里会按时间记下每一次清理。
    </p>
  )
}

/**
 * 「保留 30 天」那一句 —— **放在列表下方**（2026-10-27 人类伙伴：「清理日志下方加一段话：
 * 日志仅保留30天，自动删除」）。
 *
 * 为什么不塞进空态那句话里：空态与有数据是两条路，而"日志会自己消失"这件事**两条路都要说**。
 * 塞进空态就变成"只有还没有日志的人知道"，而真需要知道的人恰恰是已经有几十条、正准备
 * 指望它当长期记录的那位。所以抽成单独一块，挂在列表下方，两条分支共用。
 */
export function JournalRetentionNote(): JSX.Element {
  return <p className="dc-muted dc-fineprint dc-journal-retention">日志仅保留 30 天，过期自动删除。</p>
}

export function CleanHistory({
  onOpenDetail,
  /** 测试可注入；默认走桥。 */
  load = () => window.deepclean.journalRuns(),
}: {
  /** 点「详情」时把 runId 交出去，由 `App.tsx` 切到详情页。 */
  onOpenDetail: (runId: string) => void
  load?: () => Promise<CleanRun[]>
}): JSX.Element {
  const [runs, setRuns] = useState<CleanRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let dead = false
    load()
      .then((r) => {
        if (!dead) setRuns(r)
      })
      .catch((e: unknown) => {
        // 桥那条纪律：失败回成异步失败。这里把原话念出来，不补默认值。
        if (!dead) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      dead = true
    }
    // `load` 由调用方给，身份变了不该重拉 —— 只在挂载时拉一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (error !== null) {
    return (
      <div className="dc-clean">
        <h2 className="dc-page-title">清理日志</h2>
        <p className="dc-warn">读不到清理日志：{error}</p>
      </div>
    )
  }

  if (runs === null) {
    return (
      <div className="dc-clean">
        <h2 className="dc-page-title">清理日志</h2>
        <p className="dc-muted">正在读取…</p>
      </div>
    )
  }

  return (
    <div className="dc-clean">
      <h2 className="dc-page-title">清理日志</h2>
      {runs.length === 0 ? (
        <JournalEmpty />
      ) : (
        <ul className="dc-journal-list">
          {runs.map((r) => (
            <JournalRow key={r.id} run={r} onOpenDetail={onOpenDetail} />
          ))}
        </ul>
      )}
      {/* 列表下方：保留窗口这句话两条分支都要有（见 `JournalRetentionNote` 的注释） */}
      <JournalRetentionNote />
    </div>
  )
}
