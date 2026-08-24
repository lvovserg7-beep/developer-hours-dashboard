# Дашборд часов по задачам разработчика

Приложение для компании Аллсан Интеграция. Берёт данные из 1С и показывает часы по задачам разработчика и активность в чате.

Стабильная версия: [v1.5.0](https://github.com/lvovserg7-beep/developer-hours-dashboard/releases/tag/v1.5.0)

Репозиторий: [https://github.com/lvovserg7-beep/developer-hours-dashboard](https://github.com/lvovserg7-beep/developer-hours-dashboard)

Страница обновляется раз в 10 минут. Вход по логину и паролю. Две вкладки: **Часы** (графики в работе и выполненные по клиентам, аналитикам и разработчикам) и **Активность** (задачи в работе, клиент, статус, последний комментарий, фильтры). У администратора есть третья вкладка **Админка** — создание пользователей и права на вкладки. Режим «На весь экран» масштабирует исходную сетку графиков, без мобильной вёрстки столбиком. Клик по номеру задачи копирует навигационную ссылку 1С. На самой странице адрес сервиса 1С не показывается. `start.cmd` перед запуском сам останавливает старый процесс на порту 8787.

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

https://github.com/lvovserg7-beep/developer-hours-dashboard/releases/tag/v1.5.0

В PowerShell:

```powershell
cd C:\Apps
git clone --branch v1.5.0 https://github.com/lvovserg7-beep/developer-hours-dashboard.git
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

Откроется страница входа. Первый администратор создаётся при первом запуске:

- логин — `DASHBOARD_ADMIN_LOGIN` из `dashboard\.env`, иначе `admin`;
- пароль — `DASHBOARD_ADMIN_PASSWORD`, если задан; иначе одноразовый пароль печатается в консоли (`First admin password: …`).

Пользователи хранятся в `dashboard\users.json` (в git не попадает). В админке можно завести обычных пользователей, включить им вкладки **Часы** и **Активность** и выдать права администратора.

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

### Обновить боевой компьютер (вместо ZIP)

Рабочая папка в Cursor и боевой каталог — разные копии. На боевую **не** копировать архив с рабочего стола. Берут стабильный тег из этого руководства (файл `STABLE`, сейчас **v1.5.0**).

Репозиторий закрытый: на боевой машине нужен Git и вход в GitHub (окно Git Credential Manager при первом `git clone` / `git fetch`).

**Один раз**, если сейчас там распакованный ZIP:

1. Остановите `start.cmd`.
2. Скопируйте в сторону `dashboard\.env` и `dashboard\users.json` (если уже есть вход в дашборд).
3. Переименуйте старую папку, например в `C:\Apps\developer-hours-dashboard.bak`.
4. Клон стабильной версии:

```powershell
cd C:\Apps
git clone --branch v1.5.0 https://github.com/lvovserg7-beep/developer-hours-dashboard.git
```

5. Верните `.env` и `users.json` в `C:\Apps\developer-hours-dashboard\dashboard\`.
6. Запустите `C:\Apps\developer-hours-dashboard\dashboard\start.cmd`.

**Дальше**, когда в руководстве новая стабильная версия:

```
C:\Apps\developer-hours-dashboard\dashboard\update-stable.cmd
```

Скрипт берёт тег из файла `STABLE`, подтягивает его с GitHub и перезапускает сервер. `.env` и `users.json` git не трогает. Другой тег вручную: `update-stable.cmd v1.5.0`.

Если Git на боевой недоступен — только ZIP **релиза** (Source code у страницы стабильной версии), распаковать поверх той же папки, не затирая `.env` и `users.json`. Не использовать ZIP рабочей копии Cursor.
