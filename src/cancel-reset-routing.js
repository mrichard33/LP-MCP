// ─── Cancelled leads → "Resets-Hot": the decisions — src/cancel-reset-routing.js ───
//
// WHY (the user, 2026-10-15: "ensure that all leads that cancel or are in a
// canceled status are sent to our resets list, called 'resets hot'")
//   Nothing in our code put a cancelled lead on Five9's Resets-Hot list; LP (or a
//   person) did, and missed a lot. Of 274 leads cancelled 10-01..10-14 (newest
//   lead per phone), 129 were called by a Reset campaign after the cancel, 42
//   only by some other campaign, and 103 (38%) by nobody.
//
// WHAT IT DOES
//   A phone whose NEWEST LP lead is cancelled (CXL or CCC), cancelled in the last
//   `lookbackDays` and at least `graceMin` ago, that no Reset campaign has dialed
//   since the cancel, goes on "Resets-Hot" once per cancel. Never a sold phone, a
//   Five9 DNC number or an opt-out; a DNC or consent read that fails waits (never
//   dial blind).
//
// WHICH FIVE9 RECORD (read 2026-10-15, profile "Resets V2"): Resets-Hot dials
//   records created 25+ hours ago whose last call was 8+ hours ago (or never).
//   The opposite of DIAL ASAP, which dials only records created in the last 16
//   hours. So this add is keyed on number1 ALONE: it lands on the phone's
//   existing record, which is old enough to dial now. A phone Five9 has never
//   seen gets a new record and waits out the 25 hours.
//
// This module is PURE: the job (src/jobs/cancel-reset-routing.js) does every read.

import { lpLocalToUtcMs } from './lead-speed.js';

export const MODES = Object.freeze(['off', 'shadow', 'live']);
export const RESETS_LIST = 'Resets-Hot';
export const CANCEL_DISPOSITIONS = Object.freeze(new Set(['CXL', 'CCC']));
/** Campaigns whose call after the cancel means the reset already happened. */
export const RESET_CAMPAIGN_RX = /^resets?\b/i;

const MIN = 60_000;
const num = (v, dflt, min = 0) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : dflt;
};

/**
 * Default live: the user ruled it on 2026-10-15. A value that is not a mode
 * reads as shadow, so a typo never starts dialing.
 */
export function cancelResetMode(env = process.env) {
  const raw = String(env.CANCEL_RESET_ROUTING_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'live';
  return MODES.includes(raw) ? raw : 'shadow';
}

export function cancelResetConfig(env = process.env) {
  return {
    list: String(env.CANCEL_RESET_LIST || RESETS_LIST).trim(),
    // LP or a person may add the lead themselves; give that a little time.
    graceMin: num(env.CANCEL_RESET_GRACE_MIN, 30, 0),
    lookbackDays: num(env.CANCEL_RESET_LOOKBACK_DAYS, 14, 1),
    maxPushes: num(env.CANCEL_RESET_MAX_PUSHES, 50, 1),
  };
}

/** One push per lead per cancel. The date is the cancel's (LP's updated time). */
export const markKey = (leadId, updatedWall) => `cancel-reset:${leadId}:${String(updatedWall || '').slice(0, 10)}`;

/**
 * @param {object} a
 * @param {object} a.lead          { lp_lead_id, disposition_code, phone10, updated_wall }
 * @param {string|null} a.newestLeadId  the newest LP lead on the same phone
 * @param {boolean} a.sold         any lead on the phone closed won
 * @param {boolean|null} a.onDnc   Five9 DNC; null = could not read
 * @param {boolean|null} a.optedOut  consent says no calls; null = could not read
 * @param {boolean} a.resetCalled  a Reset campaign dialed the phone after the cancel
 * @param {boolean} a.marked       we already pushed this cancel
 * @returns {{ action: 'push'|'skip'|'wait', reason: string }}
 */
export function decideCancelReset({ lead, newestLeadId, sold, onDnc, optedOut, resetCalled, marked, nowMs, cfg }) {
  if (!lead?.phone10 || String(lead.phone10).length !== 10) return { action: 'skip', reason: 'no_phone' };
  if (newestLeadId && String(newestLeadId) !== String(lead.lp_lead_id)) return { action: 'skip', reason: 'newer_lead' };
  if (!CANCEL_DISPOSITIONS.has(String(lead.disposition_code || '').trim())) return { action: 'skip', reason: 'not_cancelled' };
  // The LP screen pop opens the lead by CustID; without it an agent gets a blank screen.
  if (!String(lead.lp_prospect_id || '').trim()) return { action: 'skip', reason: 'no_custid' };
  const cancelledMs = lpLocalToUtcMs(lead.updated_wall);
  if (cancelledMs == null) return { action: 'skip', reason: 'unknown_cancel_time' };
  if (nowMs - cancelledMs < cfg.graceMin * MIN) return { action: 'wait', reason: 'too_new' };
  if (nowMs - cancelledMs > cfg.lookbackDays * 24 * 60 * MIN) return { action: 'skip', reason: 'out_of_window' };
  if (sold) return { action: 'skip', reason: 'sold' };
  if (onDnc === null || onDnc === undefined) return { action: 'wait', reason: 'dnc_unreadable' };
  if (onDnc) return { action: 'skip', reason: 'dnc' };
  if (optedOut === null || optedOut === undefined) return { action: 'wait', reason: 'consent_unreadable' };
  if (optedOut) return { action: 'skip', reason: 'opted_out' };
  if (resetCalled) return { action: 'skip', reason: 'reset_called' };
  if (marked) return { action: 'skip', reason: 'already_pushed' };
  return { action: 'push', reason: 'cancelled_not_reset' };
}

/** The Five9 record for the push: who it is and which LP lead the screen pop opens. */
export function buildResetRecord(lead) {
  const pairs = [
    ['number1', String(lead.phone10)],
    ['first_name', String(lead.first_name || '').trim()],
    ['last_name', String(lead.last_name || '').trim()],
    ['CustID', String(lead.lp_prospect_id || '').trim()],
    ['lead_id', String(lead.lp_lead_id)],
    ['LPRecKey', `LDS${lead.lp_lead_id}`],
  ].filter(([, v]) => v !== '');
  return { fieldNames: pairs.map(([k]) => k), values: pairs.map(([, v]) => v) };
}
