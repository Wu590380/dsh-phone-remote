# 手机远程控制台 —— 一键启动
#   1) 生成/复用访问令牌  2) 放行防火墙端口  3) 启动只监听回环的 dsh 网页实例
#   4) 启动 agent（实时屏幕 + 输入注入 + 命令下发 + 转发 dsh 网页）5) 打印手机访问地址
param(
  [int]$Port = 19390,          # 手机控制面板端口
  [int]$RelayPort = 19391,     # dsh 网页转发端口
  [int]$DshWebPort = 19400,    # 独立 dsh 网页实例端口（仅回环）
  [switch]$NoDshWeb            # 只启动控制面板，不启动 dsh 网页
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$TokenFile = Join-Path $Root 'token.txt'
$LogFile = Join-Path $Root 'agent.out.log'
$ErrFile = Join-Path $Root 'agent.err.log'

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host '未以管理员运行：无法添加防火墙规则，个别网络位置下手机可能连不上。' -ForegroundColor Yellow
  Write-Host '要保证手机一定能连：右键 start.cmd → 以管理员身份运行。' -ForegroundColor Yellow
  Write-Host '继续以普通权限启动服务…' -ForegroundColor DarkGray
}

# 1) 令牌
if (Test-Path $TokenFile) {
  $Token = (Get-Content $TokenFile -Raw).Trim()
} else {
  $bytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $Token = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
  Set-Content -Path $TokenFile -Value $Token -Encoding ASCII
}
if (-not $Token) { $Token = 'mobile' }

# 2) 防火墙（幂等，三种网络位置都放行；无管理员权限时跳过）
if (Test-Admin) {
  $prefix = 'MobileControlPanel'
  foreach ($p in @($Port, $RelayPort)) {
    $name = "$prefix-$p"
    $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if (-not $rule) {
      New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort $p -Profile Any -ErrorAction SilentlyContinue | Out-Null
      Write-Host "已放行 TCP $p (全部网络位置)" -ForegroundColor Green
    } elseif ("$($rule.Profile)" -ne 'Any') {
      Set-NetFirewallRule -DisplayName $name -Profile Any -ErrorAction SilentlyContinue | Out-Null
      Write-Host "已把规则 $name 扩展到全部网络位置" -ForegroundColor Green
    } else {
      Write-Host "防火墙规则 $name 已存在" -ForegroundColor DarkGray
    }
  }
}

# 3) 独立 dsh 网页实例（仅回环）
if (-not $NoDshWeb) {
  & (Join-Path $Root 'start-dsh-web.ps1') -Port $DshWebPort -Quiet
  if ($LASTEXITCODE -ne 0) { Write-Host 'dsh 网页实例未就绪，手机仍然可以用控制面板看屏幕/下命令。' -ForegroundColor Yellow }
}

# 4) 结束旧 agent
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*mobile-control\agent.js*' } |
  ForEach-Object {
    Write-Host "结束旧 agent (PID $($_.ProcessId))" -ForegroundColor DarkGray
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

# 5) 启动 agent
#    注意：清掉本会话可能残留的 DSH_HOME，避免影响 desktop 版 dsh
Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
$env:MC_TOKEN = $Token
$env:MC_PORT = "$Port"
$env:MC_RELAY_PORT = "$RelayPort"
# 转发目标 = 桌面 App 自己的服务（19387），agent 会自动附加签发好的会话 cookie，
# 这样手机端看到的会话与电脑完全一致（含 0.2.x 的 v4 会话）。
$env:MC_RELAY_TARGET = '19387'
$env:MC_RELAY_MINT_FROM = "$env:USERPROFILE\.dsh"
$relayTokenFile = Join-Path $Root 'dsh-web-token.txt'
if (Test-Path $relayTokenFile) { $env:MC_RELAY_TOKEN = (Get-Content $relayTokenFile -Raw).Trim() }
$env:MC_WORKDIR = (Split-Path -Parent $Root)
$env:MC_SHOT_WIDTH = '1100'
$env:MC_SHOT_QUALITY = '60'
$env:MC_FPS_MS = '500'

Start-Process -FilePath 'node.exe' -ArgumentList @((Join-Path $Root 'agent.js')) `
  -WorkingDirectory $Root -WindowStyle Hidden `
  -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile

Start-Sleep -Seconds 3
if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
  Write-Host '控制面板未能启动，最近日志：' -ForegroundColor Red
  Get-Content $LogFile -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue
  Get-Content $ErrFile -Tail 20 -Encoding UTF8 -ErrorAction SilentlyContinue
  exit 1
}

# 6) 打印地址
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -Unique IPAddress, InterfaceAlias

Write-Host ''
Write-Host '================ 手机远程控制台 ================' -ForegroundColor Cyan
Write-Host "访问令牌: $Token" -ForegroundColor Yellow
foreach ($i in $ips) {
  Write-Host ("控制面板:  http://{0}:{1}/?t={2}" -f $i.IPAddress, $Port, $Token) -ForegroundColor White
  Write-Host ("   [{0}]" -f $i.InterfaceAlias) -ForegroundColor DarkGray
}
if (-not $NoDshWeb) {
  Write-Host ''
  Write-Host "dsh 完整网页（转发到 127.0.0.1:$DshWebPort）:" -ForegroundColor White
  foreach ($i in $ips) { Write-Host ("  http://{0}:{1}/" -f $i.IPAddress, $RelayPort) }
}
Write-Host ''
Write-Host '停止服务: 运行 stop.cmd' -ForegroundColor DarkGray
Write-Host '===============================================' -ForegroundColor Cyan
Write-Host ''
Write-Host '建议：手机连同一 WiFi，或先把两端接入同一个 Radmin VPN 网络。' -ForegroundColor DarkGray
