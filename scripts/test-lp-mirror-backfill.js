/**
 * LP mirror backfill — scripts/test-lp-mirror-backfill.js
 *
 * Covers the diff-gate that keeps this sweep from re-triggering the bulk-GHL
 * re-push storm lp-cohort-reconcile.js was built to avoid: it must emit
 * lp.disposition_changed ONLY for a lead that is new/disposition-changed/
 * appointment-changed AND has an upcoming appointment. The run loop itself is
 * supabase+LP-bound (integration surface); the emit DECISION is pure and is
 * what this asserts — classifyRecovery + apptDateChanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// No SUPABASE_*/GHL env needed — importing only the pure decision helpers.
const { classifyRecovery, apptDateChanged } = await import('../src/admin/lp-mirror-backfill.js');

const FUTURE = '2027-07-08T10:00:00+00:00'; // comfortably ahead
const PAST = '2020-01-01T10:00:00+00:00';

test('apptDateChanged: absence and equality semantics', () => {
  assert.equal(apptDateChanged(null, null), false);
  assert.equal(apptDateChanged(FUTURE, null), true);
  assert.equal(apptDateChanged(null, FUTURE), true);
  assert.equal(apptDateChanged(FUTURE, FUTURE), false);
  assert.equal(apptDateChanged(FUTURE, PAST), true);
  // same instant, different offset spelling → not a change
  assert.equal(apptDateChanged('2027-07-08T10:00:00+00:00', '2027-07-08T06:00:00-04:00'), false);
});

test('new upcoming lead → recovered + upcoming (emits)', () => {
  const r = classifyRecovery(null, { disposition_code: 'Cnf', appointment_date: FUTURE });
  assert.equal(r.recovered, true);
  assert.equal(r.upcoming, true);
  assert.equal(r.isNew, true);
});

test('unchanged lead → not recovered (silent upsert, no emit)', () => {
  const existing = { disposition_code: 'Set', appointment_date: FUTURE };
  const r = classifyRecovery(existing, { disposition_code: 'Set', appointment_date: FUTURE });
  assert.equal(r.recovered, false);
});

test('disposition change (Set→Cnf) → recovered (emits)', () => {
  const existing = { disposition_code: 'Set', appointment_date: FUTURE };
  const r = classifyRecovery(existing, { disposition_code: 'Cnf', appointment_date: FUTURE });
  assert.equal(r.recovered, true);
  assert.equal(r.dispChanged, true);
  assert.equal(r.upcoming, true);
});

test('appointment reschedule → recovered (emits)', () => {
  const existing = { disposition_code: 'Cnf', appointment_date: FUTURE };
  const r = classifyRecovery(existing, { disposition_code: 'Cnf', appointment_date: '2027-07-09T14:00:00+00:00' });
  assert.equal(r.recovered, true);
  assert.equal(r.apptChanged, true);
});

test('new lead with a PAST appointment → recovered but NOT upcoming (no emit)', () => {
  const r = classifyRecovery(null, { disposition_code: 'Cnf', appointment_date: PAST });
  assert.equal(r.recovered, true);
  assert.equal(r.upcoming, false); // willEmit = recovered && upcoming = false
});
