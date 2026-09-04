// ─── LP report freshness watchdog — src/jobs/lp-report-watchdog.js ───
//
// From 07:30 ET onward, alert (GroupMe, once per report type per outage, then
// once a day while it is still missing — see REPORT_REMIND_MS) if
// a report type has NO successful snapshot ingested today. The LP emails are
// scheduled 6:00 / 6:15 ET, so by 07:30 both should have landed and ingested.
//
// INDEPENDENCE (the design requirement): this module watches the OUTCOME —
// scorecard_report_snapshots — not any stage of the pipeline. It fires the
// same alert whether LP's schedule silently stopped, Gmail delivery broke,
// the n8n workflow is paused, or the ingest route is rejecting files. It
// imports nothing from the ingest path and stays correct even if that path
// is refactored away.
//
// Kill switch: LP_REPORT_WATCHDOG_DISABLED (any value).

import supabase from '../supabase.js';
import { todayET, hourET } from './lp-report-common.js';
import { reportAlertCondition } from '../alert-state.js';

const DISABLED = !!(process.env.LP_REPORT_WATCHDOG_DISABLED || '').trim();

/**
 * The six daily feeds (cadence: docs/lp-report-cadence.md), keyed by the
 * report_type each one ACTUALLY LANDS AS — the values in CSV_REPORT_TYPES
 * (src/jobs/lp-csv-ingest.js), not the report number on the email.
 *
 * ⚠️ WHY THIS LIST IS THE WAY IT IS (corrected 2026-08-12).
 *
 * It used to name PDF-era types. LP's move to the Export Scheduler changed
 * what report 133 lands as — `job_status_ytd`, not `jobs_by_status` — and
 * added 138. The list was never updated, so the watchdog spent every morning
 * alarming about `jobs_by_status`, a type that CANNOT ingest again because
 * nothing writes it, while the real 133 feed ran unwatched. Two more (135,
 * 136) were listed but unarmed, and 138 was absent entirely.
 *
 * Of six live feeds, two were genuinely guarded. Report 134 was one of them
 * only because it armed back in its PDF era — which is the sole reason the
 * 2026-08-06 → 2026-08-12 outage produced any alarm at all.
 *
 * A type here MUST be a value in CSV_REPORT_TYPES. test-lp-report-watchdog-
 * coverage.js asserts exactly that, because the drift is silent otherwise:
 * a wrong type reads identically to a healthy feed that simply never alarms.
 */
const WATCHED = [
  { type: 'jobs_by_milestone', label: 'Report 134 "Jobs by Milestone Date" (Net Sales)', schedule: '6:00 ET' },
  { type: 'job_status_ytd', label: 'Report 133 "Jobs By Status" (Open backlog)', schedule: '6:15 ET' },
  { type: 'lead_disposition', label: 'Report 135 "Lead Disposition Detail" (leads/funnel/source)', schedule: '6:30 ET' },
  { type: 'source_cost', label: 'Report 136 "Marketing Sub-Source Cost" (marketing cost)', schedule: '6:45 ET' },
  { type: 'sales_efficiency', label: 'Report 137 "Sales Efficiency By Market" (per-market funnel)', schedule: '7:00 ET' },
  // 137 NEEDS TWO SCHEDULED RUNS, and they are two feeds, not one.
  //
  // By Market and By Setter export a BYTE-IDENTICAL header; only the `xGrouper`
  // echo column distinguishes them, which is why resolveVariant reads row 1 and
  // routes on the DATA value (REPORT_VARIANTS, lp-report-csv-common.js). That
  // routing has been in place since 2026-08-13 and works — but no By Setter file
  // has ever landed, because the LP-side schedule for it does not exist yet.
  //
  // Watching it is what makes that absence audible. Without an entry here, a
  // schedule that is never created and a schedule that silently stops look
  // identical from this side: nothing ingests, and nothing says so.
  //
  // ⚠️ It arms only after its first n8n-sourced success (see UNARMED_SENTINEL
  // below), so adding it does NOT start a daily alarm for a feed that has never
  // run. It stays in `unarmed` until the schedule exists, which is the honest
  // state and is separately reported.
  { type: 'sales_efficiency_by_setter', label: 'Report 137 "Sales Efficiency By Setter" (call-center cohort)', schedule: '7:05 ET' },
  // TIER 1, not secondary. Under the v4 contract 138 owns the call-center
  // funnel outright, so its ingest has to be as reliable as 137's — same guard,
  // same alert path, no "it's only supporting data" exemption.
  { type: 'appt_stats_by_rep_source', label: 'Report 138 "Appointment Stats by Sales Rep with Source"', schedule: '7:15 ET' },
];

// The 2026-08-05 manual CSV backfills would otherwise arm those types
// immediately and alarm every morning until Mark schedules the LP emails.
// A type arms only after its first SCHEDULED ingest (ingest-log success with
// source 'n8n') — manual/backfill sources never arm the watch.
//
// That gate is right in intent and was unreachable in practice: the CSV route
// defaults `source` to 'manual' (lp-csv-ingest.js) and the n8n workflows posted
// without `?source=n8n`, so after the CSV cutover NOTHING could arm. The
// workflows now pass the parameter; `reportUnarmed` below exists so that if
// they ever stop, the blind spot announces itself instead of failing open.
//
// 2026-08-18 — a SECOND, separate reason a type could not arm, found after the
// parameter fix landed: the arm check matched status 'success' exactly, while
// report 138 lands 'succeeded_with_warnings' on every n8n ingest. The source
// parameter was never the blocker for 138; the status literal was. See
// ARMING_STATUSES at the arm check below. Do not "fix" this by suppressing the
// warnings — the warning is the delta signal.
const UNARMED_SENTINEL = '__unarmed__';
/** An unarmed type is only worth reporting if it is demonstrably still alive. */
const RECENTLY_ACTIVE_DAYS = 7;

let watchdogTimer = null;

// 2026-09-04 — a missing report cannot fix itself; somebody has to go look at
// LP's scheduler, Gmail, or n8n. So unlike the live-ops watchdogs this one
// keeps a re-reminder — but a DAILY one. Report 134 was missing from 09-01 and
// re-announced 6 times over two days under the old per-sweep alerting.
const REPORT_REMIND_MS = parseInt(
  process.env.LP_REPORT_ALERT_REMIND_MS || `${24 * 60 * 60 * 1000}`, 10
);

/** Minute-of-hour in ET (0-59). */
function minuteET(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', minute: '2-digit',
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
}

/** ET calendar date N days back — the "still alive" cutoff. ISO dates sort lexically. */
function etDaysAgo(days) {
  return todayET(new Date(Date.now() - days * 86400 * 1000));
}

/** Latest snapshot's ET calendar day for a report type, or null. Throws on read error. */
async function lastIngestEtDay(type) {
  const { data, error } = await supabase
    .from('scorecard_report_snapshots')
    .select('ingested_at')
    .eq('report_type', type)
    .order('ingested_at', { ascending: false })
    .limit(1).maybeSingle();
  if (error) throw new Error(`snapshot read failed: ${error.message}`);
  return data ? todayET(new Date(data.ingested_at)) : null;
}

/**
 * One sweep. Exported for tests/manual runs; DST-proof — "today" is decided
 * by converting each snapshot's ingested_at INTO an ET calendar date rather
 * than converting an ET midnight into UTC.
 *
 * Returns `missing` (armed types with no snapshot today) AND `unarmed` (types
 * that are ingesting but not guarded). The second list is the whole point of
 * the 2026-08-12 revision: `if (!armed) continue` failed OPEN and SILENT, so a
 * feed nobody was watching looked exactly like a feed that was fine.
 */
export async function checkLpReportFreshness({ alert = true } = {}) {
  if (!supabase) return { checked: false };
  const today = todayET();
  const activeSince = etDaysAgo(RECENTLY_ACTIVE_DAYS);
  const missing = [];
  const unarmed = [];
  // Any read that failed this sweep. Guards the blind-spot key from clearing
  // on an `unarmed` list we could not actually verify.
  let readFailed = false;

  for (const { type, label, schedule } of WATCHED) {
    // Armed only after the first scheduled (n8n-sourced) success — see header.
    // ARMING STATUSES: 'succeeded_with_warnings' counts. Report 138
    // (appt_stats_by_rep_source) has posted with ?source=n8n since the workflow
    // fix — 6 rows, most recently 2026-08-18 11:00:47Z — but EVERY one lands
    // 'succeeded_with_warnings', never the bare 'success' the other four watched
    // types produce. An exact .eq('status','success') therefore could never arm
    // it, and the missing-report alarm for a TIER 1 report stayed silent while
    // the feed itself was healthy. The warning is a real signal and is
    // deliberately NOT suppressed elsewhere; it just must not gate the guard.
    const ARMING_STATUSES = ['success', 'succeeded_with_warnings'];
    const { data: armed, error: armErr } = await supabase
      .from('scorecard_ingest_log')
      .select('id')
      .eq('report_type', type).in('status', ARMING_STATUSES).eq('source', 'n8n')
      .limit(1).maybeSingle();
    if (armErr) {
      console.error('[LPReportWatchdog] arm check failed:', armErr.message);
      readFailed = true;
      continue;
    }

    let lastEtDay;
    try {
      lastEtDay = await lastIngestEtDay(type);
    } catch (err) {
      console.error('[LPReportWatchdog]', err.message);
      readFailed = true;
      continue;
    }

    if (!armed) {
      // Ingesting but unguarded — a real blind spot. A type that has genuinely
      // never been scheduled stays quiet, which is why arming exists at all.
      if (lastEtDay && lastEtDay >= activeSince) {
        unarmed.push({ type, label, last_ingested_et: lastEtDay });
      }
      continue;
    }

    const ingestedToday = lastEtDay === today;
    if (!ingestedToday) missing.push({ type, label, last_ingested_et: lastEtDay });

    // Every read failure above `continue`s before this point, so reaching here
    // is always a real observation — safe to open the condition or to clear it.
    // Clearing is why a report that finally lands says so exactly once.
    if (alert) {
      await reportAlertCondition({
        key: `lp_report:missing:${type}`,
        active: !ingestedToday,
        label: `${label} ingested`,
        text: () =>
          `⏰ LP report MISSING: ${label} has not ingested today (${today} ET). ` +
          `Expected via scheduled email ~${schedule}. Last ingest: ${lastEtDay ?? 'never'}. ` +
          `Check, in order: LP's scheduled email fired → Gmail received it → n8n workflow active (I.LPRA–F) → ` +
          `GET /n8n/admin/lp-report-ingest/status for a rejection.`,
        detail: `last_ingested_et=${lastEtDay ?? 'never'}`,
        remindMs: REPORT_REMIND_MS,
        send: notify,
      });
    }
  }

  if (unarmed.length) {
    console.warn(
      `[LPReportWatchdog] UNGUARDED: ${unarmed.map((u) => u.type).join(', ')} — ` +
      `ingesting but never logged a success with source='n8n', so no missing-report alert can fire for them. ` +
      `Check that the I.LPRA–F workflows still POST with ?source=n8n.`,
    );
  }

  // Outside the `if` so the blind spot can CLEAR once every feed is armed.
  // A sweep in which any read failed passes null instead of false: an empty
  // `unarmed` list that we could not actually verify is not evidence of
  // health, and clearing on it would announce an all-clear nobody earned.
  if (alert) {
    await reportAlertCondition({
      key: `lp_report:${UNARMED_SENTINEL}`,
      active: readFailed && unarmed.length === 0 ? null : unarmed.length > 0,
      label: 'LP report watchdog blind spot closed — every feed is guarded',
      text: () =>
        `⚠️ LP report watchdog BLIND SPOT (${today} ET): ${unarmed.length} feed(s) are ingesting but NOT guarded — ` +
        `${unarmed.map((u) => u.label).join('; ')}. ` +
        `They have never logged an ingest with source='n8n', so if they stop, nothing will alert. ` +
        `Fix: confirm the I.LPRA–F workflows POST to /n8n/admin/lp-csv-ingest/… with ?source=n8n.`,
      detail: unarmed.map((u) => u.type).join(', '),
      remindMs: REPORT_REMIND_MS,
      send: notify,
    });
  }

  return { checked: true, today, missing, unarmed };
}

/**
 * One place that talks to GroupMe, so routing is decided once.
 *
 * `channel: 'ops'` resolves to GROUPME_OPS_BOT_ID and falls back to the main
 * bot when that is unset (groupme.js `_resolveBotId`) — so this is inert until
 * the env var exists, and no message is ever dropped. It matters because the
 * 2026-08-12 alerts fired correctly into a channel carrying hundreds of
 * per-lead messages a day and were never seen.
 */
async function notify(text) {
  try {
    const { sendGroupMeMessage } = await import('../groupme.js');
    // 2026-09-04 — the result is RETURNED, not swallowed. alert-state.js marks
    // an incident announced only on a send it can confirm; reporting a failed
    // send as success would suppress the retry and, later, announce a recovery
    // for an alert nobody ever saw.
    return await sendGroupMeMessage(text, { channel: 'ops' });
  } catch (err) {
    console.error('[LPReportWatchdog] GroupMe alert failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

export function startLpReportWatchdog() {
  if (watchdogTimer) return;
  if (DISABLED) {
    console.log('[LPReportWatchdog] DISABLED (LP_REPORT_WATCHDOG_DISABLED set)');
    return;
  }
  console.log(
    `[LPReportWatchdog] Started — missing-report check from 07:30 ET, once per type per day; ` +
    `watching ${WATCHED.length}: ${WATCHED.map((w) => w.type).join(', ')}`,
  );
  watchdogTimer = setInterval(async () => {
    const h = hourET();
    if (h < 7 || (h === 7 && minuteET() < 30)) return;
    try {
      await checkLpReportFreshness();
    } catch (err) {
      console.error('[LPReportWatchdog] sweep failed:', err.message);
    }
  }, 5 * 60 * 1000);
}

export function stopLpReportWatchdog() {
  if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

/** Exported for the coverage guard — the watched set must match what actually lands. */
export { WATCHED };
