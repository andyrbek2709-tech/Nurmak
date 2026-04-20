# Nurmak Bot — Telegram-бот для сбора заявок на грузоперевозки

## Что делает бот

1. **Собирает заявки** от клиентов через голос и текст (OpenAI Whisper + GPT-4o-mini)
2. **Ищет грузы** на FA-FA.KZ и ATI.SU по фильтрам пользователя
3. **Мониторит** новые грузы каждые 5 минут и уведомляет в реальном времени
4. **Сохраняет лиды** в Supabase и уведомляет менеджера

## Архитектура

```
Telegram → Webhook → Express/Telegraf
                        ├── Whisper API        (голос → текст)
                        ├── OpenAI GPT-4o-mini (диалог + function calling → лиды)
                        ├── Supabase           (хранение лидов + фильтров)
                        └── Playwright Scraper
                               ├── FA-FA.KZ   (авторизация + поиск)
                               └── ATI.SU     (авторизация + поиск + DOM-парсинг)
```

## Структура проекта

```
src/
├── index.js              # Express-сервер + Telegraf webhook
├── bot/
│   ├── handlers.js       # Обработка text/voice + фильтры + поиск + мониторинг
│   └── prompts.js        # Системный промпт + function schema для GPT
├── services/
│   ├── fafa.js           # Скрапер FA-FA.KZ + оркестратор поиска (runOnce, tick)
│   ├── atisu.js          # Скрапер ATI.SU (Playwright, авторизация, DOM-парсинг)
│   ├── openai.js         # Chat completion с function calling
│   ├── whisper.js        # Голос → текст через Whisper API
│   ├── supabase.js       # Supabase клиент + CRUD для лидов и настроек
│   └── users.js          # Управление пользователями в Supabase
└── utils/
    ├── timing.js          # delay() и rand() — общие хелперы задержек
    └── state.js           # In-memory контекст диалогов (TTL 30 мин)
```

## Telegram-команды

| Команда | Описание |
|---|---|
| `/filter` | Настройка фильтров (Откуда / Куда / Тип груза / Транспорт) |
| `/search` | Разовый поиск по текущим фильтрам |
| `/monitor` | Запустить / остановить мониторинг (проверка каждые 5 мин) |
| `/new` | Новые заявки — только для менеджера |
| `/active` | Заявки в работе — только для менеджера |
| `/today` | Заявки за сегодня — только для менеджера |
| `/help` | Справка |

## Как работает поиск грузов

1. Пользователь задаёт фильтры через `/filter` (страна → город, двухшаговый выбор)
2. Нажимает **Найти сейчас** — бот скрапит FA-FA.KZ и ATI.SU последовательно
3. Результаты фильтруются по заданным параметрам и отправляются в Telegram
4. При мониторинге — новые грузы приходят сразу; если ничего нового — уведомление раз в час

## Быстрый старт (локально)

```bash
npm install
cp .env.example .env
# заполнить .env
npm run dev
```

Для локального webhook нужен HTTPS — используй [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
# обновить WEBHOOK_DOMAIN в .env
```

## Переменные окружения

| Переменная | Описание |
|---|---|
| `BOT_TOKEN` | Telegram Bot Token от @BotFather |
| `OPENAI_API_KEY` | OpenAI API Key |
| `SUPABASE_URL` | URL проекта Supabase |
| `SUPABASE_KEY` | service_role ключ Supabase |
| `MANAGER_CHAT_ID` | Chat ID менеджера (только он видит /new, /active, /today) |
| `WEBHOOK_DOMAIN` | `https://<app>.up.railway.app` (без слэша в конце) |
| `ATISU_LOGIN` | Логин / email аккаунта на ATI.SU |
| `ATISU_PASSWORD` | Пароль аккаунта на ATI.SU |

## Деплой на Railway

1. Запушить в GitHub
2. **railway.app → New Project → Deploy from GitHub repo**
3. Добавить все переменные окружения в **Variables**
4. Railway сам запустит `npm start` и установит Chromium через `postinstall`

> `postinstall` выполняет `playwright install --with-deps chromium` — первый старт занимает дольше обычного.

### CLI-деплой

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## Примечания по скраперам

- Оба скрапера работают **последовательно** (сначала FA-FA.KZ, затем ATI.SU) — снижает пиковое потребление памяти
- ATI.SU: жёсткий таймаут 120 секунд; при ошибке бот отвечает результатами только с FA-FA.KZ
- ATI.SU требует авторизацию — задай `ATISU_LOGIN` и `ATISU_PASSWORD` в Railway Variables

## Технические решения ATI.SU (scraper)

### 1. Перехват API через `page.route()` вместо `waitForResponse()`

ATI.SU делает XHR-запросы к `/loads/search` — результаты забираются через перехватчик маршрутов:

```javascript
await page.route(/\/loads\/search(\?|$)/, async (route) => {
  const resp = await route.fetch();           // выполнить запрос через браузер (с куками)
  const json = await resp.json().catch(() => null);
  if (json?.loads) capturedLoads = json;
  await route.fulfill({ response: resp });    // вернуть ответ странице
});
```

**Почему не `waitForResponse()`**: асинхронное чтение `resp.json()` в обработчике `page.on('response')` завершалось ПОСЛЕ того как код-вызыватель уже читал пустой массив — гонка данных. `page.route()` блокирует передачу до завершения обработчика.

### 2. Сохранение сессии через `storageState`

```javascript
// Загрузка сохранённой сессии (cookies + localStorage)
if (existsSync(SESSION_PATH)) {
  contextOpts.storageState = SESSION_PATH;
}
// После успешного логина — сохранить
await context.storageState({ path: SESSION_PATH });
```

Файл `/tmp/atisu_session.json` создаётся при первом старте контейнера (Railway ephemeral storage). Повторные запросы в рамках одного деплоя используют сохранённую сессию и не логинятся заново.

### 3. Логин в React SPA

ATI.SU не имеет стандартного `button[type="submit"]`. Используется поиск кнопки по тексту:

```javascript
const candidates = [
  "button:has-text('Войти')", "button:has-text('Продолжить')",
  "button:has-text('Далее')", "button[type='submit']", "form button",
];
```

После клика ждём редирект с `id.ati.su` через `Promise.all([waitForURL, click])`.

Двухшаговая форма (email → пароль) обрабатывается автоматически: если поле пароля не видно — сначала отправляем email.

### 4. `page.evaluate()` — только один аргумент

Playwright принимает ровно один аргумент в `page.evaluate()`. Несколько значений оборачиваются в объект:

```javascript
// ОШИБКА: "Too many arguments"
await page.evaluate((txt, sel) => {...}, best, optSel);

// ПРАВИЛЬНО:
await page.evaluate(({ txt, sel }) => {...}, { txt: best, sel: optSel });
```

### 5. Фильтр городов — пропуск страновых значений

ATI.SU принимает только города в поле поиска. Если фильтр содержит только название страны (например `to: "Россия"`), значение пропускается:

```javascript
const COUNTRY_NAMES = new Set(["Россия", "Казахстан", "Беларусь", ...]);
const toVal = toRaw && !COUNTRY_NAMES.has(toRaw) ? toRaw : null;
```

### 6. Структура данных ATI.SU API

Поля ответа `/loads/search`:

| Поле в боте | Источник в JSON |
|---|---|
| `from` | `loading.location.city` + `route.country[0]` |
| `to` | `unloading.location.city` + `route.country[-1]` |
| `cargo` | `loading.loadingCargos[0].name` или `load.cargoType` |
| `weight` | `load.weight` / `load.volume` |
| `truck_type` | `truck.carTypes[]` → битовые ID → `ATI_CAR_TYPE` |
| `price` | `rate.sum` (если > 0) или `rate.rateType` |
| `distance` | `route.distance` |
| `time` | `loading.firstDate` / `loading.lastDate` |
