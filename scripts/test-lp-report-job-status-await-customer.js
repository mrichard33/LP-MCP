// Regression: LP added the status 'Await Customer' without notice and report
// 133 "Jobs By Status" fail-closed on unmapped_status for four consecutive days
// (2026-08-18 through 2026-08-21). The rows below are the two real rows from
// the 8/21 export that triggered it.
//
// Two things are under test and BOTH matter: that this specific status now
// buckets, and that the fail-closed gate itself still fires for the next
// unannounced status. Widening the map must never become loosening the gate.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJobStatusCsv,
  validateJobStatusCsv,
  classifyJobStatus,
  JOB_STATUS_BUCKET_MAP,
  GOOD_BUSINESS_BUCKETS,
} from '../src/jobs/lp-report-parse-job-status.js';

const HEADER = '"id","District","Market","custname","city","ContractDate","grossamount","job_id","contractid","Status","TotalDue","SDate","EDate","CurrentDateTime"';

const csv = (...rows) => [HEADER, ...rows].join('\r\n');

const AWAIT_CUSTOMER_ROWS = csv(
  '"451421","STPET","STPET","Garcia , Marielis","Holiday","08/10/26","19000","59476","37202","Await Customer","19000","8/1/2026","8/20/2026","8/21/2026 6:00:32 AM"',
  '"451825","SAR","SAR","Houser, Richard & Tong","Bradenton","08/13/26","68828","59522","37251","Await Customer","68828","8/1/2026","8/20/2026","8/21/2026 6:00:32 AM"',
);

test('Await Customer maps to other_pending', () => {
  assert.equal(classifyJobStatus('Await Customer'), 'other_pending');
});

test('Await Customer is trimmed before lookup', () => {
  assert.equal(classifyJobStatus('  Await Customer  '), 'other_pending');
});

test('Await Customer counts into open Good Business', () => {
  assert.ok(GOOD_BUSINESS_BUCKETS.includes(JOB_STATUS_BUCKET_MAP['Await Customer']));
});

test('the 2026-08-21 export no longer fails closed', () => {
  const parsed = parseJobStatusCsv(AWAIT_CUSTOMER_ROWS);
  const v = validateJobStatusCsv(parsed);
  assert.equal(v.violations.find((x) => x.rule === 'unmapped_status'), undefined);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(v.bucketCounts.other_pending, 2);
});

test('an unknown status still fails the file closed', () => {
  const parsed = parseJobStatusCsv(csv(
    '"451421","STPET","STPET","Test, Row","Holiday","08/10/26","19000","59476","37202","Await Unicorn","19000","8/1/2026","8/20/2026","8/21/2026 6:00:32 AM"',
  ));
  const v = validateJobStatusCsv(parsed);
  const hit = v.violations.find((x) => x.rule === 'unmapped_status');
  assert.ok(hit, 'expected unmapped_status violation');
  assert.deepEqual(hit.detail.statuses, ['Await Unicorn']);
  assert.equal(v.ok, false);
});
