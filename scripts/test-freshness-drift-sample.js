/**
 * Drift probe sampling — scripts/test-freshness-drift-sample.js
 *
 * Locks in the 2026-10-07 fix in src/admin/data-freshness.js (checkFieldDrift).
 * Two junk lp_leads rows ('null', 'test-smoke', no created_at_lp) sorted first
 * and were sent to LP every 30 minutes; LP answered each with 500 "Execution
 * Timeout Expired" after ~30s, three tries apiece, all swallowed.
 *
 * NO REAL I/O: supabase, getLeadByLdsId and the circuit read are injected.
 *
 * Run: node --test scripts/test-freshness-drift-sample.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFieldDrift } from '../src/admin/data-freshness.js';

/** A chainable stand-in for the supabase query; records the filters it saw. */
function fakeSupabase(rows) {
  const seen = { not: [], order: null };
  const q = {
    from: () => q,
    select: () => q,
    is: () => q,
    not: (...args) => { seen.not.push(args); return q; },
    order: (...args) => { seen.order = args; return q; },
    limit: async () => ({ data: rows, error: null }),
  };
  return { db: q, seen };
}

/** An LP GetLead answer carrying one lead with the given flags. */
const lpAnswer = (id) => [{ leads: [{ id, sat: 'N', apptset: 'N', sold: 'N' }] }];

const row = (id) => ({ lp_lead_id: id, demo_completed: false, appointment_set: false, closed_won: false });

test('junk ids never reach LP, and probes use the fast path', async () => {
  const { db, seen } = fakeSupabase([row('null'), row('test-smoke'), row(''), row(null), row('581967'), row('581966')]);
  const calls = [];
  const res = await checkFieldDrift({
    deps: {
      supabase: db,
      getCircuitStatus: () => ({ circuitOpen: false }),
      getLeadByLdsId: async (id, opts) => { calls.push({ id, opts }); return lpAnswer(id); },
    },
  });
  assert.deepEqual(calls.map((c) => c.id), ['581967', '581966']);
  assert.ok(calls.every((c) => c.opts?.fast === true), 'every probe is one short try');
  assert.equal(res.sampled, 2);
  assert.equal(res.errors, 0);
  assert.deepEqual(res.unreadable, []);
  // Undated rows are filtered in the query and sorted last as a second line.
  assert.deepEqual(seen.not, [['created_at_lp', 'is', null]]);
  assert.equal(seen.order[1].nullsFirst, false);
});

test('an unreadable lead is counted and named, not silent', async () => {
  const { db } = fakeSupabase([row('581001'), row('581002'), row('581003')]);
  const res = await checkFieldDrift({
    deps: {
      supabase: db,
      getCircuitStatus: () => ({ circuitOpen: false }),
      getLeadByLdsId: async (id) => {
        if (id === '581001') throw new Error('LP API 500: Execution Timeout Expired');
        if (id === '581002') return [];          // LP answered, lead not in it
        return lpAnswer(id);
      },
    },
  });
  assert.equal(res.sampled, 1);
  assert.equal(res.errors, 2);
  assert.deepEqual(res.unreadable, ['581001', '581002']);
  assert.equal(res.status, 'ok');
});

test('only junk rows → empty, nothing sent to LP', async () => {
  const { db } = fakeSupabase([row('null'), row('test-smoke')]);
  let called = false;
  const res = await checkFieldDrift({
    deps: { supabase: db, getCircuitStatus: () => ({ circuitOpen: false }), getLeadByLdsId: async () => { called = true; } },
  });
  assert.equal(res.status, 'empty');
  assert.equal(called, false);
});
