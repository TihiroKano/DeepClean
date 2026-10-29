/**
 * 清理日志的**详情独立页**（2026-10-25 人类伙伴定：跳独立页，不是弹窗）。
 *
 * 一棵按**父目录折叠**的树，且**逐层懒加载**：打开时只拉第一层目录汇总，
 * 点开某个目录才拉它的下一层。
 *
 * 为什么必须懒加载：那趟 750.9 MB 的真实清理删了 17,143 个文件。一次全拉会让首屏等好几秒，
 * 而用户第一眼只需要知道「哪些目录被清了、各多大」（设计 §6.3）。
 *
 * 为什么折叠在服务端：渲染层拿不到全部 files，它没法自己折叠 —— 这一点原设计写反过。
 */
import { useCallback, useEffect, useState } from 'react'
import type { JournalDirEntry, JournalDirSummary } from '../../../shared/types'
import { formatBytes } from '../../../shared/format'

export interface JournalDetailApi {
  tree: (runId: string) => Promise<JournalDirSummary[]>
  children: (runId: string, dir: string) => Promise<JournalDirEntry[]>
}

const defaultApi: JournalDetailApi = {
  tree: (runId) => window.deepclean.journalDirTree(runId),
  children: (runId, dir) => window.deepclean.journalDirChildren(runId, dir),
}

/** 一个目录节点：自己 + 点开后的子项（懒加载）。 */
function DirNode({
  runId,
  summary,
  api,
  depth,
}: {
  runId: string
  summary: JournalDirSummary
  api: JournalDetailApi
  depth: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [kids, setKids] = useState<JournalDirEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggle = useCallback(() => {
    const next = !open
    setOpen(next)
    // 只在**展开且还没拉过**时拉一次：收起来再展开不该重新拉
    if (next && kids === null) {
      api
        .children(runId, summary.dir)
        .then(setKids)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    }
  }, [api, kids, open, runId, summary.dir])

  return (
    <li className="dc-journal-dir">
      <button className="dc-journal-dir-head" onClick={toggle} aria-expanded={open}>
        <span className="dc-journal-dir-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="dc-journal-dir-name dc-mono">{summary.dir}</span>
        <span className="dc-muted dc-fineprint">
          {summary.fileCount.toLocaleString()} 个文件 · {formatBytes(summary.bytes)}
        </span>
      </button>
      {open && (
        <div className="dc-journal-dir-body">
          {error !== null && <p className="dc-warn">这一层读不到：{error}</p>}
          {kids === null && error === null && <p className="dc-muted">正在读取…</p>}
          {kids !== null && (
            <ul className="dc-journal-dir-children">
              {kids.map((k) =>
                k.isDir ? (
                  <DirNode
                    key={k.path}
                    runId={runId}
                    // 子目录的 summary 形状与 DirSummary 一致：用它的 path/count/bytes
                    summary={{ dir: k.path, fileCount: k.fileCount, bytes: k.sizeBytes }}
                    api={api}
                    depth={depth + 1}
                  />
                ) : (
                  <li key={k.path} className="dc-journal-file" data-depth={depth + 1}>
                    <span className="dc-journal-file-name dc-mono">{k.name}</span>
                    <span className="dc-muted dc-fineprint">{formatBytes(k.sizeBytes)}</span>
                  </li>
                ),
              )}
              {kids.length === 0 && <li className="dc-muted dc-fineprint">这一层没有文件。</li>}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

export function CleanJournalDetail({
  runId,
  onBack,
  header,
  api = defaultApi,
}: {
  runId: string
  onBack: () => void
  /** 顶栏那句话（由列表页带着 run 的元信息给，省一次往返）。 */
  header?: string
  api?: JournalDetailApi
}): JSX.Element {
  const [roots, setRoots] = useState<JournalDirSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let dead = false
    api
      .tree(runId)
      .then((r) => {
        if (!dead) setRoots(r)
      })
      .catch((e: unknown) => {
        if (!dead) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      dead = true
    }
    // 同一个 runId 只拉一次；`api` 身份变了也不该重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  return (
    <div className="dc-clean dc-journal-detail">
      <div className="dc-journal-detail-head">
        <button className="dc-btn dc-btn-xs" onClick={onBack}>
          ‹ 返回
        </button>
        {header !== undefined && <span className="dc-journal-detail-title">{header}</span>}
      </div>

      {error !== null && <p className="dc-warn">读不到这次清理的详情：{error}</p>}
      {roots === null && error === null && <p className="dc-muted">正在读取…</p>}
      {roots !== null && roots.length === 0 && (
        <p className="dc-muted">这次清理没有可展开的文件记录。</p>
      )}
      {roots !== null && roots.length > 0 && (
        <ul className="dc-journal-tree">
          {roots.map((r) => (
            <DirNode key={r.dir} runId={runId} summary={r} api={api} depth={0} />
          ))}
        </ul>
      )}
    </div>
  )
}
