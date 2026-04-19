import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

export async function saveLead(leadData) {
  const row = {
    from_city: leadData.from || null,
    to_city: leadData.to || null,
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
    sender_phone: leadData.sender_phone || null,
    receiver_name: leadData.receiver_name || null,
    receiver_phone: leadData.receiver_phone || null,
    transport_type: leadData.transport_type || null,
    urgency: leadData.urgency || null,
    notes: leadData.notes || null,
  };

  const { data, error } = await supabase
    .from("leads")
    .insert(row)
    .select()
    .single();

  if (error) {
    throw new Error(`Supabase insert failed: ${error.message}`);
  }

  return data;
}
