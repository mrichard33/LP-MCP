/**
 * LP Job Value — src/lp-job-value.js
 *
 * ONE question: what is this opportunity's contract value?
 *
 * WHY THIS EXISTS
 * ---------------
 * move_opportunity never set a value. All three of its GHL write paths
 * (src/actions/handlers/opportunities.js) sent only pipelineStageId/status, so
 * every opportunity the milestone chain created or moved landed with no value.
 * Measured 2026-08-31: 260 of 2,483 Client Lifecycle opportunities sitting at
 * zero or null. update_opportunity COULD set monetaryValue, but it is a
 * separate action type a rule has to queue explicitly, and the milestone rules
 * do not.
 *
 * WHY monetaryValue AND NOT A CUSTOM FIELD
 * ----------------------------------------
 * "LP Gross Sale Amount" (YWhoVixgPtvEDzSXcMpJ, src/ghl-field-map.js) is a
 * CONTACT custom field. GHL models contact and opportunity custom fields as
 * separate objects, so that ID cannot be written onto an opportunity.
 * monetaryValue is the opportunity's own field and the one GHL's pipeline
 * revenue reporting, stage forecasts and win-probability math already read.
 * (src/ghl-field-sync.js now derives that contact field from THIS module, so
 * the two numbers agree instead of disagreeing by aggregation.)
 *
 * ONE OPPORTUNITY TRACKS ONE JOB — NOT THE SUM, NOT THE MAX
 * ---------------------------------------------------------
 * Superseded 2026-08-31. An earlier version of this file summed the contact's
 * non-cancelled jobs, on the assumption that one opportunity spans all of a
 * contact's work. It does not.
 *
 * Mark's model, which is the correct one: an opportunity tracks ONE job's
 * lifecycle and is marked Won when that job closes. A returning customer gets a
 * NEW opportunity for the new job. Summing therefore double-counts every job
 * whose opportunity is already closed Won, and inflates pipeline for exactly the
 * repeat customers who matter most — 293 contacts hold more than one job,
 * covering 680 jobs (632 active, 48 cancelled).
 *
 * So the value is ONE job's value: the contact's most recent non-cancelled job.
 * That is correct for the ~1,878 single-job contacts and for any multi-job
 * contact holding a single open opportunity. It is a proxy, and it breaks the
 * moment a contact has two open opportunities at once — nothing on the
 * opportunity records which job it belongs to, which is what an lp_job_id
 * reference is meant to fix. Until that lands, this is the closest correct rule.
 *
 * WHY lp_job_id ORDER AND NOT A DATE
 * ----------------------------------
 * lp_jobs has NO contract_date. Its only dates are install_date,
 * install_completed_date, created_at_lp and updated_at_lp, and the last two are
 * Shape-A-only (see src/lp-job-fields.js) — populated on 3,604 of 5,892 rows.
 *
 * A COALESCE(created_at_lp, updated_at_lp, synced_at) chain was measured against
 * the 267 contacts with more than one non-cancelled job and picked a DIFFERENT
 * job than id-order on 94 of them (35%). On any contact whose jobs arrived via
 * GetLead the chain falls through to synced_at — "when we last touched this
 * row" — which is near-uniform and unrelated to job chronology. That is not
 * graceful degradation, it is ordering by noise.
 *
 * lp_job_id is numeric on 5,892 of 5,892 rows with no shape dependency,
 * correlates 0.95 with created_at_lp, and agrees with date-order on 28 of the 29
 * contacts where both jobs carry a real date. It is an LP-side sequence, so
 * higher means later.
 *
 * RECOMPUTED, NEVER INCREMENTED
 * -----------------------------
 * Every call re-derives from the contact's FULL job set. An incrementing write
 * drifts permanently the first time a job is cancelled or revalued, and nothing
 * would ever correct it.
 *
 * NEVER WRITTEN TO A CLOSED OPPORTUNITY
 * -------------------------------------
 * A won/lost/abandoned opportunity's value is historical record and is frozen.
 * That invariant is enforced by the CALLERS — see isValueWritable() in
 * src/actions/handlers/opportunities.js and the status predicate in
 * scripts/backfill-opportunity-values.js — because only they know the
 * opportunity's status. This module is pure and status-blind by design.
 */

/**
 * Job statuses excluded from pipeline value — work nobody is doing.
 *
 * 'Credit Decline' is deliberately NOT here. A decline can still convert, and
 * excluding it would take the excluded count on multi-job contacts from 65 to
 * 94 on the strength of a guess about intent.
 *
 * NOTE — this list is deliberately NARROWER than the reporting 'lost' bucket in
 * src/jobs/lp-report-parse-job-status.js, which also counts 'Credit Decline'.
 * Both choices are intentional and they do not reconcile: a Credit Decline job
 * carries pipeline value here while reporting counts it lost. If you are
 * chasing a gap between pipeline revenue and the job-status report, this is it.
 */
export const CANCELLED_JOB_STATUSES = new Set([
  'Cancelled',
  'Cancelled By Mgt',
  'Dead Deal',
]);

/**
 * Sort rank for an lp_job_id. Higher is later.
 *
 * Non-numeric and blank ids rank lowest rather than throwing or sorting as NaN:
 * Number('') is 0, which would otherwise outrank a legitimately absent id and
 * let a blank row win over a real job. Ties fall through to a string compare in
 * latestJobValue so the result is deterministic either way.
 */
function jobIdRank(lpJobId) {
  const raw = lpJobId == null ? '' : String(lpJobId).trim();
  if (raw === '') return -Infinity;
  const n = Number(raw);
  return Number.isFinite(n) ? n : -Infinity;
}

/**
 * The value of the contact's most recent non-cancelled job. Pure — no I/O, no clock.
 *
 * Cancelled jobs are filtered BEFORE the most-recent pick, so a contact whose
 * newest job was cancelled falls through to their most recent live one rather
 * than reporting zero.
 *
 * Returns null, NOT 0, when nothing qualifies: the caller must be able to tell
 * "this contact has no live work" from "this contact's work is worth zero", so
 * that a stage move on a contact with no linked jobs omits monetaryValue rather
 * than clobbering a value set by some other path.
 *
 * @param {Array<{lp_job_id?: string|number|null, job_status?: string, job_value?: number|string|null}>} jobs
 * @returns {number|null}
 */
export function latestJobValue(jobs = []) {
  let best = null;
  for (const job of jobs) {
    if (!job) continue;
    const status = typeof job.job_status === 'string' ? job.job_status.trim() : '';
    if (CANCELLED_JOB_STATUSES.has(status)) continue;
    const value = parseFloat(job.job_value);
    if (!Number.isFinite(value)) continue;
    const rank = jobIdRank(job.lp_job_id);
    const tie = job.lp_job_id == null ? '' : String(job.lp_job_id);
    if (best === null || rank > best.rank || (rank === best.rank && tie > best.tie)) {
      best = { rank, tie, value };
    }
  }
  if (best === null) return null;
  // LP money is 2dp; job_value arrives as a string often enough to be worth it.
  return Math.round(best.value * 100) / 100;
}

/**
 * The contact's current contract value, or null when they have no qualifying job.
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
    .select('lp_job_id, job_status, job_value')
    .eq('ghl_contact_id', ghlContactId);
  if (error) {
    // Never block a stage move on a value lookup: the move is the action the
    // rule asked for, the value is enrichment. Log and omit.
    console.warn(`[JobValue] lookup failed for contact ${ghlContactId}: ${error.message}`);
    return null;
  }
  return latestJobValue(data || []);
}
