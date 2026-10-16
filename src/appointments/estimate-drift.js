/**
 * Estimate drift correction — src/appointments/estimate-drift.js
 *
 * WHY (handoff v3.4 Fix 8, 2026-10-16). Five ghost Window Estimates (Gilles
 * 475840, Beilstein 466127, Stone 465486, Traina 468700, Sayre 462092) that OUR
 * sync created from LP rows LP no longer stood behind sat live with reminders
 * running until a person fixed each by hand, and a sync-created visit LP later
 * moved kept its old time. The parity watchdog (the one auto-heal owner) now
 * corrects a mirrored estimate that drifted from LP, behind
 * ESTIMATE_DRIFT_FIX_MODE (off | shadow | live, default shadow).
 *
 * SCOPE: an active (new / confirmed), future appointment on the estimate pool
 * that OUR sync created — an appt.booking `created` event for that
 * appointmentId from the reconciler (site reconcileLpAppointmentToGhl) or the
 * delegated endpoint (caller endpoint) — and that no person has edited since.
 * GHL's appointment records carry no "last updated by" (the HL mirror's
 * raw_json has none, checked 2026-10-16), so "no person edited it" is read as:
 * the appointment still starts exactly where our create put it. A person who
 * moved it moved its start; we then leave it alone. (Our own reschedules also
 * move the start and are skipped the same way — the reschedule rule owns those.)
 *
 * THE DECISION (pure, below). The owning lead is read LIVE; LP unreadable → skip.
 *   Verif                      → nothing (a hold, Fix 0)
 *   ND / No Demo               → nothing here; LP_DISP_DISQUALIFIED owns it (Fix 2)
 *   CXL or any non-live code   → nothing; the cancel path / Fix 1 owns it — a
 *                                real customer cancellation is never invalidated
 *   year-typo date             → mark_invalid + the "LP date/time looks wrong" card
 *   impossible hour            → nothing written; the card only (no rule says
 *                                invalidate a 2 AM visit, so a person decides)
 *   live time ≠ GHL time       → reschedule in place to LP's time (ET)
 *   match                      → in sync
 */

import {
  resolveSyncStartTime, isImplausibleFutureAppointment, sameStartTime, etHourFromStartTime,
  BUSINESS_HOUR_START_ET, BUSINESS_HOUR_END_ET, ESTIMATE_CALENDAR_IDS,
} from '../services/lp-ghl-appointment-reconciler.js';
import { isHoldDisposition, isDisqualifiedDisposition, isLiveAppointmentDisposition } from '../lp-disposition-classes.js';

export const DRIFT_RULE = 'ESTIMATE_DRIFT_FIX';
export const DRIFT_CAP = 25;
const MODES = ['off', 'shadow', 'live'];

export function estimateDriftMode(env = process.env) {
  const raw = String(env.ESTIMATE_DRIFT_FIX_MODE ?? '').trim().toLowerCase();
  if (!raw) return 'shadow';
  return MODES.includes(raw) ? raw : 'shadow'; // a typo must never start writing to GHL
}

/** Pure: is this GHL row in Fix 8 scope (before the created-event check)? */
export function inDriftScope(appt, nowMs = Date.now()) {
  if (!appt?.ghl_appointment_id || !ESTIMATE_CALENDAR_IDS.has(appt.ghl_calendar_id)) return false;
  const st = String(appt.status || '').toLowerCase();
  if (st !== 'new' && st !== 'confirmed') return false;
  const ms = Date.parse(appt.start_time || '');
  return Number.isFinite(ms) && ms > nowMs;
}

/** Pure: still where our create put it? (the "no person edited it" proxy) */
export function untouchedSinceCreate(appt, createdStartTime) {
  return Boolean(createdStartTime) && sameStartTime(appt?.start_time, createdStartTime);
}

/**
 * Pure. @returns {{ op: 'none'|'reschedule'|'mark_invalid'|'skip', reason: string, startTime?: string, card?: object }}
 */
export function decideDrift({ appt, lead, live, createdStartTime }) {
  if (!untouchedSinceCreate(appt, createdStartTime)) return { op: 'skip', reason: 'edited_since_create' };
  if (!lead) return { op: 'skip', reason: 'no_lp_lead' };
  const code = String(lead.disposition_code || '').trim();
  if (isHoldDisposition(code)) return { op: 'none', reason: 'verif_hold' };
  if (isDisqualifiedDisposition(code)) return { op: 'none', reason: 'disqualified_owned_by_fix2' };
  if (!isLiveAppointmentDisposition(code)) return { op: 'none', reason: 'not_live_owned_by_cancel_path' };
  if (!live?.ok) return { op: 'skip', reason: 'lp_unreadable' };
  const liveCode = String(live.disposition || code).trim();
  if (isHoldDisposition(liveCode)) return { op: 'none', reason: 'verif_hold' };
  if (isDisqualifiedDisposition(liveCode)) return { op: 'none', reason: 'disqualified_owned_by_fix2' };
  if (!isLiveAppointmentDisposition(liveCode)) return { op: 'none', reason: 'not_live_owned_by_cancel_path' };
  const { startTime } = resolveSyncStartTime(lead, live);
  if (!startTime) return { op: 'skip', reason: 'no_lp_time' };
  const ghost = isImplausibleFutureAppointment({ startTime, lead, live });
  if (ghost.implausible) {
    return {
      op: 'mark_invalid', reason: 'implausible_future_appointment', startTime,
      card: { reason: 'implausible_future_appointment', start_time: startTime, last_activity_at: ghost.lastActivityDay, days_after_last_activity: ghost.daysAfter, max_forward_days: ghost.maxDays },
    };
  }
  const hour = etHourFromStartTime(startTime);
  if (hour !== null && (hour < BUSINESS_HOUR_START_ET || hour >= BUSINESS_HOUR_END_ET)) {
    return { op: 'skip', reason: 'impossible_hour', startTime, card: { reason: 'impossible_hour', start_time: startTime, appointment_hour_et: hour } };
  }
  if (!sameStartTime(appt.start_time, startTime)) return { op: 'reschedule', reason: 'lp_time_differs', startTime };
  return { op: 'none', reason: 'in_sync' };
}

/** Pure: the cap — more than DRIFT_CAP writes in one run applies none. */
export function overCap(plans, cap = DRIFT_CAP) {
  return plans.filter((p) => p.op === 'reschedule' || p.op === 'mark_invalid').length > cap;
}
