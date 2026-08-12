/**
 * Guards the Net — Released bridge on the CSV ingest path
 * (src/jobs/lp-csv-ingest.js).
 *
 * THE DEFECT (live 2026-08-06 → 2026-08-12, six days).
 *
 * `lp_market_scorecard_daily.released_dollars` and `revenue_as_of` are sourced
 * ONLY from `lp_net_report_rtp`. Nothing else writes that table, and nothing
 * downstream can recover the date without it. The PDF path has projected into
 * it since 2026-08-05 (`lp-report-ingest.js` §9, added precisely because a
 * good snapshot was rendering "report pending"). When LP moved report 134 off
 * the Report Scheduler onto the Export Scheduler, ingest moved from the PDF
 * path to the CSV path — which never had the bridge. Every ingest after the
 * cutover stored a complete, valid snapshot (rows, facts, control totals all
 * green) while `revenue_as_of` stayed pinned at the last PDF's 2026-08-06 and
 * the dashboard reported a date six days stale.
 *
 * The failure mode is what makes this worth a guard: NOTHING GOES RED. The
 * snapshot succeeds, the ingest log says success, no alert fires, no retry
 * happens. Only a derived date quietly stops moving — which is invisible until
 * somebody reads the number and asks why it is old.
 *
 * These are source-level assertions. `ingestCsv` needs Supabase, a parsed CSV
 * and an RPC round-trip to run, so a behavioural test would be an integration
 * test; the invariant worth protecting is structural — "the CSV path calls the
 * projection, for the right report type, without letting it retract a good
 * snapshot" — and that is exactly what a source scan can hold.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CSV = readFileSync('src/jobs/lp-csv-ingest.js', 'utf8');
const PDF = readFileSync('src/jobs/lp-report-ingest.js', 'utf8');
const BACKFILL = readFileSync('src/jobs/lp-report-backfill.js', 'utf8');

/** Source with comments stripped — a rule about CODE must not pass on prose. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const CSV_CODE = strip(CSV);
const PDF_CODE = strip(PDF);

// ─── The bridge exists on the CSV path ──────────────────────────────

test('the CSV ingest path projects into lp_net_report_rtp', () => {
  // THE REGRESSION GUARD. Without this call a 134 CSV lands a good snapshot
  // and `revenue_as_of` never advances — silently.
  assert.match(CSV_CODE, /projectSnapshotToNetReport\(snapshotId\)/);
});

test('the projection is gated on jobs_by_milestone', () => {
  // Only report 134 carries per-market RTP net. Projecting anything else would
  // write nonsense into the table the hero reads.
  assert.match(CSV_CODE, /reportType === 'jobs_by_milestone'/);
});

test('the projection is imported dynamically, keeping the module cycle broken', () => {
  // lp-report-backfill imports lp-report-ingest, which this file imports. A
  // static import here closes the cycle and breaks startup.
  assert.match(CSV_CODE, /await import\('\.\/lp-report-backfill\.js'\)/);
});

// ─── It cannot retract a good snapshot ──────────────────────────────

test('a failing projection is caught, not thrown', () => {
  // The snapshot is already durable and promoted when the projection runs.
  // Letting it throw would drop the caller into the finalize-assertion catch,
  // which marks the ingest failed and alerts — for a snapshot that is fine.
  const bridge = CSV_CODE.slice(CSV_CODE.indexOf('projectSnapshotToNetReport'));
  assert.match(bridge.slice(0, 600), /catch \(err\)/);
  assert.match(CSV_CODE, /reason: 'projection_failed'/);
});

test('a failing projection alerts rather than passing silently', () => {
  // Silence is the whole bug. A projection that fails must be louder than one
  // that never ran.
  const i = CSV_CODE.indexOf("reason: 'projection_failed'");
  assert.ok(i > 0, 'projection_failed branch missing');
  assert.match(CSV_CODE.slice(i, i + 700), /alertGroupMe/);
});

test('the projection result is reported on the ingest log and the response', () => {
  // Without this the only way to tell a projected ingest from a non-projected
  // one is to diff lp_net_report_rtp — which is how six days went unnoticed.
  assert.match(CSV_CODE, /net_projection: netProjection/);
});

// ─── Anti-vacuity: the things this depends on still exist ───────────

test('the PDF path still has the bridge this mirrors', () => {
  // If the PDF path lost it, the two paths agree again — but at the broken
  // value, and this guard would be protecting a lone survivor.
  assert.match(PDF_CODE, /projectSnapshotToNetReport\(snapshotId\)/);
  assert.match(PDF_CODE, /reportType === 'jobs_by_milestone'/);
});

test('projectSnapshotToNetReport is still exported and still writes the table', () => {
  assert.match(BACKFILL, /export async function projectSnapshotToNetReport\(snapshotId\)/);
  assert.match(BACKFILL, /\.from\('lp_net_report_rtp'\)\s*\n\s*\.upsert\(/);
});

test('projectSnapshotToNetReport still refuses a non-134 snapshot itself', () => {
  // Defence in depth: the call site gates on report type AND the function does.
  assert.match(BACKFILL, /reason: 'not_jobs_by_milestone'/);
});

test('lp_net_report_rtp is still the only source of the released hero', () => {
  // The premise of the whole fix. If released_dollars is ever re-sourced, this
  // bridge stops being load-bearing and this file should be revisited rather
  // than left asserting a stale coupling.
  const RTP = readFileSync('src/jobs/scorecard-rtp-source.js', 'utf8');
  assert.match(RTP, /lp_net_report_rtp/);
});

// ─── Ordering: the bridge runs on a promoted snapshot ───────────────

test('the projection runs AFTER finalize, on a promoted snapshot', () => {
  // Projecting before finalize would read rows that are not yet current, and
  // could publish revenue for a snapshot the assertions are about to reject.
  const finalize = CSV_CODE.indexOf('lp_csv_ingest_finalize');
  const project = CSV_CODE.indexOf('projectSnapshotToNetReport');
  assert.ok(finalize > 0 && project > 0, 'expected both finalize and projection in the CSV path');
  assert.ok(project > finalize,
    'the net-report projection must run after lp_csv_ingest_finalize, not before');
});
