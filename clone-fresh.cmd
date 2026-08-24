@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

rem Новая папка проекта, чтобы не checkout'ить ветку, уже занятую worktree Cursor.
if exist "C:\Apps\" (
  set "DEST=C:\Apps\developer-hours-dashboard-pnl"
) else (
  set "DEST=%USERPROFILE%\developer-hours-dashboard-pnl"
)

set "REPO=https://github.com/lvovserg7-beep/developer-hours-dashboard.git"
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

echo Целевая папка: %DEST%

if exist "%DEST%\.git" (
  echo Папка уже есть — подтягиваю origin/main...
  git -C "%DEST%" fetch origin
  if errorlevel 1 goto :fail
  if exist "%DEST%\.git\" (
    git -C "%DEST%" checkout main
    if errorlevel 1 goto :fail
    git -C "%DEST%" pull origin main
    if errorlevel 1 goto :fail
  ) else (
    git -C "%DEST%" merge --ff-only origin/main
    if errorlevel 1 goto :fail
  )
  goto :secrets
)

echo Создаю новую копию main...
cd /d "%HERE%"
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 goto :clone

git fetch origin
if errorlevel 1 goto :clone
set "NEWBR=local-pnl-copy-%RANDOM%"
git worktree add -b "!NEWBR!" "%DEST%" origin/main
if not errorlevel 1 goto :secrets

:clone
git clone --branch main "%REPO%" "%DEST%"
if errorlevel 1 goto :fail

:secrets
if not exist "%DEST%\dashboard\" (
  echo Нет папки dashboard в %DEST%
  goto :fail
)

call :copy_secret ".env"
call :copy_secret "users.json"

echo Останавливаю дашборд на порту 8787 и запускаю из новой папки...
cd /d "%DEST%\dashboard"
call start.cmd
exit /b %ERRORLEVEL%

:copy_secret
set "NAME=%~1"
if exist "%DEST%\dashboard\%NAME%" exit /b 0
if exist "%HERE%\dashboard\%NAME%" (
  copy /Y "%HERE%\dashboard\%NAME%" "%DEST%\dashboard\%NAME%" >nul
  echo Скопирован dashboard\%NAME% из текущей копии.
  exit /b 0
)
if exist "%USERPROFILE%\.cursor\worktrees\default\3pi8\dashboard\%NAME%" (
  copy /Y "%USERPROFILE%\.cursor\worktrees\default\3pi8\dashboard\%NAME%" "%DEST%\dashboard\%NAME%" >nul
  echo Скопирован dashboard\%NAME% из worktree Cursor.
  exit /b 0
)
if exist "C:\Apps\developer-hours-dashboard\dashboard\%NAME%" (
  copy /Y "C:\Apps\developer-hours-dashboard\dashboard\%NAME%" "%DEST%\dashboard\%NAME%" >nul
  echo Скопирован dashboard\%NAME% из C:\Apps\developer-hours-dashboard.
)
exit /b 0

:fail
echo.
echo Не удалось создать или обновить %DEST%
echo Нужны Git, доступ к GitHub и сеть.
pause
exit /b 1
