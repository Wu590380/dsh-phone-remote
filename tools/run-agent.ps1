# run-agent.ps1 —— 前台运行面板 agent（19390 面板 / 19391 转发），隐藏窗口启动
$ErrorActionPreference = 'Continue'
$MC = Split-Path -Parent $PSScriptRoot
$env:MC_TOKEN          = (Get-Content (Join-Path $MC 'token.txt') -Raw).Trim()
$p = Join-Path $MC 'dsh-web-token.txt'
if (Test-Path $p) { $env:MC_RELAY_TOKEN = (Get-Content $p -Raw).Trim() }
$env:MC_RELAY_TARGET   = '19387'
$env:MC_RELAY_MINT_FROM = (Join-Path $env:USERPROFILE '.dsh')
$env:MC_SHOT_WIDTH     = '1000'
$env:MC_SHOT_QUALITY   = '55'
Remove-Item Env:MC_RELAY_DEBUG -ErrorAction SilentlyContinue
Set-Location $MC
& node (Join-Path $MC 'agent.js')
