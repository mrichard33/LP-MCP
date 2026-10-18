/**
 * Same-slot sibling reads — src/same-slot-sibling-io.js
 *
 * WHY (Kathleen Badley, 2026-10-17). The same-slot rule (src/same-slot-sibling.js)
 * searched only the leads that carry the contact's ghl_contact_id. Badley's CXL
 * lead 583460 is linked to her contact on prospect 464723; the lead that holds
 * her live 10/17 10 AM visit, 583453 (Issue), sits on ANOTHER prospect, 464721,
 * with no ghl_contact_id at all. The two share one phone. A contact-only read
 * found no sibling, so the 14-day backfill dry run planned to cancel her real
 * appointment on the morning of the visit.
 *
 * The sibling scope is therefore every lead that shares the contact, a prospect
 * or a phone with the contact's leads (or with the cancelling lead itself). The
 * rule that decides stays the pure one: same ET date and time, live disposition,
 * confirmed by LP live by the caller.
 *
 * Throws on any read failure; the callers decide what that means (the cancel
 * guard lets the cancel run, as before).
 */

import supabase from './supabase.js';
import { normalizePhone10 } from './lead-leak-classify.js';

export const SIBLING_COLUMNS =
  'lp_lead_id, lp_prospect_id, ghl_contact_id, disposition_code, appointment_date, ' +
  'phone, phone_alt, created_at_lp, lp_deleted_at';
const LIMIT = 25;

async function select(db, apply, what) {
  const { data, error } = await apply(db.from('lp_leads').select(SIBLING_COLUMNS).is('lp_deleted_at', null)).limit(LIMIT);
  if (error) throw new Error(`lp_leads ${what} read failed: ${error.message}`);
  return data || [];
}

/**
 * Every lp_leads row (not soft-deleted) that shares the contact, a prospect or a
 * phone with the contact's leads and with `lead`. Deduped by lead id.
 *
 * @param {object} a
 * @param {string} [a.contactId]
 * @param {object} [a.lead]   the cancelling lead ({ lp_lead_id, lp_prospect_id?, phone? })
 * @param {object} [a.db]
 * @returns {Promise<object[]>}
 */
export async function readSlotSiblings({ contactId, lead, db = supabase } = {}) {
  if (!db) throw new Error('LP database not configured');
  const rows = [];
  if (contactId) rows.push(...await select(db, (q) => q.eq('ghl_contact_id', contactId), 'contact'));
  if (lead?.lp_lead_id && !rows.some((r) => String(r.lp_lead_id) === String(lead.lp_lead_id))) {
    rows.push(...await select(db, (q) => q.eq('lp_lead_id', String(lead.lp_lead_id)), 'lead'));
  }
  const prospects = new Set();
  const phones = new Set();
  for (const r of [...rows, lead || {}]) {
    if (r.lp_prospect_id) prospects.add(String(r.lp_prospect_id));
    for (const p of [r.phone, r.phone_alt]) {
      const d = normalizePhone10(p);
      if (d) phones.add(d);
    }
  }
  if (prospects.size) {
    rows.push(...await select(db, (q) => q.in('lp_prospect_id', [...prospects]), 'prospect'));
  }
  if (phones.size) {
    const list = [...phones].join(',');
    rows.push(...await select(db, (q) => q.or(`phone.in.(${list}),phone_alt.in.(${list})`), 'phone'));
  }
  const seen = new Set();
  return rows.filter((r) => {
    const id = String(r?.lp_lead_id ?? '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
