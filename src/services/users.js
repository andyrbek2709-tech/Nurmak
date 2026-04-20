import { supabase } from "./supabase.js";

export async function getUser(telegramUserId) {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("telegram_user_id", telegramUserId)
    .maybeSingle();
  return data || null;
}

export async function upsertUser(telegramUserId, { name, phone, lastOrderData }) {
  const { error } = await supabase.from("users").upsert(
    {
      telegram_user_id: telegramUserId,
      name: name || null,
      phone: phone || null,
      last_order_data: lastOrderData || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "telegram_user_id" }
  );
  if (error) console.error("upsertUser error:", error.message);
}
