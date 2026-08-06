/**
 * Guards for snapshot IDENTITY — src/jobs/lp-report-common.js (contentSha256)
 * and src/jobs/lp-report-ingest.js (canonicalReportType).
 *
 * Both exist because of live defects found on 2026-08-06:
 *
 *   · Eight jobs_by_milestone snapshots for one period — all 30 rows, all net
 *     $702,506, every one with a DISTINCT file_sha256 (two landing 20ms and
 *     43ms apart). The byte hash was working; LP simply re-renders the PDF on
 *     each fetch, so the same report arrives as different bytes.
 *
 *   · The ingest log carried BOTH spellings of three report types
 *     (lead_disposition / lead-disposition, source_cost / source-cost,
 *     sales_efficiency / sales-efficiency), because the telemetry endpoint fell
 *     back to the raw hyphenated slug for anything not in REPORT_TYPES — which
 *     held only the two routed reports. Every failure was double-counted.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import { contentSha256, sha256Hex } from '../src/jobs/lp-report-common.js';
import { canonicalReportType, REPORT_TYPES } from '../src/jobs/lp-report-ingest.js';

const WINDOW = {
  reportType: 'jobs_by_milestone',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  asOfDate: '2026-08-05',
  scope: 'mtd',
};

const ROWS = [
  { job_number: '1001', market: 'ORL_MKT', net_cents: 1_500_00, rtp_date: '2026-08-03' },
  { job_number: '1002', market: 'SAR_MKT', net_cents: 2_500_00, rtp_date: '2026-08-04' },
];

test('the same report re-rendered into different bytes is ONE content identity', () => {
  // Two different PDFs, same parsed content — the live case exactly.
  assert.notEqual(sha256Hex(Buffer.from('pdf-render-A')), sha256Hex(Buffer.from('pdf-render-B')));
  const a = contentSha256({ ...WINDOW, rows: ROWS });
  const b = contentSha256({ ...WINDOW, rows: ROWS.map((r) => ({ ...r })) });
  assert.equal(a, b);
});

test('field ORDER does not change identity — a parser refactor is not a new report', () => {
  const reordered = ROWS.map((r) => ({
    rtp_date: r.rtp_date, net_cents: r.net_cents, market: r.market, job_number: r.job_number,
  }));
  assert.equal(contentSha256({ ...WINDOW, rows: reordered }), contentSha256({ ...WINDOW, rows: ROWS }));
});

test('transient underscore fields are excluded from identity', () => {
  const withTransient = ROWS.map((r) => ({ ...r, _renders_cents: true }));
  assert.equal(contentSha256({ ...WINDOW, rows: withTransient }), contentSha256({ ...WINDOW, rows: ROWS }));
});

test('ANY material row change is a different report — totals alone are not enough', () => {
  // The reason identity hashes ROWS, not control totals: this pair has the same
  // row count AND the same net total, but one row genuinely changed. Hashing
  // totals would have silently dropped it as a duplicate.
  const shifted = [
    { ...ROWS[0], net_cents: 1_000_00 },
    { ...ROWS[1], net_cents: 3_000_00 },
  ];
  const sum = (rs) => rs.reduce((a, r) => a + r.net_cents, 0);
  assert.equal(sum(shifted), sum(ROWS));
  assert.equal(shifted.length, ROWS.length);
  assert.notEqual(contentSha256({ ...WINDOW, rows: shifted }), contentSha256({ ...WINDOW, rows: ROWS }));
});

test('a different window is a different report even with identical rows', () => {
  const ytd = contentSha256({ ...WINDOW, scope: 'ytd', periodStart: '2026-01-01', rows: ROWS });
  assert.notEqual(ytd, contentSha256({ ...WINDOW, rows: ROWS }));
  // as_of alone distinguishes two pulls of the same window on different days.
  const nextDay = contentSha256({ ...WINDOW, asOfDate: '2026-08-06', rows: ROWS });
  assert.notEqual(nextDay, contentSha256({ ...WINDOW, rows: ROWS }));
});

test('a status change that preserves row count and money still differs', () => {
  // Jobs By Status: bucket mix shifts, gross holds. Must NOT dedupe.
  const w = { ...WINDOW, reportType: 'jobs_by_status' };
  const before = [{ prosp_number: '9', total_gross_cents: 100, status_raw: 'Hold - HOA' }];
  const after = [{ prosp_number: '9', total_gross_cents: 100, status_raw: 'Hold - Permit' }];
  assert.notEqual(contentSha256({ ...w, rows: after }), contentSha256({ ...w, rows: before }));
});

test('canonicalReportType folds every known slug to ONE key', () => {
  assert.equal(canonicalReportType('lead-disposition'), 'lead_disposition');
  assert.equal(canonicalReportType('lead_disposition'), 'lead_disposition');
  assert.equal(canonicalReportType('source-cost'), 'source_cost');
  assert.equal(canonicalReportType('source_cost'), 'source_cost');
  assert.equal(canonicalReportType('sales-efficiency'), 'sales_efficiency');
  assert.equal(canonicalReportType('jobs-by-milestone'), 'jobs_by_milestone');
  assert.equal(canonicalReportType('jobs-by-status'), 'jobs_by_status');
  assert.equal(canonicalReportType('job-status'), 'job_status_ytd');
});

test('the two routed slugs still resolve exactly as before', () => {
  for (const [slug, type] of Object.entries(REPORT_TYPES)) {
    assert.equal(canonicalReportType(slug), type);
  }
});

test('an UNKNOWN report stays visible but cannot fragment a known key', () => {
  // Hyphens fold so a new spelling never opens a second key, but the report is
  // returned rather than dropped — an unknown feed must surface, not vanish.
  assert.equal(canonicalReportType('brand-new-report'), 'brand_new_report');
  assert.equal(canonicalReportType('  Source-Cost  '), 'source_cost');
  assert.equal(canonicalReportType(''), null);
  assert.equal(canonicalReportType(null), null);
});
