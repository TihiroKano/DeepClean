# 勾选延迟的真机验收（2026-10-25）。
#
# 走 **debug 构建**：DC_ENV_ROOT 是 debug-only 口子，规则领地才会进靶场。
# 判据：**真鼠标点下去，同一拍**勾选框必须已翻成已勾、行必须高亮；
#       回包落定后「计入预估」必须不再是「—」。
# 截图落 docs/acceptance/assets/checkbox-instant.png。
param(
    [string]$App = 'D:\DeepClean\src-tauri\target\debug\deepclean-app.exe',
    [int]$Port   = 9231
)
$ErrorActionPreference = 'Stop'

function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_DEL = U 0x5220, 0x9664, 0x6D4B, 0x8BD5            # 删除测试
$target = Join-Path $env:USERPROFILE ("Desktop\DeepClean" + $T_DEL + "\target")
if (-not (Test-Path $target)) { throw "授权靶场不存在：$target" }
$envroot = Join-Path $target "envroot"
$scratch = Join-Path $envroot "TEMP"

# ---- 造种子：5 个 8 KiB 文件（与 clean-dialog-e2e 同一套靶场）----
if (Test-Path $envroot) { Remove-Item -Recurse -Force $envroot }
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
1..5 | ForEach-Object {
    [System.IO.File]::WriteAllBytes((Join-Path $scratch ("clean-dialog-{0}.tmp" -f $_)), (New-Object byte[] 8192))
}
$before = @(Get-ChildItem $scratch -File).Count
Write-Host "seeded $before files -> $scratch"
if ($before -ne 5) { throw "种子没造齐（$before ≠ 5）" }

if (-not (Test-Path $App)) { throw "应用产物不存在：$App（先 cargo build）" }
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $App
$psi.UseShellExecute = $false
$psi.EnvironmentVariables["DC_ENV_ROOT"] = $envroot
$proc = [System.Diagnostics.Process]::Start($psi)
Write-Host "PID=$($proc.Id)"

try {
    node (Join-Path $PSScriptRoot 'checkbox-latency-probe.mjs') --port $Port --root $envroot --out 'D:\dc-tmp\checkbox-latency.json'
    if ($LASTEXITCODE -ne 0) { throw "探针失败（退出码 $LASTEXITCODE）" }
    Write-Host "PROBE_OK"
}
finally {
    if (-not $proc.HasExited) {
        $proc.Kill()
        $proc.WaitForExit(5000) | Out-Null
    }
}

# 靶场没被删过（本探针不执行清理），独立核对一下
$after = @(Get-ChildItem $scratch -File -ErrorAction SilentlyContinue).Count
Write-Host "after: $after files"
if ($after -ne 5) { throw "本探针不该删文件，却剩 $after 个" }
Write-Host "CHECKBOX_E2E_OK"
