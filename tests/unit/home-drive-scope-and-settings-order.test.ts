/**
 * 首页"这块盘"读数的**口径判据**（2026-10-29 两轮修复之后补上）。
 *
 * 这一组守的是一条**已经栽过两次**的路：
 *
 *  ① 第一版：`drives.find(d => d.root === root)`，而 `root` 是盘符下拉那一格
 *     （"下次扫哪"）⇒ 扫了 D 盘、首页还画着 C 盘。人类伙伴报：「当清理位置选择为
 *     其他盘时，主页面数据应该也跟着改变，而不是依旧显示 Windows 占用」。
 *  ② 第二版：改成 `snapshot?.root ?? null` ⇒ **没扫过就整块盘空着**，
 *     环是 0.0%、已使用与总容量都是「—」。人类伙伴报：「首次进入应该默认显示 C 盘
 *     数据啊，怎么全是 0」。
 *
 * 两版的错法是同一个：**把一个两级的问题当成一级**。
 * 正确的口径：
 *  - **有快照** → 读 `snapshot.root`（"刚才真扫了哪"），下拉怎么改都不动；
 *  - **没快照** → 读 `startTarget`（"下次要扫哪"），因为盘的容量来自 `listDrives()`，
 *    与扫描无关，从来没有"没扫过所以不显示"的理由。
 *
 * 为什么是源码闸：`useScan` 依赖 `window.deepclean`（四条 IPC），
 * 本仓 vitest 是 `environment: 'node'`，挂不起来。这里钉的是**那一行口径本身**，
 * 与 `cleanup-layout-contract.test.ts` 同一处先例。真行为那一头由真窗口截图把守。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const USE_SCAN = src('src/renderer/hooks/useScan.ts')
const HOME = src('src/renderer/pages/Home.tsx')
const SETTINGS = src('src/renderer/pages/Settings.tsx')
const APP = src('src/renderer/App.tsx')

/**
 * 盘容量**必须能被重新读取**（2026-10-30 修 bug）。
 *
 * 用户报的原话：「我日志记录了我刚刚进行了一次删除，但是主页面的值和我实际 C 盘
 * 剩余的值不一样，还是显示清理前的数值」（截图里实际空闲 3.31 GB，界面写 1.0 GB）。
 *
 * 根因不是算错，是**只算过一次**：`listDrives()` 原来只有一个 `useEffect(..., [])`，
 * 整个进程生命周期里盘容量都是挂载那一刻的快照。清理删掉 2 GB 之后没有任何地方
 * 重新读盘 —— 于是界面永远停在"清理前"。
 *
 * 这一组钉三个重读入口，缺任何一个都会让用户回到那个症状：
 *  ① 清理完成（`onCleanDone`）；
 *  ② 扫描进入终态（`useScan` 自己的 effect）；
 *  ③ 切回首页（`App` 的 view effect）。
 */
describe('盘容量能被重新读取（否则清理完首页永远是旧数）', () => {
  it('`useScan` 暴露 refreshDrives，且它是 useCallback 稳定引用', () => {
    expect(USE_SCAN, '`refreshDrives` 没暴露出去 —— App 那两处调不到').toMatch(/refreshDrives,/)
    // useCallback 是"能安全进 effect 依赖"的前提；写成普通函数会让调用方那个 effect
    // 每次渲染都重跑（切个 view 就打一次 IPC，还会互相触发）。
    expect(USE_SCAN, '`refreshDrives` 不是 useCallback 包出来的').toMatch(
      /const refreshDrives = useCallback\(/
    )
  })

  it('初始化那一次还在（挂载时要读一次，否则首页空着）', () => {
    expect(USE_SCAN, '初始读盘没了').toMatch(/useEffect\(\(\) => \{\s*refreshDrives\(\)\s*\}/)
  })

  it('扫描进入终态会重读（扫描那几十秒里盘会变）', () => {
    expect(USE_SCAN, '扫描终态那个 effect 不见了').toMatch(
      /scanStatus === 'completed'[\s\S]{0,200}refreshDrives\(\)/
    )
    // 反面对照：不许用 `running === false` 判 —— 那在"还没开始"时也成立，会多打一次 IPC
    expect(USE_SCAN, '用了 `!running` 那种判据（还没开始也成立）').not.toMatch(
      /if \(!scan\.running\)\s*\{\s*refreshDrives/
    )
  })

  it('清理完成会重读 —— 这是用户报的那个场景', () => {
    expect(APP, '`onCleanDone` 里没有重读盘容量').toMatch(
      /onCleanDone=\{\(\) => \{[\s\S]{0,400}refreshDrives\(\)/
    )
    // 两件事必须**都**在：nonce 管清理预览的缓存键，refreshDrives 管盘容量。
    // 只做前者正是这个缺陷的形状（预览刷新了、盘容量没动）。
    expect(APP, '`cleanRefreshNonce` 那一句丢了').toMatch(/setCleanRefreshNonce\(\(n\) => n \+ 1\)/)
  })

  it('切回首页会重读（用户可能在别的程序里删了东西，DeepClean 没有任何事件能知道）', () => {
    expect(APP, '切回首页没有重读').toMatch(/if \(view === 'home'\) scan\.refreshDrives\(\)/)
  })

  it('反面对照：`listDrives()` 不许只有一个 `[]` 依赖的 effect（那正是原来的缺陷）', () => {
    // 原来那一段是 `useEffect(() => { window.deepclean.listDrives().then(setDrives)... }, [])`
    // 直接把 listDrives 写在依赖为 `[]` 的 effect 里 = 一辈子只读一次。
    expect(USE_SCAN, '`listDrives()` 又被直接写进 `[]` 依赖的 effect 了').not.toMatch(
      /useEffect\(\(\) => \{\s*window\.deepclean\s*\.listDrives\(\)/
    )
  })
})

describe('首页"这块盘"的两级口径', () => {
  it('scannedRoot 的两级都在：有快照读快照，没快照读 startTarget', () => {
    /**
     * 这一条**逐字**钉那一行。只钉"有 snapshot.root"会漏掉第二版那个缺陷
     * （它确实读了 snapshot.root，只是没给 `??` 右边）；只钉"有 startTarget"
     * 会漏掉第一版（它读了 startTarget，但连快照都不看）。
     */
    const m = /const scannedRoot[^=]*=\s*snapshot\?\.root\s*\?\?\s*startTarget/.exec(USE_SCAN)
    expect(
      m,
      '`scannedRoot` 必须是 `snapshot?.root ?? startTarget` —— 少了右边那半，' +
        '没扫过时首页会是全 0（人类伙伴 2026-10-29 报的第二个症状）'
    ).not.toBeNull()
  })

  it('反面对照：`?? null` 的形状必须被挡住（那是上一次的错误修法）', () => {
    // 如果谁把它改回去，上面那条会红；这里再钉一次"不许是 null"，
    // 免得将来有人把两级合并成一句 `snapshot?.root ?? null` 又觉得"读的是快照嘛"。
    expect(USE_SCAN, '`scannedRoot` 不许回退成 null（那会让没扫过时整块盘空着）').not.toMatch(
      /const scannedRoot[^=]*=\s*snapshot\?\.root\s*\?\?\s*null/
    )
  })

  it('Home 不再自己按 `scannedRoot === null` 短路成 undefined', () => {
    /**
     * 第二版在 Home 里写着 `scannedRoot === null ? undefined : (...)` ——
     * 那是同一个缺陷的第二半（hook 给了 null、页面把 null 翻译成"什么都不画"）。
     * 现在 `scannedRoot` 是**非空**的 `string`，这个分支不该存在。
     */
    expect(HOME, 'Home 里还留着 `scannedRoot === null ? undefined` 的短路').not.toMatch(
      /scannedRoot === null/
    )
    // 正面：驱动盘一律由 drives 查出来，先精确后前缀
    expect(HOME, '驱动盘的查找丢了精确匹配').toMatch(/scan\.drives\.find\(\(d\) => d\.root === scannedRoot\)/)
    expect(HOME, '驱动盘的查找丢了盘符前缀回退（自定义目录要用它找所在那块盘）').toMatch(
      /scan\.drives\.find\(\(d\) => scannedRoot\.startsWith\(d\.root\)\)/
    )
  })
})

describe('设置页五块卡的顺序（2026-10-29 人类伙伴点名）', () => {
  it('语言 → 性能 → 外观 → 授权 → 关于', () => {
    /**
     * 顺序是产品决定，不是审美：语言必须第一（它决定后面四块怎么读 ——
     * 一个看不懂中文的人打开这一页，第一个要找的就是它）。
     *
     * 判据用 `indexOf` 逐个比较位置，而不是"五个都在" —— 后者对顺序一字未说。
     */
    const order = ['<LanguageCard', '<PerformanceCard', '<AppearanceCard', '<LicenseCard'].map((k) =>
      SETTINGS.indexOf(k)
    )
    for (let i = 0; i < order.length; i++) {
      expect(order[i], `第 ${i + 1} 块卡（${['LanguageCard', 'PerformanceCard', 'AppearanceCard', 'LicenseCard'][i]}）不在期望位置`).toBeGreaterThan(-1)
    }
    expect(order, '四块卡的顺序必须是 语言 < 性能 < 外观 < 授权').toEqual([...order].sort((a, b) => a - b))
    // 「关于」是内联的一段 section，不是组件 —— 它必须在 LicenseCard 之后
    const about = SETTINGS.indexOf("t('关于')")
    expect(about, '「关于」那块不在').toBeGreaterThan(-1)
    expect(about, '「关于」必须排在授权之后').toBeGreaterThan(order[3]!)
  })
})

describe('性能卡：删除速率（2026-10-30 第三轮：点阵 / 核数档位 / 60% 默认 / 无弹窗）', () => {
  it('标签是「删除速率」，读数里是「默认推荐」（不再是「并行倍数」/「推荐」）', () => {
    expect(SETTINGS, '「删除速率」这个标签不见了').toContain("t('删除速率')")
    expect(SETTINGS, '「默认推荐」这个读数不见了').toContain("t('默认推荐')")
    // 反面对照：旧的两个词必须真的不在（否则上面两条在旧标签还在时也绿）
    expect(SETTINGS, '旧的「并行倍数」标签还在').not.toContain("t('并行倍数')")
    expect(SETTINGS, '旧的「推荐」读数还在').not.toContain("t('推荐')")
  })

  it('那两段说明小字已经删掉（人类伙伴：「下面的小字取消」）', () => {
    // 原文是「推荐值 = 本机逻辑核数…」与「这台机器上按 N 条线程跑…」两段
    expect(SETTINGS, '旧的第一段说明还在').not.toContain('推荐值 = 本机逻辑核数')
    expect(SETTINGS, '旧的第二段说明还在').not.toContain('条线程跑')
  })

  it('档位数 = 本机逻辑核数（getHardware），不是 navigator 也不是写死', () => {
    expect(SETTINGS, '档位没有从 getHardware 取').toContain('window.deepclean.getHardware()')
    expect(SETTINGS, '用了 navigator.hardwareConcurrency —— 那是另一个来源，会与内核打架').not.toContain(
      'navigator.hardwareConcurrency'
    )
    // 点阵格子数由 stops 驱动（= 核数），不是写死的数组
    expect(SETTINGS, '格子不是按 stops 渲染的').toMatch(/length: stops/)
  })

  it('默认值 = 核数的 60%（2026-10-30 第三轮）', () => {
    // 算式出现且至少 1：Math.max(1, Math.round(stops * 0.6))
    expect(SETTINGS, '60% 默认档的算式不见了').toMatch(/Math\.max\(1,\s*Math\.round\(stops \* 0\.6\)\)/)
  })

  it('上限弹窗已取消（2026-10-30 第三轮：人类伙伴「取消上限弹窗」）', () => {
    /**
     * 第二轮加的弹窗在这一轮被点名取消 —— 实测已经证明拉高不会崩
     * （内存不涨、只是排队），弹窗是在替一个不存在的问题道歉。
     * 反面对照钉两个旧形状：alertdialog 与「知道了」按钮。
     */
    expect(SETTINGS, '阈值弹窗还在（role="alertdialog"）').not.toContain('role="alertdialog"')
    expect(SETTINGS, '阈值弹窗还在（知道了按钮）').not.toContain("t('知道了')")
  })

  it('点阵样式：格子可点击跳档、range 仍是真交互面（键盘/读屏不丢）', () => {
    // 点阵 DOM 在：cells 容器 + 每格一个 button
    expect(SETTINGS, '点阵格子容器不见了').toContain('dc-rate-cells')
    expect(SETTINGS, '格子不是 button（点击跳档靠它）').toMatch(/className=\{\s*'dc-rate-cell'/)
    // 真交互面仍在：range 的 onChange 还在 —— 换皮肤不许丢掉键盘与读屏
    expect(SETTINGS, 'range 的 onChange 丢了（键盘会失灵）').toMatch(/type="range"[\s\S]{0,600}onChange=/)
    // aria：读屏要能读到当前档位的含义
    expect(SETTINGS, 'range 的 aria-valuetext 丢了').toContain('aria-valuetext=')
  })

  it('读数是 xN 形式（2026-10-30 第四轮：线程俩字改为 x7 / x8 这种）', () => {
    // 显式档位：`x${current}`，模板串而不是走 t()（x7 / x8 这种记号不需要翻译）
    expect(SETTINGS, '显式档位的读数不是 xN 形式').toMatch(/current === defaultWorkers \? t\('默认推荐'\) : `x\$\{current\}`/)
    // 反面对照：旧的「N 线程」读数必须真的不在
    expect(SETTINGS, '旧的「{n} 线程」读数还在').not.toContain("t('{n} 线程'")
    // 参考图两端那两行说明字（更快/更强）按人类伙伴要求撤掉 —— 读数在右上角，
    // 再标两端是第三处说同一件事。
    expect(SETTINGS, '「更快」那端还在').not.toContain("t('更快')")
    expect(SETTINGS, '「更强」那端还在').not.toContain("t('更强')")
    // 读屏仍能读到档位含义（aria-valuetext 也换成 xN 形式）
    expect(SETTINGS, 'aria-valuetext 丢了').toMatch(/aria-valuetext=\{current === defaultWorkers \? t\('默认推荐'\) : `x\$\{current\}`\}/)
  })
})
