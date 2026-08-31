/**
 * scripts/test-lp-job-value.js
 *
 * Unit coverage for latestJobValue() — the number that lands on every
 * opportunity move (src/actions/handlers/opportunities.js) and on the
 * "LP Gross Sale Amount" contact field (src/ghl-field-sync.js).
 *
 * The failure this guards against is a pipeline forecast that is quietly wrong:
 * summing a repeat customer's jobs so a closed-Won job is counted twice, valuing
 * an opportunity from work that was cancelled, or ordering jobs by a column that
 * is really "when we last synced this row". None of them throws, and none is
 * visible without checking a contact by hand.
 *
 * Pure-function test — no DB, no network.
 * Run: node --test scripts/test-lp-job-value.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { latestJobValue, CANCELLED_JOB_STATUSES } from '../src/lp-job-value.js';

const job = (lp_job_id, job_value, job_status = 'Paid In Full') =>
  ({ lp_job_id: String(lp_job_id), job_value, job_status });

test('a single live job returns its value', () => {
  // The ~1,878 single-job contacts. Nothing about them changes.
  assert.equal(latestJobValue([job(50001, 12000)]), 12000);
});

test('a multi-job contact takes the MOST RECENT job — not the sum, not the max', () => {
  // The returning customer. Summing double-counts the job whose opportunity is
  // already closed Won; max picks whichever job happened to be biggest.
  const jobs = [job(50001, 20000), job(50002, 12000)];
  assert.equal(latestJobValue(jobs), 12000);
  assert.notEqual(latestJobValue(jobs), 32000); // not the sum
  assert.notEqual(latestJobValue(jobs), 20000); // not the max
});

test('most-recent is by lp_job_id, not array order', () => {
  assert.equal(latestJobValue([job(50002, 12000), job(50001, 20000)]), 12000);
  assert.equal(latestJobValue([job(50001, 20000), job(50002, 12000)]), 12000);
});

test('lp_job_id is compared numerically, not as a string', () => {
  // '9' > '50002' lexically. Ordering by string would pick the older job.
  assert.equal(latestJobValue([job(9, 20000), job(50002, 12000)]), 12000);
});

test('a cancelled newest job falls through to the most recent LIVE one', () => {
  // Filtering must happen BEFORE the most-recent pick. Picking first would
  // report the cancelled job and then drop it, valuing the opportunity at null.
  assert.equal(latestJobValue([job(50001, 20000), job(50002, 12000, 'Cancelled')]), 20000);
  assert.equal(latestJobValue([job(50001, 20000), job(50002, 12000, 'Cancelled By Mgt')]), 20000);
  assert.equal(latestJobValue([job(50001, 20000), job(50002, 12000, 'Dead Deal')]), 20000);
});

test("'Credit Decline' still counts — a decline can convert", () => {
  assert.equal(latestJobValue([job(50001, 12000, 'Credit Decline')]), 12000);
  assert.ok(!CANCELLED_JOB_STATUSES.has('Credit Decline'));
});

test('a contact whose only jobs are cancelled returns null, NOT 0', () => {
  // The caller must be able to tell "no live work" from "work worth zero", so
  // that a stage move omits monetaryValue instead of clobbering it to 0.
  assert.equal(latestJobValue([job(50001, 9000, 'Cancelled')]), null);
  assert.equal(latestJobValue([]), null);
  assert.equal(latestJobValue(), null);
});

test('a live job worth 0 is still a live job, so the value is 0 not null', () => {
  assert.equal(latestJobValue([job(50001, 0)]), 0);
});

test('null and unparseable job values are skipped, not treated as zero', () => {
  // A newest job with no value falls through to the newest job that has one,
  // rather than valuing the opportunity at null.
  assert.equal(latestJobValue([job(50001, 12000), job(50002, null)]), 12000);
  assert.equal(latestJobValue([job(50001, null)]), null);
});

test('numeric strings from the DB driver are handled', () => {
  assert.equal(latestJobValue([job(50001, '9000.25'), job(50002, '12000.50')]), 12000.5);
});

test('status matching tolerates whitespace but not case', () => {
  assert.equal(latestJobValue([job(50001, 9000, '  Cancelled  ')]), null);
  assert.equal(latestJobValue([job(50001, 9000, 'cancelled')]), 9000);
});

test('a blank or non-numeric lp_job_id never outranks a real one', () => {
  // Number('') is 0, which would let a blank row beat a job with no id at all.
  assert.equal(latestJobValue([job(50001, 20000), { lp_job_id: '', job_value: 1, job_status: 'x' }]), 20000);
  assert.equal(latestJobValue([job(50001, 20000), { lp_job_id: 'abc', job_value: 1, job_status: 'x' }]), 20000);
  assert.equal(latestJobValue([job(50001, 20000), { job_value: 1, job_status: 'x' }]), 20000);
});

test('an unrankable id is still usable when it is all the contact has', () => {
  assert.equal(latestJobValue([{ lp_job_id: 'abc', job_value: 7000, job_status: 'x' }]), 7000);
});

test('ties on rank resolve deterministically regardless of array order', () => {
  const a = { lp_job_id: 'abc', job_value: 100, job_status: 'x' };
  const b = { lp_job_id: 'abd', job_value: 200, job_status: 'x' };
  assert.equal(latestJobValue([a, b]), latestJobValue([b, a]));
});

test('recomputation is idempotent and never additive', () => {
  // The guard against a delta-style write: calling repeatedly on the same set
  // must return the same number, not accumulate.
  const jobs = [job(50001, 12000), job(50002, 8000), job(50003, 5000, 'Cancelled')];
  const first = latestJobValue(jobs);
  assert.equal(first, 8000);
  assert.equal(latestJobValue(jobs), first);
  assert.equal(latestJobValue(jobs), first);
});

test('cancelling the newest job revalues to the previous one', () => {
  const before = latestJobValue([job(50001, 12000), job(50002, 8000)]);
  const after  = latestJobValue([job(50001, 12000), job(50002, 8000, 'Cancelled')]);
  assert.equal(before, 8000);
  assert.equal(after, 12000);
});

test('a new job supersedes the old value rather than adding to it', () => {
  // The repeat customer, one year on. Under the old sum this returned 20000.
  const firstSale  = [job(50001, 12000)];
  const secondSale = [job(50001, 12000), job(50002, 8000)];
  assert.equal(latestJobValue(firstSale), 12000);
  assert.equal(latestJobValue(secondSale), 8000);
});

test('malformed rows do not throw', () => {
  assert.doesNotThrow(() => latestJobValue([null, undefined, {}, { job_status: 5 }]));
  assert.equal(latestJobValue([null, {}, job(50001, 100)]), 100);
});
