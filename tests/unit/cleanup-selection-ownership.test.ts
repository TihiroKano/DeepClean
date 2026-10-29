/**
 * V0.5 Task 2 评审返工 I-1 ——「换页丢勾选」的**归属权**闸门。
 *
 * 缺陷本体：勾选以前住在 `Cleanup` 组件内部（`const [selected, setSelected] = useState`），
 * 而 `App` 是**条件渲染**的 —— 切一次视图就把 `Cleanup` 卸载，state 随之清零。真人路径：
 * 垃圾清理 → 勾好 → 点「清理记录」（Task 2 刚把这一步变成最自然的一跳）→ 点回来
 * ⇒「已勾 0 项」、两个按钮置灰、一个字都不提示。`9b2dad7` 曾拿 harness 在确认前重放一次全选
 * 把它盖掉 —— 那等于给产品缺陷加了个只有截图脚本才有的止痛药，修与不修在 PNG 上长得一模一样。
 *
 * 修法：勾选上移到 `App`，与 `tilePaths` 同一处（它当初就是为了导航存活才上移的，
 * 先例在本文件里）。本测试量的是"归属权真的换了"，共三条判据 + 一条反面对照：
 * 为什么是源码闸而不是行为闸 —— 本仓零新增依赖，`node_modules` 里没有 jsdom / testing-library，
 * `renderToStaticMarkup` 又不跑 effect（拿不到预估 payload，也就渲染不出「已勾 N 项」那一格）。
 * 真行为那一头由 `--shot` 的「换页前后 已勾 N 项 必须相同」判据在真实页面上把守；
 * 这里守的是别让人把状态搬回组件里去（搬回去截图就又不红了，正是本次返工要留下的痕迹）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = (rel: string): string => {
  const raw = readFileSync(join(process.cwd(), rel), 'utf8')
  // 剥掉注释再判：这条闸量的是"实现把状态搬走了没有"，一句写着"以前是组件内 state"的注释
  // 不该把它喂饱。（只认 `//` 与 `/* */` 两种形态，够用且不引依赖；真出现字符串里带斜杠的
  // 写法就误伤一行，届时红的是这条闸自己，不会反过来放绿。）
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const APP = src('src/renderer/App.tsx')
const CLEANUP = src('src/renderer/pages/Cleanup.tsx')

/** 归属权判据：App 必须**持有**这份勾选并把它传下去，Cleanup 必须**只读**它。 */
function ownershipGaps(app: string, cleanup: string): string[] {
  const gaps: string[] = []
  if (!/const \[[a-zA-Z]+, set[A-Z][a-zA-Z]+\] = useState<string\[\]>\(\[\]\)/.test(app)) gaps.push('App 里没有持有 string[] 勾选状态')
  if (!/selected=\{[a-zA-Z]+\}/.test(app)) gaps.push('App 没有把 selected 传给 Cleanup')
  if (!/onSelectedChange=\{set[A-Z][a-zA-Z]*\}/.test(app)) gaps.push('App 没有把改勾选的权力交回去（onSelectedChange）')
  if (/const \[selected[^\]]*\] = useState/.test(cleanup)) gaps.push('Cleanup 又把勾选变成了组件内部 state')
  if ((cleanup.match(/onSelectedChange\(/g) ?? []).length < 3) gaps.push('Cleanup 的三个改勾选入口（单条/全选/清空）没有都走父级')
  if (!/已勾 \{selected\.length\} 项/.test(cleanup)) gaps.push('「已勾 N 项」这一格不再是 selected.length 的函数 —— --shot 那条换页判据读的就是它')
  return gaps
}

describe('I-1：清理页勾选的归属权在 App，不在组件里', () => {
  it('当前实现：App 持有 + 传下，Cleanup 只读并回写', () => {
    expect(ownershipGaps(APP, CLEANUP), ownershipGaps(APP, CLEANUP).join('；')).toEqual([])
  })

  it('换扫描必须把上一轮的勾选一起丢掉（与 tilePaths 同一条纪律）', () => {
    const effect = /useEffect\(\(\) => \{[\s\S]*?\}, \[scan\.scanId\]\)/.exec(APP)
    expect(effect, 'App 里那个"换一次扫描就清账"的 effect 不见了').not.toBeNull()
    // ~~`setDupGroupIds([])`~~：重复文件检测（§20）下线后那一格 state 跟着撤了，
    // 纪律本身没变 —— 每一条"上一轮会话留下"的状态都必须在同一个 effect 里清掉。
    for (const setter of ['setTilePaths([])', 'setCleanSelected([])'])
      expect(effect![0]!, `${setter} 必须在同一个 effect 里 —— 半清半不清就是两张嘴`).toContain(setter)
  })

  it('反面对照：把状态搬回组件里（返工前的形状）时，这条闸必须逐条点名', () => {
    const before = ownershipGaps(
      APP,
      CLEANUP.replace(/onSelectedChange\(/g, 'setSelected(').replace(
        'export function Cleanup',
        'const [selected, setSelected] = useState<string[]>([])\nexport function Cleanup'
      )
    )
    expect(before.length, '这条闸谁都拦不住 —— 它是个恒过的空壳').toBeGreaterThan(0)
    expect(before.join('；')).toContain('组件内部 state')
  })

  it('反面对照（App 半边）：勾选没上移时同样必须红', () => {
    /**
     * `g` 是 V0.7 §3.6 逼出来的：App 现在把同一份 `cleanSelected` 交给两个受控视图
     * （`Cleanup` 与 `DevEnv`）。原来那条不带 `g` 的 replace 只摘第一处，于是加了第二个
     * 合法消费者之后，这条反面对照会"以为勾选还传着"而空过 —— 正是这条闸最不该有的形状。
     * 全局摘除后变异反而更强：只要 App 不再把勾选交给**任何**视图，它必须红。
     */
    expect(ownershipGaps(APP.replace(/selected=\{cleanSelected\}/g, ''), CLEANUP).join('；')).toContain('没有把 selected 传给')
  })
})
