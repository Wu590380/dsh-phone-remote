# 把 Windows 显示缩放改成 150%（字体/元素变大，流化后手机上更看得清）
# 需要重新登录（或注销/登录）才完全生效；改完可以随时改回 125%
param([int]$Percent = 150)
$map = @{ 100 = 96; 125 = 120; 150 = 144; 175 = 168; 200 = 192 }
if (-not $map.ContainsKey($Percent)) { Write-Host "只支持 100/125/150/175/200"; exit 1 }
$v = $map[$Percent]
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name LogPixels -Value $v
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name Win8DpiScaling -Value 1 -ErrorAction SilentlyContinue
Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name DpiScalingVer -Value 0x00001018 -ErrorAction SilentlyContinue
Write-Host "已设置显示缩放为 $Percent%（注册表 LogPixels=$v）。注销/重新登录后完全生效。"
Write-Host "想改回去： powershell -File set-scale.ps1 -Percent 125"