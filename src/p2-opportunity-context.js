/**
 * P2 opportunity context — src/p2-opportunity-context.js
 * ONE question: for THIS contact, which LP job would a new P2 opportunity track,
 * is that job still alive, and what source does it carry?
 *
 * WHY: measured 2026-09-21, 115 of 157 P2 opportunities created in 30 days were
 * for jobs already Paid In Full (105) or dead (10). Once an opp is Won/Lost the
 * next milestone finds no OPEN opp and the create path mints a new one. And the
 * create path sent no source whenever contact.source was blank or 'lp-backstop'.
 *
 * FAIL OPEN is the binding rule. Unreadable jobs or no job at all means CREATE,
 * exactly as before — absence of evidence never blocks a live customer.
 */
import { latestJob, jobsForContact } from './lp-job-value.js';
import { combinedSourceLabel } from './format-helpers.js';
import { WON_JOB_STATUSES, LOST_JOB_STATUSES } from './lp-job-terminal.js';

const MODES = new Set(['off', 'shadow', 'enforce']);
/** P2_TERMINAL_CREATE_GUARD_MODE — off | shadow (default) | enforce. Read per call. */
export function terminalGuardMode() {
  const m = String(process.env.P2_TERMINAL_CREATE_GUARD_MODE || 'shadow').toLowerCase().trim();
  return MODES.has(m) ? m : 'shadow';
}

const trimmed = (s) => (typeof s === 'string' ? s.trim() : '');
const jobIdOf = (job) => {
  const n = Number(String(job?.lp_job_id ?? '').trim());
  return Number.isFinite(n) ? n : -Infinity;
};

/** Pure. Same order as stageDecision() in scripts/reconcile-p2-stages.js. */
export function decidingJob(jobs = []) {
  const rows = (jobs || []).filter(Boolean);
  if (rows.length === 0) return { job: null, verdict: 'no_job' };
  const live = latestJob(rows);
  if (live === null) {
    const newest = rows.reduce((a, b) => (jobIdOf(b) > jobIdOf(a) ? b : a), rows[0]);
    return { job: newest, verdict: 'terminal_lost' };
  }
  const status = trimmed(live.job_status);
  if (WON_JOB_STATUSES.has(status)) return { job: live, verdict: 'terminal_won' };
  if (LOST_JOB_STATUSES.has(status)) return { job: live, verdict: 'terminal_lost' };
  return { job: live, verdict: 'live' };
}

/** Pure. "Source, Subsource" of the lead that owns the job; single-label fallback when no job. */
export function sourceForJob(job, leads = []) {
  const rows = (leads || []).filter(Boolean);
  if (job) {
    const lead = rows.find((l) => String(l.lp_lead_id) === String(job.lp_lead_id));
    const label = lead ? combinedSourceLabel(lead.lead_source, lead.lead_source_detail) : null;
    if (label) return label;
  }
  const labels = new Set(rows
    .map((l) => combinedSourceLabel(l.lead_source, l.lead_source_detail)).filter(Boolean));
  return labels.size === 1 ? [...labels][0] : null;
}

export async function loadP2CreateContext(contactId) {
  const { jobs, leads, error } = await jobsForContact(contactId);
  if (error) {
    console.warn(`[P2Context] unreadable for ${contactId}: ${error} — failing open`);
    return { terminal: false, verdict: 'unreadable', job: null, source: null };
  }
  const { job, verdict } = decidingJob(jobs);
  return {
    terminal: verdict === 'terminal_won' || verdict === 'terminal_lost',
    verdict, job, source: sourceForJob(job, leads),
  };
}
