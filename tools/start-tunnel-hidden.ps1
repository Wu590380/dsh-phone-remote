# start-tunnel-hidden.ps1 —— 无窗口启动 cloudflared 隧道（稳定版）
# 做法：WMI 直起（进程不随调用者退出而消失）+ 起完把它的控制台窗口隐藏
# 关键：加 --logfile，否则 console 宿主一收走进程就退
param([switch]$NoHide)

$ErrorActionPreference = 'Continue'
$MC  = Split-Path -Parent $PSScriptRoot
$CF  = Join-Path $env:USERPROFILE '.dsh\dsh-pocket\bin\cloudflared.exe'
$CFG = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
$LF  = Join-Path $MC '_cf.log'

if (-not (Test-Path $CF))  { Write-Output 'FAIL 缺少 cloudflared'; exit 1 }
if (-not (Test-Path $CFG)) { Write-Output 'FAIL 缺少隧道配置'; exit 1 }

$sig = @'
using System;
using System.Runtime.InteropServices;
public class WinHide {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
}
'@
try { Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue | Out-Null } catch { }

$line = '"' + $CF + '" --logfile "' + $LF + '" --loglevel info tunnel --protocol http2 --config "' + $CFG + '" run'
$cim = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line; CurrentDirectory = $MC }
if ($cim.ReturnValue -ne 0) { Write-Output ('FAIL 启动返回码 ' + $cim.ReturnValue); exit 1 }
Write-Output ('STARTED pid=' + $cim.ProcessId)

if (-not $NoHide) {
  # 它的控制台窗口由 conhost 持有：找最近出现的、标题含 cloudflared 的窗口并隐藏
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 300
    $win = Get-Process -ErrorAction SilentlyContinue |
           Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'cloudflared' } |
           Select-Object -First 1
    if ($win) {
      [WinHide]::ShowWindow($win.MainWindowHandle, 0) | Out-Null
      Write-Output ('HIDDEN pid=' + $win.Id + ' title=' + $win.MainWindowTitle)
      break
    }
  }
}
exit 0
