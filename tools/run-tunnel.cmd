@echo off
rem 启动 cloudflared 命名隧道（前台运行；由 stack.ps1 通过 Win32_Process 脱离父进程拉起）
set "CF=%USERPROFILE%\.dsh\dsh-pocket\bin\cloudflared.exe"
set "CFG=%USERPROFILE%\.cloudflared\config.yml"
"%CF%" tunnel --protocol http2 --config "%CFG%" run
