# run-mcp.ps1 —— 前台运行电脑侧 MCP 服务（19395），隐藏窗口启动
$ErrorActionPreference = 'Continue'
$MC = Split-Path -Parent $PSScriptRoot
$env:MC_MCP_TOKEN = (Get-Content (Join-Path $MC 'mcp-token.txt') -Raw).Trim()
Set-Location (Join-Path $MC 'mcp')
& node (Join-Path $MC 'mcp\pc-mcp-server.js')
