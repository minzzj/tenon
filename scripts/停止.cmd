@echo off
chcp 65001 >nul
echo 正在停止榫卯…
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7410" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1
wmic process where "commandline like '%%node-agent\\agent.js%%'" call terminate >nul 2>&1
echo 已停止。