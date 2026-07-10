/**
 * Calendar-wide live GHL read — src/services/ghl-calendar-read.js
 *
 * The reconciler and the LP contact backstop only ever read appointments
 * PER-CONTACT (GET /contacts/{id}/appointments). Three new needs — the dedupe
 * pass, the dashboard live count, and the live parity report — want the whole
 * calendar for a day/window, which the v2 GET /calendars/events list provides
 * (it takes calendarId + startTime/endTime as EPOCH MILLISECONDS; it rejects a
 * contactId param, so it is strictly calendar-scoped).
 *
 * All I/O via ghlFetch (Bearer + Version 2021-07-28 + token bucket). start_time
 * is normalized through the reconciler's normalizeGhlStartTime so naive GHL
 * wall-clock strings gain the DST-correct ET offset, matching every other
 * appointment comparison in the codebase.
 *
 * FALLBACK: if a deployment's GHL rejects the calendar-wide list shape, callers
 * can fall back to per-contact reads (reconciler.fetchUpcomingAppointmentsNormalized)
 * over a known contact set — but the calendar-wide path is the intended one and
 * is validated live (WE / 7-11 → 49 active) before rollout.
 */

import { ghlFetch } from '../actions/helpers.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { ESTIMATE_CALENDAR_IDS, normalizeGhlStartTime } from './lp-ghl-appointment-reconciler.js';

// Mirrors the reconciler's NON_ACTIVE_APPOINTMENT_STATUSES (module-private there).
const NON_ACTIVE_STATUSES = new Set([
  'cancelled', 'canceled', 'no_show', 'noshow', 'no-show', 'invalid',
]);

export function isActiveStatus(status) {
  return !NON_ACTIVE_STATUSES.has(String(status || '').toLowerCase());
}

// Tolerant mapping of a GHL /calendars/events element to the codebase's
// appointment shape (same keys the per-contact reader returns).
function mapEvent(e) {
  return {
    appointment_id: e.id || e.appointmentId || null,
    calendar_id: e.calendarId || e.calendar_id || null,
    contact_id: e.contactId || e.contact_id || null,
    start_time: normalizeGhlStartTime(e.startTime || e.start_time || e.startTimeISO || null),
    end_time: e.endTime || e.end_time || null,
    status: e.appointmentStatus || e.status || null,
    title: e.title || null,
    assigned_user_id: e.assignedUserId || e.assigned_user_id || null,
    date_added: e.dateAdded || e.date_added || null,
  };
}

/**
 * List every event on ONE calendar within [startMs, endMs] (epoch millis).
 * Returns mapped+normalized events (all statuses; filter with isActiveStatus).
 */
export async function listCalendarEvents({ calendarId, startMs, endMs }) {
  if (!calendarId) throw new Error('listCalendarEvents: calendarId required');
  const qs = `locationId=${GHL_LOCATION_ID}&calendarId=${calendarId}&startTime=${startMs}&endTime=${endMs}`;
  const res = await ghlFetch('GET', `/calendars/events?${qs}`);
  const events = Array.isArray(res?.events) ? res.events
    : Array.isArray(res?.appointments) ? res.appointments
    : Array.isArray(res) ? res : [];
  // GHL's /calendars/events returns events PAST the endTime we pass (verified
  // live: a 7/11 query returned 7/12 appointments), which surfaced as false
  // "orphans" in the parity report once the LP side was correctly narrowed.
  // Strictly re-bound to [startMs, endMs) here so every consumer is window-
  // accurate regardless of GHL's loose endTime handling. Half-open, matching
  // the LP-side expectationInWindow.
  const inWindow = (e) => {
    const ms = Date.parse(e.start_time || '');
    return !Number.isNaN(ms) && ms >= startMs && ms < endMs;
  };
  return events.map(mapEvent).filter(inWindow);
}

/**
 * Union of active estimate-pool appointments (WE + MV + HPA) within the window.
 * `activeOnly` (default true) drops cancelled/no-show/invalid.
 */
export async function listEstimatePoolEvents({ startMs, endMs, activeOnly = true }) {
  const calendarIds = Array.from(ESTIMATE_CALENDAR_IDS);
  const all = [];
  for (const calendarId of calendarIds) {
    const events = await listCalendarEvents({ calendarId, startMs, endMs });
    all.push(...events);
  }
  return activeOnly ? all.filter((e) => isActiveStatus(e.status)) : all;
}
