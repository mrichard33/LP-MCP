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

import { decidingJob, sourceForJob, terminalGuardMode } from '../src/p2-opportunity-context.js';
import { p2SourceRepair } from './backfill-p2-opportunity-source.js';

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
