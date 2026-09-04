/**
 * Data Freshness Monitor — src/admin/data-freshness.js
 *
 * Periodic auto-detection of stale data in monitored Supabase tables.
 * Replaces the manual "is the table updating?" check that surfaced
 * the 4-day lp_notes gap.
 *
 * What this monitors:
 *   1. Per-table freshness — latest timestamp vs. threshold per table
 *   2. Sync watermark health — count of consecutive 0-record sync runs
 *      (the actual signal that incremental sync is producing nothing
 *      even though it's "completing successfully")
 *
 * What this does on detection:
 *   - Logs every check to data_freshness_log (apply sql/015 first)
 *   - Fires a GroupMe alert when a table goes stale (with dedup —
 *     same table won't re-alert within ALERT_DEDUP_HOURS)
 *
 * Endpoints (registered by registerDataFreshnessRoutes):
 *   GET  /n8n/admin/freshness        — current state of all monitored tables
 *   POST /n8n/admin/freshness-check  — run check now (alert=true by default)
 *   GET  /n8n/admin/sync-probe       — probe LP API directly (?days=3)
 *
 * Scheduler (registered by startDataFreshnessMonitorScheduler):
 *   Runs runFreshnessCheck() every CHECK_INTERVAL_MINUTES (default 30).
 *
 * v1.2 — 2026-04-30. Kill switch for GroupMe alerts.
 *        FRESHNESS_GROUPME_ALERTS_DISABLED=true silences SYNC WATERMARK
 *        STUCK and STALE DATA pings to GroupMe while continuing to log
 *        every check to data_freshness_log. Use when ops alerts are
 *        creating noise during active LP-sync work and you want the
 *        signal preserved for /n8n/admin/freshness inspection without
 *        the channel pings.
 *
 * v1.1 — 2026-04-28. Sync probe upgraded to test all 3 lead-fetch paths
 *        (pro_id=0, pro_id omitted, /api/Customers/GetLead) so we can
 *        see exactly which path the auto-fallback in lp-client picks.
 *
 * v1.0 — 2026-04-28.
 */

import supabase from '../supabase.js';
import { getJobStatusChanges, probeLeadEndpoints, getLeadByLdsId, getCircuitStatus } from '../lp-client.js';
import { sendGroupMeMessage } from '../groupme.js';
import { extractArray, getField } from '../sync-utils.js';
import { runSQL } from './supabase-admin.js';
import { lpStoredAgeMinutes, lpStoredToUtcIso } from '../lp-dates.js';
import { reportAlertCondition } from '../alert-state.js';

// ─── Configuration ──────────────────────────────────────────────────
// Per-table freshness thresholds. Tuned to typical update cadence:
//   - LP-derived tables: hours-to-overnight (12-24h)
//   - Agentic system tables: tighter (30min - 6h)
//
// severity:
//   - 'critical' — fires GroupMe alert
//   - 'warning'  — fires GroupMe alert
//   - 'info'     — logs only, no alert (used for low-volume tables that
//                  legitimately go quiet for hours)

// lp_wall_clock: this column is written through lpDateToEastern(), which tags
// ET wall-clock with +00:00. Measuring staleness with a raw Date.now() diff
// therefore adds a constant ~4h (5h in EST) to every reading. On lp_leads that
// left 2h of real headroom under a 6h threshold, so any ordinary quiet stretch
// paged GroupMe with a STALE DATA warning that was not true. See
// lpStoredAgeMinutes in src/lp-dates.js.
const MONITORED_TABLES = [
  // LP-derived (synced from Lead Perfection every 15min)
  { name: 'lp_leads',        timestamp_col: 'created_at_lp', threshold_min: 360,  severity: 'warning',  lp_wall_clock: true }, // 6h
  { name: 'lp_notes',        timestamp_col: 'created_at_lp', threshold_min: 720,  severity: 'critical', lp_wall_clock: true }, // 12h — was the original symptom
  { name: 'lp_call_logs',    timestamp_col: 'call_date',     threshold_min: 720,  severity: 'warning',  lp_wall_clock: true }, // 12h
  { name: 'lp_activities',   timestamp_col: 'activity_date', threshold_min: 720,  severity: 'warning',  lp_wall_clock: true }, // 12h
  // Agentic system (continuous when in use)
  { name: 'system_events',   timestamp_col: 'created_at',    threshold_min: 60,   severity: 'critical' }, // 1h
  { name: 'agent_actions',   timestamp_col: 'created_at',    threshold_min: 360,  severity: 'warning'  }, // 6h
  { name: 'kb_handler_logs', timestamp_col: 'created_at',    threshold_min: 1440, severity: 'info'     }, // 24h (low volume)
  // Sync infrastructure
  { name: 'lp_sync_log',     timestamp_col: 'started_at',    threshold_min: 30,   severity: 'critical' }, // 30min — sync should run every 15
];

const ALERT_DEDUP_HOURS      = parseInt(process.env.FRESHNESS_ALERT_DEDUP_HOURS || '6', 10);
const CHECK_INTERVAL_MINUTES = parseInt(process.env.FRESHNESS_CHECK_INTERVAL_MIN || '30', 10);
const ZERO_RECORD_RUN_LIMIT  = parseInt(process.env.FRESHNESS_ZERO_RECORD_LIMIT  || '5', 10);
// v1.2: Global kill switch for GroupMe alerts. When true, stale-data and
// sync-watermark-stuck alerts skip GroupMe but still write to
// data_freshness_log so /n8n/admin/freshness reflects current state.
// Set FRESHNESS_GROUPME_ALERTS_DISABLED=true on Railway to silence ops pings.
const GROUPME_ALERTS_DISABLED = (process.env.FRESHNESS_GROUPME_ALERTS_DISABLED || 'false').toLowerCase() === 'true';
// Field-drift probe: row-arrival freshness reported "fresh" while the demo
// funnel flags rotted (cache demo_completed=false vs LP Sat=true). Sample N
// recent leads, compare cached flags to a live getLeadByLdsId, and alert when
// the count of drifted rows exceeds FRESHNESS_FIELD_DRIFT_LIMIT.
const FIELD_DRIFT_SAMPLE = parseInt(process.env.FRESHNESS_FIELD_DRIFT_SAMPLE || '25', 10);
const FIELD_DRIFT_LIMIT  = parseInt(process.env.FRESHNESS_FIELD_DRIFT_LIMIT  || '3', 10);

// Date-inversion probe: jobs whose install_completed_date precedes install_date —
// an install that finished before it started. Measured 2026-08-31 immediately after
// the lp_jobs field backfill: 19 rows, 18 of them Paid In Full (work done and paid,
// dates keyed wrong in LP) plus one one-day inversion that reads as a typo.
//
// This is LP SOURCE data. The mapper reads both values from milestone actdates and
// correcting them would mean inventing data, so this check exists to keep the number
// VISIBLE, not to fix it. Alert only when it grows past the accepted baseline —
// following the named-residual precedent in src/jobs/lp-report-recon.js:66.
export const JOB_DATE_INVERSION_BASELINE =
  parseInt(process.env.FRESHNESS_JOB_DATE_INVERSION_BASELINE || '19', 10);
// Freshness runs every 30 min; this is a slow-moving warehouse invariant and a full
// lp_jobs scan. Once an hour is plenty — 48 scans/day buys nothing.
const JOB_DATE_INVERSION_MIN_INTERVAL_MS = 60 * 60 * 1000;
let _lastInversionCheck = 0;
let _lastInversionResult = null;

// Prospect-split probe: one ghl_contact_id whose lp_leads point at more than one
// lp_prospect_id. PR #823 stopped the duplicate LeadAdd at source, so no new bursts
// should occur — but the 2026-09-03 audit found the lead-level view was missing this:
// for contact lGQ0WjsMU2zmoq9MsVJH the three retry leads landed on THREE separate LP
// prospects (456535, 456538, 456540), while Messick and Totolis each stayed on one.
// Splitting is conditional on something not yet identified, most likely whether the
// LeadAdd carried a matchable phone or address at that moment.
//
// Prospect-level duplication is worse than lead-level: lp_prospect_id is the stable
// person-level key used for cross-system lookups, so a split silently gives one human
// two identities, and deleting the duplicate LEADS does not clean it up.
//
// DETECT, DO NOT AUTO-MERGE. Merging LP prospects is destructive and LP-side; this
// keeps the number VISIBLE and a human merges. Same accepted-baseline shape as
// JOB_DATE_INVERSION_BASELINE above — alert only on growth.
//
// Measured 2026-09-04 over the 90-day window: 161. Worst offender at the time was
// LSo4GLGF0PtdlN161XWq with 9 distinct prospects. A RISE means the LeadAdd path is
// splitting prospects again — check what changed in the phone/address match at intake.
export const PROSPECT_SPLIT_BASELINE =
  parseInt(process.env.FRESHNESS_PROSPECT_SPLIT_BASELINE || '161', 10);
// Same reasoning as the inversion guard: a slow-moving warehouse invariant and a full
// lp_leads group-by. Once an hour is plenty.
const PROSPECT_SPLIT_MIN_INTERVAL_MS = 60 * 60 * 1000;
// Name the affected contacts in the alert so it is actionable rather than a bare
// count. Capped — a GroupMe message is not a report.
const PROSPECT_SPLIT_SAMPLE_CAP = 10;
let _lastProspectSplitCheck = 0;
let _lastProspectSplitResult = null;

// ─── Per-table check ────────────────────────────────────────────────

async function checkOneTable(t) {
  try {
    const { data, error } = await supabase
      .from(t.name)
      .select(t.timestamp_col)
      .order(t.timestamp_col, { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return { table: t.name, status: 'error', error_message: error.message, severity: t.severity };
    }
    if (!data || !data[t.timestamp_col]) {
      return { table: t.name, status: 'empty', latest: null, staleness_min: null,
               threshold_min: t.threshold_min, severity: t.severity };
    }

    // LP-derived columns store ET wall-clock tagged +00:00, so a raw diff
    // over-reports age by ~4h. lpStoredAgeMinutes converts; everything this
    // service writes itself is already true UTC and is measured directly.
    const raw = data[t.timestamp_col];
    const staleness_min = t.lp_wall_clock
      ? lpStoredAgeMinutes(raw)
      : Math.round((Date.now() - new Date(raw).getTime()) / 60000);

    if (staleness_min == null || !Number.isFinite(staleness_min)) {
      return { table: t.name, status: 'error', error_message: `unparseable ${t.timestamp_col}: ${String(raw)}`,
               severity: t.severity, threshold_min: t.threshold_min };
    }

    return {
      table: t.name,
      status: staleness_min > t.threshold_min ? 'stale' : 'fresh',
      latest: t.lp_wall_clock ? lpStoredToUtcIso(raw) : new Date(raw).toISOString(),
      latest_raw: t.lp_wall_clock ? String(raw) : undefined,
      staleness_min,
      threshold_min: t.threshold_min,
      severity: t.severity,
    };
  } catch (err) {
    return { table: t.name, status: 'error', error_message: err.message, severity: t.severity };
  }
}

export async function checkFreshness() {
  return Promise.all(MONITORED_TABLES.map(checkOneTable));
}

// ─── Sync watermark health (separate from table freshness) ─────────
// Counts consecutive recent 'leads' sync runs that completed with
// records_synced=0. This is the actual root-cause signal — the syncs
// are completing but pulling nothing from LP. lp_sync_log freshness
// alone wouldn't catch it (the rows are being written; they're just empty).

export async function checkSyncWatermarkHealth() {
  try {
    const { data, error } = await supabase
      .from('lp_sync_log')
      .select('id, status, records_synced, completed_at, started_at')
      .eq('entity_type', 'leads')
      .eq('status', 'completed')
      .order('started_at', { ascending: false })
      .limit(ZERO_RECORD_RUN_LIMIT);

    if (error) return { status: 'error', error_message: error.message };
    if (!data || data.length === 0) return { status: 'unknown', recent_runs: 0 };

    const zero_record_runs = data.filter(r => (r.records_synced || 0) === 0).length;
    const all_zero = zero_record_runs === data.length;

    return {
      status: all_zero ? 'stuck' : 'healthy',
      recent_runs: data.length,
      zero_record_runs,
      threshold: ZERO_RECORD_RUN_LIMIT,
      latest_run_at: data[0]?.completed_at || data[0]?.started_at,
      message: all_zero
        ? `Last ${data.length} 'leads' incremental syncs all returned 0 records. LP API may have changed; run /n8n/admin/sync-probe to diagnose.`
        : null,
    };
  } catch (err) {
    return { status: 'error', error_message: err.message };
  }
}

// ─── Field-level drift (funnel flags) ──────────────────────────────
// The check that would have caught the 5-vs-21 demo gap: row-arrival
// freshness only proves new rows land, not that demo_completed /
// appointment_set / closed_won on existing rows match LP truth. Sample N
// recent leads, fetch each live via getLeadByLdsId, derive the flags the
// same way buildLeadRow does (Sat / ApptSet / Sold), and count mismatches.
// Sequential + small sample to bound LP load; respects the circuit breaker.

function deriveFlag(v) { return v === 'true' || v === true; }

function findLeadByLdsId(resp, ldsId) {
  for (const prospect of extractArray(resp)) {
    const leads = getField(prospect, 'leads', 'Leads') || [];
    const match = leads.find(l => String(getField(l, 'id', 'lds_id', 'LeadID')) === String(ldsId));
    if (match) return match;
  }
  return null;
}

export async function checkFieldDrift({ sample = FIELD_DRIFT_SAMPLE } = {}) {
  try {
    const { data: rows, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, demo_completed, appointment_set, closed_won')
      .order('created_at_lp', { ascending: false })
      .limit(sample);

    if (error) return { status: 'error', error_message: error.message };
    if (!rows || rows.length === 0) return { status: 'empty', sampled: 0, drifted: 0 };

    let sampled = 0;
    let drifted = 0;
    let errors = 0;
    const examples = [];

    for (const row of rows) {
      if (getCircuitStatus().circuitOpen) break; // LP failing — stop probing
      try {
        const resp = await getLeadByLdsId(row.lp_lead_id);
        const lead = findLeadByLdsId(resp, row.lp_lead_id);
        if (!lead) { errors++; continue; }
        sampled++;

        const liveDemo    = deriveFlag(getField(lead, 'sat', 'Sat'));
        const liveApptSet = deriveFlag(getField(lead, 'apptset', 'ApptSet'));
        const liveSold    = deriveFlag(getField(lead, 'sold', 'Sold'));

        const mismatch =
          (!!row.demo_completed)  !== liveDemo ||
          (!!row.appointment_set) !== liveApptSet ||
          (!!row.closed_won)      !== liveSold;

        if (mismatch) {
          drifted++;
          if (examples.length < 10) {
            examples.push({
              lp_lead_id: row.lp_lead_id,
              cache: { demo_completed: !!row.demo_completed, appointment_set: !!row.appointment_set, closed_won: !!row.closed_won },
              live:  { demo_completed: liveDemo, appointment_set: liveApptSet, closed_won: liveSold },
            });
          }
        }
      } catch (err) {
        errors++;
      }
    }

    const drift_pct = sampled > 0 ? Math.round((drifted / sampled) * 100) : 0;
    return {
      status: drifted > FIELD_DRIFT_LIMIT ? 'drift' : 'ok',
      sampled,
      drifted,
      drift_pct,
      errors,
      threshold: FIELD_DRIFT_LIMIT,
      examples,
    };
  } catch (err) {
    return { status: 'error', error_message: err.message };
  }
}

// ─── Job date inversion ─────────────────────────────────────────────
// Counts lp_jobs rows where the install finished before it started, and compares
// against an accepted baseline. Same count-vs-threshold shape as checkFieldDrift.
//
// runSQL, not a supabase-js filter: PostgREST cannot compare one column to another,
// so `install_completed_date < install_date` is not expressible through .lt(). runSQL
// throws on failure (supabase.rpc reports errors in its return value without
// throwing) — see sql/README.md.
export async function checkJobDateInversion({ force = false } = {}) {
  const now = Date.now();
  if (!force && _lastInversionResult && now - _lastInversionCheck < JOB_DATE_INVERSION_MIN_INTERVAL_MS) {
    return { ..._lastInversionResult, cached: true };
  }
  try {
    const rows = await runSQL(
      'SELECT count(*)::int AS inverted FROM lp_jobs WHERE install_completed_date < install_date;'
    );
    const count = Array.isArray(rows) ? (rows[0]?.inverted ?? 0) : (rows?.inverted ?? 0);
    const result = {
      status:   count > JOB_DATE_INVERSION_BASELINE ? 'inverted' : 'ok',
      count,
      baseline: JOB_DATE_INVERSION_BASELINE,
      delta:    count - JOB_DATE_INVERSION_BASELINE,
    };
    _lastInversionCheck = now;
    _lastInversionResult = result;
    return result;
  } catch (err) {
    return { status: 'error', error_message: err.message };
  }
}

// ─── Prospect-split check (warehouse invariant, detect only) ────────
//
// Counts contacts whose lp_leads span more than one lp_prospect_id, and compares
// against an accepted baseline. Same count-vs-threshold shape as
// checkJobDateInversion, and the same hourly guard.
//
// runSQL, not a supabase-js filter: PostgREST cannot express GROUP BY … HAVING
// count(DISTINCT …) > 1. runSQL throws on failure — see sql/README.md.
const PROSPECT_SPLIT_SQL =
  `SELECT ghl_contact_id, count(DISTINCT lp_prospect_id)::int AS prospects
     FROM lp_leads
    WHERE ghl_contact_id IS NOT NULL
      AND lp_prospect_id IS NOT NULL
      AND created_at_lp > now() - interval '90 days'
    GROUP BY ghl_contact_id
   HAVING count(DISTINCT lp_prospect_id) > 1
    ORDER BY 2 DESC;`;

/**
 * Pure: rows → the check result. Split out from the DB wrapper so the baseline
 * comparison is unit-testable without a database; unit-tested in
 * scripts/test-prospect-split-detector.js.
 */
export function classifyProspectSplit(rows, baseline = PROSPECT_SPLIT_BASELINE) {
  const list = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  const count = list.length;
  return {
    status:   count > baseline ? 'split' : 'ok',
    count,
    baseline,
    delta:    count - baseline,
    // Worst-first, capped: the alert names who to look at, not everyone.
    sample:   list.slice(0, PROSPECT_SPLIT_SAMPLE_CAP)
                  .map(r => ({ ghl_contact_id: r.ghl_contact_id, prospects: Number(r.prospects) })),
    sample_capped: count > PROSPECT_SPLIT_SAMPLE_CAP,
  };
}

/**
 * Pure: should the hourly guard serve the cached result instead of re-scanning?
 * Split out for the same reason as classifyProspectSplit.
 */
export function isProspectSplitCacheFresh({ force = false, lastResult = null, lastCheckMs = 0, nowMs = Date.now() } = {}) {
  if (force) return false;
  if (!lastResult) return false;
  return nowMs - lastCheckMs < PROSPECT_SPLIT_MIN_INTERVAL_MS;
}

export async function checkProspectSplit({ force = false } = {}) {
  const now = Date.now();
  if (isProspectSplitCacheFresh({
    force, lastResult: _lastProspectSplitResult, lastCheckMs: _lastProspectSplitCheck, nowMs: now,
  })) {
    return { ..._lastProspectSplitResult, cached: true };
  }
  try {
    const result = classifyProspectSplit(await runSQL(PROSPECT_SPLIT_SQL));
    _lastProspectSplitCheck = now;
    _lastProspectSplitResult = result;
    return result;
  } catch (err) {
    return { status: 'error', error_message: err.message };
  }
}

// ─── Alert dedup ────────────────────────────────────────────────────
//
// 2026-09-05 (follow-on to PR #845). This file was the only watchdog whose
// dedup was already DURABLE — `data_freshness_log.alerted_at` survives a
// restart, unlike the process-local Maps everywhere else. Its predicate was
// still wrong: "no alert in the last 6h", not "not currently firing". A table
// stale for a week paged 28 times about the same stale table.
//
// So the storage was never the problem, the question was. reportAlertCondition
// asks the right one. `alerted_at` keeps being written — /n8n/admin/freshness
// reads it — it just no longer decides anything.

const ALERT_PREFIX = 'freshness:';
const FALLBACK_COOLDOWN_MS = ALERT_DEDUP_HOURS * 3600 * 1000;

/**
 * Report one freshness condition. Returns true if a card actually went out.
 *
 * The kill switch maps to `active: null`, not `false`. alert-state.js calls
 * that case out by name — "deliberately inhibited" — and the distinction is
 * load-bearing: `false` would mark every open condition resolved the moment
 * somebody set FRESHNESS_GROUPME_ALERTS_DISABLED, and then re-announce the lot
 * when they unset it.
 */
/**
 * Tri-state verdict for the four probes, which all report `{ status }` and two
 * of which memoize (JOB_DATE_INVERSION_MIN_INTERVAL_MS, PROSPECT_SPLIT_MIN_
 * INTERVAL_MS) between the 30-minute freshness sweeps.
 *
 *   badStatus  → true
 *   'error'    → null. The probe could not run; that is not a clean bill.
 *   cached     → null. A memoized answer is a REPLAY of an earlier observation,
 *                not a new one, and re-deciding on it would let one stale read
 *                clear a condition it never actually re-checked.
 *   anything else → false
 */
function probeVerdict(probe, badStatus) {
  if (!probe || probe.status === 'error') return null;
  if (probe.cached) return null;
  return probe.status === badStatus;
}

async function reportFreshness({ key, active, label, text, detail }) {
  const res = await reportAlertCondition({
    key: `${ALERT_PREFIX}${key}`,
    active: GROUPME_ALERTS_DISABLED ? null : active,
    label,
    text,
    detail,
    notifyRecovery: false,
    fallbackCooldownMs: FALLBACK_COOLDOWN_MS,
    send: sendGroupMeMessage,
  });
  return res.sent === true;
}

// ─── Run check + alert + log ────────────────────────────────────────

export async function runFreshnessCheck({ alert = true } = {}) {
  const results = await checkFreshness();
  const watermark = await checkSyncWatermarkHealth();
  const fieldDrift = await checkFieldDrift();
  const dateInversion = await checkJobDateInversion();
  const prospectSplit = await checkProspectSplit();
  const stale = results.filter(r => r.status === 'stale' || r.status === 'empty' || r.status === 'error');
  const alerted = [];

  // Insert one log row per table (always) so /n8n/admin/freshness shows history
  const logRows = results.map(r => ({
    table_name:        r.table,
    latest_timestamp:  r.latest || null,
    staleness_minutes: r.staleness_min ?? null,
    threshold_minutes: r.threshold_min ?? null,
    status:            r.status,
    severity:          r.severity,
    error_message:     r.error_message || null,
  }));
  try {
    await supabase.from('data_freshness_log').insert(logRows);
  } catch (err) {
    console.warn('[Freshness] log insert failed:', err.message);
  }

  // Alert on stale (edge-triggered per table, severity gate)
  if (alert) {
    // Every table gets a verdict, not just the stale ones — a table dropping
    // OUT of `stale` is exactly how its condition resolves, and the old
    // `for (const r of stale)` loop could never see that.
    for (const r of results) {
      if (r.severity === 'info') continue;  // info-level: log only

      // "The check itself failed" is its own condition, and it is NOT evidence
      // the table is fresh — so it fires the error key and leaves the stale key
      // untouched rather than clearing it.
      const isError = r.status === 'error';
      const isStale = r.status === 'stale' || r.status === 'empty';

      try {
        const icon = r.severity === 'critical' ? '🚨' : '⚠️';
        const sent = await reportFreshness({
          key: `table_stale:${r.table}`,
          active: isError ? null : isStale,
          label: `${r.table} stale`,
          detail: r.status,
          text: () => {
            const human = r.status === 'empty'
              ? `${r.table} has NO ROWS`
              : `${r.table} last updated ${formatStaleness(r.staleness_min)} ago (threshold ${formatStaleness(r.threshold_min)})`;
            return `${icon} STALE DATA [${r.severity.toUpperCase()}]\n${human}`;
          },
        });
        const errSent = await reportFreshness({
          key: `table_error:${r.table}`,
          active: isError,
          label: `${r.table} check error`,
          detail: r.error_message || null,
          text: () =>
            `${icon} STALE DATA [${r.severity.toUpperCase()}]\n` +
            `${r.table} CHECK ERROR: ${r.error_message || 'unknown'}`,
        });

        if (sent || errSent) {
          // Mark the most recent log row as alerted. Kept for the admin route,
          // which reads alerted_at; it no longer gates anything.
          await supabase
            .from('data_freshness_log')
            .update({ alerted_at: new Date().toISOString() })
            .eq('table_name', r.table)
            .gte('checked_at', new Date(Date.now() - 120000).toISOString());
          alerted.push(r.table);
        }
      } catch (err) {
        console.warn(`[Freshness] alert failed for ${r.table}: ${err.message}`);
      }
    }

    // Also alert on stuck-watermark (separate signal — different message).
    // 'unknown' (no recent runs) and 'error' are not health: null, not false.
    try {
      const sent = await reportFreshness({
        key: 'sync_watermark_stuck',
        active: probeVerdict(watermark, 'stuck'),
        label: 'sync watermark stuck',
        detail: watermark.message || null,
        text: () => `🚨 SYNC WATERMARK STUCK\n${watermark.message}`,
      });
      // A log row on the firing EDGE, not on every sweep: the old code was gated
      // by the 6h dedup read, so a firing probe wrote at most one row per window.
      // Writing one per 30-min sweep instead would quietly grow the table.
      // Under the kill switch nothing is ever "sent", so the row is written on
      // each sweep exactly as before — that path is unchanged.
      if ((watermark.status === 'stuck') && (sent || GROUPME_ALERTS_DISABLED)) {
        await supabase.from('data_freshness_log').insert({
          table_name:    '__sync_watermark__',
          status:        'stale',
          severity:      'critical',
          error_message: sent
            ? watermark.message
            : `${watermark.message} [alert suppressed — already firing, or FRESHNESS_GROUPME_ALERTS_DISABLED]`,
          alerted_at:    sent ? new Date().toISOString() : null,
        });
        if (sent) alerted.push('__sync_watermark__');
      }
    } catch (err) {
      console.warn(`[Freshness] watermark alert failed: ${err.message}`);
    }

    // Field-drift alert (funnel flags rotting on existing rows — the 5-vs-21 probe)
    try {
      const human = () => `Funnel-flag drift: ${fieldDrift.drifted}/${fieldDrift.sampled} sampled leads (${fieldDrift.drift_pct}%) have cached demo/appt/sold flags that disagree with LP (threshold ${fieldDrift.threshold}). Run POST /n8n/admin/lp-cohort-reconcile.`;
      const sent = await reportFreshness({
        key: 'field_drift',
        active: probeVerdict(fieldDrift, 'drift'),
        label: 'LP field drift',
        detail: fieldDrift.status,
        text: () => `🚨 LP FIELD DRIFT\n${human()}`,
      });
      // A log row on the firing EDGE, not on every sweep: the old code was gated
      // by the 6h dedup read, so a firing probe wrote at most one row per window.
      // Writing one per 30-min sweep instead would quietly grow the table.
      // Under the kill switch nothing is ever "sent", so the row is written on
      // each sweep exactly as before — that path is unchanged.
      if ((fieldDrift.status === 'drift') && (sent || GROUPME_ALERTS_DISABLED)) {
        await supabase.from('data_freshness_log').insert({
          table_name:    '__field_drift__',
          status:        'stale',
          severity:      'critical',
          error_message: sent ? human() : `${human()} [alert suppressed — already firing, or FRESHNESS_GROUPME_ALERTS_DISABLED]`,
          alerted_at:    sent ? new Date().toISOString() : null,
        });
        if (sent) alerted.push('__field_drift__');
      }
    } catch (err) {
      console.warn(`[Freshness] field-drift alert failed: ${err.message}`);
    }

    // Job date-inversion alert (install finished before it started — LP source data,
    // tracked not repaired). Fires only above the accepted baseline.
    try {
      const human = () => `lp_jobs date inversion: ${dateInversion.count} jobs have install_completed_date before install_date, up ${dateInversion.delta} on the accepted baseline of ${dateInversion.baseline}. LP source data — check what is keying these dates, do not repair in the mapper.`;
      const sent = await reportFreshness({
        key: 'job_date_inversion',
        active: probeVerdict(dateInversion, 'inverted'),
        label: 'LP job date inversion',
        detail: dateInversion.status,
        text: () => `⚠️ LP JOB DATE INVERSION\n${human()}`,
      });
      // A log row on the firing EDGE, not on every sweep: the old code was gated
      // by the 6h dedup read, so a firing probe wrote at most one row per window.
      // Writing one per 30-min sweep instead would quietly grow the table.
      // Under the kill switch nothing is ever "sent", so the row is written on
      // each sweep exactly as before — that path is unchanged.
      if ((dateInversion.status === 'inverted' && !dateInversion.cached) && (sent || GROUPME_ALERTS_DISABLED)) {
        await supabase.from('data_freshness_log').insert({
          table_name:    '__job_date_inversion__',
          status:        'stale',
          severity:      'warning',
          error_message: sent ? human() : `${human()} [alert suppressed — already firing, or FRESHNESS_GROUPME_ALERTS_DISABLED]`,
          alerted_at:    sent ? new Date().toISOString() : null,
        });
        if (sent) alerted.push('__job_date_inversion__');
      }
    } catch (err) {
      console.warn(`[Freshness] date-inversion alert failed: ${err.message}`);
    }

    // Prospect-split alert (one contact spanning several LP prospects — a person-level
    // identity split). Detect only; a human merges in LP. Fires only above baseline.
    try {
      const human = () => {
        const names = prospectSplit.sample
          .map(s => `${s.ghl_contact_id} (${s.prospects})`)
          .join(', ');
        const more = prospectSplit.sample_capped
          ? ` +${prospectSplit.count - prospectSplit.sample.length} more`
          : '';
        return `LP prospect split: ${prospectSplit.count} contacts have lp_leads across more than one lp_prospect_id, up ${prospectSplit.delta} on the accepted baseline of ${prospectSplit.baseline}. Affected: ${names}${more}. lp_prospect_id is the person-level key, so a split gives one human two identities — deleting duplicate LEADS does not fix it. Merge or delete the extra prospects in LP; do NOT auto-merge.`;
      };
      const sent = await reportFreshness({
        key: 'prospect_split',
        active: probeVerdict(prospectSplit, 'split'),
        label: 'LP prospect split',
        detail: prospectSplit.status,
        text: () => `⚠️ LP PROSPECT SPLIT\n${human()}`,
      });
      // A log row on the firing EDGE, not on every sweep: the old code was gated
      // by the 6h dedup read, so a firing probe wrote at most one row per window.
      // Writing one per 30-min sweep instead would quietly grow the table.
      // Under the kill switch nothing is ever "sent", so the row is written on
      // each sweep exactly as before — that path is unchanged.
      if ((prospectSplit.status === 'split' && !prospectSplit.cached) && (sent || GROUPME_ALERTS_DISABLED)) {
        await supabase.from('data_freshness_log').insert({
          table_name:    '__prospect_split__',
          status:        'stale',
          severity:      'warning',
          error_message: sent ? human() : `${human()} [alert suppressed — already firing, or FRESHNESS_GROUPME_ALERTS_DISABLED]`,
          alerted_at:    sent ? new Date().toISOString() : null,
        });
        if (sent) alerted.push('__prospect_split__');
      }
    } catch (err) {
      console.warn(`[Freshness] prospect-split alert failed: ${err.message}`);
    }
  }

  return {
    checked_at: new Date().toISOString(),
    table_results: results,
    sync_watermark: watermark,
    field_drift: fieldDrift,
    job_date_inversion: dateInversion,
    prospect_split: prospectSplit,
    stale_count: stale.length,
    alerted,
    groupme_alerts_disabled: GROUPME_ALERTS_DISABLED,
  };
}

function formatStaleness(min) {
  if (min == null) return 'unknown';
  if (min < 60) return `${min}min`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  return `${Math.round(min / 1440)}d`;
}

// ─── LP API sync probe (diagnostic) ─────────────────────────────────
// v1.1: Tests all 3 lead-fetch paths in parallel via probeLeadEndpoints,
// plus getJobStatusChanges as the control. Returns a clear verdict
// telling Mark which path the auto-fallback is currently using.

export async function probeSyncEndpoints({ days = 3 } = {}) {
  const enddate   = new Date().toISOString().slice(0, 10);
  const startdate = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const out = { window: { startdate, enddate, days } };

  // 3-path probe of lead endpoints (parallelized inside probeLeadEndpoints)
  let leadProbe = null;
  try {
    leadProbe = await probeLeadEndpoints({ startdate, enddate, PageSize: 50 });
    out.lead_endpoints = leadProbe;
  } catch (err) {
    out.lead_endpoints = { error: err.message };
  }

  // Control: getJobStatusChanges (currently working)
  try {
    const r = await getJobStatusChanges({ startdate, enddate, PageSize: 50, StartIndex: 1 });
    const items = Array.isArray(r) ? r : (r?.data || r?.jobs || r?.results || []);
    out.getJobStatusChanges = {
      response_shape: Array.isArray(r) ? 'array' : (typeof r),
      count: items.length,
      first_item_keys: items[0] ? Object.keys(items[0]).slice(0, 20) : [],
    };
  } catch (err) {
    out.getJobStatusChanges = { error: err.message };
  }

  // Verdict — which path is currently working
  const a = leadProbe?.path_a?.count ?? null;
  const b = leadProbe?.path_b?.count ?? null;
  const c = leadProbe?.path_c?.count ?? null;
  const job = out.getJobStatusChanges?.count ?? 0;

  if (a > 0) {
    out.verdict = `Path A working (GetLeadData with pro_id=0 returned ${a}). Sync should be healthy on legacy path.`;
    out.recommended_action = 'No code change needed. Investigate why recent incremental syncs returned 0.';
  } else if (b > 0) {
    out.verdict = `Path A broken (0 records) but Path B working (GetLeadData WITHOUT pro_id returned ${b}). pro_id=0 is the broken parameter.`;
    out.recommended_action = 'Permanent fix: patch lp-client.js getLeadData to omit pro_id by default. The auto-fallback is currently doing this for you on every run.';
  } else if (c > 0) {
    out.verdict = `Both Path A and Path B return 0 from GetLeadData. Path C (/api/Customers/GetLead) returned ${c}. /api/Leads/GetLeadData appears fully broken on LP side.`;
    out.recommended_action = 'The auto-fallback is currently routing all traffic to /api/Customers/GetLead. Consider asking Amanda at LP to investigate /api/Leads/GetLeadData. To accelerate backfill, set FORCE_SYNC_SINCE env var on Railway to ~5 days ago for one full incremental.';
  } else if (a === 0 && b === 0 && c === 0 && job > 0) {
    out.verdict = `All 3 lead paths return 0 but getJobStatusChanges returns ${job}. Auth+token+network are fine but every lead-fetch endpoint is empty for this window. Unusual.`;
    out.recommended_action = 'Try a wider window (?days=14). If still 0, contact Amanda at LP — both /api/Leads/GetLeadData AND /api/Customers/GetLead are misbehaving.';
  } else if (a === 0 && b === 0 && c === 0 && job === 0) {
    out.verdict = 'Every endpoint returns 0. Likely token/auth issue OR the window genuinely has no activity.';
    out.recommended_action = 'Try a wider window. If still 0, hit /lp/test to verify auth.';
  } else {
    out.verdict = 'Partial / unusual response pattern. Inspect response_shape and raw_response_keys for each path.';
    out.recommended_action = 'Manual inspection required.';
  }

  return out;
}

// ─── Express routes ─────────────────────────────────────────────────

export function registerDataFreshnessRoutes(app) {
  // Quick view — does NOT write to log table; for human inspection
  app.get('/n8n/admin/freshness', async (req, res) => {
    try {
      const [results, watermark] = await Promise.all([
        checkFreshness(),
        checkSyncWatermarkHealth(),
      ]);
      // Field-drift makes live LP calls, so it's opt-in on this quick view
      // (?drift=1). The scheduled freshness-check always runs it.
      const wantDrift = req.query?.drift === '1' || req.query?.drift === 'true';
      const fieldDrift = wantDrift ? await checkFieldDrift() : null;
      // Date-inversion is a plain DB count with no LP call, so unlike field-drift it
      // runs unconditionally here. Its own hourly guard keeps the scan cheap.
      const dateInversion = await checkJobDateInversion();
      // Prospect-split is likewise a plain DB count with no LP call, guarded hourly.
      const prospectSplit = await checkProspectSplit();
      const stale = results.filter(r => r.status === 'stale' || r.status === 'empty' || r.status === 'error');
      res.json({
        checked_at: new Date().toISOString(),
        all_fresh: stale.length === 0 && watermark.status !== 'stuck'
                   && (!fieldDrift || fieldDrift.status !== 'drift')
                   && dateInversion.status !== 'inverted'
                   && prospectSplit.status !== 'split',
        stale_count: stale.length,
        sync_watermark: watermark,
        field_drift: fieldDrift,
        job_date_inversion: dateInversion,
        prospect_split: prospectSplit,
        groupme_alerts_disabled: GROUPME_ALERTS_DISABLED,
        results,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Manual run (with logging + optional alert)
  app.post('/n8n/admin/freshness-check', async (req, res) => {
    try {
      const result = await runFreshnessCheck({ alert: req.body?.alert !== false });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // LP API probe for sync diagnostics
  app.get('/n8n/admin/sync-probe', async (req, res) => {
    try {
      const days = Math.max(1, Math.min(30, parseInt(req.query.days || '3', 10)));
      const result = await probeSyncEndpoints({ days });
      res.json({ probed_at: new Date().toISOString(), ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[Freshness] Registered: GET /n8n/admin/freshness | POST /n8n/admin/freshness-check | GET /n8n/admin/sync-probe');
}

// ─── Scheduler ──────────────────────────────────────────────────────

let freshnessTimer = null;

export function startDataFreshnessMonitorScheduler() {
  if (freshnessTimer) return;
  const intervalMs = CHECK_INTERVAL_MINUTES * 60 * 1000;
  console.log(`[Freshness] Scheduler started — checks every ${CHECK_INTERVAL_MINUTES}min, dedup ${ALERT_DEDUP_HOURS}h, groupme_alerts=${GROUPME_ALERTS_DISABLED ? 'DISABLED' : 'enabled'}`);

  // First check 60s after boot — gives sync scheduler time to settle
  setTimeout(() => {
    runFreshnessCheck().catch(e => console.warn('[Freshness] initial check failed:', e.message));
  }, 60_000);

  freshnessTimer = setInterval(() => {
    runFreshnessCheck().catch(e => console.warn('[Freshness] scheduled check failed:', e.message));
  }, intervalMs);
}

export function stopDataFreshnessMonitorScheduler() {
  if (freshnessTimer) {
    clearInterval(freshnessTimer);
    freshnessTimer = null;
  }
}
