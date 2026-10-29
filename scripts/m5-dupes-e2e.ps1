# M5 duplicate detection, end to end on the real Tauri build:
#   build a small fixture tree -> dev auto-scan it -> open 重复文件 -> 开始查找重复文件
#   -> the report paragraph must say what an INDEPENDENT oracle (Get-FileHash) predicts.
#
# WHY AN EXTERNAL ORACLE: "the page shows 确认 1 组" is worthless if the number comes from the same
# code that decided what to count. So the expected numbers are computed here from the fixture files
# with PowerShell's own SHA256, and only then compared against what the app rendered.
#
# Same three disciplines as scripts/m4-license-e2e.ps1 (learned the hard way there):
#   $ErrorActionPreference='Stop' + a disk/number coordinate per phase; never trust "the click returned";
#   every UIA name is built from code points because this file is BOM-less UTF-8 and Windows
#   PowerShell 5.1 would read the literals as ANSI (a mojibake name == "the button isn't there").
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\release\deepclean-app.exe",
    [string]$Fix    = "D:\dc-dup-fixture",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    [int]$Size      = 5242880,
    # 换构建跑必须换前缀：`m5-dupes-real.png` 那份是 debug 态的证据图，覆盖它等于把别人的证据换掉。
    [string]$Prefix = "m5dupes-rel-"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')
Add-Type -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr p);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool share);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
'@ -Name U32 -Namespace Native -ReferencedAssemblies System.Runtime.InteropServices
[void][Native.U32]::SetProcessDPIAware()

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$N_DUP      = U 0x91CD,0x590D,0x6587,0x4EF6                              # 重复文件 (nav)
$N_START    = U 0x5F00,0x59CB,0x67E5,0x627E,0x91CD,0x590D,0x6587,0x4EF6  # 开始查找重复文件
$S_PARA     = U 0x540C,0x5927,0x5C0F,0x6210,0x7EC4                       # 同大小成组
$S_DONE     = U 0x67E5,0x770B,0x626B,0x63CF,0x7ED3,0x679C               # 查看扫描结果
$W_HOUXUAN  = U 0x5019,0x9009                                            # 候选
$W_QUEREN   = U 0x786E,0x8BA4                                            # 确认
$ZU         = U 0x7EC4                                                   # 组

$A = [System.Windows.Automation.AutomationElement]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition
$script:Own = $null

function Get-Els($root) {
    for ($i = 0; $i -lt 6; $i++) { try { return $root.FindAll($SCOPE_D, $COND_TRUE) } catch { Start-Sleep -Milliseconds 250 } }
    throw "UIA tree enumeration kept failing (COM) - cannot judge the UI at all"
}
function Find-Name($root, [string]$name) { foreach ($e in (Get-Els $root)) { if ($e.Current.Name -eq $name) { return $e } }; return $null }
function Find-Substr($root, [string]$sub) { foreach ($e in (Get-Els $root)) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }; return $null }
function Wait-Name($root, [string]$name, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { $e = Find-Name $root $name; if ($e) { return $e }; Start-Sleep -Milliseconds 300 }
    throw "no element named '$name' within ${sec}s"
}
function Wait-Substr($root, [string]$sub, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { $e = Find-Substr $root $sub; if ($e) { return $e }; Start-Sleep -Milliseconds 300 }
    throw "no element whose name contains '$sub' within ${sec}s"
}
function Raise-Window([System.IntPtr]$h) {
    $script:Hwnd = $h
    [void][Native.U32]::ShowWindow($h, 6); Start-Sleep -Milliseconds 400; [void][Native.U32]::ShowWindow($h, 9)
    $cur = [System.AppDomain]::GetCurrentThreadId()
    $tgt = [Native.U32]::GetWindowThreadProcessId($h, [System.IntPtr]::Zero)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $true)
    [void][Native.U32]::BringWindowToTop($h); [void][Native.U32]::SetForegroundWindow($h)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $false)
}
function Click-Until($root, [string]$target, [string]$expect, [int]$tries) {
    for ($t = 1; $t -le $tries; $t++) {
        $el = Find-Name $root $target
        if (-not $el) { throw "click target missing: '$target'" }
        $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $end = (Get-Date).AddSeconds(12)
        while ((Get-Date) -lt $end) { if (Find-Substr $root $expect) { return }; Start-Sleep -Milliseconds 300 }
        Write-Host "  click '$target' did not produce the expected result (try $t/$tries), retrying"
    }
    throw "clicking '$target' $tries times never produced '$expect'"
}
function Shot([string]$file) {
    # 拍**整块桌面**存进版本库 = 把任务栏、别的窗口、桌面上任何正在显示的东西一起存档。
    # 改成共享的 DWM 帧裁图（只裁应用窗口），并且"不在最前就拒收这张图"。
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if (-not $info.Foreground) { throw "拍 $file 时窗口不在最前 —— 这张不能当证据" }
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "screenshot is $len bytes - too small to be a rendered window" }
    Write-Host "  shot -> $file ($len bytes)"
}

try {
    # ---- 夹具：三份同内容 + 一份只差一个字节（默认阈值 4 MiB 之上才进候选）----
    if (Test-Path $Fix) { Remove-Item -Recurse -Force $Fix }
    New-Item -ItemType Directory -Path "$Fix\sub" | Out-Null
    $body = New-Object byte[] $Size
    for ($i = 0; $i -lt $Size; $i++) { $body[$i] = [byte](($i * 7 + 13) -band 0xff) }
    [System.IO.File]::WriteAllBytes("$Fix\a.bin", $body)
    [System.IO.File]::WriteAllBytes("$Fix\b.bin", $body)
    [System.IO.File]::WriteAllBytes("$Fix\sub\d1.bin", $body)
    $other = New-Object byte[] $Size
    [Array]::Copy($body, $other, $Size); $other[1000] = 1
    [System.IO.File]::WriteAllBytes("$Fix\c.bin", $other)

    # ---- 独立口径：PowerShell 自己算 sha256，期望值不从被测代码来 ----
    $hashes = Get-ChildItem -Recurse $Fix -Filter *.bin | Get-FileHash -Algorithm SHA256
    $byHash = $hashes | Group-Object Hash
    $dupGroups = @($byHash | Where-Object { $_.Count -ge 2 })
    $expectGroups = $dupGroups.Count
    $expectCandidates = @($hashes).Count
    $expectReclaim = 0
    foreach ($g in $dupGroups) { $expectReclaim += ($g.Count - 1) * $Size }
    Write-Host ("oracle: candidates={0} groups={1} reclaim={2}" -f $expectCandidates, $expectGroups, $expectReclaim)
    if ($expectGroups -ne 1 -or $expectCandidates -ne 4) { throw "夹具本身不对：期望 4 个候选 / 1 组，拿到 $expectCandidates / $expectGroups" }

    # ---- 起应用 + 扫这棵夹具树：走 release 可用的共享通道 lib-dc-release.ps1 ----
    # 原来这一段自己拼 `$env:DC_AUTOSCAN` + 按 PID 轮询窗口 + `Wait-Name $Fix`，而那个变量
    # 在 main.rs 上是 #[cfg(debug_assertions)] 门控的 ⇒ 打包版上这一棒结构上跑不了。
    # helper 的完成判据还比这里强一档：它要**地图面包屑里出现这棵根**，而旧写法只等"有个名字出来了"。
    Remove-Item Env:\DC_LICENSE_NET_FORCE -ErrorAction SilentlyContinue
    $dcApp = Start-DcReleaseApp -App $App -ScanRoot $Fix -WaitSec 180
    $p = $dcApp.Proc; $script:Win = $dcApp.Win; $script:Hwnd = $dcApp.Hwnd
    $script:Own = $p.Id
    $w = $dcApp.Win
    Write-Host "  scan done, map shows $Fix"

    # ---- 进重复文件页 → 开查 ----
    Click-Until $w $N_DUP $N_START 4
    Write-Host "  on the duplicates page"
    Click-Until $w $N_START $S_PARA 3
    # UIA 会把一句带插值的中文拆成好几个文本节点（实测抓到的"那一句"只有 `）→ 同大小成组 `）。
    # 所以断言的对象是**按树序拼起来的一整块文本**，不是某一个元素的名字。
    $txt = ((Get-Els $w) | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Out-String).Replace("`r`n", "").Trim()
    Write-Host ("  rendered text: {0}" -f $txt.Substring(0, [Math]::Min(220, $txt.Length)))

    # ---- 三条对上独立口径的断言（数字来自 Get-FileHash，不来自被测代码）----
    if ($txt -notmatch "$W_HOUXUAN\s*$expectCandidates") { throw "候选数没按 oracle 报（要 $expectCandidates）：$txt" }
    if ($txt -notmatch "$W_QUEREN\s*$expectGroups\s*$ZU") { throw "确认组数没按 oracle 报（要 $expectGroups）：$txt" }
    if ($txt -match "报告不是全量") { throw "这一轮明明跑完了，界面却说自己不是全量：$txt" }

    # 三份副本都要在组里被点名（少了任何一份就是漏扫，而"1 组"这个数照样能对上）
    foreach ($n in @("a.bin", "b.bin", "d1.bin")) {
        if (-not (Find-Substr $w $n)) { throw "组里没有 $n —— 数字对上了但清单漏了" }
    }
    if (Find-Substr $w "c.bin") { throw "c.bin 只差一个字节，不该出现在重复组里" }

    Shot (Join-Path $OutDir "${Prefix}real.png")
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $script:Own = $null
    Write-Host "DONE"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  at line $($_.InvocationInfo.ScriptLineNumber)"
    if ($script:Own) { Stop-Process -Id $script:Own -Force -ErrorAction SilentlyContinue }
    exit 1
}
