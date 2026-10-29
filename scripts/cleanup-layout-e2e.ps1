# 清理页版式重构（图二那套）之后的**真机验收**。
#
# 判据分两层，都必须过：
#   ① 可机读（CDP 几何）：`.dc-clean-stats` / `.dc-clean-list` / 每一行 `.dc-clean-row` 真在 DOM
#      且矩形非空；表头五格与行内对应五格**逐列对齐**（容差 1.5 px）；「计入预估」列没被挤出视口；
#      勾选框没被缩小；根没有横向溢出。三档宽度各量一次。
#   ② 肉眼：三张图落到 assets 下（宽窗 / 窄窗 / 勾选后），由人看。
#
# 为什么必须有两层：`renderToStaticMarkup` 没有布局引擎（本仓 vitest environment 是 node），
# 单测钉得住字的形状、钉不住"数字掉到描述下面""窄窗把结论列挤没"这两类只存在于像素里的缺陷。
#
# ⚠️ 驱动走 CDP 而不是 `lib-dc-release.ps1` 的 UIA 通道：那条通道当前是坏的，坏因与本任务无关
#    —— 首页把「指定位置」改成了「选择位置」+ 盘符下拉（工作区里 `Home.tsx` 的一份未提交改动），
#    而 helper 还在找旧名字与 `<input>`。本轮只登记，不去改别人的半成品。
param(
    [string]$App    = 'D:\DeepClean\src-tauri\target\release\deepclean-app.exe',
    [string]$Drive  = 'D:\',
    [string]$OutDir = 'D:\DeepClean\docs\acceptance\assets',
    [string]$Prefix = 'cleanup-layout-',
    [int[]]$Widths  = @(1440, 880),
    [int]$Port      = 9231
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct DcLayRect { public int Left; public int Top; public int Right; public int Bottom; }
public class DcLayWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int l, bool repaint);
}
'@ -ReferencedAssemblies System.Runtime.InteropServices
# 不做 DPI-aware，MoveWindow 给的宽度会被系统按缩放虚拟化（150% 下 880 落成 1320），
# 那几档就白跑了 —— 与 `m6b-scale-e2e.ps1` 同一条坑。
[void][DcLayWin]::SetProcessDPIAware()

$json = 'D:\dc-tmp\cleanup-layout.json'
Remove-Item $json -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path 'D:\dc-tmp' | Out-Null
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"

function Shot([string]$file) {
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if (-not $info.Foreground) { throw "拍 $file 时窗口不在最前 —— 这张不能当证据" }
    if ($info.Width -gt 1900) { throw "拍出来 $info.Width 宽 —— 那不是窗口是桌面" }
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "截图只有 $len 字节，不像一扇渲染出来的窗口" }
    Write-Host ("  SHOT {0} ({1}x{2}) {3} B foreground=True" -f (Split-Path $file -Leaf), $info.Width, $info.Height, $len)
}

try {
    $stale = @(Get-Process deepclean-app -ErrorAction SilentlyContinue)
    if ($stale.Count -gt 0) { throw "已经有 $($stale.Count) 个 deepclean-app 在跑 —— 先关掉，脚本不抢窗口" }

    # ---- 起应用（不喂 -ScanRoot：那条 helper 通道当前坏在首页改名上）----
    $proc = Start-Process -FilePath $App -PassThru
    $script:Proc = $proc
    $win = $null
    for ($i = 0; $i -lt 80; $i++) {
        $cands = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id))
        $win = $cands | Where-Object { $_.Current.ClassName -eq 'Tauri Window' } | Select-Object -First 1
        if ($win) { break }
        if ($proc.HasExited) { throw "进程自己退了（exit=$($proc.ExitCode)）" }
        Start-Sleep -Milliseconds 500
    }
    if (-not $win) { throw "40 秒内没抓到 'Tauri Window'" }
    $script:Win = $win
    $script:Hwnd = [System.IntPtr]::new($win.Current.NativeWindowHandle)
    Write-Host "  pid=$($proc.Id) hwnd=$($script:Hwnd)"

    # ---- 驱动：切「选择位置」→ 选盘根 → 点「开始深度扫描」→ 进清理页 ----
    node (Join-Path $PSScriptRoot 'cleanup-layout-drive.mjs') --port $Port --drive $Drive
    if ($LASTEXITCODE -ne 0) { throw "驱动段失败（退出码 $LASTEXITCODE）" }

    # ---- 三档几何 + 截图 ----
    $h = $script:Hwnd
    foreach ($w in $Widths) {
        [void][DcLayWin]::MoveWindow($h, 40, 30, $w, 880, $true)
        Start-Sleep -Milliseconds 1600
        Write-Host "--- 窗口物理宽 $w ---"
        node (Join-Path $PSScriptRoot 'cleanup-layout-probe.mjs') --port $Port --out $json --physical $w --selected $false
        if ($LASTEXITCODE -ne 0) { throw "版式探针在 $w 这一档红了（退出码 $LASTEXITCODE）" }
        Shot (Join-Path $OutDir ("${Prefix}{0}.png" -f $w))
    }

    # ---- 勾上全部可清理项，再拍一张（看 `.dc-clean-row-on` 与统计带联动）----
    [void][DcLayWin]::MoveWindow($h, 40, 30, 1440, 880, $true)
    Start-Sleep -Milliseconds 1200
    node (Join-Path $PSScriptRoot 'cleanup-layout-select-all.mjs') --port $Port
    if ($LASTEXITCODE -ne 0) { throw "「全选可清理项」这一相失败（退出码 $LASTEXITCODE）" }
    Start-Sleep -Milliseconds 800
    node (Join-Path $PSScriptRoot 'cleanup-layout-probe.mjs') --port $Port --out $json --physical 1440 --selected $true
    if ($LASTEXITCODE -ne 0) { throw "版式探针在勾选后这一相红了（退出码 $LASTEXITCODE）" }
    Shot (Join-Path $OutDir "${Prefix}1440-selected.png")

    # ---- Loading 什么时候出现（人类伙伴 2026-10-21 两轮要求）----
    #
    #   ① 「重新计价这段改成 Loading」→ 现在是 16 颗点跳动的动画；
    #   ② 「只为第一次进入垃圾清理页面加载就好」→ 勾选/取消勾选**不许**再闪它。
    #
    # 两条各由一方提供证据：
    #   · ①那一瞬（冷进页面、只可能发生一次）由驱动段 30 ms 高频采样写进
    #     `D:\dc-tmp\loading-first-seen.json` —— **不在这一行重现**，因为这一相跑在最后，
    #     此时早就进出清理页多次，缓存命中 ⇒ 按设计不会再闪（第一版判据错在这里）。
    #   · ②在这里连点三次勾选框验证"它一次都不回来"，同时核对 ① 的那份证据。
    node (Join-Path $PSScriptRoot 'cleanup-layout-loading-probe.mjs') --port $Port --cold-evidence 'D:\dc-tmp\loading-first-seen.json'
    if ($LASTEXITCODE -ne 0) { throw "Loading 那一相红了（退出码 $LASTEXITCODE）" }

    $rows = (Get-Content $json -Raw | ConvertFrom-Json).rows
    Write-Host ("MATRIX cells={0}" -f $rows.Count)
    foreach ($r in $rows) {
        Write-Host ("  phys={0} css={1} 统计带={2} 行数={3} 勾上={4} 溢出={5}px 对齐偏差={6}px" -f `
            $r.physicalWindowWidth, $r.innerW, $r.hasStats, $r.rows, $r.selectedRows, $r.overflowPx, $r.alignSkew)
    }
    $bad = @($rows | Where-Object { -not $_.ok })
    foreach ($b in $bad) { Write-Host ("  X phys={0}: {1}" -f $b.physicalWindowWidth, ($b.problems -join ' / ')) }
    if ($bad.Count -gt 0) { throw "版式判据 $($bad.Count) 格红了 —— 逐条点名在上面" }
    Write-Host "DONE（统计带在、行在、三列右缘对齐、结论列没被挤出视口、勾选框没缩、无横向溢出；三张图由人肉眼复核）"
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
