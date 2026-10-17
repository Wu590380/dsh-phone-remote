@echo off
rem 启动电脑侧 MCP 服务（19395）。由 stack.ps1 通过 Win32_Process 脱离父进程拉起。
set "MC=%~dp0.."
for /f "usebackq delims=" %%i in ("%MC%\mcp-token.txt") do set "MC_MCP_TOKEN=%%i"
cd /d "%MC%\mcp"
node "%MC%\mcp\pc-mcp-server.js"
