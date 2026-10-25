@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo 正在启动榫卯…
start "TenonHub" cmd /k "node server\start.js"
timeout /t 2 >nul
start "TenonNode" cmd /k "node node-agent\agent.js"
timeout /t 3 >nul
start "" "http://127.0.0.1:7410"
echo 已启动：中枢窗口 + 节点窗口；浏览器应已打开 http://127.0.0.1:7410