# M5-E⑤ 真机验收：扫描报告导出（v0.1 那份带 schema 的 JSON）。
# **全程零删除**：只点「导出 JSON 报告」这一条只读通道，跑完逐名点名夹具文件还在盘上。
#
# 三件事分开证。落点由服务端定（原生保存框在本机弹不出来，见 `commands.rs::dc_export_report`
# 里那段偏离登记），所以证据链刻意是"界面说什么位置 ↔ 那个位置真有什么"，两边都不许脚本猜：
#   ① 点导出 → 界面那句「已导出：<路径>」点名的位置，盘上真有那份文件；
#   ② 再点一次 → 同一格位置（覆盖写，不是攒一堆孤儿文件）；
#   ③ 内容对得上独立口径 —— `scan.counters` 与 `Get-ChildItem` 现数的 files/dirs 逐项一致，
#      `schema` 串逐字对，`errors.sample` 那两条"整键缺席"的规矩成立，目录树不是空的。
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\release\deepclean-app.exe",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    # 换构建跑必须换前缀：`m5e-report-exported.png` 那张是 debug 态既有的证据图，不许被这一棒覆盖。
    [string]$Prefix = "m5ereport-rel-"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
# release 可用的「起应用 + 扫一棵树 + 按 DWM 帧裁图」通道
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_HOME       = U 0x9996, 0x9875
$T_EXPORT_BTN = U 0x5BFC, 0x51FA, 0x0020, 0x4A, 0x53, 0x4F, 0x4E, 0x0020, 0x62A5, 0x544A
$T_DONE       = U 0x5DF2, 0x5BFC, 0x51FA
$T_COLON      = [char]0xFF1A

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
    Start-Sleep -Milliseconds 300
}
function Find-ByName([string]$sub, [int]$sec = 25) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) {
        foreach ($e in All) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }
        Start-Sleep -Milliseconds 300
    }
    return $null
}
function Note-Line([string]$prefix) {
    # 界面那句是「已导出：<路径>」，整条在一个元素名里；按全角冒号切，不猜路径形状
    $all = (PageText) -split '\|'   # 必须转义：-split 走正则，裸 | 会把它切成单字符
    $hit = @($all | Where-Object { $_.StartsWith($prefix) }) | Select-Object -First 1
    if (-not $hit) { return $null }
    $i = $hit.IndexOf($T_COLON)
    if ($i -lt 0) { return $null }
    return $hit.Substring($i + 1).Trim()
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

$R = 'D:\deepclean-fixture\m5e-report'
try {
    if (Test-Path $R) { Remove-Item -Recurse -Force $R }
    New-Item -ItemType Directory -Force -Path "$R\a\b" | Out-Null
    function Blank([int]$n) { $a = New-Object byte[] $n; for ($i = 0; $i -lt $n; $i++) { $a[$i] = [byte]($i -band 0xff) }; return $a }
    [System.IO.File]::WriteAllBytes("$R\one.bin", (Blank 300000))
    [System.IO.File]::WriteAllBytes("$R\a\two.bin", (Blank 200000))
    [System.IO.File]::WriteAllBytes("$R\a\b\three.bin", (Blank 100000))
    $oracleFiles = (Get-ChildItem -Path $R -Recurse -File | Measure-Object).Count
    $oracleDirs = (Get-ChildItem -Path $R -Recurse -Directory | Measure-Object).Count
    Write-Host "  夹具：$oracleFiles 个文件 / $oracleDirs 个子目录（独立口径）"

    # DC_SETTINGS_DIR 是 settings.rs:198 那个 #[cfg(debug_assertions)] 的重定向 ⇒ **打包版拿不到**，
    # 这一棒在 release 上的导出会写用户真的那份目录，所以先把真设置拍快照，finally 里还原。
    $env:DC_SETTINGS_DIR = 'D:\deepclean-fixture\m5e-report-settings'
    $script:SetTok = Protect-DcSettings
    # 变量名一律 $dcApp：PowerShell 大小写不敏感，接成 $r 会把这个脚本的夹具根 $R 直接覆盖掉
    # （m5e-exclusions 迁移时就这么红过一次，兜住它的是零删除那条 throw）。
    $dcApp = Start-DcReleaseApp -App $App -ScanRoot $R -WaitSec 150
    $script:ProcId = $dcApp.Proc.Id
    $script:Win = $dcApp.Win
    $script:Hwnd = $dcApp.Hwnd
    Write-Host "  扫描跑完（面包屑里有这棵根）"

    $homeBtn = (All | Where-Object { $_.Current.Name -eq $T_HOME } | Select-Object -First 1)
    if (-not $homeBtn) { throw "侧栏没有「$T_HOME」那一项" }
    $homeBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 1500

    # ---- ① 界面点名的那个位置，盘上真有 ----
    # 前先记下 reports/ 里本来有哪些文件（上一次失败的回跑会留下孤儿，不能把它当成「这次又写了一份」）。
    $reportsDir = Join-Path $env:APPDATA 'com.deepclean.app\reports'
    $before = @(Get-ChildItem $reportsDir -Filter 'deepclean-report-*.json' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
    $btn = Find-ByName $T_EXPORT_BTN
    if (-not $btn) { throw "首页没有「$T_EXPORT_BTN」那颗" }
    $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $jsonPath = $null
    $end1 = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $end1 -and -not $jsonPath) {
        $jsonPath = Note-Line $T_DONE
        if (-not $jsonPath) { Start-Sleep -Milliseconds 400 }
    }
    if (-not $jsonPath) { throw "30s 内界面没念出「$T_DONE：…」那句" }
    Write-Host "  ① 界面点名位置：$jsonPath"
    if (-not (Test-Path $jsonPath)) { throw "界面说导出到 $jsonPath，盘上却没有" }
    Shot (Join-Path $OutDir "${Prefix}exported.png")

    # ---- ② 再点一次：同一格位置（覆盖写） ----
    $btn2 = Find-ByName $T_EXPORT_BTN
    $btn2.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 2500
    $again = Note-Line $T_DONE
    if ($again -ne $jsonPath) { throw "两次导出落到不同位置：$jsonPath vs $again" }
    $after = @(Get-ChildItem (Split-Path $jsonPath) -Filter 'deepclean-report-*.json' | ForEach-Object { $_.Name })
    $fresh = @($after | Where-Object { $before -notcontains $_ })
    if ($fresh.Count -ne 1) { throw "两次导出凭空写出 $($fresh.Count) 份新文件（该是 1 份，第二遍覆盖同一格）：$($fresh -join ', ')" }
    if ($fresh[0] -ne (Split-Path $jsonPath -Leaf)) { throw "盘上新增的是 $($fresh[0])，界面点名的却是 $jsonPath" }
    $dirCount = $after.Count
    Write-Host "  ② 两次导出同一格位置；本次新增 $($fresh.Count) 份（reports/ 下共 $dirCount 份，含历史）"

    # ---- ③ 内容与独立口径对账 ----
    $doc = Get-Content -Raw -Encoding UTF8 $jsonPath | ConvertFrom-Json
    if ($doc.schema -ne 'deepclean.scan-report/1') { throw "schema 串不对：$($doc.schema)" }
    if ($doc.app.name -ne 'DeepClean') { throw "app.name 不对" }
    if (-not $doc.app.version) { throw "app.version 是空的（那会是一个看起来正常的假版本号）" }
    Write-Host "  ③ schema=$($doc.schema) app=$($doc.app.name) $($doc.app.version) status=$($doc.scan.status)"
    Write-Host "     报告 files=$($doc.scan.counters.files) dirs=$($doc.scan.counters.dirs) totalBytes=$($doc.scan.counters.totalBytes)"
    Write-Host "     独立 files=$oracleFiles dirs(不含根)=$oracleDirs"
    if ([int]$doc.scan.counters.files -ne $oracleFiles) { throw "文件条数对不上：报告 $($doc.scan.counters.files) vs 独立 $oracleFiles" }
    # dirs 的口径是「子树目录数、不含本目录自己」（shared/types.ts:186 与 TS 侧 tree-store 的 dirCount += 1 都是这个口径），
    # Get-ChildItem -Recurse -Directory 同样不含根 —— 两边都是 2，谁也不加 1。
    if ([int]$doc.scan.counters.dirs -ne $oracleDirs) { throw "目录数对不上：报告 $($doc.scan.counters.dirs) vs 独立 $oracleDirs（都不含扫描根）" }
    if ([long]$doc.scan.counters.totalBytes -lt 1) { throw "占用合计是 0（少报能伪装成通过，这里连上界都没过）" }
    if ($null -ne $doc.scan.peakRssBytes) { throw "peakRssBytes 该是 null（没采），实际 $($doc.scan.peakRssBytes)" }
    if ($doc.scan.errors.PSObject.Properties.Name -notcontains 'denied') { throw "errors 少了 denied 那一栏" }
    if ($doc.scan.errors.denied -eq 0) {
        if ($doc.scan.errors.PSObject.Properties.Name -contains 'sample') { throw "denied=0 还给了 sample（空数组会被读成一句话）" }
        if ($doc.scan.errors.PSObject.Properties.Name -contains 'sampleOverflow') { throw "denied=0 还给了 sampleOverflow" }
    }
    if (-not $doc.tree.children) { throw "报告里的目录树是空的（TS 那边 rootId 取错时就是这个形状）" }
    if ($doc.treeLimits.maxDepth -ne 3 -or $doc.treeLimits.topPerLevel -ne 12) { throw "裁剪参数没写出来或不是默认值" }
    if ($doc.topFiles.Count -lt 1) { throw "topFiles 是空的（那份堆没接到报告里）" }
    Write-Host "     目录树根下 $($doc.tree.children.Count) 个子项，treeLimits=$($doc.treeLimits.maxDepth)/$($doc.treeLimits.topPerLevel)，topFiles $($doc.topFiles.Count) 行"

    foreach ($f in @("$R\one.bin", "$R\a\two.bin", "$R\a\b\three.bin")) {
        if (-not (Test-Path $f)) { throw "零删除这一条没守住：$f 不在了" }
    }
    Write-Host "  三个夹具文件都还在盘上（导出是只读通道，没有任何执行入口被点过）"
    Write-Host "DONE（§报告导出：位置点名 / 覆盖写 / 内容与独立口径对账 三相全过）"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Hwnd) { Shot (Join-Path $OutDir "${Prefix}FAIL.png") } } catch { }
    exit 1
} finally {
    if ($script:ProcId) { Stop-Process -Id $script:ProcId -Force -ErrorAction SilentlyContinue }
    Restore-DcSettings $script:SetTok
}
