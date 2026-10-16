@echo off
chcp 65001 >nul
cd /d "%~dp0"
:menu
cls
echo ================================================================
echo   dsh 手机派活台
echo ================================================================
echo.
echo   [1] 公网扫码模式（推荐，人在外面也能用，不受局域网限制）
echo   [2] 局域网模式（手机与电脑同一 WiFi，延迟最低）
echo   [3] 停止全部服务
echo   [0] 退出
echo.
set /p choice=请输入数字并回车: 

if "%choice%"=="1" goto public
if "%choice%"=="2" goto lan
if "%choice%"=="3" goto stop
if "%choice%"=="0" exit /b 0
goto menu

:public
echo.
echo 正在启动公网扫码模式…
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-public.ps1"
pause
exit /b 0

:lan
echo.
echo 正在启动局域网模式…
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
exit /b 0

:stop
echo.
call "%~dp0stop.cmd"
pause
exit /b 0
