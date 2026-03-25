// ─── Sync Logging — src/sync-log.js ───────────────────────────────
//
// Sync log management for lp_sync_log table.
// Tracks per-entity sync progress, completion, and failures.
// activeLogIds scopes SIGTERM cleanup to THIS process's rows only.

import supabase from './supabase.js';

export const ENTITY_TYPES = ['leads', 'calls', 'notes', 'jobs', 'milestones', 'activities', 'dispositions', 'sources', 'ghl_backfill'];

// Track sync log IDs owned by THIS process — scopes SIGTERM cleanup
export const activeLogIds = new Set();

// Mutex state — shared across fullSync/incrementalSync
export let syncInProgress = false;
export let syncStartedAt = null;
export const STALE_LOCK_MINUTES = 120; // 2 hours max before force-reset

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

// Update records_synced count (call after each page/batch for live progress)
export async function syncLogProgress(logId, count) {
  if (!logId) return;
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

export async function getLastSyncTimestamp() {
  try {
    const { data } = await supabase
      .from('lp_sync_log')
      .select('completed_at')
      .eq('entity_type', 'leads')
      .eq('status', 'completed')
      .gt('records_synced', 0)
      .not('completed_at', 'is', null)
      .order('completed_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.completed_at ? new Date(data.completed_at) : null;
  } catch (err) {
    console.error('[Sync] Failed to read sync log:', err.message);
    return null;
  }
}

// Mark this process's own running sync logs as failed on termination.
// Scoped to activeLogIds to prevent poisoning a newly-booted process's rows.
export async function markRunningLogsAsFailed() {
  try {
    const ids = [...activeLogIds];
    if (ids.length === 0) {
      console.log('[Sync] No active sync log IDs to clean up');
      return;
    }
    await supabase.from('lp_sync_log')
      .update({
        status: 'failed',
        error_message: 'Process terminated',
        completed_at: new Date().toISOString(),
      })
      .in('id', ids);
    console.log(`[Sync] Marked ${ids.length} owned sync log rows as failed (process terminating)`);
  } catch (_) {
    // Best-effort — process is shutting down
  }
}
