/**
 * Tests — Duplicate-lead guard (src/duplicate-lead-guard.js)
 * scripts/test-duplicate-lead-guard.js
 *
 * Uses Node 18+ built-in test runner (`node:test`). Run with:
 *
 *   node --test scripts/test-duplicate-lead-guard.js
 *
 * Covers the two things that can silently break this guard:
 *   1. blockingReason() classification — the metrics split live_appointment
 *      vs recent_sale, so a misclassification hides one of the two causes.
 *   2. The fail-OPEN contract. This guard suppresses customer messaging; if a
 *      Supabase error ever started returning a truthy "block" instead of null,
 *      every cancellation would stop routing to S5.2 (~700 contacts/30d).
 *      The fail-open path is the whole safety argument, so it is asserted
 *      directly against an injected failing client rather than assumed.
 */

// Supabase client construction in src/supabase.js reads env at import time.
// Set harmless dummies so the module graph loads without a live config.
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test_dummy_key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { blockingReason, findBlockingLiveLead } from '../src/duplicate-lead-guard.js';

test('blockingReason classifies a live Set/Cnf appointment', () => {
  assert.equal(blockingReason({ disposition_code: 'Set' }), 'live_appointment');
  assert.equal(blockingReason({ disposition_code: 'Cnf' }), 'live_appointment');
});

test('blockingReason classifies a recent sale', () => {
  assert.equal(blockingReason({ disposition_code: 'Sale' }), 'recent_sale');
  assert.equal(blockingReason({ disposition_code: 'Sold' }), 'recent_sale');
});

test('blockingReason does not guess on an unexpected disposition', () => {
  assert.equal(blockingReason({ disposition_code: 'CXL' }), 'unknown');
  assert.equal(blockingReason({}), 'unknown');
  assert.equal(blockingReason(null), 'unknown');
});

test('a missing contact_id never blocks', async () => {
  assert.equal(await findBlockingLiveLead(null), null);
  assert.equal(await findBlockingLiveLead(''), null);
  assert.equal(await findBlockingLiveLead(undefined), null);
});

// ─── Fail-open contract ────────────────────────────────────────────────────
// findBlockingLiveLead closes over the module's supabase import, so these
// exercise the same code path by asserting the documented contract: any error
// shape reaching the guard maps to null (no block). A regression here would
// turn a bounded false-positive fix into a system-wide messaging outage.

test('a PostgREST error response fails open (returns null, not a block)', async () => {
  const failing = {
    from: () => failing,
    select: () => failing,
    eq: () => failing,
    or: () => failing,
    order: () => failing,
    limit: () => failing,
    maybeSingle: async () => ({ data: null, error: { message: 'boom' } }),
  };
  const { findBlockingLiveLeadWith } = await import('../src/duplicate-lead-guard.js');
  assert.equal(await findBlockingLiveLeadWith(failing, 'c1'), null);
});

test('a thrown client error fails open (returns null, not a block)', async () => {
  const throwing = {
    from: () => { throw new Error('connection reset'); },
  };
  const { findBlockingLiveLeadWith } = await import('../src/duplicate-lead-guard.js');
  assert.equal(await findBlockingLiveLeadWith(throwing, 'c1'), null);
});

test('a matching row is returned as the block', async () => {
  const row = {
    lp_lead_id: '571845',
    lead_source_detail: 'MVP Marketing',
    disposition_code: 'Set',
    appointment_set: true,
    appointment_date: '2099-01-01T14:00:00+00:00',
    updated_at_lp: '2026-09-01T16:20:15.323+00:00',
  };
  const ok = {
    from: () => ok,
    select: () => ok,
    eq: () => ok,
    or: () => ok,
    order: () => ok,
    limit: () => ok,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  const { findBlockingLiveLeadWith } = await import('../src/duplicate-lead-guard.js');
  const blocking = await findBlockingLiveLeadWith(ok, 'c1');
  assert.equal(blocking.lp_lead_id, '571845');
  assert.equal(blockingReason(blocking), 'live_appointment');
});

test('no matching row means no block', async () => {
  const empty = {
    from: () => empty,
    select: () => empty,
    eq: () => empty,
    or: () => empty,
    order: () => empty,
    limit: () => empty,
    maybeSingle: async () => ({ data: null, error: null }),
  };
  const { findBlockingLiveLeadWith } = await import('../src/duplicate-lead-guard.js');
  assert.equal(await findBlockingLiveLeadWith(empty, 'c1'), null);
});
