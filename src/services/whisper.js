import fs from "fs";
import path from "path";
import os from "os";
import { File } from "node:buffer";
import OpenAI from "openai";

// Polyfill required by OpenAI SDK on Node.js 18
if (typeof globalThis.File === "undefined") {
  globalThis.File = File;
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcribeVoice(ctx) {
  const voice = ctx.message.voice || ctx.message.audio;
  if (!voice) return null;

  const fileLink = await ctx.telegram.getFileLink(voice.file_id);
  const response = await fetch(fileLink.href);

  if (!response.ok) {
    throw new Error(`Failed to download voice file: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const tmpPath = path.join(os.tmpdir(), `voice_${Date.now()}.ogg`);

  try {
    fs.writeFileSync(tmpPath, buffer);
    const transcription = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(tmpPath),
      language: "ru",
    });
    return transcription.text;
  } finally {
    fs.unlinkSync(tmpPath);
  }
}