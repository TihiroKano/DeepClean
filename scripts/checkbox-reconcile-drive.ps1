# 勾选链状态对账的驱动（checkbox-reconcile-probe 的 PowerShell 外壳）。
param(
    [string]$App = 'D:\DeepClean\src-tauri\target\debug\deepclean-app.exe',
    [int]$Port   = 9232
)
$ErrorActionPreference = 'Stop'
function U([int[]]$cp) { $s = ''; foreach ($c in $cp) { $s += [char]$c }; return $s }
$T_DEL = U 0x5220, 0x9664, 0x6D4B, 0x8BD5
$target = Join-Path $env:USERPROFILE ("Desktop\DeepClean" + $T_DEL + "\target")
$envroot = Join-Path $target "envroot"
$scratch = Join-Path $envroot "TEMP"
if (Test-Path $envroot) { Remove-Item -Recurse -Force $envroot }
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
1..5 | ForEach-Object {
    [System.IO.File]::WriteAllBytes((Join-Path $scratch ("clean-dialog-{0}.tmp" -f $_)), (New-Object byte[] 8192))
}
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $App
$psi.UseShellExecute = $false
$psi.EnvironmentVariables["DC_ENV_ROOT"] = $envroot
$proc = [System.Diagnostics.Process]::Start($psi)
Write-Host "PID=$($proc.Id)"
try {
    node (Join-Path $PSScriptRoot 'checkbox-reconcile-probe.mjs') --port $Port --root $envroot --out 'D:\dc-tmp\checkbox-reconcile.json'
    if ($LASTEXITCODE -ne 0) { throw "探针失败（$LASTEXITCODE）" }
    Write-Host "RECONCILE_OK"
}
finally {
    if (-not $proc.HasExited) { $proc.Kill(); $proc.WaitForExit(5000) | Out-Null }
}
