// ─── GHL Field Sync — src/ghl-field-sync.js ──────────────────────
//
// v4 — April 5, 2026
// Syncs LP lead data to GHL contact custom fields with change detection.
//
// v4 CHANGES:
// - Handles 'not_found' return from updateGHLContactFields (deleted GHL contacts)
// - Auto-clears stale ghl_contact_id from ALL lp_leads rows for deleted contacts
// - Tracks cleared contacts in stats for observability
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
let fieldSyncStats = { checked: 0, pushed: 0, skipped: 0, failed: 0, cleared: 0 };

/**
 * Build a merged lead object from ALL leads for a single GHL contact.
 * Combines current-status fields from the newest lead with aggregated
 * "ever" fields across all leads.
 *
 * @param {Array} leads - All lp_leads rows for one GHL contact
 * @returns {Object} Merged lead object compatible with field map transforms
 */
export function buildMergedLead(leads) {
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

    // All lead IDs for this contact (needed for stale ID cleanup)
    _all_lead_ids: sorted.map(l => l.lp_lead_id),
  };
}

/**
 * Clear stale ghl_contact_id from ALL lp_leads rows for a deleted GHL contact.
 * Called when GHL returns 400 "Contact not found" during field sync.
 */
async function clearStaleGHLContact(ghlContactId, leadIds) {
  try {
    const { data } = await supabase.from('lp_leads')
      .update({ ghl_contact_id: null, ghl_tag_applied: false, ghl_fields_hash: null })
      .eq('ghl_contact_id', ghlContactId)
      .select('lp_lead_id');
    const cleared = data?.length || 0;
    console.warn(`[FieldSync] Cleared stale GHL ID ${ghlContactId} from ${cleared} lp_leads rows (contact deleted from GHL)`);

    // Also clear from lp_prospects
    await supabase.from('lp_prospects')
      .update({ ghl_contact_id: null, ghl_tag_applied: false })
      .eq('ghl_contact_id', ghlContactId);

    return cleared;
  } catch (err) {
    console.error(`[FieldSync] Failed to clear stale GHL ID ${ghlContactId}:`, err.message);
    return 0;
  }
}

/**
 * Sync merged lead fields to the matched GHL contact.
 * Only calls GHL API if field values have changed since last sync.
 *
 * v4: Handles 'not_found' return — clears stale ghl_contact_id automatically.
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
  const result = await updateGHLContactFields(ghlContactId, fields);

  if (result === true) {
    fieldSyncStats.pushed++;

    // Store new hash on ALL lp_leads rows for this contact — not just the
    // newest. The change-detection hash is logically a CONTACT-level value
    // (the merged payload covers all of a contact's leads), so writing it to
    // every row keeps it consistent regardless of which lead is "newest". This
    // removes the stranded-hash fragility: when a newly-synced lead becomes the
    // newest, it inherits the contact's current hash instead of a NULL that
    // forces a redundant push — and a legitimate re-push can't be falsely
    // skipped by a stale per-lead hash left on an older row.
    try {
      await supabase.from('lp_leads')
        .update({ ghl_fields_hash: newHash })
        .eq('ghl_contact_id', ghlContactId);
    } catch (err) {
      console.warn(`[FieldSync] Hash update failed for contact ${ghlContactId}:`, err.message);
    }

    return { pushed: true, hash: newHash };
  } else if (result === 'not_found') {
    // ─── v4: GHL contact was deleted — clean up stale references ──
    fieldSyncStats.cleared++;
    await clearStaleGHLContact(ghlContactId, lead._all_lead_ids || []);
    return { pushed: false, hash: storedHash, cleared: true };
  } else {
    fieldSyncStats.failed++;
    return { pushed: false, hash: storedHash };
  }
}

// Per-cycle cap on the number of GHL pushes. Without this, a population-wide
// catch-up (e.g. after the pagination fix exposed thousands of never-synced
// contacts) would push every changed contact in a single cycle, tripping
// disposition-keyed agent rules and saturating the shared GHL rate limiter
// (the 2026-06 token-starvation storm). Unchanged contacts still hash-skip for
// free; only actual pushes count against the cap, so the backlog drains
// gradually over successive cycles. Env-tunable; safe default below.
const DEFAULT_MAX_PUSHES_PER_CYCLE = Math.max(
  1,
  parseInt(process.env.FIELD_SYNC_MAX_PUSHES_PER_CYCLE || '150', 10)
);

// Supabase caps un-ranged selects at 1000 rows (default max_rows). With >5k
// GHL-matched leads, an un-paginated query silently processed only the 1000
// most-recently-updated leads, leaving older contacts permanently stale and
// producing wrong merges for contacts only partially inside the window.
const LEAD_PAGE_SIZE = 1000;

/**
 * Bulk field sync — queries ALL leads per GHL contact and merges them.
 *
 * @param {number} batchSize - Not used but kept for API compat
 * @param {number} delayMs - Delay between GHL API calls in ms (default 200)
 * @param {number} maxPushesPerCycle - Cap on GHL pushes this cycle (env-tunable)
 * @returns {Object} { total, pushed, skipped, failed, cleared }
 */
export async function bulkFieldSync(batchSize = 100, delayMs = 200, maxPushesPerCycle = DEFAULT_MAX_PUSHES_PER_CYCLE) {
  const { configured } = getConfiguredFieldCount();
  if (configured === 0) {
    console.log('[FieldSync] No GHL fields configured — skipping bulk sync');
    return { total: 0, pushed: 0, skipped: 0, failed: 0, cleared: 0 };
  }

  const stats = { total: 0, pushed: 0, skipped: 0, failed: 0, cleared: 0, deferred: 0 };
  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    // Get ALL leads with GHL matches (not just newest — we need all for
    // aggregation). Paginate via .range() so we are not silently capped at
    // Supabase's 1000-row default — otherwise contacts whose leads fall
    // outside the 1000 most-recently-updated are never synced.
    const allLeads = [];
    let offset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('lp_leads')
        .select('lp_lead_id, lp_prospect_id, ghl_contact_id, ghl_fields_hash, disposition_code, disposition_label, rep_name, promoter_name, appointment_set, appointment_date, demo_completed, closed_won, job_value, lead_source, lead_source_detail, call_count, last_contact_date, updated_at_lp')
        .not('ghl_contact_id', 'is', null)
        .order('updated_at_lp', { ascending: false })
        .range(offset, offset + LEAD_PAGE_SIZE - 1);

      if (error) {
        console.error('[FieldSync] Query failed:', error.message);
        return stats;
      }
      if (!data || data.length === 0) break;
      allLeads.push(...data);
      if (data.length < LEAD_PAGE_SIZE) break;
      offset += LEAD_PAGE_SIZE;
    }

    // Group leads by GHL contact ID
    const byContact = new Map();
    for (const lead of allLeads) {
      if (!byContact.has(lead.ghl_contact_id)) {
        byContact.set(lead.ghl_contact_id, []);
      }
      byContact.get(lead.ghl_contact_id).push(lead);
    }

    console.log(`[FieldSync] ${allLeads.length} GHL-matched leads → ${byContact.size} unique contacts (max ${maxPushesPerCycle} pushes/cycle)`);

    // Process each contact with merged data. We iterate EVERY contact so the
    // cheap hash-skip runs for all of them; once we've issued maxPushesPerCycle
    // actual pushes we stop pushing (defer the rest to the next cycle) rather
    // than breaking, so the stale backlog — not just recently-updated contacts —
    // gets a fair turn each cycle.
    for (const [ghlContactId, leads] of byContact) {
      stats.total++;

      const merged = buildMergedLead(leads);
      if (!merged) continue;

      // Push budget exhausted — leave this contact's hash untouched so it is
      // re-evaluated and pushed on a later cycle.
      if (stats.pushed >= maxPushesPerCycle) {
        stats.deferred++;
        continue;
      }

      const result = await syncLeadFieldsToGHL(merged, ghlContactId, merged.ghl_fields_hash);
      if (result.pushed) {
        stats.pushed++;
        await sleep(delayMs);
      } else if (result.cleared) {
        stats.cleared++;
      } else {
        stats.skipped++;
      }
    }
  } catch (err) {
    console.error('[FieldSync] Bulk sync error:', err.message);
    stats.failed++;
  }

  if (stats.pushed > 0 || stats.failed > 0 || stats.cleared > 0 || stats.deferred > 0) {
    console.log(`[FieldSync] Bulk sync: ${stats.total} contacts, ${stats.pushed} pushed, ${stats.skipped} unchanged, ${stats.failed} failed, ${stats.cleared} stale IDs cleared, ${stats.deferred} deferred (push cap)`);
  }
  return stats;
}

/**
 * Get and reset cycle stats.
 */
export function getFieldSyncStats() {
  const stats = { ...fieldSyncStats };
  fieldSyncStats = { checked: 0, pushed: 0, skipped: 0, failed: 0, cleared: 0 };
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
