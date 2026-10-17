' watchdog.vbs - scheduled task entry (GUI host, no console window at all)
' launches stack.ps1 -Up through conhost --headless
Option Explicit
Dim sh, ps, st, cmd
Set sh = CreateObject("WScript.Shell")
ps = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
st = "E:\harness-workspace\mobile-control\tools\stack.ps1"
cmd = "conhost.exe --headless """ & ps & """ -NoProfile -ExecutionPolicy Bypass -File """ & st & """ -Up"
sh.Run cmd, 0, False
