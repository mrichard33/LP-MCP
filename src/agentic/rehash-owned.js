/**
 * A rehash lead John owns — src/agentic/rehash-owned.js (Mark, 2026-10-21)
 *
 * Pure. Jim Anderson (5Cp5CiWtQ2zSRlxb2XPL, LP prospect 464257): John Manieri
 * set a call on his Rehash Call calendar and LP had the lead at Cnf for the
 * next morning, and the bot kept answering (a comparison question, then a
 * send queued after John set DND). Mark's ruling with John and Brandon: once
 * a call is on the rehash rep's GHL calendar or an appointment is set in LP,
 * the bot is out. John owns the lead, cancellations included.
 *
 * A rehash contact is OWNED when any of:
 *   a. the GHL tag `rehash-owned` (GHL U.RCB adds it on a Rehash Call booking
 *      New/Confirmed, and John adds it by hand as his stop button; the code
 *      never removes it, so John removing it is the hand-back);
 *   b. an upcoming, not-cancelled appointment on REHASH_CALENDAR_ID;
 *   c. the NEWEST LP lead is Cnf, Issue or Reset with an appointment dated
 *      today or later (Eastern). The F.0 v2 "booked estimate" exit, read
 *      straight from lp_leads, so it never waits on the rehash sweep.
 *
 * Three answers, never a guess: { owned: true, reason }, { owned: false },
 * or { owned: null } when a source could not be read and none said owned.
 * Unknown is never "owned": the bot sends, the same as human-takeover.
 */
import { simModeOverrides } from '../simulator/sim-overrides.js';

export const REHASH_OWNED_TAG = 'rehash-owned';
export const REHASH_OWNED_SKIP_REASON = 'rehash_owned';
export const REHASH_OWNED_MODES = Object.freeze(['off', 'shadow', 'live']);
/** LP dispositions that mean an appointment a person set (Issue = issued to a rep, Reset = re-set). */
export const OWNED_LP_DISPOSITIONS = Object.freeze(['cnf', 'issue', 'reset']);
const DEAD_APPT_STATUSES = new Set(['cancelled', 'canceled', 'noshow', 'no_show', 'invalid']);

const lower = (v) => String(v ?? '').trim().toLowerCase();

function etToday(nowMs) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(nowMs));
}

/** REHASH_OWNED_MODE (default shadow; a bot-gate run may force it). */
export function rehashOwnedMode(env = process.env) {
  const v = lower(simModeOverrides().rehashOwnedMode ?? env?.REHASH_OWNED_MODE);
  return REHASH_OWNED_MODES.includes(v) ? v : 'shadow';
}

/** True when the contact carries the `rehash-owned` tag. */
export function hasOwnedTag(tags) {
  return (Array.isArray(tags) ? tags : []).some((t) => lower(t) === REHASH_OWNED_TAG);
}

/**
 * The first upcoming Rehash Call appointment, or null. `appointments` are
 * fetchRecentAndUpcomingAppointments rows ({ calendar_id, start_time, status }).
 */
export function upcomingRehashCall(appointments, { rehashCalendarId, nowMs = Date.now() } = {}) {
  if (!rehashCalendarId || !Array.isArray(appointments)) return null;
  return appointments.find((a) => String(a?.calendar_id || '') === String(rehashCalendarId)
    && !DEAD_APPT_STATUSES.has(lower(a?.status))
    && (Date.parse(a?.end_time || a?.start_time || '') || 0) > nowMs) || null;
}

/** True when the newest lead is Cnf / Issue / Reset with an appointment today or later (ET). */
export function isOwnedLpLead(lead, nowMs = Date.now()) {
  if (!lead || !OWNED_LP_DISPOSITIONS.includes(lower(lead.disposition_code))) return false;
  // lp_leads.appointment_date is the ET wall clock tagged +00:00, so its first
  // ten characters ARE the Eastern date (the same read as s52-entry-gate.js).
  const d = lead.appointment_date ? String(lead.appointment_date).slice(0, 10) : null;
  return !!d && d >= etToday(nowMs);
}

/**
 * @param {{ tags?: string[], appointments?: object[]|null, currentLead?: object|null,
 *           rehashCalendarId?: string|null, nowMs?: number }} a
 *   appointments: null/undefined when the read failed; currentLead: undefined when the read failed
 * @returns {{ owned: true, reason: 'a'|'b'|'c', detail?: object } | { owned: false } | { owned: null, unknown: string[] }}
 */
export function rehashOwned({ tags = [], appointments, currentLead, rehashCalendarId = null, nowMs = Date.now() } = {}) {
  if (hasOwnedTag(tags)) return { owned: true, reason: 'a', detail: { tag: REHASH_OWNED_TAG } };
  const unknown = [];
  if (Array.isArray(appointments)) {
    const call = upcomingRehashCall(appointments, { rehashCalendarId, nowMs });
    if (call) return { owned: true, reason: 'b', detail: { appointment_id: call.appointment_id || null, start_time: call.start_time || null } };
  } else if (rehashCalendarId) unknown.push('appointments');
  if (currentLead === undefined) unknown.push('lp_lead');
  else if (isOwnedLpLead(currentLead, nowMs)) {
    return { owned: true, reason: 'c', detail: { disposition: currentLead.disposition_code, appointment_date: String(currentLead.appointment_date).slice(0, 10) } };
  }
  return unknown.length ? { owned: null, unknown } : { owned: false };
}

/** What to do with a bot send to a rehash contact. Pure. */
export function ownedDecision({ mode = 'shadow', owned = null } = {}) {
  if (!REHASH_OWNED_MODES.includes(mode) || mode === 'off' || owned?.owned !== true) return 'send';
  return mode === 'live' ? 'skip' : 'would_skip';
}
