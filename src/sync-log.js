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
export async function syncLogComplete(logId, count, errorMessage) {
  if (!logId) return;
  activeLogIds.delete(logId);
  lastProgressWrite.delete(logId); // v6.4: clear throttle state for this logId
  try {
    await supabase.from('lp_sync_log').update({
      status:         errorMessage ? 'failed' : 'completed',
      records_synced: count,
      error_message:  errorMessage || null,
      completed_at:   new Date().toISOString(),
    }).eq('id', logId).eq('status', 'running'); // Only update if still running
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

    // First try: completed syncs with records (the ideal case)
    const { data: completed } = await supabase
      .from('lp_sync_log')
      .select('completed_at')
      .eq('entity_type', 'leads')
      .eq('status', 'completed')
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

    const completedTs = completed?.completed_at ? new Date(completed.completed_at) : null;
    const failedTs = partialFailed?.started_at ? new Date(partialFailed.started_at) : null;

    // Use whichever is more recent
    let bestTs = null;
    if (completedTs && failedTs) {
      bestTs = completedTs > failedTs ? completedTs : failedTs;
    } else {
      bestTs = completedTs || failedTs;
    }

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
export async function syncLogTelemetry(logId, { apiCalls, pagingMode } = {}) {
  if (!logId) return;
  try {
    const patch = {};
    if (Number.isFinite(apiCalls)) patch.api_calls = apiCalls;
    if (pagingMode) patch.paging_mode = pagingMode;
    if (Object.keys(patch).length === 0) return;
    await supabase.from('lp_sync_log').update(patch).eq('id', logId);
  } catch (_) {
    // Telemetry must never break a sync.
  }
}
