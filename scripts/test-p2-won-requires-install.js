/**
 * A P2 card is Won only once its job is installed AND paid (the user, 2026-10-20).
 * Rule 366 closed 106 cards Won before "7. Install Completed" on the job status
 * alone. Covers isInstalled / isWonJob, the executor guard (decideP2Win, checkP2Win),
 * the reconciler, the sale backstop's verdict and the one-time repair plan.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isInstalled, isWonJob, WON_JOB_STATUSES } from '../src/lp-job-terminal.js';
import { installCompletedAt } from '../src/lp-job-fields.js';
import { decideP2Win, checkP2Win, pickOpenCard, INSTALL_COMPLETED_STAGE_ID } from '../src/p2-won-guard.js';
import { decidingJob, OPP_CF_LP_JOB_ID } from '../src/p2-opportunity-context.js';
import { planForSale } from '../src/p2-sale-backstop.js';
import { stageDecision } from './reconcile-p2-stages.js';
import { planRepair, repairBody } from './repair-p2-won-before-install.js';
import { STAGE_MAP } from '../src/actions/constants.js';

const NOW = new Date('2026-10-20T16:00:00Z');
const ms = (mdt_id, actdate) => ({ mdt_id, actdate });
const job = (over = {}) => ({ lp_job_id: '58566', lp_lead_id: 'L1', job_status: 'Paid In Full', job_value: 20000, ...over });
const card = (over = {}) => ({ id: 'opp1', status: 'open', pipelineStageId: STAGE_MAP['Install Scheduled'], ...over });

// ─── isInstalled / isWonJob ────────────────────────────────────────────

test('installed: a passed Install End (F) or Completion (C), job_stage complete, or install_completed_date', () => {
  assert.equal(isInstalled(job({ milestones: [ms('F', '2026-10-09T00:00:00')] }), NOW), true);
  assert.equal(isInstalled(job({ milestones: [ms('C', '2026-10-12T00:00:00')] }), NOW), true);
  assert.equal(isInstalled(job({ job_stage: 'complete' }), NOW), true);
  assert.equal(isInstalled(job({ install_completed_date: '2026-10-07T00:00:00+00:00' }), NOW), true);
  // lp_job_milestones shape, bare date
  assert.equal(isInstalled(job({ milestones: [{ mdt_id: 'F', act_date: '2026-09-09' }] }), NOW), true);
});

test('not installed: install start only, a BOOKED install end, or no evidence at all', () => {
  assert.equal(isInstalled(job({ milestones: [ms('S', '2026-10-09T00:00:00')] }), NOW), false);
  assert.equal(isInstalled(job({ milestones: [ms('F', '2026-11-02T00:00:00')] }), NOW), false);
  assert.equal(isInstalled(job({ install_completed_date: '2026-11-02T00:00:00+00:00' }), NOW), false);
  assert.equal(isInstalled(job({ job_stage: 'install' }), NOW), false);
  assert.equal(isInstalled(job(), NOW), false);
  assert.equal(isInstalled(null, NOW), false);
  assert.equal(installCompletedAt(job({ milestones: [ms('F', '')] }), NOW), null);
});

test('won = paid AND installed; Installed & Unpaid is not won', () => {
  for (const status of WON_JOB_STATUSES) {
    assert.equal(isWonJob(job({ job_status: status, job_stage: 'complete' }), NOW), true, status);
    assert.equal(isWonJob(job({ job_status: status }), NOW), false, `${status} not installed`);
  }
  assert.equal(isWonJob(job({ job_status: 'Installed & Unpaid', job_stage: 'complete' }), NOW), false);
});

// ─── the executor guard ───────────────────────────────────────────────

test('guard: refuses a win before the install, and names why', () => {
  const d = decideP2Win({ opp: card(), jobs: [job({ milestones: [ms('S', '2026-10-09T00:00:00')] })], now: NOW });
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'won_before_install');
  assert.equal(d.verdict, 'live');
});

test('guard: refuses an installed job that is not paid', () => {
  const d = decideP2Win({ opp: card(), jobs: [job({ job_status: 'Installed & Unpaid', job_stage: 'complete' })], now: NOW });
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'won_job_not_collected');
});

test('guard: fails closed on a failed read and on no LP job', () => {
  assert.equal(decideP2Win({ opp: card(), jobs: [], readError: 'timeout', now: NOW }).reason, 'won_jobs_unreadable');
  assert.equal(decideP2Win({ opp: card(), jobs: [], now: NOW }).reason, 'won_no_lp_job');
});

test('guard: installed and paid wins and moves the card forward to Install Completed', () => {
  const d = decideP2Win({ opp: card({ pipelineStageId: STAGE_MAP['Contract Signed'] }), jobs: [job({ job_stage: 'complete' })], now: NOW });
  assert.equal(d.allow, true);
  assert.equal(d.stageId, INSTALL_COMPLETED_STAGE_ID);
});

test('guard: never moves a card backward (Referral & Expansion stays) or onto itself', () => {
  const won = [job({ job_stage: 'complete' })];
  assert.equal(decideP2Win({ opp: card({ pipelineStageId: STAGE_MAP['Referral & Expansion'] }), jobs: won, now: NOW }).stageId, null);
  assert.equal(decideP2Win({ opp: card({ pipelineStageId: INSTALL_COMPLETED_STAGE_ID }), jobs: won, now: NOW }).stageId, null);
});

test('guard: the STAMPED job decides, not a newer paid one', () => {
  const jobs = [job({ lp_job_id: '40001', job_status: 'Awaiting Product' }), job({ lp_job_id: '58566', job_stage: 'complete' })];
  const opp = card({ customFields: [{ id: OPP_CF_LP_JOB_ID, fieldValueString: '40001' }] });
  assert.equal(decideP2Win({ opp, jobs, now: NOW }).reason, 'won_job_not_collected');
});

test('checkP2Win: reads through the deps seam; a throwing read refuses', async () => {
  const ok = await checkP2Win({ contactId: 'c1', opp: card(), now: NOW, deps: { jobsForContact: async () => ({ jobs: [job({ job_stage: 'complete' })], error: null }) } });
  assert.equal(ok.allow, true);
  const bad = await checkP2Win({ contactId: 'c1', opp: card(), now: NOW, deps: { jobsForContact: async () => { throw new Error('down'); } } });
  assert.equal(bad.allow, false);
  assert.equal(bad.reason, 'won_jobs_unreadable');
});

test('pickOpenCard: an old Won or Lost card is never the one closed', () => {
  assert.equal(pickOpenCard([{ id: 'a', status: 'won' }, { id: 'b', status: 'open' }]).id, 'b');
  assert.equal(pickOpenCard([{ id: 'a', status: 'won' }, { id: 'c', status: 'lost' }]), null);
});

// ─── the other writers ────────────────────────────────────────────────

test('sale backstop: a sale paid before its install gets an open card, never create_won', () => {
  const paidOnly = job({ contractdate: '2026-09-01T00:00:00' });
  const { verdict, job: j } = decidingJob([paidOnly]);
  assert.equal(verdict, 'live');
  assert.notEqual(planForSale({ verdict, job: j, p2Opps: [], contact: null, nowMs: NOW.getTime() }).action, 'create_won');
});

test('reconciler: Paid In Full with no install milestone is not a win', () => {
  const rows = [{ lp_job_id: '1', job_status: 'Paid In Full', job_value: 1, milestones: [{ mdt_id: 'S', act_date: '2026-10-01T00:00:00Z' }] }];
  assert.notEqual(stageDecision({ currentStageId: STAGE_MAP['Install Scheduled'], jobs: rows, mapping: {} }).verdict, 'win');
  assert.notEqual(stageDecision({ currentStageId: STAGE_MAP['Install Scheduled'], jobs: rows, mapping: {}, trackedJobId: '1' }).verdict, 'win');
  const done = [{ ...rows[0], milestones: [{ mdt_id: 'F', act_date: '2026-10-01T00:00:00Z' }] }];
  assert.equal(stageDecision({ currentStageId: STAGE_MAP['Install Scheduled'], jobs: done, mapping: {} }).verdict, 'win');
});

// ─── the one-time repair ──────────────────────────────────────────────

test('repair: installed + paid → move to Install Completed and stay Won', () => {
  const opp = card({ status: 'won', pipelineStageId: STAGE_MAP['Contract Signed'] });
  const plan = planRepair({ opp, decision: decideP2Win({ opp, jobs: [job({ job_stage: 'complete' })], now: NOW }) });
  assert.equal(plan.action, 'move');
  assert.deepEqual(repairBody(plan), { pipelineStageId: INSTALL_COMPLETED_STAGE_ID, status: 'won' });
});

test('repair: a live job is reopened; a cancelled job or a failed read is for a person', () => {
  const opp = card({ status: 'won' });
  const live = planRepair({ opp, decision: decideP2Win({ opp, jobs: [job()], now: NOW }) });
  assert.equal(live.action, 'reopen');
  assert.deepEqual(repairBody(live), { status: 'open' });
  const dead = planRepair({ opp, decision: decideP2Win({ opp, jobs: [job({ job_status: 'Cancelled' })], now: NOW }) });
  assert.equal(dead.action, 'report');
  assert.equal(repairBody(dead), null);
  const unread = planRepair({ opp, decision: decideP2Win({ opp, jobs: [], readError: 'x', now: NOW }) });
  assert.equal(unread.action, 'report');
});

test('repair: a card no longer Won, or already at Install Completed, is left alone', () => {
  const d = decideP2Win({ opp: card(), jobs: [job({ job_stage: 'complete' })], now: NOW });
  assert.equal(planRepair({ opp: card({ status: 'open' }), decision: d }).action, 'skip');
  assert.equal(planRepair({ opp: card({ status: 'won', pipelineStageId: INSTALL_COMPLETED_STAGE_ID }), decision: d }).action, 'skip');
  assert.equal(planRepair({ opp: null, decision: d }).action, 'report');
});
