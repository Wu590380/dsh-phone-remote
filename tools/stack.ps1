<#
  stack.ps1 —— 手机远控服务：体检 / 拉起 / 自愈
  用法：
    powershell -File tools\stack.ps1 -Status   只看状态
    powershell -File tools\stack.ps1 -Up       缺什么补什么（幂等）
  依赖：桌面 App(19387，需手动开着) → agent(19390/19391) → dispatcher(19392, agent 自动拉) → MCP(19395) → cloudflared 隧道
  注意：服务必须用 WMI 脱离父进程启动，否则调用者一退出就会被连带杀掉。
#>
param([switch]$Up, [switch]$Status)

$ErrorActionPreference = 'Continue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$MC  = Split-Path -Parent $here
$LOG = Join-Path $MC 'stack.log'

function Log($msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'MM-dd HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path $LOG -Value $line -Encoding UTF8
}

function PortUp($p) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
}

function Start-Detached([string]$cmdFile) {
  $cim = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = ('cmd.exe /c "' + $cmdFile + '"')
    CurrentDirectory = $MC
  }
  if ($cim.ReturnValue -eq 0) { Log ('  已脱离启动 ' + (Split-Path $cmdFile -Leaf) + ' (PID ' + $cim.ProcessId + ')') }
  else { Log ('  启动失败 ' + (Split-Path $cmdFile -Leaf) + ' 返回码 ' + $cim.ReturnValue) }
}

function Ensure-Agent {
  if (PortUp 19390) { return $true }
  Start-Detached (Join-Path $MC 'tools\run-agent.cmd')
  return $false
}

function Ensure-Mcp {
  if (PortUp 19395) { return $true }
  Start-Detached (Join-Path $MC 'tools\run-mcp.cmd')
  return $false
}

function Ensure-Tunnel {
  if ((Get-Process cloudflared -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) { return $true }
  $cmd = Join-Path $MC 'tools\run-tunnel.cmd'
  if (-not (Test-Path $cmd)) { Log ('缺少 ' + $cmd); return $false }
  Start-Detached $cmd
  return $false
}

function Report {
  $items = [ordered]@{
    'agent 面板 19390' = (PortUp 19390)
    'agent 转发 19391' = (PortUp 19391)
    '派活台   19392'   = (PortUp 19392)
    'MCP     19395'   = (PortUp 19395)
    '桌面 App 19387'   = (PortUp 19387)
    'shotd 采集'       = [bool](Get-Process shotd -ErrorAction SilentlyContinue)
    'cloudflared 隧道' = ((Get-Process cloudflared -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
  }
  foreach ($k in $items.Keys) { Log ('  ' + $k.PadRight(18) + ' ' + $(if ($items[$k]) { 'OK' } else { 'DOWN' })) }

  $mt = (Get-Content (Join-Path $MC 'mcp-token.txt') -Raw).Trim()
  $pt = (Get-Content (Join-Path $MC 'token.txt') -Raw).Trim()
  $bf = Join-Path $MC '_stack_probe.json'
  [System.IO.File]::WriteAllText($bf, '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sessions","arguments":{}}}', (New-Object System.Text.UTF8Encoding($false)))
  $mcpCode = & curl.exe -s -o NUL -w '%{http_code}' -m 25 -H "Authorization: Bearer $mt" -H 'Content-Type: application/json' --data-binary "@$bf" 'https://mcp.mywebopen.ltd/mcp' 2>$null
  $panCode = & curl.exe -s -o NUL -w '%{http_code}' -m 20 "https://panel.mywebopen.ltd/api/status?t=$pt" 2>$null
  Remove-Item $bf -Force -ErrorAction SilentlyContinue
  Log ('  公网 mcp.mywebopen.ltd    HTTP ' + $mcpCode)
  Log ('  公网 panel.mywebopen.ltd  HTTP ' + $panCode)
  $ok = ($mcpCode -eq '200') -and ($panCode -eq '200')
  Log ('结论: ' + $(if ($ok) { '全部正常，手机可以连' } else { '有异常（见上）' }))
  return $ok
}

if ($Status -and -not $Up) { [void](Report); exit 0 }

if (-not (Ensure-Agent)) { }
Start-Sleep -Seconds 5
[void](Ensure-Mcp)
[void](Ensure-Tunnel)
Start-Sleep -Seconds 8
if (-not (Get-Process shotd -ErrorAction SilentlyContinue) -and (PortUp 19390)) {
  # agent 正常情况下会自己拉起 shotd；这里只是兜底
  Start-Detached (Join-Path $MC 'tools\run-shotd.cmd')
}
Start-Sleep -Seconds 4

if (Report) { exit 0 } else { exit 1 }
