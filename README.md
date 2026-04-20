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
