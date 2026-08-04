/**
 * Guards for src/jobs/lp-report-facts.js — the JS mirror of the SQL facts
 * projection (scorecard_rebuild_facts in 2026-08-05_lp_report_facts.sql).
 *
 * Invariants under guard (handoff test #16, JS side):
 *   • expectedFacts equals independently-computed aggregates for both report
 *     types, at (market, branch, metric, bucket) grain.
 *   • The metrics PARTITION the raw rows: Σ facts value_count == row count
 *     and Σ facts cents == Σ raw cents, per report type — no row can vanish
 *     from or double into the facts.
 *   • dup_review rows land ONLY in dup_review_pending (ruled 2026-08-04 —
 *     never counted into Good Business), excluded rows only in
 *     pipeline_excluded.
 *
 * DB-side assertions (#17 retention across re-ingest, #18 two-day as_of_date
 * time series, is_current lockstep, corrupt-then-rebuild) live in
 * sql/verify/2026-08-05_lp_report_facts_smoke.sql — a BEGIN…ROLLBACK script
 * run against the live schema after the migration is applied.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { expectedFacts, factKey } from '../src/jobs/lp-report-facts.js';

const ROWS_A = [
  { market: 'ORL_MKT', branch_code_raw: 'ORL', net_cents: 100000, gross_cents: 120000 },
  { market: 'ORL_MKT', branch_code_raw: 'ORL', net_cents: 200000, gross_cents: 240000 },
  { market: 'ORL_MKT', branch_code_raw: 'LAKE', net_cents: 50000, gross_cents: 60000 },
  { market: 'FTLAU_MKT', branch_code_raw: 'BOCA', net_cents: 75000, gross_cents: 90000 },
];

const ROWS_B = [
  { market: 'ORL_MKT', branch_code_raw: 'ORL', bucket: 'hoa', total_gross_cents: 100000, dup_review: false },
  { market: 'ORL_MKT', branch_code_raw: 'ORL', bucket: 'hoa', total_gross_cents: 40000, dup_review: false },
  { market: 'SAR_MKT', branch_code_raw: 'SAR', bucket: 'other_pending', total_gross_cents: 50000, dup_review: false },
  { market: 'STPET_MKT', branch_code_raw: 'STPET', bucket: 'excluded', total_gross_cents: 0, dup_review: false },
  { market: 'JAX_MKT', branch_code_raw: 'JAX', bucket: 'other_pending', total_gross_cents: 70000, dup_review: true },
  { market: 'JAX_MKT', branch_code_raw: 'JAX', bucket: 'other_pending', total_gross_cents: 70000, dup_review: true },
];

test('Report A: net_sales + gross_sold per (market, branch), counts = jobs', () => {
  const facts = expectedFacts('jobs_by_milestone', ROWS_A);
  assert.equal(facts.size, 6); // 3 (market,branch) grains × 2 metrics

  const orlNet = facts.get(factKey({ market: 'ORL_MKT', branch_code_raw: 'ORL', metric: 'net_sales', bucket: null }));
  assert.deepEqual({ cents: orlNet.cents, count: orlNet.count }, { cents: 300000, count: 2 });
  const lakeGross = facts.get(factKey({ market: 'ORL_MKT', branch_code_raw: 'LAKE', metric: 'gross_sold', bucket: null }));
  assert.deepEqual({ cents: lakeGross.cents, count: lakeGross.count }, { cents: 60000, count: 1 });
  const bocaNet = facts.get(factKey({ market: 'FTLAU_MKT', branch_code_raw: 'BOCA', metric: 'net_sales', bucket: null }));
  assert.equal(bocaNet.cents, 75000);

  // Partition: each metric covers every row exactly once.
  const netCount = [...facts.values()].filter((f) => f.metric === 'net_sales').reduce((a, f) => a + f.count, 0);
  const netCents = [...facts.values()].filter((f) => f.metric === 'net_sales').reduce((a, f) => a + f.cents, 0);
  assert.equal(netCount, ROWS_A.length);
  assert.equal(netCents, ROWS_A.reduce((a, r) => a + r.net_cents, 0));
});

test('Report B: dup rows only in dup_review_pending, excluded only in pipeline_excluded', () => {
  const facts = expectedFacts('jobs_by_status', ROWS_B);

  const hoa = facts.get(factKey({ market: 'ORL_MKT', branch_code_raw: 'ORL', metric: 'good_business_open', bucket: 'hoa' }));
  assert.deepEqual({ cents: hoa.cents, count: hoa.count }, { cents: 140000, count: 2 });
  const dup = facts.get(factKey({ market: 'JAX_MKT', branch_code_raw: 'JAX', metric: 'dup_review_pending', bucket: null }));
  assert.deepEqual({ cents: dup.cents, count: dup.count }, { cents: 140000, count: 2 });
  const excl = facts.get(factKey({ market: 'STPET_MKT', branch_code_raw: 'STPET', metric: 'pipeline_excluded', bucket: 'excluded' }));
  assert.deepEqual({ cents: excl.cents, count: excl.count }, { cents: 0, count: 1 });

  // The dups' bucket never leaks into good_business_open.
  assert.equal(facts.get(factKey({ market: 'JAX_MKT', branch_code_raw: 'JAX', metric: 'good_business_open', bucket: 'other_pending' })), undefined);

  // Partition across ALL metrics: every raw row exactly once.
  const totalCount = [...facts.values()].reduce((a, f) => a + f.count, 0);
  const totalCents = [...facts.values()].reduce((a, f) => a + f.cents, 0);
  assert.equal(totalCount, ROWS_B.length);
  assert.equal(totalCents, ROWS_B.reduce((a, r) => a + r.total_gross_cents, 0));
});

test('unknown report type throws', () => {
  assert.throws(() => expectedFacts('sales_efficiency', []), /unknown report_type/);
});
