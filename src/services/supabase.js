import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/**
 * Insert a lead into the leads table.
 * Returns the inserted row or throws on error.
 */
export async function saveLead(leadData) {
  const row = {
    from_city: leadData.from_city || null,
    to_city: leadData.to_city || null,
    cargo: leadData.cargo || null,
    weight: leadData.weight || null,
    volume: leadData.volume || null,
    date: leadData.date || null,
    transport_type: leadData.transport_type || null,
    urgency: leadData.urgency || null,
    loading: leadData.loading || null,
    name: leadData.name || null,
    phone: leadData.phone || null,
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