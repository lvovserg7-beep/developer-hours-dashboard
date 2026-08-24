@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-stable.ps1" %*
if errorlevel 1 (
  echo.
  echo Update failed. Need Git, access to GitHub, and a clone (not a ZIP folder).
  pause
  exit /b 1
)
echo.
echo Restart the dashboard.
call "%~dp0start.cmd"
