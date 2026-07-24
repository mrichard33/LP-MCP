/**
 * Tests — scripts/test-canvassing-intake.js
 *
 * Covers the Canvassing Intake endpoint (src/canvassing-intake.js), the
 * deterministic replacement for I.CC steps 3–19 and 21–27:
 *   1. normalizePreferredTime — the DST regression table that kills the
 *      "minus 4 hours" LLM node (winter EST, midnight date-rollover, naive
 *      vs Z vs offset ISO, ET wall-clock pass-through, unparseable).
 *   2. planIntakeTime — forward / strip(impossible_hour) / omit(unparseable).
 *   3. buildCanvassingNotes — byte-exact 7-line block; blanks stay empty.
 *   4. formatPhoneNational / buildAddleadBody — key set + appt-key gating.
 *   5. extractInboundLeadId integration — "lead added: N" → N.
 *   6. writebacks — injected-deps unit test: the three verified field IDs on
 *      forward, the hour-invalid tag on strip, SalesRabbit skip paths.
 *   7. getSalesRabbitUserId — GET .data.userId, fail-open nulls.
 *   8. Route — shadow (0 LP sends / 0 GHL writes), live forward/strip/omit,
 *      LP-500 → 502, and claim-deduped cards (exactly one per key).
 *
 * Harness mirrors scripts/test-lp-addlead-proxy.js: env set BEFORE the
 * dynamic import, globalThis.fetch stubbed BEFORE import. A LIVE supabase
 * client + GroupMe bot are configured so the claim/card path runs; the stub
 * intercepts the PostgREST insert and simulates the 23505 unique violation.
 * GHL_API_KEY is deliberately UNSET so the route's fire-and-forget writeback
 * tail is inert (ghlClient null → early return, no network).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Env set BEFORE import ───────────────────────────────────────────────
process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.GROUPME_BOT_ID = 'test-bot';
process.env.LP_ADDLEAD_URL = 'http://lp.test/addlead';
delete process.env.GHL_API_KEY;               // keep the writeback tail inert
delete process.env.CANVASSING_INTAKE_MODE;    // set per test via setMode()

// ─── Mutable stub state ──────────────────────────────────────────────────
let lpCalls = [];             // parsed addlead bodies forwarded to LP
let cardCalls = [];           // GroupMe card texts
let sbNoticeKeys = new Set(); // simulates the notice_key PRIMARY KEY
let lpResponse = { ok: true, status: 200, text: 'lead added: 409976' };
let lpShouldThrow = false;

function sbOkRes() {
  return { status: 201, ok: true, statusText: 'Created', headers: { get: () => null }, text: async () => '', json: async () => ({}) };
}
function sbConflictRes() {
  const body = JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint' });
  return { status: 409, ok: false, statusText: 'Conflict', headers: { get: () => null }, text: async () => body, json: async () => JSON.parse(body) };
}
function groupmeOkRes() {
  return { status: 202, ok: true, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
}
function lpRes() {
  return { ok: lpResponse.ok, status: lpResponse.status, headers: { get: () => 'text/plain' }, text: async () => lpResponse.text };
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
    return lpRes();
  }

  throw new Error(`unexpected fetch: ${u}`);
};

// ─── Dynamic import AFTER stub + env are in place ────────────────────────
const {
  normalizePreferredTime,
  planIntakeTime,
  buildCanvassingNotes,
  formatPhoneNational,
  buildAddleadBody,
  writebacks,
  registerCanvassingIntakeRoutes,
} = await import('../src/canvassing-intake.js');
const { getSalesRabbitUserId } = await import('../src/salesrabbit.js');

// Capture the route handler against a fake app.
let routeHandler = null;
registerCanvassingIntakeRoutes({
  post: (path, handler) => {
    if (path === '/webhook/ghl/canvassing-intake') routeHandler = handler;
  },
});

function reset() {
  lpCalls = [];
  cardCalls = [];
  sbNoticeKeys = new Set();
  lpResponse = { ok: true, status: 200, text: 'lead added: 409976' };
  lpShouldThrow = false;
}
function setMode(m) { process.env.CANVASSING_INTAKE_MODE = m; }

function makeRes() {
  const r = { _status: 200, _json: null };
  r.status = (s) => { r._status = s; return r; };
  r.json = (b) => { r._json = b; return r; };
  return r;
}
async function invoke(body) {
  const res = makeRes();
  await routeHandler({ body }, res);
  return res;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. normalizePreferredTime — the DST regression table
// ═══════════════════════════════════════════════════════════════════════

test('normalizePreferredTime: ET wall clock passes through untouched', () => {
  const a = normalizePreferredTime('07/24/2026 06:00 AM');
  assert.deepEqual(a, { adate: '07/24/2026', atime: '6:00 AM', hour: 6, sourceFormat: 'et_wall_clock' });

  const b = normalizePreferredTime('05/26/2026 02:00 PM');
  assert.deepEqual(b, { adate: '05/26/2026', atime: '2:00 PM', hour: 14, sourceFormat: 'et_wall_clock' });
});

test('normalizePreferredTime: summer UTC instant → EDT', () => {
  const r = normalizePreferredTime('2026-07-24T22:00:00Z');
  assert.equal(r.adate, '07/24/2026');
  assert.equal(r.atime, '6:00 PM');
  assert.equal(r.hour, 18);
  assert.equal(r.sourceFormat, 'iso_instant');
});

test('normalizePreferredTime: WINTER UTC instant → EST (the -4h bug)', () => {
  // The case the hardcoded "minus 4 hours" node got wrong every Nov–Mar.
  const r = normalizePreferredTime('2026-01-15T22:00:00Z');
  assert.equal(r.adate, '01/15/2026');
  assert.equal(r.atime, '5:00 PM');
  assert.equal(r.hour, 17);
});

test('normalizePreferredTime: midnight UTC rolls the DATE back correctly', () => {
  // The "00:00:00 → 20:00:00" example — now with the right (previous) day.
  const r = normalizePreferredTime('2026-07-25T00:00:00Z');
  assert.equal(r.adate, '07/24/2026');
  assert.equal(r.atime, '8:00 PM');
  assert.equal(r.hour, 20);
});

test('normalizePreferredTime: naive (space) form is treated as UTC → EST', () => {
  const r = normalizePreferredTime('2026-01-15 14:30');
  assert.equal(r.adate, '01/15/2026');
  assert.equal(r.atime, '9:30 AM');
  assert.equal(r.hour, 9);
});

test('normalizePreferredTime: explicit offset is respected', () => {
  // Pacific 3:00 PM (-07:00) == 22:00Z == 6:00 PM ET. (An unambiguous offset:
  // -04:00 IS Eastern in July, so a -04:00 label would just echo ET.)
  const r = normalizePreferredTime('2026-07-24T15:00:00-07:00');
  assert.equal(r.adate, '07/24/2026');
  assert.equal(r.atime, '6:00 PM');
  assert.equal(r.hour, 18);
});

test('normalizePreferredTime: unparseable never guesses a time', () => {
  for (const v of ['whenever works', '', '   ', null, undefined]) {
    const r = normalizePreferredTime(v);
    assert.equal(r.unparseable, true, `expected unparseable for ${JSON.stringify(v)}`);
    assert.equal(r.adate, undefined);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 2. planIntakeTime
// ═══════════════════════════════════════════════════════════════════════

test('planIntakeTime: business-hour gate (8 inclusive .. 20 exclusive)', () => {
  assert.deepEqual(planIntakeTime({ hour: 6 }), { action: 'strip', reason: 'impossible_hour', hour: 6 });
  assert.deepEqual(planIntakeTime({ hour: 8 }), { action: 'forward', reason: 'valid_hour', hour: 8 });
  assert.deepEqual(planIntakeTime({ hour: 19 }), { action: 'forward', reason: 'valid_hour', hour: 19 });
  assert.deepEqual(planIntakeTime({ hour: 20 }), { action: 'strip', reason: 'impossible_hour', hour: 20 });
  assert.deepEqual(planIntakeTime({ unparseable: true }), { action: 'omit', reason: 'unparseable_time', hour: null });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. buildCanvassingNotes
// ═══════════════════════════════════════════════════════════════════════

test('buildCanvassingNotes: byte-exact 7-line block', () => {
  const b = {
    property_type: 'Single Family', window_count: '12', door_count: '2',
    slider_count: '1', form_notes: 'Back door sticks', promoter: 'Jane Doe',
  };
  const out = buildCanvassingNotes(b, '07/24/2026 2:00 PM');
  assert.equal(out,
    'Property Type: Single Family\n' +
    'Window Count: 12\n' +
    'Door Count: 2\n' +
    'Slider Count: 1\n' +
    'Preferred Estimate Time: 07/24/2026 2:00 PM\n' +
    'Notes: Back door sticks\n' +
    'Promoter: Jane Doe');
});

test('buildCanvassingNotes: blank fields render empty, never "undefined"', () => {
  const out = buildCanvassingNotes({}, '');
  assert.equal(out,
    'Property Type: \nWindow Count: \nDoor Count: \nSlider Count: \n' +
    'Preferred Estimate Time: \nNotes: \nPromoter: ');
  assert.ok(!/undefined/.test(out));
});

// ═══════════════════════════════════════════════════════════════════════
// 4. formatPhoneNational + buildAddleadBody
// ═══════════════════════════════════════════════════════════════════════

test('formatPhoneNational: strips symbols, keeps last 10', () => {
  assert.equal(formatPhoneNational('(954) 508-1512'), '9545081512');
  assert.equal(formatPhoneNational('+1 954 508 1512'), '9545081512');
  assert.equal(formatPhoneNational('508-1512'), '5081512');
});

const SAMPLE_BODY = {
  contact_id: 'CT123', first_name: 'Mark', last_name: 'Test',
  address1: '1 Main St', city: 'Boca', state: 'FL', postal_code: '33432',
  phone_raw: '(954) 508-1512', email: 'm@t.co', pro_id: '88',
  date_created: '2026-07-24T10:00:00Z',
  utm_medium: 'field', utm_campaign: 'Jane', utm_content: 'c', utm_term: '33432',
};

test('buildAddleadBody: full non-appointment key set + srs_id + phone', () => {
  const body = buildAddleadBody(SAMPLE_BODY, 'NOTES', { action: 'forward' },
    { adate: '07/24/2026', atime: '2:00 PM' });
  const baseKeys = [
    'firstname', 'lastname', 'address1', 'city', 'state', 'zip', 'phone1', 'email',
    'sender', 'srs_id', 'pro_id', 'productid', 'proddescr', 'notes', 'lognumber',
    'User1', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
    'HasConsent', 'ConsentDate', 'TextOptIn', 'EmailOptIn',
  ];
  for (const k of baseKeys) assert.ok(k in body, `missing key ${k}`);
  assert.equal(body.srs_id, '344');
  assert.equal(body.sender, 'GHL-Canvassing');
  assert.equal(body.phone1, '9545081512');
  assert.equal(body.zip, '33432');
  assert.equal(body.lognumber, 'CT123');
  assert.equal(body.User1, 'CT123');
  assert.equal(body.utm_source, 'canvassing');   // default when unset
  assert.equal(body.notes, 'NOTES');
});

test('buildAddleadBody: appt keys ONLY on forward', () => {
  const fwd = buildAddleadBody(SAMPLE_BODY, 'N', { action: 'forward' },
    { adate: '07/24/2026', atime: '2:00 PM' });
  assert.equal(fwd.adate, '07/24/2026');
  assert.equal(fwd.atime, '2:00 PM');

  for (const action of ['strip', 'omit']) {
    const body = buildAddleadBody(SAMPLE_BODY, 'N', { action }, { adate: '07/24/2026', atime: '6:00 AM' });
    assert.ok(!('adate' in body), `${action}: adate must be absent`);
    assert.ok(!('atime' in body), `${action}: atime must be absent`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 5. extractInboundLeadId integration (reused from lp-client)
// ═══════════════════════════════════════════════════════════════════════

test('extractInboundLeadId parses the LP "lead added: N" text', async () => {
  const { extractInboundLeadId } = await import('../src/lp-client.js');
  assert.equal(extractInboundLeadId({ message: 'lead added: 409976' }), '409976');
  assert.equal(extractInboundLeadId({ message: 'Inbound Lead Created: 371817' }), '371817');
  assert.equal(extractInboundLeadId({ message: 'no digits here' }), null);
});

// ═══════════════════════════════════════════════════════════════════════
// 6. writebacks — injected deps, no network
// ═══════════════════════════════════════════════════════════════════════

function captureDeps(srUserId = null) {
  const calls = { updateFields: [], tags: [], notes: [], srLookups: [] };
  return {
    calls,
    deps: {
      updateFields: async (id, fields) => { calls.updateFields.push({ id, fields }); return true; },
      applyTag: async (id, tag) => { calls.tags.push({ id, tag }); return true; },
      addNote: async (id, body) => { calls.notes.push({ id, body }); return { success: true }; },
      getSrUserId: async (srId) => { calls.srLookups.push(srId); return srUserId; },
    },
  };
}

test('writebacks: forward writes the 3 field IDs + note + SR user id', async () => {
  const { calls, deps } = captureDeps('7021');
  await writebacks({
    b: { contact_id: 'CT1', salesrabbit_id: 'SR9', source: 'Canvassing' },
    plan: { action: 'forward', reason: 'valid_hour' },
    norm: { adate: '07/24/2026', atime: '2:00 PM' },
    notes: 'NOTES', inboundId: '409976',
  }, deps);

  // First updateFields call: inbound id, normalized time, notes block.
  const first = calls.updateFields[0];
  const ids = first.fields.map((f) => f.id);
  assert.deepEqual(ids, ['3YMxheIlPyhACB8zyc3W', '7lpRWFDM8DZbLd3viHEG', 'KcXVXLmMdwca7O4QJ5lZ']);
  assert.equal(first.fields[0].field_value, '409976');
  assert.equal(first.fields[1].field_value, '07/24/2026 2:00 PM');
  assert.equal(first.fields[2].field_value, 'NOTES');

  // No hour-invalid tag on a valid hour.
  assert.equal(calls.tags.length, 0);
  // Note written once.
  assert.equal(calls.notes.length, 1);
  // SalesRabbit user id written back to its field.
  const srWrite = calls.updateFields[1];
  assert.deepEqual(srWrite.fields, [{ id: '69vctRrUluWZDZ605wgM', field_value: '7021' }]);
});

test('writebacks: strip applies the hour-invalid tag and omits the time field', async () => {
  const { calls, deps } = captureDeps(null);
  await writebacks({
    b: { contact_id: 'CT2', salesrabbit_id: '' },
    plan: { action: 'strip', reason: 'impossible_hour' },
    norm: { adate: '07/24/2026', atime: '6:00 AM' },
    notes: 'NOTES', inboundId: '123',
  }, deps);

  const ids = calls.updateFields[0].fields.map((f) => f.id);
  assert.ok(!ids.includes('7lpRWFDM8DZbLd3viHEG'), 'normalized-time field must NOT be written on strip');
  assert.ok(ids.includes('KcXVXLmMdwca7O4QJ5lZ'), 'notes still written');
  assert.deepEqual(calls.tags, [{ id: 'CT2', tag: 'appt:hour-invalid' }]);
  // Blank salesrabbit_id → no SR lookup result → no SR writeback.
  assert.equal(calls.updateFields.length, 1);
});

test('writebacks: no SalesRabbit writeback when lookup returns null', async () => {
  const { calls, deps } = captureDeps(null);
  await writebacks({
    b: { contact_id: 'CT3', salesrabbit_id: 'SR1' },
    plan: { action: 'forward', reason: 'valid_hour' },
    norm: { adate: '07/24/2026', atime: '2:00 PM' },
    notes: 'N', inboundId: '1',
  }, deps);
  assert.deepEqual(calls.srLookups, ['SR1']);       // lookup attempted
  assert.equal(calls.updateFields.length, 1);        // but no SR field write
});

test('writebacks: no-op without a contact id', async () => {
  const { calls, deps } = captureDeps('x');
  await writebacks({ b: {}, plan: { action: 'forward' }, norm: {}, notes: 'N', inboundId: '1' }, deps);
  assert.equal(calls.updateFields.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// 7. getSalesRabbitUserId
// ═══════════════════════════════════════════════════════════════════════

test('getSalesRabbitUserId: reads .data.userId as a string', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: { userId: 4021 } }) });
  assert.equal(await getSalesRabbitUserId('SR1', { token: 'tok', fetchImpl }), '4021');
});

test('getSalesRabbitUserId: fail-open nulls', async () => {
  const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ data: { userId: 1 } }) });
  const errFetch = async () => ({ ok: false, status: 404, text: async () => 'nope' });
  assert.equal(await getSalesRabbitUserId('', { token: 'tok', fetchImpl: okFetch }), null);      // no id
  assert.equal(await getSalesRabbitUserId('SR1', { token: '', fetchImpl: okFetch }), null);       // no token
  assert.equal(await getSalesRabbitUserId('SR1', { token: 'tok', fetchImpl: errFetch }), null);   // http error
});

// ═══════════════════════════════════════════════════════════════════════
// 8. Route behavior
// ═══════════════════════════════════════════════════════════════════════

test('route shadow: valid hour → no LP send, no card, 200 with normalized', async () => {
  reset(); setMode('shadow');
  const res = await invoke({ ...SAMPLE_BODY, preferred_estimate_time: '07/24/2026 02:00 PM' });
  assert.equal(lpCalls.length, 0);
  assert.equal(cardCalls.length, 0);
  assert.equal(res._json.success, true);
  assert.equal(res._json.mode, 'shadow');
  assert.equal(res._json.plan, 'forward');
  assert.equal(res._json.normalized, '07/24/2026 2:00 PM');
});

test('route shadow: impossible hour → no LP send, exactly one card', async () => {
  reset(); setMode('shadow');
  const res = await invoke({ ...SAMPLE_BODY, preferred_estimate_time: '07/24/2026 06:00 AM' });
  assert.equal(lpCalls.length, 0);
  assert.equal(cardCalls.length, 1);
  assert.match(cardCalls[0], /FLAGGED \(shadow\)/);
  assert.equal(res._json.plan, 'strip');
  assert.equal(res._json.reason, 'impossible_hour');
});

test('route live: forward → LP gets the full body incl adate/atime, inbound id parsed', async () => {
  reset(); setMode('live');
  const res = await invoke({ ...SAMPLE_BODY, contact_id: 'CTLIVE', salesrabbit_id: '', preferred_estimate_time: '07/24/2026 02:00 PM' });
  assert.equal(lpCalls.length, 1);
  const sent = lpCalls[0];
  assert.equal(sent.srs_id, '344');
  assert.equal(sent.phone1, '9545081512');
  assert.equal(sent.adate, '07/24/2026');
  assert.equal(sent.atime, '2:00 PM');
  assert.equal(cardCalls.length, 0);
  assert.equal(res._json.success, true);
  assert.equal(res._json.mode, 'live');
  assert.equal(res._json.inbound_id, '409976');
});

test('route live: impossible hour → LP body has NO adate/atime + one card', async () => {
  reset(); setMode('live');
  const res = await invoke({ ...SAMPLE_BODY, contact_id: 'CTSTRIP', salesrabbit_id: '', preferred_estimate_time: '07/24/2026 06:00 AM' });
  assert.equal(lpCalls.length, 1);
  assert.ok(!('adate' in lpCalls[0]), 'adate must be absent');
  assert.ok(!('atime' in lpCalls[0]), 'atime must be absent');
  assert.equal(cardCalls.length, 1);
  assert.match(cardCalls[0], /STRIPPED/);
  assert.equal(res._json.plan, 'strip');
});

test('route live: unparseable time → lead still posts, appointment omitted, card', async () => {
  reset(); setMode('live');
  const res = await invoke({ ...SAMPLE_BODY, contact_id: 'CTOMIT', salesrabbit_id: '', preferred_estimate_time: 'whenever works' });
  assert.equal(lpCalls.length, 1);
  assert.ok(!('adate' in lpCalls[0]));
  assert.equal(cardCalls.length, 1);
  assert.match(cardCalls[0], /UNPARSEABLE/);
  assert.equal(res._json.plan, 'omit');
  assert.equal(res._json.reason, 'unparseable_time');
});

test('route live: LP 500 → 502 + failure card', async () => {
  reset(); setMode('live');
  lpResponse = { ok: false, status: 500, text: 'boom' };
  const res = await invoke({ ...SAMPLE_BODY, contact_id: 'CTERR', salesrabbit_id: '', preferred_estimate_time: '07/24/2026 02:00 PM' });
  assert.equal(res._status, 502);
  assert.equal(res._json.success, false);
  assert.match(res._json.error, /LP 500/);
  assert.ok(cardCalls.some((c) => /LP addlead failed/.test(c)), 'expected an LP-failure card');
});

test('route live: LP unreachable → 502', async () => {
  reset(); setMode('live');
  lpShouldThrow = true;
  const res = await invoke({ ...SAMPLE_BODY, contact_id: 'CTNET', salesrabbit_id: '', preferred_estimate_time: '07/24/2026 02:00 PM' });
  assert.equal(res._status, 502);
  assert.equal(res._json.success, false);
  assert.ok(cardCalls.some((c) => /LP unreachable/.test(c)));
});

test('route: card claim dedups — two identical strips send exactly one card', async () => {
  reset(); setMode('shadow');
  const body = { ...SAMPLE_BODY, contact_id: 'CTDUP', preferred_estimate_time: '07/24/2026 06:00 AM' };
  await invoke(body);
  await invoke(body);
  assert.equal(cardCalls.length, 1, 'the 23505 claim collision must suppress the second card');
});
