// ─── GHL Field Sync — src/ghl-field-sync.js ──────────────────────
//
// v5 — 2026-06-19
// Syncs LP lead data to GHL contact custom fields with change detection.
//
// v5 CHANGES:
// - After a successful push, emit lp.disposition_changed when the
//   disposition_code has changed. Closes the Bug 1 gap where LP sync
//   wrote CXL/CCC/BO to the GHL custom field but never fired an event,
//   leaving CXL leads stuck in S2.2 indoctrination indefinitely.
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
//   - Value fields (job value) → the CURRENT job's value (see below)
//   - Count fields (total appointments) → COUNT across all leads
//   - Engagement (call count, last contact) → shared at prospect level
//
// When the newest lead has null for a field (e.g., rep_name), we send an
// empty string to GHL to CLEAR the old stale value — not skip it.
//
// v5.1 — 2026-08-31 — "LP Gross Sale Amount" is ONE job's value
// ------------------------------------------------------------
// job_value used to be MAX across the contact's leads here, while
// src/n8n-enrichment.js wrote a SUM to the SAME GHL field
// (lp_gross_sale_amount / YWhoVixgPtvEDzSXcMpJ) — so the number a contact showed
// depended on which writer ran last. Both were wrong for the same reason the
// opportunity sum was: an opportunity tracks ONE job, and the GHL workflow
// "C.0-IN Sale Made Entry" reads this field as the stage-1 Client Lifecycle
// opportunity's monetary value. A repeat customer's field therefore inflated
// their pipeline by work that was already closed and paid.
//
// Both writers now mean the same thing: the value of the contact's most recent
// non-cancelled lp_jobs row, via latestJobValue() in src/lp-job-value.js — the
// same derivation the opportunity itself uses. Single-job contacts are
// unaffected (max, sum and latest agree on one job); the change is confined to
// the ~293 multi-job contacts.
//
// EXPECT A ONE-TIME PUSH WAVE. This changes the field payload for multi-job
// contacts, so their ghl_fields_hash no longer matches and they queue for a
// push in the first cycle after deploy. That is the correction landing, not a
// fault.

import supabase from './supabase.js';
import { updateGHLContactFields } from './ghl.js';
import { buildGHLFieldPayload, computeFieldHash, getConfiguredFieldCount } from './ghl-field-map.js';
import { latestJobValue } from './lp-job-value.js';
import { emitEvent, dispositionPriority } from './event-emitter.js';
import { sendGroupMeMessage } from './groupme.js';

// GHL custom field ID for the canonical LP disposition (URWTGtobi9a9Y7gwGxC8).
// Used to detect disposition changes from the field payload after a push so we
// can emit lp.disposition_changed without an extra Supabase round-trip.
const DISPOSITION_FIELD_ID = 'URWTGtobi9a9Y7gwGxC8';

// Track stats per sync cycle
let fieldSyncStats = { checked: 0, pushed: 0, skipped: 0, failed: 0, cleared: 0 };

/**
 * Build a merged lead object from ALL leads for a single GHL contact.
 * Combines current-status fields from the newest lead with aggregated
 * "ever" fields across all leads.
 *
 * @param {Array} leads - All lp_leads rows for one GHL contact
 * @param {Array} [jobs] - All lp_jobs rows for the same contact, when available
 * @returns {Object} Merged lead object compatible with field map transforms
 */
export function buildMergedLead(leads, jobs = null) {
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

  // The CURRENT job's value — not a max, not a sum. See the v5.1 note above.
  //
  // lp_jobs is the right grain and is preferred whenever we have it. The lead
  // fallback exists for contacts with no linked job row at all, and mirrors the
  // same rule at lead grain: the most recent lead that actually carries a value,
  // rather than the largest one the contact ever had.
  const jobValueFromJobs = Array.isArray(jobs) && jobs.length > 0 ? latestJobValue(jobs) : null;
  const newestValuedLead = sorted.find(l => (parseFloat(l.job_value) || 0) > 0) || null;
  const currentJobValue = jobValueFromJobs !== null
    ? jobValueFromJobs
    : (newestValuedLead ? parseFloat(newestValuedLead.job_value) : null);

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
    job_value: currentJobValue,

    // Count of appointments
    _total_appointments: totalAppointments,

    // Engagement — prospect-level, same on all leads
    call_count: newest.call_count,
    last_contact_date: newest.last_contact_date,

    // All lead IDs for this contact (needed for stale ID cleanup)
    _all_lead_ids: sorted.map(l => l.lp_lead_id),
  };
}

// ─── Mass-clear circuit breaker (2026-07-29) ─────────────────────
//
// clearStaleGHLContact NULLs the link on lp_leads AND lp_prospects. Until
// 2026-07-28 it only fired on 400 "Contact not found" — a genuinely deleted
// contact, which is rare and self-limiting.
//
// The widened classifier (sql/050 PR) also routes HTTP 403 "The token does not
// have access to this location" here. That is right for ONE orphan id, and
// catastrophic for a systemic cause: a wrong GHL_LOCATION_ID or a rotated
// token makes EVERY contact answer 403, and the bulk loop's only guard is on
// stats.pushed — cleared was never counted against maxPushesPerCycle. One
// cycle would have NULLed the entire link table. Trip the switch instead:
// clearing is capped per cycle, and hitting the cap is treated as evidence of
// a systemic fault rather than a very large number of dead contacts.
//
// Deleting a link is not recoverable without a rebuild, so this fails toward
// leaving stale links in place — the audit script (scripts/audit-orphan-ghl-links.js)
// exists to clean those deliberately, under approval.
const MAX_CLEARS_PER_CYCLE = parseInt(process.env.FIELD_SYNC_MAX_CLEARS_PER_CYCLE || '25', 10);
let _clearsThisCycle = 0;
let _clearBreakerTripped = false;

function resetClearBreaker() {
  _clearsThisCycle = 0;
  _clearBreakerTripped = false;
}

/**
 * Clear stale ghl_contact_id from ALL lp_leads rows for an unreachable GHL
 * contact — deleted (400/404) or outside this token's location (403).
 *
 * Returns -1 when the per-cycle breaker is open (nothing cleared).
 */
async function clearStaleGHLContact(ghlContactId, leadIds) {
  if (_clearBreakerTripped) return -1;
  if (_clearsThisCycle >= MAX_CLEARS_PER_CYCLE) {
    _clearBreakerTripped = true;
    console.error(
      `[FieldSync] MASS-CLEAR BREAKER TRIPPED — ${_clearsThisCycle} contacts reported unreachable in one cycle `
      + `(cap ${MAX_CLEARS_PER_CYCLE}). This looks systemic (bad GHL_LOCATION_ID / rotated token), not ${_clearsThisCycle} `
      + `dead contacts. No further links will be cleared this cycle. Verify GHL credentials, then run `
      + `scripts/audit-orphan-ghl-links.js to clear genuine orphans deliberately.`
    );
    sendGroupMeMessage(
      `⚠️ LP FieldSync mass-clear breaker tripped — ${_clearsThisCycle} GHL contacts unreachable in one cycle. `
      + `Link clearing halted. Check GHL_LOCATION_ID / token before anything else.`
    ).catch(() => {});
    return -1;
  }
  _clearsThisCycle++;

  try {
    const { data } = await supabase.from('lp_leads')
      .update({ ghl_contact_id: null, ghl_tag_applied: false, ghl_fields_hash: null, ghl_link_source: null })
      .eq('ghl_contact_id', ghlContactId)
      .select('lp_lead_id');
    const cleared = data?.length || 0;
    console.warn(`[FieldSync] Cleared stale GHL ID ${ghlContactId} from ${cleared} lp_leads rows (contact unreachable — deleted, or outside this token's location)`);

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
 * Extract the disposition code from a GHL field payload array.
 * Returns the value of DISPOSITION_FIELD_ID, or null if not present.
 *
 * @param {Array} fields - Array of { id, field_value } objects
 * @returns {string|null}
 */
function extractDispositionFromPayload(fields) {
  const field = fields.find(f => f.id === DISPOSITION_FIELD_ID);
  return field?.field_value || null;
}

/**
 * Emit lp.disposition_changed after a successful field push if the disposition
 * code has changed. Uses idempotency key scoped to contact + code so re-syncs
 * cannot double-fire.
 *
 * Called ONLY after updateGHLContactFields returns true (confirmed push).
 *
 * @param {string} ghlContactId
 * @param {string} newCode       - Disposition code being written
 * @param {string|null} oldCode  - Prior code (null for first sync)
 * @param {Object} lead          - Merged lead (for LP IDs)
 */
async function maybeEmitDispositionChanged(ghlContactId, newCode, oldCode, lead) {
  // Only fire when the code has actually changed (or first-time write from null)
  if (!newCode || newCode === oldCode) return;

  const priority = dispositionPriority(newCode);
  const idempotencyKey = `lp.disp.sync.${ghlContactId}.${newCode}`;

  try {
    await emitEvent({
      event_type: 'lp.disposition_changed',
      event_subtype: newCode,
      source: 'lp_sync',
      entity_type: 'contact',
      entity_id: ghlContactId,
      ghl_contact_id: ghlContactId,
      lp_lead_id: lead.lp_lead_id ? String(lead.lp_lead_id) : null,
      lp_prospect_id: lead.lp_prospect_id ? String(lead.lp_prospect_id) : null,
      payload: {
        disposition_code: newCode,
        previous_disposition_code: oldCode || null,
        source: 'field_sync',
      },
      previous_state: oldCode ? { disposition_code: oldCode } : null,
      new_state: { disposition_code: newCode },
      priority,
      idempotency_key: idempotencyKey,
      bypass_filter: false,
    });
    console.log(`[FieldSync] Emitted lp.disposition_changed:${newCode} for contact ${ghlContactId} (was: ${oldCode || 'null'})`);
  } catch (err) {
    // Non-fatal — field push already succeeded; log and continue
    console.warn(`[FieldSync] Failed to emit disposition change event for ${ghlContactId}:`, err.message);
  }
}

/**
 * Sync merged lead fields to the matched GHL contact.
 * Only calls GHL API if field values have changed since last sync.
 *
 * v4: Handles 'not_found' return — clears stale ghl_contact_id automatically.
 * v5: Emits lp.disposition_changed when disposition_code changes.
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

  // Capture the incoming disposition before the push (for change detection)
  const incomingDisposition = extractDispositionFromPayload(fields);

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

    // ── v5: Emit disposition change event if code changed ──────────
    // The merged lead's disposition_code is what was in the lp_leads cache
    // before this push. incomingDisposition is what we just wrote to GHL.
    // If they differ, emit the event so the Decision Engine can route correctly.
    // When storedHash === null this is the contact's first sync — treat prior
    // disposition as null so the event fires unconditionally for new codes.
    const priorDisposition = storedHash === null ? null : (lead.disposition_code || null);
    await maybeEmitDispositionChanged(ghlContactId, incomingDisposition, priorDisposition, lead);

    return { pushed: true, hash: newHash };
  } else if (result === 'not_found') {
    // ─── GHL contact unreachable — deleted (400/404), or outside this
    //     token's location (403). Clean up the stale reference, subject to
    //     the per-cycle mass-clear breaker above.
    const cleared = await clearStaleGHLContact(ghlContactId, lead._all_lead_ids || []);
    if (cleared === -1) {
      // Breaker open — treat as a failure, NOT a clear, so the row is retried
      // once credentials are fixed rather than counted as resolved.
      fieldSyncStats.failed++;
      return { pushed: false, hash: storedHash };
    }
    fieldSyncStats.cleared++;
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
  parseInt(process.env.FIELD_SYNC_MAX_PUSHES_PER_CYCLE || '500', 10)
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
  // Fresh budget each cycle — the breaker is a per-cycle blast radius limit,
  // not a permanent latch, so a genuine trickle of dead contacts still drains.
  resetClearBreaker();

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

    // Jobs for the same contacts, paginated the same way. Loaded in bulk rather
    // than per contact: this loop already runs over every GHL-matched contact,
    // and a per-contact lookup would turn one query into thousands. A read
    // failure here is NOT fatal — buildMergedLead falls back to lead-grain
    // values, so a sync cycle still completes with a slightly coarser number.
    const jobsByContact = new Map();
    let jobOffset = 0;
    while (true) {
      const { data, error } = await supabase
        .from('lp_jobs')
        .select('ghl_contact_id, lp_job_id, job_status, job_value')
        .not('ghl_contact_id', 'is', null)
        .order('lp_job_id', { ascending: false })
        .range(jobOffset, jobOffset + LEAD_PAGE_SIZE - 1);

      if (error) {
        console.warn(`[FieldSync] lp_jobs read failed (${error.message}) — falling back to lead-grain job values this cycle`);
        jobsByContact.clear();
        break;
      }
      if (!data || data.length === 0) break;
      for (const job of data) {
        if (!jobsByContact.has(job.ghl_contact_id)) jobsByContact.set(job.ghl_contact_id, []);
        jobsByContact.get(job.ghl_contact_id).push(job);
      }
      if (data.length < LEAD_PAGE_SIZE) break;
      jobOffset += LEAD_PAGE_SIZE;
    }

    console.log(`[FieldSync] ${allLeads.length} GHL-matched leads → ${byContact.size} unique contacts (max ${maxPushesPerCycle} pushes/cycle)`);

    // ── Phase 1: find the contacts that ACTUALLY need a push (no GHL calls) ──
    // Build the merged payload + hash for every contact and compare to the stored
    // hash. Unchanged contacts skip for free. Collecting the changed set up front
    // lets us PRIORITISE it instead of pushing in raw recency order — raw recency
    // order is what starved the oldest / never-synced contacts (dormant OPPFDN,
    // CXL, etc.) behind the per-cycle cap: newest churn consumed the budget every
    // cycle and the back never got a turn.
    const pending = [];
    for (const [ghlContactId, leads] of byContact) {
      stats.total++;
      const merged = buildMergedLead(leads, jobsByContact.get(ghlContactId) || null);
      if (!merged) continue;

      const fields = buildGHLFieldPayload(merged);
      if (fields.length === 0) { stats.skipped++; continue; }

      const newHash = computeFieldHash(fields);
      if (newHash === merged.ghl_fields_hash) { stats.skipped++; continue; } // unchanged — free skip

      // Newest lead recency for this contact (used for fair, oldest-first draining).
      const newestUpdate = leads.reduce((acc, l) => {
        const t = new Date(l.updated_at_lp || 0).getTime();
        return t > acc ? t : acc;
      }, 0);

      pending.push({
        ghlContactId,
        merged,
        neverSynced: merged.ghl_fields_hash == null,
        newestUpdate,
      });
    }

    // ── Phase 2: prioritise, then push up to the cap ──
    // 1) Never-synced first (true backfill: null hash — brand-new leads AND the
    //    multi-lead stranded set).
    // 2) Then OLDEST-updated first, so the long-tail backlog drains fairly instead
    //    of newest-always-wins. Guarantees dormant targets reach GHL in the first
    //    cycle(s) instead of being perpetually deferred.
    pending.sort((a, b) => {
      if (a.neverSynced !== b.neverSynced) return a.neverSynced ? -1 : 1;
      return a.newestUpdate - b.newestUpdate; // oldest first
    });

    for (const c of pending) {
      if (stats.pushed >= maxPushesPerCycle) { stats.deferred++; continue; }
      const result = await syncLeadFieldsToGHL(c.merged, c.ghlContactId, c.merged.ghl_fields_hash);
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
