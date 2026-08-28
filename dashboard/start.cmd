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
echo Stopping previous dashboard on port 8787 if it is running...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
ping -n 2 127.0.0.1 >nul
echo Starting dashboard...
echo Local:  http://localhost:8787/
echo LAN:    http://192.168.10.240:8787/
echo On start: refresh board caches for the last 7 days (hours + SEO + Ozon).
node server.mjs 2>&1
if errorlevel 1 (
  echo.
  echo Start failed. Code 401 means OData login or password was rejected.
  echo Set ODATA_DB_TRADE_* and ODATA_DB_ECOTIDY_* in dashboard\.env
  pause
)
