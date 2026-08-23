@echo off
cd /d "%~dp0"
if not exist ".env" if not exist "odata.env" (
  copy /Y ".env.example" ".env" >nul
  echo.
  echo Создан файл .env. Впишите логин и пароль OData из 1С, сохраните и закройте блокнот.
  echo Не используйте Windows-учётку этого компьютера — нужен пользователь публикации OData.
  echo.
  notepad ".env"
)
echo Starting dashboard...
echo Локально:  http://localhost:8787/
echo В сети:    http://192.168.10.240:8787/  (если брандмауэр закрыт — запустите open-firewall.cmd от администратора)
node server.mjs
if errorlevel 1 (
  echo.
  echo Запуск не удался. Код 401 значит: логин или пароль OData не приняты сервером 1С.
  echo Возьмите ODATA_DB_TRADE_USERNAME и ODATA_DB_TRADE_PASSWORD из mcp.json на рабочей машине с Cursor.
  pause
)
