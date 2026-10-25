@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo 正在停止榫卯…
rem 优先优雅停止：中枢会追加 system.stopped、关闭服务、释放 hub.lock，避免下次启动被误判为崩溃恢复。
node scripts\stop.js
if errorlevel 1 (
  echo 优雅停止未成功，回退为强制结束（本次停止会被下次启动记为异常退出）。
  for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7410" ^| findstr "LISTENING"') do taskkill /PID %%a /F >nul 2>&1
)
rem 节点进程没有停止接口，直接结束（节点不写中枢账本，不会造成 crashRecovery）。
wmic process where "commandline like '%%node-agent\\agent.js%%'" call terminate >nul 2>&1
echo 已停止。