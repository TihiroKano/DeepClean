/**
 * 设置页的唯一取数入口（2026-10-27 新增）。
 *
 * ## 为什么要有这个 hook，而不是在设置页里裸调 `window.deepclean`
 *
 * 三件事住在这里，而且**都只能住一处**：
 *
 * 1. **写盘防抖**。四格滑块拖动时 `onInput` 每帧都触发；一次 IPC 落一次盘（
 *    `save_settings` 是"读 + 合并 + 写 + rename"四条系统调用），一个 3 秒的拖动会变成
 *    几十次整份重写。这里把写合并成 180 ms 一次 —— 但**末次一定落**（`flush` 在卸挂时跑）。
 * 2. **回执赢**。服务端回的是"存下来那一份"，界面拿它画控件，不是拿自己刚发出去的请求画。
 *    服务端把 `blur 9999` 夹成 60 之后，界面必须显示 60 —— 显示 9999 就是给用户看一个
 *    文件里并不存在的值（`dc_settings_set` 那段注释写着同一条）。
 * 3. **CSS 变量的唯一出口**。`applySettingsToDocument` 是"设置怎么变成样式"的唯一一处；
 *    一个设置键如果没进 `settingsToCssVars`，它就没有读者，那一格控件就是假的。
 *
 * ## 为什么 CSS 变量落在 `documentElement` 上
 *
 * `:root` 上那批 `--glass-*` 就是 `styles/glass/tokens.css` 定义的同一批名字。
 * 写在 `documentElement.style` 上会**覆盖**样式表里的值（内联优先），
 * 于是"用户调过的"与"样式表里那个默认"各就各位，不需要改任何一条 CSS。
 * 卸挂时把内联值清掉，界面就回到样式表默认 —— 这也是"恢复外观默认"的实现：
 * 把设置写成默认值，变量自然跟着回默认。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SETTINGS, settingsToCssVars, type AppSettings } from '../../../shared/settings'
import mountainBg from '../assets/mountain-bg.jpg'

/** 写盘防抖窗口。180 ms 是"拖动时肉眼无滞后"与"一次拖动最多写几次"的折中。 */
export const SAVE_DEBOUNCE_MS = 180

export interface UseSettings {
  /** 当前生效的那份。**永远是一份合法的完整对象**（服务端已清洗）。 */
  value: AppSettings
  /** 首次读盘还没回来。这一段里控件该禁用 —— 拿默认值画出来会让用户以为那就是他的设置。 */
  loading: boolean
  /** 写盘在飞（防抖窗口内或 IPC 未回）。 */
  saving: boolean
  /** 上一次写失败的**原话**。成功时清空。 */
  error: string | null
  /** 写半个 patch。防抖；回执赢。 */
  save(patch: Partial<AppSettings>): Promise<void>
  /** 外观四格恢复默认（不动 dup 与 wallpaper 之外的语义？—— 见实现）。 */
  resetGlass(): Promise<void>
  /**
   * 把一份**已经从服务端拿到**的值直接摆进来（壁纸选图那条命令自己会落盘，
   * 再走一趟 `save` 会把同一件事写两遍，而两次之间有一个缝隙）。
   */
  replace(next: AppSettings): void
}

/**
 * 设置 → 文档上的 CSS 变量。**唯一出口**，所以它单独导出、单独被测。
 *
 * `clearSettingsFromDocument` 是它的反面：卸挂时调，把内联值撤掉，回到样式表默认。
 *
 * 壁纸那一格在 `settingsToCssVars` 之外单算：`shared/settings.ts` 不许 import 任何
 * `.jpg`（它同时编进 node 与 web 两个项目），所以"引用 → URL"这一步只能住在这里。
 * `--dc-wallpaper` 的默认值写在 `global.css` 的 `.dc-app` 那条规则里
 * （`var(--dc-wallpaper, url('../assets/mountain-bg.jpg'))`），
 * 所以**没有设置时逐字等于改之前**。
 */
export function applySettingsToDocument(s: AppSettings, doc?: Document): void {
  const target = doc ?? (typeof document === 'undefined' ? null : document)
  if (!target) return
  const root = target.documentElement
  for (const [k, v] of Object.entries(settingsToCssVars(s))) {
    root.style.setProperty(k, v)
  }
  root.style.setProperty('--dc-wallpaper', `url("${wallpaperUrl(s.wallpaper)}")`)
}

/** 撤掉内联值（不是写回默认值 —— 那样样式表里改默认就不生效了）。 */
export function clearSettingsFromDocument(doc?: Document): void {
  const target = doc ?? (typeof document === 'undefined' ? null : document)
  if (!target) return
  const root = target.documentElement
  for (const k of Object.keys(settingsToCssVars(DEFAULT_SETTINGS))) {
    root.style.removeProperty(k)
  }
  root.style.removeProperty('--dc-wallpaper')
}

/**
 * 壁纸引用 → 能塞进 CSS `url()` 的地址。
 *
 * - `builtin:mountain` → Vite 打进产物的静态资源（与 `global.css` 里那个默认值是同一个文件）；
 * - `file:<名>` → `dc-wallpaper://localhost/<名>`，由服务端那个自定义协议读盘。
 *
 * **不在这里拼绝对路径**：渲染端拿不到（也不该拿到）用户数据目录。名字越界由协议层挡
 * （`wallpaper::wallpaper_path` 拒绝 `../`、分隔符、非白名单扩展名）。
 */
export function wallpaperUrl(ref: string): string {
  if (ref === 'builtin:mountain') return mountainBg
  if (ref.startsWith('file:')) {
    const name = ref.slice('file:'.length)
    // `encodeURIComponent` 是必须的：文件名里可能有空格、中文、`#`。
    // 不编码的话 `#` 之后会被当成 fragment，整条地址指向另一张图（或干脆 404）。
    return `dc-wallpaper://localhost/${encodeURIComponent(name)}`
  }
  return mountainBg
}

export function useSettings(): UseSettings {
  const [value, setValue] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * 待写的 patch（合并中）。存 `Partial` 而不是整份：两次快连的改动要叠起来，
   * 后一次不许把前一次覆盖掉（那正是"我改了亮度，模糊半径却跳回去了"的形状）。
   */
  const pending = useRef<Partial<AppSettings>>({})
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 连点两次写盘，回执顺序没有保证 —— 晚到的旧回执一律丢掉（与 `usePreview` 的 `seq` 同一条）。 */
  const seq = useRef(0)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      // 卸挂时把待写的**立刻发出去**：滑块拖到一半切页，那一下必须落盘。
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
        const patch = pending.current
        pending.current = {}
        if (Object.keys(patch).length > 0) {
          void window.deepclean.setSettings(patch).catch(() => {
            /* 卸挂之后没人接这个错误了；下一次进页面读盘会看到真实值 */
          })
        }
      }
      clearSettingsFromDocument()
    }
  }, [])

  useEffect(() => {
    let dead = false
    window.deepclean.getSettings().then(
      (s) => {
        if (dead) return
        setValue(s)
        setLoading(false)
        applySettingsToDocument(s)
      },
      (e: unknown) => {
        if (dead) return
        // 读不到就明说读不到，**不许**拿默认值冒充"你的设置就是这样"。
        // 但控件要能操作（默认值是可用的），所以 error 记下、loading 放掉。
        setLoading(false)
        setError(e instanceof Error ? e.message : String(e))
        applySettingsToDocument(DEFAULT_SETTINGS)
      }
    )
    return () => {
      dead = true
    }
  }, [])

  const flush = useCallback((): void => {
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length === 0) return
    const mine = ++seq.current
    setSaving(true)
    window.deepclean.setSettings(patch).then(
      (saved) => {
        if (seq.current !== mine || !alive.current) return
        // **回执赢**：画的是服务端存下来的那份（夹过的值），不是我们刚发出去那份。
        setValue(saved)
        setError(null)
        applySettingsToDocument(saved)
        setSaving(false)
      },
      (e: unknown) => {
        if (seq.current !== mine || !alive.current) return
        setError(e instanceof Error ? e.message : String(e))
        setSaving(false)
      }
    )
  }, [])

  const save = useCallback(
    (patch: Partial<AppSettings>): Promise<void> =>
      new Promise<void>((resolve) => {
        // 本地立刻摆正：滑块的读数与 CSS 变量要跟着手走，不能等 IPC。
        // 但**只摆本地能信的那部分** —— 越界值由下一次回执改回来（回执赢）。
        setValue((prev) => {
          const optimistic = { ...prev, ...patch }
          applySettingsToDocument(optimistic)
          return optimistic
        })
        pending.current = { ...pending.current, ...patch }
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => {
          timer.current = null
          flush()
          resolve()
        }, SAVE_DEBOUNCE_MS)
      }),
    [flush]
  )

  const resetGlass = useCallback(
    (): Promise<void> =>
      save({
        glassBlurPx: DEFAULT_SETTINGS.glassBlurPx,
        glassSaturate: DEFAULT_SETTINGS.glassSaturate,
        glassBrightness: DEFAULT_SETTINGS.glassBrightness,
        glassOpacity: DEFAULT_SETTINGS.glassOpacity
      }),
    [save]
  )

  const replace = useCallback((next: AppSettings): void => {
    setValue(next)
    applySettingsToDocument(next)
  }, [])

  return { value, loading, saving, error, save, resetGlass, replace }
}
