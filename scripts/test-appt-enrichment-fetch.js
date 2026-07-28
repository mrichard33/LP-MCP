/**
 * test-appt-enrichment-fetch.js — fetchLatestAppointment repoint + flag gates.
 *
 * Covers the 2026-07-28 fix in src/lp-appointment-sync.js. The old call hit
 * /calendars/events/appointments (a POST-only CREATION route) and 404'd on
 * 100% of calls since v5.1.6, leaving calendar-name enrichment dormant for
 * months. Repointed to GET /contacts/{contactId}/appointments, gated behind
 * APPT_ENRICHMENT_ENABLED + APPT_ENRICHMENT_LOG_ONLY so it ships dark.
 *
 *   1.  Flag off → returns null AND never touches the network. This is the
 *       assertion that proves merging changes nothing in production.
 *   2.  Enabled + log-only → fetch goes to /contacts/{id}/appointments (the
 *       whole bug is the path), but null is still returned to consumers.
 *   3.  Enabled + log-only off → the appointment is actually returned.
 *   4.  Ordering — latest by startTime wins REGARDLESS of status. Regression
 *       lock against someone swapping in fetchUpcomingAppointments, which
 *       filters to future+active and would silently change the semantics.
 *   5.  Response-envelope matrix: bare array / {events} / {appointments}.
 *   6.  Empty list → null, no throw.
 *   7.  404 → null (soft-fail preserved) and the warn line carries BOTH the
 *       status and the response body.
 *   8.  Network rejection → null, status unparseable, still no throw.
 *   9.  'disabled' telemetry is a one-shot latch, not one row per call.
 *   10. enrichFromGHLContact returns an identically shaped object while the
 *       flag is off. Cases 1-9 only exercise fetchLatestAppointment; this
 *       locks the no-op property in the live consumer, whose calendar block
 *       this change refactored into resolveCalendarFromAppointment.
 *
 * Supabase env is cleared so the module singleton is null — emitEvent then
 * throws internally and swallows its own error, making the telemetry path
 * inert. Assertions therefore target fetch calls, return values, and console
 * output, never DB writes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.GHL_API_KEY = 'test-key';
delete process.env.APPT_ENRICHMENT_ENABLED;
delete process.env.APPT_ENRICHMENT_LOG_ONLY;

const BASE = 'https://services.leadconnectorhq.com';
const CONTACT = 'contact-abc';
const WINDOW_ESTIMATE_CAL = 'aJj14ONxh1oFyDcQ706O';

function jsonRes(body, status = 200) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ─── fetch stub: records every call, replies from a per-test script ────────
let fetchCalls = [];
let apptHandler = () => jsonRes({ events: [] });

globalThis.fetch = async (url, opts) => {
  const path = String(url).replace(BASE, '');
  fetchCalls.push({ path, method: opts?.method || 'GET' });
  if (/\/appointments$/.test(path)) return apptHandler(path);
  if (/^\/contacts\/[^/]+$/.test(path)) {
    return jsonRes({ contact: { id: CONTACT, customFields: [], tags: [] } });
  }
  return jsonRes({});
};

const {
  fetchLatestAppointment,
  enrichFromGHLContact,
  resolveCalendarFromAppointment,
} = await import('../src/lp-appointment-sync.js');

// Flags are read inside the function, so each case just sets env and calls.
function setFlags({ enabled, logOnly }) {
  if (enabled === undefined) delete process.env.APPT_ENRICHMENT_ENABLED;
  else process.env.APPT_ENRICHMENT_ENABLED = enabled;
  if (logOnly === undefined) delete process.env.APPT_ENRICHMENT_LOG_ONLY;
  else process.env.APPT_ENRICHMENT_LOG_ONLY = logOnly;
}

function reset() {
  fetchCalls = [];
  apptHandler = () => jsonRes({ events: [] });
}

// Emits are fire-and-forget (`void`); let the microtask queue drain so a
// rejection cannot surface as an unhandled rejection mid-assertion.
const flush = () => new Promise((r) => setImmediate(r));

function captureConsole(method) {
  const original = console[method];
  const lines = [];
  console[method] = (...args) => { lines.push(args.join(' ')); };
  return { lines, restore: () => { console[method] = original; } };
}

const APPT = {
  id: 'appt-1',
  calendarId: WINDOW_ESTIMATE_CAL,
  startTime: '2026-08-01T15:00:00Z',
  appointmentStatus: 'confirmed',
};

// ─── 1. Flag off: null AND no network. The merge-safety assertion. ─────────
test('disabled → returns null without issuing any request', async () => {
  reset();
  setFlags({});
  const cap = captureConsole('log');
  const out = await fetchLatestAppointment(CONTACT);
  cap.restore();
  await flush();

  assert.equal(out, null);
  assert.equal(fetchCalls.length, 0, 'flag off must not touch the network');
});

// ─── 2. Enabled + log-only: right path, still null to consumers ────────────
test('enabled + log-only → hits /contacts/{id}/appointments but returns null', async () => {
  reset();
  setFlags({ enabled: 'true' });           // LOG_ONLY unset → log-only
  apptHandler = () => jsonRes({ events: [APPT] });

  const out = await fetchLatestAppointment(CONTACT);
  await flush();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].path, `/contacts/${CONTACT}/appointments`,
    'must call the contact-scoped route, not /calendars/events/appointments');
  assert.equal(fetchCalls[0].method, 'GET');
  assert.equal(out, null, 'log-only must withhold the result from consumers');
});

// ─── 3. Fully live: the appointment is returned ───────────────────────────
test('enabled + log-only off → returns the appointment', async () => {
  reset();
  setFlags({ enabled: 'true', logOnly: 'false' });
  apptHandler = () => jsonRes({ events: [APPT] });

  const out = await fetchLatestAppointment(CONTACT);
  await flush();

  assert.equal(out?.id, 'appt-1');
  assert.deepEqual(resolveCalendarFromAppointment(out), {
    calendarId: WINDOW_ESTIMATE_CAL,
    calendarName: 'Window Estimate',
  });
});

// ─── 4. Latest by startTime, ANY status ───────────────────────────────────
test('picks latest by startTime regardless of status', async () => {
  reset();
  setFlags({ enabled: 'true', logOnly: 'false' });
  apptHandler = () => jsonRes({
    events: [
      { id: 'old',    startTime: '2026-07-01T10:00:00Z', appointmentStatus: 'showed' },
      { id: 'newest', startTime: '2026-09-15T10:00:00Z', appointmentStatus: 'cancelled' },
      { id: 'mid',    startTime: '2026-08-01T10:00:00Z', appointmentStatus: 'confirmed' },
    ],
  });

  const out = await fetchLatestAppointment(CONTACT);
  await flush();

  assert.equal(out?.id, 'newest',
    'cancelled must NOT be filtered — semantics are most-recent, any status');
});

// ─── 5. Envelope matrix ───────────────────────────────────────────────────
for (const [label, body] of [
  ['bare array',      [APPT]],
  ['{events}',        { events: [APPT] }],
  ['{appointments}',  { appointments: [APPT] }],
]) {
  test(`envelope: ${label} resolves to the appointment`, async () => {
    reset();
    setFlags({ enabled: 'true', logOnly: 'false' });
    apptHandler = () => jsonRes(body);

    const out = await fetchLatestAppointment(CONTACT);
    await flush();
    assert.equal(out?.id, 'appt-1');
  });
}

// ─── 6. Empty list ────────────────────────────────────────────────────────
test('empty appointment list → null, no throw', async () => {
  reset();
  setFlags({ enabled: 'true', logOnly: 'false' });
  apptHandler = () => jsonRes({ events: [] });

  assert.equal(await fetchLatestAppointment(CONTACT), null);
  await flush();
});

// ─── 7. 404 soft-fail, logging status AND body ────────────────────────────
test('404 → null, and the warning carries both status and response body', async () => {
  reset();
  setFlags({ enabled: 'true', logOnly: 'false' });
  apptHandler = () => jsonRes({ message: 'Cannot GET /calendars/events/appointments' }, 404);

  const cap = captureConsole('warn');
  const out = await fetchLatestAppointment(CONTACT);
  cap.restore();
  await flush();

  assert.equal(out, null, 'soft-fail must be preserved — never throw');
  const line = cap.lines.join('\n');
  assert.match(line, /status=404/, 'status code must be logged');
  assert.match(line, /Cannot GET/, 'response body must be logged, not just the status');
});

// ─── 8. Network rejection ─────────────────────────────────────────────────
test('network error → null, status unparseable, no throw', async () => {
  reset();
  setFlags({ enabled: 'true', logOnly: 'false' });
  apptHandler = () => { throw new Error('socket hang up'); };

  const cap = captureConsole('warn');
  const out = await fetchLatestAppointment(CONTACT);
  cap.restore();
  await flush();

  assert.equal(out, null);
  assert.match(cap.lines.join('\n'), /status=n\/a/);
});

// ─── 9. 'disabled' telemetry is one-shot ──────────────────────────────────
test("disabled notice logs once per process, not once per call", async () => {
  reset();
  setFlags({});
  const cap = captureConsole('log');
  for (let i = 0; i < 5; i++) await fetchLatestAppointment(CONTACT);
  cap.restore();
  await flush();

  const notices = cap.lines.filter((l) => l.includes('enrichment DISABLED'));
  // The latch already tripped in case 1, so within this process the correct
  // count here is zero — either way it must never be one-per-call.
  assert.ok(notices.length <= 1, `expected at most one notice, got ${notices.length}`);
  assert.equal(fetchCalls.length, 0);
});

// ─── 10. enrichFromGHLContact no-op lock ──────────────────────────────────
test('enrichFromGHLContact shape is unchanged while enrichment is disabled', async () => {
  reset();
  setFlags({});

  const out = await enrichFromGHLContact(CONTACT);
  await flush();

  // Only the contact GET should fire — the appointments call must not.
  assert.deepEqual(fetchCalls.map((c) => c.path), [`/contacts/${CONTACT}`]);

  // Full shape lock: every key the pre-fix version returned, same values.
  assert.deepEqual(out, {
    phone: null,
    email: null,
    name: null,
    address1: null,
    postalCode: null,
    city: null,
    state: null,
    prospectId: null,
    inboundId: null,
    ghlLeadIdField: null,
    appointmentDate: null,
    appointmentTime: null,
    calendarId: null,
    calendarName: null,
  });
});
