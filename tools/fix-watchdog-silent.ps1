# fix-watchdog-silent.ps1 —— 把自愈任务改成 conhost --headless 方式（彻底不创建控制台窗口）
$ErrorActionPreference = 'Continue'
$MC    = Split-Path -Parent $PSScriptRoot
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$stack = Join-Path $MC 'tools\stack.ps1'

# conhost --headless：Win11 的无窗口控制台宿主，进程从头到尾没有窗口
$tr = 'conhost.exe --headless "' + $psExe + '" -NoProfile -ExecutionPolicy Bypass -File "' + $stack + '" -Up'

& schtasks /delete /tn mc-stack-watchdog /f 2>&1 | Out-Null
$out = & schtasks /create /tn mc-stack-watchdog /tr $tr /sc minute /mo 2 /st 00:00 /f /rl limited 2>&1
Write-Output ('重建任务: ' + ($out -join ' '))

# 顺便把登录自启也统一成同一条命令（已经是 conhost --headless，这里做幂等校验）
$cur = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).'mc-stack-logon'
if ($cur -notlike 'conhost.exe*') {
  Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'mc-stack-logon' -Value $tr
  Write-Output '已同步 Run 自启为 conhost --headless'
} else {
  Write-Output 'Run 自启已是 conhost --headless，无需改'
}

Write-Output ('任务命令: ' + $tr)
& schtasks /run /tn mc-stack-watchdog 2>&1 | ForEach-Object { Write-Output ('立即触发: ' + $_) }
