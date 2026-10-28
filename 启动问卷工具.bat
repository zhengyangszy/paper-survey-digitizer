@echo off
title 问卷数字化工具
cd /d "%~dp0"
set NODEEXE=node
if exist "%~dp0node.exe" set NODEEXE=%~dp0node.exe
echo 正在启动问卷数字化工具...
start "paper-survey-digitizer-server" /min "%NODEEXE%" src\server.js
ping -n 3 127.0.0.1 >nul
start "" http://localhost:3000
echo.
echo   浏览器已打开 http://localhost:3000（如果没弹出，手动打开即可）
echo   数据保存在本文件夹的 data\ 目录里
echo   停止服务：关闭任务栏里最小化的 "paper-survey-digitizer-server" 窗口
echo.
ping -n 6 127.0.0.1 >nul
