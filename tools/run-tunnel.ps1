# run-tunnel.ps1 —— 前台运行 cloudflared 隧道（由 stack.ps1 用 powershell -WindowStyle Hidden 隐藏启动）
$ErrorActionPreference = 'Continue'
$MC = Split-Path -Parent $PSScriptRoot
$CF  = Join-Path $env:USERPROFILE '.dsh\dsh-pocket\bin\cloudflared.exe'
$CFG = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
$log = Join-Path $MC '_tunnel.log'
Add-Content -Path $log -Value ('[' + (Get-Date -Format 'MM-dd HH:mm:ss') + '] start') -Encoding UTF8
& $CF tunnel --protocol http2 --config $CFG run *>> $log
Add-Content -Path $log -Value ('[' + (Get-Date -Format 'MM-dd HH:mm:ss') + '] exited code ' + $LASTEXITCODE) -Encoding UTF8
