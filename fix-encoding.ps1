# 给本目录下的 PowerShell 脚本补 UTF-8 BOM。
# 原因：Windows PowerShell 5.1 读取「无 BOM」的文件时按 ANSI 解码，
# 中文注释会被解码成乱码并可能吞掉后面的语法，导致 parse error。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$utf8Bom = New-Object System.Text.UTF8Encoding($true)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

foreach ($f in (Get-ChildItem $root -Filter *.ps1 -File)) {
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $hasBom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  if ($hasBom) { Write-Host "[跳过] $($f.Name) 已有 BOM" -ForegroundColor DarkGray; continue }
  $text = [System.IO.File]::ReadAllText($f.FullName, $utf8NoBom)
  [System.IO.File]::WriteAllText($f.FullName, $text, $utf8Bom)
  Write-Host "[修复] $($f.Name) 已加 UTF-8 BOM" -ForegroundColor Green
}
