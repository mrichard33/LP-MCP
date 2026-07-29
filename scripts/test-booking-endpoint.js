/**
 * Guards for src/appointments/booking-endpoint.js.
 *
 * The endpoint sits on a GHL workflow's SYNCHRONOUS path and Mark branches on
 * the response body in the GHL UI, so the contract itself is the thing under
 * test:
 *
 *   • ALWAYS HTTP 200, on every path including auth failure and internal error.
 *     A non-2xx may render as an unparseable response in GHL and cost the
 *     branch entirely.
 *   • Body is always flat { outcome, appointmentId, message }.
 *   • outcome ∈ created | updated | noop_already_exists | error. Only `error`
 *     tells I.LP-IN to fall back to its native booking node.
 *   • Auth is header-only and fails closed when the env key is unset.
 *   • The budget returns `error` / budget_exceeded rather than hanging the
 *     workflow.
 *
 * There was no test for this file before; it shipped in PR #581 untested.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppointmentFromLpHandler, bookingBudgetMs, raceWithBudget } from '../src/appointments/booking-endpoint.js';

const KEY = 'test-booking-key';

/** Minimal Express-ish res that records what the handler sent. */
function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function makeReq(body = {}, headers = {}) {
  return { body, query: {}, headers };
}

/** Run the handler with env pinned, restoring afterwards. */
async function withEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const VALID_OUTCOMES = new Set(['created', 'updated', 'noop_already_exists', 'error']);

function assertContract(res) {
  assert.equal(res.statusCode, 200, 'must always be HTTP 200');
  assert.ok(res.body && typeof res.body === 'object', 'body must be an object');
  assert.ok(VALID_OUTCOMES.has(res.body.outcome), `unexpected outcome: ${res.body.outcome}`);
  assert.ok('appointmentId' in res.body, 'appointmentId key always present');
  assert.equal(typeof res.body.message, 'string', 'message is always a string');
}

// ─── Auth ───────────────────────────────────────────────────────────

test('bad key → 200 + outcome error (never 401)', async () => {
  await withEnv({ APPT_BOOKING_ENDPOINT_KEY: KEY, APPT_SLOT_CHECK_ENABLED: 'true' }, async () => {
    const res = makeRes();
    await createAppointmentFromLpHandler(makeReq({}, { 'x-appt-booking-key': 'wrong' }), res);
    assertContract(res);
    assert.equal(res.body.outcome, 'error');
    assert.equal(res.body.message, 'invalid_key');
  });
});

test('missing key header → outcome error', async () => {
  await withEnv({ APPT_BOOKING_ENDPOINT_KEY: KEY, APPT_SLOT_CHECK_ENABLED: 'true' }, async () => {
    const res = makeRes();
    await createAppointmentFromLpHandler(makeReq({}), res);
    assertContract(res);
    assert.equal(res.body.message, 'invalid_key');
  });
});

test('fails CLOSED when APPT_BOOKING_ENDPOINT_KEY is unset — correct key value is irrelevant', async () => {
  await withEnv({ APPT_BOOKING_ENDPOINT_KEY: undefined, APPT_SLOT_CHECK_ENABLED: 'true' }, async () => {
    const res = makeRes();
    await createAppointmentFromLpHandler(makeReq({}, { 'x-appt-booking-key': 'anything' }), res);
    assertContract(res);
    assert.equal(res.body.message, 'invalid_key');
  });
});

test('key in the BODY is rejected — header-only, so the secret stays out of logs', async () => {
  await withEnv({ APPT_BOOKING_ENDPOINT_KEY: KEY, APPT_SLOT_CHECK_ENABLED: 'true' }, async () => {
    const res = makeRes();
    await createAppointmentFromLpHandler(makeReq({ key: KEY, contactId: 'c1', calendarId: 'cal', startTime: '2026-08-01T14:00:00-04:00' }), res);
    assertContract(res);
    assert.equal(res.body.message, 'invalid_key');
  });
});

// ─── Validation ─────────────────────────────────────────────────────

test('missing required fields → 200 + outcome error', async () => {
  await withEnv({ APPT_BOOKING_ENDPOINT_KEY: KEY, APPT_SLOT_CHECK_ENABLED: 'true' }, async () => {
    for (const body of [
      {},
      { contactId: 'c1' },
      { contactId: 'c1', calendarId: 'cal' },
      { calendarId: 'cal', startTime: '2026-08-01T14:00:00-04:00' },
    ]) {
      const res = makeRes();
      await createAppointmentFromLpHandler(makeReq(body, { 'x-appt-booking-key': KEY }), res);
      assertContract(res);
      assert.equal(res.body.outcome, 'error');
      assert.match(res.body.message, /required/);
    }
  });
});

// ─── Dark-ship gate ─────────────────────────────────────────────────

test('flag off → outcome error so I.LP-IN falls back to its native node', async () => {
  for (const v of [undefined, 'false', '1', 'yes']) {
    await withEnv({ APPT_BOOKING_ENDPOINT_KEY: KEY, APPT_SLOT_CHECK_ENABLED: v }, async () => {
      const res = makeRes();
      await createAppointmentFromLpHandler(makeReq(
        { contactId: 'c1', calendarId: 'cal', startTime: '2026-08-01T14:00:00-04:00' },
        { 'x-appt-booking-key': KEY },
      ), res);
      assertContract(res);
      assert.equal(res.body.outcome, 'error');
      assert.equal(res.body.message, 'appt_slot_check_disabled');
      assert.equal(res.body.appointmentId, null);
    });
  }
});

// ─── Budget ─────────────────────────────────────────────────────────

test('bookingBudgetMs defaults to 8000 and honours a valid override', async () => {
  await withEnv({ APPT_BOOKING_BUDGET_MS: undefined }, () => {
    assert.equal(bookingBudgetMs(), 8000);
  });
  await withEnv({ APPT_BOOKING_BUDGET_MS: '2500' }, () => {
    assert.equal(bookingBudgetMs(), 2500);
  });
  // Garbage and non-positive values fall back rather than disabling the budget.
  for (const bad of ['', 'abc', '0', '-1']) {
    await withEnv({ APPT_BOOKING_BUDGET_MS: bad }, () => {
      assert.equal(bookingBudgetMs(), 8000, `"${bad}" must fall back to the default`);
    });
  }
});

test('raceWithBudget: work wins when it finishes inside the budget', async () => {
  const out = await raceWithBudget(Promise.resolve({ outcome: 'created' }), 1000);
  assert.equal(out.timedOut, false);
  assert.deepEqual(out.value, { outcome: 'created' });
});

test('raceWithBudget: deadline wins when the work overruns', async () => {
  const slow = new Promise((r) => setTimeout(() => r({ outcome: 'created' }), 200));
  const out = await raceWithBudget(slow, 10);
  assert.equal(out.timedOut, true);
  assert.equal(out.value, undefined);
});

test('raceWithBudget: the abandoned work is NOT cancelled', async () => {
  // A duplicate is visible and recoverable; a missed appointment is neither.
  // The in-flight create must be allowed to land.
  let landed = false;
  const slow = new Promise((r) => setTimeout(() => { landed = true; r('done'); }, 40));
  const out = await raceWithBudget(slow, 5);
  assert.equal(out.timedOut, true);
  await slow;
  assert.equal(landed, true, 'abandoned work still completed');
});

test('raceWithBudget: a fast rejection still propagates', async () => {
  await assert.rejects(
    () => raceWithBudget(Promise.reject(new Error('ghl exploded')), 1000),
    /ghl exploded/,
  );
});

test('budget expiry → outcome error / budget_exceeded, still HTTP 200', async () => {
  // 0 is rejected by bookingBudgetMs (falls back to 8000), so the deadline is
  // driven through the real env var at 1ms and the work is a genuine network
  // path. Asserted loosely on outcome; raceWithBudget above pins the mechanism.
  await withEnv({
    APPT_BOOKING_ENDPOINT_KEY: KEY,
    APPT_SLOT_CHECK_ENABLED: 'true',
    APPT_BOOKING_BUDGET_MS: '1',
  }, async () => {
    const res = makeRes();
    await createAppointmentFromLpHandler(makeReq(
      { contactId: 'c1', calendarId: 'cal', startTime: '2026-08-01T14:00:00-04:00' },
      { 'x-appt-booking-key': KEY },
    ), res);
    assertContract(res);
    // Either the budget fired or the lookup failed first — both are `error`,
    // which is what I.LP-IN branches on. Never a 5xx, never a silent create.
    assert.equal(res.body.outcome, 'error');
    assert.equal(res.body.appointmentId, null);
  });
});

// ─── Contract shape ─────────────────────────────────────────────────

test('response never carries legacy keys Mark would not branch on', async () => {
  await withEnv({ APPT_BOOKING_ENDPOINT_KEY: KEY, APPT_SLOT_CHECK_ENABLED: 'false' }, async () => {
    const res = makeRes();
    await createAppointmentFromLpHandler(makeReq(
      { contactId: 'c1', calendarId: 'cal', startTime: '2026-08-01T14:00:00-04:00' },
      { 'x-appt-booking-key': KEY },
    ), res);
    assert.deepEqual(Object.keys(res.body).sort(), ['appointmentId', 'message', 'outcome']);
    // `error` and `reason` were the PR #581 shape; branching on them would break.
    assert.equal(res.body.error, undefined);
    assert.equal(res.body.reason, undefined);
  });
});
