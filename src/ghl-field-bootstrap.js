// ─── GHL Sync Bootstrap — src/ghl-field-bootstrap.js ──────────────
//
// Wires the GHL field sync AND notes sync into the sync engine.
// Called from index.js on server boot.
//
// v2 — March 24, 2026
// Added notes sync: pushes LP notes to GHL contact records.
//
// What this does:
// 1. Logs field sync config on startup
// 2. Runs bulk field sync (newest lead per contact only)
// 3. Runs notes sync (pushes unpushed LP notes to GHL)

import supabase from './supabase.js';
import { syncLeadFieldsToGHL, bulkFieldSync, getFieldSyncStats, logFieldSyncConfig } from './ghl-field-sync.js';
import { pushNotesToGHL, countUnpushedNotes } from './ghl-notes-sync.js';

let initialized = false;

/**
 * Initialize the GHL sync system.
 * Call once from index.js after the server boots.
 */
export function initFieldSync() {
  if (initialized) return;
  initialized = true;
  logFieldSyncConfig();
  console.log('[GHLSync] Bootstrap initialized — field writeback + notes sync active');
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
    console.warn(`[FieldSync] Failed for lead ${lpLeadId}: ${err.message}`);
  }
}

/**
 * Run bulk field sync (newest lead per contact) + notes sync.
 * This is the main periodic function called from the scheduler in index.js.
 */
export async function runBulkFieldSync() {
  // 1. Field sync — push LP custom field data to GHL contacts
  try {
    const fieldStats = await bulkFieldSync(100, 200);
    if (fieldStats.pushed > 0 || fieldStats.failed > 0 || fieldStats.deferred > 0) {
      const deferredNote = fieldStats.deferred > 0 ? `, ${fieldStats.deferred} deferred (push cap)` : '';
      console.log(`[FieldSync] Bulk: ${fieldStats.pushed} updated, ${fieldStats.skipped} unchanged, ${fieldStats.failed} failed${deferredNote}`);
    }
  } catch (err) {
    console.warn('[FieldSync] Bulk sync failed:', err.message);
  }

  // 2. Notes sync — push LP notes to GHL contact records
  try {
    const unpushed = await countUnpushedNotes();
    if (unpushed > 0) {
      console.log(`[NoteSync] ${unpushed} notes pending push to GHL`);
      const noteStats = await pushNotesToGHL({ batchSize: 50, delayMs: 300, maxNotes: 200 });
      if (noteStats.pushed > 0 || noteStats.failed > 0) {
        console.log(`[NoteSync] Cycle: ${noteStats.pushed} pushed, ${noteStats.failed} failed`);
      }
    }
  } catch (err) {
    // Notes sync failure is non-fatal — field sync still works
    console.warn('[NoteSync] Notes sync failed:', err.message);
    if (err.message && err.message.includes('ghl_note_pushed')) {
      console.warn('[NoteSync] Migration needed — run sql/005_add_ghl_note_pushed.sql in Supabase');
    }
  }
}

/**
 * Log field sync stats for the current cycle.
 */
export function logCycleStats() {
  const stats = getFieldSyncStats();
  if (stats.pushed > 0 || stats.failed > 0) {
    console.log(`[FieldSync] Cycle: ${stats.pushed} pushed, ${stats.skipped} unchanged, ${stats.failed} failed`);
  }
}
