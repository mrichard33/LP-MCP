/**
 * scripts/test-outbound-lock-priority.js
 *
 * Unit coverage for shouldPreemptByPriority — the deterministic outbound-lock
 * arbitration rule (Mark Test repro, June 2026). Smaller priority value = higher
 * priority. A challenger preempts a live holder ONLY when both priorities are
 * finite and the challenger is strictly lower-numbered. This guarantees the
 * intended primary send wins regardless of which raced to INSERT first, while
 * keeping legacy first-come behaviour for callers without a priority.
 *
 * Pure-function test — no Supabase, no network.
 * Run: node --test scripts/test-outbound-lock-priority.js
 */

// supabase.js reads env at import time; outbound-locks imports it transitively.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldPreemptByPriority } from '../src/services/outbound-locks.js';

test('strictly-higher-priority challenger (lower number) preempts', () => {
  assert.equal(shouldPreemptByPriority(10, 60), true);  // agentic reply vs Lane-5 catch-all
  assert.equal(shouldPreemptByPriority(5, 10), true);
});

test('equal priority does NOT preempt (first-come holder keeps slot)', () => {
  assert.equal(shouldPreemptByPriority(10, 10), false);
});

test('lower-priority challenger (higher number) does NOT preempt', () => {
  assert.equal(shouldPreemptByPriority(60, 10), false);
  assert.equal(shouldPreemptByPriority(20, 15), false);
});

test('missing / non-finite priorities never preempt (legacy callers)', () => {
  assert.equal(shouldPreemptByPriority(undefined, 10), false);
  assert.equal(shouldPreemptByPriority(10, undefined), false);
  assert.equal(shouldPreemptByPriority(null, null), false);
  assert.equal(shouldPreemptByPriority(NaN, 10), false);
  assert.equal(shouldPreemptByPriority(10, NaN), false);
});
