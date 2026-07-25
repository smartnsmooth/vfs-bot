@echo off
setlocal
cd /d "%~dp0"
echo Starting vfsbot (single instance)...
set "NODE_EXE=%~dp0node\node.exe"
if not exist "%NODE_EXE%" (
  echo Portable Node runtime is missing: "%NODE_EXE%"
  pause
  exit /b 1
)
"%NODE_EXE%" dist\index.js
echo.
echo Process exited.
pause
