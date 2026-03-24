// ─── GHL Field Sync — src/ghl-field-sync.js ──────────────────────
//
// v3 — March 24, 2026
// Syncs LP lead data to GHL contact custom fields with change detection.
//
// MERGED LEAD APPROACH: When a prospect has multiple LP leads (e.g., 7
// leads over several years), we build a MERGED object per GHL contact:
//   - Status fields (disposition, rep, promoter, source) → from NEWEST lead
//   - Appointment fields → from the lead with the most recent appointment
//   - "Ever" fields (demo completed, closed won) → true if ANY lead has flag
//   - Value fields (job value) → MAX across all leads
//   - Count fields (total appointments) → COUNT across all leads
//   - Engagement (call count, last contact) → shared at prospect level
//
// When the newest lead has null for a field (e.g., rep_name), we send an
// empty string to GHL to CLEAR the old stale value — not skip it.

import supabase from './supabase.js';
import { updateGHLContactFields } from './ghl.js';
import { buildGHLFieldPayload, computeFieldHash, getConfiguredFieldCount } from './ghl-field-map.js';

// Track stats per sync cycle
let fieldSyncStats = { checked: 0, pushed: 0, skipped: 0, failed: 0 };

/**
 * Build a merged lead object from ALL leads for a single GHL contact.
 * Combines current-status fields from the newest lead with aggregated
 * "ever" fields across all leads.
 *
 * @param {Array} leads - All lp_leads rows for one GHL contact
 * @returns {Object} Merged lead object compatible with field map transforms
 */
function buildMergedLead(leads) {
  if (!leads || leads.length === 0) return null;

  // Sort by updated_at_lp DESC — newest first
  const sorted = [...leads].sort((a, b) =>
    new Date(b.updated_at_lp || 0) - new Date(a.updated_at_lp || 0)
  );
  const newest = sorted[0];

  // Find the lead with the most recent appointment date (where appt was set)
  const withAppt = sorted.filter(l => l.appointment_set && l.appointment_date);
  const latestAppt = withAppt.length > 0
    ? withAppt.sort((a, b) => new Date(b.appointment_date) - new Date(a.appointment_date))[0]
    : null;

  // Aggregate "ever" flags across ALL leads
  const everDemoCompleted = sorted.some(l => l.demo_completed === true);
  const everClosedWon = sorted.some(l => l.closed_won === true);

  // MAX job value across all leads
  const jobValues = sorted.map(l => parseFloat(l.job_value) || 0).filter(v => v > 0);
  const maxJobValue = jobValues.length > 0 ? Math.max(...jobValues) : null;

  // COUNT of leads with appointments set
  const totalAppointments = sorted.filter(l => l.appointment_set).length;

  return {
    // Identity — from newest lead
    lp_lead_id: newest.lp_lead_id,
    lp_prospect_id: newest.lp_prospect_id,
    ghl_contact_id: newest.ghl_contact_id,
    ghl_fields_hash: newest.ghl_fields_hash,

    // Current status — from newest lead (may be null — that's intentional)
    disposition_code: newest.disposition_code || '',
    disposition_label: newest.disposition_label || '',
    rep_name: newest.rep_name || '',
    promoter_name: newest.promoter_name || '',
    lead_source: newest.lead_source || '',
    lead_source_detail: newest.lead_source_detail || '',

    // Appointment — from the lead with the most recent appointment
    appointment_date: latestAppt?.appointment_date || null,
    appointment_set: totalAppointments > 0,

    // "Ever" aggregates — across ALL leads
    demo_completed: everDemoCompleted,
    closed_won: everClosedWon,

    // Value — MAX across all leads
    job_value: maxJobValue,

    // Count of appointments
    _total_appointments: totalAppointments,

    // Engagement — prospect-level, same on all leads
    call_count: newest.call_count,
    last_contact_date: newest.last_contact_date,
  };
}

/**
 * Sync merged lead fields to the matched GHL contact.
 * Only calls GHL API if field values have changed since last sync.
 */
export async function syncLeadFieldsToGHL(lead, ghlContactId, storedHash) {
  if (!ghlContactId || !lead) {
    return { pushed: false, hash: storedHash };
  }

  fieldSyncStats.checked++;

  // Build the field payload
  const fields = buildGHLFieldPayload(lead);
  if (fields.length === 0) {
    fieldSyncStats.skipped++;
    return { pushed: false, hash: storedHash };
  }

  // Compute hash and compare
  const newHash = computeFieldHash(fields);
  if (newHash === storedHash) {
    fieldSyncStats.skipped++;
    return { pushed: false, hash: storedHash };
  }

  // Push to GHL
  const success = await updateGHLContactFields(ghlContactId, fields);

  if (success) {
    fieldSyncStats.pushed++;

    // Store new hash on the NEWEST lead row for this contact
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
 * Bulk field sync — queries ALL leads per GHL contact and merges them.
 *
 * @param {number} batchSize - Not used but kept for API compat
 * @param {number} delayMs - Delay between GHL API calls in ms (default 200)
 * @returns {Object} { total, pushed, skipped, failed }
 */
export async function bulkFieldSync(batchSize = 100, delayMs = 200) {
  const { configured } = getConfiguredFieldCount();
  if (configured === 0) {
    console.log('[FieldSync] No GHL fields configured — skipping bulk sync');
    return { total: 0, pushed: 0, skipped: 0, failed: 0 };
  }

  const stats = { total: 0, pushed: 0, skipped: 0, failed: 0 };
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    // Get ALL leads with GHL matches (not just newest — we need all for aggregation)
    const { data: allLeads, error } = await supabase
      .from('lp_leads')
      .select('lp_lead_id, lp_prospect_id, ghl_contact_id, ghl_fields_hash, disposition_code, disposition_label, rep_name, promoter_name, appointment_set, appointment_date, demo_completed, closed_won, job_value, lead_source, lead_source_detail, call_count, last_contact_date, updated_at_lp')
      .not('ghl_contact_id', 'is', null)
      .order('updated_at_lp', { ascending: false });

    if (error || !allLeads) {
      console.error('[FieldSync] Query failed:', error?.message || 'no data');
      return stats;
    }

    // Group leads by GHL contact ID
    const byContact = new Map();
    for (const lead of allLeads) {
      if (!byContact.has(lead.ghl_contact_id)) {
        byContact.set(lead.ghl_contact_id, []);
      }
      byContact.get(lead.ghl_contact_id).push(lead);
    }

    console.log(`[FieldSync] ${allLeads.length} GHL-matched leads → ${byContact.size} unique contacts`);

    // Process each contact with merged data
    for (const [ghlContactId, leads] of byContact) {
      stats.total++;

      const merged = buildMergedLead(leads);
      if (!merged) continue;

      const result = await syncLeadFieldsToGHL(merged, ghlContactId, merged.ghl_fields_hash);
      if (result.pushed) {
        stats.pushed++;
        await sleep(delayMs);
      } else {
        stats.skipped++;
      }
    }
  } catch (err) {
    console.error('[FieldSync] Bulk sync error:', err.message);
    stats.failed++;
  }

  if (stats.pushed > 0 || stats.failed > 0) {
    console.log(`[FieldSync] Bulk sync: ${stats.total} contacts, ${stats.pushed} pushed, ${stats.skipped} unchanged, ${stats.failed} failed`);
  }
  return stats;
}

/**
 * Get and reset cycle stats.
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
  } else if (configured < total) {
    console.log(`[FieldSync] ${configured}/${total} GHL fields configured — partial writeback active`);
  } else {
    console.log(`[FieldSync] ${configured}/${total} GHL fields configured — full writeback active`);
  }
}
