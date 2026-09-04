/**
 * Tests — v6.11 sync hash gate (stableHash determinism + processProspect
 * signature back-compat)
 * scripts/test-hash-gate.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-hash-gate.js
 *
 * stableHash is duplicated below rather than imported: sync-engine.js runs
 * scheduler/signal-handler wiring at import time, which a unit test must not
 * trigger. This copy MUST stay byte-for-byte in sync with stableHash in
 * src/sync-engine.js (── Payload Hash (v6.11) ── section) — if the gate's
 * hashing changes, change it here too or the tests guard the wrong contract.
 */

// Supabase client construction in src/supabase.js reads env at import time.
// sync-leads.js imports it transitively. HARD-override (not ||=): the smoke
// test below actually invokes processProspect, and a shell that carries real
// credentials must never let those calls reach a live instance.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { processProspect, attributionColumnsComplete } from '../src/sync-leads.js';

// Duplicate of stableHash in src/sync-engine.js — see header comment.
function stableHash(obj) {
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = sortKeys(v[k]); return acc; }, {});
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(sortKeys(obj))).digest('hex');
}

test('identical content with different key order hashes identically', () => {
  const a = {
    cst_id: '12345',
    firstname: 'Pat',
    leads: [{ id: '9', disposition: 'Set', jobs: [{ jb_id: '1', status: 'RTP' }] }],
    nested: { zip: '33701', city: 'St. Petersburg' },
  };
  const b = {
    nested: { city: 'St. Petersburg', zip: '33701' },
    leads: [{ jobs: [{ status: 'RTP', jb_id: '1' }], disposition: 'Set', id: '9' }],
    firstname: 'Pat',
    cst_id: '12345',
  };
  assert.equal(stableHash(a), stableHash(b));
});

test('array order is content, not key-order jitter — different order differs', () => {
  const a = { leads: [{ id: '1' }, { id: '2' }] };
  const b = { leads: [{ id: '2' }, { id: '1' }] };
  assert.notEqual(stableHash(a), stableHash(b));
});

test('different content produces a different digest', () => {
  const a = { cst_id: '12345', leads: [{ id: '9', disposition: 'Set' }] };
  const b = { cst_id: '12345', leads: [{ id: '9', disposition: 'Sold' }] };
  assert.notEqual(stableHash(a), stableHash(b));
});

test('null / primitive / empty shapes hash deterministically', () => {
  assert.equal(stableHash({ a: null, b: [] }), stableHash({ b: [], a: null }));
  assert.notEqual(stableHash({ a: null }), stableHash({ a: '' }));
});

test('processProspect is callable with and without an opts argument', () => {
  // Signature back-compat smoke only: both call forms must get past argument
  // destructuring (no synchronous TypeError). The returned promise is not
  // awaited — with dummy env it rejects downstream on the null supabase
  // client, which is expected and swallowed here.
  const lead = { cst_id: 'test-smoke', leads: [] };
  const p1 = processProspect(lead, {});
  const p2 = processProspect(lead);
  const p3 = processProspect(lead, { payloadHash: 'abc123' });
  for (const p of [p1, p2, p3]) {
    assert.ok(p && typeof p.then === 'function');
    p.catch(() => {});
  }
});

// ─── Attribution-backfill hold (2026-09-04) ──────────────────────
//
// The gate skips a prospect whose LP payload is byte-identical. That proves LP
// has nothing new; it does NOT prove WE have finished writing our own columns.
// LP never bumps lastchangedon for columns we added, so an incomplete row's
// payload stays identical forever and an enforcing gate would freeze it NULL
// permanently — the same failure mode that forced the lp_branch_id
// backfill-on-skip, one level further up.
//
// Measured 2026-09-04: 214,285 of 237,747 lp_leads rows are still
// attribution-incomplete and 3,923 of those ALREADY carry a hash, so this is
// not hypothetical — it is what flipping SYNC_HASH_GATE_MODE=enforce would do
// on the next pass.
//
// sync-engine.js imports this predicate rather than restating it; these tests
// are what stop the two copies from drifting apart.

const completeRow = {
  set_by_name: 'Dana R', ever_confirmed: true, ever_sat: false, raw_lp_data: { cst_id: '1' },
};

test('a fully populated row is complete and may be hash-skipped', () => {
  assert.equal(attributionColumnsComplete(completeRow), true);
});

test('any single unpopulated attribution column holds the row back', () => {
  for (const col of ['set_by_name', 'ever_confirmed', 'ever_sat', 'raw_lp_data']) {
    assert.equal(attributionColumnsComplete({ ...completeRow, [col]: null }), false,
      `${col} null must disqualify the row from a hash skip`);
    assert.equal(attributionColumnsComplete({ ...completeRow, [col]: undefined }), false,
      `${col} absent must disqualify the row too`);
  }
});

test('falsy-but-populated values are complete — false and 0 are real answers', () => {
  // The bug this guards: a truthiness test would treat ever_sat=false as
  // "not yet written" and hold the row back forever, which is the opposite
  // failure — every never-sat lead reprocessed on every single pass.
  assert.equal(attributionColumnsComplete({ ...completeRow, ever_confirmed: false, ever_sat: false }), true);
  assert.equal(attributionColumnsComplete({ ...completeRow, set_by_name: '' }), true);
});

test('a missing row is not complete', () => {
  assert.equal(attributionColumnsComplete(null), false);
  assert.equal(attributionColumnsComplete(undefined), false);
  assert.equal(attributionColumnsComplete({}), false);
});
