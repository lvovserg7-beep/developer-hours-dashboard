# Дашборд часов по задачам разработчика

Приложение для компании Аллсан Интеграция. Берёт данные из 1С и показывает часы по задачам разработчика и активность в чате.

Стабильная версия: [v1.2.0](https://github.com/lvovserg7-beep/developer-hours-dashboard/releases/tag/v1.2.0)

Репозиторий: [https://github.com/lvovserg7-beep/developer-hours-dashboard](https://github.com/lvovserg7-beep/developer-hours-dashboard)

Страница обновляется раз в 10 минут. Две вкладки: **Часы** (пять графиков) и **Активность** (задачи в работе, статус, последний комментарий). Есть режим «На весь экран». Клик по номеру задачи копирует навигационную ссылку 1С. На самой странице адрес сервиса 1С не показывается.

## Правила отбора

- Статусы — по реквизиту **Порядок**, не по названию.
- В работе: номера 1–6. Выполненные: 7 и выше.
- Отложенные часы в работу не входят. В блоке «Отложено» — только задачи со статусом 1–6.
- «Часов в работе по статусам» — реквизит **Часы**.
- «Часов в работе по разработчикам» — реквизит **Часы разработки**, не общие «Часы» задачи.

## Запуск на управляемом компьютере с Windows

На той машине это обычная программа на Node.js: код с GitHub, доступ в 1С и запуск `start.cmd`. Cursor ставить не нужно.

### Что должно быть на компьютере

1. **Windows 10/11** с интернетом до `https://trade.alsn.ru` (DNS и порт 443).
2. **Node.js LTS** с [https://nodejs.org](https://nodejs.org) — при установке оставьте галочку «Add to PATH». Проверка в командной строке: `node -v`.
3. **Git** с [https://git-scm.com](https://git-scm.com) (удобно для копии с GitHub). Можно вместо этого скачать ZIP релиза.

IIS не обязателен. Дашборд сам слушает порт **8787**.

### Что положить на диск

Стабильная версия:

https://github.com/lvovserg7-beep/developer-hours-dashboard/releases/tag/v1.2.0

В PowerShell:

```powershell
cd C:\Apps
git clone --branch v1.2.0 https://github.com/lvovserg7-beep/developer-hours-dashboard.git
```

Или скачайте Source code (zip) у релиза и распакуйте, например в `C:\Apps\developer-hours-dashboard`.

Паролей в репозитории нет. Их задаёте на этой машине сами.

### Доступ к 1С (обязательно)

На чистой Windows **нет** файла Cursor `%USERPROFILE%\.cursor\mcp.json`. Самый простой способ — файл рядом с программой:

1. Скопируйте `dashboard\.env.example` в `dashboard\.env`.
2. Откройте `.env` в блокноте и укажите логин и пароль OData:

```
ODATA_DB_TRADE_BASE_URL=https://trade.alsn.ru/trade/odata/standard.odata/
ODATA_DB_TRADE_USERNAME=логин
ODATA_DB_TRADE_PASSWORD=пароль
```

Если запустить `start.cmd` без `.env`, скрипт сам создаст файл из образца и откроет блокнот.

Можно вместо файла задать переменные среды Windows:

| Имя | Значение |
|---|---|
| `ODATA_DB_TRADE_BASE_URL` | `https://trade.alsn.ru/trade/odata/standard.odata/` |
| `ODATA_DB_TRADE_USERNAME` | логин OData из 1С |
| `ODATA_DB_TRADE_PASSWORD` | пароль OData из 1С |

Путь: Параметры Windows → Система → О программе → Дополнительные параметры системы → Переменные среды.

Если на компьютере уже стоит Cursor и есть `%USERPROFILE%\.cursor\mcp.json` с сервером `1c-odata`, программа возьмёт данные оттуда.

Логин и пароль — те же, что у публикации OData 1С. Файл `.env` в git не попадает. Не подставляйте Windows-учётку компьютера.

### Запуск

1. Закройте и снова откройте командную строку (чтобы подхватились переменные среды).
2. Запустите:

```
C:\Apps\developer-hours-dashboard\dashboard\start.cmd
```

или:

```
cd C:\Apps\developer-hours-dashboard\dashboard
node server.mjs
```

3. Окно не закрывайте — это и есть сервер.
4. В браузере **Google Chrome или Microsoft Edge**: http://localhost:8787/

Не открывайте в Internet Explorer — графики там не обновляются.

Если в консоли `Dashboard http://localhost:8787/` — всё хорошо. Если ошибка про `mcp.json` — нет файла `.env` (или пустые логин/пароль). Если `401` или таймаут — нет доступа к 1С (логин, пароль или сеть).

### Чтобы открывалось с других компьютеров в сети

Адрес вида `http://192.168.10.240:8787/` работает только **в той же локальной сети** (или по VPN). Из интернета этот адрес не открывается.

На компьютере, где запущен дашборд, один раз от администратора:

```
C:\Apps\developer-hours-dashboard\dashboard\open-firewall.cmd
```

Или вручную в PowerShell от администратора:

```
netsh advfirewall firewall add rule name="Developer hours dashboard 8787" dir=in action=allow protocol=TCP localport=8787 profile=any
```

Окно `start.cmd` не закрывайте. С другого компьютера откройте в Chrome или Edge: `http://192.168.10.240:8787/`

### Чтобы поднималось после перезагрузки

Планировщик заданий Windows:

- Триггер: «При входе в систему» или «При запуске компьютера».
- Действие: запуск `C:\Apps\developer-hours-dashboard\dashboard\start.cmd`.
- Галочка «Выполнять независимо от регистрации пользователя», если нужно без входа.
- Рабочая папка: `...\dashboard`.

Либо ярлык `start.cmd` в автозагрузке пользователя.

### Что ставить не нужно

- Cursor
- npm-пакеты (`npm install` нет)
- SQL, Python, IIS — для этой версии не требуются

Коротко: Node.js → клон репозитория → файл `dashboard\.env` с логином и паролем 1С → `dashboard\start.cmd` → браузер на порт 8787.
