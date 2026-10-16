# 一次性把「命名隧道 + 固定子域」全部配好
#   方式 A（推荐，全自动）：-Login        → 自动建隧道、写 ingress、配 DNS、装自启
#   方式 B（仪表盘建的隧道）：-Token xxx  → 只跑连接器，Hostname 需你在 Zero Trust 里加
#
#   用法：
#     powershell -ExecutionPolicy Bypass -File tools\setup-named-tunnel-all.ps1 -Domain example.com -Login
#     powershell -ExecutionPolicy Bypass -File tools\setup-named-tunnel-all.ps1 -Domain example.com -Token <TOKEN>
param(
  [Parameter(Mandatory = $true)][string]$Domain,
  [string]$Token = '',
  [switch]$Login,
  [string]$TunnelName = 'dsh-pc',
  [switch]$SkipPreflight
)
$ErrorActionPreference = 'Continue'
$Mc = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$Cf = 'C:\Users\your-user\.dsh\dsh-pocket\bin\cloudflared.exe'
if (-not (Test-Path $Cf)) { $Cf = 'C:\Program Files (x86)\cloudflared\cloudflared.exe' }
$CfHome = Join-Path $env:USERPROFILE '.cloudflared'
$ConfigYml = Join-Path $CfHome 'config.yml'

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Head($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }

# ---------- 0. 前置检查 ----------
Head '0) 前置检查'
if (-not $SkipPreflight) {
  $ok = $false
  try {
    $ns = Resolve-DnsName $Domain -Type NS -Server 1.1.1.1 -ErrorAction Stop
    $hosts = ($ns | Where-Object { $_.NameHost } | Select-Object -ExpandProperty NameHost)
    Say ("  NS: " + ($hosts -join ', '))
    $ok = ($hosts | Where-Object { $_ -like '*cloudflare*' }).Count -gt 0
  } catch { Say "  域名还解析不到（$($_.Exception.Message)）" 'Yellow' }
  if (-not $ok) {
    Say '  ⚠️ 域名还没交给 Cloudflare（NS 里没有 cloudflare）。' 'Yellow'
    Say '     请先：Cloudflare → Add a site → 填域名 → 拿两条 NS → 到注册商处改成它们，等 Active。' 'Yellow'
    Say '     确认要继续就加 -SkipPreflight 再跑。' 'DarkGray'
    exit 1
  }
  Say '  ✅ NS 已在 Cloudflare' 'Green'
}

# ---------- 1. 服务是否都在跑 ----------
Head '1) 本地服务检查'
$need = @{ 19395 = 'MCP（手机指挥电脑）'; 19390 = '派活台'; 3080 = 'dsh 网页'; 3081 = 'dsh-pocket' }
foreach ($p in $need.Keys) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue
  Say ("  端口 {0,-5} {1,-22} {2}" -f $p, $need[$p], $(if ($c) { 'OK' } else { '未监听（对应功能会 502）' })) $(if ($c) { 'Gray' } else { 'Yellow' })
}

# ---------- 2. 隧道 ----------
Head '2) 隧道'
New-Item -ItemType Directory -Force -Path $CfHome | Out-Null

if ($Login -or -not $Token) {
  $cert = Join-Path $CfHome 'cert.pem'
  if (-not (Test-Path $cert)) {
    Say '  需要先在浏览器里授权一次（会打开 Cloudflare 登录页，选你的域名）…' 'Yellow'
    Start-Process -FilePath $Cf -ArgumentList @('tunnel', 'login') -Wait | Out-Null
  } else { Say '  已有 cert.pem（先前授权过）' 'DarkGray' }

  if (-not (Test-Path (Join-Path $CfHome 'cert.pem'))) { Say '  授权未完成，退出。' 'Red'; exit 1 }

  # 建隧道（同名已存在就复用）
  $list = & $Cf tunnel list 2>&1 | Out-String
  if ($list -notmatch "\b$TunnelName\b") {
    Say "  创建隧道 $TunnelName …"
    & $Cf tunnel create $TunnelName 2>&1 | ForEach-Object { Say "    $_" }
  } else { Say "  隧道 $TunnelName 已存在，复用" 'DarkGray' }

  # 找到 tunnel id
  $tunnelId = ''
  $line = ($list -split "`n") | Where-Object { $_ -match "\b$TunnelName\b" } | Select-Object -First 1
  if ($line -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') { $tunnelId = $Matches[1] }
  if (-not $tunnelId -and (Test-Path (Join-Path $CfHome "$TunnelName.json"))) { $tunnelId = (Get-Content (Join-Path $CfHome "$TunnelName.json") -Raw | ConvertFrom-Json).TunnelID }
  Say "  tunnel id: $tunnelId"

  # ingress 配置：四个固定子域
  $ingress = @()
  $ingress += "tunnel: $tunnelId"
  $ingress += "credentials-file: $($CfHome -replace '\\','/')/$TunnelName.json"
  $ingress += ''
  $ingress += 'ingress:'
  $ingress += "  - hostname: mcp.$Domain"
  $ingress += '    service: http://127.0.0.1:19395'
  $ingress += "  - hostname: panel.$Domain"
  $ingress += '    service: http://127.0.0.1:19390'
  $ingress += "  - hostname: dsh.$Domain"
  $ingress += '    service: http://127.0.0.1:3080'
  $ingress += "  - hostname: home.$Domain"
  $ingress += '    service: http://127.0.0.1:3081'
  $ingress += '  - service: http_status:404'
  [System.IO.File]::WriteAllText($ConfigYml, ($ingress -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Say "  已写入 $ConfigYml" 'Green'

  # DNS 路由
  foreach ($h in @("mcp.$Domain", "panel.$Domain", "dsh.$Domain", "home.$Domain")) {
    Say "  路由 DNS: $h"
    & $Cf tunnel route dns $TunnelName $h 2>&1 | ForEach-Object { Say "    $_" }
  }

  # 启动（前台窗口最小化，便于排查）
  Say '  启动隧道（后台窗口）…'
  Start-Process -FilePath $Cf -ArgumentList @('tunnel', '--protocol', 'http2', '--config', $ConfigYml, 'run', $TunnelName) -WindowStyle Minimized | Out-Null
} else {
  Say '  使用 Token 模式（远程托管的隧道）' 'Gray'
  Say '  注意：Token 模式的 Hostname 必须在 Zero Trust → Networks → Tunnels 里加，' 'Yellow'
  Say "        需要加 4 条：mcp/panel/dsh/home.$Domain 分别指向 http://127.0.0.1:19395 / 19390 / 3080 / 3081" 'Yellow'
  Start-Process -FilePath $Cf -ArgumentList @('tunnel', '--no-autoupdate', 'run', '--token', $Token) -WindowStyle Minimized | Out-Null
}

Start-Sleep -Seconds 12

# ---------- 3. 验证 ----------
Head '3) 公网验证'
$checks = @(
  @{ n = "mcp.$Domain/health";   u = "https://mcp.$Domain/health" },
  @{ n = "panel.$Domain";        u = "https://panel.$Domain/?t=$((Get-Content (Join-Path $Mc 'token.txt') -Raw).Trim())" },
  @{ n = "dsh.$Domain";          u = "https://dsh.$Domain/" }
)
$okAll = $true
foreach ($c in $checks) {
  $good = $false
  for ($i = 0; $i -lt 8; $i++) {
    try { $r = Invoke-WebRequest $c.u -UseBasicParsing -TimeoutSec 15; if ($r.StatusCode -eq 200) { $good = $true; break } } catch { }
    Start-Sleep -Seconds 4
  }
  Say ("  {0,-28} {1}" -f $c.n, $(if ($good) { '✅ 200' } else { '❌ 未通（DNS 还没生效或服务没起）' })) $(if ($good) { 'Green' } else { 'Yellow' })
  if (-not $good) { $okAll = $false }
}

# ---------- 4. 把固定地址写进各处 ----------
Head '4) 更新本地记录'
$mcpUrl = "https://mcp.$Domain/mcp"
[System.IO.File]::WriteAllText((Join-Path $Mc 'mcp-public-url.txt'), $mcpUrl, (New-Object System.Text.ASCIIEncoding))
Say "  mcp-public-url.txt → $mcpUrl" 'Green'
"panel=https://panel.$Domain/?t=$((Get-Content (Join-Path $Mc 'token.txt') -Raw).Trim())`ndsh=https://dsh.$Domain/`nhome=https://home.$Domain/" |
  Set-Content (Join-Path $Mc 'fixed-urls.txt') -Encoding UTF8
Say "  fixed-urls.txt 已写出（派活台 / dsh / dsh-pocket 的固定地址）" 'Green'

# ---------- 5. 开机自启 ----------
Head '5) 开机自启'
$isAdmin = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin -and -not $Token) {
  & $Cf service install 2>&1 | ForEach-Object { Say "  $_" }
  Say '  已尝试注册 Windows 服务（cloudflared）' 'Green'
} else {
  $task = 'cloudflared-dsh-tunnel'
  schtasks /delete /tn $task /f 2>$null | Out-Null
  $tr = if ($Token) { "`"$Cf`" tunnel --no-autoupdate run --token $Token" } else { "`"$Cf`" tunnel --protocol http2 --config `"$ConfigYml`" run $TunnelName" }
  schtasks /create /tn $task /sc onlogon /rl highest /f /tr $tr | Out-Null
  Say "  已注册登录自启任务: $task（想取消：schtasks /delete /tn $task /f）" 'Green'
}

# ---------- 6. 手机侧改成固定地址 ----------
Head '6) 手机 MCP 改成固定地址'
$upd = Join-Path $Mc 'tools\refresh-phone-mcp.ps1'
if (Test-Path $upd) {
  Say '  调用 refresh-phone-mcp.ps1（会改手机 dsh 配置并重启它）…'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $upd
} else { Say '  没找到 refresh-phone-mcp.ps1，手动跑一次即可' 'Yellow' }

Head '完成'
if ($okAll) { Say '✅ 四个固定地址都通了。以后不用再管隧道地址。' 'Green' }
else { Say '⚠️ 有地址没通：通常是 DNS 还没生效（等几分钟重跑本脚本），或对应本地服务没起。' 'Yellow' }
Say "  固定地址记录在: $(Join-Path $Mc 'fixed-urls.txt')" 'DarkGray'
