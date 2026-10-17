@echo off
rem watchdog.cmd - scheduled task entry: bring up backend silently (dsh gate is inside stack.ps1)
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
conhost.exe --headless "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0stack.ps1" -Up
