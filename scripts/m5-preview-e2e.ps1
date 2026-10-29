# M5-B 真机验收：勾一组重复文件 → §17 预览 → 确认回执。**全程零删除。**
#
# 这一棒要钉的是那句界面承诺：`Duplicates.tsx` 底部写「勾选只是把组 id 交给 §17 的确认链」。
# 2026-10-11 那版兑现不了（桥上直接抛 `E_NOT_IMPLEMENTED`）。所以这里跑到"拿到确认回执"为止，
# **一个删除入口都不点**，并且拿盘上坐标反证：四个夹具文件跑完之后必须还在、字节数一字不变。
#
# 三条独立坐标（不来自被测代码）：
#   ① 期望的组数/可释放字节由 PowerShell 自己的 `Get-FileHash` 现算（与 m5-dupes-e2e.ps1 同源）；
#   ② 「确认预估」那颗按钮在 `model.totalBytes === 0` 时是 disabled 的 —— 它亮起来就是
#      「重复项真并进预估了」的证据，而不是"页面上有这行字"；
#   ③ 跑完逐名点名盘上还在不在（零删除的反证）。
#
# 纪律照 m4/m5 那两份（都是付过学费的）：`$ErrorActionPreference='Stop'`；
# 每一个 UIA 名字用码点拼 —— 本文件是无 BOM 的 UTF-8，Windows PowerShell 5.1 会按 ANSI 读字面量，
# 乱码的名字与"按钮不存在"在日志里长得一模一样；复选框按 `ControlType.CheckBox` + `TogglePattern`
# 取（按 `-like` 命中的常是它旁边那个文本节点）；断言对象是**按树序拼起来的一整块文本**
# （UIA 会把一句带插值的中文拆成好几个节点）。
param(
    # 默认打的是**要发出去的那份**（M6 之后 release 才是交付物）；要看 debug 态传 -App 即可，
    # 这条通道对两种构建同形（不再吃 debug-only 的 DC_AUTOSCAN）。
    [string]$App    = "D:\DeepClean\src-tauri\target\release\deepclean-app.exe",
    [string]$Fix    = "D:\dc-dup-preview-fixture",
    [string]$OutDir = "D:\DeepClean\docs\acceptance\assets",
    # 截图名前缀。默认 `m5b-` 就是 P3 验收文档正在引用的那三张 + FAIL —— 换构建跑必须改前缀，
    # 否则会把别人的证据图静默覆盖掉（本轮真的发生过一次：release 跑把 m5b-FAIL.png 盖了，
    # 而 2026-10-14-tauri-m5-p3.md:137 正拿它当"回执在画面下方"的证据）。
    [string]$Prefix = "m5b-",
    [int]$Size      = 5242880
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
# release 可用的「起应用 + 扫一棵树」通道；不再依赖 dev-only 的 DC_AUTOSCAN
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
$N_DUP        = U 0x91CD,0x590D,0x6587,0x4EF6                                     # 重复文件
$N_START      = U 0x5F00,0x59CB,0x67E5,0x627E,0x91CD,0x590D,0x6587,0x4EF6         # 开始查找重复文件
$S_PARA       = U 0x540C,0x5927,0x5C0F,0x6210,0x7EC4                              # 同大小成组
$N_GO_CLEAN   = U 0x53BB,0x6E05,0x7406,0x9875,0x786E,0x8BA4                       # 去清理页确认
$S_ESTIMATE_H = U 0x9884,0x8BA1,0x91CA,0x653E                                     # 预计释放（清理页独有的地标；侧栏那个「垃圾清理」在每页都找得到，不能当"到了清理页"的证据。另：圾 = U+576C，第一版写成 U+57FE「埾」，于是"页面没渲染"与"我的名字是错的"在日志里长得一模一样）
$S_ACK        = U 0x6211,0x4E86,0x89E3,0x52FE,0x9009,0x7684,0x6587,0x4EF6,0x5C06,0x88AB,0x6C38,0x4E45,0x5220,0x9664  # 我了解勾选的文件将被永久删除
$N_ESTIMATE   = U 0x786E,0x8BA4,0x9884,0x4F30                                     # 确认预估
$N_EXECUTE    = U 0x5F00,0x59CB,0x6E05,0x7406                                     # 开始清理（**不点**）
$S_CONFIRMED  = U 0x5DF2,0x786E,0x8BA4                                            # 已确认
$S_DIGEST     = U 0x6307,0x7EB9                                                   # 指纹
$S_DUPROW     = U 0x91CD,0x590D,0x6587,0x4EF6                                     # 重复文件（伪项那一行的名字前缀）
$S_DENG       = U 0x7B49                                                          # 等
$S_FEN        = U 0x4EFD                                                          # 份
$S_GEWEN      = U 0x4E2A,0x6587,0x4EF6                                            # 个文件
$S_MB         = 'MB'

$A = [System.Windows.Automation.AutomationElement]
$SCOPE_C = [System.Windows.Automation.TreeScope]::Children
$SCOPE_D = [System.Windows.Automation.TreeScope]::Descendants
$COND_TRUE = [System.Windows.Automation.Condition]::TrueCondition
$script:Own = $null

function Get-Els($root) {
    for ($i = 0; $i -lt 6; $i++) { try { return $root.FindAll($SCOPE_D, $COND_TRUE) } catch { Start-Sleep -Milliseconds 250 } }
    throw "UIA 树枚举一直失败（COM）—— 这样一条判据都跑不了"
}
function Find-Name($root, [string]$name) { foreach ($e in (Get-Els $root)) { if ($e.Current.Name -eq $name) { return $e } }; return $null }
function Find-Substr($root, [string]$sub) { foreach ($e in (Get-Els $root)) { if ($e.Current.Name -and $e.Current.Name.Contains($sub)) { return $e } }; return $null }
function Wait-Substr($root, [string]$sub, [int]$sec) {
    $end = (Get-Date).AddSeconds($sec)
    while ((Get-Date) -lt $end) { $e = Find-Substr $root $sub; if ($e) { return $e }; Start-Sleep -Milliseconds 300 }
    throw "${sec}s 内没找到名字含 '$sub' 的元素"
}
function Joined-Text($root) {
    ((Get-Els $root) | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Out-String).Replace("`r`n", "").Trim()
}
function Raise-Window([System.IntPtr]$h) {
    [void][Native.U32]::ShowWindow($h, 6); Start-Sleep -Milliseconds 400; [void][Native.U32]::ShowWindow($h, 9)
    $cur = [System.AppDomain]::GetCurrentThreadId()
    $tgt = [Native.U32]::GetWindowThreadProcessId($h, [System.IntPtr]::Zero)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $true)
    [void][Native.U32]::BringWindowToTop($h); [void][Native.U32]::SetForegroundWindow($h)
    [void][Native.U32]::AttachThreadInput($cur, $tgt, $false)
}
function Click-Until($root, [string]$target, [string]$expect, [int]$tries) {
    for ($t = 1; $t -le $tries; $t++) {
        $el = Find-Substr $root $target
        if (-not $el) { throw "点不到目标：'$target'" }
        $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        $end = (Get-Date).AddSeconds(15)
        while ((Get-Date) -lt $end) { if (Find-Substr $root $expect) { return }; Start-Sleep -Milliseconds 300 }
        Write-Host "  点 '$target' 没等到 '$expect'（第 $t/$tries 次），重试"
    }
    throw "点了 $tries 次 '$target' 始终没出现 '$expect'"
}
function Shot([string]$file) {
    # **拍之前必须把这扇窗顶到最前，并且验它真在最前。**
    # 上一轮三张图全拍到了操作员桌面上正在播的视频，而所有 UIA 断言照样全绿 —— DOM 与 z-order 无关。
    # "两张 PNG 字节不同"那种闸挡不住它（三张互不相同，全是废图）。唯一的硬闸是前台句柄。
    $ok = $false
    for ($t = 0; $t -lt 5; $t++) {
        Raise-Window $script:Hwnd
        Start-Sleep -Milliseconds 400
        if ([Native.U32]::GetForegroundWindow() -eq $script:Hwnd) { $ok = $true; break }
    }
    if (-not $ok) {
        throw "拍之前顶不起这扇窗（前台句柄 $([Native.U32]::GetForegroundWindow()) ≠ $script:Hwnd）—— 不许存一张不是应用的图当证据"
    }
    # 只裁应用窗口，且必须按 **DWM 真实帧边界** 裁：UIA 的 BoundingRectangle 含透明投影边，
    # 拿它当裁剪框会把左边一条别的窗口的字拍进证据图（桌面上有别的应用在显示内容，
    # 本仓 2026-10-11 为"截图本身就是泄密面"付过两次学费）。共享实现见 lib-dc-release.ps1。
    $info = Save-DcShot -Hwnd $script:Hwnd -OutPath $file
    if ($info.Width -lt 400 -or $info.Height -lt 300) { throw "裁出来 $($info.Width)x$($info.Height) 不像一扇真窗口，这张图不能当证据" }
    if (-not $info.Foreground) { throw "截图时窗口不在最前 —— 不许存一张不是应用的图当证据" }
    $len = (Get-Item $file).Length
    if ($len -lt 100kb) { throw "截图只有 $len 字节 —— 不像拍到了渲染好的窗口" }
    Write-Host "  截图 -> $file ($len 字节，裁自 DWM 帧 $($info.Width)x$($info.Height))"
}

try {
    # ---- 夹具：三份同内容 + 一份只差一个字节（与 m5-dupes-e2e.ps1 同一个形状）----
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

    # ---- 独立口径：期望值从 Get-FileHash 现算，不从被测代码来 ----
    $hashes = Get-ChildItem -Recurse $Fix -Filter *.bin | Get-FileHash -Algorithm SHA256
    $dupGroups = @($hashes | Group-Object Hash | Where-Object { $_.Count -ge 2 })
    if ($dupGroups.Count -ne 1) { throw "夹具本身不对：期望 1 组，拿到 $($dupGroups.Count)" }
    $keepName = ($dupGroups[0].Group | Sort-Object Path | Select-Object -First 1).Path | Split-Path -Leaf
    $expectFiles = $dupGroups[0].Count - 1
    $expectBytes = $expectFiles * $Size
    # 界面上那句是 `formatBytes()` 的产物：`${v.toFixed(1)} MB` ⇒ 必须比 "10.0 MB" 而不是 "10 MB"。
    # 用 Round(...,1) 直接插值会拿到 "10"（PowerShell 去掉尾零），regex 就永不命中 —— 那是假红的教科书形状。
    $expectShown = ([Math]::Round($expectBytes / 1MB, 1)).ToString('0.0', [System.Globalization.CultureInfo]::InvariantCulture)
    Write-Host ("oracle: 1 组 / 保留 $keepName / 待删 $expectFiles 个 / {0} MB" -f $expectShown)

    # ---- 起应用 + 扫这棵树：走 release 可用的驱动通道 ----
    # 原来这一段是 `$env:DC_AUTOSCAN = $Fix` 起进程，而那个变量在 main.rs:99 上是
    # `#[cfg(debug_assertions)]` ⇒ 打包版拿不到，这一棒（以及另外 12 棒）在 M6 之后
    # 只能在 debug 上跑。改成驱动界面（指定位置 → 真点 → 等扫完），debug / release 同一条路。
    $r = Start-DcReleaseApp -App $App -ScanRoot $Fix
    $p = $r.Proc
    $script:Own = $p.Id
    $w = $r.Win
    $script:Win = $w
    $script:Hwnd = $r.Hwnd
    Write-Host "  pid=$($p.Id) 扫描根=$Fix"
    Raise-Window $script:Hwnd
    $script:WinRect = $w.Current.BoundingRectangle
    Write-Host ("  窗口矩形 {0}x{1} @ ({2},{3})" -f [int]$script:WinRect.Width, [int]$script:WinRect.Height, [int]$script:WinRect.X, [int]$script:WinRect.Y)

    # 完成判据在 helper 里（首页那格「查看扫描结果」出现）；这里再按面包屑确认扫的确实是这棵树，
    # 不靠"窗口出来了"当"扫完了"。
    if (-not (Find-Substr $w $Fix)) { throw "helper 说扫完了，但界面上找不到这棵根：$Fix" }
    Write-Host "  扫描跑完，地图渲染的就是这棵树"

    # ---- 重复文件页 → 开查 → 勾那一组 ----
    Click-Until $w $N_DUP $N_START 4
    Click-Until $w $N_START $S_PARA 3
    $boxes = @($w.FindAll($SCOPE_D, [System.Windows.Automation.PropertyCondition]::new($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::CheckBox)))
    if ($boxes.Count -lt 1) { throw "重复文件页一个复选框都没有 —— 组没渲染出来（页面文本：$(Joined-Text $w)）" }
    $boxes[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    Start-Sleep -Milliseconds 800
    $txt = Joined-Text $w
    Write-Host ("  勾完之后的页面：{0}" -f $txt.Substring(0, [Math]::Min(200, $txt.Length)))

    # ---- 走「去清理页确认 →」：这是用户点的那条路，不是侧栏导航 ----
    # 落点坐标取「预计释放」（清理页独有的那一块），不取侧栏的「垃圾清理」——
    # 导航项在任何一个页面都找得到，拿它当"到了清理页"的证据等于什么都没验。
    Click-Until $w $N_GO_CLEAN $S_ESTIMATE_H 3
    Start-Sleep -Milliseconds 2500   # 等 usePreview 的那一次取数落地（预览是异步的）

    # ---- 坐标①：伪项那一行 + 它带的字节，都在清理页上 ----
    # 按**元素名**找，不按拼起来的整页文本找：整页文本里「重复文件」四个字是侧栏导航项，
    # 恒命中，拿它当"这一行在"的证据就是自导数值。
    $dot = [char]0x00B7
    $rowName = "$S_DUPROW $dot $keepName"
    $row = Find-Substr $w $rowName
    if (-not $row) { throw "清理页没有「$rowName …」那一行（伪项没进模型）。整页文本：$((Joined-Text $w).Substring(0, 240))" }
    # 那一行排在所有规则项后面，在折叠线以下 —— 不滚进视野就拍照，两张 PNG 会跟"什么都没发生"逐字节相同
    try { $row.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() }
    catch { Write-Host "  （ScrollIntoView 用不上：$($_.Exception.Message)）" }
    Start-Sleep -Milliseconds 600
    Shot (Join-Path $OutDir "${Prefix}01-preview.png")
    $txt = Joined-Text $w
    if ($txt -notmatch "$S_DENG\s*$($dupGroups[0].Count)\s*$S_FEN") { throw "那一行没念出「等 $($dupGroups[0].Count) 份」：$txt" }
    if ($txt -notmatch ([regex]::Escape($expectShown) + '\s*' + $S_MB)) { throw "预览没按 oracle 报出 $expectShown MB：$txt" }
    if ($txt -notmatch "$expectFiles\s*$S_GEWEN") { throw "预览没念出「$expectFiles 个文件」（待删份数没按组算）：$txt" }

    # ---- 坐标②：「确认预估」亮着 == totalBytes 真的大于 0（合并进了预估）----
    $est = Wait-Substr $w $N_ESTIMATE 30
    if (-not $est.Current.IsEnabled) { throw "「确认预估」是 disabled —— 说明重复项没并进 totalBytes，预览里那行字只是摆设" }
    $ack = @($w.FindAll($SCOPE_D, [System.Windows.Automation.PropertyCondition]::new($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::CheckBox))) |
        Where-Object { $_.Current.Name -and $_.Current.Name.Contains($S_ACK) } | Select-Object -First 1
    if (-not $ack) { throw "找不到「我了解…」那个复选框（按 ControlType 取的，不是按文字）" }
    $ack.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    Start-Sleep -Milliseconds 400
    $est = Wait-Substr $w $N_ESTIMATE 20
    $est.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()

    # ---- 坐标③：拿到确认回执（有「已确认」那句 + 指纹），而**一个删除入口都没点** ----
    [void](Wait-Substr $w $S_CONFIRMED 30)
    $txt = Joined-Text $w
    if ($txt -notmatch $S_DIGEST) { throw "回执那句没带指纹（没有指纹就没有通行证）：$txt" }
    $ex = Find-Substr $w $N_EXECUTE
    if ($ex -and -not $ex.Current.IsEnabled) { throw "确认过了「开始清理」还点不动：$txt" }
    $row2 = Find-Substr $w $rowName
    if ($row2) { try { $row2.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch { } }
    Start-Sleep -Milliseconds 600
    Shot (Join-Path $OutDir "${Prefix}02-confirmed.png")
    # 两张图必须不同：同字节即"这一相根本没改变画面"，那张证据是空的（本仓为这事加过闸）
    $h1 = (Get-FileHash (Join-Path $OutDir "${Prefix}01-preview.png") -Algorithm SHA256).Hash
    $h2 = (Get-FileHash (Join-Path $OutDir "${Prefix}02-confirmed.png") -Algorithm SHA256).Hash
    if ($h1 -eq $h2) { throw "预览相与确认相两张 PNG 逐字节相同 ⇒ 第二相没有可看的后果" }

    # 第三相：回执那句（`已确认 N 项 / M 个文件 / X（指纹 …）`）要拍进图里。
    # 判据从「三张 PNG 两两必须不同」换成**几何包含** —— M5-P3 之后窗口更高、回执本来就在视野内，
    # 于是 ScrollIntoView 是空操作 ⇒ 03 与 02 逐字节相同，旧断言把"证据已经齐了"误判成"没滚到东西"。
    # 旧断言真正要防的是"拍了一张画面里根本没有回执的图"，那就直接量它：回执元素的矩形必须整个落在窗口矩形之内。
    $rc = Find-Substr $w $S_CONFIRMED
    if (-not $rc) { throw "确认回执那句不在 DOM 里（界面没渲染它）" }
    try { $rc.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView() } catch { }
    Start-Sleep -Milliseconds 600
    $rcR = $rc.Current.BoundingRectangle
    $wR = $script:Win.Current.BoundingRectangle
    if ($rcR.Width -le 0 -or $rcR.Height -le 0) { throw "回执那句的矩形是空的（$rcR）⇒ 它根本没被画出来，拍进去也是一张空证据" }
    if ($rcR.Top -lt $wR.Top -or $rcR.Bottom -gt $wR.Bottom -or $rcR.Left -lt $wR.Left -or $rcR.Right -gt $wR.Right) {
        throw "回执那句不在窗口可视区内：回执=$rcR 窗口=$wR ⇒ 这一相拍不到它"
    }
    Shot (Join-Path $OutDir "${Prefix}03-receipt.png")
    $h3 = (Get-FileHash (Join-Path $OutDir "${Prefix}03-receipt.png") -Algorithm SHA256).Hash
    if ($h3 -eq $h1) { throw "回执相与预览相逐字节相同 ⇒ 确认这一步在画面上没有任何后果" }
    Write-Host ("  回执相：几何核验通过（{0}x{1} @ ({2},{3})，窗口 {4}x{5}）；与预览相不同=({6})" -f `
        [int]$rcR.Width, [int]$rcR.Height, [int]$rcR.Left, [int]$rcR.Top, [int]$wR.Width, [int]$wR.Height, ($h3 -ne $h1))
    Write-Host "  回执相里那句的片段：$($rc.Current.Name)"

    $alive = @()
    foreach ($f in @("$Fix\a.bin", "$Fix\b.bin", "$Fix\sub\d1.bin", "$Fix\c.bin")) {
        if (Test-Path $f) { $alive += (Get-Item $f).Length } else { $alive += 'GONE' }
    }
    Write-Host "  盘上四个文件的字节数：$($alive -join ', ')"
    $gone = @($alive | Where-Object { $_ -eq 'GONE' })
    if ($gone.Count -gt 0) { throw "零删除这一条没守住：$($gone.Count) 个文件不见了" }
    Write-Host "DONE（预览 + 确认回执，零删除）"
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $script:Own = $null
} catch {
    Write-Host "FAILED: $($_.Exception.Message)"
    Write-Host "  行 $($_.InvocationInfo.ScriptLineNumber)"
    try { if ($w) { Shot (Join-Path $OutDir "${Prefix}FAIL.png") } } catch { }
    if ($script:Own) { Stop-Process -Id $script:Own -Force -ErrorAction SilentlyContinue }
    exit 1
}
