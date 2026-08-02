/**
 * test-rate-limiter-cycle-decay.js — v1.3 decay of consecutive429Cycles.
 *
 * The defect this locks down: reportSuccess() was exported in v1.1 and wired
 * into ZERO of the 11 report429() call sites, so consecutive429Cycles only ever
 * incremented. It reached 5 in production, pinning currentPauseMs at the
 * 900000ms MAX_PAUSE_MS ceiling — every 429 then blacked out ALL GHL traffic
 * for 15 minutes and the agentic bot answered nothing for ~47 hours.
 *
 * Properties under test:
 *   - the counter still escalates the pause the way it always did;
 *   - it now steps back DOWN after a quiet CYCLE_DECAY_MS, ONE step per window
 *     (escalation degrades gracefully; it does not snap to 0 while GHL may
 *     still be throttling);
 *   - a fresh 429 inside the window restarts the full quiet period;
 *   - resetCycles() clears a pinned counter AND lifts a stuck pause;
 *   - from a pinned 5, the counter reaches 0 on its own within
 *     5 × CYCLE_DECAY_MS — which it never did before this change.
 *
 * Clock: CYCLE_DECAY_MS has a 60-SECOND FLOOR (Math.max(60000, env)), so the
 * decay window cannot be shrunk into test range via the env var. Date is mocked
 * instead — seeded to the real now, because the module captured its decay
 * stamps with the real clock at import time. setTimeout is left REAL so
 * acquireToken's fail-open path still resolves on its own.
 *
 * The limiter is a process singleton, so these tests share module state and
 * run in declaration order (node --test does this by default). resetCycles()
 * is used between cases that need a clean slate.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// Deliberately BELOW the 60s floor — case 1 asserts the clamp.
process.env.GHL_RATE_CYCLE_DECAY_MS = '200';
const DECAY_MS = 60000; // Math.max(60000, 200)

const {
  acquireToken,
  report429,
  reportSuccess,
  resetCycles,
  getRateLimiterStats,
} = await import('../src/ghl-rate-limiter.js');

// Seed the mocked clock at the real now so the module's import-time stamps
// (lastRefill, lastCycleDecayAt) stay in the past rather than ~1.7e12ms in the
// future, which would make every elapsed-time check negative.
mock.timers.enable({ apis: ['Date'], now: Date.now() });

// Jump the mocked clock forward by a full quiet window (plus a hair).
const quietWindow = (n = 1) => mock.timers.tick(DECAY_MS * n + 50);

// After report429() the limiter is PAUSED with pauseUntil up to 15 minutes out,
// so a bare acquireToken() would enqueue and block for the full 30s
// WAIT_TIMEOUT_MS. decayCycles() runs synchronously at the top of acquireToken
// (before the pause check), so a 250ms fail-open wait still drives exactly one
// decay evaluation. 250 is the minimum legal maxWaitMs — acquireToken clamps
// with Math.max(250, ...).
const evaluateDecay = () => acquireToken({ maxWaitMs: 250 });

const cycles = () => getRateLimiterStats().consecutive429Cycles;

test('five 429s pin currentPauseMs at the 15-minute MAX_PAUSE_MS ceiling', () => {
  resetCycles();
  for (let i = 0; i < 5; i++) report429();

  const stats = getRateLimiterStats();
  assert.equal(stats.consecutive429Cycles, 5);
  assert.equal(stats.currentPauseMs, 900000, 'pinned at MAX_PAUSE_MS');
  assert.equal(stats.paused, true);
  // v1.3 stats surface — what /n8n/rate-limiter/stats must now expose.
  assert.equal(stats.cycleDecayMs, DECAY_MS, 'env 200 clamped up to the 60s floor');
  assert.ok(typeof stats.last429At === 'number' && stats.last429At > 0);
  assert.ok(typeof stats.msSinceLast429 === 'number');
});

test('after a quiet window the counter steps down by exactly one, not five', async () => {
  // Continues from the previous test's pinned state of 5.
  assert.equal(cycles(), 5, 'precondition: still pinned at 5');

  quietWindow();
  await evaluateDecay();
  assert.equal(cycles(), 4, 'one step down after one quiet window');

  // Immediately again — inside the same window, so no second step.
  await evaluateDecay();
  await evaluateDecay();
  assert.equal(cycles(), 4, 'at most one step per CYCLE_DECAY_MS window');
});

test('a fresh 429 inside the window restarts the full quiet period', async () => {
  resetCycles();
  report429();
  report429();
  assert.equal(cycles(), 2);

  // Most of a window passes, then another 429 lands — that restamps both clocks.
  mock.timers.tick(DECAY_MS * 0.6);
  report429();
  assert.equal(cycles(), 3);

  // The remainder of the ORIGINAL window is not enough; the clock restarted.
  mock.timers.tick(DECAY_MS * 0.6);
  await evaluateDecay();
  assert.equal(cycles(), 3, 'no decay — the 429 restarted the quiet window');

  // A full fresh window does decay.
  quietWindow();
  await evaluateDecay();
  assert.equal(cycles(), 2, 'decays once the full window finally elapses');
});

test('resetCycles() clears a pinned counter and lifts a stuck pause', () => {
  resetCycles();
  for (let i = 0; i < 5; i++) report429();
  assert.equal(getRateLimiterStats().paused, true);
  assert.equal(cycles(), 5);

  const result = resetCycles();
  assert.deepEqual(result, { previous_cycles: 5, was_paused: true });

  const stats = getRateLimiterStats();
  assert.equal(stats.consecutive429Cycles, 0);
  assert.equal(stats.paused, false);
  assert.equal(stats.currentPauseMs, 300000, 'back to the BASE_PAUSE_MS floor');
});

test('regression: a pinned counter now reaches 0 on its own within 5 windows', async () => {
  resetCycles();
  for (let i = 0; i < 5; i++) report429();
  assert.equal(cycles(), 5);

  // PRE-v1.3 this loop could run forever: nothing decremented the counter and
  // reportSuccess() was called from nowhere. Bound it at exactly the 5 windows
  // the property claims.
  for (let i = 0; i < 5; i++) {
    quietWindow();
    await evaluateDecay();
  }

  assert.equal(cycles(), 0, 'decayed to 0 within 5 × CYCLE_DECAY_MS');

  // Further windows must not drive it negative.
  quietWindow();
  await evaluateDecay();
  assert.equal(cycles(), 0, 'floors at 0');
});

test('reportSuccess() still works for anyone who wires it later', () => {
  resetCycles();
  report429();
  report429();
  assert.equal(cycles(), 2);

  reportSuccess();
  assert.equal(cycles(), 0, 'retained v1.1 behavior — immediate reset to 0');

  resetCycles(); // leave the module clean
  mock.timers.reset();
});
