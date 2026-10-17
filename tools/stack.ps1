<#
  stack.ps1 —— 手机远控服务：体检 / 拉起 / 自愈
  用法：
    powershell -File tools\stack.ps1 -Status   只看状态
    powershell -File tools\stack.ps1 -Up       缺什么补什么（幂等；**要求 dsh 已打开**）
    powershell -File tools\stack.ps1 -Up -Force  不管 dsh 在不在，强制拉起（手动排障用）
  依赖：桌面 App(19387，需你自己打开) → agent(19390/19391) → dispatcher(19392, agent 自动拉) → MCP(19395) → cloudflared 隧道
  策略：**只有 dsh 在跑时才拉起后台**（不开机自启）。dsh 关着时这个脚本只体检、不动手。
  注意：服务必须用 WMI 脱离父进程启动，否则调用者一退出就会被连带杀掉。
#>
param(
  [switch]$Up,
  [switch]$Status,
  [switch]$Force,
  [string]$RequireDsh = 'DeepSeek Harness',
  [switch]$IgnorePort   # 测试用：只看进程名，不看 19387 端口
)

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

function Start-Detached([string]$scriptFile) {
  # conhost --headless + powershell -File：Win11 的无窗口控制台，配合 WMI 脱离父进程
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $line  = 'conhost.exe --headless "' + $psExe + '" -NoProfile -ExecutionPolicy Bypass -File "' + $scriptFile + '"'
  $cim = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = $line
    CurrentDirectory = $MC
  }
  if ($cim.ReturnValue -eq 0) { Log ('  已无窗口启动 ' + (Split-Path $scriptFile -Leaf) + ' (PID ' + $cim.ProcessId + ')') }
  else { Log ('  启动失败 ' + (Split-Path $scriptFile -Leaf) + ' 返回码 ' + $cim.ReturnValue) }
}



function Ensure-Agent {
  if (PortUp 19390) { return $true }
  Start-Detached (Join-Path $MC 'tools\run-agent.ps1')
  return $false
}

function Ensure-Mcp {
  if (PortUp 19395) { return $true }
  Start-Detached (Join-Path $MC 'tools\run-mcp.ps1')
  return $false
}



function Ensure-Tunnel {
  if ((Get-Process cloudflared -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) { return $true }
  $cf  = Join-Path $env:USERPROFILE '.dsh\dsh-pocket\bin\cloudflared.exe'
  $cfg = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
  if (-not (Test-Path $cf))  { Log ('缺少 cloudflared: ' + $cf); return $false }
  if (-not (Test-Path $cfg)) { Log ('缺少隧道配置: ' + $cfg); return $false }
  $line = 'conhost.exe --headless "' + $cf + '" tunnel --protocol http2 --config "' + $cfg + '" run'
  $cim = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = $MC }
  if ($cim.ReturnValue -eq 0) { Log ('  已无窗口启动 隧道 (PID ' + $cim.ProcessId + ')') }
  else { Log ('  隧道启动失败 返回码 ' + $cim.ReturnValue) }
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

# 关键策略：只有 dsh 在跑时才拉起后台（按用户要求，不做开机自启）
function DshRunning {
  $p = Get-Process -Name $RequireDsh -ErrorAction SilentlyContinue
  if ($p) { return $true }
  if (-not $IgnorePort) { return (PortUp 19387) }
  return $false
}

if (-not $Force -and -not (DshRunning)) {
  Log ('dsh 未运行（未检测到 "' + $RequireDsh + '" 且 19387 未监听）→ 本次不启动后台。打开 dsh 后 2 分钟内会自动拉起。')
  exit 0
}
if ($Force) { Log '强制模式：忽略 dsh 是否运行' }

if (-not (Ensure-Agent)) { }
Start-Sleep -Seconds 5
[void](Ensure-Mcp)
[void](Ensure-Tunnel)
Start-Sleep -Seconds 8
if (-not (Get-Process shotd -ErrorAction SilentlyContinue) -and (PortUp 19390)) {
  # agent 正常情况下会自己拉起 shotd；这里只是兜底
  Start-Detached (Join-Path $MC 'tools\run-shotd.ps1')
}
Start-Sleep -Seconds 4

if (Report) { exit 0 } else { exit 1 }
