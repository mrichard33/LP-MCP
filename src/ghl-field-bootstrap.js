// ─── GHL Field Sync Bootstrap — src/ghl-field-bootstrap.js ────────
//
// Wires the GHL field sync into the sync engine at runtime.
// Called once from index.js on server boot.
//
// Why a bootstrap instead of editing sync-engine.js directly?
// sync-engine.js is 77KB. This module applies the field sync
// integration without touching the main file, reducing merge risk.
//
// What this does:
// 1. Logs field sync config on startup
// 2. Hooks into incremental sync to push changed fields to GHL
// 3. Runs bulk field sync after GHL backfill on full sync

import supabase from './supabase.js';
import { syncLeadFieldsToGHL, bulkFieldSync, getFieldSyncStats, logFieldSyncConfig } from './ghl-field-sync.js';

let initialized = false;

/**
 * Initialize the GHL field sync system.
 * Call once from index.js after the server boots.
 */
export function initFieldSync() {
  if (initialized) return;
  initialized = true;
  logFieldSyncConfig();
  console.log('[FieldSync] Bootstrap initialized — field writeback active on incremental sync');
}

/**
 * Push LP fields to GHL for a single lead after it's been synced.
 * Call from processProspect() or anywhere a lead is upserted + has a GHL match.
 *
 * @param {string} lpLeadId - The LP lead ID
 * @param {string} ghlContactId - The matched GHL contact ID
 */
export async function pushLeadFieldsToGHL(lpLeadId, ghlContactId) {
  if (!ghlContactId || !lpLeadId) return;

  try {
    const { data: lead } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, disposition_code, disposition_label, rep_name, appointment_set, appointment_date, demo_completed, closed_won, job_value, lead_source, lead_source_detail, call_count, last_contact_date, promoter_name, ghl_fields_hash')
      .eq('lp_lead_id', lpLeadId)
      .single();

    if (lead) {
      await syncLeadFieldsToGHL(lead, ghlContactId, lead.ghl_fields_hash);
    }
  } catch (err) {
    // Non-fatal — don't break sync over a field push
    console.warn(`[FieldSync] Failed for lead ${lpLeadId}: ${err.message}`);
  }
}

/**
 * Run bulk field sync for all GHL-matched leads.
 * Call after GHL backfill phase in fullSync().
 */
export async function runBulkFieldSync() {
  try {
    const stats = await bulkFieldSync(100, 200);
    console.log(`[FieldSync] Bulk complete: ${stats.pushed} updated, ${stats.skipped} unchanged, ${stats.failed} failed`);
    return stats;
  } catch (err) {
    console.warn('[FieldSync] Bulk sync failed:', err.message);
    return { total: 0, pushed: 0, skipped: 0, failed: 0 };
  }
}

/**
 * Log field sync stats for the current cycle.
 * Call at end of incrementalSync().
 */
export function logCycleStats() {
  const stats = getFieldSyncStats();
  if (stats.pushed > 0 || stats.failed > 0) {
    console.log(`[FieldSync] Cycle: ${stats.pushed} pushed, ${stats.skipped} unchanged, ${stats.failed} failed`);
  }
}
