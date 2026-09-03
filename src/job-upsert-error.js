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
