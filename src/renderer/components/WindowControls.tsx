/**
 * 窗口右上角那三颗系统按钮：最小化 / 最大化·还原 / 关闭。
 *
 * **为什么要自己画**：`tauri.conf.json` 里 `decorations: false`（整窗圆角 + 玻璃背景的前提），
 * 系统从此不再提供标题按钮 —— 缺了它们，窗口只能 Alt+F4 关、连最小化都没有。这一排补的就是那一课。
 * 落点（右上 138×40 的最暗区）是背景图换人时继承下来的那条约束，别挪到别处。
 *
 * **为什么不走 `window.deepclean`**：那座桥是应用数据通道的纪律（每条都有线格式与校验），
 * 窗控是 chrome 层能力，不是数据 —— 给它开一条 invoke 才是把两件事混进一个口子。
 * 这里只用 `withGlobalTauri` 注入的 `window.__TAURI__.window`。
 *
 * 拿不到 Tauri 全局（纯浏览器预览）时**整排不渲染**，而不是画三颗点了没反应的假按钮。
 */
import { useEffect, useState } from 'react'
import { useT } from '../i18n'
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from './icons'

interface TauriWindow {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
}

function currentWindow(): TauriWindow | null {
  const t = (window as unknown as { __TAURI__?: { window?: { getCurrentWindow?: () => TauriWindow } } })
    .__TAURI__
  return t?.window?.getCurrentWindow?.() ?? null
}

export function WindowControls(): JSX.Element | null {
  const t = useT()
  // 全局对象在挂载前就位（tauri-main.tsx 先装桥再渲染），读一次就够，不必每次渲染重查
  const [win] = useState<TauriWindow | null>(() => currentWindow())
  const [maximized, setMaximized] = useState(false)

  /*
   * 窗控调用的失败**不许再静默**：上一版三颗按钮"点了没反应"，根因是 capabilities 没给
   * window 权限，promise 一路 reject 而被 `void` 吞掉 —— 从外表看与"按钮坏了"一模一样。
   * 从此这里统一走 `run`：拒绝就打进 console，排障时第一眼就能看到。
   */
  const run = (p: Promise<unknown>): void => {
    p.catch((e: unknown) => console.error('[dc] 窗控调用失败（先查 capabilities 的 window 权限）', e))
  }

  useEffect(() => {
    if (!win) return
    let alive = true
    const sync = (): void => {
      run(
        win.isMaximized().then((m) => {
          if (alive) setMaximized(m)
        })
      )
    }
    sync()
    // 系统最大化/还原（含双击标题栏、Win+↑）都会触发 DOM 的 resize —— 用它做同步信号，零订阅成本
    window.addEventListener('resize', sync)
    return () => {
      alive = false
      window.removeEventListener('resize', sync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win])

  if (!win) return null

  return (
    <div className="dc-winctl">
      <button
        type="button"
        className="dc-winctl-btn"
        title={t('最小化')}
        aria-label={t('最小化')}
        onClick={() => run(win.minimize())}
      >
        <MinimizeIcon size={13} />
      </button>
      <button
        type="button"
        className="dc-winctl-btn"
        title={maximized ? t('还原') : t('最大化')}
        aria-label={maximized ? t('还原') : t('最大化')}
        onClick={() => run(win.toggleMaximize())}
      >
        {maximized ? <RestoreIcon size={13} /> : <MaximizeIcon size={13} />}
      </button>
      <button
        type="button"
        className="dc-winctl-btn dc-winctl-close"
        title={t('关闭')}
        aria-label={t('关闭')}
        onClick={() => run(win.close())}
      >
        <CloseIcon size={13} />
      </button>
    </div>
  )
}
