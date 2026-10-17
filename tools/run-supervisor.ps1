# run-supervisor.ps1 —— 前台运行隧道看护（node），由 stack.ps1 用 -WindowStyle Hidden 隐藏启动
$ErrorActionPreference = 'Continue'
$MC = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { exit 1 }
Set-Location $MC
& $node (Join-Path $MC 'tools\tunnel-supervisor.js')
