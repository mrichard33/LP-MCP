// ─── Post-demo LP lock — src/lp-post-demo-lock.js ─────────────────────────────
//
// WHY (the user, 2026-10-09)
//   "We should never modify a lead marked OPP FDN, that status indicates a
//   post-demo, completed lead." On 2026-10-08 LP lead 581695 (Monica, OPPFDN,
//   demo 10/7) took a SetAppointment for a rehash phone call and flipped to Set,
//   which also pulled her out of F.0. terminalDispositionDecision in
//   src/lp-appointment-sync.js already refuses a post-demo lead on the webhook
//   path, but only when the resolver handed it a disposition: a blank one passes
//   ("unknown, not terminal"), and set_lp_appointment (rule 112) had no check.
//
// WHAT
//   ONE question, asked right before every LP SetAppointment (the only two call
//   sites: executeSetLPAppointment and syncAppointmentToLP): is this lead
//   post-demo or sold (isDemoDisposition: Sale, OPPFDN, NoRehash, FDNS, SW, PM)?
//   Any source that says so locks it. Sources, cheapest first:
//     1. the disposition the caller already resolved (no I/O)
//     2. lp_leads (our copy, Supabase), and a NEWER lead on the same prospect
//        that is issued or post-demo (2026-10-16, Roberta Ritchie)
//     3. LP live (GetLead by lds_id)
//   A lead neither source knows (a lead minted minutes ago) is not post-demo and
//   proceeds. Both reads FAILING is "could not tell" and locks: a SetAppointment
//   is rare, and the parity watchdog re-drives a real gap 30 minutes later.
//
// The lead still gets every other write (notes, DNC): the lock covers the
// appointment, which is what changes the disposition.

import { isDemoDisposition } from './demo-truth.js';

const clean = (v) => (v == null ? '' : String(v).trim());

function liveDisposition(resp, ldsId) {
  const rows = Array.isArray(resp) ? resp
    : Array.isArray(resp?.data) ? resp.data
      : Array.isArray(resp?.Data) ? resp.Data
        : Array.isArray(resp?.leads) ? resp.leads : [];
  const want = String(ldsId);
  const lead = rows.find((l) => [l?.lds_id, l?.LeadID, l?.leadid, l?.id].some((v) => v != null && String(v) === want))
    || (rows.length === 1 ? rows[0] : null);
  if (!lead) return null;
  return clean(lead.Disposition ?? lead.disposition ?? lead.disp_code ?? lead.dsp_id);
}

// Post-issue dispositions of a newer lead that make an older lead's write wrong:
// Issue (the visit is with a rep) and every post-demo / sold code.
async function newerOwningLead(sb, prospectId, ldsId) {
  const { data, error } = await sb.from('lp_leads').select('lp_lead_id, disposition_code').eq('lp_prospect_id', String(prospectId));
  if (error || !Array.isArray(data)) return null;
  const mine = Number(ldsId);
  for (const row of data) {
    if (!(Number(row.lp_lead_id) > mine)) continue;
    const d = clean(row.disposition_code);
    if (d === 'Issue' || isDemoDisposition(d)) return { lp_lead_id: String(row.lp_lead_id), disposition: d };
  }
  return null;
}

/**
 * @param {string|number} ldsId
 * @param {object} [o]
 * @param {string} [o.knownDisposition]  what the caller already resolved
 * @param {object} [o.deps]  { supabase, getLeadByLdsId }
 * @returns {Promise<{ locked: boolean, disposition: string|null, source: string }>}
 */
export async function postDemoLock(ldsId, { knownDisposition = null, deps = {} } = {}) {
  if (!ldsId) return { locked: false, disposition: null, source: 'no_lead_id' };
  const known = clean(knownDisposition);
  if (known && isDemoDisposition(known)) return { locked: true, disposition: known, source: 'caller' };

  let dbFailed = false;
  let dbSaw = false;
  try {
    const sb = deps.supabase || (await import('./supabase.js')).default;
    const { data, error } = await sb.from('lp_leads').select('disposition_code, lp_prospect_id').eq('lp_lead_id', String(ldsId)).maybeSingle();
    if (error) throw new Error(error.message);
    if (data) {
      dbSaw = true;
      const d = clean(data.disposition_code);
      if (isDemoDisposition(d)) return { locked: true, disposition: d, source: 'lp_leads' };
      // A NEWER lead on the same prospect that is post-demo or issued owns the
      // visit (2026-10-16, Roberta Ritchie): the parity watchdog wrote GHL's
      // stale 10/17 10 AM onto her OLDER lead 579742 (Data → Set) the afternoon
      // her newest lead 583833 was issued and had its demo. An older lead must
      // not take an appointment then. Best-effort: a failed read here adds no
      // lock (the caller-lead checks above and below still stand).
      if (data.lp_prospect_id) {
        const newer = await newerOwningLead(sb, data.lp_prospect_id, ldsId).catch(() => null);
        if (newer) return { locked: true, disposition: newer.disposition, source: 'newer_lead', newer_lp_lead_id: newer.lp_lead_id };
      }
    }
  } catch {
    dbFailed = true;
  }

  try {
    const getLead = deps.getLeadByLdsId || (await import('./lp-client.js')).getLeadByLdsId;
    const d = liveDisposition(await getLead(String(ldsId), { fast: true }), ldsId);
    if (d && isDemoDisposition(d)) return { locked: true, disposition: d, source: 'lp_live' };
    return { locked: false, disposition: d || known || null, source: 'lp_live' };
  } catch {
    // Live failed. lp_leads answered (and it was not post-demo), or had no row:
    // a lead we have never synced is a new lead, not a post-demo one.
    if (!dbFailed) return { locked: false, disposition: known || null, source: dbSaw ? 'lp_leads' : 'unknown_new_lead' };
    return { locked: true, disposition: null, source: 'unreadable' };
  }
}
