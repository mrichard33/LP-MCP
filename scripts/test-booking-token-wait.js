/**
 * Booking-path rate-limiter budget — scripts/test-booking-token-wait.js
 *
 * Covers the 2026-08-16 fix: executeBookAppointment caps the rate-limiter
 * queue wait on the GHL calls it owns, so a 429-paused bucket cannot stack
 * 30s waits past the executor's 60s handler watchdog.
 *
 * WHY THIS EXISTS. Observed live 2026-08-16: a single GHL 429 at 00:10:36 put
 * the token bucket into its 5-minute pause. Every acquireToken then waited the
 * full 30s default before failing open. A test booking spent ~54s just
 * reaching its POST and the executor killed the handler at 60s — so the
 * booking was reported as timed-out even though nothing was wrong with it.
 *
 * The limiter FAILS OPEN at the cap, so a shorter wait never drops a call.
 * The cap only decides how long a booking is willing to queue.
 *
 * WHAT IS AND IS NOT ASSERTED. ESM namespace objects are frozen, so the
 * limiter's acquireToken cannot be swapped out without node:test module
 * mocking — and `npm test` runs `node --test scripts/test-*.js` with no flags,
 * so mock.module (which needs --experimental-test-module-mocks) would break the
 * repo's own test command. These tests therefore assert the two things that are
 * observable without it: that the new rateOpts argument is threaded through
 * without altering any request, and that the budget expression is parsed
 * safely. That the three booking-path call sites actually pass the cap is
 * verified by reading the diff, not by this suite.
 *
 * Run: node --test scripts/test-booking-token-wait.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.TZ = 'UTC';
process.env.GHL_API_KEY = 'test-key';
process.env.BOOKING_TOKEN_WAIT_MS = '8000';
process.env.GROUPME_BOT_ID = '';   // keep escalation cards out of this suite

// ─── fetch stub ──────────────────────────────────────────────────────
let calls = [];
let contactRecord = null;

function jsonRes(body) {
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  const raw = String(url);
  const path = raw.replace('https://services.leadconnectorhq.com', '');
  calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null });

  if (raw.startsWith('https://api.groupme.com')) return jsonRes({});
  if (method === 'GET' && /^\/contacts\/[^/?]+\/appointments/.test(path)) return jsonRes({ events: [] });
  if (method === 'GET' && /^\/calendars\/events\/appointments\/[^/?]+$/.test(path)) {
    return jsonRes({ appointment: { id: path.split('/').pop(), appointmentStatus: 'new' } });
  }
  if (method === 'POST' && path === '/calendars/events/appointments') return jsonRes({ id: 'appt-1' });
  if (method === 'GET' && /^\/contacts\/[^/?]+$/.test(path)) return jsonRes({ contact: contactRecord });
  return jsonRes({});
};

const { ghlFetch } = await import('../src/actions/helpers.js');
const { getContactCached } = await import('../src/actions/contact-cache.js');

// ═══ 1. ghlFetch forwards the cap, and defaults unchanged ═════════════

test('(1) ghlFetch accepts a 4th rateOpts arg without changing existing behaviour', async () => {
  calls = [];
  await ghlFetch('GET', '/contacts/abc');
  await ghlFetch('GET', '/contacts/abc', null, { maxWaitMs: 8000 });
  // Both calls reach GHL identically — the cap is a queueing concern only and
  // must never alter the request itself.
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], calls[1]);
});

test('(1b) a body still serialises correctly with rateOpts present', async () => {
  calls = [];
  await ghlFetch('POST', '/calendars/events/appointments', { a: 1 }, { maxWaitMs: 8000 });
  assert.deepEqual(calls[0].body, { a: 1 });
  assert.equal(calls[0].method, 'POST');
});

// ═══ 2. getContactCached threads the cap, cache still short-circuits ══

test('(2) getContactCached passes maxWaitMs through and still caches', async () => {
  calls = [];
  contactRecord = { id: 'c1', firstName: 'Maria', tags: [], customFields: [] };
  const cache = new Map();
  const a = await getContactCached('c1', cache, { maxWaitMs: 8000 });
  const b = await getContactCached('c1', cache, { maxWaitMs: 8000 });
  assert.equal(a.firstName, 'Maria');
  assert.equal(b.firstName, 'Maria');
  // Second read is a cache hit — one GHL call total, and a cache hit never
  // queues for a token at all.
  assert.equal(calls.filter((c) => c.path === '/contacts/c1').length, 1);
});

test('(2b) getContactCached without maxWaitMs behaves exactly as before', async () => {
  calls = [];
  contactRecord = { id: 'c2', firstName: 'Maria', tags: [], customFields: [] };
  const got = await getContactCached('c2', new Map());
  assert.equal(got.firstName, 'Maria');
  assert.equal(calls.filter((c) => c.path === '/contacts/c2').length, 1);
});

// ═══ 3. The constant is env-tunable with a sane floor ════════════════

test('(3) BOOKING_TOKEN_WAIT_MS is env-tunable and floored at 1000ms', async () => {
  // Mirrors the expression in appointments.js. Pinning it here documents the
  // contract: an operator can shorten or lengthen the budget, but cannot set
  // it low enough to defeat queueing entirely, and cannot silently disable it
  // with a typo.
  //
  // The naive form `Math.max(1000, parseInt(v || '8000', 10))` is WRONG:
  // Math.max(1000, NaN) is NaN, and acquireToken treats a non-finite maxWaitMs
  // as absent — reverting to the 30s default this constant exists to avoid.
  const compute = (v) => {
    const parsed = parseInt(v ?? '', 10);
    return Number.isFinite(parsed) ? Math.max(1000, parsed) : 8000;
  };
  assert.equal(compute(undefined), 8000);
  assert.equal(compute('12000'), 12000);
  assert.equal(compute('50'), 1000, 'floor prevents a pathological 0ms budget');
  assert.equal(compute('not-a-number'), 8000, 'a typo falls back to the default, never NaN');
  assert.ok(Number.isFinite(compute('not-a-number')), 'must never yield NaN');
  assert.ok(Number.isNaN(Math.max(1000, parseInt('oops', 10))), 'the naive form really does yield NaN');
});

// ═══ 4. The booking path books normally with the cap in place ════════

test('(4) a booking still succeeds end-to-end with the cap applied', async () => {
  calls = [];
  contactRecord = {
    id: 'gUihunGyOa6SiGbJCJ3K', firstName: 'Maria', lastName: '',
    phone: '+18135551234', address1: '3311 Foxridge Cir', postalCode: '33618',
    tags: [], customFields: [],
  };
  const { executeBookAppointment } = await import('../src/actions/handlers/appointments.js');
  const r = await executeBookAppointment({
    target_id: 'gUihunGyOa6SiGbJCJ3K',
    action_payload: {
      calendar_name: 'Window Estimate',
      start_time: '2026-08-19T19:00:00+00:00',
      qualifying_data: { decision_makers_present: 'Yes' },
      status: 'confirmed',
      title: 'Window Estimate - Maria Laing',
    },
  }, {});

  assert.equal(r.action, 'appointment_booked');
  assert.equal(r.status, 'new', 'the status fix still holds under the cap');
  // The read-back still ran and still verified.
  assert.equal(
    calls.filter((c) => c.method === 'GET' && /^\/calendars\/events\/appointments\//.test(c.path)).length,
    1,
  );
  // And the title is still rebuilt from the contact record, not the payload.
  const post = calls.find((c) => c.method === 'POST' && c.path === '/calendars/events/appointments');
  assert.equal(post.body.title, 'Window Estimate - Maria');
  assert.doesNotMatch(post.body.title, /Laing/);
});
