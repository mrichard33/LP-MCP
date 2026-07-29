/**
 * GHL slot-uniqueness check — src/appointments/slot-check.js
 *
 * Two systems create appointments on the estimate calendars and neither asks
 * GHL whether the slot is already taken: LP MCP via the API (surfacing in GHL
 * as createdBy.source = third_party) and the GHL workflow I.LP-IN via native
 * booking nodes (source = workflow). Measured 2026-07-28 over 60 days on the
 * three booking calendars, grouped by (contact, calendar, minute): 619 of 5,182
 * slots held more than one appointment, and 400 of those 619 were MIXED — one
 * from each writer. Fixing a single writer therefore leaves ~two thirds of the
 * problem in place, which is why this lives in a shared module consumed by both
 * the in-process call sites and the delegated booking endpoint.
 *
 * WHY NOT the existing guards:
 *   • The `already_in_sync` / `duplicate_sync_suppressed` outcomes test LP MCP's
 *     OWN recorded state, not whether GHL holds the slot.
 *   • executeBookAppointment's findExistingAppointmentOnCalendar is CALENDAR-
 *     scoped (any active appointment on the calendar) and fail-open. This is
 *     SLOT-scoped and reports lookup failure to the caller instead of
 *     swallowing it.
 *
 * WHY NOT the HL Supabase `appointments` cache: its deleted_at column is
 * corrupt — 8,028 of 8,087 rows are tombstoned while GHL's own raw_json.deleted
 * is false on every one of them (bulk-swept, 993 rows share a single
 * microsecond). It also lags. GHL is queried live, always.
 *
 * REJECTED SIGNALS, do not revive: the `appt-exists` tag (1,240 tagged vs 283
 * live — 21% precision, and a one-way ratchet), and the `Appointment DateTime`
 * contact field (28% recall).
 *
 * Time comparison is on ABSOLUTE INSTANTS. GHL returns ISO with an offset, and
 * some paths return naive wall-clock; both sides go through the reconciler's
 * normalizeGhlStartTime (DST-correct ET) and then Date.parse to epoch ms, so a
 * string compare can never sneak in.
 */

import { fetchUpcomingAppointments } from '../knowledge/contact-appointments.js';
import { normalizeGhlStartTime } from '../services/lp-ghl-appointment-reconciler.js';
import { emitEvent } from '../event-emitter.js';

/** Statuses that mean "this slot is taken". Mirrors the brief's ('new','confirmed'). */
const OCCUPYING_STATUSES = new Set(['new', 'confirmed']);

const DEFAULT_MATCH_WINDOW_S = 60;

/** Feature flag — read per call so a Railway redeploy is not needed to flip it in tests. */
export function isSlotCheckEnabled() {
  return String(process.env.APPT_SLOT_CHECK_ENABLED || '').trim().toLowerCase() === 'true';
}

/** Start times within N seconds of each other are the same slot. */
export function matchWindowSeconds() {
  const raw = parseInt(process.env.APPT_SLOT_MATCH_WINDOW_S || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MATCH_WINDOW_S;
}

/**
 * Read an appointment's status tolerantly.
 *
 * GHL's payload carries a MISSPELLED `appoinmentStatus` (no 't') alongside the
 * correct `appointmentStatus` — 7,410 of 8,087 cached rows have both. The
 * correct spelling is present on all of them, so this is belt-and-braces, but
 * the misspelling is real and cheap to absorb.
 */
export function readStatus(appt) {
  if (!appt) return '';
  return String(
    appt.status ?? appt.appointmentStatus ?? appt.appoinmentStatus ?? ''
  ).trim().toLowerCase();
}

/** Epoch ms for a GHL timestamp, offset-normalized first. NaN when unparseable. */
function toEpochMs(value) {
  if (!value) return NaN;
  return Date.parse(normalizeGhlStartTime(value) || '');
}

/**
 * Does this appointment occupy the target slot?
 * Pure — exported so the window logic is unit-testable without any I/O.
 */
export function occupiesSlot(appt, { calendarId, targetMs, windowMs }) {
  if (!appt) return false;
  if (calendarId && appt.calendar_id !== calendarId) return false;
  if (appt.deleted === true) return false;
  if (!OCCUPYING_STATUSES.has(readStatus(appt))) return false;

  const apptMs = toEpochMs(appt.start_time);
  if (Number.isNaN(apptMs) || Number.isNaN(targetMs)) return false;
  return Math.abs(apptMs - targetMs) <= windowMs;
}

/**
 * Ask GHL LIVE whether this contact already holds an appointment on this
 * calendar at this slot.
 *
 * Returns a discriminated result rather than a bare appointment-or-null, because
 * conflating "lookup failed" with "no conflict" is the specific way this class
 * of check fails silently. (Precedent: fetchLatestAppointment in
 * lp-appointment-sync.js has been 404ing in production for months and degrading
 * to null — for a slot check that would read as "slot is free" and authorize
 * every duplicate it was written to prevent.)
 *
 * @returns {Promise<{ outcome: 'match'|'clear'|'error',
 *                     appointment: object|null, reason: string }>}
 */
export async function findExistingAppointment({ contactId, calendarId, startTime }) {
  if (!contactId || !startTime) {
    return { outcome: 'error', appointment: null, reason: 'missing_contact_or_start_time' };
  }

  const targetMs = toEpochMs(startTime);
  if (Number.isNaN(targetMs)) {
    return { outcome: 'error', appointment: null, reason: 'unparseable_start_time' };
  }

  let upcoming;
  try {
    upcoming = await fetchUpcomingAppointments(contactId);
  } catch (err) {
    console.warn(`[SlotCheck] live lookup threw for ${contactId}: ${err.message}`);
    return { outcome: 'error', appointment: null, reason: 'lookup_threw' };
  }

  // fetchUpcomingAppointments returns null on a non-ok response, a missing API
  // key, or a timeout — NOT an empty calendar. Must not be read as "clear".
  if (!Array.isArray(upcoming)) {
    return { outcome: 'error', appointment: null, reason: 'lookup_failed' };
  }

  const windowMs = matchWindowSeconds() * 1000;
  const match = upcoming.find((a) => occupiesSlot(a, { calendarId, targetMs, windowMs })) || null;

  return match
    ? { outcome: 'match', appointment: match, reason: 'slot_occupied' }
    : { outcome: 'clear', appointment: null, reason: 'slot_free' };
}

/**
 * Record one booking decision in system_events. Best-effort: observability must
 * never be able to fail a booking.
 *
 * `budget_exceeded` is its OWN subtype, never folded into `error`. It is the one
 * outcome that can leave an abandoned create in flight and therefore produce a
 * duplicate, so it has to be countable on its own. `query_failed` is likewise
 * first-class rather than swallowed — a fall-through create after a failed
 * lookup is the other path that can still duplicate.
 *
 * FIRE-AND-FORGET. Callers must `void` this, never `await` it. emitEvent makes
 * two Supabase calls, each bounded by EMIT_EVENT_TIMEOUT_MS (default 6000) —
 * up to 12s worst case, which does not fit inside the endpoint's 8s response
 * budget. The internal catch means a rejected promise can never surface.
 *
 * NOTE for anyone querying these: system_events.created_at is genuine UTC, so
 * bucket it with AT TIME ZONE 'America/New_York'. Do NOT apply that cast to
 * lp_call_logs.call_date or lp_leads.appointment_date — those hold LP
 * wall-clock in a timestamptz column and the cast double-shifts them 4 hours.
 *
 * @param {'created'|'updated'|'noop_already_exists'|'error'|'budget_exceeded'|'query_failed'} subtype
 * @param {object} opts
 * @param {object} [deps] injectable emitter for tests — ESM namespace objects
 *   are frozen, so this mirrors claimAppointmentCreate's injectable `client`
 *   (services/appointment-sync-claim.js) rather than trying to patch the module.
 */
export async function emitSlotCheckEvent(
  subtype,
  { contactId, calendarId, startTime, matched, extra = {} },
  { emit = emitEvent } = {},
) {
  try {
    const slotMs = toEpochMs(startTime);
    await emit({
      event_type: 'appt.booking',
      event_subtype: subtype,
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      // Subtype + emit time are BOTH in the key. The previous form
      // (slot_<contact>_<calendar>_<slotMs>) carried neither, so for a given
      // slot only the FIRST decision ever persisted — a later `updated` or
      // `created` hit the idempotency SELECT in emitEvent and returned null
      // silently. One row per decision is the point here; this is not a dedup
      // guard. Same rationale as lp-appointment-sync.js:501-503.
      idempotency_key: `book_${contactId}_${calendarId}_${Number.isNaN(slotMs) ? 'na' : slotMs}_${subtype}_${Date.now()}`,
      payload: {
        contactId,
        calendarId,
        startTime,
        matched_appointment_id: matched?.appointment_id || null,
        matchedStartTime: matched?.start_time || null,
        matchedStatus: matched ? readStatus(matched) : null,
        matchWindowSeconds: matchWindowSeconds(),
        ...extra,
      },
      // MANDATORY. 'appt.booking' is NOT in ALLOWED_EVENT_TYPES
      // (services/event-intake-filter.js:111-166) and never will be — that
      // list's contract is "types with >=1 consuming agent_rule" and this is
      // pure telemetry. shouldAllowEvent() is default-DROP (188,654 rows
      // diverted in 30 days), so without bypass_filter every row lands in
      // system_events_filtered with reason "event_type_not_in_allowlist",
      // expires in 72h, and the observation window produces NOTHING. Precedent:
      // agentic.hold_error, documented verbatim at event-intake-filter.js:133-134.
      bypass_filter: true,
    });
  } catch (err) {
    console.warn(`[SlotCheck] event emit failed for ${contactId}: ${err.message}`);
  }
}
