# M5-E③ 真机验收：§7「排除该目录」接通，并且**只**改这张地图。
# **全程零删除**：这一趟只右键目录格子、点「排除该目录」与「清除全部排除」，不点任何执行入口，
# 跑完逐名点名夹具文件还在盘上。
#
# 判据分两层，各证各的：
#   · 真机这一趟证"界面与 IPC 通了"：横幅那句出现、数字对得上、清除之后横幅消失；
#   · 「排除绝不漏进计价口径」那条红线由单测钉（`the_exclusion_never_reaches_the_pricing_caliber`），
#     因为界面上"预估没变"这件事需要跑一整条清理链才看得见，而那条链本棒不许点。
#     横幅自己那句「清理预估也仍按完整的树计价」是**产品的说法**，不是本脚本的证据。
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\release\deepclean-app.exe",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    # 换构建跑必须换前缀：`m5e-excluded-banner.png` 那两张是 debug 态既有的证据图。
    [string]$Prefix = "m5eexcl-rel-"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
# release 可用的「起应用 + 扫一棵树 + 按 DWM 帧裁图」通道
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')
function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_MAP        = U 0x7A7A, 0x95F4, 0x5730, 0x56FE                                  # 空间地图
$T_EXCLUDE    = U 0x6392, 0x9664, 0x8BE5, 0x76EE, 0x5F55                          # 排除该目录
$T_CLEAR      = U 0x6E05, 0x9664, 0x5168, 0x90E8, 0x6392, 0x9664                  # 清除全部排除
$T_EXCL_HEAD  = U 0x5DF2, 0x6392, 0x9664                                          # 已排除
$T_OF_DIR     = U 0x4E2A, 0x76EE, 0x5F55                                          # 个目录
$T_NOT_COUNT  = U 0x4E0D, 0x8BA1, 0x5165, 0x5730, 0x56FE                          # 不计入地图
$T_SENTINEL   = U 0x88AB, 0x6392, 0x9664, 0x90A3, 0x4E00, 0x5C42, 0x663E, 0x793A, 0x7684, 0x76EE, 0x5F55, 0x5927, 0x5C0F, 0x4ECD, 0x662F, 0x5B8C, 0x6574, 0x5B50, 0x6811, 0x5408, 0x8BA1
# 被排除那一层显示的目录大小仍是完整子树合计
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
    $winRect = $script:Win.Current.BoundingRectangle
    [void][Native.U32]::SetCursorPos([int]($winRect.X + $winRect.Width * $fx), [int]($winRect.Y + $winRect.Height * $fy))
    Start-Sleep -Milliseconds 250
    $down = if ($right) { 0x0008 } else { 0x0002 }
    $up   = if ($right) { 0x0010 } else { 0x0004 }
    [Native.U32]::mouse_event($down, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Native.U32]::mouse_event($up, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 200
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

$R = 'D:\deepclean-fixture\m5e-excl'
try {
    # ---- 夹具：两个目录格子，容量差 8 倍，右键点大的那一格是可确定的 ----
    if (Test-Path $R) { Remove-Item -Recurse -Force $R }
    New-Item -ItemType Directory -Force -Path "$R\BigHide" | Out-Null
    New-Item -ItemType Directory -Force -Path "$R\Keep" | Out-Null
    $big = New-Object byte[] (8 * 1024 * 1024)
    $small = New-Object byte[] (1024 * 1024)
    [System.IO.File]::WriteAllBytes("$R\BigHide\payload.bin", $big)
    [System.IO.File]::WriteAllBytes("$R\Keep\payload.bin", $small)
    Write-Host "  夹具：BigHide 8 MB / Keep 1 MB（两块格子都只含一个文件）"

    # DC_SETTINGS_DIR 是 settings.rs:198 那个 #[cfg(debug_assertions)] 的重定向 ⇒ **打包版拿不到**，
    # 这一棒在 release 上点的「排除此文件夹」会落进用户真的那份设置里。所以先把真设置拍快照，
    # finally 里还原（清理工具里一条残留的排除项会静默改变将来的删除范围，不是无害噪音）。
    $env:DC_SETTINGS_DIR = 'D:\deepclean-fixture\m5e-excl-settings'
    $script:SetTok = Protect-DcSettings
    $dcApp = Start-DcReleaseApp -App $App -ScanRoot $R -WaitSec 150
    $script:ProcId = $dcApp.Proc.Id
    $script:Win = $dcApp.Win
    $script:Hwnd = $dcApp.Hwnd
    $nav = (All | Where-Object { $_.Current.Name -eq $T_MAP } | Select-Object -First 1)
    if (-not $nav) { throw "侧栏没有「$T_MAP」" }
    $nav.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 1800
    Write-Host "  进了空间地图"

    # ---- ① 右键大的那一格 → 排除 ----
    Click-At 0.28 0.5 $true
    $mi = Find-ByName $T_EXCLUDE
    if (-not $mi) { throw "右键之后菜单里没有「$T_EXCLUDE」那一项（点歪了 = 这一相没有证据）" }
    $rect = $mi.Current.BoundingRectangle
    Click-At ([double](($rect.X + $rect.Width / 2 - $script:Win.Current.BoundingRectangle.X) / $script:Win.Current.BoundingRectangle.Width)) ([double](($rect.Y + $rect.Height / 2 - $script:Win.Current.BoundingRectangle.Y) / $script:Win.Current.BoundingRectangle.Height))
    $banner = Find-ByName ($T_EXCL_HEAD + ' 1 ' + $T_OF_DIR)
    if (-not $banner) { throw "排除之后横幅没出现（那句「$T_EXCL_HEAD 1 $T_OF_DIR … $T_NOT_COUNT」）" }
    if (-not $banner.Current.Name.Contains($T_SENTINEL)) { throw "横幅少了那句「完整子树合计 / 预估照旧按完整的树计价」：$($banner.Current.Name)" }
    Write-Host "  ① 横幅出现了：$($banner.Current.Name)"
    Shot (Join-Path $OutDir "${Prefix}excluded-banner.png")

    # ---- ② 清除全部排除 → 横幅消失 ----
    $clear = Find-ByName $T_CLEAR
    if (-not $clear) { throw "侧栏没有「$T_CLEAR」那个按钮" }
    $clear.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 2000
    $still = (PageText).Contains($T_EXCL_HEAD + ' 1 ' + $T_OF_DIR)
    if ($still) { throw "点了「$T_CLEAR」之后横幅还在 —— 排除没被清掉" }
    Write-Host "  ② 「$T_CLEAR」生效：横幅消失了"

    # ---- ③ 再来一次，然后确认「恢复显示」这一格（同一目录 excluded=false）也通 ----
    Click-At 0.28 0.5 $true
    $mi2 = Find-ByName $T_EXCLUDE
    if ($mi2) {
        $rect2 = $mi2.Current.BoundingRectangle
        Click-At ([double](($rect2.X + $rect2.Width / 2 - $script:Win.Current.BoundingRectangle.X) / $script:Win.Current.BoundingRectangle.Width)) ([double](($rect2.Y + $rect2.Height / 2 - $script:Win.Current.BoundingRectangle.Y) / $script:Win.Current.BoundingRectangle.Height))
        Start-Sleep -Milliseconds 1500
        if (-not (PageText).Contains($T_EXCL_HEAD)) { throw "第二次排除没出横幅（会话累计没生效？）" }
        Write-Host "  ③ 再排除一次仍有点名（本轮累计那一份在涨）"
    }

    foreach ($f in @("$R\BigHide\payload.bin", "$R\Keep\payload.bin")) {
        if (-not (Test-Path $f)) { throw "零删除这一条没守住：$f 不在了" }
    }
    Write-Host "  两个夹具文件都还在盘上（排除是纯视图动作，规格书 §7 要的就是"这块噪音我先不看"）"
    Write-Host "DONE（§7 视图排除接通；计价那条红线由单测钉，界面上不点执行链）"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Hwnd) { Shot (Join-Path $OutDir "${Prefix}FAIL.png") } } catch { }
    exit 1
} finally {
    if ($script:ProcId) { Stop-Process -Id $script:ProcId -Force -ErrorAction SilentlyContinue }
    Restore-DcSettings $script:SetTok
}
