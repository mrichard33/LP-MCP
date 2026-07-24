/**
 * Tests — scripts/test-lp-addlead-proxy.js
 *
 * Covers the LP Addlead Validation Proxy (src/lp-addlead-proxy.js):
 *   1. hourFromLpAtime  — 12-hour → ET hour parser, fail-open nulls.
 *   2. planAddleadValidation — the full decision table.
 *   3. stripAppointmentKeys / dropControlKeys — key surgery, nothing else lost.
 *   4. Route behavior via a stubbed global fetch — passthrough fidelity across
 *      shadow / validate / passthrough modes, fail-open, LP-down 502, and
 *      claim-deduped cards (exactly one per lognumber+adate+reason).
 *
 * Harness pattern mirrors scripts/test-lp-ghl-appointment-sync.js: env is set
 * BEFORE the module import, and globalThis.fetch is stubbed BEFORE the dynamic
 * import so module-load reads are safe. Unlike that suite, this one needs a
 * LIVE supabase client + GroupMe bot so the claim/card path is exercised — the
 * stub intercepts both the PostgREST insert and the GroupMe POST and simulates
 * the unique-constraint (23505) that drives dedup.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Env set BEFORE import (all read at module load) ─────────────────────
process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.GROUPME_BOT_ID = 'test-bot';
process.env.LP_ADDLEAD_URL = 'http://lp.test/addlead';
process.env.LP_ADDLEAD_TIMEOUT_MS = '5000';
// LP_ADDLEAD_PROXY_MODE is read per-request via proxyMode(); set per test.

// ─── Mutable stub state ──────────────────────────────────────────────────
let lpCalls = [];             // [{ body }] each forward to LP
let cardCalls = [];           // [text] each GroupMe card sent
let sbNoticeKeys = new Set(); // simulates the notice_key PRIMARY KEY
let lpResponse = { status: 200, text: 'Inbound Lead Created: 371817', contentType: 'text/plain' };
let lpShouldThrow = false;

// Supabase PostgREST insert responses (shapes per postgrest-js 2.99 handling):
//   success → 2xx + empty body  → error null (Prefer: return=minimal branch)
//   dup     → 409 + {code:23505} → error.code '23505'
function sbOkRes() {
  return {
    status: 201, ok: true, statusText: 'Created',
    headers: { get: () => null },
    text: async () => '',
    json: async () => ({}),
  };
}
function sbConflictRes() {
  const body = JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint' });
  return {
    status: 409, ok: false, statusText: 'Conflict',
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}
// GroupMe bot POST — 202 Accepted, empty body.
function groupmeOkRes() {
  return { status: 202, ok: true, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
}
// LP legacy endpoint — raw bytes back, read via arrayBuffer().
function lpRes(status, text, contentType) {
  const buf = Buffer.from(text, 'utf8');
  return {
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes('/rest/v1/lp_sync_failure_notices')) {
    const parsed = opts.body ? JSON.parse(opts.body) : {};
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    const key = row && row.notice_key;
    if (sbNoticeKeys.has(key)) return sbConflictRes();
    sbNoticeKeys.add(key);
    return sbOkRes();
  }

  if (u.includes('api.groupme.com')) {
    const b = opts.body ? JSON.parse(opts.body) : {};
    cardCalls.push(b.text || '');
    return groupmeOkRes();
  }

  if (u.startsWith('http://lp.test')) {
    lpCalls.push(opts.body ? JSON.parse(opts.body) : null);
    if (lpShouldThrow) throw new Error('ECONNREFUSED');
    return lpRes(lpResponse.status, lpResponse.text, lpResponse.contentType);
  }

  throw new Error(`unexpected fetch: ${u}`);
};

// ─── Dynamic import AFTER stub + env are in place ────────────────────────
const {
  hourFromLpAtime,
  planAddleadValidation,
  stripAppointmentKeys,
  dropControlKeys,
  registerLpAddleadProxyRoutes,
} = await import('../src/lp-addlead-proxy.js');

// Register the route once against a fake app; capture the handler.
let routeHandler = null;
registerLpAddleadProxyRoutes({
  post: (path, handler) => {
    if (path === '/webhook/ghl/lp-addlead-proxy') routeHandler = handler;
  },
});

function reset() {
  lpCalls = [];
  cardCalls = [];
  sbNoticeKeys = new Set();
  lpResponse = { status: 200, text: 'Inbound Lead Created: 371817', contentType: 'text/plain' };
  lpShouldThrow = false;
}
function setMode(m) { process.env.LP_ADDLEAD_PROXY_MODE = m; }

// Minimal express res double.
function makeRes() {
  const r = { _status: null, _type: null, _body: null };
  r.status = (s) => { r._status = s; return r; };
  r.type = (t) => { r._type = t; return r; };
  r.send = (b) => { r._body = b; return r; };
  return r;
}
async function invoke(body) {
  const res = makeRes();
  await routeHandler({ body }, res);
  return res;
}

// A representative flat I.CC addlead body (every non-appointment key must survive).
const ICC_BODY = () => ({
  firstname: 'Jane', lastname: 'Doe', address1: '1 Main St', city: 'Tampa',
  state: 'FL', zip: '33601', phone1: '8135551234', email: 'jane@example.com',
  EmailOptIn: '1', srs_id: '123', pro_id: '456', lognumber: '371817',
  User1: 'canvasser', consent_sms: '1', sender: 'I.CC',
  adate: '2026-08-01', atime: '06:00 AM',
});

// ═══ 1. hourFromLpAtime ══════════════════════════════════════════════════

test('hourFromLpAtime: parses 12-hour ET wall-clock', () => {
  assert.equal(hourFromLpAtime('6:00 AM'), 6);
  assert.equal(hourFromLpAtime('06:30 AM'), 6);
  assert.equal(hourFromLpAtime('6:00 PM'), 18);
  assert.equal(hourFromLpAtime('12:00 AM'), 0);
  assert.equal(hourFromLpAtime('12:15 PM'), 12);
  assert.equal(hourFromLpAtime('7:59 PM'), 19);
});

test('hourFromLpAtime: null on anything not a clean 12-hour time', () => {
  assert.equal(hourFromLpAtime('19:00'), null);   // 24-hour, no meridiem
  assert.equal(hourFromLpAtime(''), null);
  assert.equal(hourFromLpAtime(null), null);
  assert.equal(hourFromLpAtime(undefined), null);
  assert.equal(hourFromLpAtime('garbage'), null);
  assert.equal(hourFromLpAtime('13:00 PM'), null); // hour out of 1..12
});

// ═══ 2. planAddleadValidation ════════════════════════════════════════════

test('plan: no adate/atime → forward no_appointment', () => {
  assert.deepEqual(planAddleadValidation({ firstname: 'X' }),
    { action: 'forward', reason: 'no_appointment', hour: null });
});

test('plan: impossible early hour → strip', () => {
  assert.deepEqual(planAddleadValidation({ adate: '2026-08-01', atime: '6:00 AM' }),
    { action: 'strip', reason: 'impossible_hour', hour: 6 });
});

test('plan: business-hours boundaries', () => {
  assert.deepEqual(planAddleadValidation({ adate: '2026-08-01', atime: '8:00 AM' }),
    { action: 'forward', reason: 'valid_hour', hour: 8 });   // 8 inclusive
  assert.deepEqual(planAddleadValidation({ adate: '2026-08-01', atime: '7:30 PM' }),
    { action: 'forward', reason: 'valid_hour', hour: 19 });
  assert.deepEqual(planAddleadValidation({ adate: '2026-08-01', atime: '8:00 PM' }),
    { action: 'strip', reason: 'impossible_hour', hour: 20 }); // 20 exclusive
});

test('plan: adate present + blank atime → strip blank_time', () => {
  assert.deepEqual(planAddleadValidation({ adate: '2026-08-01', atime: '' }),
    { action: 'strip', reason: 'blank_time', hour: null });
});

test('plan: unparseable atime → forward (fail open, never guess)', () => {
  assert.deepEqual(planAddleadValidation({ adate: '2026-08-01', atime: 'whenever' }),
    { action: 'forward', reason: 'unparseable_time', hour: null });
});

test('plan: dormant appt_id backstop only when key exists', () => {
  // Key present and blank while adate set → strip.
  assert.deepEqual(planAddleadValidation({ adate: '2026-08-01', atime: '10:00 AM', appt_id: '' }),
    { action: 'strip', reason: 'missing_appt_id', hour: null });
  // Key absent → no ID enforcement, hour decides normally.
  assert.deepEqual(planAddleadValidation({ adate: '2026-08-01', atime: '10:00 AM' }),
    { action: 'forward', reason: 'valid_hour', hour: 10 });
  // Key present and populated → no ID strip, hour decides.
  assert.deepEqual(planAddleadValidation({ adate: '2026-08-01', atime: '10:00 AM', appt_id: 'A1' }),
    { action: 'forward', reason: 'valid_hour', hour: 10 });
});

// ═══ 3. key surgery ══════════════════════════════════════════════════════

test('stripAppointmentKeys: removes exactly adate/atime/appt_id, keeps the rest', () => {
  const body = { ...ICC_BODY(), appt_id: 'A1' };
  const out = stripAppointmentKeys(body);
  assert.equal('adate' in out, false);
  assert.equal('atime' in out, false);
  assert.equal('appt_id' in out, false);
  // Every other verified I.CC key survives identical.
  for (const k of ['firstname', 'lastname', 'address1', 'city', 'state', 'zip',
    'phone1', 'email', 'EmailOptIn', 'srs_id', 'pro_id', 'lognumber', 'User1',
    'consent_sms', 'sender']) {
    assert.equal(out[k], body[k], `key ${k} must survive`);
  }
});

test('dropControlKeys: removes only appt_id, adate/atime survive', () => {
  const out = dropControlKeys({ ...ICC_BODY(), appt_id: 'A1' });
  assert.equal('appt_id' in out, false);
  assert.equal(out.adate, '2026-08-01');
  assert.equal(out.atime, '06:00 AM');
  assert.equal(out.firstname, 'Jane');
});

// ═══ 4. route behavior ═══════════════════════════════════════════════════

test('validate mode: impossible hour → LP gets body WITHOUT adate/atime, response mirrored', async () => {
  reset(); setMode('validate');
  lpResponse = { status: 200, text: 'Inbound Lead Created: 371817', contentType: 'text/plain' };
  const res = await invoke({ ...ICC_BODY(), atime: '6:00 AM' });

  assert.equal(lpCalls.length, 1);
  assert.equal('adate' in lpCalls[0], false, 'adate stripped before LP');
  assert.equal('atime' in lpCalls[0], false, 'atime stripped before LP');
  assert.equal(lpCalls[0].firstname, 'Jane', 'non-appointment keys forwarded');
  // Response fidelity: status, content-type, and raw bytes mirrored verbatim.
  assert.equal(res._status, 200);
  assert.equal(res._type, 'text/plain');
  assert.ok(Buffer.isBuffer(res._body));
  assert.equal(res._body.toString('utf8'), 'Inbound Lead Created: 371817');
  // The exact contract GHL's "Extract Inbound Lead ID" depends on:
  assert.equal(res._body.toString('utf8').split(': ')[1].trim(), '371817');
  assert.equal(cardCalls.length, 1, 'one strip card');
});

test('shadow mode: LP gets the ORIGINAL time (never stripped) and the card still fires', async () => {
  reset(); setMode('shadow');
  const res = await invoke({ ...ICC_BODY(), atime: '6:00 AM' });

  assert.equal(lpCalls.length, 1);
  assert.equal(lpCalls[0].adate, '2026-08-01', 'shadow forwards adate unchanged');
  assert.equal(lpCalls[0].atime, '6:00 AM', 'shadow forwards atime unchanged');
  assert.equal(res._status, 200);
  assert.equal(cardCalls.length, 1, 'shadow still flags');
  assert.match(cardCalls[0], /SHADOW MODE/, 'card marked as shadow');
});

test('valid hour: forwarded untouched, no card', async () => {
  reset(); setMode('validate');
  const res = await invoke({ ...ICC_BODY(), atime: '10:00 AM' });
  assert.equal(lpCalls.length, 1);
  assert.equal(lpCalls[0].adate, '2026-08-01');
  assert.equal(lpCalls[0].atime, '10:00 AM');
  assert.equal(cardCalls.length, 0);
  assert.equal(res._status, 200);
});

test('passthrough mode: no validation — original time forwarded, no card even on impossible hour', async () => {
  reset(); setMode('passthrough');
  const res = await invoke({ ...ICC_BODY(), atime: '3:00 AM' });
  assert.equal(lpCalls.length, 1);
  assert.equal(lpCalls[0].atime, '3:00 AM', 'passthrough never strips');
  assert.equal(cardCalls.length, 0, 'passthrough never cards');
  assert.equal(res._status, 200);
});

test('passthrough mode: appt_id control key still dropped before LP', async () => {
  reset(); setMode('passthrough');
  await invoke({ ...ICC_BODY(), atime: '10:00 AM', appt_id: 'A1' });
  assert.equal('appt_id' in lpCalls[0], false);
});

test('LP 500 → status and body mirrored back to GHL', async () => {
  reset(); setMode('validate');
  lpResponse = { status: 500, text: 'LP internal error', contentType: 'text/plain' };
  const res = await invoke({ ...ICC_BODY(), atime: '10:00 AM' });
  assert.equal(res._status, 500);
  assert.equal(res._body.toString('utf8'), 'LP internal error');
});

test('LP unreachable → 502 so GHL retry branches behave as when LP is down', async () => {
  reset(); setMode('validate');
  lpShouldThrow = true;
  const res = await invoke({ ...ICC_BODY(), atime: '10:00 AM' });
  assert.equal(res._status, 502);
  assert.equal(res._type, 'text/plain');
  assert.match(res._body, /LP forward failed/);
});

test('validation throw (poisoned body) → fail-open forward, no strip, no card', async () => {
  reset(); setMode('validate');
  // Enumerable adate (survives dropControlKeys spread) + a non-enumerable
  // atime getter that throws only when planAddleadValidation reads it.
  const poison = { firstname: 'Poison', lognumber: 'L9', adate: '2026-08-01' };
  Object.defineProperty(poison, 'atime', {
    enumerable: false,
    get() { throw new Error('poison-atime'); },
  });
  const res = await invoke(poison);
  assert.equal(lpCalls.length, 1, 'still forwarded to LP');
  assert.equal(lpCalls[0].adate, '2026-08-01', 'body forwarded untouched');
  assert.equal(cardCalls.length, 0, 'no card on fail-open');
  assert.equal(res._status, 200, 'LP response mirrored');
});

test('dedup: two identical strips (same lognumber+adate+reason) → exactly one card', async () => {
  reset(); setMode('validate');
  const bad = { ...ICC_BODY(), atime: '6:00 AM' }; // impossible_hour, lognumber 371817
  await invoke({ ...bad });
  await invoke({ ...bad });
  assert.equal(lpCalls.length, 2, 'both leads still reach LP');
  assert.equal(cardCalls.length, 1, 'second card suppressed by claim (23505)');
});
