import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import { handleStart, handleText, handleVoice } from "./bot/handlers.js";

const required = ["BOT_TOKEN", "OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_KEY", "MANAGER_CHAT_ID"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const PORT = process.env.PORT || 3000;

bot.start(handleStart);
bot.on("text", handleText);
bot.on("voice", handleVoice);

if (process.env.WEBHOOK_DOMAIN) {
  // Webhook mode (Railway / production)
  const app = express();
  const webhookPath = `/webhook/${process.env.BOT_TOKEN}`;

  app.get("/health", (_req, res) => res.send("OK"));
  app.use(bot.webhookCallback(webhookPath));

  const webhookUrl = `${process.env.WEBHOOK_DOMAIN.trim()}${webhookPath}`;

  await new Promise((resolve) => app.listen(PORT, resolve));
  console.log(`Server running on port ${PORT}`);

  try {
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook set: ${webhookUrl}`);
  } catch (err) {
    console.error(`Failed to set webhook: ${err.message}`);
    console.error(`Webhook URL was: "${webhookUrl}"`);
  }
} else {
  // Long-polling mode (local dev without ngrok)
  await bot.telegram.deleteWebhook();
  bot.launch();
  console.log("Bot started in long-polling mode");
}

process.on("SIGTERM", () => {
  bot.stop("SIGTERM");
  process.exit(0);
});

process.on("SIGINT", () => {
  bot.stop("SIGINT");
  process.exit(0);
});