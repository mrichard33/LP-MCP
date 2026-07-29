/**
 * Delegated booking endpoint — src/appointments/booking-endpoint.js
 *
 * POST /webhook/ghl/book-appointment
 *
 * WHY THIS EXISTS
 * The GHL workflow I.LP-IN books appointments with native `appointment_booking`
 * nodes. Every node sets `ignoreFreeSlots: true`, so GHL is explicitly told to
 * disregard slot availability. Those nodes are the `source = workflow` half of
 * the double-booking: measured 2026-07-29 over 7 days on the three booking
 * calendars, 155 of 900 slots held more than one appointment and 137 of those
 * 155 were MIXED — one from the workflow and one from LP MCP.
 *
 * I.LP-IN is NOT a fallback for leads LP MCP cannot resolve. It wins on LATENCY:
 * it books straight off the LP webhook, ahead of lp_sync's 15–38 minute cadence,
 * after which LP MCP correctly sees the slot as already in sync and skips. That
 * is why the nodes get a delegation endpoint rather than being deleted — the
 * speed is the point, the blind create is not.
 *
 * Only three booking nodes remain live, under the `Appointment Booked`
 * disposition branch: Book Home Protection Assessment, Book Measurement
 * Verification Appointment, Book Window Estimate Appointment. Mark rewires them
 * ONE branch at a time, watching daily creation volume after each — if volume
 * drops, the native node on that branch goes back. The native nodes are never
 * deleted, only moved onto the failure path.
 *
 * REQUEST CONTRACT
 *   POST /webhook/ghl/book-appointment
 *   Header: x-appt-booking-key: <APPT_BOOKING_ENDPOINT_KEY>
 *   {
 *     "contactId":      "{{contact.id}}",
 *     "calendarId":     "<hardcoded per branch, unchanged>",
 *     "startTime":      "{{custom_code.N.output.appointmentDateTime}}",
 *     "firstName":      "{{contact.first_name}}",   // optional, for the title
 *     "lastName":       "{{contact.last_name}}",    // optional, for the title
 *     "address1":       "{{contact.address1}}",     // optional, for the address
 *     "city":           "{{contact.city}}",         // optional
 *     "state":          "{{contact.state}}",        // optional
 *     "postalCode":     "{{contact.postal_code}}",  // optional
 *     "assignedUserId": "3K6HtoPyBLWeQrrnSnCD",     // optional
 *     "status":         "confirmed"                 // optional
 *   }
 *
 * Deliberately does NOT require an LP lead id — contactId plus the slot is
 * sufficient. I.LP-IN calls this for contacts LP MCP may not resolve, and
 * requiring lead resolution would reintroduce exactly the latency this endpoint
 * exists to avoid.
 *
 * RESPONSE — flat and stable, Mark branches on this in the GHL UI:
 *   { "outcome": "created" | "updated" | "noop_already_exists" | "error",
 *     "appointmentId": "<id or null>",
 *     "message": "<short diagnostic>" }
 *
 * created / updated / noop_already_exists all mean I.LP-IN must NOT fall back to
 * native booking. Only `error` should.
 *
 * ALWAYS HTTP 200, including on internal failure. A non-2xx may render as an
 * unparseable response in GHL and cost Mark the ability to branch cleanly; the
 * real detail rides in `message` instead.
 *
 * Auth: APPT_BOOKING_ENDPOINT_KEY, constant-time, FAIL CLOSED when unset.
 * Gate: returns outcome 'error' unless APPT_SLOT_CHECK_ENABLED === 'true', so a
 * branch wired up before enable falls back to its native node rather than
 * silently double-booking. Ships dark.
 */

import crypto from 'crypto';
import { ghlFetch } from '../actions/helpers.js';
import { GHL_LOCATION_ID } from '../actions/constants.js';
import { findExistingAppointment, emitSlotCheckEvent, isSlotCheckEnabled, readStatus } from './slot-check.js';
import { applyAppointmentFormat } from './format.js';
import { claimAppointmentCreate, releaseAppointmentCreate } from '../services/appointment-sync-claim.js';

const APPOINTMENT_DURATION_MS = 90 * 60_000;
const DEFAULT_BUDGET_MS = 8000;

/** Hard budget before we abandon and let the native node book instead. */
export function bookingBudgetMs() {
  const raw = parseInt(process.env.APPT_BOOKING_BUDGET_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_MS;
}

/**
 * Constant-time key compare over SHA-256 digests, so the buffers are always
 * equal length and the real key's length never leaks. Fails closed when the
 * env var is unset — an unconfigured endpoint accepts nothing.
 */
function keyMatches(provided) {
  const expected = process.env.APPT_BOOKING_ENDPOINT_KEY || '';
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function endTimeFor(startTime, endTime) {
  if (endTime) return endTime;
  const ms = Date.parse(startTime);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms + APPOINTMENT_DURATION_MS).toISOString();
}

/**
 * Race `work` against the response budget.
 *
 * Resolves to { timedOut: false, value } when the work wins, or
 * { timedOut: true } when the deadline does. Rejects only if the work rejects
 * before the deadline.
 *
 * The loser is NOT cancelled — an abandoned create may still land in GHL. That
 * is deliberate: a duplicate is visible and recoverable, a missed appointment is
 * neither. The caller records `budget_exceeded` as its own event subtype so
 * those are countable and sweepable.
 *
 * Exported for tests: the alternative is a timing-dependent test that has to
 * make a real network call slow, which is exactly the kind of flake a response
 * budget should not be guarded by.
 */
export function raceWithBudget(work, budgetMs) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __budgetExceeded: true }), budgetMs);
  });
  return Promise.race([work.then((value) => ({ value })), deadline])
    .then((winner) => (winner?.__budgetExceeded ? { timedOut: true } : { timedOut: false, value: winner.value }))
    .finally(() => clearTimeout(timer));
}

/** The one response shape. Always 200, always these three keys. */
function respond(res, outcome, appointmentId, message) {
  return res.status(200).json({
    outcome,
    appointmentId: appointmentId || null,
    message: String(message || ''),
  });
}

/**
 * The booking work itself, minus the budget. Split out so the handler can race
 * it against a deadline without the timeout path having to understand any of it.
 *
 * @returns {Promise<{outcome: string, appointmentId: string|null, message: string}>}
 */
async function doBooking({ contactId, calendarId, startTime, requestedStatus, assignedUserId, endTime, title, contact, startedAt }) {
  const elapsed = () => Date.now() - startedAt;

  // ─── Slot check ──────────────────────────────────────────────────
  const check = await findExistingAppointment({ contactId, calendarId, startTime });

  if (check.outcome === 'error') {
    // Does NOT fall through to a blind create. The workflow branches on `error`
    // and falls back to its native booking node, which preserves coverage
    // without this endpoint having to guess.
    void emitSlotCheckEvent('query_failed', {
      contactId, calendarId, startTime, matched: null,
      extra: { caller: 'endpoint', reason: check.reason, duration_ms: elapsed() },
    });
    return { outcome: 'error', appointmentId: null, message: `slot_lookup_failed:${check.reason}` };
  }

  if (check.outcome === 'match') {
    const existing = check.appointment;
    const currentStatus = readStatus(existing);

    // Slot already held. Only touch it when the status actually differs — a
    // needless PUT would churn GHL and fire appointment-update automations.
    if (requestedStatus && currentStatus && requestedStatus !== currentStatus) {
      await ghlFetch('PUT', `/calendars/events/appointments/${existing.appointment_id}`, {
        appointmentStatus: requestedStatus,
      });
      void emitSlotCheckEvent('updated', {
        contactId, calendarId, startTime, matched: existing,
        extra: { caller: 'endpoint', from: currentStatus, to: requestedStatus, duration_ms: elapsed() },
      });
      return {
        outcome: 'updated',
        appointmentId: existing.appointment_id,
        message: `status ${currentStatus} -> ${requestedStatus}`,
      };
    }

    void emitSlotCheckEvent('noop_already_exists', {
      contactId, calendarId, startTime, matched: existing,
      extra: { caller: 'endpoint', duration_ms: elapsed() },
    });
    return {
      outcome: 'noop_already_exists',
      appointmentId: existing.appointment_id,
      message: `slot already held (${currentStatus})`,
    };
  }

  // ─── Slot is clear → create ──────────────────────────────────────
  // Claim first, closing the sub-second read-after-write window between the
  // check above and the POST below. FAIL-OPEN (see appointment-sync-claim.js).
  const slotMs = Date.parse(startTime);
  const claim = await claimAppointmentCreate(contactId, slotMs);
  if (!claim.claimed) {
    void emitSlotCheckEvent('noop_already_exists', {
      contactId, calendarId, startTime, matched: null,
      extra: { caller: 'endpoint', reason: 'create_claim_held', duration_ms: elapsed() },
    });
    return { outcome: 'noop_already_exists', appointmentId: null, message: 'create_claim_held' };
  }

  const body = {
    calendarId,
    locationId: GHL_LOCATION_ID,
    contactId,
    startTime,
    endTime: endTimeFor(startTime, endTime),
    title,
    appointmentStatus: requestedStatus || 'confirmed',
    toNotify: true,
    // Every native I.LP-IN node this replaces sets ignoreFreeSlots: true.
    // Without it the endpoint 400s on slots GHL considers full — precisely the
    // bookings delegation is supposed to absorb — and the caller falls back to
    // a native node that would have booked them anyway.
    ignoreFreeSlotValidation: true,
  };
  if (assignedUserId) body.assignedUserId = assignedUserId;

  const fmt = applyAppointmentFormat(body, contact);

  let result;
  try {
    result = await ghlFetch('POST', '/calendars/events/appointments', body);
  } catch (err) {
    if (claim.reason === 'claimed') await releaseAppointmentCreate(contactId, slotMs).catch(() => {});
    throw err;
  }

  const appointmentId = result?.id || result?.appointment?.id || null;
  console.log(`[ApptBooking] ✅ created ${appointmentId} for ${contactId} on ${calendarId} @ ${startTime}`);
  void emitSlotCheckEvent('created', {
    contactId, calendarId, startTime, matched: null,
    extra: {
      caller: 'endpoint',
      appointmentId,
      resolved_title: fmt.title,
      address_populated: fmt.addressPopulated,
      duration_ms: elapsed(),
    },
  });

  return { outcome: 'created', appointmentId, message: 'created' };
}

export async function createAppointmentFromLpHandler(req, res) {
  const startedAt = Date.now();
  const src = { ...(req.query || {}), ...(req.body || {}) };

  // ─── Auth ────────────────────────────────────────────────────────
  // Header only. The previous query/body `key` fallback put the secret in URL
  // and access logs; a GHL Custom Webhook step can send headers, so there is no
  // constraint forcing it the way there is for Five9 Connectors.
  const provided = req.headers['x-appt-booking-key'] || '';
  if (!keyMatches(provided)) {
    console.warn('[ApptBooking] rejected: bad/missing key');
    return respond(res, 'error', null, 'invalid_key');
  }

  const contactId = String(src.contactId || src.contact_id || '').trim();
  const calendarId = String(src.calendarId || src.calendar_id || '').trim();
  const startTime = String(src.startTime || src.start_time || '').trim();
  const assignedUserId = String(src.assignedUserId || src.assigned_user_id || '').trim();
  const title = src.title || 'Appointment';
  const requestedStatus = String(src.status || src.appointmentStatus || 'confirmed').trim().toLowerCase();

  const contact = {
    firstName: src.firstName || src.first_name || '',
    lastName: src.lastName || src.last_name || '',
    address1: src.address1 || src.address || '',
    city: src.city || '',
    state: src.state || '',
    postalCode: src.postalCode || src.postal_code || src.zip || '',
  };

  if (!contactId || !calendarId || !startTime) {
    return respond(res, 'error', null, 'contactId, calendarId and startTime are all required');
  }

  // ─── Dark-ship gate ──────────────────────────────────────────────
  // outcome 'error' (not a 5xx) so a branch wired up before enable falls back to
  // its native node, which is the correct behaviour while this is dark.
  if (!isSlotCheckEnabled()) {
    return respond(res, 'error', null, 'appt_slot_check_disabled');
  }

  // ─── Response budget ─────────────────────────────────────────────
  // This sits on a GHL workflow's synchronous path. If the slot check or the
  // create has not finished by the budget we abandon and report `error`, so the
  // native node books instead. The in-flight create may still land, producing a
  // duplicate alongside it — accepted, and made countable via the distinct
  // `budget_exceeded` subtype. We deliberately do NOT try to cancel it: a
  // duplicate is visible and recoverable, a missed appointment is neither.
  try {
    const work = doBooking({
      contactId, calendarId, startTime, requestedStatus, assignedUserId,
      endTime: src.endTime || src.end_time, title, contact, startedAt,
    });
    // Keep the abandoned promise from surfacing as an unhandled rejection once
    // we have already responded on the budget path.
    work.catch((err) => console.error(`[ApptBooking] abandoned work failed for ${contactId}: ${err.message}`));

    const raced = await raceWithBudget(work, bookingBudgetMs());

    if (raced.timedOut) {
      const durationMs = Date.now() - startedAt;
      console.warn(`[ApptBooking] budget exceeded (${durationMs}ms) for ${contactId} on ${calendarId} @ ${startTime}`);
      void emitSlotCheckEvent('budget_exceeded', {
        contactId, calendarId, startTime, matched: null,
        extra: { caller: 'endpoint', duration_ms: durationMs, budget_ms: bookingBudgetMs() },
      });
      return respond(res, 'error', null, 'budget_exceeded');
    }

    const winner = raced.value;
    return respond(res, winner.outcome, winner.appointmentId, winner.message);

  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error(`[ApptBooking] unhandled error for ${contactId}: ${err.message}`);
    void emitSlotCheckEvent('error', {
      contactId, calendarId, startTime, matched: null,
      extra: { caller: 'endpoint', duration_ms: durationMs, reason: err.message },
    });
    return respond(res, 'error', null, err.message);
  }
}
