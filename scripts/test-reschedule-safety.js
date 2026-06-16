/**
 * Reschedule book-before-cancel safety — scripts/test-reschedule-safety.js
 *
 * Locks in the Bug 2a fix (Jacqueline Virtue, fbC6JUcY9EDBrHoMiFmF): the
 * reschedule handler must BOOK the new slot before cancelling the old one, so a
 * failed booking never strands the lead with no appointment.
 *
 *   - Success: POST (book) is issued BEFORE PUT (cancel); result is a full
 *     reschedule with the new appointment id.
 *   - Book failure: the new-slot POST fails (GHL 400 slot-unavailable) → NO
 *     PUT-cancel is ever issued, the old appointment is left intact, and the
 *     result flags a clean failure + escalation.
 *
 * Mechanism mirrors test-tag-safety.js: ghlFetch bottoms out at global fetch()
 * (src/actions/helpers.js); we stub globalThis.fetch and record every call.
 * supabase is left unconfigured (null) so the in-flight marker and the
 * escalation task's resolver lookups no-op without network. GROUPME_BOT_ID is
 * left unset so the escalation task's GroupMe send returns immediately (no
 * timers).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';
// Intentionally NOT setting SUPABASE_* or GROUPME_BOT_ID.

const { executeRescheduleAppointment } = await import('../src/actions/handlers/appointments.js');

// ─── fetch stub ────────────────────────────────────────────────────────
let calls = [];
let bookShouldFail = false;

function jsonRes(body) {
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
function errRes(status, text) {
  return {
    status, ok: false,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => text,
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const path = String(url).replace('https://services.leadconnectorhq.com', '');
  calls.push({ method, path });
  const isApptCollection = method === 'POST' && path === '/calendars/events/appointments';
  const isApptCancel = method === 'PUT' && path.startsWith('/calendars/events/appointments/');
  if (isApptCollection) {
    if (bookShouldFail) return errRes(400, 'The slot you have selected is no longer available');
    return jsonRes({ id: 'new-appt-123' });
  }
  if (isApptCancel) return jsonRes({ id: 'old-appt-1', appointmentStatus: 'cancelled' });
  // Everything else (escalation task's contact/note lookups, etc.) → benign.
  return jsonRes({ contact: { id: 'c1', tags: [] }, id: 'c1' });
};

const basePayload = {
  old_appointment_id: 'old-appt-1',
  new_calendar_id: 'cal-abc',
  new_start_time: '2026-06-17T14:00:00-04:00',
  duration_minutes: 90,
  title: 'Rescheduled visit',
  ignore_free_slot_validation: true,
};

function apptCalls() {
  return calls.filter((c) => c.path.startsWith('/calendars/events/appointments'));
}

test('success: books the new slot BEFORE cancelling the old one', async () => {
  calls = []; bookShouldFail = false;
  const result = await executeRescheduleAppointment(
    { target_id: 'resched-c1', action_payload: basePayload },
    {},
  );

  const appt = apptCalls();
  const bookIdx = appt.findIndex((c) => c.method === 'POST');
  const cancelIdx = appt.findIndex((c) => c.method === 'PUT');
  assert.ok(bookIdx !== -1, 'a book POST was issued');
  assert.ok(cancelIdx !== -1, 'a cancel PUT was issued');
  assert.ok(bookIdx < cancelIdx, 'book POST must precede cancel PUT');

  assert.equal(result.action, 'appointment_rescheduled');
  assert.equal(result.new_appointment_booked, true);
  assert.equal(result.new_appointment_id, 'new-appt-123');
  assert.equal(result.old_cancelled, true);
});

test('book failure: old appointment left intact, NO cancel, escalation flagged', async () => {
  calls = []; bookShouldFail = true;
  const result = await executeRescheduleAppointment(
    { target_id: 'resched-c1', action_payload: basePayload },
    {},
  );

  const cancelPuts = apptCalls().filter((c) => c.method === 'PUT');
  assert.equal(cancelPuts.length, 0, 'no cancel PUT may be issued when booking fails');

  assert.equal(result.action, 'reschedule_book_failed');
  assert.equal(result.old_cancelled, false);
  assert.equal(result.new_appointment_booked, false);
  assert.equal(result.escalated, true);
});
