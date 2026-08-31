/**
 * LP Job Value — src/lp-job-value.js
 *
 * ONE question: what is this contact's live contract value?
 *
 * WHY THIS EXISTS
 * ---------------
 * move_opportunity never set a value. All three of its GHL write paths
 * (src/actions/handlers/opportunities.js) sent only pipelineStageId/status, so
 * every opportunity the milestone chain created or moved landed with no value.
 * Measured 2026-08-31: 260 of 2,518 Client Lifecycle opportunities sitting at
 * zero or null. update_opportunity COULD set monetaryValue, but it is a
 * separate action type a rule has to queue explicitly, and the milestone rules
 * do not.
 *
 * WHY monetaryValue AND NOT A CUSTOM FIELD
 * ----------------------------------------
 * "LP Gross Sale Amount" (YWhoVixgPtvEDzSXcMpJ, src/ghl-field-map.js) is a
 * CONTACT custom field, written by ghl-field-sync from lp_leads.job_value and
 * populated on 6,962 contacts. GHL models contact and opportunity custom fields
 * as separate objects, so that ID cannot be written onto an opportunity.
 * monetaryValue is the opportunity's own field and the one GHL's pipeline
 * revenue reporting, stage forecasts and win-probability math already read.
 *
 * SUM, NOT MAX, AND NOT THE TRIGGERING JOB
 * ----------------------------------------
 * A contact holds at most one OPEN opportunity per pipeline (the invariant in
 * opportunities.js v5.0) but can hold several LP jobs — 2,171 linked contacts,
 * 293 with more than one, 680 jobs among them, heaviest carrying 9. The
 * opportunity represents the contact's live work, so a two-window customer at
 * $12k each is $24k of pipeline. MAX understates them by exactly the second
 * window; the triggering job's own value would jump to a different number every
 * time a milestone fired, with no business meaning.
 *
 * RECOMPUTED, NEVER INCREMENTED
 * -----------------------------
 * Every call re-derives the total from the contact's FULL job set. An
 * incrementing write drifts permanently the first time a job is cancelled or
 * revalued, and nothing would ever correct it.
 */

/**
 * Job statuses excluded from pipeline value — work nobody is doing.
 *
 * 'Credit Decline' is deliberately NOT here. A decline can still convert, and
 * excluding it would take the excluded count on multi-job contacts from 65 to
 * 94 on the strength of a guess about intent.
 */
export const CANCELLED_JOB_STATUSES = new Set([
  'Cancelled',
  'Cancelled By Mgt',
  'Dead Deal',
]);

/**
 * Sum the non-cancelled job values. Pure — no I/O, no clock.
 *
 * Returns null, NOT 0, when nothing qualifies: the caller must be able to tell
 * "this contact has no live work" from "this contact's work is worth zero", so
 * that a stage move on a contact with no linked jobs omits monetaryValue rather
 * than clobbering a value set by some other path.
 *
 * @param {Array<{job_status?: string, job_value?: number|string|null}>} jobs
 * @returns {number|null}
 */
export function sumJobValues(jobs = []) {
  let total = 0;
  let counted = 0;
  for (const job of jobs) {
    if (!job) continue;
    const status = typeof job.job_status === 'string' ? job.job_status.trim() : '';
    if (CANCELLED_JOB_STATUSES.has(status)) continue;
    const value = parseFloat(job.job_value);
    if (!Number.isFinite(value)) continue;
    total += value;
    counted++;
  }
  if (counted === 0) return null;
  // LP money is 2dp; float addition across 9 jobs otherwise yields 1e-11 tails.
  return Math.round(total * 100) / 100;
}

/**
 * The contact's live contract value, or null when they have no qualifying job.
 *
 * @param {string} ghlContactId
 * @returns {Promise<number|null>}
 */
export async function openJobValueForContact(ghlContactId) {
  if (!ghlContactId) return null;
  // Imported lazily so the pure half of this module stays loadable without the
  // Supabase driver — that is what lets scripts/test-lp-job-value.js run as a
  // real unit test rather than needing a database.
  const { default: supabase } = await import('./supabase.js');
  const { data, error } = await supabase.from('lp_jobs')
    .select('job_status, job_value')
    .eq('ghl_contact_id', ghlContactId);
  if (error) {
    // Never block a stage move on a value lookup: the move is the action the
    // rule asked for, the value is enrichment. Log and omit.
    console.warn(`[JobValue] lookup failed for contact ${ghlContactId}: ${error.message}`);
    return null;
  }
  return sumJobValues(data || []);
}
