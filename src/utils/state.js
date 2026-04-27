// In-memory state management for dialog contexts
// Key: chatId (number), Value: { messages: Array, updatedAt: number }

const conversations = new Map();
const TTL_MS = 30 * 60 * 1000; // 30 minutes

export function getContext(chatId) {
  const entry = conversations.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > TTL_MS) {
    conversations.delete(chatId);
    return null;
  }
  return entry.messages;
}

export function setContext(chatId, messages) {
  conversations.set(chatId, { messages, updatedAt: Date.now() });
}

export function clearContext(chatId) {
  conversations.delete(chatId);
}

// Periodic cleanup of expired contexts
setInterval(() => {
  const now = Date.now();
  for (const [chatId, entry] of conversations) {
    if (now - entry.updatedAt > TTL_MS) {
      conversations.delete(chatId);
    }
  }
}, 5 * 60 * 1000); // every 5 minutes