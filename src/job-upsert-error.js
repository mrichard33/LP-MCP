/**
 * Job Upsert Error — src/job-upsert-error.js
 *
 * Shaping helpers for a rejected lp_jobs upsert, split out of sync-children.js
 * for one reason: NO IMPORTS. sync-children.js pulls in supabase.js (and with
 * it @supabase/supabase-js), so a test that touched these helpers there needed
 * a full install and a configured environment. Same rationale as
 * src/knowledge/vector-gate.js — scripts/test-job-upsert-error.js runs against
 * this file with no env and no network.
 *
 * v1.0 — 2026-09-03. Extracted with the observability fix for the job-changes
 *   sweep, which counted FK-rejected jobs as synced.
 */

// Postgres foreign_key_violation. On lp_jobs the only FK is
// lp_jobs_lp_lead_id_fkey → lp_leads(lp_lead_id), so a 23503 from that upsert
// means exactly one thing: the parent lead was never synced. That distinction
// matters because it is the ONLY job-upsert failure a caller could fix by
// creating the parent — permissions, constraint and type errors all need a
// human, and must never be treated as "just make the lead".
export const PG_FK_VIOLATION = '23503';

/**
 * @param {string|number|null} jobId
 * @param {string|number|null} lpLeadId
 * @param {{code?:string,message?:string,details?:string,hint?:string}|null} jobErr
 *        The PostgrestError as supabase-js RESOLVES it (it does not throw).
 * @returns {object|null} null when there was no error.
 */
export function buildJobUpsertError(jobId, lpLeadId, jobErr) {
  if (!jobErr) return null;
  const code = jobErr.code || 'none';
  return {
    jobId:    jobId    != null ? String(jobId)    : null,
    lpLeadId: lpLeadId != null ? String(lpLeadId) : null,
    code,
    message:  jobErr.message || '',
    details:  jobErr.details || '',
    hint:     jobErr.hint    || '',
    missingParent: code === PG_FK_VIOLATION,
  };
}

/** One-line summary for lp_sync_errors.error_message. */
export function describeJobUpsertError(e) {
  if (!e) return '';
  return (
    `Job ${e.jobId} upsert failed (lead ${e.lpLeadId}) — [${e.code}] ${e.message}` +
    (e.details ? ` — ${e.details}` : '') +
    (e.missingParent ? ' — parent lead absent from lp_leads' : '')
  );
}

// ─── Parent-lead self-heal gate (v1.1) ───────────────────────────
//
// The heal path fetches the prospect from LP and runs it through the canonical
// upsertLeadOnly(), then retries the job once. Gated because it is a WRITE path
// on the recurring sweep: ships off, gets proven in shadow, then live.

export const JOB_PARENT_HEAL_MODES = new Set(['off', 'shadow', 'live']);

/** off (default) | shadow (log the intent, write nothing) | live (heal + retry). */
export function getJobParentHealMode(env = process.env) {
  const m = String(env.LP_JOB_PARENT_HEAL_MODE || 'off').toLowerCase().trim();
  return JOB_PARENT_HEAL_MODES.has(m) ? m : 'off';
}

/**
 * Per-sweep cap on heal attempts. Each heal costs one LP GetLead call, so an
 * unbounded gap (a full-sync outage leaving thousands of parents missing) would
 * turn one sweep into thousands of LP calls. Bound it; the remainder simply
 * logs as before and gets picked up on later sweeps.
 */
export function getJobParentHealBudget(env = process.env) {
  const n = parseInt(env.LP_JOB_PARENT_HEAL_MAX_PER_SWEEP || '25', 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

/**
 * Heal ONLY a missing parent, and only with a usable lead id.
 *
 * missingParent is true only for Postgres 23503 (see PG_FK_VIOLATION). A
 * permission or constraint error must never reach the heal path — creating a
 * lead would not fix it and would write a row nobody asked for.
 */
export function shouldHealParent(jobUpsertError, mode, healsUsed = 0, budget = 25) {
  if (mode !== 'shadow' && mode !== 'live') return false;
  if (!jobUpsertError || !jobUpsertError.missingParent) return false;
  if (!/^\d+$/.test(String(jobUpsertError.lpLeadId || ''))) return false;
  return healsUsed < budget;
}
