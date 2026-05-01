/**
 * Appointment Handlers — src/actions/handlers/appointments.js
 *
 * book_appointment (v3.1): POST /calendars/events/appointments — book GHL
 *   calendar appointment. Accepts calendar_name (mapped to ID) or direct
 *   calendar_id. Supports US-format date/time as well as ISO start_time.
 *   Duration defaults to 90 min, end_time auto-calculated if not provided.
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
 * cancel_appointment (v3.1 — 2026-05-01): PUT /calendars/events/appointments/{id} —
 *   cancel/update GHL appointment status. Accepts an optional `reason`
 *   field that is logged in the action result for audit; reasons are
 *   not pushed back to GHL (no native field for that).
 *
 *   v3.1 ADDITION — contact custom field fallback: when the action fires
 *   from a rule that only knows the contact (e.g. INTENT_CANCEL_REQUESTED
 *   on ai.analysis_completed), the action_payload won't carry an
 *   appointment_id. Instead of failing, the handler now fetches the
 *   contact via GHL API and reads the Event ID custom field
 *   (rmadoRNzDKPb5aNmFwGO) set by the APPT Handler workflows at booking
 *   time. The result includes resolved_from = 'payload' | 'contact_custom_field'
 *   for audit. If neither path resolves an ID, the handler still throws.
 *
 *   Cited incident: contact wnl6nhVkQ18pylh0dw1g (Mark Test) — explicit
 *   "Hey can you cancel my appointment?" inbound message, bot routed to
 *   reschedule path instead of executing the cancel; calendar event
 *   9Sj3QzszzviQAJSLRwVT for Thursday May 7 6 PM remained active.
 *
 * reschedule_appointment (v1.0 — NEW): cancels old + books new in a
 *   single executor call. Order matters:
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
 *   Payload field naming uses "new_*" prefixes to disambiguate from the
 *   old appointment's metadata:
 *     old_appointment_id  →  the existing appt to cancel
 *     new_calendar_name   →  calendar for the new booking (usually same as old)
 *     new_start_time      →  ISO 8601 with FL offset
 *     new_end_time        →  optional; auto-calculated from duration if missing
 *     duration_minutes    →  default 90
 *     status              →  "new" (default) or "confirmed" — same gate as book
 *     qualifying_data     →  optional, same shape as book_appointment
 *
 * Extracted from action-executor.js v4.2 refactor.
 */

import { ghlFetch, interpolatePayload } from '../helpers.js';
import { CALENDAR_MAP, GHL_LOCATION_ID } from '../constants.js';
import { updateGHLContactFields } from '../../ghl.js';

// v3.1: GHL custom field IDs for qualifying-data persistence.
const FIELD_ID_WINDOW_COUNT = 'h9FJTUbmUHIuD6JKmpXv';
const FIELD_ID_DECISION_MAKERS_PRESENT = 'GH1QGGOseMKmJAMqajiN';
const DECISION_MAKERS_VALID_VALUES = new Set(['Yes', 'No', 'Solo Owner', 'Uncertain']);

// v3.1 cancel_appointment: contact custom field that stores the GHL Event ID
// when an appointment is booked. Set by the APPT Handler workflows at booking
// time. Used as a fallback resolver when the action_payload doesn't carry
// appointment_id (rules that fire from ai.analysis_completed know the contact
// but not the appointment).
const APPT_EVENT_ID_FIELD = 'rmadoRNzDKPb5aNmFwGO';

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
 * the standard book_appointment field names (calendar_name/calendar_id,
 * start_time, end_time, etc.). Used by both executeBookAppointment and
 * executeRescheduleAppointment (after the latter translates new_* fields).
 *
 * Throws on missing/invalid fields. Returns { body, calendarId, startTime,
 * endTime, title, status } so callers can log or transform further.
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

  return { body, calendarId, startTime, endTime, title, status };
}

export async function executeBookAppointment(action, context) {
  const contactId = action.target_id;
  const payload = interpolatePayload(action.action_payload, context);
  if (!contactId) throw new Error('Missing contactId');

  const { body, calendarId, startTime, endTime, title, status } = buildAppointmentBody(payload, contactId);

  console.log(`[ActionExecutor] Booking appointment: calendar=${calendarId}, contact=${contactId}, start=${startTime}, status=${status}`);
  const result = await ghlFetch('POST', '/calendars/events/appointments', body);
  const appointmentId = result?.id || result?.appointment?.id || null;
  console.log(`[ActionExecutor] ✅ Appointment booked: id=${appointmentId}, calendar=${title}`);

  // v3.1: persist qualifying data after successful booking (best-effort).
  let qualifyingDataFieldsWritten = 0;
  if (payload.qualifying_data) {
    qualifyingDataFieldsWritten = await persistQualifyingData(contactId, payload.qualifying_data);
  }

  return {
    action: 'appointment_booked',
    appointment_id: appointmentId,
    calendar_id: calendarId,
    calendar_name: title,
    contact_id: contactId,
    start_time: startTime,
    end_time: endTime,
    status,
    qualifying_data_fields_written: qualifyingDataFieldsWritten,
  };
}

/**
 * v3.1 — Resolve a GHL appointment Event ID from a contact's custom field.
 * Returns null if the contact lookup fails or the field is empty.
 *
 * The Event ID custom field is set by the APPT Handler workflows at the
 * moment the contact books an appointment. It points to the GHL Calendar
 * Event ID that is the correct target for PUT /calendars/events/appointments/{id}
 * status updates.
 *
 * Logs at info level on success, warn on failure. Never throws — the
 * caller is responsible for raising a more specific error when both the
 * payload and this fallback fail to produce an ID.
 */
async function resolveAppointmentIdFromContact(contactId) {
  if (!contactId) return null;
  try {
    const contactRes = await ghlFetch('GET', `/contacts/${contactId}`);
    const fields = contactRes?.contact?.customFields || [];
    const eventField = fields.find(f => f.id === APPT_EVENT_ID_FIELD);
    if (!eventField?.value) return null;
    const id = String(eventField.value).trim();
    return id || null;
  } catch (err) {
    console.warn(`[ActionExecutor] cancel_appointment: contact ${contactId} lookup failed during fallback: ${err.message}`);
    return null;
  }
}

export async function executeCancelAppointment(action) {
  const payload = action.action_payload || {};
  let appointmentId = payload.appointment_id;
  let resolvedFrom = appointmentId ? 'payload' : null;
  const newStatus = payload.status || 'cancelled';
  const reason = payload.reason || null;

  // v3.1 — Fallback: rules that fire from ai.analysis_completed (e.g.
  // INTENT_CANCEL_REQUESTED) only know the contact, not the appointment.
  // Resolve from the Event ID custom field that the APPT Handlers wrote
  // to the contact at booking time.
  if (!appointmentId && action.target_id) {
    appointmentId = await resolveAppointmentIdFromContact(action.target_id);
    if (appointmentId) {
      resolvedFrom = 'contact_custom_field';
      console.log(`[ActionExecutor] cancel_appointment: resolved appointment_id ${appointmentId} from contact ${action.target_id} custom field`);
    }
  }

  if (!appointmentId) {
    throw new Error(
      `Missing appointment_id (and contact custom field fallback did not resolve one for target_id=${action.target_id || 'none'})`
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
 * v1.0 — reschedule_appointment: cancel old + book new in one operation.
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
  // Translate "new_*" payload fields to the standard book_appointment shape
  // before calling buildAppointmentBody.
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
    console.log(`[ActionExecutor] Reschedule step 2/2: booking new appointment, calendar=${built.calendarId}, start=${built.startTime}`);
    const bookResult = await ghlFetch('POST', '/calendars/events/appointments', built.body);
    newAppointmentId = bookResult?.id || bookResult?.appointment?.id || null;
    console.log(`[ActionExecutor] ✅ Reschedule complete: new appointment id=${newAppointmentId}, status=${built.status}`);
  } catch (err) {
    // Old is cancelled; new failed. Report half-success — ops sees the
    // orphan in the audit and can re-book manually.
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
