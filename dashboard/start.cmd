@echo off
cd /d "%~dp0"
if not exist "odata.env" (
  copy /Y "odata.env.example" "odata.env" >nul
  echo.
  echo Создан файл odata.env. Впишите логин и пароль OData, сохраните и закройте блокнот.
  echo.
  notepad "odata.env"
)
echo Starting dashboard...
node server.mjs
if errorlevel 1 (
  echo.
  echo Запуск не удался. Проверьте odata.env и доступ к trade.alsn.ru.
  pause
)
