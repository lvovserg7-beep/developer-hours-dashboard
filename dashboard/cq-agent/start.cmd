@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\@cursor\sdk" (
  echo Installing @cursor/sdk ...
  call npm install
)
:restart
echo Stopping previous collector on port 8791 if it is running...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 8791 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
ping -n 2 127.0.0.1 >nul
echo Collector panel: http://127.0.0.1:8791/
echo Close this window to stop.
node server.mjs 2>&1
echo.
echo Collector exited with code %ERRORLEVEL%. Restarting in 5 seconds...
ping -n 6 127.0.0.1 >nul
goto restart
