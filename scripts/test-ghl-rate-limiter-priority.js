// scripts/test-ghl-rate-limiter-priority.js — v1.5 priority lane + token reserve.
//
// The defect this locks down, measured 2026-09-21: POST /intake/ap-resolve
// timed out on four consecutive probes at its 1200ms ceiling while the GHL
// search it makes measured 101-270ms. It was not waiting on GoHighLevel — the
// action executor was mid-batch and the two share this bucket. That window's
// logs read `20 executed ... [budget exhausted] (61464ms)` and
// `limiter alert sent — 12 token timeouts`.
//
// FIFO is the wrong discipline when the callers are not equals. An executor
// action that waits 30s retries next tick and loses nothing; a lead intake that
// waits 30s is a lead ActiveProspect gave up on, and Lead Perfection accepts
// `lognumber` only at AddLead and never again.
//
// Properties under test:
//   - a normal caller stops drawing at the reserve, so the reserve survives a
//     batch that would otherwise drain the bucket to zero;
//   - a high-priority caller takes the FAST path against that reserve — it
//     does not merely jump a queue it should never have joined;
//   - when both are queued, priority is released first even though it arrived
//     last, and normals stay queued while tokens sit below the reserve;
//   - the drainer wakes for a LONE priority waiter (gating on waitQueue alone
//     parked it until fail-open — the very failure this lane prevents);
//   - drainStuckWaiters clears both queues;
//   - the reserve cannot be configured so high that normal callers starve.
//
// Env is set BEFORE the import because the limiter reads its knobs at module
// load and is a process singleton. Capacity 10 / reserve 3 keeps the arithmetic
// readable; refill 600/min (one token per 100ms) keeps the waits in test range.

process.env.GHL_RATE_CAPACITY = '10';
process.env.GHL_RATE_REFILL_PER_MIN = '600';
process.env.GHL_RATE_RESERVE = '3';

import test from 'node:test';
import assert from 'node:assert/strict';

const { acquireToken, getRateLimiterStats, drainStuckWaiters } =
  await import('../src/ghl-rate-limiter.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Take tokens as a normal (batch-like) caller until the fast path closes. */
async function drainAsNormal(limit = 50) {
  let taken = 0;
  while (taken < limit) {
    const before = getRateLimiterStats().tokens;
    if (before <= 0) break;
    const settled = await Promise.race([
      acquireToken().then(() => 'got'),
      sleep(30).then(() => 'queued'),
    ]);
    if (settled === 'queued') break;
    taken++;
  }
  return taken;
}

test('the knobs under test are the ones configured', () => {
  const s = getRateLimiterStats();
  assert.equal(s.capacity, 10);
  assert.equal(s.reserveTokens, 3);
});

test('a normal caller stops at the reserve instead of draining to zero', async () => {
  // This is the half that keeps the fast path OPEN for an intake that has not
  // arrived yet. Without it, priority would only ever be a better place in a
  // queue — and a queue is already too slow.
  const taken = await drainAsNormal();
  const s = getRateLimiterStats();
  assert.equal(taken, 7, '10 capacity minus a 3-token reserve');
  assert.equal(s.tokens, 3, 'the reserve is intact');
  assert.equal(s.queueDepth, 1, 'the caller that could not draw is queued, not served');
});

test('a high-priority caller takes the fast path against that reserve', async () => {
  // The bucket is sitting at the reserve after the previous test. An intake
  // arriving now must be served immediately, not queued.
  const before = getRateLimiterStats();
  assert.ok(before.tokens > 0 && before.tokens <= before.reserveTokens + 1,
    `expected to be at/near the reserve, saw ${before.tokens}`);

  const settled = await Promise.race([
    acquireToken({ priority: 'high' }).then(() => 'got'),
    sleep(30).then(() => 'queued'),
  ]);
  assert.equal(settled, 'got', 'intake must never queue while the reserve holds tokens');
  assert.equal(getRateLimiterStats().priorityQueueDepth, 0);
  assert.ok(getRateLimiterStats().highAcquired >= 1, 'and it is counted as such');
});

test('a queued priority waiter is released before queued normals', async () => {
  drainStuckWaiters();
  // Drain to zero as priority, so nothing is left even below the reserve.
  for (let i = 0; i < 12; i++) {
    if (getRateLimiterStats().tokens <= 0) break;
    await acquireToken({ priority: 'high' });
  }
  assert.equal(getRateLimiterStats().tokens, 0);

  const order = [];
  const normals = [
    acquireToken().then(() => order.push('normal-a')),
    acquireToken().then(() => order.push('normal-b')),
  ];
  // Arrives LAST and must still be served FIRST.
  const high = acquireToken({ priority: 'high' }).then(() => order.push('high'));

  await Promise.race([high, sleep(1500)]);
  assert.equal(order[0], 'high', `priority went first (order: ${order.join(',')})`);
  assert.deepEqual(order.filter((o) => o.startsWith('normal')), [],
    'and normals stay queued while tokens sit below the reserve');

  drainStuckWaiters();
  await Promise.allSettled([...normals, high]);
});

test('the drainer wakes for a lone priority waiter', async () => {
  // Regression: ensureDrainer's interval was gated on `waitQueue.length > 0`,
  // so a priority waiter with no normal company sat until its fail-open
  // timeout — exactly the stall this lane exists to prevent.
  drainStuckWaiters();
  for (let i = 0; i < 12; i++) {
    if (getRateLimiterStats().tokens <= 0) break;
    await acquireToken({ priority: 'high' });
  }
  assert.equal(getRateLimiterStats().tokens, 0);
  assert.equal(getRateLimiterStats().queueDepth, 0, 'no normal waiters at all');

  const started = Date.now();
  const settled = await Promise.race([
    acquireToken({ priority: 'high' }).then(() => 'got'),
    sleep(2000).then(() => 'stalled'),
  ]);
  assert.equal(settled, 'got', 'released by refill, not by fail-open');
  assert.ok(Date.now() - started < 2000);
  assert.equal(getRateLimiterStats().highTimedOut, 0, 'and never as a timeout');
});

test('drainStuckWaiters clears both queues', async () => {
  for (let i = 0; i < 12; i++) {
    if (getRateLimiterStats().tokens <= 0) break;
    await acquireToken({ priority: 'high' });
  }
  const a = acquireToken();
  const b = acquireToken({ priority: 'high' });
  await sleep(10);
  const s = getRateLimiterStats();
  assert.ok(s.queueDepth >= 1 && s.priorityQueueDepth >= 1, 'both queues populated');

  const { cleared } = drainStuckWaiters();
  assert.ok(cleared >= 2);
  await Promise.all([a, b]); // both fail open rather than hanging
  const after = getRateLimiterStats();
  assert.equal(after.queueDepth, 0);
  assert.equal(after.priorityQueueDepth, 0);
});

test('an over-large reserve is clamped below capacity', async () => {
  // A reserve of capacity-or-more would mean no normal caller ever draws a
  // token, turning a safety margin into a total outage for batch work.
  process.env.GHL_RATE_CAPACITY = '10';
  process.env.GHL_RATE_RESERVE = '999';
  const fresh = await import(`../src/ghl-rate-limiter.js?clamp=${Date.now()}`);
  const s = fresh.getRateLimiterStats();
  assert.equal(s.reserveTokens, s.capacity - 1);
  assert.ok(s.reserveTokens < s.capacity, 'normal callers keep at least one token');
});

test('the cautious restart after a pause seeds ABOVE the reserve', async () => {
  // Regression, caught by test-ghl-rate-limiter-coverage.js going red:
  // the post-pause restart seeded two tokens flat. A normal caller needs tokens
  // above the reserve, so two against a reserve of three meant NO normal caller
  // could run until refill climbed past the reserve — the reserve stopped
  // meaning "keep a little back for intake" and started meaning "only intake
  // may run at all". A 429 recovery would have blocked all batch work.
  const { resetCycles, getRateLimiterStats: stats, acquireToken: acquire } =
    await import('../src/ghl-rate-limiter.js');
  resetCycles();  // same cautious-restart path isPaused() takes when a pause ends
  const s = stats();
  assert.ok(s.tokens > s.reserveTokens,
    `restart must leave normal callers something to draw: ${s.tokens} vs reserve ${s.reserveTokens}`);
  assert.equal(s.tokens, s.reserveTokens + 2, 'and exactly the two cautious tokens, above the reserve');

  const before = stats().totalAcquired;
  const settled = await Promise.race([
    acquire().then(() => 'got'),
    sleep(50).then(() => 'queued'),
  ]);
  assert.equal(settled, 'got', 'a normal caller runs immediately after a recovery');
  assert.equal(stats().totalAcquired, before + 1, 'on the fast path, not by failing open');
});
