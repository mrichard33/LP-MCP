/**
 * LP-origin guard for the parity watchdog's Class A — src/appointments/lp-origin-guard.js
 *
 * WHY (Roberta Ritchie, GHL 0Hwk6Mw05TSkKfQDhssm, 2026-10-16). LP is the
 * authority on appointments. Her GHL estimate (w0KtmFfsOnC3DilwxYIu) was created
 * by OUR LP→GHL sync at 10/17 10 AM. LP then moved her lead 583833 to 10/16 2 PM
 * and issued it; GHL never heard. At 18:28Z, with the 2 PM visit just past (so
 * out of the watchdog's forward-looking LP book), Class A read the stale GHL
 * 10/17 10 AM as "LP is missing this appointment" and wrote it into LP on her
 * OLDER lead 579742 (Data → Set). A rep could have been sent to a home that had
 * its demo the day before. The same path wrote lead 583242 on 10/13.
 *
 * Class A exists for a booking made in GHL that never reached LP. It must never
 * fire for an appointment LP itself created, or for a contact whose LP history
 * says the visit already happened. Then GHL is the stale side, and the fix is
 * in GHL (the drift fix, the post-appointment close), never a write to LP.
 *
 * PURE. The watchdog reads the facts (readLpOriginFacts below is the I/O) and
 * asks this module.
 *
 *   sync_created         our LP→GHL sync created this appointment (an appt.booking
 *                        `created` event from the reconciler or the delegated
 *                        endpoint — the same test Fix 8 uses)
 *   recent_lp_visit      a lead on the contact (or its prospect) held an LP visit
 *                        in the last RECENT_VISIT_HOURS, in any disposition that
 *                        had a real visit: live (Set/Cnf/Issue), post-demo or sold
 *   post_demo_lead       the newest lead on the contact (or prospect) is post-demo
 *                        / sold with its visit in the last POST_DEMO_DAYS
 *
 * Any of them → do not write to LP (outcome `lp_origin_drift`). A contact with
 * no LP history at all (a booking LP has never seen) passes.
 */

import { isDemoDisposition } from '../demo-truth.js';
import { isLiveAppointmentDisposition } from '../lp-disposition-classes.js';
import { lpWallClockToGhlStartTime } from '../appointment-dates.js';

export const RECENT_VISIT_HOURS = 72;
// The rehash window (REHASH_DAYS in src/agentic/rehash-state.js).
export const POST_DEMO_DAYS = 30;
const SENTINEL_BEFORE_MS = Date.UTC(2000, 0, 1);

/** Epoch ms of an lp_leads appointment_date (ET wall clock labelled +00:00); null when none. */
export function lpVisitMs(appointmentDate) {
  if (!appointmentDate) return null;
  const raw = Date.parse(appointmentDate);
  if (!Number.isFinite(raw) || raw < SENTINEL_BEFORE_MS) return null;
  const iso = lpWallClockToGhlStartTime(appointmentDate);
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) ? ms : null;
}

const leadNum = (row) => {
  const n = Number(row?.lp_lead_id);
  return Number.isFinite(n) ? n : -Infinity;
};

/**
 * Pure. Should Class A refuse to write this GHL appointment into LP?
 *
 * @param {object} a
 * @param {boolean} a.syncCreated  OUR sync created the GHL appointment
 * @param {Array<object>} a.leads  every lp_leads row for the contact and its prospect(s):
 *                                 { lp_lead_id, disposition_code, appointment_date }
 * @param {number} [a.nowMs]
 * @returns {{ block: boolean, reason: string|null, lp_lead_id?: string|null }}
 */
export function lpOriginBlock({ syncCreated = false, leads = [], nowMs = Date.now() } = {}) {
  if (syncCreated) return { block: true, reason: 'sync_created', lp_lead_id: null };
  const rows = Array.isArray(leads) ? leads : [];
  const since = nowMs - RECENT_VISIT_HOURS * 3600_000;
  for (const row of rows) {
    const code = String(row?.disposition_code || '').trim();
    if (!isLiveAppointmentDisposition(code) && !isDemoDisposition(code)) continue;
    const ms = lpVisitMs(row?.appointment_date);
    if (ms !== null && ms >= since && ms <= nowMs) {
      return { block: true, reason: 'recent_lp_visit', lp_lead_id: row.lp_lead_id ?? null };
    }
  }
  // The newest lead on the prospect is post-demo or sold, with its visit inside
  // the rehash window: the visit happened, and an older lead must not take a new
  // appointment from a GHL echo (a rehash lead is never booked a visit anyway).
  // Older than the window, a returning homeowner's new GHL booking is real.
  const newest = [...rows].sort((a, b) => leadNum(b) - leadNum(a))[0];
  if (newest && isDemoDisposition(newest.disposition_code)) {
    const ms = lpVisitMs(newest.appointment_date);
    if (ms !== null && ms >= nowMs - POST_DEMO_DAYS * 86400_000 && ms <= nowMs) {
      return { block: true, reason: 'post_demo_lead', lp_lead_id: newest.lp_lead_id ?? null };
    }
  }
  return { block: false, reason: null };
}

/**
 * Pure: is `lead` (the watchdog's LP book row for a contact) superseded by a
 * NEWER lead on the same contact or prospect that already holds or held the
 * visit? Then Class B must not create a GHL appointment from the older one.
 *
 * Roberta Ritchie again: once the watchdog had written GHL's stale time onto her
 * older lead 579742 (Set 10/17 10 AM), that phantom was the only row in the
 * forward book, and Class B would mirror it right back into GHL after the close.
 * Her newest lead 583833 was OPPFDN with the demo the day before.
 *
 * Superseding: a newer lead that is post-demo / sold with its visit in the last
 * POST_DEMO_DAYS, or a newer lead in a live disposition (Set / Cnf / Issue).
 */
export function supersededByNewerLead({ lead, leads = [], nowMs = Date.now() } = {}) {
  const mine = leadNum(lead);
  if (!Number.isFinite(mine)) return { superseded: false };
  for (const row of Array.isArray(leads) ? leads : []) {
    if (leadNum(row) <= mine) continue;
    const code = String(row?.disposition_code || '').trim();
    if (isLiveAppointmentDisposition(code)) return { superseded: true, reason: 'newer_live_lead', lp_lead_id: row.lp_lead_id };
    if (isDemoDisposition(code)) {
      const ms = lpVisitMs(row.appointment_date);
      if (ms !== null && ms >= nowMs - POST_DEMO_DAYS * 86400_000 && ms <= nowMs) {
        return { superseded: true, reason: 'newer_post_demo_lead', lp_lead_id: row.lp_lead_id };
      }
    }
  }
  return { superseded: false };
}

/**
 * I/O: the facts lpOriginBlock needs for a batch of Class A candidates.
 * Throws on any read failure — the watchdog then writes nothing to LP this
 * sweep (fail closed: LP is the authority, and a real gap waits 30 minutes).
 *
 * @param {object} a
 * @param {Map} a.candidates  contact id → GHL row { ghl_appointment_id }
 * @param {object} a.db       LP supabase client
 * @param {Function} a.readSyncCreatedStarts  (ids) → Map(appointmentId → startTime)
 * @returns {Promise<{ syncCreated: Set<string>, leadsByContact: Map<string, object[]> }>}
 */
export async function readLpOriginFacts({ candidates, db, readSyncCreatedStarts }) {
  const cids = [...(candidates?.keys?.() || [])];
  const syncCreated = new Set();
  const leadsByContact = new Map();
  if (!cids.length) return { syncCreated, leadsByContact };
  if (!db) throw new Error('LP database not configured');

  const apptIds = cids.map((c) => candidates.get(c)?.ghl_appointment_id).filter(Boolean);
  const starts = await readSyncCreatedStarts(apptIds);
  for (const id of starts.keys()) syncCreated.add(id);

  const COLS = 'lp_lead_id, lp_prospect_id, ghl_contact_id, disposition_code, appointment_date';
  const byContact = [];
  for (let i = 0; i < cids.length; i += 100) {
    const { data, error } = await db.from('lp_leads').select(COLS).in('ghl_contact_id', cids.slice(i, i + 100));
    if (error) throw new Error(`lp_leads read failed: ${error.message}`);
    byContact.push(...(data || []));
  }
  // The prospect's other leads too: a duplicate lead on another (or no) contact
  // still says the visit happened.
  const prospects = [...new Set(byContact.map((r) => r.lp_prospect_id).filter(Boolean).map(String))];
  const byProspect = [];
  for (let i = 0; i < prospects.length; i += 100) {
    const { data, error } = await db.from('lp_leads').select(COLS).in('lp_prospect_id', prospects.slice(i, i + 100));
    if (error) throw new Error(`lp_leads prospect read failed: ${error.message}`);
    byProspect.push(...(data || []));
  }
  const prospectOf = new Map();
  for (const r of byContact) if (r.lp_prospect_id) {
    const set = prospectOf.get(r.ghl_contact_id) || new Set();
    set.add(String(r.lp_prospect_id));
    prospectOf.set(r.ghl_contact_id, set);
  }
  for (const cid of cids) {
    const ps = prospectOf.get(cid) || new Set();
    const seen = new Set();
    const rows = [];
    for (const r of [...byContact, ...byProspect]) {
      if (r.ghl_contact_id !== cid && !(r.lp_prospect_id && ps.has(String(r.lp_prospect_id)))) continue;
      if (seen.has(String(r.lp_lead_id))) continue;
      seen.add(String(r.lp_lead_id));
      rows.push(r);
    }
    leadsByContact.set(cid, rows);
  }
  return { syncCreated, leadsByContact };
}
