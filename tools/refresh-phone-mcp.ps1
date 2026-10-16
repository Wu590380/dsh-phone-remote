# 刷新手机 dsh 的 MCP 公网地址（快速隧道重启后地址会变，跑这个就行）
#   用法: powershell -ExecutionPolicy Bypass -File tools\refresh-phone-mcp.ps1 [-NewTunnel]
param(
  [switch]$NewTunnel,             # 强制新建隧道（默认复用记录里的地址，先验证再决定是否新建）
  [string]$Phone = ''             # 手机无线 adb 地址；留空则自动从 adb devices 里挑
)
$ErrorActionPreference = 'Continue'
$Mc = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$UrlFile = Join-Path $Mc 'mcp-public-url.txt'
$TokFile = Join-Path $Mc 'mcp-token.txt'
$Adb = 'D:\Program Files\Netease\MuMu\nx_main\adb.exe'
if (-not (Test-Path $Adb)) { $Adb = 'adb' }

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

# ---------- 1. 令牌 ----------
if (-not (Test-Path $TokFile)) { Say "缺少 $TokFile（MCP 专用令牌）" 'Red'; exit 1 }
$token = (Get-Content $TokFile -Raw).Trim()

# ---------- 2. 地址：复用并验证，必要时新建隧道 ----------
function Test-McpUrl($u) {
  if (-not $u) { return $false }
  try {
    $r = Invoke-WebRequest ($u -replace '/mcp$', '/health') -UseBasicParsing -TimeoutSec 12
    return $r.StatusCode -eq 200
  } catch { return $false }
}

$url = if (Test-Path $UrlFile) { (Get-Content $UrlFile -Raw).Trim() } else { '' }
$isFixedDomain = ($url -ne '') -and ($url -notmatch 'trycloudflare\.com')

if ((Test-McpUrl $url) -and -not $NewTunnel) {
  Say "复用现有 MCP 公网地址: $url" 'Green'
} elseif ($isFixedDomain -and -not $NewTunnel) {
  # 固定域名（命名隧道）绝不轻易丢弃：一次验证失败多半是 DNS 还没生效或隧道刚重启
  Say "⚠️ 固定域名暂时验证失败，保持不变（不新建临时隧道）: $url" 'Yellow'
  Say '   若是命名隧道没跑，先跑 tools\_start-named-tunnel.ps1 再重试。' 'DarkGray'
} else {
  Say '正在新建 cloudflared 快速隧道（指向 127.0.0.1:19395）…'
  $cf = 'C:\Users\your-user\.dsh\dsh-pocket\bin\cloudflared.exe'
  if (-not (Test-Path $cf)) { $cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
  $out = Join-Path $Mc '_mcptunnel.err.log'
  Remove-Item $out -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $cf -ArgumentList @('--no-autoupdate', 'tunnel', '--url', 'http://127.0.0.1:19395') -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Mc '_mcptunnel.out.log') -RedirectStandardError $out | Out-Null
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Seconds 3
    $t = Get-Content $out -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($t -match 'https://[a-z0-9-]+\.trycloudflare\.com') { break }
  }
  $t = Get-Content $out -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($t -match '(https://[a-z0-9-]+\.trycloudflare\.com)') {
    $url = $Matches[1] + '/mcp'
    $url | Set-Content $UrlFile -Encoding ASCII
    Say "新地址: $url" 'Green'
  } else {
    Say '隧道没建起来（看 _mcptunnel.err.log）' 'Red'; exit 1
  }
}

# ---------- 3. 找手机 ----------
if (-not $Phone) {
  $lines = & $Adb devices 2>&1 | Where-Object { $_ -match '\sdevice' -and $_ -notmatch 'List of devices' }
  if ($lines) {
    $wireless = $lines | Where-Object { $_ -match '^\s*([0-9.]+:\d+)\s' } | Select-Object -First 1
    $pick = if ($wireless) { $wireless } else { $lines | Select-Object -First 1 }
    if ($pick -match '^\s*(\S+)\s') { $Phone = $Matches[1] }
  }
}
if (-not $Phone) {
  Say '没找到 adb 设备（USB 或无线都行）。无线的话先执行：' 'Yellow'
  Say "  & '$Adb' connect <手机IP>:5555" 'Yellow'
  exit 1
}
Say "目标手机: $Phone" 'Green'

# ---------- 4. 生成并推送手机侧脚本 ----------
$src = Join-Path $Mc 'mcp\_set-public-url.sh'
if (-not (Test-Path $src)) { Say "缺少 $src" 'Red'; exit 1 }
$body = [System.IO.File]::ReadAllText($src, [System.Text.UTF8Encoding]::new($false))
$body = $body -replace '__URL__', $url -replace '__TOKEN__', $token -replace "`r`n", "`n"
$push = Join-Path $Mc 'mcp\_push-refresh.sh'
[System.IO.File]::WriteAllText($push, $body, [System.Text.UTF8Encoding]::new($false))
& $Adb -s $Phone push $push /sdcard/set-public-url.sh 2>&1 | Out-Null
Say '已推送到手机 /sdcard/set-public-url.sh' 'Gray'

# ---------- 5. 手机上执行（走 DSHA 的「终端」页面） ----------
function Dump($n) {
  & $Adb -s $Phone shell "uiautomator dump /sdcard/$n.xml >/dev/null 2>&1; cat /sdcard/$n.xml" > (Join-Path $Mc "_$n.xml") 2>$null
  return [xml][System.IO.File]::ReadAllText((Join-Path $Mc "_$n.xml"), [System.Text.UTF8Encoding]::new($false))
}
function TapNode($n) { if ($n -and $n.bounds -match '\[(\d+),(\d+)\]\[(\d+),(\d+)\]') { $x = [int](([int]$Matches[1] + [int]$Matches[3]) / 2); $y = [int](([int]$Matches[2] + [int]$Matches[4]) / 2); & $Adb -s $Phone shell "input tap $x $y" > $null 2>&1; return "$x,$y" } }
function TapId($doc, $id) { return (TapNode ($doc.SelectNodes("//node") | Where-Object { $_.'resource-id' -eq "com.dsh.client:id/$id" } | Select-Object -First 1)) }

& $Adb -s $Phone shell "am force-stop com.dsh.client" > $null 2>&1
Start-Sleep -Seconds 3
& $Adb -s $Phone shell "am start -n com.dsh.client/com.deepseekharness.app.MainActivity" > $null 2>&1
Start-Sleep -Seconds 6
$d = Dump 'r1'; TapId $d 'nav_terminal' | Out-Null; Start-Sleep -Seconds 3
$d = Dump 'r2'
$inp = $d.SelectNodes("//node") | Where-Object { $_.'resource-id' -eq 'com.dsh.client:id/term_input' } | Select-Object -First 1
if (-not $inp) { Say '没找到手机终端输入框：请手动打开 DSHA → 终端，执行 bash /sdcard/set-public-url.sh' 'Yellow'; exit 1 }
TapNode $inp | Out-Null; Start-Sleep -Seconds 2
& $Adb -s $Phone shell "input text 'bash%s/sdcard/set-public-url.sh'" > $null 2>&1
Start-Sleep -Seconds 1
& $Adb -s $Phone shell "input keyevent 66" > $null 2>&1
Say '已在手机上执行（等 30 秒）…'
Start-Sleep -Seconds 30
$d = Dump 'r3'
$outN = $d.SelectNodes("//node") | Where-Object { $_.'resource-id' -eq 'com.dsh.client:id/term_output' } | Select-Object -First 1
if ($outN) { Say (($outN.text -split "`n") | Select-Object -Last 10 | Out-String) }

# ---------- 6. 杀掉旧 dsh 并在 App 里启动，让新配置生效 ----------
& $Adb -s $Phone push (Join-Path $Mc 'mcp\_kill.sh') /sdcard/kill-dsh.sh 2>&1 | Out-Null
$d = Dump 'r4'
$inp = $d.SelectNodes("//node") | Where-Object { $_.'resource-id' -eq 'com.dsh.client:id/term_input' } | Select-Object -First 1
if ($inp) {
  TapNode $inp | Out-Null; Start-Sleep -Seconds 2
  & $Adb -s $Phone shell "input text 'bash%s/sdcard/kill-dsh.sh'" > $null 2>&1
  Start-Sleep -Seconds 1
  & $Adb -s $Phone shell "input keyevent 66" > $null 2>&1
  Start-Sleep -Seconds 6
}
$d = Dump 'r5'; TapId $d 'nav_launch' | Out-Null; Start-Sleep -Seconds 3
$d = Dump 'r6'; TapId $d 'launch_start' | Out-Null

Say '等 50 秒后检查电脑侧是否收到手机连接…'
Start-Sleep -Seconds 50
$log = Get-Content (Join-Path $Mc 'mcp\mcp.out.log') -Encoding UTF8 -Tail 12
Say ($log -join "`n")
if (($log -join "`n") -match 'initialize') { Say '✅ 手机 dsh 已连接（公网）' 'Green' } else { Say '⚠️ 暂未看到 initialize，可能还需再点一次「进入」' 'Yellow' }
