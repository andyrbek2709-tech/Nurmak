import { getContext, setContext, clearContext } from "../utils/state.js";
import { chat } from "../services/openai.js";
import { transcribeVoice } from "../services/whisper.js";
import {
  saveLead, updateLeadStatus, getLeadById,
  getLeadsByStatus, getLeadsToday, normalizePhone,
} from "../services/supabase.js";

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
    [{ text: "⏸ Отложить", callback_data: `delay:${id}` }],
  ];

  if (phone) {
    rows[1].unshift({ text: "📞 Позвонить", url: `tel:+${phone}` });
    rows.push([{ text: "💬 WhatsApp", url: `https://wa.me/${phone}` }]);
  }

  return { inline_keyboard: rows };
}

// ─── Reminders ───────────────────────────────────────────────────────────────

function scheduleReminder(leadId, delayMs, text) {
  const existing = reminders.get(leadId);
  if (existing) clearTimeout(existing);

  const id = setTimeout(async () => {
    reminders.delete(leadId);
    try {
      const lead = await getLeadById(leadId);
      if (lead.status === "new") {
        await _bot.telegram.sendMessage(MANAGER_CHAT_ID, text);
      }
    } catch (err) {
      console.error("Reminder error:", err.message);
    }
  }, delayMs);

  reminders.set(leadId, id);
}

// ─── Callbacks ───────────────────────────────────────────────────────────────

async function handleCallback(ctx) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const [action, id] = data.split(":");
  if (!id) return;

  try {
    if (action === "accept") {
      await updateLeadStatus(id, "in_progress");
      await ctx.answerCbQuery("✅ Принято");
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.reply(`✅ Заявка ${id.substring(0, 8)} принята в работу.`);
    } else if (action === "reject") {
      await updateLeadStatus(id, "canceled");
      await ctx.answerCbQuery("❌ Отклонено");
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.reply(`❌ Заявка ${id.substring(0, 8)} отклонена.`);
    } else if (action === "delay") {
      await ctx.answerCbQuery("⏸ Напомним через 30 мин");
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      await ctx.reply(`⏸ Напомним через 30 минут.`);
      scheduleReminder(id, 30 * 60 * 1000, `⏰ Напоминание: заявка ${id.substring(0, 8)} ещё ждёт обработки.`);
    }
  } catch (err) {
    console.error("Callback error:", err.message);
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
    messages.push({ role: "user", content: userText });

    const result = await chat(messages);

    if (result.type === "function") {
      const saved = await saveLead(result.args);

      await ctx.telegram.sendMessage(
        MANAGER_CHAT_ID,
        formatNotification(saved),
        { reply_markup: buildKeyboard(saved) }
      );

      scheduleReminder(
        saved.id,
        15 * 60 * 1000,
        `⏰ Напоминание: заявка ${saved.id.substring(0, 8)} не обработана уже 15 минут.`
      );

      await ctx.reply("Спасибо! Заявка принята 👍\nС вами скоро свяжутся.");
      clearContext(chatId);
      console.log(`Lead saved: ${saved.id}`);
    } else {
      messages.push({ role: "assistant", content: result.content });
      setContext(chatId, messages);
      await ctx.reply(result.content);
    }
  } catch (err) {
    console.error("Processing error:", err.message);
    await ctx.reply("Что-то пошло не так, давайте попробуем ещё раз.");
  }
}
