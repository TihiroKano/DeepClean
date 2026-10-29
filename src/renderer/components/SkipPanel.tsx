import { useState } from 'react'
import { formatCount } from '../../../shared/format'
import type { SkippedWire } from '../../../shared/types'

/** §15：跳过项必须可见、可点名。只显示一个总数等于告诉用户"有些东西我没算，但你别问"。 */
export function SkipPanel({ data }: { data: SkippedWire | null }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!data || data.total === 0) return null
  return (
    <section className="dc-skip">
      <button className="dc-link" onClick={() => setOpen((v) => !v)}>
        部分数据无法访问 · 共跳过 {formatCount(data.total)} 个{open ? ' ▲' : ' ▼'}
      </button>
      {/* 展开体单独成组件（SkipPanelBody）：这样"清单该不该出现、说什么"能被单测直接渲染出来，
          不必靠截图去猜。收起态与展开态读的是同一份 data，没有第二个真值源。 */}
      {open && <SkipPanelBody data={data} />}
    </section>
  )
}

/**
 * 展开后的那一截。拆出来的唯一理由是被测（见上）。
 *
 * 三句话（介绍、清单、「另有 M 个未列出」）全挂同一条 `data.sample.length > 0` 的门，
 * 而**不是**挂在 `data.denied > 0` 上：
 * 清单只从 denied 里填，所以一趟全是 `missing`/`busy`/`otherErrors` 的正常扫描（真盘上随手就是：
 * 消失的临时文件 ENOENT → missing）会是 `total > 0 而 sample 为空`。
 * 这时候在 `<ul>` 上方写「下列为前 0 个…」就是一句关于扫描器压根没声称过的工作的假话 ——
 * 而这一栏存在的理由正是不说假话。分账那一行照旧如实报（`权限拒绝 0 · 文件消失 N …`），
 * 一句都不多、一句都不少。
 *
 * 「另有 M 个未列出」也进同一道门：「另有」在语用上**预设前面有一份名单**，
 * 悬在一个空 list 上方就是「下列为前 0 个」的缩小版（评审修订 2）。
 * 今天这一状态走扫描链到不了 —— `scanner.ts` 的 `count()` 五处调用点与 walk 的 error 事件都带 path；
 * 但 `addError` 的 `path` 是可选兼容面（`tests/unit/scan-denied-paths.test.ts` 钉着"拿不到路径也计数"），
 * 一个不带 path 的新调用点随时能让它出现 —— 按防御对待，与截图判据同一立场：
 * "denied>0 而零名字"那一支本来就该 FAIL（`electron/main/index.ts` 第 32 步），这句也不该悬在半空。
 */
export function SkipPanelBody({ data }: { data: SkippedWire }): JSX.Element {
  return (
    <div className="dc-skip-body">
      <p className="dc-muted">
        权限拒绝 {formatCount(data.denied)} · 文件消失 {formatCount(data.missing)} · 被占用 {formatCount(data.busy)} · 其它 {formatCount(data.otherErrors)}
      </p>
      {data.sample.length > 0 && (
        <>
          {/* 名词是「项目」而不是「目录」：denied 里真混着文件 —— 单个文件 stat 撞 EPERM/EACCES
              同样分类成 denied（core/fs/errors.ts、walk.ts 的 stat 那处、scanner.ts 的浅层 stat），
              而清单不许为了迁就一个名词就把已有的路径扔掉（丢了名字等于漏报）。
              「及其子目录」也一并去掉：一个文件没有子目录，那句话对它本身就是假的。 */}
          <p className="dc-muted">下列为前 {formatCount(data.sample.length)} 个未能读取的项目；它们的容量没有计入地图。</p>
          <ul className="dc-skip-list">
            {data.sample.map((p, i) => (
              // 键带上序号：同一个路径理论上能被记两次（例如一个目录既在预遍历里被拒、又作为种子被走），
              // 重复键只会让 React 报一句 warning，但这一栏是"点名栏"，名字对不上号比样式难看更糟。
              <li key={`${i}-${p}`} className="dc-mono dc-ell" title={p}>
                {p}
              </li>
            ))}
          </ul>
          {data.sampleOverflow > 0 && <p className="dc-muted">另有 {formatCount(data.sampleOverflow)} 个未列出。</p>}
        </>
      )}
    </div>
  )
}
