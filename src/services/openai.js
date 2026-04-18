import OpenAI from "openai";
import { SYSTEM_PROMPT, SAVE_LEAD_FUNCTION } from "../bot/prompts.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Send message to OpenAI with function calling.
 * Returns either { type: "text", content: string } or { type: "function", args: object }
 */
export async function chat(messages) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    functions: [SAVE_LEAD_FUNCTION],
    function_call: "auto",
    temperature: 0.3,
  });

  const choice = response.choices[0];
  const msg = choice.message;

  if (msg.function_call && msg.function_call.name === "save_lead") {
    return {
      type: "function",
      args: JSON.parse(msg.function_call.arguments),
    };
  }

  return { type: "text", content: msg.content };
}