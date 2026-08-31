/**
 * scripts/test-lp-job-value.js
 *
 * Unit coverage for sumJobValues() — the number that now lands on every
 * opportunity move (src/actions/handlers/opportunities.js).
 *
 * The failure this guards against is a pipeline forecast that is quietly wrong:
 * summing cancelled work, or collapsing a multi-job customer to one job's value.
 * Neither throws, and neither is visible without checking a contact by hand.
 *
 * Pure-function test — no DB, no network.
 * Run: node --test scripts/test-lp-job-value.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { sumJobValues, CANCELLED_JOB_STATUSES } from '../src/lp-job-value.js';

const job = (job_value, job_status = 'Paid In Full') => ({ job_value, job_status });

test('a single live job returns its value', () => {
  assert.equal(sumJobValues([job(12000)]), 12000);
});

test('a multi-job contact SUMS rather than taking the max', () => {
  // The two-window customer. MAX would understate them by the second window.
  assert.equal(sumJobValues([job(12000), job(12000)]), 24000);
});

test('cancelled work is excluded', () => {
  assert.equal(sumJobValues([job(12000), job(9000, 'Cancelled')]), 12000);
  assert.equal(sumJobValues([job(12000), job(9000, 'Cancelled By Mgt')]), 12000);
  assert.equal(sumJobValues([job(12000), job(9000, 'Dead Deal')]), 12000);
});

test("'Credit Decline' still counts — a decline can convert", () => {
  assert.equal(sumJobValues([job(12000, 'Credit Decline')]), 12000);
  assert.ok(!CANCELLED_JOB_STATUSES.has('Credit Decline'));
});

test('a contact whose only jobs are cancelled returns null, NOT 0', () => {
  // The caller must be able to tell "no live work" from "work worth zero", so
  // that a stage move omits monetaryValue instead of clobbering it to 0.
  assert.equal(sumJobValues([job(9000, 'Cancelled')]), null);
  assert.equal(sumJobValues([]), null);
  assert.equal(sumJobValues(), null);
});

test('a live job worth 0 is still a live job, so the total is 0 not null', () => {
  assert.equal(sumJobValues([job(0)]), 0);
});

test('null and unparseable job values are skipped, not treated as zero', () => {
  assert.equal(sumJobValues([job(12000), job(null), job(undefined)]), 12000);
  assert.equal(sumJobValues([job(null)]), null);
});

test('numeric strings from the DB driver are handled', () => {
  assert.equal(sumJobValues([job('12000.50'), job('9000.25')]), 21000.75);
});

test('float tails do not leak into the money value', () => {
  // 9 jobs is the heaviest real contact; naive float addition yields 1e-11 tails.
  const jobs = Array.from({ length: 9 }, () => job(0.1));
  assert.equal(sumJobValues(jobs), 0.9);
});

test('status matching tolerates whitespace but not case', () => {
  assert.equal(sumJobValues([job(9000, '  Cancelled  ')]), null);
});

test('recomputation is idempotent and never additive', () => {
  // The guard against a delta-style write: calling repeatedly on the same set
  // must return the same number, not accumulate.
  const jobs = [job(12000), job(8000), job(5000, 'Cancelled')];
  const first = sumJobValues(jobs);
  assert.equal(first, 20000);
  assert.equal(sumJobValues(jobs), first);
  assert.equal(sumJobValues(jobs), first);
});

test('cancelling a job lowers the recomputed total', () => {
  const before = sumJobValues([job(12000), job(8000)]);
  const after  = sumJobValues([job(12000), job(8000, 'Cancelled')]);
  assert.equal(before, 20000);
  assert.equal(after, 12000);
});

test('malformed rows do not throw', () => {
  assert.doesNotThrow(() => sumJobValues([null, undefined, {}, { job_status: 5 }]));
  assert.equal(sumJobValues([null, {}, job(100)]), 100);
});
