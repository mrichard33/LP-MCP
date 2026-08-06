/**
 * Guards for src/jobs/lp-report-parse-source-cost-pdf.js — report 136
 * "Marketing Sub-Source Cost Analysis 2", the COMPANY CONTROL-TOTAL AUTHORITY.
 *
 * FIXTURE: unlike report 135, this report carries NO customer PII — it is
 * company-wide aggregates, one row per marketing sub-source. The `-layout`
 * text is committed verbatim with only the report operator's name masked, so
 * the goldens run on every checkout instead of skipping.
 *
 * Pinned to the real 2026-08-06 emailed file: 2 pages, 37 sub-source rows,
 * Grand Total Raw 1,194 — which is the same 1,194 report 135's Grand Total
 * counts for the same window.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseSourceCostPdf, validateSourceCostPdf, computeSourceCostPdfTotals,
  parseCell, parsePeriodLine, reconcileWithLeadDisposition,
  SC_PDF_FIELDS, SC_PDF_SUM_FIELDS,
} from '../src/jobs/lp-report-parse-source-cost-pdf.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)),
  'fixtures/lp-reports/report-136-source-cost-aug-mtd.txt');
const TEXT = readFileSync(FIXTURE, 'utf8');
const parsed = parseSourceCostPdf(TEXT);

test('golden: 37 sub-source rows, Aug MTD window, generated 2026-08-06', () => {
  assert.equal(parsed.rows.length, 37);
  assert.deepEqual(parsed.header, {
    periodStart: '2026-08-01', periodEnd: '2026-08-31', asOf: '2026-08-06', scope: 'mtd',
  });
});

test('golden: EVERY summed column ties to the printed Grand Total', () => {
  // This report is the control-total authority — the tie is the whole point.
  const v = validateSourceCostPdf(parsed);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  const computed = computeSourceCostPdfTotals(parsed.rows);
  assert.deepEqual(computed, {
    raw: 1194, set: 463, issued: 211, demo: 95, sold: 29,
    gross_cents: 71_413_800, working_cents: 107_949_100,
    net_sales_cents: 0, total_cost_cents: 0,
  });
  for (const f of SC_PDF_SUM_FIELDS) assert.equal(computed[f], parsed.printedTotals[f], f);
});

test('a Grand Total that does not tie FAILS CLOSED', () => {
  // Drop one row's gross; the column must stop tying and the file must reject.
  const broken = { ...parsed, rows: parsed.rows.map((r, i) => (i === 0 ? { ...r, gross_cents: 0 } : r)) };
  const v = validateSourceCostPdf(broken);
  assert.equal(v.ok, false);
  const hit = v.violations.find((x) => x.rule === 'grand_total_mismatch' && x.detail.column === 'gross_cents');
  assert.ok(hit, 'expected a gross_cents mismatch');
  assert.equal(hit.detail.printed, 71_413_800);
});

test('a truncated file with no Grand Total row fails closed', () => {
  const cut = TEXT.split('\n').filter((l) => !/Grand Total/i.test(l)).join('\n');
  const v = validateSourceCostPdf(parseSourceCostPdf(cut));
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.rule === 'missing_grand_total'));
});

test('wrapped sub-source names reassemble onto their own row', () => {
  // LP wraps long names onto following lines with nothing else on them.
  const names = parsed.rows.map((r) => r.sub_source);
  assert.ok(names.includes('Website Estimate Calculator'));
  assert.ok(names.includes('Fort Myers Beat the Heat Indoor Craft Festival'));
  assert.ok(names.includes('Contractor Appointment Rev Share'));
  assert.ok(names.includes('Contractor Appointment-West'));
  // The continuation lines must NOT have become rows of their own.
  assert.ok(!names.includes('Calculator'));
  assert.ok(!names.includes('Festival'));
  assert.equal(parsed.rows.length, 37);
});

test('BLANK sub-source names are real rows and are counted', () => {
  // Two rows in the 2026-08-06 file have no name at all. Dropping them would
  // break the Raw tie by 10.
  const blank = parsed.rows.filter((r) => !r.sub_source);
  assert.equal(blank.length, 2);
  assert.equal(blank.reduce((a, r) => a + r.raw, 0), 10);
});

test('DUPLICATE sub-source names stay distinct rows — identity is row_num', () => {
  // `Previous Customer` appears twice with different numbers. Any dedupe or
  // upsert on the name breaks the checksum.
  const prev = parsed.rows.filter((r) => r.sub_source === 'Previous Customer');
  assert.equal(prev.length, 2);
  assert.deepEqual(prev.map((r) => r.raw).sort((a, b) => a - b), [2, 4]);
  assert.equal(new Set(parsed.rows.map((r) => r.row_num)).size, parsed.rows.length);
});

test('a row is EXACTLY fifteen numeric cells — a short row is not a row', () => {
  assert.equal(SC_PDF_FIELDS.length, 15);
  const short = parseSourceCostPdf('Something   1   2   3\nGrand Total:   1   2   3\n');
  assert.equal(short.rows.length, 0);
  assert.equal(short.printedTotals, null);
});

test('money is WHOLE DOLLARS in this PDF — cents are always zero', () => {
  // The CSV export carries cents and stays the cents-exact authority; this PDF
  // prints $714,138, never $714,138.29.
  for (const r of parsed.rows) {
    for (const f of ['gross_cents', 'working_cents', 'net_sales_cents']) {
      if (r[f] != null) assert.equal(r[f] % 100, 0, `${r.sub_source} ${f}`);
    }
  }
  assert.equal(parsed.printedTotals.gross_cents, 714_138 * 100);
});

test('parseCell scales money and percent by 100, counts by 1', () => {
  assert.equal(parseCell('1,194', 'raw'), 1194);
  assert.equal(parseCell('$714,138', 'gross_cents'), 71_413_800);
  assert.equal(parseCell('17.7%', 'issue_pct'), 1770);
  assert.equal(parseCell('0.00%', 'mkt_pct'), 0);
  assert.equal(parseCell('$0', 'net_sales_cents'), 0);
  assert.equal(parseCell('', 'raw'), null);
});

test('the reporting window and generated stamp parse off the header', () => {
  assert.deepEqual(
    parsePeriodLine('For the Period Saturday, August 1, 2026 through Monday, August 31, 2026'),
    { periodStart: '2026-08-01', periodEnd: '2026-08-31' },
  );
});

test('per-row percentages reconcile as ratios — advisory, never a gate', () => {
  const v = validateSourceCostPdf(parsed);
  assert.equal(v.reconciliations.length, 0, 'the real file has no ratio drift');
  // A wrong percentage reports, but does not reject: LP prints rounded ratios.
  const drift = { ...parsed, rows: parsed.rows.map((r, i) => (i === 0 ? { ...r, issue_pct: 9900 } : r)) };
  const v2 = validateSourceCostPdf(drift);
  assert.equal(v2.ok, true, 'a rounded percentage must not fail the file');
  assert.ok(v2.reconciliations.some((x) => x.scope === 'issue_pct'));
});

test('cross-report: 136 Raw ties to 135 rows — logged, never gated', () => {
  // 1,194 both sides for the 2026-08-06 window.
  const rec = reconcileWithLeadDisposition({
    sourceCostRaw: parsed.printedTotals.raw, leadDispositionRows: 1194,
  });
  assert.equal(rec.detail.tied, true);
  assert.equal(rec.detail.delta, 0);
  // A mismatch still only REPORTS — 135 and 136 are separate pulls and a
  // one-row drift between them is not a reason to reject either file.
  const off = reconcileWithLeadDisposition({ sourceCostRaw: 1194, leadDispositionRows: 1190 });
  assert.equal(off.detail.tied, false);
  assert.equal(off.detail.delta, -4);
});

test('136 funnel counters are NOT comparable to 135 dispositions', () => {
  // 135's Current Dispo is a POINT-IN-TIME STATE; 136's Set/Issue/Demo/Sold are
  // CUMULATIVE COUNTERS. A lead now at `Sale` was also Set and Issued, so
  // count(dispo='Set') in 135 can never equal Set here. This asserts the shape
  // that makes such a comparison obviously wrong: the funnel narrows monotonically.
  const t = parsed.printedTotals;
  assert.ok(t.raw > t.set && t.set > t.issued && t.issued > t.demo && t.demo > t.sold);
});
