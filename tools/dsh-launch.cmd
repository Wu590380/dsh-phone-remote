@echo off
rem dsh-launch.cmd - start the phone-remote backend silently, then launch DeepSeek Harness
rem Backend starts in background (conhost --headless => no window). dsh launches immediately.
set "MCDIR=%~dp0.."
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
start "" /b conhost.exe --headless "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%MCDIR%\tools\stack.ps1" -Up
start "" "C:\Users\14304\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
exit /b 0
