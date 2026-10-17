@echo off
rem 启动面板 agent（19390 面板 / 19391 dsh 转发）。由 stack.ps1 通过 Win32_Process 脱离父进程拉起。
set "MC=%~dp0.."
for /f "usebackq delims=" %%i in ("%MC%\token.txt") do set "MC_TOKEN=%%i"
for /f "usebackq delims=" %%i in ("%MC%\dsh-web-token.txt") do set "MC_RELAY_TOKEN=%%i"
set "MC_RELAY_TARGET=19387"
set "MC_RELAY_MINT_FROM=%USERPROFILE%\.dsh"
set "MC_SHOT_WIDTH=1000"
set "MC_SHOT_QUALITY=55"
cd /d "%MC%"
node "%MC%\agent.js"
