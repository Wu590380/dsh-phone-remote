# 配置 Cloudflare 命名隧道（固定域名）—— 一次填好，之后链接永久不变
#   用法: powershell -ExecutionPolicy Bypass -File tools\setup-named-tunnel.ps1
#   交互输入：Tunnel Token、固定域名（如 pocket.example.com）
param(
  [string]$Token = '',
  [string]$Domain = '',
  [switch]$AutoStart,        # 顺带注册登录自启
  [switch]$SkipRestart
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$SettingsDir = Join-Path $env:USERPROFILE '.dsh\dsh-pocket'
$SettingsFile = Join-Path $SettingsDir 'settings.json'
$PocketCmd = 'E:\node_global\dsh-pocket.cmd'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

# ---------- 1. 取 Token ----------
if (-not $Token) {
  Write-Host ''
  Say '请到 Cloudflare Zero Trust 控制台复制隧道 Token：' 'Cyan'
  Say '  https://one.dash.cloudflare.com/  →  Networks → Tunnels → 选你的隧道 → Configure → 复制 Connector token'
  Write-Host ''
  Say '（Token 形如 eyJhIjoi... 很长一串，以 . 分三段）' 'DarkGray'
  $Token = (Read-Host 'Tunnel Token').Trim()
}
if (-not $Token) { Say 'Token 为空，已退出。' 'Red'; exit 1 }
if ($Token -notmatch '^[A-Za-z0-9_\-\.]{80,}$') {
  Say '这个值看起来不像 Tunnel Token（长度不足或含非法字符），仍按你给的写入了。' 'Yellow'
}

# ---------- 2. 取固定域名 ----------
if (-not $Domain) {
  Write-Host ''
  Say '固定域名 = 你在 Zero Trust 里配的 Public Hostname，例如 pocket.example.com' 'DarkGray'
  $Domain = (Read-Host '固定域名').Trim()
}
$Domain = ($Domain -replace '^https?://', '' -replace '/.*$', '').Trim().TrimEnd('/')
if ($Domain -notmatch '^[A-Za-z0-9]([A-Za-z0-9\-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9\-]*[A-Za-z0-9])?)+$') {
  Say "域名格式不对（应为 pocket.example.com 这种裸域名，不要带 https:// 或路径）：$Domain" 'Red'; exit 1
}

# ---------- 3. 写入 dsh-pocket 设置 ----------
New-Item -ItemType Directory -Force -Path $SettingsDir | Out-Null
$settings = @{}
if (Test-Path $SettingsFile) {
  try { $settings = Get-Content $SettingsFile -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable } catch { $settings = @{} }
}
$settings['tunnelMode'] = 'named'
$settings['tunnelToken'] = $Token
$settings['tunnelHostname'] = $Domain
($settings | ConvertTo-Json -Depth 6) | Set-Content $SettingsFile -Encoding UTF8
Say "已写入设置: $SettingsFile" 'Green'
Say "  隧道模式: named（固定域名 $Domain）" 'Green'

# ---------- 4. 重启 dsh-pocket 让它生效 ----------
if (-not $SkipRestart) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*dsh-pocket*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Say "已停止旧 dsh-pocket PID $($_.ProcessId)" 'DarkGray' }
  Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; Say "已停止旧 cloudflared PID $($_.Id)" 'DarkGray' }
  Start-Sleep -Seconds 2
  Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
  Start-Process -FilePath $PocketCmd -ArgumentList @('--public') -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $Root 'pocket.out.log') -RedirectStandardError (Join-Path $Root 'pocket.err.log') | Out-Null
  Say '已重启 dsh-pocket（等它把命名隧道拉起来）…' 'Gray'
  Start-Sleep -Seconds 12
}

# ---------- 5. 验证固定域名 ----------
$url = "https://$Domain/?token="
$pin = ''
$out = Get-Content (Join-Path $Root 'pocket.out.log') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
if ($out -match '访问密码：(\S+)') { $pin = $Matches[1] }
if ($pin) { $url = "https://$Domain/?token=$pin" }
Say "固定访问地址: $url" 'Yellow'

$ok = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 3
  try {
    $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 12
    if ($r.StatusCode -eq 200) { Say "验证通过：HTTP 200（$(if ($r.Content -match '__DSH_BOOT__') { '是 dsh 页面' } else { '不是 dsh 页面，检查 Public Hostname 是否指向 http://127.0.0.1:3081' })）" 'Green'; $ok = $true; break }
  } catch { }
  Say "  第 $($i+1) 次还没通（命名隧道 + DNS 生效有时要 1~2 分钟）…" 'DarkGray'
}
if (-not $ok) {
  Say '固定域名还没通，常见原因：' 'Yellow'
  Say '  1) 该隧道的 Public Hostname 没配，或 Service 没指向 http://127.0.0.1:3081' 'Yellow'
  Say '  2) 域名的 DNS 还没被 Cloudflare 接管（域名的 NS 必须指到 Cloudflare）' 'Yellow'
  Say '  3) Token 复制不完整，或隧道被删了' 'Yellow'
  Say "  日志: $(Join-Path $Root 'pocket.err.log')" 'DarkGray'
  Get-Content (Join-Path $Root 'pocket.err.log') -Encoding UTF8 -Tail 8 -ErrorAction SilentlyContinue
}

# ---------- 6. 生成二维码 ----------
if ($pin) {
  $qr = Join-Path $Root 'qr-public.png'
  & python (Join-Path $Root 'tools\make-qr.py') $url $qr 10 4 2>&1 | Out-Null
  @(
    "mode=named",
    "url=$url",
    "pin=$pin",
    "domain=$Domain",
    "updated=$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  ) | Set-Content (Join-Path $Root 'pocket-info.txt') -Encoding UTF8
  Say "二维码已更新: $qr（固定域名，以后不用再换）" 'Green'
  Start-Process $qr -ErrorAction SilentlyContinue
}

# ---------- 7. 可选：登录自启 ----------
if ($AutoStart) {
  $taskName = 'dsh-pocket-named'
  schtasks /delete /tn $taskName /f 2>$null | Out-Null
  $tr = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$Root\start-public.ps1`""
  schtasks /create /tn $taskName /sc onlogon /rl highest /f /tr $tr | Out-Null
  Say "已注册登录自启任务: $taskName（管理员授权过即可生效；取消: schtasks /delete /tn $taskName /f）" 'Green'
}

Say ''
Say '完成。手机上直接用固定地址（或扫二维码），以后地址不变。' 'Cyan'
