Бизнес-контекст в .business/ — читай .business/INDEX.md

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

Telegram-бот для поиска грузоперевозок. Пользователь задаёт фильтры (откуда / куда / тип груза / транспорт), бот скрапит два сайта и возвращает список грузов. Есть мониторинг каждые 5 минут.

**Стек:** Node.js (ESM), Telegraf, Playwright, OpenAI (GPT-4o-mini + Whisper), Supabase, Railway (деплой).

---

## Структура

```
src/
├── index.js              — Express + Telegraf webhook / long-polling
├── bot/
│   ├── handlers.js       — команды /filter /search /monitor и логика диалога
│   └── prompts.js        — системный промпт + function schema для GPT
├── services/
│   ├── fafa.js           — скрапер FA-FA.KZ (Playwright, авторизация, DOM)
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

## Что реализовано

- Поиск грузов на **FA-FA.KZ** — работает, Playwright + DOM-парсинг, авторизация через cookie
- Поиск грузов на **ATI.SU** — работает, Playwright + перехват XHR-ответа `/loads/search`
- Оба скрапера запускаются **последовательно** (сначала FA-FA.KZ, затем ATI.SU) — экономия RAM
- Фильтры: откуда / куда / тип груза / тип транспорта — двухшаговый выбор через inline-кнопки
- Мониторинг — проверка каждые 5 мин, уведомление о новых грузах; "тишина" раз в час
- Сбор заявок через голос (Whisper) и текст (GPT function calling) → сохранение в Supabase
- Менеджерские команды: /new /active /today
- Деплой на Railway, webhook через HTTPS

---

## Ключевые технические решения ATI.SU

### Перехват API (page.route)
```javascript
await page.route(/\/loads\/search(\?|$)/, async (route) => {
  const resp = await route.fetch();          // запрос выполняется с куками браузера
  const json = await resp.json().catch(() => null);
  if (json?.loads) capturedLoads = json;
  await route.fulfill({ response: resp });   // ответ возвращается странице
});
```
`waitForResponse()` не используем — гонка данных: `resp.json()` разрешается после того, как вызывающий код уже прочёл пустой массив.

### Сессия (storageState)
```javascript
// Загрузка: contextOpts.storageState = "/tmp/atisu_session.json"
// Сохранение после логина: await context.storageState({ path: SESSION_PATH })
```
Файл живёт в `/tmp/` — эфемерный на Railway, пересоздаётся при первом запросе нового контейнера.

### page.evaluate() — только один аргумент
```javascript
// СЛОМАНО: page.evaluate((a, b) => {...}, val1, val2)
// ПРАВИЛЬНО:
await page.evaluate(({ txt, sel }) => {...}, { txt: best, sel: optSel });
```

### Пропуск страновых значений в фильтрах ATI.SU
ATI.SU принимает только города. Если `to = "Россия"` — пропускаем:
```javascript
const COUNTRY_NAMES = new Set(["Россия","Казахстан","Беларусь",...]);
const toVal = toRaw && !COUNTRY_NAMES.has(toRaw) ? toRaw : null;
```

### Структура ответа /loads/search
| Поле | JSON-путь |
|------|-----------|
| from | `loading.location.city` + `route.country[0]` → ATI_COUNTRY |
| to | `unloading.location.city` + `route.country[-1]` → ATI_COUNTRY |
| cargo | `loading.loadingCargos[0].name` или `load.cargoType` |
| weight | `load.weight` / `load.volume` |
| truck_type | `truck.carTypes[]` → битовые ID → ATI_CAR_TYPE map |
| price | `rate.sum` (если > 0) иначе `rate.rateType` / `rate.negotiation` |
| distance | `route.distance` |
| time | `loading.firstDate` / `loading.lastDate` |

---

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `BOT_TOKEN` | Telegram Bot Token |
| `OPENAI_API_KEY` | OpenAI API Key |
| `SUPABASE_URL` | URL проекта Supabase |
| `SUPABASE_KEY` | service_role ключ |
| `MANAGER_CHAT_ID` | Chat ID менеджера |
| `WEBHOOK_DOMAIN` | `https://<app>.up.railway.app` (без слэша) |
| `ATISU_LOGIN` | Логин ATI.SU |
| `ATISU_PASSWORD` | Пароль ATI.SU |

---

## Деплой

Railway (GitHub → автодеплой). `postinstall` устанавливает Chromium: `playwright install --with-deps chromium`.
Без `WEBHOOK_DOMAIN` — long-polling (локально). С `WEBHOOK_DOMAIN` — webhook-режим.
