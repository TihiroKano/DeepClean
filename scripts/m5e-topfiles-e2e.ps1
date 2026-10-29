# M5-E④ 真机验收：§4「大文件」那张表第一次接上（Top 100 来自扫描途中的堆，不是第二次遍历）。
# **全程零删除**：只读表、只切筛选，不点任何执行入口；跑完逐名点名夹具文件还在盘上。
#
# 独立口径：表里那几行的**大小与顺序**拿 `Get-ChildItem -Recurse -File | Sort Length -Desc` 现算一份对。
# 堆的容量是 100，所以"前 100 名"这个集合本身就是被验对象 —— 夹具放 104 个文件，
# 让"截断"这件事真的发生一次（第 101..104 名不该出现，而前 100 必须齐全且降序）。
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\release\deepclean-app.exe",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    # 换构建跑必须换前缀：`m5e-topfiles.png` / `m5e-topfiles-floor100mb.png` 是 debug 态既有的证据图，不许被这一棒覆盖。
    [string]$Prefix = "m5etop-rel-"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
# release 可用的「起应用 + 扫一棵树 + 按 DWM 帧裁图」通道
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')
function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_LARGE   = U 0x5927, 0x6587, 0x4EF6                          # 大文件（侧栏那一项）
$T_TOP100  = 'Top 100 ' + (U 0x5927, 0x6587, 0x4EF6)           # Top 100 大文件
$T_FLOOR100 = U 0x2265, 0x0020, 0x31, 0x30, 0x30, 0x20, 0x4D, 0x42  # ≥ 100 MB
$T_FLOOR_ALL = U 0x4E0D, 0x9650                                 # 不限
$A = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition
Add-Type -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
'@ -Name U32 -Namespace Native -ReferencedAssemblies System.Runtime.InteropServices
[void][Native.U32]::SetProcessDPIAware()

$script:Win = $null
$script:Hwnd = [System.IntPtr]::Zero
function All { $script:Win.FindAll($SCOPE_D, $COND_TRUE) }
function PageText { ((All | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join '|') }
function Ensure-OnTop {
    [void][Native.U32]::SetWindowPos($script:Hwnd, [System.IntPtr]::new(-1), 0, 0, 0, 0, 0x0003)
    [void][Native.U32]::ShowWindow($script:Hwnd, 9)
    Start-Sleep -Milliseconds 300
}
function Click-El($e) {
    Ensure-OnTop
    $rect = $e.Current.BoundingRectangle
    if ($rect.Width -lt 6 -or $rect.Height -lt 6) { throw "元素矩形 $($rect.Width)x$($rect.Height) 不像能点的" }
    [void][Native.U32]::SetCursorPos([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
    Start-Sleep -Milliseconds 250
    [Native.U32]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Native.U32]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 200
}
function Find-ByName([string]$sub) {
    $end = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $end) {
        foreach ($e in All) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }
        Start-Sleep -Milliseconds 300
    }
    return $null
}
function Shot([string]$file) {
    # 原来这一套是「先把整块桌面抓进临时位图，再按 UIA BoundingRectangle 裁」。裁完的图**宽度是窄的**，
    # 所以 scripts/shot-leak-gate.mjs 那道只量宽度的闸拦不住它 —— 而 UIA 矩形左沿 ≠ 窗口可见左沿
    # （2026-10-15 实测差 40-55 px），于是每张图都裁进一条别窗口的像素。改成共享的 DWM 帧裁图，
    # 并且"拍的时候不在最前"直接拒收。
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if (-not $info.Foreground) { throw "拍 $file 时窗口不在最前 —— 这张不能当证据" }
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "screenshot is $len bytes - too small to be a rendered window" }
    Write-Host "  截图 -> $file ($len 字节)"
}

$R = 'D:\deepclean-fixture\m5e-top'
try {
    # ---- 夹具：1 个 120 MB、1 个 6 MB、1 个 1 MB，再加 101 个小文件（总共 104 个 ⇒ 堆要截掉 4 个） ----
    if (Test-Path $R) { Remove-Item -Recurse -Force $R }
    New-Item -ItemType Directory -Force -Path $R | Out-Null
    function Blank([int]$n) { $a = New-Object byte[] $n; for ($i = 0; $i -lt $n; $i++) { $a[$i] = [byte]($i -band 0xff) }; return $a }
    [System.IO.File]::WriteAllBytes("$R\big.iso",   (Blank (120 * 1024 * 1024)))
    [System.IO.File]::WriteAllBytes("$R\mid.zip",   (Blank (6 * 1024 * 1024)))
    [System.IO.File]::WriteAllBytes("$R\small.txt", (Blank (1 * 1024 * 1024)))
    for ($i = 0; $i -lt 101; $i++) {
        [System.IO.File]::WriteAllBytes("$R\tiny{0:d3}.dat" -f $i, (Blank (1024 + $i)))
    }
    Write-Host "  夹具：104 个文件（120 MB / 6 MB / 1 MB + 101 个约 1 KB）⇒ 堆容量 100 会截掉最小的 4 个"

    # ---- 独立口径：这棵树上按大小降序的前 100 名 ----
    $oracle = Get-ChildItem -Path $R -Recurse -File | Sort-Object Length -Descending | Select-Object -First 100
    $oracleNames = @($oracle | ForEach-Object { $_.Name })
    Write-Host "  独立口径前 3 名：$(($oracleNames | Select-Object -First 3) -join ', ')；第 100 名 $($oracleNames[99])"

    # DC_SETTINGS_DIR 是 settings.rs:198 那个 #[cfg(debug_assertions)] 的重定向 ⇒ **打包版拿不到**，
    # 这一棒在 release 上切门槛会写用户真的那份设置，所以先把真设置拍快照，finally 里还原。
    $env:DC_SETTINGS_DIR = 'D:\deepclean-fixture\m5e-top-settings'
    $script:SetTok = Protect-DcSettings
    # 变量名一律 $dcApp：PowerShell 大小写不敏感，接成 $r 会把这个脚本的夹具根 $R 直接覆盖掉
    # （m5e-exclusions 迁移时就这么红过一次，兜住它的是零删除那条 throw）。
    $dcApp = Start-DcReleaseApp -App $App -ScanRoot $R -WaitSec 150
    $script:ProcId = $dcApp.Proc.Id
    $script:Win = $dcApp.Win
    $script:Hwnd = $dcApp.Hwnd
    $nav = (All | Where-Object { $_.Current.Name -eq $T_LARGE } | Select-Object -First 1)
    if (-not $nav) { throw "侧栏没有「$T_LARGE」" }
    $nav.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    [void](Find-ByName $T_TOP100)
    Start-Sleep -Milliseconds 1500
    $t = PageText
    if ($t.Contains('E_NOT_IMPLEMENTED')) { throw "页面还在念未实现：$(($t -split '\|' | Where-Object { $_ -like '*NOT_IMPLEMENTED*' })[0])" }
    Write-Host "  ① 进了「$T_TOP100」页，表出来了（不再是未实现桩）"

    # ---- ② 前三行的名字与大小逐条对独立口径 ----
    function Fmt([long]$n) { if ($n -ge 1GB) { return ('{0:N1} GB' -f ($n / 1GB)) }; if ($n -ge 1MB) { return ('{0:N1} MB' -f ($n / 1MB)) }; if ($n -ge 1KB) { return ('{0:N1} KB' -f ($n / 1KB)) }; return "$n B" }
    $top3 = @($oracle | Select-Object -First 3)
    $i = 0
    foreach ($row in $top3) {
        $want = $row.Name
        $wantSize = Fmt ([int64]$row.Length)
        if (-not $t.Contains($want)) { throw "第 $i 行该有「$want」，页面上没有" }
        $seg = ($t -split '\|')
        $at = [array]::IndexOf($seg, $want)
        if ($at -lt 0) { throw "「$want」不是一格独立文本，无法定位它的大小列" }
        $near = ($seg[$at..([Math]::Min($at + 3, $seg.Count - 1))] -join ' ')
        if (-not $near.Contains($wantSize)) { throw "「$want」旁边那几格没有它的大小「$wantSize」：$near" }
        Write-Host "  ② 第 $i 名 $want = $wantSize（与 Get-ChildItem 一致）"
        $i++
    }
    # 堆容量截断：第 101 名（最小的那一个）不该出现在表里
    $dropped = (Get-ChildItem -Path $R -Recurse -File | Sort-Object Length -Descending | Select-Object -Skip 100 -First 1).Name
    if ($t.Contains($dropped)) { throw "第 101 名「$dropped」出现在表里 —— 堆的容量没生效" }
    Write-Host "  ③ 第 101 名「$dropped」确实不在表里（容量 100 在真机上生效）"
    Shot (Join-Path $OutDir "${Prefix}topfiles.png")

    # ---- ④ 门槛筛选：真点开下拉、真点「≥ 100 MB」那一档 ----
    # （第一版用 ValuePattern.SetValue，页面纹丝不动：Chromium 的 select 被 UIA 改值时不派发
    #   React 监听的那个 change 事件 —— 与设置页同一形状，那里也是真点选项才验得到的。）
    $cb = (All | Where-Object { $_.Current.ControlType -eq $CT::ComboBox } | Select-Object -First 1)
    if (-not $cb) { throw "页面上没有那个门槛下拉" }
    Click-El $cb
    Start-Sleep -Milliseconds 1000
    $opt = (All | Where-Object { $_.Current.Name -eq $T_FLOOR100 } | Select-Object -First 1)
    if (-not $opt) { throw "点开之后弹层里没有「$T_FLOOR100」那一档" }
    Click-El $opt
    Start-Sleep -Milliseconds 2200
    $t2 = PageText
    if (-not $t2.Contains('big.iso')) { throw "选了「$T_FLOOR100」之后连 big.iso 都没了" }
    if ($t2.Contains('mid.zip')) { throw "「$T_FLOOR100」没生效：6 MB 的 mid.zip 还在表里" }
    Write-Host "  ④ 门槛「$T_FLOOR100」生效：只剩 big.iso，mid.zip 被过滤掉了"
    Shot (Join-Path $OutDir "${Prefix}topfiles-floor100mb.png")
    $cb2 = (All | Where-Object { $_.Current.ControlType -eq $CT::ComboBox } | Select-Object -First 1)
    Click-El $cb2
    Start-Sleep -Milliseconds 1000
    $opt2 = (All | Where-Object { $_.Current.Name -eq $T_FLOOR_ALL } | Select-Object -First 1)
    if (-not $opt2) { throw "弹层里没有「$T_FLOOR_ALL」那一档" }
    Click-El $opt2
    Start-Sleep -Milliseconds 2200
    if (-not (PageText).Contains('mid.zip')) { throw "切回「$T_FLOOR_ALL」之后 mid.zip 该回来" }
    Write-Host "  ⑤ 切回「$T_FLOOR_ALL」，表恢复原样"

    foreach ($f in @("$R\big.iso", "$R\mid.zip", "$R\small.txt")) {
        if (-not (Test-Path $f)) { throw "零删除这一条没守住：$f 不在了" }
    }
    Write-Host "DONE（§4 大文件表：Top 100 与门槛筛选都在真机上对了独立口径）"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Hwnd) { Shot (Join-Path $OutDir "${Prefix}FAIL.png") } } catch { }
    exit 1
} finally {
    if ($script:ProcId) { Stop-Process -Id $script:ProcId -Force -ErrorAction SilentlyContinue }
    Restore-DcSettings $script:SetTok
}
