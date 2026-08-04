/**
 * Guards for src/jobs/lp-report-recon.js (the pure comparison core).
 *
 * Invariants under guard:
 *   • An exact tie is ok with zero deltas — nothing invented, nothing lost.
 *   • toleranceCents forgives CENTS only, never a record-count delta.
 *   • The July-2026 named residual (2 records / $14,957.00) is consumed
 *     ONLY when it exactly explains the total delta — and is annotated in
 *     applied_exceptions, never silently swallowed.
 *   • Keys present on one side only still surface as deltas.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { compareBuckets, NAMED_RECON_EXCEPTIONS } from '../src/jobs/lp-report-recon.js';

test('exact tie passes with no deltas', () => {
  const side = { hoa: { count: 65, cents: 137922800 }, other_pending: { count: 297, cents: 700000000 } };
  const cmp = compareBuckets(side, structuredClone(side));
  assert.equal(cmp.ok, true);
  assert.deepEqual(cmp.deltas, []);
  assert.deepEqual(cmp.applied_exceptions, []);
});

test('cents inside tolerance pass; outside fail; counts are never tolerated', () => {
  const lhs = { hoa: { count: 65, cents: 137922850 } };
  const rhs = { hoa: { count: 65, cents: 137922800 } };
  assert.equal(compareBuckets(lhs, rhs, { toleranceCents: 100 }).ok, true);
  assert.equal(compareBuckets(lhs, rhs, { toleranceCents: 10 }).ok, false);

  const countOff = { hoa: { count: 66, cents: 137922800 } };
  assert.equal(compareBuckets(countOff, rhs, { toleranceCents: 1_000_000 }).ok, false);
});

test('named July-2026 residual: exact match consumed AND annotated', () => {
  const lhs = { ORL_MKT: { count: 2, cents: 1495700 } }; // 2 records / $14,957.00 over
  const rhs = { ORL_MKT: { count: 0, cents: 0 } };
  const cmp = compareBuckets(lhs, rhs, { namedExceptions: NAMED_RECON_EXCEPTIONS });
  assert.equal(cmp.ok, true);
  assert.deepEqual(cmp.applied_exceptions, ['SE_RESIDUAL_2026_07']);
  assert.equal(cmp.deltas.length, 1); // the delta stays VISIBLE in the trail
});

test('named residual does NOT consume a different delta', () => {
  const lhs = { ORL_MKT: { count: 2, cents: 1495800 } }; // $1 off the known residual
  const rhs = { ORL_MKT: { count: 0, cents: 0 } };
  const cmp = compareBuckets(lhs, rhs, { namedExceptions: NAMED_RECON_EXCEPTIONS });
  assert.equal(cmp.ok, false);
  assert.deepEqual(cmp.applied_exceptions, []);
});

test('one-sided keys surface as deltas', () => {
  const cmp = compareBuckets(
    { hoa: { count: 1, cents: 100 } },
    { excluded: { count: 1, cents: 100 } },
  );
  assert.equal(cmp.ok, false);
  assert.deepEqual(cmp.deltas.map((d) => d.key).sort(), ['excluded', 'hoa']);
});
