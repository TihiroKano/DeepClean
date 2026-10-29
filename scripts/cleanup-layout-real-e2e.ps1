# 清理页在**有真实字节**的夹具上的版式验收（数字列出现非 0 读数时的那种排版）。
#
# 为什么还要这一支：`cleanup-layout-e2e.ps1` 扫的是 D 盘根，这台机器那个盘上
# 没有任何登记规则的地盘 => 22 行全是 0 B / 0。0 B 的排版说明不了问题 ——
# "345.0 MB"这种七字符读数才是数字列的真实宽度来源，而列宽容不下它在截图上
# 会表现为**数字被截成省略号**（`.dc-clean-row-num` 有 `text-overflow: ellipsis`）。
#
# 夹具由 `cleanup-layout-fixture.ps1` 造（npm-cache / D3DSCache / TEMP / thumbcache），
# 并靠 dev-only 的 `DC_ENV_ROOT` 把规则领地指进去。**release 上没有这个口子**
# （`main.rs` 里它是 `#[cfg(debug_assertions)]`），所以这一支跑的是 debug 版 ——
# 与 `m3-e2e-cleanup.ps1` 同一条通道，也是本项目"真机验收"的既有做法之一。
#
# ⚠️ 两条坑都真撞过，别重犯：
#  1. 注释里**不要写带尾反斜杠的路径字面量**（引号会配平错，整个 param 块当场语法错）；
#  2. 本仓 `.ps1` 一律无 BOM，PS 5.1 按 ANSI 读 —— 中文只能出现在注释里，
#     要拿去匹配界面文字的一律用码点拼（见 `lib-dc-release.ps1` 的 `U-Str`）。
param(
    [string]$App     = (Join-Path 'D:\DeepClean\src-tauri\target\debug' 'deepclean-app.exe'),
    [string]$EnvRoot = (Join-Path 'D:\dc-tmp' 'cleanup-fixture'),
    [string]$OutDir  = (Join-Path 'D:\DeepClean\docs\acceptance' 'assets'),
    [string]$Prefix  = 'cleanup-layout-real-',
    [int]$Port       = 9232
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct DcRealRect { public int Left; public int Top; public int Right; public int Bottom; }
public class DcRealWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int l, bool repaint);
}
'@ -ReferencedAssemblies System.Runtime.InteropServices
[void][DcRealWin]::SetProcessDPIAware()

$json = 'D:\dc-tmp\cleanup-layout-real.json'
Remove-Item $json -ErrorAction SilentlyContinue
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
# 两条 dev-only 口子：规则领地重定向 + 起窗口就扫（都不进 release 二进制）
$env:DC_ENV_ROOT = $EnvRoot
$env:DC_AUTOSCAN = $EnvRoot

function Shot([string]$file) {
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if (-not $info.Foreground) { throw "拍 $file 时窗口不在最前 —— 这张不能当证据" }
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "截图只有 $len 字节" }
    Write-Host ("  SHOT {0} ({1}x{2}) {3} B" -f (Split-Path $file -Leaf), $info.Width, $info.Height, $len)
}

try {
    $stale = @(Get-Process deepclean-app -ErrorAction SilentlyContinue)
    if ($stale.Count -gt 0) { throw "已经有 $($stale.Count) 个 deepclean-app 在跑 —— 先关掉" }
    if (-not (Test-Path $EnvRoot)) { throw "夹具不存在：$EnvRoot（先跑 cleanup-layout-fixture.ps1）" }

    $proc = Start-Process -FilePath $App -PassThru
    $win = $null
    for ($i = 0; $i -lt 100; $i++) {
        $cands = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id))
        $win = $cands | Where-Object { $_.Current.ClassName -eq 'Tauri Window' } | Select-Object -First 1
        if ($win) { break }
        if ($proc.HasExited) { throw "进程自己退了" }
        Start-Sleep -Milliseconds 500
    }
    if (-not $win) { throw "50 秒内没抓到 'Tauri Window'" }
    $script:Win = $win
    $script:Hwnd = [System.IntPtr]::new($win.Current.NativeWindowHandle)
    Write-Host "  pid=$($proc.Id) hwnd=$($script:Hwnd) envroot=$EnvRoot"

    # 等 DC_AUTOSCAN 扫完（`--wait-scan`）→ 进清理页 → 量几何 + 读三列数字。
    # 三件事都在同一个探针里：它们共用同一条 CDP 连接，拆成三个进程要各连一次，
    # 而断开期间页面状态可能变（重建计价、行被重画），量到的就不是同一份画面了。
    [void][DcRealWin]::MoveWindow($script:Hwnd, 40, 30, 1440, 900, $true)
    Start-Sleep -Milliseconds 1800
    node (Join-Path $PSScriptRoot 'cleanup-layout-probe.mjs') --port $Port --out $json --physical 1440 --wait-scan
    if ($LASTEXITCODE -ne 0) { throw "版式探针红了（1440）" }
    Shot (Join-Path $OutDir "${Prefix}1440.png")

    [void][DcRealWin]::MoveWindow($script:Hwnd, 40, 30, 880, 880, $true)
    Start-Sleep -Milliseconds 1600
    node (Join-Path $PSScriptRoot 'cleanup-layout-probe.mjs') --port $Port --out $json --physical 880
    if ($LASTEXITCODE -ne 0) { throw "版式探针红了（880）" }
    Shot (Join-Path $OutDir "${Prefix}880.png")

    Write-Host "DONE（真实字节夹具：两档版式全绿，三列数字可用宽度够放「345.0 MB」这类读数）"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Hwnd) { Shot (Join-Path $OutDir "${Prefix}FAIL.png") } } catch { }
    exit 1
} finally {
    Get-Process deepclean-app -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }
    Start-Sleep -Milliseconds 1500
    Get-Process deepclean-app -ErrorAction SilentlyContinue | Stop-Process -Force
}
