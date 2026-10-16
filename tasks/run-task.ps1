# 单个 dsh 任务的执行入口（由 dispatcher 调用）
#   任务文本用 UTF-8 文件传入，避免命令行参数在中文/特殊字符上出现编码问题。
param(
  [Parameter(Mandatory = $true)][string]$TaskFile,
  [string]$Cwd = '',
  [string]$Profile = 'headless'
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}

$DshPs1 = 'E:\node_global\dsh.ps1'
if (-not (Test-Path $DshPs1)) { Write-Error "找不到 dsh 启动脚本: $DshPs1"; exit 127 }

$task = [System.IO.File]::ReadAllText($TaskFile, [System.Text.Encoding]::UTF8).Trim()
if (-not $task) { Write-Error '任务内容为空'; exit 2 }

if ($Cwd -and (Test-Path -LiteralPath $Cwd)) { Set-Location -LiteralPath $Cwd }

& $DshPs1 --profile $Profile -- $task
exit $LASTEXITCODE
