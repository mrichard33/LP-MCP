// node --test — pure scorecard-validation checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTieOut, checkNetIdentity, checkBounds, checkMonotonicity, isRtpBasis } from '../src/jobs/scorecard-validate.js';

const reece = { market: 'REECE', leads: 100, sets: 100, issued: 60, net_issue: 60, demos: 40, sales: 10, net_close: 9, ko_count: 1, gross_sales: 1000, net_sales: 900, released_dollars: 500, working_dollars: 400 };
const a = { market: 'A_MKT', leads: 60, sets: 60, issued: 36, net_issue: 36, demos: 24, sales: 6, net_close: 5, ko_count: 1, gross_sales: 600, net_sales: 540, released_dollars: 300, working_dollars: 240 };
const b = { market: 'B_MKT', leads: 40, sets: 40, issued: 24, net_issue: 24, demos: 16, sales: 4, net_close: 4, ko_count: 0, gross_sales: 400, net_sales: 360, released_dollars: 200, working_dollars: 160 };

test('checkTieOut passes when Σ markets == REECE', () => {
  assert.deepEqual(checkTieOut([reece, a, b]), []);
});

test('checkTieOut flags a drifted column', () => {
  const v = checkTieOut([reece, { ...a, sales: 5 }, b]); // 5+4 ≠ 10
  assert.equal(v.length, 1);
  assert.equal(v[0].column, 'sales');
});

test('checkNetIdentity passes when buckets reconcile', () => {
  const row = { market: 'A', gross_sales: 1000, net_sales: 900, raw_inputs: { bucket_tally: { released_dollars: 500, working_dollars: 300, other_pending: 100, cancelled_dollars: 100 } } };
  assert.deepEqual(checkNetIdentity(row), []);
});

test('checkNetIdentity flags gross−cancelled mismatch and negative other', () => {
  const row = { market: 'A', gross_sales: 1000, net_sales: 950, raw_inputs: { bucket_tally: { released_dollars: 500, working_dollars: 300, other_pending: -50, cancelled_dollars: 100 } } };
  const v = checkNetIdentity(row);
  assert.ok(v.some((x) => x.detail.includes('gross')));
  assert.ok(v.some((x) => x.detail.includes('< 0')));
});

test('checkNetIdentity skips pre-bucket rows (no bucket_tally)', () => {
  assert.deepEqual(checkNetIdentity({ market: 'A', gross_sales: 1000, net_sales: 900, raw_inputs: {} }), []);
});

test('checkNetIdentity skips RTP-net rows (no released/working/cancel split applies)', () => {
  // A realigned row: net_sales is report RTP net, and any lingering bucket_tally is a stale v1
  // artifact that must NOT be net-identity-checked against the new basis.
  const row = { market: 'A', revenue_basis: 'rtp_net_by_milestone_date', gross_sales: 1000, net_sales: 900,
    raw_inputs: { bucket_tally: { released_dollars: 1, working_dollars: 1, other_pending: 1, cancelled_dollars: 999 } } };
  assert.deepEqual(checkNetIdentity(row), []);
});

test('checkBounds flags sales>demos and net_sales>gross', () => {
  const v = checkBounds({ market: 'A', gross_sales: 100, net_sales: 200, sales: 50, demos: 40, net_close: 10 });
  assert.ok(v.some((x) => x.detail.includes('net_sales')));
  assert.ok(v.some((x) => x.detail.includes('sales')));
});

// ── 2026-09-17: bounds is basis-aware ──────────────────────────────────────
//
// The two rows below are the actual violations from the 2026-09-16 alert
// ("bounds (2): net_sales 108052.52 > gross_sales 99585; net_sales 300433.55 >
// gross_sales 149641"). Both carried revenue_basis 'rtp_net_by_milestone_date'
// and reconciled true. On that basis net_sales is RELEASED revenue by
// milestone date while gross_sales stays funnel SOLD gross by sale date, so
// net exceeding gross is a timing outcome, not a defect.

test('checkBounds: real JAX_MKT 2026-09-16 rtp_ row no longer flags net>gross', () => {
  const row = {
    market: 'JAX_MKT', revenue_basis: 'rtp_net_by_milestone_date',
    gross_sales: 149641, net_sales: 300433.55, released_dollars: 300433.55, working_dollars: 0,
    sales: 12, demos: 30, net_close: 11,
  };
  assert.deepEqual(checkBounds(row), []);
});

test('checkBounds: real FTLAU_MKT 2026-09-16 rtp_ row no longer flags net>gross', () => {
  const row = {
    market: 'FTLAU_MKT', revenue_basis: 'rtp_net_by_milestone_date',
    gross_sales: 99585, net_sales: 108052.52, released_dollars: 108052.52, working_dollars: 0,
    sales: 8, demos: 22, net_close: 7,
  };
  assert.deepEqual(checkBounds(row), []);
});

test('checkBounds: COUNT bounds still apply on an rtp_ row', () => {
  // Basis-independent funnel facts — exempting the dollar bound must not
  // exempt these. A genuinely broken rtp_ row still pages.
  const row = {
    market: 'JAX_MKT', revenue_basis: 'rtp_net_by_milestone_date',
    gross_sales: 149641, net_sales: 300433.55,
    sales: 50, demos: 40, net_close: 60,
  };
  const v = checkBounds(row);
  assert.ok(v.some((x) => x.detail.includes('sales 50 > demos 40')));
  assert.ok(v.some((x) => x.detail.includes('net_close 60 > sales 50')));
  assert.ok(!v.some((x) => x.detail.includes('net_sales 300433.55 > gross_sales')),
    'dollar bound must not fire on an rtp_ row');
});

test('checkBounds: v1-basis rows KEEP the dollar bound', () => {
  // No revenue_basis at all — the pre-RTP shape. Nothing about this change
  // may weaken it.
  const v = checkBounds({ market: 'A', gross_sales: 1000, net_sales: 1200, sales: 5, demos: 10, net_close: 4 });
  assert.ok(v.some((x) => x.detail.includes('net_sales 1200 > gross_sales 1000')));
});

test('checkBounds: an explicitly non-rtp revenue_basis KEEPS the dollar bound', () => {
  const v = checkBounds({ market: 'A', revenue_basis: 'funnel_v1', gross_sales: 1000, net_sales: 1200, sales: 5, demos: 10, net_close: 4 });
  assert.ok(v.some((x) => x.detail.includes('net_sales')));
});

test('checkBounds: rtp_ row with net BELOW gross is silent either way', () => {
  // ORL_MKT 2026-09-16 — one of the five that passed only by timing accident.
  const row = {
    market: 'ORL_MKT', revenue_basis: 'rtp_net_by_milestone_date',
    gross_sales: 480841, net_sales: 227589.01, sales: 20, demos: 45, net_close: 18,
  };
  assert.deepEqual(checkBounds(row), []);
});

test('isRtpBasis matches the rtp_ prefix and nothing else', () => {
  assert.equal(isRtpBasis({ revenue_basis: 'rtp_net_by_milestone_date' }), true);
  assert.equal(isRtpBasis({ revenue_basis: 'rtp_gross_provisional' }), true);
  assert.equal(isRtpBasis({ revenue_basis: 'funnel_v1' }), false);
  assert.equal(isRtpBasis({ revenue_basis: null }), false);
  assert.equal(isRtpBasis({}), false);
  assert.equal(isRtpBasis(null), false);
});

test('checkNetIdentity and checkBounds agree on which rows are rtp_', () => {
  // The whole point of extracting isRtpBasis: these two exemptions must never
  // drift apart again. checkBounds skipping the dollar bound while
  // checkNetIdentity still ran (or vice versa) is the defect this fixes.
  const row = {
    market: 'A', revenue_basis: 'rtp_net_by_milestone_date',
    gross_sales: 100, net_sales: 900, sales: 1, demos: 2, net_close: 1,
    raw_inputs: { bucket_tally: { released_dollars: 1, working_dollars: 1, other_pending: 1, cancelled_dollars: 999 } },
  };
  assert.deepEqual(checkNetIdentity(row), []);
  assert.deepEqual(checkBounds(row), []);
});

test('checkMonotonicity flags a cumulative count drop', () => {
  const series = [
    { period_start: '2026-07-01', as_of_date: '2026-07-06', leads: 500, issued: 300, demos: 200, sales: 60, gross_sales: 1_500_000 },
    { period_start: '2026-07-01', as_of_date: '2026-07-07', leads: 480, issued: 320, demos: 210, sales: 65, gross_sales: 1_600_000 }, // leads dropped 500→480
  ];
  const v = checkMonotonicity(series);
  assert.equal(v.length, 1);
  assert.equal(v[0].column, 'leads');
});

test('checkMonotonicity passes a normal increasing series', () => {
  const series = [
    { period_start: '2026-07-01', as_of_date: '2026-07-06', leads: 500, issued: 300, demos: 200, sales: 60, gross_sales: 1_500_000 },
    { period_start: '2026-07-01', as_of_date: '2026-07-07', leads: 546, issued: 320, demos: 210, sales: 65, gross_sales: 1_600_000 },
  ];
  assert.deepEqual(checkMonotonicity(series), []);
});
