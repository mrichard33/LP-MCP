/**
 * Guards for src/jobs/lp-report-parse-sales-efficiency.js — LP report 137,
 * the only per-market source of Issued / Sat / Sold / Cancelled / NSA.
 *
 * Invariants under guard (handoff §8, 2026-08-05):
 *   • #1  The REAL Aug MTD PDF fixture parses; markets with omitted bucket
 *         columns (BOCA/FTLAU/MIAMI) land by COLUMN POSITION, never token
 *         order; the Total row checksums every column.
 *   • #2  The YTD CSV golden fixture ties the §1 company figures exactly.
 *   • #4  (facts side) counts_only rows never emit net_sold.
 *   • #5  MTD pulls (blank Net column) parse as counts_only — Net/NSA are
 *         never written; the printed NSLI column is never ingested.
 *   • #8  Filename report-ID routing (mirrors the I.LPR router's regex).
 *   • checksum fail-closed: a perturbed Total row rejects the file.
 *
 * The PDF fixture is real-report text (market aggregates — no PII),
 * reconstructed at -layout-style character offsets; the parser is
 * self-calibrating from the Total row, so offset scale is irrelevant.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSalesEfficiencyCsv, parseSalesEfficiencyPdf, resolveSalesEfficiencyMarkets,
  computeSalesEfficiencyTotals, validateSalesEfficiency, SE_BRANCH_LABELS,
} from '../src/jobs/lp-report-parse-sales-efficiency.js';
import { expectedFacts, factKey } from '../src/jobs/lp-report-facts.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/lp-reports');
const PDF_TEXT = readFileSync(join(FIX, 'report-137-sales-efficiency-aug-mtd.txt'), 'utf8');
const CSV_TEXT = readFileSync(join(FIX, 'report-137-sales-efficiency-ytd.csv'), 'utf8');

const MAPS = {
  branchMap: new Map([
    ['ORL', 'ORL_MKT'], ['LAKE', 'LAKE_MKT'], ['STPET', 'STPET_MKT'],
    ['FTLAU', 'FTLAU_MKT'], ['BOCA', 'FTLAU_MKT'], ['MIAMI', 'FTLAU_MKT'], ['RFED', 'FTLAU_MKT'],
    ['FTMYR', 'FTMYR_MKT'], ['SAR', 'SAR_MKT'], ['JAX', 'JAX_MKT'],
  ]),
};

// ── PDF (Aug MTD sample) ────────────────────────────────────────────────────

test('§8.1 PDF: real MTD sample parses 9 markets, window, counts_only mode', () => {
  const p = parseSalesEfficiencyPdf(PDF_TEXT);
  assert.equal(p.mode, 'counts_only');
  assert.equal(p.rows.length, 9);
  assert.equal(p.header.periodStart, '2026-08-01');
  assert.equal(p.header.periodEnd, '2026-08-31');
  assert.deepEqual(p.misaligned, []);
});

test('§8.1 PDF: sparse columns land by position — BOCA/FTLAU/MIAMI', () => {
  const p = parseSalesEfficiencyPdf(PDF_TEXT);
  const by = Object.fromEntries(p.rows.map((r) => [r.branch_code_raw, r]));
  // BOCA: Close 1/$85,415 AND Working 1/$85,415 — same dollars in two
  // different columns; token-order parsing cannot tell them apart.
  assert.equal(by.BOCA.num_sold, 1);
  assert.equal(by.BOCA.gsa_cents, 8541500);
  assert.equal(by.BOCA.num_working, 1);
  assert.equal(by.BOCA.working_cents, 8541500);
  assert.equal(by.BOCA.num_cancelled, undefined);
  assert.equal(by.BOCA.num_hold, undefined);
  // FTLAU: Canceled (not Working) — position, not order.
  assert.equal(by.FTLAU.num_cancelled, 1);
  assert.equal(by.FTLAU.cancelled_cents, 9569800);
  assert.equal(by.FTLAU.num_working, undefined);
  // MIAMI: only Iss / Net Iss / Demo.
  assert.deepEqual(
    { iss: by.MIAMI.num_issued, net: by.MIAMI.num_net_issued, sat: by.MIAMI.num_sat },
    { iss: 5, net: 3, sat: 1 });
  assert.equal(by.MIAMI.num_sold, undefined);
  // JAX: the only Credit Decline row.
  assert.equal(by.JAX.num_cd, 2);
  assert.equal(by.JAX.cd_cents, 3132300);
  // Hold-HOA: LAKE 1/$25,715 + SAR 4/$69,156 + STPET 1/$6,400.
  assert.equal(by.LAKE.hold_cents, 2571500);
  assert.equal(by.SAR.num_hold, 4);
  assert.equal(by.STPET.hold_cents, 640000);
});

test('§8.1 PDF: Total row checksums every column (values line precedes the label)', () => {
  const p = parseSalesEfficiencyPdf(PDF_TEXT);
  assert.deepEqual(p.totals, {
    num_issued: 298, num_net_issued: 165, num_sat: 136,
    num_sold: 40, gsa_cents: 104250200,
    num_working: 30, working_cents: 78576700,
    num_cd: 2, cd_cents: 3132300,
    num_cancelled: 2, cancelled_cents: 12414100,
    num_hold: 6, hold_cents: 10127100,
  });
  const v = validateSalesEfficiency(p, { todayIso: '2026-08-05' });
  assert.equal(v.ok, true);
});

test('§8.5 PDF MTD: no Net figures anywhere, printed NSLI never ingested', () => {
  const p = parseSalesEfficiencyPdf(PDF_TEXT);
  for (const r of p.rows) {
    assert.equal(r.num_net, undefined);
    assert.equal(r.nsa_cents, undefined);
    // the printed NSLI values (3,674 / 1,572 / 136) appear in NO field
    for (const v of Object.values(r)) {
      assert.notEqual(v, 367400);
      assert.notEqual(v, 157200);
    }
  }
  const totals = computeSalesEfficiencyTotals(p.rows, p.mode);
  assert.equal('num_net' in totals, false);
  assert.equal('nsa_cents' in totals, false);
});

test('checksum fail-closed: perturbed Total row rejects the file', () => {
  const perturbed = PDF_TEXT.replace('298', '299');
  const p = parseSalesEfficiencyPdf(perturbed);
  const v = validateSalesEfficiency(p);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.rule === 'total_row_mismatch'));
});

test('PDF money checksum honors the $1/row display_rounding allowance', () => {
  // shift one row's Working by $5 — within 9 rows × $1? No: allowance is
  // $1 × 9 = $9, so $5 passes as a logged reconciliation, $50 fails.
  const within = PDF_TEXT.replace('443,511', '443,516');
  const v1 = validateSalesEfficiency(parseSalesEfficiencyPdf(within));
  assert.equal(v1.ok, true);
  assert.ok(v1.reconciliations.some((r) => r.class === 'display_rounding'));
  const beyond = PDF_TEXT.replace('443,511', '443,561');
  const v2 = validateSalesEfficiency(parseSalesEfficiencyPdf(beyond));
  assert.equal(v2.ok, false);
});

// ── CSV (YTD golden) ────────────────────────────────────────────────────────

const GOLDEN = {
  num_issued: 15441, num_sat: 10505, num_sold: 3443, gsa_cents: 8111013520,
  num_net: 2250, nsa_cents: 5411910128, num_cancelled: 628, cancelled_cents: 1527535792,
};

test('§8.2 CSV: YTD golden fixture ties every §1 company figure to the cent', () => {
  const p = parseSalesEfficiencyCsv(CSV_TEXT);
  assert.equal(p.rows.length, 10);
  assert.equal(p.header.periodStart, '2026-01-01');
  assert.equal(p.header.periodEnd, '2026-09-02');
  const v = validateSalesEfficiency(p, { expectedTotals: GOLDEN, todayIso: '2026-08-05' });
  assert.equal(v.ok, true);
  // future EDate (9/2) recorded as a reconciliation, never a rejection
  assert.ok(v.reconciliations.some((r) => r.class === 'future_period_end'));
});

test('§8.2 CSV: six-market rollup matches the handoff table', () => {
  const p = parseSalesEfficiencyCsv(CSV_TEXT);
  resolveSalesEfficiencyMarkets(p.rows, MAPS);
  const agg = {};
  for (const r of p.rows) {
    const a = agg[r.market] ??= { iss: 0, sold: 0, gsa: 0, net: 0, nsa: 0, cxl: 0 };
    a.iss += r.num_issued; a.sold += r.num_sold; a.gsa += r.gsa_cents;
    a.net += r.num_net; a.nsa += r.nsa_cents; a.cxl += r.num_cancelled;
  }
  assert.deepEqual(agg.FTLAU_MKT, { iss: 1449, sold: 187, gsa: 473033000, net: 100, nsa: 223252000, cxl: 51 });
  assert.deepEqual(agg.FTMYR_MKT, { iss: 3940, sold: 901, gsa: 2306005915, net: 617, nsa: 1575415915, cxl: 140 });
  assert.deepEqual(agg.SAR_MKT, { iss: 1783, sold: 485, gsa: 1280148600, net: 338, nsa: 929889600, cxl: 73 });
  // Orlando = ORL + LAKE (display fold happens downstream; warehouse codes here)
  assert.equal(agg.ORL_MKT.iss + agg.LAKE_MKT.iss, 3387);
  assert.equal(agg.ORL_MKT.nsa + agg.LAKE_MKT.nsa, 933391600);
  assert.equal(agg.STPET_MKT.gsa, 1965245505);
  assert.equal(agg.JAX_MKT.cxl, 52);
});

test('CSV: a 1¢ control-total mismatch fails closed', () => {
  const p = parseSalesEfficiencyCsv(CSV_TEXT);
  const v = validateSalesEfficiency(p, { expectedTotals: { ...GOLDEN, nsa_cents: GOLDEN.nsa_cents + 1 } });
  assert.equal(v.ok, false);
  assert.equal(v.violations[0].rule, 'control_total_mismatch');
});

test('unmapped branch label is returned for quarantine, never silently kept', () => {
  const p = parseSalesEfficiencyCsv(CSV_TEXT.replace('"BOCA"', '"NEWTOWN"'));
  // NEWTOWN isn't a known label — but CSV rows come from Grouper verbatim;
  // resolve flags it (label list guards the PDF line-anchoring only).
  const unmapped = resolveSalesEfficiencyMarkets(p.rows, MAPS);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].branch_code_raw, 'NEWTOWN');
});

// ── facts projection (§8.4 side of the MTD guard) ───────────────────────────

test('facts: counts_only rows emit issued/sold/cancelled but never net_sold', () => {
  const p = parseSalesEfficiencyPdf(PDF_TEXT);
  resolveSalesEfficiencyMarkets(p.rows, MAPS);
  const facts = expectedFacts('sales_efficiency', p.rows);
  const hasNet = [...facts.values()].some((f) => f.metric === 'net_sold');
  assert.equal(hasNet, false);
  const boca = facts.get(factKey({ market: 'FTLAU_MKT', branch_code_raw: 'BOCA', metric: 'sold', bucket: null }));
  assert.deepEqual({ cents: boca.cents, count: boca.count }, { cents: 8541500, count: 1 });
});

test('facts: full-mode CSV rows carry net_sold with NSA cents', () => {
  const p = parseSalesEfficiencyCsv(CSV_TEXT);
  resolveSalesEfficiencyMarkets(p.rows, MAPS);
  const facts = expectedFacts('sales_efficiency', p.rows);
  const sarNet = facts.get(factKey({ market: 'SAR_MKT', branch_code_raw: 'SAR', metric: 'net_sold', bucket: null }));
  assert.deepEqual({ cents: sarNet.cents, count: sarNet.count }, { cents: 929889600, count: 338 });
  const sarCxl = facts.get(factKey({ market: 'SAR_MKT', branch_code_raw: 'SAR', metric: 'cancelled', bucket: null }));
  assert.deepEqual({ cents: sarCxl.cents, count: sarCxl.count }, { cents: 199395700, count: 73 });
});

// ── §8.8 filename report-ID routing (mirror of the I.LPR router regex) ──────

const ROUTER_RE = /_1(3[3-7])_/;
const ROUTE_MAP = { 133: 'jobs-by-status', 134: 'jobs-by-milestone', 135: 'lead-disposition', 136: 'source-cost', 137: 'sales-efficiency' };

test('§8.8 router regex routes every LP filename to the right slug', () => {
  const cases = [
    ['mrichard5152_133_260805060012_Jobs_By_Status.pdf', 'jobs-by-status'],
    ['mrichard5152_134_260805060012_Jobs_by_Milestone_Date.pdf', 'jobs-by-milestone'],
    ['mrichard5152_135_260805063001_Lead_Disposition_Detail.pdf', 'lead-disposition'],
    ['mrichard5152_136_260805064512_Marketing_Sub_Source_Cost_Anlysis_2.pdf', 'source-cost'],
    ['mrichard5152_137_260805112258_Sales_Efficiency_By_Mode_1.pdf', 'sales-efficiency'],
  ];
  for (const [name, slug] of cases) {
    const m = name.match(ROUTER_RE);
    assert.ok(m, name);
    assert.equal(ROUTE_MAP[`1${m[1]}`], slug);
  }
  assert.equal('mrichard5152_138_whatever.pdf'.match(ROUTER_RE), null);
  assert.equal('unrelated_attachment.pdf'.match(ROUTER_RE), null);
});

test('known branch labels cover the CSV fixture exactly', () => {
  const p = parseSalesEfficiencyCsv(CSV_TEXT);
  for (const r of p.rows) assert.ok(SE_BRANCH_LABELS.includes(r.branch_code_raw), r.branch_code_raw);
});

// ── §G  the 13-band Total row is only trustworthy while the period is open ──
//
// FIELD_SETS[13] assumes the missing (count, volume) pair is the LAST one, Net.
// That holds for a month still accumulating, where net requires completion. It
// does NOT hold for a closed month with an empty bucket: March 2026 printed no
// Hold-HOA activity, so Net slid into the Hold slot and $8,357,993 of net sales
// was stored as hold_cents with nsa_cents NULL — silently. The band count alone
// cannot say which pair is absent, so coverage decides whether to trust it.

test('§G a closed-month 13-band file is REJECTED, not silently relabelled', () => {
  const asClosed = PDF_TEXT
    .replaceAll('8/5/2026 2:22PM', '9/3/2026 6:00PM');   // run AFTER 8/31
  const p = parseSalesEfficiencyPdf(asClosed);
  assert.equal(p.mode, 'unparseable');
  assert.equal(p.error, 'unexpected_band_count_13');
  assert.equal(p.detail.period_end, '2026-08-31');
  assert.equal(p.detail.printed_at, '2026-09-03');
});

test('§G an in-flight month still parses counts_only — the legitimate case', () => {
  const p = parseSalesEfficiencyPdf(PDF_TEXT);
  assert.equal(p.mode, 'counts_only');
  assert.equal(p.header.asOf, '2026-08-05', 'the printed run stamp is now read');
});

test('§G no run date means coverage cannot be proven — fail closed', () => {
  const undated = PDF_TEXT.replaceAll('8/5/2026 2:22PM', '');
  const p = parseSalesEfficiencyPdf(undated);
  assert.equal(p.mode, 'unparseable');
  assert.equal(p.error, 'unexpected_band_count_13');
});

test('§G the PDF parser is marked legacy and points at the CSV path', () => {
  const src = readFileSync('src/jobs/lp-report-parse-sales-efficiency.js', 'utf8');
  assert.match(src, /LEGACY \/ FROZEN/, 'the freeze must be stated in the file');
  assert.match(src, /do\s*\n?\s*\*?\s*not recalibrate bands from the header/i);
});
