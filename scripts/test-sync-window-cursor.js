/**
 * Tests — v6.13 sync window cursor (overlap + wire format)
 * scripts/test-sync-window-cursor.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-sync-window-cursor.js
 *
 * The window helpers in src/sync-engine.js read env at module load and that
 * module starts scheduler/signal wiring on import, which a unit test must not
 * trigger. The two pure helpers are duplicated here; they MUST stay in sync
 * with formatLpWindowStart / the cursor arithmetic in resolveWindowStart
 * (── v6.13 sync window cursor ── section of src/sync-engine.js).
 *
 * The invariant these tests exist to protect: THE OVERLAP MUST EXCEED THE
 * LONGEST SWEEP. getLastSyncTimestamp() returns the last run's completed_at,
 * but a sweep READS across [started_at .. completed_at]. A lead changed while
 * the sweep was already past its page never lands in that run, so a cursor set
 * exactly at completed_at would skip it forever. The date-truncated window
 * masked this; a precise cursor exposes it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Duplicates of the helpers in src/sync-engine.js — see header comment.
function formatLpWindowStart(date, fmt = 'space') {
  const iso = date.toISOString().slice(0, 19);
  return fmt === 'iso' ? iso : iso.replace('T', ' ');
}
function cursorFor(lastSyncTime, overlapMin) {
  return new Date(lastSyncTime.getTime() - overlapMin * 60000);
}

test('wire format: space vs iso, seconds precision, no milliseconds', () => {
  const d = new Date('2026-08-18T20:27:47.071Z');
  assert.equal(formatLpWindowStart(d, 'space'), '2026-08-18 20:27:47');
  assert.equal(formatLpWindowStart(d, 'iso'), '2026-08-18T20:27:47');
  // LP is given whole seconds — a trailing ".071Z" must never reach the wire.
  assert.ok(!formatLpWindowStart(d).includes('.'));
  assert.ok(!formatLpWindowStart(d).endsWith('Z'));
});

test('overlap is subtracted, not added — the cursor moves BACKWARD', () => {
  const last = new Date('2026-08-18T20:27:47.000Z');
  const c = cursorFor(last, 60);
  assert.ok(c < last, 'cursor must precede the last sync time');
  assert.equal(c.toISOString(), '2026-08-18T19:27:47.000Z');
});

test('REGRESSION: a lead changed mid-sweep is still inside the next window', () => {
  // Sweep ran 20:05 -> 20:27 (22min). A lead changed at 20:10 was already
  // paged past, so it did NOT sync in that run. The next run's cursor must
  // still cover 20:10 or the change is lost permanently.
  const sweepStarted = new Date('2026-08-18T20:05:00.000Z');
  const sweepCompleted = new Date('2026-08-18T20:27:00.000Z');
  const changedMidSweep = new Date('2026-08-18T20:10:00.000Z');

  const exactCursor = cursorFor(sweepCompleted, 0);
  assert.ok(changedMidSweep < exactCursor,
    'sanity: a zero-overlap cursor would indeed strand the mid-sweep change');

  const safeCursor = cursorFor(sweepCompleted, 60);
  assert.ok(safeCursor <= changedMidSweep,
    'default 60min overlap must cover a change made mid-sweep');
  assert.ok(safeCursor <= sweepStarted,
    'default overlap must reach back past the start of the previous sweep');
});

test('overlap must exceed the longest observed sweep (22.5min on 2026-08-18)', () => {
  const OBSERVED_LONGEST_SWEEP_MIN = 22.5;
  const DEFAULT_OVERLAP_MIN = 60;
  assert.ok(DEFAULT_OVERLAP_MIN > OBSERVED_LONGEST_SWEEP_MIN,
    'default overlap must exceed the longest sweep or changes are dropped');
  // An overlap shorter than the sweep is the failure mode this guards.
  const completed = new Date('2026-08-18T20:27:00.000Z');
  const tooSmall = cursorFor(completed, 10);
  const started = new Date('2026-08-18T20:05:00.000Z');
  assert.ok(tooSmall > started,
    'a 10min overlap does NOT reach the start of a 22min sweep — unsafe');
});

test('cursor still narrows the window massively vs midnight truncation', () => {
  // 20:27Z with a 60min overlap: 1h window instead of 20h+ since midnight.
  const last = new Date('2026-08-18T20:27:00.000Z');
  const cursor = cursorFor(last, 60);
  const midnight = new Date('2026-08-18T00:00:00.000Z');
  const cursorSpanH = (last - cursor) / 3600000;
  const dateSpanH = (last - midnight) / 3600000;
  assert.equal(cursorSpanH, 1);
  assert.ok(dateSpanH > 20);
  assert.ok(dateSpanH / cursorSpanH > 20, 'expect >20x narrower at end of day');
});
