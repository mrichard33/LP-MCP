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
 *     are rejected, not partially ingested — and the rejection logs every
 *     sub-check (milestone_ok / mode_ok), not just a truncated header.
 *   • Header validation is CONTENT-matched: the optional 'All Sales' line
 *     may be present, absent, or reordered without affecting any gate
 *     (2026-08-04 regression class: a positional theory wasted a cycle).
 *   • display_rounding: a whole-dollar-rendered PDF may print subtotals
 *     computed from unrounded values; the allowance is capped at $1 × rows
 *     in the group, logged in `reconciliations` on every use, and never
 *     applies when any cell carries cents.
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
All Sales
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

test("wrong parameters (milestone 'Ordered' — the misconfigured 2026-08-04 schedule) are rejected, with every sub-check logged", () => {
  const ordered = SYNTHETIC
    .replace("For Jobs with the Milestone 'RTP'", "For Jobs with the Milestone 'Ordered'");
  const check = validateJobsByMilestone(parseJobsByMilestone(ordered));
  const hit = check.violations.find((v) => v.rule === 'wrong_report_parameters');
  assert.ok(hit, 'expected wrong_report_parameters');
  assert.equal(hit.detail.milestone, 'Ordered');
  assert.equal(hit.detail.expected_milestone, 'RTP');
  assert.equal(hit.detail.milestone_ok, false);
  assert.equal(hit.detail.mode, 'Actual');
  assert.equal(hit.detail.mode_ok, true);
  assert.equal(check.ok, false);

  // …but an explicit expectedMilestone override accepts it.
  assert.equal(validateJobsByMilestone(parseJobsByMilestone(ordered), { expectedMilestone: 'Ordered' }).ok, true);
});

test('wrong parameters (Projected, no Actual) are rejected with mode_ok:false', () => {
  const projected = SYNTHETIC
    .replace("For Jobs with the Milestone 'RTP'", "For Jobs with the Milestone 'Install'")
    .replace('Mode: Actual', 'Mode: Projected');
  const check = validateJobsByMilestone(parseJobsByMilestone(projected));
  const hit = check.violations.find((v) => v.rule === 'wrong_report_parameters');
  assert.ok(hit, 'expected wrong_report_parameters');
  assert.equal(hit.detail.milestone_ok, false);
  assert.equal(hit.detail.mode, 'Projected');
  assert.equal(hit.detail.mode_ok, false);
  assert.equal(check.ok, false);
});

test("mode check is ANCHORED to 'Mode:' — a stray 'Actual' elsewhere in the header cannot satisfy it", () => {
  // 'Mode: Projected' + the word 'Actual' in another header line: the old
  // unanchored /\bActual\b/ passed this; the anchored check must not.
  const sneaky = SYNTHETIC
    .replace('Mode: Actual', 'Mode: Projected')
    .replace('Sort By: Sales Rep', 'Sort By: Sales Rep (Actual)');
  const parsed = parseJobsByMilestone(sneaky);
  assert.equal(parsed.header.mode, 'Projected');
  assert.equal(parsed.header.declaresActual, false);
  const check = validateJobsByMilestone(parsed);
  assert.ok(check.violations.map((v) => v.rule).includes('wrong_report_parameters'));
});

test("header validation is content-matched: 'All Sales' present, absent, or reordered — all pass (id=5 regression)", () => {
  // Present (SYNTHETIC includes it).
  assert.equal(validateJobsByMilestone(parseJobsByMilestone(SYNTHETIC)).ok, true);

  // Absent.
  const without = SYNTHETIC.replace('All Sales\n', '');
  assert.equal(validateJobsByMilestone(parseJobsByMilestone(without)).ok, true);

  // Reordered: 'All Sales' after 'Mode: Actual'.
  const reordered = SYNTHETIC
    .replace('All Sales\n', '')
    .replace('Mode: Actual', 'Mode: Actual\nAll Sales');
  assert.equal(validateJobsByMilestone(parseJobsByMilestone(reordered)).ok, true);
});

test('wrong_period: backfill-declared period must match the header (shared validator, no fork)', () => {
  const parsed = parseJobsByMilestone(SYNTHETIC); // declares 2026-07-01..31
  assert.equal(validateJobsByMilestone(parsed, { expectedPeriod: { start: '2026-07-01', end: '2026-07-31' } }).ok, true);
  const check = validateJobsByMilestone(parsed, { expectedPeriod: { start: '2026-06-01', end: '2026-06-30' } });
  const hit = check.violations.find((v) => v.rule === 'wrong_period');
  assert.ok(hit, 'expected wrong_period');
  assert.equal(hit.detail.declared_start, '2026-07-01');
  assert.equal(hit.detail.expected_start, '2026-06-01');
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

// ── Real production layout (2026-08-04), sanitized ──────────────────────────
// Structurally byte-faithful to the first real scheduled PDF (pdftotext
// -layout): 2-digit detail years, no-cents money, bare-integer subtotal
// cells ('1', '200'), a wrapped customer name on an indented continuation
// line, per-rep groups, and the real footer/timestamp lines. Names and
// addresses are fake; every number and column offset quirk is real.
const REAL_LAYOUT = `                                                                Jobs By Milestone Date
                                                                       For Jobs with the Milestone 'Ordered'
                                                            from Monday, August 3, 2026 through Monday, August 3, 2026
                                                                                Sort By: Sales Rep
                                                                                      All Sales
                                                                                   Mode: Actual



Job                                                                                        Contract                                    Net    Total     Total    Balance
Number    Customer Name                    Address                   City                    Date      Ordered    Mkt     Product   Amount    Gross      Paid        Due

Rep, Alpha
35978     Alpha , Linda/David              12808 Example Dr          Riverview              05/16/26   08/03/26   STPET   Win        21,000    21,000   10,500     10,500
36479     BRAVO, LAWRENCE                  902 SAMPLE CT             SUN CITY CENTER        06/16/26   08/03/26   STPET   Win        21,500    21,500    2,000     19,500
36788     Charlie, Edgar                   721 53rd Ave S            Saint Petersburg       07/09/26   08/03/26   STPET   Win        15,000    15,000       1      14,999
36791     Delta, Rickey & Stacie           387 Sample Cir            Oldsmar                07/09/26   08/03/26   STPET   Win        26,000    26,000   13,000     13,000
                                                                                                                                     83,500    83,500   25,501     57,999


Rep, Bravo
36369     Echo, Judith                     4805 Sample Rd            North Port             06/11/26   08/03/26   SAR     Win        34,832    34,832       1      34,831
                                                                                                                                     34,832    34,832       1      34,831


Rep, Charlie
36222     Foxtrot, Wendell & Lorlan        22005 Sample Way          Land O Lakes           06/02/26   08/03/26   STPET   Door       15,550    15,550    7,775       7,775
                                                                                                                                     15,550    15,550    7,775       7,775


Rep, Delta
36365     Golf, Mead                       8946 Sample Loop          Sarasota               06/09/26   08/03/26   SAR     Win        77,544    78,645   39,323     39,322
                                                                                                                                     77,544    78,645   39,323     39,322


Rep, Echo
36887     Hotel, Luiz & Celia              5125 Sample Blvd          Tampa                  07/08/26   08/03/26   STPET   Win        23,588    23,588   11,794     11,794
                                                                                                                                     23,588    23,588   11,794     11,794


Rep, Foxtrot
35562     India/Juliet, Jay &              3610 103rd ave n          Clearwater             04/22/26   08/03/26   STPET   Win        17,894    17,900     200      17,700
          Raisa
                                                                                                                                     17,894    17,900     200      17,700


                 Total # Records:      9                                                                                            252,908   254,015   84,594    169,421


8/4/2026 4:42:58 PM                                                                 Page 1 of 1                                                           User:Example User
`;

test('real production layout (2026-08-04, sanitized): every gate passes', () => {
  const parsed = parseJobsByMilestone(REAL_LAYOUT);

  // The capture predates the LP schedule fix — it declares 'Ordered', so the
  // gate check below runs with an explicit override. Everything structural
  // (columns, subtotals, wrapped names, footer) is byte-faithful regardless.
  assert.equal(parsed.header.milestone, 'Ordered');
  assert.equal(parsed.header.mode, 'Actual');
  assert.equal(parsed.header.declaresActual, true);
  assert.deepEqual(parsed.header.moneyColumnOrder, ['net', 'gross', 'paid', 'balance']);
  assert.equal(parsed.header.periodStart, '2026-08-03');
  assert.equal(parsed.header.periodEnd, '2026-08-03');
  assert.equal(parsed.header.reportGeneratedAt, '2026-08-04');

  assert.equal(parsed.rows.length, 9);
  assert.equal(parsed.repSubtotals.length, 6, 'all six rep subtotals captured, including bare-integer cells');
  assert.equal(parsed.footer.recordCount, 9);
  assert.deepEqual(parsed.footer.totalCents, [25290800, 25401500, 8459400, 16942100]);

  // 2-digit years land in 2026, both date columns.
  const r1 = parsed.rows[0];
  assert.equal(r1.contract_date, '2026-05-16');
  assert.equal(r1.rtp_date, '2026-08-03');
  assert.equal(r1.net_cents, 2100000);
  assert.equal(r1.sales_rep, 'Rep, Alpha');

  // Bare-integer money in a detail row ('1' paid) parses as exact dollars.
  const wilcox = parsed.rows.find((r) => r.job_number === '36788');
  assert.equal(wilcox.paid_cents, 100);
  assert.equal(wilcox.balance_cents, 1499900);

  // Wrapped customer name: the indented continuation line joins the row
  // above instead of being taken for a rep header.
  const wrapped = parsed.rows.find((r) => r.job_number === '35562');
  assert.equal(wrapped.customer_name, 'India/Juliet, Jay & Raisa');
  assert.equal(wrapped.sales_rep, 'Rep, Foxtrot');

  const check = validateJobsByMilestone(parsed, { expectedMilestone: 'Ordered' });
  assert.deepEqual(check.violations, []);
  assert.equal(check.ok, true);
});

test('a dropped rep subtotal is a violation, not a silent hole in the guard', () => {
  // Remove one rep subtotal line entirely — rep_subtotal_missing must fire.
  const holed = REAL_LAYOUT.replace(
    '                                                                                                                                     34,832    34,832       1      34,831\n\n\n',
    '\n\n',
  );
  const check = validateJobsByMilestone(parseJobsByMilestone(holed), { expectedMilestone: 'Ordered' });
  const hit = check.violations.find((v) => v.rule === 'rep_subtotal_missing');
  assert.ok(hit, `expected rep_subtotal_missing in ${check.violations.map((v) => v.rule)}`);
  assert.equal(hit.detail.rep, 'Rep, Bravo');
  assert.equal(check.ok, false);
});

// ── display_rounding — the id=4 $1.00 case (2026-08-04) ─────────────────────
// LP renders this PDF in whole dollars but computes subtotals from unrounded
// values: "Inlay, Katie" printed net $57,227 while her displayed rows summed
// $57,226, and the grand total carried the same $1. The allowance is bounded
// ($1 × rows in the group), whole-dollar-gated, and LOGGED on every use.

/** REAL_LAYOUT with Rep Bravo's row displayed $1 below its printed subtotal — the id=4 shape. */
const ROUNDED_LAYOUT = REAL_LAYOUT
  .replace(
    '36369     Echo, Judith                     4805 Sample Rd            North Port             06/11/26   08/03/26   SAR     Win        34,832    34,832       1      34,831',
    '36369     Echo, Judith                     4805 Sample Rd            North Port             06/11/26   08/03/26   SAR     Win        34,831    34,832       1      34,831',
  );

test('display_rounding: $1 whole-dollar subtotal drift passes within cap and is logged as a reconciliation', () => {
  const check = validateJobsByMilestone(parseJobsByMilestone(ROUNDED_LAYOUT), { expectedMilestone: 'Ordered' });
  // Footer net (252,908) now also sits $1 above the displayed-row sum — the
  // same drift propagates, exactly as in id=4.
  assert.deepEqual(check.violations, [], `unexpected violations: ${JSON.stringify(check.violations)}`);
  assert.equal(check.ok, true);

  const sub = check.reconciliations.find((r) => r.scope === 'rep_subtotal');
  assert.ok(sub, 'expected a rep_subtotal display_rounding reconciliation');
  assert.equal(sub.class, 'display_rounding');
  assert.equal(sub.detail.rep, 'Rep, Bravo');
  assert.equal(sub.detail.column_field, 'net');
  assert.equal(sub.detail.delta_cents, 100);
  assert.equal(sub.detail.cap_cents, 100); // 1 row in the group → $1 cap

  const foot = check.reconciliations.find((r) => r.scope === 'footer_total');
  assert.ok(foot, 'expected a footer_total display_rounding reconciliation');
  assert.equal(foot.detail.delta_cents, 100);
  assert.equal(foot.detail.cap_cents, 900); // 9 rows → $9 cap
});

test('display_rounding: drift beyond the $1-per-row cap still fails closed', () => {
  // Rep Bravo has ONE row → cap $1. Print the row $2 low: past the cap.
  const past = REAL_LAYOUT.replace(
    '36369     Echo, Judith                     4805 Sample Rd            North Port             06/11/26   08/03/26   SAR     Win        34,832    34,832       1      34,831',
    '36369     Echo, Judith                     4805 Sample Rd            North Port             06/11/26   08/03/26   SAR     Win        34,830    34,832       1      34,831',
  );
  const check = validateJobsByMilestone(parseJobsByMilestone(past), { expectedMilestone: 'Ordered' });
  const hit = check.violations.find((v) => v.rule === 'rep_subtotal_mismatch');
  assert.ok(hit, 'expected rep_subtotal_mismatch');
  assert.equal(hit.detail.delta_cents, 200);
  assert.equal(hit.detail.cap_cents, 100);
  assert.equal(check.ok, false);
});

test('display_rounding: never applies when the group carries cents — exact tie required (SYNTHETIC, $1 off)', () => {
  // SYNTHETIC prints cents everywhere; a $1 drift there is a parse defect,
  // not display rounding.
  const off = SYNTHETIC.replace(
    '                                                                        1,800.00    2,000.00       0.00    1,800.00',
    '                                                                        1,801.00    2,000.00       0.00    1,800.00',
  );
  const check = validateJobsByMilestone(parseJobsByMilestone(off));
  const hit = check.violations.find((v) => v.rule === 'rep_subtotal_mismatch');
  assert.ok(hit, 'expected rep_subtotal_mismatch');
  assert.equal(hit.detail.whole_dollar_group, false);
  assert.equal(check.ok, false);
  assert.equal((check.reconciliations ?? []).length, 0);
});
