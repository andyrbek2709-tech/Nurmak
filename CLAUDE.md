Бизнес-контекст в .business/ — читай .business/INDEX.md

## Правило работы

**Доделывай до конца перед деплоем.** Не пуши промежуточные изменения с просьбой "проверь логи" или "посмотри что будет". Пуши только тогда, когда задача решена полностью. Если нужна диагностика — сначала разберись в коде, потом делай решение, потом пуши.

## Итог каждого чата

В конце каждого разговора обязательно пиши итог на русском языке в следующем формате:

---
**Задача:** [что было поставлено]
**Решена:** да / нет / частично
**Эффективность решения:** [коротко — оптимально ли, есть ли лучший способ]
**Было:** [как было до]
**Стало:** [как стало после]
---

---

## Проект: Nurmak Bot

Telegram-бот для поиска грузоперевозок. Пользователь задаёт фильтры для каждого сайта отдельно, бот скрапит FA-FA.KZ и ATI.SU и возвращает список грузов. Есть мониторинг каждые 5 минут — работает до явной команды `/stop`, переживает рестарты Railway.

**Стек:** Node.js (ESM), Telegraf, Playwright, OpenAI (GPT-4o-mini + Whisper), Supabase, Railway (деплой).

---

## Системы и доступы — читай это перед любой задачей

| Система | Роль | Как задействована |
|---|---|---|
| **Telegram Bot** | Интерфейс пользователя | Webhook (Railway) или long-polling (локально) |
| **FA-FA.KZ** | Источник грузов #1 | Playwright + DOM-парсинг, авторизация через `FAFA_LOGIN` / `FAFA_PASSWORD` |
| **ATI.SU** | Источник грузов #2 | Playwright + перехват XHR `/loads/search`, авторизация через `ATISU_LOGIN` / `ATISU_PASSWORD` |
| **Supabase** | База данных | Лиды + настройки пользователей (`loadBotSetting` / `saveBotSetting`) |
| **Railway** | Хостинг | GitHub → автодеплой при пуше в `main`. Chromium ставится через `postinstall` |
| **GitHub** | Репозиторий | `andyrbek2709-tech/Nurmak`, ветка `main` |
| **OpenAI** | AI-обработка | GPT-4o-mini (диалог, function calling), Whisper (голос → текст) |

**Деплой = git push origin main.** Railway подхватывает автоматически. Ничего руками настраивать не нужно.

**Переменные окружения** (все заданы в Railway Variables):

| Переменная | Назначение |
|---|---|
| `BOT_TOKEN` | Telegram Bot Token |
| `OPENAI_API_KEY` | OpenAI API Key |
| `SUPABASE_URL` | URL проекта Supabase |
| `SUPABASE_KEY` | service_role ключ |
| `MANAGER_CHAT_ID` | Chat ID менеджера (только он видит /new /active /today) |
| `WEBHOOK_DOMAIN` | `https://<app>.up.railway.app` (без слэша) |
| `FAFA_LOGIN` | Логин FA-FA.KZ |
| `FAFA_PASSWORD` | Пароль FA-FA.KZ |
| `ATISU_LOGIN` | Логин ATI.SU |
| `ATISU_PASSWORD` | Пароль ATI.SU |

---

## Структура

```
src/
├── index.js              — Express + Telegraf webhook / long-polling
├── bot/
│   ├── handlers.js       — команды /filter /search /monitor /stop и логика диалога
│   └── prompts.js        — системный промпт + function schema для GPT
├── services/
│   ├── fafa.js           — скрапер FA-FA.KZ + оркестратор (scrape, runOnce, tick, мониторинг)
│   ├── atisu.js          — скрапер ATI.SU (Playwright, API-перехват, auth)
│   ├── openai.js         — chat completion + function calling
│   ├── whisper.js        — голос → текст
│   ├── supabase.js       — CRUD лидов и настроек
│   └── users.js          — управление пользователями
└── utils/
    ├── timing.js         — delay(), rand()
    └── state.js          — in-memory контекст диалогов (TTL 30 мин)
```

---

## Что реализовано (актуальное состояние)

- Поиск грузов на **FA-FA.KZ** — Playwright + DOM-парсинг, авторизация через cookie
- Поиск грузов на **ATI.SU** — Playwright + перехват XHR-ответа `/loads/search`, жёсткий timeout 120 сек
- Оба скрапера запускаются **последовательно** — экономия RAM
- **Раздельные фильтры** для каждого сайта: FA-FA.KZ и ATI.SU настраиваются независимо
- **Фильтры:** откуда / куда / тип транспорта (мульти-выбор) / тоннаж (т) / объём (м³)
- Фильтр груза — **удалён**
- **Мульти-выбор транспорта:** интерактивные чекбоксы (✅), OR-логика фильтрации
- **Тоннаж / объём:** одно число = максимум («5» = до 5 т), диапазон «10-20» = от 10 до 20
- **Мониторинг** — проверка каждые 5 мин, уведомление о новых; тишина раз в час
- Мониторинг **переживает рестарты Railway** — список активных пользователей сохраняется в Supabase (ключ `active_monitors`), восстанавливается при старте
- Команды мониторинга: `/monitor` запускает, `/stop` останавливает
- Сбор заявок через голос (Whisper) и текст (GPT function calling) → Supabase
- Менеджерские команды: `/new` `/active` `/today`
- Деплой: Railway, webhook через HTTPS

---

## Структура фильтров (fafa.js)

```javascript
u.filters = {
  fafa:  { from, to, truck_type, weight, volume },  // null = не задано
  atisu: { from, to, truck_type, weight, volume },
}
```

`truck_type` — строка через запятую: `"тент,рефр"` (OR-логика при фильтрации).
`weight` / `volume` — строка: `"5"` (до 5) или `"10-20"` (диапазон).

Supabase-ключ: `filters_{chatId}`. Есть миграция старого формата (flat → per-site).

---

## Telegram-команды

| Команда | Описание |
|---|---|
| `/filter` | Настройка фильтров — отдельно для FA-FA.KZ и ATI.SU |
| `/search` | Разовый поиск по текущим фильтрам |
| `/monitor` | Запустить мониторинг (каждые 5 мин, бессрочно) |
| `/stop` | Остановить мониторинг |
| `/new` | Новые заявки — только менеджер |
| `/active` | Заявки в работе — только менеджер |
| `/today` | Заявки за сегодня — только менеджер |
| `/help` | Справка |

---

## Callback_data форматы (handlers.js)

| callback_data | Действие |
|---|---|
| `fsite:fafa` / `fsite:atisu` | Открыть подменю сайта |
| `fset:fafa:from` / `fset:atisu:to` | Редактировать поле |
| `fset:fafa:truck_type` | Открыть мульти-выбор транспорта |
| `fset:fafa:weight` / `fset:fafa:volume` | Ввод тоннажа / объёма (текстом) |
| `fset:fafa:back` | Назад на главный экран фильтров |
| `fset:fafa:clear_site` | Сбросить все поля одного сайта |
| `fset:search` / `fset:clear` / `fset:monitor` | Глобальные действия |
| `fsel:fafa:from:Казахстан` | Выбор страны |
| `fsel:fafa:from:manual` / `:clear` | Ручной ввод / убрать фильтр |
| `ftrk:fafa:toggle:тент` | Переключить тип транспорта |
| `ftrk:fafa:done` / `:clear` | Сохранить / сбросить выбор |

---

## Ключевые технические решения ATI.SU

### Перехват API (page.route)
```javascript
await page.route(/\/loads\/search(\?|$)/, async (route) => {
  const resp = await route.fetch();
  const json = await resp.json().catch(() => null);
  if (json?.loads) capturedLoads = json;
  await route.fulfill({ response: resp });
});
```
`waitForResponse()` не используем — гонка данных.

### Сессия (storageState)
```javascript
// contextOpts.storageState = "/tmp/atisu_session.json"
// await context.storageState({ path: SESSION_PATH })
```
`/tmp/` — эфемерный на Railway, пересоздаётся при новом контейнере.

### page.evaluate() — только один аргумент
```javascript
// СЛОМАНО: page.evaluate((a, b) => {...}, val1, val2)
// ПРАВИЛЬНО:
await page.evaluate(({ txt, sel }) => {...}, { txt: best, sel: optSel });
```

### Страны в фильтрах
- **ATI.SU** принимает только города. Если `to = "Россия"` — пропускаем `city_end`, пост-фильтр через `COUNTRY_ALIASES` ловит "RU".
- **FA-FA.KZ** принимает страну текстом. `city_end="Россия"` → сервер сам фильтрует, title результатов "Грузы Актау→Россия (найдено N шт.)". НЕ пропускать страны для FA-FA.KZ — без `city_end` сайт вернёт все 70+ грузов из города отправления, и пост-фильтр их все срежет.
- **FA-FA.KZ** для поиска логин не нужен — заявки видны анонимно. `doLogin` вызывать только если есть `FAFA_LOGIN`/`FAFA_PASSWORD`, ловить ошибку и продолжать без авторизации.

---

## Мониторинг-персистентность (fafa.js)

```javascript
// При старте (initFafa): читаем Supabase, восстанавливаем мониторинг для каждого chatId
async function restoreMonitoring() { ... }

// При startMonitoring: добавляем chatId в set → сохраняем в Supabase
// При stopMonitoring: удаляем chatId из set → сохраняем в Supabase
async function saveMonitorList(set) {
  await saveBotSetting("active_monitors", JSON.stringify([...set]));
}
```

---

## Диагностика — какие инструменты использовать и в каком порядке

Когда что-то ломается, **не правь код наугад**. Сначала пойми что происходит. Порядок:

### 1. Запусти скрапер локально (быстрее всего, видно сразу что отдаёт сайт)

```bash
# Один раз поставить Chromium (если не было)
"C:\Program Files\nodejs\npx.cmd" playwright install chromium

# Запустить разовый диагностический скрипт
& "C:\Program Files\nodejs\node.exe" diag_fafa.js
```

Скрипт `diag_fafa.js` — временный, создаётся под конкретную задачу и удаляется после: launches Playwright с теми же фильтрами что у пользователя, дампит `forms`/`inputs`/`selects`, кликает по полям, сохраняет HTML результата (`fafa_results.html`) и скриншот. Локальный запуск показывает: какие поля принимает форма, что появляется в autocomplete, какой URL после submit, какой title (`найдено N шт.`), все ли результаты на странице или есть пагинация.

**Это нашло корневую причину FA-FA.KZ за минуту:** title "найдено 70 шт." + все маршруты KZ→KZ → проблема не в скрапере, а в том что мы не передавали страну в форму.

### 2. Логи Railway через GraphQL API

Токен лежит в `~/.railway/config.json` → `user.accessToken`, истекает каждые ~30 минут.

```bash
TOKEN=$(grep -oE '"accessToken":\s*"[^"]+' ~/.railway/config.json | cut -d'"' -f4)
curl -s -X POST https://backboard.railway.com/graphql/v2 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ deploymentLogs(deploymentId: \"<ID>\", limit: 200, filter: \"FAFA\") { timestamp message } }"}'
```

ID Nurmak (закэшированы):
- workspace: `b45388e2-f11d-4739-9e50-6bb21588125f`
- project: `789c93ee-6126-424c-9d1a-6c6ad113f637`
- service: `61a2ff81-36ce-42c2-97b0-86f8a0655a46`
- environment (production): `6e687022-7ea6-4499-93fd-5b2c51e2b130`

Также `variables(projectId, environmentId, serviceId)` — выдаёт все env vars (имена + значения).

### 3. Тестирование бота через webhook без участия пользователя

```bash
# 1. baseline: отправить контрольное сообщение, запомнить message_id
curl https://api.telegram.org/bot<TOKEN>/sendMessage -d "chat_id=<MGR>" -d "text=BASELINE"
# 2. отправить fake update в webhook
curl -X POST https://nurmak-production.up.railway.app/webhook/<TOKEN> \
  -H "Content-Type: application/json" \
  -d '{"update_id":..., "callback_query":{"id":"...","from":{...},"message":{...},"data":"fset:search"}}'
# 3. подождать ~3 мин (FAFA до 90с + ATI до 120с + sequential)
# 4. отправить endpoint message, посчитать gap
# gap = (endpoint_id − baseline_id − 1) = число сообщений от бота
```

Структура сообщений при `/search`: 1 (header) + N (items) + 1 (footer). Если gap=4 → 2 items, gap=5 → 3 items, и т.д.

### 4. Чтение содержимого Telegram-сообщений (бот не имеет getHistory)

```bash
# forwardMessage возвращает Message object с полным text — используй для проверки что именно отправил бот
curl https://api.telegram.org/bot<TOKEN>/forwardMessage \
  -d "chat_id=<MGR>" -d "from_chat_id=<MGR>" -d "message_id=<MID>" -d "disable_notification=true"
```

### 5. Чтение пользовательских фильтров из Supabase

`SELECT key, value FROM bot_settings WHERE key = 'filters_<chatId>';` — возвращает JSON фильтра. Понадобится чтобы понять что именно ищет пользователь, не догадываясь.

### Чего не делать
- Не пушить «добавил логи, посмотри» — сначала диагностика локально/через API, потом фикс, потом пуш
- Не пытаться угадывать секретные значения env vars — спрашивай или не трогай
- Не интерпретировать `gap=4` как «работает» — нужно forwardMessage и реально прочитать тексты, чтобы убедиться что заявки от обоих сайтов

---

## Changelog

### 2026-04-26
- **FA-FA.KZ принимает страны текстом** — `city_end="Россия"` → сервер сам фильтрует, title "Грузы Актау→Россия". Удалены `extractCity()` и `COUNTRY_NAMES_LC`, баг был в том что страны пропускались и сайт возвращал все 70 грузов из Актау (KZ→KZ), пост-фильтр всё срезал
- **FA-FA.KZ login сделан опциональным** — анонимный пользователь видит заявки, `doLogin` вызывается только если `FAFA_LOGIN`+`FAFA_PASSWORD` оба заданы; на ошибке логина продолжаем без авторизации
- **Восстановлен event-dispatch fillSearchForm** — `inp.dispatchEvent(input/keyup/change)` вместо `pressSequentially`; даже если `div.av1` autocomplete не появился, текстовое значение `City[1]`/`city_end` всё равно отправляется и сервер парсит

### 2026-04-25
- **Раздельные фильтры FA-FA.KZ / ATI.SU** — `u.filters = { fafa: {...}, atisu: {...} }` вместо одного объекта
- **Мульти-выбор типа транспорта** — интерактивные чекбоксы, OR-логика, `truckPending` Map
- **Убран фильтр груза** — не нужен, загромождал UI
- **Добавлены фильтры тоннаж и объём** — `weight`, `volume`; одно число = максимум
- **Мониторинг переживает рестарты** — список активных мониторов сохраняется в Supabase (`active_monitors`)
- **Команда `/stop`** — явная остановка мониторинга без toggle
- **Исправлен `clear_site`** — сбрасывает `weight`/`volume` вместо удалённого `cargo`
