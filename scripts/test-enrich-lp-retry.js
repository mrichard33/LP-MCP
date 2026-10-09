/**
 * LP retry in /n8n/enrich-lead — scripts/test-enrich-lp-retry.js
 *
 * Locks in the 2026-10-07 fix in src/n8n-enrichment.js: lpPost called Lead
 * Perfection exactly once, so a momentary network blip ("fetch failed") made
 * the route return 500 and the contact was never enriched. Four contacts
 * failed that way within 3 seconds on 2026-10-06 at 8:08 pm ET.
 *
 * lpPost now retries a transient network error or a 502/503/504 twice, and
 * never a timeout (one 60s timeout already outlasts GHL's 60s webhook wait).
 *
 * NO REAL HTTP: fetchImpl is injected and delays are [0, 0].
 *
 * Run: node --test scripts/test-enrich-lp-retry.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from '../src/n8n-enrichment.js';

const { lpPost, isTransientNetworkError } = __testing;
const NO_WAIT = { delays: [0, 0] };

/** A fake fetch that plays `steps` in order; each step is an Error to throw or a status to answer. */
function scriptedFetch(steps) {
  const fake = async () => {
    const step = steps[fake.calls++];
    if (step instanceof Error) throw step;
    return { status: step, ok: step < 400, json: async () => ({ status: step }) };
  };
  fake.calls = 0;
  return fake;
}

const fetchFailed = () => new TypeError('fetch failed');

test('case 1: fetch failed twice, then success → returns JSON after 3 calls', async () => {
  const fetchImpl = scriptedFetch([fetchFailed(), fetchFailed(), 200]);
  const out = await lpPost('/api/Customers/GetLead', { cst_id: '1' }, 'tok', { fetchImpl, ...NO_WAIT });
  assert.deepEqual(out, { status: 200 });
  assert.equal(fetchImpl.calls, 3);
});

test('case 2: fetch failed three times → throws after 3 calls', async () => {
  const fetchImpl = scriptedFetch([fetchFailed(), fetchFailed(), fetchFailed()]);
  await assert.rejects(
    () => lpPost('/api/Customers/GetLead', {}, 'tok', { fetchImpl, ...NO_WAIT }),
    /fetch failed/,
  );
  assert.equal(fetchImpl.calls, 3);
});

test('case 3: a timeout is not retried → throws after 1 call', async () => {
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  const fetchImpl = scriptedFetch([timeout, 200]);
  await assert.rejects(
    () => lpPost('/api/Customers/GetLead', {}, 'tok', { fetchImpl, ...NO_WAIT }),
    (err) => err.name === 'TimeoutError',
  );
  assert.equal(fetchImpl.calls, 1);
});

test('case 4: 503 then 200 → returns JSON after 2 calls', async () => {
  const fetchImpl = scriptedFetch([503, 200]);
  const out = await lpPost('/api/Customers/GetLeadInfo', {}, 'tok', { fetchImpl, ...NO_WAIT });
  assert.deepEqual(out, { status: 200 });
  assert.equal(fetchImpl.calls, 2);
});

test('case 5: 400 is returned as-is after 1 call (not retried)', async () => {
  const fetchImpl = scriptedFetch([400, 200]);
  const out = await lpPost('/api/Customers/GetCustomers3', {}, 'tok', { fetchImpl, ...NO_WAIT });
  assert.deepEqual(out, { status: 400 });
  assert.equal(fetchImpl.calls, 1);
});

test('case 6: isTransientNetworkError tells a blip from everything else', () => {
  assert.equal(isTransientNetworkError(fetchFailed()), true);
  const reset = new TypeError('something else');
  reset.cause = { code: 'ECONNRESET' };
  assert.equal(isTransientNetworkError(reset), true);

  const timeout = new Error('timed out');
  timeout.name = 'TimeoutError';
  assert.equal(isTransientNetworkError(timeout), false);
  assert.equal(isTransientNetworkError(new SyntaxError('Unexpected token < in JSON')), false);
  assert.equal(isTransientNetworkError(null), false);
});

// ─── The LP login (/token) retries the same way ──────────────────
// A cold token cache puts this request in front of every LP call, so a blip
// here failed the enrichment just the same. Its delays are fixed (1s, 3s), so
// this case waits about one second.

test('case 7: the /token request retries a blip once and then succeeds', async () => {
  const { refreshToken, invalidateToken } = await import('../src/token-manager.js');
  const env = { LP_API_BASE_URL: 'https://lp.invalid', LP_USERNAME: 'u', LP_PASSWORD: 'p', LP_CLIENT_ID: '1', LP_APP_KEY: 'k' };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  const savedFetch = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(process.env, env);
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw fetchFailed();
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok-retry' }) };
    };
    invalidateToken();
    assert.equal(await refreshToken(), 'tok-retry');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = savedFetch;
    invalidateToken();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
