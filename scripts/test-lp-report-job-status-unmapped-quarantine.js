// Report 133 `unmapped_status` is no longer a whole-file rejection.
//
// LP adds job statuses without notice. 'Await Customer' appeared on 2026-08-18
// and fail-closed 133 for four days (08-18 → 08-21) over one or two rows a day,
// costing three daily snapshots to protect against mis-filing two rows. The
// ruling now: quarantine the offending rows, ingest the rest, warn loudly.
//
// BOTH halves are under test, and the second matters more than the first. A
// bucket is money — 'other_pending' is Good Business — so every quarantined row
// is backlog dollars withheld from the dashboard. That is affordable at two
// rows and indefensible at two hundred, so a bulk LP status rename must still
// stop the file rather than land a snapshot that looks fine and is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseJobStatusCsv,
  validateJobStatusCsv,
  judgeUnmappedStatus,
  UNMAPPED_STATUS_MAX_ROWS,
  UNMAPPED_STATUS_MAX_PCT,
} from '../src/jobs/lp-report-parse-job-status.js';

const HEADER = '"id","District","Market","custname","city","ContractDate","grossamount","job_id","contractid","Status","TotalDue","SDate","EDate","CurrentDateTime"';
const csv = (...rows) => [HEADER, ...rows].join('\r\n');

let seq = 0;
const row = (status, gross = 10000) => {
  seq += 1;
  return `"45${1000 + seq}","STPET","STPET","Row ${seq}","Holiday","08/10/26","${gross}","59${1000 + seq}","37${1000 + seq}","${status}","${gross}","8/1/2026","8/20/2026","8/21/2026 6:00:32 AM"`;
};

const judge = (text, opts) => {
  const parsed = parseJobStatusCsv(text);
  const v = validateJobStatusCsv(parsed);
  return { parsed, v, judged: judgeUnmappedStatus(parsed, v.violations, opts) };
};

test('a clean file is not judged at all', () => {
  const { v, judged } = judge(csv(row('Quoted'), row('Scheduled')));
  assert.equal(v.ok, true);
  assert.equal(judged.action, 'none');
});

test('one unknown status among many known rows quarantines rather than rejects', () => {
  const rows = Array.from({ length: 99 }, () => row('Quoted'));
  const { parsed, v, judged } = judge(csv(...rows, row('Await Unicorn', 19000)));

  assert.equal(v.ok, false, 'the validator still reports the violation');
  assert.equal(judged.action, 'quarantine');
  assert.equal(judged.bad.length, 1);
  assert.deepEqual(judged.statuses, ['Await Unicorn']);
  assert.equal(judged.grossCents, 1900000, 'gross travels with the ruling');
  assert.equal(judged.pct, 1);

  // The ingest drops exactly these rows; everything else still lands.
  const kept = parsed.rows.filter((r) => r.bucket != null);
  assert.equal(kept.length, 99);
  assert.equal(kept.every((r) => r.bucket === 'other_pending'), true);
});

test('the real 2026-08-18 shape — 1 unknown row in 180 — quarantines', () => {
  const rows = Array.from({ length: 179 }, () => row('Quoted'));
  const { judged } = judge(csv(...rows, row('Await Customer Unknown')));
  assert.equal(judged.action, 'quarantine');
});

test('a bulk status rename is past the guard and still rejects the file', () => {
  // 30 of 100 rows renamed: well past 2%, and past 10 rows.
  const known = Array.from({ length: 70 }, () => row('Quoted'));
  const renamed = Array.from({ length: 30 }, () => row('Scheduled - Install'));
  const { judged } = judge(csv(...known, ...renamed));

  assert.equal(judged.action, 'reject');
  assert.equal(judged.bad.length, 30);
  assert.equal(judged.pct, 30);
});

test('the row-count half of the guard bites even at a small percentage', () => {
  // 11 unknown of 1100 rows = 1% — under the pct limit, over the row limit.
  const known = Array.from({ length: 1089 }, () => row('Quoted'));
  const unknown = Array.from({ length: 11 }, () => row('Await Unicorn'));
  const { judged } = judge(csv(...known, ...unknown));

  assert.equal(judged.pct, 1, 'inside the percentage limit');
  assert.ok(judged.bad.length > UNMAPPED_STATUS_MAX_ROWS, 'outside the row limit');
  assert.equal(judged.action, 'reject', 'either limit alone is enough to reject');
});

test('the percentage half of the guard bites even at a small row count', () => {
  // 3 unknown of 20 rows = 15% — under the row limit, over the pct limit.
  const known = Array.from({ length: 17 }, () => row('Quoted'));
  const unknown = Array.from({ length: 3 }, () => row('Await Unicorn'));
  const { judged } = judge(csv(...known, ...unknown));

  assert.ok(judged.bad.length <= UNMAPPED_STATUS_MAX_ROWS, 'inside the row limit');
  assert.ok(judged.pct > UNMAPPED_STATUS_MAX_PCT, 'outside the percentage limit');
  assert.equal(judged.action, 'reject');
});

test('the guard is tunable, and tightening it to zero restores fail-closed', () => {
  const rows = Array.from({ length: 99 }, () => row('Quoted'));
  const text = csv(...rows, row('Await Unicorn'));

  assert.equal(judge(text, { maxRows: 0 }).judged.action, 'reject');
  assert.equal(judge(text, { maxPct: 0 }).judged.action, 'reject');
  // An unset env var arrives as undefined and must fall back to the default.
  assert.equal(judge(text, { maxRows: undefined, maxPct: undefined }).judged.action, 'quarantine');
});

test('unmapped_status alongside ANY other violation still rejects the whole file', () => {
  // Same single unknown status, but the file is also missing a job_id. A file
  // with two things wrong is a broken file; softening one of them helps nobody.
  const rows = Array.from({ length: 99 }, () => row('Quoted'));
  const noJobId = '"459999","STPET","STPET","No Job Id","Holiday","08/10/26","19000","","37999","Await Unicorn","19000","8/1/2026","8/20/2026","8/21/2026 6:00:32 AM"';
  const { v, judged } = judge(csv(...rows, noJobId));

  assert.equal(v.ok, false);
  assert.ok(v.violations.length > 1, 'more than one rule fired');
  assert.equal(judged.action, 'none', 'the softening never applies to a multi-violation file');
});

test('multiple distinct unknown statuses are all reported', () => {
  const rows = Array.from({ length: 198 }, () => row('Quoted'));
  const { judged } = judge(csv(...rows, row('Await Unicorn'), row('Await Griffin')));
  assert.equal(judged.action, 'quarantine');
  assert.deepEqual(judged.statuses.sort(), ['Await Griffin', 'Await Unicorn']);
});
