@echo off
setlocal
cd /d "%~dp0"
echo Starting VFS Bot Cluster (5 instances)...
node dist\cluster.js
echo.
echo Process exited.
pause
