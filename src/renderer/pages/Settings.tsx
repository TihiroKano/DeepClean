/**
 * 「设置」页 —— 2026-10-27 重做成**三块竖排卡片**（人类伙伴给的形状）。
 *
 * ## 这一页的立身规矩没有变
 *
 * **每一格控件背后都必须有一段真消费它的逻辑**。这条从 2026-10-24 起写在本文件里，
 * 今天新加的四格外观控件也照同一条办：它们各自落进一条 CSS 变量
 * （`settingsToCssVars` 是唯一出口），而壁纸落进 `.dc-app` 的 `background-image`。
 * 一个"改了没反应"的滑块仍然是缺陷 —— 与开关同罪。
 *
 * ## 为什么是三块竖排，而不是横向三栏
 *
 * 人类伙伴一句「分为三栏」，但他随后自己修正为「上下结构」。这个判断从产品上讲也是对的：
 * 窗口最小宽 1080、侧栏 200 ⇒ 内容区最窄 880；横排三栏每栏不到 290 px，
 * 而四格滑块每格都要「标签 + 滑块 + 读数」，290 px 里滑块只剩 120 px ——
 * 那种宽度上调 5% 的差别在像素上看不出来，等于给了四格假控件。
 * 竖排三块的高度各随内容，1080 宽下每块都有 800+ px 可用。
 *
 * ## 三块分别是什么
 *
 * 1. **外观** —— 壁纸 + 毛玻璃四格。这两件是同一件事（"窗口看起来什么样"），
 *    分成两块会让用户在两处之间来回切着调。
 * 2. **授权** —— 状态 + 一句"需联网激活验证" + 输入框与按钮。**说明文字全部删掉**
 *    （人类伙伴 2026-10-27：「授权下方所有文字删掉，只保留展示激活和未激活」）。
 * 3. **关于** —— 版本号。字号比另两块大（「设置授权关于的字放大一些」指的是这一组标题）。
 */
import { useCallback, useEffect, useState } from 'react'
import { LicenseCard } from '../components/LicenseCard'
import { useSettings } from '../hooks/useSettings'
import {
  MAX_GLASS_BLUR_PX,
  MAX_GLASS_BRIGHTNESS,
  MAX_GLASS_OPACITY,
  MAX_GLASS_SATURATE,
  MIN_GLASS_BLUR_PX,
  MIN_GLASS_BRIGHTNESS,
  MIN_GLASS_OPACITY,
  MIN_GLASS_SATURATE,
  type AppSettings
} from '../../../shared/settings'

/**
 * 一格滑块的描述。**数据驱动，不是四段重复 JSX**：
 * 四格共用同一套"标签 + 滑块 + 读数 + 落盘"的链，写四遍就会有四份各自的偏差
 * （本仓在清理页的"全选/清空"上付过这笔学费）。
 */
interface SliderSpec {
  key: 'glassBlurPx' | 'glassSaturate' | 'glassBrightness' | 'glassOpacity'
  label: string
  min: number
  max: number
  step: number
  /** 读数怎么念。`pct` 会把 0.22 念成 22%。 */
  format: (v: number) => string
  /** 一句话说清这一格影响什么 —— 没有它，四个英文变量名对用户是空的。 */
  hint: string
}

export const GLASS_SLIDERS: readonly SliderSpec[] = [
  {
    key: 'glassBlurPx',
    label: '模糊半径',
    min: MIN_GLASS_BLUR_PX,
    max: MAX_GLASS_BLUR_PX,
    step: 1,
    format: (v) => `${Math.round(v)} px`,
    hint: '卡片身后糊多狠。0 是完全不平滑，60 以上在 1080p 上基本一片糊。'
  },
  {
    key: 'glassSaturate',
    label: '饱和度',
    min: MIN_GLASS_SATURATE,
    max: MAX_GLASS_SATURATE,
    step: 0.05,
    format: (v) => `${v.toFixed(2)}×`,
    hint: '处理后颜色的浓度。低于 1 会发灰，高于 2 开始发荧光。'
  },
  {
    key: 'glassBrightness',
    label: '亮度',
    min: MIN_GLASS_BRIGHTNESS,
    max: MAX_GLASS_BRIGHTNESS,
    step: 0.01,
    format: (v) => `${v.toFixed(2)}×`,
    hint: '处理后的明暗。太高会让背景压过文字，读起来吃力。'
  },
  {
    key: 'glassOpacity',
    label: '透明度',
    min: MIN_GLASS_OPACITY,
    max: MAX_GLASS_OPACITY,
    step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
    hint: '那块"玻璃板"有多实。越低背景越透，也越考验文字对比度。'
  }
]

/** 壁纸显示名。内置那张有人类伙伴给的名字，用户自己选的用源文件名。 */
export function wallpaperLabel(ref: string): string {
  if (ref === 'builtin:mountain') return '夜山（内置）'
  if (ref.startsWith('file:')) return ref.slice('file:'.length)
  return ref
}

export function Settings(): JSX.Element {
  const settings = useSettings()
  const [version, setVersion] = useState<string | null>(null)
  const [versionError, setVersionError] = useState<string | null>(null)
  const [wallpaperBusy, setWallpaperBusy] = useState(false)
  const [wallpaperNote, setWallpaperNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    // 版本号读不到就明说读不到。这一块的规矩是"没有真数据就没有那一行"，
    // 所以不许拿一个 '—' 或写死的 0.1.0 顶上去 —— 后者会随 package.json 变成分叉的两句真话。
    window.deepclean
      .getAppVersion()
      .then((v) => {
        if (alive) setVersion(v)
      })
      .catch((e: unknown) => {
        if (alive) setVersionError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [])

  /**
   * 选图。**取消不弹红字**（服务端那边把它归成 `ok:true, cancelled:true`）——
   * 用户按了取消之后屏幕上冒出"操作失败"，那是在指控他点坏了。
   */
  const pick = useCallback((): void => {
    if (wallpaperBusy) return
    setWallpaperNote(null)
    setWallpaperBusy(true)
    window.deepclean
      .pickWallpaper()
      .then((r) => {
        if (!r.ok) {
          setWallpaperNote(r.error)
          return
        }
        if (r.cancelled) {
          setWallpaperNote('已取消，没有换图。')
          return
        }
        // 服务端已经把设置落盘了（复制 + 保存是同一条命令），这里只把新值抄回本地那份，
        // 免得再走一趟 `setSettings` —— 那一趟会把同一件事写两遍，而两次之间有一个缝隙。
        settings.replace({ ...settings.value, wallpaper: r.wallpaper })
        setWallpaperNote(`已换成 ${wallpaperLabel(r.wallpaper)}`)
      })
      .catch((e: unknown) => setWallpaperNote(e instanceof Error ? e.message : String(e)))
      .finally(() => setWallpaperBusy(false))
  }, [settings, wallpaperBusy])

  return (
    <div className="dc-page dc-settings">
      <h2 className="dc-page-title">设置</h2>

      <AppearanceCard settings={settings} wallpaperBusy={wallpaperBusy} wallpaperNote={wallpaperNote} onPick={pick} />

      <LicenseCard />

      <section className="dc-settings-card">
        <h3 className="dc-settings-card-title">关于</h3>
        <p className="dc-fineprint dc-muted">
          DeepClean 版本：
          {version === null ? (
            <span className="dc-warn">{versionError ?? '读不到（主进程没给出版本号）'}</span>
          ) : (
            <code className="dc-mono">{version}</code>
          )}
        </p>
        <p className="dc-fineprint dc-muted">扫描 ≠ 删除。这一页不改任何文件，也不清理任何东西。</p>
      </section>

      {settings.error !== null && <p className="dc-warn">设置没能保存：{settings.error}</p>}
    </div>
  )
}

/**
 * 「外观」那块卡。壁纸与毛玻璃四格在同一张卡里 —— 它们回答的是同一个问题
 * （"窗口看起来什么样"），分成两块会让用户在两处之间来回切着调。
 */
function AppearanceCard({
  settings,
  wallpaperBusy,
  wallpaperNote,
  onPick
}: {
  settings: ReturnType<typeof useSettings>
  wallpaperBusy: boolean
  wallpaperNote: string | null
  onPick: () => void
}): JSX.Element {
  const s = settings.value
  return (
    <section className="dc-settings-card">
      <h3 className="dc-settings-card-title">外观</h3>

      <div className="dc-settings-row">
        <div className="dc-settings-row-head">
          <span className="dc-settings-row-label">背景壁纸</span>
          <span className="dc-settings-row-value dc-mono">{wallpaperLabel(s.wallpaper)}</span>
        </div>
        <p className="dc-fineprint dc-muted">
          选一张本地图片（png / jpg / jpeg / webp / bmp）。选中之后会复制进本程序的数据目录，
          原文件删掉也不影响。
        </p>
        <div className="dc-actions">
          <button className="dc-btn" type="button" disabled={wallpaperBusy} onClick={onPick}>
            {wallpaperBusy ? '正在选择…' : '选择图片…'}
          </button>
          <button
            className="dc-btn"
            type="button"
            disabled={wallpaperBusy || s.wallpaper === 'builtin:mountain'}
            onClick={() => void settings.save({ wallpaper: 'builtin:mountain' })}
          >
            恢复默认壁纸
          </button>
        </div>
        {wallpaperNote !== null && <p className="dc-fineprint dc-muted">{wallpaperNote}</p>}
      </div>

      <hr className="dc-settings-sep" />

      <p className="dc-muted dc-fineprint">
        毛玻璃四格。改一下立刻生效 —— 它们直接落成 CSS 变量，不重启、不刷新。
      </p>
      {GLASS_SLIDERS.map((spec) => (
        <GlassSlider
          key={spec.key}
          spec={spec}
          value={s[spec.key]}
          disabled={settings.saving}
          onChange={(v) => void settings.save({ [spec.key]: v } as Partial<AppSettings>)}
        />
      ))}

      <button
        className="dc-btn dc-btn-xs"
        type="button"
        disabled={settings.saving}
        onClick={() => void settings.resetGlass()}
      >
        恢复外观默认
      </button>
    </section>
  )
}

/**
 * 一格滑块。
 *
 * `onChange` 用的是 input 的 `onInput`（拖动过程中一直触发）而不是 `onChange`，
 * 但**落盘是防抖的**（`useSettings.save` 内部 180 ms）—— 拖动一下要写盘几十次的话，
 * 一个 3 秒的拖动就是几十次 IPC。
 */
function GlassSlider({
  spec,
  value,
  disabled,
  onChange
}: {
  spec: SliderSpec
  value: number
  disabled: boolean
  onChange: (v: number) => void
}): JSX.Element {
  return (
    <div className="dc-settings-row">
      <div className="dc-settings-row-head">
        <label className="dc-settings-row-label" htmlFor={`glass-${spec.key}`}>
          {spec.label}
        </label>
        <span className="dc-settings-row-value dc-mono">{spec.format(value)}</span>
      </div>
      <input
        id={`glass-${spec.key}`}
        className="dc-slider"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p className="dc-fineprint dc-muted">{spec.hint}</p>
    </div>
  )
}
