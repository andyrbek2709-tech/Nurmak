// Control Tower integration — fire-and-forget, never throws
import { randomUUID } from "node:crypto";

const CT_URL = process.env.CONTROL_TOWER_API_URL;
const TENANT_ID = "tenant-main";
const PROJECT_ID = "cargo-parser";

const HEADERS = {
  "Content-Type": "application/json",
  "x-tenant-id": TENANT_ID,
};

async function post(path, body) {
  if (!CT_URL) return;
  try {
    const res = await fetch(`${CT_URL}${path}`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`[CT] ${path} → HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[CT] ${path} error: ${err.message}`);
  }
}

export function trackEvent(eventType, payload = {}) {
  void post("/ingestion/events", {
    eventId: randomUUID(),
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    eventType,
    eventCategory: "product",
    occurredAt: new Date().toISOString(),
    userId: payload.chatId ? String(payload.chatId) : undefined,
    payload,
  });
}

export function trackTransaction(amount, currency = "RUB", payload = {}) {
  if (!amount || amount <= 0) return;
  void post("/ingestion/transactions", {
    transactionId: randomUUID(),
    tenantId: TENANT_ID,
    projectId: PROJECT_ID,
    amount: Number(amount),
    currency,
    status: "succeeded",
    occurredAt: new Date().toISOString(),
    userId: payload.chatId ? String(payload.chatId) : undefined,
    payload,
  });
}
