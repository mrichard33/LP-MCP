/**
 * test-prospect-split-detector.js — the LP prospect-split warehouse invariant.
 *
 * One ghl_contact_id whose lp_leads span more than one lp_prospect_id is a
 * person-level identity split: lp_prospect_id is the stable cross-system key, so
 * a split gives one human two identities and deleting the duplicate LEADS does
 * not clean it up.
 *
 * This check DETECTS ONLY — merging LP prospects is destructive and LP-side.
 * It follows checkJobDateInversion: hourly-guarded count against an env-tunable
 * accepted baseline, alerting only on growth.
 *
 * node:test. No DB, no network — the two pure pieces (classification and the
 * hourly cache guard) are exercised directly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key';

const {
  classifyProspectSplit,
  isProspectSplitCacheFresh,
  PROSPECT_SPLIT_BASELINE,
} = await import('../src/admin/data-freshness.js');

/** n synthetic split rows, worst-first. */
const rows = (n, prospects = 2) =>
  Array.from({ length: n }, (_, i) => ({ ghl_contact_id: `contact-${i}`, prospects }));

// ── baseline comparison ─────────────────────────────────────────────

test('the shipped default baseline is the measured number, not a guess', () => {
  // Measured 2026-09-04 over the 90-day window. If this changes, it must change
  // because someone re-measured — not because a test was failing.
  assert.equal(PROSPECT_SPLIT_BASELINE, 161);
});

test('at the baseline is ok — the accepted residual is not an alert', () => {
  const r = classifyProspectSplit(rows(161), 161);
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 161);
  assert.equal(r.delta, 0);
});

test('below the baseline is ok, with a negative delta', () => {
  const r = classifyProspectSplit(rows(150), 161);
  assert.equal(r.status, 'ok');
  assert.equal(r.delta, -11);
});

test('one above the baseline is a split — alert fires only on GROWTH', () => {
  const r = classifyProspectSplit(rows(162), 161);
  assert.equal(r.status, 'split');
  assert.equal(r.count, 162);
  assert.equal(r.delta, 1);
  assert.equal(r.baseline, 161);
});

test('an empty result set is ok, not an error', () => {
  const r = classifyProspectSplit([], 161);
  assert.equal(r.status, 'ok');
  assert.equal(r.count, 0);
  assert.deepEqual(r.sample, []);
  assert.equal(r.sample_capped, false);
});

test('a zero baseline makes any split an alert', () => {
  assert.equal(classifyProspectSplit([], 0).status, 'ok');
  assert.equal(classifyProspectSplit(rows(1), 0).status, 'split');
});

// ── sample capping (the alert must be actionable, not a bare count) ──

test('the sample names the affected contacts, worst-first', () => {
  const r = classifyProspectSplit([
    { ghl_contact_id: 'LSo4GLGF0PtdlN161XWq', prospects: 9 },
    { ghl_contact_id: 'lGQ0WjsMU2zmoq9MsVJH', prospects: 4 },
  ], 0);
  assert.equal(r.sample.length, 2);
  assert.deepEqual(r.sample[0], { ghl_contact_id: 'LSo4GLGF0PtdlN161XWq', prospects: 9 });
  assert.deepEqual(r.sample[1], { ghl_contact_id: 'lGQ0WjsMU2zmoq9MsVJH', prospects: 4 });
  assert.equal(r.sample_capped, false);
});

test('the sample is capped at 10 and flags that it was capped', () => {
  const r = classifyProspectSplit(rows(25), 0);
  assert.equal(r.count, 25);
  assert.equal(r.sample.length, 10);
  assert.equal(r.sample_capped, true);
});

test('exactly 10 is not flagged as capped', () => {
  const r = classifyProspectSplit(rows(10), 0);
  assert.equal(r.sample.length, 10);
  assert.equal(r.sample_capped, false);
});

test('a string count from the driver is normalized to a number', () => {
  const r = classifyProspectSplit([{ ghl_contact_id: 'c1', prospects: '3' }], 0);
  assert.equal(r.sample[0].prospects, 3);
});

// ── shape tolerance from runSQL ─────────────────────────────────────

test('a single non-array row is treated as one row', () => {
  const r = classifyProspectSplit({ ghl_contact_id: 'c1', prospects: 2 }, 0);
  assert.equal(r.count, 1);
});

test('null / undefined rows are an empty result, not a throw', () => {
  assert.equal(classifyProspectSplit(null, 161).count, 0);
  assert.equal(classifyProspectSplit(undefined, 161).count, 0);
  assert.equal(classifyProspectSplit(null, 161).status, 'ok');
});

// ── hourly cache guard ──────────────────────────────────────────────

test('no prior result → always re-scan', () => {
  assert.equal(isProspectSplitCacheFresh({ lastResult: null, lastCheckMs: Date.now(), nowMs: Date.now() }), false);
});

test('within the hour → serve the cache', () => {
  const now = Date.now();
  assert.equal(isProspectSplitCacheFresh({
    lastResult: { status: 'ok' }, lastCheckMs: now - 59 * 60 * 1000, nowMs: now,
  }), true);
});

test('past the hour → re-scan', () => {
  const now = Date.now();
  assert.equal(isProspectSplitCacheFresh({
    lastResult: { status: 'ok' }, lastCheckMs: now - 61 * 60 * 1000, nowMs: now,
  }), false);
});

test('exactly one hour → re-scan (the guard is strictly less-than)', () => {
  const now = Date.now();
  assert.equal(isProspectSplitCacheFresh({
    lastResult: { status: 'ok' }, lastCheckMs: now - 60 * 60 * 1000, nowMs: now,
  }), false);
});

test('force always bypasses the cache, even one second in', () => {
  const now = Date.now();
  assert.equal(isProspectSplitCacheFresh({
    force: true, lastResult: { status: 'ok' }, lastCheckMs: now - 1000, nowMs: now,
  }), false);
});

test('called with no arguments does not throw', () => {
  assert.equal(isProspectSplitCacheFresh(), false);
});
