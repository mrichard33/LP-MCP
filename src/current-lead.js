// The contact's CURRENT LP lead = the most recently CREATED lead (tie-break:
// most recently updated). Used by GHL field sync AND by routing verbs so the
// GHL "LP Disposition" field and F.0 decisions can never disagree.
// Why created, not updated: an old duplicate lead gets touched (call logs,
// re-syncs) and would otherwise overwrite the live lead's disposition.
// 438 multi-lead contacts disagreed under the old rule on 2026-09-30.
//
// 2026-10-01 — a blank "Data" lead does not outrank a real appointment.
// Sharyn Blake (3UHhZjKgDtQgtDD3N8qI): LP made lead 579801 (appointment
// 10/1, demoed, OPPFDN) and, four minutes later, lead 579804 from a Google
// form — disposition "Data", no appointment. Newest-created picked the Data
// lead, so LP Disposition read "Data" and F.0 never enrolled her. 987
// contacts had a Data lead on top of an older lead with an appointment.
// A Data lead with no appointment now yields to any lead whose appointment
// falls on or after DATA_SHADOW_WINDOW_DAYS before the Data lead was created:
// a web inquiry inside that window is the same sales cycle, not a new one.
// Older than the window, the inquiry is a new cycle and stays current.
// Only "Data" is skipped — DNC and every worked disposition still win.
import supabase from './supabase.js';

export const PLACEHOLDER_DISPOSITION = 'Data';
export const DATA_SHADOW_WINDOW_DAYS = 15; // Mark, 2026-10-01
const DAY_MS = 24 * 60 * 60 * 1000;

const t = (v) => (v ? new Date(v).getTime() : 0);

const newestFirst = (a, b) =>
  (t(b.created_at_lp) - t(a.created_at_lp)) || (t(b.updated_at_lp) - t(a.updated_at_lp));

/** A Data lead that never got an appointment: an unworked inquiry. */
export function isPlaceholderLead(lead) {
  return String(lead?.disposition_code ?? '').trim() === PLACEHOLDER_DISPOSITION
    && !lead?.appointment_date;
}

/** True when another lead's appointment makes this Data lead a duplicate inquiry. */
function isShadowed(placeholder, leads) {
  const from = t(placeholder.created_at_lp) - DATA_SHADOW_WINDOW_DAYS * DAY_MS;
  return leads.some((o) => o !== placeholder && !isPlaceholderLead(o)
    && o.appointment_date && t(o.appointment_date) >= from);
}

export function pickCurrentLead(leads) {
  if (!Array.isArray(leads) || leads.length === 0) return null;
  const real = leads.filter((l) => !(isPlaceholderLead(l) && isShadowed(l, leads)));
  return [...(real.length ? real : leads)].sort(newestFirst)[0];
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
