/**
 * Idempotency guards for the LP report ingest paths (handoff 2026-08-05 §3).
 *
 * WHAT WAS ACTUALLY OBSERVED: five `jobs_by_milestone` snapshots for Aug 1–31
 * existed on 2026-08-05. Their SHA-256s are all DIFFERENT (656e15f6, 3944e6d1,
 * 82f5cdd4 at 17:00:53–59; 37ff8441, 591f5cf2 at 21:52:36; a9842b0e at
 * 22:05:54) — LP re-sent regenerated PDFs whose bytes differ (embedded
 * generation timestamps), so byte-level dedup could not and should not have
 * collapsed them. Overlap-demotion kept exactly one current, which is the
 * invariant that matters. These tests pin the two mechanisms that make that
 * true, so a future refactor can't quietly drop either:
 *
 *   1. Same bytes twice ⇒ ONE snapshot. The SHA check runs BEFORE any insert
 *      and returns the existing snapshot as a no-op success (never a second
 *      row, never a 500 that makes n8n retry forever).
 *   2. The database is the backstop: UNIQUE (report_type, file_sha256). Even
 *      if a caller skipped the JS check, the second insert cannot land.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');

const INGEST = read('../src/jobs/lp-report-ingest.js');
const CSV = read('../src/jobs/lp-csv-ingest.js');

test('PDF path: the sha duplicate check runs BEFORE the ingest RPC', () => {
  const dupAt = INGEST.indexOf("eq('file_sha256', sha)");
  const rpcAt = INGEST.indexOf("rpc('scorecard_ingest_snapshot'");
  assert.ok(dupAt > 0, 'duplicate check must exist');
  assert.ok(rpcAt > 0, 'ingest RPC must exist');
  assert.ok(dupAt < rpcAt, 'the duplicate check must precede the insert, not follow it');
});

test('PDF path: a repeat of the SAME file is a success no-op, not a new snapshot', () => {
  // The duplicate branch returns the EXISTING snapshot id and never falls
  // through to the parse/insert path. A 200 keeps n8n from retrying a file
  // that will always be a duplicate.
  const branch = INGEST.slice(INGEST.indexOf('if (dup) {'), INGEST.indexOf('if (dup) {') + 260);
  assert.match(branch, /done\('duplicate'/);
  assert.match(branch, /success:\s*true/);
  assert.match(branch, /duplicate:\s*true/);
  assert.match(branch, /snapshot_id:\s*dup\.id/);
  assert.match(branch, /return/);
});

test('CSV/PDF chunked path: duplicate check ignores UNFINALIZED snapshots', () => {
  // A snapshot whose finalize failed (fail-closed gate) leaves a row holding
  // the sha. Retrying the same file must be allowed to complete rather than
  // being reported as an already-ingested duplicate — hence the
  // finalized_at NOT NULL filter on every duplicate probe.
  const probes = CSV.match(/\.eq\('file_sha256'[\s\S]{0,220}?maybeSingle\(\)/g) ?? [];
  assert.ok(probes.length > 0, 'the chunked path must probe for duplicates');
  for (const p of probes) {
    assert.match(p, /not\('finalized_at',\s*'is',\s*null\)/,
      'each duplicate probe must only match FINALIZED snapshots');
  }
});

test('the database backstops dedup: UNIQUE (report_type, file_sha256)', () => {
  // A caller that skipped the JS check still cannot create a second snapshot
  // for identical bytes — the constraint is declared on the table itself.
  const sql = read('../sql/migrations/2026-08-04_scorecard_lp_reports.sql');
  assert.match(sql, /UNIQUE\s*\(\s*report_type\s*,\s*file_sha256\s*\)/i);
});

test('one current snapshot per (report_type, scope, period_start)', () => {
  // The partial unique index is what makes "five duplicate rows" harmless:
  // duplicates are retained history, and only one can be current per window.
  const sql = read('../sql/migrations/2026-08-05_snapshot_scope.sql');
  assert.match(
    sql,
    /CREATE UNIQUE INDEX scorecard_report_snapshots_current_idx[\s\S]*?\(report_type, scope, period_start\)[\s\S]*?WHERE is_current/,
  );
});

test('promotion is scope-confined — an MTD arrival cannot demote a YTD snapshot', () => {
  // The §1 regression: five same-window snapshots are harmless because
  // overlap-demotion keeps one current, but that rule must never reach across
  // scopes. Both promotion sites carry the same family predicate.
  const sql = read('../sql/migrations/2026-08-05_snapshot_scope.sql');
  const demotions = sql.match(/SET is_current = false[\s\S]{0,420}?RETURNING id/g) ?? [];
  assert.equal(demotions.length, 2, 'both promotion RPCs must demote');
  for (const d of demotions) {
    assert.match(d, /daterange\(period_start, period_end, '\[\]'\) &&/, 'overlap rule retained');
    assert.match(d, /scope IN \('mtd', 'month'\)/, 'mtd+month are one family');
    assert.match(d, /scope = (v_scope|s\.scope)/, 'demotion is confined to the same scope');
  }
});
