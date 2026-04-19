import {
  updateLeadStatus, getLeadById,
  getLeadsByStatus, getLeadsToday,
} from "../services/supabase.js";
import { initFafa, startMonitoring, stopMonitoring, isMonitoringActive, getFilters, setFilter, clearFilters, runOnce, buildMessage } from "../services/fafa.js";

const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

// module-level bot reference for reminders
let _bot = null;
const reminders = new Map();

export function registerHandlers(bot) {
  _bot = bot;

  initFafa(bot);

  bot.start(handleStart);

  // Commands must be registered before bot.on("text") — Telegraf runs middleware in order
  bot.command("new", (ctx) => handleOwnerList(ctx, "new", "🆕 Новые заявки"));
  bot.command("active", (ctx) => handleOwnerList(ctx, "in_progress", "🔄 В работе"));
  bot.command("today", handleOwnerToday);
  bot.command("monitor", handleMonitor);
  bot.command("filter", handleFilter);
  bot.command("search", handleSearchOnce);
  bot.command("help", handleHelp);

  bot.on("text", handleText);
  bot.on("voice", handleVoice);
  bot.on("callback_query", handleCallback);
}


// ─── Reminders ───────────────────────────────────────────────────────────────

const REPEAT_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

function cancelReminder(leadId) {
  const existing = reminders.get(leadId);
  if (existing) { clearTimeout(existing); reminders.delete(leadId); }
}

function scheduleReminder(leadId, firstDelayMs) {
  cancelReminder(leadId);

  const short = leadId.substring(0, 8);

  const tick = async () => {
    try {
      const lead = await getLeadById(leadId);
      if (lead.status !== "new") { reminders.delete(leadId); return; }

      await _bot.telegram.sendMessage(
        MANAGER_CHAT_ID,
        `⏰ Заявка ${short} всё ещё не обработана! Примите решение.`
      );

      // Schedule next tick in 5 minutes
      const id = setTimeout(tick, REPEAT_INTERVAL_MS);
      reminders.set(leadId, id);
    } catch (err) {
      console.error("Reminder error:", err.message);
      reminders.delete(leadId);
    }
  };

  const id = setTimeout(tick, firstDelayMs);
  reminders.set(leadId, id);
}

// ─── Callbacks ───────────────────────────────────────────────────────────────

async function handleCallback(ctx) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const [action, ...rest] = data.split(":");
  const id = rest.join(":");
  if (!id) return;

  const chatId = ctx.callbackQuery.message?.chat?.id;
  console.log(`Callback: action=${action} id=${id.substring(0, 8)} chatId=${chatId}`);

  try {
    const msgId = ctx.callbackQuery.message.message_id;

    if (action === "fset") {
      const field = id;
      if (field === "clear") {
        await clearFilters(chatId);
        await ctx.answerCbQuery("Фильтры сброшены");
        await ctx.editMessageText(await buildFilterText(chatId), { reply_markup: buildFilterKeyboard() });
      } else if (field === "search") {
        await ctx.answerCbQuery("Ищу...");
        await ctx.reply("🔍 Запускаю поиск по текущим фильтрам...");
        runOnce(chatId).then(async (items) => {
          if (!items.length) {
            await ctx.telegram.sendMessage(chatId, "По вашим фильтрам ничего не найдено.");
            return;
          }
          for (const item of items) {
            await ctx.telegram.sendMessage(chatId, buildMessage(item)).catch(() => {});
          }
          await ctx.telegram.sendMessage(chatId, `✅ Найдено ${items.length} заявок.`);
        }).catch(async (err) => {
          await ctx.telegram.sendMessage(chatId, `❌ Ошибка поиска: ${err.message}`).catch(() => {});
        });
      } else {
        const labels = { from: "Откуда (город)", to: "Куда (город)", cargo: "Тип груза", truck_type: "Тип машины (Тент, Рефрижератор, Бортовой...)" };
        filterAwait.set(String(chatId), field);
        await ctx.answerCbQuery();
        await ctx.reply(`Напишите значение для «${labels[field] || field}» (или «-» чтобы убрать фильтр):`);
      }
      return;
    }

    await ctx.answerCbQuery();

    if (action === "accept") {
      const lead = await getLeadById(id);
      await updateLeadStatus(id, "in_progress");
      cancelReminder(id);
      await ctx.telegram.editMessageReplyMarkup(chatId, msgId, undefined, { inline_keyboard: [] });
      await ctx.telegram.sendMessage(chatId, `✅ Заявка ${id.substring(0, 8)} принята в работу.`);
      if (lead.client_chat_id) {
        await ctx.telegram.sendMessage(lead.client_chat_id, "Заявка принята в работу ✅\n\nВаш запрос уже обрабатывается.\nС вами скоро свяжутся для уточнения деталей 📞").catch(() => {});
      }
    } else if (action === "reject") {
      const lead = await getLeadById(id);
      await updateLeadStatus(id, "canceled");
      cancelReminder(id);
      await ctx.telegram.editMessageReplyMarkup(chatId, msgId, undefined, { inline_keyboard: [] });
      await ctx.telegram.sendMessage(chatId, `❌ Заявка ${id.substring(0, 8)} отклонена.`);
      if (lead.client_chat_id) {
        await ctx.telegram.sendMessage(lead.client_chat_id, "К сожалению, по вашей заявке не смогли подобрать транспорт. Попробуйте изменить условия или свяжитесь с нами напрямую.").catch(() => {});
      }
    } else if (action === "delay5" || action === "delay15" || action === "delay30") {
      const minutes = action === "delay5" ? 5 : action === "delay15" ? 15 : 30;
      await ctx.telegram.editMessageReplyMarkup(chatId, msgId, undefined, { inline_keyboard: [] });
      await ctx.telegram.sendMessage(chatId, `⏱ Напомним через ${minutes} минут.`);
      scheduleReminder(id, minutes * 60 * 1000);
    }
  } catch (err) {
    console.error("Callback error:", err.message, err.stack);
    await ctx.answerCbQuery("Ошибка").catch(() => {});
  }
}

// ─── Owner commands ───────────────────────────────────────────────────────────

async function handleOwnerList(ctx, status, title) {
  try {
    const leads = await getLeadsByStatus(status);
    if (!leads.length) { await ctx.reply(`${title}: нет заявок.`); return; }

    const lines = leads.map(l =>
      `🆔 ${l.id.substring(0, 8)} | ${l.from_city || "?"} → ${l.to_city || "?"} | ${l.cargo || "?"} | ${l.sender_phone || "?"}`
    );
    await ctx.reply(`${title}:\n\n${lines.join("\n")}`);
  } catch (err) {
    console.error("Owner list error:", err.message);
  }
}

async function handleOwnerToday(ctx) {
  try {
    const leads = await getLeadsToday();
    if (!leads.length) { await ctx.reply("За сегодня заявок нет."); return; }

    const lines = leads.map(l =>
      `🆔 ${l.id.substring(0, 8)} | ${l.from_city || "?"} → ${l.to_city || "?"} | ${l.status}`
    );
    await ctx.reply(`За сегодня (${leads.length}):\n\n${lines.join("\n")}`);
  } catch (err) {
    console.error("Today error:", err.message);
  }
}

// ─── Filter state machine ─────────────────────────────────────────────────────
// Tracks which filter field the owner is currently setting
const filterAwait = new Map(); // chatId → "from" | "to" | "cargo"

async function buildFilterText(chatId) {
  const f = await getFilters(chatId);
  return [
    `⚙️ Фильтры поиска FA-FA:`,
    ``,
    `🗺 Откуда: ${f.from || "любой"}`,
    `🗺 Куда: ${f.to || "любой"}`,
    `📦 Груз: ${f.cargo || "любой"}`,
    `🚛 Тип машины: ${f.truck_type || "любой"}`,
  ].join("\n");
}

function buildFilterKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "✏️ Откуда", callback_data: "fset:from" },
        { text: "✏️ Куда", callback_data: "fset:to" },
      ],
      [
        { text: "✏️ Груз", callback_data: "fset:cargo" },
        { text: "🚛 Тип машины", callback_data: "fset:truck_type" },
      ],
      [
        { text: "🔍 Найти сейчас", callback_data: "fset:search" },
        { text: "🗑 Сбросить всё", callback_data: "fset:clear" },
      ],
    ],
  };
}

async function handleFilter(ctx) {
  const chatId = String(ctx.chat.id);
  await ctx.reply(await buildFilterText(chatId), { reply_markup: buildFilterKeyboard() });
}

async function handleMonitor(ctx) {
  const chatId = String(ctx.chat.id);
  try {
    if (await isMonitoringActive(chatId)) {
      await stopMonitoring(chatId);
      await ctx.reply("⏹ Мониторинг fa-fa.kz остановлен.");
    } else {
      await ctx.reply("▶️ Мониторинг fa-fa.kz запущен. Проверка каждые 3 минуты.");
      startMonitoring(chatId).catch(err => {
        console.error("[FAFA] startMonitoring error:", err.message);
        ctx.telegram.sendMessage(chatId, `❌ Ошибка мониторинга: ${err.message}`).catch(() => {});
      });
    }
  } catch (err) {
    console.error("Monitor command error:", err.message);
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
}

async function handleSearchOnce(ctx) {
  const chatId = String(ctx.chat.id);
  await ctx.reply("🔍 Запускаю поиск по текущим фильтрам...");
  try {
    const items = await runOnce(chatId);
    if (!items.length) { await ctx.reply("По вашим фильтрам ничего не найдено."); return; }
    for (const item of items) {
      await ctx.reply(buildMessage(item));
    }
    await ctx.reply(`✅ Найдено ${items.length} заявок.`);
  } catch (err) {
    await ctx.reply(`❌ Ошибка: ${err.message}`);
  }
}

async function handleHelp(ctx) {
  await ctx.reply([
    `📖 Команды бота FA-FA.KZ`,
    ``,
    `/filter — настроить фильтры поиска`,
    `   🗺 Откуда / Куда — город или страна`,
    `   📦 Груз — тип груза`,
    `   🚛 Тип машины — Тент, Рефрижератор, Бортовой...`,
    `   🔍 Найти сейчас — разовый поиск`,
    `   Напишите - (минус) чтобы убрать фильтр`,
    ``,
    `/search — разовый поиск по текущим фильтрам`,
    `/monitor — запустить / остановить мониторинг`,
    `   Бот проверяет сайт каждые 3 минуты`,
    `   и присылает вам новые грузы`,
  ].join("\n"));
}

// ─── Client handlers ─────────────────────────────────────────────────────────

export async function handleStart(ctx) {
  await ctx.reply(
    "Добрый день! 👋\n\n" +
    "Я помогаю искать грузы на FA-FA.KZ.\n\n" +
    "Используйте /filter чтобы настроить фильтры и найти грузы.\n" +
    "Используйте /monitor чтобы получать уведомления о новых грузах.\n\n" +
    "/help — все команды"
  );
}

export async function handleText(ctx) {
  const chatId = String(ctx.chat.id);
  const userMessage = ctx.message.text;
  if (!userMessage?.trim()) return;

  // If user is setting a filter field — intercept
  const awaitField = filterAwait.get(chatId);
  if (awaitField) {
    filterAwait.delete(chatId);
    const value = userMessage.trim() === "-" ? null : userMessage.trim();
    await setFilter(chatId, awaitField, value);
    const labels = { from: "Откуда", to: "Куда", cargo: "Груз", truck_type: "Тип машины" };
    await ctx.reply(
      `${value ? `✅ Фильтр «${labels[awaitField]}» установлен: ${value}` : `✅ Фильтр «${labels[awaitField]}» убран`}\n\n${await buildFilterText(chatId)}`,
      { reply_markup: buildFilterKeyboard() }
    );
    return;
  }

  await ctx.reply("Используйте /filter для поиска грузов или /help для списка команд.");
}

export async function handleVoice(ctx) {
  await ctx.reply("Голосовые сообщения не поддерживаются. Используйте /filter для поиска грузов.");
}

