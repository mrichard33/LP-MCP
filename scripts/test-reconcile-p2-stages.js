/**
 * scripts/test-reconcile-p2-stages.js
 *
 * Unit coverage for the decisions in scripts/reconcile-p2-stages.js — what
 * happens to 1,515 live CRM records, and why.
 *
 * The failure these guard against is a repair pass that makes the data worse.
 * The worst of them, and the reason the job selection lives INSIDE
 * stageDecision rather than in its caller: a returning customer holds a 2024
 * job Paid In Full and a 2026 job in production, and a rule that reads "any job
 * is complete" closes their LIVE job as won. That opportunity is then out of
 * the pipeline, out of the follow-up sequences, and counted as revenue twice.
 *
 * Pure-function test — no DB, no network.
 * Run: node --test scripts/test-reconcile-p2-stages.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stageDecision, buildMilestoneStageMap, derivedStageFromMilestones,
  parseLostReasonArg, resolveLostReason, normalizeLostReasons,
  parseLostReasonIdArg, resolveLostReasonForStatus,
  WON_JOB_STATUSES, LOST_JOB_STATUSES,
} from './reconcile-p2-stages.js';

// The real ids, so a test that passes proves the pairing an operator would type.
const ID = {
  CUSTOMER_CANCELLED: '6aad8dc01f2de24d878ec356',
  COLLECTIONS:        '6aad8dc0f4cad9983ac319ce',
  FINANCING_DENIED:   '69cd48077ac164325a355e36',
  GHOSTED:            '69cd4807e4ce65bc76877f98',
};

// ─── fixtures ───────────────────────────────────────────────────────────

const STAGE = {
  CONTRACT_SIGNED:   'fec39f2e-ba39-4536-95b2-bbac7ca6c454', // 0
  FINANCING_PENDING: 'b7fc445c-a969-42b1-9a7a-eda5c89f25a5', // 1
  RTP:               '375089e1-aaa5-429f-8c4c-5e01058fa8f8', // 2
  PERMITTING:        '561f35fe-3632-40e9-bf0d-b9061bdf2589', // 3
  IN_PRODUCTION:     '6b89bc8d-067a-41fb-a76c-fc0c9feaaf92', // 4
  INSTALL_SCHEDULED: 'd852ba71-c6f5-422b-9c74-33b6036c69a5', // 5
  INSTALL_COMPLETED: '5fc94c74-d136-481e-b8ca-2200817111af', // 6
  REFERRAL:          '053a0020-0f96-4a22-8717-8814c3ca1ff8', // 7
};

/**
 * The mapping as it is derived from the live agent_rules P2_MILESTONE_* family
 * (read 2026-08-31). The real script never hardcodes this — it reads the rules
 * — but a unit test needs a fixed one to decide against.
 */
const MAPPING = buildMilestoneStageMap([
  rule('P2_MILESTONE_MEASURE', 'M', 'Financing Pending'),
  rule('P2_MILESTONE_RTP', 'R', 'Financing Approved'),        // legacy alias, deliberate
  rule('P2_MILESTONE_HOA', 'H', 'Permitting & HOA'),
  rule('P2_MILESTONE_PERMIT_SUBMIT', 'U', 'Permitting & HOA'),
  rule('P2_MILESTONE_PERMIT_ISSUED', 'P', 'Permitting & HOA'),
  rule('P2_MILESTONE_ORDERED', 'K', 'In Production'),
  rule('P2_MILESTONE_PRODUCT_RECEIVED', 'G', 'In Production'),
  rule('P2_MILESTONE_INSTALL_START', 'S', 'Install Scheduled'),
  rule('P2_MILESTONE_INSTALL_END', 'F', 'Install Completed'),
  rule('P2_MILESTONE_COMPLETION', 'C', 'Install Completed'),
  rule('P2_MILESTONE_INSPECTION_SET', 'I', 'Install Completed'),
  rule('P2_MILESTONE_INSPECTION_PASSED', 'B', 'Referral & Expansion'),
]).mapping;

function rule(ruleKey, mdtId, stage) {
  return {
    rule_key: ruleKey,
    event_pattern: { event_type: 'lp.milestone_completed', payload: { mdt_id: mdtId } },
    action_template: [
      { action_type: 'move_opportunity', params: { pipeline: 'P2', stage, status: 'open' } },
      { action_type: 'add_tag', params: { tag: `p2-stage:${mdtId}` } },
    ],
  };
}

/** An lp_jobs row with its completed milestones. `done` is a list of mdt_ids. */
function job(lpJobId, jobStatus, done = []) {
  return {
    lp_job_id: String(lpJobId),
    job_status: jobStatus,
    job_value: 12000,
    milestones: done.map((mdt_id) => ({ mdt_id, act_date: '2026-03-01T00:00:00Z' })),
  };
}

const decide = (currentStageId, jobs) => stageDecision({ currentStageId, jobs, mapping: MAPPING });

// ─── the one that matters most ──────────────────────────────────────────

test('a returning customer is decided by the NEWEST job, not the completed one', () => {
  // 2024 job: Paid In Full, fully milestoned. 2026 job: in production.
  // Reading "any job is complete" would mark this WON and close a live job.
  const jobs = [
    job(80100, 'Paid In Full', ['M', 'R', 'H', 'K', 'G', 'S', 'F', 'C', 'B']),
    job(93400, 'Awaiting Product', ['M', 'R', 'K']),
  ];
  const d = decide(STAGE.CONTRACT_SIGNED, jobs);
  assert.equal(d.verdict, 'move');
  assert.equal(d.targetStageId, STAGE.IN_PRODUCTION);
  assert.equal(d.job.lp_job_id, '93400');
});

test('job order is by lp_job_id, not by array order or milestone count', () => {
  // Same two jobs, newest listed first. LP job ids are a sequence; higher is
  // later. Whichever way the rows arrive, the answer must not change.
  const jobs = [
    job(93400, 'Awaiting Product', ['M', 'R', 'K']),
    job(80100, 'Paid In Full', ['M', 'R', 'H', 'K', 'G', 'S', 'F', 'C', 'B']),
  ];
  assert.equal(decide(STAGE.CONTRACT_SIGNED, jobs).job.lp_job_id, '93400');
});

test('a cancelled NEWEST job falls through to the live older one, not to lost', () => {
  // latestJob() filters cancelled jobs before picking. A contact whose newest
  // job died but who still has live work is still working with us.
  const jobs = [
    job(80100, 'Awaiting Product', ['M', 'R', 'K']),
    job(93400, 'Cancelled', ['M']),
  ];
  const d = decide(STAGE.CONTRACT_SIGNED, jobs);
  assert.equal(d.verdict, 'move');
  assert.equal(d.job.lp_job_id, '80100');
});

// ─── the guards ─────────────────────────────────────────────────────────

test('a backward move is refused', () => {
  // The opportunity is at Install Completed (6); the job's furthest completed
  // milestone is Permit Issued, which targets Permitting & HOA (3). LP
  // milestones arrive out of stage order by design — this is not a correction.
  const d = decide(STAGE.INSTALL_COMPLETED, [job(93400, 'Awaiting Product', ['M', 'R', 'P'])]);
  assert.equal(d.verdict, 'skip_not_forward');
});

test('an opportunity already at the derived stage is skipped', () => {
  const d = decide(STAGE.IN_PRODUCTION, [job(93400, 'Awaiting Product', ['M', 'R', 'K'])]);
  assert.equal(d.verdict, 'skip_already_correct');
});

test('re-running decides nothing — the second pass sees the stage it just set', () => {
  const jobs = [job(93400, 'Awaiting Product', ['M', 'R', 'K'])];
  const first = decide(STAGE.CONTRACT_SIGNED, jobs);
  assert.equal(first.verdict, 'move');
  assert.equal(decide(first.targetStageId, jobs).verdict, 'skip_already_correct');
});

test('a contact with no LP job is skipped and reported, never guessed', () => {
  const d = decide(STAGE.CONTRACT_SIGNED, []);
  assert.equal(d.verdict, 'skip_no_job');
  assert.equal(d.targetStageId, null);
});

test('no LP job is decided before anything else, including an unmapped milestone', () => {
  // Order matters: a contact with no job is the basic problem, not a mapping
  // problem we would have moved if only the milestone had resolved.
  assert.equal(stageDecision({ currentStageId: STAGE.CONTRACT_SIGNED, jobs: [null], mapping: MAPPING }).verdict,
               'skip_no_job');
});

test('an unmapped milestone is skipped, never defaulted to a stage', () => {
  // O (Quoted), V (Receive Windows), E (Receive Doors) and X (Snap/Trim) are
  // tag-only and have no P2_MILESTONE_* rule. A job whose only completed
  // milestones are those has no derivable stage.
  const d = decide(STAGE.CONTRACT_SIGNED, [job(93400, 'Awaiting Product', ['O', 'V', 'X'])]);
  assert.equal(d.verdict, 'skip_unmapped_milestone');
  assert.equal(d.targetStageId, null);
  assert.deepEqual(d.unmappedMdtIds, ['O', 'V', 'X']);
});

test('an unmapped milestone alongside a mapped one does not block the mapped one', () => {
  // Nearly every job carries a completed O. Treating that as "unmapped, skip"
  // would skip almost the entire pipeline.
  const d = decide(STAGE.CONTRACT_SIGNED, [job(93400, 'Awaiting Product', ['O', 'M', 'R', 'K', 'V'])]);
  assert.equal(d.verdict, 'move');
  assert.equal(d.targetStageId, STAGE.IN_PRODUCTION);
});

test('a job with no completed milestone at all is left where it is', () => {
  // LP asserts nothing has happened past contract signature. That is not a
  // defect and not an unmapped milestone.
  const d = decide(STAGE.CONTRACT_SIGNED, [job(93400, 'New', [])]);
  assert.equal(d.verdict, 'skip_already_correct');
  assert.equal(d.completedMilestones, 0);
});

test('an opportunity at a stage the guard has no position for is never moved', () => {
  const d = decide('not-a-real-stage-id', [job(93400, 'Awaiting Product', ['M', 'R', 'K'])]);
  assert.equal(d.verdict, 'skip_not_forward');
});

// ─── terminal status ────────────────────────────────────────────────────

test('a completed job becomes won', () => {
  for (const status of WON_JOB_STATUSES) {
    const d = decide(STAGE.INSTALL_COMPLETED, [job(93400, status, ['M', 'R', 'K', 'S', 'F', 'C'])]);
    assert.equal(d.verdict, 'win', `${status} should be a win`);
  }
});

test('a cancelled job becomes lost, never abandoned', () => {
  // 'abandoned' belongs to scripts/dedupe-opportunities.js and asserts
  // "duplicate record". None of these are duplicates; their jobs died.
  const d = decide(STAGE.CONTRACT_SIGNED, [job(93400, 'Cancelled', ['M'])]);
  assert.equal(d.verdict, 'lose');
  assert.equal(d.jobStatus, 'Cancelled');
});

test('every job cancelled is a loss, NOT reported as a missing job', () => {
  // latestJob() filters cancelled jobs, so it answers null here — the same
  // answer it gives for a contact with no jobs at all. The raw list is checked
  // first precisely so these two do not collapse into one bucket.
  const d = decide(STAGE.CONTRACT_SIGNED, [
    job(80100, 'Cancelled', ['M']),
    job(93400, 'Dead Deal', ['M', 'R']),
  ]);
  assert.equal(d.verdict, 'lose');
  assert.equal(d.jobStatus, 'Dead Deal'); // the newest of them, for the reason
});

test('Sent To Attorney is lost — a deal in collections is not in progress', () => {
  assert.equal(decide(STAGE.CONTRACT_SIGNED, [job(93400, 'Sent To Attorney', ['M', 'R'])]).verdict, 'lose');
});

test('Credit Decline IS lost — reversed 2026-09-18', () => {
  // This test asserted the OPPOSITE until 2026-09-18, and the reasoning it
  // carried is worth keeping: the status was excluded on 2026-08-31 — 149 of the
  // 375 planned Contract Signed losses hung on it — because marking an
  // opportunity lost is irreversible in reporting and nobody had measured how
  // often a decline is reworked and recovers.
  //
  // Mark reversed it once that objection had an answer. The decline gets its OWN
  // lost reason, "Financing Denied" (69cd48077ac164325a355e36), rather than being
  // folded in with cancellations — so recovery rate becomes measurable after the
  // fact by querying lost opportunities by reason. ~345 jobs / ~179 contacts.
  assert.equal(LOST_JOB_STATUSES.has('Credit Decline'), true);
  assert.equal(WON_JOB_STATUSES.has('Credit Decline'), false);
  const d = decide(STAGE.CONTRACT_SIGNED, [job(93400, 'Credit Decline', ['M', 'R', 'H'])]);
  assert.equal(d.verdict, 'lose');
  assert.equal(d.jobStatus, 'Credit Decline');
  // A loss never carries a stage move — the two phases stay disjoint.
  assert.equal(d.targetStageId, null);
});

test('a NEWER in-progress job outranks a Credit Decline, and it is not lost', () => {
  // Credit Decline stays OUT of CANCELLED_JOB_STATUSES in src/lp-job-value.js,
  // so latestJob() can still select it — but only when it is the newest. A
  // contact who was declined and then started live work is still working with us.
  const jobs = [job(80100, 'Credit Decline', ['M', 'R']), job(93400, 'Awaiting Product', ['M', 'R', 'K'])];
  const d = decide(STAGE.CONTRACT_SIGNED, jobs);
  assert.equal(d.job.lp_job_id, '93400');
  assert.equal(d.verdict, 'move');
  assert.equal(d.targetStageId, STAGE.IN_PRODUCTION);
});

test('a Credit Decline outranks an OLDER Paid In Full, and the decline decides', () => {
  // The reverse of the returning-customer case. The old job was collected and
  // its opportunity is already closed; the NEW one was declined. Reading "any
  // job is complete" would mark this won and book revenue that never arrived.
  const jobs = [
    job(80100, 'Paid In Full', ['M', 'R', 'K', 'S', 'F', 'C']),
    job(93400, 'Credit Decline', ['M', 'R']),
  ];
  const d = decide(STAGE.CONTRACT_SIGNED, jobs);
  assert.equal(d.job.lp_job_id, '93400');
  assert.equal(d.verdict, 'lose');
  assert.equal(d.jobStatus, 'Credit Decline');
});

test('Installed & Unpaid is NOT won — the work is done, the money is not', () => {
  // Default pending sign-off: derive a stage, leave the status open. Marking
  // unpaid work won overstates revenue.
  assert.equal(WON_JOB_STATUSES.has('Installed & Unpaid'), false);
  assert.equal(LOST_JOB_STATUSES.has('Installed & Unpaid'), false);
  const d = decide(STAGE.CONTRACT_SIGNED, [job(93400, 'Installed & Unpaid', ['M', 'R', 'K', 'S', 'F', 'C'])]);
  assert.equal(d.verdict, 'move');
  assert.equal(d.targetStageId, STAGE.INSTALL_COMPLETED);
});

test('an in-progress hold derives a stage and stays open', () => {
  for (const status of ['Awaiting Product', 'Scheduled', 'HOLD - HOA', 'Quoted', 'New', 'Mgmt Hold']) {
    const d = decide(STAGE.CONTRACT_SIGNED, [job(93400, status, ['M', 'R', 'H'])]);
    assert.equal(d.verdict, 'move', `${status} should derive a stage`);
    assert.equal(d.targetStageId, STAGE.PERMITTING);
  }
});

test('a terminal status wins over the stage derivation, so the two phases stay disjoint', () => {
  // A Paid In Full job has every milestone. It must not ALSO be planned as a
  // stage move: --fields=stage and --fields=status must never touch the same
  // record, or the canary stops isolating what it is meant to isolate.
  const d = decide(STAGE.CONTRACT_SIGNED, [job(93400, 'Paid In Full', ['M', 'R', 'K', 'S', 'F', 'C', 'B'])]);
  assert.equal(d.verdict, 'win');
  assert.equal(d.targetStageId, null);
});

// ─── the derived mapping ────────────────────────────────────────────────

test('the mapping is derived from agent_rules, aliases and all', () => {
  // P2_MILESTONE_RTP deliberately names the legacy alias 'Financing Approved'
  // because it is the rollback-safe target. Both names resolve to 375089e1.
  assert.equal(MAPPING.R.stageId, STAGE.RTP);
  assert.equal(MAPPING.M.stageId, STAGE.FINANCING_PENDING);
  assert.equal(MAPPING.B.stageId, STAGE.REFERRAL);
});

test('three milestones legitimately share one stage', () => {
  for (const mdt of ['H', 'U', 'P']) assert.equal(MAPPING[mdt].stageId, STAGE.PERMITTING);
  for (const mdt of ['F', 'C', 'I']) assert.equal(MAPPING[mdt].stageId, STAGE.INSTALL_COMPLETED);
});

test('a rule naming a stage STAGE_MAP does not know is a problem, not a guess', () => {
  const { mapping, problems } = buildMilestoneStageMap([rule('P2_MILESTONE_BOGUS', 'Z', 'Nonexistent Stage')]);
  assert.equal(mapping.Z, undefined);
  assert.equal(problems[0].reason, 'unknown_stage_name');
});

test('two rules disagreeing about one milestone is a conflict, not last-one-wins', () => {
  const { problems } = buildMilestoneStageMap([
    rule('P2_MILESTONE_A', 'M', 'Financing Pending'),
    rule('P2_MILESTONE_B', 'M', 'In Production'),
  ]);
  assert.equal(problems.some((p) => p.reason === 'conflicting_rules_for_mdt'), true);
});

test('a tag-only rule contributes no mapping', () => {
  const { mapping, problems } = buildMilestoneStageMap([{
    rule_key: 'P2_MILESTONE_TAGONLY',
    event_pattern: { payload: { mdt_id: 'O' } },
    action_template: [{ action_type: 'add_tag', params: { tag: 'p2-stage:quoted' } }],
  }]);
  assert.equal(mapping.O, undefined);
  assert.equal(problems[0].reason, 'no_p2_move_action');
});

test('a rule moving an opportunity in another pipeline is not a P2 mapping', () => {
  const { mapping } = buildMilestoneStageMap([{
    rule_key: 'P2_MILESTONE_WRONGPIPE',
    event_pattern: { payload: { mdt_id: 'M' } },
    action_template: [{ action_type: 'move_opportunity', params: { pipeline: 'P1', stage: 'Sale Recorded' } }],
  }]);
  assert.equal(mapping.M, undefined);
});

// ─── milestone ranking ──────────────────────────────────────────────────

test('the furthest-along milestone wins, ranked by stage position not by date', () => {
  // Ordered (K, position 4) lands +10d from RTP; Permit Issued (P, position 3)
  // lands +21d. Ranking by act_date would pick P and move the job backward.
  const { target } = derivedStageFromMilestones([
    { mdt_id: 'K', act_date: '2026-03-10T00:00:00Z' },
    { mdt_id: 'P', act_date: '2026-03-21T00:00:00Z' },
  ], MAPPING);
  assert.equal(target.stageId, STAGE.IN_PRODUCTION);
});

test('a milestone row with no act_date has not happened', () => {
  // lp_job_milestones carries a row per milestone type per job whether or not
  // it occurred — 5,898 rows per type. Row existence means nothing.
  const { target, completed } = derivedStageFromMilestones([
    { mdt_id: 'M', act_date: '2026-03-01T00:00:00Z' },
    { mdt_id: 'B', act_date: null },
    { mdt_id: 'C', act_date: '' },
  ], MAPPING);
  assert.equal(completed, 1);
  assert.equal(target.stageId, STAGE.FINANCING_PENDING);
});

// ─── lost reasons ───────────────────────────────────────────────────────

test('one lost reason can cover every lost status', () => {
  const spec = parseLostReasonArg('Customer Cancelled');
  assert.equal(spec.fallback, 'Customer Cancelled');
  assert.deepEqual(spec.byStatus, {});
});

test('per-status lost reasons are parsed as pairs', () => {
  const spec = parseLostReasonArg('Cancelled=Customer Cancelled,Credit Decline=Financing Denied');
  assert.equal(spec.byStatus['Cancelled'], 'Customer Cancelled');
  assert.equal(spec.byStatus['Credit Decline'], 'Financing Denied');
});

test('a lost reason is resolved against the list GHL actually holds', () => {
  const reasons = [{ id: 'lr_1', name: 'Customer Cancelled' }, { id: 'lr_2', name: 'Financing Denied' }];
  const spec = parseLostReasonArg('Cancelled=Customer Cancelled');
  assert.deepEqual(resolveLostReason('Cancelled', spec, reasons), { id: 'lr_1', name: 'Customer Cancelled' });
});

test('an unconfigured lost reason is an error, never a string sent to GHL', () => {
  const reasons = [{ id: 'lr_1', name: 'Customer Cancelled' }];
  assert.ok(resolveLostReason('Cancelled', parseLostReasonArg('Made This Up'), reasons).error);
  assert.ok(resolveLostReason('Cancelled', parseLostReasonArg(''), reasons).error);
  assert.ok(resolveLostReason('Cancelled', parseLostReasonArg('Customer Cancelled'), []).error);
});

test('GHL has answered the lost-reason collection as three different shapes', () => {
  const one = [{ id: 'a', name: 'X' }];
  assert.deepEqual(normalizeLostReasons(one), one);
  assert.deepEqual(normalizeLostReasons({ lossReasons: one }), one);
  assert.deepEqual(normalizeLostReasons({ data: one }), one);
  assert.deepEqual(normalizeLostReasons({ nothing: true }), []);
});

// ─── lost reasons by ID (2026-09-18) ────────────────────────────────────
//
// The name path cannot work: GHL's lost-reason collection endpoint 404s as
// OPPORTUNITY_NOT_FOUND for this location, so resolveLostReason has no list to
// match against and every loss is refused — 336 of them on the live pass.
// --lost-reason-id bypasses the lookup entirely.

test('one id can cover every lost status', () => {
  const { spec, problems } = parseLostReasonIdArg(ID.CUSTOMER_CANCELLED);
  assert.deepEqual(problems, []);
  assert.equal(spec.fallback, ID.CUSTOMER_CANCELLED);
  assert.deepEqual(spec.byStatus, {});
  for (const status of LOST_JOB_STATUSES) {
    const r = resolveLostReasonForStatus(status, { idSpec: spec, nameSpec: parseLostReasonArg('') });
    assert.equal(r.id, ID.CUSTOMER_CANCELLED, `${status} should fall back to the single id`);
    assert.equal(r.source, 'id');
  }
});

test('per-status ids resolve to the right id per status', () => {
  const { spec, problems } = parseLostReasonIdArg(
    `Cancelled=${ID.CUSTOMER_CANCELLED},Cancelled By Mgt=${ID.CUSTOMER_CANCELLED},`
    + `Dead Deal=${ID.GHOSTED},Sent To Attorney=${ID.COLLECTIONS},Credit Decline=${ID.FINANCING_DENIED}`,
  );
  assert.deepEqual(problems, []);
  const nameSpec = parseLostReasonArg('');
  const idOf = (status) => resolveLostReasonForStatus(status, { idSpec: spec, nameSpec }).id;
  assert.equal(idOf('Cancelled'), ID.CUSTOMER_CANCELLED);
  assert.equal(idOf('Cancelled By Mgt'), ID.CUSTOMER_CANCELLED);
  assert.equal(idOf('Dead Deal'), ID.GHOSTED);
  assert.equal(idOf('Sent To Attorney'), ID.COLLECTIONS);
  assert.equal(idOf('Credit Decline'), ID.FINANCING_DENIED);
  // Every lost status is covered — this is the pairing the live run uses, and a
  // gap here is a refused loss there.
  for (const status of LOST_JOB_STATUSES) assert.ok(idOf(status), `${status} has no id`);
});

test('an id resolves with NO GHL list — that is the whole point of the flag', () => {
  // resolveLostReason needs `reasons` to match a name against. The id path must
  // not consult it at all, because it cannot be fetched.
  const { spec } = parseLostReasonIdArg(`Cancelled=${ID.CUSTOMER_CANCELLED}`);
  const r = resolveLostReasonForStatus('Cancelled', {
    idSpec: spec, nameSpec: parseLostReasonArg(''), reasons: [],
  });
  assert.equal(r.error, undefined);
  assert.equal(r.id, ID.CUSTOMER_CANCELLED);
  // And it names the reason from the shared mapping, for readable output.
  assert.equal(r.name, 'Customer Cancelled');
});

test('when both an id and a name are given for one status, the id wins and warns', () => {
  const { spec: idSpec } = parseLostReasonIdArg(`Cancelled=${ID.CUSTOMER_CANCELLED}`);
  const nameSpec = parseLostReasonArg('Cancelled=Ghosted / Unresponsive');
  const reasons = [{ id: ID.GHOSTED, name: 'Ghosted / Unresponsive' }];
  const r = resolveLostReasonForStatus('Cancelled', { idSpec, nameSpec, reasons });
  assert.equal(r.id, ID.CUSTOMER_CANCELLED);
  assert.equal(r.source, 'id');
  // Silently picking one would hide a real disagreement about an irreversible write.
  assert.ok(r.warning, 'the conflict must be reported');
  assert.match(r.warning, /Ghosted \/ Unresponsive/);
});

test('a status with neither an id nor a name is REFUSED, never defaulted', () => {
  // The refusal is the feature. Guessing a reason writes an irreversible lie
  // into loss reporting; a refused loss can always be re-run.
  const empty = { idSpec: parseLostReasonIdArg('').spec, nameSpec: parseLostReasonArg(''), reasons: [] };
  for (const status of LOST_JOB_STATUSES) {
    assert.ok(resolveLostReasonForStatus(status, empty).error, `${status} must refuse`);
  }
  // And a pairing that covers only SOME statuses refuses the rest, rather than
  // letting one id leak across.
  const partial = {
    idSpec: parseLostReasonIdArg(`Cancelled=${ID.CUSTOMER_CANCELLED}`).spec,
    nameSpec: parseLostReasonArg(''), reasons: [],
  };
  assert.equal(resolveLostReasonForStatus('Cancelled', partial).id, ID.CUSTOMER_CANCELLED);
  assert.ok(resolveLostReasonForStatus('Dead Deal', partial).error);
});

test('a malformed id is rejected at PARSE time, not at write time', () => {
  // Catching a typo before the run starts is free. An id GHL rejects fails its
  // own write and is counted as `failed`, which is also correct — but only for
  // ids that are at least the right shape.
  const bad = [
    'not-an-id',                          // obviously not
    '6aad8dc01f2de24d878ec35',            // 23 chars
    '6aad8dc01f2de24d878ec3567',          // 25 chars
    '6aad8dc01f2de24d878ec35g',           // 24 chars, not hex
  ];
  for (const value of bad) {
    const { spec, problems } = parseLostReasonIdArg(value);
    assert.equal(problems.length, 1, `${value} should be rejected`);
    assert.equal(problems[0].reason, 'not_a_24_char_hex_id');
    assert.equal(spec.fallback, null, `${value} must not survive into the spec`);
  }
  // Per-status pairs are validated the same way, and a bad one names its status
  // so the operator knows which pair to fix.
  const { spec, problems } = parseLostReasonIdArg(`Cancelled=${ID.CUSTOMER_CANCELLED},Dead Deal=nope`);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].status, 'Dead Deal');
  assert.equal(spec.byStatus['Cancelled'], ID.CUSTOMER_CANCELLED);
  assert.equal(spec.byStatus['Dead Deal'], undefined);
});

test('an id that disagrees with the shared mapping is flagged but not blocked', () => {
  // src/lp-lost-reasons.js is a COPY of GHL's config. If the two disagree, the
  // operator on the command line is the one who just read the UI — so warn,
  // print, and proceed.
  const { spec } = parseLostReasonIdArg(`Credit Decline=${ID.GHOSTED}`);
  const r = resolveLostReasonForStatus('Credit Decline', { idSpec: spec, nameSpec: parseLostReasonArg('') });
  assert.equal(r.id, ID.GHOSTED);
  assert.ok(r.mismatch, 'a pairing that contradicts the mapping must be reported');
  assert.match(r.mismatch, /Financing Denied/);
});

test('the name path still works unchanged when no id is given', () => {
  // --lost-reason is not deprecated; it is correct and will be the only path
  // needed once the endpoint is fixed.
  const reasons = [{ id: ID.CUSTOMER_CANCELLED, name: 'Customer Cancelled' }];
  const r = resolveLostReasonForStatus('Cancelled', {
    idSpec: parseLostReasonIdArg('').spec,
    nameSpec: parseLostReasonArg('Cancelled=Customer Cancelled'),
    reasons,
  });
  assert.equal(r.id, ID.CUSTOMER_CANCELLED);
  assert.equal(r.name, 'Customer Cancelled');
  assert.equal(r.source, 'name');
});
