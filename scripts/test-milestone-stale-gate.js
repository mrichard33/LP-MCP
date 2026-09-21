/**
 * scripts/test-milestone-stale-gate.js
 *
 * Pure unit tests for the milestone stale-fire gate — no database, no network.
 *
 * The thing being defended: lp-milestone-* tags trigger the C.x customer journey
 * workflows. On 2026-09-19, job 54595 (Cancelled) fired lp-milestone-measure for
 * a Measure dated 2025-10-02 on contact Ham2AIBSkJcBsZ42YDmB, after a late
 * prospect_propagated link. With C.x live that is a customer message about a
 * cancelled job, nearly a year after the fact.
 *
 * Two independent reasons to hold a tag, and one deliberate non-reason:
 *   job_dead           — the job is in LOST_JOB_STATUSES, at any age
 *   older_than_max_age — the completion is older than the window
 *   (a WON job is NOT a reason) — a fresh Completion on a Paid In Full job is
 *   exactly the beat the customer should hear about.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  staleFireVerdict, staleFireMode, staleFireDays,
} from '../src/milestone-stale-gate.js';

const NOW = new Date('2026-09-21T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const verdict = (over) => staleFireVerdict({ now: NOW, ...over });

// ─── dead jobs: stale at ANY age ─────────────────────────────────────

test('a Cancelled job is stale even when the milestone is fresh today', () => {
  const v = verdict({ actDate: daysAgo(0), jobStatus: 'Cancelled' });
  assert.deepEqual(v, { stale: true, reason: 'job_dead' });
});

test('every LOST status gates the tag, regardless of date', () => {
  for (const status of ['Cancelled', 'Cancelled By Mgt', 'Dead Deal', 'Sent To Attorney', 'Credit Decline']) {
    const v = verdict({ actDate: daysAgo(1), jobStatus: status });
    assert.deepEqual(v, { stale: true, reason: 'job_dead' }, status);
  }
});

test('the 2026-09-19 incident: job 54595 Cancelled, Measure dated 2025-10-02', () => {
  const v = verdict({ actDate: '2025-10-02', jobStatus: 'Cancelled' });
  assert.equal(v.stale, true);
  assert.equal(v.reason, 'job_dead', 'dead is reported before age — it is the stronger signal');
});

test('job status is trimmed and whitespace does not smuggle a tag through', () => {
  assert.equal(verdict({ actDate: daysAgo(1), jobStatus: '  Cancelled  ' }).stale, true);
});

// ─── a WON job still fires a FRESH milestone ─────────────────────────

test('a Paid In Full job 2 days ago still fires — the win IS the beat', () => {
  const v = verdict({ actDate: daysAgo(2), jobStatus: 'Paid In Full' });
  assert.deepEqual(v, { stale: false, reason: 'fresh', ageDays: 2 });
});

test('a Paid In Full job 400 days ago is gated on AGE, not on being won', () => {
  const v = verdict({ actDate: daysAgo(400), jobStatus: 'Paid In Full' });
  assert.equal(v.stale, true);
  assert.equal(v.reason, 'older_than_max_age');
  assert.equal(v.ageDays, 400);
});

// ─── the age window ──────────────────────────────────────────────────

test('31 days is stale and 29 days is fresh against the 30-day default', () => {
  assert.equal(verdict({ actDate: daysAgo(31), jobStatus: 'Awaiting Product' }).stale, true);
  assert.equal(verdict({ actDate: daysAgo(29), jobStatus: 'Awaiting Product' }).stale, false);
});

test('exactly at the limit is NOT stale — the window is inclusive', () => {
  assert.equal(verdict({ actDate: daysAgo(30), jobStatus: 'Awaiting Product' }).stale, false);
});

test('maxAgeDays is honoured when passed explicitly', () => {
  assert.equal(verdict({ actDate: daysAgo(10), jobStatus: 'Awaiting Product', maxAgeDays: 7 }).stale, true);
  assert.equal(verdict({ actDate: daysAgo(10), jobStatus: 'Awaiting Product', maxAgeDays: 90 }).stale, false);
});

// ─── unreadable input never gates ────────────────────────────────────

test('an unparseable date is NOT stale — unreadable must never suppress a customer beat', () => {
  for (const bad of ['not-a-date', '', null, undefined]) {
    const v = verdict({ actDate: bad, jobStatus: 'Awaiting Product' });
    assert.deepEqual(v, { stale: false, reason: 'no_date' }, String(bad));
  }
});

test('a missing job status is not a dead job', () => {
  assert.equal(verdict({ actDate: daysAgo(1), jobStatus: undefined }).stale, false);
  assert.equal(verdict({ actDate: daysAgo(1), jobStatus: null }).stale, false);
});

// ─── mode and window parsing ─────────────────────────────────────────

test('the mode defaults to shadow and never throws on garbage', () => {
  const prior = process.env.MILESTONE_STALE_FIRE_MODE;
  try {
    delete process.env.MILESTONE_STALE_FIRE_MODE;
    assert.equal(staleFireMode(), 'shadow', 'unset');
    process.env.MILESTONE_STALE_FIRE_MODE = 'banana';
    assert.equal(staleFireMode(), 'shadow', 'garbage');
    process.env.MILESTONE_STALE_FIRE_MODE = ' ENFORCE ';
    assert.equal(staleFireMode(), 'enforce');
    process.env.MILESTONE_STALE_FIRE_MODE = 'off';
    assert.equal(staleFireMode(), 'off');
  } finally {
    if (prior === undefined) delete process.env.MILESTONE_STALE_FIRE_MODE;
    else process.env.MILESTONE_STALE_FIRE_MODE = prior;
  }
});

test('the window defaults to 30 days and rejects nonsense rather than gating everything', () => {
  const prior = process.env.MILESTONE_STALE_FIRE_DAYS;
  try {
    delete process.env.MILESTONE_STALE_FIRE_DAYS;
    assert.equal(staleFireDays(), 30, 'unset');
    for (const bad of ['banana', '0', '-5', '']) {
      process.env.MILESTONE_STALE_FIRE_DAYS = bad;
      assert.equal(staleFireDays(), 30, bad);
    }
    process.env.MILESTONE_STALE_FIRE_DAYS = '90';
    assert.equal(staleFireDays(), 90);
  } finally {
    if (prior === undefined) delete process.env.MILESTONE_STALE_FIRE_DAYS;
    else process.env.MILESTONE_STALE_FIRE_DAYS = prior;
  }
});
