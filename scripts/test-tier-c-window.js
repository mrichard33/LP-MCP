/**
 * Tier C window guards — scripts/test-tier-c-window.js
 *
 * Tier C creates GHL contacts for a CLOSED historical window (2026-08-13..19).
 * Two things separate that from the forward-only intake sweep, and both are
 * load-bearing:
 *
 *   1. The window has an UPPER bound. makeIsWithinIntakeWindow is lower-bound
 *      only, which is correct for a sweep that should always run up to now.
 *      Measured 2026-08-29: a lookback deep enough to reach 2026-08-13 also
 *      picks up 21 unlinked "Data" leads created AFTER 2026-08-19, and some are
 *      fresh enough that shouldSuppressOutbound would let them through
 *      UN-suppressed — a backfill sending a speed-to-lead text it was never
 *      scoped to send. makeIntakeWindowGate is what stops that.
 *
 *   2. Nothing in the window may be created un-suppressed. Two independent
 *      guards cover it (run posture, and the age belt), and the point of
 *      testing both is that either alone is sufficient — so a future change
 *      that drops one does not silently arm the cohort.
 *
 * Pure functions only — no GHL I/O, no Supabase.
 *
 * Run: node scripts/test-tier-c-window.js
 */

import assert from 'node:assert';
import {
  makeIntakeWindowGate,
  makeIsWithinIntakeWindow,
  shouldSuppressOutbound,
  MAX_INTAKE_LOOKBACK_HOURS,
  DEFAULT_INTAKE_FRESH_HOURS,
} from '../src/services/lp-contact-backstop.js';
import { lookbackHoursFor, TIER_C_SINCE, TIER_C_UNTIL } from './backfill-tier-c-contacts.js';

const NOW = Date.parse('2026-08-29T18:00:00Z');
const lead = (iso) => ({ created_at_lp: iso });

// ─── the upper bound ─────────────────────────────────────────────
{
  const lookback = lookbackHoursFor(TIER_C_SINCE, NOW);
  const gate = makeIntakeWindowGate(lookback, new Date(TIER_C_UNTIL).toISOString(), NOW);

  assert.equal(gate(lead('2026-08-13T00:30:00Z')), true, 'first day of window is in');
  assert.equal(gate(lead('2026-08-16T12:00:00Z')), true, 'mid-window is in');
  assert.equal(gate(lead('2026-08-19T23:59:00Z')), true, 'last day of window is in');

  // The 21 leads the bound exists to exclude.
  assert.equal(gate(lead('2026-08-20T00:00:00Z')), false, 'upper bound is EXCLUSIVE');
  assert.equal(gate(lead('2026-08-25T09:00:00Z')), false, 'after the window is out');
  assert.equal(gate(lead('2026-08-29T17:00:00Z')), false, 'a lead from today is out');

  // Below the lookback floor.
  assert.equal(gate(lead('2026-08-12T23:00:00Z')), false, 'before the window is out');
  assert.equal(gate(lead('2024-01-01T00:00:00Z')), false, 'ancient is out');

  // Fails closed.
  assert.equal(gate(lead('not-a-date')), false, 'unparseable is out');
  assert.equal(gate(lead(null)), false, 'null created_at_lp is out');
}

// Without an upper bound the gate must behave exactly as before — this is what
// guarantees the change is additive and the forward sweep is untouched.
{
  const lookback = 72;
  const bounded = makeIntakeWindowGate(lookback, null, NOW);
  const legacy = makeIsWithinIntakeWindow(lookback, NOW);
  for (const iso of ['2026-08-29T17:00:00Z', '2026-08-27T00:00:00Z', '2026-08-01T00:00:00Z', 'garbage']) {
    assert.equal(bounded(lead(iso)), legacy(lead(iso)), `untilIso=null must match legacy gate for ${iso}`);
  }
}

// A malformed bound must throw rather than silently degrade to "no upper bound",
// which would widen the run.
assert.throws(
  () => makeIntakeWindowGate(408, 'not-a-date', NOW),
  /not a valid date/,
  'a bad untilIso must throw, never fall back to unbounded',
);

// ─── lookbackHoursFor ────────────────────────────────────────────
{
  const h = lookbackHoursFor('2026-08-13', NOW);
  assert.ok(h >= 400 && h <= 420, `expected ~408h to reach 2026-08-13, got ${h}`);
  assert.ok(h <= MAX_INTAKE_LOOKBACK_HOURS, 'must fit under the scan ceiling');

  assert.throws(() => lookbackHoursFor('2027-01-01', NOW), /future/, 'future --since must throw');
  assert.throws(() => lookbackHoursFor('nonsense', NOW), /not a valid date/, 'bad --since must throw');
  // Reaching past the ceiling must be a loud refusal, not a silent clamp: a
  // clamp would quietly run a narrower window than the operator asked for.
  assert.throws(() => lookbackHoursFor('2020-01-01', NOW), /ceiling/, 'past the ceiling must throw');
}

// ─── nothing in this window can be created un-suppressed ─────────
{
  const inWindow = ['2026-08-13T00:30:00Z', '2026-08-16T12:00:00Z', '2026-08-19T23:59:00Z'];

  for (const iso of inWindow) {
    // Guard 1 alone: the age belt, with the run posture OFF.
    const belt = shouldSuppressOutbound(lead(iso), { nowMs: NOW });
    assert.equal(belt.suppress, true, `${iso} must suppress on age alone`);
    assert.match(belt.reason, /^stale_/, `${iso} should suppress with a stale_ reason`);

    // Guard 2 alone: the run posture, with an artificially huge fresh window.
    const posture = shouldSuppressOutbound(lead(iso), {
      suppressOutbound: true, freshHours: Infinity, nowMs: NOW,
    });
    assert.equal(posture.suppress, true, `${iso} must suppress on run posture alone`);
    assert.equal(posture.reason, 'run_mode_backlog');
  }

  // Sanity: the belt is a real test, not one that passes for everything. A lead
  // inside freshHours does NOT suppress on age — which is exactly why the
  // upper bound above matters for the 21 post-window leads.
  const fresh = shouldSuppressOutbound(
    lead(new Date(NOW - 2 * 3600 * 1000).toISOString()),
    { nowMs: NOW, freshHours: DEFAULT_INTAKE_FRESH_HOURS },
  );
  assert.equal(fresh.suppress, false, 'a 2h-old lead is NOT suppressed by the age belt');
}

console.log('test-tier-c-window.js — all assertions passed');
