<#
  stack.ps1 —— 手机远控这套服务的"拉起 / 体检 / 自愈"
  用法：
    powershell -File tools\stack.ps1 -Up        # 缺什么补什么（幂等），并体检
    powershell -File tools\stack.ps1 -Status    # 只看状态
  依赖顺序：桌面 App(19387, 你手动开的) → agent(19390/19391) → dispatcher(19392, agent 自动拉) → MCP(19395) → cloudflared 隧道
#>
param(
  [switch]$Up,
  [switch]$Status
)

$ErrorActionPreference = 'Continue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$MC = Split-Path -Parent $here
$LOG = Join-Path $MC 'stack.log'
$CF = Join-Path $env:USERPROFILE '.dsh\dsh-pocket\bin\cloudflared.exe'
$Cfg = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
$NODE = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NODE) { $NODE = 'node' }

function Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $msg
  Write-Output $line
  Add-Content -Path $LOG -Value $line -Encoding UTF8
}

function PortUp($p) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
}

function Ensure-Agent {
  if (PortUp 19390) { return $true }
  $tok = (Get-Content (Join-Path $MC 'token.txt') -Raw).Trim()
  $dshTok = ''
  $p = Join-Path $MC 'dsh-web-token.txt'
  if (Test-Path $p) { $dshTok = (Get-Content $p -Raw).Trim() }
  $env:MC_TOKEN = $tok
  $env:MC_RELAY_TARGET = '19387'
  if ($dshTok) { $env:MC_RELAY_TOKEN = $dshTok }
  $env:MC_RELAY_MINT_FROM = (Join-Path $env:USERPROFILE '.dsh')
  $env:MC_SHOT_WIDTH = '1000'
  $env:MC_SHOT_QUALITY = '55'
  Remove-Item Env:MC_RELAY_DEBUG -ErrorAction SilentlyContinue
  Start-Process -FilePath $NODE -ArgumentList (Join-Path $MC 'agent.js') -WorkingDirectory $MC -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $MC 'agent.out.log') -RedirectStandardError (Join-Path $MC 'agent.err.log')
  Log '已拉起 agent.js（19390/19391）'
  return $false
}

function Ensure-Mcp {
  if (PortUp 19395) { return $true }
  $mt = (Get-Content (Join-Path $MC 'mcp-token.txt') -Raw).Trim()
  $env:MC_MCP_TOKEN = $mt
  Start-Process -FilePath $NODE -ArgumentList (Join-Path $MC 'mcp\pc-mcp-server.js') -WorkingDirectory (Join-Path $MC 'mcp') -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $MC 'mcp\mcp.out.log') -RedirectStandardError (Join-Path $MC 'mcp\mcp.err.log')
  Log '已拉起 MCP（19395）'
  return $false
}

function Ensure-Tunnel {
  $n = (Get-Process cloudflared -ErrorAction SilentlyContinue | Measure-Object).Count
  if ($n -gt 0) { return $true }
  if (-not (Test-Path $CF)) { Log ('缺少 cloudflared: ' + $CF); return $false }
  if (-not (Test-Path $Cfg)) { Log ('缺少隧道配置: ' + $Cfg); return $false }
  Start-Process -FilePath $CF -ArgumentList @('tunnel', '--protocol', 'http2', '--config', $Cfg, 'run') -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $MC '_tunnel.out.log') -RedirectStandardError (Join-Path $MC '_tunnel.err.log')
  Log '已拉起 cloudflared 隧道'
  return $false
}

function Ensure-Shotd {
  if (Get-Process shotd -ErrorAction SilentlyContinue) { return $true }
  $exe = Join-Path $MC 'shotd.exe'
  if (-not (Test-Path $exe)) { Log '缺少 shotd.exe'; return $false }
  # agent 起来后通常会自动拉起 shotd；这里只在 agent 已在跑却仍没有 shotd 时补
  if (PortUp 19390) {
    Start-Process -FilePath $exe -ArgumentList @('--listen', '0', '--width', '1000', '--quality', '55') -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $MC '_shotd.out.log') -RedirectStandardError (Join-Path $MC '_shotd.err.log')
    Log '已补拉起 shotd'
  }
  return $false
}

function Report {
  $rows = @(
    @{ n = 'agent 面板 19390'; ok = (PortUp 19390) },
    @{ n = 'agent 转发 19391'; ok = (PortUp 19391) },
    @{ n = '派活台   19392'; ok = (PortUp 19392) },
    @{ n = 'MCP     19395'; ok = (PortUp 19395) },
    @{ n = '桌面 App 19387'; ok = (PortUp 19387) },
    @{ n = 'shotd 采集'; ok = [bool](Get-Process shotd -ErrorAction SilentlyContinue) },
    @{ n = 'cloudflared 隧道'; ok = ((Get-Process cloudflared -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) }
  )
  foreach ($r in $rows) { Log ("  {0,-18} {1}" -f $r.n, $(if ($r.ok) { 'OK' } else { 'DOWN' })) }

  # 公网体检（手机走的就是这两条）
  $mt = (Get-Content (Join-Path $MC 'mcp-token.txt') -Raw).Trim()
  $pt = (Get-Content (Join-Path $MC 'token.txt') -Raw).Trim()
  $body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sessions","arguments":{}}}'
  $bf = Join-Path $MC '_stack_probe.json'
  [System.IO.File]::WriteAllText($bf, $body, (New-Object System.Text.UTF8Encoding($false)))
  $mcpCode = & curl.exe -s -o NUL -w '%{http_code}' -m 25 -H "Authorization: Bearer $mt" -H 'Content-Type: application/json' --data-binary "@$bf" 'https://mcp.mywebopen.ltd/mcp' 2>$null
  $panCode = & curl.exe -s -o NUL -w '%{http_code}' -m 20 "https://panel.mywebopen.ltd/api/status?t=$pt" 2>$null
  Remove-Item $bf -Force -ErrorAction SilentlyContinue
  Log ("  公网 mcp.mywebopen.ltd   HTTP " + $mcpCode)
  Log ("  公网 panel.mywebopen.ltd HTTP " + $panCode)
  $allOk = ($mcpCode -eq '200') -and ($panCode -eq '200')
  Log $(if ($allOk) { '结论: 全部正常，手机可以连' } else { '结论: 有异常（见上）' })
  return $allOk
}

if ($Status -and -not $Up) { Report | Out-Null; exit 0 }

# -Up：缺什么补什么（两轮，给依赖留时间）
$changed = $false
if (-not (Ensure-Agent)) { $changed = $true }
Start-Sleep -Seconds 5
if (-not (Ensure-Mcp)) { $changed = $true }
if (-not (Ensure-Tunnel)) { $changed = $true }
Start-Sleep -Seconds 6
Ensure-Shotd | Out-Null
Start-Sleep -Seconds 4

$ok = Report
if ($ok) { exit 0 } else { exit 1 }
