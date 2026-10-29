# M6 出包前置第 2 道闸的**被验方**取数：在打包要用的那份 release 产物上，真点界面扫一次
# D:\deepclean-fixture\f100k，走产品自己的 `dc_export_report` 通道把报告落到应用数据目录，
# 再把三轴与分账桶读回来。
#
# 为什么坚持 release + 真窗口，而不是 `cargo test --release golden::` 那条 harness：
# `golden.rs` 文件头自己写了理由 —— 组自己的 RuleEnv、自己建 TreeSource，量的是 harness
# 不是产品。这里要的是「装出去的那份 exe 在这台机器上会报什么数」，所以只能起那扇门。
#
# 文本框那格的判据是**开始按钮的 IsEnabled**，不是「ValuePattern 读回来等于我写的」：
# Chromium 的 UIA SetValue 未必派发 React 监的那个 input 事件（下拉框那格已经栽过一次，
# 见 scripts/m5e-topfiles-e2e.ps1:145 的注释），而 `disabled={startTarget.length === 0}`
# 放开才证明 React 的 state 真的拿到了路径。
#
# 全程只读：不点任何执行入口，跑完一个文件都不动。
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\release\deepclean-app.exe",
    [string]$Root   = "D:\deepclean-fixture\f100k",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    [int]$WaitSec   = 300,
    # 截图前缀。默认 m6-gate- 那四张是 §4.1「修前」的证据，复跑必须换前缀（同 m5-preview/m5k 那条）
    [string]$Prefix    = 'm6-gate-'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
# 共享的 DWM 裁图（截图不许把桌面拍进版本库）
. (Join-Path $PSScriptRoot 'lib-dc-release.ps1')

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
# 中文一律按码点拼：PS 5.1 把 .ps1 按 ANSI 读，字面量会变乱码
$T_SCOPE   = U 0x6307, 0x5B9A, 0x4F4D, 0x7F6E          # 指定位置
$T_READY   = U 0x626B, 0x63CF, 0x8303, 0x56F4          # 扫描范围（首页就绪的标记）
$T_CTA     = U 0x5F00, 0x59CB, 0x6DF1, 0x5EA6, 0x626B, 0x63CF  # 开始深度扫描
$T_DONE    = U 0x67E5, 0x770B, 0x626B, 0x63CF, 0x7ED3, 0x679C  # 查看扫描结果（只有扫完那支才有）
$T_EXPORT  = U 0x5BFC, 0x51FA                          # 导出
$T_EXPORTED = U 0x5DF2, 0x5BFC, 0x51FA                  # 已导出
$T_FILECNT = U 0x4E2A, 0x6587, 0x4EF6                  # 个文件
$T_HOME    = U 0x9996, 0x9875                          # 首页（导航项，整名相等）
$T_MAPMARK = U 0x9002, 0x5E94, 0x7A97, 0x53E3          # 适应窗口（空间地图独有的工具条）
$COLON     = [char]0xFF1A                              # ：

$A = [System.Windows.Automation.AutomationElement]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition
$CT = [System.Windows.Automation.ControlType]

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
function Click-El($e) {
    Ensure-OnTop
    $rect = $e.Current.BoundingRectangle
    if ($rect.Width -lt 6 -or $rect.Height -lt 6) { throw "元素矩形 $($rect.Width)x$($rect.Height) 不像能点的" }
    [void][Native.U32]::SetCursorPos([int]($rect.X + $rect.Width / 2), [int]($rect.Y + $rect.Height / 2))
    Start-Sleep -Milliseconds 250
    [Native.U32]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Native.U32]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 220
}
function Shot([string]$name) {
    # 裁图走共享实现：按 **DWM 真实帧边界** 裁。原来这两行按 UIA 的 BoundingRectangle 裁，
    # 把左边一条聊天面板的字和下面一截 IDE 状态条拍了进来，还提交进了版本库
    # （截图是泄露面 —— 桌面内容不许进仓；这条 `m5k-cleanlog-e2e.ps1:119` 早就写明过）。
    Ensure-OnTop
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath (Join-Path $OutDir $name)
    # 顶不起来就不许留图：DOM 与 z-order 无关，所有 UIA 断言照样全绿，而拍到的可能是别人家的窗口
    # （本轮第 1 张就报了 foreground=False）。同 m5-preview-e2e.ps1 那条规矩。
    if (-not $info.Foreground) { throw "拍「$name」时窗口不在最前 —— 这张不能当证据，先解决顶窗再跑" }
}

# ── 前置：残留实例一律拒绝（上一轮的 stderr 日志会被这一轮的写文件撞掉） ──
$res = @(Get-Process -Name 'deepclean-app' -ErrorAction SilentlyContinue)
if ($res.Count -gt 0) { throw "已有 $($res.Count) 个 deepclean-app 实例在跑（PID $($res.Id -join ',')）—— 先关掉再跑闸" }
if (-not (Test-Path -LiteralPath $App)) { throw "产物不存在：$App —— 先 cargo build --release" }
if (-not (Test-Path -LiteralPath $Root)) { throw "目标不存在：$Root" }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
Write-Output "GATE exe=$App root=$Root"

$repsBefore = @(Get-ChildItem -LiteralPath "$env:APPDATA\com.deepclean.app\reports" -Filter *.json -ErrorAction SilentlyContinue).Count

try {
    # 起进程 → 切「指定位置」→ 填路径 → 开扫 → 等跳图 → 点回首页，整段交给共享实现。
    # 这里原来有一份**内联的重复实现**：上一轮只修了 helper（radio 之后改成 12 秒条件等待），
    # 闸脚本这份还睡 600 ms，于是它自己红了一次。一套实现，别再分叉。
    $r = Start-DcReleaseApp -App $App -ScanRoot $Root -WaitSec $WaitSec -BackHome `
        -Shot { param($tag, $h, $w) $script:Hwnd = $h; $script:Win = $w
                 $n = if ($tag -eq '1-ready') { '1-home' } else { $tag }; Shot "${Prefix}$n.png" }
    $p = $r.Proc
    $script:Win = $r.Win
    $script:Hwnd = $r.Hwnd
    Write-Output "STEP window=OK pid=$($p.Id) scan_done=OK back_home=OK"
    # ── 判据：扫完跳图再回首页，「扫描范围」那格必须**还**是「指定位置」+ 那行路径 ──
    # 输入框只在 scope==='custom' 时渲染，所以"页面上有没有 Edit"就是这一档有没有被选中的
    # 单点信号（比读旁边那个文字节点可靠 —— 文字命中常抓到相邻的 Text 而不是控件本身）。
    # 修之前这里必然 MISSING：scope/custom 是 Home 的局部 state，重新挂载就打回 'drive'，
    # 于是同一屏下方写着「扫描 89,801 个文件」、右边写着「本地磁盘 Windows」。
    $editBack = (All | Where-Object { $_.Current.ControlType -eq $CT::Edit } | Select-Object -First 1)
    if ($editBack) {
        $vb = $null
        if ($editBack.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vb)) {
            Write-Output "STEP scope_still_custom=OK value=$($vb.Current.Value)"
        } else {
            Write-Output "STEP scope_still_custom=OK（输入框在，但读不到 Value）"
        }
    } else {
        Write-Output "STEP scope_still_custom=MISSING —— 回首页后那格不再是「指定位置」，与实际扫的树矛盾"
    }
    # 界面那句「扫描 89,801 个文件」在 UIA 里被拆成**好几个节点**（数字是 `formatCount` 生成的
    # 独立文本）。只捞含「个文件」那一个会打印出一句像"界面没数"的半截话，所以往上走一层
    # 把那一行的子节点拼回来 —— 这格是"界面与报告说的是不是同一个数"的肉眼之外的第二道读数。
    $cnt = (All | Where-Object { $_.Current.Name -and $_.Current.Name.Contains($T_FILECNT) } | Select-Object -First 1)
    if ($cnt) {
        $walk = [System.Windows.Automation.TreeWalker]::RawViewWalker
        $row = $walk.GetParent($cnt)
        if ($row) {
            $row = $walk.GetParent($row)   # 再上一层到 .dc-recent-row，数字与单位是它的两个子节点
        }
        $txt = ''
        if ($row) { $txt = (($row.FindAll($SCOPE_D, $COND_TRUE) | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join ' ') }
        Write-Output "UI_COUNTER_ROW $txt"
    } else {
        Write-Output "UI_COUNTER_ROW MISSING（界面上没有含「$T_FILECNT」的那一格）"
    }
    Shot "${Prefix}3-done.png"

    # ── 走产品自己的导出通道，读回它念出来的落点 ──
    $exp = (All | Where-Object { $_.Current.ControlType -eq $CT::Button -and $_.Current.Name -and $_.Current.Name.Contains($T_EXPORT) } | Select-Object -First 1)
    if (-not $exp) { throw "找不到「$T_EXPORT ...」那个按钮（导出通道没接上？）" }
    $exp.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $note = $null
    $end = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $end) {
        $n = (All | Where-Object { $_.Current.Name -and $_.Current.Name.Contains($T_EXPORTED) } | Select-Object -First 1)
        if ($n) { $note = $n.Current.Name; break }
        Start-Sleep -Milliseconds 400
    }
    if (-not $note) { throw "点了导出但界面上没念出「$T_EXPORTED」" }
    Write-Output "STEP export_note=$note"
    $jsonPath = $note.Split($COLON)[-1].Trim()
    if (-not (Test-Path -LiteralPath $jsonPath)) { throw "界面念的路径盘上没有：$jsonPath" }
    Shot "${Prefix}4-exported.png"

    $j = Get-Content -LiteralPath $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Output "REPORT_PATH $jsonPath"
    Write-Output ("REPORT root=" + $j.scan.root + " status=" + $j.scan.status + " truncated=" + $j.scan.truncated +
        " elapsedMs=" + $j.scan.elapsedMs + " files=" + $j.scan.counters.files + " dirs=" + $j.scan.counters.dirs +
        " totalBytes=" + $j.scan.counters.totalBytes)
    Write-Output ("REPORT errors denied=" + $j.scan.errors.denied + " missing=" + $j.scan.errors.missing +
        " busy=" + $j.scan.errors.busy + " otherErrors=" + $j.scan.errors.otherErrors + " skipped=" + $j.scan.errors.skipped)
    Write-Output ("REPORT tree size=" + $j.tree.size + " files=" + $j.tree.files + " dirs=" + $j.tree.dirs +
        " foldedBytes=" + $j.tree.foldedBytes + " foldedDirs=" + $j.tree.foldedDirs)
    $repsAfter = @(Get-ChildItem -LiteralPath "$env:APPDATA\com.deepclean.app\reports" -Filter *.json -ErrorAction SilentlyContinue).Count
    Write-Output "GATE reports_dir grew $repsBefore -> $repsAfter"
    Write-Output "GATE_DONE"
}
finally {
    Get-Process -Name 'deepclean-app' -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }
    Start-Sleep -Milliseconds 1500
    $left = @(Get-Process -Name 'deepclean-app' -ErrorAction SilentlyContinue)
    if ($left.Count -gt 0) { $left | ForEach-Object { $_.Kill() }; Write-Output "CLEANUP killed $($left.Id -join ',')" }
    Write-Output "CLEANUP residual=$(@(Get-Process -Name 'deepclean-app' -ErrorAction SilentlyContinue).Count)"
}
