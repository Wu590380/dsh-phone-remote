# install-boot-hooks.ps1 —— 配好"开机登录即自愈"：
#   1) 删掉旧的 HKCU Run 隧道自启（它会弹一个黑窗口）
#   2) 注册两个计划任务（隐藏、无需管理员）：
#        mc-stack-logon  —— 每次登录立刻拉起全套
#        mc-stack-watchdog —— 每 2 分钟体检补齐（已存在则重建）
# 用法: powershell -File tools\install-boot-hooks.ps1
$ErrorActionPreference = 'Continue'
$MC   = Split-Path -Parent $PSScriptRoot
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$stack = Join-Path $MC 'tools\stack.ps1'
$tr    = '"' + $psExe + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $stack + '" -Up'

# 1) 清掉旧的可见窗口自启项
foreach ($name in @('cloudflared-dsh-tunnel')) {
  $v = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue).$name
  if ($v) {
    Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $name -ErrorAction SilentlyContinue
    Write-Output ('已删除 Run 自启项: ' + $name)
  }
}

# 2) 登录触发 + 每 2 分钟自愈
function Setup-Task($name, $schedule, $desc) {
  & schtasks /delete /tn $name /f 2>&1 | Out-Null
  $args = @('/create', '/tn', $name, '/tr', $tr, '/sc', $schedule, '/f', '/rl', 'limited')
  if ($schedule -eq 'minute') { $args += @('/mo', '2', '/st', '00:00') }
  $out = & schtasks @args 2>&1
  Write-Output ($name + ': ' + ($out -join ' '))
  & schtasks /change /tn $name /it 2>&1 | Out-Null   # 允许交互式运行（登录会话内）
  & schtasks /query /tn $name /fo LIST 2>&1 | Select-String -Pattern 'TaskName|Status|Next Run' | ForEach-Object { '    ' + $_.Line.Trim() }
}

Setup-Task 'mc-stack-logon'    'onlogon' '登录即拉起手机远控全套后台'
Setup-Task 'mc-stack-watchdog' 'minute'  '每 2 分钟体检并补齐手机远控后台'

# 3) 立刻跑一次
& schtasks /run /tn 'mc-stack-logon' 2>&1 | ForEach-Object { Write-Output ('触发 mc-stack-logon: ' + $_) }
