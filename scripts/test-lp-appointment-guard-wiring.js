/**
 * LP SetAppointment refusal guard — wiring tests
 * scripts/test-lp-appointment-guard-wiring.js
 *
 * src/lp-appointment-guards.js was written on 2026-08-27 to stop LP's silent
 * refusals being recorded as successes, and shipped UNWIRED. Nothing in src/
 * imported it, so lp-client.setAppointment kept checking only `result.error` —
 * which LP never populates. A refusal (HTTP 200, { Result: 1, Message: "market
 * is OOA.  " }) therefore read as success, the caller wrote its dedup mark and
 * applied `lp-appt-synced`, and the contact was self-locked for 24h against an
 * appointment LP had refused. Incident 2026-08-26, contact q5GehRye7DNkN6jlmjl3.
 *
 * These tests pin the wiring and, just as importantly, pin that SHADOW MODE IS
 * THE DEFAULT — the refusal markers match broad substrings ('invalid',
 * 'cannot', 'error'), and no real SetAppointment reply was observable in 30h of
 * production logs to validate them against.
 *
 * Style B (globalThis.fetch stub), as in test-ghl-tag-fastack.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LP_API_BASE_URL = 'https://lp.stub.local';
process.env.LP_USERNAME = 'u';
process.env.LP_PASSWORD = 'p';
process.env.LP_CLIENT_ID = 'c';
process.env.LP_APP_KEY = 'k';

/** The next SetAppointment body the stubbed LP returns. */
let lpReply = { Result: 1, Message: 'OK' };
let setAppointmentCalls = 0;

function jsonRes(body, status = 200) {
  return {
    status,
    ok: status < 400,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith('/token')) {
    return jsonRes({ access_token: 'stub-token', expires_in: 3600 });
  }
  if (u.includes('SetAppointment')) {
    setAppointmentCalls++;
    return jsonRes(lpReply);
  }
  return jsonRes({});
};

const { setAppointment } = await import('../src/lp-client.js');

const ARGS = { ldsId: '575580', apptDate: '09/15/2026', apptTime: '10:00' };
const OOA = { Result: 1, Message: 'market is OOA.  ' };

function reset(mode) {
  setAppointmentCalls = 0;
  lpReply = { Result: 1, Message: 'OK' };
  if (mode === undefined) delete process.env.LP_APPT_GUARD_MODE;
  else process.env.LP_APPT_GUARD_MODE = mode;
}

// ════════════════════════════════════════════════════════════════════
// The defect
// ════════════════════════════════════════════════════════════════════

test('enforce: a Result:1 "market is OOA" refusal THROWS instead of reading as success', async () => {
  reset('enforce');
  lpReply = OOA;

  await assert.rejects(
    () => setAppointment(ARGS),
    (err) => {
      assert.equal(err.code, 'LP_APPT_REFUSED', 'must carry the typed code');
      assert.equal(err.reason, 'lp_market_out_of_area');
      assert.match(err.message, /REFUSED/);
      assert.match(err.message, /575580/, 'names the lead');
      return true;
    },
    'a refusal must not resolve — resolving is what wrote the 24h self-lock',
  );
  assert.equal(setAppointmentCalls, 1);
});

test('enforce: an explicit Result:0 also throws', async () => {
  reset('enforce');
  lpReply = { Result: 0, Message: 'no such lead' };
  await assert.rejects(() => setAppointment(ARGS), (e) => e.code === 'LP_APPT_REFUSED');
});

// ════════════════════════════════════════════════════════════════════
// Shadow is the default, and shadow must not change behaviour
// ════════════════════════════════════════════════════════════════════

test('shadow is the DEFAULT and a refusal still resolves', async () => {
  reset(undefined); // env var absent entirely
  lpReply = OOA;

  const result = await setAppointment(ARGS);
  assert.deepEqual(result, OOA, 'shadow must return LP’s reply untouched');
  assert.equal(setAppointmentCalls, 1);
});

test('shadow: explicitly set, same non-throwing behaviour', async () => {
  reset('shadow');
  lpReply = OOA;
  const result = await setAppointment(ARGS);
  assert.deepEqual(result, OOA);
});

test('off: the guard can be disabled entirely', async () => {
  reset('off');
  lpReply = OOA;
  const result = await setAppointment(ARGS);
  assert.deepEqual(result, OOA);
});

// ════════════════════════════════════════════════════════════════════
// The risk this guard introduces: refusing a genuine success
// ════════════════════════════════════════════════════════════════════

test('a genuine success passes cleanly in BOTH modes', async () => {
  for (const mode of ['shadow', 'enforce']) {
    reset(mode);
    lpReply = { Result: 1, Message: 'OK' };
    const result = await setAppointment(ARGS);
    assert.deepEqual(result, { Result: 1, Message: 'OK' }, `${mode}: success must pass through`);
  }

  // A bare Result:1 with no Message is the other shape LP uses.
  for (const mode of ['shadow', 'enforce']) {
    reset(mode);
    lpReply = { Result: 1 };
    const result = await setAppointment(ARGS);
    assert.deepEqual(result, { Result: 1 }, `${mode}: bare Result:1 must pass through`);
  }
});

test('the pre-existing result.error contract is unchanged', async () => {
  reset('shadow');
  lpReply = { error: 'boom', message: 'detail' };
  await assert.rejects(() => setAppointment(ARGS), /LP SetAppointment error: boom/);
});
