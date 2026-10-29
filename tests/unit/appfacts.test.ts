/**
 * `core/facts/appfacts.ts` 的用例（M5-P2 P2-T2，计划 §2.3 + §3-P2-T2）。
 *
 * 两条线：
 * 1. **对账线**：跑 Rust 侧同一份夹具（`src-tauri/crates/appfacts/tests/data/reference-shapes.json`），
 *    逐格比夹具声明的 `expect`，再逐格比 Rust 的投影 `reference-shapes.rust-table.json`。
 *    比两份不是冗余：`expect` 是**人写的期望**（两侧各自都要满足），投影是 **Rust 实算的结果** ——
 *    于是「TS 与 Rust 同意」是同一张表被真比了一遍，不是两边各自跟自己的副本点头。
 * 2. **判据线**：P2-T2 那七条硬判据里 TS 侧测得到的部分，各自独立成一条（不靠夹具也能红）。
 *
 * ⚠️ 这一侧一次 IO 都不做：夹具的 `contents` 就是它的整台机器（Rust 那侧才把树搬到 %TEMP% 下真读）。
 *    投影文件会静默过期：改了 Rust 判据不重生成，这里会红 —— 那是刻意的漂移探测，
 *    重生成命令写在那份文件的 `_generatedBy` 里。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ABSENT,
  BODY_CHANNELS,
  GENERIC_ROLE_NAMES,
  CH_INSTALL_ROOTS,
  CH_PACKAGES,
  CH_PROCESSES,
  CH_START_MENU,
  CH_UNINSTALL,
  CH_VENDOR_KEYS,
  PRESENT,
  TRACE_CHANNELS,
  collectAppFacts,
  evidenceFor,
  expandInstallLocation,
  emptyScan,
  extraInstallLocations,
  factFor,
  factKey,
  imageParentName,
  judge,
  nameMatches,
  nameMatchesLoose,
  nothingCollected,
  packageFamily,
  probeChannel,
  processScan,
  probeFor,
  projectTable,
  rootsWithFeedback,
  scanAll,
  unresolvableInstallLocations,
  uninstallScan,
  unknown,
  vendorKeyScan,
  type AppFact,
  type AppFactsTable,
  type CandidateEvidence,
  type FsEntry,
  type MachineEvidence,
} from '../../core/facts/appfacts'

const DATA = join(
  process.cwd(),
  'src-tauri',
  'crates',
  'appfacts',
  'tests',
  'data',
)

interface FixtureEntry {
  key: string
  displayName: string | null
  installLocation: string | null
}

interface FixtureRoot {
  path: string
  status: 'listed' | 'missing' | 'unavailable'
  why?: string
  entries?: FixtureEntry[]
  keys?: string[]
}

interface FixtureCase {
  name: string
  candidates: string[]
  roots: { channel: 'packages' | 'install' | 'startMenu'; path: string; status: string; extra?: boolean }[]
  contents: Record<string, { name: string; kind: 'dir' | 'file' }[]>
  registry: { uninstall: FixtureRoot[]; vendors: FixtureRoot[] }
  processes: { status: string; why?: string; records: { exe: string; image: string | null }[] }
  env: Record<string, string>
  expect: Record<string, string>
}

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(DATA, file), 'utf8')) as T
}

const fixture = loadJson<{ cases: FixtureCase[] }>('reference-shapes.json')
const rustProjection = loadJson<{ cases: { name: string; table: Record<string, string> }[] }>(
  'reference-shapes.rust-table.json',
)

function toEvidence(c: FixtureCase): MachineEvidence {
  return {
    roots: c.roots.map((r) => ({
      channel: r.channel,
      path: r.path,
      status: r.status as MachineEvidence['roots'][number]['status'],
      extra: r.extra,
    })),
    contents: c.contents as Record<string, FsEntry[]>,
    registry: {
      uninstall: c.registry.uninstall.map((r) => ({
        path: r.path,
        status: r.status,
        why: r.why,
        entries: r.entries ?? [],
      })),
      vendors: c.registry.vendors.map((r) => ({
        path: r.path,
        status: r.status,
        why: r.why,
        keys: r.keys ?? [],
      })),
    },
    processes: {
      status: c.processes.status as MachineEvidence['processes']['status'],
      why: c.processes.why,
      records: c.processes.records,
    },
    env: c.env,
  }
}

function caseByName(name: string): FixtureCase {
  const c = fixture.cases.find((x) => x.name === name)
  if (c === undefined) throw new Error(`夹具没有 case「${name}」`)
  return c
}

function rustTableOf(name: string): Record<string, string> {
  const c = rustProjection.cases.find((x) => x.name === name)
  if (c === undefined) throw new Error(`Rust 的投影里没有 case「${name}」—— 重生成：见 reference-shapes.rust-table.json 的 _generatedBy`)
  return c.table
}

function tableOf(name: string): { table: AppFactsTable; c: FixtureCase } {
  const c = caseByName(name)
  return { table: collectAppFacts(c.candidates, toEvidence(c)), c }
}

// ---------------------------------------------------------------- 对账线

describe('the_ts_and_rust_tables_agree_on_the_same_fixture', () => {
  it('每条 case 的每一格都同时等于夹具的 expect 与 Rust 的投影', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(8)
    for (const c of fixture.cases) {
      const table = collectAppFacts(c.candidates, toEvidence(c))
      const projected = projectTable(table)
      const rust = rustTableOf(c.name)
      for (const cand of c.candidates) {
        const key = factKey(cand)
        const want = c.expect[key]
        expect(want, `case「${c.name}」的 expect 里少了「${key}」这一格`).toBeDefined()
        expect(projected[key], `case「${c.name}」的「${key}」：夹具期望 ${want}`).toBe(want)
        expect(projected[key], `case「${c.name}」的「${key}」：Rust 投影是 ${rust[key]}`).toBe(rust[key])
      }
      // 表不能比期望多出格子（多出来的那一格是没被人写过结论的）。
      expect(Object.keys(projected).sort()).toEqual(Object.keys(c.expect).sort())
      expect(Object.keys(rust).sort()).toEqual(Object.keys(c.expect).sort())
    }
  })

  it('三档都在对账里出现过（两侧一致地只会弃权不算对账）', () => {
    const seen = new Set<string>()
    for (const c of fixture.cases) {
      for (const v of Object.values(projectTable(collectAppFacts(c.candidates, toEvidence(c))))) {
        seen.add(v)
      }
    }
    expect([...seen].sort()).toEqual(['absent', 'present', 'unknown'])
  })
})

describe('the_three_reference_counterexamples_never_come_back_absent', () => {
  it('Claude / kazumi / urban-friendship-story 各自回 Present 或弃权，一条都不许回 absent', () => {
    for (const name of ['claude-msix', 'kazumi-running', 'urban-no-evidence']) {
      const c = caseByName(name)
      const projected = projectTable(collectAppFacts(c.candidates, toEvidence(c)))
      for (const [key, state] of Object.entries(projected)) {
        expect(state, `§0.2 的反例「${name}」的「${key}」回来了 absent —— 那一档后面接删除`).not.toBe('absent')
      }
    }
    expect(projectTable(tableOf('claude-msix').table).claude).toBe('present')
    expect(projectTable(tableOf('kazumi-running').table).kazumi).toBe('present')
    expect(projectTable(tableOf('urban-no-evidence').table)['urban-friendship-story']).toBe('unknown')
  })
})

// ---------------------------------------------------------------- 判据线：三路通道

describe('c1_uninstall_entry_makes_it_present', () => {
  const clean = (entries: FixtureEntry[]): MachineEvidence => {
    const base = tableOf('claude-registered-on-d')
    const ev = toEvidence(base.c)
    ev.registry = {
      uninstall: [{ path: 'HKLM/SOFTWARE/…/Uninstall（64 位视图）', status: 'listed', entries }],
      vendors: [{ path: 'HKLM/SOFTWARE（64 位视图顶层键）', status: 'listed', keys: ['Microsoft'] }],
    }
    return ev
  }

  it('卸载表里有这一条 ⇒ Present（分隔符歧义这一侧要认）', () => {
    const ev = clean([{ key: 'acme_notepad', displayName: 'Acme Notepad', installLocation: null }])
    const table = collectAppFacts(['acme-notepad'], ev)
    expect(table['acme-notepad']).toEqual(PRESENT)
  })

  it('条目登记在 WOW6432Node 那一根也算（三根都读）', () => {
    const ev = clean([
      { key: 'x', displayName: '别的', installLocation: null },
    ])
    ev.registry.uninstall.push({
      path: 'HKLM/SOFTWARE/WOW6432Node/…/Uninstall（32 位视图）',
      status: 'listed',
      entries: [{ key: '{GUID}', displayName: 'Zoom Cloud', installLocation: null }],
    })
    expect(collectAppFacts(['zoom-cloud'], ev)['zoom-cloud']).toEqual(PRESENT)
  })

  it('那一根取不到证据时既不 Present 也不 absent —— 弃权，并点名 C1', () => {
    const ev = clean([])
    ev.registry.uninstall[0] = { path: 'HKLM/…', status: 'unavailable', why: 'RegOpenKeyExW 失败（错误码 5）', entries: [] }
    ev.registry.vendors = [{ path: 'HKLM/SOFTWARE', status: 'listed', keys: ['acme-notepad'] }]
    const fact = collectAppFacts(['acme-notepad'], ev)['acme-notepad'] as AppFact
    expect(fact.state).toBe('unknown')
    expect(fact.state === 'unknown' ? fact.why : '').toContain('C1')
  })
})

describe('c2_vendor_key_alone_is_only_a_trace', () => {
  // ⚠️ 这里**不许**把 startMenu 那几根删掉。少一根不是「痕迹少了 C6 这一路」，而是
  // 「C6 一个根都没配上」= 这一路**没看成**（Rust 的 `channel.rs::probe` 里
  // `roots_configured == 0` 那一档，TS 的 `probeChannel` 逐字同法），判据第 ② 步先接住 ⇒ 弃权，
  // 于是本条用例要测的那个形状（四条本体全部「看成了、空的」+ 一条痕迹）根本搭不出来。
  // Rust 侧的同名孪生用例 `c2_vendor_key_alone_is_only_a_trace`（`tests/collect.rs`）也是
  // 留着开始菜单根、只把厂商键换成 `Zebrafish`，然后断 `judge(&ev) == AppFact::Absent`。
  // acme-residual 的开始菜单里只有 `Acme-tool.lnk`，对 `zebrafish` 是「看过、没命中」，正是要的形状。
  const ev = (): MachineEvidence => {
    const c = toEvidence(caseByName('acme-residual'))
    c.registry.vendors = [{ path: 'HKLM/SOFTWARE（64 位视图顶层键）', status: 'listed', keys: ['Zebrafish'] }]
    return c
  }

  it('厂商键不是本体：单凭它抬不到 Present', () => {
    const scan = scanAll(ev())
    expect(probeFor(scan, CH_UNINSTALL, 'zebrafish').probe).not.toBe('hit')
    expect(probeFor(scan, CH_VENDOR_KEYS, 'zebrafish').probe).toBe('hit')
    expect(collectAppFacts(['zebrafish'], ev())['zebrafish']).not.toEqual(PRESENT)
  })

  it('四条本体逐条「看成了、空的」+ 一条痕迹 ⇒ absent；任一条没看成 ⇒ 弃权', () => {
    expect(collectAppFacts(['zebrafish'], ev())['zebrafish']).toEqual(ABSENT)
    const broken = ev()
    broken.roots = broken.roots.map((r) =>
      r.channel === 'packages' ? { ...r, status: 'unavailable' as const, why: 'ACL 拒' } : r,
    )
    const fact = collectAppFacts(['zebrafish'], broken)['zebrafish'] as AppFact
    expect(fact.state).toBe('unknown')
    expect(fact.state === 'unknown' ? fact.why : '').toContain('C3')
  })

  it('痕迹的口径是字面的，而且证据串里没有路径段', () => {
    const scan = scanAll(ev())
    for (const k of ['windows', 'currentversion', 'uninstall', 'software']) {
      expect(probeFor(scan, CH_VENDOR_KEYS, k).probe, `厂商键的证据里混进了路径段「${k}」`).not.toBe('hit')
    }
    expect(nameMatches('acme-tool', 'Acme Tool')).toBe(false)
    expect(nameMatches('acme-tool', 'acme-tool')).toBe(true)
  })
})

describe('c5_a_running_process_makes_it_present', () => {
  const base = (): MachineEvidence => toEvidence(caseByName('urban-no-evidence'))

  it('进程在跑 ⇒ Present', () => {
    const ev = base()
    ev.processes = {
      status: 'listed',
      records: [
        { exe: 'svchost.exe', image: 'C:/Windows/System32/svchost.exe' },
        { exe: 'Zoom.exe', image: 'D:/Apps/Zoom/bin/Zoom.exe' },
      ],
    }
    expect(collectAppFacts(['zoom'], ev)['zoom']).toEqual(PRESENT)
  })

  it('完整路径拿不到（保护进程）不降级：名字来自枚举本身', () => {
    const ev = base()
    ev.processes = { status: 'listed', records: [{ exe: 'Zoom.exe', image: null }] }
    expect(collectAppFacts(['zoom'], ev)['zoom']).toEqual(PRESENT)
    const cs = processScan(ev.processes)
    expect(cs.emptyNotes.join('；')).toContain('拿不到')
  })

  it('没采集 / 断了 / 空表 —— 三档都不许被读成「它没在跑」', () => {
    for (const snap of [
      { status: 'unavailable' as const, why: '默认值', records: [] },
      { status: 'unavailable' as const, why: 'Process32NextW 在第 12 个进程处中断', records: [] },
      { status: 'listed' as const, records: [] },
    ]) {
      const ev = base()
      ev.registry.vendors = [{ path: 'HKLM/SOFTWARE', status: 'listed', keys: ['zoom'] }]
      ev.roots = ev.roots.filter((r) => r.channel !== 'startMenu')
      ev.processes = snap
      const fact = collectAppFacts(['zoom'], ev)['zoom'] as AppFact
      expect(fact.state, `快照 {${JSON.stringify(snap)}} 被读成了某一档`).toBe('unknown')
      expect(fact.state === 'unknown' ? fact.why : '').toContain('C5')
    }
  })

  it('整条镜像路径不进证据：只有上一级目录名进（否则用户名里的词会造出凭空的 Present）', () => {
    expect(imageParentName('D:/Software/Claude/Claude.exe')).toBe('Claude')
    // 「上一级」= 紧挨着 exe 的那一段，不是用户名那一段。Rust 的 `image_parent_name`
    // （`procs.rs`）取的是 `segs.rev()` 的第二格 ⇒ `C:/Users/claude/Desktop/app.exe` → `Desktop`。
    // 这一条原来断的是 `'claude'`：那既不是 Rust 的实算，也正是这条规则要**挡掉**的那种泄漏
    // （用户名里的词进证据 ⇒ 凭空的 Present），所以改成断 `'Desktop'`，并把真正承重的那一句
    // 补在下面：候选名与用户名同名时也不许从 C5 拿到命中。
    expect(imageParentName('C:/Users/claude/Desktop/app.exe')).toBe('Desktop')
    const cs = processScan({ status: 'listed', records: [{ exe: 'app.exe', image: 'C:/Windows/System32/app.exe' }] })
    expect(cs.entries).not.toContain('C:/Windows/System32/app.exe')

    const leak = processScan({
      status: 'listed',
      records: [{ exe: 'app.exe', image: 'C:/Users/claude/Desktop/app.exe' }],
    })
    expect(leak.entries, '整条镜像路径不许进证据').not.toContain('C:/Users/claude/Desktop/app.exe')
    expect(leak.entries).toContain('Desktop')
    expect(
      probeChannel(leak, 'claude').probe,
      `C5 的证据里漏进了用户名那一段：${leak.entries.join('；')}`,
    ).not.toBe('hit')
  })
})

// ---------------------------------------------------------------- 判据线：§4.4 与 fail-safe

describe('install_location_feeds_extra_roots_so_d_drive_apps_are_present', () => {
  it('Claude 登记了、InstallLocation 在 D 盘 ⇒ Present，且那个根真的进了 C4 的清单', () => {
    const c = caseByName('claude-registered-on-d')
    const ev = toEvidence(c)
    const fed = rootsWithFeedback(ev)
    expect(fed.some((p) => p.toLowerCase().endsWith('claude')), JSON.stringify(fed)).toBe(true)
    expect(projectTable(collectAppFacts(c.candidates, ev)).claude).toBe('present')
    expect(extraInstallLocations(ev.registry, ev.env).length).toBeGreaterThan(0)
  })

  it('GUID 键 + InstallLocation 那条刀锋：装在别的盘的应用不许被提议删除', () => {
    const c = caseByName('d-drive-name-mismatch')
    const projected = projectTable(collectAppFacts(c.candidates, toEvidence(c)))
    expect(projected['urban-friendship-story']).toBe('present')
  })

  it('展不开的 InstallLocation 变成盲区点名，不是静默丢弃', () => {
    const c = caseByName('install-location-unexpandable')
    const ev = toEvidence(c)
    expect(extraInstallLocations(ev.registry, ev.env)).toEqual([])
    expect(unresolvableInstallLocations(ev.registry, ev.env)).toEqual(['ghost-app'])
    expect(projectTable(collectAppFacts(c.candidates, ev))['ghost-app']).toBe('unknown')
  })

  it('陈旧 InstallLocation（指向不存在的位置）不许凭空 Present', () => {
    // 与 Rust 侧的孪生用例 `install_location_feeds_extra_roots_so_d_drive_apps_are_present`
    // 里那段 `4-4-stale` 同形状：GUID 键 + 空 DisplayName + 一个**没建出来**的 InstallLocation，
    // 痕迹留在厂商键上，然后断的就是 absent。Rust 那侧同样**留着**开始菜单根
    // （`FakeMachine::roots()` 的两条 start_menu_roots 都在）—— 删掉它就不是「四条本体逐条
    // 看成了、空的」那一格，而是「C6 没看成」那一格，判据第 ② 步先接住 ⇒ 弃权。
    const ev = toEvidence(caseByName('claude-registered-on-d'))
    ev.registry.uninstall = [
      {
        path: 'HKLM/…',
        status: 'listed',
        entries: [{ key: '{GUID}', displayName: null, installLocation: 'D:/Nowhere/Gone' }],
      },
    ]
    ev.registry.vendors = [{ path: 'HKLM/SOFTWARE', status: 'listed', keys: ['gone'] }]
    expect(projectTable(collectAppFacts(['gone'], ev)).gone).toBe('absent')
    const scan = scanAll(ev)
    // 先断"这个通道在结果里"再用它：少了这句，索引拿空也能被后面那句静默跳过
    expect(scan[CH_INSTALL_ROOTS], `scanAll 没返回 ${CH_INSTALL_ROOTS} 通道`).toBeDefined()
    expect(scan[CH_INSTALL_ROOTS]!.emptyNotes.join('；')).toContain('不存在')
    // 那个额外根的 basename 不许进本体证据（进了就是凭空的 Present，这条断言也就白写）。
    expect(scan[CH_INSTALL_ROOTS]!.entries, `陈旧 InstallLocation 的 basename 被当成本体证据了`).not.toContain('Gone')
  })

  it('额外根指向 listed key 下的一个目录条目 = 那个位置在 ⇒ 本体证据（不许折成「不存在」）', () => {
    // Rust 那侧 `materialize` 是把 `kind:"dir"` 的条目 `create_dir_all` 出来的，所以
    // 「某一条目叫这个名字」与「它是某一个 key」在那棵树里同样是存在。查不出来那一格
    // 就是把真实存在的应用判成残留（多删方向）—— 这条测的是 `pathKindInTree` 的那一支。
    const ev = toEvidence(caseByName('acme-residual'))
    ev.contents = {
      ...ev.contents,
      'D:/Apps/Gadget': [{ name: 'Widget', kind: 'dir' }],
    }
    ev.registry.uninstall = [
      {
        path: 'HKLM/…',
        status: 'listed',
        entries: [{ key: '{A1B2}', displayName: null, installLocation: 'D:/Apps/Gadget/Widget' }],
      },
    ]
    ev.registry.vendors = [{ path: 'HKLM/SOFTWARE', status: 'listed', keys: ['Widget'] }]
    const scan = scanAll(ev)
    expect(scan[CH_INSTALL_ROOTS]!.entries, '额外根的 basename 没进本体证据').toContain('Widget')
    expect(scan[CH_INSTALL_ROOTS]!.emptyNotes.join('；')).not.toContain('Widget')
    // 断到档位为止：痕迹在、本体**命中** ⇒ Present，绝不是 absent。
    expect(projectTable(collectAppFacts(['widget'], ev)).widget).toBe('present')
  })

  it('额外根指向一条文件 ⇒ 这一路没取到证据（Rust 对文件 read_dir 报的不是 NotFound）', () => {
    // 真机上是有这种脏值的（`InstallLocation` 写成 exe 自己的路径）。Rust 那一侧
    // `read_dir` 给的是「其它错误」那一支 ⇒ `failures` ⇒ 判据第 ② 步弃权；
    // 折成「那个位置不存在」就成了 absent（删除方向）。
    const ev = toEvidence(caseByName('acme-residual'))
    ev.contents = {
      ...ev.contents,
      'D:/Apps/Gadget': [{ name: 'widget.exe', kind: 'file' }],
    }
    ev.registry.uninstall = [
      {
        path: 'HKLM/…',
        status: 'listed',
        entries: [{ key: '{A1B2}', displayName: null, installLocation: 'D:/Apps/Gadget/widget.exe' }],
      },
    ]
    ev.registry.vendors = [{ path: 'HKLM/SOFTWARE', status: 'listed', keys: ['Gadget'] }]
    const scan = scanAll(ev)
    expect(scan[CH_INSTALL_ROOTS]!.failures.join('；'), '指向文件的额外根没被记成「没取到证据」').toContain('文件')
    const fact = collectAppFacts(['gadget'], ev).gadget as AppFact
    expect(fact.state).toBe('unknown')
    expect(fact.state === 'unknown' ? fact.why : '').toContain('C4')
  })

  it('正斜杠、引号、%VAR% 三种写法都按 Rust 同法处理', () => {
    const env = { LOCALAPPDATA: 'C:/Users/x/AppData/Local' }
    expect(expandInstallLocation('"D:\\App\\"', env)).toBe('D:\\App')
    expect(expandInstallLocation('C:/Tools/Foo', env)).toBe('C:\\Tools\\Foo')
    // 斜杠归一只发生在**进 %VAR% 展开之前**那一次（Rust `registry.rs::expand_install_location`
    // 第一行是 `raw.trim()…replace('/', "\\")`，`expand_percent_vars` 里插值是
    // `out.push_str(&value)` —— 注入表交出来的值**逐字**拼进去，不第二次归一）。
    // 原来这一条断的是「展完再归一一次」：那既不是 Rust 的实算，多归一那一次还会把
    // basename 长度闸一起改严（`C:/ab` 这种值归一后只剩 2 个字符 ⇒ 整个额外根被判成展不开），
    // 那是丢一条 Present ⇒ 多判 Absent 的方向，所以基准侧不许自己加这一步。
    expect(expandInstallLocation('%LOCALAPPDATA%\\Programs\\Foo', env)).toBe('C:/Users/x/AppData/Local\\Programs\\Foo')
    // 真机口径（Windows 交出来的 env 值本来就是反斜杠）：与 Rust 的
    // `install_locations_expand_into_extra_roots` 里 `%LOCALAPPDATA%\Programs\WithVar` 那一条逐字同。
    expect(expandInstallLocation('%LOCALAPPDATA%\\Programs\\Foo', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' })).toBe(
      'C:\\Users\\x\\AppData\\Local\\Programs\\Foo',
    )
    expect(expandInstallLocation('%NOPE%\\Foo', env)).toBeNull()
    expect(expandInstallLocation('Apps/Relative', env)).toBeNull()
    expect(expandInstallLocation('D:\\', env)).toBeNull()
    expect(expandInstallLocation('', env)).toBeNull()
    // MSI 的 `%%` 转义与 UNC：Rust 的 `a_lone_percent_is_left_alone_but_an_unknown_var_is_not` /
    // `quoted_and_slashed_install_locations_still_work` 各钉了一次，这两格基准侧也要有。
    expect(expandInstallLocation('D:\\A%%B\\App', env)).toBe('D:\\A%B\\App')
    expect(expandInstallLocation('\\\\nas\\share\\App', env)).toBe('\\\\nas\\share\\App')
  })
})

describe('a_standard_root_basename_is_not_body_evidence_p2_t3_ruling', () => {
  /**
   * 主会话裁定（plan `2026-10-13-deepclean-tauri-m5-p2.md` §5 末，P2-T2 遗留分歧 (b)）要求钉住的那一格：
   * **候选名恰好等于某个标准根的 basename，而 `InstallLocation` 就指向那个标准根本身**
   * （MSI 的脏值真的就这么写）。裁定是「Rust 是对的，TS 缺的是 dedup」，所以这一格钉的是基准侧
   * 与 Rust 同法之后的行为 —— 不是把 Rust 改成和 TS 一样。
   *
   * 为什么"相等 ⇒ 留下先插入的那一份（`extra = false`）"是设计：`extra` 的语义是
   * 「调用方**点名**这里装着某个应用 ⇒ 这个位置的存在就是本体证据」
   * （`crates/appfacts/src/lib.rs:307-312`）。标准根的 basename（`Program Files`）不是应用名，
   * 把它当本体证据会让**每一个**装在 `C:\Program Files\Foo` 的应用凭空拿到 `Program Files`
   * 这个 token，反过来也让"标准根本身"被当成某个同名应用的安装位置。
   *
   * ⚠️ 方向如实写清楚：对齐之后基准在这种构造形状上**更容易判 absent**（更偏删）。
   * 所以这一格必须两边都钉：正半边走 dedup（相等 ⇒ 降级成标准根 ⇒ absent），
   * 反半边把那份标准根从清单里拿走 ⇒ 同一条 `InstallLocation` 就真的是一条额外根 ⇒ Present。
   * 少了反半边，"额外根的 basename 算本体证据"那一段可以整块失效而两条断言照样绿。
   */
  const PF = 'C:\\Program Files'
  const START_MENU = 'C:\\Users\\Kano\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs'
  /** 候选 = 一个叫 `Program Files` 的目录：basename 恰好等于标准根那个名字（`factKey` ⇒ `program files`）。 */
  const CANDIDATE = 'C:\\SomeApp\\Program Files'

  /** 除了"相等"那一格以外全都干净的注入面：四条本体通道逐条"看成了、没命中"，痕迹只有 C6 那一根 `.lnk`。 */
  const ev = (): MachineEvidence => ({
    roots: [
      { channel: 'packages', path: 'C:\\Local\\Packages', status: 'listed' },
      // 标准根**先入**（与 Rust `ProbeRoots::from_env_vars` 同序），额外根由反馈环**后 push**
      // （`roots_with_feedback` ⇒ `push_extra_install_root`）⇒ 逐字相等时留下的是 `extra = false` 那一份。
      { channel: 'install', path: PF, status: 'listed' },
      { channel: 'install', path: 'C:\\Program Files (x86)', status: 'listed' },
      { channel: 'startMenu', path: START_MENU, status: 'listed' },
    ],
    contents: {
      'C:\\Local\\Packages': [],
      [PF]: [{ name: 'Zebrafish', kind: 'dir' }],
      'C:\\Program Files (x86)': [],
      // 痕迹那一半：开始菜单里一根同名快捷方式（C6 只当痕迹，抬不到 Present）
      [START_MENU]: [{ name: 'Program Files.lnk', kind: 'file' }],
    },
    registry: {
      uninstall: [
        {
          path: 'HKLM/SOFTWARE/Microsoft/Windows/CurrentVersion/Uninstall（64 位视图）',
          status: 'listed',
          // 键名与 DisplayName 都不许与候选撞上 —— 否则 C1 那条本体通道先把 Present 抬起来，
          // 这一格要测的 C4 行为就永远走不到判据那一步。
          entries: [{ key: 'Zebrafish', displayName: 'Zebrafish Viewer', installLocation: '%ProgramFiles%' }],
        },
      ],
      vendors: [{ path: 'HKLM/SOFTWARE（64 位视图顶层键）', status: 'listed', keys: ['Zebrafish'] }],
    },
    processes: { status: 'listed', records: [{ exe: 'explorer.exe', image: 'C:\\Windows\\explorer.exe' }] },
    env: { ProgramFiles: PF },
  })

  it('相等的那条 InstallLocation 被去重成那份标准根：rootsConfigured 不涨、basename 不进证据串', () => {
    // 先确认反馈环真的产出了那一条额外根 —— 否则下面两句都在测"根本没有额外根"那种空转
    expect(rootsWithFeedback(ev())).toEqual([PF])
    // `!`：`scanAll` 的构造就是把六条通道逐个填进这张表（`Record<string, ChannelScan>` 的
    // 键在此处必在），索引类型认不出来而已。
    const cs = scanAll(ev())[CH_INSTALL_ROOTS]!
    expect(cs.rootsConfigured, '相等的一条 InstallLocation 没被去重成「那份标准根」').toBe(2)
    expect(
      cs.entries,
      '标准根的 basename 混进了本体证据串 —— 每一个装在 C:\\Program Files\\Foo 的应用都会凭空拿到这个 token',
    ).not.toContain('Program Files')
    // 而标准根**自己**的一级目录照旧算证据（去重不是把这一路关掉）
    expect(cs.entries).toContain('Zebrafish')
    expect(cs.failures, '这一路被折成「没取到证据」了：缺席不等于没看过').toEqual([])
  })

  it('候选名等于标准根 basename ⇒ 两半成立，判 absent（对齐之后更偏删，所以这一格必须点名）', () => {
    const fact = collectAppFacts([CANDIDATE], ev())[factKey(CANDIDATE)]!
    expect(fact).toEqual(ABSENT)
    // 而且这个 absent 是**判出来的**，不是弃权凑出来的：四条本体逐条"看成了、没命中"
    const scan = scanAll(ev())
    for (const ch of BODY_CHANNELS) {
      expect(probeFor(scan, ch, factKey(CANDIDATE)).probe, `${ch} 不是"看过且没命中"`).toBe('checked-no-hit')
    }
    expect(probeFor(scan, CH_START_MENU, factKey(CANDIDATE)).probe).toBe('hit')
  })

  it('反半边（这条判据的牙）：把那份标准根从清单里拿走，同一条 InstallLocation 就是额外根 ⇒ Present', () => {
    const noStandard = ev()
    noStandard.roots = noStandard.roots.filter((r) => !(r.channel === 'install' && r.path === PF))
    expect(rootsWithFeedback(noStandard)).toEqual([PF])
    const cs = scanAll(noStandard)[CH_INSTALL_ROOTS]!
    expect(cs.entries, '额外根的 basename 没算进本体证据 —— 那 §4.4 那个反馈环就白搭了').toContain('Program Files')
    expect(collectAppFacts([CANDIDATE], noStandard)[factKey(CANDIDATE)]).toEqual(PRESENT)
    // 顺带钉住"这不是把整条规则关掉"：同一个候选在正半边那一格里是 absent，不是 unknown
    expect(collectAppFacts([CANDIDATE], ev())[factKey(CANDIDATE)]!.state).not.toBe('unknown')
  })
})

describe('an_unavailable_channel_can_never_be_read_as_checked_and_empty', () => {
  const cleanFixture = (): MachineEvidence => toEvidence(caseByName('acme-residual'))

  it('基线形状先能出 absent（否则下面每一换都测不到东西）', () => {
    expect(projectTable(collectAppFacts(['acme-tool'], cleanFixture()))['acme-tool']).toBe('absent')
  })

  it('六路每一路换成「没看成」都把 absent 打回弃权，并点名是哪一路', () => {
    const cases: [string, (ev: MachineEvidence) => void][] = [
      [CH_UNINSTALL, (ev) => { ev.registry.uninstall = [{ path: 'HKLM/…', status: 'unavailable', why: '错误码 5' }] }],
      [CH_VENDOR_KEYS, (ev) => { ev.registry.vendors = [{ path: 'HKLM/SOFTWARE', status: 'unavailable', why: '枚举断了' }] }],
      [CH_PACKAGES, (ev) => { ev.roots = ev.roots.map((r) => (r.channel === 'packages' ? { ...r, status: 'unavailable' as const, why: 'ACL 拒' } : r)) }],
      [CH_INSTALL_ROOTS, (ev) => { ev.roots = ev.roots.filter((r) => r.channel !== 'install') }],
      [CH_PROCESSES, (ev) => { ev.processes = { status: 'unavailable', why: '快照没建起来', records: [] } }],
      [CH_START_MENU, (ev) => { ev.roots = ev.roots.map((r) => (r.channel === 'startMenu' ? { ...r, status: 'unavailable' as const, why: '读不出来' } : r)) }],
    ]
    for (const [channel, breakIt] of cases) {
      const ev = cleanFixture()
      breakIt(ev)
      const fact = collectAppFacts(['acme-tool'], ev)['acme-tool'] as AppFact
      expect(fact.state, `通道「${channel}」没取证却给出了结论`).toBe('unknown')
      expect(fact.state === 'unknown' ? fact.why : '', `why 要点名「${channel}」`).toContain(channel)
    }
  })

  it('一条通道都没接上（空表）⇒ 全表弃权', () => {
    const table = collectAppFacts(['acme-tool'], nothingCollected())
    const fact = table['acme-tool'] as AppFact
    expect(fact.state).toBe('unknown')
    for (const ch of [...BODY_CHANNELS, ...TRACE_CHANNELS]) {
      expect(fact.state === 'unknown' ? fact.why : '', `why 要点名 ${ch}`).toContain(ch)
    }
  })

  it('没采集的注册表快照不是「卸载表是空的」', () => {
    const cs = uninstallScan({ uninstall: [], vendors: [] })
    expect(probeChannel(cs, 'claude').probe).toBe('unavailable')
    const vs = vendorKeyScan({ uninstall: [], vendors: [] })
    expect(probeChannel(vs, 'claude').probe).toBe('unavailable')
  })

  it('空 why 不许静默出厂（与 Rust 的 AppFact::unknown 同一条纪律）', () => {
    const f = unknown('   ') as AppFact
    expect(f.state).toBe('unknown')
    expect(f.state === 'unknown' ? f.why.trim() : '').not.toBe('')
  })
})

// ---------------------------------------------------------------- 表形状与 key

describe('the_table_shape_matches_the_rust_side', () => {
  it('factKey 与引擎的 basename 口径同法（绝对路径也接）', () => {
    expect(factKey('Claude')).toBe('claude')
    expect(factKey('C:\\Users\\x\\AppData\\Roaming\\Claude')).toBe('claude')
    expect(factKey('C:/Users/x/AppData/Local/Packages/')).toBe('packages')
    expect(factKey('')).toBe('')
    expect(factKey('C:\\')).toBe('c:')
  })

  it('缺键 = Unknown（带 why），不是「可以删」', () => {
    const table: AppFactsTable = {}
    const fact = factFor(table, 'C:\\Users\\x\\AppData\\Roaming\\Ghost') as AppFact
    expect(fact.state).toBe('unknown')
    const why = fact.state === 'unknown' ? fact.why : ''
    expect(why).toContain('ghost')
  })

  it('判据四步的顺序：Present > 弃权 > 无痕迹弃权 > absent', () => {
    const ev = (body: ('hit' | 'no' | 'un')[], traces: ('hit' | 'no' | 'un')[]): CandidateEvidence => ({
      body: BODY_CHANNELS.map((channel, i) => ({ channel, probe: probe(body[i] ?? 'no') })),
      traces: TRACE_CHANNELS.map((channel, i) => ({ channel, probe: probe(traces[i] ?? 'no') })),
    })
    const probe = (k: 'hit' | 'no' | 'un') =>
      k === 'hit' ? ({ probe: 'hit', detail: '条目「X」' } as const) : k === 'no' ? ({ probe: 'checked-no-hit' } as const) : ({ probe: 'unavailable', why: '没看成' } as const)
    expect(judge(ev(['hit', 'no', 'no', 'no'], ['no', 'no']))).toEqual(PRESENT)
    expect(judge(ev(['no', 'un', 'no', 'no'], ['hit', 'no']))!.state).toBe('unknown')
    expect(judge(ev(['no', 'no', 'no', 'no'], ['no', 'no']))!.state).toBe('unknown')
    expect(judge(ev(['no', 'no', 'no', 'no'], ['hit', 'no']))).toEqual(ABSENT)
    // 痕迹命中在第一步不参与：本体有命中才是 Present，痕迹只决定第 ③/④ 步。
    expect(judge(ev(['un', 'no', 'no', 'no'], ['hit', 'hit']))!.state).toBe('unknown')
  })

  it('本体放宽、痕迹收窄（P2-T2 的裁定）', () => {
    expect(nameMatchesLoose('acme-notepad', 'Acme Notepad')).toBe(true)
    expect(nameMatches('acme-notepad', 'Acme Notepad')).toBe(false)
    expect(nameMatchesLoose('zoom-cloud', 'Zoom Cloud Meetings')).toBe(true)
    // 归一只去分隔符：不改大小写以外的东西，也不裁后缀。
    expect(nameMatchesLoose('ghost', 'ghos t')).toBe(true)
    expect(nameMatchesLoose('ghost', 'unrelated')).toBe(false)
    expect(packageFamily('Claude_pzs8sxrjxfjjc')).toBe('Claude')
    expect(packageFamily('Teamo_Router')).toBe('Teamo_Router')
    expect(packageFamily('no_underscore')).toBe('no_underscore')
  })

  // 真机缺陷的孪生（Rust 侧同名用例：channel::tests::a_role_word_*）。
  // 成因：安装根一级目录里有个 `update`，双向包含把它当成了任何 `*-updater` 的本体证据。
  it('角色词不许替具体应用作证（本体侧），整串相等除外', () => {
    const body = (entries: string[]) =>
      emptyScan({ entries, rootsConfigured: 1, rootsVerified: 1, looseMatch: true })
    for (const entry of ['update', 'Temp', 'installer', 'backups']) {
      for (const key of ['adrive-desktop-updater', 'clash_win-updater', 'webcast_mate-updater']) {
        expect(probeChannel(body([entry]), key).probe, `条目「${entry}」把「${key}」证成了在场`).toBe('checked-no-hit')
      }
    }
    // 反向半边：真叫这个名字的应用还在这一格里。
    expect(probeChannel(body(['update']), 'update').probe).toBe('hit')
    expect(probeChannel(body(['update']), 'Update').probe, '大小写归一后也要算相等').toBe('hit')
    // 具体名字不受影响，多词条目也不在表里（`Common Files` 不等于 `common`）。
    expect(probeChannel(body(['Adrive']), 'adrive-desktop-updater').probe).toBe('hit')
    expect(probeChannel(body(['Common Files']), 'common').probe).toBe('hit')
    // 痕迹通道一行不动：那边放宽一寸就多删一寸。
    const traceScan = emptyScan({ entries: ['update'], rootsConfigured: 1, rootsVerified: 1, looseMatch: false })
    expect(probeChannel(traceScan, 'adrive-desktop-updater').probe, '痕迹侧被这次改动带窄了').toBe('hit')
  })

  it('角色词表里不许有厂商名/系统名（收了就是多删的方向）', () => {
    for (const forbidden of ['microsoft', 'windows', 'google', 'nvidia', 'tencent', 'claude', 'packages', 'programs']) {
      expect(GENERIC_ROLE_NAMES, `「${forbidden}」进了角色词表 —— 它能证明某个厂商/系统在场`).not.toContain(forbidden)
    }
    expect(GENERIC_ROLE_NAMES).toContain('update')
    expect(GENERIC_ROLE_NAMES.length, '与 Rust 的 GENERIC_ROLE_NAMES 同数（24 条）').toBe(24)
  })

  // 真机那一格的孪生：卷根一级目录里有个名叫 `D` 的目录，双向包含之下它替每个含 d 的候选作证。
  it('条目短到带不动身份 ⇒ 两侧都不许匹配', () => {
    const body = (entries: string[]) =>
      emptyScan({ entries, rootsConfigured: 1, rootsVerified: 1, looseMatch: true })
    for (const entry of ['D', 'd', 'ab', '']) {
      for (const key of ['adrive-desktop-updater', 'starward', 'tidalab', 'leigod']) {
        expect(probeChannel(body([entry]), key).probe, `条目「${entry}」吞掉了「${key}」`).toBe('checked-no-hit')
      }
      const traceScan = emptyScan({ entries: [entry], rootsConfigured: 1, rootsVerified: 1, looseMatch: false })
      expect(probeChannel(traceScan, 'adrive-desktop-updater').probe, '痕迹侧也被短条目发过入场券').toBe('checked-no-hit')
    }
    expect(probeChannel(body(['adr']), 'adrive-desktop-updater').probe).toBe('hit')
  })

  // 跨语言逐条对账：这张表两侧各写一份，漂一条就是两套判据在判两件不同的事。
  // 手法与 `rules-engine.test.ts` 里 PACKAGE_TREE_NAMES 那条同源（拿 Rust 源码当判据，
  // 不是拿 TS 自己比自己）—— 找不到声明就 throw，不许退化成"只比自己"。
  it('角色词表与 Rust 侧逐条同序', () => {
    const src = readFileSync(
      join(process.cwd(), 'src-tauri', 'crates', 'appfacts', 'src', 'channel.rs'),
      'utf8'
    )
    const at = src.indexOf('pub const GENERIC_ROLE_NAMES')
    if (at < 0) throw new Error('channel.rs 里找不到 GENERIC_ROLE_NAMES —— 那一侧漏了整份名单')
    const open = src.indexOf('[', src.indexOf('=', at) + 1)
    const close = src.indexOf(']', open + 1)
    const rust = [...src.slice(open + 1, close).matchAll(/"([^"]*)"/g)].map((m) => m[1])
    if (rust.length === 0) throw new Error('Rust 侧解析出空名单 —— 恒过的闸比没有闸更坏')
    expect(rust, 'Rust 与 TS 的角色词表不同序或不同串').toEqual([...GENERIC_ROLE_NAMES])
  })

  it('太短的候选名一条通道都不许给结论', () => {
    const ev = evidenceFor(scanAll(toEvidence(caseByName('acme-residual'))), 'ab')
    for (const c of [...ev.body, ...ev.traces]) {
      expect(c.probe.probe, `候选「ab」拿到了 {${c.probe.probe}} —— 长度闸漏了`).toBe('unavailable')
    }
    expect(projectTable(collectAppFacts(['ab'], toEvidence(caseByName('acme-residual')))).ab).toBe('unknown')
  })
})
