@echo off
chcp 65001 >nul
title BiliIDM Bridge
cd /d "%~dp0bridge"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 没找到 Node.js，请先安装： https://nodejs.org/
  pause
  exit /b 1
)

echo ============================================
echo   BiliIDM Bridge  -  B站 ^-^> IDM 下载桥接
echo   保持本窗口开着；关掉窗口 = 停止服务
echo ============================================
echo.

node server.mjs

echo.
echo [服务已退出] 按任意键关闭窗口
pause >nul
