/**
 * P2 won guard — src/p2-won-guard.js
 * ONE question, asked before ANY write that closes a P2 (Client Lifecycle) card Won:
 * is the job this card tracks installed AND paid?
 *
 * WHY (the user, 2026-10-20): "The only time an opportunity in pipeline 2 should be
 * considered won is if the project is installed." Rule 366 (P2_JOB_TERMINAL_WON)
 * closed cards Won on the LP job STATUS alone (Paid In Full, PIF Survey Ready, PIF
 * NO Survey, Assumed Complete) and left the stage where it was: 106 Won cards sat in
 * stages before "7. Install Completed" on 2026-10-20, 102 of them closed on
 * 2026-09-18..23. A customer who pays in full before the install is paid, not won.
 * Installed & Unpaid stays open until paid (same ruling).
 *
 * The guard sits in the executor, not in the rule, so rule 366, the install rule
 * (P2_INSTALL_COMPLETE_WON) and any later caller all pass the same test. It FAILS
 * CLOSED: a job read that fails, or no LP job, writes nothing. A Won close is
 * reported revenue; "could not tell" is never a win.
 *
 * On a win the card also moves forward to Install Completed (never backward, so a
 * card at Referral & Expansion stays there).
 */
import { resolveTrackedJob, readOppJobId } from './p2-opportunity-context.js';
import { WON_JOB_STATUSES, isInstalled } from './lp-job-terminal.js';
import { checkForwardOnly } from './pipeline-guard.js';
import { STAGE_MAP } from './actions/constants.js';

export const INSTALL_COMPLETED_STAGE_ID = STAGE_MAP['Install Completed'];

/**
 * Pure. May this P2 card be closed Won?
 * @returns {{ allow: boolean, reason: string, job: object|null, verdict: string, stageId: string|null }}
 *   verdict: the tracked job's live | terminal_won | terminal_lost | no_job | unreadable.
 *   stageId: the stage to write with the win (Install Completed), or null to leave it.
 */
export function decideP2Win({ opp = null, jobs = [], readError = null, now = new Date() } = {}) {
  if (readError) return { allow: false, reason: 'won_jobs_unreadable', job: null, verdict: 'unreadable', stageId: null };
  const { job, verdict } = resolveTrackedJob({ jobs, stampedJobId: readOppJobId(opp) });
  const refuse = (reason) => ({ allow: false, reason, job, verdict, stageId: null });
  if (!job) return refuse('won_no_lp_job');
  if (!WON_JOB_STATUSES.has(String(job.job_status ?? '').trim())) return refuse('won_job_not_collected');
  if (!isInstalled(job, now)) return refuse('won_before_install');
  const fwd = checkForwardOnly(opp?.pipelineStageId, INSTALL_COMPLETED_STAGE_ID);
  const stageId = fwd.reason === 'forward_move' ? INSTALL_COMPLETED_STAGE_ID : null;
  return { allow: true, reason: 'installed_and_paid', job, verdict, stageId };
}

/**
 * Pure. Which P2 card does a Won close write? The OPEN one. The handler used to take
 * whatever GHL listed first, so a card already Won or Lost (a repeat customer's old
 * one) could be closed again. null when no card is open.
 */
export function pickOpenCard(opps = []) {
  return (opps || []).find((o) => String(o?.status || 'open').toLowerCase() === 'open') || null;
}

/** I/O. Read the contact's LP jobs and decide. deps.jobsForContact for tests. */
export async function checkP2Win({ contactId, opp, deps = {}, now = new Date() }) {
  const jobsForContact = deps.jobsForContact
    || (await import('./lp-job-value.js')).jobsForContact;
  let read;
  try {
    read = await jobsForContact(contactId);
  } catch (err) {
    read = { jobs: [], error: err.message };
  }
  return decideP2Win({ opp, jobs: read?.jobs || [], readError: read?.error || null, now });
}
