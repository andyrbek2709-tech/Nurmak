# STATE — Nurmak Bot

> Живой журнал. Обновляется при каждом значимом изменении. Источник правды между сессиями Claude.

## Текущее состояние

- **Прод:** https://nurmak-production.up.railway.app/ — Railway проект `patient-sparkle / InstitutPro` (по факту: `789c93ee-6126-424c-9d1a-6c6ad113f637`)
- **Стек:** Node.js (ESM), Telegraf, Playwright, OpenAI (GPT-4o-mini + Whisper), Supabase, Railway
- **Репо:** `andyrbek2709-tech/Nurmak`, ветка `main`
- **Последний рабочий коммит:** `814aa33` — fix: restore truncated package.json (Railway nixpacks build was failing) (2026-04-27 08:01:21)
- **Env (Railway):** `BOT_TOKEN`, `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_KEY`, `MANAGER_CHAT_ID`, `WEBHOOK_DOMAIN`, `FAFA_LOGIN`, `FAFA_PASSWORD`, `ATISU_LOGIN`, `ATISU_PASSWORD`
- Команды: `/filter /search /monitor /stop /new /active /today /help`

## Известные проблемы

- При сбое page.evaluate() в ATISU fallback бот может крашиться, если не `await extractItemsDom(page)` (исправлено в `1ae900d`).
- Node 18 deprecated в `@supabase/supabase-js`, добавили `engines: node>=20`.

## Следующие шаги

- [ ] (заполнится по мере работы)

## Последние изменения (новые сверху)

### 2026-04-27 18:42 — chore: добавлен STATE.md (память проекта)
- **Что:** введён единый протокол памяти через STATE.md в репо. Любая сессия Claude (Cowork, Sonnet code chat, Claude Code, claude.ai) теперь читает этот файл первым делом и обновляет после каждого значимого изменения.
- **Файлы:** `STATE.md` (новый), `CLAUDE.md` (дополнен/создан с правилами).
- **Деплой:** не требуется, документация.
- **Почему:** чтобы память о проекте переживала сессии и переходила между разными чатами Claude через git.

## Недавние коммиты (контекст до начала ведения STATE.md)

- `814aa33` fix: restore truncated package.json (Railway nixpacks build was failing) (2026-04-27 08:01:21 +0000)
- `1ae900d` fix(atisu): await extractItemsDom before browser.close to prevent promise rejection (2026-04-27 06:55:29 +0000)
- `6a9015a` docs: diagnostic toolkit + 2026-04-26 changelog (2026-04-26 12:40:16 +0500)
