/**
 * Delegated booking endpoint guards (handoff v3.4 Fix 0.9, 2026-10-16).
 *
 * I.LP-IN branches on `response.outcome` ∈ {created, updated, noop_already_exists}
 * (verified in the HL mirror); ANY other outcome — even HTTP 200 — runs GHL's own
 * "Book … Appointment" step around every guard. So a deliberate skip must answer
 * 200 + outcome noop_already_exists + { ok: true, booked: false, skipped: true,
 * reason }, and only a real technical failure answers `error`.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

const { createAppointmentFromLpHandler, __setBookingGuardDepsForTest } = await import('../src/appointments/booking-endpoint.js');
const { decideBookingGuard, checkBookingGuards, etHourOfRequest } = await import('../src/appointments/booking-endpoint-guard.js');

const KEY = 'guard-test-key';
const START = '2026-11-03T10:00:00-05:00';

function makeRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
  };
}

async function call({ lead, live = { ok: false, error: 'not_read' }, startTime = START, notify }) {
  const prev = { key: process.env.APPT_BOOKING_ENDPOINT_KEY, gate: process.env.APPT_SLOT_CHECK_ENABLED, budget: process.env.APPT_BOOKING_BUDGET_MS };
  process.env.APPT_BOOKING_ENDPOINT_KEY = KEY;
  process.env.APPT_SLOT_CHECK_ENABLED = 'true';
  process.env.APPT_BOOKING_BUDGET_MS = '4000';
  const cards = [];
  __setBookingGuardDepsForTest({
    resolveLead: async () => lead,
    readLive: async () => live,
    notify: notify || (async (args) => { cards.push(args); return { sent: true }; }),
    budgetMs: 1000,
  });
  try {
    const res = makeRes();
    await createAppointmentFromLpHandler({
      body: { contactId: 'c1', calendarId: 'aJj14ONxh1oFyDcQ706O', startTime, status: 'new' },
      query: {}, headers: { 'x-appt-booking-key': KEY },
    }, res);
    return { res, cards };
  } finally {
    __setBookingGuardDepsForTest(null);
    for (const [k, v] of [['APPT_BOOKING_ENDPOINT_KEY', prev.key], ['APPT_SLOT_CHECK_ENABLED', prev.gate], ['APPT_BOOKING_BUDGET_MS', prev.budget]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const lead = (disposition_code, extra = {}) => ({
  lp_lead_id: '583000', disposition_code, first_name: 'T', last_name: 'Lead',
  updated_at_lp: '2026-10-15T12:00:00+00:00', created_at_lp: '2026-10-14T12:00:00+00:00', ...extra,
});

function assertSkip(res, reason) {
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'noop_already_exists', 'an outcome I.LP-IN accepts, so GHL never books natively');
  assert.equal(res.body.appointmentId, null);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.booked, false);
  assert.equal(res.body.skipped, true);
  assert.equal(res.body.reason, reason);
}

test('Verif → 200 skip verif_hold, no appointment, no card', async () => {
  const { res, cards } = await call({ lead: lead('Verif') });
  assertSkip(res, 'verif_hold');
  assert.equal(cards.length, 0);
});

test('LP live wins over a stale row: row says Set, LP now says Verif → skip', async () => {
  const { res } = await call({ lead: lead('Set'), live: { ok: true, disposition: 'Verif', date: '2026-11-03', time: '10:00', timeStatus: 'known' } });
  assertSkip(res, 'verif_hold');
});

for (const code of ['ND', 'No Demo']) {
  test(`${code} → 200 skip disqualified`, async () => {
    const { res, cards } = await call({ lead: lead(code) });
    assertSkip(res, 'disqualified');
    assert.equal(cards.length, 0);
  });
}

test('year-typo date → 200 skip implausible_future_appointment + ONE LP-looks-wrong card', async () => {
  const old = lead('Set', { updated_at_lp: '2025-11-26T12:00:00+00:00', created_at_lp: '2025-11-20T12:00:00+00:00' });
  const { res, cards } = await call({ lead: old, startTime: '2026-11-30T10:00:00-05:00' });
  assertSkip(res, 'implausible_future_appointment');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].result.reason, 'implausible_future_appointment');
});

test('impossible hour (2 AM ET) → 200 skip impossible_hour + ONE card', async () => {
  const { res, cards } = await call({ lead: lead('Set'), startTime: '2026-11-03T02:00:00-05:00' });
  assertSkip(res, 'impossible_hour');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].result.appointment_hour_et, 2);
});

test('a real technical failure still answers `error` (GHL lookup unreachable here)', async () => {
  const { res } = await call({ lead: lead('Set') });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'error');
  assert.equal(res.body.skipped, undefined);
});

test('pure decision: no lead books as before; a clean Set/Cnf/Issue passes', () => {
  assert.deepEqual(decideBookingGuard({ lead: null, live: null, startTime: START }).skip, false);
  for (const code of ['Set', 'Cnf', 'Issue']) {
    assert.equal(decideBookingGuard({ lead: lead(code), live: null, startTime: START }).skip, false, code);
  }
});

test('ET hour reads offset and naive times; 19:00 is a real slot, 20:00 is not', () => {
  assert.equal(etHourOfRequest('2026-11-03T19:00:00-05:00'), 19);
  assert.equal(etHourOfRequest('2026-07-08 10:00:00'), 10);
  assert.equal(decideBookingGuard({ lead: lead('Set'), live: null, startTime: '2026-11-03T19:00:00-05:00' }).skip, false);
  assert.equal(decideBookingGuard({ lead: lead('Set'), live: null, startTime: '2026-11-03T20:00:00-05:00' }).reason, 'impossible_hour');
});

test('fail open: a slow or failing read books exactly as before the guard existed', async () => {
  const slow = await checkBookingGuards({
    contactId: 'c1', startTime: START,
    deps: { resolveLead: () => new Promise((r) => setTimeout(() => r(lead('Verif')), 200)), readLive: async () => null, budgetMs: 20 },
  });
  assert.deepEqual([slow.skip, slow.reason], [false, 'guard_timeout']);
  const broken = await checkBookingGuards({
    contactId: 'c1', startTime: START,
    deps: { resolveLead: async () => { throw new Error('db down'); }, readLive: async () => null, budgetMs: 500 },
  });
  assert.equal(broken.skip, false);
  assert.match(broken.reason, /^guard_error/);
});
