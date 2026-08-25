/**
 * Tests — one bad Five9 password must cost ONE failed login, not thirty-seven
 * scripts/test-five9-auth-breaker.js
 *
 * WHAT HAPPENED. Five9 locks the API account after repeated failed logins, and
 * every admin call carries HTTP Basic credentials — so a wrong password does
 * not fail once, it fails once PER CALL.
 *
 * On 2026-08-25 the account was locked. The amplifier was
 * jobs/five9-config-snapshot.js: one SOAP read per campaign plus profiles,
 * lists, skills, dispositions, users and VCC — ~37 sequential calls, each
 * wrapped in an attempt() that records the error and CONTINUES to the next.
 * One stale credential became ~37 failed logins inside a few seconds.
 *
 * The credential rejection arrives as a SOAP FAULT WITH HTTP 200, not a 401,
 * which is why the pre-existing 401 branch never saw it.
 *
 * These tests pin the two properties that matter:
 *   1. the first auth rejection trips the breaker
 *   2. every later call then fails WITHOUT touching the network
 *
 * and the property that keeps it from being a nuisance: a timeout, a 500 or an
 * oversize refusal must NOT disable the integration.
 *
 * No network — fetch is stubbed and the call count is the assertion.
 *
 * Run: node --test scripts/test-five9-auth-breaker.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  five9SoapCall, isFive9AuthFailure, five9AuthBreakerStatus, resetFive9AuthBreaker,
} from '../src/five9-admin.js';

/** The exact fault Five9 returned on 2026-08-25, verbatim. */
const LOCKED_FAULT =
  'The user name or password that you provided is incorrect, or the account is locked.'
  + ' If you feel that you received this message in error, contact your Five9 administrator'
  + ' (traceUid=f8939c88-68eb-4578-8bb0-bf3f9daea9ee)';

const soapFault = (msg) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => `<soapenv:Envelope><soapenv:Body><soapenv:Fault>`
    + `<faultstring>${msg}</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`,
});

/** Install a fetch double that counts calls. Returns the counter. */
function stubFetch(response) {
  const calls = { count: 0 };
  const real = globalThis.fetch;
  globalThis.fetch = async () => { calls.count += 1; return typeof response === 'function' ? response() : response; };
  calls.restore = () => { globalThis.fetch = real; };
  return calls;
}

/** Credentials must LOOK configured, or the call short-circuits before fetch. */
function withCredentials(fn) {
  const saved = { u: process.env.FIVE9_USERNAME, p: process.env.FIVE9_PASSWORD };
  process.env.FIVE9_USERNAME = 'svc-test';
  process.env.FIVE9_PASSWORD = 'not-a-real-password';
  return (async () => {
    try { return await fn(); } finally {
      if (saved.u === undefined) delete process.env.FIVE9_USERNAME; else process.env.FIVE9_USERNAME = saved.u;
      if (saved.p === undefined) delete process.env.FIVE9_PASSWORD; else process.env.FIVE9_PASSWORD = saved.p;
    }
  })();
}

// ─── recognising the rejection ──────────────────────────────────────────────

test('the live lockout fault is recognised as an auth failure', () => {
  assert.equal(isFive9AuthFailure(LOCKED_FAULT), true);
  assert.equal(isFive9AuthFailure('The user name or password that you provided is incorrect'), true);
  assert.equal(isFive9AuthFailure('Invalid login'), true);
});

test('ordinary faults are NOT auth failures — they must not disable Five9', () => {
  for (const msg of [
    'Execution Timeout Expired',
    'The number of rows provided for a FETCH clause must be greater then zero',
    'Internal server error',
    'campaign not found',
    '',
    null,
  ]) {
    assert.equal(isFive9AuthFailure(msg), false, `wrongly treated as auth failure: ${msg}`);
  }
});

// ─── the breaker ────────────────────────────────────────────────────────────

test('THE FIX: an auth fault trips the breaker, and call 2 never reaches the network', async () => {
  resetFive9AuthBreaker();
  const fetches = stubFetch(soapFault(LOCKED_FAULT));
  try {
    await withCredentials(async () => {
      // Call 1 — reaches Five9, is rejected, trips the breaker.
      await assert.rejects(() => five9SoapCall('getCampaigns'), /user name or password/);
      assert.equal(fetches.count, 1);
      assert.equal(five9AuthBreakerStatus().open, true);

      // Calls 2..37 — what the config snapshot would do next. NONE may reach
      // the network; that difference is the account staying unlocked.
      for (let i = 0; i < 36; i++) {
        await assert.rejects(() => five9SoapCall('getOutboundCampaign'), /auth breaker OPEN/);
      }
      assert.equal(fetches.count, 1, 'a full snapshot run must cost exactly ONE failed login');
    });
  } finally {
    fetches.restore();
    resetFive9AuthBreaker();
  }
});

test('a NON-auth fault does not trip it — the integration stays usable', async () => {
  resetFive9AuthBreaker();
  const fetches = stubFetch(soapFault('Execution Timeout Expired'));
  try {
    await withCredentials(async () => {
      await assert.rejects(() => five9SoapCall('getCampaigns'), /Execution Timeout/);
      assert.equal(five9AuthBreakerStatus().open, false, 'a timeout is not a credential problem');
      await assert.rejects(() => five9SoapCall('getCampaigns'), /Execution Timeout/);
      assert.equal(fetches.count, 2, 'both calls should still be attempted');
    });
  } finally {
    fetches.restore();
    resetFive9AuthBreaker();
  }
});

test('an HTTP 401 trips it too', async () => {
  resetFive9AuthBreaker();
  const fetches = stubFetch({
    ok: false, status: 401, headers: { get: () => null }, text: async () => 'Unauthorized',
  });
  try {
    await withCredentials(async () => {
      await assert.rejects(() => five9SoapCall('getCampaigns'), /HTTP 401/);
      assert.equal(five9AuthBreakerStatus().open, true);
      await assert.rejects(() => five9SoapCall('getCampaigns'), /auth breaker OPEN/);
      assert.equal(fetches.count, 1);
    });
  } finally {
    fetches.restore();
    resetFive9AuthBreaker();
  }
});

// ─── recovery ───────────────────────────────────────────────────────────────

test('the breaker does NOT auto-reset — only a fixed credential re-arms it', async () => {
  resetFive9AuthBreaker();
  const fetches = stubFetch(soapFault(LOCKED_FAULT));
  try {
    await withCredentials(async () => {
      await assert.rejects(() => five9SoapCall('getCampaigns'), /user name or password/);

      // A timer-based reset would re-arm the exact loop this exists to stop:
      // tomorrow's snapshot would spend another burst against a password that
      // has not changed. Recovery is deliberate, not automatic.
      const status = five9AuthBreakerStatus();
      assert.equal(status.open, true);
      assert.ok(status.since, 'the trip time must be visible to an operator');
      assert.match(status.reason, /user name or password/);

      assert.equal(resetFive9AuthBreaker().reset, true);
      assert.equal(five9AuthBreakerStatus().open, false);
    });
  } finally {
    fetches.restore();
    resetFive9AuthBreaker();
  }
});

test('resetting a closed breaker is a harmless no-op', () => {
  resetFive9AuthBreaker();
  assert.equal(resetFive9AuthBreaker().reset, false);
  assert.equal(five9AuthBreakerStatus().open, false);
});
