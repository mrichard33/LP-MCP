/**
 * Tests — executor concurrency helpers (Phase 2)
 * scripts/test-executor-pool.js
 *
 *   node --test scripts/test-executor-pool.js
 *
 * Pure-function tests for runPool / groupByBatch — no DB, no network, no env.
 * Guards the two invariants Phase 2 relies on:
 *   - runPool never exceeds the concurrency cap and preserves result order.
 *   - groupByBatch puts all actions sharing a batch_id in ONE batch (so they
 *     never run concurrently) and sorts each batch by sequence_order.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runPool, groupByBatch } from '../src/actions/concurrency.js';

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

// ─── runPool ───────────────────────────────────────────────────────

test('runPool: runs every item and preserves result order by index', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7];
  const out = await runPool(items, 3, async (x) => {
    await tick(Math.random() * 5);
    return x * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
});

test('runPool: never exceeds the concurrency cap', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  await runPool(items, 4, async (x) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick(3);
    inFlight--;
    return x;
  });
  assert.ok(maxInFlight <= 4, `maxInFlight ${maxInFlight} exceeded cap 4`);
  assert.ok(maxInFlight >= 2, `pool did not actually parallelize (max ${maxInFlight})`);
});

test('runPool: concurrency 1 is fully serial (cap never exceeds 1)', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  await runPool([1, 2, 3], 1, async (x) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick(2);
    inFlight--;
    return x;
  });
  assert.equal(maxInFlight, 1);
});

test('runPool: empty input returns empty array, worker never called', async () => {
  let called = 0;
  const out = await runPool([], 4, async () => { called++; });
  assert.deepEqual(out, []);
  assert.equal(called, 0);
});

test('runPool: more workers than items still resolves correctly', async () => {
  const out = await runPool([1, 2], 8, async (x) => x + 1);
  assert.deepEqual(out, [2, 3]);
});

// ─── groupByBatch ──────────────────────────────────────────────────

test('groupByBatch: groups by batch_id and sorts each batch by sequence_order', () => {
  const actions = [
    { id: 1, batch_id: 'B', sequence_order: 2 },
    { id: 2, batch_id: 'A', sequence_order: 1 },
    { id: 3, batch_id: 'B', sequence_order: 0 },
    { id: 4, batch_id: 'A', sequence_order: 0 },
  ];
  const batches = groupByBatch(actions);
  assert.equal(batches.length, 2);
  const byFirstId = Object.fromEntries(batches.map((b) => [b[0].batch_id, b]));
  assert.deepEqual(byFirstId.A.map((a) => a.id), [4, 2]); // seq 0,1
  assert.deepEqual(byFirstId.B.map((a) => a.id), [3, 1]); // seq 0,2
});

test('groupByBatch: rows without batch_id are isolated singletons (s_<id>)', () => {
  const actions = [
    { id: 10, sequence_order: 0 },
    { id: 11, sequence_order: 0 },
    { id: 12, batch_id: 'X', sequence_order: 0 },
  ];
  const batches = groupByBatch(actions);
  // two singletons + one named batch = 3 groups, each singleton size 1
  assert.equal(batches.length, 3);
  const singletons = batches.filter((b) => b.length === 1 && !b[0].batch_id);
  assert.equal(singletons.length, 2);
});

test('groupByBatch: every input action appears exactly once across batches', () => {
  const actions = Array.from({ length: 9 }, (_, i) => ({
    id: i, batch_id: i % 3 === 0 ? 'G' : undefined, sequence_order: i,
  }));
  const batches = groupByBatch(actions);
  const flatIds = batches.flat().map((a) => a.id).sort((a, b) => a - b);
  assert.deepEqual(flatIds, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('groupByBatch: empty / nullish input → empty array', () => {
  assert.deepEqual(groupByBatch([]), []);
  assert.deepEqual(groupByBatch(undefined), []);
});
