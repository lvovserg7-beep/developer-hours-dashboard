@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TR=%~dp0start.cmd"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ЦУК сбор клиентских чатов.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$w = New-Object -ComObject WScript.Shell; $l = $w.CreateShortcut($env:LNK); $l.TargetPath = $env:TR; $l.WorkingDirectory = (Split-Path $env:TR); $l.WindowStyle = 7; $l.Description = 'Локальный сбор клиентских чатов ЦУК'; $l.Save(); Write-Host ('Startup shortcut: ' + $env:LNK)"
if errorlevel 1 (
  echo Failed to create the Startup shortcut.
  pause
  exit /b 1
)

schtasks /Create /F /TN "ЦУК сбор клиентских чатов" /TR "\"%TR%\"" /SC ONLOGON /RL LIMITED
if errorlevel 1 (
  echo Task Scheduler entry skipped (need rights). Startup shortcut is enough.
) else (
  echo Task Scheduler: starts this collector when you sign in to Windows.
)

echo Panel: http://127.0.0.1:8791/
echo The 2-hour schedule is configured in the panel, not in Task Scheduler.
pause
