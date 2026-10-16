/**
 * Parity watchdog heal decisions — src/jobs/appointment-parity-heal.js
 *
 * Pure policy for the two LP→GHL heals the watchdog owns since 2026-10-16
 * (Mark, handoff v3.4: "GHL must match LP", replacing "Class B escalate only").
 * The watchdog is the ONE owner of appointment auto-healing; no other sweep.
 *
 *   Class B (ghl_missing_appointment) → create through the mirror-on-link path
 *     (reconciler + LP live). A reconciler GUARD refusal is never "add it to
 *     GHL": a bad date or hour is the "LP date/time looks wrong" card (Fix 4),
 *     an unreadable LP waits for the next sweep, a visit inside 60 minutes is
 *     left alone. Only a failed create, or a refusal a person must judge (a DNC
 *     contact, two estimate appointments), escalates.
 *   Class D (cancellation_drift) → RESTORE the cancelled GHL appointment only in
 *     the narrow Badley case (Fix 1.7): the contact's LP book holds a LIVE lead
 *     and a cancelled lead at the SAME slot as the cancelled GHL appointment —
 *     a duplicate's cancel, not the customer's. Status from LP (Set → new,
 *     Cnf / Issue → confirmed), only when LP live confirms the slot and the
 *     reconciler's guards pass. Never an `invalid` appointment (settled, Fix 8)
 *     and never on Verif (settled). Anything else stays an escalation.
 */

import { lpWallClockToGhlStartTime } from '../appointment-dates.js';
import {
  sameStartTime, resolveSyncStartTime, isImplausibleFutureAppointment, etHourFromStartTime,
  BUSINESS_HOUR_START_ET, BUSINESS_HOUR_END_ET,
} from '../services/lp-ghl-appointment-reconciler.js';
import { ghlStatusForDisposition, isLiveAppointmentDisposition } from '../lp-disposition-classes.js';
import { slotKeyOf, liveStillHoldsSlot } from '../same-slot-sibling.js';

export const S52_REBOOK_TAGS = Object.freeze([
  'appt-cancelled', 'rebook-reason:cancelled', 'active-s5.2', 'active-w5.2', 'stage:reactivation',
]);

/** Pure: what the watchdog does with a Class B mirror result. */
export function classBOutcome(rec) {
  if (!rec) return { kind: 'escalate', reason: 'no_result' };
  if (rec.outcome === 'created' || rec.outcome === 'rescheduled' || rec.outcome === 'status_updated') return { kind: 'created', reason: rec.outcome };
  const r = rec.reason;
  if (r === 'already_in_sync' || r === 'slot_already_held' || r === 'create_claim_held') return { kind: 'in_sync', reason: r };
  if (r === 'implausible_future_appointment' || r === 'impossible_hour') return { kind: 'lp_looks_wrong', reason: r };
  if (r === 'stale_mirror_unverified' || r === 'too_late_to_mirror' || r === 'past_appointment_date'
    || r === 'no_appointment_date' || r === 'verif_hold' || r === 'disqualified' || r === 'not_live' || r === 'dry_run') {
    return { kind: 'deferred', reason: r };
  }
  return { kind: 'escalate', reason: r || rec.outcome || 'unknown' };
}

/** True when a GHL row's start is the LP row's slot. */
export function sameSlot(ghlStart, lpAppointmentDate) {
  const lpStart = lpWallClockToGhlStartTime(lpAppointmentDate);
  return Boolean(lpStart && ghlStart && sameStartTime(ghlStart, lpStart));
}

/** Pure pre-check, no I/O: is this the Badley shape at all (worth an LP read)? */
export function sameSlotDuplicateCandidate({ lead, resolvedRow, cancelledAppt }) {
  const st = String(cancelledAppt?.status || '').toLowerCase();
  return (st === 'cancelled' || st === 'canceled')
    && isLiveAppointmentDisposition(lead?.disposition_code)
    && Boolean(resolvedRow) && slotKeyOf(resolvedRow.appointment_date) === slotKeyOf(lead.appointment_date)
    && sameSlot(cancelledAppt.start_time, lead.appointment_date);
}

/**
 * Pure: restore a cancelled GHL appointment for a same-slot live sibling?
 * @param {object} a
 * @param {object} a.lead          LP active row (the live lead)
 * @param {object|null} a.resolvedRow  LP resolved row for the contact (the cancelling duplicate)
 * @param {object} a.cancelledAppt GHL row { ghl_appointment_id, status, start_time }
 * @param {object|null} a.live     readLiveForSync(lead) result
 */
export function restoreDecision({ lead, resolvedRow, cancelledAppt, live }) {
  const no = (reason) => ({ restore: false, reason });
  if (!cancelledAppt) return no('no_ghl_row');
  const st = String(cancelledAppt.status || '').toLowerCase();
  if (st === 'invalid') return no('invalid_is_settled');
  if (st !== 'cancelled' && st !== 'canceled') return no(`status_${st || 'unknown'}`);
  if (!isLiveAppointmentDisposition(lead?.disposition_code)) return no('lead_not_live');
  if (!resolvedRow || slotKeyOf(resolvedRow.appointment_date) !== slotKeyOf(lead.appointment_date)) return no('no_same_slot_duplicate');
  if (!sameSlot(cancelledAppt.start_time, lead.appointment_date)) return no('ghl_row_other_slot');
  if (!liveStillHoldsSlot(live, slotKeyOf(lead.appointment_date))) return no('lp_live_unconfirmed');
  const { startTime } = resolveSyncStartTime(lead, live);
  if (!startTime) return no('no_start_time');
  if (isImplausibleFutureAppointment({ startTime, lead, live }).implausible) return no('implausible_future_appointment');
  const hour = etHourFromStartTime(startTime);
  if (hour !== null && (hour < BUSINESS_HOUR_START_ET || hour >= BUSINESS_HOUR_END_ET)) return no('impossible_hour');
  const status = ghlStatusForDisposition(live.disposition || lead.disposition_code);
  if (!status) return no('no_status');
  return { restore: true, reason: 'same_slot_live_sibling', status };
}
