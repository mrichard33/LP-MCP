/**
 * Guards for src/jobs/lp-report-backfill.js — the historical backfill path.
 *
 * Invariants under guard:
 *   • The backfill uses the IDENTICAL ingest pipeline — it imports
 *     ingestReportPdf from lp-report-ingest.js and validateJobsByMilestone is
 *     never re-implemented (asserted against the module source: backfilled
 *     months must carry exactly the guarantees daily months do).
 *   • The declared-period gate (rule wrong_period) lives in the SHARED
 *     validator — see test-lp-report-parse-a.js for its behavior tests.
 *   • The lp_net_report_rtp projection sums per-market net exactly, includes
 *     the REECE roll-up (= Σ every market, so no revenue can silently drop),
 *     and counts rows per market.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { sumSnapshotNetByMarket } from '../src/jobs/lp-report-backfill.js';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/jobs/lp-report-backfill.js'),
  'utf8',
);

test('backfill runs the identical ingest pipeline — no forked parser or validator', () => {
  // The one-and-only ingest entry point is imported, not re-implemented.
  assert.match(SRC, /import\s*\{\s*ingestReportPdf\s*\}\s*from\s*'\.\/lp-report-ingest\.js'/);
  // No parallel parse/validate: the backfill module must not import or define
  // its own parser/validator.
  assert.doesNotMatch(SRC, /parseJobsByMilestone|validateJobsByMilestone|pdftotext/);
  // The freeze bridge reuses the proven restate (June mechanism), not a copy.
  assert.match(SRC, /import\s*\{\s*restateClosedFromReport\s*\}\s*from\s*'\.\/scorecard-rtp-source\.js'/);
});

test('projection: per-market sums, REECE roll-up = Σ every market, row counts', () => {
  const rows = [
    { market: 'ORL_MKT', net_cents: 100_000_00 },
    { market: 'ORL_MKT', net_cents: 15_842_400 }, // 158,424.00
    { market: 'LAKE_MKT', net_cents: 6_327_300 },
    { market: 'STPET_MKT', net_cents: 230_239_819 },
    { market: 'FTLAU_MKT', net_cents: 8_205_608 },
  ];
  const byMarket = sumSnapshotNetByMarket(rows);

  assert.equal(byMarket.get('ORL_MKT').cents, 25_842_400);
  assert.equal(byMarket.get('ORL_MKT').rows, 2);
  assert.equal(byMarket.get('LAKE_MKT').cents, 6_327_300);
  assert.equal(byMarket.get('STPET_MKT').cents, 230_239_819);
  assert.equal(byMarket.get('FTLAU_MKT').cents, 8_205_608);

  const total = rows.reduce((a, r) => a + r.net_cents, 0);
  assert.equal(byMarket.get('REECE').cents, total, 'REECE roll-up must equal Σ every market to the cent');
  assert.equal(byMarket.get('REECE').rows, rows.length);
});

test('projection: null net counts as 0, never NaN', () => {
  const byMarket = sumSnapshotNetByMarket([
    { market: 'SAR_MKT', net_cents: null },
    { market: 'SAR_MKT', net_cents: 500 },
  ]);
  assert.equal(byMarket.get('SAR_MKT').cents, 500);
  assert.equal(byMarket.get('REECE').cents, 500);
});

// ── §2 (2026-08-05): the Net — Released hero was blank for a live month ─────
// lp_market_scorecard_daily.released_dollars is sourced ONLY from
// lp_net_report_rtp, and the ONLY writer of that table was this backfill
// route. A daily jobs_by_milestone snapshot therefore never produced a row:
// Aug 1–31 sat current with net $702,506 while the hero read "report pending"
// and lp_net_report_rtp's newest row was July.

test('the daily ingest path projects into lp_net_report_rtp — not just the backfill', async () => {
  const ingestSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../src/jobs/lp-report-ingest.js'),
    'utf8',
  );
  assert.match(
    ingestSrc,
    /projectSnapshotToNetReport/,
    'ingestReportPdf must bridge jobs_by_milestone snapshots into lp_net_report_rtp',
  );
  // The projection is exported (it used to be module-private, which is why
  // only the backfill could reach it).
  const mod = await import('../src/jobs/lp-report-backfill.js');
  assert.equal(typeof mod.projectSnapshotToNetReport, 'function');
});

test('report_as_of never claims coverage past the generation date', async () => {
  const { coverageEndOf } = await import('../src/jobs/lp-report-backfill.js');
  // LP prints the SCHEDULED window: a pull run Aug 5 declares period_end Aug 31.
  assert.equal(coverageEndOf('2026-08-31', '2026-08-05'), '2026-08-05');
  // A closed month generated later keeps its own end date.
  assert.equal(coverageEndOf('2026-07-31', '2026-08-05'), '2026-07-31');
  // Same-day pulls are unchanged; a missing as_of falls back to the declared end.
  assert.equal(coverageEndOf('2026-08-05', '2026-08-05'), '2026-08-05');
  assert.equal(coverageEndOf('2026-08-31', null), '2026-08-31');
});
