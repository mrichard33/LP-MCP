// ─── GHL Field Sync — src/ghl-field-sync.js ──────────────────────
//
// Syncs LP lead data to GHL contact custom fields with change detection.
// Only pushes updates to GHL when field values actually change,
// avoiding redundant API calls across 194K+ leads.
//
// Flow:
//   1. Build field payload from LP lead data (via field map config)
//   2. Compute hash of payload
//   3. Compare against stored hash in lp_leads.ghl_fields_hash
//   4. If different → push to GHL via updateGHLContactFields()
//   5. Store new hash on success
//
// Called from: processProspect() in sync-engine.js (incremental sync)
//             syncAllChildRecords() (full sync Pass 2)
//             GHL backfill phase

import supabase from './supabase.js';
import { updateGHLContactFields } from './ghl.js';
import { buildGHLFieldPayload, computeFieldHash, getConfiguredFieldCount } from './ghl-field-map.js';

// Track stats per sync cycle
let fieldSyncStats = { checked: 0, pushed: 0, skipped: 0, failed: 0 };

/**
 * Sync LP lead fields to the matched GHL contact.
 * Only calls GHL API if field values have changed since last sync.
 *
 * @param {Object} lead - Row from lp_leads table (must include all mapped fields)
 * @param {string} ghlContactId - The matched GHL contact ID
 * @param {string|null} storedHash - The ghl_fields_hash from the lead row (null if never synced)
 * @returns {Object} { pushed: boolean, hash: string }
 */
export async function syncLeadFieldsToGHL(lead, ghlContactId, storedHash) {
  if (!ghlContactId || !lead) {
    return { pushed: false, hash: storedHash };
  }

  fieldSyncStats.checked++;

  // 1. Build the field payload
  const fields = buildGHLFieldPayload(lead);
  if (fields.length === 0) {
    fieldSyncStats.skipped++;
    return { pushed: false, hash: storedHash };
  }

  // 2. Compute hash and compare
  const newHash = computeFieldHash(fields);
  if (newHash === storedHash) {
    fieldSyncStats.skipped++;
    return { pushed: false, hash: storedHash };
  }

  // 3. Push to GHL
  const success = await updateGHLContactFields(ghlContactId, fields);

  if (success) {
    fieldSyncStats.pushed++;

    // 4. Store new hash
    try {
      await supabase.from('lp_leads')
        .update({ ghl_fields_hash: newHash })
        .eq('lp_lead_id', lead.lp_lead_id);
    } catch (err) {
      console.warn(`[FieldSync] Hash update failed for ${lead.lp_lead_id}:`, err.message);
    }

    return { pushed: true, hash: newHash };
  } else {
    fieldSyncStats.failed++;
    return { pushed: false, hash: storedHash };
  }
}

/**
 * Bulk field sync for leads that have GHL matches but stale/missing field data.
 * Called after GHL backfill completes during full sync.
 * Processes in batches to respect GHL rate limits.
 *
 * @param {number} batchSize - Number of leads to process per batch (default 100)
 * @param {number} delayMs - Delay between GHL API calls in ms (default 200)
 * @returns {Object} { total, pushed, skipped, failed }
 */
export async function bulkFieldSync(batchSize = 100, delayMs = 200) {
  const { configured } = getConfiguredFieldCount();
  if (configured === 0) {
    console.log('[FieldSync] No GHL fields configured — skipping bulk sync');
    return { total: 0, pushed: 0, skipped: 0, failed: 0 };
  }

  console.log(`[FieldSync] Starting bulk field sync (${configured} fields configured)...`);
  const stats = { total: 0, pushed: 0, skipped: 0, failed: 0 };

  let offset = 0;
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  while (true) {
    // Fetch leads that have GHL matches
    const { data: leads, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, ghl_contact_id, ghl_fields_hash, disposition_code, disposition_label, rep_name, appointment_set, appointment_date, demo_completed, closed_won, job_value, lead_source, lead_source_detail, call_count, last_contact_date, promoter_name')
      .not('ghl_contact_id', 'is', null)
      .range(offset, offset + batchSize - 1)
      .order('updated_at_lp', { ascending: false });

    if (error) {
      console.error('[FieldSync] Query failed:', error.message);
      break;
    }
    if (!leads || leads.length === 0) break;

    for (const lead of leads) {
      stats.total++;
      const result = await syncLeadFieldsToGHL(lead, lead.ghl_contact_id, lead.ghl_fields_hash);
      if (result.pushed) {
        stats.pushed++;
      } else {
        stats.skipped++;
      }
      // Rate limit buffer between GHL calls
      if (result.pushed) await sleep(delayMs);
    }

    if (leads.length < batchSize) break;
    offset += batchSize;

    // Log progress every 1000 leads
    if (stats.total % 1000 === 0) {
      console.log(`[FieldSync] Progress: ${stats.total} checked, ${stats.pushed} pushed, ${stats.skipped} skipped`);
    }
  }

  console.log(`[FieldSync] Bulk sync complete: ${stats.total} checked, ${stats.pushed} pushed, ${stats.skipped} unchanged, ${stats.failed} failed`);
  return stats;
}

/**
 * Get and reset cycle stats.
 * Called at end of each sync cycle for logging.
 */
export function getFieldSyncStats() {
  const stats = { ...fieldSyncStats };
  fieldSyncStats = { checked: 0, pushed: 0, skipped: 0, failed: 0 };
  return stats;
}

/**
 * Log field sync configuration status on startup.
 */
export function logFieldSyncConfig() {
  const { total, configured } = getConfiguredFieldCount();
  if (configured === 0) {
    console.log(`[FieldSync] WARNING: 0/${total} GHL fields configured — field writeback is DISABLED`);
    console.log('[FieldSync] Edit src/ghl-field-map.js and replace FILL_IN_GHL_FIELD_ID with actual GHL custom field IDs');
  } else if (configured < total) {
    console.log(`[FieldSync] ${configured}/${total} GHL fields configured — partial writeback active`);
  } else {
    console.log(`[FieldSync] ${configured}/${total} GHL fields configured — full writeback active`);
  }
}
