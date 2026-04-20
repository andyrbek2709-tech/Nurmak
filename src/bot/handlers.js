import {
  updateLeadStatus, getLeadById,
  getLeadsByStatus, getLeadsToday,
} from "../services/supabase.js";
import { initFafa, startMonitoring, stopMonitoring, isMonitoringActive, getFilters, setFilter, clearFilters, runOnce, buildMessage } from "../services/fafa.js";

const MANAGER_CHAT_ID = String(process.env.MANAGER_CHAT_ID);

let _bot = null;
const reminders = new Map();

export function clearAllReminders() {
  for (const id of reminders.values()) clearTimeout(id);
  reminders.clear();
}

export function registerHandlers(bot) {
  _bot = bot;

  initFafa(bot);

  bot.start(handleStart);

  // Commands must be registered before bot.on("text") — Telegraf runs middleware in order
  const ownerOnly = (fn) => (ctx) => {
    if (String(ctx.chat?.id) !== MANAGER_CHAT_ID) return;
    return fn(ctx);
  };
  bot.command("new", ownerOnly((ctx) => handleOwnerList(ctx, "new", "🆕 Новые заявки")));
  bot.command("active", ownerOnly((ctx) => handleOwnerList(ctx, "in_progress", "🔄 В работе")));
  bot.command("today", ownerOnly(handleOwnerToday));
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

  const chatId = String(ctx.callbackQuery.message?.chat?.id);
  console.log(`Callback: action=${action} id=${id.substring(0, 8)} chatId=${chatId}`);

  try {
    const msgId = ctx.callbackQuery.message.message_id;

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
        // from / to → show country selection keyboard
        const labels = { from: "Откуда", to: "Куда" };
        await ctx.answerCbQuery();
        await ctx.reply(`${labels[field] || field}: выберите страну:`, { reply_markup: buildCountryKeyboard(field) });
      }
      return;
    }

    if (action === "fsel") {
      // id = "from:Казахстан" or "to:clear" etc.
      const colonIdx = id.indexOf(":");
      const field   = id.substring(0, colonIdx);
      const country = id.substring(colonIdx + 1);
      if (country === "clear") {
        await setFilter(chatId, field, null);
        await ctx.answerCbQuery("Фильтр убран");
        const isActive = await isMonitoringActive(chatId);
        await ctx.editMessageText(await buildFilterText(chatId), { reply_markup: buildFilterKeyboard(isActive) }).catch(() => {});
      } else if (country === "manual") {
        filterPending.set(chatId, { field, country: null });
        await ctx.answerCbQuery();
        const labels = { from: "Откуда", to: "Куда" };
        await ctx.reply(`Введите «${labels[field]}» вручную (например: «Алматы, Казахстан» или «-» чтобы убрать):`);
      } else {
        filterPending.set(chatId, { field, country });
        await ctx.answerCbQuery();
        const flag = { Казахстан: "🇰🇿", Россия: "🇷🇺", Беларусь: "🇧🇾", Узбекистан: "🇺🇿" }[country] || "🌍";
        await ctx.reply(
          `${flag} ${country}\n\nВведите город (или «-» чтобы искать по всей стране без уточнения города):`
        );
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
// chatId → { field, country|null } — pending text input for filter wizard
const filterPending = new Map();

async function buildFilterText(chatId) {
  const f = await getFilters(chatId);
  const isActive = await isMonitoringActive(chatId);
  return [
    `⚙️ Фильтры поиска (FA-FA.KZ + ATI.SU):`,
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
        { text: "✏️ Куда",   callback_data: "fset:to"   },
      ],
      [
        { text: "🔍 Найти сейчас", callback_data: "fset:search" },
        { text: "🗑 Сбросить всё", callback_data: "fset:clear"  },
      ],
      [
        { text: isActive ? "⏹ Остановить мониторинг" : "▶️ Мониторинг каждые 5 мин", callback_data: "fset:monitor" },
      ],
    ],
  };
}

function buildCountryKeyboard(field) {
  const p = `fsel:${field}`;
  return {
    inline_keyboard: [
      [
        { text: "🇰🇿 Казахстан",  callback_data: `${p}:Казахстан`  },
        { text: "🇷🇺 Россия",     callback_data: `${p}:Россия`     },
      ],
      [
        { text: "🇧🇾 Беларусь",   callback_data: `${p}:Беларусь`   },
        { text: "🇺🇿 Узбекистан", callback_data: `${p}:Узбекистан` },
      ],
      [
        { text: "🌍 Другая страна (введу сам)", callback_data: `${p}:manual` },
        { text: "❌ Убрать фильтр",             callback_data: `${p}:clear`  },
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
    `/filter — фильтры и мониторинг (FA-FA.KZ + ATI.SU)`,
    `/search — разовый поиск по обоим сайтам`,
    ``,
    `Проверка каждые 5 мин. Новый груз — сразу.`,
    `Если ничего нового — раз в час "нет новых".`,
    `Напишите - (минус) чтобы убрать фильтр.`,
  ].join("\n"));
}

// ─── Client handlers ─────────────────────────────────────────────────────────

export async function handleStart(ctx) {
  await ctx.reply(
    "Добрый день! 👋\n\n" +
    "Я ищу грузы на FA-FA.KZ и ATI.SU одновременно.\n\n" +
    "/filter — поиск и мониторинг\n" +
    "/help — все команды"
  );
}

export async function handleText(ctx) {
  const chatId = String(ctx.chat.id);
  const userMessage = ctx.message.text?.trim();
  if (!userMessage) return;

  const labels = { from: "Откуда", to: "Куда" };

  const pending = filterPending.get(chatId);
  if (pending) {
    filterPending.delete(chatId);
    const { field, country } = pending;
    let value;
    if (country) {
      // country→city flow: "-" means search whole country
      value = userMessage === "-" ? country : `${userMessage}, ${country}`;
    } else {
      // manual entry flow: "-" clears the filter
      value = userMessage === "-" ? null : userMessage;
    }
    await setFilter(chatId, field, value);
    const isActive = await isMonitoringActive(chatId);
    await ctx.reply(
      `${value ? `✅ ${labels[field]}: ${value}` : `✅ Фильтр «${labels[field]}» убран`}\n\n${await buildFilterText(chatId)}`,
      { reply_markup: buildFilterKeyboard(isActive) }
    );
    return;
  }

  await ctx.reply("Используйте /filter для поиска грузов.");
}

export async function handleVoice(ctx) {
  await ctx.reply("Голосовые сообщения не поддерживаются. Используйте /filter для поиска грузов.");
}


