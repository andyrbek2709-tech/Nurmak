import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import { handleStart, handleText, handleVoice } from "./bot/handlers.js";

// Validate required env vars
const required = ["BOT_TOKEN", "OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_KEY", "MANAGER_CHAT_ID", "WEBHOOK_DOMAIN"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;

// Register bot handlers
bot.start(handleStart);
bot.on("text", handleText);
bot.on("voice", handleVoice);

// Health check endpoint for Railway
app.get("/health", (_req, res) => {
  res.send("OK");
});

// Webhook endpoint for Telegram
const webhookPath = `/webhook/${process.env.BOT_TOKEN}`;
app.use(bot.webhookCallback(webhookPath));

// Set webhook on startup
const webhookUrl = `${process.env.WEBHOOK_DOMAIN}${webhookPath}`;

bot.telegram.setWebhook(webhookUrl).then(() => {
  console.log(`Webhook set: ${webhookUrl}`);
}).catch((err) => {
  console.error("Failed to set webhook:", err.message);
});

// Start Express server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  process.exit(0);
});