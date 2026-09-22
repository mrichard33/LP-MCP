// scripts/test-backfill-p2-opportunity-job-id.js
//
// The two decisions in scripts/backfill-p2-opportunity-job-id.js that a person
// cannot check by reading the output: which LP job an opportunity tracks, and
// whether the mirror is fresh enough to write from.
//
// jobIdMatch decides 2,488 PERMANENT writes and had no test at all. The rule it
// inherits from every other repair in this repo:
//
//   an unstamped opportunity is an inconvenience;
//   one lead's job id stamped onto a different job is not.
//
// So the cases that matter here are the REFUSALS. A multi-job contact whose
// opportunity is already closed says nothing about which job it tracked, and the
// only correct answer is to decline and list it for a manual pass.
//
// The freshness tests exist because the guard fired backwards on 2026-09-22 and
// blocked the single-row canary — see assertMirrorFresh's comment.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  jobIdMatch, mirrorAgeHours, mirrorFreshnessSQL,
} from './backfill-p2-opportunity-job-id.js';

/** A job row in the shape lp_jobs / jobsForContact return. */
const job = (id, value, status = 'Sold') => ({
  lp_job_id: id, job_value: value, job_status: status,
});

// ─── only_job ───────────────────────────────────────────────────────────────

test('one job is stamped without consulting anything else', () => {
  const r = jobIdMatch({ status: 'won', monetaryValue: 999, jobs: [job(58862, 1500)] });
  assert.deepEqual(r, { write: true, jobId: '58862', how: 'only_job' });
});

test('one job is stamped even when the opportunity carries no value', () => {
  // A closed opp with a blank monetaryValue is still unambiguous at one job.
  for (const v of [null, undefined, 0, '']) {
    const r = jobIdMatch({ status: 'lost', monetaryValue: v, jobs: [job(58862, 1500)] });
    assert.equal(r.how, 'only_job', `monetaryValue ${JSON.stringify(v)}`);
  }
});

test('the job id is returned as a STRING, matching the custom field', () => {
  // OPP_CF_LP_JOB_ID is a text field and readOppJobId compares strings. A number
  // here would write 58862 and read back "58862" — equal by luck, not by design.
  const r = jobIdMatch({ status: 'open', monetaryValue: 0, jobs: [job(58862, 1500)] });
  assert.equal(typeof r.jobId, 'string');
});

// ─── no job ─────────────────────────────────────────────────────────────────

test('no jobs refuses rather than writing an empty id', () => {
  for (const jobs of [[], null, undefined, [null, undefined]]) {
    const r = jobIdMatch({ status: 'won', monetaryValue: 1500, jobs });
    assert.deepEqual(r, { write: false, reason: 'no_lp_job' }, JSON.stringify(jobs));
  }
});

// ─── value_match ────────────────────────────────────────────────────────────

test('exactly one job matching the opportunity value wins', () => {
  const jobs = [job(1, 1500), job(2, 2400), job(3, 9900)];
  const r = jobIdMatch({ status: 'won', monetaryValue: 2400, jobs });
  assert.deepEqual(r, { write: true, jobId: '2', how: 'value_match' });
});

test('the value compare is to the cent, from either side as a string', () => {
  const jobs = [job(1, '1500.00'), job(2, '2400.55')];
  assert.equal(jobIdMatch({ status: 'won', monetaryValue: '2400.55', jobs }).jobId, '2');
  assert.equal(jobIdMatch({ status: 'won', monetaryValue: 2400.55, jobs }).jobId, '2');
});

test('a cent off is not a match', () => {
  // Near-misses are the dangerous kind: close enough to look right in a summary,
  // wrong on the record forever.
  const jobs = [job(1, '1500.00'), job(2, '2400.55')];
  const r = jobIdMatch({ status: 'won', monetaryValue: 2400.56, jobs });
  assert.equal(r.write, false, 'a penny apart is a different job');
});

test('two jobs sharing the value is not a match', () => {
  const jobs = [job(1, 2400), job(2, 2400)];
  const r = jobIdMatch({ status: 'won', monetaryValue: 2400, jobs });
  assert.deepEqual(r, { write: false, reason: 'ambiguous_multi_job' });
});

test('a zero or missing opportunity value never drives a match', () => {
  // A job worth 0 must not be selected by an opp whose value was never set.
  const jobs = [job(1, 0), job(2, 3000)];
  for (const v of [0, null, undefined, '', 'n/a', -5]) {
    const r = jobIdMatch({ status: 'won', monetaryValue: v, jobs });
    assert.equal(r.write, false, `monetaryValue ${JSON.stringify(v)} must not select`);
  }
});

test('a job with an unparseable value is simply not a candidate', () => {
  const jobs = [job(1, null), job(2, 2400)];
  assert.equal(jobIdMatch({ status: 'won', monetaryValue: 2400, jobs }).jobId, '2');
});

// ─── deciding_job, and the closed-opportunity refusal ───────────────────────

test('an OPEN opportunity with no value match falls back to decidingJob', () => {
  // Same rule the live path and the reconciler already use: newest live job.
  const jobs = [job(100, 1000, 'Paid In Full'), job(200, 2000, 'Sold')];
  const r = jobIdMatch({ status: 'open', monetaryValue: 7777, jobs });
  assert.deepEqual(r, { write: true, jobId: '200', how: 'deciding_job' });
});

test('a CLOSED opportunity with no value match REFUSES', () => {
  // This is the heart of it. Won/lost is a historical fact about a job we can no
  // longer identify; decidingJob answers "which job is live NOW", which is a
  // different question and would confidently stamp the wrong one.
  const jobs = [job(100, 1000, 'Paid In Full'), job(200, 2000, 'Sold')];
  for (const status of ['won', 'lost', 'abandoned']) {
    const r = jobIdMatch({ status, monetaryValue: 7777, jobs });
    assert.deepEqual(r, { write: false, reason: 'ambiguous_multi_job' }, status);
  }
});

test('value_match outranks deciding_job on an open opportunity', () => {
  // The value was written FROM the job, so it is the stronger signal.
  const jobs = [job(100, 1000, 'Sold'), job(200, 2000, 'Sold')];
  const r = jobIdMatch({ status: 'open', monetaryValue: 1000, jobs });
  assert.deepEqual(r, { write: true, jobId: '100', how: 'value_match' });
});

test('an open opportunity whose jobs are ALL cancelled still resolves', () => {
  // decidingJob falls back to the newest id when nothing is live, rather than
  // leaving an open opp on the board unidentified.
  const jobs = [job(100, 1000, 'Cancelled'), job(200, 2000, 'Dead Deal')];
  const r = jobIdMatch({ status: 'open', monetaryValue: 7777, jobs });
  assert.equal(r.write, true);
  assert.equal(r.how, 'deciding_job');
});

// ─── mirror freshness ───────────────────────────────────────────────────────

test('mirrorAgeHours measures from the timestamp, not from the row count', () => {
  const now = Date.parse('2026-09-22T21:00:00Z');
  assert.equal(mirrorAgeHours('2026-09-22T21:00:00Z', now), 0);
  assert.equal(mirrorAgeHours('2026-09-22T18:00:00Z', now), 3);
  assert.equal(mirrorAgeHours('2026-09-11T19:51:41Z', now).toFixed(1), '265.1');
});

test('an unreadable timestamp is null, never 0', () => {
  // 0 would read as "perfectly fresh" and license the write this guard exists
  // to block. null is the caller's cue to refuse.
  for (const bad of [null, undefined, '', '   ', 'never', {}, NaN]) {
    assert.equal(mirrorAgeHours(bad, Date.now()), null, JSON.stringify(bad));
  }
});

test('the freshness probe spans the pipeline and carries NO opportunity filter', () => {
  // 2026-09-22 regression. Freshness measured over the CANDIDATE rows meant
  // "when did this opportunity last change", so `--opportunity-id=` on any
  // untouched row reported 265.2h and refused to write while the pipeline's
  // newest sync was 0.17h old. This assertion is the guard on that guard.
  const sql = mirrorFreshnessSQL();
  assert.match(sql, /max\(synced_at\)/, 'asks for the newest sync');
  assert.match(sql, /ghl_pipeline_id = '44mOrpmHqk7YqZN9vSPW'/, 'scoped to P2');
  assert.match(sql, /deleted_at IS NULL/);
  assert.doesNotMatch(sql, /ghl_opportunity_id/,
    'a single-id filter here turns "is the sync alive" into "was this row edited lately"');
  assert.doesNotMatch(sql, /LIMIT/, 'an aggregate over the whole pipeline, not a sample');
});
