/**
 * Guards for src/jobs/lp-report-parse-job-status.js — the report 133
 * "Jobs by Status" CSV parser.
 *
 * The export this parser was FIRST built against no longer exists. This suite
 * is pinned to the real March 2026 file (`report-133-job-status-mar.csv`,
 * 525 rows), because every defect below was live against a synthetic fixture
 * that agreed with the parser and disagreed with LP:
 *
 *   • REQUIRED demanded seven columns the shipped export does not have, so the
 *     router accepted every file and the parser rejected it. REQUIRED is now
 *     minimal, exported, and asserted ⊆ the real header in test-lp-csv-cutover.
 *   • ContractDate prints a TWO-DIGIT year ('03/01/26'). parseCsvDate requires
 *     four and returns null, which would have nulled the one column that now
 *     defines the cohort — on all 525 rows, silently.
 *   • TotalDue prints LP's four-decimal form on 478 of 525 rows. The strict
 *     parseMoneyCents returns null for '0.0000', which would have failed the
 *     whole file closed on money that is perfectly well-formed.
 *   • `id` is NOT unique (524 distinct over 525 rows), so it cannot be a row key.
 *
 * Invariants under guard:
 *   • All 14 shipped statuses map to a non-null bucket; an invented 15th fails
 *     the whole file closed (unmapped_status) rather than being guessed.
 *   • Buckets partition the file: 331 completed + 167 lost + 25 in_production
 *     + 1 hoa + 1 permit = 525. `lost` and `completed` are separately
 *     addressable — the reporting value of this export is cancellation and
 *     credit-decline volume, which `excluded` could not express.
 *   • Money is cents across integer, four-decimal and NEGATIVE forms.
 *   • CurrentDateTime keeps its time.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  JOB_STATUS_BUCKET_MAP, JOB_STATUS_BUCKETS, GOOD_BUSINESS_BUCKETS,
  classifyJobStatus, parseJobStatusCsv, validateJobStatusCsv, REQUIRED,
} from '../src/jobs/lp-report-parse-job-status.js';
import { parseCsv } from '../src/jobs/lp-report-csv-common.js';

const FIXTURE = 'scripts/fixtures/lp-reports/report-133-job-status-mar.csv';
const TEXT = readFileSync(FIXTURE, 'utf8');

/** Re-emit the fixture with one cell changed, RFC-4180 intact. */
function doctor(mutate) {
  const rows = parseCsv(TEXT).filter((r) => !(r.length === 1 && r[0] === ''));
  mutate(rows[0], rows.slice(1));
  return `${rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')}\r\n`;
}
const col = (header, name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());

// ── the bucket map ──────────────────────────────────────────────────────────

test('bucket map: every value is a declared bucket, and all six are reachable', () => {
  const used = new Set(Object.values(JOB_STATUS_BUCKET_MAP));
  for (const b of used) assert.ok(JOB_STATUS_BUCKETS.includes(b), `undeclared bucket ${b}`);
  assert.deepEqual([...used].sort(), [...JOB_STATUS_BUCKETS].sort());
});

test('bucket map: terminal outcomes are separately addressable, not folded away', () => {
  // The whole point of the 2026-08-07 rewrite. If either of these collapses
  // into another bucket, cancellation volume by market stops being answerable.
  assert.equal(JOB_STATUS_BUCKET_MAP['Paid In Full'], 'completed');
  assert.equal(JOB_STATUS_BUCKET_MAP['PIF Survey Ready'], 'completed');
  for (const s of ['Cancelled', 'Cancelled By Mgt', 'Credit Decline', 'Dead Deal']) {
    assert.equal(JOB_STATUS_BUCKET_MAP[s], 'lost', s);
  }
  // Good Business is the three OPEN buckets — never "everything not excluded".
  assert.deepEqual(GOOD_BUSINESS_BUCKETS, ['hoa', 'permit', 'other_pending']);
  for (const b of ['in_production', 'completed', 'lost']) {
    assert.ok(!GOOD_BUSINESS_BUCKETS.includes(b), `${b} must not count as open Good Business`);
  }
});

test('bucket map: the released/production track kept its membership under the rename', () => {
  // 'excluded' → 'in_production' was a rename, not a re-bucketing.
  for (const s of ['Rel To Production', 'RTP Await recission', 'RTP DP DUE',
    'Awaiting Product', 'Out to Measure', 'Product Received', 'Scheduled',
    'Started', 'Installed & Unpaid', 'Sent To Attorney']) {
    assert.equal(JOB_STATUS_BUCKET_MAP[s], 'in_production', s);
  }
  assert.ok(!Object.values(JOB_STATUS_BUCKET_MAP).includes('excluded'));
});

test('classify: trims, and returns null for anything unmapped', () => {
  assert.equal(classifyJobStatus('  Paid In Full  '), 'completed');
  assert.equal(classifyJobStatus('Definitely Not A Status'), null);
  assert.equal(classifyJobStatus(''), null);
  assert.equal(classifyJobStatus(undefined), null);
});

// ── REQUIRED ────────────────────────────────────────────────────────────────

test('REQUIRED is minimal and every name is really in the shipped export', () => {
  assert.deepEqual(REQUIRED, ['id', 'Market', 'ContractDate', 'grossamount', 'Status', 'SDate', 'EDate']);
  const header = parseCsv(TEXT)[0].map((h) => h.trim().toLowerCase());
  for (const c of REQUIRED) assert.ok(header.includes(c.toLowerCase()), `${c} absent from the real export`);
  // The seven columns that caused the outage must never come back.
  for (const gone of ['cst_id', 'NETDATE', 'statusdate', 'FinAmount', 'descr', 'RepName', 'FinCo']) {
    assert.ok(!REQUIRED.includes(gone), `${gone} is not in this export and cannot be required`);
  }
});

test('parse: column lookup is case-insensitive — never stricter than the router', () => {
  const upper = doctor((header) => { for (let i = 0; i < header.length; i++) header[i] = header[i].toUpperCase(); });
  const parsed = parseJobStatusCsv(upper);
  assert.equal(parsed.rows.length, 525);
  assert.equal(validateJobStatusCsv(parsed).ok, true);
});

// ── the real file ───────────────────────────────────────────────────────────

test('parse: the March export yields 525 rows and validates clean', () => {
  const parsed = parseJobStatusCsv(TEXT);
  assert.equal(parsed.rows.length, 525);
  const v = validateJobStatusCsv(parsed);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
});

test('parse: record count differs from line count — newlines live inside quotes', () => {
  const lines = TEXT.split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === '')).length;
  const { rows } = parseJobStatusCsv(TEXT);
  assert.equal(rows.length, 525);
  assert.notEqual(lines, rows.length + 1);
  assert.ok(rows.some((r) => /\n/.test(r.notes_raw ?? '')), 'no note carries an embedded newline');
});

test('validate: all 14 shipped statuses bucket, and the counts foot to 525', () => {
  const parsed = parseJobStatusCsv(TEXT);
  assert.equal(new Set(parsed.rows.map((r) => r.status_raw)).size, 14);
  assert.equal(parsed.rows.filter((r) => r.bucket == null).length, 0);

  const { bucketCounts } = validateJobStatusCsv(parsed);
  assert.deepEqual(bucketCounts, {
    completed: 331, lost: 167, in_production: 25, hoa: 1, permit: 1,
  });
  assert.equal(Object.values(bucketCounts).reduce((a, b) => a + b, 0), 525);

  // 143 is Cancelled + Credit Decline alone; `lost` also carries Dead Deal (20)
  // and Cancelled By Mgt (4). Pinned because the handoff quoted both numbers.
  const by = (s) => parsed.rows.filter((r) => r.status_raw === s).length;
  assert.equal(by('Cancelled') + by('Credit Decline'), 143);
  assert.equal(by('Cancelled') + by('Credit Decline') + by('Dead Deal') + by('Cancelled By Mgt'), 167);
});

test('validate: an invented 15th status rejects the WHOLE file, not just its row', () => {
  const mutated = doctor((header, rows) => { rows[0][col(header, 'Status')] = 'Awaiting Teleportation'; });
  const parsed = parseJobStatusCsv(mutated);
  assert.equal(parsed.rows[0].bucket, null);

  const v = validateJobStatusCsv(parsed);
  assert.equal(v.ok, false);
  const violation = v.violations.find((x) => x.rule === 'unmapped_status');
  assert.ok(violation, JSON.stringify(v.violations));
  assert.deepEqual(violation.detail, { count: 1, statuses: ['Awaiting Teleportation'] });
});

// ── dates ───────────────────────────────────────────────────────────────────

test('parse: ContractDate\'s two-digit year resolves on every row', () => {
  // The regression that would have emptied the cohort column in silence.
  const { rows } = parseJobStatusCsv(TEXT);
  assert.equal(rows.filter((r) => !r.contract_date).length, 0);
  assert.equal(rows[0].contract_date, '2026-03-01');
  assert.ok(rows.every((r) => r.contract_date.startsWith('2026-03')),
    'every row of a March cohort must carry a March contract date');
});

test('validate: an unparseable ContractDate fails closed', () => {
  const mutated = doctor((header, rows) => { rows[0][col(header, 'ContractDate')] = ''; });
  const v = validateJobStatusCsv(parseJobStatusCsv(mutated));
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.rule === 'missing_contract_date'), JSON.stringify(v.violations));
});

test('parse: the period and generation time come from the file, with the time kept', () => {
  const { header } = parseJobStatusCsv(TEXT);
  assert.equal(header.periodStart, '2026-03-01');
  assert.equal(header.periodEnd, '2026-03-31');
  // 8/7/2026 3:00:10 PM ET → 19:00:10Z. Truncating this to a date is what made
  // is_partial_month unknowable and stopped periods ever closing.
  assert.equal(header.generatedAt, '2026-08-07T19:00:10.000Z');
  assert.equal(header.generatedAtTruncated, false);
  assert.equal(header.asOf, '2026-08-07');
});

// ── money ───────────────────────────────────────────────────────────────────

test('parse: money is cents across integer, four-decimal and negative forms', () => {
  const { rows, subCentColumns } = parseJobStatusCsv(TEXT);
  assert.equal(rows.filter((r) => r.gross_cents == null).length, 0);
  assert.equal(rows.filter((r) => r.total_due_cents == null).length, 0);
  assert.equal(rows[0].gross_cents, 999000);            // '9990'
  assert.equal(rows[0].total_due_cents, 0);             // '0.0000' — NOT null
  assert.equal(rows.reduce((a, r) => a + r.gross_cents, 0), 1190339900);

  // TotalDue is legitimately negative on 18 rows — an overpayment, not corruption.
  assert.equal(rows.filter((r) => r.total_due_cents < 0).length, 18);
  // Nothing in this file actually loses sub-cent precision.
  assert.deepEqual(subCentColumns, []);
});

test('parse: four-decimal and negative money round-trip exactly', () => {
  const mutated = doctor((header, rows) => {
    rows[0][col(header, 'grossamount')] = '28900.0000';
    rows[0][col(header, 'TotalDue')] = '-0.5';
    rows[1][col(header, 'grossamount')] = '0';
    rows[1][col(header, 'TotalDue')] = '1,234.56';
  });
  const { rows } = parseJobStatusCsv(mutated);
  assert.equal(rows[0].gross_cents, 2890000);
  assert.equal(rows[0].total_due_cents, -50);
  assert.equal(rows[1].gross_cents, 0);                  // '0' is valid, not absent
  assert.equal(rows[1].total_due_cents, 123456);
});

test('validate: an unparseable grossamount fails closed', () => {
  const mutated = doctor((header, rows) => { rows[0][col(header, 'grossamount')] = 'N/A'; });
  const v = validateJobStatusCsv(parseJobStatusCsv(mutated));
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.rule === 'money_parse_failed'), JSON.stringify(v.violations));
});

// ── identity and carried columns ────────────────────────────────────────────

test('parse: job_id is the row key; lp_id is a join key and is NOT unique', () => {
  const { rows } = parseJobStatusCsv(TEXT);
  assert.equal(new Set(rows.map((r) => r.job_id)).size, 525, 'job_id must be unique per row');
  // 414605 covers two separate jobs. Keying an upsert on lp_id would silently
  // drop one of them, which is why the migration keys on job_id.
  assert.equal(new Set(rows.map((r) => r.lp_id)).size, 524);
  // contractid carries the literal 'NEW' on 8 rows — also not a key.
  assert.equal(rows.filter((r) => r.contract_id === 'NEW').length, 8);
});

test('validate: a row with no job_id fails closed', () => {
  const mutated = doctor((header, rows) => { rows[0][col(header, 'job_id')] = ''; });
  const v = validateJobStatusCsv(parseJobStatusCsv(mutated));
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.rule === 'missing_job_id'), JSON.stringify(v.violations));
});

test('parse: branch travels with the row — no 135 join needed', () => {
  const { rows } = parseJobStatusCsv(TEXT);
  assert.equal(rows.filter((r) => !r.market_code_raw).length, 0, 'Market is populated on every row');
  assert.deepEqual([...new Set(rows.map((r) => r.market_code_raw))].sort(),
    ['BOCA', 'FTLAU', 'FTMYR', 'JAX', 'LAKE', 'MIAMI', 'ORL', 'SAR', 'STPET']);
  // District is the fallback, not the source: blank on 3 rows.
  assert.equal(rows.filter((r) => !r.district_raw).length, 3);
});

test('parse: multi-value columns become arrays, empties dropped', () => {
  const { rows } = parseJobStatusCsv(TEXT);
  assert.deepEqual(rows[0].product_ids, ['Door']);
  assert.deepEqual(rows[0].finance_sources, ['Finance']);
  assert.ok(rows.every((r) => r.product_ids.every(Boolean)), 'no empty product id');
  assert.ok(rows.every((r) => r.finance_sources.every(Boolean)), 'no empty finance source');

  const mutated = doctor((header, rows2) => {
    rows2[0][col(header, 'ProductID')] = 'Win';
    rows2[0][col(header, 'ProductID2')] = '';
    rows2[0][col(header, 'ProductID3')] = 'Door';
    rows2[0][col(header, 'FinanceSource2')] = 'Cash';
  });
  const m = parseJobStatusCsv(mutated).rows[0];
  assert.deepEqual(m.product_ids, ['Win', 'Door']);
  assert.deepEqual(m.finance_sources, ['Finance', 'Cash']);
});

test('parse: the five dropped columns are gone, not silently zeroed', () => {
  // They have no source in this export. Emitting 0/'' would have looked like
  // measured data; absent is the honest representation.
  const row = parseJobStatusCsv(TEXT).rows[0];
  for (const gone of ['fin_cents', 'net_date', 'status_date', 'rep_name', 'fin_co', 'cst_id']) {
    assert.ok(!(gone in row), `${gone} must not be emitted`);
  }
});

test('parse: a file missing a required column is rejected by name', () => {
  const stripped = doctor((header, rows) => {
    const i = col(header, 'Status');
    header.splice(i, 1);
    for (const r of rows) r.splice(i, 1);
  });
  assert.throws(() => parseJobStatusCsv(stripped), /CSV missing required columns \(Status\)/);
});
