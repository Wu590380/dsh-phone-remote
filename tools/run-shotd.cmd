@echo off
rem 兜底启动 shotd 采集（agent 正常会自己拉起；这里给 watchdog 用）
set "MC=%~dp0.."
cd /d "%MC%"
"%MC%\shotd.exe"
