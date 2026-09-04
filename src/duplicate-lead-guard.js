/**
 * Duplicate-Lead Guard — src/duplicate-lead-guard.js
 *
 * One shared predicate, used at BOTH layers of the S5.2 disruption path:
 *
 *   1. src/decision-engine.js — the `not_duplicate_lead_live_appointment`
 *      context-condition verb, which suppresses the WHOLE action batch of a
 *      cancellation / no-show routing rule before any action is queued.
 *   2. src/actions/handlers/objection-state.js — the v2.0 guard in
 *      executeTransitionObjectionState(), which rejects an
 *      APPOINTMENT_DISRUPTION proposal before the state row is written.
 *
 * ─── Why this module exists ──────────────────────────────────────────────
 * Contacts with two or more LP leads (Lead Gurus + Canvass, MyHomePros +
 * Canvass, etc.) get one lead CXL'd by the call center as duplicate cleanup
 * while the real appointment stays Set/Cnf on the OTHER lead. The disposition
 * sync emits APPOINTMENT_DISRUPTION.cancelled and the contact receives a
 * "you cancelled" rescue text while their appointment is still on the books.
 *
 * Live data, S5.2 v2 recipients Aug 26 – Sep 1: 7 replied "I didn't cancel",
 * 9 of 111 cancelled-branch recipients had another LP lead with a live
 * appointment, 1 had a same-day Sale on the other lead. Two of the seven then
 * cancelled for real after receiving the text.
 *
 * v2.0 (2026-09-02) shipped the handler-side guard only, which stopped the
 * S5.2 enrollment and the state write but left the sibling actions of the
 * routing rule firing: set_stage stage:reactivation, move_opportunity →
 * Reactivation, add_tag appt-cancelled, create_task "LP CANCELLATION", and
 * end_agentic_handoff. A contact who never cancelled still got moved to
 * Reactivation and had their agentic handoff ended. This module lifts the
 * same predicate to the rule gate so the entire batch is suppressed.
 *
 * ─── Fail-open, deliberately ─────────────────────────────────────────────
 * Returns null on ANY query error, which lets the caller proceed. This is a
 * DOCUMENTED EXCEPTION to the engine-wide fail-closed doctrine of 2026-07-03
 * ("missing data is never a wildcard pass"), and the exception is the point:
 *
 *   - Fail-open on outage = today's behaviour. The bounded false-positive
 *     cohort (~8% of cancelled-branch recipients) may get a wrong text.
 *   - Fail-closed on outage = every cancellation stops routing to S5.2.
 *     ~700 contacts/30d lose their rescue path, not just the bad cohort.
 *
 * The guard exists to suppress a false positive. Letting it suppress the
 * true positives too, whenever Supabase hiccups, trades a small harm for a
 * much larger one. Both call sites log the failure so outages stay visible.
 */

import supabase from './supabase.js';
import { emitEvent } from './event-emitter.js';
import { utcToLpStoredIso } from './lp-dates.js';

// Dispositions that prove a lead's appointment is still live on the books.
const LIVE_APPOINTMENT_DISPOSITIONS = ['Set', 'Cnf'];

// Dispositions that prove the contact already bought on another lead.
// 'Sold' is not currently emitted by the LP sync; kept as a harmless synonym
// so a future LP mapping change does not silently open the hole again.
const SOLD_DISPOSITIONS = ['Sale', 'Sold'];

// How far back a Sale still counts as "this contact already bought".
const SALE_LOOKBACK_DAYS = 30;

/**
 * Find an lp_leads row that should block a disruption transition/routing.
 *
 * A block is any lead on the same GHL contact that is either:
 *   (a) appointment_set = true AND appointment_date >= now() AND
 *       disposition_code IN ('Set','Cnf')   — a live future appointment, or
 *   (b) disposition_code IN ('Sale','Sold') AND
 *       updated_at_lp >= now() - 30d        — already bought on another lead.
 *
 * Both now() bounds are expressed in the stored ET-wall-clock frame via
 * utcToLpStoredIso(); see the comment on nowStored below for why.
 *
 * The triggering (cancelled/no-show) lead cannot match (a): its own
 * disposition is CXL/CCC/BO/NoHome/1Leg/NS. So there is no need to know which
 * lead fired — any match is by construction a DIFFERENT lead.
 *
 * NOTE: updated_at_lp is null on some rows (known cache limitation). The .gte
 * filter treats null as non-matching, which is the safe direction for clause
 * (b) — a null-dated Sale does not block. Clause (a) does not depend on it.
 *
 * lp_leads lives in the LP Supabase instance; no cross-instance join.
 *
 * @param {string} contact_id  GHL contact id
 * @param {string} [logPrefix] tag for the fail-open warning, so the two call
 *                             sites are distinguishable in Railway logs
 * @returns {Promise<object|null>} blocking lp_leads row, or null to allow
 */
export async function findBlockingLiveLead(contact_id, logPrefix = 'DuplicateLeadGuard') {
  return findBlockingLiveLeadWith(supabase, contact_id, logPrefix);
}

const BLOCKING_SELECT =
  'lp_lead_id, lead_source_detail, disposition_code, appointment_set, appointment_date, updated_at_lp';

/**
 * A fail-open that nobody can see is indistinguishable from a guard that works.
 * Every error path now emits duplicate_lead_guard_unavailable so the silence is
 * countable. bypass_filter, no consuming rule — observability only, same stance
 * as appointment.authority_denied.
 */
async function reportFailOpen(contact_id, logPrefix, stage, message, emit = emitEvent) {
  console.warn(`[${logPrefix}] ${stage} failed for ${contact_id}: ${message} — FAILING OPEN`);
  try {
    await emit({
      event_type: 'duplicate_lead_guard_unavailable',
      event_subtype: stage,
      source: 'duplicate_lead_guard',
      entity_type: 'contact',
      entity_id: String(contact_id),
      ghl_contact_id: String(contact_id),
      priority: 'high',
      bypass_filter: true,
      payload: { contact_id: String(contact_id), stage, call_site: logPrefix, error: String(message).slice(0, 300) },
    });
  } catch (err) {
    console.warn(`[${logPrefix}] fail-open event emit failed: ${err.message}`);
  }
}

/**
 * Same predicate against an injected client. Exported so the fail-open
 * contract can be asserted directly in scripts/test-duplicate-lead-guard.js —
 * that contract is the guard's entire safety argument and must not regress
 * into a silent block. Production callers use findBlockingLiveLead().
 *
 * @param {object} client      a supabase-js-shaped client
 * @param {string} contact_id  GHL contact id
 * @param {string} [logPrefix]
 * @param {object} [deps]      TEST SEAM ONLY — deps.emitEvent overrides the
 *                             fail-open emitter so the test can assert that a
 *                             fail-open is reported exactly once. Production
 *                             callers pass three arguments and get emitEvent.
 * @returns {Promise<object|null>} blocking lp_leads row, or null to allow
 */
export async function findBlockingLiveLeadWith(client, contact_id, logPrefix = 'DuplicateLeadGuard', deps = {}) {
  if (!contact_id) return null;

  const emit = deps.emitEvent || emitEvent;

  // BOUNDS ARE BUILT IN THE STORED FRAME, NOT UTC. lp_leads appointment_date
  // and updated_at_lp hold ET wall-clock digits wearing a +00:00 offset they
  // did not earn (see the banner in src/lp-dates.js). A true-UTC bound against
  // those columns is four hours off — and on clause (a) it fails in the unsafe
  // direction: at 2:00 PM ET, new Date().toISOString() is 18:00Z and a 6:00 PM
  // ET appointment is stored as 18:00Z, so the guard read a live appointment as
  // past and stopped suppressing four hours before the appointment began.
  // Verified 2026-09-04 on contact zLDD7V1eosF8vldF5U7i / lead 459770.
  //
  // utcToLpStoredIso() shifts the BOUND into the column's frame, so the
  // comparison stays same-frame and index-eligible and no stored row changes.
  const nowStored = utcToLpStoredIso();
  const saleCutoffStored = utcToLpStoredIso(Date.now() - SALE_LOOKBACK_DAYS * 86400000);

  // TWO PLAIN QUERIES, NOT ONE .or() STRING. The previous single-call version
  // built a PostgREST logical tree — `or(and(...,in.(Set,Cnf)),and(in.(Sale,
  // Sold),...))` — and terminated it with .maybeSingle(). Both a parse failure
  // in that nested string and maybeSingle()'s multiple-rows error land on the
  // SAME silent `return null`, which is a pass. On 2026-09-03 contact
  // eqjK58AwEZ1juYJH6szE had lead 572839 (Cnf, appointment 2026-09-04
  // 10:00) matching clause (a) — the identical predicate in raw SQL returns
  // that row — and BOTH call sites let the batch through: the rule
  // GHL_APPT_CANCELLED_REBOOK_COLD queued 18 actions and the objection-state
  // handler enrolled S5.2 Appointment Rescue on a live appointment. The guard's
  // last suppression event was 2026-09-02 21:32.
  //
  // Simple .eq/.in/.gte filters and .limit(1) with an array result remove both
  // hazards. Two round trips is the right price for a guard that decides
  // whether a customer is told they cancelled.

  // (a) another lead holds a live FUTURE appointment
  try {
    const { data, error } = await client
      .from('lp_leads')
      .select(BLOCKING_SELECT)
      .eq('ghl_contact_id', String(contact_id))
      .eq('appointment_set', true)
      .in('disposition_code', LIVE_APPOINTMENT_DISPOSITIONS)
      .gte('appointment_date', nowStored)
      .order('appointment_date', { ascending: false })
      .limit(1);
    if (error) {
      await reportFailOpen(contact_id, logPrefix, 'live_appointment_query', error.message, emit);
      return null;
    }
    if (Array.isArray(data) && data.length > 0) return data[0];
  } catch (err) {
    await reportFailOpen(contact_id, logPrefix, 'live_appointment_query', err.message, emit);
    return null;
  }

  // (b) another lead already bought inside the lookback
  try {
    const { data, error } = await client
      .from('lp_leads')
      .select(BLOCKING_SELECT)
      .eq('ghl_contact_id', String(contact_id))
      .in('disposition_code', SOLD_DISPOSITIONS)
      .gte('updated_at_lp', saleCutoffStored)
      .order('updated_at_lp', { ascending: false })
      .limit(1);
    if (error) {
      await reportFailOpen(contact_id, logPrefix, 'recent_sale_query', error.message, emit);
      return null;
    }
    if (Array.isArray(data) && data.length > 0) return data[0];
  } catch (err) {
    await reportFailOpen(contact_id, logPrefix, 'recent_sale_query', err.message, emit);
    return null;
  }

  return null;
}

/**
 * Why a given row blocks — 'live_appointment' or 'recent_sale'. Used in the
 * suppression events so the two causes stay separable in the metrics.
 *
 * @param {object} row  an lp_leads row returned by findBlockingLiveLead
 * @returns {'live_appointment'|'recent_sale'|'unknown'}
 */
export function blockingReason(row) {
  if (!row) return 'unknown';
  if (SOLD_DISPOSITIONS.includes(row.disposition_code)) return 'recent_sale';
  if (LIVE_APPOINTMENT_DISPOSITIONS.includes(row.disposition_code)) return 'live_appointment';
  return 'unknown';
}

export default { findBlockingLiveLead, findBlockingLiveLeadWith, blockingReason };
