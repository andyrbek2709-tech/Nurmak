import {
  updateLeadStatus, getLeadById,
  getLeadsByStatus, getLeadsToday,
} from "../services/supabase.js";
import { initFafa, startMonitoring, stopMonitoring, isMonitoringActive, getFilters, setFilter, clearFilters, runOnce, buildMessage } from "../services/fafa.js";
import { initAtisu, startAtisuMonitoring, stopAtisuMonitoring, isAtisuMonitoringActive, getAtisuFilters, setAtisuFilter, clearAtisuFilters, runAtisuOnce, buildAtisuMessage } from "../services/atisu.js";

const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

// module-level bot reference for reminders
let _bot = null;
const reminders = new Map();

export function registerHandlers(bot) {
  _bot = bot;

  initFafa(bot);
  initAtisu(bot);

  bot.start(handleStart);

  // Commands must be registered before bot.on("text") — Telegraf runs middleware in order
  bot.command("new", (ctx) => handleOwnerList(ctx, "new", "🆕 Новые заявки"));
  bot.command("active", (ctx) => handleOwnerList(ctx, "in_progress", "🔄 В работе"));
  bot.command("today", handleOwnerToday);
  bot.command("monitor", handleMonitor);
  bot.command("filter", handleFilter);
  bot.command("search", handleSearchOnce);
  bot.command("atisu", handleAtisuFilter);
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

  const chatId = String(ctx.callbackQuery.message?.chat?.id);
  console.log(`Callback: action=${action} id=${id.substring(0, 8)} chatId=${chatId}`);

  try {
    const msgId = ctx.callbackQuery.message.message_id;

    if (action === "atisu") {
      await handleAtisuCallback(ctx, chatId, id);
      return;
    }

    if (action === "fset") {
      const field = id;
      if (field === "clear") {
        await clearFilters(chatId);
        await ctx.answerCbQuery("Фильтры сброшены");
        const isActive = await isMonitoringActive(chatId);
        await ctx.editMessageText(await buildFilterText(chatId), { reply_markup: buildFilterKeyboard(isActive) });
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
      } else if (field === "monitor") {
        const isActive = await isMonitoringActive(chatId);
        if (isActive) {
          await stopMonitoring(chatId);
          await ctx.answerCbQuery("Мониторинг остановлен");
        } else {
          await ctx.answerCbQuery("Мониторинг запущен!");
          await ctx.reply("▶️ Мониторинг запущен. Проверка каждые 5 минут.\nНовые грузы — сразу. Если ничего нового — раз в час.");
          startMonitoring(chatId).catch(err => {
            console.error("[FAFA] startMonitoring error:", err.message);
            ctx.telegram.sendMessage(chatId, `❌ Ошибка мониторинга: ${err.message}`).catch(() => {});
          });
        }
        const nowActive = await isMonitoringActive(chatId);
        await ctx.editMessageText(await buildFilterText(chatId), { reply_markup: buildFilterKeyboard(nowActive) }).catch(() => {});
      } else {
        const labels = { from: "Откуда (город или страна)", to: "Куда (город или страна)" };
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
  const isActive = await isMonitoringActive(chatId);
  return [
    `⚙️ Фильтры поиска FA-FA:`,
    ``,
    `🗺 Откуда: ${f.from || "любой"}`,
    `🗺 Куда: ${f.to || "любой"}`,
    ``,
    isActive ? `🟢 Мониторинг активен` : `⚫️ Мониторинг выключен`,
  ].join("\n");
}

function buildFilterKeyboard(isActive = false) {
  return {
    inline_keyboard: [
      [
        { text: "✏️ Откуда", callback_data: "fset:from" },
        { text: "✏️ Куда", callback_data: "fset:to" },
      ],
      [
        { text: "🔍 Найти сейчас", callback_data: "fset:search" },
        { text: "🗑 Сбросить всё", callback_data: "fset:clear" },
      ],
      [
        { text: isActive ? "⏹ Остановить мониторинг" : "▶️ Мониторинг каждые 5 мин", callback_data: "fset:monitor" },
      ],
    ],
  };
}

async function handleFilter(ctx) {
  const chatId = String(ctx.chat.id);
  const isActive = await isMonitoringActive(chatId);
  await ctx.reply(await buildFilterText(chatId), { reply_markup: buildFilterKeyboard(isActive) });
}

async function handleMonitor(ctx) {
  const chatId = String(ctx.chat.id);
  try {
    if (await isMonitoringActive(chatId)) {
      await stopMonitoring(chatId);
      await ctx.reply("⏹ Мониторинг остановлен.");
    } else {
      await ctx.reply("▶️ Мониторинг запущен. Проверка каждые 5 минут.\nНовые грузы — сразу. Если ничего нового — раз в час.");
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
    `📖 Команды бота`,
    ``,
    `━━━ FA-FA.KZ ━━━`,
    `/filter — фильтры + мониторинг FA-FA`,
    `/search — разовый поиск FA-FA`,
    ``,
    `━━━ ATI.SU ━━━`,
    `/atisu — фильтры + мониторинг ATI.SU`,
    ``,
    `Оба бота: проверка каждые 5 мин`,
    `Новый груз — сразу. Тишина — раз в час "нет новых".`,
    `Напишите - (минус) чтобы убрать фильтр.`,
  ].join("\n"));
}

// ─── Client handlers ─────────────────────────────────────────────────────────

export async function handleStart(ctx) {
  await ctx.reply(
    "Добрый день! 👋\n\n" +
    "Я ищу грузы на FA-FA.KZ и ATI.SU.\n\n" +
    "/filter — поиск и мониторинг FA-FA.KZ\n" +
    "/atisu — поиск и мониторинг ATI.SU\n" +
    "/help — все команды"
  );
}

export async function handleText(ctx) {
  const chatId = String(ctx.chat.id);
  const userMessage = ctx.message.text;
  if (!userMessage?.trim()) return;

  // FA-FA filter input
  const awaitField = filterAwait.get(chatId);
  if (awaitField) {
    filterAwait.delete(chatId);
    const value = userMessage.trim() === "-" ? null : userMessage.trim();
    await setFilter(chatId, awaitField, value);
    const labels = { from: "Откуда", to: "Куда" };
    const isActive = await isMonitoringActive(chatId);
    await ctx.reply(
      `${value ? `✅ Фильтр «${labels[awaitField]}» установлен: ${value}` : `✅ Фильтр «${labels[awaitField]}» убран`}\n\n${await buildFilterText(chatId)}`,
      { reply_markup: buildFilterKeyboard(isActive) }
    );
    return;
  }

  // ATI.SU filter input
  const atisuAwaitField = atisuFilterAwait.get(chatId);
  if (atisuAwaitField) {
    atisuFilterAwait.delete(chatId);
    const value = userMessage.trim() === "-" ? null : userMessage.trim();
    await setAtisuFilter(chatId, atisuAwaitField, value);
    const labels = { from: "Откуда", to: "Куда" };
    const isActive = await isAtisuMonitoringActive(chatId);
    await ctx.reply(
      `${value ? `✅ ATI.SU фильтр «${labels[atisuAwaitField]}» установлен: ${value}` : `✅ ATI.SU фильтр «${labels[atisuAwaitField]}» убран`}\n\n${await buildAtisuFilterText(chatId)}`,
      { reply_markup: buildAtisuFilterKeyboard(isActive) }
    );
    return;
  }

  await ctx.reply("Используйте /filter (FA-FA) или /atisu (ATI.SU) для поиска грузов.");
}

export async function handleVoice(ctx) {
  await ctx.reply("Голосовые сообщения не поддерживаются. Используйте /filter для поиска грузов.");
}

// ─── ATI.SU handlers ──────────────────────────────────────────────────────────

const atisuFilterAwait = new Map(); // chatId → "from" | "to"

async function buildAtisuFilterText(chatId) {
  const f = await getAtisuFilters(chatId);
  const isActive = await isAtisuMonitoringActive(chatId);
  return [
    `⚙️ Фильтры поиска ATI.SU:`,
    ``,
    `🗺 Откуда: ${f.from || "любой"}`,
    `🗺 Куда: ${f.to || "любой"}`,
    ``,
    isActive ? `🟢 Мониторинг активен` : `⚫️ Мониторинг выключен`,
  ].join("\n");
}

function buildAtisuFilterKeyboard(isActive = false) {
  return {
    inline_keyboard: [
      [
        { text: "✏️ Откуда", callback_data: "atisu:from" },
        { text: "✏️ Куда",   callback_data: "atisu:to"   },
      ],
      [
        { text: "🔍 Найти сейчас", callback_data: "atisu:search" },
        { text: "🗑 Сбросить",     callback_data: "atisu:clear"  },
      ],
      [
        { text: isActive ? "⏹ Остановить мониторинг" : "▶️ Мониторинг каждые 5 мин", callback_data: "atisu:monitor" },
      ],
    ],
  };
}

async function handleAtisuFilter(ctx) {
  const chatId = String(ctx.chat.id);
  const isActive = await isAtisuMonitoringActive(chatId);
  await ctx.reply(await buildAtisuFilterText(chatId), { reply_markup: buildAtisuFilterKeyboard(isActive) });
}

async function handleAtisuCallback(ctx, chatId, field) {
  if (field === "clear") {
    await clearAtisuFilters(chatId);
    await ctx.answerCbQuery("Фильтры сброшены");
    const isActive = await isAtisuMonitoringActive(chatId);
    await ctx.editMessageText(await buildAtisuFilterText(chatId), { reply_markup: buildAtisuFilterKeyboard(isActive) });
  } else if (field === "search") {
    await ctx.answerCbQuery("Ищу...");
    await ctx.reply("🔍 Запускаю поиск ATI.SU...");
    runAtisuOnce(chatId).then(async (items) => {
      if (!items.length) {
        await ctx.telegram.sendMessage(chatId, "ATI.SU: по вашим фильтрам ничего не найдено.");
        return;
      }
      for (const item of items) {
        await ctx.telegram.sendMessage(chatId, buildAtisuMessage(item)).catch(() => {});
      }
      await ctx.telegram.sendMessage(chatId, `✅ ATI.SU: найдено ${items.length} заявок.`);
    }).catch(async (err) => {
      await ctx.telegram.sendMessage(chatId, `❌ ATI.SU ошибка: ${err.message}`).catch(() => {});
    });
  } else if (field === "monitor") {
    const isActive = await isAtisuMonitoringActive(chatId);
    if (isActive) {
      await stopAtisuMonitoring(chatId);
      await ctx.answerCbQuery("Мониторинг остановлен");
    } else {
      await ctx.answerCbQuery("Мониторинг запущен!");
      await ctx.reply("▶️ ATI.SU мониторинг запущен. Проверка каждые 5 минут.");
      startAtisuMonitoring(chatId).catch(err => {
        console.error("[ATISU] startMonitoring error:", err.message);
        ctx.telegram.sendMessage(chatId, `❌ ATI.SU ошибка: ${err.message}`).catch(() => {});
      });
    }
    const nowActive = await isAtisuMonitoringActive(chatId);
    await ctx.editMessageText(await buildAtisuFilterText(chatId), { reply_markup: buildAtisuFilterKeyboard(nowActive) }).catch(() => {});
  } else {
    // from / to — ждём текстового ввода
    atisuFilterAwait.set(chatId, field);
    await ctx.answerCbQuery();
    const labels = { from: "Откуда (город или страна)", to: "Куда (город или страна)" };
    await ctx.reply(`Напишите значение для «${labels[field]}» (или «-» чтобы убрать):`);
  }
}

