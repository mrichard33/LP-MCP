/**
 * One active appointment per lead — scripts/test-one-appointment-per-contact.js
 *
 * Covers the 2026-08-17 owner rule (Mark): a lead never holds more than ONE
 * active appointment at a time.
 *
 * The double-book guard in executeBookAppointment used to be CALENDAR-scoped,
 * so a contact could hold one active appointment per calendar and still pass
 * it. Verified live: contact mcZ8OFDfZndBUgEdcnO2 held a Confirmation Call at
 * 1:00 PM, a Window Estimate at 3:00 PM and a Measurement Verification at
 * 3:00 PM on 2026-07-24 — all active, none visible to the old guard.
 *
 * The guard is now CONTACT-scoped:
 *   • same calendar, same time      → idempotent skip   (unchanged)
 *   • same calendar, different time → reschedule in place (unchanged)
 *   • DIFFERENT calendar            → BLOCK + escalate  (new)
 *
 * BLOCK, never replace. Cancel-and-recreate would let a 15-minute Confirmation
 * Call destroy a booked in-home Window Estimate; the demo is the revenue event,
 * so a human decides which appointment survives.
 *
 * Escalation is asserted end-to-end through GroupMe (GROUPME_DEBOUNCE_MS=1
 * collapses the v1.7 consolidation window), which proves the rep card actually
 * reaches a human rather than just that a function was called.
 *
 * Run: node --test scripts/test-one-appointment-per-contact.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.TZ = 'UTC';
process.env.GHL_API_KEY = 'test-key';
process.env.GROUPME_BOT_ID = 'test-bot';
process.env.GROUPME_DEBOUNCE_MS = '1';
// Intentionally NOT setting SUPABASE_* — emitEvent is guarded on it.

// Future, offset-carrying so toEpochMsEt takes the parse-directly branch and
// the business-hours/past filters can't make this suite pass or fail by clock.
const FUTURE = (() => {
  const d = new Date(Date.now() + 4 * 24 * 3600 * 1000);
  d.setUTCHours(18, 0, 0, 0);
  return d.toISOString().replace('Z', '+00:00');
})();
const FUTURE_LATER = (() => {
  const d = new Date(Date.now() + 5 * 24 * 3600 * 1000);
  d.setUTCHours(18, 0, 0, 0);
  return d.toISOString().replace('Z', '+00:00');
})();

const WINDOW_ESTIMATE = 'aJj14ONxh1oFyDcQ706O';  // in-home
const REVIEW_SESSION  = 'DQYMaJ22N6zL4SXjHukw';  // phone
const CONF_CALL       = 'gFWoSQrlKIdfRbAPV842';  // phone, GHL-only
const CONTACT_ID      = 'mcZ8OFDfZndBUgEdcnO2';

// ─── fetch stub ──────────────────────────────────────────────────────
let calls = [];
let upcoming = [];        // GET /contacts/{id}/appointments → { events }
let upcomingFails = false;
let contactRecord = null;

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
  const raw = String(url);
  const p = raw.replace('https://services.leadconnectorhq.com', '');
  calls.push({ method, path: p, body: opts.body ? JSON.parse(opts.body) : null });

  if (raw.startsWith('https://api.groupme.com')) return jsonRes({});
  if (method === 'GET' && /^\/contacts\/[^/?]+\/appointments/.test(p)) {
    if (upcomingFails) return errRes(500, 'lookup boom');
    return jsonRes({ events: upcoming });
  }
  if (method === 'GET' && /^\/calendars\/events\/appointments\/[^/?]+$/.test(p)) {
    return jsonRes({ appointment: { id: p.split('/').pop(), appointmentStatus: 'new', startTime: FUTURE } });
  }
  if (method === 'POST' && p === '/calendars/events/appointments') return jsonRes({ id: 'appt-new-1' });
  if (method === 'GET' && /^\/contacts\/[^/?]+$/.test(p)) return jsonRes({ contact: contactRecord });
  return jsonRes({});
};

const { executeBookAppointment } = await import('../src/actions/handlers/appointments.js');

const evt = (over = {}) => ({
  id: 'appt-existing-1', calendarId: WINDOW_ESTIMATE, appointmentStatus: 'confirmed',
  startTime: FUTURE, endTime: FUTURE, title: 'Window Estimate', ...over,
});

const fullContact = (over = {}) => ({
  id: CONTACT_ID, firstName: 'Mike', lastName: 'Hak', phone: '+18135551234',
  address1: '1 Main St', city: 'Tampa', state: 'FL', postalCode: '33618',
  tags: [], customFields: [], ...over,
});

function reset({ events = [], fails = false, contact = fullContact() } = {}) {
  calls = [];
  upcoming = events;
  upcomingFails = fails;
  contactRecord = contact;
}

const action = (over = {}) => ({
  target_id: CONTACT_ID,
  action_payload: {
    calendar_id: CONF_CALL,
    calendar_name: 'Confirmation Call',
    start_time: FUTURE_LATER,
    qualifying_data: { decision_makers_present: 'Yes' },
    ...over,
  },
});

const createPosts = () => calls.filter((c) => c.method === 'POST' && c.path === '/calendars/events/appointments');
const puts = () => calls.filter((c) => c.method === 'PUT' && /^\/calendars\/events\/appointments\//.test(c.path));
const groupMeText = () => calls.filter((c) => c.path.startsWith('https://api.groupme.com'))
  .map((c) => c.body?.text || '').join('\n');
const drainGroupMe = () => new Promise((r) => setTimeout(r, 60));

// ═══ 1. The new rule — cross-calendar block ══════════════════════════

test('(1) active appointment on ANOTHER calendar → blocked, nothing created', async () => {
  // THE REGRESSION. Mike Hak's shape: a booked in-home Window Estimate, and the
  // bot now tries to add a Confirmation Call. Old guard saw a different
  // calendar and created a second appointment.
  reset({ events: [evt()] });
  const r = await executeBookAppointment(action(), {});

  assert.equal(r.action, 'appointment_blocked_existing_appointment');
  assert.equal(r.blocked, true);
  assert.equal(r.existing_appointment_id, 'appt-existing-1');
  assert.equal(r.existing_calendar_id, WINDOW_ESTIMATE);
  assert.equal(createPosts().length, 0, 'must not create a second appointment');
  assert.equal(puts().length, 0, 'must not touch the existing appointment either');
});

test('(1b) the block escalates to a human', async () => {
  reset({ events: [evt()] });
  await executeBookAppointment(action(), {});
  await drainGroupMe();
  assert.match(groupMeText(), /BOOKING BLOCKED/);
  assert.match(groupMeText(), /already holds an active appointment/i,
    'the rep card must say why, and that nothing was created');
});

test('(1c) blocking a phone booking never cancels the in-home demo', async () => {
  // The explicit reason block was chosen over replace: a 15-minute Conf Call
  // must never destroy a booked Window Estimate.
  reset({ events: [evt({ calendarId: WINDOW_ESTIMATE, title: 'Window Estimate' })] });
  await executeBookAppointment(action(), {});
  const cancels = calls.filter((c) =>
    c.method === 'PUT' && JSON.stringify(c.body || {}).includes('cancelled'));
  assert.equal(cancels.length, 0, 'the existing demo must survive untouched');
});

// ═══ 2. Same-calendar behaviour is unchanged ═════════════════════════

test('(2) same calendar, same time → idempotent skip, still no second object', async () => {
  reset({ events: [evt({ calendarId: CONF_CALL, startTime: FUTURE_LATER, endTime: FUTURE_LATER })] });
  const r = await executeBookAppointment(action(), {});
  assert.equal(r.action, 'appointment_book_skipped_existing');
  assert.equal(r.skipped_reason, 'idempotent_skip');
  assert.equal(createPosts().length, 0);
});

test('(3) same calendar, different time → rescheduled in place, no second object', async () => {
  reset({ events: [evt({ calendarId: CONF_CALL, startTime: FUTURE, endTime: FUTURE })] });
  const r = await executeBookAppointment(action(), {});
  assert.equal(r.action, 'appointment_rescheduled_existing');
  assert.equal(createPosts().length, 0, 'reschedule moves the existing object, never creates');
  assert.equal(puts().length, 1);
});

test('(3b) same-calendar wins when the contact ALREADY holds two', async () => {
  // A pre-existing violation (two live appointments) must not make the handler
  // block a same-calendar reschedule — moving one in place does not add a
  // third, and is the outcome that reduces the count rather than raising it.
  reset({
    events: [
      evt({ id: 'a-other', calendarId: WINDOW_ESTIMATE, startTime: FUTURE, endTime: FUTURE }),
      evt({ id: 'a-same', calendarId: CONF_CALL, startTime: FUTURE, endTime: FUTURE }),
    ],
  });
  const r = await executeBookAppointment(action(), {});
  assert.equal(r.action, 'appointment_rescheduled_existing');
  assert.equal(r.appointment_id, 'a-same');
  assert.equal(createPosts().length, 0);
});

// ═══ 3. The clean path still books ══════════════════════════════════

test('(4) no existing appointment → books normally', async () => {
  reset({ events: [] });
  const r = await executeBookAppointment(action(), {});
  assert.equal(r.action, 'appointment_booked');
  assert.equal(createPosts().length, 1);
});

test('(4b) a CANCELLED existing appointment does not block', async () => {
  // fetchUpcomingAppointments already filters cancelled/noshow, so a lead whose
  // only other appointment was cancelled is free to book. Pinned because the
  // whole rule depends on that filter.
  reset({ events: [evt({ appointmentStatus: 'cancelled' })] });
  const r = await executeBookAppointment(action(), {});
  assert.equal(r.action, 'appointment_booked');
});

test('(5) lookup failure still fails OPEN and books', async () => {
  // Pre-existing contract: a failed lookup must not strand a booking the bot
  // has already promised. Widening the guard must not change that.
  reset({ fails: true });
  const r = await executeBookAppointment(action(), {});
  assert.equal(r.action, 'appointment_booked');
});

// ═══ 4. Kill switch ═════════════════════════════════════════════════

test('(6) ONE_APPT_PER_CONTACT=false restores the old calendar-scoped behaviour', async () => {
  process.env.ONE_APPT_PER_CONTACT = 'false';
  try {
    const mod = await import('../src/actions/handlers/appointments.js?killswitch=1');
    reset({ events: [evt()] });
    const r = await mod.executeBookAppointment(action(), {});
    assert.equal(r.action, 'appointment_booked', 'with the rule off, a cross-calendar create proceeds');
    assert.equal(createPosts().length, 1);
  } finally {
    delete process.env.ONE_APPT_PER_CONTACT;
  }
});

// ═══ 5. The lead must never be told they are booked ══════════════════

test('(7) the blocked action is NOT in send-message-handler BOOKING_LANDED_ACTIONS', async () => {
  // THE LOAD-BEARING ASSERTION. send-message-handler decides whether to tell
  // the lead "you're all set" from an ALLOWLIST of outcomes. A new blocked
  // outcome is safe precisely because it is absent from that list — this test
  // fails loudly if someone ever adds it.
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/send-message-handler.js'),
    'utf8',
  );
  const block = src.slice(src.indexOf('const BOOKING_LANDED_ACTIONS'));
  const listed = block.slice(0, block.indexOf(']'));
  assert.doesNotMatch(listed, /appointment_blocked_existing_appointment/,
    'a blocked booking must never count as landed');
  // And the three that legitimately mean "booked" are still there.
  for (const a of ['appointment_booked', 'appointment_rescheduled_existing', 'appointment_book_skipped_existing']) {
    assert.match(listed, new RegExp(a), `${a} must remain a landed outcome`);
  }
});
