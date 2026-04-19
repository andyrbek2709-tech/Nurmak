import { getContext, setContext, clearContext } from "../utils/state.js";
import { chat } from "../services/openai.js";
import { transcribeVoice } from "../services/whisper.js";
import {
  saveLead, updateLeadStatus, getLeadById,
  getLeadsByStatus, getLeadsToday, normalizePhone,
} from "../services/supabase.js";
import { getUser, upsertUser } from "../services/users.js";

const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

// module-level bot reference for reminders
let _bot = null;
const reminders = new Map();

export function registerHandlers(bot) {
  _bot = bot;

  bot.start(handleStart);
  bot.on("text", handleText);
  bot.on("voice", handleVoice);

  bot.command("new", (ctx) => handleOwnerList(ctx, "new", "🆕 Новые заявки"));
  bot.command("active", (ctx) => handleOwnerList(ctx, "in_progress", "🔄 В работе"));
  bot.command("today", handleOwnerToday);

  bot.on("callback_query", handleCallback);
}

// ─── Notification ────────────────────────────────────────────────────────────

function formatNotification(lead) {
  const short = lead.id.substring(0, 8);
  return [
    `🚛 Новая заявка`,
    ``,
    `🆔 ID: ${short}`,
    ``,
    `📍 Маршрут: ${lead.from_city || "—"} → ${lead.to_city || "—"}`,
    `📌 Адрес загрузки: ${lead.from_address || "—"}`,
    `📌 Адрес разгрузки: ${lead.to_address || "—"}`,
    `📦 Груз: ${lead.cargo || "—"}`,
    `Вес: ${lead.weight || "—"}`,
    `Объём: ${lead.volume || "—"}`,
    ``,
    `📅 Загрузка: ${lead.date_loading || "—"} (${lead.time_loading || "—"})`,
    `📅 Разгрузка: ${lead.time_unloading || "—"}`,
    ``,
    `⚙️ Погрузка: ${lead.need_loading || "—"}`,
    `⚙️ Разгрузка: ${lead.need_unloading || "—"}`,
    ``,
    `👤 Отправитель: ${lead.sender_name || "—"} ${lead.sender_phone || ""}`,
    `👤 Получатель: ${lead.receiver_name || "—"} ${lead.receiver_phone || ""}`,
    ``,
    `📝 Комментарий: ${lead.notes || "—"}`,
  ].join("\n");
}

function buildKeyboard(lead) {
  const phone = normalizePhone(lead.sender_phone) || normalizePhone(lead.receiver_phone);
  const id = lead.id;

  const rows = [
    [
      { text: "✅ Принять", callback_data: `accept:${id}` },
      { text: "❌ Отклонить", callback_data: `reject:${id}` },
    ],
    [
      { text: "⏱ 5 мин", callback_data: `delay5:${id}` },
      { text: "⏱ 15 мин", callback_data: `delay15:${id}` },
      { text: "⏱ 30 мин", callback_data: `delay30:${id}` },
    ],
  ];

  if (phone) {
    rows.push([{ text: "💬 WhatsApp", url: `https://wa.me/${phone}` }]);
  }

  return { inline_keyboard: rows };
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
    await ctx.answerCbQuery();

    const msgId = ctx.callbackQuery.message.message_id;

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

// ─── Client handlers ─────────────────────────────────────────────────────────

export async function handleStart(ctx) {
  clearContext(ctx.chat.id);
  await ctx.reply(
    "Добрый день! Я логистический менеджер по грузоперевозкам.\n\n" +
    "Расскажите о вашем грузе — откуда, куда и что везём?"
  );
}

export async function handleText(ctx) {
  const chatId = ctx.chat.id;
  const userMessage = ctx.message.text;
  if (!userMessage?.trim()) return;
  await processMessage(ctx, chatId, userMessage);
}

export async function handleVoice(ctx) {
  const chatId = ctx.chat.id;
  try {
    const text = await transcribeVoice(ctx);
    if (!text?.trim()) {
      await ctx.reply("Не расслышал. Попробуйте ещё раз или напишите текстом.");
      return;
    }
    await processMessage(ctx, chatId, text);
  } catch (err) {
    console.error("Voice transcription error:", err.message);
    await ctx.reply("Что-то пошло не так, давайте попробуем ещё раз.");
  }
}

async function processMessage(ctx, chatId, userText) {
  try {
    let messages = getContext(chatId) || [];
    const isFirstMessage = messages.length === 0;

    messages.push({ role: "user", content: userText });

    // On first message inject known user data into context
    if (isFirstMessage) {
      const user = await getUser(ctx.from.id).catch(() => null);
      if (user?.name || user?.phone) {
        const parts = [];
        if (user.name) parts.push(`Имя: ${user.name}`);
        if (user.phone) parts.push(`Телефон: ${user.phone}`);
        if (user.last_order_data) {
          const d = user.last_order_data;
          if (d.from) parts.push(`Прошлый маршрут: ${d.from} → ${d.to || "?"}`);
        }
        messages = [
          {
            role: "system",
            content: `[Данные клиента из базы]\n${parts.join("\n")}\n\nУточни у клиента: оставляем прежние контакты или нужно изменить?`,
          },
          ...messages,
        ];
      }
    }

    const result = await chat(messages);

    if (result.type === "function") {
      const saved = await saveLead({ ...result.args, client_chat_id: ctx.chat.id });

      await ctx.telegram.sendMessage(
        MANAGER_CHAT_ID,
        formatNotification(saved),
        { reply_markup: buildKeyboard(saved) }
      );

      scheduleReminder(saved.id, 5 * 60 * 1000); // first reminder in 5 min, then every 5 min

      // Save user profile for future orders
      await upsertUser(ctx.from.id, {
        name: result.args.sender_name,
        phone: result.args.sender_phone,
        lastOrderData: {
          from: result.args.from,
          to: result.args.to,
          cargo: result.args.cargo,
        },
      }).catch(() => {});

      await ctx.reply("Спасибо! Заявка принята 👍\nС вами скоро свяжутся.");
      clearContext(chatId);
      console.log(`Lead saved: ${saved.id}`);
    } else {
      messages.push({ role: "assistant", content: result.content });
      setContext(chatId, messages);
      await ctx.reply(result.content);
    }
  } catch (err) {
    console.error("Processing error:", err.message, err.stack);
    await ctx.reply("Что-то пошло не так, давайте попробуем ещё раз.");
  }
}
