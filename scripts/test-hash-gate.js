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

import { processProspect } from '../src/sync-leads.js';

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
