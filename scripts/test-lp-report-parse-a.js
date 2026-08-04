/**
 * Guards for src/jobs/lp-report-parse-a.js — "Jobs by Milestone Date" (RTP/Actual).
 *
 * Invariants under guard:
 *   • Money-column order is DERIVED from the printed column header (the first
 *     production PDF printed Net|Gross|Paid|Balance where the original spec
 *     assumed Gross|Net|Paid|Balance — hardcoding would silently transpose
 *     net and gross while every tie still passed). An unrecognizable header
 *     fails money_columns_unrecognized — never a guessed assignment.
 *   • Detail rows carry exact CENTS; the rep-subtotal tie is EXACT (the
 *     double-count guard) and the footer tie is ±1¢. Money may print with
 *     or without cents.
 *   • The period line parses in both renderings: long-form prose
 *     ('from Monday, August 3, 2026 through …') and M/D/YYYY.
 *   • A misclassified line (subtotal counted as detail, detail counted
 *     twice) breaks a validation gate — the file can NEVER pass while a
 *     row leaked.
 *   • Truncated files (no footer) and wrong-parameter runs (not RTP/Actual)
 *     are rejected, not partially ingested.
 *   • Branch → market roll-up follows lp_branch_market_map (BOCA→FTLAU_MKT).
 *
 * Golden-file assertions (row count 288, net $7,502,745.76, Orlando
 * 1,158,424.00, Fort Lauderdale roll-up 135,317.08) run ONLY when the
 * redacted fixture exists — see scripts/fixtures/lp-reports/README.md.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseJobsByMilestone, validateJobsByMilestone, sumNetByMarket, deriveMoneyColumnOrder,
} from '../src/jobs/lp-report-parse-a.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/lp-reports/report-a-jobs-by-milestone.txt');

// Mirrors the real scheduled-run layout captured from the first production
// email (2026-08-04): long-form period prose, two-line column header with the
// branch column labelled 'Mkt', money printed Net | Gross | Paid | Balance.
const SYNTHETIC = `Reece Windows & Doors
Jobs By Milestone Date
For Jobs with the Milestone 'RTP'
from Wednesday, July 1, 2026 through Friday, July 31, 2026
Sort By: Sales Rep
Mode: Actual
Job                                          Contract                      Net    Total    Total   Balance
Number   Customer Name   Address   City       Date       RTP    Mkt  Product    Amount   Gross     Paid      Due

Alice Andrews
123456  Bob Smith         12 Palm Ave        Orlando       6/15/2026   7/02/2026   ORL     Windows      9,000.00   10,000.00     500.00    8,500.00
123457  Carla Diaz        99 Ocean Dr        Boca Raton    6/20/2026   7/03/2026   BOCA    Doors        4,500.00    5,000.00       0.00    4,500.00
                                                                       13,500.00   15,000.00     500.00   13,000.00
Ben Brown
123458  Dan Evans         7 Lake St          Sarasota      6/25/2026   7/05/2026   SAR     Windows      1,800.00    2,000.00       0.00    1,800.00
                                                                        1,800.00    2,000.00       0.00    1,800.00
Total # Records: 3
Totals:                                                                15,300.00   17,000.00     500.00   14,800.00
`;

test('synthetic (real layout): rows, derived column order, rep carry, long-form period — and all gates pass', () => {
  const parsed = parseJobsByMilestone(SYNTHETIC);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.header.moneyColumnOrder, ['net', 'gross', 'paid', 'balance']);

  const [r1, , r3] = parsed.rows;
  assert.equal(r1.job_number, '123456');
  assert.equal(r1.customer_name, 'Bob Smith');
  assert.equal(r1.city, 'Orlando');
  assert.equal(r1.contract_date, '2026-06-15');
  assert.equal(r1.rtp_date, '2026-07-02');
  assert.equal(r1.branch_code_raw, 'ORL');
  assert.equal(r1.product, 'Windows');
  // Printed Net|Gross|Paid|Balance — net is the FIRST money cell here.
  assert.equal(r1.net_cents, 900000);
  assert.equal(r1.gross_cents, 1000000);
  assert.equal(r1.paid_cents, 50000);
  assert.equal(r1.balance_cents, 850000);
  assert.equal(r1.sales_rep, 'Alice Andrews');
  assert.equal(r3.sales_rep, 'Ben Brown');

  assert.equal(parsed.header.periodStart, '2026-07-01');
  assert.equal(parsed.header.periodEnd, '2026-07-31');
  assert.equal(parsed.footer.recordCount, 3);

  const check = validateJobsByMilestone(parsed);
  assert.deepEqual(check.violations, []);
  assert.equal(check.ok, true);
});

test('legacy single-line column header (Gross Net Paid Balance) still derives correctly', () => {
  const legacy = SYNTHETIC
    .replace(/Job {2,}.*\n/, '')
    .replace(/Number {2,}.*\n/, 'Job#    Customer          Address            City          Contract    RTP         Mkt     Product         Gross         Net       Paid    Balance\n')
    // Money stays printed in the synthetic's physical order — relabel means
    // the parser must now read column 1 as GROSS, 2 as NET.
    ;
  const parsed = parseJobsByMilestone(legacy);
  assert.deepEqual(parsed.header.moneyColumnOrder, ['gross', 'net', 'paid', 'balance']);
  const r1 = parsed.rows[0];
  assert.equal(r1.gross_cents, 900000);
  assert.equal(r1.net_cents, 1000000);
});

test('unrecognizable column header → money_columns_unrecognized, no guessed assignment', () => {
  const garbled = SYNTHETIC
    .replace(/Job {2,}.*\n/, '')
    .replace(/Number {2,}.*\n/, '');
  const parsed = parseJobsByMilestone(garbled);
  assert.equal(parsed.header.moneyColumnOrder, null);
  assert.equal(parsed.rows[0].net_cents, null);
  const check = validateJobsByMilestone(parsed);
  const rules = check.violations.map((v) => v.rule);
  assert.ok(rules.includes('money_columns_unrecognized'), `expected money_columns_unrecognized in ${rules}`);
  assert.equal(check.ok, false);
});

test('M/D/YYYY period line (From:/To:) also parses', () => {
  const mdy = SYNTHETIC.replace(
    'from Wednesday, July 1, 2026 through Friday, July 31, 2026',
    'From: 7/1/2026  To: 7/31/2026',
  );
  const parsed = parseJobsByMilestone(mdy);
  assert.equal(parsed.header.periodStart, '2026-07-01');
  assert.equal(parsed.header.periodEnd, '2026-07-31');
  assert.equal(validateJobsByMilestone(parsed).ok, true);
});

test('money printed without cents parses to exact cents and all ties pass', () => {
  const noCents = `Reece Windows & Doors
Jobs By Milestone Date
For Jobs with the Milestone 'RTP'
from Wednesday, July 1, 2026 through Friday, July 31, 2026
Mode: Actual
Job                                          Contract                      Net    Total    Total   Balance
Number   Customer Name   Address   City       Date       RTP    Mkt  Product    Amount   Gross     Paid      Due

Alice Andrews
123456  Bob Smith         12 Palm Ave        Orlando       6/15/2026   7/02/2026   ORL     Windows      9,000   10,000    1,500    8,500
123457  Carla Diaz        99 Ocean Dr        Boca Raton    6/20/2026   7/03/2026   BOCA    Doors        4,500    5,000    1,000    4,000
                                                                       13,500   15,000    2,500   12,500
Total # Records: 2
Totals:                                                                13,500   15,000    2,500   12,500
`;
  const parsed = parseJobsByMilestone(noCents);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].net_cents, 900000);
  assert.equal(parsed.rows[0].gross_cents, 1000000);
  const check = validateJobsByMilestone(parsed);
  assert.deepEqual(check.violations, []);
  assert.equal(check.ok, true);
});

test('deriveMoneyColumnOrder: real two-line and flat forms; garbage → null', () => {
  assert.deepEqual(deriveMoneyColumnOrder([
    'Job                Contract          Net    Total    Total   Balance',
    'Number  Customer   Date    RTP  Mkt  Product  Amount  Gross    Paid     Due',
  ]), ['net', 'gross', 'paid', 'balance']);
  assert.deepEqual(deriveMoneyColumnOrder([
    'Job#  Customer  City  Contract  RTP  Mkt  Product  Gross  Net  Paid  Balance',
  ]), ['gross', 'net', 'paid', 'balance']);
  assert.equal(deriveMoneyColumnOrder(['Jobs By Milestone Date', 'Mode: Actual']), null);
  // Three money labels only — never a partial guess.
  assert.equal(deriveMoneyColumnOrder(['A  Gross  Net  Paid']), null);
});

test('double-counted detail row breaks the rep-subtotal tie AND the footer count', () => {
  const dupLine = '123456  Bob Smith         12 Palm Ave        Orlando       6/15/2026   7/02/2026   ORL     Windows      9,000.00   10,000.00     500.00    8,500.00';
  const doctored = SYNTHETIC.replace(dupLine, `${dupLine}\n${dupLine}`);
  const check = validateJobsByMilestone(parseJobsByMilestone(doctored));
  const rules = check.violations.map((v) => v.rule);
  assert.ok(rules.includes('rep_subtotal_mismatch'), `expected rep_subtotal_mismatch in ${rules}`);
  assert.ok(rules.includes('footer_count_mismatch'), `expected footer_count_mismatch in ${rules}`);
  assert.equal(check.ok, false);
});

test('subtotal-row leak: a subtotal misread as detail cannot pass the gates', () => {
  // Give the first rep's subtotal a leading job-number-ish cell so the
  // classifier takes it as a detail row — count and money ties both break.
  const doctored = SYNTHETIC.replace(
    '                                                                       13,500.00   15,000.00     500.00   13,000.00',
    '999999                                                                 13,500.00   15,000.00     500.00   13,000.00',
  );
  const check = validateJobsByMilestone(parseJobsByMilestone(doctored));
  assert.equal(check.ok, false);
  assert.ok(check.violations.map((v) => v.rule).includes('footer_count_mismatch'));
});

test('truncated file (footer gone) is rejected', () => {
  const truncated = SYNTHETIC.split('\n').slice(0, -3).join('\n');
  const check = validateJobsByMilestone(parseJobsByMilestone(truncated));
  const rules = check.violations.map((v) => v.rule);
  assert.ok(rules.includes('missing_footer'), `expected missing_footer in ${rules}`);
  assert.equal(check.ok, false);
});

test("wrong parameters (milestone 'Ordered', as production actually sent) are rejected", () => {
  // The real misconfigured run relabels the milestone-date column too.
  const ordered = SYNTHETIC
    .replace("For Jobs with the Milestone 'RTP'", "For Jobs with the Milestone 'Ordered'")
    .replace('Date       RTP    Mkt', 'Date   Ordered    Mkt');
  const check = validateJobsByMilestone(parseJobsByMilestone(ordered));
  const hit = check.violations.find((v) => v.rule === 'wrong_report_parameters');
  assert.ok(hit, 'expected wrong_report_parameters');
  assert.equal(hit.detail.declaresRtp, false);
  assert.equal(check.ok, false);
});

test('wrong parameters (Projected, no Actual) are rejected', () => {
  const projected = SYNTHETIC
    .replace("For Jobs with the Milestone 'RTP'", "For Jobs with the Milestone 'Install'")
    .replace('Mode: Actual', 'Mode: Projected');
  const check = validateJobsByMilestone(parseJobsByMilestone(projected));
  assert.ok(check.violations.map((v) => v.rule).includes('wrong_report_parameters'));
  assert.equal(check.ok, false);
});

test('footer money tie: 1¢ passes (LP rounding), 5¢ fails with both sides logged', () => {
  const oneCent = SYNTHETIC.replace('15,300.00   17,000.00', '15,300.01   17,000.00');
  assert.equal(validateJobsByMilestone(parseJobsByMilestone(oneCent)).ok, true);

  const fiveCents = SYNTHETIC.replace('15,300.00   17,000.00', '15,300.05   17,000.00');
  const check = validateJobsByMilestone(parseJobsByMilestone(fiveCents));
  const hit = check.violations.find((v) => v.rule === 'footer_total_mismatch');
  assert.ok(hit, 'expected footer_total_mismatch');
  assert.equal(hit.detail.column_field, 'net');
  assert.equal(hit.detail.printed_cents, 1530005);
  assert.equal(hit.detail.computed_cents, 1530000);
});

test('branch → market roll-up: BOCA rolls into FTLAU_MKT', () => {
  const branchMap = new Map([
    ['ORL', 'ORL_MKT'], ['BOCA', 'FTLAU_MKT'], ['FTLAU', 'FTLAU_MKT'], ['SAR', 'SAR_MKT'],
  ]);
  const { rows } = parseJobsByMilestone(SYNTHETIC);
  const byMarket = sumNetByMarket(rows, branchMap);
  assert.equal(byMarket.get('ORL_MKT'), 900000);
  assert.equal(byMarket.get('FTLAU_MKT'), 450000);
  assert.equal(byMarket.get('SAR_MKT'), 180000);
});

test('golden: July 2026 fixture ties to the report footer (skipped until fixture exists)', (t) => {
  if (!existsSync(FIXTURE)) {
    t.skip('redacted fixture not present — see scripts/fixtures/lp-reports/README.md');
    return;
  }
  const parsed = parseJobsByMilestone(readFileSync(FIXTURE, 'utf8'));
  const check = validateJobsByMilestone(parsed);
  assert.deepEqual(check.violations, []);
  assert.equal(parsed.rows.length, 288);

  const netSum = parsed.rows.reduce((a, r) => a + (r.net_cents ?? 0), 0);
  assert.equal(netSum, 750274576); // $7,502,745.76

  const branchMap = new Map([
    ['BOCA', 'FTLAU_MKT'], ['FTLAU', 'FTLAU_MKT'], ['MIAMI', 'FTLAU_MKT'], ['RFED', 'FTLAU_MKT'],
    ['FTMYR', 'FTMYR_MKT'], ['JAX', 'JAX_MKT'], ['LAKE', 'LAKE_MKT'], ['ORL', 'ORL_MKT'],
    ['SAR', 'SAR_MKT'], ['STPET', 'STPET_MKT'],
  ]);
  const byMarket = sumNetByMarket(parsed.rows, branchMap);
  assert.equal(byMarket.get('ORL_MKT'), 115842400);   // Orlando 1,158,424.00
  assert.equal(byMarket.get('FTLAU_MKT'), 13531708);  // Fort Lauderdale roll-up 135,317.08
  assert.ok(!byMarket.has('UNMAPPED'), 'no branch may fall out of the market map');
});
