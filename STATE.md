# STATE — Nurmak Bot

> Живой журнал. Обновляется при каждом значимом изменении. Источник правды между сессиями Claude.

## Текущее состояние

- **Прод:** https://nurmak-production.up.railway.app/ — Railway проект `patient-sparkle / InstitutPro` (по факту: `789c93ee-6126-424c-9d1a-6c6ad113f637`)
- **Стек:** Node.js (ESM), Telegraf, Playwright, OpenAI (GPT-4o-mini + Whisper), Supabase, Railway
- **Репо:** `andyrbek2709-tech/Nurmak`, ветка `main`
- **Последний рабочий коммит (origin/main):** `22166a8` — фикс Railway/Playwright (`channel: "chromium"`), чтобы скрейперы не падали на старте.
- **Env (Railway):** `BOT_TOKEN`, `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`, `MANAGER_CHAT_ID`, `WEBHOOK_DOMAIN`, `FAFA_LOGIN`, `FAFA_PASSWORD`, `ATISU_LOGIN`, `ATISU_PASSWORD`
- Команды: `/filter /search /monitor /stop /new /active /today /help`

## Известные проблемы

- При сбое page.evaluate() в ATISU fallback бот может крашиться, если не `await extractItemsDom(page)` (исправлено в `1ae900d`).
- Node 18 deprecated в `@supabase/supabase-js`, добавили `engines: node>=20`.

## Следующие шаги

- [ ] (заполнится по мере работы)

## Последние изменения (новые сверху)

### 2026-05-04 — hardening: fail-fast по env + alert на повторные падения browser launch
- **Проблема:** повторяющиеся инциденты из-за конфигурации (`FAFA_LOGIN ` с пробелом) и тихие падения Playwright launch в проде.
- **Что сделано:** в `src/index.js` обязательными сделаны `FAFA_*` и `ATISU_*`; добавлена проверка env-ключей на пробелы по краям с аварийным `process.exit(1)`; в `src/services/fafa.js` добавлен счётчик повторных `browserType.launch` ошибок и алерт менеджеру при серии с cooldown.
- **Ожидаемый эффект:** сервис падает сразу с понятной причиной при кривом env (а не работает «полусломанно»), а при деградации браузера менеджер узнаёт автоматически.

### 2026-05-04 — fix(fafa): автоповтор с укороченным городом при `blank=1`
- **Проблема:** часть пользовательских фильтров хранится как «город + регион» (например, `Актау Мангистау, Казахстан`), что на FA-FA часто даёт `search_load/?blank=1`.
- **Что сделано:** если первичный FA-FA поиск вернул 0, выполняется один retry с укороченными токенами города (первое слово) и повторным submit формы.
- **Ожидаемый эффект:** меньше ложных нулей FA-FA для «грязных» гео-строк из ручного ввода.

### 2026-05-04 — ops: исправлена переменная Railway `FAFA_LOGIN` (удалён ключ с пробелом)
- **Проблема:** в переменных окружения был ключ `FAFA_LOGIN ` (с пробелом в конце), поэтому приложение считало, что логин FA-FA отсутствует, и писало `login form present but no credentials`.
- **Что сделано:** добавлен корректный `FAFA_LOGIN`, удалён ошибочный ключ `FAFA_LOGIN ` через Railway CLI.
- **Результат:** логин FA-FA снова выполняется в проде (`[FAFA] login successful` в логах).

### 2026-05-04 — fix(playwright/railway): запуск Chromium через channel=chromium
- **Проблема:** в прод-логах Railway массово падал `chromium_headless_shell` с `SIGTRAP` (`browserType.launch: Target page, context or browser has been closed`), из-за этого оба скрейпера (FA-FA и ATI) возвращали 0.
- **Что сделано:** в `src/services/fafa.js` и `src/services/atisu.js` в `chromium.launch(...)` добавлен `channel: "chromium"` (используем полный Chromium вместо headless_shell).
- **Ожидаемый эффект:** браузер стабильно стартует на Railway, `/search` и мониторинг снова дают реальные результаты вместо постоянного нуля.

### 2026-05-04 — fix(fafa): после логина возврат на /search_load/ + мониторинг «нет новых» с диагностикой
- **Проблема:** после `doLogin` FA-FA.KZ часто редиректит с `/search_load/` — форма `#search1`/`#search10` оказывается не на странице → пустая выдача; плюс пользователи путают почасовое «нет новых» с поломкой скрейпера.
- **Что сделано:** при успешном логине, если URL не `search_load`, снова `goto(SEARCH_URL)`; при ошибке логина при заданных `FAFA_*` — не продолжать анонимный поиск по FA-FA (вернуть `[]`); текст hourly-сообщения с пояснением + счётчики FA-FA/ATI; лог `tick … scraped/fresh/matched`; заголовок карточки `Новое направление (сайт)` без лишнего переноса.

### 2026-04-27 18:42 — chore: добавлен STATE.md (память проекта)
- **Что:** введён единый протокол памяти через STATE.md в репо. Любая сессия Claude (Cowork, Sonnet code chat, Claude Code, claude.ai) теперь читает этот файл первым делом и обновляет после каждого значимого изменения.
- **Файлы:** `STATE.md` (новый), `CLAUDE.md` (дополнен/создан с правилами).
- **Деплой:** не требуется, документация.
- **Почему:** чтобы память о проекте переживала сессии и переходила между разными чатами Claude через git.

## Недавние коммиты (контекст до начала ведения STATE.md)

- `814aa33` fix: restore truncated package.json (Railway nixpacks build was failing) (2026-04-27 08:01:21 +0000)
- `1ae900d` fix(atisu): await extractItemsDom before browser.close to prevent promise rejection (2026-04-27 06:55:29 +0000)
- `6a9015a` docs: diagnostic toolkit + 2026-04-26 changelog (2026-04-26 12:40:16 +0500)
