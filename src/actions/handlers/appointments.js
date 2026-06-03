/**
 * Appointment Handlers — src/actions/handlers/appointments.js
 *
 * book_appointment (v3.3 — 2026-05-02): POST /calendars/events/appointments —
 *   book GHL calendar appointment. Accepts calendar_name (mapped to ID) or
 *   direct calendar_id. Supports US-format date/time as well as ISO
 *   start_time. Duration defaults to 90 min, end_time auto-calculated if
 *   not provided.
 *
 *   v3.3 — 2026-05-02: added ignore_free_slot_validation payload flag.
 *   When true, sets ignoreFreeSlotValidation: true on the GHL appointment
 *   POST body, bypassing GHL's calendar availability checks. Used for
 *   recovery flows where the source-of-truth (e.g. the customer's verbal
 *   agreement via chatbot) says the slot is valid even if GHL's calendar
 *   rules would otherwise block it. This matches the "Override Availability"
 *   flag used by GHL's Book Appointment workflow action and the LP webhook
 *   booking flow. Cited incident: Jeanne Jewell 2026-05-02 — Bot 4
 *   OUT_OF_AREA misfire blocked the in-session booking; recovery rebooking
 *   needed override because GHL availability had already been consumed
 *   by other reps in the intervening hours.
 *
 *   v3.1 ADDITION — qualifying_data persistence: after a successful booking,
 *   if action_payload includes qualifying_data { window_count?,
 *   decision_makers_present? }, the values are written to the GHL custom
 *   fields below. Field-write failures are logged but do NOT fail the
 *   booking — the booking is the primary side effect; field persistence
 *   is best-effort enrichment.
 *
 *     Window Count             field id: h9FJTUbmUHIuD6JKmpXv  (number)
 *     Decision Makers Present  field id: GH1QGGOseMKmJAMqajiN  (select)
 *
 *   Decision Makers Present must be one of: "Yes", "No", "Solo Owner",
 *   "Uncertain". Anything else is dropped with a warn log. The select
 *   options match what Mark configured in GHL (2026-04-30).
 *
 * cancel_appointment (v3.2 — 2026-05-01): PUT /calendars/events/appointments/{id} —
 *   cancel/update GHL appointment status. Accepts an optional `reason`
 *   field that is logged in the action result for audit; reasons are
 *   not pushed back to GHL (no native field for that).
 *
 *   v3.2 — 2026-05-01: REPLACED contact custom field fallback with live
 *   GHL appointments API lookup. The v3.1 implementation read the contact
 *   custom field rmadoRNzDKPb5aNmFwGO ("Last Appointment ID") which was
 *   supposed to be set by APPT Handler workflows at booking time — but
 *   live data on contact wnl6nhVkQ18pylh0dw1g (Mark Test) showed the field
 *   was empty even though an appointment had been booked. The Event ID
 *   was actually in a different field (bja3R0i0pGRmz6fFVdxb / "Last
 *   Cancelled Appointment ID") which only stores cancelled appointments.
 *   Neither field is reliable for the cancel-current-booking case.
 *
 *   v3.2 fallback now calls GET /contacts/{contactId}/appointments to fetch
 *   the contact's full appointment list, filters out cancelled/no-show/
 *   invalid statuses, and prefers the next future appointment over past
 *   ones. This is the source-of-truth path: GHL itself, no workflow
 *   side-effect dependency.
 *
 *   Result includes resolved_from = 'payload' | 'live_api'. If neither
 *   path resolves an ID, the handler still throws.
 *
 *   Cited incidents:
 *     • wnl6nhVkQ18pylh0dw1g — said "cancel my appointment", v3.1 cancel
 *       failed because last_appointment_id was empty.
 *     • Same contact at 23:07 — SPOUSE_GATE_BLOCK_SOLO_BOOKING (rule #155)
 *       fired auto-cancel on a fresh booking; v3.1 cancel failed for
 *       same reason.
 *
 * reschedule_appointment (v1.1 — 2026-05-02): cancels old + books new in
 *   a single executor call. Order matters:
 *     1. PUT old appointment to status='cancelled'. If this fails, abort
 *        — we don't want to create a second appointment when the first
 *        is still active.
 *     2. POST new appointment via the same body builder as book_appointment.
 *        If THIS fails, the executor result reports the partial failure
 *        (old_cancelled=true, new_appointment_booked=false) so ops sees
 *        the orphaned cancellation in the action audit and can re-book
 *        manually. The action goes into 'failed' status (no retry — the
 *        cancel is non-idempotent and a retry would just fail again at
 *        step 1 with "appointment already cancelled").
 *     3. Same qualifying_data persistence as book_appointment, on the
 *        contact (the data is contact-level, not appointment-level).
 *
 *   v1.1: also forwards ignore_free_slot_validation to the new-booking
 *   step, so reschedules can override availability the same way book
 *   does.
 *
 *   Payload field naming uses "new_*" prefixes to disambiguate from the
 *   old appointment's metadata.
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import { ghlFetch, interpolatePayload } from '../helpers.js';
import { CALENDAR_MAP, GHL_LOCATION_ID } from '../constants.js';
import { updateGHLContactFields, applyGHLTag, removeGHLTags } from '../../ghl.js';
import { fetchUpcomingAppointments } from '../../knowledge/contact-appointments.js';
import { isInHomeCalendarId } from '../../knowledge/booking-calendar-router.js';

// Tags cleared once a booking lands (or the flow otherwise terminates) so the
// post-qualification affirmative-gate bypass (intent-classifier.js) doesn't
// stay on permanently for the contact. See BUILD HANDOFF §8 correction #6.
const BOOKING_FLOW_TAGS = ['booking:active', 'booking:dm-pending'];
// Rule #155 SPOUSE_GATE_BLOCK_SOLO_BOOKING fires on ghl.appointment_booked when
// the contact has gate:spouse-required and lacks spouse-confirmed-attending. For
// a confirmed in-home booking we set the release tag (and drop the gate tag)
// BEFORE creating the appointment so #155's condition is already false when the
// booked event fires. See BUILD HANDOFF §8.
const SPOUSE_RELEASE_TAG = 'spouse-confirmed-attending';
const SPOUSE_GATE_TAG = 'gate:spouse-required';

// v3.1: GHL custom field IDs for qualifying-data persistence.
const FIELD_ID_WINDOW_COUNT = 'h9FJTUbmUHIuD6JKmpXv';
const FIELD_ID_DECISION_MAKERS_PRESENT = 'GH1QGGOseMKmJAMqajiN';
const DECISION_MAKERS_VALID_VALUES = new Set(['Yes', 'No', 'Solo Owner', 'Uncertain']);

// v3.2: appointment statuses that mean "not active / don't try to cancel"
// (used by resolveActiveAppointmentId to filter the contact's appointment list).
const NON_ACTIVE_APPOINTMENT_STATUSES = new Set([
  'cancelled', 'canceled', 'no_show', 'noshow', 'no-show', 'invalid',
]);

/**
 * v3.1 — Persist qualifying data to GHL custom fields. Returns the count
 * of fields written for audit purposes. Failures are logged at warn level
 * but never thrown — qualifying_data persistence is best-effort enrichment;
 * the booking is the primary side effect and must not be impacted.
 */
async function persistQualifyingData(contactId, qualifyingData) {
  if (!contactId || !qualifyingData || typeof qualifyingData !== 'object') return 0;

  const fields = [];
  if (typeof qualifyingData.window_count === 'number'
      && Number.isFinite(qualifyingData.window_count)
      && qualifyingData.window_count > 0
      && qualifyingData.window_count < 1000) {
    fields.push({ id: FIELD_ID_WINDOW_COUNT, value: Math.round(qualifyingData.window_count) });
  }
  if (typeof qualifyingData.decision_makers_present === 'string'
      && DECISION_MAKERS_VALID_VALUES.has(qualifyingData.decision_makers_present)) {
    fields.push({
      id: FIELD_ID_DECISION_MAKERS_PRESENT,
      value: qualifyingData.decision_makers_present,
    });
  }
  if (fields.length === 0) return 0;

  try {
    const result = await updateGHLContactFields(contactId, fields);
    if (result === 'not_found') {
      console.warn(`[ActionExecutor] qualifying_data: contact ${contactId} not found, skipping field writes`);
      return 0;
    }
    if (!result) {
      console.warn(`[ActionExecutor] qualifying_data: GHL custom field update returned falsy for ${contactId}`);
      return 0;
    }
    const summary = fields.map(f => {
      if (f.id === FIELD_ID_WINDOW_COUNT) return `window_count=${f.value}`;
      if (f.id === FIELD_ID_DECISION_MAKERS_PRESENT) return `decision_makers_present="${f.value}"`;
      return f.id;
    }).join(', ');
    console.log(`[ActionExecutor] ✅ qualifying_data persisted for ${contactId}: ${summary}`);
    return fields.length;
  } catch (err) {
    console.warn(`[ActionExecutor] qualifying_data persist threw for ${contactId}: ${err.message}`);
    return 0;
  }
}

/**
 * Internal: build the GHL appointment POST body from a payload that uses
 * the standard book_appointment field names. Used by both
 * executeBookAppointment and executeRescheduleAppointment.
 *
 * v3.3 — 2026-05-02: when payload.ignore_free_slot_validation is truthy,
 * adds ignoreFreeSlotValidation: true to the body. GHL respects this flag
 * to bypass calendar availability checks, matching the "Override
 * Availability" toggle in the workflow Book Appointment action.
 */
function buildAppointmentBody(payload, contactId) {
  let calendarId = payload.calendar_id;
  if (!calendarId && payload.calendar_name) {
    calendarId = CALENDAR_MAP[payload.calendar_name];
    if (!calendarId) {
      throw new Error(`Unknown calendar name: "${payload.calendar_name}". Valid: ${Object.keys(CALENDAR_MAP).join(', ')}`);
    }
  }
  if (!calendarId) throw new Error('Missing calendar_id or calendar_name');

  let startTime = payload.start_time;
  if (!startTime && payload.appointment_date && payload.appointment_time) {
    const date = payload.appointment_date;
    let time = payload.appointment_time;
    let isoDate = date;
    const usMatch = date.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (usMatch) isoDate = `${usMatch[3]}-${usMatch[1]}-${usMatch[2]}`;
    const match12 = time.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (match12) {
      let h = parseInt(match12[1], 10);
      const min = match12[2], p = match12[3].toUpperCase();
      if (p === 'AM' && h === 12) h = 0;
      if (p === 'PM' && h !== 12) h += 12;
      time = `${String(h).padStart(2, '0')}:${min}`;
    }
    startTime = `${isoDate}T${time}:00-04:00`;
  }
  if (!startTime) throw new Error('Missing start_time or appointment_date+appointment_time');

  let endTime = payload.end_time;
  if (!endTime) {
    const durationMin = payload.duration_minutes || 90;
    const start = new Date(startTime);
    const end = new Date(start.getTime() + durationMin * 60000);
    endTime = end.toISOString();
  }

  const title = payload.title || payload.calendar_name || 'Appointment';
  const status = payload.status || 'new';
  const assignedUserId = payload.assigned_user_id || null;
  const ignoreFreeSlotValidation = !!payload.ignore_free_slot_validation;

  const body = {
    calendarId,
    locationId: GHL_LOCATION_ID,
    contactId,
    startTime,
    endTime,
    title,
    appointmentStatus: status,
    toNotify: true,
  };
  if (assignedUserId) body.assignedUserId = assignedUserId;
  if (ignoreFreeSlotValidation) body.ignoreFreeSlotValidation = true;

  return { body, calendarId, startTime, endTime, title, status, ignoreFreeSlotValidation };
}

/**
 * v3.4 — Double-book guard. Returns an already-existing active future
 * appointment on `calendarId` for the contact, or null. Reuses the live
 * appointment lookup. On lookup failure returns null (fail-open: we'd rather
 * risk a rare duplicate than block a legitimate booking on a transient API
 * error — GHL also rejects exact-overlap slots server-side).
 */
async function findExistingAppointmentOnCalendar(contactId, calendarId) {
  if (!contactId || !calendarId) return null;
  try {
    const upcoming = await fetchUpcomingAppointments(contactId);
    if (!Array.isArray(upcoming)) return null;
    return upcoming.find((a) => a.calendar_id === calendarId) || null;
  } catch (err) {
    console.warn(`[ActionExecutor] double-book guard lookup threw for ${contactId}: ${err.message}`);
    return null;
  }
}

export async function executeBookAppointment(action, context) {
  const contactId = action.target_id;
  const payload = interpolatePayload(action.action_payload, context);
  if (!contactId) throw new Error('Missing contactId');

  let { body, calendarId, startTime, endTime, title, status, ignoreFreeSlotValidation } = buildAppointmentBody(payload, contactId);

  // v3.4: double-book guard. The executor reaps stuck actions and can re-run a
  // book_appointment, and the model can emit a duplicate on a re-confirm. If an
  // active future appointment already exists on this calendar, do NOT create a
  // second one — return the existing as a no-op success. See BUILD HANDOFF §8.
  const existing = await findExistingAppointmentOnCalendar(contactId, calendarId);
  if (existing) {
    console.log(`[ActionExecutor] ⏭️  Double-book guard: contact ${contactId} already has appointment ${existing.appointment_id} on calendar ${calendarId} (start=${existing.start_time}) — skipping create.`);
    await removeGHLTags(contactId, BOOKING_FLOW_TAGS).catch(() => {});
    return {
      action: 'appointment_book_skipped_existing',
      appointment_id: existing.appointment_id,
      calendar_id: calendarId,
      calendar_name: existing.calendar_name || title,
      contact_id: contactId,
      start_time: existing.start_time,
      status: existing.status,
      skipped_reason: 'active_future_appointment_exists',
    };
  }

  const inHome = isInHomeCalendarId(calendarId);
  const dmPresent = payload.qualifying_data?.decision_makers_present;

  // Deterministic status backstop (never blocks). An in-home appointment is
  // ALWAYS booked — there is no conversational hold. 'confirmed' requires
  // decision-maker confirmation (Yes | Solo Owner); otherwise book tentative
  // 'new' (a human confirms later). This mirrors the response-generator gate
  // (§A2) and catches any companion that reached the handler un-normalized
  // (e.g. a raw model-parroted companion that skipped the resolver).
  const dmConfirmed = dmPresent === 'Yes' || dmPresent === 'Solo Owner';
  if (inHome && !dmConfirmed && status === 'confirmed') {
    console.warn(`[ActionExecutor] In-home status downgrade: contact ${contactId}, calendar ${calendarId}, decision_makers_present=${dmPresent ?? 'absent'} → booking as 'new' (not confirmed).`);
    status = 'new';
    body.appointmentStatus = 'new';
  }

  // v3.4: rule #155 reconciliation. For a confirmed in-home booking where all
  // decision-makers will attend, set the spouse-gate release tag and drop the
  // gate tag BEFORE creating the appointment, so SPOUSE_GATE_BLOCK_SOLO_BOOKING
  // (which fires on the ghl.appointment_booked event) sees its condition as
  // already false and does not auto-cancel a valid booking. Only on an explicit
  // 'Yes' and only for in-home calendars — never for phone bookings (a stale
  // release tag there could later neutralize #155 for a genuine solo in-home).
  if (inHome && dmPresent === 'Yes') {
    await applyGHLTag(contactId, SPOUSE_RELEASE_TAG).catch((err) =>
      console.warn(`[ActionExecutor] #155 release tag add threw for ${contactId}: ${err.message}`));
    await removeGHLTags(contactId, [SPOUSE_GATE_TAG]).catch(() => {});
  }

  console.log(`[ActionExecutor] Booking appointment: calendar=${calendarId}, contact=${contactId}, start=${startTime}, status=${status}${ignoreFreeSlotValidation ? ', override_availability=true' : ''}`);
  const result = await ghlFetch('POST', '/calendars/events/appointments', body);
  const appointmentId = result?.id || result?.appointment?.id || null;
  console.log(`[ActionExecutor] ✅ Appointment booked: id=${appointmentId}, calendar=${title}`);

  // v3.1: persist qualifying data after successful booking (best-effort).
  let qualifyingDataFieldsWritten = 0;
  if (payload.qualifying_data) {
    qualifyingDataFieldsWritten = await persistQualifyingData(contactId, payload.qualifying_data);
  }

  // v3.4: tear down the booking-flow tags now that a booking has landed, so the
  // affirmative-gate bypass doesn't persist for this contact. See §8 #6.
  await removeGHLTags(contactId, BOOKING_FLOW_TAGS).catch(() => {});

  return {
    action: 'appointment_booked',
    appointment_id: appointmentId,
    calendar_id: calendarId,
    calendar_name: title,
    contact_id: contactId,
    start_time: startTime,
    end_time: endTime,
    status,
    ignore_free_slot_validation: ignoreFreeSlotValidation,
    qualifying_data_fields_written: qualifyingDataFieldsWritten,
  };
}

/**
 * v3.2 — Resolve the contact's active appointment ID via live GHL API call.
 * Returns null if no active appointment found or the lookup fails.
 *
 * Strategy:
 *   1. GET /contacts/{contactId}/appointments — full appointment list
 *   2. Filter out cancelled/no-show/invalid statuses
 *   3. Prefer the NEXT FUTURE appointment (smallest startTime >= now)
 *   4. Fall back to most-recent past appointment if no future ones exist
 *
 * Why live API instead of custom field: the v3.1 implementation read
 * contact custom field rmadoRNzDKPb5aNmFwGO ("Last Appointment ID")
 * which depends on APPT Handler workflows running a field-write step
 * at booking time. Live data showed that field empty for contacts who
 * clearly had appointments. The appointments API is the source of truth.
 *
 * Trade-off: one extra API call per cancel-from-rule invocation. Worth
 * it for reliability.
 *
 * Logs at info level on success, warn on failure. Never throws.
 */
async function resolveActiveAppointmentId(contactId) {
  if (!contactId) return null;
  try {
    const result = await ghlFetch('GET', `/contacts/${contactId}/appointments`);
    // GHL response shape varies — appointments may live under .events,
    // .appointments, or be the top-level array. Handle all shapes.
    const list = (Array.isArray(result) ? result : null)
      || result?.events
      || result?.appointments
      || [];
    if (!Array.isArray(list) || list.length === 0) {
      console.log(`[ActionExecutor] cancel_appointment: contact ${contactId} has no appointments in GHL`);
      return null;
    }

    const active = list
      .filter(a => {
        const status = String(a?.appointmentStatus || '').toLowerCase();
        return a?.id && !NON_ACTIVE_APPOINTMENT_STATUSES.has(status);
      })
      .map(a => ({
        id: a.id,
        startMs: a.startTime ? new Date(a.startTime).getTime() : 0,
        status: a.appointmentStatus,
      }));

    if (active.length === 0) {
      console.log(`[ActionExecutor] cancel_appointment: contact ${contactId} has appointments but none are active (all cancelled/no-show)`);
      return null;
    }

    const now = Date.now();
    const future = active.filter(a => a.startMs >= now).sort((a, b) => a.startMs - b.startMs);
    if (future.length > 0) {
      console.log(`[ActionExecutor] cancel_appointment: resolved next-future appointment ${future[0].id} (status: ${future[0].status}) for contact ${contactId}`);
      return future[0].id;
    }

    const past = active.sort((a, b) => b.startMs - a.startMs);
    console.log(`[ActionExecutor] cancel_appointment: no future appointments; resolved most-recent past appointment ${past[0].id} (status: ${past[0].status}) for contact ${contactId}`);
    return past[0].id;
  } catch (err) {
    console.warn(`[ActionExecutor] cancel_appointment: appointments API lookup failed for ${contactId}: ${err.message}`);
    return null;
  }
}

export async function executeCancelAppointment(action) {
  const payload = action.action_payload || {};
  let appointmentId = payload.appointment_id;
  let resolvedFrom = appointmentId ? 'payload' : null;
  const newStatus = payload.status || 'cancelled';
  const reason = payload.reason || null;

  // v3.2 — Fallback: rules that fire from ai.analysis_completed or
  // ghl.appointment_booked (e.g. INTENT_CANCEL_REQUESTED, SPOUSE_GATE_*)
  // know only the contact, not the appointment. Resolve via live GHL
  // appointments API (replaces v3.1's custom-field-based fallback).
  if (!appointmentId && action.target_id) {
    appointmentId = await resolveActiveAppointmentId(action.target_id);
    if (appointmentId) {
      resolvedFrom = 'live_api';
    }
  }

  if (!appointmentId) {
    throw new Error(
      `Missing appointment_id and live appointments API returned no active appointment for target_id=${action.target_id || 'none'}`
    );
  }

  await ghlFetch('PUT', `/calendars/events/appointments/${appointmentId}`, { appointmentStatus: newStatus });
  console.log(`[ActionExecutor] ✅ Appointment ${appointmentId} status → ${newStatus}${reason ? ` (reason: ${reason})` : ''} [resolved_from: ${resolvedFrom}]`);
  return {
    action: 'appointment_updated',
    appointment_id: appointmentId,
    new_status: newStatus,
    reason,
    resolved_from: resolvedFrom,
  };
}

/**
 * v1.1 — reschedule_appointment: cancel old + book new in one operation.
 *
 * Why a combined action instead of two companions:
 *   - Keeps companion_action a single object (no multi-companion refactor)
 *   - Atomic from the AI's perspective — one decision, one outcome
 *   - Order is enforced by the handler (cancel ALWAYS before book)
 *
 * Failure modes:
 *   - Cancel fails → throw, action goes 'failed', no book attempted.
 *     Old appointment is unchanged; lead's calendar state is consistent.
 *   - Cancel succeeds, book fails → return partial-success result. Old
 *     is cancelled; new is missing. Action goes 'failed' (after
 *     max_retries); ops sees the orphaned cancellation in the audit and
 *     can manually rebook. Retrying would fail at the cancel step with
 *     "already cancelled" — no value. So we don't auto-retry here.
 *   - Both succeed → return full-success result with new appointment_id.
 *     Qualifying data persistence runs after both succeed (best-effort).
 *
 * v1.1 — 2026-05-02: forwards ignore_free_slot_validation to the new
 * booking step (Jeanne Jewell pattern).
 */
export async function executeRescheduleAppointment(action, context) {
  const contactId = action.target_id;
  const payload = interpolatePayload(action.action_payload, context);
  if (!contactId) throw new Error('Missing contactId');

  const oldId = payload.old_appointment_id;
  if (!oldId) throw new Error('Missing old_appointment_id');

  // ─── Step 1/2: cancel the old appointment ──────────────────────────
  console.log(`[ActionExecutor] Reschedule step 1/2: cancelling old appointment ${oldId} for contact ${contactId}`);
  try {
    await ghlFetch('PUT', `/calendars/events/appointments/${oldId}`, { appointmentStatus: 'cancelled' });
  } catch (err) {
    throw new Error(`Reschedule failed at cancel step: ${err.message}`);
  }
  console.log(`[ActionExecutor] ✅ Old appointment ${oldId} cancelled`);

  // ─── Step 2/2: book the new appointment ────────────────────────────
  const bookPayload = {
    calendar_name: payload.new_calendar_name,
    calendar_id: payload.new_calendar_id,
    start_time: payload.new_start_time,
    end_time: payload.new_end_time,
    duration_minutes: payload.duration_minutes,
    title: payload.title,
    status: payload.status,
    assigned_user_id: payload.assigned_user_id,
    appointment_date: payload.appointment_date,
    appointment_time: payload.appointment_time,
    ignore_free_slot_validation: payload.ignore_free_slot_validation, // v1.1
  };

  let newAppointmentId = null;
  let bookStatus = bookPayload.status || 'new';
  let bookStartTime = null;
  let bookCalendarName = null;
  try {
    const built = buildAppointmentBody(bookPayload, contactId);
    bookStartTime = built.startTime;
    bookCalendarName = built.title;
    bookStatus = built.status;
    console.log(`[ActionExecutor] Reschedule step 2/2: booking new appointment, calendar=${built.calendarId}, start=${built.startTime}${built.ignoreFreeSlotValidation ? ', override_availability=true' : ''}`);
    const bookResult = await ghlFetch('POST', '/calendars/events/appointments', built.body);
    newAppointmentId = bookResult?.id || bookResult?.appointment?.id || null;
    console.log(`[ActionExecutor] ✅ Reschedule complete: new appointment id=${newAppointmentId}, status=${built.status}`);
  } catch (err) {
    console.error(`[ActionExecutor] ⚠️ Reschedule partial failure: old ${oldId} cancelled, new booking failed: ${err.message}`);
    return {
      action: 'reschedule_partial_failure',
      old_appointment_id: oldId,
      old_cancelled: true,
      new_appointment_booked: false,
      contact_id: contactId,
      error: err.message,
    };
  }

  // ─── Optional: persist qualifying data on the contact ──────────────
  let qualifyingDataFieldsWritten = 0;
  if (payload.qualifying_data) {
    qualifyingDataFieldsWritten = await persistQualifyingData(contactId, payload.qualifying_data);
  }

  return {
    action: 'appointment_rescheduled',
    old_appointment_id: oldId,
    old_cancelled: true,
    new_appointment_id: newAppointmentId,
    new_appointment_booked: true,
    new_calendar_name: bookCalendarName,
    new_start_time: bookStartTime,
    new_status: bookStatus,
    contact_id: contactId,
    qualifying_data_fields_written: qualifyingDataFieldsWritten,
  };
}
