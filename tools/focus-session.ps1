<#
  focus-session.ps1 —— 把电脑 dsh 的界面切到侧栏里的某一条会话（默认第一条＝最新）
  定位思路（不写死坐标）：
    1. 抓一帧（1920 宽）
    2. 像素分析侧栏文字行
    3. 用「蓝色文件夹图标」那一行当作"工作区标题"锚点
    4. 它下面第 N 行就是第 N 条会话 → 点它的中心
  用法：
    powershell -File focus-session.ps1                切到第一条
    powershell -File focus-session.ps1 -Row 2         切到第二条
    powershell -File focus-session.ps1 -JustLocate    只定位不点击
#>
param(
  [int]$Row = 1,
  [string]$Token = '',
  [switch]$JustLocate,
  [switch]$NoForeground
)

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Definition }
if (-not $here) { $here = Split-Path -Parent $PSCommandPath }
$mc = Split-Path -Parent $here
if (-not $mc) { Write-Output 'FAIL cannot resolve script dir'; exit 1 }
if (-not $Token) { $Token = (Get-Content (Join-Path $mc 'token.txt') -Raw).Trim() }
$panel = 'http://127.0.0.1:19390'

$frame = Join-Path $mc '_focus.jpg'
if (Test-Path $frame) { Remove-Item $frame -Force -ErrorAction SilentlyContinue }
& curl.exe -s -o $frame -m 25 "$panel/api/shot.jpg?w=1920&q=95&t=$Token" 2>$null
if (-not (Test-Path $frame) -or (Get-Item $frame).Length -lt 5000) { Write-Output 'FAIL frame fetch failed'; exit 1 }

$pyLines = @(
  'import sys',
  'from PIL import Image',
  'import numpy as np',
  'path = sys.argv[1]',
  "im = Image.open(path).convert('RGB')",
  'W, H = im.size',
  'rgb = np.array(im)',
  'gray = np.array(im.convert("L"))',
  'x0, x1 = int(W*0.045), int(W*0.19)',
  'y0, y1 = int(H*0.15), int(H*0.80)',
  'sub = gray[y0:y1, x0:x1]',
  'rows = (sub < 150).sum(axis=1)',
  'bands = []',
  'inb = False',
  'start = 0',
  'for i, v in enumerate(rows):',
  '    if v > 3 and not inb:',
  '        start = i; inb = True',
  '    elif v <= 3 and inb:',
  '        if i - start >= 6:',
  '            bands.append([start+y0, i+y0])',
  '        inb = False',
  'if inb and (len(rows)-start) >= 6:',
  '    bands.append([start+y0, len(rows)+y0])',
  'anchor = -1',
  'for bi, b in enumerate(bands):',
  '    seg = rgb[b[0]:b[1], x0:x1]',
  '    r = seg[:,:,0].astype(int); g = seg[:,:,1].astype(int); bl = seg[:,:,2].astype(int)',
  '    blue = ((bl > 150) & ((bl - r) > 40) & ((bl - g) > 20)).sum()',
  '    if blue >= 8:',
  '        anchor = bi; break',
  'out = ["ANCHOR=%d" % anchor, "BANDS=%d" % len(bands)]',
  'for bi, b in enumerate(bands):',
  '    out.append("BAND %d %d %d" % (bi, b[0], b[1]))',
  'print("\n".join(out))'
)
$py = Join-Path $here '_sidebar_rows.py'
[System.IO.File]::WriteAllLines($py, $pyLines, (New-Object System.Text.UTF8Encoding($false)))

$raw = & python $py $frame 2>&1
$anchor = -1
$bands = @()
foreach ($line in $raw) {
  if ($line -match '^ANCHOR=(-?\d+)') { $anchor = [int]$Matches[1] }
  elseif ($line -match '^BAND (\d+) (\d+) (\d+)') { $bands += ,@([int]$Matches[1], [int]$Matches[2], [int]$Matches[3]) }
}
if ($anchor -lt 0) {
  # 找不到蓝色文件夹图标时的兜底：侧栏结构固定为 插件 / 工作区 / 工作区标题 / 会话…，取第 3 个 band
  if ($bands.Count -ge 4) { $anchor = 2 } else { Write-Output ("FAIL anchor not found; bands=" + $bands.Count); exit 1 }
}
$sessionBands = @($bands | Where-Object { $_[0] -gt $anchor })
if ($sessionBands.Count -eq 0) { Write-Output 'FAIL no session rows under workspace title'; exit 1 }

$idx = $Row - 1
if ($idx -ge $sessionBands.Count) { $idx = $sessionBands.Count - 1 }
$centerY = [int](($sessionBands[$idx][1] + $sessionBands[$idx][2]) / 2)
$clickX = [int](1920 * 0.08)

Write-Output ("INFO anchorBand=$anchor sessionRows=" + $sessionBands.Count + " targetY=$centerY x=$clickX")
if ($JustLocate) { exit 0 }

if (-not $NoForeground) {
  $sig = @'
using System;
using System.Runtime.InteropServices;
public class McWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
'@
  try {
    Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue | Out-Null
    $w = Get-Process | Where-Object { $_.MainWindowTitle -match 'DeepSeek Harness|dsh' } | Select-Object -First 1
    if ($w) {
      if ([McWin]::IsIconic($w.MainWindowHandle)) { [McWin]::ShowWindow($w.MainWindowHandle, 9) | Out-Null }
      [McWin]::SetForegroundWindow($w.MainWindowHandle) | Out-Null
      Start-Sleep -Milliseconds 450
      Write-Output ("INFO foreground -> " + $w.ProcessName)
    }
  } catch { }
}

$body = '{"action":"click","x":' + $clickX + ',"y":' + $centerY + '}'
$bf = Join-Path $mc '_focus_req.json'
[System.IO.File]::WriteAllText($bf, $body, (New-Object System.Text.UTF8Encoding($false)))
$r = & curl.exe -s -m 20 -H 'Content-Type: application/json' --data-binary "@$bf" "$panel/api/input?t=$Token" 2>$null
if ($r -match 'ok') { Write-Output "OK clicked sidebar session row $Row (x=$clickX y=$centerY)" } else { Write-Output "FAIL click: $r" }
Remove-Item $bf -Force -ErrorAction SilentlyContinue
