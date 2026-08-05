/**
 * Guards for src/jobs/lp-report-parse-source-cost.js — the Marketing
 * Sub-Source Cost Analysis 2 CSV parser (the control-total authority).
 *
 * Invariants under guard:
 *   • Column sums tie to caller-declared expected totals EXACTLY — a
 *     deliberate 1¢ mismatch fails the file closed (the §4 defect class).
 *   • GSA prints integer dollars on most rows and cents on some
 *     ('2797423.92') — both parse to exact cents.
 *   • Duplicate descr rows and blank-descr rows are KEPT (row grain).
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSourceCostCsv, computeSourceCostTotals, validateSourceCostCsv,
} from '../src/jobs/lp-report-parse-source-cost.js';

const HEADER = 'descr,NumRaw,NumSet,NumCnf,NumIssued,NumSat,NumSold,NumNetSold,GSA,NSA,MCost,WorkingAmount,EmpName,SDate,EDate,FullName,xbrn_id,xsrc_id,xsrs_id,xSortBy,CurrentDateTime,UseColor';

const row = (over = {}) => {
  const base = {
    descr: 'Canvass', NumRaw: '100', NumSet: '50', NumCnf: '40', NumIssued: '30', NumSat: '20',
    NumSold: '10', NumNetSold: '8', GSA: '250000', NSA: '200000', MCost: '0', WorkingAmount: '0',
    EmpName: 'mrichard5152', SDate: '1/1/2026', EDate: '8/5/2026', FullName: 'Mark Richard',
    xbrn_id: 'ALL', xsrc_id: 'ALL', xsrs_id: 'ALL', xSortBy: 'By Gross Sales',
    CurrentDateTime: '8/5/2026 10:31', UseColor: 'TRUE',
  };
  return HEADER.split(',').map((h) => ({ ...base, ...over })[h] ?? '').join(',');
};

const csv = (...rows) => [HEADER, ...rows].join('\n');

test('parse: integer-dollar and cents GSA both land as exact cents', () => {
  const { rows, header } = parseSourceCostCsv(csv(
    row({ GSA: '2797423.92', NSA: '1715246', MCost: '190828' }),
  ));
  assert.equal(rows[0].gsa_cents, 279742392);
  assert.equal(rows[0].nsa_cents, 171524600);
  assert.equal(rows[0].mcost_cents, 19082800);
  assert.equal(header.periodStart, '2026-01-01');
  assert.equal(header.periodEnd, '2026-08-05');
});

test('parse: duplicate descr rows and blank descr rows are kept', () => {
  const { rows } = parseSourceCostCsv(csv(
    row({ descr: 'Customer Referral' }),
    row({ descr: 'Customer Referral', NumRaw: '96' }),
    row({ descr: '' }),
  ));
  assert.equal(rows.length, 3);
  assert.equal(rows[2].sub_source, null);
  assert.deepEqual(rows.map((r) => r.row_num), [1, 2, 3]);
});

test('totals: sums are exact across rows', () => {
  const { rows } = parseSourceCostCsv(csv(row(), row({ GSA: '0.01', NumRaw: '1' })));
  const t = computeSourceCostTotals(rows);
  assert.equal(t.gsa_cents, 25000001);
  assert.equal(t.num_raw, 101);
});

test('validate: expected totals tie → ok; a 1¢ mismatch fails closed', () => {
  const parsed = parseSourceCostCsv(csv(row()));
  const good = validateSourceCostCsv(parsed, { gsa_cents: 25000000, num_sold: 10 });
  assert.equal(good.ok, true);
  const oneCent = validateSourceCostCsv(parsed, { gsa_cents: 25000001 });
  assert.equal(oneCent.ok, false);
  assert.equal(oneCent.violations[0].rule, 'control_total_mismatch');
  assert.deepEqual(oneCent.violations[0].detail, { key: 'gsa_cents', computed: 25000000, expected: 25000001 });
});

test('validate: without expected totals the computed sums stand (chunk guard is DB-side)', () => {
  const v = validateSourceCostCsv(parseSourceCostCsv(csv(row())));
  assert.equal(v.ok, true);
  assert.equal(v.totals.num_net_sold, 8);
});

test('validate: unknown control key fails closed', () => {
  const v = validateSourceCostCsv(parseSourceCostCsv(csv(row())), { bogus_key: 1 });
  assert.equal(v.ok, false);
  assert.equal(v.violations[0].rule, 'unknown_control_key');
});
