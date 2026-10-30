@echo off
cd /d "%~dp0.."
set TENON_V2=1
node node-agent\agent.js >> data\agent.out.log 2>> data\agent.err.log
