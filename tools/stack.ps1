<#
  stack.ps1 —— 手机远控后台：体检 / 拉起 / 自愈
  用法：
    powershell -File tools\stack.ps1 -Status      只看状态
    powershell -File tools\stack.ps1 -Up          缺什么补什么（要求 dsh 已打开）
    powershell -File tools\stack.ps1 -Up -Force   无视 dsh 强制拉起
  组成：桌面 App(19387, 你手动打开) → agent(19390/19391) → dispatcher(19392, agent 自动拉) → MCP(19395) → 隧道(node 看护托管)
  原则：① 只有 dsh 在跑时才动手（不做开机自启） ② 全部无窗口 ③ 服务用 WMI 脱离父进程启动
#>
param(
  [switch]$Up,
  [switch]$Status,
  [switch]$Force,
  [string]$RequireDsh = 'DeepSeek Harness',
  [switch]$IgnorePort
)

$ErrorActionPreference = 'Continue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$MC  = Split-Path -Parent $here
$LOG = Join-Path $MC 'stack.log'
$PSX = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

function Log($msg) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'MM-dd HH:mm:ss'), $msg
  Write-Host $line
  try { Add-Content -Path $LOG -Value $line -Encoding UTF8 } catch { }
}

function PortUp($p) {
  return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
}

function DshRunning {
  if (Get-Process -Name $RequireDsh -ErrorAction SilentlyContinue) { return $true }
  if (-not $IgnorePort) { return (PortUp 19387) }
  return $false
}

# 用 WMI 创建进程：脱离调用者的 job；父进程退出也不会带走它
function Start-Detached([string]$CommandLine) {
  $cim = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine      = $CommandLine
    CurrentDirectory = $MC
  }
  if ($cim.ReturnValue -eq 0) { return [int]$cim.ProcessId }
  Log ('  启动失败 返回码 ' + $cim.ReturnValue)
  return 0
}

# node / cloudflared 是 console 程序，启动会带出一个终端窗口；隐藏它（进程本身不受影响）
function Hide-ConsoleWindows {
  $sig = @"
using System;
using System.Runtime.InteropServices;
public class McHideWin { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c); }
"@
  try { Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue | Out-Null } catch { }
  for ($i = 0; $i -lt 14; $i++) {
    $wins = Get-Process -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'node\.exe|tunnel-supervisor|cloudflared' }
    if ($wins) {
      foreach ($w in $wins) {
        [McHideWin]::ShowWindow($w.MainWindowHandle, 0) | Out-Null
        Log ('  已隐藏窗口: ' + $w.ProcessName + ' 「' + $w.MainWindowTitle + '」')
      }
      return
    }
    Start-Sleep -Milliseconds 350
  }
}

function Ensure-Agent {
  if (PortUp 19390) { return $true }
  $p1 = Start-Detached ('"' + $PSX + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $MC 'tools\run-agent.ps1') + '"')
  if ($p1) { Log ('  已启动 agent (PID ' + $p1 + ')') }
  return $false
}

function Ensure-Mcp {
  if (PortUp 19395) { return $true }
  $p1 = Start-Detached ('"' + $PSX + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $MC 'tools\run-mcp.ps1') + '"')
  if ($p1) { Log ('  已启动 MCP (PID ' + $p1 + ')') }
  return $false
}

function Ensure-Tunnel {
  # 隧道由 node 看护（tools/tunnel-supervisor.js）托管：被关掉/杀掉 2 秒内自愈
  $sup = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -like '*tunnel-supervisor*' }
  if ($sup) { return $true }
  $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) { Log '缺少 node，无法启动隧道看护'; return $false }
  $p1 = Start-Detached ('"' + $nodeExe + '" "' + (Join-Path $MC 'tools\tunnel-supervisor.js') + '"')
  if ($p1) { Log ('  已启动隧道看护 (PID ' + $p1 + ')') }
  Start-Sleep -Seconds 6
  Hide-ConsoleWindows
  return $false
}

function Ensure-Shotd {
  if (Get-Process shotd -ErrorAction SilentlyContinue) { return $true }
  if (-not (PortUp 19390)) { return $false }
  $p1 = Start-Detached ('"' + $PSX + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $MC 'tools\run-shotd.ps1') + '"')
  if ($p1) { Log ('  已补拉起 shotd (PID ' + $p1 + ')') }
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
    '隧道看护 node'    = [bool](Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
                                Where-Object { $_.CommandLine -like '*tunnel-supervisor*' })
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

  $wins = (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'node\.exe|cloudflared|run-tunnel|tunnel-supervisor' }).Count
  Log ('  相关控制台窗口数 ' + $wins + $(if ($wins -eq 0) { '（干净）' } else { '（应隐藏）' }))

  $ok = ($mcpCode -eq '200') -and ($panCode -eq '200')
  Log ('结论: ' + $(if ($ok) { '全部正常，手机可以连' } else { '有异常（见上）' }))
  return $ok
}

if ($Status -and -not $Up) { [void](Report); exit 0 }

if (-not $Force -and -not (DshRunning)) {
  Log ('dsh 未运行（未检测到 "' + $RequireDsh + '" 且 19387 未监听）→ 本次不动手。打开 dsh 后再跑，或加 -Force。')
  exit 0
}
if ($Force) { Log '强制模式：忽略 dsh 是否运行' }

[void](Ensure-Agent)
Start-Sleep -Seconds 5
[void](Ensure-Mcp)
[void](Ensure-Tunnel)
Start-Sleep -Seconds 8
[void](Ensure-Shotd)
Start-Sleep -Seconds 4
Hide-ConsoleWindows

if (Report) { exit 0 } else { exit 1 }
