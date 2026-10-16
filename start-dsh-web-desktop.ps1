# 启动「能看到桌面会话」的 dsh 网页实例（供手机远程接着做）
#
# 关键点（0.2.0-rc.2 起）：
#   - 网页带 token 鉴权：启动时打印 http://127.0.0.1:<port>/?token=<启动令牌>；
#     用它换一次签名 cookie（secret 持久化在 .credentials.yaml），之后设备长期有效。
#   - DSH_HOME 用独立目录 dsh-web-desktop（自有凭据），其中 sessions/storages/attachments
#     都做成指向 ~/.dsh 的目录联接 → 看到的会话 == 桌面 App 的会话（含 v4 新格式）。
#   - 必须用 0.2.x 的 dsh：0.1.x 只认 session format 0，读不了桌面 App 写的 v4 会话。
param([int]$Port = 3086, [switch]$Quiet)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$HomeDir = Join-Path $Root 'dsh-web-desktop'
$DesktopHome = Join-Path $env:USERPROFILE '.dsh'

# 优先用装好的新版 dsh（支持 v4 会话），回退到全局 CLI
$candidates = @(
  'E:\harness-workspace\dsh-0.2\node_modules\@deepseek-ai\dsh\lib\bin.js',
  'E:\node_global\node_modules\@deepseek-ai\dsh\lib\bin.js'
)
$DshBin = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $DshBin) { Write-Host '找不到可用的 dsh' -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path $HomeDir, (Join-Path $HomeDir 'profiles\web') | Out-Null

# 1) 扁平凭据（桌面版的嵌套格式命令行不认）；dsh 自己写入的 browser-session grant 要保留
$cred = Join-Path $HomeDir '.credentials.yaml'
if (-not (Test-Path $cred)) {
  $key = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')
  if (-not $key) { $key = $env:DEEPSEEK_API_KEY }
  if ($key) {
    [System.IO.File]::WriteAllText($cred,
      "version: 1`nrefs:`n  DEEPSEEK_API_KEY: $key`n",
      (New-Object System.Text.UTF8Encoding($false)))
  }
}

# 2) profile 补丁：凭据来源指向这个文件
$patchFile = Join-Path $HomeDir 'profiles\web\cordis.patch.yml'
$patchText = "- id: credentials-local`n  config:`n    path: $($cred -replace '\\','/')`n"
if (-not (Test-Path $patchFile) -or (Get-Content $patchFile -Raw) -ne $patchText) {
  [System.IO.File]::WriteAllText($patchFile, $patchText, (New-Object System.Text.UTF8Encoding($false)))
}

# 3) settings：首次从桌面导入一份
$settings = Join-Path $HomeDir 'settings.yaml'
if (-not (Test-Path $settings)) {
  $src = Join-Path $DesktopHome 'settings.yaml.imported'
  if (Test-Path $src) { Copy-Item $src $settings -Force }
}

# 4) 联接桌面 home 的关键目录：会话 / 索引 / 附件 / 预设
foreach ($item in 'sessions', 'storages', 'attachments', '.agent-presets') {
  $src = Join-Path $DesktopHome $item
  $dst = Join-Path $HomeDir $item
  if (-not (Test-Path $src)) { continue }
  if (Test-Path $dst) {
    if ((Get-Item $dst -Force).LinkTarget) { continue }
    Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
  }
  & cmd /c "mklink /J `"$dst`" `"$src`"" | Out-Null
}

# 5) 启动（--no-open：别弹电脑上的浏览器）
$out = Join-Path $Root '_web3086.out'
$err = Join-Path $Root '_web3086.err'
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
$env:DSH_HOME = $HomeDir
$env:BROWSER = 'true'
Start-Process node.exe -ArgumentList @($DshBin, 'web', '--port', "$Port", '--host', '127.0.0.1', '--no-open') `
  -WorkingDirectory $HomeDir -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err

# 6) 等启动，抠出启动令牌，写出「本机地址 / 手机地址」
$launchToken = ''
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 2
  $t = Get-Content $out -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
  if ($t -match '\?token=([A-Za-z0-9_-]+)') { $launchToken = $Matches[1]; break }
}
$localUrl = "http://127.0.0.1:$Port/?token=$launchToken"
[System.IO.File]::WriteAllText((Join-Path $Root 'pc-dsh-url.txt'), $localUrl, (New-Object System.Text.ASCIIEncoding))

$relayTok = ''
$rt = Join-Path $Root 'dsh-web-token.txt'
if (Test-Path $rt) { $relayTok = (Get-Content $rt -Raw).Trim() }
if ($relayTok -and $launchToken) {
  $public = "https://pc.example.com/?t=$relayTok&token=$launchToken"
  [System.IO.File]::WriteAllText((Join-Path $Root 'pc-public-url.txt'), $public, (New-Object System.Text.ASCIIEncoding))
} else { $public = '(缺少转发令牌或启动令牌，检查 _web3086.out)' }

if (-not $Quiet) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
  if ($c) { Write-Host "dsh 网页实例已启动 (PID $($c[0].OwningProcess))" -ForegroundColor Green }
  else { Write-Host "端口 $Port 未监听，看 _web3086.err" -ForegroundColor Yellow; Get-Content $err -Tail 10 }
  Write-Host "  本机地址: $localUrl"
  Write-Host "  手机地址: $public"
}
