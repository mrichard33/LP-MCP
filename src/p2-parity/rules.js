/**
 * P2 parity rules — src/p2-parity/rules.js (pure)
 *
 * ONE question: where should this Client Lifecycle (P2) card be, given what LP says
 * about the job it tracks, and what must change to get it there?
 *
 * WHY (the user, 2026-10-20): "I want to make sure going forward there is zero
 * deviation from the source or what is in LP." An audit that day found 325 of 3,270
 * P2 cards out of step with LP. Cards move only when an event fires, and only
 * forward; an event that is lost, suppressed (backfills run with side effects off),
 * collapsed onto a milestone that moves nothing (H over R, #1395) or skipped
 * forward-only on a repeat buyer's old card is never retried, and nothing compared a
 * card with LP again. The sweep (src/p2-parity/sweep.js) asks this module every pass.
 *
 * The user's rulings, same day:
 *   - LP is the source: a card AHEAD of LP moves back too.
 *   - A repeat buyer's one card (GHL allows one P2 card per contact) follows the NEW
 *     project: re-stamped with its LP Job ID, reopened, at its stage.
 *   - Won = paid AND installed (isWonJob, #1394). Installed & Unpaid stays open.
 *
 * Milestones come from BOTH raw_lp_data.milestones and lp_job_milestones: the audit
 * found each one missing rows the other had (job 57338's raw copy had no B, the
 * table had it; 600 jobs had raw milestones and no table rows). A milestone counts
 * only once its actual date has passed (LP stores booked installs as actuals).
 */
import { resolveTrackedJob, decidingJob, readOppJobId, OPP_CF_LP_JOB_ID } from '../p2-opportunity-context.js';
import { isWonJob, LOST_JOB_STATUSES } from '../lp-job-terminal.js';
import { latestJobValue } from '../lp-job-value.js';
import { looksLikeDuplicateOfPaidJob } from '../p2-sale-backstop.js';
import { lostReasonIdForJobStatus } from '../lp-lost-reasons.js';
import { getStagePosition } from '../pipeline-guard.js';
import { STAGE_MAP } from '../actions/constants.js';

export const CONTRACT_SIGNED_STAGE_ID = STAGE_MAP['Contract Signed'];
export const INSTALL_COMPLETED_STAGE_ID = STAGE_MAP['Install Completed'];
const INSTALL_COMPLETED_POS = getStagePosition(INSTALL_COMPLETED_STAGE_ID);

const trimmed = (s) => (typeof s === 'string' ? s.trim() : '');
const jobIdOf = (job) => {
  const n = Number(String(job?.lp_job_id ?? '').trim());
  return Number.isFinite(n) ? n : -Infinity;
};

/** Pure. A bare 'YYYY-MM-DD' or an LP timestamp → ms, or NaN. */
function dateMs(raw) {
  const s = trimmed(String(raw ?? ''));
  if (!s) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
}

/**
 * Pure. The stage LP supports for one job: the furthest stage any milestone with a
 * PASSED actual date maps to, else Contract Signed (a signed contract, nothing more).
 * Reads `milestones` in either shape ({mdt_id, actdate} raw, {mdt_id, act_date} table).
 */
export function lpStageFor(job, mapping = {}, now = new Date()) {
  let best = null;
  for (const m of job?.milestones || []) {
    const t = dateMs(m?.actdate ?? m?.act_date);
    if (Number.isNaN(t) || t > now.getTime()) continue;
    const hit = mapping[trimmed(String(m?.mdt_id ?? ''))];
    if (!hit) continue;
    if (!best || hit.position > best.position) best = hit;
  }
  return best ? best.stageId : CONTRACT_SIGNED_STAGE_ID;
}

/**
 * Pure. Where the card should be.
 * @returns {{ kind: 'no_lp_job' } | { kind: 'expected', job, status: 'open'|'won'|'lost',
 *            stageId: string|null, value: number|null, followsNewJob: boolean }}
 */
export function expectedP2({ jobs = [], stampedJobId = null, mapping = {}, now = new Date() } = {}) {
  const rows = (jobs || []).filter(Boolean);
  if (!rows.length) return { kind: 'no_lp_job' };
  let { job, via, verdict } = resolveTrackedJob({ jobs: rows, stampedJobId });
  if (!job) return { kind: 'no_lp_job' };

  // A repeat buyer's card follows the NEW project (the user, 2026-10-20). The stamp
  // pins the card to a finished job; a newer live job that is not a placeholder copy
  // or a near-duplicate of a paid job (the two shapes LP leaves behind) takes over.
  let followsNewJob = false;
  if (via === 'stamped' && verdict !== 'live') {
    const d = decidingJob(rows);
    if (d.verdict === 'live' && d.job && String(d.job.lp_job_id) !== String(job.lp_job_id)
        && jobIdOf(d.job) > jobIdOf(job) && !looksLikeDuplicateOfPaidJob(d.job, rows, [])) {
      job = d.job;
      verdict = 'live';
      followsNewJob = true;
    }
  }

  const status = verdict === 'terminal_lost' || LOST_JOB_STATUSES.has(trimmed(job.job_status))
    ? 'lost'
    : (isWonJob(job, now) ? 'won' : 'open');
  let stageId = status === 'lost' ? null : lpStageFor(job, mapping, now);
  // An installed, paid job's card sits at Install Completed or later.
  if (status === 'won' && (getStagePosition(stageId) ?? -1) < INSTALL_COMPLETED_POS) stageId = INSTALL_COMPLETED_STAGE_ID;
  return { kind: 'expected', job, status, stageId, value: latestJobValue([job]), followsNewJob };
}

/**
 * Pure. What must change on the card. `card` is { status, pipelineStageId,
 * monetaryValue, customFields } (GHL's shape; the mirror row is mapped to it).
 * @returns {{ action: 'none'|'update'|'report', kinds: string[], body: object|null,
 *            reason?: string, lostReasonId?: string }}
 */
export function parityAction({ card, expected }) {
  if (!expected || expected.kind === 'no_lp_job') return { action: 'report', kinds: [], body: null, reason: 'no_lp_job' };
  const status = String(card?.status || 'open').toLowerCase();
  const kinds = [];
  const body = {};

  if (expected.status === 'lost') {
    if (status === 'lost') return { action: 'none', kinds: [], body: null };
    const lostReasonId = lostReasonIdForJobStatus(expected.job.job_status);
    if (!lostReasonId) return { action: 'report', kinds: [], body: null, reason: `no_lost_reason:${expected.job.job_status}` };
    return { action: 'update', kinds: ['lose'], body: { status: 'lost', lostReasonId }, lostReasonId };
  }

  if (status !== expected.status) {
    kinds.push(expected.status === 'won' ? 'win' : 'reopen');
    body.status = expected.status;
  }
  if (expected.stageId && card?.pipelineStageId !== expected.stageId) {
    const from = getStagePosition(card?.pipelineStageId);
    const to = getStagePosition(expected.stageId);
    kinds.push(from === null || to > from ? 'move_forward' : 'move_back');
    body.pipelineStageId = expected.stageId;
  }
  if (expected.followsNewJob && readOppJobId(card) !== String(expected.job.lp_job_id)) {
    kinds.push('restamp');
    body.customFields = [{ id: OPP_CF_LP_JOB_ID, field_value: String(expected.job.lp_job_id) }];
  }
  const have = Number(card?.monetaryValue ?? card?.monetary_value);
  if (expected.value != null && (!Number.isFinite(have) || Math.abs(have - expected.value) >= 1)) {
    kinds.push('value');
    body.monetaryValue = expected.value;
  }
  return kinds.length ? { action: 'update', kinds, body } : { action: 'none', kinds: [], body: null };
}

/** Pure. Order a pass's writes: status first (the reported numbers), then stage, then value. */
export function writePriority(kinds = []) {
  if (kinds.includes('lose') || kinds.includes('win') || kinds.includes('reopen')) return 0;
  if (kinds.includes('move_forward') || kinds.includes('move_back') || kinds.includes('restamp')) return 1;
  return 2;
}

// Stages a GHL customer workflow starts on: C.1 (4-6), C.2 (7), C.4 after its fix (8).
// Nothing starts on 1-3 (C.0 starts on a card's CREATION), so a tag added for a move
// there would sit on the contact and swallow the customer's next real update.
const FIRST_MESSAGED_POS = getStagePosition(STAGE_MAP['Permitting & HOA']);

/**
 * Pure. The heal tag goes on before a repair that moves an OPEN card into a stage a
 * customer workflow starts on, so the workflow consumes it and exits instead of texting.
 */
export function needsHealTag(card, body) {
  const endStatus = body?.status || String(card?.status || 'open').toLowerCase();
  if (!body?.pipelineStageId || endStatus !== 'open') return false;
  return (getStagePosition(body.pipelineStageId) ?? -1) >= FIRST_MESSAGED_POS;
}
