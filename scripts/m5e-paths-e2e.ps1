# M5-E② 真机验收：§28 白名单那两条第一次接上（打开 / 打开所在位置）。
# **全程零删除**：这一趟只右键地图上的格子、点菜单里那两项，跑完逐名点名夹具文件还在盘上。
#
# 这一刀要看的不是"窗口开出来了"，而是**开出去的是谁**：
#   · 「打开所在位置」→ 新多出来一个资源管理器窗口，标题是那**一层目录**（`/select` 的形态）；
#   · 「打开」→ 新多出来一个窗口，标题里带着那个文件名（走的是 ShellExecuteW，与 Electron
#     `shell.openPath` 底下同一个 API）。
# 拒绝那一格（`E_UNTRUSTED_PATH`）**在界面上走不到** —— 这正是这道闸存在的理由：渲染端只能
# 从已扫的树里拿到路径。所以它由 `src/paths.rs` 的四条单测钉住（含 `C:\Windows\System32\cmd.exe`
# 与 `D:\range\evil.exe` 两格），这里不假装"真机点了一次拒绝"。
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\release\deepclean-app.exe",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    # 换构建跑必须换前缀：`m5e-reveal-explorer.png` 那张是 debug 态既有的证据图。
    [string]$Prefix = "m5epaths-rel-"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
# release 可用的「起应用 + 扫一棵树 + 按 DWM 帧裁图」通道
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')
function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_MAP       = U 0x7A7A, 0x95F4, 0x5730, 0x56FE      # 空间地图
$T_REVEAL    = U 0x6253, 0x5F00, 0x6240, 0x5728, 0x4F4D, 0x7F6E  # 打开所在位置（少一个 0x7F6E「置」就打印成半截词，Contains 照样命中 —— 码点表要逐字点过）
$T_OPEN      = U 0x6253, 0x5F00                        # 打开
$A = [System.Windows.Automation.AutomationElement]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition
Add-Type -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint msg, System.IntPtr w, System.IntPtr l);
'@ -Name U32 -Namespace Native -ReferencedAssemblies System.Runtime.InteropServices
[void][Native.U32]::SetProcessDPIAware()

$script:Win = $null
$script:Hwnd = [System.IntPtr]::Zero

function TopWindows {
    # 用 UIA 的顶层子元素列窗口（先前那版手写 EnumWindows + native 回调，只捞回一个 "m" ——
    # PowerShell 脚本块当原生回调在这台机器上不可靠）。标题、pid、句柄都在 Current 上。
    $out = @()
    foreach ($e in $A::RootElement.FindAll($SCOPE_C, $COND_TRUE)) {
        $c = $e.Current
        if (-not $c.IsOffscreen -and $c.Name) {
            $out += [pscustomobject]@{ Hwnd = [System.IntPtr]::new($c.NativeWindowHandle); Title = $c.Name; Pid = $c.ProcessId }
        }
    }
    return $out
}
function All { $script:Win.FindAll($SCOPE_D, $COND_TRUE) }
function PageText { ((All | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join '|') }
function Ensure-OnTop {
    [void][Native.U32]::SetWindowPos($script:Hwnd, [System.IntPtr]::new(-1), 0, 0, 0, 0, 0x0003)
    [void][Native.U32]::ShowWindow($script:Hwnd, 9)
    Start-Sleep -Milliseconds 300
}
function Find-ByName([string]$sub) {
    $end = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $end) {
        foreach ($e in All) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }
        Start-Sleep -Milliseconds 300
    }
    return $null
}
function Click-At([double]$fx, [double]$fy, [bool]$right = $false) {
    Ensure-OnTop
    $r = $script:Win.Current.BoundingRectangle
    [void][Native.U32]::SetCursorPos([int]($r.X + $r.Width * $fx), [int]($r.Y + $r.Height * $fy))
    Start-Sleep -Milliseconds 250
    $down = if ($right) { 0x0008 } else { 0x0002 }
    $up   = if ($right) { 0x0010 } else { 0x0004 }
    [Native.U32]::mouse_event($down, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Native.U32]::mouse_event($up, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
}
function Click-El($e) {
    Ensure-OnTop
    $r = $e.Current.BoundingRectangle
    if ($r.Width -lt 6 -or $r.Height -lt 6) { throw "元素矩形 $($r.Width)x$($r.Height) 不像能点的" }
    [void][Native.U32]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
    Start-Sleep -Milliseconds 250
    [Native.U32]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Native.U32]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 200
}
function Shot([string]$file) {
    # 原来是「抓整块桌面再按 UIA BoundingRectangle 裁」：裁完的图宽度是窄的，Task 1 那道只量宽度的闸
    # 拦不住它，而 UIA 矩形左沿 ≠ 窗口可见左沿（2026-10-15 实测差 40-55 px）⇒ 每张都裁进一条别窗口。
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if (-not $info.Foreground) { throw "拍 $file 时窗口不在最前 —— 这张不能当证据" }
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "screenshot is $len bytes - too small to be a rendered window" }
    Write-Host "  截图 -> $file ($len 字节)"
}

$R = 'D:\deepclean-fixture\m5e-paths'
$opened = @()
try {
    # ---- 夹具：一个**大文件** + 一个小目录，让文件格子占满画布中心（右键点哪一格是可确定的） ----
    if (Test-Path $R) { Remove-Item -Recurse -Force $R }
    New-Item -ItemType Directory -Force -Path "$R\Inbox" | Out-Null
    [int]$sizeMb = 2 * 1024 * 1024
    $b = New-Object byte[] $sizeMb; for ($i = 0; $i -lt $b.Length; $i++) { $b[$i] = [byte]($i -band 0xff) }
    [System.IO.File]::WriteAllBytes("$R\Alpha.txt", $b)
    [System.IO.File]::WriteAllBytes("$R\Inbox\nested.bin", (New-Object byte[] 512))
    Write-Host "  夹具：Alpha.txt 2 MB（占满画布）+ Inbox 一个 512 B 的文件（格子大小差 4000 倍，右键点中心必是那个文件）"

    # DC_SETTINGS_DIR 只在 debug 生效（settings.rs:198 是 #[cfg(debug_assertions)]）⇒ 这一棒在
    # release 上点的设置会写用户真的那份，所以拍快照、finally 还原。
    $env:DC_SETTINGS_DIR = 'D:\deepclean-fixture\m5e-paths-settings'
    $script:SetTok = Protect-DcSettings
    # 变量名一律 $dcApp：PowerShell 大小写不敏感，接成 $r 会把这个脚本的夹具根 $R 直接覆盖掉
    # （m5e-exclusions 迁移时就这么红过一次，兜住它的是零删除那条 throw）。
    $dcApp = Start-DcReleaseApp -App $App -ScanRoot $R -WaitSec 150
    $script:ProcId = $dcApp.Proc.Id
    $script:Win = $dcApp.Win
    $script:Hwnd = $dcApp.Hwnd
    Write-Host "  扫描跑完"

    $nav = $null
    $endN = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $endN -and -not $nav) {
        $nav = (All | Where-Object { $_.Current.Name -eq $T_MAP } | Select-Object -First 1)
        if (-not $nav) { Start-Sleep -Milliseconds 400 }
    }
    if (-not $nav) { throw "侧栏没有「$T_MAP」" }
    $nav.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 1800

    # ---- ① 右键文件格子 → 菜单里必须有那两项（点了没反应 = 菜单没出来，这里就红） ----
    Click-At 0.55 0.55 $true
    $reveal = Find-ByName $T_REVEAL
    if (-not $reveal) { throw "右键之后菜单里没有「$T_REVEAL」那一项" }
    Write-Host "  ① 右键文件格子：菜单出来了（含「$T_REVEAL」与「$T_OPEN」）"
    $before = @(TopWindows)
    Click-El $reveal
    Start-Sleep -Milliseconds 3500
    $newOne = @(TopWindows) | Where-Object { $h = $_.Hwnd; -not ($before | Where-Object { $_.Hwnd -eq $h }) }
    $hit = $newOne | Where-Object { $_.Title -like '*m5e-paths*' } | Select-Object -First 1
    if (-not $hit) { throw "点「$T_REVEAL」之后没有多出标题含 m5e-paths 的窗口。新开的是：$(($newOne | ForEach-Object { $_.Title }) -join ' / ')" }
    $opened += $hit.Hwnd
    Write-Host "  ① 真开出了资源管理器窗口：标题「$($hit.Title)」"
    Shot (Join-Path $OutDir "${Prefix}reveal-explorer.png")

    # ---- ② 右键同一个格子 → 「打开」走 ShellExecuteW，新窗口的标题里带着文件名 ----
    Click-At 0.55 0.55 $true
    $openItem = $null
    foreach ($e in All) { if ($e.Current.Name -eq $T_OPEN) { $openItem = $e; break } }
    if (-not $openItem) { throw "右键之后菜单里没有「$T_OPEN」那一项" }
    $before2 = @(TopWindows)
    Click-El $openItem
    $found = $null
    $end2 = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $end2 -and -not $found) {
        Start-Sleep -Milliseconds 700
        $diff = @(TopWindows) | Where-Object { $h = $_.Hwnd; -not ($before2 | Where-Object { $_.Hwnd -eq $h }) }
        $found = $diff | Where-Object { $_.Title -like '*Alpha*' } | Select-Object -First 1
    }
    if (-not $found) { throw "点「$T_OPEN」之后 20s 内没有多出标题含 Alpha 的窗口（关联程序没接活？）" }
    $opened += $found.Hwnd
    Write-Host "  ② 真开出了关联程序的窗口：标题「$($found.Title)」"

    # ---- 零删除的反证 ----
    foreach ($f in @("$R\Alpha.txt", "$R\Inbox\nested.bin")) {
        if (-not (Test-Path $f)) { throw "零删除这一条没守住：$f 不在了" }
    }
    Write-Host "  两个夹具文件都还在盘上（这两条命令只有只读语义，也没有任何执行入口被点过）"
    Write-Host "DONE（§28 白名单两条：真机各开出一个窗口；拒绝那一格由单测钉住，界面上走不到）"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Hwnd) { Shot (Join-Path $OutDir "${Prefix}FAIL.png") } } catch { }
    exit 1
} finally {
    # 只关这次验收**新多出来**的那两扇窗口（WM_CLOSE，不杀进程 —— 杀 explorer.exe 会牵连桌面）
    foreach ($h in $opened) { [void][Native.U32]::PostMessage($h, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero) }
    if ($script:ProcId) { Stop-Process -Id $script:ProcId -Force -ErrorAction SilentlyContinue }
    Restore-DcSettings $script:SetTok
}
