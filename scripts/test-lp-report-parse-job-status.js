/**
 * Guards for src/jobs/lp-report-parse-job-status.js — the Job Status Report
 * YTD CSV parser (open-job stock snapshot, three-bucket build).
 *
 * Invariants under guard:
 *   • The bucket map covers exactly the 23 statuses in the 2026-08-05
 *     export and partitions them 2 hoa-family + 11 other_pending + 10
 *     excluded; 'Hold - Permit' is its OWN bucket (flagged for Mark's
 *     ruling — collapsing later is a one-line change here).
 *   • An unmapped 24th status fails the file closed (unmapped_status).
 *   • Money is cents; FinAmount's one-decimal print ('6288.9' → 628890)
 *     parses exactly; unparseable gross fails closed; '0' is valid.
 *   • Bucket counts foot to the row count — no row vanishes or doubles.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JOB_STATUS_BUCKET_MAP, classifyJobStatus, parseJobStatusCsv, validateJobStatusCsv,
} from '../src/jobs/lp-report-parse-job-status.js';

const HEADER = 'CustName,cst_id,Phone,id,pds_id,contractid,jbs_id,contractdate,grossamount,NETDATE,statusdate,FinAmount,descr,RepName,Rep2Name,FinCo,DH,PW,S2,S3,C1,C2,C3,PRM,SGD,BAY,BOW,GAR,RF,SI,UNotes,FullName,xPDS_ID,SDate,EDate,xSrc_ID,UseColor,CurrentDateTime';

const row = (over = {}) => {
  const base = {
    CustName: 'Doe, Jane', cst_id: '123456', Phone: '(555)555-0100', id: '1', pds_id: '2',
    contractid: '35001', jbs_id: '3', contractdate: '5/16/2026', grossamount: '12000',
    NETDATE: '', statusdate: '6/1/2026', FinAmount: '', descr: 'HOLD - HOA',
    RepName: 'Rep One', Rep2Name: '', FinCo: '', DH: '', PW: '', S2: '', S3: '', C1: '', C2: '',
    C3: '', PRM: '', SGD: '', BAY: '', BOW: '', GAR: '', RF: '', SI: '', UNotes: 'note',
    FullName: 'Mark Richard', xPDS_ID: 'ALL', SDate: '1/1/2026', EDate: '8/5/2026',
    xSrc_ID: 'ALL', UseColor: 'TRUE', CurrentDateTime: '8/5/2026 10:31',
  };
  const quote = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return HEADER.split(',').map((h) => quote(({ ...base, ...over })[h] ?? '')).join(',');
};

const csv = (...rows) => [HEADER, ...rows].join('\n');

test('bucket map: exactly the 23 known statuses, correct partition', () => {
  const entries = Object.entries(JOB_STATUS_BUCKET_MAP);
  assert.equal(entries.length, 23);
  const byBucket = {};
  for (const [, b] of entries) byBucket[b] = (byBucket[b] || 0) + 1;
  assert.deepEqual(byBucket, { hoa: 1, permit: 1, other_pending: 11, excluded: 10 });
  assert.equal(classifyJobStatus('HOLD - HOA'), 'hoa');
  assert.equal(classifyJobStatus('Hold - Permit'), 'permit');
  assert.equal(classifyJobStatus('  Awaiting Product '), 'excluded');
  assert.equal(classifyJobStatus('Totally New Status'), null);
});

test('parse: dates, cents, one-decimal FinAmount, notes', () => {
  const { rows, header } = parseJobStatusCsv(csv(
    row({ grossamount: '6288.9', FinAmount: '6288.9', NETDATE: '7/1/2026' }),
  ));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.gross_cents, 628890);
  assert.equal(r.fin_cents, 628890);
  assert.equal(r.contract_date, '2026-05-16');
  assert.equal(r.net_date, '2026-07-01');
  assert.equal(r.bucket, 'hoa');
  assert.equal(header.periodStart, '2026-01-01');
  assert.equal(header.periodEnd, '2026-08-05');
  assert.equal(header.asOf, '2026-08-05');
});

test('validate: clean file passes, bucket counts foot', () => {
  const parsed = parseJobStatusCsv(csv(
    row(),
    row({ cst_id: '2', descr: 'Hold - Permit', grossamount: '343564' }),
    row({ cst_id: '3', descr: 'Quoted' }),
    row({ cst_id: '4', descr: 'Awaiting Product' }),
  ));
  const v = validateJobStatusCsv(parsed);
  assert.equal(v.ok, true);
  assert.deepEqual(v.bucketCounts, { hoa: 1, permit: 1, other_pending: 1, excluded: 1 });
});

test('validate: a 24th status fails the file closed', () => {
  const parsed = parseJobStatusCsv(csv(row({ descr: 'Hold - Alien Invasion' })));
  const v = validateJobStatusCsv(parsed);
  assert.equal(v.ok, false);
  assert.equal(v.violations[0].rule, 'unmapped_status');
  assert.deepEqual(v.violations[0].detail.statuses, ['Hold - Alien Invasion']);
});

test('validate: unparseable gross fails closed; $0 gross is valid', () => {
  const bad = validateJobStatusCsv(parseJobStatusCsv(csv(row({ grossamount: 'oops' }))));
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].rule, 'money_parse_failed');
  const zero = validateJobStatusCsv(parseJobStatusCsv(csv(row({ grossamount: '0', descr: 'New' }))));
  assert.equal(zero.ok, true);
});

test('validate: missing cst_id fails closed', () => {
  const v = validateJobStatusCsv(parseJobStatusCsv(csv(row({ cst_id: '' }))));
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.rule === 'missing_cst_id'));
});
