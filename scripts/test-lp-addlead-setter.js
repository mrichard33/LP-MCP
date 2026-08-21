/**
 * LP addlead setter + attribution labels — scripts/test-lp-addlead-setter.js
 *
 * Covers the 2026-08-15 attribution work:
 *   1-4. src/lp-client.js addLead() stamps LP_EMP.GHL_INTEGRATION (5686) as
 *        the setter when a lead is created WITH an appointment — but only
 *        when LP_ADDLEAD_SETTER_FIELD names a key LP actually accepts.
 *        Unset (today's state in Railway) must be a byte-for-byte no-op.
 *   5.   The assertNotTransposed contract, including the exact error text
 *        that lp-force-addlead.js's rethrow guard matches on.
 *   6.   The field→value mapping guard. Rewritten 2026-08-21: it used to pin
 *        the INVERTED mapping (k6j4…→830, BbUJ…→5574) and so was one of the
 *        five tests that went red when src/lp-source-ids.js reached v2.1. It
 *        now pins the live-verified one, plus the canvass pair that
 *        force-addlead was throwing on.
 *
 * WHY 5 AND 6 ARE NOT DRIVEN THROUGH ensureLpSourceAndProId(): that function
 * is module-private and its contact read goes through getGHLContact, which
 * uses the axios ghlClient rather than global fetch. Stubbing it would need
 * node:test module mocking, and `npm test` runs `node --test scripts/test-*.js`
 * with no flags — a mocked suite would break the repo's own test command. So
 * the two invariants that actually protect attribution are asserted directly:
 * the error text the rethrow guard depends on, and the id→value pairing.
 *
 * Run: node --test scripts/test-lp-addlead-setter.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.LP_POST_URL = 'https://lppost.test.invalid/br27/addlead';

// ─── fetch stub (installed before import) ────────────────────────────
let posts = [];
globalThis.fetch = async (url, opts = {}) => {
  posts.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
  return {
    status: 200, ok: true,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => ({ status: 'OK', message: 'lead added', lds_id: 999001 }),
    text: async () => '{"status":"OK"}',
  };
};

const { LP_EMP, LP_SRS, LP_PRO, assertNotTransposed } = await import('../src/lp-source-ids.js');

// LP_ADDLEAD_SETTER_FIELD is read at MODULE LOAD (a const), so each
// configuration needs its own module instance. A distinct query string gives
// ESM a distinct cache key while resolving to the same file.
let loadCounter = 0;
async function loadAddLead(setterField) {
  if (setterField === undefined) delete process.env.LP_ADDLEAD_SETTER_FIELD;
  else process.env.LP_ADDLEAD_SETTER_FIELD = setterField;
  loadCounter += 1;
  const mod = await import(`../src/lp-client.js?setter=${loadCounter}`);
  return mod.addLead;
}

// A canvassing lead WITH an appointment — the path contact
// gUihunGyOa6SiGbJCJ3K went through.
const leadFields = (over = {}) => ({
  firstname: 'Maria', lastname: 'R',
  address1: '3311 Foxridge Cir', city: 'Tampa', state: 'FL', zip: '33618',
  phone: '8135551234', srs_id: LP_SRS.CHATBOT, pro_id: LP_PRO.CHATBOT,
  apptdate: '08/19/2026', appttime: '3:00 PM',
  ...over,
});

const lastBody = () => posts[posts.length - 1].body;

// ═══ 1-4. The setter stamp ════════════════════════════════════════════

test('(1) LP_ADDLEAD_SETTER_FIELD unset → body identical to today, no setter key', async () => {
  posts = [];
  const addLead = await loadAddLead(undefined);
  await addLead(leadFields());
  assert.equal(posts.length, 1);
  // The full legacy wire body, pinned. `adate`/`atime`/`phone1` are the
  // LEGACY_FIELD_MAP translations of apptdate/appttime/phone.
  assert.deepEqual(lastBody(), {
    firstname: 'Maria', lastname: 'R',
    address1: '3311 Foxridge Cir', city: 'Tampa', state: 'FL', zip: '33618',
    phone1: '8135551234', srs_id: '830', pro_id: '5574',
    adate: '08/19/2026', atime: '3:00 PM',
  });
  // No stray setter-ish key crept in under any name.
  const keys = Object.keys(lastBody());
  assert.equal(keys.some((k) => /set_?by|empid|setter|user2/i.test(k)), false);
});

test('(2) setter field set + appointment present → key carries 5686', async () => {
  posts = [];
  const addLead = await loadAddLead('setby');
  await addLead(leadFields());
  assert.equal(lastBody().setby, '5686');
  assert.equal(lastBody().setby, String(LP_EMP.GHL_INTEGRATION));
});

test('(2b) the setter key passes through _translateToLegacy unrenamed', async () => {
  // LP silently drops unrecognised keys, so the env var must reach the wire
  // under exactly the name it was given — no LEGACY_FIELD_MAP surprise.
  posts = [];
  const addLead = await loadAddLead('User2');
  await addLead(leadFields());
  assert.equal(lastBody().User2, '5686');
});

test('(3) setter field set but NO appointment → key absent', async () => {
  // A lead with no appointment has no setter to record.
  posts = [];
  const addLead = await loadAddLead('setby');
  await addLead(leadFields({ apptdate: undefined, appttime: undefined }));
  assert.equal('setby' in lastBody(), false);
});

test('(3b) appttime without apptdate → key absent (both required)', async () => {
  posts = [];
  const addLead = await loadAddLead('setby');
  // addLead itself rejects a half-specified appointment; assert that contract
  // holds rather than silently stamping a setter onto a rejected lead.
  await assert.rejects(() => addLead(leadFields({ apptdate: undefined })));
  assert.equal(posts.length, 0);
});

test('(4) caller already supplied the key → the caller value survives', async () => {
  posts = [];
  const addLead = await loadAddLead('setby');
  await addLead(leadFields({ setby: '1234' }));
  assert.equal(lastBody().setby, '1234', 'an explicit caller value must never be overwritten');
});

// ═══ 5. The transposition assertion + the rethrow guard's coupling ════

test('(5) assertNotTransposed fires on srs_id=5574 / pro_id=830', () => {
  // The I.CT orientation: the 4-digit promoter id in the srs_id slot and the
  // 3-digit subsource id in the pro_id slot.
  assert.throws(
    () => assertNotTransposed('5574', '830'),
    /LP attribution transposed/,
  );
});

test('(5b) the correct pairing does NOT throw', () => {
  assert.doesNotThrow(() => assertNotTransposed(LP_SRS.CHATBOT, LP_PRO.CHATBOT));
  assert.doesNotThrow(() => assertNotTransposed('830', '5574'));
});

test('(5d) a real canvass pair does NOT throw — the regression this PR fixes', () => {
  // THE LIVE DEFECT. lp-force-addlead.js read existingSrs from BbUJ… and
  // existingPro from k6j4…, which on a canvass contact is srs=5339/pro=344 —
  // 4-digit srs + 3-digit pro, so the guard threw and the throw is
  // deliberately re-raised past the fail-open catch. Enrollment aborted for
  // the admin endpoint, the syncAppointmentToLP auto-heal and the
  // force_lp_lead_creation MCP tool alike.
  //
  // Read the fields the right way round and the same contacts are ordinary:
  // srs_id=344 (LP_SRS.CANVASSING, 3-digit) with a 4-digit per-canvasser
  // promoter. Values verified live 2026-08-21 on 424VpfdtIa1yUyP1ZYNa
  // (canvasser Timothy Blyth) and rL81tAIiSMMqBroWNg2S (Kenny Peloke).
  assert.doesNotThrow(() => assertNotTransposed('344', '5339'));
  assert.doesNotThrow(() => assertNotTransposed('344', '2460'));
  assert.doesNotThrow(() => assertNotTransposed(LP_SRS.CANVASSING, '5339'));

  // And the same contact read backwards must still be caught — otherwise this
  // test would pass just as well against the bug it exists to pin.
  assert.throws(() => assertNotTransposed('5339', '344'), /LP attribution transposed/);
});

test('(5c) the rethrow guard regex matches the real error text', () => {
  // lp-force-addlead.js re-throws on /LP attribution transposed/i rather than
  // falling open. If assertNotTransposed's wording ever drifts, that guard
  // silently reverts to fail-open and misattributed leads ship again. This
  // pins the coupling between the two files.
  const GUARD = /LP attribution transposed/i;
  let msg = null;
  try { assertNotTransposed('5574', '830'); } catch (err) { msg = err.message; }
  assert.ok(msg, 'assertNotTransposed must throw for the I.CT pair');
  assert.match(msg, GUARD, 'the rethrow guard in lp-force-addlead.js keys off this exact text');

  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/admin/lp-force-addlead.js'),
    'utf8',
  );
  assert.match(src, /if \(\/LP attribution transposed\/i\.test\(err\.message\)\) throw err;/,
    'the transposition rethrow must remain in ensureLpSourceAndProId');
});

// ═══ 6. Field/value mapping guard ═════════════════════════════════════

test('(6) SRS_ID_FIELD→k6j4…/830 and PRO_ID_FIELD→BbUJ…/5574 — do NOT swap', () => {
  // THE GUARD, corrected 2026-08-21. It previously pinned the inverse of this
  // and taught the inversion as fact, which is how the mapping survived the
  // v2.1 registry correction.
  //
  // The structural rule, from src/lp-source-ids.js v2.1: LP SubSource ids are
  // 3-digit and LP Promoter ids are 4-digit. So:
  //   k6j4IBh5IejPooSCsj49 holds srs_id — SubSource, 3-digit (canvass 344)
  //   BbUJ6RrdTjjEqqRA8JVx holds pro_id — Promoter,  4-digit (canvass 5339)
  // Verified live 2026-08-21 on 424VpfdtIa1yUyP1ZYNa and rL81tAIiSMMqBroWNg2S,
  // whose "LP Promoter Name" fields name the humans behind those 4-digit ids.
  // src/actions/handlers/lp-lead.js:118-119 is the reference implementation.
  //
  // If these assertions go red, the source is what changed — check a live
  // canvass contact before touching the numbers here. A 4-digit value in
  // k6j4… or a 3-digit value in BbUJ… is the transposition, always.
  //
  // Asserted at source level because both constants are module-private and
  // the module's contact read is axios-based (see the header note).
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/admin/lp-force-addlead.js'),
    'utf8',
  );

  assert.match(src, /const SRS_ID_FIELD\s*=\s*'k6j4IBh5IejPooSCsj49'/,
    'SRS_ID_FIELD must be k6j4IBh5IejPooSCsj49 — the 3-digit SubSource field');
  assert.match(src, /const PRO_ID_FIELD\s*=\s*'BbUJ6RrdTjjEqqRA8JVx'/,
    'PRO_ID_FIELD must be BbUJ6RrdTjjEqqRA8JVx — the 4-digit Promoter field');
  assert.match(src, /const FALLBACK_PRO_ID\s*=\s*String\(process\.env\.LP_FALLBACK_PRO_ID \|\| LP_PRO\.CHATBOT\)/,
    'the promoter fallback must come from LP_PRO.CHATBOT');
  assert.match(src, /const FALLBACK_SRS_ID\s*=\s*String\(process\.env\.LP_FALLBACK_SRS_ID \|\| LP_SRS\.CHATBOT\)/,
    'the subsource fallback must come from LP_SRS.CHATBOT');

  // The registry values those fallbacks resolve to, pinned end-to-end.
  assert.equal(LP_SRS.CHATBOT, '830');
  assert.equal(LP_PRO.CHATBOT, '5574');

  // The dead constant must not come back as live code. It is still NAMED in
  // the v2.1.0 changelog, which documents the rename — that mention is the
  // point, so the guard targets declarations and uses, not prose.
  assert.doesNotMatch(src, /const\s+LP_SOURCE_ID_FIELD/);
  assert.doesNotMatch(src, /const\s+FALLBACK_SOURCE_ID/);
  assert.doesNotMatch(src, /field_value:\s*FALLBACK_SOURCE_ID/);
  assert.doesNotMatch(src, /id:\s*LP_SOURCE_ID_FIELD/);
  assert.match(src, /LP_FALLBACK_SOURCE_ID is DEAD/,
    'the changelog must keep telling operators the old env var is dead');
});

test('(6b) the writes still pair each field id with its own fallback', () => {
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/admin/lp-force-addlead.js'),
    'utf8',
  );
  assert.match(src, /updates\.push\(\{ id: PRO_ID_FIELD, field_value: FALLBACK_PRO_ID \}\)/);
  assert.match(src, /updates\.push\(\{ id: SRS_ID_FIELD, field_value: FALLBACK_SRS_ID \}\)/);
});
