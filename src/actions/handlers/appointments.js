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
import { isInHomeCalendarId, isGhlOnlyCalendarId } from '../../knowledge/booking-calendar-router.js';
import { markRescheduleInflight } from '../../services/reschedule-inflight.js';
import { executeCreateTask } from './tasks.js';
import { getContactCached } from '../contact-cache.js';
import { isPlaceholderName, EMAIL_ASKED_TAG } from '../../services/identity-extraction.js';
import { emitEvent } from '../../event-emitter.js';
import { etAppointmentParts } from '../../appointment-dates.js';
import supabase from '../../supabase.js';
import { syncCancelledAppointmentState, reconcileGhlOnlyApptTag } from './appointment-field-sync.js';
import { findExistingAppointment, emitSlotCheckEvent, isSlotCheckEnabled } from '../../appointments/slot-check.js';
import { applyAppointmentFormatForContact } from '../../appointments/format-contact.js';
import { claimAppointmentCreate, releaseAppointmentCreate } from '../../services/appointment-sync-claim.js';

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

// v1.1 (Victor Lopez incident 2026-07-04) — tag stamped when the R2 hard
// gate blocks an in-home booking at creation time, so humans can find and
// rescue these conversations.
const GATE_BLOCKED_TAG = 'booking:gate-blocked';

// 2026-07-07 — explicit LP-exemption marker (call-dispatch-integrity): any
// appointment on a GHL-only calendar (Confirmation Call) is stamped with this
// tag on booking and it is removed once no GHL-only appointment remains
// active, so reconciliation logic — code, rules, or n8n — has an unambiguous
// "never mirror this into LP" signal.
const GHL_ONLY_APPT_TAG = 'ghl-only-appointment';

// 2026-08-16 — RATE-LIMITER BUDGET FOR THE BOOKING PATH.
//
// executeBookAppointment makes several sequential rate-limited GHL calls, and
// the executor kills a handler at EXECUTOR_HANDLER_TIMEOUT_MS (60s). The
// limiter's default queue wait is 30s per call, so a single 429 pause — which
// drains the bucket for 5 minutes — makes two calls enough to blow the
// watchdog. Observed live 2026-08-16: one 429 at 00:10:36 put the bucket in a
// 5-minute pause; a test booking spent ~54s reaching its POST and the handler
// was killed at 60s.
//
// The limiter FAILS OPEN at the cap, so a shorter wait never drops a call — it
// stops queueing sooner and proceeds. Capping the calls this handler owns keeps
// a booking inside the watchdog instead of being killed mid-flight.
//
// Scoped deliberately to the POST, the read-back, and the title read — the
// window where a kill is actually harmful. A kill BEFORE the POST creates
// nothing and is safe; a kill AFTER it leaves an appointment that the retry's
// double-book guard has to reconcile. The double-book guard's own lookup
// (fetchUpcomingAppointments) bypasses the limiter entirely, so it is already
// exempt and needs no cap.
//
// 8s × 3 capped calls = 24s, comfortably inside the 60s watchdog while still
// allowing a real queue to drain under normal load.
// Parsed defensively: Math.max(1000, NaN) is NaN, not 1000, so a typo'd env
// value would produce NaN — which acquireToken treats as "not finite" and
// silently reverts to the 30s default, i.e. the exact behaviour this constant
// exists to prevent. An unparseable value falls back to the 8s default instead.
const BOOKING_TOKEN_WAIT_MS = (() => {
  const parsed = parseInt(process.env.BOOKING_TOKEN_WAIT_MS ?? '', 10);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 8000;
})();

function readContactCustomField(contact, fieldId) {
  const cfs = Array.isArray(contact?.customFields) ? contact.customFields : [];
  const f = cfs.find((x) => x?.id === fieldId);
  const v = f?.value ?? f?.field_value ?? null;
  return v == null || String(v).trim() === '' ? null : String(v).trim();
}

/**
 * v1.1 — R2 hard backstop: an in-home appointment may NEVER be created
 * without (a) a real name, (b) phone, (c) property address, (d) the
 * decision-maker question having been asked. The response-generator's
 * prompt gate is the primary enforcement; this catches anything that
 * reaches the handler un-gated (raw companions, replayed actions, rules).
 * Contact-read failure fails OPEN (loudly) — the prompt gate remains the
 * primary control and a transient GHL error must not strand a legit
 * booking the bot already promised.
 */
export async function evaluateInHomePrerequisites(contactId, payload, context) {
  let contact;
  try {
    contact = await getContactCached(contactId, context?._contactCache);
  } catch (err) {
    console.warn(`[ActionExecutor] in-home prereq gate: contact read failed for ${contactId}: ${err.message} — failing open`);
    return { ok: true, failOpen: true, missing: [] };
  }

  const missing = [];
  const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ')
    || contact.contactName || contact.name || '';
  if (isPlaceholderName(fullName) || isPlaceholderName(contact.firstName ?? fullName)) missing.push('real_name');
  if (!contact.phone) missing.push('phone');
  // Street + zip are the hard components (zip proves service area);
  // city/state derive from the zip and never block.
  if (!contact.address1 || !contact.postalCode) missing.push('address');

  const dmField = readContactCustomField(contact, FIELD_ID_DECISION_MAKERS_PRESENT);
  const dmInPayload = DECISION_MAKERS_VALID_VALUES.has(payload?.qualifying_data?.decision_makers_present);
  const tags = Array.isArray(contact.tags) ? contact.tags : [];
  const dmAsked = !!dmField || dmInPayload
    || tags.includes('booking:dm-pending') || tags.includes('booking:dm-asked');
  if (!dmAsked) missing.push('decision_maker_question');

  return { ok: missing.length === 0, missing };
}

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

// v1.1 (2026-07-24 Engelke incident) — the email ask is sequenced to AFTER the
// booking lands, as its OWN message (never bundled with the confirmation or a
// slot offer; that dual-question was Defect 4). Kept deliberately short and
// self-contained so it reads as a standalone follow-up.
const POST_BOOKING_EMAIL_ASK_MESSAGE =
  "One more thing — what's the best email to send your confirmation and appointment details to?";

// 2026-08-13 — tag guard for the deferred confirmation. Stamped on enqueue so a
// handler re-run or a reaper requeue can never text the lead two confirmations
// for one booking. Mirrors the EMAIL_ASKED_TAG discipline above.
const DEFERRED_CONFIRM_TAG = 'booking:confirm-queued';

/**
 * v1.1 — Queue a separate post-booking email ask when the contact still has no
 * email and has not already been asked. Idempotent via the booking:email-asked
 * tag (stamped on enqueue, exactly as response-generator does for the in-flow
 * ask). The queued send passes through the agentic send cooldown
 * (MIN_AGENTIC_SEND_GAP_SEC), so it lands AFTER the confirmation send. Best-
 * effort — never fails the booking.
 */
async function enqueuePostBookingEmailAsk(contactId, action, context) {
  try {
    const contact = await getContactCached(contactId, context?._contactCache);
    const email = contact?.email && String(contact.email).trim() ? String(contact.email).trim() : null;
    const tags = Array.isArray(contact?.tags) ? contact.tags.map((t) => String(t).toLowerCase()) : [];
    if (email) return { queued: false, reason: 'email_on_file' };
    if (tags.includes(EMAIL_ASKED_TAG)) return { queued: false, reason: 'already_asked' };

    const { error } = await supabase.from('agent_actions').insert({
      event_id: action?.event_id || null,
      action_type: 'send_message',
      target_system: 'ghl',
      target_entity: 'contact',
      target_id: contactId,
      action_payload: { message: POST_BOOKING_EMAIL_ASK_MESSAGE, channel: 'sms' },
      reasoning: 'Post-booking email ask — its own message on the turn after the confirmation, once (2026-07-24 Engelke incident, Defect 4).',
      rule_applied: 'POST_BOOKING_EMAIL_ASK',
      confidence: 1.0,
      status: 'pending',
      requires_approval: false,
      priority: 20,
    });
    if (error) {
      console.warn(`[ActionExecutor] post-booking email-ask enqueue failed for ${contactId}: ${error.message}`);
      return { queued: false, reason: 'insert_error' };
    }
    // Stamp asked-once NOW so a handler re-run never re-asks (the tag is the guard).
    await applyGHLTag(contactId, EMAIL_ASKED_TAG).catch(() => {});
    console.log(`[ActionExecutor] 📧 post-booking email ask queued for ${contactId} (${EMAIL_ASKED_TAG} stamped)`);
    return { queued: true };
  } catch (err) {
    console.warn(`[ActionExecutor] post-booking email-ask threw for ${contactId} (fail-soft): ${err.message}`);
    return { queued: false, reason: 'threw' };
  }
}

/**
 * 2026-08-13 — Send the confirmation the lead was promised but never got.
 *
 * When send-message-handler books inline it normally confirms in the same turn.
 * If that inline attempt times out or hits a transient failure, the lead is sent
 * honest hold copy instead ("let me get that time nailed down and text you right
 * back") and the booking is left for the executor. Without this, the executor
 * books it and NOBODY tells the lead — a promise made and silently dropped,
 * which is worse than the confirm-too-early bug it replaced.
 *
 * The confirmation text is the model's own, captured at generation time and
 * stamped onto this action's payload, so there is no re-generation and no drift
 * from the on-brand copy.
 *
 * Re-reads the payload from the row rather than trusting the one this handler
 * was called with: on the timeout path the stamp lands WHILE this execution is
 * already in flight, so the in-memory payload predates it.
 *
 * Priority 10 places it ahead of the post-booking email ask (20). Both pass
 * through the agentic send cooldown, so they land in order and never bundle.
 * Best-effort — never fails a booking that already succeeded.
 */
async function enqueueDeferredConfirmation(contactId, action, context) {
  if (!action?.id || !contactId) return { queued: false, reason: 'no_action_id' };
  try {
    const { data: row } = await supabase
      .from('agent_actions')
      .select('action_payload')
      .eq('id', action.id)
      .maybeSingle();

    const deferred = row?.action_payload?.deferred_confirmation;
    const message = deferred?.message ? String(deferred.message).trim() : '';
    if (!message) return { queued: false, reason: 'none_pending' };

    const contact = await getContactCached(contactId, context?._contactCache).catch(() => null);
    const tags = Array.isArray(contact?.tags) ? contact.tags.map((t) => String(t).toLowerCase()) : [];
    if (tags.includes(DEFERRED_CONFIRM_TAG)) {
      return { queued: false, reason: 'already_queued' };
    }

    const { error } = await supabase.from('agent_actions').insert({
      event_id: action.event_id || null,
      action_type: 'send_message',
      target_system: 'ghl',
      target_entity: 'contact',
      target_id: contactId,
      action_payload: { message, channel: deferred.channel || 'sms' },
      reasoning: `Deferred booking confirmation — the inline booking did not land in time, the lead was sent hold copy, and this keeps that promise (companion action ${action.id}).`,
      rule_applied: 'DEFERRED_BOOKING_CONFIRMATION',
      confidence: 1.0,
      status: 'pending',
      requires_approval: false,
      priority: 10,
    });
    if (error) {
      console.warn(`[ActionExecutor] deferred confirmation enqueue failed for ${contactId}: ${error.message}`);
      return { queued: false, reason: 'insert_error' };
    }

    // Stamp asked-once NOW so a re-run can't double-send, and clear the key so
    // the row no longer advertises an outstanding confirmation.
    await applyGHLTag(contactId, DEFERRED_CONFIRM_TAG).catch(() => {});
    const cleared = { ...(row.action_payload || {}) };
    delete cleared.deferred_confirmation;
    const { error: clearErr } = await supabase.from('agent_actions')
      .update({ action_payload: cleared, updated_at: new Date().toISOString() })
      .eq('id', action.id);
    if (clearErr) {
      // The tag is the real idempotency guard; a stale key just means the row
      // still advertises a confirmation that has already been queued.
      console.warn(`[ActionExecutor] deferred confirmation key clear failed for action ${action.id}: ${clearErr.message}`);
    }

    console.log(`[ActionExecutor] 📨 deferred booking confirmation queued for ${contactId} — promise kept`);
    return { queued: true };
  } catch (err) {
    console.warn(`[ActionExecutor] deferred confirmation threw for ${contactId} (fail-soft): ${err.message}`);
    return { queued: false, reason: 'threw' };
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
  // 2026-08-15 (Mark, LOCKED): EVERY appointment this system creates is born
  // 'new' (unconfirmed). A caller-supplied 'confirmed' is IGNORED at creation.
  // Confirmation is a separate, explicit transition owned by
  // update_appointment_status, which already gates on
  // decision_makers_present ∈ {Yes, Solo Owner}. Before this, a model-authored
  // companion could assert 'confirmed' on a booking whose existence had never
  // been verified (contact gUihunGyOa6SiGbJCJ3K, action 320924).
  const requestedStatus = payload.status || 'new';
  const status = 'new';
  if (requestedStatus !== 'new') {
    console.warn(`[ActionExecutor] appointment status forced to 'new' at creation (requested '${requestedStatus}') — confirmation is a separate transition.`);
  }
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
 * True when two appointment start times refer to the same instant. Both inputs
 * are ISO strings (the existing object's from GHL, the requested one from
 * buildAppointmentBody). Compared on epoch ms so equivalent offsets match. If
 * either is unparseable, treat as NOT the same time (favor reschedule over a
 * silent no-op on bad data).
 */
function sameStartTime(a, b) {
  const am = a ? Date.parse(a) : NaN;
  const bm = b ? Date.parse(b) : NaN;
  if (Number.isNaN(am) || Number.isNaN(bm)) return false;
  return am === bm;
}

/**
 * v3.4 — Double-book guard. Finds an already-existing active future appointment
 * on `calendarId` for the contact. Reuses the live appointment lookup.
 *
 * Still FAIL-OPEN: on lookup failure the caller proceeds to book, because we'd
 * rather risk a rare duplicate than block a legitimate booking on a transient
 * API error (GHL also rejects exact-overlap slots server-side). What changed
 * (slot-uniqueness work) is that the failure is now REPORTED rather than
 * swallowed — `lookupFailed` lets the caller emit an appt.slot_check
 * 'query_failed' event, so the one path that can still produce a duplicate is
 * countable instead of invisible.
 *
 * @returns {Promise<{ appointment: object|null, lookupFailed: boolean }>}
 */
async function findExistingAppointmentOnCalendar(contactId, calendarId) {
  if (!contactId || !calendarId) return { appointment: null, lookupFailed: false };
  try {
    const upcoming = await fetchUpcomingAppointments(contactId);
    // null (not []) means the lookup itself failed — a non-ok response, a
    // missing API key, or a timeout. An empty calendar returns [].
    if (!Array.isArray(upcoming)) return { appointment: null, lookupFailed: true };
    return {
      appointment: upcoming.find((a) => a.calendar_id === calendarId) || null,
      lookupFailed: false,
    };
  } catch (err) {
    console.warn(`[ActionExecutor] double-book guard lookup threw for ${contactId}: ${err.message}`);
    return { appointment: null, lookupFailed: true };
  }
}

export async function executeBookAppointment(action, context) {
  const contactId = action.target_id;
  const payload = interpolatePayload(action.action_payload, context);
  if (!contactId) throw new Error('Missing contactId');

  let { body, calendarId, startTime, endTime, title, status, ignoreFreeSlotValidation } = buildAppointmentBody(payload, contactId);

  // v3.4 / 2026-06-24: idempotent-booking guard. The executor reaps stuck
  // actions and can re-run a book_appointment, and the model can emit a
  // duplicate on a re-confirm. If an active future appointment already exists
  // on this calendar, do NOT create a second object:
  //   • same start_time  → true no-op, return the existing id (idempotent_skip).
  //   • different time    → RESCHEDULE the existing object in place (PUT), so the
  //                         contact never ends up with two objects on one calendar.
  // Only when there is no active same-calendar appointment do we POST a new one.
  const { appointment: existing, lookupFailed } = await findExistingAppointmentOnCalendar(contactId, calendarId);

  // Fail-open is preserved (we fall through and book), but no longer silent.
  if (lookupFailed && isSlotCheckEnabled()) {
    console.warn(`[ActionExecutor] slot check: live lookup failed for ${contactId} on ${calendarId} — booking anyway (fail-open)`);
    await emitSlotCheckEvent('query_failed', {
      contactId, calendarId, startTime, matched: null,
      extra: { site: 'executeBookAppointment', stage: 'double_book_guard' },
    });
  }

  if (existing) {
    if (sameStartTime(existing.start_time, startTime)) {
      console.log(`[ActionExecutor] ⏭️  idempotent_skip: contact ${contactId} already has appointment ${existing.appointment_id} on calendar ${calendarId} at the requested time (${existing.start_time}) — no-op.`);
      await removeGHLTags(contactId, BOOKING_FLOW_TAGS).catch(() => {});
      if (isGhlOnlyCalendarId(calendarId)) {
        await applyGHLTag(contactId, GHL_ONLY_APPT_TAG).catch(() => {});
      }
      if (isSlotCheckEnabled()) {
        await emitSlotCheckEvent('noop_already_exists', {
          contactId, calendarId, startTime, matched: existing,
          extra: { site: 'executeBookAppointment', reason: 'idempotent_skip' },
        });
      }
      return {
        action: 'appointment_book_skipped_existing',
        appointment_id: existing.appointment_id,
        calendar_id: calendarId,
        calendar_name: existing.calendar_name || title,
        contact_id: contactId,
        start_time: existing.start_time,
        status: existing.status,
        skipped_reason: 'idempotent_skip',
      };
    }
    // Different time on the same calendar → reschedule the existing object
    // rather than creating a second one.
    console.log(`[ActionExecutor] ♻️  Idempotent reschedule: contact ${contactId} has appointment ${existing.appointment_id} on calendar ${calendarId} at ${existing.start_time} → moving to ${startTime} (no new object).`);
    await ghlFetch('PUT', `/calendars/events/appointments/${existing.appointment_id}`, {
      calendarId,
      startTime,
      endTime,
    });
    await removeGHLTags(contactId, BOOKING_FLOW_TAGS).catch(() => {});
    if (isGhlOnlyCalendarId(calendarId)) {
      await applyGHLTag(contactId, GHL_ONLY_APPT_TAG).catch(() => {});
    }
    if (payload.qualifying_data) {
      await persistQualifyingData(contactId, payload.qualifying_data).catch(() => {});
    }
    if (isSlotCheckEnabled()) {
      await emitSlotCheckEvent('updated', {
        contactId, calendarId, startTime, matched: existing,
        extra: { site: 'executeBookAppointment', reason: 'rescheduled_existing', previousStartTime: existing.start_time },
      });
    }
    return {
      action: 'appointment_rescheduled_existing',
      appointment_id: existing.appointment_id,
      calendar_id: calendarId,
      calendar_name: existing.calendar_name || title,
      contact_id: contactId,
      start_time: startTime,
      end_time: endTime,
      previous_start_time: existing.start_time,
      status: existing.status,
    };
  }

  const inHome = isInHomeCalendarId(calendarId);
  const dmPresent = payload.qualifying_data?.decision_makers_present;

  // v1.1 — R2 hard gate (Victor Lopez incident 2026-07-04): never CREATE an
  // in-home appointment without real name + phone + address + the
  // decision-maker question asked. Runs only for fresh bookings — the
  // double-book guard above already returned for existing appointments.
  if (inHome) {
    const prereq = await evaluateInHomePrerequisites(contactId, payload, context);
    if (!prereq.ok) {
      console.warn(`[ActionExecutor] 🚫 in-home booking BLOCKED for ${contactId} (calendar ${calendarId}): missing ${prereq.missing.join(', ')}`);
      await applyGHLTag(contactId, GATE_BLOCKED_TAG).catch(() => {});
      await emitEvent({
        event_type: 'booking.gate_blocked',
        event_subtype: prereq.missing.join(','),
        source: 'lp_mcp',
        entity_type: 'contact',
        entity_id: contactId,
        ghl_contact_id: contactId,
        payload: { calendar_id: calendarId, requested_start_time: startTime, missing: prereq.missing },
        priority: 'high',
        bypass_filter: true,
      }).catch(() => {});
      // 2026-08-15 — a blocked booking used to end here silently while the
      // agent_actions row still read `completed` (action 320913, contact
      // gUihunGyOa6SiGbJCJ3K). Nothing was created and nobody was told.
      await executeCreateTask({
        target_id: contactId,
        action_payload: {
          title: 'BOOKING BLOCKED — prerequisites missing, NO appointment created',
          description: `Agentic in-home booking for {{contact_name}} was blocked for ${startTime}: missing ${prereq.missing.join(', ')}. NO appointment exists on the calendar. The lead may believe they are booked — verify and book manually.`,
        },
      }, context).catch((taskErr) =>
        console.warn(`[ActionExecutor] blocked-booking escalation task failed for ${contactId}: ${taskErr.message}`));
      return {
        action: 'appointment_blocked_prerequisites',
        blocked: true,
        contact_id: contactId,
        calendar_id: calendarId,
        requested_start_time: startTime,
        missing: prereq.missing,
        reason: `in-home booking blocked: missing ${prereq.missing.join(', ')}`,
      };
    }
  }

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

  // Cross-worker create claim. The calendar guard above reads GHL live, but the
  // duplicates it misses are read-after-write: I.LP-IN (or another worker)
  // books, and this handler's read lands before GHL has propagated it. The
  // claim is the existing answer to that window — the reconciler has taken it
  // since 2026-07-11. It is FAIL-OPEN by design (see appointment-sync-claim.js):
  // a claim-infra error lets the booking through rather than stranding it.
  const slotMs = Date.parse(startTime);
  let claimed = false;
  if (isSlotCheckEnabled()) {
    const claim = await claimAppointmentCreate(contactId, slotMs);
    if (!claim.claimed) {
      console.log(`[ActionExecutor] ⏭️  slot claim held for ${contactId}@${startTime} — another worker is creating this slot; skipping.`);
      await emitSlotCheckEvent('noop_already_exists', {
        contactId, calendarId, startTime, matched: null,
        extra: { site: 'executeBookAppointment', reason: 'create_claim_held' },
      });
      return {
        action: 'appointment_book_skipped_existing',
        appointment_id: null,
        calendar_id: calendarId,
        calendar_name: title,
        contact_id: contactId,
        start_time: startTime,
        skipped_reason: 'create_claim_held',
      };
    }
    claimed = claim.reason === 'claimed';
  }

  console.log(`[ActionExecutor] Booking appointment: calendar=${calendarId}, contact=${contactId}, start=${startTime}, status=${status}${ignoreFreeSlotValidation ? ', override_availability=true' : ''}`);

  // 2026-08-15 — the person name in an appointment title comes from the GHL
  // contact record ONLY, never from the action payload. The model-authored
  // title for contact gUihunGyOa6SiGbJCJ3K read "Window Estimate - Maria
  // Laing"; "Laing" was inherited from a cross-contaminated LP prospect lookup
  // (Yvonne Laing, LP lead 566250). An LP-derived surname must never reach a
  // customer-visible artifact. No name on the record → calendar name alone.
  try {
    const titleContact = await getContactCached(contactId, context?._contactCache, { maxWaitMs: BOOKING_TOKEN_WAIT_MS });
    const ghlName = [titleContact?.firstName, titleContact?.lastName].filter(Boolean).join(' ').trim();
    const calName = payload.calendar_name
      || Object.keys(CALENDAR_MAP).find((n) => CALENDAR_MAP[n] === calendarId)
      || 'Appointment';
    body.title = ghlName ? `${calName} - ${ghlName}` : calName;
    if (!ghlName) {
      console.warn(`[ActionExecutor] appointment title: contact ${contactId} has no name on the GHL record — using calendar name alone rather than a payload-supplied name.`);
    }
  } catch (err) {
    console.warn(`[ActionExecutor] appointment title rebuild failed for ${contactId}: ${err.message} — leaving payload title.`);
  }

  // Title + address. No-op unless APPT_FORMAT_ENABLED, and fails open.
  const fmt = await applyAppointmentFormatForContact(body, contactId, context?._contactCache);

  let result;
  try {
    result = await ghlFetch('POST', '/calendars/events/appointments', body, { maxWaitMs: BOOKING_TOKEN_WAIT_MS });
  } catch (err) {
    // Release so the executor's retry can re-attempt this slot.
    if (claimed) await releaseAppointmentCreate(contactId, slotMs).catch(() => {});
    // 2026-08-15 — a failed booking used to be silent. Action 320924 for
    // contact gUihunGyOa6SiGbJCJ3K died on GHL 400 "The slot you have selected
    // is no longer available" and nobody was told; the lead had already been
    // led to believe she was booked. Escalate BEFORE rethrowing.
    await applyGHLTag(contactId, 'booking:failed').catch(() => {});
    await emitEvent({
      event_type: 'booking.create_failed',
      event_subtype: 'ghl_post_error',
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: { calendar_id: calendarId, requested_start_time: startTime, error: err.message },
      priority: 'critical',
      bypass_filter: true,
    }).catch(() => {});
    await executeCreateTask({
      target_id: contactId,
      action_payload: {
        title: 'BOOKING FAILED — lead has NO appointment, rep action needed',
        description: `Agentic booking for {{contact_name}} failed on the ${payload.calendar_name || title} calendar at ${startTime}. NO appointment exists. The lead may already believe they are booked — call and rebook. GHL error: ${err.message}`,
      },
    }, context).catch((taskErr) =>
      console.warn(`[ActionExecutor] failed-booking escalation task failed for ${contactId}: ${taskErr.message}`));
    throw err;
  }

  // 2026-08-15 — READ-BACK VERIFICATION. A booking is not "booked" until GHL
  // hands the object back. Everything below this point is a promise to the
  // lead — the ghl.appointment_booked emit that drives LP sync, the deferred
  // confirmation text, the email ask — and none of it may fire on an
  // unverified create.
  const appointmentId = result?.id || result?.appointment?.id || null;
  if (!appointmentId) {
    if (claimed) await releaseAppointmentCreate(contactId, slotMs).catch(() => {});
    throw new Error(`Booking POST returned no appointment id for ${contactId} at ${startTime} — treating as failed`);
  }
  let verified = null;
  for (let attempt = 1; attempt <= 2 && !verified; attempt++) {
    try {
      const v = await ghlFetch('GET', `/calendars/events/appointments/${appointmentId}`, null, { maxWaitMs: BOOKING_TOKEN_WAIT_MS });
      const appt = v?.appointment || v || {};
      if (appt.id) verified = appt;
    } catch (err) {
      console.warn(`[ActionExecutor] appointment read-back attempt ${attempt} failed for ${appointmentId}: ${err.message}`);
    }
    if (!verified && attempt === 1) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!verified) {
    if (claimed) await releaseAppointmentCreate(contactId, slotMs).catch(() => {});
    throw new Error(`Appointment ${appointmentId} could not be read back from GHL after create — treating as failed rather than confirming to the lead`);
  }
  console.log(`[ActionExecutor] ✅ Appointment booked AND verified: id=${appointmentId}, status=${verified.appointmentStatus || status}, start=${verified.startTime || startTime}, calendar=${title}`);

  if (isSlotCheckEnabled()) {
    void emitSlotCheckEvent('created', {
      contactId, calendarId, startTime, matched: null,
      extra: {
        caller: 'rule',
        site: 'executeBookAppointment',
        appointmentId,
        resolved_title: fmt.title,
        address_populated: fmt.addressPopulated,
      },
    });
  }

  // v3.1: persist qualifying data after successful booking (best-effort).
  let qualifyingDataFieldsWritten = 0;
  if (payload.qualifying_data) {
    qualifyingDataFieldsWritten = await persistQualifyingData(contactId, payload.qualifying_data);
  }

  // 2026-07-06 — one-legger policy (locked with Mark): a booking with a
  // non-"Yes"/"Solo Owner" decision-maker answer STILL BOOKS (the question
  // never blocks), but gets tagged one-legger-risk so the post-booking
  // confirmation call resolves attendance. "Solo Owner" is a complete
  // decision-making unit, not a one-legger. Best-effort; never fails the booking.
  const dmAnswer = payload.qualifying_data?.decision_makers_present;
  if (typeof dmAnswer === 'string' && dmAnswer !== 'Yes' && dmAnswer !== 'Solo Owner') {
    await applyGHLTag(contactId, 'one-legger-risk').catch((err) =>
      console.warn(`[ActionExecutor] one-legger-risk tag failed for ${contactId} (fail-soft): ${err.message}`));
    console.log(`[ActionExecutor] one-legger-risk tagged for ${contactId} (decision_makers_present="${dmAnswer}") — booking proceeds per locked policy`);
  }

  // 2026-07-07 — explicit LP-exemption marker: GHL-only calendar bookings
  // never sync to LP; the tag is the unambiguous skip signal for any
  // reconciliation logic. Fail-soft — the booking is the primary side effect.
  if (isGhlOnlyCalendarId(calendarId)) {
    await applyGHLTag(contactId, GHL_ONLY_APPT_TAG).catch((err) =>
      console.warn(`[ActionExecutor] ${GHL_ONLY_APPT_TAG} tag apply failed for ${contactId} (fail-soft): ${err.message}`));
  }

  // Quality Pass v1.0 Item 5 — persist the call purpose (why the lead wants
  // this call: pricing_questions / general_questions / pre_visit_confirmation
  // / requested_callback) so later confirmations and rep prep can name it.
  // Env-gated: the "Call Purpose" GHL custom field doesn't exist yet — Mark
  // creates it and sets CALL_PURPOSE_FIELD_ID in Railway. Best-effort.
  if (payload.call_purpose && process.env.CALL_PURPOSE_FIELD_ID) {
    await updateGHLContactFields(contactId, [
      { id: process.env.CALL_PURPOSE_FIELD_ID, field_value: String(payload.call_purpose) },
    ]).catch((err) =>
      console.warn(`[ActionExecutor] call_purpose field write failed for ${contactId} (fail-soft): ${err.message}`));
  }

  // v3.4: tear down the booking-flow tags now that a booking has landed, so the
  // affirmative-gate bypass doesn't persist for this contact. See §8 #6.
  await removeGHLTags(contactId, BOOKING_FLOW_TAGS).catch(() => {});

  // 2026-08-13 — LP writeback through the agentic layer.
  //
  // Rule 112 GHL_APPT_LP_SYNC (enabled, priority 15) queues set_lp_appointment
  // on ghl.appointment_booked. Until now this path never emitted that event, so
  // the rule had simply never been fed: on contact lGQ0WjsMU2zmoq9MsVJH the
  // only events for the appointment were appt.booking (telemetry) and
  // ghl.workflow_handoff, and LP was carried ~6 minutes later by the GHL-native
  // fallback I.LP-A instead.
  //
  // Why not build a rule on appt.booking, which already fires here: it is
  // documented as pure telemetry (slot-check.js), it also fires from
  // reconcileLpAppointmentToGhl — the LP→GHL direction, so a rule on it would
  // push LP's own appointments back at LP — and its payload uses `startTime`
  // (camelCase), which is in NONE of executeSetLPAppointment's date branches.
  // It would fall through to the contact's last_appointment_start_date and
  // silently sync a STALE date rather than failing loudly.
  //
  // Shape below mirrors a real GHL webhook row (reference event 2820152) so the
  // handler parses it identically whichever producer it came from. calendar_id
  // is emitted because it is authoritative for the GHL-only skip; calendar_name
  // and title both carry the clean calendar name (the handler falls back
  // title → calendar name), never the model's "<calendar> - <lead>" title.
  // ghl_status drives the decision-maker line on the LP note and GroupMe card.
  //
  // Two owners by design: I.LP-A stays as the backstop it was built to be. The
  // paths interlock — set_lp_appointment returns already_set_in_lp when LP
  // holds the same date and time, and I.LP-A exits early on lp-appt-synced.
  // This path is primary because it fires in seconds rather than the workflow's
  // 15-minute wait and resolves the LP lead through a five-step chain the GHL
  // workflow does not have.
  //
  // Best-effort, exactly like every other side effect in this branch: a failed
  // emit must never fail a booking that has already landed in GHL.
  try {
    const etParts = etAppointmentParts(startTime);
    const cleanCalendarName = payload.calendar_name
      || Object.keys(CALENDAR_MAP).find((n) => CALENDAR_MAP[n] === calendarId)
      || title;
    const bookedContact = await getContactCached(contactId, context?._contactCache).catch(() => null);
    const contactName = [bookedContact?.firstName, bookedContact?.lastName].filter(Boolean).join(' ')
      || bookedContact?.contactName || bookedContact?.name || null;

    await emitEvent({
      event_type: 'ghl.appointment_booked',
      event_subtype: 'created',
      source: 'lp_mcp',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: {
        title: cleanCalendarName,
        status: 'booked',
        end_time: null,
        startDate: etParts?.startDate || null,
        start_time: etParts?.startTime12h || null,
        calendar_id: calendarId,
        calendar_name: cleanCalendarName,
        contactName,
        appointment_id: appointmentId,
        ghl_status: status,
      },
      // One event per created appointment. The executor can re-run a
      // book_appointment (reaper requeue, duplicate companion), and the
      // idempotent-skip branch above returns before reaching here, but a
      // genuine double-create would otherwise queue LP sync twice.
      idempotency_key: appointmentId ? `ghl_appt_booked:${appointmentId}` : null,
    });
    console.log(`[ActionExecutor] 📤 ghl.appointment_booked emitted for ${contactId} (appt ${appointmentId}, ${cleanCalendarName} ${etParts?.startDate} ${etParts?.startTime12h}, ghl_status=${status}) → rule 112 GHL_APPT_LP_SYNC`);
  } catch (err) {
    console.warn(`[ActionExecutor] ghl.appointment_booked emit failed for ${contactId} (fail-soft, I.LP-A remains the backstop): ${err.message}`);
  }

  // 2026-08-13 — if the lead was told "text you right back" because the inline
  // booking didn't land in time, this is where that promise gets kept. Must run
  // BEFORE the email ask so the confirmation lands first. No-ops when the
  // booking confirmed in-turn (the normal path).
  const deferredConfirmation = await enqueueDeferredConfirmation(contactId, action, context);

  // v1.1 (2026-07-24 Engelke incident) — sequence the email ask to its own
  // message AFTER the booking lands. Idempotent + best-effort; never blocks.
  await enqueuePostBookingEmailAsk(contactId, action, context);

  return {
    action: 'appointment_booked',
    deferred_confirmation_queued: !!deferredConfirmation.queued,
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

  // Mirror the cancellation onto the contact record + LP snapshot so
  // downstream context never reads the cancelled appointment as upcoming.
  // Idempotent with the ghl.appointment_cancelled webhook path; fail-soft.
  let fieldSync = null;
  if (action.target_id && ['cancelled', 'noshow', 'no-show'].includes(String(newStatus).toLowerCase())) {
    fieldSync = await syncCancelledAppointmentState(action.target_id, {
      appointmentId,
      calendarId: payload.calendar_id || null,
    }).catch(() => null);
  }

  return {
    action: 'appointment_updated',
    appointment_id: appointmentId,
    new_status: newStatus,
    reason,
    resolved_from: resolvedFrom,
    field_sync: fieldSync,
  };
}

/**
 * update_appointment_status (v1.0 — 2026-06-03): PUT
 * /calendars/events/appointments/{id} — upgrade an EXISTING appointment's
 * status in place (the book-then-capture path). Nearly identical to
 * executeCancelAppointment (which also PUTs an arbitrary appointmentStatus)
 * plus qualifying-data persistence.
 *
 * Why this action exists: there is no status-upgrade path today (book/cancel/
 * reschedule only), and re-emitting book_appointment won't work — the double-
 * book guard returns the existing row unchanged. The in-home gate now ALWAYS
 * books on a hard confirmation (status 'new' when decision-makers aren't yet
 * confirmed). When the lead then answers the decision-maker question with
 * Yes / Solo Owner, this action flips that same appointment 'new'→'confirmed'
 * in place and persists the qualifying data — no second appointment.
 *
 * Backstop (mirrors the book handler §A2): 'confirmed' is only honored when
 * qualifying_data.decision_makers_present ∈ {Yes, Solo Owner}; otherwise the
 * status is forced back to 'new' and a warn is logged. Never set 'confirmed'
 * without decision-maker confirmation.
 *
 * Rule #155 reconciliation (same as the book handler): when the final status
 * is 'confirmed' and decision_makers_present === 'Yes', set the spouse-gate
 * release tag and drop the gate tag BEFORE the PUT. An appointment-update
 * webhook can re-fire ghl.appointment_booked; pre-setting the release tag
 * keeps SPOUSE_GATE_BLOCK_SOLO_BOOKING from race-cancelling the just-confirmed
 * visit.
 */
export async function executeUpdateAppointmentStatus(action /*, context */) {
  const contactId = action.target_id;
  const payload = action.action_payload || {};

  let appointmentId = payload.appointment_id;
  let resolvedFrom = appointmentId ? 'payload' : null;

  // Fallback: if no explicit appointment_id, resolve the contact's active
  // appointment via the live GHL appointments API (reuses the cancel helper).
  if (!appointmentId && contactId) {
    appointmentId = await resolveActiveAppointmentId(contactId);
    if (appointmentId) resolvedFrom = 'live_api';
  }

  if (!appointmentId) {
    throw new Error(
      `Missing appointment_id and live appointments API returned no active appointment for target_id=${contactId || 'none'}`
    );
  }

  let status = payload.status || 'new';
  const dmPresent = payload.qualifying_data?.decision_makers_present;
  const dmConfirmed = dmPresent === 'Yes' || dmPresent === 'Solo Owner';

  // Status backstop (mirror A1/A2): never set 'confirmed' without DM confirmation.
  if (status === 'confirmed' && !dmConfirmed) {
    console.warn(`[ActionExecutor] update_appointment_status backstop: contact ${contactId}, appointment ${appointmentId}, decision_makers_present=${dmPresent ?? 'absent'} → forcing 'new' (not confirmed).`);
    status = 'new';
  }

  // #155 reconciliation: pre-set the spouse-gate release tag (and drop the gate
  // tag) BEFORE the PUT so an appointment-update webhook can't race-cancel a
  // just-confirmed visit. Only on an explicit 'Yes' confirmed upgrade.
  if (status === 'confirmed' && dmPresent === 'Yes') {
    await applyGHLTag(contactId, SPOUSE_RELEASE_TAG).catch((err) =>
      console.warn(`[ActionExecutor] #155 release tag add threw for ${contactId}: ${err.message}`));
    await removeGHLTags(contactId, [SPOUSE_GATE_TAG]).catch(() => {});
  }

  await ghlFetch('PUT', `/calendars/events/appointments/${appointmentId}`, { appointmentStatus: status });
  console.log(`[ActionExecutor] ✅ Appointment ${appointmentId} status → ${status} [resolved_from: ${resolvedFrom}, dm=${dmPresent ?? 'absent'}]`);

  // Cancels/no-shows through this action get the same mirror sync as
  // executeCancelAppointment (fail-soft, idempotent with the webhook path).
  if (contactId && ['cancelled', 'noshow', 'no-show'].includes(String(status).toLowerCase())) {
    await syncCancelledAppointmentState(contactId, {
      appointmentId,
      calendarId: payload.calendar_id || null,
    }).catch(() => {});
  }

  // Persist qualifying data (Decision Makers Present + Window Count). Best-effort.
  let qualifyingDataFieldsWritten = 0;
  if (payload.qualifying_data) {
    qualifyingDataFieldsWritten = await persistQualifyingData(contactId, payload.qualifying_data);
  }

  return {
    action: 'appointment_status_updated',
    appointment_id: appointmentId,
    new_status: status,
    decision_makers_present: dmPresent || null,
    qualifying_data_fields_written: qualifyingDataFieldsWritten,
    resolved_from: resolvedFrom,
  };
}

/**
 * v2 — reschedule_appointment: book new + cancel old in one operation.
 *
 * Why a combined action instead of two companions:
 *   - Keeps companion_action a single object (no multi-companion refactor)
 *   - Atomic from the AI's perspective — one decision, one outcome
 *   - Order is enforced by the handler (BOOK ALWAYS before cancel)
 *
 * v2 (2026-06-16) — BOOK-BEFORE-CANCEL. The prior order (cancel old → book new)
 * stranded the lead with NO appointment whenever the new booking failed
 * (GHL 400 "slot no longer available"): old was already cancelled, new never
 * booked. That is exactly what happened to Jacqueline Virtue
 * (fbC6JUcY9EDBrHoMiFmF). New contract:
 *   - Book new FIRST. If it fails (non-2xx) → leave the old appointment
 *     untouched, create a rep escalation task, return a clean failure. The
 *     lead keeps their existing appointment; a human rebooks.
 *   - Only after the new booking succeeds do we cancel the old slot. A failure
 *     of the (now best-effort) cancel does NOT strand the lead — they have the
 *     new appointment; the stale old one is surfaced for cleanup.
 *
 * Cold-cancel correlation (Bug 2b): immediately before cancelling the old slot
 * we set a short-lived reschedule-in-flight marker so the
 * ghl.appointment_cancelled webbook our own cancel emits does not trip the
 * customer-cancellation rules (GHL_APPT_CANCELLED_REBOOK_COLD /
 * GHL_APPT_CANCELLED_REBOOK), which guard on `not_reschedule_inflight`.
 *
 * Idempotency: a retry that runs after the new booking already succeeded would
 * re-book. We avoid that by only attempting the cancel + qualifying-data steps
 * after a successful book within the same invocation; the handler is not
 * auto-retried past the book step (a book failure returns a terminal result, it
 * does not throw).
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

  // ─── Step 1/2: book the new appointment FIRST ──────────────────────
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
  let bookCalendarId = null;
  try {
    const built = buildAppointmentBody(bookPayload, contactId);
    bookStartTime = built.startTime;
    bookCalendarName = built.title;
    bookCalendarId = built.calendarId;
    bookStatus = built.status;
    // Slot-uniqueness gate. Unlike executeBookAppointment this path had NO live
    // GHL read at all — it booked first and cancelled the old appointment after,
    // so a slot already held by I.LP-IN (or by a prior reschedule) was never
    // detected. Reuses the target appointment when the slot is already taken
    // instead of creating a second object on it.
    if (isSlotCheckEnabled()) {
      const check = await findExistingAppointment({
        contactId, calendarId: built.calendarId, startTime: built.startTime,
      });

      if (check.outcome === 'match' && check.appointment.appointment_id !== oldId) {
        console.log(`[ActionExecutor] ⏭️  Reschedule target slot already held by ${check.appointment.appointment_id} for ${contactId} at ${built.startTime} — reusing it, no new object.`);
        void emitSlotCheckEvent('noop_already_exists', {
          contactId, calendarId: built.calendarId, startTime: built.startTime,
          matched: check.appointment,
          extra: { caller: 'rule', site: 'executeRescheduleAppointment', oldAppointmentId: oldId },
        });
        newAppointmentId = check.appointment.appointment_id;
      } else if (check.outcome === 'error') {
        // Fail-open, consistent with the booking path — but countable.
        console.warn(`[ActionExecutor] reschedule slot check failed for ${contactId} (${check.reason}) — booking anyway (fail-open)`);
        void emitSlotCheckEvent('query_failed', {
          contactId, calendarId: built.calendarId, startTime: built.startTime, matched: null,
          extra: { caller: 'rule', site: 'executeRescheduleAppointment', reason: check.reason },
        });
      }
    }

    if (!newAppointmentId) {
      // Cross-worker create claim. executeBookAppointment and the reconciler
      // have both taken this since 2026-07-11; this path had no claim at all,
      // so the read-after-write window the slot check above cannot see stayed
      // fully open on reschedules. FAIL-OPEN (see appointment-sync-claim.js).
      const newSlotMs = Date.parse(built.startTime);
      let rescheduleClaimed = false;
      if (isSlotCheckEnabled()) {
        const claim = await claimAppointmentCreate(contactId, newSlotMs);
        if (!claim.claimed) {
          // Another worker is mid-create on this slot. Returning rather than
          // throwing on purpose: the throw path escalates a "new slot
          // unavailable" task to a rep and that would be a lie — the slot is
          // being booked right now. The old appointment stays intact either
          // way, so the lead is never stranded.
          console.log(`[ActionExecutor] ⏭️  reschedule slot claim held for ${contactId}@${built.startTime} — another worker is creating this slot; skipping.`);
          void emitSlotCheckEvent('noop_already_exists', {
            contactId, calendarId: built.calendarId, startTime: built.startTime, matched: null,
            extra: { caller: 'rule', site: 'executeRescheduleAppointment', reason: 'create_claim_held', oldAppointmentId: oldId },
          });
          return {
            action: 'reschedule_skipped_claim_held',
            old_appointment_id: oldId,
            old_cancelled: false,
            new_appointment_booked: false,
            contact_id: contactId,
            skipped_reason: 'create_claim_held',
          };
        }
        rescheduleClaimed = claim.reason === 'claimed';
      }

      console.log(`[ActionExecutor] Reschedule step 1/2: booking new appointment FIRST, calendar=${built.calendarId}, start=${built.startTime}${built.ignoreFreeSlotValidation ? ', override_availability=true' : ''}`);

      // Title + address. No-op unless APPT_FORMAT_ENABLED, and fails open.
      const fmt = await applyAppointmentFormatForContact(built.body, contactId, context?._contactCache);

      let bookResult;
      try {
        bookResult = await ghlFetch('POST', '/calendars/events/appointments', built.body);
      } catch (err) {
        if (rescheduleClaimed) await releaseAppointmentCreate(contactId, newSlotMs).catch(() => {});
        throw err;
      }
      newAppointmentId = bookResult?.id || bookResult?.appointment?.id || null;
      if (!newAppointmentId) throw new Error('Booking returned no appointment id');
      console.log(`[ActionExecutor] ✅ New appointment booked id=${newAppointmentId}, status=${built.status}`);
      if (isSlotCheckEnabled()) {
        void emitSlotCheckEvent('created', {
          contactId, calendarId: built.calendarId, startTime: built.startTime, matched: null,
          extra: {
            caller: 'rule',
            site: 'executeRescheduleAppointment',
            appointmentId: newAppointmentId,
            oldAppointmentId: oldId,
            resolved_title: fmt.title,
            address_populated: fmt.addressPopulated,
          },
        });
      }
    }
  } catch (err) {
    // New booking failed → DO NOT cancel the old slot. The lead keeps their
    // existing appointment. Escalate to a rep and return a clean failure.
    console.error(`[ActionExecutor] ⚠️ Reschedule book step failed; OLD APPOINTMENT LEFT INTACT for ${contactId}: ${err.message}`);
    const requestedSlot = payload.new_start_time || payload.appointment_date || payload.appointment_time || 'requested time';
    await executeCreateTask({
      target_id: contactId,
      action_payload: {
        title: 'RESCHEDULE FAILED — new slot unavailable, old appt intact; rep action needed',
        description: `Agentic reschedule for {{contact_name}} could not book the new slot (${requestedSlot}). The existing appointment (${oldId}) was LEFT INTACT — the lead still has their original appointment. A rep needs to manually rebook or confirm. GHL error: ${err.message}`,
      },
    }, context).catch((taskErr) =>
      console.warn(`[ActionExecutor] reschedule escalation task failed for ${contactId}: ${taskErr.message}`));
    return {
      action: 'reschedule_book_failed',
      old_appointment_id: oldId,
      old_cancelled: false,
      new_appointment_booked: false,
      escalated: true,
      contact_id: contactId,
      error: err.message,
    };
  }

  // ─── Step 2/2: cancel the old appointment (new is confirmed) ───────
  // Mark the contact reschedule-in-flight BEFORE the cancel so the
  // ghl.appointment_cancelled webhook our cancel emits is not read as a
  // customer cold/warm cancellation (Bug 2b correlation marker).
  await markRescheduleInflight(contactId).catch((err) =>
    console.warn(`[ActionExecutor] reschedule-inflight mark failed for ${contactId}: ${err.message}`));
  let oldCancelled = false;
  console.log(`[ActionExecutor] Reschedule step 2/2: cancelling old appointment ${oldId} for contact ${contactId}`);
  try {
    await ghlFetch('PUT', `/calendars/events/appointments/${oldId}`, { appointmentStatus: 'cancelled' });
    oldCancelled = true;
    console.log(`[ActionExecutor] ✅ Old appointment ${oldId} cancelled`);
  } catch (err) {
    // New appt is already booked, so the lead is NOT stranded. Surface the
    // stale old appointment for manual cleanup rather than failing the action.
    console.warn(`[ActionExecutor] ⚠️ New appt ${newAppointmentId} booked but cancelling old ${oldId} failed (lead not stranded): ${err.message}`);
  }

  // ─── Step 2b/2: collapse any stale duplicate on the target calendar ──
  // Guarantee a reschedule never leaves a second active object on the new
  // calendar. If old_appointment_id was stale/wrong (or there were already
  // duplicates), the cancel above may have missed the real lingering object.
  // Cancel any active appointment on the target calendar that is neither the
  // appointment we just booked nor the old id we already handled. The
  // reschedule-inflight marker set above keeps these cancels from tripping the
  // customer-cancellation rules. Best-effort: lookup failure is non-fatal.
  if (bookCalendarId) {
    try {
      const onCalendar = await fetchUpcomingAppointments(contactId);
      const stale = (Array.isArray(onCalendar) ? onCalendar : [])
        .filter(a => a.calendar_id === bookCalendarId
          && a.appointment_id
          && a.appointment_id !== newAppointmentId
          && a.appointment_id !== oldId);
      for (const dup of stale) {
        console.log(`[ActionExecutor] ♻️ Reschedule cleanup: cancelling stale duplicate ${dup.appointment_id} on calendar ${bookCalendarId} for contact ${contactId}`);
        await ghlFetch('PUT', `/calendars/events/appointments/${dup.appointment_id}`, { appointmentStatus: 'cancelled' })
          .catch((e) => console.warn(`[ActionExecutor] reschedule cleanup cancel ${dup.appointment_id} failed: ${e.message}`));
      }
    } catch (err) {
      console.warn(`[ActionExecutor] reschedule duplicate-collapse lookup failed for ${contactId} (non-fatal): ${err.message}`);
    }
  }

  // 2026-07-07 — reconcile the GHL-only marker once from live truth: covers
  // both the old-appointment cancel and the new booking's calendar (re-applies
  // the tag if the new appointment is GHL-only, removes it if the reschedule
  // moved off a GHL-only calendar). The reschedule path bypasses
  // syncCancelledAppointmentState, so it needs its own call. Fire-and-forget.
  reconcileGhlOnlyApptTag(contactId)
    .catch(err => console.warn(`[ActionExecutor] ghl-only tag reconcile failed for ${contactId}: ${err.message}`));

  // ─── Optional: persist qualifying data on the contact ──────────────
  let qualifyingDataFieldsWritten = 0;
  if (payload.qualifying_data) {
    qualifyingDataFieldsWritten = await persistQualifyingData(contactId, payload.qualifying_data);
  }

  return {
    action: 'appointment_rescheduled',
    old_appointment_id: oldId,
    old_cancelled: oldCancelled,
    new_appointment_id: newAppointmentId,
    new_appointment_booked: true,
    new_calendar_name: bookCalendarName,
    new_start_time: bookStartTime,
    new_status: bookStatus,
    contact_id: contactId,
    qualifying_data_fields_written: qualifyingDataFieldsWritten,
  };
}
