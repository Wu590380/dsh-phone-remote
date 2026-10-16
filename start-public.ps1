# 公网扫码模式一键启动（不需要局域网）
#   1) 起 dsh web（127.0.0.1:3080，独立 DSH_HOME=dsh-home）
#   2) 起 dsh-pocket 公网隧道（cloudflared，手机 4G/任何网络都能访问）
#   3) 起手机派活台 agent（抓屏 + 派活 + 输入注入）
#   4) 打印公网链接并生成可扫描二维码（qr-public.png）
param(
  [int]$WebPort = 3080,
  [int]$PanelPort = 19390,
  [int]$RelayPort = 19391,
  [string]$Pin = 'dsh2026go',
  [switch]$NoPanel
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$DshHome = Join-Path $Root 'dsh-home'
$DshPs1 = 'E:\node_global\dsh.ps1'
$PocketCmd = 'E:\node_global\dsh-pocket.cmd'
$CloudflaredFallback = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$PocketBin = Join-Path $env:USERPROFILE '.dsh\dsh-pocket\bin'

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

# ---------- 0. 依赖与目录 ----------
if (-not (Test-Path $DshHome)) { New-Item -ItemType Directory -Force -Path $DshHome | Out-Null }
if (-not (Test-Path $PocketCmd)) { Say "找不到 dsh-pocket（npm i -g dsh-pocket）: $PocketCmd" 'Red'; exit 1 }
if (-not (Test-Path (Join-Path $DshHome 'settings.yaml'))) {
  Say '缺少 dsh-home/settings.yaml，请先从 ~/.dsh/settings.yaml.imported 复制一份。' 'Yellow'
}
# cloudflared：插件找不到就手动放进去
if (-not (Test-Path (Join-Path $PocketBin 'cloudflared.exe'))) {
  if (Test-Path $CloudflaredFallback) {
    New-Item -ItemType Directory -Force -Path $PocketBin | Out-Null
    Copy-Item $CloudflaredFallback (Join-Path $PocketBin 'cloudflared.exe') -Force
    Say '已把系统里的 cloudflared 复制给 dsh-pocket（避免它再下载）' 'DarkGray'
  } else {
    Say '未找到 cloudflared，dsh-pocket 会尝试自行下载（Windows 走官方源，可能较慢）' 'Yellow'
  }
}

# ---------- 1. dsh web ----------
$webAlive = Get-NetTCPConnection -State Listen -LocalPort $WebPort -ErrorAction SilentlyContinue
if (-not $webAlive) {
  Say "启动 dsh web（127.0.0.1:$WebPort，DSH_HOME=$DshHome）…"
  $env:DSH_HOME = $DshHome
  try {
    Start-Process -FilePath 'powershell.exe' -WindowStyle Minimized -ArgumentList @(
      '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', $DshPs1, 'web', '--port', "$WebPort"
    ) | Out-Null
  } finally {
    Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
  }
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 750
    try { if ((Invoke-WebRequest "http://127.0.0.1:$WebPort/" -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { break } } catch {}
  }
} else {
  Say "dsh web 已在 127.0.0.1:$WebPort 运行" 'DarkGray'
}
try {
  $ok = (Invoke-WebRequest "http://127.0.0.1:$WebPort/" -UseBasicParsing -TimeoutSec 5).StatusCode
  Say "dsh web 就绪（HTTP $ok）" 'Green'
} catch {
  Say "dsh web 未就绪：$($_.Exception.Message)" 'Red'
}

# ---------- 2. dsh-pocket 公网隧道 ----------
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*dsh-pocket*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$pocketOut = Join-Path $Root 'pocket.out.log'
$pocketErr = Join-Path $Root 'pocket.err.log'
Remove-Item $pocketOut, $pocketErr -Force -ErrorAction SilentlyContinue

Say '正在建立公网隧道（cloudflared）…'
Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
Start-Process -FilePath $PocketCmd -ArgumentList @('--public', '--pin', $Pin) `
  -WorkingDirectory $Root -WindowStyle Hidden `
  -RedirectStandardOutput $pocketOut -RedirectStandardError $pocketErr | Out-Null

$publicUrl = $null
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  $txt = Get-Content $pocketOut -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($txt -match 'https://[a-z0-9-]+\.trycloudflare\.com[^\s]*') { $publicUrl = $Matches[0]; break }
  $err = Get-Content $pocketErr -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($err -match '公网隧道失败') { break }
}

# ---------- 3. 手机派活台（抓屏 + 派活） ----------
$panelUrl = $null
if (-not $NoPanel) {
  $tokenFile = Join-Path $Root 'token.txt'
  $token = if (Test-Path $tokenFile) { (Get-Content $tokenFile -Raw).Trim() } else { '' }
  if (-not $token) {
    $bytes = New-Object byte[] 16
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    Set-Content -Path $tokenFile -Value $token -Encoding ASCII
  }
  # 屏幕面板走局域网（手机在家里/同一 WiFi 时用它看屏幕）；派活功能公网也能用（见下）
  $env:MC_TOKEN = $token
  $env:MC_PORT = "$PanelPort"
  $env:MC_RELAY_PORT = "$RelayPort"
  # 转发目标 = 桌面 App 自己的服务（19387）：它读得到全部会话（含 0.2.x 的 v4 格式），
  # 配合 agent 自动签发的浏览器会话 cookie，手机端就能看到与电脑完全一致的会话列表。
  $env:MC_RELAY_TARGET = '19387'
  $env:MC_RELAY_MINT_FROM = "$env:USERPROFILE\.dsh"
  $relayTokenFile = Join-Path $Root 'dsh-web-token.txt'
  if (Test-Path $relayTokenFile) { $env:MC_RELAY_TOKEN = (Get-Content $relayTokenFile -Raw).Trim() }
  $env:MC_WORKDIR = (Split-Path -Parent $Root)
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*mobile-control\agent.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Process -FilePath 'node.exe' -ArgumentList @((Join-Path $Root 'agent.js')) `
    -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Root 'agent.out.log') `
    -RedirectStandardError (Join-Path $Root 'agent.err.log') | Out-Null
  Start-Sleep -Seconds 3
  $panelUrl = "http://<电脑局域网IP>:$PanelPort/?t=$token"
}

# ---------- 4. 二维码与提示 ----------
$qrPath = Join-Path $Root 'qr-public.png'
$lines = @()
$lines += ''
$lines += '================ 公网扫码访问（不需要局域网） ================'
if ($publicUrl) {
  $lines += "公网地址: $publicUrl"
  $lines += "访问密码: $Pin"
  try {
    & python (Join-Path $Root 'tools\make-qr.py') $publicUrl $qrPath 10 4 | Out-Null
    $lines += "二维码:   $qrPath   （已自动打开，用手机相机扫一扫）"
    Start-Process $qrPath -ErrorAction SilentlyContinue
  } catch {
    $lines += "二维码生成失败：$($_.Exception.Message)（可手动把上面的链接发到手机）"
  }
} else {
  $lines += '公网隧道未建立成功，日志见 pocket.err.log（常见原因：代理/VPN 拦截 cloudflared）'
  $lines += '兜底方案：用手机热点让电脑连上，再走局域网扫码（同样不受局域网限制）'
}
if ($panelUrl) {
  $lines += ''
  $lines += "手机派活台（同一 WiFi 时用）: $panelUrl"
  $lines += '  · 任务页：把活派给电脑上的 dsh，结果实时回传'
  $lines += '  · 屏幕页：实时看电脑屏幕并触控'
  $lines += '  · dsh 页：打开完整 dsh 网页（相当于本机 3080）'
}
$lines += ''
$lines += "停止：stop.cmd    查看隧道日志：pocket.out.log / pocket.err.log"
$lines += '============================================================'
$lines | ForEach-Object { if ($_ -match '^={5,}') { Say $_ 'Cyan' } elseif ($_ -match '密码|地址') { Say $_ 'Yellow' } else { Say $_ } }

# 把这次的信息也存一份，方便手机扫不到时手动复制
if ($publicUrl) {
  @(
    "url=$publicUrl",
    "pin=$Pin",
    "started=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  ) | Set-Content (Join-Path $Root 'pocket-info.txt') -Encoding UTF8
}
