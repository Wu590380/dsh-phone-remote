# install-logon-run.ps1 —— 登录自启（免管理员）：HKCU Run 里放一条 conhost --headless 的命令
# 效果：登录后立刻把手机远控全套后台无窗口拉起；不开黑窗口、不需要管理员
$ErrorActionPreference = 'Continue'
$MC    = Split-Path -Parent $PSScriptRoot
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$stack = Join-Path $MC 'tools\stack.ps1'

$cmd = 'conhost.exe --headless "' + $psExe + '" -NoProfile -ExecutionPolicy Bypass -File "' + $stack + '" -Up'
Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'mc-stack-logon' -Value $cmd
Write-Output ('已写入 Run 自启: mc-stack-logon')
Write-Output ('  命令: ' + $cmd)

# 验证：立刻按同样方式跑一次（确认能无窗口拉起）
$cim = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $MC }
Write-Output ('  立即试跑返回码: ' + $cim.ReturnValue + '  PID ' + $cim.ProcessId)
