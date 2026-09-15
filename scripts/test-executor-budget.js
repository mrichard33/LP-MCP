/**
 * Executor run-budget regression tests — scripts/test-executor-budget.js
 *
 * 2026-09-15 — EXECUTOR_RUN_BUDGET_MS (50s) was checked ONLY at the top of the
 * claim loop in executeActions, so a chunk that started under budget ran
 * straight past it: 64,552ms observed against a 50,000ms budget. That overrun
 * pushes the executor past the 60s scheduler cadence, which is what produced
 * "[DecisionEngineHeartbeat] FAILOVER — firing processEvents (57s stale)".
 *
 * The fix makes runPool deadline-aware. Two properties have to hold together,
 * and getting either wrong is worse than the original bug:
 *
 *   - Work already in flight ALWAYS finishes. shouldStop is checked before a
 *     runner claims its next item, never mid-item, so no GHL or LP write is
 *     ever cut in half.
 *   - Work never started is RELEASED to 'pending', not stranded in 'executing'.
 *     reaper.js classes create_task, create_lp_lead and lp_callback_requeue as
 *     NON_IDEMPOTENT and DROPS them on stall rather than retrying, so leaving a
 *     claimed-but-untouched row for the reaper silently loses it ten minutes
 *     later. Releasing is exact: the row was never executed.
 *     retry_count is deliberately untouched — nothing was attempted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runPool } from '../src/actions/concurrency.js';

const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

// ─── runPool: deadline behavior ────────────────────────────────────────

test('runPool stops claiming new items once shouldStop goes true', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const started = [];
  let stop = false;

  await runPool(items, 2, async (x) => {
    started.push(x);
    await tick(2);
    if (started.length >= 4) stop = true;   // budget "expires" mid-run
    return x;
  }, { shouldStop: () => stop });

  assert.ok(started.length < items.length,
    `the pool must stop dispatching, but it ran all ${items.length} items`);
  assert.ok(started.length >= 4, 'it must not stop before the budget actually expired');
});

test('runPool reports exactly the items it never started', async () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'];
  const started = [];
  let notStarted = null;
  let stop = false;

  await runPool(items, 1, async (x) => {
    started.push(x);
    if (started.length === 2) stop = true;
    return x;
  }, { shouldStop: () => stop, onNotStarted: (rest) => { notStarted = rest; } });

  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(notStarted, ['c', 'd', 'e', 'f'],
    'every unstarted item must be reported, or the executor cannot release it and it is lost to the reaper');
  assert.equal(started.length + notStarted.length, items.length,
    'started + notStarted must account for every item — a gap here is a dropped action');
});

test('every item that starts also finishes — shouldStop never interrupts one', async () => {
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const started = [];
  const finished = [];
  let stop = false;

  const out = await runPool(items, 3, async (x) => {
    started.push(x);
    // Flip the budget while several items are mid-flight, which is the real
    // race: the check happens between items, never inside one.
    if (started.length === 3) stop = true;
    await tick(4);
    finished.push(x);
    return x;
  }, { shouldStop: () => stop });

  assert.deepEqual(finished.sort(), started.sort(),
    'an action cut off mid-flight is a half-done GHL or LP write with no record of it — every started item must complete');
  assert.ok(started.length >= 3 && started.length < items.length,
    `expected a partial run, got ${started.length} of ${items.length}`);
  for (const x of started) {
    assert.equal(out[items.indexOf(x)], x, 'a completed item must still report its result by index');
  }
});

test('unstarted indices come back as holes, so every consumer must guard', async () => {
  // Caught during review of this very change: executeActions tallies
  // `for (const br of batchResults) for (const r of br)`, which throws
  // "undefined is not iterable" the first time the budget holds a batch back.
  const started = [];
  let stop = false;

  const out = await runPool([1, 2, 3, 4, 5, 6], 1, async (x) => {
    started.push(x);
    if (started.length === 2) stop = true;
    return { status: 'completed', x };
  }, { shouldStop: () => stop });

  assert.equal(out.length, 6, 'the array keeps its full length so results stay index-aligned');
  assert.equal(out[2], undefined, 'an unstarted index is a hole, not a result');
  assert.ok(out.slice(2).every((r) => r === undefined),
    'every unstarted index is a hole — iterating them without a guard crashes the run');
  assert.equal(out.filter(Boolean).length, 2, 'only the two that ran have results');
});

test('onNotStarted is not called when the pool runs to completion', async () => {
  let called = false;
  const out = await runPool([1, 2, 3], 2, async (x) => x * 2, {
    shouldStop: () => false,
    onNotStarted: () => { called = true; },
  });
  assert.deepEqual(out, [2, 4, 6]);
  assert.equal(called, false, 'a clean run has nothing to release');
});

test('runPool without opts behaves exactly as before', async () => {
  const out = await runPool([1, 2, 3], 2, async (x) => x + 1);
  assert.deepEqual(out, [2, 3, 4],
    'the return value stays a plain results-by-index array — callers deep-equal it');
});

// ─── releaseClaimedActions: the write ──────────────────────────────────

/** Minimal supabase stub recording the update chain. */
function supabaseStub({ error = null } = {}) {
  const seen = {};
  const chain = {
    from(table) { seen.table = table; return chain; },
    update(patch) { seen.patch = patch; return chain; },
    in(col, vals) { seen.inCol = col; seen.inVals = vals; return chain; },
    eq(col, val) { seen.eqCol = col; seen.eqVal = val; return Promise.resolve({ error }); },
  };
  return { supabase: chain, seen };
}

const { releaseClaimedActions } = await import('../src/actions/index.js');

test('unstarted rows go back to pending, guarded on still being executing', async () => {
  const { supabase, seen } = supabaseStub();
  const n = await releaseClaimedActions(
    [{ id: 11, action_type: 'create_lp_lead' }, { id: 12, action_type: 'add_tag' }],
    { supabase },
  );

  assert.equal(n, 2);
  assert.equal(seen.table, 'agent_actions');
  assert.equal(seen.patch.status, 'pending',
    'a row that was never executed belongs back in the queue, not in executing for the reaper to DROP');
  assert.deepEqual(seen.inVals, [11, 12]);
  assert.equal(seen.eqCol, 'status');
  assert.equal(seen.eqVal, 'executing',
    'the eq(status, executing) guard means a row another worker already advanced is left alone');
});

test('retry_count is never touched — nothing was attempted', async () => {
  const { supabase, seen } = supabaseStub();
  await releaseClaimedActions([{ id: 1 }], { supabase });

  assert.equal('retry_count' in seen.patch, false,
    'burning a retry for work that never ran would exhaust the budget of an action nobody tried');
  assert.equal('last_error' in seen.patch, false, 'and there is no error to record');
});

test('a release failure is fail-soft — the row just stays for the reaper', async () => {
  const { supabase } = supabaseStub({ error: { message: 'connection reset' } });
  const n = await releaseClaimedActions([{ id: 1 }], { supabase });
  assert.equal(n, 0,
    'a failed release must not be counted as released; leaving the row in executing is the pre-existing path, never worse');
});

test('a thrown release is fail-soft too', async () => {
  const boom = { from() { throw new Error('boom'); } };
  const n = await releaseClaimedActions([{ id: 1 }], { supabase: boom });
  assert.equal(n, 0, 'the budget path must never be able to throw out of executeActions');
});

test('nothing to release is a no-op with no write', async () => {
  let touched = false;
  const spy = { from() { touched = true; throw new Error('should not be called'); } };
  assert.equal(await releaseClaimedActions([], { supabase: spy }), 0);
  assert.equal(await releaseClaimedActions(undefined, { supabase: spy }), 0);
  assert.equal(await releaseClaimedActions([{ id: null }], { supabase: spy }), 0);
  assert.equal(touched, false, 'an empty release must not issue an unbounded UPDATE');
});
