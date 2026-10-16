# 启动一个「只监听 127.0.0.1」的独立 dsh 网页实例（自动生成独立凭据，不动桌面配置）
# 手机端通过 agent 的转发端口访问它，因此电脑上的 dsh 本体仍然保持仅回环可访问。
param(
  [int]$Port = 19400,
  [switch]$Quiet
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$HomeDir = Join-Path $Root 'dsh-web-home'
$DshPs1 = 'E:\node_global\dsh.ps1'

if (-not (Test-Path $DshPs1)) {
  Write-Host "找不到 dsh 启动脚本: $DshPs1" -ForegroundColor Red
  exit 1
}

# 独立的 DSH_HOME，与桌面版互不干扰
if (-not (Test-Path $HomeDir)) { New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null }
$settings = Join-Path $HomeDir 'settings.yaml'
if (-not (Test-Path $settings)) {
  $src = Join-Path $env:USERPROFILE '.dsh\settings.yaml.imported'
  if (Test-Path $src) { Copy-Item $src $settings -Force }
}

# 关于凭据：桌面版的 ~/.dsh/.credentials.yaml 用的是「嵌套 payload」格式，
# 命令行版 dsh 只认「扁平 reference: 字符串」格式，直接拷过来会导致启动失败
# （credentials-local: the value for "version" ... must be a string）。
# 所以这里不复制凭据：手机端第一次进 dsh 网页时，按提示在模型设置里填一次 API Key 即可，
# 填完会写进 dsh-web-home\.credentials.yaml，之后一直可用。
$credDst = Join-Path $HomeDir '.credentials.yaml'
if (Test-Path $credDst) {
  Write-Host '独立实例已有自己的凭据文件，沿用。' -ForegroundColor DarkGray
} else {
  Write-Host '提示：首次打开手机端 dsh 网页时，需按引导配置一次模型 API Key（会存在 dsh-web-home）。' -ForegroundColor DarkGray
}

# 已在本端口运行就不再重复启动
$alive = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($alive) {
  Write-Host "dsh 网页实例已在 127.0.0.1:$Port 运行 (PID $($alive[0].OwningProcess))" -ForegroundColor DarkGray
  exit 0
}

# 用独立窗口启动（-NoExit 保留窗口，出错时能直接看到输出）
$argList = @(
  '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass',
  '-File', "`"$DshPs1`"", 'web', '--port', "$Port"
)
$envBackup = $env:DSH_HOME
$env:DSH_HOME = $HomeDir
try {
  Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WorkingDirectory $Root -WindowStyle Minimized | Out-Null
} finally {
  if ($null -eq $envBackup) { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue } else { $env:DSH_HOME = $envBackup }
}

if (-not $Quiet) { Write-Host "已启动独立 dsh 网页实例，端口 127.0.0.1:$Port（DSH_HOME=$HomeDir）" -ForegroundColor Green }

# 等它就绪
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 750
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3
    if ($r.StatusCode -eq 200) {
      if (-not $Quiet) { Write-Host "dsh 网页实例就绪（$([math]::Round(($i+1)*0.75,1)) 秒）" -ForegroundColor Green }
      exit 0
    }
  } catch {}
}
Write-Host "等待 dsh 网页实例超时，请查看窗口输出。" -ForegroundColor Yellow
exit 1
