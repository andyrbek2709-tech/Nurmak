import OpenAI from "openai";
import { SYSTEM_PROMPT, SAVE_LEAD_FUNCTION } from "../bot/prompts.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TOOLS = [{ type: "function", function: SAVE_LEAD_FUNCTION }];

/**
 * Send message to OpenAI with tool calling.
 * Returns either { type: "text", content: string } or { type: "function", args: object }
 */
export async function chat(messages) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    tools: TOOLS,
    tool_choice: "auto",
    temperature: 0.3,
  });

  const msg = response.choices[0].message;

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    const call = msg.tool_calls[0];
    if (call.function.name === "save_lead") {
      return {
        type: "function",
        args: JSON.parse(call.function.arguments),
      };
    }
  }

  return { type: "text", content: msg.content };
}