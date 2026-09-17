/**
 * Scope and window handling in the report-137 recon checks —
 * src/jobs/lp-report-recon.js.
 *
 * Regression cover for the two warnings that fired through 2026-09-17. Both were
 * recon defects; report 137's figures were fine throughout.
 *
 *   se_hold_vs_job_status_hoa  An ingest race. The recon ran at 11:00:17 UTC and
 *                              the 137 snapshot landed at 11:00:26 UTC — nine
 *                              seconds later — so currentSnapshot() per report
 *                              compared the 09-15 137 snapshot against the 09-16
 *                              job_status snapshot.
 *   se_internal                A YTD-measured exact-match constant applied to MTD
 *                              residuals. Across all 43 rows written since
 *                              2026-08-06 it never once matched.
 *
 * THE ASSERTION THAT DROVE THE DESIGN is 'pairOnWindow falls back to AUGUST'
 * below. Swapping currentSnapshot() for pairOnWindow() looks like the fix and is
 * not: pairOnWindow walks every is_current snapshot, and both reports still carry
 * an August one, so a late 137 ingest yields a real pair of month-old data and a
 * silent 'pass'. That is why pairOnCurrentWindow exists.
 *
 * Run: node --test scripts/test-lp-report-recon-scope.js
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  compareBuckets, pairOnWindow, pairOnCurrentWindow, windowList,
  SE_BUCKET_RESIDUAL, SE_MTD_RESIDUAL_TOLERANCE_CENTS, SE_HOLD_VS_HOA_TOLERANCE,
} from '../src/jobs/lp-report-recon.js';

const SRC = readFileSync('src/jobs/lp-report-recon.js', 'utf8');

const residual = (cents) => ({ residual: { count: 0, cents } });
const ZERO = { residual: { count: 0, cents: 0 } };

// Real production residuals, measured from scorecard_recon_results. The full
// observed MTD range is -17,200.00 … +38,881.00.
const OBSERVED_MTD_RESIDUALS = [
  ['2026-09-10/11', -1720000],
  ['2026-09-12..15', 1096400],
  ['2026-09-16/17', 3888100],
];

// ── se_internal: YTD keeps the exact-match constant ─────────────────────────

test('YTD: the named $246,768 residual is consumed exactly, and annotated', () => {
  const cmp = compareBuckets(residual(SE_BUCKET_RESIDUAL.cents), ZERO,
    { namedExceptions: { SE_BUCKET_RESIDUAL } });
  assert.equal(cmp.ok, true);
  assert.deepEqual(cmp.applied_exceptions, ['SE_BUCKET_RESIDUAL'],
    'a consumed exception is annotated, never silently swallowed');
});

test('YTD: a residual that is NOT the named constant still warns', () => {
  const cmp = compareBuckets(residual(3888100), ZERO,
    { namedExceptions: { SE_BUCKET_RESIDUAL } });
  assert.equal(cmp.ok, false);
});

// ── se_internal: MTD uses a band, and every real residual passes it ─────────

for (const [label, cents] of OBSERVED_MTD_RESIDUALS) {
  test(`MTD: observed residual ${label} (${cents}) is inside the band`, () => {
    const cmp = compareBuckets(residual(cents), ZERO,
      { toleranceCents: SE_MTD_RESIDUAL_TOLERANCE_CENTS });
    assert.equal(cmp.ok, true, `${label} must not warn`);
  });
}

test('MTD: the YTD constant would NEVER have matched an MTD residual', () => {
  // The whole bug: exact-match against a figure measured on a different window.
  // named_exceptions was NULL on all 43 se_internal rows ever written.
  for (const [label, cents] of OBSERVED_MTD_RESIDUALS) {
    const cmp = compareBuckets(residual(cents), ZERO,
      { namedExceptions: { SE_BUCKET_RESIDUAL } });
    assert.equal(cmp.ok, false, `${label} warns under the YTD constant`);
    assert.deepEqual(cmp.applied_exceptions, [], `${label} consumes no exception`);
  }
});

test('MTD: a residual past the band still warns', () => {
  const cmp = compareBuckets(residual(SE_MTD_RESIDUAL_TOLERANCE_CENTS + 1), ZERO,
    { toleranceCents: SE_MTD_RESIDUAL_TOLERANCE_CENTS });
  assert.equal(cmp.ok, false);
});

test('the band is headroom over the measured range, not a figure tuned to pass', () => {
  const maxObserved = Math.max(...OBSERVED_MTD_RESIDUALS.map(([, c]) => Math.abs(c)));
  assert.equal(maxObserved, 3888100, 'max |residual| ever recorded is $38,881.00');
  assert.ok(SE_MTD_RESIDUAL_TOLERANCE_CENTS > maxObserved,
    'a band equal to the worst observed value is tuning, not tolerance');
});

// ── window pairing: the part that looks done and is not ────────────────────

const snap = (id, start, end, scope) =>
  ({ id, period_start: start, period_end: end, scope });

const SE_15 = snap('se-15', '2026-09-01', '2026-09-15', 'mtd'); // yesterday's 137
const SE_16 = snap('se-16', '2026-09-01', '2026-09-16', 'mtd'); // today's, once ingested
const JS_16 = snap('js-16', '2026-09-01', '2026-09-16', 'mtd');
const SE_AUG = snap('se-aug', '2026-08-01', '2026-08-31', 'month');
const JS_AUG = snap('js-aug', '2026-08-01', '2026-08-31', 'month');

// currentSnapshots() orders by period_end DESC, so callers see newest first.
const SE_RACE = [SE_15, SE_AUG];
const JS_RACE = [JS_16, JS_AUG];

test('the 2026-09-17 race: newest-of-each pairs 09-15 with 09-16', () => {
  assert.notEqual(SE_15.period_end, JS_16.period_end,
    'currentSnapshot() per report is how the phantom delta was manufactured');
});

test('pairOnWindow SILENTLY FALLS BACK TO AUGUST — it does not return null', () => {
  // The finding that changed the design. Both reports keep historical monthly
  // snapshots is_current, so the walk finds a real shared window a month old.
  // Live proof: §F's se_gsa_vs_milestone_gross recorded window
  // 2026-08-01..2026-08-31 on 2026-09-17, and September on every other day.
  const p = pairOnWindow(SE_RACE, JS_RACE);
  assert.ok(p, 'pairOnWindow finds a pair here — that is precisely the problem');
  assert.equal(p.lhs.id, 'se-aug');
  assert.equal(p.rhs.id, 'js-aug');
});

test('pairOnCurrentWindow refuses it — skipped beats a stale pass', () => {
  assert.equal(pairOnCurrentWindow(SE_RACE, JS_RACE), null);
});

test('pairOnCurrentWindow pairs once the 137 ingest has landed', () => {
  const p = pairOnCurrentWindow([SE_16, SE_AUG], JS_RACE);
  assert.ok(p);
  assert.equal(p.lhs.id, 'se-16');
  assert.equal(p.rhs.id, 'js-16');
});

test('pairOnCurrentWindow returns null when either side has no snapshot', () => {
  assert.equal(pairOnCurrentWindow([], JS_RACE), null);
  assert.equal(pairOnCurrentWindow(SE_RACE, []), null);
});

test('pairOnCurrentWindow matches the WINDOW, not the scope label', () => {
  // scope is derived per report; the same span can carry different labels.
  const l = snap('L', '2026-09-01', '2026-09-16', 'mtd');
  const r = snap('R', '2026-09-01', '2026-09-16', 'month');
  assert.equal(pairOnCurrentWindow([l], [r])?.rhs.id, 'R');
});

test('a skip reason names the windows each side actually had', () => {
  assert.deepEqual(windowList(SE_RACE),
    ['2026-09-01..2026-09-15(mtd)', '2026-08-01..2026-08-31(month)']);
});

// ── se_hold on a genuinely shared window ───────────────────────────────────

test('on a shared window the real 2026-09-16 Hold/HOA figures tie exactly', () => {
  const cmp = compareBuckets(
    { hoa_hold: { count: 33, cents: 80358500 } },
    { hoa_hold: { count: 33, cents: 80358500 } },
    { namedExceptions: { SE_HOLD_VS_HOA_TOLERANCE } },
  );
  assert.equal(cmp.ok, true);
  assert.deepEqual(cmp.applied_exceptions, [],
    'they tie outright — the named tolerance is not consumed');
});

test('a REAL Hold/HOA divergence on a shared window still warns', () => {
  const cmp = compareBuckets(
    { hoa_hold: { count: 33, cents: 80358500 } },
    { hoa_hold: { count: 40, cents: 99000000 } },
    { namedExceptions: { SE_HOLD_VS_HOA_TOLERANCE } },
  );
  assert.equal(cmp.ok, false);
});

// ── static tripwires (NOT behavioural coverage — they read source text) ────

test('[static] se_hold pairs on the CURRENT window and drops currentSnapshot', () => {
  assert.match(SRC, /const holdPair = pairOnCurrentWindow\(seSnapsHold, jsSnaps\)/);
  assert.ok(!/currentSnapshot\('job_status_ytd'\)/.test(SRC),
    'the newest-of-each read is what caused the phantom delta');
});

test('[static] the skip row names the stale shared window it declined', () => {
  assert.match(SRC, /declined_stale_shared_window/);
});

test('[static] currentSnapshot selects scope — se_internal branches on it', () => {
  const sel = SRC.slice(SRC.indexOf('async function currentSnapshot('));
  assert.match(sel.slice(0, 400), /\.select\('id, period_start, period_end, scope,/);
});

test('[static] the daily run hour is env-tunable, not hardcoded', () => {
  assert.match(SRC, /LP_REPORT_RECON_HOUR_ET/);
  assert.match(SRC, /hourET\(\) === RECON_HOUR_ET/);
  assert.ok(!/hourET\(\) === 7\b/.test(SRC));
});
