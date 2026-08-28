@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".env" if not exist "odata.env" (
  copy /Y ".env.example" ".env" >nul
  echo.
  echo Created .env. Enter 1C OData login and password, save and close Notepad.
  echo Do not use this computer Windows account. Use the OData publication user.
  echo.
  notepad ".env"
)

:restart
echo Stopping previous dashboard on port 8787 if it is running...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
ping -n 2 127.0.0.1 >nul
echo Starting dashboard...
echo Local:  http://localhost:8787/
echo LAN:    http://192.168.10.240:8787/
echo On start: hours + SEO trailing (Ozon auto-refresh is off by default).
echo If the process exits, it will restart in 5 seconds. Close this window to stop.
node server.mjs 2>&1
set EXITCODE=%ERRORLEVEL%
echo.
echo Dashboard exited with code %EXITCODE%.
if "%EXITCODE%"=="401" (
  echo Code 401 means OData login or password was rejected.
  echo Set ODATA_DB_TRADE_* and ODATA_DB_ECOTIDY_* in dashboard\.env
  pause
  exit /b 401
)
echo Restarting in 5 seconds...
ping -n 6 127.0.0.1 >nul
goto restart
