# M5-N 真机验收：§12（地图「加入清理列表」的具体文件）+ §20（重复组）**在同一份勾选里并存**。
# **全程零删除** —— 跑到确认回执为止，一个执行入口都不点，跑完逐名点名三个夹具文件还在盘上。
#
# 出处：`docs/acceptance/2026-10-13-tauri-m5-m.md` §3 ① ——「两条各自验过的通道在同一份勾选里
# 并存时会不会双计，今天仍然只有代码级证据」。M5-B 只验了 §20 一条通道，M5-C 只验了 §12 一条，
# 两条**同时**开着从没量过。
#
# 三相对账（期望值一律由 PowerShell 自己算，不读被测代码）：
#   P0 只勾重复组          → 5.0 MB / 1 个文件（§20 那条通道自己的基线）
#   P1 组 + 一个组外文件    → 8.0 MB / 2 个文件（两条通道并存且不相交，该相加）
#   P2 组 + 组里那份待删    → 只该计 5.0 MB / 1 个文件；双计的形状 = 10.0 MB / 2 个文件
# 三相的数刻意互不相同 ⇒ "预览还没重算完"这一种过期读数不可能伪装成任何一相的期望值。
#
# 夹具让 §12 与 §20 落在**同一个目录、同一批文件**上：
#   DC_ENV_ROOT=$Fix        ⇒ %TEMP% 指到 $Fix\TEMP，也就是 `windows-temp` 的地盘
#   DC_AUTOSCAN=$Fix\TEMP   ⇒ 扫的就是那层，三个文件都是根层格子，归属必命中
#   dup-a.bin / dup-b.bin 逐字节相同（各 5 MiB），a 的 mtime 更早 ⇒ 定序上 a 保留、b 待删；
#   solo.bin 内容不同（3 MiB）⇒ 不参与任何组，专门给 P1 当"组外那一条"。
#   「保留哪一份」由界面自己念出，脚本再拿 Get-ChildItem 的 mtime 独立复核一次。
#
# 纪律照 m5b / m5c / m5j（都是付过学费的）：UIA 名字一律用码点拼（本文件是无 BOM 的 UTF-8，
# Windows PowerShell 5.1 按 ANSI 读字面量，乱码的名字与"元素不存在"在日志里长得一模一样）；
# 复选框按 `ControlType.CheckBox` + `TogglePattern` 取；地图是 canvas 自绘 ⇒ 格子不在 UIA 树里，
# "点中了哪一格"由**单击之后详情面板里那条完整路径**判定，不由像素判定；
# 「被拒的勾选」那条是折叠的 `<details>` ⇒ 只数 summary 里那个条数，不去找列表项；
# 拍照前先 Ensure-OnTop，四张 PNG 里有逐字节相同的即判失败。
param(
    [string]$App    = "D:\DeepClean\src-tauri\target\debug\deepclean-app.exe",
    [string]$Fix    = "D:\dc-m5n-fixture",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets"
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool BringWindowToTop(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, System.IntPtr p);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool share);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, System.UIntPtr extra);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr after, int x, int y, int cx, int cy, uint flags);
'@ -Name U32 -Namespace Native -ReferencedAssemblies System.Runtime.InteropServices
[void][Native.U32]::SetProcessDPIAware()

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$N_MAP          = U 0x7A7A,0x95F4,0x5730,0x56FE                        # 空间地图
$N_DUP_NAV      = U 0x91CD,0x590D,0x6587,0x4EF6                        # 重复文件
$N_START        = U 0x5F00,0x59CB,0x67E5,0x627E,0x91CD,0x590D,0x6587,0x4EF6  # 开始查找重复文件
$S_GROUPED      = U 0x540C,0x5927,0x5C0F,0x6210,0x7EC4                 # 同大小成组
$N_GO_CLEAN     = U 0x53BB,0x6E05,0x7406,0x9875,0x786E,0x8BA4          # 去清理页确认
$S_ESTIMATE_H   = U 0x9884,0x8BA1,0x91CA,0x653E                        # 预计释放（清理页独有的地标）
$S_GEWENJIAN    = U 0x4E2A,0x6587,0x4EF6                               # 个文件
$S_KEEP         = U 0x4FDD,0x7559                                      # 保留
$S_TODEL        = U 0x5F85,0x5220                                      # 待删
$N_ADD_TO_CLEAN = U 0x52A0,0x5165,0x6E05,0x7406,0x5217,0x8868          # 加入清理列表
$S_FROM_MAP     = U 0x4ECE,0x7A7A,0x95F4,0x5730,0x56FE,0x52A0,0x5165,0x7684  # 从空间地图加入的
$N_REMOVE_ALL   = U 0x5168,0x90E8,0x79FB,0x9664                        # 全部移除
$S_REFUSE_SUM   = U 0x88AB,0x62D2,0x7684,0x52FE,0x9009                 # 被拒的勾选（summary 里那句）
$S_CONFIRMED    = U 0x5DF2,0x786E,0x8BA4                               # 已确认
$S_DIGEST       = U 0x6307,0x7EB9                                      # 指纹
$N_ESTIMATE     = U 0x786E,0x8BA4,0x9884,0x4F30                        # 确认预估（认 = U+8BA4；写成 U+8BA1「计」就永远等不到，而"按钮不存在"与"我的名字是错的"在日志里长得一模一样）
$S_ACK          = U 0x6211,0x4E86,0x89E3,0x52FE,0x9009,0x7684,0x6587,0x4EF6,0x5C06,0x88AB,0x6C38,0x4E45,0x5220,0x9664  # 我了解勾选的文件将被永久删除

$A = [System.Windows.Automation.AutomationElement]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition
$script:Own = $null
$script:Hwnd = [System.IntPtr]::Zero
$script:Win = $null
$script:Fails = @()      # 测量型判据先读数、最后统一判，免得第一相红掉就拿不到后面两相的证据

function Get-Els($root) {
    for ($i = 0; $i -lt 6; $i++) { try { return $root.FindAll($SCOPE_D, $COND_TRUE) } catch { Start-Sleep -Milliseconds 250 } }
    throw "UIA 树枚举一直失败（COM）"
}
function Names($root) { (Get-Els $root | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) }
function PageText($root) { ((Names $root) -join '|') }
# React 把一个 div 里的插值拆成多个文本节点 ⇒ 带分隔符的文本没法做跨节点的正则。
# 这一份**不带分隔符**，专供正则用（拼接顺序 = 树序）。
function FlatText($root) { ((Names $root) -join '') }
function Find-Substr($root, [string]$sub) { foreach ($e in (Get-Els $root)) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }; return $null }
function Has-Substr($root, [string]$sub) { return [bool](Find-Substr $root $sub) }
function Wait-Substr($root, [string]$sub, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { $e = Find-Substr $root $sub; if ($e) { return $e }; Start-Sleep -Milliseconds 300 }
    $t = PageText $root
    throw "${sec}s 内没出现 '$sub'。整页文本头 300 字：$($t.Substring(0, [Math]::Min(300, $t.Length)))"
}
function Wait-Gone($root, [string]$sub, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { if (-not (Has-Substr $root $sub)) { return }; Start-Sleep -Milliseconds 300 }
    throw "${sec}s 后 '$sub' 还在（这一步没生效）"
}
function Raise-Window([System.IntPtr]$h) {
    [void][Native.U32]::ShowWindow($h, 6); Start-Sleep -Milliseconds 350; [void][Native.U32]::ShowWindow($h, 9)
    $cur = [System.AppDomain]::GetCurrentThreadId()
    $tgt = [Native.U32]::GetWindowThreadProcessId($h, [System.IntPtr]::Zero)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $true)
    [void][Native.U32]::BringWindowToTop($h); [void][Native.U32]::SetForegroundWindow($h)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $false)
}
function Ensure-OnTop([string]$why) {
    $ok = [Native.U32]::SetWindowPos($script:Hwnd, [System.IntPtr]::new(-1), 0, 0, 0, 0, 0x0003)
    Raise-Window $script:Hwnd
    Start-Sleep -Milliseconds 300
    if (-not $ok) { throw "SetWindowPos(TOPMOST) 失败（$why）—— 不许在点不准的情况下继续" }
}
function Click-At([double]$fx, [double]$fy, [bool]$right = $false) {
    Ensure-OnTop "点击"
    $r = $script:Win.Current.BoundingRectangle
    $sx = [int]($r.X + $r.Width * $fx)
    $sy = [int]($r.Y + $r.Height * $fy)
    if (-not [Native.U32]::SetCursorPos($sx, $sy)) { throw "SetCursorPos($sx,$sy) 失败" }
    Start-Sleep -Milliseconds 220
    $down = if ($right) { 0x0008 } else { 0x0002 }
    $up   = if ($right) { 0x0010 } else { 0x0004 }
    [Native.U32]::mouse_event($down, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [Native.U32]::mouse_event($up, 0, 0, 0, [System.UIntPtr]::Zero)
    Start-Sleep -Milliseconds 450
}
function Invoke-ByName($root, [string]$name, [string]$expectAfter = '', [int]$tries = 4) {
    for ($t = 1; $t -le $tries; $t++) {
        $e = Find-Substr $root $name
        if (-not $e) { Start-Sleep -Milliseconds 400; continue }
        if (-not $e.Current.IsEnabled) { throw "命中的 '$name' 是 disabled（点它没有后果，判据会假过）" }
        $e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        if ($expectAfter -eq '') { Start-Sleep -Milliseconds 700; return }
        $end = (Get-Date).AddSeconds(25)
        while ((Get-Date) -lt $end) { if (Find-Substr $root $expectAfter) { return }; Start-Sleep -Milliseconds 300 }
        Write-Host "  点 '$name' 没等到 '$expectAfter'（第 $t/$tries 次），重试"
    }
    throw "点了 $tries 次 '$name' 始终没出现 '$expectAfter'"
}
# 清理页那两个数。「5.0 MB」这个字串在页面上有好几处（风险分账徽章、每行的「计入预估」列），
# 所以只认**紧挨在「预计释放」之前**的那一个：拼接文本里它必须是「…10.0 MB预计释放…」的形状。
function Read-Total($root) {
    $flat = FlatText $root
    $mB = [regex]::Match($flat, "([0-9][0-9\.]* ?(?:B|KB|MB|GB|TB))$S_ESTIMATE_H")
    $mF = [regex]::Match($flat, "$S_ESTIMATE_H[^0-9]{0,8}([0-9]+)")
    if (-not $mB.Success -or -not $mF.Success) {
        $i = $flat.IndexOf($S_ESTIMATE_H)
        $seg = if ($i -ge 0) { $flat.Substring([Math]::Max(0, $i - 60), [Math]::Min(140, $flat.Length - [Math]::Max(0, $i - 60))) } else { $flat.Substring(0, [Math]::Min(200, $flat.Length)) }
        throw "读不出预估那两个数（字节匹配 $($mB.Success) / 文件数匹配 $($mF.Success)）。「$S_ESTIMATE_H」附近原文：$seg"
    }
    return [pscustomobject]@{ Bytes = $mB.Groups[1].Value; Files = [int]$mF.Groups[1].Value }
}
# 等它自己停下来：连续两次读数一致才算落定（预览是异步的，读早了拿到的是上一相的数）
function Read-Total-Stable($root, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    $prev = $null
    while ((Get-Date) -lt $end) {
        $cur = Read-Total $root
        if ($prev -and $cur.Bytes -eq $prev.Bytes -and $cur.Files -eq $prev.Files) { return $cur }
        $prev = $cur; Start-Sleep -Milliseconds 900
    }
    throw "$($sec)s 内预估一直在变，读不到一个稳定值"
}
function Read-RefusalCount($root) {
    $flat = FlatText $root
    $m = [regex]::Match($flat, "$S_REFUSE_SUM[^0-9]{0,4}([0-9]+)")
    if ($m.Success) { return [int]$m.Groups[1].Value }
    return 0
}
# 正在被断言的那两个数排在表格下方 —— 不滚进视野就拍照，等于拍一张没有结论的图（M5-C 为这事付过学费）
function Show-Cleanup-Tail($root) {
    $e = Find-Substr $root $S_ESTIMATE_H
    if (-not $e) { throw "滚不到「$S_ESTIMATE_H」那一句（不在清理页？）" }
    try { $e.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() }
    catch { Write-Host "  （ScrollIntoView 用不上：$($_.Exception.Message)）" }
    Start-Sleep -Milliseconds 700
}
function Shot([string]$file) {
    Ensure-OnTop "拍照"
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $full = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($full)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $r = $script:Win.Current.BoundingRectangle
    $x = [Math]::Max(0, [int]$r.X); $y = [Math]::Max(0, [int]$r.Y)
    $cw = [Math]::Min([int]$r.Width, $full.Width - $x); $ch = [Math]::Min([int]$r.Height, $full.Height - $y)
    if ($cw -lt 400 -or $ch -lt 300) { $g.Dispose(); $full.Dispose(); throw "窗口矩形 $cw x $ch 不像一扇真窗口" }
    $crop = New-Object System.Drawing.Bitmap($cw, $ch)
    $gc = [System.Drawing.Graphics]::FromImage($crop)
    $gc.DrawImage($full, (New-Object System.Drawing.Rectangle(0, 0, $cw, $ch)), (New-Object System.Drawing.Rectangle($x, $y, $cw, $ch)), [System.Drawing.GraphicsUnit]::Pixel)
    $crop.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $gc.Dispose(); $crop.Dispose(); $g.Dispose(); $full.Dispose()
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "截图只有 $len 字节" }
    Write-Host "  截图 -> $file ($len 字节)"
}
# 与 `shared/format.ts` 的 formatBytes 同一套换算（只做显示换算，不参与任何判定）
function Fmt([long]$n) {
    $units = @('B', 'KB', 'MB', 'GB', 'TB', 'PB'); $v = [double]$n; $i = 0
    while ($v -ge 1024 -and $i -lt $units.Count - 1) { $v /= 1024; $i++ }
    if ($i -eq 0) { return "$([Math]::Round($v)) B" }
    return $v.ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture) + ' ' + $units[$i]
}

try {
    # ---- 夹具 ----
    if (Test-Path $Fix) { Remove-Item -Recurse -Force $Fix }
    $tempDir = Join-Path $Fix 'TEMP'
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    $sizeDup = 5242880L      # 5 MiB，两份相同
    $sizeSolo = 3145728L     # 3 MiB，唯一一份；也刻意让三相的数互不相同
    $xB = New-Object byte[] $sizeDup; for ($i = 0; $i -lt $sizeDup; $i++) { $xB[$i] = [byte](($i * 7 + 13) -band 0xff) }
    $yB = New-Object byte[] $sizeSolo; for ($i = 0; $i -lt $sizeSolo; $i++) { $yB[$i] = [byte](($i * 11 + 7) -band 0xff) }
    $fA = Join-Path $tempDir 'dup-a.bin'; $fB = Join-Path $tempDir 'dup-b.bin'; $fS = Join-Path $tempDir 'solo.bin'
    [System.IO.File]::WriteAllBytes($fA, $xB)
    [System.IO.File]::WriteAllBytes($fB, $xB)
    [System.IO.File]::WriteAllBytes($fS, $yB)
    $xB = $null; $yB = $null
    (Get-Item $fA).LastWriteTime = [datetime]'2020-01-01 08:00:00'   # 更早 ⇒ 定序上该保留
    (Get-Item $fB).LastWriteTime = [datetime]'2025-06-15 08:00:00'   # 更晚 ⇒ 待删那一份
    (Get-Item $fS).LastWriteTime = [datetime]'2023-03-03 08:00:00'

    # ---- 独立口径：Get-FileHash 认组、LastWriteTime 认保留哪一份，两条都不读被测代码 ----
    $rows = @((Get-ChildItem $tempDir -Filter *.bin | ForEach-Object { [pscustomobject]@{
        Path = $_.FullName; Size = $_.Length; Mtime = $_.LastWriteTime; Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash } }))
    $grp = @($rows | Group-Object Hash | Where-Object { $_.Count -ge 2 })
    if ($grp.Count -ne 1) { throw "夹具本身不对：期望 1 组，拿到 $($grp.Count) 组" }
    if ($grp[0].Count -ne 2) { throw "夹具本身不对：那组期望 2 份，拿到 $($grp[0].Count) 份" }
    $ordered = @($grp[0].Group | Sort-Object Mtime, Path)
    $keepPath = $ordered[0].Path
    $survivor = $ordered[1]
    $solo = $rows | Where-Object { $_.Path -ne $keepPath -and $_.Path -ne $survivor.Path }
    if (@($solo).Count -ne 1) { throw "夹具里应当还有一个不参与重复的文件" }
    $soloPath = $solo[0].Path
    $exp0 = Fmt $survivor.Size                    # P0 只勾组
    $exp1 = Fmt ($survivor.Size + $solo[0].Size)  # P1 组 + 组外
    $exp2 = Fmt $survivor.Size                    # P2 组 + 组里那份（只该计一次）
    $bad2 = Fmt ($survivor.Size * 2)              # P2 双计的形状
    Write-Host ("oracle: 保留 {0} / 待删 {1}（{2} = {3}）/ 组外 {4} = {5}" -f `
        (Split-Path $keepPath -Leaf), (Split-Path $survivor.Path -Leaf), $survivor.Size, $exp0, (Split-Path $soloPath -Leaf), (Fmt $solo[0].Size))
    Write-Host "  期望 P0 $exp0/1 · P1 $exp1/2 · P2 $exp2/1（P2 若拿到 $bad2/2 就是同一条路径计了两次）"

    # ---- 起应用：领地与扫描根都指向这棵夹具树 ----
    # 先拒绝"桌面上已经有一实例"：上一轮被中途掐掉的实例会攥着这一轮的 stderr 日志不放
    # （`-RedirectStandardError` 当场失败），而 M5-M 那次它表现成「路径输入框没出现」——
    # 一个残留实例能把一次好端端的运行读成产品坏了。处置是人工关掉，不是脚本按镜像名全杀。
    $stale = @(Get-Process deepclean-app -ErrorAction SilentlyContinue)
    if ($stale.Count -gt 0) {
        throw "已经有 $($stale.Count) 个 deepclean-app 在跑（PID $(($stale.Id) -join ', ')）—— 先关掉再跑，脚本不抢窗口"
    }
    $env:DC_ENV_ROOT = $Fix
    $env:DC_AUTOSCAN = $tempDir
    # 文件名带时刻：不会被上一轮那个残留实例攥着
    $appLog = Join-Path $Fix ('app-stderr-{0}.log' -f (Get-Date -Format 'HHmmss'))
    $p = Start-Process -FilePath $App -PassThru -RedirectStandardError $appLog
    $script:Own = $p.Id
    $script:AppLog = $appLog
    $w = $null
    for ($i = 0; $i -lt 60; $i++) {
        $cands = $A::RootElement.FindAll($SCOPE_C, [System.Windows.Automation.PropertyCondition]::new($A::ProcessIdProperty, $p.Id))
        $w = $cands | Where-Object { $_.Current.ClassName -eq 'Tauri Window' } | Select-Object -First 1
        if ($w) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $w) { throw "pid $($p.Id) 没有 'Tauri Window'（C: 只剩 3 MB 空闲，WebView2 写不下也会是这个形状）" }
    $script:Win = $w; $script:Hwnd = [System.IntPtr]::new($w.Current.NativeWindowHandle)
    Raise-Window $script:Hwnd
    # 应用的 stderr 必须落盘：上一轮这条链红在「180s 没出现这棵根」，整页文本是首页空态，
    # 而同一份脚本、同一棵夹具紧接着手动复跑 10 秒就到根。「起不来」「扫失败」「没扫」
    # 在没有那份日志时长得一模一样。落点刻意在仓库外、与夹具同目录（C: 当时只剩 3 MB，
    # 往 %TEMP% 写日志本身就可能就是失败源）。
    try {
        [void](Wait-Substr $w $tempDir 240)
    } catch {
        $said = if (Test-Path $appLog) { ((Get-Content $appLog | Out-String).Trim()) } else { '（没有这个文件 = 进程根本没起来或重定向没生效）' }
        Write-Host "  应用 stderr（$appLog）：$said"
        throw
    }
    Write-Host "  扫描跑完（面包屑里有这棵根）"

    # 加一格「加入清理列表」：先单击把详情面板切到那一条，靠**详情里那条完整路径**确认点中了哪一格，
    # 再在同一点右键、点菜单第五项。地图是 canvas 自绘，UIA 树里没有格子，元素矩形在 WebView2 里也不可信。
    # 先确认已经离开清理页（「预计释放」消失）——「空间地图」这四个字在清理页那句
    # 「从空间地图加入的」里也有，拿它当"到了地图页"的证据等于什么都没验。
    function Add-Tile([string]$targetPath, [string]$tag) {
        Invoke-ByName $script:Win $N_MAP
        Wait-Gone $script:Win $S_ESTIMATE_H 15
        Start-Sleep -Milliseconds 800
        $found = $null
        foreach ($fy in @(0.34, 0.52, 0.70, 0.84)) {
            foreach ($fx in @(0.26, 0.34, 0.42, 0.50, 0.58, 0.66)) {
                Click-At $fx $fy
                if ((FlatText $script:Win).Contains($targetPath)) { $found = @($fx, $fy); break }
            }
            if ($found) { break }
        }
        if (-not $found) { throw "$tag：地图上没找到那一格（单击 24 次，详情面板始终没念出 $targetPath）" }
        Write-Host "  $tag：($($found[0]),$($found[1])) 这一点选中了 $(Split-Path $targetPath -Leaf)（判据 = 详情面板里那条路径）"
        Click-At $found[0] $found[1] $true
        $menu = Wait-Substr $script:Win $N_ADD_TO_CLEAN 15
        if (-not $menu.Current.IsEnabled) { throw "$tag：命中的是目录格（「加入清理列表」对目录置灰）" }
        $menu.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        [void](Wait-Substr $script:Win $S_ESTIMATE_H 30)
        if (-not (Has-Substr $script:Win $S_FROM_MAP)) { throw "$tag：点了「加入清理列表」而清理页没出现「从空间地图加入的」那一块" }
        if (-not (FlatText $script:Win).Contains($targetPath)) { throw "$tag：加进来的不是那条路径（清理页没有 $targetPath）" }
    }

    # ============ P0：只勾重复组 ============
    Invoke-ByName $w $N_DUP_NAV $N_START
    Invoke-ByName $w $N_START $S_GROUPED
    $flat = FlatText $w
    if (-not $flat.Contains($keepPath)) { throw "重复页没点名保留那份 $keepPath" }
    if (-not $flat.Contains($survivor.Path)) { throw "重复页没列出待删那条 $($survivor.Path)" }
    if (-not $flat.Contains($S_KEEP) -or -not $flat.Contains($S_TODEL)) { throw "重复页既没有「$S_KEEP」也没有「$S_TODEL」" }
    Write-Host "  界面念出的保留 = $(Split-Path $keepPath -Leaf)，待删 = $(Split-Path $survivor.Path -Leaf)（与 PowerShell 按 mtime 独立算的一致）"
    $boxes = @($w.FindAll($SCOPE_D, [System.Windows.Automation.PropertyCondition]::new($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::CheckBox)))
    if ($boxes.Count -ne 1) { throw "重复页按 ControlType.CheckBox 取到 $($boxes.Count) 个复选框，期望 1 个（组没渲染出来就是 0 个）" }
    $boxes[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    Start-Sleep -Milliseconds 800
    Invoke-ByName $w $N_GO_CLEAN $S_ESTIMATE_H
    $t0 = Read-Total-Stable $w 25
    $r0 = Read-RefusalCount $w
    Write-Host "  P0（只勾组）：$($t0.Bytes) / $($t0.Files) 个文件 · 被拒 $r0 条"
    if ($t0.Bytes -ne $exp0 -or $t0.Files -ne 1) { $script:Fails += "P0 基线就不对：拿到 $($t0.Bytes)/$($t0.Files)，期望 $exp0/1 —— 后面两相失去对照意义" }
    if ($r0 -ne 0) { $script:Fails += "P0 一条通道自己就出了 $r0 条拒绝，基线不干净" }
    Show-Cleanup-Tail $w
    Shot (Join-Path $OutDir 'm5n-01-dup-only.png')

    # ============ P1：组 + 一个组外的文件（两条通道并存、路径不相交）============
    Add-Tile $soloPath 'P1'
    $t1 = Read-Total-Stable $w 25
    $r1 = Read-RefusalCount $w
    Write-Host "  P1（组 + 组外）：$($t1.Bytes) / $($t1.Files) 个文件 · 被拒 $r1 条"
    if ($t1.Bytes -ne $exp1 -or $t1.Files -ne 2) { $script:Fails += "P1 两条通道不相交却没相加：拿到 $($t1.Bytes)/$($t1.Files)，期望 $exp1/2" }
    if ($r1 -ne 0) { $script:Fails += "P1 出现了 $r1 条「$S_REFUSE_SUM」—— 两条通道各勾各的不同文件，本不该有任何拒绝" }
    Show-Cleanup-Tail $w
    Shot (Join-Path $OutDir 'm5n-02-disjoint.png')

    # ---- 摘掉地图那格，回到"只有组"，再换成组里那份待删 ----
    Invoke-ByName $w $N_REMOVE_ALL
    Wait-Gone $w $S_FROM_MAP 20
    $back = Read-Total-Stable $w 20
    if ($back.Bytes -ne $exp0) { $script:Fails += "摘掉地图那格后没回到 P0 的数：拿到 $($back.Bytes)，期望 $exp0" }

    # ============ P2：组 + 组里那份待删 = 同一条路径被两条通道各表达一次 ============
    Add-Tile $survivor.Path 'P2'
    $t2 = Read-Total-Stable $w 25
    $r2 = Read-RefusalCount $w
    Write-Host "  P2（组 + 组里那份待删）：$($t2.Bytes) / $($t2.Files) 个文件 · 被拒 $r2 条"
    if ($t2.Bytes -ne $exp2 -or $t2.Files -ne 1) {
        $script:Fails += "P2 同一条路径被计了两次：拿到 $($t2.Bytes)/$($t2.Files)，期望 $exp2/1（双计的形状正是 $bad2/2）"
    }
    if ($r2 -lt 1) { $script:Fails += "P2 一条「$S_REFUSE_SUM」都没有 —— 第二次表达既没计价也没点名，是静默吞掉" }
    Show-Cleanup-Tail $w
    Shot (Join-Path $OutDir 'm5n-03-overlap.png')

    # ---- 再走一次确认：通行证上那两个数与预估同源 ----
    $ackEl = $null
    foreach ($e in (Get-Els $w)) { if ($e.Current.Name -and $e.Current.Name.Contains($S_ACK)) { $ackEl = $e; break } }
    if (-not $ackEl) { throw "找不到「$S_ACK」那个复选框" }
    $ackEl.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    Start-Sleep -Milliseconds 500
    Invoke-ByName $w $N_ESTIMATE $S_CONFIRMED
    $rc = Wait-Substr $w $S_CONFIRMED 30
    Write-Host "  回执：$($rc.Current.Name)"
    if (-not (FlatText $w).Contains($S_DIGEST)) { $script:Fails += "回执那句没带指纹（没有指纹就没有通行证）" }
    try { $rc.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch { }
    Start-Sleep -Milliseconds 600
    Shot (Join-Path $OutDir 'm5n-04-receipt.png')
    $hs = @('m5n-01-dup-only.png', 'm5n-02-disjoint.png', 'm5n-03-overlap.png', 'm5n-04-receipt.png') |
        ForEach-Object { (Get-FileHash (Join-Path $OutDir $_) -Algorithm SHA256).Hash }
    if (($hs | Sort-Object -Unique).Count -ne $hs.Count) { throw "四张图里有逐字节相同的 ⇒ 某一相根本没改变画面，那张证据是空的" }

    # ---- 零删除的反证 ----
    foreach ($f in @($fA, $fB, $fS)) {
        if (-not (Test-Path $f)) { throw "零删除这一条没守住：$f 不在了" }
        if ((Get-Item $f).Length -ne $(if ($f -eq $fS) { $sizeSolo } else { $sizeDup })) { throw "$f 字节数变了" }
    }
    Write-Host "  三个夹具文件都还在盘上、字节数一字未改（没点任何执行入口）"

    if ($script:Fails.Count -gt 0) {
        Write-Host "---- 判定：有未成立项 ----"
        foreach ($f in $script:Fails) { Write-Host "  X $f" }
        throw "$($script:Fails.Count) 条判据未成立（见上面 X 清单）"
    }
    Write-Host "DONE：§12 与 §20 在同一份勾选里并存 —— 不相交相加、相交只计一次，且第二次表达留痕"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $script:Own = $null
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try {
        if ($script:AppLog -and (Test-Path $script:AppLog)) {
            Write-Host "  应用 stderr（$script:AppLog）：`n$(((Get-Content $script:AppLog | Select-Object -Last 12) | ForEach-Object { "    $_" }) -join "`n")"
        }
    } catch { }
    try { if ($script:Win) { Shot (Join-Path $OutDir 'm5n-FAIL.png') } } catch { }
    if ($script:Own) { Stop-Process -Id $script:Own -Force -ErrorAction SilentlyContinue }
    exit 1
}
