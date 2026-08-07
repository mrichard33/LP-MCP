/**
 * Guards for the §F CROSS-REPORT reconciliations — src/jobs/lp-report-recon.js.
 *
 * Two checks compare one LP report against another:
 *   lead_count_vs_source_raw   135 record count vs summed 136 NumRaw
 *   se_gsa_vs_milestone_gross  137 per-market GSA vs 134 summed GrossAmount
 *
 * THE POINT OF THESE TESTS IS THAT NEITHER CAN EVER BLOCK ANYTHING. They are
 * observability: they record a number someone can look at when two reports
 * disagree. They must never return 'fail', never alert, and never reject a
 * file. Every other assertion here is secondary to that one.
 *
 * The numbers below are real, measured against production 2026-08-07 — which
 * is also how we know a threshold on the 137/134 delta would be worthless.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { pairOnWindow, windowList } from '../src/jobs/lp-report-recon.js';

const SRC = readFileSync('src/jobs/lp-report-recon.js', 'utf8');
const CROSS_FN = SRC.slice(SRC.indexOf('async function runCrossReportRecon'));

// ── the invariant everything else serves ────────────────────────────────────

test('§F neither cross-report check can EVER return fail', () => {
  assert.ok(CROSS_FN.length > 0, 'runCrossReportRecon must exist');
  assert.ok(!/'fail'/.test(CROSS_FN),
    "a cross-report check that can fail can block a send — §F forbids it");
});

test('§F neither cross-report check can page anyone', () => {
  assert.ok(!/alertGroupMe/.test(CROSS_FN),
    'these are advisory; paging on an expected difference trains people to ignore alarms');
});

test('§F both checks are wired into the daily run', () => {
  assert.match(SRC, /results\.push\(\.\.\.await runCrossReportRecon\(date\)\)/);
  assert.match(CROSS_FN, /'lead_count_vs_source_raw'/);
  assert.match(CROSS_FN, /'se_gsa_vs_milestone_gross'/);
});

// ── window pairing: the hard part ───────────────────────────────────────────

const snap = (id, start, end, scope, rowCount = 0) =>
  ({ id, period_start: start, period_end: end, scope, row_count: rowCount });

test('pairing matches on the WINDOW, not the scope label', () => {
  // The same span can carry different scope labels per report type, because
  // scope is derived independently. Matching on the label would miss real pairs.
  const lhs = [snap('L1', '2026-08-01', '2026-08-31', 'mtd')];
  const rhs = [snap('R1', '2026-08-01', '2026-08-31', 'month')];
  const p = pairOnWindow(lhs, rhs);
  assert.equal(p?.lhs.id, 'L1');
  assert.equal(p?.rhs.id, 'R1');
});

test('pairing refuses windows that merely overlap', () => {
  // 135 YTD (Jan–Aug 5) vs 136 YTD (Jan–Aug 6) describe different spans.
  // Comparing them would manufacture a difference out of the calendar.
  const lhs = [snap('L1', '2026-01-01', '2026-08-05', 'ytd')];
  const rhs = [snap('R1', '2026-01-01', '2026-08-06', 'ytd')];
  assert.equal(pairOnWindow(lhs, rhs), null);
});

test('pairing takes the newest shared window when several match', () => {
  // Callers pass snapshots ordered newest-window-first, so the first hit wins.
  const lhs = [
    snap('L_AUG', '2026-08-01', '2026-08-31', 'mtd'),
    snap('L_YTD', '2026-01-01', '2026-08-05', 'ytd'),
  ];
  const rhs = [
    snap('R_AUG', '2026-08-01', '2026-08-31', 'month'),
    snap('R_YTD', '2026-01-01', '2026-08-05', 'ytd'),
  ];
  assert.equal(pairOnWindow(lhs, rhs)?.lhs.id, 'L_AUG');
});

test('no shared window returns null rather than a wrong pair', () => {
  // The real 2026-08-07 state: 135 has an August window, 136 does not.
  const ld = [
    snap('LD_AUG', '2026-08-01', '2026-08-31', 'mtd', 1194),
    snap('LD_YTD', '2026-01-01', '2026-08-05', 'ytd', 78557),
  ];
  const sc = [snap('SC_MAR', '2026-03-01', '2026-03-31', 'custom')];
  assert.equal(pairOnWindow(ld, sc), null);
});

test('a skip reason names the windows each side actually had', () => {
  // Without this, "no result" and "never ran" look identical — the ambiguity
  // that kept the ingest-log CHECK bug invisible for days.
  const ld = [snap('LD_AUG', '2026-08-01', '2026-08-31', 'mtd', 1194)];
  assert.deepEqual(windowList(ld), ['2026-08-01..2026-08-31(mtd)']);
  assert.match(CROSS_FN, /lead_disposition_windows/);
  assert.match(CROSS_FN, /source_cost_windows/);
  assert.match(CROSS_FN, /sales_efficiency_windows/);
  assert.match(CROSS_FN, /jobs_by_milestone_windows/);
});

// ── 135 vs 136 ──────────────────────────────────────────────────────────────

test('§F 135↔136 ties → pass; drift → warn, never worse', () => {
  // Ceiling is 'warn'. The status expression is the whole safety property.
  assert.match(CROSS_FN, /delta === 0 \? 'pass' : 'warn'/);
});

test('§F 135↔136 records both sides and the delta, not just a verdict', () => {
  // 2026-08-07 YTD: 78,557 records vs 78,561 NumRaw. Someone reading the row
  // must be able to see WHICH side moved without re-deriving it.
  for (const field of ['record_count', 'sum_num_raw', 'delta', 'window']) {
    assert.match(CROSS_FN, new RegExp(field), `comparison must carry ${field}`);
  }
  const delta = 78557 - 78561;
  assert.equal(delta, -4, 'the measured YTD drift');
});

// ── 137 vs 134 ──────────────────────────────────────────────────────────────

test('§F 137↔134 is warn-only and says outright that differing is expected', () => {
  const block = CROSS_FN.slice(CROSS_FN.indexOf("'se_gsa_vs_milestone_gross'"));
  assert.match(block, /EXPECTED TO DIFFER/,
    'a reader must not mistake a large delta for a defect');
  assert.ok(!/'pass'/.test(block.slice(0, block.indexOf('return out'))),
    'it never ties, so claiming pass would be a lie');
});

test('§F 137↔134 unions markets — a market on one side is never dropped', () => {
  // An inner join loses markets: Feb matched 7 of 9 against production.
  assert.match(CROSS_FN, /markets_only_in_137/);
  assert.match(CROSS_FN, /markets_only_in_134/);
  assert.match(CROSS_FN, /new Set\(\[\.\.\.seByMarket\.keys\(\), \.\.\.msByMarket\.keys\(\)\]\)/);
});

test('§F the measured deltas are structural — proving a threshold is useless', () => {
  // Real per-market figures, production 2026-08-07. A rule that passed all of
  // these would have to admit everything from −39% to +185%.
  const measured = [
    { period: 'Feb', market: 'JAX', se: 53930300, ms: 18898800 },
    { period: 'Feb', market: 'FTLAU', se: 68365800, ms: 41552000 },
    { period: 'Mar', market: 'FTMYR', se: 350539800, ms: 251771800 },
    { period: 'Aug', market: 'ORL', se: 10927000, ms: 18013000 },
    { period: 'Aug', market: 'STPET', se: 10214200, ms: 16038100 },
  ];
  const ratios = measured.map((m) => m.se / m.ms);
  assert.ok(Math.max(...ratios) > 2.8, 'some markets run nearly 3x');
  assert.ok(Math.min(...ratios) < 0.7, 'and others run well under 1x');
  assert.ok(measured.some((m) => m.se - m.ms < 0), 'the delta goes negative');
  assert.ok(measured.some((m) => m.se - m.ms > 0), 'and positive, in the same report');
});

test('§F 137↔134 carries the per-market breakdown inside one row', () => {
  // scorecard_recon_results is UNIQUE (recon_date, recon_type), so per-market
  // detail cannot be separate rows — it goes in the comparison jsonb.
  assert.match(CROSS_FN, /per_market: perMarket/);
  assert.match(CROSS_FN, /total_delta_cents/);
});
