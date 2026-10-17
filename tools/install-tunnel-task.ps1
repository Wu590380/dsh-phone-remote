# install-tunnel-task.ps1 —— 把隧道装成"隐藏的计划任务"（当前用户，不弹任何窗口）
# 用法: powershell -File tools\install-tunnel-task.ps1
$ErrorActionPreference = 'Continue'
$MC  = Split-Path -Parent $PSScriptRoot
$ps1 = Join-Path $MC 'tools\run-tunnel.ps1'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$action = New-ScheduledTaskAction -Execute $psExe `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ps1 + '"')

$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn),
  (New-ScheduledTaskTrigger -AtStartup)
)

$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'mc-tunnel' -Action $action -Trigger $triggers -Settings $settings `
  -Description 'cloudflared 隧道（手机远控后台服务，隐藏运行）' -Force | Out-Null

Start-ScheduledTask -TaskName 'mc-tunnel'
Write-Output '已注册并启动 mc-tunnel（隐藏）'
