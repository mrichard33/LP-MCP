// ─── Guard for the daily scorecard run — scripts/test-scorecard-run-guard.js ───
//
// These pin a defect that shipped and was caught only by watching production.
//
// The first version raced `computeGoalScorecard()` against a timeout and treated
// losing that race as failure. `Promise.race` does not cancel the loser, and
// there is no AbortController plumbed through lp-client, so on 2026-08-11 the
// live sequence was:
//
//   03:28:28  watchdog starts the run
//   03:30:30  deadline at 120s → "run FAILED (attempt 1/3)"
//   03:30:30  GroupMe paged: "this is a real failure, not a missed window"
//   03:34:04  the run finishes normally and writes all ten market rows
//
// Three things were wrong. The alert was false. The attempt was spent on a run
// that worked. And the `finally` released the in-flight lock at 120s while the
// work was still hammering LP, so the next 5-minute watchdog poll could stack a
// second run on the first.
//
// The invariant that matters: THE LOCK FOLLOWS THE WORK, NOT THE WAIT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunGuard, stalenessLagSellingDays } from '../src/jobs/goal-scorecard-daily.js';
import { resolveSellingCalendar } from '../src/selling-days.js';

/** Silent logger so the suite output stays readable. */
const quiet = { log() {}, warn() {}, error() {} };

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const guard = (over = {}) =>
  createRunGuard({ timeoutMs: 20, maxAttemptsPerDay: 3, log: quiet, ...over });

test('a run that finishes inside the deadline reports ok and records the day', async () => {
  const g = guard();
  assert.equal(await g.attempt('2026-08-11', 'test', async () => {}), 'ok');
  assert.equal(g.lastSuccessDate, '2026-08-11');
  assert.equal(g.busy, false);
});

test('a run that throws reports failed and leaves the day reclaimable', async () => {
  const g = guard();
  const outcome = await g.attempt('2026-08-11', 'test', async () => {
    throw new Error('LP exploded');
  });
  assert.equal(outcome, 'failed');
  assert.equal(g.lastSuccessDate, null, 'a failure must not claim the day');
});

test('REGRESSION: passing the deadline is "slow", NOT a failure', async () => {
  // The 2026-08-11 false alarm. The work is still running; saying "failed" here
  // is what paged GroupMe about a run that went on to succeed.
  const d = deferred();
  const g = guard();
  const outcome = await g.attempt('2026-08-11', 'test', () => d.promise);
  assert.equal(outcome, 'slow');
  d.resolve();
  await g.settled();
});

test('REGRESSION: the lock is HELD while a slow run is still working', async () => {
  // The serious half of the bug: `inFlight = false` ran in the finally of the
  // RACE, so a second watchdog poll could start a second concurrent run against
  // the same sick API.
  const d = deferred();
  const g = guard();

  assert.equal(await g.attempt('2026-08-11', 'first', () => d.promise), 'slow');
  assert.equal(g.busy, true, 'the run is still in flight after the deadline');

  let secondRan = false;
  const second = await g.attempt('2026-08-11', 'second', async () => { secondRan = true; });
  assert.equal(second, 'in_flight');
  assert.equal(secondRan, false, 'a second run must NOT stack on an in-flight one');

  d.resolve();
  await g.settled();
  assert.equal(g.busy, false, 'the lock releases when the WORK ends');
});

test('a slow run that later succeeds still claims the day, and costs one attempt', async () => {
  const d = deferred();
  const g = guard();

  assert.equal(await g.attempt('2026-08-11', 'test', () => d.promise), 'slow');
  assert.equal(g.lastSuccessDate, null, 'not successful yet — it is still running');
  assert.equal(g.attemptsOn('2026-08-11'), 1);

  d.resolve();
  await g.settled();
  assert.equal(g.lastSuccessDate, '2026-08-11', 'late success is still success');
  assert.equal(g.attemptsOn('2026-08-11'), 1, 'one run, one attempt — never double-counted');
});

test('attempts are capped per day, so a sick API cannot become a run-storm', async () => {
  const g = guard({ maxAttemptsPerDay: 2 });
  const fail = async () => { throw new Error('nope'); };
  assert.equal(await g.attempt('2026-08-11', 'a', fail), 'failed');
  assert.equal(await g.attempt('2026-08-11', 'b', fail), 'failed');
  assert.equal(await g.attempt('2026-08-11', 'c', fail), 'capped');
  assert.equal(g.attemptsOn('2026-08-11'), 2);
});

test('the attempt budget resets on a new ET day', async () => {
  const g = guard({ maxAttemptsPerDay: 1 });
  const fail = async () => { throw new Error('nope'); };
  assert.equal(await g.attempt('2026-08-11', 'a', fail), 'failed');
  assert.equal(await g.attempt('2026-08-11', 'b', fail), 'capped');
  assert.equal(await g.attempt('2026-08-12', 'c', fail), 'failed', 'a new day gets a fresh budget');
  assert.equal(g.attemptsOn('2026-08-11'), 0, 'yesterday is no longer the tracked day');
});

test('a rejected slow run does not leave an unhandled rejection or a stuck lock', async () => {
  const d = deferred();
  const g = guard();
  assert.equal(await g.attempt('2026-08-11', 'test', () => d.promise), 'slow');
  d.reject(new Error('LP timed out for real'));
  await g.settled();
  assert.equal(g.busy, false);
  assert.equal(g.lastSuccessDate, null);
});

// ── Staleness lag, in SELLING days ─────────────────────────────────────────
//
// The alert now says how far behind we are, not just that something is missing.
// One missed morning must not read like the Jul 31–Aug 4 five-day outage, and
// `sellingDaysElapsed` is inclusive of both endpoints — so the gap is one less
// than the count, which is exactly the sort of off-by-one that ships quietly.

const CAL = resolveSellingCalendar({
  SCORECARD_SELLING_DAYS: 'mon,tue,wed,thu,fri,sat',
  SCORECARD_HOLIDAYS: 'none',
});

test('data reaching the expected day is 0 behind, not 1', () => {
  assert.equal(stalenessLagSellingDays('2026-08-10', '2026-08-10', CAL), 0);
  // Ahead of expectation (a same-morning write) is still 0, never negative.
  assert.equal(stalenessLagSellingDays('2026-08-11', '2026-08-10', CAL), 0);
});

test('Sunday is not lateness', () => {
  // Sat 08-08 data, expected Mon 08-10. Sunday 08-09 is not a selling day, so
  // exactly one selling day was missed.
  assert.equal(stalenessLagSellingDays('2026-08-08', '2026-08-10', CAL), 1);
});

test('counts the real outage', () => {
  // Fri 08-07 data against Mon 08-10: Sat 08-08 and Mon 08-10 = 2.
  assert.equal(stalenessLagSellingDays('2026-08-07', '2026-08-10', CAL), 2);
});

test('no snapshot at all is null — a worse statement than zero', () => {
  assert.equal(stalenessLagSellingDays(null, '2026-08-10', CAL), null);
});
