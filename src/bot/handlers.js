import { getContext, setContext, clearContext } from "../utils/state.js";
import { chat } from "../services/openai.js";
import { transcribeVoice } from "../services/whisper.js";
import { saveLead } from "../services/supabase.js";

const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

/**
 * Format lead data for manager notification
 */
function formatLeadNotification(lead) {
  const lines = [
    "📋 Новая заявка на грузоперевозку:",
    "",
    `🗺 Маршрут: ${lead.from || "—"} → ${lead.to || "—"}`,
    "",
    `📦 Груз: ${lead.cargo || "—"}`,
    `⚖️ Вес: ${lead.weight || "—"}`,
    `📐 Объём: ${lead.volume || "—"}`,
    `⚠️ Особенности: ${lead.cargo_notes || "—"}`,
    "",
    `📅 Дата загрузки: ${lead.date_loading || "—"}`,
    `🕐 Время загрузки: ${lead.time_loading || "—"}`,
    `🕑 Время разгрузки: ${lead.time_unloading || "—"}`,
    `🔼 Погрузка: ${lead.need_loading || "—"}`,
    `🔽 Разгрузка: ${lead.need_unloading || "—"}`,
    "",
    `👤 Отправитель: ${lead.sender_name || "—"} | ${lead.sender_phone || "—"}`,
    `👤 Получатель: ${lead.receiver_name || "—"} | ${lead.receiver_phone || "—"}`,
    "",
    `🚛 Транспорт: ${lead.transport_type || "—"}`,
    `⚡ Срочность: ${lead.urgency || "—"}`,
    `📝 Комментарии: ${lead.notes || "—"}`,
  ];
  return lines.join("\n");
}

/**
 * Handle incoming text message
 */
export async function handleText(ctx) {
  const chatId = ctx.chat.id;
  const userMessage = ctx.message.text;

  if (!userMessage || !userMessage.trim()) return;

  await processMessage(ctx, chatId, userMessage);
}

/**
 * Handle incoming voice message
 */
export async function handleVoice(ctx) {
  const chatId = ctx.chat.id;

  try {
    const text = await transcribeVoice(ctx);
    if (!text || !text.trim()) {
      await ctx.reply("Не удалось распознать голосовое сообщение. Пожалуйста, напишите текстом или запишите ещё раз.");
      return;
    }
    await processMessage(ctx, chatId, text);
  } catch (err) {
    console.error("Voice transcription error:", err.message);
    await ctx.reply("Ошибка при обработке голосового сообщения. Попробуйте написать текстом.");
  }
}

/**
 * Core message processing: context → OpenAI → response/save
 */
async function processMessage(ctx, chatId, userText) {
  try {
    // Get or create conversation context
    let messages = getContext(chatId) || [];
    messages.push({ role: "user", content: userText });

    // Call OpenAI
    const result = await chat(messages);

    if (result.type === "function") {
      // LLM says: data is complete → save lead
      const lead = result.args;
      const saved = await saveLead(lead);

      // Notify manager
      await ctx.telegram.sendMessage(MANAGER_CHAT_ID, formatLeadNotification(lead));

      // Confirm to user
      await ctx.reply("✅ Ваша заявка принята! Менеджер свяжется с вами в ближайшее время.");

      // Clear conversation context
      clearContext(chatId);

      console.log(`Lead saved: ${saved.id}`);
    } else {
      // LLM continues the dialog
      messages.push({ role: "assistant", content: result.content });
      setContext(chatId, messages);
      await ctx.reply(result.content);
    }
  } catch (err) {
    console.error("Processing error:", err.message);
    await ctx.reply("Произошла ошибка. Попробуйте ещё раз или свяжитесь с нами напрямую.");
  }
}

/**
 * Handle /start command
 */
export async function handleStart(ctx) {
  clearContext(ctx.chat.id);
  await ctx.reply(
    "Добрый день! Я логистический менеджер по грузоперевозкам.\n\n" +
    "Расскажите о вашем грузе — откуда, куда и что везём?"
  );
}