/**
 * scripts/test-p2-opportunity-context.js
 *
 * Pure unit tests for the P2 create-path context — no database, no network.
 * Pins three things the live path now depends on:
 *   1. WHICH job decides a new P2 opportunity (decidingJob)
 *   2. WHAT source that job carries (sourceForJob)
 *   3. WHEN the terminal-job create guard is allowed to act (terminalGuardMode)
 * plus the pure repair decision in scripts/backfill-p2-opportunity-source.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decidingJob, sourceForJob, terminalGuardMode,
  readOppJobId, resolveTrackedJob, OPP_CF_LP_JOB_ID,
} from '../src/p2-opportunity-context.js';
import { p2SourceRepair } from './backfill-p2-opportunity-source.js';
import { jobIdMatch } from './backfill-p2-opportunity-job-id.js';

// ─── fixtures ────────────────────────────────────────────────────────
const job = (lp_job_id, job_status, lp_lead_id, job_value = '15000') =>
  ({ lp_job_id, job_status, lp_lead_id, job_value });
const lead = (lp_lead_id, lead_source, lead_source_detail) =>
  ({ lp_lead_id, lead_source, lead_source_detail });

// ─── decidingJob ─────────────────────────────────────────────────────

test('a single cancelled job is terminal_lost, not "no job"', () => {
  const jobs = [job(54595, 'Cancelled', 900)];
  const d = decidingJob(jobs);
  assert.equal(d.verdict, 'terminal_lost');
  assert.equal(d.job.lp_job_id, 54595);
});

test('Canvass/Canvass collapses to a single "Canvass", never "Canvass, Canvass"', () => {
  const jobs = [job(54595, 'Cancelled', 900)];
  const leads = [lead(900, 'Canvass', 'Canvass')];
  assert.equal(sourceForJob(decidingJob(jobs).job, leads), 'Canvass');
});

test('an old Paid In Full does not decide over a newer live job', () => {
  const jobs = [job(40001, 'Paid In Full', 700), job(58862, 'Awaiting Product', 900)];
  const d = decidingJob(jobs);
  assert.equal(d.verdict, 'live');
  assert.equal(d.job.lp_job_id, 58862);
});

test('the source comes from the lead owning the DECIDING job, not any lead', () => {
  const jobs = [job(40001, 'Paid In Full', 700), job(58862, 'Awaiting Product', 900)];
  const leads = [lead(700, 'Canvass', 'Canvass'), lead(900, 'Internet', 'Modernize')];
  assert.equal(sourceForJob(decidingJob(jobs).job, leads), 'Internet, Modernize');
});

test('Credit Decline alone is terminal_lost', () => {
  assert.equal(decidingJob([job(54595, 'Credit Decline', 900)]).verdict, 'terminal_lost');
});

test('"Installed & Unpaid" is live — the work is done, the money is not', () => {
  const d = decidingJob([job(54595, 'Installed & Unpaid', 900)]);
  assert.equal(d.verdict, 'live');
  assert.equal(d.job.lp_job_id, 54595);
});

test('every WON status is terminal_won', () => {
  for (const status of ['Paid In Full', 'PIF Survey Ready', 'PIF NO Survey', 'Assumed Complete']) {
    assert.equal(decidingJob([job(1, status, 900)]).verdict, 'terminal_won', status);
  }
});

test('every LOST status is terminal_lost', () => {
  for (const status of ['Cancelled', 'Cancelled By Mgt', 'Dead Deal', 'Sent To Attorney', 'Credit Decline']) {
    assert.equal(decidingJob([job(1, status, 900)]).verdict, 'terminal_lost', status);
  }
});

test('no jobs at all is no_job with a null job — never a guess', () => {
  const d = decidingJob([]);
  assert.equal(d.verdict, 'no_job');
  assert.equal(d.job, null);
});

// ─── sourceForJob fallbacks ──────────────────────────────────────────

test('with no job, ONE distinct lead label is still safe to use', () => {
  const leads = [lead(900, 'Internet', 'Modernize'), lead(901, 'Internet', 'Modernize')];
  assert.equal(sourceForJob(null, leads), 'Internet, Modernize');
});

test('with no job and leads that DISAGREE, the answer is null — never a coin flip', () => {
  const leads = [lead(900, 'Internet', 'Modernize'), lead(901, 'Canvass', null)];
  assert.equal(sourceForJob(null, leads), null);
});

test('"SelfGenerated" / "Self Generated" differ by a space, so both parts are kept', () => {
  const leads = [lead(900, 'SelfGenerated', 'Self Generated')];
  assert.equal(sourceForJob(job(1, 'Awaiting Product', 900), leads), 'SelfGenerated, Self Generated');
});

test('a job whose lead is missing falls back to the single-label rule, not to null', () => {
  const leads = [lead(901, 'Internet', 'Modernize')];
  assert.equal(sourceForJob(job(1, 'Awaiting Product', 900), leads), 'Internet, Modernize');
});

// ─── terminalGuardMode ───────────────────────────────────────────────

test('the guard mode defaults to shadow and never throws on garbage', () => {
  const prior = process.env.P2_TERMINAL_CREATE_GUARD_MODE;
  try {
    delete process.env.P2_TERMINAL_CREATE_GUARD_MODE;
    assert.equal(terminalGuardMode(), 'shadow', 'unset');
    process.env.P2_TERMINAL_CREATE_GUARD_MODE = 'banana';
    assert.equal(terminalGuardMode(), 'shadow', 'garbage');
    process.env.P2_TERMINAL_CREATE_GUARD_MODE = '';
    assert.equal(terminalGuardMode(), 'shadow', 'empty');
    process.env.P2_TERMINAL_CREATE_GUARD_MODE = ' ENFORCE ';
    assert.equal(terminalGuardMode(), 'enforce', 'case and whitespace tolerant');
    process.env.P2_TERMINAL_CREATE_GUARD_MODE = 'off';
    assert.equal(terminalGuardMode(), 'off');
  } finally {
    if (prior === undefined) delete process.env.P2_TERMINAL_CREATE_GUARD_MODE;
    else process.env.P2_TERMINAL_CREATE_GUARD_MODE = prior;
  }
});

// ─── p2SourceRepair ──────────────────────────────────────────────────
const repair = (over) => ({
  current: null, status: 'open', target: 'Internet, Modernize', distinctLabels: 1,
  overwriteMismatch: !!over,
});

test('a null source is FILLED', () => {
  const d = p2SourceRepair(repair());
  assert.deepEqual(d, { write: true, value: 'Internet, Modernize', kind: 'fill' });
});

test("the 'lp-backstop' sentinel is an absence, so it is FILLED not overwritten", () => {
  const d = p2SourceRepair({ ...repair(), current: 'lp-backstop' });
  assert.equal(d.kind, 'fill');
});

test('a bare parent is EXTENDED with its subsource', () => {
  const d = p2SourceRepair({ ...repair(), current: 'Internet' });
  assert.deepEqual(d, { write: true, value: 'Internet, Modernize', kind: 'extend' });
});

test('a value that already matches is left alone', () => {
  const d = p2SourceRepair({ ...repair(), current: 'Internet, Modernize' });
  assert.deepEqual(d, { write: false, reason: 'unchanged' });
});

test('a different vocabulary is REPORTED, not rewritten', () => {
  const d = p2SourceRepair({ ...repair(), current: 'Window Estimator' });
  assert.deepEqual(d, { write: false, reason: 'vocabulary_mismatch' });
});

test('--overwrite-mismatch turns that same row into a write', () => {
  const d = p2SourceRepair({ ...repair(true), current: 'Window Estimator' });
  assert.deepEqual(d, { write: true, value: 'Internet, Modernize', kind: 'overwrite' });
});

test('a CLOSED opp whose contact has disagreeing jobs is never guessed at', () => {
  const d = p2SourceRepair({ ...repair(), status: 'won', current: 'Internet', distinctLabels: 2 });
  assert.deepEqual(d, { write: false, reason: 'ambiguous_multi_job' });
});

test('an OPEN opp is still repaired even when the contact has disagreeing jobs', () => {
  const d = p2SourceRepair({ ...repair(), status: 'open', current: 'Internet', distinctLabels: 2 });
  assert.equal(d.kind, 'extend');
});

test('no LP source means nothing is written, whatever the opp currently says', () => {
  assert.deepEqual(p2SourceRepair({ ...repair(), target: null }), { write: false, reason: 'no_lp_source' });
  assert.deepEqual(
    p2SourceRepair({ ...repair(), current: 'Internet', target: null }),
    { write: false, reason: 'no_lp_source' },
  );
});

// ═══════════════════════════════════════════════════════════════════
// v5.5 — the opportunity records WHICH LP job it tracks
// ═══════════════════════════════════════════════════════════════════

const CANCELLED = 'Cancelled';
const LIVE = 'Awaiting Product';
const WON = 'Paid In Full';

// ─── readOppJobId ────────────────────────────────────────────────────

test('readOppJobId reads fieldValueString, the shape GHL actually returns', () => {
  const opp = { customFields: [{ id: OPP_CF_LP_JOB_ID, type: 'string', fieldValueString: '58862' }] };
  assert.equal(readOppJobId(opp), '58862');
});

test('readOppJobId ignores other custom fields on the same opportunity', () => {
  const opp = { customFields: [
    { id: 'someOtherFieldId00', type: 'string', fieldValueString: 'No' },
    { id: OPP_CF_LP_JOB_ID, type: 'string', fieldValueString: '54595' },
  ] };
  assert.equal(readOppJobId(opp), '54595');
});

test('an absent, blank or whitespace LP Job ID reads as null, never as ""', () => {
  assert.equal(readOppJobId({ customFields: [] }), null, 'empty array');
  assert.equal(readOppJobId({}), null, 'no customFields at all');
  assert.equal(readOppJobId(null), null, 'no opp');
  assert.equal(readOppJobId({ customFields: [{ id: OPP_CF_LP_JOB_ID, fieldValueString: '' }] }), null, 'blank');
  assert.equal(readOppJobId({ customFields: [{ id: OPP_CF_LP_JOB_ID, fieldValueString: '   ' }] }), null, 'spaces');
});

test('an OBJECT-shaped custom_fields reads as null instead of throwing', () => {
  // Regression, 2026-09-21. The HL mirror's opportunities.custom_fields column
  // defaults to '{}'::jsonb, so a row the opportunity sync has not written
  // custom fields for arrives as an OBJECT, not an array — 253 such rows in P2.
  // The original guard was `(opp?.customFields || []).find(...)`, and {} is
  // truthy, so the fallback never fired and .find threw. That took
  // scripts/backfill-p2-opportunity-job-id.js down on its first object-shaped
  // row, before it scanned a single opportunity. The suite missed it because
  // every case above passes an array or omits the key.
  assert.equal(readOppJobId({ customFields: {} }), null, 'the mirror default');
  assert.equal(readOppJobId({ customFields: { someKey: 'someValue' } }), null, 'a populated object');
});

test('readOppJobId never throws on any shape the two sources can produce', () => {
  // GHL returns an array or omits the key; the mirror can return either shape.
  // Nothing here should be an error — absence of a stamp is a null, not a fault,
  // and a scan over thousands of rows must not die on one odd row.
  for (const shape of [{}, [], null, undefined, 0, '', 'string', 42, true, [null], [{}]]) {
    assert.doesNotThrow(() => readOppJobId({ customFields: shape }), `shape: ${JSON.stringify(shape)}`);
    assert.equal(readOppJobId({ customFields: shape }), null, `shape: ${JSON.stringify(shape)}`);
  }
});

// ─── resolveTrackedJob ───────────────────────────────────────────────

test('a STAMPED job wins over a newer live job — that is the whole point', () => {
  const jobs = [job(40001, WON, 700), job(58862, LIVE, 900)];
  const r = resolveTrackedJob({ jobs, stampedJobId: '40001' });
  assert.equal(r.job.lp_job_id, 40001);
  assert.equal(r.via, 'stamped');
  assert.equal(r.verdict, 'terminal_won');
});

test("an unstamped opp follows the EVENT's job when that job is live", () => {
  const jobs = [job(40001, LIVE, 700), job(58862, LIVE, 900)];
  const r = resolveTrackedJob({ jobs, eventJobId: '40001' });
  assert.equal(r.job.lp_job_id, 40001);
  assert.equal(r.via, 'event');
  assert.equal(r.otherJob, false);
});

test("a TERMINAL event job that is not the latest flags otherJob and does not take over", () => {
  const jobs = [job(40001, CANCELLED, 700), job(58862, LIVE, 900)];
  const r = resolveTrackedJob({ jobs, eventJobId: '40001' });
  assert.equal(r.job.lp_job_id, 58862, 'the live job is still the tracked one');
  assert.equal(r.via, 'latest');
  assert.equal(r.otherJob, true, 'an old job replaying a milestone at a different opportunity');
  assert.equal(r.eventJob.lp_job_id, 40001);
});

test('a terminal event job that IS the tracked one is not "another job"', () => {
  const jobs = [job(58862, WON, 900)];
  const r = resolveTrackedJob({ jobs, eventJobId: '58862' });
  assert.equal(r.job.lp_job_id, 58862);
  assert.equal(r.otherJob, false);
  assert.equal(r.verdict, 'terminal_won');
});

test('a stamped id naming a job we did not read falls through, never refuses', () => {
  const jobs = [job(58862, LIVE, 900)];
  const r = resolveTrackedJob({ jobs, stampedJobId: '99999' });
  assert.equal(r.job.lp_job_id, 58862);
  assert.equal(r.via, 'latest');
});

test('the stamp beats the event even when the event names a live job', () => {
  const jobs = [job(40001, WON, 700), job(58862, LIVE, 900)];
  const r = resolveTrackedJob({ jobs, stampedJobId: '40001', eventJobId: '58862' });
  assert.equal(r.via, 'stamped');
  assert.equal(r.job.lp_job_id, 40001);
});

test('no jobs at all yields a null job and no_job — never a guess', () => {
  const r = resolveTrackedJob({ jobs: [], stampedJobId: '40001', eventJobId: '58862' });
  assert.equal(r.job, null);
  assert.equal(r.verdict, 'no_job');
  assert.equal(r.otherJob, false);
});

test('ids compare across string and number without missing a match', () => {
  const jobs = [job('58862', LIVE, 900)];
  assert.equal(resolveTrackedJob({ jobs, stampedJobId: 58862 }).via, 'stamped');
});

// ─── jobIdMatch ──────────────────────────────────────────────────────

test('one job is one answer', () => {
  const d = jobIdMatch({ status: 'open', monetaryValue: 15000, jobs: [job(58862, LIVE, 900)] });
  assert.deepEqual(d, { write: true, jobId: '58862', how: 'only_job' });
});

test("the opp's value identifies its job to the cent", () => {
  const jobs = [job(40001, WON, 700, '22500.00'), job(58862, LIVE, 900, '15333.00')];
  const d = jobIdMatch({ status: 'won', monetaryValue: 15333, jobs });
  assert.deepEqual(d, { write: true, jobId: '58862', how: 'value_match' });
});

test('an OPEN opp with no value match falls back to the deciding job', () => {
  const jobs = [job(40001, WON, 700, '22500'), job(58862, LIVE, 900, '15333')];
  const d = jobIdMatch({ status: 'open', monetaryValue: null, jobs });
  assert.deepEqual(d, { write: true, jobId: '58862', how: 'deciding_job' });
});

test('a CLOSED opp with no value match is ambiguous, never guessed', () => {
  const jobs = [job(40001, WON, 700, '22500'), job(58862, LIVE, 900, '15333')];
  assert.deepEqual(
    jobIdMatch({ status: 'won', monetaryValue: null, jobs }),
    { write: false, reason: 'ambiguous_multi_job' },
  );
});

test('two jobs sharing one value is ambiguous — a value match must be UNIQUE', () => {
  const jobs = [job(40001, WON, 700, '15333'), job(58862, LIVE, 900, '15333')];
  assert.deepEqual(
    jobIdMatch({ status: 'won', monetaryValue: 15333, jobs }),
    { write: false, reason: 'ambiguous_multi_job' },
  );
});

test('a zero or missing value never matches a job', () => {
  const jobs = [job(40001, WON, 700, '0'), job(58862, LIVE, 900, '15333')];
  assert.deepEqual(
    jobIdMatch({ status: 'lost', monetaryValue: 0, jobs }),
    { write: false, reason: 'ambiguous_multi_job' },
  );
});

test('no LP job at all is reported, not stamped', () => {
  assert.deepEqual(jobIdMatch({ status: 'open', monetaryValue: 15000, jobs: [] }),
    { write: false, reason: 'no_lp_job' });
});
