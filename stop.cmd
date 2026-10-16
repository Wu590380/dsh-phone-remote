@echo off
chcp 65001 >nul
echo 正在停止 dsh 手机派活台（含公网隧道）…
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*mobile-control\agent.js*' -or $_.CommandLine -like '*mobile-control\tasks\dispatcher.js*' -or $_.CommandLine -like '*mobile-control\mcp\pc-mcp-server.js*' -or $_.CommandLine -like '*dsh-pocket*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; 'stopped node PID ' + $_.ProcessId }"
powershell -NoProfile -Command "Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force; 'stopped cloudflared PID ' + $_.Id }"
powershell -NoProfile -Command "foreach ($port in 3080,3081,19390,19391,19392,19395) { $c = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue; if ($c) { Stop-Process -Id $c[0].OwningProcess -Force -ErrorAction SilentlyContinue; 'stopped port ' + $port + ' PID ' + $c[0].OwningProcess } }"
echo 完成。
pause
