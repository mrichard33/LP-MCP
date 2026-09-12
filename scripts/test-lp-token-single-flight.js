/**
 * Tests — one login request, not a stampede
 * scripts/test-lp-token-single-flight.js
 *
 * WHAT THIS PROTECTS. Every LP call routes through getToken()
 * (src/lp-client.js:102). With a cold or expired cache and no single-flight
 * guard, EVERY concurrent caller fired its own POST /token. The capacity lead
 * pass alone opens ~180 per-lead fetches, so each restart produced a ~180
 * request login stampede against Lead Perfection.
 *
 * WHAT IT ACTUALLY COST. Not the wasted requests — the queue behind them.
 * Observed in production on 2026-09-12: a single token request took 80 SECONDS
 * (16:30:04 -> 16:31:24) and three refreshes landed inside one second.
 * Meanwhile the capacity board's GetSalesSchedule, which must await a token
 * before it can issue its own request, burned its whole 60s budget waiting in
 * that queue and never reached the schedule endpoint — failing at exactly
 * 60000ms on every attempt with no LP-side error to show for it. The board read
 * DATA STALE for hours and it was diagnosed as vendor slowness. Lead
 * Perfection was serving other traffic fine throughout; the load was ours.
 *
 * THE SECOND HALF MATTERS AS MUCH. The token fetch had no timeout. Under
 * single-flight a hung login blocks every LP call in the process, so the bound
 * is load-bearing rather than garnish — case 6 pins it.
 *
 * NO REAL HTTP. globalThis.fetch is stubbed to count /token hits and to control
 * when each resolves. Env and fetch are restored in after().
 *
 * Run: node --test scripts/test-lp-token-single-flight.js
 */

import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

let getToken, refreshToken, invalidateToken, getTokenStatus;
const savedEnv = {};

const ENV = {
  LP_API_BASE_URL: 'https://lp.invalid',
  LP_USERNAME: 'u', LP_PASSWORD: 'p', LP_CLIENT_ID: '1', LP_APP_KEY: 'k',
  LP_TOKEN_TIMEOUT_MS: '1000', // short, so case 6 stays fast
  SUPABASE_URL: 'https://supabase.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test',
};

let tokenCalls = 0;
let nextToken = 0;
/** Resolver for the pending /token response, so tests control the timing. */
let pending = null;

function stubFetch({ mode = 'immediate' } = {}) {
  globalThis.fetch = async (url, opts) => {
    if (!String(url).endsWith('/token')) throw new Error(`unexpected fetch: ${url}`);
    tokenCalls++;
    if (mode === 'hang') {
      // Never resolves on its own — only the abort signal ends it, which is
      // exactly the production hazard being pinned.
      return await new Promise((_, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'TimeoutError';
          reject(e);
        });
      });
    }
    if (mode === 'deferred') {
      await new Promise((r) => { pending = r; });
    }
    return { ok: true, json: async () => ({ access_token: `tok-${++nextToken}` }) };
  };
}

before(async () => {
  for (const [k, v] of Object.entries(ENV)) { savedEnv[k] = process.env[k]; process.env[k] = v; }
  ({ getToken, refreshToken, invalidateToken, getTokenStatus } = await import('../src/token-manager.js'));
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

beforeEach(() => {
  tokenCalls = 0;
  pending = null;
  invalidateToken();
  stubFetch();
});

/**
 * AbortSignal.timeout()'s internal timer is UNREF'D, so it does not hold the
 * event loop open. A long-running server always has other work pending, so
 * this is invisible in production — but in a short test process the loop can
 * settle before the abort ever fires, and the test reports as cancelled rather
 * than failed. A ref'd timer for the duration keeps the loop alive.
 * Do NOT "fix" this by removing the keepalive; the cancel is the symptom.
 */
async function withKeepAlive(fn, ms = 4000) {
  const keep = setTimeout(() => {}, ms);
  try {
    return await fn();
  } finally {
    clearTimeout(keep);
  }
}

test('case 1: a cold cache costs exactly one login request', async () => {
  const tok = await getToken();
  assert.match(tok, /^tok-/);
  assert.equal(tokenCalls, 1);
});

test('case 2: a warm cache costs none', async () => {
  await getToken();
  tokenCalls = 0;
  for (let i = 0; i < 50; i++) await getToken();
  assert.equal(tokenCalls, 0, 'a cached token must not re-login');
});

test('case 3: THE REGRESSION — 180 concurrent cold callers make ONE login request', async () => {
  // 180 is the real number: the capacity lead pass's near-window refresh.
  stubFetch({ mode: 'deferred' });
  const inflight = Array.from({ length: 180 }, () => getToken());

  // Let the callers pile up before the response lands.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tokenCalls, 1, `${tokenCalls} login requests for one cold cache — this is the stampede`);
  assert.equal(getTokenStatus().refreshInFlight, true);

  pending();
  const tokens = await Promise.all(inflight);
  assert.equal(tokenCalls, 1);
  // And they all get the SAME token, not 180 different ones.
  assert.equal(new Set(tokens).size, 1, 'callers received different tokens from one refresh');
});

test('case 4: direct refreshToken callers join the same flight', async () => {
  // lp-client.js's 401 retry calls refreshToken() directly, and concurrent
  // calls all get 401 together — the hardest-stampeding path of the lot.
  stubFetch({ mode: 'deferred' });
  const inflight = Array.from({ length: 25 }, () => refreshToken());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tokenCalls, 1);
  pending();
  const tokens = await Promise.all(inflight);
  assert.equal(new Set(tokens).size, 1);
});

test('case 5: the flight clears on settle, so a later refresh still works', async () => {
  await getToken();
  assert.equal(getTokenStatus().refreshInFlight, false, 'a settled refresh must not stay pinned');
  invalidateToken();
  tokenCalls = 0;
  await getToken();
  assert.equal(tokenCalls, 1, 'the guard wedged shut and blocked a legitimate later refresh');
});

test('case 6: a hung login times out rather than wedging every LP call', async () => {
  stubFetch({ mode: 'hang' });
  await withKeepAlive(async () => {
    const started = Date.now();
    await assert.rejects(() => getToken(), (err) => {
      assert.match(err.message, /timed out after 1000ms/);
      return true;
    });
    assert.ok(Date.now() - started < 5000, 'did not give up anywhere near the configured bound');
  });
});

test('case 7: a failed login does not poison later attempts', async () => {
  // The rejected promise must not stay pinned as the shared flight, or every
  // subsequent caller inherits the same failure forever.
  stubFetch({ mode: 'hang' });
  await withKeepAlive(() => assert.rejects(() => getToken()));
  assert.equal(getTokenStatus().refreshInFlight, false);

  stubFetch(); // LP recovers
  tokenCalls = 0;
  const tok = await getToken();
  assert.match(tok, /^tok-/);
  assert.equal(tokenCalls, 1);
});

test('case 8: concurrent callers all see one failure, not one each', async () => {
  stubFetch({ mode: 'hang' });
  const results = await withKeepAlive(() =>
    Promise.allSettled(Array.from({ length: 20 }, () => getToken())));
  assert.ok(results.every((r) => r.status === 'rejected'));
  assert.equal(tokenCalls, 1, 'a failing LP got hammered 20 times instead of once');
});

test('case 9: an HTTP error still surfaces with its status', async () => {
  globalThis.fetch = async () => {
    tokenCalls++;
    return { ok: false, status: 401, text: async () => 'bad creds' };
  };
  await assert.rejects(() => getToken(), /HTTP 401/);
});

test('case 10: status reports the timeout bound for diagnosis', async () => {
  const s = getTokenStatus();
  assert.equal(s.tokenTimeoutMs, 1000);
  assert.equal(typeof s.refreshInFlight, 'boolean');
  assert.equal(typeof s.noteRefreshInFlight, 'boolean');
});
