# Screen capture helper: grab the primary screen, scale down, emit JPEG to stdout.
# Output: one JSON metadata line, "\n", then raw JPEG bytes.
param(
  [int]$Width = 1100,
  [int]$Quality = 60
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MCShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
}
'@

try { [void][MCShot]::SetProcessDPIAware() } catch {}

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$srcW = $vs.Width; $srcH = $vs.Height
if ($srcW -le 0 -or $srcH -le 0) { throw 'cannot query screen size' }

$scale = 1.0
if ($Width -gt 0 -and $srcW -gt $Width) { $scale = $Width / $srcW }
$dstW = [int][Math]::Max(1, [Math]::Round($srcW * $scale))
$dstH = [int][Math]::Max(1, [Math]::Round($srcH * $scale))

$src = New-Object System.Drawing.Bitmap($srcW, $srcH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($src)
try {
  $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, (New-Object System.Drawing.Size($srcW, $srcH)), [System.Drawing.CopyPixelOperation]::SourceCopy)
} finally { $g.Dispose() }

$dst = New-Object System.Drawing.Bitmap($dstW, $dstH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g2 = [System.Drawing.Graphics]::FromImage($dst)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
try { $g2.DrawImage($src, 0, 0, $dstW, $dstH) } finally { $g2.Dispose(); $src.Dispose() }

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ps = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ps.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]$Quality)

$ms = New-Object System.IO.MemoryStream
$dst.Save($ms, $codec, $ps)
$bytes = $ms.ToArray()
$ms.Dispose(); $dst.Dispose()

$meta = [ordered]@{
  ow = $srcW; oh = $srcH; scale = $scale; sw = $dstW; sh = $dstH
  bytes = $bytes.Length; ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
} | ConvertTo-Json -Compress

$out = [Console]::OpenStandardOutput()
$metaBuf = [System.Text.Encoding]::UTF8.GetBytes($meta + "`n")
$out.Write($metaBuf, 0, $metaBuf.Length)
$out.Write($bytes, 0, $bytes.Length)
$out.Flush()
