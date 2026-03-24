// ─── GHL Field Sync — src/ghl-field-sync.js ──────────────────────
//
// v2 — March 24, 2026
// Syncs LP lead data to GHL contact custom fields with change detection.
// Only pushes updates to GHL when field values actually change.
//
// CRITICAL FIX: When a prospect has multiple leads in LP (e.g., 7 leads
// for the same person over years), we ONLY sync the NEWEST lead per GHL
// contact. Previously all leads were processed sequentially, with older
// data overwriting newer data depending on processing order.
//
// Flow:
//   1. Query newest lead per GHL contact (DISTINCT ON ghl_contact_id)
//   2. Build field payload from that lead (via field map config)
//   3. Compute hash of payload
//   4. Compare against stored hash in lp_leads.ghl_fields_hash
//   5. If different → push to GHL via updateGHLContactFields()
//   6. Store new hash on success

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
 * SQL query that selects ONLY the newest lead per GHL contact.
 * Uses DISTINCT ON to deduplicate — one row per ghl_contact_id,
 * ordered by updated_at_lp DESC so the most recent lead wins.
 *
 * This prevents older leads from overwriting newer data when a
 * prospect has multiple leads in LP.
 */
const NEWEST_LEAD_PER_CONTACT_QUERY = `
  SELECT DISTINCT ON (ghl_contact_id)
    lp_lead_id, lp_prospect_id, ghl_contact_id, ghl_fields_hash,
    disposition_code, disposition_label, rep_name, promoter_name,
    appointment_set, appointment_date,
    demo_completed, closed_won, job_value,
    lead_source, lead_source_detail,
    call_count, last_contact_date,
    updated_at_lp
  FROM lp_leads
  WHERE ghl_contact_id IS NOT NULL
  ORDER BY ghl_contact_id, updated_at_lp DESC NULLS LAST
`;

/**
 * Bulk field sync for leads that have GHL matches.
 * CRITICAL: Only processes the NEWEST lead per GHL contact.
 *
 * @param {number} batchSize - Not used for SQL approach but kept for API compat
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

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    // Get only the newest lead per GHL contact
    const { data: leads, error } = await supabase.rpc('exec_sql', {
      query: NEWEST_LEAD_PER_CONTACT_QUERY,
    });

    // Fallback: if RPC not available, use standard query with JS dedup
    let leadsToProcess = leads;
    if (error || !leads) {
      console.log('[FieldSync] RPC not available, falling back to JS dedup...');
      const { data: allLeads, error: fallbackErr } = await supabase
        .from('lp_leads')
        .select('lp_lead_id, lp_prospect_id, ghl_contact_id, ghl_fields_hash, disposition_code, disposition_label, rep_name, promoter_name, appointment_set, appointment_date, demo_completed, closed_won, job_value, lead_source, lead_source_detail, call_count, last_contact_date, updated_at_lp')
        .not('ghl_contact_id', 'is', null)
        .order('updated_at_lp', { ascending: false });

      if (fallbackErr || !allLeads) {
        console.error('[FieldSync] Query failed:', fallbackErr?.message || 'no data');
        return stats;
      }

      // JS dedup: keep only the first (newest) lead per ghl_contact_id
      const seen = new Set();
      leadsToProcess = allLeads.filter(lead => {
        if (seen.has(lead.ghl_contact_id)) return false;
        seen.add(lead.ghl_contact_id);
        return true;
      });

      console.log(`[FieldSync] ${allLeads.length} total GHL-matched leads → ${leadsToProcess.length} unique contacts (newest lead per contact)`);
    }

    if (!leadsToProcess || leadsToProcess.length === 0) {
      console.log('[FieldSync] No GHL-matched leads to sync');
      return stats;
    }

    for (const lead of leadsToProcess) {
      stats.total++;
      const result = await syncLeadFieldsToGHL(lead, lead.ghl_contact_id, lead.ghl_fields_hash);
      if (result.pushed) {
        stats.pushed++;
        await sleep(delayMs); // Rate limit only when we actually called GHL
      } else {
        stats.skipped++;
      }
    }
  } catch (err) {
    console.error('[FieldSync] Bulk sync error:', err.message);
    stats.failed++;
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
