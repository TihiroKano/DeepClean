# M6-B Task 6：装机 → 核对 → 首启投递 → 卸载，**分相**跑。
#
# 为什么分相而不是一条道跑到底：这一段改的是**这台机器的系统状态**（HKLM 两把键、Program Files、
# 开始菜单），一处写错最坏的结果是"装上了但没卸干净"或"还原时把用户数据盖掉"。每相单独一条命令、
# 每相自己打印它看到了什么，我才有可能在中间停下来。
#
# 全程不许碰的东西：license.dat 的内容（设备绑定，DPAPI）只在还原后比对哈希证明没变；
# 真删授权靶场与本脚本无关（本脚本一个清理按钮都不点）。
param(
    [Parameter(Mandatory = $true)][ValidateSet('baseline', 'install', 'verify', 'firstlaunch', 'uninstall', 'residue')][string]$Phase,
    [string]$Version = '',
    [string]$Setup = '',
    [string]$BuiltExe = 'D:\DeepClean\src-tauri\target\release\deepclean-app.exe',
    [string]$Snap = 'D:\dc-tmp\m6-install-baseline.json'
)
$ErrorActionPreference = 'Stop'

# 版本号**只认一个源**：`src-tauri/tauri.conf.json` 的 `version`。
#
# 2026-10-28 改（1.0.0 那一版）：原来这里把 `0.1.0` 写死在两处（安装包文件名 + ARP 的
# DisplayVersion 判据）。版本一动，两处都要有人记得改，而**忘了改的表现是"装机验收说
# 版本不对"** —— 那看起来像安装包坏了，不像脚本过期了。所以改成从配置文件读。
$ConfPath = 'D:\DeepClean\src-tauri\tauri.conf.json'
if ($Version -eq '') {
    $Version = (Get-Content $ConfPath -Raw | ConvertFrom-Json).version
    if ([string]::IsNullOrWhiteSpace($Version)) { throw "从 $ConfPath 读不到 version" }
}
if ($Setup -eq '') {
    $Setup = "D:\DeepClean\src-tauri\target\release\bundle\nsis\DeepClean_${Version}_x64-setup.exe"
}
Write-Host "VERSION=$Version  SETUP=$Setup"

$INSTDIR = Join-Path ${env:ProgramFiles} 'DeepClean'
$ARP = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\DeepClean'
$ARP_WOW = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\DeepClean'
$COMPANY = 'HKLM:\SOFTWARE\TihiroKano\DeepClean'
$APPDATA_DIR = Join-Path $env:APPDATA 'com.deepclean.app'
$STARTMENU = Join-Path ${env:ProgramData} 'Microsoft\Windows\Start Menu\Programs'
$CODES_SRC = 'D:\DeepClean\src-tauri\resources\codes.sha256'

function Get-ArpRows {
    # ARP 里凡是名字带 DeepClean 的都点名，别只读一把键 —— 卸不干净常常就藏在第二把键里
    $out = @()
    foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
                        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (-not (Test-Path $root)) { continue }
        foreach ($k in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
            $p = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
            if ($p.DisplayName -like '*DeepClean*') {
                $out += [pscustomobject]@{ Key = $k.PSPath; DisplayName = $p.DisplayName; Publisher = $p.Publisher; DisplayVersion = $p.DisplayVersion; UninstallString = $p.UninstallString; InstallLocation = $p.InstallLocation }
            }
        }
    }
    return $out
}

function Get-PfDirs {
    if (-not (Test-Path ${env:ProgramFiles})) { return @() }
    @(Get-ChildItem ${env:ProgramFiles} -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
}

function Get-StartMenuLinks {
    @(Get-ChildItem $STARTMENU -Recurse -Filter '*DeepClean*.lnk' -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
}

function Sha256Of([string]$p) { (Get-FileHash $p -Algorithm SHA256).Hash }

switch ($Phase) {
    'baseline' {
        if (-not (Test-Path $Setup)) { throw "安装包不存在：$Setup" }
        $b = [pscustomobject]@{
            TakenAt     = (Get-Date).ToString('o')
            SetupBytes  = (Get-Item $Setup).Length
            SetupSha    = Sha256Of $Setup
            BuiltExeSha = Sha256Of $BuiltExe
            BuiltExeBytes = (Get-Item $BuiltExe).Length
            Arp         = @(Get-ArpRows)
            ProgramFilesHasDeepClean = (@(Get-PfDirs) -contains 'DeepClean')
            StartMenu   = @(Get-StartMenuLinks)
            AppDataExists = Test-Path $APPDATA_DIR
            AppDataFiles  = @(Get-ChildItem $APPDATA_DIR -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($APPDATA_DIR.Length + 1) + '|' + $_.Length })
            LicenseHash = if (Test-Path (Join-Path $APPDATA_DIR 'license\license.dat')) { Sha256Of (Join-Path $APPDATA_DIR 'license\license.dat') } else { $null }
        }
        if ($b.Arp.Count -gt 0 -or $b.ProgramFilesHasDeepClean) {
            Write-Host "  注意：装之前就有 DeepClean 的痕迹（ARP $($b.Arp.Count) 条 / ProgramFiles=$($b.ProgramFilesHasDeepClean)）—— 这不是干净基线"
        }
        $b | ConvertTo-Json -Depth 5 | Set-Content -Path $Snap -Encoding UTF8
        Write-Host ("BASELINE setup={0} B sha={1}" -f $b.SetupBytes, $b.SetupSha.Substring(0, 16))
        Write-Host ("BASELINE builtExe sha={0}" -f $b.BuiltExeSha.Substring(0, 16))
        Write-Host ("BASELINE arp={0} startmenu={1} programFilesDeepClean={2} appDataExists={3} appDataFiles={4}" -f `
            $b.Arp.Count, $b.StartMenu.Count, $b.ProgramFilesHasDeepClean, $b.AppDataExists, $b.AppDataFiles.Count)
        Write-Host ("BASELINE licenseHash={0}" -f $(if ($b.LicenseHash) { $b.LicenseHash.Substring(0, 16) } else { '(absent)' }))
        Write-Host "BASELINE_SAVED $Snap"
    }

    'install' {
        if (-not (Test-Path $Snap)) { throw '先跑 -Phase baseline' }
        Write-Host '  下一步会弹 UAC（installMode=perMachine）。/S = NSIS 静默，不弹界面但**仍要授权**。'
        $p = Start-Process -FilePath $Setup -ArgumentList '/S' -Verb RunAs -PassThru
        $p.WaitForExit()
        Write-Host ("INSTALL exitcode={0}" -f $p.ExitCode)
        if ($p.ExitCode -ne 0) { throw "安装器退出码 $($p.ExitCode)（0 才算装成）" }
        # 装完立刻核对 $INSTDIR 有东西，别等到 verify 才发现装了个空目录
        $n = @(Get-ChildItem $INSTDIR -Recurse -File -ErrorAction SilentlyContinue)
        if ($n.Count -lt 2) { throw "$INSTDIR 里只有 $($n.Count) 个文件 —— 不像装上了" }
        Write-Host ("INSTALL ok INSTDIR={0} files={1}" -f $INSTDIR, $n.Count)
    }

    'verify' {
        $b = Get-Content $Snap -Raw | ConvertFrom-Json
        $fails = @()
        $rows = @(Get-ArpRows)
        if ($rows.Count -eq 0) { $fails += 'ARP 里找不到任何 DeepClean 条目' }
        foreach ($r in $rows) {
            Write-Host ("ARP {0} DisplayName={1} Publisher={2} DisplayVersion={3}" -f $r.Key, $r.DisplayName, $r.Publisher, $r.DisplayVersion)
            if ($r.Publisher -ne 'TihiroKano') { $fails += "Publisher 不是 TihiroKano：'$($r.Publisher)'" }
            if ($r.DisplayVersion -ne $Version) { $fails += "DisplayVersion 不是 $Version：'$($r.DisplayVersion)'" }
        }
        $links = @(Get-StartMenuLinks)
        Write-Host ("STARTMENU links={0}" -f $links.Count)
        if ($links.Count -eq 0) { $fails += '开始菜单里没有 DeepClean 快捷方式' }
        foreach ($l in $links) {
            $sh = New-Object -ComObject WScript.Shell
            $tgt = $sh.CreateShortcut($l).TargetPath
            Write-Host ("  LINK {0} -> {1}" -f (Split-Path $l -Leaf), $tgt)
            if ($tgt -ne (Join-Path $INSTDIR 'deepclean-app.exe')) { $fails += "快捷方式指向的不是 `$INSTDIR\deepclean-app.exe：$tgt" }
        }
        $instExe = Join-Path $INSTDIR 'deepclean-app.exe'
        if (-not (Test-Path $instExe)) { $fails += "$instExe 不存在" }
        else {
            $h = Sha256Of $instExe
            Write-Host ("INSTALLED_EXE sha={0} bytes={1}" -f $h.Substring(0, 16), (Get-Item $instExe).Length)
            # 判据**不是**"与 target/release 那份同 SHA"（正文 Task 6 Step 2 那么写，它是假的）：
            # `tauri build` 会为打包再链一遍，把内嵌常量 `__TAURI_BUNDLE_TYPE_VAR_` 从 `UNK` 改写成 `NSS`
            # —— 实测两份差 3 个字节、长度逐字节相同，其余全同。所以真正的判据是"差异**恰好**是这一处"：
            # 差 0 处说明装的是没打包上下文的那份（不对），差 >3 处说明有别的东西被改过（更不对）。
            $ai = [System.IO.File]::ReadAllBytes($BuiltExe)
            $bi = [System.IO.File]::ReadAllBytes($instExe)
            if ($ai.Length -ne $bi.Length) { $fails += "长度不同：built=$($ai.Length) installed=$($bi.Length)" }
            else {
                $diff = @()
                for ($i = 0; $i -lt $ai.Length; $i++) { if ($ai[$i] -ne $bi[$i]) { if ($diff.Count -le 8) { $diff += $i } } }
                $mark = [System.Text.Encoding]::ASCII.GetBytes('__TAURI_BUNDLE_TYPE_VAR_')
                $at = -1
                for ($i = [Math]::Max(0, $diff[0] - 64); $i -lt $diff[0]; $i++) {
                    $hit = $true
                    for ($j = 0; $j -lt $mark.Length; $j++) { if ($bi[$i + $j] -ne $mark[$j]) { $hit = $false; break } }
                    if ($hit) { $at = $i + $mark.Length; break }
                }
                $aTail = [System.Text.Encoding]::ASCII.GetString($ai, $at, 3)
                $bTail = [System.Text.Encoding]::ASCII.GetString($bi, $at, 3)
                Write-Host ("EXE_DIFF 字节数={0} 首个差异 @{1}；常量 __TAURI_BUNDLE_TYPE_VAR_ 后面 built='{2}' installed='{3}'" -f `
                    $(if ($diff.Count -le 8) { $diff.Count } else { '>8' }), $diff[0], $aTail, $bTail)
                if ($diff.Count -ne 3 -or $at -ne $diff[0] -or $aTail -ne 'UNK' -or $bTail -ne 'NSS') {
                    $fails += "两份 exe 的差异不是『恰好 __TAURI_BUNDLE_TYPE_VAR_ 那三个字节』这一处 —— 得逐个点名差异再说清每一处为什么"
                }
            }
        }
        # WebView2 那一段：本机已有运行时 ⇒ 装完不该多出 EverGreen 安装痕迹，也不该联网拉 bootstrapper
        $wv = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue
        if (-not $wv) { $wv = Get-ItemProperty 'HKLM:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue }
        Write-Host ("WEBVIEW2 pv={0}（本机装之前就有 ⇒ 安装器那段应当被跳过）" -f $(if ($wv) { $wv.pv } else { '(none)' }))
        if (-not $wv) { $fails += '这台机器上查不到 WebView2 运行时，那一格的"跳过"判据不成立' }
        foreach ($f in $fails) { Write-Host "  X $f" }
        if ($fails.Count -gt 0) { throw "verify 有 $($fails.Count) 格不成立" }
        Write-Host 'VERIFY_DONE 四格全过（ARP 字段 / 快捷方式指向 / exe 差异恰好是 bundle-type 那 3 字节 / WebView2 本机已有）'
    }

    'firstlaunch' {
        $bak = "$APPDATA_DIR.m6bak"
        if (Test-Path $bak) { throw "上一次留下的 $bak 还在 —— 先人工确认再跑，脚本不自动覆盖别人的备份" }
        if (-not (Test-Path $APPDATA_DIR)) { throw "$APPDATA_DIR 不存在，没有可改名的目录" }
        $b = Get-Content $Snap -Raw | ConvertFrom-Json
        Move-Item $APPDATA_DIR $bak
        Write-Host "  已把 $APPDATA_DIR 改名到 $bak（不是删）"
        try {
            $p = Start-Process -FilePath (Join-Path $INSTDIR 'deepclean-app.exe') -PassThru
            Start-Sleep -Seconds 12
            [void]$p.CloseMainWindow()
            Start-Sleep -Seconds 3
            if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
            $codes = Join-Path $APPDATA_DIR 'license\codes.sha256'
            $logDir = Join-Path $APPDATA_DIR 'logs'
            if (-not (Test-Path $codes)) { throw "首启没投递 $codes —— release 空数据目录的那条自投递链没走通" }
            $h1 = Sha256Of $codes; $h2 = Sha256Of $CODES_SRC
            Write-Host ("FIRSTLAUNCH codes.sha256 投递 ok 与 src-tauri/resources 那份逐字节相同={0}（{1} B）" -f ($h1 -eq $h2), (Get-Item $codes).Length)
            if ($h1 -ne $h2) { throw "投递的 codes.sha256 与仓内那份不同哈希：$h1 vs $h2" }
            # 判据是 **logs 目录建出来了**，不是"logs/deepclean.log 存在"。
            # `FileCleanLog::create`（cleanlog.rs:36-38）只做 `create_dir_all(logs)` 就把路径存下来，
            # 文件本身要到**第一条清理记录 append** 时才出现 —— 所以"首启没有 .log"是产品行为，不是缺陷。
            # （正文 Task 6 Step 3 那句"logs/deepclean.log 建出来"是照记忆写的，写错了判据。）
            if (-not (Test-Path $logDir)) { throw "首启没建出 logs 目录：$logDir" }
            $logFile = Join-Path $logDir 'deepclean.log'
            Write-Host ("FIRSTLAUNCH logs 目录 ok；deepclean.log 存在={0}（按设计要到第一条清理记录才落文件，本相不许点清理，所以 False 是对的）" -f (Test-Path $logFile))
        } finally {
            $produced = @(Get-ChildItem $APPDATA_DIR -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
            Remove-Item $APPDATA_DIR -Recurse -Force -ErrorAction SilentlyContinue
            Move-Item $bak $APPDATA_DIR
            $lic = Join-Path $APPDATA_DIR 'license\license.dat'
            if ($b.LicenseHash) {
                $now = Sha256Of $lic
                Write-Host ("RESTORED license.dat 哈希未变={0}（{1} vs {2}）" -f ($now -eq $b.LicenseHash), $now.Substring(0, 16), $b.LicenseHash.Substring(0, 16))
                if ($now -ne $b.LicenseHash) { throw 'license.dat 在这趟里被改动过 —— 立刻人工核对' }
            } else {
                # 本机基线里根本没有 license.dat（授权状态还没落到这台机器上）⇒ 这一格**没验到东西**，
                # 明写出来，不许让它看起来像"凭据未被改动 ✅"。
                Write-Host 'RESTORED license.dat 基线不存在 ⇒ 这一格无对象可核（不是通过，是没测）'
            }
            Write-Host ("RESTORED 首启那趟造出来的文件已丢弃 {0} 个；原目录已改回原名" -f $produced.Count)
        }
        Write-Host 'FIRSTLAUNCH_DONE'
    }

    'uninstall' {
        $rows = @(Get-ArpRows)
        if ($rows.Count -eq 0) { throw 'ARP 里没有 DeepClean —— 装都没装上，卸什么' }
        $u = $rows[0].UninstallString
        if (-not $u) { throw 'ARP 条目里没有 UninstallString' }
        # NSIS 写的形状有两种：`"…\uninstall.exe" /S` 或 `"…\uninstall.exe" "/S"`（带引号那段是
        # 给 QuietUninstallString 用的）。取"第一个引号对里的内容"当可执行路径，剩下的参数一律丢掉，
        # 由我们自己重新给 /S —— 直接拿整串去 Start-Process 会把 `"/S"` 当成路径的一部分。
        $m = [regex]::Match($u, '^\s*"?([^"]*?\.exe)"?')
        if (-not $m.Success) { throw "看不懂 UninstallString 的形状：$u" }
        $exe = $m.Groups[1].Value
        if (-not (Test-Path $exe)) { throw "卸载器不存在：$exe（ARP 里那句是：$u）" }
        Write-Host "  卸载器：$exe /S（仍会弹 UAC）"
        $p = Start-Process -FilePath $exe -ArgumentList '/S' -Verb RunAs -PassThru
        $p.WaitForExit()
        Write-Host ("UNINSTALL exitcode={0}" -f $p.ExitCode)
    }

    'residue' {
        $fails = @()
        foreach ($k in @($ARP, $ARP_WOW, $COMPANY)) {
            $gone = -not (Test-Path $k)
            Write-Host ("RESIDUE key {0} absent={1}" -f $k, $gone)
            if (-not $gone) { $fails += "注册表键还在：$k" }
        }
        $links = @(Get-StartMenuLinks)
        Write-Host ("RESIDUE startmenu links={0}" -f $links.Count)
        if ($links.Count -gt 0) { $fails += "开始菜单快捷方式没清：$($links -join ', ')" }
        $dirLeft = Test-Path $INSTDIR
        Write-Host ("RESIDUE INSTDIR present={0}" -f $dirLeft)
        if ($dirLeft) {
            $left = @(Get-ChildItem $INSTDIR -Recurse -File -ErrorAction SilentlyContinue)
            Write-Host ("  INSTDIR 里还剩 {0} 个文件：{1}" -f $left.Count, (($left | ForEach-Object { $_.Name }) -join ', '))
            if ($left.Count -gt 0) { $fails += "卸载后 `$INSTDIR 非空（NSIS 通常只删它自己登记的文件，用户数据类残留要逐个点名，不许一句'正常'带过）" }
        }
        # 这一条**不是缺陷**：用户数据不该被卸载器删。写清楚，别下一个人当 bug 报。
        Write-Host ("RESIDUE APPDATA present={0}（按设计保留 —— 用户数据不该被卸载器删）" -f (Test-Path $APPDATA_DIR))
        foreach ($f in $fails) { Write-Host "  X $f" }
        if ($fails.Count -gt 0) { throw "卸载残留有 $($fails.Count) 格不成立" }
        Write-Host 'RESIDUE_DONE 两把键 + 快捷方式全消失，INSTDIR 已空'
    }
}
