import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Download voice file from Telegram and transcribe via Whisper API.
 * Telegram voice messages are .ogg format, supported by Whisper directly.
 */
export async function transcribeVoice(ctx) {
  const voice = ctx.message.voice || ctx.message.audio;
  if (!voice) return null;

  const fileLink = await ctx.telegram.getFileLink(voice.file_id);
  const response = await fetch(fileLink.href);

  if (!response.ok) {
    throw new Error(`Failed to download voice file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  const transcription = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file: await openai.toFile(buffer, "voice.ogg", { type: "audio/ogg" }),
    language: "ru",
  });

  return transcription.text;
}