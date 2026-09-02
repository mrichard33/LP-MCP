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

/**
 * Same predicate against an injected client. Exported so the fail-open
 * contract can be asserted directly in scripts/test-duplicate-lead-guard.js —
 * that contract is the guard's entire safety argument and must not regress
 * into a silent block. Production callers use findBlockingLiveLead().
 *
 * @param {object} client      a supabase-js-shaped client
 * @param {string} contact_id  GHL contact id
 * @param {string} [logPrefix]
 * @returns {Promise<object|null>} blocking lp_leads row, or null to allow
 */
export async function findBlockingLiveLeadWith(client, contact_id, logPrefix = 'DuplicateLeadGuard') {
  if (!contact_id) return null;

  try {
    const nowIso = new Date().toISOString();
    const saleCutoff = new Date(Date.now() - SALE_LOOKBACK_DAYS * 86400000).toISOString();

    const { data, error } = await client
      .from('lp_leads')
      .select('lp_lead_id, lead_source_detail, disposition_code, appointment_set, appointment_date, updated_at_lp')
      .eq('ghl_contact_id', String(contact_id))
      .or(
        `and(appointment_set.eq.true,appointment_date.gte.${nowIso},disposition_code.in.(${LIVE_APPOINTMENT_DISPOSITIONS.join(',')})),` +
        `and(disposition_code.in.(${SOLD_DISPOSITIONS.join(',')}),updated_at_lp.gte.${saleCutoff})`
      )
      .order('appointment_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn(`[${logPrefix}] query failed for ${contact_id}: ${error.message} — failing open`);
      return null;
    }
    return data || null;
  } catch (err) {
    console.warn(`[${logPrefix}] threw for ${contact_id}: ${err.message} — failing open`);
    return null;
  }
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
