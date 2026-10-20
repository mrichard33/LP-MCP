/**
 * Terminal LP job statuses — src/lp-job-terminal.js
 * ONE definition, shared by scripts/reconcile-p2-stages.js, the P2 create guard
 * (src/p2-opportunity-context.js) and the stale-fire gate. Mirrors the
 * event_subtype_in lists on agent_rules 365 (P2_JOB_TERMINAL_LOST) and 366
 * (P2_JOB_TERMINAL_WON). 'Installed & Unpaid' is deliberately in NEITHER set.
 */
import { installCompletedAt } from './lp-job-fields.js';

export const WON_JOB_STATUSES = new Set([
  'Paid In Full', 'PIF Survey Ready', 'PIF NO Survey', 'Assumed Complete',
]);
export const LOST_JOB_STATUSES = new Set([
  'Cancelled', 'Cancelled By Mgt', 'Dead Deal', 'Sent To Attorney', 'Credit Decline',
]);

/**
 * Pure. Has this job been INSTALLED? true only on evidence: lp_jobs.job_stage
 * 'complete', a passed install_completed_date, or a passed Install End (F) /
 * Completion (C) actual date in its milestones. No evidence is false.
 * lp_jobs.install_completed (the boolean) is never written by anything, so it is
 * not read.
 */
export function isInstalled(job, now = new Date()) {
  if (!job) return false;
  if (String(job.job_stage ?? '').trim() === 'complete') return true;
  const done = Date.parse(job.install_completed_date ?? '');
  if (!Number.isNaN(done) && done <= now.getTime()) return true;
  return installCompletedAt(job, now) !== null;
}

/**
 * Pure. Is this job WON for P2 (the user, 2026-10-20: "The only time an
 * opportunity in pipeline 2 should be considered won is if the project is
 * installed")? Collected AND installed. Rule 366 marked Won on the status alone
 * and closed 106 cards in stages before Install Completed (2026-09-18..23): a
 * customer who pays in full before the install is paid, not won. 'Installed &
 * Unpaid' stays open until paid (same ruling).
 */
export function isWonJob(job, now = new Date()) {
  if (!job) return false;
  return WON_JOB_STATUSES.has(String(job.job_status ?? '').trim()) && isInstalled(job, now);
}
