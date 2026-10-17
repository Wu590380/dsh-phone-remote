# watch-windows.ps1 —— 盯一段时间，看有没有控制台窗口冒出来
param([int]$Seconds = 180, [int]$IntervalMs = 4000)
$seen = @{}
$end = (Get-Date).AddSeconds($Seconds)
Write-Host ("开始监控 " + $Seconds + " 秒…")
while ((Get-Date) -lt $end) {
  $w = Get-Process | Where-Object { $_.MainWindowTitle -match 'cmd|powershell|conhost|run-tunnel|cloudflared' }
  foreach ($x in $w) {
    $key = [string]$x.Id
    if (-not $seen.ContainsKey($key)) {
      $seen[$key] = $x.MainWindowTitle
      Write-Host ("  [" + (Get-Date -Format 'HH:mm:ss') + "] 出现窗口 PID " + $x.Id + " " + $x.ProcessName + " 「" + $x.MainWindowTitle + "」")
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
if ($seen.Count -eq 0) { Write-Host "结果: 全程没有出现任何控制台窗口 ✅" }
else { Write-Host ("结果: 共出现 " + $seen.Count + " 次窗口 ⚠️") }
