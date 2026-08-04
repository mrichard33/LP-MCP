/**
 * Guards for src/jobs/lp-report-parse-b.js — "Jobs By Status" (open pipeline).
 *
 * Invariants under guard:
 *   • RULED 2026-08-04: two reporting buckets only — hoa / other_pending.
 *     Hold - Permit is other_pending; there is NO permit bucket. Excluded
 *     statuses (cancelled/dead/declined/RTP-adjacent) map to 'excluded'.
 *   • An unknown 22nd status classifies to NULL (→ quarantine + file
 *     rejection), never a guessed bucket.
 *   • Money is parsed ONLY from the anchor line after the status cell —
 *     note lines like 'MSRP $21,750' can NEVER leak into total_gross.
 *   • Wrapped statuses (Awaiting Change / Order) and wrapped customer names
 *     re-join; the completion word never becomes a note.
 *   • Same Prosp# + same contract date → dup_review on BOTH rows; same
 *     Prosp# on different dates is legitimate and unflagged.
 *
 * Golden-file assertions (428 rows, $10,456,216 gross, Hold-HOA 65/$1,379,228,
 * Credit Decline 30/$680,720, Cancelled-group 66/$1,675,576) run ONLY when
 * the redacted fixture exists — see scripts/fixtures/lp-reports/README.md.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  KNOWN_STATUSES, STATUS_BUCKET_MAP, classifyStatus,
  parseJobsByStatus, flagDuplicates, validateJobsByStatus, sumByBucket, dupReviewRows,
} from '../src/jobs/lp-report-parse-b.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/lp-reports/report-b-jobs-by-status.txt');

const SYNTHETIC = `Reece Windows & Doors
Jobs By Status
Report Date: 8/4/2026

ORL    445566   Maria Gonzalez        (407) 555-1212   maria@example.com   6/10/2026   HOLD - HOA        21,500
BOCA   445577   John Longnamerson     (561) 555-3434   john@example.com    6/12/2026   Awaiting Change   18,250   GreenSky
Order
SAR    445588   Pat Newman            (941) 555-9876   pat@example.com     6/20/2026   New               12,000
Customer called 7/15 - HOA meeting 8/10. MSRP $21,750 quoted.
JAX    445599   Quinn Ochoa           (904) 555-4321   quinn@example.com   6/22/2026   Hold - Permit     9,750
STPET  445600   Rae Silva             (727) 555-6543   rae@example.com     6/25/2026   Credit Decline    $0
Total # Records: 5    Total: 61,500
`;

test('bucket map: the ruling holds — 21 statuses, no permit bucket', () => {
  assert.equal(KNOWN_STATUSES.length, 21);
  assert.equal(classifyStatus('HOLD - HOA'), 'hoa');
  assert.equal(classifyStatus('Hold - Permit'), 'other_pending'); // RULED: no permit bucket
  assert.equal(classifyStatus('Rel To Production'), 'excluded');
  assert.equal(classifyStatus('RTP Await recission'), 'excluded');
  assert.equal(classifyStatus('Cancelled By Mgt'), 'excluded');
  assert.equal(classifyStatus('Awaiting Commission Sheet'), 'other_pending');
  assert.equal(classifyStatus('Totally Made Up'), null);
  const buckets = new Set(STATUS_BUCKET_MAP.values());
  assert.deepEqual([...buckets].sort(), ['excluded', 'hoa', 'other_pending']);
});

test('synthetic: rows, columns, buckets — and all gates pass', () => {
  const parsed = parseJobsByStatus(SYNTHETIC);
  assert.equal(parsed.rows.length, 5);

  const [hoa, wrapped, newRow, permit, decline] = parsed.rows;
  assert.equal(hoa.prosp_number, '445566');
  assert.equal(hoa.customer_name, 'Maria Gonzalez');
  assert.equal(hoa.phone, '(407) 555-1212');
  assert.equal(hoa.email, 'maria@example.com');
  assert.equal(hoa.contract_date, '2026-06-10');
  assert.equal(hoa.status_raw, 'HOLD - HOA');
  assert.equal(hoa.bucket, 'hoa');
  assert.equal(hoa.total_gross_cents, 2150000);

  assert.equal(newRow.status_raw, 'New'); // boundary-safe: 'Newman' in the name didn't match
  assert.equal(newRow.bucket, 'other_pending');
  assert.equal(permit.status_raw, 'Hold - Permit');
  assert.equal(permit.bucket, 'other_pending');
  assert.equal(decline.total_gross_cents, 0); // $0 is a valid value
  assert.equal(decline.bucket, 'excluded');
  assert.equal(wrapped.lender, 'GreenSky');

  const check = validateJobsByStatus(parsed);
  assert.deepEqual(check.violations, []);
  assert.equal(check.ok, true);
});

test('wrapped status re-joins: Awaiting Change + Order, money from the anchor line', () => {
  const { rows } = parseJobsByStatus(SYNTHETIC);
  const wrapped = rows.find((r) => r.prosp_number === '445577');
  assert.equal(wrapped.status_raw, 'Awaiting Change Order');
  assert.equal(wrapped.bucket, 'other_pending');
  assert.equal(wrapped.total_gross_cents, 1825000);
  assert.equal(wrapped.notes_raw, null); // 'Order' was consumed, not noted
});

test('note-noise: MSRP $21,750 stays in notes_raw, never in total_gross', () => {
  const { rows } = parseJobsByStatus(SYNTHETIC);
  const noisy = rows.find((r) => r.prosp_number === '445588');
  assert.equal(noisy.total_gross_cents, 1200000); // the anchor-line 12,000 — not 21,750
  assert.match(noisy.notes_raw, /MSRP \$21,750/);
});

test('unknown 22nd status: null bucket, no money guessed, file rejected', () => {
  const doctored = SYNTHETIC
    .replace('New               12,000', 'Await Legal       12,000')
    .replace('Customer called 7/15 - HOA meeting 8/10. MSRP $21,750 quoted.\n', '');
  const parsed = parseJobsByStatus(doctored);
  const bad = parsed.rows.find((r) => r.prosp_number === '445588');
  assert.equal(bad.status_raw, null);
  assert.equal(bad.bucket, null);
  assert.equal(bad.total_gross_cents, null); // no status anchor → no money column read

  const check = validateJobsByStatus(parsed);
  const hit = check.violations.find((v) => v.rule === 'unmapped_status');
  assert.ok(hit, 'expected unmapped_status violation');
  assert.equal(hit.detail.count, 1);
  assert.equal(check.ok, false);
});

test('duplicates: same Prosp#+date flags both; different dates stay clean', () => {
  const rows = [
    { prosp_number: '111', contract_date: '2026-06-01', dup_review: false },
    { prosp_number: '111', contract_date: '2026-06-01', dup_review: false },
    { prosp_number: '222', contract_date: '2026-06-01', dup_review: false },
    { prosp_number: '222', contract_date: '2026-07-01', dup_review: false },
  ];
  flagDuplicates(rows);
  assert.equal(rows[0].dup_review, true);
  assert.equal(rows[1].dup_review, true);
  assert.equal(rows[2].dup_review, false);
  assert.equal(rows[3].dup_review, false);
});

test('footer gates: count and total mismatches are rejected with both sides', () => {
  const badCount = SYNTHETIC.replace('Total # Records: 5', 'Total # Records: 6');
  const c1 = validateJobsByStatus(parseJobsByStatus(badCount));
  assert.ok(c1.violations.find((v) => v.rule === 'footer_count_mismatch'));

  const badTotal = SYNTHETIC.replace('Total: 61,500', 'Total: 61,750');
  const c2 = validateJobsByStatus(parseJobsByStatus(badTotal));
  const hit = c2.violations.find((v) => v.rule === 'footer_total_mismatch');
  assert.ok(hit);
  assert.equal(hit.detail.printed_cents, 6175000);
  assert.equal(hit.detail.computed_cents, 6150000);
});

test('sumByBucket rolls count + cents per bucket', () => {
  const { rows } = parseJobsByStatus(SYNTHETIC);
  const buckets = sumByBucket(rows);
  assert.deepEqual(buckets.get('hoa'), { count: 1, cents: 2150000 });
  assert.deepEqual(buckets.get('other_pending'), { count: 3, cents: 4000000 });
  assert.deepEqual(buckets.get('excluded'), { count: 1, cents: 0 });
});

test('dup_review rows are excluded from bucket totals by default but retained (ruled 2026-08-04)', () => {
  // A doctored duplicate of the HOA row: same Prosp# + same contract date.
  const dupLine = 'ORL    445566   Maria Gonzalez        (407) 555-1212   maria@example.com   6/10/2026   HOLD - HOA        21,500';
  const doctored = SYNTHETIC
    .replace(dupLine, `${dupLine}\n${dupLine}`)
    .replace('Total # Records: 5    Total: 61,500', 'Total # Records: 6    Total: 83,000');
  const parsed = parseJobsByStatus(doctored);
  flagDuplicates(parsed.rows);

  // Parse-integrity ties are on ALL rows — the PDF prints the dups.
  assert.equal(validateJobsByStatus(parsed).ok, true);
  assert.equal(parsed.rows.length, 6);

  // Reporting default: both flagged rows held OUT of the hoa bucket…
  const buckets = sumByBucket(parsed.rows);
  assert.equal(buckets.get('hoa'), undefined);
  assert.deepEqual(buckets.get('other_pending'), { count: 3, cents: 4000000 });

  // …restorable explicitly (the raw-PDF sum)…
  const raw = sumByBucket(parsed.rows, { includeDupReview: true });
  assert.deepEqual(raw.get('hoa'), { count: 2, cents: 4300000 });

  // …and surfaced, never dropped.
  const held = dupReviewRows(parsed.rows);
  assert.equal(held.length, 2);
  assert.ok(held.every((r) => r.prosp_number === '445566'));
});

test('golden: fixture ties to the report footer (skipped until fixture exists)', (t) => {
  if (!existsSync(FIXTURE)) {
    t.skip('redacted fixture not present — see scripts/fixtures/lp-reports/README.md');
    return;
  }
  const parsed = parseJobsByStatus(readFileSync(FIXTURE, 'utf8'));
  flagDuplicates(parsed.rows);
  const check = validateJobsByStatus(parsed);
  assert.deepEqual(check.violations, []);
  assert.equal(parsed.rows.length, 428);

  const grossSum = parsed.rows.reduce((a, r) => a + (r.total_gross_cents ?? 0), 0);
  assert.equal(grossSum, 1045621600); // $10,456,216

  const hoa = parsed.rows.filter((r) => r.bucket === 'hoa');
  assert.equal(hoa.length, 65);
  assert.equal(hoa.reduce((a, r) => a + (r.total_gross_cents ?? 0), 0), 137922800); // $1,379,228

  const decline = parsed.rows.filter((r) => r.status_raw === 'Credit Decline');
  assert.equal(decline.length, 30);
  assert.equal(decline.reduce((a, r) => a + (r.total_gross_cents ?? 0), 0), 68072000); // $680,720

  const cancelled = parsed.rows.filter((r) => ['Cancelled', 'Cancelled By Mgt'].includes(r.status_raw));
  assert.equal(cancelled.length, 66);
  assert.equal(cancelled.reduce((a, r) => a + (r.total_gross_cents ?? 0), 0), 167557600); // $1,675,576
});
