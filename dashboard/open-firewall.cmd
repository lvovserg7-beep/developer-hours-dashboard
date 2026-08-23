@echo off
echo Правило брандмауэра: входящий TCP 8787 для дашборда.
echo Запустите этот файл от имени администратора.
echo.
netsh advfirewall firewall delete rule name="Developer hours dashboard 8787" >nul 2>&1
netsh advfirewall firewall add rule name="Developer hours dashboard 8787" dir=in action=allow protocol=TCP localport=8787 profile=any
if errorlevel 1 (
  echo Не удалось. Щёлкните файл правой кнопкой — «Запуск от имени администратора».
  pause
  exit /b 1
)
echo Готово. С другого компьютера в той же сети откройте:
echo   http://192.168.10.240:8787/
echo Окно start.cmd на этом компьютере должно быть открыто.
pause
