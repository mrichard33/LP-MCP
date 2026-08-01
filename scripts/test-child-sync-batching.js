#!/usr/bin/env node
/**
 * Batched child-record writes — scripts/test-child-sync-batching.js
 *
 * Covers perf/batch-child-sync: syncCallLogs, syncNotes and syncActivities in
 * src/sync-children.js now build their rows, dedupe on the conflict key, and
 * issue ONE bulk upsert each with a per-row fallback — the shape
 * syncJobAndMilestones has used since #512-perf.
 *
 * The contract these tests pin:
 *   1. Existence check unchanged — skipped ids still increment _childSkips.
 *   2. Surviving rows are deduped on the conflict key, LAST occurrence wins.
 *      A dedupe is NOT a skip and must not touch _childSkips.
 *   3. ONE .upsert(rowsArray, { onConflict }) per table per call. Zero upserts
 *      when the set is empty — never an empty array to PostgREST.
 *   4. On a bulk { error }, fall back to one .upsert(row) per row.
 *   5. raw_lp_data is omitted from lp_call_logs and lp_activities rows and
 *      RETAINED on lp_notes rows.
 *   6. Every row in a bulk payload carries the same key set (getField returns
 *      null, never undefined) — otherwise PostgREST silently defaults columns.
 *   7. syncCallLogs aggregates are computed in memory: call_count = distinct
 *      call ids, last_contact_date = max non-null call date.
 *
 * The dedupe cases are the load-bearing ones. lp_activity_id is synthesized as
 * `call-${lead}-${date}-${agent}`, so two calls at the same datetime by the same
 * agent collapse to one key. Repeated inside a single bulk upsert that is a hard
 * Postgres 21000 that fails the WHOLE batch; the old per-row loop was immune.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Seam ────────────────────────────────────────────────────────
// sync-children.js has no DI hook — it calls the module-level supabase
// singleton directly. Force dummy env BEFORE importing src/supabase.js (it
// returns null without both vars, and a real SUPABASE_URL in the dev's shell
// must never reach this suite), then shadow `from` on the client instance.
// Both modules hold the same object reference, so the stub is what runs.
process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
delete process.env.GHL_API_KEY;   // keeps ghl.js's axios client null

// Network tripwire. Records rather than throws — an unhandled rejection from a
// background auth tick would kill the process. Asserted empty in the last test.
const networkCalls = [];
globalThis.fetch = async (url) => {
  networkCalls.push(String(url));
  return {
    ok: false, status: 599, statusText: 'blocked-by-test',
    headers: { get: () => null }, text: async () => '', json: async () => ({}),
  };
};

const rec = createRecorder();

const supabase = (await import('../src/supabase.js')).default;
assert.ok(supabase, 'supabase client must exist — check the env writes above');
Object.defineProperty(supabase, 'from', {
  value: (table) => rec.from(table), writable: true, configurable: true,
});

// Pre-seed the first-record key logging so the suite stays quiet.
const { loggedFirstKeys } = await import('../src/sync-utils.js');
for (const k of ['call', 'note']) loggedFirstKeys.add(k);

const { syncCallLogs, syncNotes, syncActivities, getChildSkipStats } =
  await import('../src/sync-children.js');

// ─── Recorder ────────────────────────────────────────────────────
// One from(table) call → one fresh thenable chain. The op is recorded in then(),
// so a chain production built but never awaited is never counted.
function createRecorder() {
  const calls = [];
  const existing = new Map();    // table → Set(ids) that "already exist"
  const upsertFail = new Map();  // table → (payload) => errorObj | null

  function settle(s) {
    calls.push({ table: s.table, op: s.op, payload: s.payload, options: s.options, filters: s.filters });
    if (s.op === 'select') {
      const inF = s.filters.find(f => f[0] === 'in');
      if (inF) {
        const [, col, ids] = inF;
        const have = existing.get(s.table) ?? new Set();
        return { data: ids.filter(id => have.has(id)).map(id => ({ [col]: id })), error: null };
      }
      return s.single ? { data: null, error: null } : { data: [], error: null };
    }
    if (s.op === 'upsert') {
      const fail = upsertFail.get(s.table);
      return { data: null, error: fail ? fail(s.payload) : null };
    }
    return { data: null, error: null };
  }

  function from(table) {
    const s = { table, op: null, payload: null, options: null, filters: [], single: false };
    const chain = {
      select(cols, opts) { s.op ??= 'select'; s.payload = cols; if (opts) s.options = opts; return chain; },
      insert(p, o) { s.op = 'insert'; s.payload = p; s.options = o ?? null; return chain; },
      upsert(p, o) { s.op = 'upsert'; s.payload = p; s.options = o ?? null; return chain; },
      update(p)    { s.op = 'update'; s.payload = p; return chain; },
      delete()     { s.op = 'delete'; return chain; },
      eq(c, v)     { s.filters.push(['eq', c, v]);     return chain; },
      in(c, v)     { s.filters.push(['in', c, v]);     return chain; },
      not(c, o, v) { s.filters.push(['not', c, o, v]); return chain; },
      order(c, o)  { s.filters.push(['order', c, o]);  return chain; },
      limit(n)     { s.filters.push(['limit', n]);     return chain; },
      single()      { s.single = true; return chain; },
      maybeSingle() { s.single = true; return chain; },
      then(resolve, reject) { return Promise.resolve().then(() => settle(s)).then(resolve, reject); },
    };
    return chain;
  }

  return {
    from, calls,
    ops:  (t, op) => calls.filter(c => c.table === t && (!op || c.op === op)),
    bulk: (t) => calls.filter(c => c.table === t && c.op === 'upsert' &&  Array.isArray(c.payload)),
    row:  (t) => calls.filter(c => c.table === t && c.op === 'upsert' && !Array.isArray(c.payload)),
    setExisting: (t, ids) => existing.set(t, new Set(ids)),
    failUpsert:  (t, fn)  => upsertFail.set(t, fn),
    reset() { calls.length = 0; existing.clear(); upsertFail.clear(); },
  };
}

// ─── Fixtures + helpers ──────────────────────────────────────────
const LEAD = 'L1', CONTACT = 'C1';
const D1 = '2026-06-01T09:00:00';
const D2 = '2026-07-01T10:00:00';
const D3 = '2026-05-01T08:00:00';

const mkCall = (o = {}) => ({
  id: 'c1', calldatetime: D1, agent: 'E77', agentname: 'Dana R',
  duration: 120, resultcode: 'CONN', resultdescr: 'Connected',
  calltype: 'O', notes: 'spoke', recording_url: 'http://rec/1', ...o,
});
const mkNote = (o = {}) => ({
  id: 'n1', enteredon: D1, enteredby: 'Dana R',
  note: 'Customer called back', category: 'GEN', rectype: 'GEN', ...o,
});

const keysOf = (r) => Object.keys(r).sort();
const bulkPayload = (t) => { const b = rec.bulk(t); assert.equal(b.length, 1, `expected exactly one bulk upsert on ${t}`); return b[0].payload; };

function assertNoDupKeys(rows, col) {
  const seen = rows.map(r => r[col]);
  assert.equal(new Set(seen).size, seen.length, `duplicate ${col} in one bulk payload → Postgres 21000`);
}

// Drain-on-entry: _childSkips is a module-level counter that zeroes on read, so
// a test that increments but never reads would pollute the next one.
function fresh() { rec.reset(); getChildSkipStats(); }

// ─── syncCallLogs ────────────────────────────────────────────────

test('syncCallLogs issues ONE bulk upsert containing every new call', async () => {
  fresh();
  await syncCallLogs(LEAD, CONTACT, [
    mkCall({ id: 'c1' }), mkCall({ id: 'c2', calldatetime: D2 }), mkCall({ id: 'c3', calldatetime: D3 }),
  ]);
  assert.equal(rec.bulk('lp_call_logs').length, 1, 'exactly one upsert round-trip');
  assert.equal(rec.row('lp_call_logs').length, 0, 'no per-row upserts on the happy path');
  const rows = bulkPayload('lp_call_logs');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.lp_call_id), ['c1', 'c2', 'c3']);
  assert.equal(rec.bulk('lp_call_logs')[0].options.onConflict, 'lp_call_id');
});

test('syncCallLogs skips existing ids and reports them via getChildSkipStats', async () => {
  fresh();
  rec.setExisting('lp_call_logs', ['c1', 'c2']);
  await syncCallLogs(LEAD, CONTACT, [mkCall({ id: 'c1' }), mkCall({ id: 'c2' }), mkCall({ id: 'c3' })]);
  assert.equal(bulkPayload('lp_call_logs').length, 1);
  assert.equal(getChildSkipStats().calls, 2);
});

test('syncCallLogs writes nothing when every call already exists', async () => {
  fresh();
  rec.setExisting('lp_call_logs', ['c1', 'c2']);
  await syncCallLogs(LEAD, CONTACT, [mkCall({ id: 'c1' }), mkCall({ id: 'c2' })]);
  assert.equal(rec.ops('lp_call_logs', 'upsert').length, 0, 'no empty-array upsert to PostgREST');
  assert.equal(rec.ops('lp_leads').length, 0, 'aggregates untouched when nothing was inserted');
  assert.equal(getChildSkipStats().calls, 2);
});

test('lp_call_logs rows carry no raw_lp_data', async () => {
  fresh();
  await syncCallLogs(LEAD, CONTACT, [mkCall({ id: 'c1' }), mkCall({ id: 'c2' })]);
  for (const row of bulkPayload('lp_call_logs')) {
    assert.ok(!('raw_lp_data' in row), `raw_lp_data leaked onto ${row.lp_call_id}`);
  }
});

test('lp_call_logs bulk rows share a uniform key set even when LP fields are missing', async () => {
  fresh();
  await syncCallLogs(LEAD, CONTACT, [mkCall({ id: 'c1' }), { id: 'c2', calldatetime: D2 }]);
  const [full, sparse] = bulkPayload('lp_call_logs');
  assert.deepEqual(keysOf(full), keysOf(sparse), 'PostgREST would silently default the missing columns');
  assert.equal(sparse.call_result, null, 'getField must yield null, not undefined');
  assert.equal(sparse.rep_name, null);
});

test('a failed bulk call upsert falls back to one upsert per row', async () => {
  fresh();
  rec.failUpsert('lp_call_logs', (p) => (Array.isArray(p) ? { code: 'XX000', message: 'boom' } : null));
  await syncCallLogs(LEAD, CONTACT, [mkCall({ id: 'c1' }), mkCall({ id: 'c2' }), mkCall({ id: 'c3' })]);
  assert.equal(rec.bulk('lp_call_logs').length, 1);
  const perRow = rec.row('lp_call_logs');
  assert.equal(perRow.length, 3, 'one row must not drop the lead’s whole call history');
  for (const c of perRow) assert.equal(c.options.onConflict, 'lp_call_id');
  assert.equal(rec.ops('lp_leads', 'update').length, 1, 'surviving rows still update the aggregates');
});

test('call aggregates use the distinct count and the max non-null call date', async () => {
  fresh();
  await syncCallLogs(LEAD, CONTACT, [
    mkCall({ id: 'c1', calldatetime: null }),
    mkCall({ id: 'c2', calldatetime: D2 }),
    mkCall({ id: 'c3', calldatetime: D1 }),
  ]);
  const updates = rec.ops('lp_leads', 'update');
  assert.equal(updates.length, 1, 'three round-trips collapse to one update');
  assert.deepEqual(updates[0].payload, { call_count: 3, last_contact_date: `${D2}+00:00` });
  assert.deepEqual(updates[0].filters, [['eq', 'lp_lead_id', LEAD]]);
});

test('call aggregates write null — not undefined — when every call date is null', async () => {
  fresh();
  await syncCallLogs(LEAD, CONTACT, [mkCall({ id: 'c1', calldatetime: null }), mkCall({ id: 'c2', calldatetime: null })]);
  const [update] = rec.ops('lp_leads', 'update');
  assert.deepEqual(update.payload, { call_count: 2, last_contact_date: null });
  assert.ok('last_contact_date' in update.payload);
});

test('an empty calls array issues zero supabase calls', async () => {
  fresh();
  await syncCallLogs(LEAD, CONTACT, []);
  assert.equal(rec.calls.length, 0, 'not even the existence check should run');
});

test('a duplicate lp_call_id inside one batch is deduped before the bulk upsert', async () => {
  fresh();
  await syncCallLogs(LEAD, CONTACT, [
    mkCall({ id: 'c9', resultdescr: 'first' }),
    mkCall({ id: 'c9', resultcode: 'LAST' }),
    mkCall({ id: 'c8' }),
  ]);
  const rows = bulkPayload('lp_call_logs');
  assert.equal(rows.length, 2);
  assertNoDupKeys(rows, 'lp_call_id');
  assert.equal(rows.find(r => r.lp_call_id === 'c9').call_result, 'LAST', 'last occurrence wins');
  assert.equal(getChildSkipStats().calls, 0, 'a dedupe is not a skip');
});

// ─── syncNotes ───────────────────────────────────────────────────

test('syncNotes issues ONE bulk upsert with onConflict lp_note_id', async () => {
  fresh();
  await syncNotes(LEAD, CONTACT, [mkNote({ id: 'n1' }), mkNote({ id: 'n2' }), mkNote({ id: 'n3' })]);
  assert.equal(rec.bulk('lp_notes').length, 1);
  assert.equal(rec.row('lp_notes').length, 0);
  assert.equal(bulkPayload('lp_notes').length, 3);
  assert.equal(rec.bulk('lp_notes')[0].options.onConflict, 'lp_note_id');
});

test('lp_notes rows RETAIN raw_lp_data', async () => {
  fresh();
  const sources = [mkNote({ id: 'n1' }), mkNote({ id: 'n2' })];
  await syncNotes(LEAD, CONTACT, sources);
  const rows = bulkPayload('lp_notes');
  for (const [i, row] of rows.entries()) {
    assert.ok('raw_lp_data' in row, 'the note pipeline still wants the original LP payload');
    assert.deepEqual(row.raw_lp_data, sources[i]);
  }
});

test('syncNotes skips existing ids and reports them via getChildSkipStats', async () => {
  fresh();
  rec.setExisting('lp_notes', ['n1']);
  await syncNotes(LEAD, CONTACT, [mkNote({ id: 'n1' }), mkNote({ id: 'n2' })]);
  assert.equal(bulkPayload('lp_notes').length, 1);
  assert.equal(getChildSkipStats().notes, 1);
});

test('note_origin is still classified at ingest for both AI BRIEF prefixes', async () => {
  fresh();
  await syncNotes(LEAD, CONTACT, [
    mkNote({ id: 'n1', note: 'Plain rep note' }),
    mkNote({ id: 'n2', note: '[GHL · AI BRIEF · 7/28/26 7:37 PM] COLD' }),
    mkNote({ id: 'n3', note: '** IMPORTANT ** [AI BRIEF · 7/28/26 7:37 PM] COLD' }),
  ]);
  assert.deepEqual(bulkPayload('lp_notes').map(r => r.note_origin), ['lp', 'ghl_ai_brief', 'ghl_ai_brief']);
});

test('id-less notes sharing a date are deduped rather than colliding in the batch', async () => {
  fresh();
  await syncNotes(LEAD, CONTACT, [
    { enteredon: D1, enteredby: 'Dana R', note: 'first' },
    { enteredon: D1, enteredby: 'Dana R', note: 'second' },
  ]);
  const rows = bulkPayload('lp_notes');
  assert.equal(rows.length, 1, 'the `${lead}-${date}` id fallback has no per-note discriminator');
  assertNoDupKeys(rows, 'lp_note_id');
  assert.equal(rows[0].note_body, 'second', 'last occurrence wins');
  assert.equal(getChildSkipStats().notes, 0);
});

test('a failed bulk note upsert falls back to one upsert per row', async () => {
  fresh();
  rec.failUpsert('lp_notes', (p) => (Array.isArray(p) ? { code: 'XX000', message: 'boom' } : null));
  await syncNotes(LEAD, CONTACT, [mkNote({ id: 'n1' }), mkNote({ id: 'n2' })]);
  assert.equal(rec.bulk('lp_notes').length, 1);
  assert.equal(rec.row('lp_notes').length, 2);
});

test('an empty notes array issues zero supabase calls', async () => {
  fresh();
  await syncNotes(LEAD, CONTACT, []);
  assert.equal(rec.calls.length, 0);
});

// ─── syncActivities ──────────────────────────────────────────────

test('syncActivities bulk-upserts calls and notes as one lp_activities payload', async () => {
  fresh();
  await syncActivities(
    LEAD,
    [mkCall({ id: 'c1', calldatetime: D1 }), mkCall({ id: 'c2', calldatetime: D2 })],
    [mkNote({ id: 'n1', enteredon: D1 }), mkNote({ id: 'n2', enteredon: D2 })],
  );
  assert.equal(rec.bulk('lp_activities').length, 1);
  assert.equal(rec.row('lp_activities').length, 0);
  assert.equal(bulkPayload('lp_activities').length, 4);
  assert.equal(rec.bulk('lp_activities')[0].options.onConflict, 'lp_activity_id');
});

test('two calls at the same datetime by the same agent collapse to one activity row', async () => {
  fresh();
  const calls = [
    mkCall({ id: '1', calldatetime: D1, agent: 'E77', resultdescr: 'first' }),
    mkCall({ id: '2', calldatetime: D1, agent: 'E77', resultdescr: 'second' }),
    mkCall({ id: '3', calldatetime: D1, agent: 'E88', resultdescr: 'other agent' }),
  ];
  await syncActivities(LEAD, calls, []);
  const rows = bulkPayload('lp_activities');
  assert.equal(rows.length, 2, 'the synthetic activity id has no call-id component');
  assertNoDupKeys(rows, 'lp_activity_id');
  assert.equal(rows.find(r => r.lp_activity_id.endsWith('-E77')).activity_detail, 'second', 'last occurrence wins');
  assert.equal(getChildSkipStats().activities, 0, 'a dedupe is not a skip');

  // The asymmetry is the whole point: distinct lp_call_ids, colliding synthetic
  // activity key. lp_call_logs must still receive all three.
  rec.reset();
  await syncCallLogs(LEAD, CONTACT, calls);
  assert.equal(bulkPayload('lp_call_logs').length, 3);
});

test('two notes on the same date by the same author collapse to one activity row', async () => {
  fresh();
  await syncActivities(LEAD, [], [
    mkNote({ id: 'n1', enteredon: D1, enteredby: 'Dana R', note: 'first' }),
    mkNote({ id: 'n2', enteredon: D1, enteredby: 'Dana R', note: 'second' }),
  ]);
  const rows = bulkPayload('lp_activities');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].activity_detail, 'second');
});

test('lp_activities rows carry no raw_lp_data', async () => {
  fresh();
  await syncActivities(LEAD, [mkCall({ id: 'c1' })], [mkNote({ id: 'n1', enteredon: D2 })]);
  for (const row of bulkPayload('lp_activities')) {
    assert.ok(!('raw_lp_data' in row), `raw_lp_data leaked onto ${row.lp_activity_id}`);
  }
});

test('call-derived and note-derived activity rows share a uniform key set', async () => {
  fresh();
  await syncActivities(LEAD, [mkCall({ id: 'c1', calldatetime: D1 })], [mkNote({ id: 'n1', enteredon: D2 })]);
  const [callRow, noteRow] = bulkPayload('lp_activities');
  assert.equal(callRow.activity_type, 'call');
  assert.deepEqual(keysOf(callRow), keysOf(noteRow), 'a mixed bulk payload needs one column list');
  assert.equal(noteRow.rep_id, null, 'null, not omitted');
});

test('syncActivities skips existing ids and reports them via getChildSkipStats', async () => {
  fresh();
  rec.setExisting('lp_activities', [`call-${LEAD}-${D1}-E77`]);
  await syncActivities(LEAD, [mkCall({ id: 'c1', calldatetime: D1 }), mkCall({ id: 'c2', calldatetime: D2 })], []);
  assert.equal(bulkPayload('lp_activities').length, 1);
  assert.equal(getChildSkipStats().activities, 1);
});

test('a failed bulk activity upsert still attempts one upsert per row', async () => {
  fresh();
  rec.failUpsert('lp_activities', (p) => (Array.isArray(p) ? { code: 'XX000', message: 'boom' } : null));
  await syncActivities(LEAD, [mkCall({ id: 'c1', calldatetime: D1 }), mkCall({ id: 'c2', calldatetime: D2 })], []);
  assert.equal(rec.bulk('lp_activities').length, 1);
  assert.equal(rec.row('lp_activities').length, 2);
});

test('empty calls and notes issue zero supabase calls', async () => {
  fresh();
  await syncActivities(LEAD, [], []);
  assert.equal(rec.calls.length, 0);
});

// ─── Harness ─────────────────────────────────────────────────────

test('getChildSkipStats resets the counter on read', async () => {
  fresh();
  rec.setExisting('lp_call_logs', ['c1', 'c2']);
  await syncCallLogs(LEAD, CONTACT, [mkCall({ id: 'c1' }), mkCall({ id: 'c2' })]);
  assert.equal(getChildSkipStats().calls, 2);
  assert.equal(getChildSkipStats().calls, 0, 'read-once semantics the whole suite depends on');
});

test('no test touched the network', () => {
  const real = networkCalls.filter(u => u.includes('/rest/v1/') || u.includes('leadconnectorhq'));
  assert.deepEqual(real, []);
});
