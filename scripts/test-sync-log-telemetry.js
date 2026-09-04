#!/usr/bin/env node
/**
 * Paging telemetry persistence — scripts/test-sync-log-telemetry.js
 *
 * Covers 084: syncLogTelemetry now persists rows_scanned alongside the
 * api_calls / paging_mode columns 082 added.
 *
 * WHY rows_scanned EXISTS
 * -----------------------
 * records_synced counts rows WRITTEN. Deep-offset paging triggers on rows
 * FETCHED, and the two are not the same number — measured 2026-09-04, one
 * leads sweep logged `scanned=543` against `records_synced=303`. Correlating
 * sweep duration against records_synced therefore answers the wrong question,
 * which is why the first attempt to confirm the paging theory came back
 * inconclusive: runs showing <=50 leads synced still reached 1,483s because
 * they had scanned far more than 50 rows.
 *
 * The contract these tests pin:
 *   1. rowsScanned lands in the rows_scanned column.
 *   2. ZERO is a real measurement and must be written, not skipped. A sweep
 *      that fetched nothing is exactly the observation that separates "LP had
 *      no rows" from "we never asked" — the truthiness bug here would erase it.
 *   3. Absent / non-numeric fields are OMITTED, never nulled. Telemetry is
 *      written by whichever sweep owns that entity's paging; a null would
 *      overwrite a real number with an absence.
 *   4. Telemetry NEVER touches records_synced or status. It is an additive
 *      annotation on a row another code path owns.
 *   5. No logId, or nothing to write, issues no query at all.
 *   6. A failing update never throws — telemetry must not break a sync.
 *
 * Run: node scripts/test-sync-log-telemetry.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Dummy env BEFORE importing src/supabase.js — it returns null without both
// vars, and a real SUPABASE_URL in the dev's shell must never reach this suite.
process.env.SUPABASE_URL = 'http://sb.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';

const networkCalls = [];
globalThis.fetch = async (url) => {
  networkCalls.push(String(url));
  return { ok: false, status: 599, headers: { get: () => null }, text: async () => '', json: async () => ({}) };
};

const calls = [];
let failNext = null;

const supabase = (await import('../src/supabase.js')).default;
assert.ok(supabase, 'supabase client must exist — check the env writes above');
Object.defineProperty(supabase, 'from', {
  value: (table) => {
    const s = { table, op: null, payload: null, filters: [] };
    const chain = {
      update(p) { s.op = 'update'; s.payload = p; return chain; },
      eq(c, v)  { s.filters.push([c, v]); return chain; },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            calls.push(s);
            if (failNext) { const e = failNext; failNext = null; throw e; }
            return { data: null, error: null };
          })
          .then(resolve, reject);
      },
    };
    return chain;
  },
  writable: true, configurable: true,
});

const { syncLogTelemetry } = await import('../src/sync-log.js');

const LOG_ID = 'e5f4a1c2-0000-4000-8000-000000000001';
function fresh() { calls.length = 0; failNext = null; }
const lastPatch = () => { assert.equal(calls.length, 1, 'expected exactly one update'); return calls[0].payload; };

// ─── 1. rows_scanned is persisted ────────────────────────────────

test('rowsScanned is written to the rows_scanned column', async () => {
  fresh();
  await syncLogTelemetry(LOG_ID, { apiCalls: 12, pagingMode: 'deep', rowsScanned: 543 });
  assert.deepEqual(lastPatch(), { api_calls: 12, paging_mode: 'deep', rows_scanned: 543 });
  assert.equal(calls[0].table, 'lp_sync_log');
  assert.deepEqual(calls[0].filters, [['id', LOG_ID]]);
});

test('the 082 columns still work on their own', async () => {
  fresh();
  await syncLogTelemetry(LOG_ID, { apiCalls: 3, pagingMode: 'normal' });
  assert.deepEqual(lastPatch(), { api_calls: 3, paging_mode: 'normal' });
});

test('rowsScanned can be written on its own', async () => {
  fresh();
  await syncLogTelemetry(LOG_ID, { rowsScanned: 51 });
  assert.deepEqual(lastPatch(), { rows_scanned: 51 });
});

// ─── 2. Zero is a measurement, not an absence ────────────────────

test('rowsScanned = 0 IS written — a sweep that fetched nothing is a real result', async () => {
  // The bug this guards: `if (rowsScanned)` instead of Number.isFinite would
  // drop this silently, and "scanned nothing" would become indistinguishable
  // from "never measured" — the exact ambiguity 084 exists to remove.
  fresh();
  await syncLogTelemetry(LOG_ID, { rowsScanned: 0, apiCalls: 0 });
  assert.deepEqual(lastPatch(), { api_calls: 0, rows_scanned: 0 });
});

// ─── 3. Absent fields are omitted, never nulled ──────────────────

test('fields that were not measured are omitted from the patch', async () => {
  fresh();
  await syncLogTelemetry(LOG_ID, { rowsScanned: 90 });
  const patch = lastPatch();
  assert.ok(!('api_calls' in patch), 'a null here would erase the owning sweep’s number');
  assert.ok(!('paging_mode' in patch));
});

test('non-numeric and empty values are rejected rather than written', async () => {
  for (const bad of [undefined, null, NaN, Infinity, '543', {}]) {
    fresh();
    await syncLogTelemetry(LOG_ID, { rowsScanned: bad });
    assert.equal(calls.length, 0, `rowsScanned=${String(bad)} must not produce a write`);
  }
  fresh();
  await syncLogTelemetry(LOG_ID, { pagingMode: '' });
  assert.equal(calls.length, 0, 'an empty paging_mode is not a measurement');
});

// ─── 4. Telemetry is additive only ───────────────────────────────

test('telemetry never touches records_synced, status or completed_at', async () => {
  // rows_scanned annotates a row whose lifecycle another code path owns.
  // Writing any of these from here would race syncLogComplete.
  fresh();
  await syncLogTelemetry(LOG_ID, { apiCalls: 9, pagingMode: 'deep', rowsScanned: 543 });
  for (const forbidden of ['records_synced', 'status', 'completed_at', 'started_at', 'error_message']) {
    assert.ok(!(forbidden in lastPatch()), `${forbidden} must not be written by telemetry`);
  }
});

// ─── 5. Nothing to write issues no query ─────────────────────────

test('a missing logId issues no query', async () => {
  for (const id of [null, undefined, '']) {
    fresh();
    await syncLogTelemetry(id, { rowsScanned: 10 });
    assert.equal(calls.length, 0);
  }
});

test('an empty measurement set issues no query', async () => {
  fresh();
  await syncLogTelemetry(LOG_ID, {});
  await syncLogTelemetry(LOG_ID);
  assert.equal(calls.length, 0, 'never send an empty patch to PostgREST');
});

// ─── 6. Telemetry cannot break a sync ────────────────────────────

test('a failing update is swallowed, not thrown', async () => {
  fresh();
  failNext = new Error('column "rows_scanned" does not exist');
  await assert.doesNotReject(
    () => syncLogTelemetry(LOG_ID, { rowsScanned: 543 }),
    'a sync must survive telemetry failing — including before the migration lands',
  );
  assert.equal(calls.length, 1, 'it was attempted');
});

test('no test touched the network', () => {
  assert.deepEqual(networkCalls.filter(u => u.includes('/rest/v1/')), []);
});
