// node --test — pure scorecard-validation checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTieOut, checkNetIdentity, checkBounds, checkMonotonicity } from '../src/jobs/scorecard-validate.js';

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

test('checkBounds flags sales>demos and net_sales>gross', () => {
  const v = checkBounds({ market: 'A', gross_sales: 100, net_sales: 200, sales: 50, demos: 40, net_close: 10 });
  assert.ok(v.some((x) => x.detail.includes('net_sales')));
  assert.ok(v.some((x) => x.detail.includes('sales')));
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
