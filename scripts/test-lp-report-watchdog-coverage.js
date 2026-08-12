/**
 * Guards what the LP report watchdog can actually SEE
 * (src/jobs/lp-report-watchdog.js).
 *
 * THE DEFECT (found 2026-08-12, live for an unknown span before it).
 *
 * The watchdog is the safety net for every LP feed. It was watching PDF-era
 * report types. LP's move to the Export Scheduler changed what report 133
 * lands as — `job_status_ytd`, not `jobs_by_status` — and added report 138.
 * Nobody updated the list, so:
 *
 *   • it alarmed every morning about `jobs_by_status`, a type that CANNOT
 *     ingest again because nothing writes it;
 *   • the real 133 feed ran unwatched;
 *   • 135 and 136 were listed but unarmed, so they were skipped in silence;
 *   • 138 was absent entirely.
 *
 * Two of six live feeds were genuinely guarded. Report 134 was one of them
 * only because it armed back in its PDF era — the sole reason the six-day
 * 2026-08-06 outage produced any alarm at all. Had it been a post-cutover
 * feed, nothing would have fired.
 *
 * The arming gate compounded it: `.eq('source','n8n')` is right in intent
 * (a manual backfill must not arm a watch) but was unreachable, because the
 * CSV route defaults `source` to 'manual' and the workflows posted without
 * `?source=n8n`. After the cutover NOTHING could arm.
 *
 * WHY THESE ASSERTIONS AND NOT A BEHAVIOURAL TEST. A sweep needs Supabase and
 * GroupMe, so exercising it would be an integration test. The invariant that
 * actually failed is structural and checkable from source: every watched type
 * must be a type the ingest layer really writes. That single rule is what
 * would have caught this the day 133 changed shape.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { WATCHED } from '../src/jobs/lp-report-watchdog.js';
import { REPORT_FINGERPRINTS } from '../src/jobs/lp-report-csv-common.js';

const WATCHDOG = readFileSync('src/jobs/lp-report-watchdog.js', 'utf8');
const GROUPME = readFileSync('src/groupme.js', 'utf8');

/** Source with comments stripped — a rule about CODE must not pass on prose. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const WATCHDOG_CODE = strip(WATCHDOG);

/**
 * The authoritative registry of what can land. NOT CSV_REPORT_TYPES — that is
 * the URL-slug map, and the route says outright that the slug is "only a
 * hint": `detectReportFromHeader` fingerprints the file and the HEADER
 * decides. Report 138 proves the distinction — it has no slug of its own and
 * would look unlandable if this guard checked slugs, which is exactly the
 * wrong answer for a feed that ingests daily.
 */
const landable = new Set(REPORT_FINGERPRINTS.map((f) => f.reportType));
const watchedTypes = WATCHED.map((w) => w.type);

// ─── The watched set matches what actually lands ────────────────────

test('every watched type is one the ingest layer can actually resolve', () => {
  // HALF OF THE GUARD THAT WOULD HAVE CAUGHT THIS. A watched type absent from
  // the fingerprint registry can never ingest, so it alarms forever and
  // guards nothing — indistinguishable, from outside, from a healthy feed.
  for (const type of watchedTypes) {
    assert.ok(
      landable.has(type),
      `WATCHED type "${type}" is not in REPORT_FINGERPRINTS — it can never ingest, so it will alarm every day and guard nothing`,
    );
  }
});

test('every report the fingerprinter can resolve is watched', () => {
  // THE OTHER HALF, and the one that matters going forward. Report 138 was
  // added and simply never given a guard; nothing anywhere said so. This
  // fails the day a seventh report is fingerprinted without being watched,
  // which is the same silence that let 133 drift.
  for (const { reportType, lpReportId } of REPORT_FINGERPRINTS) {
    assert.ok(
      watchedTypes.includes(reportType),
      `report ${lpReportId} ("${reportType}") can ingest but is not watched — if it stops, nothing will alert`,
    );
  }
});

test('jobs_by_status is gone — it is the PDF-era name for 133', () => {
  // The specific false alarm. 133 lands as job_status_ytd now.
  assert.ok(!watchedTypes.includes('jobs_by_status'));
  assert.ok(watchedTypes.includes('job_status_ytd'));
});

test('all six live feeds are watched', () => {
  for (const type of [
    'jobs_by_milestone',        // 134 — Net Sales / revenue_as_of
    'job_status_ytd',           // 133 — Open backlog
    'lead_disposition',         // 135 — leads / funnel / source
    'source_cost',              // 136 — marketing cost
    'sales_efficiency',         // 137 — per-market funnel
    'appt_stats_by_rep_source', // 138 — appointment stats by rep
  ]) {
    assert.ok(watchedTypes.includes(type), `${type} is not watched`);
  }
});

test('no duplicate types, and every entry is fully described', () => {
  assert.equal(new Set(watchedTypes).size, watchedTypes.length, 'duplicate report_type in WATCHED');
  for (const w of WATCHED) {
    assert.ok(w.label && w.label.length > 10, `${w.type} has no usable label`);
    assert.ok(w.schedule, `${w.type} has no schedule — the alert body prints it`);
  }
});

// ─── An unguarded feed must not fail silently ───────────────────────

test('the sweep reports types that are ingesting but unarmed', () => {
  // `if (!armed) continue` failed OPEN and SILENT: a feed nobody watched
  // looked exactly like a feed that was fine. That is the deeper bug.
  assert.match(WATCHDOG_CODE, /unarmed\.push\(/);
  assert.match(WATCHDOG_CODE, /unarmed,?\s*\n?\s*\}?;?\s*$|return \{ checked: true, today, missing, unarmed \}/m);
});

test('the unarmed set is logged AND alerted, not just returned', () => {
  // Returning it only would repeat the original mistake at one remove: a
  // blind spot recorded where nobody reads it is still a blind spot.
  assert.match(WATCHDOG_CODE, /console\.warn\(/);
  assert.match(WATCHDOG_CODE, /BLIND SPOT/);
});

test('the unarmed alert is deduped once per ET day, like the missing alert', () => {
  assert.match(WATCHDOG_CODE, /UNARMED_SENTINEL/);
  assert.match(WATCHDOG_CODE, /lastAlertDate\.get\(UNARMED_SENTINEL\) !== today/);
});

test('only a demonstrably live feed counts as a blind spot', () => {
  // A type that has genuinely never been scheduled must stay quiet — that is
  // the whole reason arming exists, and re-alarming on it would recreate the
  // 2026-08-05 noise the gate was added to stop.
  assert.match(WATCHDOG_CODE, /RECENTLY_ACTIVE_DAYS/);
  assert.match(WATCHDOG_CODE, /lastEtDay >= activeSince/);
});

// ─── The arming gate still means what it says ───────────────────────

test('arming still requires a scheduled (n8n-sourced) success', () => {
  // Loosening this to "any success" would let a manual backfill arm a watch —
  // the failure mode the gate was built for. The fix belongs upstream, in the
  // workflows passing ?source=n8n, not in weakening the gate.
  assert.match(WATCHDOG_CODE, /\.eq\('report_type', type\)\.eq\('status', 'success'\)\.eq\('source', 'n8n'\)/);
});

test('the ingest route still honours ?source=n8n, which is what arms a watch', () => {
  // Anti-vacuity for the workflow-side half of this fix. If the route stopped
  // reading the query param, every feed would silently disarm again.
  const CSV = readFileSync('src/jobs/lp-csv-ingest.js', 'utf8');
  assert.match(CSV, /source: String\(req\.query\.source \|\| 'manual'\)/);
});

// ─── Alert routing ──────────────────────────────────────────────────

test('watchdog alerts are addressed to the ops channel', () => {
  assert.match(WATCHDOG_CODE, /channel: 'ops'/);
});

test("the ops channel falls back to the main bot when unset, dropping nothing", () => {
  // The routing change must be inert until GROUPME_OPS_BOT_ID exists. An
  // alarm that silently goes nowhere is worse than one that is hard to see.
  assert.match(GROUPME, /GROUPME_OPS_BOT_ID/);
  const i = GROUPME.indexOf("if (channel === 'ops')");
  assert.ok(i > 0, "no 'ops' case in _resolveBotId");
  const block = GROUPME.slice(i, i + 400);
  assert.match(block, /if \(GROUPME_OPS_BOT_ID\) return GROUPME_OPS_BOT_ID;/);
  assert.match(block, /warnedOpsFallback/);
  // …and the function still ends by returning the main bot.
  assert.match(GROUPME, /\}\s*\n\s*return GROUPME_BOT_ID;\s*\n\}/);
});

// ─── Anti-vacuity ───────────────────────────────────────────────────

test('the fingerprint registry still describes the whole feed set', () => {
  // If this shrank, the two coverage rules above could both pass vacuously by
  // the watched list shrinking in step with it.
  assert.ok(REPORT_FINGERPRINTS.length >= 6,
    'REPORT_FINGERPRINTS has fewer entries than there are LP report feeds');
  assert.ok(WATCHED.length >= 6, 'WATCHED shrank — a feed lost its guard');
  // Reports 133–138 are the live series; a gap means one was dropped.
  const ids = REPORT_FINGERPRINTS.map((f) => f.lpReportId).sort();
  assert.deepEqual(ids, ['133', '134', '135', '136', '137', '138']);
});

test('the remediation line names the workflows that exist', () => {
  // It used to say "I.LPR router / I.LPRA-E". The router was rolled back on
  // 2026-08-05 and there are six workflows now. Sending someone to look at a
  // workflow that does not exist costs real minutes mid-incident.
  assert.match(WATCHDOG, /I\.LPRA–F/);
  assert.ok(!/I\.LPR router/.test(WATCHDOG));
});
