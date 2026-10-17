# set-watchdog.ps1 —— 重建自愈计划任务（每 1 分钟，conhost --headless 无窗口）
$ErrorActionPreference = 'Continue'
$MC    = Split-Path -Parent $PSScriptRoot
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$stack = Join-Path $MC 'tools\stack.ps1'
$tr    = 'conhost.exe --headless "' + $psExe + '" -NoProfile -ExecutionPolicy Bypass -File "' + $stack + '" -Up'

& schtasks.exe /delete /tn mc-stack-watchdog /f 2>&1 | Out-Null

$createArgs = @(
  '/create', '/tn', 'mc-stack-watchdog',
  '/tr', $tr,
  '/sc', 'minute', '/mo', '1', '/st', '00:00',
  '/f', '/rl', 'limited'
)
$out = & schtasks.exe @createArgs 2>&1
Write-Output ('创建结果: ' + ($out -join ' '))

$q = & schtasks.exe /query /tn mc-stack-watchdog /fo LIST /v 2>&1
$q | Select-String -Pattern 'TaskName|Status|Next Run Time|Task To Run|要运行的任务|下次运行时间|状态' | ForEach-Object {
  Write-Output ('  ' + $_.Line.Trim())
}
