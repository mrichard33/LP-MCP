/**
 * scripts/test-p2-placeholder-jobs.js
 *
 * Pins dropShadowJobs() (src/p2-opportunity-context.js) and everything that now
 * runs through it: decidingJob, jobIdMatch, restampDecision, and the untracked
 * path of the P2 stage reconciler.
 *
 * The fixtures are the REAL job shapes behind the 2026-09-23 spot-check of LP
 * Job ID stamps — five opportunities stamped with a do-nothing copy of their
 * job. The guards that matter just as much are the ones that must NOT drop:
 * a returning customer's new job at a different price, and two real contracts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { dropShadowJobs, jobShowsProgress, decidingJob } from '../src/p2-opportunity-context.js';
import { jobIdMatch, restampDecision } from './backfill-p2-opportunity-job-id.js';
import { stageDecision } from './reconcile-p2-stages.js';

// A job as jobsForContact() returns it: raw LP payments / milestones attached.
// Progress defaults to 2026-09-01; placeholder contracts default to 2026-06-01,
// so a twin "kept moving after the copy was written" unless a test says otherwise.
const paid = (amt, pmtdate = '2026-09-01T00:00:00') => [{ pmtamount: String(amt), pmtdate }];
const done = (...types) => types.map((datetype) => ({ datetype, actdate: '2026-09-01T00:00:00', estdate: '2026-06-01T00:00:00' }));
const planned = [{ datetype: 'RTP', actdate: '', estdate: '2026-08-01T00:00:00' }];
const job = (lp_job_id, job_status, job_value, { payments = [], milestones = [], contractdate = '2026-06-01T00:00:00' } = {}) =>
  ({ lp_job_id, job_status, job_value, contractdate, lp_lead_id: `L${lp_job_id}`, payments, milestones });
const ids = (jobs) => jobs.map((j) => String(j.lp_job_id)).sort();

// ─── the five wrong stamps ───────────────────────────────────────────

test('DihbT: a "New" copy loses to the Paid In Full job at the same value', () => {
  const jobs = [
    job('58867', 'Paid In Full', 13450, { payments: paid(13450), milestones: done('RTP', 'Completion') }),
    job('59236', 'New', 13450, { milestones: planned }),
  ];
  assert.deepEqual(ids(dropShadowJobs(jobs)), ['58867']);
  assert.equal(decidingJob(jobs).job.lp_job_id, '58867');
  assert.equal(decidingJob(jobs).verdict, 'terminal_won');
});

test('yvCn: the rehash duplicate with a real contract id but no progress is dropped', () => {
  const jobs = [
    job('58692', 'Paid In Full', 24400, { payments: paid(24400), milestones: done('RTP') }),
    job('58699', 'RTP Await recission', 24400),
  ];
  assert.equal(decidingJob(jobs).job.lp_job_id, '58692');
});

test('ETEo1: with the copy gone the only job is cancelled, so the verdict is lost', () => {
  const jobs = [
    job('58297', 'New', 41000),
    job('58322', 'Cancelled', 41000, { milestones: done('Measure') }),
  ];
  const d = decidingJob(jobs);
  assert.equal(d.verdict, 'terminal_lost');
  assert.equal(d.job.lp_job_id, '58322');
});

test('OWGhV: two same-value jobs, only one has moved — value_match finds it', () => {
  const jobs = [
    job('57520', 'Awaiting Loan Docs', 40772),
    job('57521', 'Paid In Full', 45345, { payments: paid(45345), milestones: done('RTP') }),
    job('57791', 'New', 45345),
  ];
  assert.deepEqual(
    jobIdMatch({ status: 'open', monetaryValue: 45345, jobs }),
    { write: true, jobId: '57521', how: 'value_match' },
  );
});

// ─── what must NOT be dropped ────────────────────────────────────────

test('a returning customer: old Paid In Full + new "New" at a DIFFERENT value keeps the new job', () => {
  const jobs = [
    job('40001', 'Paid In Full', 22500, { payments: paid(22500), milestones: done('Completion') }),
    job('58862', 'New', 15333),
  ];
  assert.equal(dropShadowJobs(jobs).length, 2);
  assert.equal(decidingJob(jobs).job.lp_job_id, '58862');
  assert.equal(decidingJob(jobs).verdict, 'live');
});

test('two same-value jobs that have BOTH moved are both kept (newest still wins)', () => {
  const jobs = [
    job('536', 'Assumed Complete', 10236, { payments: paid(10236) }),
    job('19590', 'Assumed Complete', 10236, { payments: paid(10236), milestones: done('Completion') }),
  ];
  assert.equal(dropShadowJobs(jobs).length, 2);
  assert.equal(decidingJob(jobs).job.lp_job_id, '19590');
});

test('two same-value jobs where NEITHER has moved are both kept', () => {
  const jobs = [job('59148', 'Awaiting Commission Sheet', 74820), job('59285', 'Awaiting Paperwork', 74820)];
  assert.equal(dropShadowJobs(jobs).length, 2);
});

test('zvVMD: a same-value REWRITE whose old twin stopped moving before it was written is kept', () => {
  const jobs = [
    job('57744', 'Out to Measure', 24992, {
      contractdate: '2026-04-22T00:00:00',
      payments: paid(1, '2026-04-27T00:00:00'),
      milestones: [{ datetype: 'Measure', actdate: '2026-05-14T00:00:00' }],
    }),
    job('59965', 'Awaiting Credit Application', 24992, { contractdate: '2026-09-18T00:00:00' }),
  ];
  assert.equal(dropShadowJobs(jobs).length, 2);
  assert.equal(decidingJob(jobs).job.lp_job_id, '59965');
});

test('a job with no contract date is never dropped', () => {
  const jobs = [
    job('1', 'New', 5000, { contractdate: '' }),
    job('2', 'Paid In Full', 5000, { payments: paid(5000) }),
  ];
  assert.equal(dropShadowJobs(jobs).length, 2);
});

test('rows read without payments or milestones are never judged — nothing is dropped', () => {
  const bare = [
    { lp_job_id: '1', job_status: 'New', job_value: 5000, contractdate: '2026-06-01' },
    { lp_job_id: '2', job_status: 'Paid In Full', job_value: 5000, contractdate: '2026-06-01' },
  ];
  assert.equal(jobShowsProgress(bare[0]), null);
  assert.equal(dropShadowJobs(bare).length, 2);
});

test('a zero or missing value never pairs two jobs', () => {
  const jobs = [job('1', 'New', 0), job('2', 'Paid In Full', 0, { payments: paid(100) })];
  assert.equal(dropShadowJobs(jobs).length, 2);
});

// ─── restampDecision ─────────────────────────────────────────────────

test('restamp: a stamp on a placeholder moves to the real job', () => {
  const jobs = [
    job('59365', 'Paid In Full', 9550, { payments: paid(9550), milestones: done('RTP') }),
    job('59385', 'New', 9550),
  ];
  assert.deepEqual(
    restampDecision({ stampedJobId: '59385', status: 'open', monetaryValue: 9550, jobs }),
    { write: true, from: '59385', to: '59365', how: 'only_job' },
  );
});

test('restamp: a stamp on a real job is never touched', () => {
  const jobs = [
    job('59097', 'Awaiting Product', 74820, { payments: paid(1), milestones: done('Measure') }),
    job('59148', 'Awaiting Commission Sheet', 74820),
    job('59285', 'Awaiting Paperwork', 74820),
  ];
  assert.deepEqual(
    restampDecision({ stampedJobId: '59097', status: 'open', monetaryValue: 74820, jobs }),
    { write: false, reason: 'stamp_ok' },
  );
});

test('restamp: an empty stamp or a stamp naming a job we did not read is left alone', () => {
  const jobs = [job('1', 'New', 5000), job('2', 'Paid In Full', 5000, { payments: paid(5000) })];
  assert.equal(restampDecision({ stampedJobId: null, status: 'open', monetaryValue: 5000, jobs }).reason, 'not_stamped');
  assert.equal(restampDecision({ stampedJobId: '999', status: 'open', monetaryValue: 5000, jobs }).reason, 'stamped_job_unread');
});

test('restamp: a placeholder whose replacement is only a best guess goes to a person (i8MK)', () => {
  // Door add-on written twice at 5,398; the rewrite was later cancelled. The
  // main job is Paid In Full at a different value. "Newest live" would move the
  // stamp onto the main job — a guess, so it is suggested, never written.
  const jobs = [
    job('54944', 'Cancelled', 18000, { contractdate: '2025-10-17T00:00:00' }),
    job('57476', 'Paid In Full', 26980, { payments: paid(26980, '2026-07-14T00:00:00'), contractdate: '2026-04-04T00:00:00' }),
    job('57907', 'New', 5398, { contractdate: '2026-05-02T00:00:00' }),
    job('58935', 'Cancelled', 5398, { payments: paid(500, '2026-07-30T00:00:00'), contractdate: '2026-07-01T00:00:00' }),
  ];
  assert.deepEqual(
    restampDecision({ stampedJobId: '57907', status: 'open', monetaryValue: null, jobs }),
    { write: false, reason: 'placeholder_needs_review', suggest: '57476' },
  );
});

test('restamp: a closed opp whose real job cannot be told apart is left alone', () => {
  const jobs = [
    job('1', 'New', 5000),
    job('2', 'Paid In Full', 5000, { payments: paid(5000) }),
    job('3', 'Paid In Full', 7000, { payments: paid(7000) }),
  ];
  const d = restampDecision({ stampedJobId: '1', status: 'won', monetaryValue: null, jobs });
  assert.equal(d.write, false);
  assert.equal(d.reason, 'placeholder_but_ambiguous_multi_job');
});

// ─── the reconciler's untracked path uses the same filter ────────────

test('reconciler: an unstamped opp with a placeholder copy closes won on the real job', () => {
  // Reconciler rows carry lp_job_milestones (act_date), never payments.
  const jobs = [
    { lp_job_id: '58867', job_status: 'Paid In Full', job_value: 13450, milestones: [{ mdt_id: 'C', act_date: '2026-09-09' }] },
    { lp_job_id: '59236', job_status: 'New', job_value: 13450, contractdate: '2026-06-24T00:00:00', milestones: [] },
  ];
  const d = stageDecision({ currentStageId: 'x', jobs, mapping: {} });
  assert.equal(d.verdict, 'win');
  assert.equal(d.job.lp_job_id, '58867');
});

test('reconciler: a placeholder next to a cancelled job reports the cancelled job', () => {
  const jobs = [
    { lp_job_id: '58297', job_status: 'New', job_value: 41000, contractdate: '2026-05-23T00:00:00', milestones: [] },
    { lp_job_id: '58322', job_status: 'Cancelled', job_value: 41000, milestones: [{ mdt_id: 'M', act_date: '2026-05-29' }] },
  ];
  const d = stageDecision({ currentStageId: 'x', jobs, mapping: {} });
  assert.equal(d.verdict, 'lose');
  assert.equal(d.job.lp_job_id, '58322');
});
