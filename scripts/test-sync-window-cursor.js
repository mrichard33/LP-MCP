/**
 * Tests — v6.13 sync window cursor + v6.14 Eastern window formatting
 * scripts/test-sync-window-cursor.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-sync-window-cursor.js
 *
 * The window helpers in src/sync-engine.js read env at module load and that
 * module starts scheduler/signal wiring on import, which a unit test must not
 * trigger. The pure helpers are duplicated here; they MUST stay in sync with
 * etDateString / etTimestampString / formatLpWindowStart and the cursor
 * arithmetic in resolveWindowStart (── v6.13 sync window cursor ── section of
 * src/sync-engine.js).
 *
 * TWO invariants are protected here.
 *
 * 1. THE OVERLAP MUST EXCEED THE LONGEST SWEEP. getLastSyncTimestamp() returns
 *    the last run's completed_at, but a sweep READS across
 *    [started_at .. completed_at]. A lead changed while the sweep was already
 *    past its page never lands in that run, so a cursor set exactly at
 *    completed_at would skip it forever. The date-truncated window masked this;
 *    a precise cursor exposes it.
 *
 * 2. EVERY WINDOW VALUE SENT TO LP IS EASTERN WALL CLOCK. LP evaluates its
 *    date windows in America/New_York. Formatting them from a UTC ISO string
 *    is correct for 20 hours a day and silently wrong for the other four: from
 *    20:00 ET the UTC calendar date is already TOMORROW, so the sweep asked LP
 *    for a window that had not begun yet. LP answers a future window with an
 *    empty 200 — not an error — so the sweep completed in seconds having
 *    scanned nothing, 96 consecutive times across 21:00-23:59 ET.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Duplicates of the helpers in src/sync-engine.js — see header comment.
function etDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function etTimestampString(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${p.year}-${p.month}-${p.day} ${hh}:${p.minute}:${p.second}`;
}
function formatLpWindowStart(date, fmt = 'space') {
  const ts = etTimestampString(date);
  return fmt === 'iso' ? ts.replace(' ', 'T') : ts;
}
function cursorFor(lastSyncTime, overlapMin) {
  return new Date(lastSyncTime.getTime() - overlapMin * 60000);
}

// ─── v6.14: Eastern formatting ───────────────────────────────────

test('window values are Eastern wall clock, not UTC', () => {
  // 2026-08-19 01:00Z is 2026-08-18 21:00 in ET (EDT, UTC-4).
  const d = new Date('2026-08-19T01:00:00.000Z');
  assert.equal(etDateString(d), '2026-08-18');
  assert.equal(etTimestampString(d), '2026-08-18 21:00:00');
  // The bug this replaces: the UTC slice reports the NEXT day.
  assert.equal(d.toISOString().slice(0, 10), '2026-08-19');
  assert.notEqual(etDateString(d), d.toISOString().slice(0, 10));
});

test('REGRESSION: the 20:00-ET boundary does not roll the window into the future', () => {
  // Every instant in the 21:00-23:59 ET band carries the NEXT UTC date. Under
  // the old code both `since` and `enddate` became tomorrow-in-Eastern, so LP
  // was asked for a window that had not started — it returned an empty page and
  // the sweep recorded a clean run having read nothing.
  const band = [
    '2026-08-20T01:00:00.000Z', // 21:00 ET
    '2026-08-20T02:30:00.000Z', // 22:30 ET
    '2026-08-20T03:59:00.000Z', // 23:59 ET
  ];
  for (const iso of band) {
    const d = new Date(iso);
    assert.equal(etDateString(d), '2026-08-19', `${iso} must resolve to Aug 19 ET`);
    assert.equal(d.toISOString().slice(0, 10), '2026-08-20',
      `${iso} sanity: the UTC date really is the next day`);
  }
  // 20:00 ET exactly — the first instant of the affected band.
  assert.equal(etDateString(new Date('2026-08-20T00:00:00.000Z')), '2026-08-19');
  // 19:59 ET — the last instant that was already correct under the old code.
  const before = new Date('2026-08-19T23:59:00.000Z');
  assert.equal(etDateString(before), before.toISOString().slice(0, 10));
});

test('DST: the offset is read from the zone, never hard-coded', () => {
  // January is EST (UTC-5); August is EDT (UTC-4). A fixed -4 or -5 would break
  // one of these.
  assert.equal(etTimestampString(new Date('2026-01-15T02:00:00.000Z')), '2026-01-14 21:00:00');
  assert.equal(etTimestampString(new Date('2026-08-15T02:00:00.000Z')), '2026-08-14 22:00:00');
});

test('ET midnight is emitted as 00:00:00, never 24:00:00', () => {
  // Some Intl implementations render midnight as hour '24' under hour12:false.
  const etMidnight = new Date('2026-08-19T04:00:00.000Z'); // 00:00 ET
  const ts = etTimestampString(etMidnight);
  assert.equal(ts, '2026-08-19 00:00:00');
  assert.ok(!ts.includes(' 24:'));
});

test('wire format: space vs iso, seconds precision, no milliseconds', () => {
  const d = new Date('2026-08-19T00:27:47.071Z'); // 20:27:47 ET on Aug 18
  assert.equal(formatLpWindowStart(d, 'space'), '2026-08-18 20:27:47');
  assert.equal(formatLpWindowStart(d, 'iso'), '2026-08-18T20:27:47');
  // LP is given whole seconds — a trailing ".071Z" must never reach the wire.
  assert.ok(!formatLpWindowStart(d).includes('.'));
  assert.ok(!formatLpWindowStart(d).endsWith('Z'));
});

test('the timestamped start and the date start describe the same ET day', () => {
  // resolveWindowStart guards on etDateString(cursor) < dateSince; both sides
  // must be computed in the same zone or the guard misfires nightly.
  const last = new Date('2026-08-20T02:00:00.000Z'); // 22:00 ET Aug 19
  const cursor = cursorFor(last, 60);               // 21:00 ET Aug 19
  assert.equal(etDateString(last), '2026-08-19');
  assert.equal(etDateString(cursor), '2026-08-19');
  assert.ok(!(etDateString(cursor) < etDateString(last)),
    'a same-ET-day cursor must not be rejected as predating the date window');
  assert.equal(formatLpWindowStart(cursor), '2026-08-19 21:00:00');
});

// ─── v6.13: overlap arithmetic ───────────────────────────────────

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

// ─── v6.14: the probe decision rule ──────────────────────────────
//
// Duplicate of the decision table at the end of resolveWindowStart. An empty
// LP response is NOT acceptance — the single-call probe this replaced treated
// "it didn't throw" as proof, which is exactly the signal a future-dated or
// mangled startdate produces.
function probeVerdict(baseRows, equivRows) {
  if (baseRows === 0) return 'date';   // inconclusive — nothing in the day window
  if (equivRows === 0) return 'date';  // LP did not honour the time component
  return 'timestamp';
}

test('probe: an empty response never counts as acceptance', () => {
  assert.equal(probeVerdict(1, 1), 'timestamp', 'both windows return rows — format proven');
  assert.equal(probeVerdict(1, 0), 'date', 'date window has rows, timestamped equivalent does not');
  assert.equal(probeVerdict(0, 0), 'date', 'empty day window proves nothing');
  assert.equal(probeVerdict(0, 1), 'date', 'baseline empty is inconclusive regardless');
});
