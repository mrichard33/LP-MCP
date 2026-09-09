/**
 * test-cancel-appointment-resolution.js — 2026-09-09
 * (Wally Scott, GHL 2LT4JDrObOgPlKnn3H0q / LP 573728, post-mortem).
 *
 * WHAT WENT WRONG: the response-generator emitted a cancel_appointment
 * companion carrying an appointment id that did not exist —
 * OWd5WhnU2l6x56R9Y9mO. The EXISTING APPOINTMENTS prompt block was empty
 * (fetchUpcomingAppointments is future-only and Wally's slot had already
 * passed), so the model had nothing real to quote and invented one. GHL
 * answered the PUT with 400, the action died, and NOBODY WAS TOLD — the bot
 * had already written "you're taken off the calendar" to the homeowner, who
 * was still on the calendar.
 *
 * The three guarantees under test:
 *   1. a payload id the contact really has → exactly one PUT, on that id
 *   2. a payload id the contact does NOT have → fall back to the live list
 *      and cancel the real appointment
 *   3. nothing cancellable at all → LOUD failure: cancel:failed tag, a
 *      critical appointment.cancel_failed event, a rep task, and a rethrow
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';
process.env.GHL_LOCATION_ID = 'test-location';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const CONTACT_ID = 'contact-wally';
const REAL_APPT_ID = 'appt-real-1';
const HALLUCINATED_ID = 'OWd5WhnU2l6x56R9Y9mO';

// ─── stubbed GHL ────────────────────────────────────────────────────
let calls = [];
let contactAppointments = [];
let putFailures = new Set();   // appointment ids whose PUT answers 400
let tagsApplied = [];

function jsonRes(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// A far-future slot so resolveActiveAppointmentId picks it as "next future".
const futureIso = () => new Date(Date.now() + 3 * 86_400_000).toISOString();

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const path = String(url).replace('https://services.leadconnectorhq.com', '');
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path, body });

  if (method === 'GET' && /^\/contacts\/[^/]+\/appointments/.test(path)) {
    return jsonRes({ events: contactAppointments });
  }
  if (method === 'POST' && /^\/contacts\/[^/]+\/tags/.test(path)) {
    tagsApplied.push(...(body?.tags || []));
    return jsonRes({ tags: body?.tags || [] });
  }
  if (method === 'PUT' && path.startsWith('/calendars/events/appointments/')) {
    const id = path.split('/').pop();
    if (putFailures.has(id)) {
      return jsonRes({ message: 'Appointment not found' }, 400);
    }
    const appt = contactAppointments.find((a) => a.id === id);
    if (appt && body?.appointmentStatus) appt.appointmentStatus = body.appointmentStatus;
    return jsonRes({ id });
  }
  return jsonRes({});
};

// applyGHLTag goes through axios, not fetch. Intercept at the axios adapter so
// the cancel:failed tag is observable without a network call.
const axios = (await import('axios')).default;
axios.defaults.adapter = async (config) => {
  const url = `${config.baseURL || ''}${config.url}`;
  const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data;
  calls.push({ method: String(config.method || '').toUpperCase(), path: url.replace('https://services.leadconnectorhq.com', ''), body });
  if (/\/contacts\/[^/]+\/tags$/.test(url) && String(config.method).toLowerCase() === 'post') {
    tagsApplied.push(...(body?.tags || []));
  }
  return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
};

const { executeCancelAppointment } = await import('../src/actions/handlers/appointments.js');

function reset() {
  calls = [];
  tagsApplied = [];
  putFailures = new Set();
  contactAppointments = [];
}

const calendarPuts = () => calls.filter(
  (c) => c.method === 'PUT' && c.path.startsWith('/calendars/events/appointments/')
);
const putIds = () => calendarPuts().map((c) => c.path.split('/').pop());

// ─── 1. valid payload id → one PUT, on that id ──────────────────────

test('valid payload appointment_id → cancels that appointment with a single PUT', async () => {
  reset();
  contactAppointments = [
    { id: REAL_APPT_ID, appointmentStatus: 'confirmed', startTime: futureIso() },
  ];

  const result = await executeCancelAppointment({
    target_id: CONTACT_ID,
    action_payload: { appointment_id: REAL_APPT_ID, reason: 'lead requested' },
  });

  assert.equal(result.action, 'appointment_updated');
  assert.equal(result.appointment_id, REAL_APPT_ID);
  assert.equal(result.new_status, 'cancelled');
  assert.equal(result.resolved_from, 'payload');
  assert.deepEqual(putIds(), [REAL_APPT_ID], 'exactly one PUT, on the payload id');
  assert.ok(!tagsApplied.includes('cancel:failed'), 'a successful cancel never tags cancel:failed');
});

// ─── 2. invalid payload id → live fallback ──────────────────────────

test('hallucinated payload appointment_id → resolves live and cancels the real appointment', async () => {
  reset();
  contactAppointments = [
    { id: REAL_APPT_ID, appointmentStatus: 'confirmed', startTime: futureIso() },
  ];

  const result = await executeCancelAppointment({
    target_id: CONTACT_ID,
    action_payload: { appointment_id: HALLUCINATED_ID },
  });

  assert.equal(result.appointment_id, REAL_APPT_ID);
  assert.equal(result.resolved_from, 'live_api_after_invalid_payload');
  assert.deepEqual(putIds(), [REAL_APPT_ID], 'the invented id is never PUT to');
  assert.ok(!putIds().includes(HALLUCINATED_ID));
  assert.ok(!tagsApplied.includes('cancel:failed'));
});

test('a payload id that passes the list check but 400s on PUT → retried once against the live id', async () => {
  reset();
  // The id IS on the contact's list (so check (a) passes) but GHL rejects the
  // PUT — a stale object. The retry must go to the resolvable active one.
  const staleId = 'appt-stale';
  contactAppointments = [
    { id: staleId, appointmentStatus: 'invalid', startTime: futureIso() },
    { id: REAL_APPT_ID, appointmentStatus: 'confirmed', startTime: futureIso() },
  ];
  putFailures.add(staleId);

  const result = await executeCancelAppointment({
    target_id: CONTACT_ID,
    action_payload: { appointment_id: staleId },
  });

  assert.deepEqual(putIds(), [staleId, REAL_APPT_ID], 'one failed PUT then one retry');
  assert.equal(result.appointment_id, REAL_APPT_ID);
  assert.equal(result.resolved_from, 'live_api_after_invalid_payload');
});

test('no payload id at all → resolves live (pre-existing v3.2 contract, unchanged)', async () => {
  reset();
  contactAppointments = [
    { id: REAL_APPT_ID, appointmentStatus: 'confirmed', startTime: futureIso() },
  ];

  const result = await executeCancelAppointment({
    target_id: CONTACT_ID,
    action_payload: {},
  });

  assert.equal(result.appointment_id, REAL_APPT_ID);
  assert.equal(result.resolved_from, 'live_api');
  assert.deepEqual(putIds(), [REAL_APPT_ID]);
});

// ─── 3. nothing resolvable → loud failure ───────────────────────────

test('nothing cancellable → cancel:failed tag + rep task + rethrow (never silent)', async () => {
  reset();
  contactAppointments = []; // contact has no appointments at all

  await assert.rejects(
    () => executeCancelAppointment({
      target_id: CONTACT_ID,
      action_payload: { appointment_id: HALLUCINATED_ID },
    }),
    /no active appointment/i,
    'the failure must propagate — the executor has to see it',
  );

  assert.equal(calendarPuts().length, 0, 'never PUT to an id we could not verify or resolve');
  assert.ok(
    tagsApplied.includes('cancel:failed'),
    'cancel:failed must be on the contact — the lead was told the appointment is off the calendar',
  );
  // executeCreateTask writes its audit note to the contact before notifying.
  // That note is the rep-visible half of the escalation.
  const note = calls.find(
    (c) => c.method === 'POST' && /^\/contacts\/[^/]+\/notes$/.test(c.path)
  );
  assert.ok(note, 'a rep task must be created — the failure is never silent');
  assert.match(String(note.body?.body || ''), /CANCEL FAILED/);
  assert.match(String(note.body?.body || ''), new RegExp(HALLUCINATED_ID));
});

test('escalation fires on a PUT that fails and cannot be retried', async () => {
  reset();
  // Single appointment, on the contact's list, and its PUT 400s. The live
  // resolve returns the same id, so there is no retry to make.
  contactAppointments = [
    { id: REAL_APPT_ID, appointmentStatus: 'confirmed', startTime: futureIso() },
  ];
  putFailures.add(REAL_APPT_ID);

  await assert.rejects(
    () => executeCancelAppointment({
      target_id: CONTACT_ID,
      action_payload: { appointment_id: REAL_APPT_ID },
    }),
    /→ 400/,
  );

  assert.deepEqual(putIds(), [REAL_APPT_ID], 'no pointless second PUT to the same id');
  assert.ok(tagsApplied.includes('cancel:failed'));
});
