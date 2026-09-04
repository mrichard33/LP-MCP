// ─── Sync Logging — src/sync-log.js ───────────────────────────────
//
// Sync log management for lp_sync_log table.
// Tracks per-entity sync progress, completion, and failures.
// activeLogIds scopes SIGTERM cleanup to THIS process's rows only.
//
// v6.8 — SYNC GAP DETECTION + ALERT.
//         When getLastSyncTimestamp computes a bestTs older than
//         MAX_INCREMENTAL_DAYS, we now emit a `system.sync_gap_detected`
//         system event and upgrade the log line to console.error with
//         a ⚠️ prefix. The event payload includes the exact
//         FORCE_SYNC_SINCE value to use for a one-shot backfill so
//         operators can recover in one chat command.
//         Priority: 'critical' if gap > 7 days, else 'high'.
//         The cap itself is unchanged — we still return the maxLookback
//         timestamp to keep per-run workload bounded. v6.8 is about
//         making the gap visible immediately, not auto-recovering.
//         Root cause: a 14-day gap on 2026-05-05 went silent until
//         17,176 milestone triggers and 180,134 day-15 leads piled up.
//         The cap message was console.log buried in normal-looking
//         output, and no event fired anywhere.
// v6.6 — MAX_INCREMENTAL_DAYS is now env-configurable (default lowered
//         from 3 → 1). Long gaps between successful syncs no longer
//         silently expand the per-run workload to 3 days, which was
//         pushing leads sweeps past the 20-min per-sweep budget. Override
//         via env: MAX_INCREMENTAL_DAYS=N.
//         markRunningLogsAsFailed now accepts a `reason` parameter so
//         callers can disambiguate SIGTERM ("Process terminated") from
//         timeout ("Sweep timed out") in the lp_sync_log table.
//         Default reason is still "Process terminated" for SIGTERM/SIGINT
//         callers that don't pass anything.
// v6.4 — syncLogProgress is now time-throttled rather than page-bound.
//         Callers can invoke it per-record without flooding Supabase —
//         the function itself enforces a minimum interval between writes
//         per logId. Default 5000ms, configurable via env:
//         SYNC_PROGRESS_THROTTLE_MS=N.
//         Lets the records_synced column update smoothly during long
//         runs instead of sitting at 0 until page boundaries.
// v6.3 — FORCE_SYNC_SINCE env var override in getLastSyncTimestamp.
//         Set to a valid ISO date to override computed "since" for a
//         one-shot backfill (bypasses MAX_INCREMENTAL_DAYS cap).
//         Unset/invalid = normal behavior.
// v6.2 — getLastSyncTimestamp now includes failed syncs that wrote records.
//         Added MAX_INCREMENTAL_DAYS to cap the sync window.

import supabase from './supabase.js';

export const ENTITY_TYPES = ['leads', 'calls', 'notes', 'jobs', 'milestones', 'activities', 'dispositions', 'sources', 'ghl_backfill'];

// Track sync log IDs owned by THIS process — scopes SIGTERM cleanup
export const activeLogIds = new Set();

// Mutex state — shared across fullSync/incrementalSync
export let syncInProgress = false;
export let syncStartedAt = null;
export const STALE_LOCK_MINUTES = 120; // 2 hours max before force-reset

// WO-6 (082): terminal statuses. `failed` means real record-level failures
// and NOTHING else — it is the number worth alerting on. `interrupted` is
// the process being killed out from under an in-flight sweep, which is an
// infrastructure event and never a data defect.
//
// Every SIGTERM row in lp_sync_log was written by a Railway deploy shutting
// the old container down. Counting those as failures is what produced a
// "23% failure rate" that nobody could act on for weeks.
export const SYNC_STATUS = Object.freeze({
  RUNNING:     'running',
  COMPLETED:   'completed',
  FAILED:      'failed',
  INTERRUPTED: 'interrupted',
});

// v6.6: Max days to look back in incremental sync. Env-configurable.
// Default lowered from 3 → 1 so a long gap between successful syncs
// doesn't silently inflate per-run workload past the per-sweep timeout
// budget. If you need a deeper backfill, use FORCE_SYNC_SINCE for a
// one-shot override rather than raising this cap globally.
export const MAX_INCREMENTAL_DAYS = parseInt(process.env.MAX_INCREMENTAL_DAYS || '1', 10);

// WO-12 (085): kill switch for the processed-rows watermark. Default ON.
// Set SYNC_WATERMARK_FROM_PROCESSED=false to fall back to the pre-085 rule
// (advance only on runs that WROTE rows, anchored at completed_at). Railway is
// authoritative for this value — a setting there overrides this default.
export const WATERMARK_FROM_PROCESSED =
  (process.env.SYNC_WATERMARK_FROM_PROCESSED || 'true').toLowerCase() !== 'false';

// v6.4: Throttle for syncLogProgress writes. Callers can invoke per-record;
// this map tracks the last DB-write timestamp per logId and skips writes
// inside the throttle window. 5s default keeps the dashboard feeling live
// while capping write volume to ~0.2 updates/sec/entity.
const lastProgressWrite = new Map();
const PROGRESS_THROTTLE_MS = parseInt(process.env.SYNC_PROGRESS_THROTTLE_MS || '5000', 10);

// v6.8: Suppress duplicate gap alerts within a single boot. The
// scheduler boot path calls getLastSyncTimestamp twice (once for the
// "should we run full vs incremental" decision, once inside
// incrementalSync itself). Without this, every boot with a real gap
// would emit two near-identical events. The idempotency_key on the
// emit gives belt-and-suspenders dedup at the system_events level too.
let _gapAlertEmittedThisProcess = false;

export function setSyncInProgress(val) { syncInProgress = val; }
export function setSyncStartedAt(val) { syncStartedAt = val; }

// Create a "running" row for an entity and return its id
export async function syncLogStart(entityType, syncType) {
  try {
    const { data, error } = await supabase.from('lp_sync_log').insert({
      entity_type:    entityType,
      sync_type:      syncType,
      status:         'running',
      records_synced: 0,
      started_at:     new Date().toISOString(),
    }).select('id').single();
    if (error) throw error;
    if (data?.id) activeLogIds.add(data.id);
    return data?.id;
  } catch (err) {
    console.error(`[Sync] Failed to create sync log for ${entityType}:`, err.message);
    return null;
  }
}

// Update records_synced count. v6.4: Time-throttled — safe to call per-record.
// Writes at most once per PROGRESS_THROTTLE_MS (default 5000ms) per logId.
// Calls inside the throttle window are no-ops. Final count is guaranteed
// correct via syncLogComplete, which writes unconditionally.
export async function syncLogProgress(logId, count) {
  if (!logId) return;
  const now = Date.now();
  const last = lastProgressWrite.get(logId) || 0;
  if (now - last < PROGRESS_THROTTLE_MS) return; // throttled — skip write
  lastProgressWrite.set(logId, now);
  try {
    await supabase.from('lp_sync_log').update({
      records_synced: count,
    }).eq('id', logId);
  } catch (_) {
    // Non-fatal — don't break sync over a progress update
  }
}

// Mark entity sync as completed (skips if already completed/failed)
//
// WO-12 (085): `windowComplete` says whether the sweep reached the END of its
// window, which is a different question from whether it finished without
// throwing. A run stopped by MAX_INCREMENTAL_LEADS or MAX_SCANNED_LEADS, or
// truncated by a page that errored, is `completed` for log purposes and is
// draining a backlog by design — but it has NOT covered its window, and
// getLastSyncTimestamp must not advance past it or the remainder is abandoned.
// Omit the argument to leave the column NULL (the honest value for every
// caller that does not track window coverage).
export async function syncLogComplete(logId, count, errorMessage, windowComplete) {
  if (!logId) return;
  activeLogIds.delete(logId);
  lastProgressWrite.delete(logId); // v6.4: clear throttle state for this logId
  try {
    const patch = {
      status:         errorMessage ? 'failed' : 'completed',
      records_synced: count,
      error_message:  errorMessage || null,
      completed_at:   new Date().toISOString(),
    };
    if (typeof windowComplete === 'boolean') patch.window_complete = windowComplete;
    await supabase.from('lp_sync_log').update(patch)
      .eq('id', logId).eq('status', 'running'); // Only update if still running
  } catch (err) {
    console.error('[Sync] Failed to complete sync log:', err.message);
  }
}

// Mark entity sync as failed
export async function syncLogFail(logId, count, errorMessage) {
  await syncLogComplete(logId, count, errorMessage || 'Unknown error');
}

// Helper: create log rows for all entity types at once, returns { leads: id, calls: id, ... }
export async function syncLogStartAll(syncType, entityTypes = ENTITY_TYPES) {
  const ids = {};
  await Promise.all(entityTypes.map(async (et) => {
    ids[et] = await syncLogStart(et, syncType);
  }));
  return ids;
}

export async function logSyncError(entityId, err, syncType = null) {
  console.error(`[Sync] Entity ${entityId} failed:`, err.message);
  try {
    await supabase.from('lp_sync_errors').insert({
      lp_lead_id: entityId ? String(entityId) : null,
      lp_prospect_id: null,
      error_message: err.message,
      error_stack: err.stack,
      sync_type: syncType || (syncInProgress ? 'unknown' : null),
      retry_count: 0,
      resolved: false,
    });
  } catch (logErr) {
    console.error('[Sync] Failed to log error to lp_sync_errors:', logErr.message);
  }
}

// ─── v6.8 helper — emit a sync gap alert ─────────────────────────
//
// Lazy-imports event-emitter so this file stays loadable even if the
// emitter has init-order issues at boot. bypass_filter:true is
// required because system.* event types are not in the standard
// rule-consumer allowlist (they go straight to notification handlers).
async function emitSyncGapAlert(bestTs, maxLookback, gapDays) {
  if (_gapAlertEmittedThisProcess) return;
  _gapAlertEmittedThisProcess = true;
  try {
    const { emitEvent } = await import('./event-emitter.js');
    await emitEvent({
      event_type: 'system.sync_gap_detected',
      event_subtype: 'incremental_cap_fired',
      source: 'lp_sync',
      entity_type: 'system',
      entity_id: 'sync-engine',
      payload: {
        last_successful_sync: bestTs.toISOString(),
        gap_days: gapDays,
        capped_to: maxLookback.toISOString(),
        force_sync_since_value: bestTs.toISOString(),
        operator_action: `Set FORCE_SYNC_SINCE=${bestTs.toISOString()} on the LP MCP Railway service to backfill this gap, then unset after the next successful sync completes.`,
      },
      priority: gapDays > 7 ? 'critical' : 'high',
      idempotency_key: `sync_gap_${new Date().toISOString().slice(0, 10)}_${gapDays}d`,
      bypass_filter: true, // system.* events bypass the rule-consumer gate
    });
  } catch (alertErr) {
    console.warn('[Sync] Failed to emit sync gap alert:', alertErr.message);
  }
}

// Get the most recent sync timestamp to use as the "since" date for incremental sync.
// v6.3: FORCE_SYNC_SINCE env override takes precedence — used for one-shot backfills
//        when the gap exceeds MAX_INCREMENTAL_DAYS. Set to an ISO date string.
// v6.2: Also considers failed syncs that wrote a significant number of records
// (>100), since those records ARE in the database. This prevents the sync from
// repeatedly trying to re-pull a week-old backlog after process terminations.
export async function getLastSyncTimestamp() {
  try {
    // v6.3: Env override — one-shot backfill with an explicit since-date.
    // Set FORCE_SYNC_SINCE to an ISO date (e.g. "2026-04-03T00:00:00Z") to
    // override the computed timestamp and bypass the MAX_INCREMENTAL_DAYS cap.
    // Unset to revert to normal. Invalid values are logged and ignored.
    const override = process.env.FORCE_SYNC_SINCE;
    if (override) {
      const ts = new Date(override);
      if (!isNaN(ts.getTime())) {
        console.log(`[Sync] FORCE_SYNC_SINCE override active — using ${ts.toISOString()} (MAX_INCREMENTAL_DAYS cap bypassed)`);
        return ts;
      } else {
        console.warn(`[Sync] FORCE_SYNC_SINCE invalid (not a valid ISO date): "${override}" — ignoring, falling back to normal lookup`);
      }
    }

    // WO-12 (085): FIRST try — the last run that DRAINED its window.
    //
    // Two things changed here, and both are about the difference between rows
    // PROCESSED and rows WRITTEN.
    //
    // 1. The gate is `window_complete`, not `records_synced > 0`.
    //    #837/#846 stopped writing rows whose payload hash was unchanged. An
    //    unchanged prospect returns null from the page mapper and never
    //    increments counts.leads, so records_synced counts WRITES. A quiet
    //    15-minute window in which every row is unchanged is a fully and
    //    correctly synced window that writes nothing — and the old gate threw
    //    that run away, dropping the cursor back to the last run that happened
    //    to write something and re-opening the window a little further every
    //    time. The date truncation masked this completely (a since-midnight
    //    window always writes something); narrowing the window exposes it, so
    //    this MUST land in the same change as the timestamp cursor, not after.
    //
    // 2. It reads `started_at`, not `completed_at`.
    //    A sweep READS across [started_at .. completed_at]. A lead changed
    //    while the sweep was already past its page is invisible to that run, so
    //    a cursor at completed_at skips it forever. SYNC_WINDOW_OVERLAP_MIN was
    //    sized to paper over exactly this; anchoring at started_at removes the
    //    hazard instead of out-running it, and the overlap goes back to being
    //    defence in depth rather than the only defence.
    //
    // `window_complete` is written by incrementalSync and is true ONLY when the
    // leads sweep reached the end of its window: no MAX_INCREMENTAL_LEADS cap,
    // no MAX_SCANNED_LEADS ceiling, no page that errored and truncated the
    // sweep. A capped run is `completed` for log purposes but has NOT drained
    // its window, and advancing past one silently abandons the remainder.
    const { data: drained } = WATERMARK_FROM_PROCESSED ? await supabase
      .from('lp_sync_log')
      .select('started_at')
      .eq('entity_type', 'leads')
      .eq('status', 'completed')
      .eq('window_complete', true)
      .not('started_at', 'is', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle() : { data: null };

    // Legacy path: rows written before 085 have no window_complete value at
    // all. For those the old rule is the best available signal, so it stays —
    // scoped to `window_complete IS NULL` so it can never out-rank a real
    // drained-window row from the new path.
    const { data: completed } = await supabase
      .from('lp_sync_log')
      .select('completed_at')
      .eq('entity_type', 'leads')
      .eq('status', 'completed')
      .is('window_complete', null)
      .gt('records_synced', 0)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Second try: non-completed syncs that wrote >100 records (partial
    // progress is real).
    //
    // WO-6 (082): this MUST include `interrupted` as well as `failed`. A
    // sweep killed by a Railway deploy after writing 4,000 rows is the
    // single most common partial-progress case there is — before 082 those
    // rows were labelled `failed` and this query caught them. Matching only
    // `failed` now would silently drop the cursor back to the last fully
    // completed sync, re-scanning a window that was already synced and, on a
    // long deploy run, drifting far enough back to trip the
    // MAX_INCREMENTAL_DAYS cap and fire a false sync_gap alert.
    const { data: partialFailed } = await supabase
      .from('lp_sync_log')
      .select('started_at')
      .eq('entity_type', 'leads')
      .in('status', [SYNC_STATUS.FAILED, SYNC_STATUS.INTERRUPTED])
      .gt('records_synced', 100)
      .not('started_at', 'is', null)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const drainedTs = drained?.started_at ? new Date(drained.started_at) : null;
    const completedTs = completed?.completed_at ? new Date(completed.completed_at) : null;
    const failedTs = partialFailed?.started_at ? new Date(partialFailed.started_at) : null;

    // Use whichever is most recent. All three are lower bounds on "everything
    // before this point is known synced", so max() is the correct combiner —
    // and because each is a lower bound, over-selecting is never a skip.
    const bestTs = [drainedTs, completedTs, failedTs]
      .filter(Boolean)
      .reduce((a, b) => (a > b ? a : b), null);

    if (!bestTs) return null;

    // Cap: never look back more than MAX_INCREMENTAL_DAYS
    const maxLookback = new Date(Date.now() - MAX_INCREMENTAL_DAYS * 24 * 60 * 60 * 1000);
    if (bestTs < maxLookback) {
      // v6.8: Gap is real — surface it LOUDLY and emit an alert event.
      // We still cap to keep per-run workload bounded; the alert tells
      // operators to set FORCE_SYNC_SINCE for an explicit backfill.
      const gapDays = Math.round((maxLookback.getTime() - bestTs.getTime()) / 86400000);
      console.error(
        `[Sync] ⚠️ SYNC GAP DETECTED — last sync ${bestTs.toISOString()} is ${gapDays} days behind. ` +
        `Capping to ${maxLookback.toISOString()} — the gap will NOT be backfilled by normal runs. ` +
        `To backfill: set FORCE_SYNC_SINCE=${bestTs.toISOString()}`
      );
      // Fire-and-forget — don't block the caller on the alert path.
      emitSyncGapAlert(bestTs, maxLookback, gapDays).catch(() => {});
      return maxLookback;
    }

    return bestTs;
  } catch (err) {
    console.error('[Sync] Failed to read sync log:', err.message);
    return null;
  }
}

// Mark this process's own running sync logs as failed on termination.
// Scoped to activeLogIds to prevent poisoning a newly-booted process's rows.
//
// v6.6: Accepts an optional `reason` argument so callers can distinguish
// between SIGTERM/SIGINT shutdowns (default: "Process terminated") and
// programmatic invocations like timeout cleanup (e.g. "Sweep timed out").
// Without this, every sweep-timeout failure was misleadingly labelled
// "Process terminated" in the lp_sync_log error_message column, making
// the diagnostic loop "is Railway killing us or did we time out?" take
// far longer than it should have.
export async function markRunningLogsAsFailed(reason = 'Process terminated') {
  return markRunningLogsTerminal(SYNC_STATUS.FAILED, reason);
}

// WO-6 (082): the shutdown path now marks its rows `interrupted`, not
// `failed`. Same mechanics, honest status.
//
// This is the whole fix for the lying metric. A container kill during a
// deploy is not a sync failure, and writing it into the same bucket as
// "2 records failed" is what made failed_syncs unreadable.
export async function markRunningLogsAsInterrupted(reason = 'Process terminated') {
  return markRunningLogsTerminal(SYNC_STATUS.INTERRUPTED, reason);
}

export async function markRunningLogsTerminal(status, reason) {
  try {
    const ids = [...activeLogIds];
    if (ids.length === 0) {
      console.log('[Sync] No active sync log IDs to clean up');
      return 0;
    }
    await supabase.from('lp_sync_log')
      .update({
        status,
        error_message: reason,
        completed_at: new Date().toISOString(),
      })
      .in('id', ids);
    console.log(`[Sync] Marked ${ids.length} owned sync log rows as ${status}: "${reason}"`);
    return ids.length;
  } catch (_) {
    // Best-effort — process is shutting down
    return 0;
  }
}

// WO-6 (A4): persist paging telemetry so the long-run problem becomes
// queryable instead of log-only.
//
// `pagingMode` MUST come from the branch the sweep actually took. Inferring
// "it was slow, so it must have been deep paging" is the guess this column
// exists to replace.
// 084: `rowsScanned` is rows FETCHED from LP, whether or not they were written.
// It is the variable deep-offset paging actually triggers on, and it is why the
// first attempt to confirm that theory came back inconclusive — the correlation
// was run against records_synced (rows WRITTEN), which is a different number:
// measured 2026-09-04, one leads sweep scanned 543 rows and synced 303.
//
// WO-14/G4 (085): `api_calls` is now `sweep_api_calls`.
//
// The old name read as "LP calls made for THIS entity" and it never was. One
// paging loop serves several entity rows, so runLeadsSweep wrote its single
// counter onto all four of leads/calls/notes/activities — which is why they
// reported an identical 101/101/101/101 and then 84/84/84/84. The number was
// right; the name claimed a precision it did not have.
//
// Named `sweep_api_calls`, not `run_api_calls`: the counter is scoped to ONE
// SWEEP, not one run. An incremental run makes two independent paging loops —
// runLeadsSweep (getLeadData) and runJobChangesSweep (getJobStatusChanges) —
// each with its own counter, landing on different rows. `run_` would have
// re-made the same mistake one level up. To get a run total, sum the distinct
// values across the run's rows; do not average them.
export async function syncLogTelemetry(logId, { apiCalls, pagingMode, rowsScanned } = {}) {
  if (!logId) return;
  try {
    const patch = {};
    if (Number.isFinite(apiCalls)) patch.sweep_api_calls = apiCalls;
    if (pagingMode) patch.paging_mode = pagingMode;
    if (Number.isFinite(rowsScanned)) patch.rows_scanned = rowsScanned;
    if (Object.keys(patch).length === 0) return;
    await supabase.from('lp_sync_log').update(patch).eq('id', logId);
  } catch (_) {
    // Telemetry must never break a sync.
  }
}
