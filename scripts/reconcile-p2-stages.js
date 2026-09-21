#!/usr/bin/env node
/**
 * Reconcile P2 Stages — scripts/reconcile-p2-stages.js
 *
 * One-shot data repair for the P2 Client Lifecycle opportunities that never
 * left the stage they were created at. Measured 2026-08-31: 1,515 of 2,452
 * OPEN P2 opportunities sit at "1. Contract Signed"
 * (fec39f2e-ba39-4536-95b2-bbac7ca6c454). Monthly cohorts are flat — April has
 * 284 still there and August has 284 — so nothing ages out. The stage records
 * where the opportunity was CREATED and has never been updated since. LP shows
 * 992 distinct contacts with a Paid In Full job; GHL shows 113 opportunities at
 * Install Completed.
 *
 * WHY A REPAIR PASS IS NEEDED AT ALL
 * ----------------------------------
 * The milestone handler fix (src/actions/handlers/opportunities.js v5.0) stops
 * NEW strandings. It repairs an opportunity only when a milestone MOVES it, and
 * these opportunities' milestones already fired — months ago, into a handler
 * that dropped them. Nothing will ever move them again. Same shape of problem
 * as scripts/backfill-opportunity-values.js, which this script is modelled on.
 *
 * THIS ONE CALLS GHL. It is DRY RUN BY DEFAULT and needs --apply to write.
 * Its ONLY writes are: a forward stage move, status 'won', status 'lost' (with
 * a configured lost reason). No tag, no workflow trigger, no message, no
 * delete, and never 'abandoned' — 'abandoned' belongs to
 * scripts/dedupe-opportunities.js and asserts "duplicate record", which is not
 * what any of these are.
 *
 * ─── HARD PRECONDITION, NOT CLEARED BY THIS SCRIPT ────────────────────────
 * (a) NO GHL WORKFLOW MAY TRIGGER ON A P2 OPPORTUNITY STAGE OR STATUS CHANGE.
 *     src/pipeline-guard.js documents that P2 message triggers key on the
 *     lp-milestone-* TAG and not on pipeline_stage_updated, precisely because
 *     LP milestones arrive out of stage order and the stage event does not
 *     reliably land. If that is still true this pass is inert to the customer.
 *     If ANY workflow has an opportunity-stage or opportunity-status trigger on
 *     P2, moving 1,515 opportunities fires it 1,515 times — including messages
 *     to customers whose jobs finished months ago. Only a human can check this
 *     in the GHL UI. This script cannot verify it and does not assume it.
 * (b) Marking ~318 opportunities 'won' MOVES REPORTED REVENUE. Won
 *     opportunities feed close-rate and revenue reporting including the
 *     Scorecard. That shift must be expected, not investigated as a defect.
 *
 * ─── LOCKED DECISIONS ─────────────────────────────────────────────────────
 * MOST-RECENT JOB WINS, ALWAYS. A contact may hold several LP jobs — a 2024 job
 * Paid In Full and a 2026 job in production. An opportunity tracks ONE job's
 * lifecycle (src/lp-job-value.js). Deciding from "any job is complete" would
 * close a returning customer's LIVE job as won. The job is selected FIRST, by
 * latestJob() from src/lp-job-value.js — the same "most recent non-cancelled"
 * definition the value derivation already uses — and everything after that
 * reads one job.
 *
 * FORWARD-ONLY. checkForwardOnly() from src/pipeline-guard.js decides every
 * move. A derived stage at or behind the current one is skipped. This pass
 * never moves anything backward even when LP appears to disagree: LP milestones
 * arrive out of order by design, which is the reason the guard exists.
 *
 * A CONTACT WITH NO LP JOB IS REPORTED AND NEVER TOUCHED. ~390 of them. An
 * opportunity in P2 means a contract was signed; no LP job means either the job
 * was never created or the contact link is broken. Those are two different
 * defects with two different fixes, and guessing a stage buries the evidence.
 * They are listed in full in the summary and are out of scope here.
 *
 * ALL JOBS CANCELLED IS NOT "NO JOB". latestJob() filters cancelled jobs before
 * picking, so a contact whose every job is Cancelled / Cancelled By Mgt / Dead
 * Deal has no *selectable* job — but they plainly have LP records, and the
 * answer for them is 'lose', not "report as missing". ~307 of them. The
 * distinction is made on the RAW job list before selection; see stageDecision.
 *
 * OPEN OPPORTUNITIES ONLY, BY QUERY. A won or lost opportunity's stage is
 * historical record. Same status predicate as
 * scripts/backfill-opportunity-values.js.
 *
 * ONE PIPELINE. --pipeline=P2 only. P1 and P3 have different semantics.
 *
 * ─── WHERE THE STAGE MAPPING COMES FROM ───────────────────────────────────
 * NOT from a table in this file. The LP-milestone-to-P2-stage mapping lives in
 * the agent_rules P2_MILESTONE_* family in the LP Supabase, which is what the
 * live decision engine actually executes. STAGE_MAP in src/actions/constants.js
 * is name→stageId only, and reversing it is ambiguous because legacy aliases
 * collide on one stage ID ('Financing Approved', 'Released to Production
 * (RTP)' and 'RTP' are all 375089e1). So the rules are read at run time, the
 * mapping is derived from them, and it is PRINTED AT THE TOP OF EVERY RUN.
 * A rule naming a stage STAGE_MAP does not know is a hard stop, not a skip:
 * that rule is broken and the run would be deciding from a partial mapping.
 *
 * src/milestone-order.js carries a hand-maintained mirror of the same mapping
 * for the live emit path. This script deliberately does NOT import it — a
 * repair pass reading a copy would repair the data to match the copy.
 *
 * ─── TERMINAL STATUS ──────────────────────────────────────────────────────
 * WON  : Paid In Full · PIF Survey Ready · PIF NO Survey · Assumed Complete
 * LOST : Cancelled · Cancelled By Mgt · Dead Deal · Sent To Attorney ·
 *        Credit Decline
 *
 * Everything else is in progress: derive a stage, leave the status open. One of
 * those is a decision rather than an omission, made 2026-08-31:
 *
 *   'Installed & Unpaid' (78 jobs / 61 contacts) — the work is done, the money
 *   is not collected. Its milestones carry it to Install Completed and it stays
 *   OPEN. It becomes won when a collected status is reached, not before;
 *   counting unpaid work as won overstates revenue.
 *
 *   'Credit Decline' (~345 jobs / ~179 contacts) MOVED to LOST 2026-09-18 —
 *   see LOST_JOB_STATUSES below. It keeps its own lost reason so recovery stays
 *   measurable, and it stays OUT of CANCELLED_JOB_STATUSES in
 *   src/lp-job-value.js, so a declined job still carries pipeline value and can
 *   still be the job an opportunity tracks.
 *
 * A LOST REASON IS NEVER INVENTED. GHL's built-in Lost Reason picker is a
 * configured list; an unrecognised string either fails the write or pollutes
 * loss reporting. Two ways to supply one, and a status with NEITHER is refused:
 *
 *   --lost-reason=     by NAME, matched case-insensitively against the list
 *                      fetched live. Correct, and currently unusable — see below.
 *   --lost-reason-id=  by ID, used verbatim. No GHL read, no validation beyond
 *                      the 24-hex shape. An id GHL rejects fails its own write.
 *
 * Both take the same grammar: one value for every lost status, or per-status
 * "Job Status=value" pairs. If both are given for one status the ID WINS and the
 * conflict is printed. The resolved status→id pairing is printed at the top of
 * every run, beside the milestone mapping.
 *
 * ─── THE LOST-REASON ENDPOINT IS BROKEN, HENCE --lost-reason-id ────────────
 * Both /opportunities/loss-reasons and /opportunities/loss-reason 404 with
 * OPPORTUNITY_NOT_FOUND for this location: GHL routes them as
 * /opportunities/{id} and reads the path segment as an opportunity id. The
 * reasons themselves exist and are correct — only the read path is wrong. That
 * is why the live 2026-09-18 pass refused all 336 losses while the stage and win
 * passes completed cleanly (89 moved, 1,186 won, 0 failed).
 *
 * The ids below were read from the GHL Lost Reasons UI and from live
 * `L.0 P1 Loss Marker` workflow config on 2026-09-18. They are the reference for
 * pairing --lost-reason-id until the endpoint is fixed:
 *
 *   Customer Cancelled        6aad8dc01f2de24d878ec356   ← post-contract
 *   Collections / Attorney    6aad8dc0f4cad9983ac319ce   ← post-contract
 *   Financing Denied          69cd48077ac164325a355e36
 *   Ghosted / Unresponsive    69cd4807e4ce65bc76877f98
 *   Price / Shopping          69cd4807e5a3aa0985aa450b
 *   Cannot Qualify            69cd512e10b2ee8d9ff36a73
 *   Invalid Lead              69cd512e626e00ee8a44f216
 *   Bad Fit (Preference)      69cd512e75a8ab28a34d4618
 *   Not Interested (Now)      69cd512e8bfe0935a0faa147
 *   Deferred / Timing         69cd512ee8fe3d35ae8bf6be
 *   Out of Service Area       69c55a4a362694f3cc77c898
 *   Wrong Product             69fd1c763b7ee1d776c26309
 *   DNC                       692a3a8e9205a42ce26af8da
 *   Home is Fully Protected   6927b4637752675528f642ff
 *
 * Only the first two were created for jobs that die AFTER the contract is
 * signed. Every other reason describes a pre-sale loss. Never substitute one for
 * a P2 job death — it says the sale never happened, and GHL keeps no history
 * that walks a lost reason back. The canonical status→reason mapping lives in
 * src/lp-lost-reasons.js and is shared with the action executor.
 *
 * TODO — fix this properly in HL-MCP/src/clients/ghl.ts `getLossReasons`, which
 * sends GET /opportunities/loss-reasons?locationId=… with no fallback and may
 * hold the working path. Follow-up, not this PR.
 *
 * ─── IDEMPOTENCE, AND WHY --apply RE-READS ────────────────────────────────
 * Candidates come from the HL mirror, which lags GHL. A second run planned from
 * the mirror alone would re-plan every move it just made. So in --apply mode
 * each record is re-read from GHL immediately before its write and the decision
 * is re-made against LIVE stage and status; anything already reconciled, or
 * moved by someone else in the meantime, is counted as `already live` and
 * skipped. That also puts the forward-only guard on live state, which is what
 * the 2026-08-16 replay incident in src/milestone-order.js was about.
 *
 * ─── ROLLBACK ─────────────────────────────────────────────────────────────
 * GHL keeps no stage history you can query back, so the log IS the rollback.
 * Every planned and every applied write is appended as one JSON object per line
 * to <log-dir>/reconcile-p2-stages-<timestamp>.jsonl carrying the opportunity
 * id, its PREVIOUS stage id and its PREVIOUS status. A prior run's file is
 * never overwritten — the timestamp is in the name. The path is stated in the
 * summary.
 *
 * Usage:
 *   node scripts/reconcile-p2-stages.js                      # dry run, everything
 *   node scripts/reconcile-p2-stages.js --fields=stage --limit=25 --apply
 *   node scripts/reconcile-p2-stages.js --fields=status --lost-reason-id="..." --apply
 *
 *   # the full pairing for every lost status (2026-09-18):
 *   node scripts/reconcile-p2-stages.js --fields=status --apply --lost-reason-id=\
 *     "Cancelled=6aad8dc01f2de24d878ec356,\
 *      Cancelled By Mgt=6aad8dc01f2de24d878ec356,\
 *      Dead Deal=69cd4807e4ce65bc76877f98,\
 *      Sent To Attorney=6aad8dc0f4cad9983ac319ce,\
 *      Credit Decline=69cd48077ac164325a355e36"
 *
 *   --apply            Actually write. Without it nothing is sent to GHL.
 *   --dry-run          Force dry run even alongside --apply.
 *   --limit=N          Cap the records this run ACTS on (25 means 25 writes).
 *   --pipeline=NAME    P2 only.
 *   --fields=a,b       Any of: stage, status (default both). Stage moves and
 *                      terminal statuses run separately for the phased rollout.
 *   --lost-reason=X    Either one reason NAME for every lost job status, or
 *                      comma-separated "Job Status=Reason Name" pairs. Needs the
 *                      live list, which currently 404s — prefer --lost-reason-id.
 *   --lost-reason-id=X Same grammar, but GHL lost reason IDS. Skips the lookup
 *                      entirely. Wins over --lost-reason for the same status.
 *   --log-dir=PATH     Where the .jsonl rollback log goes (default ./p2-reconcile).
 *
 * Environment (already set on the LP-MCP Railway service — this script does not
 * load .env, so run it under `railway run --service LP-MCP --`):
 *   GHL_API_KEY, HL_SUPABASE_URL, HL_SUPABASE_SERVICE_ROLE_KEY,
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { ghlFetch } from '../src/actions/helpers.js';
import { PIPELINE_IDS, STAGE_MAP, GHL_LOCATION_ID } from '../src/actions/constants.js';
import { checkForwardOnly, getStagePosition } from '../src/pipeline-guard.js';
import { hlRunSQL } from '../src/admin/hl-client.js';
import { latestJob } from '../src/lp-job-value.js';
import { readOppJobId } from '../src/p2-opportunity-context.js';
import {
  JOB_STATUS_LOST_REASON, isLostReasonId, lostReasonIdForJobStatus,
} from '../src/lp-lost-reasons.js';
import { selectAllIn, assertComplete } from '../src/supabase-page.js';
import supabase from '../src/supabase.js';
import { WON_JOB_STATUSES, LOST_JOB_STATUSES } from '../src/lp-job-terminal.js';

// ═══════════════════════════════════════════════════════════════════
// PURE — the decision surface. Everything below the fold is I/O.
// ═══════════════════════════════════════════════════════════════════

/**
 * Job statuses that mean the job finished and the money was collected.
 *
 * 'Installed & Unpaid' is NOT here, deliberately: the work is done, the money
 * is not. Its milestones carry it to Install Completed and it stays open.
 */
// Moved to src/lp-job-terminal.js 2026-09-21 so the live create guard shares it.
// Re-exported: scripts/test-reconcile-p2-stages.js imports it from here.
export { WON_JOB_STATUSES };

/**
 * Job statuses that mean the job died.
 *
 * NOTE the overlap with CANCELLED_JOB_STATUSES in src/lp-job-value.js: three of
 * these are in both. That is not redundancy. There, they exclude a job from being
 * SELECTED (a cancelled job never decides a live opportunity); here, they decide
 * the verdict for a contact who has nothing else.
 *
 * 'Credit Decline' ADDED 2026-09-18 (Mark).
 * -----------------------------------------
 * Previously excluded because nobody had measured how often a declined deal is
 * reworked and recovered, and marking lost is irreversible. That objection is
 * resolved by giving it its OWN lost reason — "Financing Denied"
 * (69cd48077ac164325a355e36) — rather than folding it in with cancellations.
 * Recovery rate becomes measurable after the fact by querying lost opportunities
 * by reason.
 *
 * ~345 jobs / ~179 contacts. It remains OUT of CANCELLED_JOB_STATUSES in
 * src/lp-job-value.js, so a declined job is still SELECTABLE and still carries
 * pipeline value — only the verdict changes. A contact with a newer live job is
 * unaffected: latestJob() picks the newer one and it decides.
 *
 * 'Sent To Attorney' stays: 40 jobs across 5 contacts, and a deal in
 * collections is not a deal in progress.
 */
// Moved to src/lp-job-terminal.js 2026-09-21. Re-exported for the test.
export { LOST_JOB_STATUSES };

const trimmed = (s) => (typeof s === 'string' ? s.trim() : '');

/**
 * Derive mdt_id → P2 stage from the agent_rules P2_MILESTONE_* family.
 *
 * Pure: takes the rows, returns the mapping and the problems. The caller reads
 * the database and decides what to do about a problem — this makes the
 * derivation, which is the part that can silently be wrong, unit-testable.
 *
 * A rule contributes only if it is a move_opportunity into pipeline P2 whose
 * stage name resolves through STAGE_MAP to a stage the forward-only guard knows
 * a position for. Anything else is a `problem`, never a guess.
 *
 * Two rules may legitimately target the same stage (H, U and P all target
 * Permitting & HOA). Two rules for the SAME mdt_id are a conflict and are
 * reported, because then nothing here can say what that milestone means.
 *
 * @param {Array<{rule_key: string, event_pattern: object, action_template: object}>} rules
 * @returns {{mapping: Record<string, {stageId: string, stageName: string, position: number, ruleKey: string}>, problems: Array<{ruleKey: string, reason: string, detail?: string}>}}
 */
export function buildMilestoneStageMap(rules = []) {
  const mapping = {};
  const problems = [];

  for (const rule of rules) {
    const ruleKey = rule?.rule_key || '(unnamed rule)';
    const mdtId = trimmed(rule?.event_pattern?.payload?.mdt_id);
    if (!mdtId) {
      problems.push({ ruleKey, reason: 'no_mdt_id' });
      continue;
    }

    const actions = Array.isArray(rule?.action_template) ? rule.action_template : [];
    const move = actions.find(
      (a) => a?.action_type === 'move_opportunity' && a?.params?.pipeline === 'P2',
    );
    if (!move) {
      // A milestone rule that only tags is not a mapping. O/V/E/X are exactly
      // that by design, and they never reach here because they have no rule.
      problems.push({ ruleKey, reason: 'no_p2_move_action', detail: mdtId });
      continue;
    }

    const stageName = trimmed(move.params?.stage);
    const stageId = STAGE_MAP[stageName];
    if (!stageId) {
      // Hard problem. The live engine would fail this rule with "Unknown stage"
      // too — see the P2_MILESTONE_RTP notes — so the rule is broken, and a
      // mapping missing one stage would silently under-reconcile.
      problems.push({ ruleKey, reason: 'unknown_stage_name', detail: stageName || '(empty)' });
      continue;
    }

    const position = getStagePosition(stageId);
    if (position === null) {
      problems.push({ ruleKey, reason: 'stage_has_no_position', detail: `${stageName} ${stageId}` });
      continue;
    }

    const existing = mapping[mdtId];
    if (existing && existing.stageId !== stageId) {
      problems.push({
        ruleKey,
        reason: 'conflicting_rules_for_mdt',
        detail: `${mdtId}: ${existing.ruleKey} → ${existing.stageName}, ${ruleKey} → ${stageName}`,
      });
      continue;
    }
    mapping[mdtId] = { stageId, stageName, position, ruleKey };
  }

  return { mapping, problems };
}

/**
 * The furthest-along stage the job's COMPLETED milestones justify.
 *
 * "Completed" is act_date IS NOT NULL. lp_job_milestones carries a row for
 * every milestone type on every job whether or not it has happened — 5,898 rows
 * per type — so row existence means nothing and only the actual date does.
 *
 * Furthest-along is by STAGE POSITION, not by date. LP milestones do not arrive
 * in stage order: Ordered lands +10d from RTP and targets position 4, while
 * Permit Issued lands +21d and targets position 3 (see src/pipeline-guard.js).
 * Ranking by act_date would pick the wrong winner, which is the same reasoning
 * as selectFurthestMilestone in src/milestone-order.js.
 *
 * @param {Array<{mdt_id?: string, act_date?: string|null}>} milestones
 * @param {Record<string, {stageId: string, position: number}>} mapping
 * @returns {{target: object|null, completed: number, unmapped: string[]}}
 */
export function derivedStageFromMilestones(milestones = [], mapping = {}) {
  let target = null;
  let completed = 0;
  const unmapped = new Set();

  for (const m of milestones) {
    if (!m || !m.act_date) continue;
    completed++;
    const mdtId = trimmed(m.mdt_id);
    const hit = mapping[mdtId];
    if (!hit) { unmapped.add(mdtId || '(blank)'); continue; }
    if (target === null || hit.position > target.position) target = { ...hit, mdtId };
  }

  return { target, completed, unmapped: [...unmapped].sort() };
}

/**
 * What should happen to ONE opportunity, given its contact's full job list.
 *
 * Pure — no DB, no clock, no network — and exported so every branch has unit
 * coverage. The write loop below reads as a dispatch on the verdict rather than
 * a nest of conditions, and a regression in the newest-job rule fails a test
 * instead of quietly closing a live job as won.
 *
 * It takes the contact's WHOLE job list rather than a pre-selected job on
 * purpose. Picking the job IS the decision that matters most here — a 2024 Paid
 * In Full job alongside a 2026 in-production one is the case that closes live
 * work — so the pick belongs inside the tested boundary, not in the caller.
 *
 * ORDER MATTERS:
 *   1. no LP job at all      → skip_no_job, reported and never touched. Decided
 *                              FIRST so a contact with no job is reported as
 *                              the basic problem rather than as an unmapped
 *                              milestone we would have moved if only it mapped.
 *   2. every job cancelled   → lose. Not the same thing as (1): there ARE LP
 *                              records and they all say the job died.
 *   3. latest job is won/lost by job_status → win / lose, stage left alone.
 *   4. otherwise derive a stage from that ONE job's completed milestones and
 *      put it through the forward-only guard.
 *
 * @param {object} args
 * @param {string} args.currentStageId  the opportunity's stage RIGHT NOW
 * @param {Array<object>} args.jobs     every lp_jobs row for the contact, each
 *                                      optionally carrying `milestones`
 * @param {Record<string, object>} args.mapping  from buildMilestoneStageMap
 * @returns {{verdict: string, job: object|null, targetStageId: string|null,
 *            targetStageName: string|null, jobStatus: string|null,
 *            unmappedMdtIds: string[], completedMilestones: number,
 *            detail: string}}
 */
export function stageDecision({ currentStageId, jobs = [], mapping = {}, trackedJobId = null } = {}) {
  const base = {
    job: null,
    targetStageId: null,
    targetStageName: null,
    jobStatus: null,
    unmappedMdtIds: [],
    completedMilestones: 0,
    detail: '',
  };
  const rows = (jobs || []).filter(Boolean);

  // 1. No LP job record at all. Out of scope by decision — see the header.
  if (rows.length === 0) {
    return { ...base, verdict: 'skip_no_job', detail: 'contact has no lp_jobs row' };
  }

  // 1b. The opportunity SAYS which job it tracks (2026-09-21, the LP Job ID
  //     custom field). That beats every heuristic below: a repeat customer's
  //     2024 Paid In Full opportunity must close won on ITS job, not stay open
  //     because a newer job is still in production. When the stamped id names a
  //     job we did not read, fall through and behave exactly as before rather
  //     than refusing — a stamp we cannot resolve is no worse than no stamp.
  const tracked = trackedJobId == null
    ? null
    : rows.find((r) => String(r.lp_job_id) === String(trackedJobId)) || null;
  if (tracked) {
    const trackedStatus = trimmed(tracked.job_status);
    const withTracked = { ...base, job: tracked, jobStatus: trackedStatus };
    if (WON_JOB_STATUSES.has(trackedStatus)) {
      return { ...withTracked, verdict: 'win', detail: `tracked job ${tracked.lp_job_id} is "${trackedStatus}"` };
    }
    if (LOST_JOB_STATUSES.has(trackedStatus)) {
      return { ...withTracked, verdict: 'lose', detail: `tracked job ${tracked.lp_job_id} is "${trackedStatus}"` };
    }
    return stageFromJob(tracked, { currentStageId, mapping, base });
  }

  // 2. Jobs exist but every one of them is cancelled or dead. latestJob()
  //    filters those before picking, so it would answer null here — which is
  //    indistinguishable from (1) unless we look at the raw list first.
  const job = latestJob(rows);
  if (job === null) {
    const newest = rows.reduce((a, b) => (jobIdOf(b) > jobIdOf(a) ? b : a), rows[0]);
    const status = trimmed(newest.job_status);
    return {
      ...base,
      verdict: 'lose',
      job: newest,
      jobStatus: status,
      detail: `all ${rows.length} job(s) cancelled/dead, newest is "${status || '(blank)'}"`,
    };
  }

  const jobStatus = trimmed(job.job_status);
  const withJob = { ...base, job, jobStatus };

  // 3. The one job that decides this opportunity has reached a terminal status.
  if (WON_JOB_STATUSES.has(jobStatus)) {
    return { ...withJob, verdict: 'win', detail: `job ${job.lp_job_id} is "${jobStatus}"` };
  }
  if (LOST_JOB_STATUSES.has(jobStatus)) {
    return { ...withJob, verdict: 'lose', detail: `job ${job.lp_job_id} is "${jobStatus}"` };
  }

  // 4. In progress. Derive a stage from THAT job's completed milestones.
  return stageFromJob(job, { currentStageId, mapping, base });
}

/**
 * Phase 2 of stageDecision: one in-progress job, its milestones, the guard.
 *
 * Extracted 2026-09-21 so the stamped-job path and the latestJob() path run the
 * SAME derivation. Two copies of this would be two chances to disagree about
 * what a milestone means, and the disagreement would only surface on the repeat
 * customers this whole change exists to get right.
 */
function stageFromJob(job, { currentStageId, mapping, base }) {
  const withJob = { ...base, job, jobStatus: trimmed(job.job_status) };
  const { target, completed, unmapped } = derivedStageFromMilestones(job.milestones || [], mapping);
  const withMilestones = { ...withJob, completedMilestones: completed, unmappedMdtIds: unmapped };

  if (target === null) {
    if (completed > 0) {
      // Every completed milestone on this job is one no P2_MILESTONE_* rule
      // covers. Nothing here can say what stage that means, so it is reported
      // rather than defaulted to a stage.
      return {
        ...withMilestones,
        verdict: 'skip_unmapped_milestone',
        detail: `job ${job.lp_job_id}: completed milestones ${unmapped.join(',')} have no P2 rule`,
      };
    }
    // No completed milestone at all: LP asserts nothing has happened past
    // contract signature, which is where this cohort already sits. Nothing to
    // change, and nothing wrong — it is not evidence of a defect.
    return {
      ...withMilestones,
      verdict: 'skip_already_correct',
      detail: `job ${job.lp_job_id} has no completed milestone`,
    };
  }

  const withTarget = {
    ...withMilestones,
    targetStageId: target.stageId,
    targetStageName: target.stageName,
  };

  // Refuse to reason about a stage the guard has no position for, rather than
  // taking checkForwardOnly's allow-on-unknown default. Every mapping target is
  // validated at startup, so this only fires on an opportunity sitting outside
  // the pipeline's known stages — where a blind move is the worst answer.
  if (getStagePosition(currentStageId) === null) {
    return {
      ...withTarget,
      verdict: 'skip_not_forward',
      detail: `current stage ${currentStageId} has no known position`,
    };
  }

  const guard = checkForwardOnly(currentStageId, target.stageId);
  if (guard.reason === 'already_at_target_stage') {
    return { ...withTarget, verdict: 'skip_already_correct', detail: `already at ${target.stageName}` };
  }
  if (!guard.allowed) {
    return {
      ...withTarget,
      verdict: 'skip_not_forward',
      detail: `${target.stageName} (${guard.targetPos}) is behind current position ${guard.currentPos}`,
    };
  }
  return {
    ...withTarget,
    verdict: 'move',
    detail: `${target.mdtId} → ${target.stageName} (position ${guard.currentPos} → ${guard.targetPos})`,
  };
}

/** Numeric lp_job_id for the newest-of-all pick; blank and non-numeric rank lowest. */
function jobIdOf(job) {
  const n = Number(String(job?.lp_job_id ?? '').trim());
  return Number.isFinite(n) ? n : -Infinity;
}

/**
 * Parse --lost-reason=. Either one reason for everything, or per-status pairs.
 *
 *   --lost-reason="Customer Cancelled"
 *   --lost-reason="Cancelled=Customer Cancelled,Credit Decline=Financing Denied"
 *
 * Pure so the parsing has coverage: a mis-parsed pair would silently fall back
 * to a default reason and mislabel every loss of that status.
 */
export function parseLostReasonArg(raw) {
  const spec = { fallback: null, byStatus: {} };
  const text = trimmed(raw);
  if (!text) return spec;
  if (!text.includes('=')) { spec.fallback = text; return spec; }
  for (const part of text.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) { spec.fallback = trimmed(part) || spec.fallback; continue; }
    const status = trimmed(part.slice(0, idx));
    const reason = trimmed(part.slice(idx + 1));
    if (status && reason) spec.byStatus[status] = reason;
  }
  return spec;
}

/**
 * The configured Lost Reason for a job status, resolved against the list GHL
 * actually holds. Returns {id, name} or {error} — never a guessed string.
 */
export function resolveLostReason(jobStatus, spec, reasons = []) {
  const wanted = spec?.byStatus?.[trimmed(jobStatus)] || spec?.fallback || null;
  if (!wanted) return { error: `no --lost-reason configured for job status "${jobStatus}"` };
  const hit = reasons.find((r) => trimmed(r?.name).toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    return {
      error: `lost reason "${wanted}" is not configured in GHL `
        + `(have: ${reasons.map((r) => r?.name).filter(Boolean).join(' · ') || 'none'})`,
    };
  }
  return { id: hit.id, name: hit.name };
}

/**
 * Parse --lost-reason-id=. Same grammar as --lost-reason, but the values are GHL
 * lost reason IDS rather than names, so nothing has to be looked up:
 *
 *   --lost-reason-id="6aad8dc01f2de24d878ec356"
 *   --lost-reason-id="Cancelled=6aad8dc01f2de24d878ec356,Credit Decline=69cd48077ac164325a355e36"
 *
 * Added 2026-09-18 because the name path cannot work: GHL's lost-reason
 * collection endpoint 404s as OPPORTUNITY_NOT_FOUND for this location (it routes
 * /opportunities/loss-reasons as /opportunities/{id}), so resolveLostReason has
 * no list to match a name against and every loss is refused. 336 of them, on the
 * live 2026-09-18 pass.
 *
 * Reuses parseLostReasonArg for the grammar rather than restating it — a second
 * parser is a second set of edge cases, and this one has coverage.
 *
 * Shape is validated HERE, at parse time, not at write time: a malformed id is a
 * typo and catching it before a run starts is free, whereas an id GHL rejects
 * fails its own write and is counted as `failed`, which is correct. Returns the
 * problems rather than exiting, because this module is imported by
 * scripts/test-reconcile-p2-stages.js and a process.exit at module scope would
 * kill the test run.
 *
 * @param {string} raw
 * @returns {{spec: {fallback: string|null, byStatus: Object}, problems: Array<{status: string|null, value: string, reason: string}>}}
 */
export function parseLostReasonIdArg(raw) {
  const parsed = parseLostReasonArg(raw);
  const spec = { fallback: null, byStatus: {} };
  const problems = [];
  if (parsed.fallback !== null) {
    if (isLostReasonId(parsed.fallback)) spec.fallback = trimmed(parsed.fallback);
    else problems.push({ status: null, value: parsed.fallback, reason: 'not_a_24_char_hex_id' });
  }
  for (const [status, value] of Object.entries(parsed.byStatus)) {
    if (isLostReasonId(value)) spec.byStatus[status] = trimmed(value);
    else problems.push({ status, value, reason: 'not_a_24_char_hex_id' });
  }
  return { spec, problems };
}

/**
 * The Lost Reason to close a job of this status with. One resolver, two sources.
 *
 * An ID supplied for the status WINS and skips the name lookup entirely — no GHL
 * read, no validation against a list that cannot be fetched. That is the whole
 * point of the flag. When a name was ALSO configured for the same status the id
 * still wins and a `warning` is returned so the run prints the conflict rather
 * than silently picking one.
 *
 * A status with NEITHER still returns {error}. That refusal is correct and must
 * not be softened into a default: guessing a reason writes an irreversible lie
 * into loss reporting, and a refused loss can always be re-run.
 *
 * `mismatch` is advisory only — an id that disagrees with the canonical mapping
 * in src/lp-lost-reasons.js is reported so a bad pairing is visible before any
 * write, but it does NOT block: the table is a copy of GHL's config, and if the
 * two ever disagree the operator on the command line is the one who just read
 * the UI.
 *
 * @returns {{id: string, name: string|null, source: 'id'|'name', warning?: string, mismatch?: string}|{error: string}}
 */
export function resolveLostReasonForStatus(jobStatus, { idSpec, nameSpec, reasons = [] } = {}) {
  const status = trimmed(jobStatus);
  const byId = idSpec?.byStatus?.[status] || idSpec?.fallback || null;
  if (byId) {
    const out = { id: byId, name: null, source: 'id' };
    const alsoNamed = nameSpec?.byStatus?.[status] || nameSpec?.fallback || null;
    if (alsoNamed) {
      out.warning = `both --lost-reason-id and --lost-reason given for "${status}" — `
        + `using the id ${byId}, ignoring the name "${alsoNamed}"`;
    }
    const canonicalId = lostReasonIdForJobStatus(status);
    const canonicalName = JOB_STATUS_LOST_REASON[status] || null;
    if (canonicalId && canonicalId !== byId) {
      out.mismatch = `id ${byId} for "${status}" is not the mapped `
        + `"${canonicalName}" (${canonicalId}) — see src/lp-lost-reasons.js`;
    } else if (canonicalName) {
      out.name = canonicalName;
    }
    return out;
  }
  const byName = resolveLostReason(status, nameSpec, reasons);
  if (byName.error) return byName;
  return { ...byName, source: 'name' };
}

/** GHL has answered this collection as three different shapes over time. */
export function normalizeLostReasons(payload) {
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.lossReasons) ? payload.lossReasons
    : Array.isArray(payload?.lostReasons) ? payload.lostReasons
    : Array.isArray(payload?.data) ? payload.data
    : [];
  return list
    .map((r) => ({ id: r?.id ?? r?._id ?? null, name: trimmed(r?.name) }))
    .filter((r) => r.id && r.name);
}

// ═══════════════════════════════════════════════════════════════════
// I/O — nothing below here is imported by the tests.
// ═══════════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const stringArg = (name, fallback = '') => {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? fallback : found.slice(name.length + 3);
};
const numericArg = (name, fallback) => {
  const n = parseInt(stringArg(name, ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

const ALL_FIELDS = ['stage', 'status'];
const fields = (stringArg('fields', '') || ALL_FIELDS.join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
const unknownField = fields.find((f) => !ALL_FIELDS.includes(f));
if (unknownField) {
  console.error(`[P2Reconcile] Unknown --fields entry "${unknownField}" — known: ${ALL_FIELDS.join(', ')}`);
  process.exit(1);
}

const opt = {
  // Dry run is the DEFAULT, not a flag anyone has to remember. --dry-run is
  // still accepted so an old invocation cannot suddenly start writing.
  apply:      args.includes('--apply') && !args.includes('--dry-run'),
  limit:      numericArg('limit', 0),
  pipeline:   stringArg('pipeline', 'P2'),
  logDir:     stringArg('log-dir', 'p2-reconcile'),
  lostReason: parseLostReasonArg(stringArg('lost-reason', '')),
  // Parsed, never validated-and-exited here: this block runs at IMPORT, and
  // scripts/test-reconcile-p2-stages.js imports the module. Problems are
  // reported inside main(), which only runs when invoked directly.
  lostReasonId: parseLostReasonIdArg(stringArg('lost-reason-id', '')),
  doStage:    fields.includes('stage'),
  doStatus:   fields.includes('status'),
};

if (opt.pipeline !== 'P2') {
  // Not a lookup failure — a scope refusal. P1 and P3 stages mean different
  // things and no part of this mapping applies to them.
  console.error(`[P2Reconcile] --pipeline=${opt.pipeline} refused. This script is P2-only by design; P1 and P3 have different stage semantics.`);
  process.exit(1);
}
const pipelineId = PIPELINE_IDS.P2;
const CONTRACT_SIGNED = STAGE_MAP['Contract Signed'];

/** The P2 stage label for a stage id, for readable output. */
const STAGE_LABELS = Object.entries(STAGE_MAP).reduce((acc, [name, id]) => {
  const pos = getStagePosition(id);
  if (pos !== null && !acc[id]) acc[id] = name;
  return acc;
}, {});
const label = (stageId) => STAGE_LABELS[stageId] || stageId || '(none)';

async function loadMilestoneMapping() {
  const { data, error, count } = await supabase
    .from('agent_rules')
    .select('rule_key, rule_name, enabled, event_pattern, action_template', { count: 'exact' })
    .like('rule_key', 'P2_MILESTONE%')
    .eq('enabled', true);
  if (error) throw new Error(`agent_rules read failed: ${error.message}`);
  // A dozen rows today, so paging is overkill — but a partial mapping
  // under-reconciles in total silence, which is the one outcome worth a cheap
  // assertion. If this family ever outgrows the cap, this throws.
  assertComplete('agent_rules', data || [], count);
  return buildMilestoneStageMap(data || []);
}

/** Open P2 opportunities, from the HL mirror rather than paging GHL. */
async function fetchCandidates() {
  const rows = await hlRunSQL(`
    SELECT o.ghl_opportunity_id, o.ghl_contact_id, o.ghl_stage_id, o.status, o.name, o.custom_fields
      FROM opportunities o
     WHERE o.ghl_pipeline_id = '${pipelineId}'
       AND o.ghl_contact_id IS NOT NULL
       AND o.deleted_at IS NULL
       AND o.status = 'open'
     ORDER BY o.ghl_opportunity_id
  `);

  // hlRunSQL goes through the run_sql RPC, which returns one json value and is
  // NOT subject to the PostgREST row cap that src/supabase-page.js exists to
  // defeat — demonstrated by this very query returning 2,453 rows. That is a
  // property of the transport, though, not a guarantee anyone wrote down, so it
  // is checked rather than assumed: an independent COUNT(*) over the same
  // predicate must agree with what arrived.
  const [{ n } = {}] = await hlRunSQL(`
    SELECT count(*) AS n
      FROM opportunities o
     WHERE o.ghl_pipeline_id = '${pipelineId}'
       AND o.ghl_contact_id IS NOT NULL
       AND o.deleted_at IS NULL
       AND o.status = 'open'
  `);
  const expected = Number(n);
  if (Number.isFinite(expected) && (rows || []).length !== expected) {
    throw new Error(
      `HL opportunities read incomplete: got ${(rows || []).length} of ${expected}. `
      + 'Refusing to reconcile from a partial candidate set.',
    );
  }
  return rows || [];
}

/** contact id → their lp_jobs rows, each with its completed milestones attached. */
async function fetchJobsWithMilestones(contactIds) {
  const byContact = new Map();
  const byJobId = new Map();

  const jobRows = await selectAllIn(supabase, 'lp_jobs', {
    columns: 'id, ghl_contact_id, lp_job_id, lp_lead_id, job_status, job_value',
    orderBy: 'id',
    column: 'ghl_contact_id',
    values: contactIds,
  });
  for (const row of jobRows) {
    const job = { ...row, milestones: [] };
    if (!byContact.has(row.ghl_contact_id)) byContact.set(row.ghl_contact_id, []);
    byContact.get(row.ghl_contact_id).push(job);
    byJobId.set(String(row.lp_job_id), job);
  }

  // 2026-09-21 — the same blind spot src/lp-job-value.js#jobsForContact closes.
  // 29 lp_jobs rows carry a NULL ghl_contact_id while their parent lp_lead IS
  // linked (link_source prospect_propagated). The read above finds none of them,
  // so those contacts were reported "no LP job" here and their P2 opportunities
  // were created with no value. Attach each such job to the contact that owns its
  // LEAD — never to the job row's own null — and dedupe on lp_job_id so a job
  // reachable both ways is counted once.
  const leadRows = await selectAllIn(supabase, 'lp_leads', {
    columns: 'id, lp_lead_id, ghl_contact_id',
    orderBy: 'id',
    column: 'ghl_contact_id',
    values: contactIds,
  });
  const contactByLeadId = new Map();
  for (const lead of leadRows) {
    if (lead.lp_lead_id != null) contactByLeadId.set(String(lead.lp_lead_id), lead.ghl_contact_id);
  }
  let viaLeadCount = 0;
  if (contactByLeadId.size) {
    const leadLinkedJobs = await selectAllIn(supabase, 'lp_jobs', {
      columns: 'id, ghl_contact_id, lp_job_id, lp_lead_id, job_status, job_value',
      orderBy: 'id',
      column: 'lp_lead_id',
      values: [...contactByLeadId.keys()],
    });
    for (const row of leadLinkedJobs) {
      if (byJobId.has(String(row.lp_job_id))) continue;
      const ownerContactId = contactByLeadId.get(String(row.lp_lead_id));
      if (!ownerContactId) continue;
      const job = { ...row, milestones: [] };
      if (!byContact.has(ownerContactId)) byContact.set(ownerContactId, []);
      byContact.get(ownerContactId).push(job);
      byJobId.set(String(row.lp_job_id), job);
      viaLeadCount++;
    }
  }

  // Only COMPLETED milestones matter — lp_job_milestones holds a row per
  // milestone type per job whether or not it happened (5,898 rows per type), so
  // act_date is the whole signal. Filtered server-side so the pages carry only
  // rows that can decide something.
  const milestoneRows = await selectAllIn(supabase, 'lp_job_milestones', {
    columns: 'id, lp_job_id, mdt_id, act_date',
    orderBy: 'id',
    column: 'lp_job_id',
    values: [...byJobId.keys()],
    refine: (q) => q.not('act_date', 'is', null),
  });
  for (const row of milestoneRows) byJobId.get(String(row.lp_job_id))?.milestones.push(row);

  return {
    byContact, jobCount: byJobId.size, milestoneCount: milestoneRows.length, viaLeadCount,
  };
}

/**
 * The location's configured Lost Reasons, live. Best-effort in a dry run: a
 * dry run that cannot reach GHL must still produce a plan, and the list is
 * only REQUIRED at write time.
 */
async function fetchLostReasons() {
  // GHL has documented both the plural and singular paths at different times
  // (see getLossReasons in HL-MCP/src/clients/ghl.ts), and the plural one has
  // been observed 404ing as OPPORTUNITY_NOT_FOUND — it routes as
  // /opportunities/{id}. Try both before giving up.
  const paths = [
    `/opportunities/loss-reasons?locationId=${GHL_LOCATION_ID}`,
    `/opportunities/loss-reason?locationId=${GHL_LOCATION_ID}`,
  ];
  const errors = [];
  for (const p of paths) {
    try {
      const list = normalizeLostReasons(await ghlFetch('GET', p));
      if (list.length) return { reasons: list, error: null };
      errors.push(`${p} → empty`);
    } catch (err) {
      errors.push(`${p} → ${err.message}`);
    }
  }
  return { reasons: [], error: errors.join(' | ') };
}

/** The opportunity as GHL holds it right now, or null when it cannot be read. */
async function readLiveOpportunity(opportunityId) {
  const res = await ghlFetch('GET', `/opportunities/${opportunityId}`);
  const o = res?.opportunity || res;
  if (!o || !o.id) return null;
  // 2026-09-21 — the tracked LP job comes from THIS live read, not from the HL
  // mirror. The mirror does carry opportunity custom fields, but it LAGS GHL by
  // up to one sync: opp Ua0Q6GSBpEV9LmAowXX0 was stamped in GHL at 20:12Z and
  // the mirror only caught up at 20:22Z. A stage decision made from inside that
  // window is a decision about the wrong job, and this read is already being
  // issued per candidate before every write — so it costs nothing to be right.
  return { stageId: o.pipelineStageId, status: o.status, trackedJobId: readOppJobId(o) };
}

function openLog() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(opt.logDir, { recursive: true });
  const file = path.join(opt.logDir, `reconcile-p2-stages-${stamp}.jsonl`);
  const stream = fs.createWriteStream(file, { flags: 'a' });
  return {
    file,
    write(record) { stream.write(`${JSON.stringify(record)}\n`); },
    close() { return new Promise((resolve) => stream.end(resolve)); },
  };
}

async function main() {
  console.log(`[P2Reconcile] pipeline P2 (${pipelineId}) — ${opt.apply ? 'APPLYING' : 'DRY RUN (no writes)'}`);
  console.log(`[P2Reconcile] fields: ${fields.join(', ')} — open opportunities only`);

  // ─── the mapping, printed before anything is decided from it ───────────
  const { mapping, problems } = await loadMilestoneMapping();
  console.log('\n─── milestone → P2 stage, derived from agent_rules ────────────');
  const mdtIds = Object.keys(mapping).sort();
  for (const mdtId of mdtIds) {
    const m = mapping[mdtId];
    console.log(`  ${mdtId.padEnd(3)} → ${String(m.position).padStart(1)} ${m.stageName.padEnd(30)} ${m.stageId}  (${m.ruleKey})`);
  }
  if (problems.length) {
    console.log('\n  PROBLEMS in the rule family:');
    for (const p of problems) console.log(`    ${p.ruleKey}: ${p.reason}${p.detail ? ` — ${p.detail}` : ''}`);
  }
  const fatal = problems.filter((p) => p.reason === 'unknown_stage_name'
    || p.reason === 'stage_has_no_position' || p.reason === 'conflicting_rules_for_mdt');
  if (fatal.length) {
    console.error('\n[P2Reconcile] REFUSING TO RUN — the mapping above is incomplete or contradictory.');
    console.error('A partial mapping under-reconciles silently. Fix the agent_rule, then re-run.');
    process.exit(1);
  }
  if (mdtIds.length === 0) {
    console.error('\n[P2Reconcile] REFUSING TO RUN — no enabled P2_MILESTONE_* rule produced a mapping.');
    process.exit(1);
  }

  // ─── lost reasons, before anything is planned as a loss ────────────────
  let lostReasons = [];
  let lostReasonError = null;
  if (opt.doStatus) {
    // A malformed --lost-reason-id is fatal, and it is fatal HERE rather than at
    // module scope so importing this file for its pure helpers never exits.
    if (opt.lostReasonId.problems.length) {
      for (const p of opt.lostReasonId.problems) {
        console.error(
          `[P2Reconcile] --lost-reason-id: "${p.value}"`
          + `${p.status ? ` (for "${p.status}")` : ''} is not a 24-character hex id`,
        );
      }
      process.exit(1);
    }

    // Skip the GHL read entirely when ids already cover every lost status. The
    // endpoint 404s for this location anyway (see fetchLostReasons), and a run
    // that needs nothing from it should not wait on it or print its failure.
    const idSpec = opt.lostReasonId.spec;
    const idsCoverEverything = Boolean(idSpec.fallback)
      || [...LOST_JOB_STATUSES].every((st) => Boolean(idSpec.byStatus[st]));
    if (idsCoverEverything) {
      console.log('\n─── GHL configured Lost Reasons ───────────────────────────────');
      console.log('  not read — --lost-reason-id covers every lost job status.');
    } else {
      ({ reasons: lostReasons, error: lostReasonError } = await fetchLostReasons());
      console.log('\n─── GHL configured Lost Reasons ───────────────────────────────');
      if (lostReasons.length) {
        for (const r of lostReasons) console.log(`  ${r.id}  ${r.name}`);
      } else {
        console.log(`  could not read them: ${lostReasonError}`);
        console.log('  A loss cannot be written without one. Losses will be PLANNED and REFUSED.');
      }
    }

    // ─── the status → lost reason pairing, printed before any write ──────
    // Beside the milestone mapping, and for the same reason: a bad pairing is
    // an irreversible mislabel on every loss of that status, and the only
    // moment it is cheap to catch is before the run starts.
    console.log('\n─── lost reason per job status ────────────────────────────────');
    for (const st of [...LOST_JOB_STATUSES].sort()) {
      const r = resolveLostReasonForStatus(st, { idSpec, nameSpec: opt.lostReason, reasons: lostReasons });
      if (r.error) {
        console.log(`  ${st.padEnd(18)} REFUSED — ${r.error}`);
        continue;
      }
      console.log(`  ${st.padEnd(18)} ${r.id}  ${(r.name || '(name not resolved)').padEnd(24)} [from --lost-reason${r.source === 'id' ? '-id' : ''}]`);
      if (r.warning) console.log(`  ${''.padEnd(18)} ⚠️  ${r.warning}`);
      if (r.mismatch) console.log(`  ${''.padEnd(18)} ⚠️  ${r.mismatch}`);
    }
  }

  // ─── candidates ────────────────────────────────────────────────────────
  // Every open P2 opportunity is classified, whatever --limit says: the limit
  // caps ACTIONS, not the sweep, so the no-job list and the summary stay
  // complete on a capped run and the canary still writes the 25 it promises.
  const candidates = await fetchCandidates();
  const atContractSigned = candidates.filter((c) => c.ghl_stage_id === CONTRACT_SIGNED).length;
  console.log(`\n[P2Reconcile] ${candidates.length} open P2 opportunities`);
  console.log(`[P2Reconcile]   of which at "1. Contract Signed": ${atContractSigned}`);
  if (opt.limit) console.log(`[P2Reconcile]   acting on at most ${opt.limit} of them (--limit)`);

  const { byContact: jobsByContact, jobCount, milestoneCount, viaLeadCount } =
    await fetchJobsWithMilestones([...new Set(candidates.map((c) => c.ghl_contact_id))]);
  console.log(`[P2Reconcile] ${jobsByContact.size} of those contacts have at least one lp_jobs row`);
  console.log(`[P2Reconcile] ${jobCount} lp_jobs rows, ${milestoneCount} completed milestones read`);
  console.log(`[P2Reconcile] ${viaLeadCount} jobs reached only through the lead link`);

  const log = openLog();
  console.log(`[P2Reconcile] rollback log → ${log.file}`);

  const blank = () => ({
    moved: 0, won: 0, lost: 0,
    skipped_no_job: 0, skipped_not_forward: 0, skipped_unmapped: 0,
    skipped_already_correct: 0, skipped_no_milestone: 0,
    skipped_field_not_selected: 0, skipped_over_limit: 0,
    already_live: 0, refused_no_lost_reason: 0, failed: 0,
  });
  // Two tallies over the same pass. This script reconciles every OPEN P2
  // opportunity — the same defect can strand one at Financing Pending, and the
  // forward-only guard makes the wider sweep safe — but the cohort the repair
  // was scoped against is the one still sitting at "1. Contract Signed". Both
  // are reported so the expected-counts check in the runbook still applies to
  // the cohort it was calibrated on.
  const stats = blank();
  const csStats = blank();
  const noJobOppIds = [];
  const unmappedMdtCounts = new Map();
  const targetCounts = new Map();
  const lostStatusCounts = new Map();
  const wonStatusCounts = new Map();
  let writes = 0;
  let actioned = 0;
  let shown = 0;
  const SAMPLE_CAP = 20;

  for (const opp of candidates) {
    const jobs = jobsByContact.get(opp.ghl_contact_id) || [];
    const atCS = opp.ghl_stage_id === CONTRACT_SIGNED;
    const bump = (key, n = 1) => { stats[key] += n; if (atCS) csStats[key] += n; };
    let currentStageId = opp.ghl_stage_id;
    let currentStatus = opp.status;
    // The mirror's stamped LP Job ID is a HINT for planning only. It carries
    // opportunity custom fields but LAGS GHL by up to one sync, so a dry run can
    // plan from a job id that is minutes out of date. That costs a miss, never a
    // wrong write: the live re-read below is what authorises anything, and a
    // missed row is picked up by the next run once the mirror catches up.
    let trackedJobId = readOppJobId({ customFields: opp.custom_fields });
    let decision = stageDecision({ currentStageId, jobs, mapping, trackedJobId });

    if (decision.verdict === 'skip_no_job') {
      bump('skipped_no_job');
      noJobOppIds.push(opp.ghl_opportunity_id);
      continue;
    }
    if (decision.verdict === 'skip_unmapped_milestone') {
      bump('skipped_unmapped');
      for (const m of decision.unmappedMdtIds) unmappedMdtCounts.set(m, (unmappedMdtCounts.get(m) || 0) + 1);
      continue;
    }
    if (decision.verdict === 'skip_not_forward') { bump('skipped_not_forward'); continue; }
    if (decision.verdict === 'skip_already_correct') {
      bump('skipped_already_correct');
      if (decision.completedMilestones === 0) bump('skipped_no_milestone');
      continue;
    }

    // A verdict this run is not writing. Counted, not acted on — the phased
    // rollout runs stage and status separately and each pass must be able to
    // say how much it deliberately left for the other.
    const wantsStage = decision.verdict === 'move';
    if ((wantsStage && !opt.doStage) || (!wantsStage && !opt.doStatus)) {
      bump('skipped_field_not_selected');
      continue;
    }

    // --limit caps the records this run ACTS ON, and is applied here — after
    // the verdict and the field filter, not to the candidate list. The canary
    // in the runbook is "25 stage moves"; capping candidates instead would
    // have made `--fields=stage --limit=25` write 5, because most of the first
    // 25 open opportunities are wins, losses or already correct. Classification
    // continues past the cap so the summary and the no-job list stay complete.
    if (opt.limit && actioned >= opt.limit) {
      bump('skipped_over_limit');
      continue;
    }
    actioned++;

    // Re-decide against LIVE state before writing. The mirror lags, so a second
    // --apply run planned from it alone would re-issue every move it just made.
    if (opt.apply) {
      let live;
      try {
        live = await readLiveOpportunity(opp.ghl_opportunity_id);
      } catch (err) {
        bump('failed');
        console.error(`[P2Reconcile] READ FAILED ${opp.ghl_opportunity_id}: ${err.message}`);
        continue;
      }
      if (!live) { bump('already_live'); continue; }
      if (live.status !== 'open') { bump('already_live'); continue; }
      currentStageId = live.stageId;
      currentStatus = live.status;
      // GHL is authoritative for the tracked job at the moment of writing.
      trackedJobId = live.trackedJobId;
      const redecided = stageDecision({ currentStageId, jobs, mapping, trackedJobId });
      if (redecided.verdict !== decision.verdict) { bump('already_live'); continue; }
      if (redecided.verdict === 'move' && redecided.targetStageId === currentStageId) {
        bump('already_live'); continue;
      }
      decision = redecided;
    }

    const body = { pipelineId };
    let record;

    if (decision.verdict === 'move') {
      body.pipelineStageId = decision.targetStageId;
      record = {
        action: 'move',
        to_stage_id: decision.targetStageId,
        to_stage_name: decision.targetStageName,
        to_status: currentStatus,
      };
      targetCounts.set(decision.targetStageName, (targetCounts.get(decision.targetStageName) || 0) + 1);
    } else {
      // Terminal status writes send the opportunity's OWN current stage, so the
      // PUT changes status and nothing else — the same shape
      // scripts/dedupe-opportunities.js uses. A won opportunity therefore keeps
      // whatever stage it held; that stage is historical record from here on.
      body.pipelineStageId = currentStageId;
      body.status = decision.verdict === 'win' ? 'won' : 'lost';
      record = {
        action: decision.verdict,
        to_stage_id: currentStageId,
        to_stage_name: label(currentStageId),
        to_status: body.status,
      };
      const bucket = decision.verdict === 'win' ? wonStatusCounts : lostStatusCounts;
      bucket.set(decision.jobStatus || '(blank)', (bucket.get(decision.jobStatus || '(blank)') || 0) + 1);

      if (decision.verdict === 'lose') {
        const reason = resolveLostReasonForStatus(decision.jobStatus, {
          idSpec: opt.lostReasonId.spec, nameSpec: opt.lostReason, reasons: lostReasons,
        });
        if (reason.error) {
          // Planned, not written. A loss with no configured reason either fails
          // the write or pollutes loss reporting; both are worse than stopping.
          bump('refused_no_lost_reason');
          if (opt.apply) {
            console.error(`[P2Reconcile] REFUSED ${opp.ghl_opportunity_id}: ${reason.error}`);
            continue;
          }
        } else {
          body.lostReasonId = reason.id;
          record.lost_reason_id = reason.id;
          // null when the id came from --lost-reason-id for a status the shared
          // mapping does not name. The ID is what GHL stores and what the
          // rollback log needs; the name is a convenience for reading it.
          record.lost_reason_name = reason.name || null;
          record.lost_reason_source = reason.source;
        }
      }
    }

    // ─── the rollback line. Previous stage and previous status, always. ───
    log.write({
      ts: new Date().toISOString(),
      applied: opt.apply,
      opportunity_id: opp.ghl_opportunity_id,
      contact_id: opp.ghl_contact_id,
      lp_job_id: decision.job?.lp_job_id ?? null,
      job_status: decision.jobStatus,
      from_stage_id: currentStageId,
      from_stage_name: label(currentStageId),
      from_status: currentStatus,
      reason: decision.detail,
      ...record,
    });

    if (decision.verdict === 'move') bump('moved');
    else if (decision.verdict === 'win') bump('won');
    else bump('lost');

    if (!opt.apply) {
      if (shown++ < SAMPLE_CAP) {
        console.log(`  would ${decision.verdict} ${opp.ghl_opportunity_id}: ${label(currentStageId)} → ${record.to_stage_name}`
          + `${record.to_status !== currentStatus ? ` · status ${currentStatus} → ${record.to_status}` : ''}`
          + `  [${decision.detail}]`);
      }
      continue;
    }

    try {
      await ghlFetch('PUT', `/opportunities/${opp.ghl_opportunity_id}`, body);
      writes++;
      if (writes % 25 === 0) console.log(`[P2Reconcile] ${writes} written...`);
    } catch (err) {
      bump('failed');
      if (decision.verdict === 'move') bump('moved', -1);
      else if (decision.verdict === 'win') bump('won', -1);
      else bump('lost', -1);
      console.error(`[P2Reconcile] FAILED ${opp.ghl_opportunity_id}: ${err.message}`);
    }
  }

  await log.close();

  // ─── summary ───────────────────────────────────────────────────────────
  const verb = opt.apply ? '' : 'would ';
  const row = (text, key, extra = '') =>
    console.log(`${text.padEnd(30)}${String(stats[key]).padStart(6)}${String(csStats[key]).padStart(10)}   ${extra}`);
  console.log('\n─── Result ────────────────────────────────────────────────────');
  console.log(`${''.padEnd(30)}${'all P2'.padStart(6)}${'@Contract'.padStart(10)}`);
  row(`${verb}move to a later stage`, 'moved');
  row(`${verb}mark won`, 'won');
  row(`${verb}mark lost`, 'lost');
  row('skipped — no LP job', 'skipped_no_job');
  row('skipped — not a forward move', 'skipped_not_forward');
  row('skipped — unmapped milestone', 'skipped_unmapped');
  row('skipped — already correct', 'skipped_already_correct',
    `(no completed milestone: ${stats.skipped_no_milestone} all / ${csStats.skipped_no_milestone} @Contract)`);
  row('skipped — field not selected', 'skipped_field_not_selected');
  if (opt.limit) row('skipped — over --limit', 'skipped_over_limit');
  if (opt.apply) row('skipped — already reconciled', 'already_live');
  if (stats.refused_no_lost_reason) row('refused — no lost reason', 'refused_no_lost_reason');
  row('failed', 'failed');
  console.log(`\n"@Contract" is the subset still sitting at "1. Contract Signed" — the cohort`);
  console.log('this repair was scoped and measured against. The wider column is every open');
  console.log('P2 opportunity, which the forward-only guard makes safe to sweep in one pass.');

  if (targetCounts.size) {
    console.log('\nstage moves by target:');
    for (const [name, n] of [...targetCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${name}`);
  }
  if (wonStatusCounts.size) {
    console.log('\nwins by job status:');
    for (const [s, n] of [...wonStatusCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${s}`);
  }
  if (lostStatusCounts.size) {
    console.log('\nlosses by job status:');
    for (const [s, n] of [...lostStatusCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${s}`);
  }
  if (unmappedMdtCounts.size) {
    console.log('\nunmapped milestone ids (no P2_MILESTONE_* rule covers them):');
    for (const [m, n] of [...unmappedMdtCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${m}`);
  }

  // The no-job list in full, not a sample: it IS the deliverable for the
  // separate investigation into whether the job or the contact link is missing.
  console.log(`\n─── ${noJobOppIds.length} opportunities with NO LP job — reported, never touched ───`);
  console.log('These are out of scope: a P2 opportunity means a contract was signed, so no LP');
  console.log('job means either the job was never created or the contact link is broken. Two');
  console.log('different defects, two different fixes. Guessing a stage would bury the evidence.');
  for (const id of noJobOppIds) console.log(`  ${id}`);

  console.log(`\n[P2Reconcile] rollback log: ${log.file}`);
  console.log(`[P2Reconcile] done${opt.apply ? '' : ' — DRY RUN, nothing written. Re-run with --apply to write.'}`);
}

// Run only when invoked directly — importing this module for its pure helpers
// (scripts/test-reconcile-p2-stages.js) must not start a GHL run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('[P2Reconcile] FAILED:', err.message); process.exit(1); });
}
