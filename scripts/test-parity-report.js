/**
 * Live LP↔GHL parity report — scripts/test-parity-report.js
 *
 * The live scan is supabase+GHL bound; the diff CLASSIFICATION is pure and is
 * what this asserts (computeParity). start_time comparison uses the production
 * sameStartTime, so offset-spelling differences are treated as equal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.GHL_API_KEY = 'test-key';
const { computeParity } = await import('../src/admin/parity-report.js');

const SLOT = '2026-07-11T10:00:00-04:00';
const SLOT_UTC = '2026-07-11T14:00:00+00:00'; // same instant, different spelling

test('in-sync contact → no differences', () => {
  const lp = new Map([['c1', { lp_lead_id: 'L1', disposition_code: 'Set', start_time: SLOT }]]);
  const ghl = new Map([['c1', [{ appointment_id: 'a1', start_time: SLOT_UTC, status: 'new' }]]]);
  const r = computeParity(lp, ghl);
  assert.equal(r.counts.missing, 0);
  assert.equal(r.counts.orphan, 0);
  assert.equal(r.counts.status_mismatch, 0);
  assert.equal(r.counts.duplicate, 0);
});

test('LP expects, GHL absent → missing', () => {
  const lp = new Map([['c1', { lp_lead_id: 'L1', disposition_code: 'Cnf', start_time: SLOT }]]);
  const ghl = new Map();
  const r = computeParity(lp, ghl);
  assert.equal(r.counts.missing, 1);
  assert.equal(r.missing[0].contact_id, 'c1');
});

test('GHL has, LP does not → orphan', () => {
  const lp = new Map();
  const ghl = new Map([['c9', [{ appointment_id: 'a9', start_time: SLOT, status: 'confirmed' }]]]);
  const r = computeParity(lp, ghl);
  assert.equal(r.counts.orphan, 1);
  assert.equal(r.orphan[0].contact_id, 'c9');
});

test('LP Cnf but GHL still "new" → status_mismatch', () => {
  const lp = new Map([['c1', { lp_lead_id: 'L1', disposition_code: 'Cnf', start_time: SLOT }]]);
  const ghl = new Map([['c1', [{ appointment_id: 'a1', start_time: SLOT, status: 'new' }]]]);
  const r = computeParity(lp, ghl);
  assert.equal(r.counts.status_mismatch, 1);
  assert.equal(r.status_mismatch[0].ghl_status, 'new');
});

test('LP Cnf and GHL confirmed → clean (no mismatch)', () => {
  const lp = new Map([['c1', { lp_lead_id: 'L1', disposition_code: 'Cnf', start_time: SLOT }]]);
  const ghl = new Map([['c1', [{ appointment_id: 'a1', start_time: SLOT, status: 'confirmed' }]]]);
  const r = computeParity(lp, ghl);
  assert.equal(r.counts.status_mismatch, 0);
});

test('>1 active estimate for a contact → duplicate', () => {
  const lp = new Map([['c1', { lp_lead_id: 'L1', disposition_code: 'Set', start_time: SLOT }]]);
  const ghl = new Map([['c1', [
    { appointment_id: 'a1', start_time: SLOT, status: 'new' },
    { appointment_id: 'a2', start_time: SLOT, status: 'new' },
  ]]]);
  const r = computeParity(lp, ghl);
  assert.equal(r.counts.duplicate, 1);
  assert.deepEqual(r.duplicate[0].appointment_ids, ['a1', 'a2']);
});

test('LP time TBD (null start) → not flagged missing', () => {
  const lp = new Map([['c1', { lp_lead_id: 'L1', disposition_code: 'Set', start_time: null }]]);
  const ghl = new Map();
  const r = computeParity(lp, ghl);
  assert.equal(r.counts.missing, 0);
});
