// The contact's CURRENT LP lead = the most recently CREATED lead (tie-break:
// most recently updated). Used by GHL field sync AND by routing verbs so the
// GHL "LP Disposition" field and F.0 decisions can never disagree.
// Why created, not updated: an old duplicate lead gets touched (call logs,
// re-syncs) and would otherwise overwrite the live lead's disposition.
// 438 multi-lead contacts disagreed under the old rule on 2026-09-30.
import supabase from './supabase.js';

const t = (v) => (v ? new Date(v).getTime() : 0);

export function pickCurrentLead(leads) {
  if (!Array.isArray(leads) || leads.length === 0) return null;
  return [...leads].sort((a, b) =>
    (t(b.created_at_lp) - t(a.created_at_lp)) || (t(b.updated_at_lp) - t(a.updated_at_lp))
  )[0];
}

// Live lookup for routing. Returns the current lead row, or null when there are
// no leads, or throws on a read error (callers fail CLOSED).
export async function fetchCurrentLead(ghlContactId, client = supabase) {
  if (!client) throw new Error('LP Supabase not configured');
  const { data, error } = await client.from('lp_leads')
    .select('lp_lead_id, disposition_code, appointment_date, appointment_set, created_at_lp, updated_at_lp')
    .eq('ghl_contact_id', String(ghlContactId))
    .is('lp_deleted_at', null)
    .limit(50);
  if (error) throw new Error(error.message);
  return pickCurrentLead(data || []);
}
