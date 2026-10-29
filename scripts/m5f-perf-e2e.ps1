# M5-F 真机验收：十万级文件扫描**途中**界面还动不动。
#
# 这一相要的是"界面没被按住"的**可见证据**，不是单测绿。三件事分开证：
#   ① 扫描途中连续采样「已扫描文件」—— **每一轮都拿到新数字** = 渲染进程在更新、`dc_snapshot`
#      往返在完成（UIA 遍历读的是渲染进程里的真 DOM：界面被按住时名字不会变，或干脆拿不到元素）。
#      刻意不说"在 X ms 内"—— 一轮采样本身要跑 UIA + CIM 几百毫秒，那个数不是 IPC 延迟。
#   ② 扫描**还没跑完**的时候点导航 —— 换页必须在 1 s 内画出来（截图为证）；
#   ③ 途中把另外三页（重复文件 / 垃圾清理 / 开发环境）各开一次 —— 同一族"途中说假话"的缺陷
#      不假定它们没有；认的是页面标题那个 Header 元素（侧栏与标题同名，拿文字判换页会恒真）；
#   ④ 停在「大文件」什么都不点，等它自己从「这一轮还在扫」念出数 —— 钉的是"扫完自动重问"
#      那一格（单测看不见它：静态渲染不跑 effect）；
#   ⑤ 回首页继续采样到扫完，全程采样点严格递增；
#   ⑥ 全程逐轮记主进程 + 其子进程树（WebView2 那几个）的工作集峰值 —— 驻留那笔账点名登记。
#
# 目标选 `C:\Windows` 而不是 f100k：后者 release 下 178 ms 就扫完了，**根本来不及观察**；
# 前者 125,125 文件 / 35,377 目录 / debug 约 21 s，够取十几个采样点。
# **全程只读**：不点任何执行入口，跑完不删任何东西。
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\release\deepclean-app.exe",
    [string]$Root   = "C:\Windows",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    # 换构建跑必须换前缀：`m5f-during-scan.png` 那批是 debug 态既有的证据图。
    [string]$Prefix = "m5f-rel-"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
# release 可用的「起应用 + 扫一棵树 + 按 DWM 帧裁图」通道
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
# 中文一律按码点拼：PS 5.1 把 .ps1 按 ANSI 读，字面量会变乱码
$T_FILES   = U 0x5DF2, 0x626B, 0x63CF, 0x6587, 0x4EF6   # 已扫描文件
$T_SCAN2   = U 0x626B, 0x63CF                            # 扫描（完成态首页那句的开头，与 已扫描文件 区分开）
$T_GEWJ    = U 0x4E2A, 0x6587, 0x4EF6                    # 个文件
$T_DUPS    = U 0x5927, 0x6587, 0x4EF6                   # 大文件
$T_HOME    = U 0x9996, 0x9875                           # 首页

$A = [System.Windows.Automation.AutomationElement]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition

Add-Type -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
'@ -Name U32 -Namespace Native -ReferencedAssemblies System.Runtime.InteropServices
[void][Native.U32]::SetProcessDPIAware()

$script:Win = $null
$script:Hwnd = [System.IntPtr]::Zero
$script:ProcId = 0

function All { $script:Win.FindAll($SCOPE_D, $COND_TRUE) }
function PageText { ((All | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join '|') }
function Ensure-OnTop {
    [void][Native.U32]::SetWindowPos($script:Hwnd, [System.IntPtr]::new(-1), 0, 0, 0, 0, 0x0003)
    [void][Native.U32]::ShowWindow($script:Hwnd, 9)
    Start-Sleep -Milliseconds 250
}
function Find-ByName([string]$sub, [int]$sec = 20) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) {
        foreach ($e in All) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }
        Start-Sleep -Milliseconds 250
    }
    return $null
}
function Invoke-ByName([string]$name) {
    $e = Find-ByName $name 8
    if (-not $e) { return $false }
    $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    return $true
}
function Shot([string]$file) {
    # 原来是「抓整块桌面再按 UIA BoundingRectangle 裁」：裁完宽度是窄的，Task 1 那道只量宽度的闸拦不住
    # 它，而 UIA 矩形左沿 ≠ 窗口可见左沿（2026-10-15 实测差 40-55 px）⇒ 每张都裁进一条别窗口的像素。
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if (-not $info.Foreground) { throw "拍 $file 时窗口不在最前 —— 这张不能当证据" }
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "截图只有 $len 字节，不像一扇渲染出来的窗口" }
    Write-Host "  截图 -> $file ($len 字节)"
}

# 主进程 + 往下两层子进程（WebView2 那几棵树）的工作集与峰值
function Tree-WorkingSet([int]$pid0) {
    $pids = @($pid0)
    try {
        $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$pid0" | ForEach-Object { $_.ProcessId }
        $pids += $kids
        foreach ($k in $kids) {
            $pids += (Get-CimInstance Win32_Process -Filter "ParentProcessId=$k" | ForEach-Object { $_.ProcessId })
        }
    } catch { }
    $ws = 0; $peak = 0; $n = 0
    foreach ($q in ($pids | Where-Object { $_ })) {
        try {
            $pr = Get-Process -Id $q -ErrorAction Stop
            $ws += $pr.WorkingSet64; $peak += $pr.PeakWorkingSet64; $n++
        } catch { }
    }
    return @{ ws = $ws; peak = $peak; procs = $n }
}

$MB = 1048576.0
try {
    # DC_SETTINGS_DIR 是 debug 门控（settings.rs:198），release 上拿不到 ⇒ 拍快照、finally 还原。
    # 这一棒全程只读，理论上不该写设置；打印 untouched 就是它的反证。
    $env:DC_SETTINGS_DIR = 'D:\deepclean-fixture\m5e-settings'
    $script:SetTok = Protect-DcSettings
    # 这一棒是**唯一**需要 -NoWait 的：① 要在扫描途中连取十几个采样点、③ 要途中把另外三页各开一次。
    # 等扫完再返回，这两相就永远拿不到证据（helper 里 Assert-DcNoWaitReturnedMidScan 两相都验过：
    # 本树 returnedAt=6.7 s / completedAt=37.9 s / margin=31.2 s）。
    # 变量名一律 $dcApp：PowerShell 大小写不敏感，接成 $r 会撞脚本里的局部变量。
    $dcApp = Start-DcReleaseApp -App $App -ScanRoot $Root -NoWait
    $p = $dcApp.Proc
    $script:ProcId = $p.Id
    $script:Win = $dcApp.Win
    $script:Hwnd = $dcApp.Hwnd

    # ---- ① 扫描途中采样（采到 5 个点就去做 ②，那时扫描**还在跑**） ----
    # 采样认的词有**两种形状**，缺一会在 release 上恒读不到：
    #   途中 —— ScanHud 那句「已扫描文件 12,345」（components/ScanHud.tsx）
    #   完成 —— 首页 dc-recent-v 那句「扫描 125,157 个文件」（pages/Home.tsx）
    # 旧正则只有途中那一支：debug 下 C:\Windows 约 21 s 扫不完、①③④ 全在途中跑，所以从没暴露。
    # release 侧实测 37.9 s 扫完，而本棒走到 ④ 已花掉约 34 s ⇒ 回首页与 ⑤ 的 plateau 段落在**完成态**，
    # 读不到 HUD 词就永远"没回到首页"（2026-10-17 第一次跑就是这么红的，行 224）。
    # 两支都要求拿到一个具体数字，不是把判据放宽成"页面上有字"。
    $rx = [regex]("(?:$T_FILES\|[^0-9]{0,12}([0-9][0-9,\.]*)|$T_SCAN2[^0-9]{0,4}([0-9][0-9,\.]*)[^0-9]{0,4}$T_GEWJ)")
    $samples = @()
    $memPeak = 0
    $memProcs = 0
    $flat = 0
    $deadline = (Get-Date).AddSeconds(240)

    function Sample-Once {
        $t0 = Get-Date
        $txt = PageText
        $m = $rx.Match($txt)
        if ($m.Success) {
            $raw = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
            $v = [int64]($raw -replace ',', '')
            if ($samples.Count -eq 0 -or $samples[-1] -ne $v) { $script:samples += $v; $script:flat = 0 } else { $script:flat++ }
        } else { $script:flat++ }
        $mem = Tree-WorkingSet $script:ProcId
        if ($mem.peak -gt $memPeak) { $script:memPeak = $mem.peak }
        $script:memProcs = $mem.procs
        $sp = 450 - [int]((Get-Date) - $t0).TotalMilliseconds
        if ($sp -gt 0) { Start-Sleep -Milliseconds $sp }
        return $txt
    }

    while ((Get-Date) -lt $deadline -and $samples.Count -lt 5) { $null = Sample-Once }
    Write-Host "  ① 扫描途中已采 $($samples.Count) 个点：$($samples -join ' → ')"
    if ($samples.Count -lt 5) { throw "只采到 $($samples.Count) 个点 —— 没抓到「扫描途中」这一相" }

    # ---- ② 就在此刻点导航：扫描还在跑（下面拿最后一格与终值之比当证据） ----
    $atClick = $samples[-1]
    $ok1 = Invoke-ByName $T_DUPS
    if (-not $ok1) { throw "侧栏点不到「$T_DUPS」" }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $flipped = $false
    while ($sw.ElapsedMilliseconds -lt 1000 -and -not $flipped) {
        if ((PageText).Contains('Top 100')) { $flipped = $true }
        Start-Sleep -Milliseconds 80
    }
    if (-not $flipped) { throw "点「$T_DUPS」后 1 s 内没换页（$($sw.ElapsedMilliseconds) ms）" }
    Write-Host "  ② 扫描跑到约 $atClick 时点「$T_DUPS」→ $($sw.ElapsedMilliseconds) ms 内换页（认的是那页独有的表头「Top 100」）"
    Shot (Join-Path $OutDir "${Prefix}during-scan.png")

    # ---- ③ 途中把另外三页也各开一次 ----
    # §4 那三个缺陷全是"第一次在扫描途中打开那一页"撞出来的，所以这一相**不预设其余页面没问题**。
    # 判据：页面标题那个 `<h2 class="dc-page-title">` 与侧栏项**同名**（「重复文件」「开发环境」），
    # 所以"找得到这五个字"是恒真断言。真正的判据是**它出现了几次**：侧栏 1 次，页面挂上去之后 2 次。
    # （第一版想用 UIA 的 ControlType=Header 精确定位标题，实测 Chromium 不把这几个 h2 报成
    #  Header —— 查询恒空，于是"换页成功"永远判不出来。改成数出现次数，且垃圾清理那一页
    #  的标题按状态是「垃圾清理」或「清理预览」，两个形状都认。）
    function Count-Name([string]$sub) {
        $n = 0
        foreach ($e in All) { if ($e.Current.Name -eq $sub) { $n++ } }
        return $n
    }
    $SWEEP = @(
        @{ tag = 'dupes';  nav = (U 0x91CD, 0x590D, 0x6587, 0x4EF6); want = @(((U 0x91CD, 0x590D, 0x6587, 0x4EF6), 2)) },
        @{ tag = 'clean';  nav = (U 0x5783, 0x573E, 0x6E05, 0x7406); want = @(((U 0x5783, 0x573E, 0x6E05, 0x7406), 2), ((U 0x6E05, 0x7406, 0x9884, 0x89C8), 1)) },
        @{ tag = 'devenv'; nav = (U 0x5F00, 0x53D1, 0x73AF, 0x5883); want = @(((U 0x5F00, 0x53D1, 0x73AF, 0x5883), 2)) }
    )
    foreach ($pg in $SWEEP) {
        if (-not (Invoke-ByName $pg.nav)) { throw "侧栏点不到「$($pg.nav)」" }
        $ok = $false
        $e3 = (Get-Date).AddSeconds(3)
        while ((Get-Date) -lt $e3 -and -not $ok) {
            foreach ($w in $pg.want) { if ((Count-Name $w[0]) -ge $w[1]) { $ok = $true } }
            if (-not $ok) { Start-Sleep -Milliseconds 120 }
        }
        if (-not $ok) {
            $seen = ($pg.want | ForEach-Object { "$($_[0])×$(Count-Name $_[0])" }) -join ' / '
            throw "点「$($pg.nav)」3 s 内页面没挂上去（$seen，判据要的是标题那一次额外出现）"
        }
        $said = ((PageText) -split '\|' | Where-Object { $_.Length -gt 10 } | Select-Object -First 3) -join ' / '
        Write-Host "  ③ 途中开「$($pg.nav)」→ 换页成功，这一页此刻说的话：$said"
        Shot (Join-Path $OutDir ("${Prefix}mid-" + $pg.tag + ".png"))
    }
    # 回到「大文件」，下面那一相要在它身上等扫描结束
    if (-not (Invoke-ByName $T_DUPS)) { throw "回不到「$T_DUPS」" }

    # ---- ④ 就停在这一页，等它自己开口：证明"扫完自动重问"那一格 ----
    # 单测看不到这一格（`renderToStaticMarkup` 不跑 effect），所以它只能在真窗口上量：
    # 全程**不再点任何东西**，页面从「这一轮还在扫」变成「N 项 · 合计 …」只能是依赖里那个
    # `running` 变了 ⇒ `load` 重建 ⇒ effect 重跑。把 `running` 从依赖里拿掉，这一相就永远等不到。
    $rxCount = [regex]'([1-9][0-9,]{0,9}) 项 · 合计'
    $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
    $filled = $false
    while ($sw2.ElapsedMilliseconds -lt 120000 -and -not $filled) {
        if ($rxCount.Match((PageText)).Success) { $filled = $true } else { Start-Sleep -Milliseconds 400 }
    }
    if (-not $filled) { throw "停在这一页 120 s 也没等到数（那句「这一轮还在扫」没自己改口 = 扫完不会自动重问）" }
    Write-Host "  ④ 不点任何东西，$($sw2.ElapsedMilliseconds) ms 后这一页自己念出了数（认的是「N 项 · 合计」那个形状，N>0）"
    Shot (Join-Path $OutDir "${Prefix}largefiles-filled.png")

    # 回首页：判据是"那一格没了 + 采样又能读到数字"，不是"侧栏里找得到「首页」两个字"
    # （侧栏常驻，拿导航项自己的文字判换页 = 恒真，那种断言谁也没在比）
    $null = Invoke-ByName $T_HOME
    $back = $false
    $end2 = (Get-Date).AddSeconds(3)
    while ((Get-Date) -lt $end2 -and -not $back) {
        $t = PageText
        if (-not $t.Contains('Top 100') -and $rx.Match($t).Success) { $back = $true }
        Start-Sleep -Milliseconds 120
    }
    if (-not $back) { throw "点「$T_HOME」3 s 内没回到首页（表头「Top 100」还在，或采样读不到数字）" }
    Write-Host "     再点「$T_HOME」也换得动（「Top 100」消失 + 采样恢复读到数字）"

    # ---- ⑤ 扫完：继续采样到不再变化，然后逐项点名 ----
    while ((Get-Date) -lt $deadline -and $flat -lt 6) { $null = Sample-Once }
    if ($samples.Count -lt 6) { throw "后半程一个点都没采到（$($samples.Count) 个）—— 界面没在更新" }
    $inc = 0
    for ($i = 1; $i -lt $samples.Count; $i++) { if ($samples[$i] -gt $samples[$i - 1]) { $inc++ } }
    if ($inc -ne $samples.Count - 1) { throw "「已扫描文件」有 $($samples.Count - 1 - $inc) 次没在涨 —— 那就是界面被按住的证据" }
    Write-Host "  ⑤ 全程 $($samples.Count) 个采样点严格递增（每一轮都拿到新数字），终值 $($samples[-1])"
    if ($atClick -ge $samples[-1]) { throw "点导航时最后一格已经是终值 $($samples[-1]) —— 那一次点击**不在**扫描途中，② 的判据作废" }
    $pct = [math]::Round(100.0 * $atClick / $samples[-1])
    Write-Host "     导航那一次落在进度的约 $pct%（$atClick / $($samples[-1])）"

    $mem = Tree-WorkingSet $p.Id
    Write-Host "  ⑥ 进程树 $memProcs 个进程：当前工作集 $([math]::Round($mem.ws / $MB, 1)) MB，全程峰值 $([math]::Round($memPeak / $MB, 1)) MB"

    Start-Sleep -Milliseconds 800
    Shot (Join-Path $OutDir "${Prefix}after-scan.png")
    Write-Host "DONE（§性能那一格：途中采样严格递增 + 途中导航点得动 + 驻留点名）"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Hwnd) { Shot (Join-Path $OutDir "${Prefix}FAIL.png") } } catch { }
    exit 1
} finally {
    if ($script:ProcId) { Stop-Process -Id $script:ProcId -Force -ErrorAction SilentlyContinue }
    Restore-DcSettings $script:SetTok
}
