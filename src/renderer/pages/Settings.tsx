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
import { useT } from '../i18n'
import { LOCALES, LOCALE_LABELS, type Locale } from '../../../shared/i18n'
import {
  MAX_GLASS_BLUR_PX,
  MAX_GLASS_BRIGHTNESS,
  MAX_GLASS_OPACITY,
  MAX_GLASS_SATURATE,
  MIN_GLASS_BLUR_PX,
  MIN_GLASS_BRIGHTNESS,
  MIN_GLASS_OPACITY,
  MIN_GLASS_SATURATE,
  SCAN_WORKERS_AUTO,
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
  const t = useT()
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
      <h2 className="dc-page-title">{t('设置')}</h2>

      {/*
        五块卡的顺序（2026-10-29 第二轮，人类伙伴点名）：
        **语言 → 性能 → 外观 → 授权 → 关于**。

        为什么是这个顺序而不是"最常改的在前"：语言排第一是因为它决定**后面四块怎么读** ——
        一个看不懂中文的人打开这一页，第一个要找的就是它。其余四块按"抽象的层级"往下排：
        性能是这台机器怎么跑、外观是它看起来什么样、授权是它归谁、关于是它是谁。
      */}
      <LanguageCard settings={settings} />

      <PerformanceCard settings={settings} />

      <AppearanceCard settings={settings} wallpaperBusy={wallpaperBusy} wallpaperNote={wallpaperNote} onPick={pick} />

      <LicenseCard />

      <section className="dc-settings-card">
        <h3 className="dc-settings-card-title">{t('关于')}</h3>
        <p className="dc-fineprint dc-muted">
          {t('DeepClean 版本：')}
          {version === null ? (
            <span className="dc-warn">{versionError ?? t('读不到（主进程没给出版本号）')}</span>
          ) : (
            <code className="dc-mono">{version}</code>
          )}
        </p>
        <p className="dc-fineprint dc-muted">{t('扫描 ≠ 删除。这一页不改任何文件，也不清理任何东西。')}</p>
      </section>

      {settings.error !== null && <p className="dc-warn">{t('设置没能保存：{err}', { err: settings.error })}</p>}
    </div>
  )
}

/**
 * 「语言」那块卡（2026-10-29）。
 *
 * 人类伙伴原话：「设置内增加语言切换功能，支持中文，繁体中文，英语，日语，韩语」。
 *
 * 三件必须说清的事：
 *
 * ① **它有一个真读者**：`App` 拿 `settings.locale` 挂 `LocaleContext.Provider`，
 *    `useT()` 从那里取词典。切了立刻生效，不重启 —— 这是本页"每格控件背后都要有
 *    一段真消费它的逻辑"那条规矩的兑现。
 *
 * ② **下拉里每种语言用自己那种写法**（`LOCALE_LABELS`）。跟着界面语言走的话，
 *    界面已经是英文时列表里写着 `Japanese`，而用户可能正是因为看不懂才来这一页。
 *
 * ③ **存的是 id 不是下标**：`en` / `ja` 这种 id 换一台机器、换一个版本都还认得出；
 *    存下标的话"给列表加一种语言"会让所有老用户的界面语言整体错位一格。
 */
function LanguageCard({ settings }: { settings: ReturnType<typeof useSettings> }): JSX.Element {
  const t = useT()
  const s = settings.value
  return (
    <section className="dc-settings-card">
      <h3 className="dc-settings-card-title">{t('界面语言')}</h3>
      <div className="dc-settings-row">
        <div className="dc-settings-row-head">
          <label className="dc-settings-row-label" htmlFor="dc-locale">
            {t('界面语言')}
          </label>
        </div>
        <select
          id="dc-locale"
          className="dc-select dc-locale-select"
          value={s.locale}
          disabled={settings.saving}
          onChange={(e) => void settings.save({ locale: e.target.value as Locale })}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_LABELS[l]}
            </option>
          ))}
        </select>
        <p className="dc-fineprint dc-muted">{t('切换后立刻生效，不需要重启。')}</p>
      </div>
    </section>
  )
}

/**
 * 「性能」那块卡 —— 删除速率（2026-10-30 第三轮）。
 *
 * ## 三轮要求的累加
 *
 * ① 第一轮：「并行清理倍数放设置以滑块方式选择，默认为推荐值（最保守），
 *    确保用户拉满倍率导致崩溃」。
 * ② 第二轮：改叫「删除速率」、读数叫「默认推荐」、取消说明小字、
 *    加"拉到阈值弹窗提示并自动拉回"。
 * ③ **本轮（看了实测数据之后）**：滑块改成**点阵样式**（参考图：一排小方格，
 *    已选的染色、未选的淡），换蓝色系；**档位数 = 本机逻辑核数**；
 *    **取消上限弹窗**；**默认值 = 逻辑核数的 60%**。
 *
 * ## 为什么默认 60%
 *
 * 实测（docs/benchmarks/2026-10-30-delete-path-swap.md 与 delprobe）：
 * 删除的加速比饱和在核数（8 核机 8 线程 2.45×，16 线程反而慢）。也就是说
 * "拉到 100% 核数"与"拉到 60%"在速度上的差距远小于直觉 —— 文件系统的日志
 * 把并行收益封顶了。默认给 60% 是把"这台机器跑别的活"的空间留给用户：
 * DeepClean 清理是瞬时突发负载，默认不占满全部核，是 polite 的那一档。
 * 用户想拉满，拉到头就是核数 —— 不会崩（实测内存不涨、不崩溃），只是别的
 * 程序那几秒里少几个核。
 *
 * ## 点阵样式
 *
 * 参考图是一排小方格：已选的染色、当前档那格带描边。DOM 用一排 button 画格子
 * （不是 CSS 渐变 —— 档位数是运行时的 stops，渐变画不出"恰好 N 格、选中恰好
 * M 格"）。真正的 `<input type=range>` 仍在，只是视觉上隐藏：键盘（方向键）、
 * 读屏、拖拽交互全部保留 —— 手绘一层格子盖在它上面，点击格子直接跳档。
 * **可访问性不因为换皮肤而丢**。
 */
function PerformanceCard({ settings }: { settings: ReturnType<typeof useSettings> }): JSX.Element {
  const t = useT()
  const s = settings.value

  /*
   * 档位总数 = 本机逻辑核数（从主进程取，理由见 shared/types.ts 的 getHardware 注释）。
   * 初值 8 是**占位**：IPC 回来前按 8 格画，回来后 setStops 撑开。
   * （初值若给 1，"默认值 = 60%" 会算出 0.6 → 1，IPC 回来后跳档；
   *   给 8 与大多数目标机器一致，跳档概率最低。）
   */
  const [stops, setStops] = useState(8)
  useEffect(() => {
    let alive = true
    void window.deepclean.getHardware().then((h) => {
      if (alive && Number.isFinite(h.logicalCores) && h.logicalCores > 0) setStops(Math.floor(h.logicalCores))
    })
    return () => {
      alive = false
    }
  }, [])

  /** 默认档 = 核数的 60%（四舍五入），至少 1。内核 clamp_workers 仍夹 1..=核数。 */
  const defaultWorkers = Math.max(1, Math.round(stops * 0.6))

  /*
   * 当前生效的档位。
   *
   * `scanWorkers === 0`（SCAN_WORKERS_AUTO）= "用默认" —— 显示成 defaultWorkers，
   * 内核收到 0 时自己按核数 × 60% 算（见 service::read_scan_workers_for_delete）。
   * 用户显式选了档位就用那个数。
   */
  const atAuto = s.scanWorkers === SCAN_WORKERS_AUTO
  const current = atAuto ? defaultWorkers : Math.min(s.scanWorkers, stops)

  const save = (v: number): void => {
    void settings.save({ scanWorkers: v })
  }

  return (
    <section className="dc-settings-card">
      <h3 className="dc-settings-card-title">{t('性能')}</h3>
      <div className="dc-settings-row">
        <div className="dc-settings-row-head">
          <label className="dc-settings-row-label" htmlFor="dc-scan-workers">
            {t('删除速率')}
          </label>
          <span className="dc-settings-row-value dc-mono">
            {current === defaultWorkers ? t('默认推荐') : `x${current}`}
          </span>
        </div>

        {/*
          点阵滑块。两层：
           1. `<input type=range>`：真交互面（键盘/读屏/拖拽），视觉透明但仍可聚焦；
           2. 点阵那排格子：纯显示 + 可点击（点了直接跳那一档）。
          参考图两端那两行说明字（更快/更强）按人类伙伴要求撤掉 —— 读数就在右上角，
          再标两端是第三处说同一件事。
        */}
        <div className="dc-rate">
          <div className="dc-rate-track">
            <input
              id="dc-scan-workers"
              className="dc-rate-range"
              type="range"
              min={1}
              max={stops}
              step={1}
              value={current}
              disabled={settings.saving}
              aria-label={t('删除速率')}
              aria-valuemin={1}
              aria-valuemax={stops}
              aria-valuenow={current}
              aria-valuetext={current === defaultWorkers ? t('默认推荐') : `x${current}`}
              onChange={(e) => save(Number(e.target.value))}
            />
            <div className="dc-rate-cells" aria-hidden="true">
              {Array.from({ length: stops }, (_, i) => {
                const v = i + 1
                const on = v <= current
                const isDefault = v === defaultWorkers
                return (
                  <button
                    key={v}
                    type="button"
                    tabIndex={-1}
                    className={
                      'dc-rate-cell' + (on ? ' dc-rate-cell-on' : '') + (isDefault ? ' dc-rate-cell-default' : '')
                    }
                    style={
                      on
                        ? // 色阶：越靠右越实（0.35 → 1.0），与参考图"强度随档位增长"同构
                          { background: `rgba(77, 143, 245, ${(0.35 + (0.65 * v) / stops).toFixed(2)})` }
                        : undefined
                    }
                    onClick={() => save(v)}
                  />
                )
              })}
            </div>
          </div>
        </div>

        <button
          className="dc-btn dc-btn-xs"
          type="button"
          disabled={settings.saving || current === defaultWorkers}
          onClick={() => save(SCAN_WORKERS_AUTO)}
        >
          {t('恢复性能默认')}
        </button>
      </div>
    </section>
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
  const t = useT()
  return (
    <section className="dc-settings-card">
      <h3 className="dc-settings-card-title">{t('外观')}</h3>

      <div className="dc-settings-row">
        <div className="dc-settings-row-head">
          <span className="dc-settings-row-label">{t('背景壁纸')}</span>
          <span className="dc-settings-row-value dc-mono">{t(wallpaperLabel(s.wallpaper))}</span>
        </div>
        <p className="dc-fineprint dc-muted">
          {t(
            '选一张本地图片（png / jpg / jpeg / webp / bmp）。选中之后会复制进本程序的数据目录，原文件删掉也不影响。'
          )}
        </p>
        <div className="dc-actions">
          <button className="dc-btn" type="button" disabled={wallpaperBusy} onClick={onPick}>
            {wallpaperBusy ? t('正在选择…') : t('选择图片…')}
          </button>
          <button
            className="dc-btn"
            type="button"
            disabled={wallpaperBusy || s.wallpaper === 'builtin:mountain'}
            onClick={() => void settings.save({ wallpaper: 'builtin:mountain' })}
          >
            {t('恢复默认壁纸')}
          </button>
        </div>
        {wallpaperNote !== null && <p className="dc-fineprint dc-muted">{wallpaperNote}</p>}
      </div>

      <hr className="dc-settings-sep" />

      <p className="dc-muted dc-fineprint">
        {t('毛玻璃四格。改一下立刻生效 —— 它们直接落成 CSS 变量，不重启、不刷新。')}
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
        {t('恢复外观默认')}
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
  const t = useT()
  return (
    <div className="dc-settings-row">
      <div className="dc-settings-row-head">
        <label className="dc-settings-row-label" htmlFor={`glass-${spec.key}`}>
          {t(spec.label)}
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
      <p className="dc-fineprint dc-muted">{t(spec.hint)}</p>
    </div>
  )
}
