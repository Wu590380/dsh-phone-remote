# Input injection helper: translate phone touch/text into Windows mouse & keyboard events.
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('move','click','rightclick','dblclick','down','up','scroll','text','keys','clipboard','key')]
  [string]$Action,
  [int]$X = -1,
  [int]$Y = -1,
  [int]$DX = 0,
  [int]$DY = 0,
  [string]$Text = '',
  [string]$Keys = '',
  [string]$File = '',
  [int]$Delay = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class MCInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out int x, out int y);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, WHEEL = 0x0800;
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public static void KeyPress(int vk) {
      keybd_event((byte)vk, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(30);
      keybd_event((byte)vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      System.Threading.Thread.Sleep(20);
    }
    public static void KeyCombo(int mod, int mod2, int vk) {
      if (mod != 0) keybd_event((byte)mod, 0, 0, UIntPtr.Zero);
      if (mod2 != 0) keybd_event((byte)mod2, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(20);
      keybd_event((byte)vk, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(30);
      keybd_event((byte)vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      if (mod2 != 0) keybd_event((byte)mod2, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      if (mod != 0) keybd_event((byte)mod, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      System.Threading.Thread.Sleep(20);
    }
  public static void SmoothMove(int tx, int ty) {
    int cx = 0, cy = 0;
    GetCursorPos(out cx, out cy);
    double dist = Math.Sqrt((double)(tx-cx)*(tx-cx) + (double)(ty-cy)*(ty-cy));
    int steps = (int)Math.Min(24, Math.Max(4, dist / 45));
    for (int i = 1; i <= steps; i++) {
      int x = (int)Math.Round(cx + (tx-cx) * (double)i/steps);
      int y = (int)Math.Round(cy + (ty-cy) * (double)i/steps);
      SetCursorPos(x, y);
      System.Threading.Thread.Sleep(6);
    }
    SetCursorPos(tx, ty);
  }
}
'@

try { [void][MCInput]::SetProcessDPIAware() } catch {}

function Get-PayloadText {
  if ($File -and (Test-Path -LiteralPath $File)) {
    return [System.IO.File]::ReadAllText($File, [System.Text.Encoding]::UTF8)
  }
  return $Text
}

switch ($Action) {
  'move' {
    if ($X -ge 0 -and $Y -ge 0) { [void][MCInput]::SetCursorPos($X, $Y) }
  }
  'click' {
    [MCInput]::SmoothMove($X, $Y)
    Start-Sleep -Milliseconds 40
    [MCInput]::mouse_event([MCInput]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    [MCInput]::mouse_event([MCInput]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  }
  'dblclick' {
    [MCInput]::SmoothMove($X, $Y)
    Start-Sleep -Milliseconds 40
    for ($i = 0; $i -lt 2; $i++) {
      [MCInput]::mouse_event([MCInput]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      [MCInput]::mouse_event([MCInput]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    }
  }
  'rightclick' {
    [MCInput]::SmoothMove($X, $Y)
    Start-Sleep -Milliseconds 40
    [MCInput]::mouse_event([MCInput]::RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
    [MCInput]::mouse_event([MCInput]::RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
  }
  'down' {
    if ($X -ge 0 -and $Y -ge 0) { [void][MCInput]::SetCursorPos($X, $Y) }
    Start-Sleep -Milliseconds 30
    [MCInput]::mouse_event([MCInput]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
  }
  'up' {
    if ($X -ge 0 -and $Y -ge 0) { [void][MCInput]::SetCursorPos($X, $Y) }
    Start-Sleep -Milliseconds 30
    [MCInput]::mouse_event([MCInput]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
  }
  'scroll' {
    $ticks = $DY
    if ($ticks -eq 0) { $ticks = 1 }
    $ticks = [Math]::Max(-12, [Math]::Min(12, $ticks))
    [MCInput]::mouse_event([MCInput]::WHEEL, 0, 0, ($ticks * 120), [UIntPtr]::Zero)
  }
    'key' {
      $map = @{ 'enter'=0x0D; 'return'=0x0D; 'backspace'=0x08; 'tab'=0x09; 'esc'=0x1B; 'escape'=0x1B; 'delete'=0x2E
        'del'=0x2E; 'space'=0x20; 'up'=0x26; 'down'=0x28; 'left'=0x25; 'right'=0x27; 'home'=0x24; 'end'=0x23
        'pageup'=0x21; 'pagedown'=0x22; 'insert'=0x2D }
      $mods = @{ 'ctrl'=0x11; 'control'=0x11; 'alt'=0x12; 'shift'=0x10; 'win'=0x5B }
      foreach ($seq in ($Keys -split ',')) {
        $k = $seq.Trim().ToLower()
        if (-not $k) { continue }
        if ($k -like 'f[0-9]' -or $k -like 'f1[0-9]' -or $k -like 'f2[0-4]') {
          $n = 0
          if ([int]::TryParse($k.Substring(1), [ref]$n) -and $n -ge 1 -and $n -le 24) { [MCInput]::KeyPress(0x70 + ($n - 1)); continue }
        }
        if ($k.Contains('+')) {
          $m1 = 0; $m2 = 0; $vk = 0
          foreach ($p in ($k -split '\+')) {
            if ($mods.ContainsKey($p)) { if ($m1 -eq 0) { $m1 = $mods[$p] } else { $m2 = $mods[$p] } }
            elseif ($map.ContainsKey($p)) { $vk = $map[$p] }
            elseif ($p.Length -eq 1) { $vk = [int][char]$p.ToUpper() }
          }
          if ($vk -ne 0) { [MCInput]::KeyCombo($m1, $m2, $vk) }
          continue
        }
        if ($map.ContainsKey($k)) { [MCInput]::KeyPress($map[$k]); continue }
        if ($k.Length -eq 1) { [MCInput]::KeyPress([int][char]$k.ToUpper()); continue }
      }
    }
    'keys' {
      foreach ($seq in ($Keys -split ',')) {
        $k = $seq.Trim().ToLower()
        if ($k -in @('enter','return')) { [MCInput]::KeyPress(0x0D) }
        elseif ($k -eq 'backspace') { [MCInput]::KeyPress(0x08) }
        elseif ($k -eq 'tab') { [MCInput]::KeyPress(0x09) }
        elseif ($k -in @('esc','escape')) { [MCInput]::KeyPress(0x1B) }
        elseif ($k -eq 'delete') { [MCInput]::KeyPress(0x2E) }
        elseif ($k -eq 'space') { [MCInput]::KeyPress(0x20) }
        elseif ($k -eq 'ctrl+a') { [MCInput]::KeyCombo(0x11, 0, 0x41) }
        elseif ($k -eq 'ctrl+c') { [MCInput]::KeyCombo(0x11, 0, 0x43) }
        elseif ($k -eq 'ctrl+v') { [MCInput]::KeyCombo(0x11, 0, 0x56) }
        elseif ($k -eq 'ctrl+z') { [MCInput]::KeyCombo(0x11, 0, 0x5A) }
        elseif ($k.Length -ge 1) { [MCInput]::KeyPress([int][char]$k.Substring(0,1).ToUpper()) }
      }
    }
  'text' {
    $t = Get-PayloadText
    Set-Clipboard -Value $t
    Start-Sleep -Milliseconds 120
    [System.Windows.Forms.SendKeys]::SendWait('^v')
  }
  'clipboard' {
    $t = Get-PayloadText
    Set-Clipboard -Value $t
  }
}

if ($Delay -gt 0) { Start-Sleep -Milliseconds $Delay }
Write-Output ('ok ' + $Action)
