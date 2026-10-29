# 清理页 2026-10-23 那一改的**真机验收**（卡片等高 + 风险/占用居中 + 最简详情 + 查看详情框 + 删副标题）。
#
# 判据分两层，都必须过：
#   ① 可机读（CDP 几何）：行高差 ≤ 1px；每行风险药丸/数字组的中心线与内容块中心线差 ≤ 1.5px；
#      摘要只有一行；「查看详情」与行一一对应；点开后 role=dialog 在视口内、有遮罩、Esc 关得掉。
#   ② 肉眼：三张图落盘（列表 / 详情框开着 / 窄窗），由人复核"像不像主人要的那样"。
#
# 为什么必须两层：`renderToStaticMarkup` + vitest 都是 node 环境，没有布局引擎 ——
# 单测钉得住"调的是哪个函数"，钉不住"中心线差 3.7px"这种只存在于像素里的东西。
#
# ⚠️ 走 debug 版：`DC_ENV_ROOT` / `DC_AUTOSCAN` 在 `main.rs` 里是 `#[cfg(debug_assertions)]`
#    （release 上不存在），而夹具要靠它们才能被算成规则领地、并自动起扫。
#    与 `cleanup-layout-real-e2e.ps1` 同一条通道。
param(
    [string]$App     = (Join-Path 'D:\DeepClean\src-tauri\target\debug' 'deepclean-app.exe'),
    [string]$EnvRoot = (Join-Path 'D:\dc-tmp' 'cleanup-fixture'),
    [string]$OutDir  = (Join-Path 'D:\DeepClean\docs\acceptance' 'assets'),
    [string]$Prefix  = 'cleanup-card-',
    [int]$Port       = 9233
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)]
public struct DcCardRect { public int Left; public int Top; public int Right; public int Bottom; }
public class DcCardWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int l, bool repaint);
}
'@ -ReferencedAssemblies System.Runtime.InteropServices
# 不做 DPI-aware：MoveWindow 给的宽度会被系统按 150% 虚拟化（880 落成 1320），那几档就白跑了。
[void][DcCardWin]::SetProcessDPIAware()

$json = 'D:\dc-tmp\cleanup-card-detail.json'
# 进程日志句柄在 try 之前就要有值：失败可能发生在它赋值之前，catch 里要能安全读它。
$errLog = $null
New-Item -ItemType Directory -Force -Path 'D:\dc-tmp' | Out-Null
Remove-Item $json -ErrorAction SilentlyContinue

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
# 两条 dev-only 口子：规则领地重定向 + 起窗口就扫。
$env:DC_ENV_ROOT = $EnvRoot
$env:DC_AUTOSCAN = $EnvRoot

function Shot([string]$file) {
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if (-not $info.Foreground) { throw "拍 $file 时窗口不在最前 —— 这张不能当证据" }
    if ($info.Width -gt 1900) { throw "拍出来 $($info.Width) 宽 —— 那不是窗口是桌面" }
    $len = (Get-Item $file).Length
    if ($len -lt 60kb) { throw "截图只有 $len 字节，不像一扇渲染出来的窗口" }
    Write-Host ("  SHOT {0} ({1}x{2}) {3} B foreground=True" -f (Split-Path $file -Leaf), $info.Width, $info.Height, $len)
}

function Probe([string]$tag) {
    node (Join-Path $PSScriptRoot 'cleanup-card-detail-probe.mjs') --port $Port --out $json
    if ($LASTEXITCODE -ne 0) { throw "几何/详情判据在 $tag 这一档红了（退出码 $LASTEXITCODE）" }
}

try {
    $stale = @(Get-Process deepclean-app -ErrorAction SilentlyContinue)
    if ($stale.Count -gt 0) { throw "已经有 $($stale.Count) 个 deepclean-app 在跑 —— 先关掉，脚本不抢窗口" }
    if (-not (Test-Path $EnvRoot)) { throw "夹具不存在：$EnvRoot" }

    # stderr 必须收下来：`DC_AUTOSCAN` 起不来时（卷几何取不到 / 变量没生效）原因**只打在那里**，
    # 而界面上的样子与"扫描慢"逐像素相同 —— 2026-10-23 在这一格上红过一次，
    # 当时手里没有那行日志，只能靠重跑猜。从这里开始它总是有的。
    $errLog = Join-Path 'D:\dc-tmp' 'cleanup-card-detail-stderr.log'
    $outLog = Join-Path 'D:\dc-tmp' 'cleanup-card-detail-stdout.log'
    Remove-Item $errLog, $outLog -ErrorAction SilentlyContinue
    $proc = Start-Process -FilePath $App -RedirectStandardError $errLog -RedirectStandardOutput $outLog -PassThru
    $script:Proc = $proc
    $win = $null
    for ($i = 0; $i -lt 100; $i++) {
        $cands = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $proc.Id))
        $win = $cands | Where-Object { $_.Current.ClassName -eq 'Tauri Window' } | Select-Object -First 1
        if ($win) { break }
        if ($proc.HasExited) { throw "进程自己退了（exit=$($proc.ExitCode)）" }
        Start-Sleep -Milliseconds 500
    }
    if (-not $win) { throw "50 秒内没抓到 'Tauri Window'" }
    $script:Win = $win
    $script:Hwnd = [System.IntPtr]::new($win.Current.NativeWindowHandle)
    Write-Host "  pid=$($proc.Id) hwnd=$($script:Hwnd) envroot=$EnvRoot"

    # ---- 宽窗：等自动扫描跑完 → 进清理页 → 量几何 + 拍列表 + 打开详情框 + 拍框 ----
    [void][DcCardWin]::MoveWindow($script:Hwnd, 40, 30, 1440, 900, $true)
    Start-Sleep -Milliseconds 1800
    # 先把扫描等完（`--wait-scan` 会切到清理页并等重新计价落定），再单独跑几何那一支：
    # 两件事写在一个脚本里会互相挡住 —— 前者要等 600 轮，后者要求"现在就可以量"。
    node (Join-Path $PSScriptRoot 'cleanup-layout-probe.mjs') --port $Port --wait-scan
    if ($LASTEXITCODE -ne 0) { throw "扫描/就绪这一段失败（退出码 $LASTEXITCODE）" }
    Start-Sleep -Milliseconds 800

    # 列表相（详情框是关着的）—— 探针会先量、再点开框、再按 Esc 关掉，所以这里拍的是关着的相。
    Probe '1440'
    Shot (Join-Path $OutDir "${Prefix}1440-list.png")

    # 详情框相：单独点开一个、拍、再关（探针那一次已经关掉了，这里重开一次专门为图）。
    node (Join-Path $PSScriptRoot 'cleanup-card-detail-shot.mjs') --port $Port --mode open
    if ($LASTEXITCODE -ne 0) { throw "打开详情框失败（退出码 $LASTEXITCODE）" }
    Start-Sleep -Milliseconds 700
    Shot (Join-Path $OutDir "${Prefix}1440-detail.png")
    node (Join-Path $PSScriptRoot 'cleanup-card-detail-shot.mjs') --port $Port --mode close
    if ($LASTEXITCODE -ne 0) { throw "关闭详情框失败（退出码 $LASTEXITCODE）" }

    # ---- 窄窗：等高在这一档是**故意撤销**的，所以只量"没被压坏"（不量等高）----
    [void][DcCardWin]::MoveWindow($script:Hwnd, 40, 30, 880, 880, $true)
    Start-Sleep -Milliseconds 1600
    node (Join-Path $PSScriptRoot 'cleanup-layout-probe.mjs') --port $Port --physical 880
    if ($LASTEXITCODE -ne 0) { throw "窄窗版式探针红了（退出码 $LASTEXITCODE）" }
    Shot (Join-Path $OutDir "${Prefix}880-list.png")

    Write-Host "DONE（等高 / 居中 / 最简摘要 / 详情框开-看-关 全绿；三张图由人肉眼复核）"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    # 先打进程日志：DC_AUTOSCAN / 卷几何那几条失败只有这里看得见（界面上与"扫描慢"同形）
    if ($errLog -and (Test-Path $errLog)) {
        $e = Get-Content $errLog -Raw -ErrorAction SilentlyContinue
        if ($e) { Write-Host "  应用 stderr：$($e.Trim())" }
    }
    try { if ($script:Hwnd) { Shot (Join-Path $OutDir "${Prefix}FAIL.png") } } catch { }
    exit 1
} finally {
    Get-Process deepclean-app -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }
    Start-Sleep -Milliseconds 1500
    Get-Process deepclean-app -ErrorAction SilentlyContinue | Stop-Process -Force
}
