# point-dsh-shortcut.ps1 —— 把桌面的「DeepSeek Harness」快捷方式指向 dsh-launch.cmd
# 效果：以后点桌面 dsh 图标 = 后台无窗口起来 + dsh 正常打开（不再开机自启）
$ErrorActionPreference = 'Continue'
$MC  = Split-Path -Parent $PSScriptRoot
$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DeepSeek Harness.lnk'
$cmd = Join-Path $MC 'tools\dsh-launch.cmd'
$dsh = 'C:\Users\14304\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'

if (-not (Test-Path $lnk)) { Write-Output ('找不到快捷方式: ' + $lnk); exit 1 }
if (-not (Test-Path $cmd)) { Write-Output ('找不到启动器: ' + $cmd); exit 1 }

# 备份原快捷方式
$bak = $lnk + '.bak-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
Copy-Item $lnk $bak -Force
Write-Output ('已备份原快捷方式: ' + (Split-Path $bak -Leaf))

$sh = New-Object -ComObject WScript.Shell
$l  = $sh.CreateShortcut($lnk)
$oldIcon = $l.IconLocation
$l.TargetPath       = $cmd
$l.Arguments        = ''
$l.WorkingDirectory = (Join-Path $MC 'tools')
$l.WindowStyle      = 7                      # 7 = 最小化（.cmd 本身一闪即退）
$l.IconLocation     = $dsh + ',0'            # 保持原来的 dsh 图标
$l.Description      = 'DeepSeek Harness（同时后台启动手机远控服务）'
$l.Save()

$check = $sh.CreateShortcut($lnk)
Write-Output ('新快捷方式目标: ' + $check.TargetPath)
Write-Output ('图标: ' + $check.IconLocation)
