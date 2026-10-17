' run-hidden.vbs - run an exe with arguments, fully hidden (no console window)
' usage: wscript.exe //nologo run-hidden.vbs "D:\node.exe" "arg1" "arg2"
Option Explicit
Dim sh, args, i, cmd
Set sh = CreateObject("WScript.Shell")
Set args = WScript.Arguments
If args.Count = 0 Then WScript.Quit 1
cmd = Chr(34) & args(0) & Chr(34)
For i = 1 To args.Count - 1
  cmd = cmd & " " & Chr(34) & args(i) & Chr(34)
Next
sh.Run cmd, 0, False
