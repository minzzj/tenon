@echo off
cd /d "%~dp0.."
set TENON_HOST=0.0.0.0
set TENON_PORT=7410
node server\start.js >> data\hub.out.log 2>> data\hub.err.log
