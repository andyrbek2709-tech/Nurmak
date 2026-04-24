import { createClient } from "@supabase/supabase-js";
import { trackEvent } from "./controlTower.js";

export const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export function normalizePhone(phone) {
  if (!phone) return null;
  return phone.replace(/[\s\(\)\-\+]/g, "");
}

function buildRow(leadData) {
  return {
    from_city: leadData.from || null,
    from_address: leadData.from_address || null,
    to_city: leadData.to || null,
    to_address: leadData.to_address || null,
    cargo: leadData.cargo || null,
    weight: leadData.weight || null,
    volume: leadData.volume || null,
    cargo_notes: leadData.cargo_notes || null,
    date_loading: leadData.date_loading || null,
    time_loading: leadData.time_loading || null,
    time_unloading: leadData.time_unloading || null,
    need_loading: leadData.need_loading || null,
    need_unloading: leadData.need_unloading || null,
    sender_name: leadData.sender_name || null,
    sender_phone: normalizePhone(leadData.sender_phone),
    receiver_name: leadData.receiver_name || null,
    receiver_phone: normalizePhone(leadData.receiver_phone),
    transport_type: leadData.transport_type || null,
    urgency: leadData.urgency || null,
    notes: leadData.notes || null,
    status: "new",
    client_chat_id: leadData.client_chat_id || null,
  };
}

export async function saveLead(leadData) {
  const phone = normalizePhone(leadData.sender_phone);
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  if (phone) {
    const { data: existing } = await supabase
      .from("leads")
      .select("id")
      .eq("sender_phone", phone)
      .gte("created_at", fiveMinutesAgo)
      .maybeSingle();

    if (existing) {
      const { data, error } = await supabase
        .from("leads")
        .update(buildRow(leadData))
        .eq("id", existing.id)
        .select()
        .single();
      if (error) throw new Error(`Supabase update failed: ${error.message}`);

      // [CT] existing lead updated — still counts as engagement
      trackEvent("booking_created", {
        leadId: data.id,
        from_city: leadData.from,
        to_city: leadData.to,
        cargo: leadData.cargo,
        chatId: leadData.client_chat_id,
        updated: true,
      });

      return data;
    }
  }

  const { data, error } = await supabase
    .from("leads")
    .insert(buildRow(leadData))
    .select()
    .single();

  if (error) throw new Error(`Supabase insert failed: ${error.message}`);

  // [CT] new lead created
  trackEvent("booking_created", {
    leadId: data.id,
    from_city: leadData.from,
    to_city: leadData.to,
    cargo: leadData.cargo,
    transport_type: leadData.transport_type,
    chatId: leadData.client_chat_id,
    updated: false,
  });

  return data;
}

export async function updateLeadStatus(id, status) {
  const { error } = await supabase.from("leads").update({ status }).eq("id", id);
  if (error) throw new Error(`Status update failed: ${error.message}`);
}

export async function getLeadById(id) {
  const { data, error } = await supabase.from("leads").select("*").eq("id", id).single();
  if (error) throw new Error(error.message);
  return data;
}

export async function getLeadsByStatus(status) {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("status", status)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function loadBotSetting(key) {
  const { data } = await supabase.from("bot_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

export async function saveBotSetting(key, value) {
  await supabase.from("bot_settings").upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
}

export async function getLeadsToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .gte("created_at", today.toISOString())
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}
