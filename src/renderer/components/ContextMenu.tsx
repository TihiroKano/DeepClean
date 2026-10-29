import { useEffect, useRef } from 'react'
import { Portal } from './Portal'

export interface MenuSpec {
  label: string
  disabled?: boolean
  hint?: string
  /** 置灰原因的小标签。默认「后续阶段」，但"这一项本来就不适用于当前对象"不是"以后才有" —— 得能区分。 */
  note?: string
  run: () => void
}

export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuSpec[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <Portal>
      <div
        ref={ref}
        className="dc-menu"
        style={{ left: Math.min(x, window.innerWidth - 240), top: Math.min(y, window.innerHeight - items.length * 32 - 20) }}
      >
        {items.map((it) => (
          <button
            key={it.label}
            className="dc-menu-item"
            disabled={it.disabled}
            title={it.hint}
            onClick={() => {
              if (it.disabled) return
              it.run()
              onClose()
            }}
          >
            <span>{it.label}</span>
            {it.disabled && <span className="dc-menu-note">{it.note ?? '后续阶段'}</span>}
          </button>
        ))}
      </div>
    </Portal>
  )
}
