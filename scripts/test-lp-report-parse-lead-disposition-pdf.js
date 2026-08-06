/**
 * Guards for src/jobs/lp-report-parse-lead-disposition-pdf.js — report 135
 * "Lead Disposition Detail", parsed from `pdftotext -bbox-layout` by
 * coordinate clustering.
 *
 * FIXTURE PII RULING (2026-08-06) — settled, do not re-litigate.
 * Report 135 carries last name, phone, email and street address for ~1,194 real
 * customers; report 136 carries none of that. The repo's standing rule
 * (scripts/fixtures/lp-reports/README.md) is that RAW PDFs ARE NEVER COMMITTED
 * and fixtures are redacted pdftotext OUTPUT. So neither of the options offered
 * in the build spec applies literally: what is committed here is redacted
 * -bbox-layout XML, gzipped.
 *
 * The committed fixture is PAGES 1–6 of the real 2026-08-06 file (31 KB
 * gzipped; the whole file is 651 KB gzipped, far past this repo's fixture
 * norm). Redaction is structure-preserving — glyphs only, never coordinates,
 * token counts or line-wrap points — and is verified: the fully-redacted file
 * parses to the identical 1,194 rows, ten bands and zero warnings as the
 * original. Numbers, `Totals:` lines, band labels, the column header and page
 * furniture are never masked; they are what the goldens assert.
 *
 * The full-file goldens (1,194 rows, all ten band totals) run only when an
 * operator drops the full redacted XML in place, and skip cleanly otherwise —
 * the same pattern reports A and B already use.
 */

process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseLeadDispositionPdf, validateLeadDispositionPdf, parseBboxPages,
  deriveColumns, splitPhoneEmail, splitAddress, classifyPromoter,
  parseWindowLine, normalizeVocab, leadDispositionFacts,
  UNASSIGNED_BAND, LD_RESULT_VOCAB,
} from '../src/jobs/lp-report-parse-lead-disposition-pdf.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXCERPT = join(HERE, 'fixtures/lp-reports/report-135-lead-disposition-p1-6.bbox.xml.gz');
const FULL = join(HERE, 'fixtures/lp-reports/report-135-lead-disposition-full.bbox.xml');

const excerpt = parseLeadDispositionPdf(gunzipSync(readFileSync(EXCERPT)).toString('utf8'));

/** Printed band totals, read off the real file. Σ = 1,194. */
const BAND_TOTALS = [
  [UNASSIGNED_BAND, 70], ['BOCA', 49], ['FTLAU', 51], ['FTMYR', 201], ['JAX', 136],
  ['LAKE', 31], ['MIAMI', 33], ['ORL', 240], ['SAR', 138], ['STPET', 245],
];

// ── Geometry ────────────────────────────────────────────────────────────────

test('column boundaries derive from the header, and the report is landscape letter', () => {
  const pages = parseBboxPages(gunzipSync(readFileSync(EXCERPT)).toString('utf8'));
  assert.equal(pages.length, 6);
  assert.equal(Math.round(pages[0].width), 792);
  const cols = deriveColumns(pages[0]);
  assert.equal(cols.error, undefined);
  assert.equal(cols.bounds.length, 10); // 11 columns → 10 interior boundaries
  // Strictly increasing, or every assignment downstream is meaningless.
  for (let i = 1; i < cols.bounds.length; i++) assert.ok(cols.bounds[i] > cols.bounds[i - 1]);
});

test('a column runs to the NEXT column start — not to a midpoint of header words', () => {
  // `# Dials` is right-aligned: a single digit prints at x≈682 under a header
  // starting at x≈663. Midpoint-of-starts would put that digit in Last Result.
  const pages = parseBboxPages(gunzipSync(readFileSync(EXCERPT)).toString('utf8'));
  const { bounds } = deriveColumns(pages[0]);
  const dialsResult = bounds[9];
  assert.ok(dialsResult > 682 && dialsResult < 693,
    `Dials|Result boundary ${dialsResult} must sit between a single digit (≈682) and Result (693.1)`);
});

// ── Bands and counts ────────────────────────────────────────────────────────

test('Test 3 — the leading UNLABELED band is retained as UNASSIGNED, never NULL', () => {
  // Page 1 begins with detail rows and the band closes on page 6 with a bare
  // `Totals: 70`. A NULL branch is silently dropped by downstream joins and 70
  // leads vanish with no error.
  const band = excerpt.bands.find((b) => b.label === UNASSIGNED_BAND);
  assert.ok(band, 'unlabeled band not detected');
  assert.equal(band.printed, 70);
  assert.equal(band.parsed, 70);
  assert.equal(excerpt.rows.filter((r) => r.branch_code_raw === UNASSIGNED_BAND).length, 70);
  assert.equal(excerpt.rows.filter((r) => r.branch_code_raw == null).length, 0);
  assert.ok(excerpt.rows.filter((r) => r.branch_band_unlabeled).length >= 70);
});

test('Test 10a — a TRUNCATED file fails closed on the missing grand total', () => {
  // The excerpt stops at page 6, so `Grand Totals:` never arrives. A short file
  // must not quietly report the rows it happened to get.
  const v = validateLeadDispositionPdf(excerpt);
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.rule === 'missing_grand_total'));
});

// ── Hazards, on real rows ───────────────────────────────────────────────────

test('Test 4/5 — duplicate Prosp # yields DISTINCT rows; nothing is deduped', () => {
  // LP's own Totals count ROWS. 434640 appears twice with DIFFERENT entry dates.
  const dupes = excerpt.rows.filter((r) => r.prosp_no === '434640');
  assert.equal(dupes.length, 2);
  assert.equal(new Set(dupes.map((r) => r.entry_date)).size, 2);
  // Identity is the file-global ordinal, never the prosp number.
  assert.equal(new Set(excerpt.rows.map((r) => r.row_ordinal)).size, excerpt.rows.length);
});

test('Test 6 — blank last names are retained, not dropped', () => {
  // The page-1 Iheart/Simpletext block carries no name at all.
  const blank = excerpt.rows.filter((r) => !r.last_name);
  assert.ok(blank.length >= 38, `expected the unnamed Iheart block, got ${blank.length}`);
  for (const r of blank) assert.ok(r.prosp_no, 'a nameless row still needs its prosp #');
});

test('Test 7 — a wrapped Last Result reassembles across interleaved lines', () => {
  // `Answering` and `Machine` are one value; on prosp 449705 an address comma
  // and a sub-source print on the line between them. This is the case that
  // makes -layout unusable and coordinate clustering necessary.
  const r = excerpt.rows.find((x) => x.prosp_no === '449705');
  assert.ok(r, 'prosp 449705 missing');
  assert.equal(r.last_result_raw, 'Answering Machine');
  assert.equal(r.dials, 15);
});

test('Test 8 — a mid-token email wrap rejoins with NO inserted whitespace', () => {
  // `project@thesolarvoltaic.co` + `m`. The local part is masked in the
  // fixture; the domain and the rejoin point are what matter.
  const r = excerpt.rows.find((x) => x.prosp_no === '449617');
  assert.ok(r, 'prosp 449617 missing');
  assert.match(r.email_raw, /^[^\s@]+@thesolarvoltaic\.com$/);
  assert.ok(!/\s/.test(r.email_raw), 'email must not contain whitespace');
  // The same row's phone is malformed and wraps too — free text, never validated.
  assert.match(r.phone_raw, /^\(\s*\d+\)\d+-\d+\s+\d+$/);
});

test('Test 9 — the apostrophe in Can’t Do Project matches the REAL encoding', () => {
  // The live file uses ASCII U+0027 (43 61 6e 27 74), not U+2019. Matching only
  // the typographic form would have missed every one of these rows.
  assert.ok(LD_RESULT_VOCAB.includes("Can't Do Project"));
  assert.equal(normalizeVocab('Can’t Do Project'), "Can't Do Project");
  assert.equal(normalizeVocab("Can't Do Project"), "Can't Do Project");
  const hits = excerpt.rows.filter((r) => /^Can't Do Project$/.test(r.last_result_raw ?? ''));
  assert.ok(hits.length >= 1, 'no Can’t Do Project row matched the vocabulary');
});

test('Test 11 — an unmapped vocabulary value WARNS; the snapshot still lands', () => {
  // Report 133 fails 25x a day on unmapped_status. Only counts are fail-closed
  // here. The real file produces zero vocabulary warnings, so drive the path
  // directly: a value outside the vocabulary is kept raw and reported.
  assert.equal(excerpt.warnings.filter((w) => w.kind.startsWith('unmapped_')).length, 0);
  const v = validateLeadDispositionPdf({
    rows: [{}], bands: [{ label: 'ORL', printed: 1, parsed: 1 }],
    grandTotalPrinted: 1, warnings: [{ kind: 'unmapped_dispo', detail: { prosp: '1', value: 'Wat' } }],
  });
  assert.equal(v.ok, true, 'an unmapped value must not fail the file');
  assert.ok(v.reconciliations.some((r) => r.scope === 'unmapped_dispo'));
});

// ── Pure helpers ────────────────────────────────────────────────────────────

test('phone and email wrap DIFFERENTLY — space-joined vs concatenated', () => {
  assert.deepEqual(
    splitPhoneEmail([[{ text: '( 91)786-2005' }], [{ text: '030' }]]),
    { phone: '( 91)786-2005 030', email: null },
  );
  assert.deepEqual(
    splitPhoneEmail([[{ text: '(561)251-2931' }], [{ text: 'mamag418@gmail.co' }], [{ text: 'm' }]]),
    { phone: '(561)251-2931', email: 'mamag418@gmail.com' },
  );
  assert.deepEqual(splitPhoneEmail([]), { phone: null, email: null });
});

test('address splits city/state/zip and tolerates the bare comma rows', () => {
  // The real Giovinazzo row: street and city arrive on different lines and are
  // joined by the band before this splits them.
  assert.deepEqual(splitAddress('9807 Pavarotti Ter Apt 202 Boynton Beach, FL 33437'),
    { address: '9807 Pavarotti Ter Apt 202', city: 'Boynton Beach', state: 'FL', zip: '33437' });
  // Unrecognised shapes keep the whole string rather than guessing a city.
  assert.deepEqual(splitAddress('undefined'),
    { address: 'undefined', city: null, state: null, zip: null });
  assert.deepEqual(splitAddress('123 Main St, Orlando, FL 32801'),
    { address: '123 Main St', city: 'Orlando', state: 'FL', zip: '32801' });
  assert.deepEqual(splitAddress(','), { address: null, city: null, state: null, zip: null });
});

test('Test 9b — promoter suffix classifies the PROMOTER, never the market', () => {
  assert.equal(classifyPromoter('Muldoon, Joshua - SARA'), 'rep');
  assert.equal(classifyPromoter('Rodriguez, Joshua - LKLND'), 'rep');
  assert.equal(classifyPromoter('Internet, Lead Gurus'), 'channel');
  assert.equal(classifyPromoter('Cust., Prev.'), 'channel');
  assert.equal(classifyPromoter(', Referral'), 'channel');
  assert.equal(classifyPromoter(''), null);
});

test('the reporting window parses off the header line', () => {
  assert.deepEqual(
    parseWindowLine('Saturday, August 1, 2026 through Monday, August 31, 2026'),
    { periodStart: '2026-08-01', periodEnd: '2026-08-31' },
  );
});

test('facts roll up at BRANCH grain, keeping UNASSIGNED as its own branch', () => {
  const f = leadDispositionFacts(excerpt.rows);
  const total = f.leads.reduce((a, x) => a + x.count, 0);
  assert.equal(total, excerpt.rows.length);
  assert.ok(f.leads.some((x) => x.branch === UNASSIGNED_BAND && x.count === 70));
  // No display rollup happens here — FTLAU/BOCA/MIAMI stay separate branches.
  assert.ok(!f.leads.some((x) => x.branch === 'FTLAU_MKT'));
});

// ── Full-file goldens (skip until the operator drops the file in) ───────────

test('golden: the whole file ties to 1,194 rows and ten band totals', (t) => {
  if (!existsSync(FULL)) {
    t.skip('full redacted fixture not present — see scripts/fixtures/lp-reports/README.md');
    return;
  }
  const parsed = parseLeadDispositionPdf(readFileSync(FULL, 'utf8'));
  const v = validateLeadDispositionPdf(parsed);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  assert.equal(parsed.rows.length, 1194);
  assert.equal(parsed.grandTotalPrinted, 1194);
  assert.deepEqual(parsed.bands.map((b) => [b.label, b.printed]), BAND_TOTALS);
  for (const b of parsed.bands) assert.equal(b.parsed, b.printed, `band ${b.label}`);

  // Scope: the window declares Aug 1–31 but the file was generated Aug 6, so a
  // period end in the future means month-to-date.
  assert.deepEqual(parsed.header, {
    periodStart: '2026-08-01', periodEnd: '2026-08-31', asOf: '2026-08-06', scope: 'mtd',
  });

  // Cross-band duplicates survive intact.
  const castro = parsed.rows.filter((r) => r.prosp_no === '449987');
  assert.deepEqual(castro.map((r) => r.branch_code_raw).sort(), [UNASSIGNED_BAND, 'LAKE'].sort());
  const brown = parsed.rows.filter((r) => r.prosp_no === '449622');
  assert.deepEqual(brown.map((r) => r.branch_code_raw).sort(), [UNASSIGNED_BAND, 'STPET'].sort());
  assert.equal(parsed.rows.filter((r) => r.prosp_no === '449816').length, 3);

  // TAMPA is a rep territory, never a market — and a rep's suffix never sets one.
  const markets = new Set(parsed.rows.map((r) => r.branch_code_raw));
  assert.ok(!markets.has('TAMPA'));
  assert.deepEqual([...markets].sort(), BAND_TOTALS.map(([l]) => l).sort());
  const sara = parsed.rows.filter((r) => /- SARA$/.test(r.promoter_raw ?? ''));
  assert.ok(new Set(sara.map((r) => r.branch_code_raw)).size > 1,
    'SARA-suffixed reps appear in more than one band — the suffix is not the market');

  // Junk is flagged, never filtered: filtering would break the checksum.
  assert.ok(parsed.rows.some((r) => r.test_row_suspect));
  assert.equal(parsed.rows.length, 1194);

  // Nothing unmapped on the real file.
  assert.deepEqual(parsed.warnings, []);
});
