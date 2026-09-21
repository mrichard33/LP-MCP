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
import { latestJob, latestJobValue, jobsForContact } from './lp-job-value.js';
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

/** GHL Opportunity custom field "LP Job ID" (opportunity.lp_job_id), created 2026-09-21. */
export const OPP_CF_LP_JOB_ID = 'sMZfcWAdoqh88pghLsNQ';

/** Pure. The LP job id stamped on an opportunity as GHL returns it, or null. */
export function readOppJobId(opp) {
  const cf = (opp?.customFields || []).find((f) => f?.id === OPP_CF_LP_JOB_ID);
  const v = cf?.fieldValueString ?? cf?.fieldValue ?? cf?.field_value ?? cf?.value ?? null;
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
}

const isTerminalStatus = (status) => WON_JOB_STATUSES.has(trimmed(status)) || LOST_JOB_STATUSES.has(trimmed(status));
const verdictFor = (job) => {
  if (!job) return 'no_job';
  const s = trimmed(job.job_status);
  if (WON_JOB_STATUSES.has(s)) return 'terminal_won';
  if (LOST_JOB_STATUSES.has(s)) return 'terminal_lost';
  return 'live';
};

/**
 * Pure. Which ONE job does this opportunity track?
 *   1. the job already stamped on the opp        (via 'stamped')
 *   2. the event's job, if it is not terminal    (via 'event')
 *   3. decidingJob() — newest live, else newest  (via 'latest')
 *   4. the event's job                           (via 'event')
 * `otherJob` is true when the event speaks for a TERMINAL job that is not the
 * tracked one — an old job's replayed milestone reaching a different opportunity.
 */
export function resolveTrackedJob({ jobs = [], stampedJobId = null, eventJobId = null } = {}) {
  const rows = (jobs || []).filter(Boolean);
  const find = (id) => (id == null ? null : rows.find((j) => String(j.lp_job_id) === String(id)) || null);
  const stamped = find(stampedJobId);
  const ev = find(eventJobId);
  const latest = decidingJob(rows).job;
  let job = null; let via = 'none';
  if (stamped) { job = stamped; via = 'stamped'; }
  else if (ev && !isTerminalStatus(ev.job_status)) { job = ev; via = 'event'; }
  else if (latest) { job = latest; via = 'latest'; }
  else if (ev) { job = ev; via = 'event'; }
  const otherJob = Boolean(ev && job && String(ev.lp_job_id) !== String(job.lp_job_id) && isTerminalStatus(ev.job_status));
  return { job, via, verdict: verdictFor(job), otherJob, eventJob: ev };
}

/** The LP job id on the event that queued this action, or null. Never throws. */
export async function eventJobIdForAction(action) {
  if (!action?.event_id) return null;
  try {
    const { default: supabase } = await import('./supabase.js');
    const { data, error } = await supabase.from('system_events')
      .select('payload').eq('id', action.event_id).maybeSingle();
    if (error || !data) return null;
    const id = data.payload?.job_id ?? data.payload?.lp_job_id ?? null;
    return id == null || String(id).trim() === '' ? null : String(id).trim();
  } catch (err) {
    console.warn(`[P2Context] event read failed for action ${action?.id}: ${err.message}`);
    return null;
  }
}

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

export async function loadP2CreateContext(contactId, { stampedJobId = null, eventJobId = null } = {}) {
  const { jobs, leads, error } = await jobsForContact(contactId);
  if (error) {
    console.warn(`[P2Context] unreadable for ${contactId}: ${error} — failing open`);
    return { terminal: false, verdict: 'unreadable', job: null, source: null, value: null, via: 'none', otherJob: false };
  }
  const { job, via, verdict, otherJob, eventJob } = resolveTrackedJob({ jobs, stampedJobId, eventJobId });
  return {
    terminal: verdict === 'terminal_won' || verdict === 'terminal_lost',
    verdict, job, via, otherJob, eventJob,
    source: sourceForJob(job, leads),
    // ONE job's value, by the same rules as everywhere else: a cancelled job → null → key omitted.
    value: job ? latestJobValue([job]) : null,
  };
}
