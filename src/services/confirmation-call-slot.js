/**
 * Confirmation Call slot guard — src/services/confirmation-call-slot.js
 *
 * RULE (the user, 2026-10-09): "We should never create a calendar event in Lead
 * Perfection for a confirmation call." A Confirmation Call (and any other
 * GHL-only calendar, see GHL_ONLY_CALENDAR_KEYS) is a phone touch that lives
 * only in GHL. LP holds the estimate visit, never the call.
 *
 * WHY THIS MODULE EXISTS. #1218 (2026-10-08) blocked the paths that KNOW the
 * calendar. Several paths do not: they carry only a date and a time copied from
 * GHL's built-in `last_appointment_start_date/time`, which GHL fills from the
 * contact's last appointment on ANY calendar. Verified in the HL mirror on
 * 2026-10-09: I.LP-OUT "Send Lead to Lead Perfection" (live, through
 * /webhook/ghl/lp-addlead-proxy) sends adate = last_appointment_start_date and
 * atime = last_appointment_start_time, and is started by B.HC, B.HC-L,
 * I.LP-FAIL, S4.6, I.LP-A and our own enrollLpLeadCreation. create_lp_lead and
 * set_lp_appointment fall back to the same fields. For a contact whose last
 * booking is a Confirmation Call, each would write the call's time into LP.
 *
 * So every such path asks one question here: does an ACTIVE GHL-only
 * appointment start at exactly this date and time, with no other active
 * appointment at that instant? Yes → the time is the call, not a visit, and LP
 * gets no appointment. The lead itself still goes to LP.
 *
 * FAIL OPEN on a failed GHL read (returns blocked:false, reason lookup_failed).
 * Refusing an appointment we could not identify would strand real Window
 * Estimates whenever GHL is slow; the callers log the miss, and the parity
 * watchdog and the reconciler no longer treat a Confirmation Call as a visit.
 */

import { fetchUpcomingAppointments } from '../knowledge/contact-appointments.js';
import { isGhlOnlyCalendarId } from '../knowledge/booking-calendar-router.js';
import { lpWallClockToGhlStartTime } from '../appointment-dates.js';
import { normalizeGhlStartTime } from './lp-ghl-appointment-reconciler.js';

const DEAD_STATUSES = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'no-show', 'invalid']);

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' from 'MM/DD/YYYY', 'YYYY-MM-DD…' or 'Month D, YYYY'; null otherwise. */
function isoDatePart(raw) {
  const s = String(raw || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  m = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
  return null;
}

/** 'HH:MM' (24h) from '6:00 PM', '06:00 pm', '18:00' or an ISO 'T18:00'; null otherwise. */
function hhmmPart(raw) {
  let s = String(raw || '').trim();
  if (s.includes('T')) s = s.split('T')[1] || '';
  let m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s);
  if (m) {
    let h = Number(m[1]);
    const pm = m[3].toUpperCase() === 'PM';
    if (h > 12) return null;
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return `${pad(h)}:${m[2]}`;
  }
  m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (m && Number(m[1]) < 24) return `${pad(m[1])}:${m[2]}`;
  return null;
}

/**
 * Pure. An LP-style date + time (ET wall clock, the way GHL's
 * last_appointment fields and LP's adate/atime carry them) → an ISO instant
 * with the DST-correct ET offset. Null when either part is unreadable.
 */
export function lpSlotToStartIso(apptDate, apptTime) {
  const date = isoDatePart(apptDate);
  const hhmm = hhmmPart(apptTime);
  if (!date || !hhmm) return null;
  return lpWallClockToGhlStartTime(`${date}T${hhmm}:00+00:00`);
}

/**
 * Pure. The active GHL-only appointment that starts at `startIso`, or null.
 * Null as well when an active appointment on any OTHER calendar starts at the
 * same instant: then the time is a real visit too, and LP should have it.
 */
export function ghlOnlyAppointmentAtSlot(upcoming, startIso) {
  const target = Date.parse(startIso || '');
  if (!Number.isFinite(target) || !Array.isArray(upcoming)) return null;
  let ghlOnly = null;
  for (const a of upcoming) {
    if (DEAD_STATUSES.has(String(a?.status || '').toLowerCase())) continue;
    const ms = Date.parse(normalizeGhlStartTime(a?.start_time) || '');
    if (ms !== target) continue;
    if (!isGhlOnlyCalendarId(a?.calendar_id)) return null;
    ghlOnly = ghlOnly || a;
  }
  return ghlOnly;
}

/**
 * Is this date + time the contact's Confirmation Call?
 *
 * @returns {Promise<{ blocked: boolean, reason: string, appointment?: object, start_time?: string }>}
 *   reason: 'confirmation_call_slot' (blocked) | 'clear' | 'unreadable_slot' |
 *           'no_contact' | 'lookup_failed' (all three not blocked — fail open)
 */
export async function checkConfirmationCallSlot({ contactId, apptDate, apptTime } = {}, deps = {}) {
  if (!contactId) return { blocked: false, reason: 'no_contact' };
  const startIso = lpSlotToStartIso(apptDate, apptTime);
  if (!startIso) return { blocked: false, reason: 'unreadable_slot' };
  const fetchUpcoming = deps.fetchUpcomingAppointments || fetchUpcomingAppointments;
  let upcoming;
  try {
    upcoming = await fetchUpcoming(contactId);
  } catch {
    upcoming = null;
  }
  if (!Array.isArray(upcoming)) return { blocked: false, reason: 'lookup_failed', start_time: startIso };
  const hit = ghlOnlyAppointmentAtSlot(upcoming, startIso);
  return hit
    ? { blocked: true, reason: 'confirmation_call_slot', appointment: hit, start_time: startIso }
    : { blocked: false, reason: 'clear', start_time: startIso };
}
