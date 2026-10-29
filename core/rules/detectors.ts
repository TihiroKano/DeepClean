/**
 * V0.7 Task 3 —— 「工具装没装」的探测器层（计划书 §3.2 / §3.5）。
 *
 * 补的是这个缺口：`core/rules/registry.ts` 的 15 条规则全是**静态路径模板**，没有任何一条问过
 * 「这台机器上有 Gradle 吗」。于是没装 Gradle 的机器照样进评估流程、照样出一条 `gradle-cache` 的
 * finding —— 用户看到的是「这工具不存在，但它有缓存」。
 *
 * 本文件是**纯函数层**：一个 `node:` 内建模块都不许 import —— 真机的文件访问、进程查询、环境变量
 * 三样全在 `electron/services/detect-env.ts` 那一侧。理由有两层：
 * 1. `core/rules` 整层要能在合成树上跑单测（引擎文件头同一条约束），探测器掺进真机 I/O 就等于
 *    把这条轴拆掉 —— 而且 `core/rules` **没有任何测试守着这条纯度**，只能靠文件划分来守。
 * 2. 判据是数据，机器是注入的：同一张表在单测里对着假探针跑，在主进程里对着 `where` 跑。
 *
 * 三条设计裁定（都有代价，写在这里而不是埋在代码里）：
 * - **两级判据取「或」**：命令在 PATH **或** 已知目录存在，任一命中就算已装。误判「未装」会把真容量
 *   静默藏起来（用户只看到少了一笔），误判「已装」退回 V0.7 之前的全量误报 —— 前者更坏，所以宁可松。
 * - **不碰注册表**（裁定 2 / 计划书 §22 明令），也不碰 `registry.ts`：本模块只按 id 引用规则，
 *   路径判据仍然只有规则自己那一份，探测器**不新建第二套路径真相**。
 * - **只报告**：探测器不带删除能力，也不带勾选策略。§3.5 的「AI 模型不进默认勾选」是结构性豁免，
 *   不住在这一层（本棒不做，见 Step 5）—— 这里加一个布尔字段就会变成第二套勾选口径。
 */

/**
 * 注入的能力面 —— 探测器唯一的对外依赖。两个方法都只回答「有没有」，都不返回内容。
 * （V0.7 Task 3 Step 6 起了**第三个**方法 `queryDockerDiskUsage`，它确实返回内容 —— 上面那句
 * 「都不返回内容」只约束前两个。为什么 Docker 非返回内容不可、为什么它是**可选**的，
 * 写在下面 `DOCKER_DETECTOR` 那一段的注释里，不在这里重复一遍。）
 * `pathExists` 收到的是 `%VAR%\…` 模板（与 `Rule.paths` 同一语言），由实现方按自己那台机器解析；
 * 这样本层连"这台机器上的变量叫什么"都不需要知道，也就没有任何理由去读真机的环境变量表。
 */
export interface DetectorProbe {
  /** 命令能不能跑（主进程侧 = 一次进程查询的退出码） */
  commandAvailable(command: string): boolean
  /** 已知目录在不在这台机器上（传入 `%VAR%` 模板；解析不出变量按「不存在」回答） */
  pathExists(pathTemplate: string): boolean
  /**
   * 只读查询本机 Docker 占用（裁定 1 / 计划书 §3.4）。**可选**，不是第三个必填方法，理由有两条：
   * 1. 那九个两级探测器一个都不需要它 —— 必填会把现有三份假探针（`detectors.test.ts` /
   *    `detect-env.test.ts` / `rules-detector-wiring.test.ts`）全变成类型错误，等于让新功能去改旧判据。
   * 2. 「没有这一能力面」本身就是 Docker 要区分的一种答案（问不出 ≠ 没有），必填反而把那格挤掉。
   * 实现方**只许**跑只读查询；执行与判据仍然分家：这里只交出原文，字节一律由本层算。
   */
  queryDockerDiskUsage?(): DockerCliOutcome
}

/**
 * 一个探测器 = 一个工具 + 它把关的规则 id。
 * 除 `isInstalled` 外全是数据；`isInstalled` 也只读 `probe`，不改任何东西、不返回路径清单。
 */
export interface IDevEnvDetector {
  /** 稳定 id，写进 `Rule.requiresDetector`（所以它一旦上表就是契约，不许改名） */
  readonly id: string
  /** 给人看的名字（§3.6 页面直接用；探测器自己不进 UI 逻辑） */
  readonly displayName: string
  /**
   * 本探测器把关的规则 id。方向注意：这里是「谁需要我」，不是「我要删什么」——
   * 规则没在自己的 `requiresDetector` 里引用某个 id，本探测器就完全不参与评估。
   */
  readonly ruleIds: readonly string[]
  /** 第一级判据：裸命令名（不带路径、不带 .exe —— `where` 只认名字） */
  readonly commands: readonly string[]
  /**
   * 第二级判据：已知安装/缓存 footprint 的 `%VAR%` 模板。
   * 它们**只是存在性证据**，永远不是清理范围 —— 清理范围只有 `Rule.paths` 那一处（裁定 2）。
   */
  readonly knownDirs: readonly string[]
  isInstalled(probe: DetectorProbe): boolean
}

/**
 * 两级判据的实现只有一份，所以「或」的语义不可能在某条探测器上悄悄变成「与」。
 * 这里**不求短路**：每个命令、每个目录都被问过一遍。多几次查询的成本换的是判据可解释 ——
 * 假探针的单测据此能钉住「这条规则到底问了哪几件事」，而短路实现下结论会随命令表顺序变。
 */
function twoLevelInstalled(commands: readonly string[], knownDirs: readonly string[], probe: DetectorProbe): boolean {
  const hitCommand = commands.map((c) => probe.commandAvailable(c)).some(Boolean)
  const hitDir = knownDirs.map((d) => probe.pathExists(d)).some(Boolean)
  return hitCommand || hitDir
}

function defineDetector(spec: Omit<IDevEnvDetector, 'isInstalled'>): IDevEnvDetector {
  return {
    ...spec,
    isInstalled: (probe) => twoLevelInstalled(spec.commands, spec.knownDirs, probe)
  }
}

/**
 * 上表的九个工具就是 §16 🟡 / §21 那批「依赖某个工具才存在」的规则。
 * 每条的 `knownDirs` 都取 `%VAR%` 模板且变量在 `registry.ts` 的 `RULE_ENV_KEYS` 里 ——
 * 变量名拼错会让第二级永远回答「不存在」，进而把真容量误判成未安装；这条由单测点名抓，不靠眼看。
 */
export const DEV_ENV_DETECTORS: readonly IDevEnvDetector[] = [
  defineDetector({
    id: 'npm',
    displayName: 'npm',
    ruleIds: ['npm-cache'],
    commands: ['npm'],
    knownDirs: ['%LOCALAPPDATA%\\npm-cache', '%USERPROFILE%\\.npm-global\\cache']
  }),
  defineDetector({
    id: 'pnpm',
    displayName: 'pnpm',
    ruleIds: ['pnpm-store'],
    commands: ['pnpm'],
    knownDirs: ['%LOCALAPPDATA%\\pnpm-store', '%LOCALAPPDATA%\\pnpm\\store']
  }),
  defineDetector({
    id: 'yarn',
    displayName: 'Yarn',
    ruleIds: ['yarn-cache'],
    commands: ['yarn'],
    knownDirs: ['%LOCALAPPDATA%\\Yarn\\Cache']
  }),
  defineDetector({
    id: 'pip',
    displayName: 'pip',
    ruleIds: ['pip-cache'],
    commands: ['pip', 'pip3'],
    knownDirs: ['%LOCALAPPDATA%\\pip\\Cache']
  }),
  defineDetector({
    id: 'maven',
    displayName: 'Maven',
    ruleIds: ['maven-repository'],
    commands: ['mvn'],
    knownDirs: ['%USERPROFILE%\\.m2\\repository']
  }),
  defineDetector({
    id: 'gradle',
    displayName: 'Gradle',
    // IDE 里跑过的构建不会往 PATH 放 gradle，所以 `.gradle\caches` 存在本身就算已装 —— 两级取或就是为这种机器留的
    ruleIds: ['gradle-cache'],
    commands: ['gradle'],
    knownDirs: ['%USERPROFILE%\\.gradle\\caches']
  }),
  defineDetector({
    id: 'huggingface',
    displayName: 'Hugging Face',
    // §3.5 的 AI 模型豁免（不进默认勾选）不住在这一层：这里只回答装没装，勾选策略由 Step 5 处理
    ruleIds: ['huggingface-cache'],
    commands: ['hf', 'huggingface-cli'],
    knownDirs: ['%USERPROFILE%\\.cache\\huggingface']
  }),
  defineDetector({
    id: 'android-sdk',
    displayName: 'Android SDK',
    // 问的是 `Sdk` 根（存在性证据），把关的规则地盘仍然是 `Sdk\.temp` —— 多问一个目录不等于多删一个目录
    ruleIds: ['android-sdk-temp'],
    commands: ['sdkmanager', 'adb'],
    knownDirs: ['%LOCALAPPDATA%\\Android\\Sdk']
  }),
  defineDetector({
    id: 'vscode',
    displayName: 'VS Code',
    ruleIds: ['vscode-cache'],
    commands: ['code'],
    knownDirs: ['%APPDATA%\\Code\\CachedData', '%USERPROFILE%\\.vscode']
  })
]

/* ================================================================== *
 * 裁定 1（计划书 §3.4；2026-09-28 计划 Task 3 Step 6）—— Docker：CLI 委托
 *
 * 这一节和上面那九个不是一个判据形状，差异是刻意的，理由写在这里：
 *
 * **为什么不能走两级判据**：§16 要的是「Docker 未使用数据」的容量，而那份容量在 `docker` 的
 * 数据目录里，路径既不是叶子路径、也不归 DeepClean 的 `Rule.paths` 表达（V0.4 就是因此否掉它的：
 * 见 `core/rules/registry.ts` 里那段「Docker 不在这批里」与 2026-09-27 计划 §21/§474）。
 * 用 `%LOCALAPPDATA%\Docker\*` 这类 FS 通配去估字节，过不了叶子路径判据、硬凑就是假字节数 ——
 * 这条绕开了那个理由：**探测与容量都来自一次只读查询 `docker system df --format json`，
 * 清理动作交给 Docker 自己**（`docker system df` 只会读，DeepClean 这一侧不持有任何针对
 * Docker 路径的 FS 删除调用；页面上那句"请用 `docker system prune`"是给**人看**的文案，
 * 不进 argv、不进这一层的任何一个函数名）。
 *
 * **为什么 `isInstalled` 的判据是「能不能拿到一份可解析的 df 输出」而不是「命令在不在 PATH」**：
 * daemon 没起的机器上 `docker` 明明在 PATH，这时候说"已装但 0 字节"和说"未安装"都是谎 ——
 * 前者把量不到的东西报成了测量结果，后者把装了的工具报成没装。所以这里三分：
 * `measured` / `absent` / `unmeasurable`，只有 `absent` 才写 `false` 交给引擎那条轴。
 * ================================================================== */

/**
 * 一次**只读** `docker system df --format json` 的结局（由实现方分类，本层只消费）。
 * 四格各答一件不同的事，谁也不许顶替谁：
 * - `ok`：CLI 与 daemon 都答了话，`stdout` 是原文，字节由本层从这份原文算
 * - `cli-missing`：**连进程都没起来**（`spawn ENOENT`）—— 这是唯一可能支持「未安装」的一格，
 *   而且还得再过一道 `commandAvailable('docker')` 反证才敢真写 false（见 `readDockerDiskUsage`）
 * - `timed-out`：有限超时到了、进程被杀
 * - `cli-failed`：进程起来了但退出码非 0 —— daemon 没起、权限不够、这个版本不认识这个参数，全在这一格
 *
 * 为什么 `cli-failed` 不再往下拆「daemon 没起」：那要拿英文报错文案去匹配，换一套语言就换一个结论，
 * 而这一格需要的结论本来就都一样（量不到）。**唯一**能推出「未安装」的证据是 ENOENT，
 * 它是机器给的、不是文案给的。
 */
export type DockerCliOutcome =
  | { kind: 'ok'; stdout: string }
  | { kind: 'cli-missing' }
  | { kind: 'timed-out' }
  | { kind: 'cli-failed'; message: string }

/** 三格结论。`absent` 是"这台机器没装"，`unmeasurable` 是"装了（或说不准）但这次量不到" —— 两者都不是 0。 */
export type DockerVerdict = 'measured' | 'absent' | 'unmeasurable'

/** df 报回来的一个类目。名字只用 CLI 自己报的那个键的小写形式，本层不改名、不并类。 */
export interface DockerUsageCategory {
  readonly name: string
  readonly reclaimableBytes: number
}

/**
 * Docker 的读数。**页面那一行要用的就是这三格**：`reclaimableBytes === null` 时必须显示「量不到」，
 * 不许印成 `0 B` —— 「0」在这里是一个测量结果，不是"没有"。
 */
export interface DockerDiskUsage {
  readonly verdict: DockerVerdict
  /** 只来自那份 df 输出；量不到 / 未安装都是 `null`，不是 `0` */
  readonly reclaimableBytes: number | null
  /** 逐类目拆分；CLI 没报的类目**不出现在表里**（不补 0，补了就是"量到了 0"） */
  readonly categories: readonly DockerUsageCategory[]
  /** 给人看的一句话，写明这次是量到了、量不到、还是没装 */
  readonly detail: string
}

/** docker 的 HumanSize / CanonicalSize 是 1000 进制；带 i 的那几个才是 1024 进制，两套都认，别互相冒充。 */
const SIZE_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5
}

/**
 * 人读尺寸串 → 字节：`0B` / `1.586MB` / `2.1 GiB` / `44.99MB (3 of 7 images)` 都认，
 * 认不出的一律 `null`（负数、`-`、空串、`Reclaimable: ""` 全在这儿被挡掉，不许悄悄当 0）。
 */
function parseHumanBytes(raw: string): number | null {
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]{0,3})\s*(?:\(|$)/.exec(raw)
  if (m === null) return null
  const value = Number(m[1])
  if (!Number.isFinite(value)) return null
  const unit = (m[2] ?? '').toLowerCase()
  if (unit.length === 0) return Math.round(value)
  const multiplier = SIZE_UNITS[unit]
  if (multiplier === undefined) return null
  return Math.round(value * multiplier)
}

/** df 里的一个尺寸字段（现代 CLI 给数字、老 CLI 给人读串）→ 字节；读不出就是真读不出。 */
function asByteCount(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null
    return Math.round(value)
  }
  if (typeof value === 'string') return parseHumanBytes(value)
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function unmeasurable(detail: string): DockerDiskUsage {
  return { verdict: 'unmeasurable', reclaimableBytes: null, categories: [], detail }
}

type DfCategories = { ok: true; categories: DockerUsageCategory[] } | { ok: false; why: string }

/**
 * `--format json` 有两种历史形状，都接：
 * - **数组**（老 CLI）：一行一个类目，`Reclaimable` 是人读串 —— 少一行、有一行解析不出来，整份读数作废。
 * - **对象**（现代 CLI）：`Images[].Reclaimable` / `Containers[].Size` / `Volumes[].Size`，单位是字节。
 *   这三个字段的口径就是 `docker system df` 自己 RECLAIMABLE 那一列用的口径。
 * 某一类整个键缺失或为 `null` → 这一类**不进总数**（少报是一处看得见的缺口）；但同类里出现了
 * 解析不出来的值 → 整份读数判「量不到」，因为这时候连"少报了哪一格"都说不准。
 */
function categoriesFromDfRows(rows: readonly unknown[]): DfCategories {
  if (rows.length === 0) return { ok: false, why: 'df 返回空数组，一个类目都没报' }
  const out: DockerUsageCategory[] = []
  for (const raw of rows) {
    const row = asRecord(raw)
    if (row === null) return { ok: false, why: 'df 的数组里有一行不是对象' }
    const name = typeof row['Type'] === 'string' ? row['Type'].toLowerCase() : '未知类目'
    const bytes = asByteCount(row['Reclaimable'])
    if (bytes === null) return { ok: false, why: `类目「${name}」的 Reclaimable 读不成字节` }
    out.push({ name, reclaimableBytes: bytes })
  }
  return { ok: true, categories: out }
}

/** 现代对象形状里被计入的三类（字段名各自是 CLI 报的哪个）。 */
const DF_OBJECT_CATEGORIES: readonly { key: string; name: string; field: string }[] = [
  { key: 'Images', name: 'images', field: 'Reclaimable' },
  { key: 'Containers', name: 'containers', field: 'Size' },
  { key: 'Volumes', name: 'volumes', field: 'Size' }
]

function categoriesFromDfObject(value: Record<string, unknown>): DfCategories {
  const out: DockerUsageCategory[] = []
  for (const spec of DF_OBJECT_CATEGORIES) {
    const rows = value[spec.key]
    if (rows === undefined || rows === null) continue
    if (!Array.isArray(rows)) return { ok: false, why: `${spec.key} 不是数组` }
    let sum = 0
    for (const raw of rows) {
      const row = asRecord(raw)
      if (row === null) return { ok: false, why: `${spec.key} 里有一行不是对象` }
      const bytes = asByteCount(row[spec.field])
      if (bytes === null) return { ok: false, why: `类目「${spec.name}」里有一行的 ${spec.field} 读不成字节` }
      sum += bytes
    }
    out.push({ name: spec.name, reclaimableBytes: sum })
  }
  if (out.length === 0) return { ok: false, why: '输出里一个被计数的类目都没有' }
  return { ok: true, categories: out }
}

/** 两种历史形状分发到这里；都不是 → 一句「读不出」，不猜一个数。 */
function parseDfValue(value: unknown): DfCategories {
  if (Array.isArray(value)) return categoriesFromDfRows(value)
  const record = asRecord(value)
  if (record === null) return { ok: false, why: '输出既不是对象也不是数组' }
  return categoriesFromDfObject(record)
}

/** 那份 stdout 是本层唯一的字节来源 —— 这里一个路径都不碰，所以"容量来自 FS 通配"这条路结构上不存在。 */
function usageFromDfStdout(stdout: string): DockerDiskUsage {
  const text = stdout.trim()
  if (text.length === 0) {
    return unmeasurable('`docker system df` 退出码 0 但一个字都没给 → 量不到；这是没量到，不是 0 字节')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return unmeasurable('`docker system df --format json` 的输出不是合法 JSON（版本不认识这个参数、' +
      '或输出被截断都会走到这里）→ 量不到，不是 0 字节')
  }
  const parsed = parseDfValue(value)
  if (parsed.ok === false) return unmeasurable(`df 报了东西但这一层读不出可回收字节（${parsed.why}）→ 量不到`)
  const total = parsed.categories.reduce((acc, c) => acc + c.reclaimableBytes, 0)
  return {
    verdict: 'measured',
    reclaimableBytes: total,
    categories: parsed.categories,
    detail:
      `容量来自只读查询 \`docker system df --format json\`（类目：${parsed.categories.map((c) => c.name).join('、') || '无'}）。` +
      '口径提醒：这是 df 自己报的逻辑字节，不是本次清理能释放的磁盘字节；build cache 未计入（形状跨版本差别最大，' +
      '拿不准就不并进总数）。清理动作不归 DeepClean，交给 Docker 本身。'
  }
}

/**
 * 问一次 Docker，拿到三格结论之一。纯函数：机器侧全在注入的 `probe` 里，这里只分类与解析。
 *
 * 「未安装」只有一个来源：`cli-missing`（ENOENT）**并且** `commandAvailable('docker')` 也说找不到。
 * 为什么要后者反证 —— Windows 上 `spawn` 不认 `.cmd`/PATHEXT 那类垫片：Docker 的 CLI 有可能是
 * 一个 `docker.cmd`，`where` 找得到而 `execFile` 起不来，这时候报「未安装」是假话，报「量不到」才是实话。
 */
export function readDockerDiskUsage(probe: DetectorProbe): DockerDiskUsage {
  const query = probe.queryDockerDiskUsage
  if (typeof query !== 'function') {
    // 这一格是留给"探针压根没这个能力面"的（现有那三份两级假探针就是这个形状）。
    // 结论既不写 false（引擎那条轴会把地盘摘掉）也不写 0 —— 问不出 ≠ 没有。
    return unmeasurable('注入的探针没有 Docker 只读查询能力面 → 无从判断，按「量不到」处理（不是未安装）')
  }
  const reply = query.call(probe)
  switch (reply.kind) {
    case 'ok':
      return usageFromDfStdout(reply.stdout)
    case 'cli-missing': {
      if (probe.commandAvailable('docker')) {
        return unmeasurable(
          '起进程报 ENOENT，但 `where docker` 找得到（`.cmd` 垫片 / PATHEXT 这一类）→ 量不到，不是未安装'
        )
      }
      return {
        verdict: 'absent',
        reclaimableBytes: null,
        categories: [],
        detail:
          '这台机器的 PATH 上没有 docker（连进程都起不来）→ 未安装。' +
          '注意：这是探测结论，不等于盘上没有 Docker 数据；容量本就不由 FS 通配推断'
      }
    }
    case 'timed-out':
      return unmeasurable('`docker system df` 到了有限超时被杀 → 量不到，不是未安装、也不是 0 字节')
    case 'cli-failed': {
      const hint = reply.message.length > 0 ? `（CLI 返回：${reply.message}）` : ''
      return unmeasurable(
        `docker 在 PATH 上，但那次只读查询非 0 退出（daemon 没起是这一格最常见的一种）→ ` +
          `量不到，不是未安装、也不是 0 字节${hint}`
      )
    }
  }
}

/**
 * Docker 探测器。**它不在 `DEV_ENV_DETECTORS` 那张数组里**，三条理由：
 * 1. 那张表的语义是「谁把关哪条规则」，键进引擎后由 `absentDetector()` 消费；而 registry 里
 *    **没有任何 Docker 规则**（V0.4 裁定维持），所以 Docker 进去只会多一个没人读的键。
 * 2. 那张表是 `Map<string, boolean>`，而 Docker 的答案是三格的 —— 布尔装不下它。
 * 3. 把它并进那张表会连带撞掉两条**不属于本棒**的现有用例（`detectors.test.ts` 的
 *    「每个探测器至少把关一条规则」与 `detect-env.test.ts` 的「九个分类全部算已装」）。
 * 需要整张图景的人用下面的 `DEV_ENV_DETECTORS_WITH_DOCKER`；`collectInstallStatus` 的第二个参数
 * 本来就收探测器表，所以那九个的默认行为一字节没变。
 */
export const DOCKER_DETECTOR: IDevEnvDetector = {
  id: 'docker',
  displayName: 'Docker',
  // 故意空：registry 里没有 Docker 规则，本探测器不把关任何一条 —— 于是也不给任何东西增加删除能力
  ruleIds: [],
  // 这一条**不是**第一级判据（Docker 的判据是 df 能不能答），只是 `cli-missing` 那格的反证；
  // 放在这儿是为了让"问的是哪个命令"仍然只有这一处数据源，而不是散在函数里
  commands: ['docker'],
  // 故意空：裁定 1 不许拿 `%LOCALAPPDATA%\Docker\*` 这类 FS 目录给 Docker 估容量，
  // 连"存在性证据"也不许拿它当 —— 字节只能来自那份 JSON，路径一次都不 stat
  knownDirs: [],
  isInstalled: (probe) => readDockerDiskUsage(probe).verdict !== 'absent'
}

/**
 * 九个两级探测器 + Docker 那一个只读探测器。
 * 注意：`collectInstallStatus()` / `detectorForRule()` 的默认参数是**上面那九个**，不是这张 ——
 * 引擎那张表的语义是「谁把关哪条规则」，Docker 不把关任何规则，默认并进只会多一个没人读的键。
 */
export const DEV_ENV_DETECTORS_WITH_DOCKER: readonly IDevEnvDetector[] = [...DEV_ENV_DETECTORS, DOCKER_DETECTOR]

/**
 * 整表跑一遍，产出引擎要的那张状态表：键 = 探测器 id（= `Rule.requiresDetector` 填的值），值 = 装没装。
 *
 * 为什么不直接把探测器对象交给引擎：引擎的判定语义是冻结的（Global Constraints），
 * 它只该收到一个「结论」，不该收到一个能问出下一个问题的入口 —— 否则规则引擎就有能力去摸机器了。
 * 表里出现的键必定来自 `DEV_ENV_DETECTORS`；反之「规则写了而表里没有的 id」不在这里兜，
 * 由引擎按「已安装」处理（那条裁定的理由与代价写在 `engine.ts` 的 `absentDetector()` 上）。
 */
export function collectInstallStatus(
  probe: DetectorProbe,
  detectors: readonly IDevEnvDetector[] = DEV_ENV_DETECTORS
): Map<string, boolean> {
  const out = new Map<string, boolean>()
  for (const d of detectors) out.set(d.id, d.isInstalled(probe))
  return out
}

/** 按规则 id 反查把关它的探测器（无人把关 → undefined，供接线侧与页面显示「无需探测」）。 */
export function detectorForRule(
  ruleId: string,
  detectors: readonly IDevEnvDetector[] = DEV_ENV_DETECTORS
): IDevEnvDetector | undefined {
  return detectors.find((d) => d.ruleIds.includes(ruleId))
}
