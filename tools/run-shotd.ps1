# run-shotd.ps1 —— 兜底启动屏幕采集（agent 通常会自己拉起），隐藏窗口启动
$ErrorActionPreference = 'Continue'
$MC = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $MC 'shotd.exe'
if (-not (Test-Path $exe)) { exit 1 }
Set-Location $MC
& $exe
