/**
 * Guards for the LP CSV cutover — §A–§G of the 2026-08-06 handoff.
 *
 * LP now schedules CSV exports, so CSV is the go-forward ingest format and the
 * PDF parsers are legacy. Three assumptions the PDF pipeline was built on do
 * not survive that, and each one below is a test:
 *
 *   • The filename no longer carries the report ID — every CSV attachment is
 *     `_<YYMMDDHHMMSS>_Export.csv`. Routing is by header fingerprint.
 *   • There is no footer and no Grand Total row, so nothing ties out against a
 *     printed total.
 *   • file_sha256 cannot dedup a CSV: every row embeds CurrentDateTime, so two
 *     pulls of one period differ byte-for-byte.
 *
 * Plus the two defects that made a duplicate page someone: a 23505 surfacing as
 * a 500 (which n8n replays), and a money parser that returned null — and so, via
 * `?? 0`, silently zero — for LP's four-decimal cells.
 */
process.env.SUPABASE_URL ||= 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  parseCsv, csvToObjects, detectReportFromHeader, parseCsvDateTimeET,
  REPORT_FINGERPRINTS, CONTENT_SORT_KEYS,
} from '../src/jobs/lp-report-csv-common.js';
import {
  parseCsvMoneyCents, parseMoneyCents, parseMoneyCentsExact,
  contentSha256, isUniqueViolation,
} from '../src/jobs/lp-report-common.js';
import {
  parseMilestoneCsv, validateMilestoneCsv, computeMilestoneTotals,
  REQUIRED as MILESTONE_REQUIRED,
} from '../src/jobs/lp-report-parse-milestone-csv.js';
import {
  parseSourceCostCsv, validateSourceCostCsv, REQUIRED as SOURCE_COST_REQUIRED,
} from '../src/jobs/lp-report-parse-source-cost.js';
import {
  parseJobStatusCsv, validateJobStatusCsv, REQUIRED as JOB_STATUS_REQUIRED,
} from '../src/jobs/lp-report-parse-job-status.js';
import {
  parseLeadDispositionCsv, validateLeadDispositionCsv, REQUIRED as LEAD_DISP_REQUIRED,
} from '../src/jobs/lp-report-parse-lead-disposition.js';
import {
  parseSalesEfficiencyCsv, validateSalesEfficiency, CSV_REQUIRED as SALES_EFF_REQUIRED,
} from '../src/jobs/lp-report-parse-sales-efficiency.js';
import {
  parseApptStatsCsv, validateApptStatsCsv, REQUIRED as APPT_STATS_REQUIRED,
} from '../src/jobs/lp-report-parse-appt-stats.js';

const FIX = 'scripts/fixtures/lp-reports';
const read = (f) => readFileSync(`${FIX}/${f}`, 'utf8');

/**
 * Every report's parse contract in one place: the columns it demands, the
 * function that parses, the function that validates.
 *
 * Exported REQUIRED lists are what make the structural test below possible —
 * without them a parser's column demands are invisible to anything but the
 * parser, which is exactly how 133 drifted.
 */
const REGISTRY = {
  job_status_ytd: {
    required: JOB_STATUS_REQUIRED, parse: parseJobStatusCsv, validate: validateJobStatusCsv,
  },
  jobs_by_milestone: {
    required: MILESTONE_REQUIRED, parse: parseMilestoneCsv, validate: validateMilestoneCsv,
  },
  lead_disposition: {
    required: LEAD_DISP_REQUIRED, parse: parseLeadDispositionCsv, validate: validateLeadDispositionCsv,
  },
  source_cost: {
    required: SOURCE_COST_REQUIRED, parse: parseSourceCostCsv, validate: (p) => validateSourceCostCsv(p),
  },
  sales_efficiency: {
    required: SALES_EFF_REQUIRED, parse: parseSalesEfficiencyCsv, validate: (p) => validateSalesEfficiency(p, {}),
  },
  appt_stats_by_rep_source: {
    required: APPT_STATS_REQUIRED, parse: parseApptStatsCsv, validate: (p) => validateApptStatsCsv(p),
  },
};

/** Every committed CSV fixture, discovered — a new one is covered on drop. */
const CSV_FIXTURES = readdirSync(FIX).filter((f) => f.endsWith('.csv')).sort();

/** Physical lines, ignoring the trailing newline at EOF. */
const physicalLines = (text) => {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
};

// ── §C  header fingerprint routing ──────────────────────────────────────────

test('§C every one of the five reports resolves from its header alone', () => {
  const cases = [
    ['report-133-job-status-mar.csv', 'job_status_ytd', '133'],
    ['report-134-jobs-by-milestone.csv', 'jobs_by_milestone', '134'],
    ['report-135-lead-disposition.csv', 'lead_disposition', '135'],
    ['report-136-source-cost.csv', 'source_cost', '136'],
    ['report-137-sales-efficiency-ytd.csv', 'sales_efficiency', '137'],
  ];
  for (const [file, reportType, lpReportId] of cases) {
    const header = parseCsv(read(file))[0];
    assert.deepEqual(detectReportFromHeader(header), { reportType, lpReportId }, file);
  }
});

test('§C fingerprints are mutually exclusive — no header matches two reports', () => {
  // If two discriminator sets ever overlap, detectReportFromHeader rejects
  // rather than guessing; this proves the table itself never gets there.
  for (const f of REPORT_FINGERPRINTS) {
    const matches = REPORT_FINGERPRINTS.filter((g) =>
      g.discriminators.every((d) => f.discriminators.some((x) => x.toLowerCase() === d.toLowerCase())));
    assert.deepEqual(matches.map((m) => m.reportType), [f.reportType],
      `${f.reportType}'s columns must identify only itself`);
  }
});

test('§C matching is case- and order-insensitive', () => {
  const shuffled = ['jbs1', 'ClosingPct', 'NUMISSUED', 'grouper', 'nsli', 'NumJSC1', 'noise'];
  assert.equal(detectReportFromHeader(shuffled).reportType, 'sales_efficiency');
});

test('§C an unrecognised header is REJECTED, never guessed at', () => {
  assert.throws(() => detectReportFromHeader(['a', 'b', 'c']), /unknown_report_fingerprint/);
  assert.throws(() => detectReportFromHeader([]), /unknown_report_fingerprint/);
});

test('§C every fingerprinted report has a deterministic content sort key', () => {
  for (const f of REPORT_FINGERPRINTS) {
    assert.ok(CONTENT_SORT_KEYS[f.reportType]?.length,
      `${f.reportType} needs a sort key or LP's xSortBy forks its identity`);
  }
});

// ── §C  RFC-4180: embedded newlines ─────────────────────────────────────────

test('§C 133 record count differs from line count — newlines live inside quotes', () => {
  const text = read('report-133-job-status-mar.csv');
  const records = parseCsv(text);
  assert.equal(records.length - 1, 525, 'the March export has 525 data rows');
  assert.ok(records.length < physicalLines(text),
    `records (${records.length}) must be fewer than lines (${physicalLines(text)})`);

  // Notes survive intact, newlines and all — a \n split would have turned each
  // of these into several broken records and truncated the file.
  const { rows } = csvToObjects(text);
  // 65 raw cells carry a newline; 62 still do after the parser trims, the other
  // three wrapping only at the very start or end of the note.
  const wrapped = rows.filter((r) => /\n/.test(r.MostRecentNoteHOA ?? ''));
  assert.equal(wrapped.length, 65, '65 notes wrap in the March export');
  assert.ok(wrapped[0].MostRecentNoteHOA.split('\n').length >= 2);
  // Every row still has all 28 columns — the proof no record was split.
  assert.ok(records.slice(1).every((r) => r.length === 28), 'a wrapped cell broke a record');
});

test('§C a UTF-8 BOM never contaminates the first header name', () => {
  const withBom = `﻿${read('report-136-source-cost.csv')}`;
  assert.equal(detectReportFromHeader(parseCsv(withBom)[0]).reportType, 'source_cost');
  assert.equal(parseCsv(withBom)[0][0].trim(), 'descr');
});

test('§C CRLF inside a quoted field normalizes to LF', () => {
  const crlf = 'a,b\r\n"x","line1\r\nline2"\r\n';
  const rows = parseCsv(crlf);
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 'line1\nline2');
});

// ── §F  money: LP's four-decimal cells ──────────────────────────────────────

test('§F LP four-decimal money parses instead of vanishing', () => {
  // The live bug: parseMoneyCents' /^\d+(\.\d{1,2})?$/ returned null for
  // '0.0000', and every CSV parser wrote `?? 0` — so real money became zero.
  assert.equal(parseMoneyCents('0.0000'), null, 'strict parser still rejects >2dp');
  assert.deepEqual(parseCsvMoneyCents('0.0000'), { cents: 0, subCent: false });
  assert.deepEqual(parseCsvMoneyCents('785767.0000'), { cents: 78576700, subCent: false });
});

test('§F integer, two-decimal and four-decimal forms coexist in one column', () => {
  assert.equal(parseCsvMoneyCents('2717232').cents, 271723200);
  assert.equal(parseCsvMoneyCents('23060059.15').cents, 2306005915);
  assert.equal(parseCsvMoneyCents('0.0000').cents, 0);
});

test('§F genuine cents survive — they are not rounded away', () => {
  const { rows } = parseMilestoneCsv(read('report-134-jobs-by-milestone.csv'));
  const withCents = rows.filter((r) => r.net_cents % 100 !== 0);
  assert.equal(withCents.length, 2, 'the fixture carries two rows with real cents');
  assert.equal(rows[1].net_cents, 2731047);
  assert.equal(rows[3].net_cents, 3347583);
});

test('§F sub-cent remainders are FLAGGED, not silently absorbed', () => {
  const nsli = parseCsvMoneyCents('2194.6359');
  assert.equal(nsli.subCent, true);
  assert.equal(nsli.cents, 219464);
  assert.equal(parseCsvMoneyCents('100.00').subCent, false);
});

test('§F rounding is half-even, and never float', () => {
  assert.equal(parseCsvMoneyCents('1.005').cents, 100, 'ties to the even cent');
  assert.equal(parseCsvMoneyCents('1.015').cents, 102, 'ties to the even cent');
  assert.equal(parseCsvMoneyCents('1.0151').cents, 102, 'past the tie rounds up');
  // 0.1 + 0.2 territory: exact string/integer arithmetic, no drift.
  assert.equal(parseCsvMoneyCents('8357993.00').cents, 835799300);
});

test('§F garbage is still null, never 0 — the doctrine holds', () => {
  assert.equal(parseCsvMoneyCents('N/A'), null);
  assert.equal(parseCsvMoneyCents(''), null);
  assert.equal(parseCsvMoneyCents('-'), null);
  assert.equal(parseMoneyCentsExact('abc', { allowSubCent: true }), null);
});

test('§F negatives keep their sign in both notations', () => {
  assert.equal(parseCsvMoneyCents('-1,234.5678').cents, -123457);
  assert.equal(parseCsvMoneyCents('(1,234.56)').cents, -123456);
});

// ── §F  UNATTRIBUTED / UNRESOLVED — never a silent drop ─────────────────────

test('§F a blank 136 descr persists as UNATTRIBUTED, carrying its leads', () => {
  const { rows } = parseSourceCostCsv(read('report-136-source-cost.csv'));
  assert.equal(rows.length, 6, 'the blank-descr row is data, not padding');
  const blank = rows.find((r) => r.sub_source === 'UNATTRIBUTED');
  assert.ok(blank, 'blank descr must be labelled, not nulled');
  assert.equal(blank.num_raw, 3, 'its raw leads are still counted');
});

test('§F duplicate 136 sub-source names are kept as distinct rows', () => {
  const { rows } = parseSourceCostCsv(read('report-136-source-cost.csv'));
  const referrals = rows.filter((r) => r.sub_source === 'Customer Referral');
  assert.equal(referrals.length, 2);
  assert.deepEqual(referrals.map((r) => r.num_raw), [96, 44]);
});

// ── §D  CurrentDateTime keeps its time ──────────────────────────────────────

test('§D CurrentDateTime round-trips with the time intact', () => {
  const got = parseCsvDateTimeET('8/6/2026 6:00:01 PM');
  assert.equal(got.iso, '2026-08-06T22:00:01.000Z');
  assert.equal(got.hadTime, true);
  assert.equal(got.isMidnight, false);
});

test('§D the 134 fixture no longer lands as date-only midnight', () => {
  const { header } = parseMilestoneCsv(read('report-134-jobs-by-milestone.csv'));
  assert.equal(header.generatedAt, '2026-08-06T10:00:01.000Z', '6:00:01 AM ET');
  assert.equal(header.generatedAtTruncated, false);
  assert.notEqual(header.generatedAt.slice(11), '00:00:00.000Z');
});

test('§D midnight is only accepted when the source actually says 12:00:00 AM', () => {
  const genuine = parseCsvDateTimeET('8/6/2026 12:00:00 AM');
  assert.equal(genuine.isMidnight, true);
  assert.equal(genuine.hadTime, true, 'stated midnight is not truncation');

  const truncated = parseCsvDateTimeET('8/6/2026');
  assert.equal(truncated.isMidnight, true);
  assert.equal(truncated.hadTime, false, 'a missing time IS truncation and must be visible');
});

test('§D ET is load-bearing: 21:00 on the 31st is next-day UTC', () => {
  // This is the case a naive UTC date comparison gets wrong — it would read
  // 2026-09-01, call the August file month-complete, and finalize a snapshot
  // missing the last three hours of the month.
  const late = parseCsvDateTimeET('8/31/2026 9:00:00 PM');
  assert.equal(late.iso, '2026-09-01T01:00:00.000Z');
  assert.equal(late.iso.slice(0, 10), '2026-09-01', 'UTC date has already rolled over');
});

test('§D EST and EDT are both handled', () => {
  assert.equal(parseCsvDateTimeET('1/15/2026 6:00:01 PM').iso, '2026-01-15T23:00:01.000Z');
  assert.equal(parseCsvDateTimeET('7/15/2026 6:00:01 PM').iso, '2026-07-15T22:00:01.000Z');
});

test('§D noon and midnight do not collide in 12-hour parsing', () => {
  assert.equal(parseCsvDateTimeET('8/6/2026 12:00:00 PM').iso, '2026-08-06T16:00:00.000Z');
  assert.equal(parseCsvDateTimeET('8/6/2026 12:00:00 AM').iso, '2026-08-06T04:00:00.000Z');
});

// ── §D  period comes from the file ──────────────────────────────────────────

test('§D SDate/EDate are read from the data, not inferred', () => {
  const { header } = parseMilestoneCsv(read('report-134-jobs-by-milestone.csv'));
  assert.equal(header.periodStart, '2026-08-01');
  assert.equal(header.periodEnd, '2026-08-31');
});

// ── §E  content identity survives a re-pull ─────────────────────────────────

const WINDOW = {
  reportType: 'jobs_by_milestone',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  scope: 'month',
  includeAsOf: false,
  sortKeys: ['contractid'],
};

test('§E two pulls differing ONLY in CurrentDateTime are ONE identity', () => {
  // The whole reason content identity exists for CSV: LP stamps every row with
  // the run time, so the bytes differ on every pull and file_sha256 sees two
  // unrelated files where there is one report.
  const morning = read('report-134-jobs-by-milestone.csv');
  const evening = morning.replaceAll('8/6/2026 6:00:01 AM', '8/6/2026 6:00:01 PM');
  assert.notEqual(morning, evening, 'the bytes really do differ');

  const rowsOf = (t) => csvToObjects(t).rows;
  assert.equal(
    contentSha256({ ...WINDOW, rows: rowsOf(morning) }),
    contentSha256({ ...WINDOW, rows: rowsOf(evening) }),
  );
});

test('§E the parameter-echo and operator columns are excluded too', () => {
  const base = read('report-136-source-cost.csv');
  const other = base
    .replaceAll('"Xxxx Xxxxxxx"', '"Someone Else"')     // FullName
    .replaceAll('"By Source"', '"By Cost"')             // xSortBy
    .replaceAll('"True"', '"False"');                   // UseColor
  const w = { reportType: 'source_cost', periodStart: '2026-08-01', periodEnd: '2026-08-31', includeAsOf: false, sortKeys: ['descr'] };
  assert.equal(
    contentSha256({ ...w, rows: csvToObjects(base).rows }),
    contentSha256({ ...w, rows: csvToObjects(other).rows }),
  );
});

test('§E ONE changed data cell is a different report', () => {
  const base = read('report-134-jobs-by-milestone.csv');
  const changed = base.replace('"18450.00"', '"18450.01"');
  assert.notEqual(base, changed);
  assert.notEqual(
    contentSha256({ ...WINDOW, rows: csvToObjects(base).rows }),
    contentSha256({ ...WINDOW, rows: csvToObjects(changed).rows }),
  );
});

test('§E row ORDER does not change identity — xSortBy must not fork it', () => {
  const rows = csvToObjects(read('report-134-jobs-by-milestone.csv')).rows;
  assert.equal(
    contentSha256({ ...WINDOW, rows }),
    contentSha256({ ...WINDOW, rows: [...rows].reverse() }),
  );
});

test('§E without a sort key, reordering DOES fork identity (why the key exists)', () => {
  const rows = csvToObjects(read('report-134-jobs-by-milestone.csv')).rows;
  const unsorted = { ...WINDOW, sortKeys: null };
  assert.notEqual(
    contentSha256({ ...unsorted, rows }),
    contentSha256({ ...unsorted, rows: [...rows].reverse() }),
  );
});

test('§E the period IS part of identity — same rows, different window', () => {
  const rows = csvToObjects(read('report-134-jobs-by-milestone.csv')).rows;
  assert.notEqual(
    contentSha256({ ...WINDOW, rows }),
    contentSha256({ ...WINDOW, periodStart: '2026-01-01', rows }),
  );
});

test('§E a parser_version bump lets corrected output re-land instead of bouncing', () => {
  const rows = csvToObjects(read('report-134-jobs-by-milestone.csv')).rows;
  assert.notEqual(
    contentSha256({ ...WINDOW, rows, parserVersion: 'milestone-csv-v1' }),
    contentSha256({ ...WINDOW, rows, parserVersion: 'milestone-csv-v2' }),
  );
});

test('§E the PDF path keeps as-of in the key — its digest is unchanged', () => {
  // includeAsOf defaults true, so the pre-CSV behaviour is byte-identical and
  // the 2026-08-06 PDF identity guards still hold.
  const rows = [{ job_number: '1', net_cents: 100 }];
  const w = { reportType: 'jobs_by_milestone', periodStart: '2026-08-01', periodEnd: '2026-08-31', scope: 'mtd', rows };
  assert.notEqual(
    contentSha256({ ...w, asOfDate: '2026-08-05' }),
    contentSha256({ ...w, asOfDate: '2026-08-06' }),
  );
});

// ── §A/§B  a duplicate is a 200, and 500 means infrastructure ───────────────

test('§A 23505 is recognised however it arrives', () => {
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(isUniqueViolation({ message: 'duplicate key value violates unique constraint "x_uq"' }), true);
  assert.equal(isUniqueViolation({ code: '23514' }), false, 'a CHECK violation is not a duplicate');
  assert.equal(isUniqueViolation({ message: 'connection refused' }), false);
  assert.equal(isUniqueViolation(null), false);
});

test('§A/§B every ingest RPC raise site is duplicate-guarded before it throws', () => {
  // Source-text guard, same technique as test-lp-report-idempotency.js: these
  // are the five sites where a 23505 used to become a 500, and n8n replays
  // only on 5xx — which is what turned one file into a retry storm.
  const csvSrc = readFileSync('src/jobs/lp-csv-ingest.js', 'utf8');
  const pdfSrc = readFileSync('src/jobs/lp-report-ingest.js', 'utf8');

  const beginThrows = csvSrc.match(/ingest begin failed/g) ?? [];
  const beginGuards = csvSrc.match(/duplicateResponse\(beginErr/g) ?? [];
  assert.equal(beginThrows.length, 4, 'four lp_csv_ingest_begin call sites');
  assert.equal(beginGuards.length, 4, 'each one guarded');

  assert.match(pdfSrc, /duplicateResponse\(rpcErr[\s\S]{0,400}?ingest RPC failed/,
    'scorecard_ingest_snapshot must try the duplicate path before throwing');
});

test('§A the duplicate response says success:true — n8n must not page on it', () => {
  const src = readFileSync('src/jobs/lp-report-ingest.js', 'utf8');
  const fn = src.slice(src.indexOf('export async function duplicateResponse'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(fn, /success:\s*true/, 'a duplicate is benign');
  assert.match(fn, /duplicate:\s*true/, 'and is identified as one');
  assert.match(fn, /matched_on/, 'and says which key matched');

  // This path used to forbid `success: false` outright. It no longer can: an
  // UNFINALIZED match is not a duplicate, it is the corpse of an ingest whose
  // begin succeeded and whose finalize failed, and reporting it as benign is
  // what let a remediation re-send read as landed while nothing changed.
  // The rule is narrower now — the ONLY failure admitted here is that orphan,
  // and it must still be a 200-shaped rejection so n8n does not replay.
  const failures = body.match(/success:\s*false[^}]*\}/g) ?? [];
  assert.equal(failures.length, 1, 'exactly one failure shape on this path: the orphan');
  assert.match(failures[0], /rejected:\s*true/, 'the orphan is a rejection, not a 500');
  assert.match(failures[0], /orphaned_snapshot/, 'and names itself');
});

test('§A an UNFINALIZED match is an orphan, never a benign duplicate', () => {
  const src = readFileSync('src/jobs/lp-report-ingest.js', 'utf8');
  const finder = src.slice(src.indexOf('export async function findExistingSnapshot'));
  assert.match(finder.slice(0, finder.indexOf('\n}')), /finalized_at/,
    'the probe must return finalized_at — the orphan test depends on it');

  const dup = src.slice(src.indexOf('export async function duplicateResponse'));
  const guard = dup.indexOf('!hit.finalizedAt');
  assert.ok(guard > 0, 'duplicateResponse branches on the unfinalized case');
  assert.ok(guard < dup.indexOf("await done('duplicate'"),
    'and does so BEFORE it can log a duplicate');
});

test('§A the pre-begin probe matches the DB constraint, filter for filter', () => {
  const src = readFileSync('src/jobs/lp-csv-ingest.js', 'utf8');
  // The constraint on (report_type, file_sha256) has no finalized_at predicate.
  // A probe that carries one disagrees with it, and that disagreement is exactly
  // how an orphan slipped past the probe into a 23505 reported as benign.
  assert.ok(!/not\('finalized_at', 'is', null\)/.test(src),
    'no probe may filter on finalized_at — the unique constraint does not');
  assert.equal((src.match(/probeExistingSnapshot\(reportType, sha, done\)/g) ?? []).length, 5,
    'one shared helper, called from all four chunked ingest paths');

  // The table has TWO unique keys and the second one is the one that fired:
  // scorecard_report_snapshots_content_uq on (report_type, content_sha256).
  // It cannot be probed alongside file_sha256 — the content hash is taken over
  // the parsed rows — so it gets its own probe, immediately before begin.
  assert.equal((src.match(/probeExistingContentSnapshot\(/g) ?? []).length, 2,
    'one content probe, defined once and called once from ingestCsv');
  const contentFn = src.slice(src.indexOf('async function probeExistingContentSnapshot'));
  const contentBody = contentFn.slice(0, contentFn.indexOf('\n}'));
  assert.match(contentBody, /finalized_at/,
    'the content probe reads finalized_at too — an orphan on either key is an orphan');
  assert.ok(!/not\('finalized_at'/.test(contentBody),
    'and no more filters on it than the file probe does');
});

test('§B content-level failures return 200 with rejected:true and a reason', () => {
  const src = readFileSync('src/jobs/lp-csv-ingest.js', 'utf8');
  const failures = src.match(/return \{ success: false[^}]*\}/g) ?? [];
  assert.ok(failures.length > 10, 'sanity: found the failure returns');
  for (const f of failures) {
    assert.match(f, /rejected: true/, `every content failure is a rejection, not a 500: ${f.slice(0, 80)}`);
    assert.match(f, /reason:/, `every content failure names a machine-readable reason: ${f.slice(0, 80)}`);
  }
});

test('§B a row-load failure no longer re-throws into a 500', () => {
  const src = readFileSync('src/jobs/lp-csv-ingest.js', 'utf8');
  assert.ok(!/failure_reason: 'row_load_failed'[\s\S]{0,200}?\n\s*throw err;/.test(src),
    'row_load_failed writes its log row and returns 200 — re-throwing made n8n replay it');
});

// ── 134 CSV parser ──────────────────────────────────────────────────────────

test('134 CSV parses the fixture and ties its own totals', () => {
  const parsed = parseMilestoneCsv(read('report-134-jobs-by-milestone.csv'));
  assert.equal(parsed.rows.length, 5);
  assert.equal(parsed.rows[0].job_number, 'J-100201');
  assert.equal(parsed.rows[0].branch_code_raw, 'BOCA');
  assert.equal(parsed.rows[0].rtp_date, '2026-08-03');

  const totals = computeMilestoneTotals(parsed.rows);
  assert.equal(totals.row_count, 5);
  assert.equal(totals.gross_cents, 2175000 + 3120047 + 1725000 + 3890083 + 1240000);
  assert.equal(totals.net_cents, 1845000 + 2731047 + 1500000 + 3347583 + 0);
});

test('134 CSV validates clean and reports what it did not map', () => {
  const parsed = parseMilestoneCsv(read('report-134-jobs-by-milestone.csv'));
  const v = validateMilestoneCsv(parsed);
  assert.equal(v.ok, true, JSON.stringify(v.violations));
  // Unmapped columns are surfaced as a reconciliation, never dropped in silence.
  assert.ok(Array.isArray(parsed.unmappedColumns));
});

test('134 CSV fails CLOSED on a missing contract id or unparseable gross', () => {
  const base = read('report-134-jobs-by-milestone.csv');
  const noId = base.replace('"J-100203"', '""');
  assert.equal(validateMilestoneCsv(parseMilestoneCsv(noId)).ok, false);
  assert.match(
    validateMilestoneCsv(parseMilestoneCsv(noId)).violations[0].rule,
    /missing_contract_id/,
  );

  const badMoney = base.replace('"17250"', '"N/A"');
  const v = validateMilestoneCsv(parseMilestoneCsv(badMoney));
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.rule === 'unparseable_money'));
});

test('134 CSV rejects a file whose header is not 134 at all', () => {
  assert.throws(() => parseMilestoneCsv(read('report-136-source-cost.csv')),
    /CSV missing required columns/);
});

// ── every fixture is really ingestible, and every parser reports coverage ───
//
// Two regressions this catches, both of which were live in the first cut of
// this work:
//
//   1. A fixture that FINGERPRINTS but does not PARSE. The 133 and 135 fixtures
//      originally carried only the discriminator columns, so routing tests
//      passed while the file would have been rejected `csv_shape_unrecognized`
//      on a real ingest.
//   2. A parser that drops CurrentDateTime's time. Three of the five still used
//      the date-only parseCsvDate, so their snapshots got report_generated_at
//      NULL, is_partial_month NULL, and could therefore NEVER close a period —
//      the closing pull would land and change nothing.

// ── THE STRUCTURAL TEST — fingerprint and parser must not drift apart ───────
//
// This is the guard that would have caught report 133 before production. Its
// fingerprint had already been re-keyed to the NEW export (`id`, `District`,
// `Market`, `custname`, `Status`, `MostRecentNoteHOA`) while its REQUIRED still
// demanded `cst_id` / `NETDATE` / `statusdate` / `FinAmount` / `descr` /
// `RepName` / `FinCo` from the OLD one. So the router accepted every file and
// the parser then refused it — `csv_shape_unrecognized` on every single send,
// with the two halves of the contract each individually looking correct.
//
// Nothing short of running BOTH halves against the same bytes finds that. Each
// fixture is therefore taken through the whole chain:
//
//   1. detectReportFromHeader resolves it to exactly one report,
//   2. that report's REQUIRED is a SUBSET of the fixture's real header,
//      compared case-insensitively (the router matches that way, so a parser
//      that is stricter is a parser that rejects files the router accepted),
//   3. the parser runs to completion and validate() returns ok.
//
// Fixtures are DISCOVERED from disk, not listed, so a new export dropped into
// the directory is covered without touching this file.

test('structural: every fixture fingerprints, satisfies its parser\'s REQUIRED, parses and validates', () => {
  assert.ok(CSV_FIXTURES.length >= 6, 'fixture directory looks empty — check FIX path');
  const seen = new Set();

  for (const file of CSV_FIXTURES) {
    const text = read(file);
    const header = parseCsv(text)[0];

    // 1. routing
    const { reportType } = detectReportFromHeader(header);
    const entry = REGISTRY[reportType];
    assert.ok(entry, `${file} routed to ${reportType}, which has no REGISTRY entry`);
    seen.add(reportType);

    // 2. REQUIRED ⊆ header, case-insensitively — the missing set is printed,
    //    because "which column" is the entire diagnostic value of this failure.
    const present = new Set(header.map((h) => String(h).trim().toLowerCase()));
    const missing = entry.required.filter((c) => !present.has(String(c).toLowerCase()));
    assert.deepEqual(missing, [],
      `${file} → ${reportType}: parser REQUIRED demands ${JSON.stringify(missing)}, `
      + 'which the shipped export does not have. Fingerprint and parser have drifted.');

    // 3. parse + validate
    const parsed = entry.parse(text);
    assert.ok(parsed.rows.length > 0, `${file} → ${reportType} produced no rows`);
    const v = entry.validate(parsed);
    assert.equal(v.ok, true,
      `${file} → ${reportType} failed validation: ${JSON.stringify(v.violations)}`);
  }

  // All six reports are represented; a report losing its last fixture is itself
  // a regression, not a quietly smaller test.
  assert.deepEqual([...seen].sort(), Object.keys(REGISTRY).sort());
});

// ── §C  only 133 wraps ──────────────────────────────────────────────────────
//
// 133 prints free-text HOA notes with literal newlines inside the quoted cell,
// so its record count and physical line count legitimately differ (525 records
// across 728 lines in March). Every other report is one line per record.
//
// Both directions are asserted. A future export that STARTS wrapping is caught
// as loudly as a 133 parse that stops handling it — the failure mode there is
// silent truncation, which looks like a smaller month rather than a bug.

test('§C 133 is the only report with newlines inside quoted fields', () => {
  for (const file of CSV_FIXTURES) {
    const text = read(file);
    const { reportType } = detectReportFromHeader(parseCsv(text)[0]);
    const records = REGISTRY[reportType].parse(text).rows.length;
    const lines = physicalLines(text);

    if (reportType === 'job_status_ytd') {
      assert.notEqual(lines, records + 1,
        `${file}: 133 must carry embedded newlines — ${records} records over ${lines} lines`);
      assert.ok(lines > records + 1, `${file}: more records than lines is impossible`);
    } else {
      assert.equal(lines, records + 1,
        `${file} (${reportType}): ${records} records over ${lines} lines — this export has `
        + 'started wrapping cells and the parser must be checked for silent truncation');
    }
  }
});

test('§D every CSV parser surfaces CurrentDateTime WITH its time', () => {
  for (const file of CSV_FIXTURES) {
    const text = read(file);
    const { reportType } = detectReportFromHeader(parseCsv(text)[0]);
    const { header } = REGISTRY[reportType].parse(text);

    assert.ok(header.generatedAt, `${file}: ${reportType} must report generatedAt — NULL can never close a period`);
    assert.equal(header.generatedAtTruncated, false, `${file}: ${reportType} lost the time component`);
    assert.notEqual(header.generatedAt.slice(11), '00:00:00.000Z',
      `${file}: ${reportType} landed as midnight — that is the truncation bug`);
  }
});
