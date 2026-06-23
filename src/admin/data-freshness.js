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

const MONITORED_TABLES = [
  // LP-derived (synced from Lead Perfection every 15min)
  { name: 'lp_leads',        timestamp_col: 'created_at_lp', threshold_min: 360,  severity: 'warning'  }, // 6h
  { name: 'lp_notes',        timestamp_col: 'created_at_lp', threshold_min: 720,  severity: 'critical' }, // 12h — was the original symptom
  { name: 'lp_call_logs',    timestamp_col: 'call_date',     threshold_min: 720,  severity: 'warning'  }, // 12h
  { name: 'lp_activities',   timestamp_col: 'activity_date', threshold_min: 720,  severity: 'warning'  }, // 12h
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

    const latest = new Date(data[t.timestamp_col]);
    const staleness_min = Math.round((Date.now() - latest.getTime()) / 60000);
    return {
      table: t.name,
      status: staleness_min > t.threshold_min ? 'stale' : 'fresh',
      latest: latest.toISOString(),
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

// ─── Alert dedup ────────────────────────────────────────────────────

async function shouldAlert(tableName) {
  const since = new Date(Date.now() - ALERT_DEDUP_HOURS * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('data_freshness_log')
    .select('id, alerted_at')
    .eq('table_name', tableName)
    .not('alerted_at', 'is', null)
    .gte('alerted_at', since)
    .order('alerted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return !data;  // alert only if no recent alert
}

// ─── Run check + alert + log ────────────────────────────────────────

export async function runFreshnessCheck({ alert = true } = {}) {
  const results = await checkFreshness();
  const watermark = await checkSyncWatermarkHealth();
  const fieldDrift = await checkFieldDrift();
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

  // Alert on stale (with dedup, severity gate)
  if (alert) {
    for (const r of stale) {
      if (r.severity === 'info') continue;  // info-level: log only
      try {
        if (!(await shouldAlert(r.table))) continue;

        const human = r.status === 'empty'
          ? `${r.table} has NO ROWS`
          : r.status === 'error'
          ? `${r.table} CHECK ERROR: ${r.error_message || 'unknown'}`
          : `${r.table} last updated ${formatStaleness(r.staleness_min)} ago (threshold ${formatStaleness(r.threshold_min)})`;

        const icon = r.severity === 'critical' ? '🚨' : '⚠️';
        const msg  = `${icon} STALE DATA [${r.severity.toUpperCase()}]\n${human}`;

        // v1.2: respect kill switch. Logs are still written above.
        const sendResult = GROUPME_ALERTS_DISABLED
          ? { sent: false, suppressed: true }
          : await sendGroupMeMessage(msg);
        if (sendResult?.sent) {
          // Mark the most recent log row as alerted
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

    // Also alert on stuck-watermark (separate signal — different message)
    if (watermark.status === 'stuck') {
      try {
        if (await shouldAlert('__sync_watermark__')) {
          // v1.2: respect kill switch. Suppressed alerts still leave a log row below.
          const sendResult = GROUPME_ALERTS_DISABLED
            ? { sent: false, suppressed: true }
            : await sendGroupMeMessage(`🚨 SYNC WATERMARK STUCK\n${watermark.message}`);
          if (sendResult?.sent) {
            await supabase.from('data_freshness_log').insert({
              table_name:    '__sync_watermark__',
              status:        'stale',
              severity:      'critical',
              error_message: watermark.message,
              alerted_at:    new Date().toISOString(),
            });
            alerted.push('__sync_watermark__');
          } else if (GROUPME_ALERTS_DISABLED) {
            // Still leave a non-alerted log row so /n8n/admin/freshness reflects it.
            await supabase.from('data_freshness_log').insert({
              table_name:    '__sync_watermark__',
              status:        'stale',
              severity:      'critical',
              error_message: `${watermark.message} [GroupMe alert suppressed by FRESHNESS_GROUPME_ALERTS_DISABLED]`,
            });
          }
        }
      } catch (err) {
        console.warn(`[Freshness] watermark alert failed: ${err.message}`);
      }
    }

    // Field-drift alert (funnel flags rotting on existing rows — the 5-vs-21 probe)
    if (fieldDrift.status === 'drift') {
      try {
        if (await shouldAlert('__field_drift__')) {
          const human = `Funnel-flag drift: ${fieldDrift.drifted}/${fieldDrift.sampled} sampled leads (${fieldDrift.drift_pct}%) have cached demo/appt/sold flags that disagree with LP (threshold ${fieldDrift.threshold}). Run POST /n8n/admin/lp-cohort-reconcile.`;
          const sendResult = GROUPME_ALERTS_DISABLED
            ? { sent: false, suppressed: true }
            : await sendGroupMeMessage(`🚨 LP FIELD DRIFT\n${human}`);
          await supabase.from('data_freshness_log').insert({
            table_name:    '__field_drift__',
            status:        'stale',
            severity:      'critical',
            error_message: sendResult?.sent ? human : `${human} [GroupMe alert suppressed by FRESHNESS_GROUPME_ALERTS_DISABLED]`,
            alerted_at:    sendResult?.sent ? new Date().toISOString() : null,
          });
          if (sendResult?.sent) alerted.push('__field_drift__');
        }
      } catch (err) {
        console.warn(`[Freshness] field-drift alert failed: ${err.message}`);
      }
    }
  }

  return {
    checked_at: new Date().toISOString(),
    table_results: results,
    sync_watermark: watermark,
    field_drift: fieldDrift,
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
      const stale = results.filter(r => r.status === 'stale' || r.status === 'empty' || r.status === 'error');
      res.json({
        checked_at: new Date().toISOString(),
        all_fresh: stale.length === 0 && watermark.status !== 'stuck' && (!fieldDrift || fieldDrift.status !== 'drift'),
        stale_count: stale.length,
        sync_watermark: watermark,
        field_drift: fieldDrift,
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
