# M5-J 真机验收：规格书 M5 那一行「十万级文件重复检测不卡界面」。
#
# M5-F 量的是**扫描**与锁内三段，没量过重复检测那一轮 —— 这一相补上它。
# 三件事分开证，全部只读（不点任何执行入口）：
#   ① 检测途中按钮那句「已读 N」连采若干点，**每一轮都拿到新数字**
#      ⇒ 进度事件在流、渲染进程在更新（界面被按住时它不动）；
#   ② 途中点导航（首页 ↔ 重复文件）换得动；
#   ③ 点「取消」必须**说实话**：报告那句要出现「被取消」，而不是交一份看着完整的报告。
#      这一相顺带把 M5-B 那条「取消要 cancelled=true 且 complete=false」在真机上走一遍；
#   ④ 把取消那一拍报告里的计数器原样抄回来（候选 / 成组 / 确认 / **被禁止根挡掉多少条**）——
#      这一格是 M5-G 那次修复在真盘上的对账口。
#
# 目标 `C:\Windows`：12 万级文件（M5-F 那格的同一棵根，数对得上）。
# 检测**不要求跑完** —— 判据是"途中界面动不动"；这台机器的 C: 已用 96%，
# debug 版 15 秒只做 18 次快速哈希，跑完要几十分钟，那是机器的属性不是产品的缺陷。
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\debug\deepclean-app.exe",
    [string]$Root   = "C:\Windows",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_DUP   = U 0x91CD, 0x590D, 0x6587, 0x4EF6   # 重复文件
$T_READ  = U 0x5DF2, 0x8BFB                   # 已读
$T_START = U 0x5F00, 0x59CB, 0x67E5, 0x627E   # 开始查找
$T_CANCEL= U 0x53D6, 0x6D88                   # 取消
$T_BY    = U 0x88AB, 0x53D6, 0x6D88           # 被取消
$T_HOME  = U 0x9996, 0x9875                   # 首页
$T_FILES = U 0x5DF2, 0x626B, 0x63CF, 0x6587, 0x4EF6  # 已扫描文件

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
    $e = Find-ByName $name 10
    if (-not $e) { return $false }
    $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    return $true
}
function Shot([string]$file) {
    Ensure-OnTop
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $full = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($full)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $r = $script:Win.Current.BoundingRectangle
    $x = [Math]::Max(0, [int]$r.X); $y = [Math]::Max(0, [int]$r.Y)
    $cw = [Math]::Min([int]$r.Width, $full.Width - $x)
    $ch = [Math]::Min([int]$r.Height, $full.Height - $y)
    $crop = New-Object System.Drawing.Bitmap($cw, $ch)
    $gc = [System.Drawing.Graphics]::FromImage($crop)
    $gc.DrawImage($full, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), (New-Object System.Drawing.Rectangle($x, $y, $cw, $ch)), [System.Drawing.GraphicsUnit]::Pixel)
    $crop.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $gc.Dispose(); $crop.Dispose(); $g.Dispose(); $full.Dispose()
    Write-Host "  截图 -> $file ($((Get-Item $file).Length) 字节)"
}

try {
    $env:DC_AUTOSCAN = $Root
    $env:DC_SETTINGS_DIR = 'D:\deepclean-fixture\m5e-settings'
    $p = Start-Process -FilePath $App -PassThru
    $script:ProcId = $p.Id
    for ($i = 0; $i -lt 60; $i++) {
        $cands = $A::RootElement.FindAll($SCOPE_C, [System.Windows.Automation.PropertyCondition]::new($A::ProcessIdProperty, $p.Id))
        $w = $cands | Where-Object { $_.Current.ClassName -eq 'Tauri Window' } | Select-Object -First 1
        if ($w) { $script:Win = $w; $script:Hwnd = [System.IntPtr]::new($w.Current.NativeWindowHandle); break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $script:Win) { throw "没有窗口" }

    # ---- 先把扫描跑完（检测要求树已 publish） ----
    # 循环条件先要"读到过至少一格"：应用启动与首帧渲染要几秒，
    # 拿不到标签就退出会把"还没起来"误判成"扫完了"（第一版就是这么红的）。
    $rxScan = [regex]("$T_FILES\|[^0-9]{0,12}([0-9][0-9,\.]*)")
    $flat = 0
    $seen = $false
    $lastVal = ''
    $end1 = (Get-Date).AddSeconds(300)
    while ((Get-Date) -lt $end1 -and (-not $seen -or $flat -lt 6)) {
        $m = $rxScan.Match((PageText))
        if ($m.Success) {
            if (-not $seen -or $m.Groups[1].Value -ne $lastVal) { $flat = 0 } else { $flat++ }
            $lastVal = $m.Groups[1].Value
            $seen = $true
        } else { $flat++ }
        Start-Sleep -Milliseconds 500
    }
    if (-not $seen) { throw "300 s 内首页一直读不到「$T_FILES」—— 应用没起来还是没在扫？" }
    Write-Host "  扫描完成：$lastVal 个文件"

    # ---- ① 开跑检测，采「已读 N」 ----
    if (-not (Invoke-ByName $T_DUP)) { throw "点不到「$T_DUP」" }
    Start-Sleep -Milliseconds 1200
    if (-not (Invoke-ByName $T_START)) { throw "找不到「$T_START」那颗按钮" }
    $rx = [regex]("$T_READ[^0-9]{0,10}([0-9][0-9,\.]*)")
    $samples = @()
    $end2 = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $end2 -and $samples.Count -lt 8) {
        $m2 = $rx.Match((PageText))
        if ($m2.Success) {
            $v = [int64]($m2.Groups[1].Value -replace ',', '')
            if ($samples.Count -eq 0 -or $samples[-1] -ne $v) { $samples += $v }
        }
        Start-Sleep -Milliseconds 900
    }
    Write-Host "  ① 检测途中「$T_READ」采样：$($samples -join ' → ')（共 $($samples.Count) 个点）"
    if ($samples.Count -lt 4) { throw "只采到 $($samples.Count) 个点 —— 进度没在动，这一相没抓到" }
    $inc = 0
    for ($i = 1; $i -lt $samples.Count; $i++) { if ($samples[$i] -gt $samples[$i - 1]) { $inc++ } }
    if ($inc -ne $samples.Count - 1) { throw "「$T_READ」有 $($samples.Count - 1 - $inc) 次没在涨 —— 界面被按住的证据" }
    Shot (Join-Path $OutDir 'm5j-detect-running.png')

    # ---- ② 途中点导航 ----
    $null = Invoke-ByName $T_HOME
    Start-Sleep -Milliseconds 900
    $t = PageText
    if (-not $rxScan.Match($t).Success) { throw "点「$T_HOME」后回不去（读不到「$T_FILES」）" }
    $null = Invoke-ByName $T_DUP
    Start-Sleep -Milliseconds 900
    if (-not ((PageText).Contains($T_READ) -or (PageText).Contains($T_CANCEL))) { throw "回到「$T_DUP」看不到检测进行中的任何痕迹" }
    Write-Host "  ② 检测途中首页 ↔ 「$T_DUP」来回点得动，回来时那一轮还在跑"

    # ---- ③ 取消必须说实话 ----
    if (-not (Invoke-ByName $T_CANCEL)) { throw "找不到「$T_CANCEL」那颗按钮（它消失了就是 M5-B 记过的那类缺陷）" }
    $sawCancelled = $false
    $end3 = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $end3 -and -not $sawCancelled) {
        if ((PageText).Contains($T_BY)) { $sawCancelled = $true } else { Start-Sleep -Milliseconds 600 }
    }
    if (-not $sawCancelled) { throw "点了「$T_CANCEL」但界面上始终没出现「$T_BY」—— 取消没说实话" }
    Write-Host "  ③ 点「$T_CANCEL」→ 界面那句改口成「$T_BY」（不是交一份看着完整的报告）"
    Shot (Join-Path $OutDir 'm5j-cancelled.png')

    # ---- ④ 把这一拍报告那句里的计数器原样抄回来（候选 / 成组 / 确认 / 被挡） ----
    # 刻意**不要求跑完**：这台机器的 C: 已用 96%，debug 版 15 秒只做 18 次快速哈希，
    # 945 个候选跑不完（第一版把"跑完"设成判据，结果每一跑都是 15 分钟 + 一个 FAIL ——
    # 那是机器的属性，不是产品的缺陷）。规格那一行写的是「不卡界面」，①②③ 才是它的判据；
    # 这一相只负责把真盘上量到的数记下来，跑没跑完照实说。
    function Grab([regex]$rx, [string]$label) {
        $m = $rx.Match((PageText))
        if ($m.Success) { Write-Host "     $label = $($m.Groups[1].Value)"; return $m.Groups[1].Value }
        Write-Host "     $label = 没读到（这一格没量到，不猜）"
        return $null
    }
    # 分隔符要宽松：UIA 把「候选」与数字放在**两个元素**里，拼出来的串是 `候选 |216`
    # （标签自带一个尾随空格再跟竖线），第一版写 `\|? ?` 因此永远匹配不上 —— 读不到数
    # 就照实说读不到，这一点是对的，但那是自己的解析 bug，不是"没量到"。
    $cand  = Grab ([regex]'候选[^\d]{0,4}([0-9][0-9,]*)')                    '候选（过了根这道闸的）'
    $sizes = Grab ([regex]'同大小成组[^\d]{0,4}([0-9][0-9,]*)')               '同大小成组'
    $conf  = Grab ([regex]'确认[^\d]{0,4}([0-9][0-9,]*)[^\d]{0,4}组')         '确认组'
    $blk   = Grab ([regex]'([0-9][0-9,]*)[^\d]{0,4}个文件在禁止根')            '被禁止根/只上报根挡在候选之外'
    Write-Host "  ④ 这一拍量到的真盘数：候选 $cand / 成组 $sizes / 确认 $conf / 被挡 $blk（跑完与否见上）"
    Write-Host "DONE（§M5 那一行：途中界面在更新 + 途中导航点得动 + 取消说实话 + 真盘计数器点名）"
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($script:Win) { Shot (Join-Path $OutDir 'm5j-FAIL.png') } } catch { }
    exit 1
} finally {
    if ($script:ProcId) { Stop-Process -Id $script:ProcId -Force -ErrorAction SilentlyContinue }
}
