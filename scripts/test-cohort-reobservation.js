/**
 * Guards for src/jobs/cohort-reobservation.js — the §8 staleness monitor.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Net Sales (Gross Written − Cancellations
 * − Financing Denied) matures DOWNWARD as losses land: 84.8% of gross at under
 * a month old, 76.3% at one month, ~70% by two or three. A cohort that stops
 * being re-observed freezes at its first, highest reading — so the failure mode
 * is not a missing number, it is a plausible number that is quietly too
 * flattering. Nothing about it looks broken, which is exactly why absence has
 * to be alarmed on rather than noticed.
 *
 * The route cannot re-pull (LP has no report API — a month-scoped observation
 * only arrives as an emailed export), so its whole job is to make a missing LP
 * schedule loud. These tests pin the two thresholds apart and pin the alert
 * copy to say WHICH failure occurred, because "stale" means two different
 * things here and they need different responses.
 *
 * DB-side behaviour (the view itself, supersession, observation history) is
 * covered by sql/migrations/2026-08-12_cohort_maturation.sql's verification
 * block, run against the live schema.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REOBSERVATION_STALE_DAYS,
  CURRENT_MONTH_STALE_DAYS,
  buildStaleAlert,
} from '../src/jobs/cohort-reobservation.js';

const cohort = (over = {}) => ({
  contract_month: '2026-06-01',
  last_observed_on: '2026-08-09',
  days_since_observed: 3,
  cohort_age_days: 72,
  working_cents: 23_890_700,
  hold_cents: 32_149_100,
  reason: 'unresolved_dollars',
  stale: false,
  ...over,
});

// ═══ Thresholds ═══════════════════════════════════════════════════════

test('the two thresholds are far apart, and deliberately so', () => {
  // Prior cohorts are re-observed MONTHLY, so ~35 days tolerates a month plus
  // weekend slack. The current month is re-observed DAILY by the ordinary 137
  // email, so 2 days means the daily ingest has stopped. Collapsing these into
  // one number either alarms every month by construction or lets the daily
  // ingest die quietly for a month — the 08-06→08-10 outage, again.
  assert.equal(REOBSERVATION_STALE_DAYS, 35);
  assert.equal(CURRENT_MONTH_STALE_DAYS, 2);
  assert.ok(REOBSERVATION_STALE_DAYS > CURRENT_MONTH_STALE_DAYS * 10);
});

// ═══ Alert copy ═══════════════════════════════════════════════════════

test('says nothing when every cohort is fresh', () => {
  // A monitor that speaks on a quiet day gets muted, and then it is not a
  // monitor. No stale cohorts ⇒ no message at all.
  assert.equal(buildStaleAlert({ stale_count: 0, stale: [] }), null);
});

test('a stale CURRENT month blames the daily ingest, not a missing export', () => {
  const status = {
    stale_count: 1,
    stale: [cohort({ contract_month: '2026-08-01', reason: 'current_month', days_since_observed: 4 })],
  };
  const text = buildStaleAlert(status);
  assert.match(text, /daily report-137 email may have stopped/);
  assert.match(text, /I\.LPRE/);
  // It must NOT tell someone to go ask LP for a monthly export — that is the
  // wrong remedy for this failure and would send them chasing the wrong thing.
  assert.doesNotMatch(text, /month-scoped/);
});

test('stale PRIOR cohorts name the months and say which way the error runs', () => {
  const status = {
    stale_count: 2,
    stale: [
      cohort({ contract_month: '2026-06-01', days_since_observed: 40 }),
      cohort({ contract_month: '2026-07-01', days_since_observed: 38 }),
    ],
  };
  const text = buildStaleAlert(status);
  assert.match(text, /Jun 2026 \(40d\)/);
  assert.match(text, /Jul 2026 \(38d\)/);
  // The direction of the error is the whole point — a frozen cohort reads HIGH.
  assert.match(text, /reads HIGH/);
  assert.match(text, /month-scoped 137 export/);
});

test('both failures in one check are reported as both, not merged', () => {
  const status = {
    stale_count: 2,
    stale: [
      cohort({ contract_month: '2026-08-01', reason: 'current_month', days_since_observed: 5 }),
      cohort({ contract_month: '2026-05-01', days_since_observed: 60 }),
    ],
  };
  const text = buildStaleAlert(status);
  assert.match(text, /daily report-137 email/);
  assert.match(text, /May 2026 \(60d\)/);
  assert.match(text, /2 cohort\(s\)/);
});

test('month names are correct at both ends of the year', () => {
  const jan = buildStaleAlert({ stale_count: 1, stale: [cohort({ contract_month: '2026-01-01', days_since_observed: 99 })] });
  assert.match(jan, /Jan 2026/);
  const dec = buildStaleAlert({ stale_count: 1, stale: [cohort({ contract_month: '2026-12-01', days_since_observed: 99 })] });
  assert.match(dec, /Dec 2026/);
});

// ═══ The blocking current-month export ════════════════════════════════

const blocked = { id: 'abc', period_start: '2026-08-01', period_end: '2026-08-31', scope: 'mtd' };

test('a blocking current-month export is reported even when nothing is stale', () => {
  // It is not a missing observation — it is an active blockage, and it can be
  // the ONLY thing wrong. Gating it behind stale_count would hide it entirely
  // for the ~2 days before the current month also trips its own threshold.
  const text = buildStaleAlert({ stale_count: 0, stale: [], blocking_full_month_export: blocked });
  assert.ok(text);
  assert.match(text, /BLOCKING the daily report-137 ingest/);
  assert.match(text, /2026-08-01 → 2026-08-31/);
});

test('its remedy is to REMOVE a schedule, not add one', () => {
  // The whole reason this is separated from staleness: the two failures point
  // in opposite directions. Telling someone to go ask LP for more exports when
  // the problem is that one export should not exist would waste the day.
  const text = buildStaleAlert({ stale_count: 0, stale: [], blocking_full_month_export: blocked });
  assert.match(text, /remove the month-scoped LP export for the CURRENT month/i);
  assert.match(text, /CLOSED months only/);
  assert.doesNotMatch(text, /Needs an LP schedule/);
});

test('a blockage and stale cohorts are both reported, blockage first', () => {
  const text = buildStaleAlert({
    stale_count: 1,
    stale: [cohort({ contract_month: '2026-06-01', days_since_observed: 40 })],
    blocking_full_month_export: blocked,
  });
  assert.match(text, /BLOCKING/);
  assert.match(text, /Jun 2026 \(40d\)/);
  // Order matters: the blockage is actively breaking ingest right now.
  assert.ok(text.indexOf('BLOCKING') < text.indexOf('Jun 2026'));
});

test('no blockage and no staleness stays silent', () => {
  assert.equal(buildStaleAlert({ stale_count: 0, stale: [], blocking_full_month_export: null }), null);
});
