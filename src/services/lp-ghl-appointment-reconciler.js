/**
 * LP→GHL appointment reconciler — src/services/lp-ghl-appointment-reconciler.js
 *
 * Shared core for the `sync_lp_appointment_to_ghl` action handler and the
 * one-time backfill script (scripts/backfill-ghl-appointments.js). On an LP
 * disposition change (Set / Cnf / CXL) it converges the GHL Window Estimate
 * calendar to LP reality. LP IS THE AUTHORITY here, which is why this module
 * exists instead of reusing book_appointment / update_appointment_status:
 *
 *   - No decision-makers backstop: the call center's Cnf in LP IS the
 *     confirmation authority; the bot-flow backstop would silently downgrade
 *     every LP confirmation to 'new'.
 *   - No R2 in-home prerequisite gate: the call center already qualified
 *     these leads; the gate would block legitimate LP-sourced bookings.
 *   - ignoreFreeSlotValidation: LP's slot is reality; GHL availability must
 *     not block mirroring it.
 *
 * Loop safety: our POST/PUT fires ghl.appointment_booked/cancelled webhooks,
 * whose GHL→LP leg (lp-appointment-sync.js → executeSetLPAppointment) skips
 * with already_set_in_lp when LP already holds the mirrored date — which it
 * does by construction, since LP is where the date came from. Proven by
 * scripts/test-lp-ghl-appointment-roundtrip.js.
 *
 * Appointment lookup FAILS CLOSED: fetchUpcomingAppointments returning null
 * means the lookup FAILED (not "no appointments") — creating on top of that
 * risks a double-book, so we throw and let the executor retry. This is a
 * deliberate deviation from the fail-open guard in handlers/appointments.js.
 */

import { ghlFetch } from '../actions/helpers.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { getContactCached } from '../actions/contact-cache.js';
import { fetchUpcomingAppointments } from '../knowledge/contact-appointments.js';
import { BOOKING_CALENDARS, isInHomeCalendarId } from '../knowledge/booking-calendar-router.js';
import { syncCancelledAppointmentState } from '../actions/handlers/appointment-field-sync.js';
import { lpWallClockToGhlStartTime } from '../appointment-dates.js';

export const WINDOW_ESTIMATE_CALENDAR_ID = BOOKING_CALENDARS.WINDOW_ESTIMATE;

const APPOINTMENT_DURATION_MS = 90 * 60 * 1000;

// Full set from handlers/appointments.js (not exported there). Required here:
// fetchUpcomingAppointments filters only cancelled/noshow/no-show, so
// 'canceled', 'no_show' and 'invalid' leak through — without this re-filter a
// Set would reschedule a dead appointment and a Cnf would resurrect it.
const NON_ACTIVE_APPOINTMENT_STATUSES = new Set([
  'cancelled', 'canceled', 'no_show', 'noshow', 'no-show', 'invalid',
]);

// Consent family: suppress Set/Cnf creation, but CXL still processes — a
// cancellation is honoring the contact's wishes, not marketing to them.
const CONSENT_BLOCK_TAGS = new Set([
  'dnc', 'dnc-sms', 'do-not-contact', 'stage:dnc', 'unsubscribed',
]);

/** Map an LP disposition code to a reconciliation kind. */
export function classifyDisposition(code) {
  const c = String(code || '').trim();
  if (c === 'Set') return 'set';
  if (c === 'Cnf') return 'confirm';
  if (c === 'CXL') return 'cancel';
  return 'out_of_scope';
}

/** Epoch-equality of two ISO timestamps; unparseable → false (favors reschedule over silent no-op). */
export function sameStartTime(a, b) {
  const aMs = Date.parse(a || '');
  const bMs = Date.parse(b || '');
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) return false;
  return aMs === bMs;
}

/**
 * Pure decision table — no I/O. `existing` is the active Window Estimate
 * appointment ({ appointment_id, start_time, status }) or null.
 *
 * @returns {{ op: 'create'|'reschedule'|'confirm'|'reschedule_confirm'|'cancel'|'noop',
 *             status?: string, reason?: string }}
 */
export function planReconciliation({ kind, startTime, existing, nowMs = Date.now() }) {
  if (kind === 'out_of_scope') return { op: 'noop', reason: 'out_of_scope' };

  // Cancel ignores the date guards: LP says this appointment is dead, and
  // that holds whether or not we can parse when it was.
  if (kind === 'cancel') {
    return existing
      ? { op: 'cancel' }
      : { op: 'noop', reason: 'nothing_to_cancel' };
  }

  if (!startTime) return { op: 'noop', reason: 'no_appointment_date' };
  const startMs = Date.parse(startTime);
  if (Number.isNaN(startMs) || startMs < nowMs) {
    return { op: 'noop', reason: 'past_appointment_date' };
  }

  if (kind === 'set') {
    if (!existing) return { op: 'create', status: 'new' };
    if (sameStartTime(existing.start_time, startTime)) {
      // Never downgrade: a Cnf may have raced ahead of this Set.
      return { op: 'noop', reason: 'already_in_sync' };
    }
    return { op: 'reschedule' }; // keep the existing status
  }

  if (kind === 'confirm') {
    if (!existing) return { op: 'create', status: 'confirmed' };
    if (sameStartTime(existing.start_time, startTime)) {
      return String(existing.status).toLowerCase() === 'confirmed'
        ? { op: 'noop', reason: 'already_in_sync' }
        : { op: 'confirm' };
    }
    return { op: 'reschedule_confirm' };
  }

  return { op: 'noop', reason: 'out_of_scope' };
}

function endTimeFor(startTime) {
  return new Date(Date.parse(startTime) + APPOINTMENT_DURATION_MS).toISOString();
}

async function contactHasConsentBlock(contactId, contactCache) {
  try {
    const contact = await getContactCached(contactId, contactCache);
    const tags = Array.isArray(contact?.tags) ? contact.tags : [];
    return tags.some((t) => CONSENT_BLOCK_TAGS.has(String(t).toLowerCase().trim()));
  } catch (err) {
    // Fail open: a transient contact-read failure must not strand the
    // calendar out of sync; DNC contacts are also blocked at send time.
    console.warn(`[LpGhlApptSync] contact read failed for ${contactId} (proceeding): ${err.message}`);
    return false;
  }
}

/**
 * Reconcile the GHL Window Estimate calendar to one lp_leads row.
 *
 * The `lead` row is INJECTED (no supabase read here) so the caller controls
 * freshness and tests run with supabase unset.
 *
 * @param {object} args
 * @param {string} args.contactId          GHL contact id
 * @param {object} args.lead               lp_leads row: { lp_lead_id, disposition_code, appointment_date }
 * @param {boolean} [args.toNotify=true]   false for backfill (suppress GHL notifications)
 * @param {Map}    [args.contactCache]     per-batch contact cache
 * @param {boolean} [args.dryRun=false]    plan only — zero mutations (still GETs)
 * @returns {Promise<object>} { outcome: 'created'|'rescheduled'|'status_updated'|'cancelled'|'noop',
 *   appointment_id, start_time, previous_start_time?, skipped?, reason?, planned_op? }
 */
export async function reconcileLpAppointmentToGhl({ contactId, lead, toNotify = true, contactCache, dryRun = false }) {
  if (!contactId) throw new Error('reconcileLpAppointmentToGhl: contactId is required');
  if (!lead) throw new Error('reconcileLpAppointmentToGhl: lead row is required');

  const kind = classifyDisposition(lead.disposition_code);
  const startTime = lpWallClockToGhlStartTime(lead.appointment_date);

  const base = {
    contact_id: contactId,
    lp_lead_id: lead.lp_lead_id || null,
    disposition_code: lead.disposition_code || null,
    start_time: startTime,
  };
  const noop = (reason, extra = {}) => ({ ...base, outcome: 'noop', skipped: true, reason, ...extra });

  if (kind === 'out_of_scope') return noop('out_of_scope');

  // Consent guard — creation only. CXL must still cancel.
  if (kind !== 'cancel' && await contactHasConsentBlock(contactId, contactCache)) {
    return noop('dnc_consent');
  }

  // FAIL CLOSED on lookup failure (null ≠ empty array) — see module header.
  const upcoming = await fetchUpcomingAppointments(contactId);
  if (!Array.isArray(upcoming)) {
    throw new Error(`appointment lookup failed for contact ${contactId} — refusing to reconcile blind`);
  }

  // Only the Window Estimate calendar, only ACTIVE appointments (see
  // NON_ACTIVE_APPOINTMENT_STATUSES note above). GHL-only calendars
  // (Confirmation Call) are excluded by the calendar-id scope itself.
  const active = upcoming.filter((a) =>
    !NON_ACTIVE_APPOINTMENT_STATUSES.has(String(a.status || '').toLowerCase()));
  const weAppointments = active.filter((a) => a.calendar_id === WINDOW_ESTIMATE_CALENDAR_ID);
  if (weAppointments.length > 1) {
    console.warn(`[LpGhlApptSync] contact ${contactId} has ${weAppointments.length} active WE appointments — reconciling the soonest, not auto-cancelling extras`);
  }
  const existing = weAppointments[0] || null; // list is soonest-first

  // No active WE, but an active appointment on ANOTHER in-home calendar
  // (Home Protection Assessment / Measurement Verification): creating a WE
  // would double-book the home visit — e.g. bot books HPA → GHL→LP sync sets
  // the LP appointment → LP emits Set → we'd mirror it back as a duplicate
  // WE. Those calendars are never ours to touch (strict WE scope), so block
  // creation and surface the mismatch instead.
  if (!existing && kind !== 'cancel') {
    const otherInHome = active.find((a) =>
      a.calendar_id && a.calendar_id !== WINDOW_ESTIMATE_CALENDAR_ID && isInHomeCalendarId(a.calendar_id));
    if (otherInHome) {
      console.warn(`[LpGhlApptSync] contact ${contactId} has an active in-home appointment on calendar ${otherInHome.calendar_id} (${otherInHome.appointment_id}) — skipping WE ${kind} to avoid double-booking`);
      return noop('active_other_in_home_appointment', {
        other_calendar_id: otherInHome.calendar_id,
        other_appointment_id: otherInHome.appointment_id,
        other_start_time: otherInHome.start_time,
      });
    }
  }

  const plan = planReconciliation({ kind, startTime, existing });

  if (plan.op === 'noop') return noop(plan.reason);

  if (dryRun) {
    return {
      ...base,
      outcome: 'noop',
      skipped: true,
      reason: 'dry_run',
      planned_op: plan.op,
      planned_status: plan.status || null,
      appointment_id: existing?.appointment_id || null,
      previous_start_time: existing?.start_time || null,
    };
  }

  if (plan.op === 'create') {
    const res = await ghlFetch('POST', '/calendars/events/appointments', {
      calendarId: WINDOW_ESTIMATE_CALENDAR_ID,
      locationId: GHL_LOCATION_ID,
      contactId,
      startTime,
      endTime: endTimeFor(startTime),
      title: 'Window Estimate',
      appointmentStatus: plan.status,
      toNotify,
      ignoreFreeSlotValidation: true,
    });
    const appointmentId = res?.id || res?.appointment?.id || null;
    if (!appointmentId) console.warn(`[LpGhlApptSync] POST created appointment for ${contactId} but no id in response`);
    return { ...base, outcome: 'created', appointment_id: appointmentId, new_status: plan.status };
  }

  const appointmentId = existing.appointment_id;

  if (plan.op === 'reschedule' || plan.op === 'reschedule_confirm') {
    await ghlFetch('PUT', `/calendars/events/appointments/${appointmentId}`, {
      calendarId: WINDOW_ESTIMATE_CALENDAR_ID,
      startTime,
      endTime: endTimeFor(startTime),
    });
    if (plan.op === 'reschedule') {
      return { ...base, outcome: 'rescheduled', appointment_id: appointmentId, previous_start_time: existing.start_time };
    }
    // reschedule_confirm: second PUT for status. Reschedule ran first so a
    // status failure still leaves the correct time in place.
    await ghlFetch('PUT', `/calendars/events/appointments/${appointmentId}`, { appointmentStatus: 'confirmed' });
    return {
      ...base, outcome: 'status_updated', appointment_id: appointmentId,
      new_status: 'confirmed', rescheduled: true, previous_start_time: existing.start_time,
    };
  }

  if (plan.op === 'confirm') {
    await ghlFetch('PUT', `/calendars/events/appointments/${appointmentId}`, { appointmentStatus: 'confirmed' });
    return { ...base, outcome: 'status_updated', appointment_id: appointmentId, new_status: 'confirmed' };
  }

  if (plan.op === 'cancel') {
    // NO reschedule-inflight marker here: an LP CXL is a real customer
    // cancellation — the rebook/rescue rules (GHL_APPT_CANCELLED_REBOOK*)
    // SHOULD see the cancellation webhook.
    await ghlFetch('PUT', `/calendars/events/appointments/${appointmentId}`, { appointmentStatus: 'cancelled' });
    await syncCancelledAppointmentState(contactId, {
      appointmentId,
      calendarId: WINDOW_ESTIMATE_CALENDAR_ID,
    }).catch((err) => {
      console.warn(`[LpGhlApptSync] cancelled-state field sync failed for ${contactId}: ${err.message}`);
      return null;
    });
    return { ...base, outcome: 'cancelled', appointment_id: appointmentId, new_status: 'cancelled' };
  }

  return noop('unknown_plan_op');
}
