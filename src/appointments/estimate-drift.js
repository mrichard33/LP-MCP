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
 *
 * NEVER INTO THE PAST, NEVER BEHIND THE ENDPOINT (Affeld, 2026-10-17). With the
 * mode live, a canvass visit I.LP-IN's endpoint booked for Sun 10/18 10 AM was
 * moved to 9/28: the contact linked only to a 2016 LP lead whose stored visit was
 * 9/28, while the lead holding 10/18 had not synced yet. Two refusals now come
 * before any write:
 *   LP's time already passed, or under 60 minutes away → skip `lp_time_past`
 *                              (a visit is never moved where nobody can attend)
 *   the endpoint booked it AFTER the LP lead last changed → skip `lp_unchanged_since_booking`
 *                              (the endpoint carries LP's newest webhook; a lead
 *                              row LP has not touched since is the stale side)
 */

import {
  resolveSyncStartTime, isImplausibleFutureAppointment, sameStartTime, etHourFromStartTime,
  BUSINESS_HOUR_START_ET, BUSINESS_HOUR_END_ET, ESTIMATE_CALENDAR_IDS,
} from '../services/lp-ghl-appointment-reconciler.js';
import { isHoldDisposition, isDisqualifiedDisposition, isLiveAppointmentDisposition } from '../lp-disposition-classes.js';
import { lpWallClockToGhlStartTime } from '../appointment-dates.js';

export const DRIFT_RULE = 'ESTIMATE_DRIFT_FIX';
export const DRIFT_CAP = 25;
/** A correction never lands a visit sooner than this (the mirror path's too-late window). */
export const DRIFT_MIN_LEAD_MINUTES = 60;
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
 * Pure: the endpoint booked this appointment after the LP lead last changed, so the
 * lead row is older news than the booking. Only the delegated endpoint qualifies:
 * a reconciler create was BUILT from the lead, so a mismatch there is ours to fix.
 * LP stamps are Eastern wall clock (lpWallClockToGhlStartTime); unknown → false.
 */
export function endpointNewerThanLead({ createdBy, createdAt, lead }) {
  if (createdBy !== 'endpoint' || !createdAt || !lead?.updated_at_lp) return false;
  const changed = Date.parse(lpWallClockToGhlStartTime(lead.updated_at_lp) || '');
  const booked = Date.parse(createdAt);
  return Number.isFinite(changed) && Number.isFinite(booked) && changed < booked;
}

/**
 * Pure. @returns {{ op: 'none'|'reschedule'|'mark_invalid'|'skip', reason: string, startTime?: string, card?: object }}
 */
export function decideDrift({ appt, lead, live, createdStartTime, createdBy = null, createdAt = null, nowMs = Date.now() }) {
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
  const targetMs = Date.parse(startTime);
  if (Number.isFinite(targetMs) && targetMs - nowMs < DRIFT_MIN_LEAD_MINUTES * 60_000) {
    return { op: 'skip', reason: 'lp_time_past', startTime };
  }
  if (!sameStartTime(appt.start_time, startTime) && endpointNewerThanLead({ createdBy, createdAt, lead })) {
    return { op: 'skip', reason: 'lp_unchanged_since_booking', startTime };
  }
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
