/**
 * Guards for 137 variant routing — the 2026-08-13 "By Setter" handoff.
 *
 * Report 137 is exported By Market, By Setter and By Source, and all three
 * carry a BYTE-IDENTICAL header row. detectReportFromHeader therefore resolves
 * all three to 'sales_efficiency', and the only thing that tells them apart is
 * `xGrouper` — a data column on row 1, invisible to header fingerprinting.
 *
 * What that cost before the fix, and what these tests exist to prevent:
 *
 *   • setter names and lead-source names landing in branch_code_raw, a column
 *     whose every consumer reads it as a branch code;
 *   • two snapshots contending for is_current on one (report_type, period), so
 *     a market-level revenue number can silently become a setter-level one;
 *   • the unmapped-branch alert firing on ~26 rows every morning, which is how
 *     a real alert stops being read.
 *
 * The By Source case is not hypothetical: snapshot fe5df304 did exactly this on
 * 2026-08-11 with 29 lead sources.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseCsv, detectReportFromHeader, resolveVariant,
  REPORT_VARIANTS, CONTENT_SORT_KEYS,
} from '../src/jobs/lp-report-csv-common.js';
import { contentSha256 } from '../src/jobs/lp-report-common.js';
import {
  parseSalesEfficiencyCsv, computeSalesEfficiencyTotals, validateSalesEfficiency,
} from '../src/jobs/lp-report-parse-sales-efficiency.js';

const FIX = new URL('./fixtures/lp-reports/', import.meta.url);
const read = (n) => readFileSync(new URL(n, FIX), 'utf8');

const BY_MARKET = read('report-137-sales-efficiency-feb.csv');
const BY_SETTER = read('report-137-sales-efficiency-by-setter-feb.csv');
const BY_SOURCE = read('report-137-sales-efficiency-by-source-feb.csv');

const resolve = (text) => {
  const grid = parseCsv(text);
  const detected = detectReportFromHeader(grid[0]);
  return { detected, variant: resolveVariant(detected.reportType, grid[0], grid[1]), grid };
};

/** assert.throws returns undefined; these tests assert ON the error. */
const caught = (fn) => {
  try { fn(); } catch (err) { return err; }
  return assert.fail('expected a throw, got none');
};

// ── §1 the premise: the header genuinely cannot tell them apart ─────────────

test('§1 all three 137 variants share one header and one fingerprint', () => {
  const [m, s, o] = [BY_MARKET, BY_SETTER, BY_SOURCE].map((t) => parseCsv(t)[0]);
  assert.deepEqual(m, s, 'By Market and By Setter headers must be identical');
  assert.deepEqual(m, o, 'By Market and By Source headers must be identical');
  for (const h of [m, s, o]) {
    assert.deepEqual(detectReportFromHeader(h), { reportType: 'sales_efficiency', lpReportId: '137' });
  }
  // The discriminator is absent from the header — that is the whole problem.
  assert.ok(!m.includes('By Setter'), 'header must not carry the grouping');
});

// ── §2 the three tiers ─────────────────────────────────────────────────────

test('§2a By Market keeps the existing report type', () => {
  const { variant } = resolve(BY_MARKET);
  assert.equal(variant.reportType, 'sales_efficiency');
  assert.equal(variant.knownUnstored, false);
});

test('§2b By Setter routes to its own report type', () => {
  const { variant } = resolve(BY_SETTER);
  assert.equal(variant.reportType, 'sales_efficiency_by_setter');
  assert.equal(variant.knownUnstored, false);
});

test('§2c By Source is recognised, flagged unstored, and NOT rerouted', () => {
  const { variant } = resolve(BY_SOURCE);
  assert.equal(variant.knownUnstored, true);
  assert.equal(variant.variant, 'by source');
  // It must not acquire a storage type — there is no table for it.
  assert.equal(variant.reportType, 'sales_efficiency');
});

test('§2d an unseen grouping fails CLOSED, with the fingerprint error shape', () => {
  const grid = parseCsv(BY_MARKET);
  const iX = grid[0].indexOf('xGrouper');
  grid[1][iX] = 'By Product';
  const err = caught(() => resolveVariant('sales_efficiency', grid[0], grid[1]));
  assert.equal(err.message, 'unknown_report_variant');
  // The route's catch reads exactly these two fields.
  assert.equal(err.failureReason, 'unknown_report_variant');
  assert.equal(err.detail.reason, 'value_unmapped');
  assert.equal(err.detail.value, 'by product');
  assert.ok(err.detail.known.includes('by market'));
});

test('§2e a missing or empty xGrouper fails closed rather than defaulting', () => {
  const grid = parseCsv(BY_MARKET);
  const iX = grid[0].indexOf('xGrouper');

  const blank = grid[1].slice();
  blank[iX] = '   ';
  assert.equal(
    caught(() => resolveVariant('sales_efficiency', grid[0], blank)).detail.reason,
    'value_empty');

  const noCol = grid[0].filter((h) => h !== 'xGrouper');
  assert.equal(
    caught(() => resolveVariant('sales_efficiency', noCol, grid[1])).detail.reason,
    'column_absent');

  // A file with a header row and nothing else: row 1 is undefined, not empty.
  assert.equal(
    caught(() => resolveVariant('sales_efficiency', grid[0], undefined)).detail.reason,
    'value_empty');

  // Defaulting to By Market is precisely what wrote setter names into
  // branch_code_raw, so "throws" is the assertion, not an implementation note.
});

test('§2f casing and spacing in LP echo columns cannot break routing', () => {
  const grid = parseCsv(BY_SETTER);
  const iX = grid[0].indexOf('xGrouper');
  for (const spelling of ['BY SETTER', '  By Setter  ', 'by setter']) {
    const row = grid[1].slice();
    row[iX] = spelling;
    assert.equal(resolveVariant('sales_efficiency', grid[0], row).reportType,
      'sales_efficiency_by_setter', `failed on ${JSON.stringify(spelling)}`);
  }
  // …including the header spelling itself.
  const header = grid[0].map((h) => (h === 'xGrouper' ? 'XGROUPER' : h));
  assert.equal(resolveVariant('sales_efficiency', header, grid[1]).reportType,
    'sales_efficiency_by_setter');
});

// ── §3 the other reports must not start failing ────────────────────────────

test('§3 reports with no variant spec pass through untouched', () => {
  for (const type of ['job_status_ytd', 'lead_disposition', 'source_cost',
    'jobs_by_milestone', 'appt_stats_by_rep_source']) {
    assert.ok(!(type in REPORT_VARIANTS), `${type} must have no variant spec`);
    // No xGrouper anywhere, and no throw.
    const r = resolveVariant(type, ['Salesrep', 'Src_id'], ['x', 'y']);
    assert.deepEqual(r, { reportType: type, variant: null, knownUnstored: false });
  }
});

test('§3b 138 still routes by header, unaffected by variant resolution', () => {
  const grid = parseCsv(read('report-138-appt-stats-jan.csv'));
  const detected = detectReportFromHeader(grid[0]);
  assert.equal(detected.reportType, 'appt_stats_by_rep_source');
  assert.equal(resolveVariant(detected.reportType, grid[0], grid[1]).reportType,
    'appt_stats_by_rep_source');
});

// ── §4 the parser: row label follows the variant, market never does ─────────

test('§4a By Setter rows carry setter_name_raw and NO branch_code_raw', () => {
  const parsed = parseSalesEfficiencyCsv(BY_SETTER, { variant: 'sales_efficiency_by_setter' });
  assert.equal(parsed.rows.length, 9);
  for (const r of parsed.rows) {
    assert.ok(r.setter_name_raw, 'every row needs a setter label');
    assert.ok(!('branch_code_raw' in r), 'a setter row must not carry a branch column');
    assert.ok(!('market' in r), 'a setter row must never carry a market');
  }
  assert.equal(parsed.rows[0].setter_name_raw, 'Deer - LF, Craig');
});

test('§4b By Market is unchanged — branch_code_raw, no setter field', () => {
  const parsed = parseSalesEfficiencyCsv(BY_MARKET);
  assert.equal(parsed.rows[0].branch_code_raw, 'BOCA');
  assert.ok(!('setter_name_raw' in parsed.rows[0]));
  // Default arg must behave exactly like the explicit market variant.
  const explicit = parseSalesEfficiencyCsv(BY_MARKET, { variant: 'sales_efficiency' });
  assert.deepEqual(parsed.rows, explicit.rows);
});

test('§4c only the label differs — every money and count column ties out', () => {
  const market = parseSalesEfficiencyCsv(BY_MARKET);
  const setter = parseSalesEfficiencyCsv(BY_SETTER, { variant: 'sales_efficiency_by_setter' });
  assert.deepEqual(
    computeSalesEfficiencyTotals(setter.rows, setter.mode),
    computeSalesEfficiencyTotals(market.rows, market.mode),
    'the setter fixture is the market fixture relabelled; totals must match');
  assert.deepEqual(setter.header, market.header, 'period/as-of parsing is variant-independent');
});

test('§4d validation is shared and passes for the setter variant', () => {
  const parsed = parseSalesEfficiencyCsv(BY_SETTER, { variant: 'sales_efficiency_by_setter' });
  const v = validateSalesEfficiency(parsed, { todayIso: '2026-08-13' });
  assert.ok(v.ok, `setter file must validate: ${JSON.stringify(v.violations)}`);
});

// ── §5 the regression that actually matters: content identity forks ─────────

test('§5 same period, two variants → DIFFERENT content_sha256', () => {
  const market = parseSalesEfficiencyCsv(BY_MARKET);
  const setter = parseSalesEfficiencyCsv(BY_SETTER, { variant: 'sales_efficiency_by_setter' });

  const sha = (reportType, parsed) => contentSha256({
    reportType,
    periodStart: parsed.header.periodStart,
    periodEnd: parsed.header.periodEnd,
    scope: null,
    rows: parsed.rows,
    parserVersion: null,
    includeAsOf: false,
    sortKeys: CONTENT_SORT_KEYS[reportType] ?? null,
  });

  assert.notEqual(
    sha('sales_efficiency', market),
    sha('sales_efficiency_by_setter', setter),
    'identical periods must not share a content key, or one snapshot supersedes the other');

  // And the report_type alone is enough to fork it, even on identical rows —
  // this is what stops the is_current collision at its root.
  assert.notEqual(sha('sales_efficiency', market), sha('sales_efficiency_by_setter', market));
});

test('§5b the setter sort key names a field the parser actually emits', () => {
  // The five inert entries name raw CSV columns and so never sort (see the
  // comment on CONTENT_SORT_KEYS). 138 set the precedent; this follows it.
  const [key] = CONTENT_SORT_KEYS.sales_efficiency_by_setter;
  const parsed = parseSalesEfficiencyCsv(BY_SETTER, { variant: 'sales_efficiency_by_setter' });
  assert.ok(key in parsed.rows[0], `${key} must exist on a parsed setter row`);

  // Row order must not change identity, which is the point of sorting.
  const shuffled = { ...parsed, rows: [...parsed.rows].reverse() };
  const sha = (p) => contentSha256({
    reportType: 'sales_efficiency_by_setter',
    periodStart: p.header.periodStart, periodEnd: p.header.periodEnd, scope: null,
    rows: p.rows, parserVersion: null, includeAsOf: false,
    sortKeys: CONTENT_SORT_KEYS.sales_efficiency_by_setter,
  });
  assert.equal(sha(parsed), sha(shuffled), 'sorting must make row order irrelevant');
});

// ── §6 the By Source file must never reach the market table ────────────────

test('§6 the 2026-08-11 pollution cannot recur', () => {
  const { variant } = resolve(BY_SOURCE);
  // Recognised, so no alert; unstored, so no rows; not rerouted, so no table.
  assert.equal(variant.knownUnstored, true);
  assert.ok(REPORT_VARIANTS.sales_efficiency.knownUnstored.includes('by source'));
  assert.ok(!('by source' in REPORT_VARIANTS.sales_efficiency.map),
    'By Source must not resolve to a storage type until it has a table of its own');

  // Had it been parsed as By Market, these lead-source labels would have gone
  // into branch_code_raw and every one would have resolved UNRESOLVED.
  const asMarket = parseSalesEfficiencyCsv(BY_SOURCE);
  assert.equal(asMarket.rows[0].branch_code_raw, 'Bing PPC');
  assert.ok(!asMarket.rows.some((r) => /,/.test(r.branch_code_raw)),
    "and the handoff's LIKE '%,%' check would have found none of it");
});
