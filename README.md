# Nurmak Bot — Telegram-бот для сбора заявок на грузоперевозки

## Архитектура

```
Telegram → Webhook → Express/Telegraf
                        ├── Whisper API (голос → текст)
                        ├── OpenAI GPT-4o-mini (диалог + function calling)
                        └── Supabase (сохранение leads + уведомление менеджера)
```

## Структура проекта

```
src/
├── index.js              # Express сервер + Telegraf webhook
├── bot/
│   ├── handlers.js       # Обработка text/voice сообщений
│   └── prompts.js        # Системный промпт + function schema
├── services/
│   ├── openai.js         # Chat completion с function calling
│   ├── whisper.js        # Голос → текст через Whisper API
│   └── supabase.js       # Insert в таблицу leads
└── utils/
    └── state.js          # In-memory контекст диалогов (TTL 30 мин)
```

## Быстрый старт (локально)

### 1. Установить зависимости

```bash
npm install
```

### 2. Создать .env файл

```bash
cp .env.example .env
```

Заполнить все переменные в `.env`.

### 3. Создать таблицу в Supabase

Открыть **Supabase Dashboard → SQL Editor** и выполнить:

```sql
-- Содержимое файла supabase/migrations/001_create_leads.sql
```

### 4. Запустить бота

```bash
npm run dev
```

Для работы webhook локально нужен HTTPS. Используйте [ngrok](https://ngrok.com/):

```bash
ngrok http 3000
```

Обновите `WEBHOOK_DOMAIN` в `.env` на URL от ngrok.

## Деплой на Railway

### Вариант 1: Через GitHub

1. Запушить код в GitHub репозиторий
2. Открыть [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Выбрать репозиторий
4. Railway автоматически определит Node.js и запустит `npm start`

### Вариант 2: Через CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Настройка переменных окружения

В **Railway Dashboard → Variables** добавить:

| Переменная | Описание |
|---|---|
| `BOT_TOKEN` | Telegram Bot Token от @BotFather |
| `OPENAI_API_KEY` | OpenAI API Key |
| `SUPABASE_URL` | URL проекта Supabase |
| `SUPABASE_KEY` | service_role ключ Supabase |
| `MANAGER_CHAT_ID` | Chat ID менеджера |
| `WEBHOOK_DOMAIN` | `https://<app-name>.up.railway.app` |

После деплоя Railway назначит домен. Обновите `WEBHOOK_DOMAIN` на этот домен — бот автоматически установит webhook при следующем рестарте.

## Настройка Telegram Bot

### Создать бота

1. Открыть [@BotFather](https://t.me/BotFather)
2. Отправить `/newbot`
3. Указать имя и username
4. Скопировать **BOT_TOKEN**

### Получить Chat ID менеджера

1. Отправить `/start` боту [@userinfobot](https://t.me/userinfobot)
2. Скопировать **Id** → это `MANAGER_CHAT_ID`

### Установить webhook вручную (опционально)

Бот устанавливает webhook автоматически при запуске. Если нужно вручную:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<WEBHOOK_DOMAIN>/webhook/<BOT_TOKEN>"
```

## Как работает

1. **Клиент отправляет текст или голос** → Telegram отправляет webhook на сервер
2. **Голос** → скачивается .ogg файл → отправляется в Whisper API → получается текст
3. **Текст** → добавляется в контекст диалога → отправляется в OpenAI с function calling
4. **OpenAI решает:**
   - Данных недостаточно → отвечает текстом с уточняющим вопросом
   - Данных достаточно → вызывает функцию `save_lead` с JSON
5. **JSON сохраняется** в Supabase таблицу `leads`
6. **Менеджер получает уведомление** в Telegram с полной информацией