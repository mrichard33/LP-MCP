/**
 * Appointment create integrity — scripts/test-appointment-create-integrity.js
 *
 * Covers the 2026-08-15 booking-integrity fix in
 * src/actions/handlers/appointments.js, all four parts:
 *   1. Every appointment is born 'new'. A caller-supplied 'confirmed' is
 *      ignored at creation; update_appointment_status owns that transition.
 *   2. A booking is not "booked" until GHL hands the object back. The POST is
 *      followed by a read-back (one retry) and the action FAILS if it can't be
 *      verified, so no downstream promise fires on an unverified create.
 *   3. A failed POST and a blocked prerequisite gate both escalate to a human
 *      instead of ending silently.
 *   4. The person name in an appointment title comes from the GHL contact
 *      record only, never from the action payload.
 *
 * The incident: contact gUihunGyOa6SiGbJCJ3K was texted "you're all set for
 * Wednesday, August 19 at 3:00 PM" while no appointment object existed.
 * Action 320913 returned appointment_blocked_prerequisites with the row still
 * reading `completed`; action 320924 then died on GHL 400 "The slot you have
 * selected is no longer available" with no rep task and no alternate slot.
 *
 * EVERYTHING IS ASSERTED AT THE fetch BOUNDARY. node:test module mocking is
 * deliberately NOT used: `npm test` runs `node --test scripts/test-*.js` with
 * no flags, and mock.module requires --experimental-test-module-mocks, so a
 * mocked suite would break the repo's own test command.
 *
 * Escalation is asserted end-to-end through GroupMe rather than by spying on
 * executeCreateTask: GROUPME_DEBOUNCE_MS=1 collapses the v1.7 consolidation
 * window so the rep card POSTs within the test. That proves the escalation
 * actually reaches a human channel, which is the whole point of the fix.
 *
 * Run: node --test scripts/test-appointment-create-integrity.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';
process.env.GHL_API_KEY = 'test-key';
process.env.GROUPME_BOT_ID = 'test-bot';   // without this GroupMe logs and returns
process.env.GROUPME_DEBOUNCE_MS = '1';     // collapse the 5s consolidation window
// Intentionally NOT setting SUPABASE_* — emitEvent and the state writes are
// guarded on it, so the suite exercises the GHL surface only.

// ─── fetch stub (installed before import) ────────────────────────────
let calls = [];
let contactRecord = null;      // GET /contacts/{id}
let postOutcome = 'ok';        // 'ok' | 'slot_taken' | 'no_id'
let readBackMode = 'ok';       // 'ok' | 'fail' | 'fail_once'
let readBackCalls = 0;
let createdApptId = 'appt-created-1';

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
  const path = raw.replace('https://services.leadconnectorhq.com', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path, body });

  // GroupMe rep card — the escalation channel
  if (raw.startsWith('https://api.groupme.com')) return jsonRes({});

  // double-book guard (must precede the single-contact GET)
  if (method === 'GET' && /^\/contacts\/[^/?]+\/appointments/.test(path)) {
    return jsonRes({ events: [] });
  }
  // read-back verification (must precede the create POST match)
  if (method === 'GET' && /^\/calendars\/events\/appointments\/[^/?]+$/.test(path)) {
    readBackCalls++;
    if (readBackMode === 'fail') return errRes(500, 'read-back boom');
    if (readBackMode === 'fail_once' && readBackCalls === 1) return errRes(500, 'transient');
    return jsonRes({
      appointment: {
        id: path.split('/').pop(),
        appointmentStatus: 'new',
        startTime: '2026-08-19T19:00:00+00:00',
      },
    });
  }
  // create
  if (method === 'POST' && path === '/calendars/events/appointments') {
    if (postOutcome === 'slot_taken') {
      return errRes(400, JSON.stringify({ message: 'The slot you have selected is no longer available.' }));
    }
    if (postOutcome === 'no_id') return jsonRes({});
    return jsonRes({ id: createdApptId });
  }
  // contact read
  if (method === 'GET' && /^\/contacts\/[^/?]+$/.test(path)) {
    return jsonRes({ contact: contactRecord });
  }
  return jsonRes({});
};

const { executeBookAppointment } = await import('../src/actions/handlers/appointments.js');

const WINDOW_ESTIMATE = 'aJj14ONxh1oFyDcQ706O';  // in-home → prerequisite gate
const REVIEW_SESSION  = 'DQYMaJ22N6zL4SXjHukw';  // phone → no gate
const CONTACT_ID = 'gUihunGyOa6SiGbJCJ3K';
const START = '2026-08-19T19:00:00+00:00';

// A contact that satisfies the in-home gate: real name, phone, street + zip.
const fullContact = (over = {}) => ({
  id: CONTACT_ID, firstName: 'Maria', lastName: '', phone: '+18135551234',
  address1: '3311 Foxridge Cir', city: 'Tampa', state: 'FL', postalCode: '33618',
  tags: [], customFields: [], ...over,
});

function reset({ contact = fullContact(), post = 'ok', readBack = 'ok' } = {}) {
  calls = [];
  contactRecord = contact;
  postOutcome = post;
  readBackMode = readBack;
  readBackCalls = 0;
}

const action = (payload = {}) => ({
  target_id: CONTACT_ID,
  action_payload: {
    calendar_name: 'Window Estimate',
    start_time: START,
    qualifying_data: { decision_makers_present: 'Yes' },
    ...payload,
  },
});

const createPosts = () => calls.filter((c) => c.method === 'POST' && c.path === '/calendars/events/appointments');
const groupMePosts = () => calls.filter((c) => c.path.startsWith('https://api.groupme.com'));
// The debounce flusher fires on a timer; give it a tick to drain.
const drainGroupMe = () => new Promise((r) => setTimeout(r, 60));
const groupMeText = () => groupMePosts().map((c) => c.body?.text || '').join('\n');

// ═══ 1. Always born 'new' ═════════════════════════════════════════════

test("(1) payload status 'confirmed' → POST body carries appointmentStatus 'new'", async () => {
  reset();
  await executeBookAppointment(action({ status: 'confirmed' }), {});
  assert.equal(createPosts().length, 1);
  assert.equal(createPosts()[0].body.appointmentStatus, 'new',
    'a caller-supplied confirmed must never reach GHL at creation');
});

test("(1b) no status supplied → still 'new'", async () => {
  reset();
  await executeBookAppointment(action(), {});
  assert.equal(createPosts()[0].body.appointmentStatus, 'new');
});

// ═══ 2. Read-back verification ════════════════════════════════════════

test('(2) POST succeeds and read-back returns the object → appointment_booked', async () => {
  reset();
  const r = await executeBookAppointment(action(), {});
  assert.equal(r.action, 'appointment_booked');
  assert.equal(r.appointment_id, createdApptId);
  assert.equal(readBackCalls, 1, 'a successful read-back must not retry');
});

test('(3) read-back fails BOTH attempts → throws, nothing is confirmed', async () => {
  reset({ readBack: 'fail' });
  await assert.rejects(
    () => executeBookAppointment(action(), {}),
    /could not be read back from GHL/,
    'an unverifiable create must fail the action rather than confirm to the lead',
  );
  assert.equal(readBackCalls, 2, 'read-back gets exactly one retry');
  // The promise-making tail must not have run.
  assert.equal(calls.some((c) => c.method === 'POST' && /conversations|messages/.test(c.path)), false,
    'no confirmation message may be queued for an unverified booking');
});

test('(3b) read-back fails once then succeeds → booked (the retry is real)', async () => {
  reset({ readBack: 'fail_once' });
  const r = await executeBookAppointment(action(), {});
  assert.equal(r.action, 'appointment_booked');
  assert.equal(readBackCalls, 2);
});

test('(3c) POST returns no appointment id → throws, no read-back attempted', async () => {
  reset({ post: 'no_id' });
  await assert.rejects(
    () => executeBookAppointment(action(), {}),
    /returned no appointment id/,
  );
  assert.equal(readBackCalls, 0);
});

// ═══ 3. Escalation ════════════════════════════════════════════════════

test('(4) POST 400 → rep card raised and the error rethrown', async () => {
  reset({ post: 'slot_taken' });
  await assert.rejects(
    () => executeBookAppointment(action(), {}),
    /no longer available/,
    'the GHL error must still propagate so the action row goes failed',
  );
  assert.equal(readBackCalls, 0, 'a failed POST is never read back');

  await drainGroupMe();
  assert.match(groupMeText(), /BOOKING FAILED/,
    'a failed booking must reach a human, not end in silence');
  assert.match(groupMeText(), /no longer available/,
    'the rep card must carry the GHL error so the rep knows why');

  // NOT asserted here: the booking:failed tag and the booking.create_failed
  // emit. applyGHLTag goes through the axios ghlClient (not global fetch) and
  // emitEvent needs supabase, so neither is visible to this stub — both are
  // also .catch()-swallowed by design so they can never mask the rethrow.
  // The rep card above is the escalation half that a human actually sees.
});

test('(5) blocked prerequisites → rep card, and the load-bearing action string is unchanged', async () => {
  // Missing decision_maker_question: no dm in payload, none on the contact,
  // no booking:dm-* tag. This is action 320913's exact shape.
  reset({ contact: fullContact({ tags: [], customFields: [] }) });
  const r = await executeBookAppointment(
    { target_id: CONTACT_ID, action_payload: { calendar_name: 'Window Estimate', start_time: START } },
    {},
  );
  // src/send-message-handler.js matches this exact string — renaming it breaks
  // the caller that suppresses the "you're all set" copy.
  assert.equal(r.action, 'appointment_blocked_prerequisites');
  assert.equal(r.blocked, true);
  assert.ok(r.missing.includes('decision_maker_question'));
  assert.equal(createPosts().length, 0, 'a blocked booking must create nothing');

  await drainGroupMe();
  assert.match(groupMeText(), /BOOKING BLOCKED/,
    'a blocked booking must reach a human, not end in silence');
});

// ═══ 4. Title comes from the GHL contact only ═════════════════════════

test('(6) firstName only → "Window Estimate - Maria"', async () => {
  reset({ contact: fullContact({ firstName: 'Maria', lastName: '' }) });
  await executeBookAppointment(action(), {});
  assert.equal(createPosts()[0].body.title, 'Window Estimate - Maria');
});

test('(6b) a payload-supplied surname is NEVER used', async () => {
  // THE REGRESSION. The model-authored title read "Window Estimate - Maria
  // Laing"; "Laing" came from a cross-contaminated LP prospect lookup (Yvonne
  // Laing, LP lead 566250). An LP-derived surname must not reach a
  // customer-visible artifact.
  reset({ contact: fullContact({ firstName: 'Maria', lastName: '' }) });
  await executeBookAppointment(action({ title: 'Window Estimate - Maria Laing' }), {});
  const sent = createPosts()[0].body.title;
  assert.equal(sent, 'Window Estimate - Maria');
  assert.doesNotMatch(sent, /Laing/, 'the payload surname must be discarded');
});

test('(6c) contact carries a real last name → both names, from the record', async () => {
  reset({ contact: fullContact({ firstName: 'Maria', lastName: 'Gonzalez' }) });
  await executeBookAppointment(action(), {});
  assert.equal(createPosts()[0].body.title, 'Window Estimate - Maria Gonzalez');
});

test('(6d) no name on the record → calendar name alone, never the payload name', async () => {
  // A nameless contact trips the in-home gate on real_name, so this case is
  // exercised on a phone calendar where the gate does not apply. The title
  // code path is calendar-agnostic.
  reset({ contact: fullContact({ firstName: '', lastName: '' }) });
  await executeBookAppointment(
    {
      target_id: CONTACT_ID,
      action_payload: {
        calendar_name: 'Review Session',
        start_time: START,
        title: 'Review Session - Maria Laing',
      },
    },
    {},
  );
  const sent = createPosts()[0].body.title;
  assert.equal(sent, 'Review Session');
  assert.doesNotMatch(sent, /Laing/);
});

test('(6e) title falls back to the calendar id lookup when no calendar_name is given', async () => {
  reset({ contact: fullContact({ firstName: 'Maria', lastName: '' }) });
  await executeBookAppointment(
    {
      target_id: CONTACT_ID,
      action_payload: {
        calendar_id: REVIEW_SESSION,
        start_time: START,
        title: 'Bogus - Wrong Person',
      },
    },
    {},
  );
  // DQYMaJ22N6zL4SXjHukw maps to "Review Session" in CALENDAR_MAP.
  assert.equal(createPosts()[0].body.title, 'Review Session - Maria');
});

// ═══ 7. Confirmation Calls go to the Rehash rep (the user, 2026-10-09) ═══

const CONFIRMATION_CALL = 'gFWoSQrlKIdfRbAPV842';
const confAction = (payload = {}) => action({
  calendar_name: 'Confirmation Call', calendar_id: CONFIRMATION_CALL, ...payload,
});

// 2026-10-09 (the user, after #1223): pre-demo leads use Confirmation Call
// too, so it names nobody again; rehash calls have their own Rehash Call
// calendar (REHASH_CALENDAR_ID), which goes to the rehash rep.
test('(7) a pre-demo Confirmation Call names nobody — not the Rehash rep', async () => {
  reset({ contact: fullContact({ assignedTo: null }) });
  await executeBookAppointment(confAction(), {});
  assert.equal(createPosts().length, 1);
  assert.equal(createPosts()[0].body.calendarId, CONFIRMATION_CALL);
  assert.equal(createPosts()[0].body.assignedUserId, undefined);
});

test('(7b) a Confirmation Call does not take the contact owner either', async () => {
  reset({ contact: fullContact({ assignedTo: 'ownerUser123' }) });
  await executeBookAppointment(confAction(), {});
  assert.equal(createPosts()[0].body.assignedUserId, undefined);
});

test('(7e) a Rehash Call goes to a rehash-team owner, else the Rehash rep', async () => {
  const prev = { cal: process.env.REHASH_CALENDAR_ID, team: process.env.REHASH_TEAM_USER_IDS };
  process.env.REHASH_CALENDAR_ID = 'rehashCal1';
  process.env.REHASH_TEAM_USER_IDS = 'TYcZ9DcNkuPCFYsFxRFV,rep2';
  try {
    reset({ contact: fullContact({ assignedTo: 'rep2' }) });
    await executeBookAppointment(action({ calendar_name: 'Rehash Call', calendar_id: 'rehashCal1' }), {});
    assert.equal(createPosts()[0].body.assignedUserId, 'rep2');
    reset({ contact: fullContact({ assignedTo: 'salesRep' }) });
    await executeBookAppointment(action({ calendar_name: 'Rehash Call', calendar_id: 'rehashCal1' }), {});
    assert.equal(createPosts()[0].body.assignedUserId, 'TYcZ9DcNkuPCFYsFxRFV');
  } finally {
    for (const [k, v] of [['REHASH_CALENDAR_ID', prev.cal], ['REHASH_TEAM_USER_IDS', prev.team]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('(7c) an assignee named on the payload wins over the owner', async () => {
  reset({ contact: fullContact({ assignedTo: 'ownerUser123' }) });
  await executeBookAppointment(confAction({ assigned_user_id: 'explicitUser9' }), {});
  assert.equal(createPosts()[0].body.assignedUserId, 'explicitUser9');
});

test('(7d) a Window Estimate is not touched by the Rehash rule', async () => {
  reset({ contact: fullContact({ assignedTo: 'ownerUser123' }) });
  await executeBookAppointment(action(), {});
  assert.equal(createPosts()[0].body.assignedUserId, undefined);
});
