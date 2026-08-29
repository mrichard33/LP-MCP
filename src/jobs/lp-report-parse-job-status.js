// ─── Job Status Report (CSV) parser — src/jobs/lp-report-parse-job-status.js ───
//
// PURE. Parses the LP "Jobs by Status" CSV export (report 133) into typed rows
// and validates fail-closed.
//
// ══ THIS IS A COHORT, NOT AN OPEN-JOB SNAPSHOT ══
// The export this parser was FIRST built against was a full-YTD stock snapshot
// of OPEN jobs. The export LP actually ships is a different report: scoped by
// CONTRACT DATE and carrying every status, most of them terminal. All 525 rows
// of the March 2026 file have a March ContractDate; 331 are Paid In Full and
// 167 are cancelled/declined/dead. Only 2 are open holds.
//
// So a consumer that sums this file as "open Good Business" is adding paid,
// cancelled and declined dollars into pending backlog. The bucket vocabulary
// below exists to make that impossible to do by accident: `completed` and
// `lost` are separately addressable and are NOT reachable by "everything that
// isn't excluded". The snapshot records cohort_basis='contract_date' so the
// semantic lives in the data rather than in a filename.
//
// report_type stays `job_status_ytd` and the history table keeps its name to
// avoid schema churn. Both names are now MISNOMERS — there is nothing YTD about
// this file. Read them as "report 133", nothing more.
//
// MARKET COMES FROM THE FILE. This export carries District and Market natively,
// so the old cst_id → Lead Disposition (135) join is gone: 133 no longer depends
// on a current 135 snapshot to know its own branch. Resolution through
// lp_branch_market_map happens in the orchestrator (lp-csv-ingest.js), which is
// where the DB lives; this module stays pure and carries both codes raw.
//
// COLUMNS THE OLD EXPORT HAD AND THIS ONE DOES NOT: cst_id, NETDATE, statusdate,
// FinAmount, descr, RepName, FinCo. Status arrives as `Status`, not `descr`.
// The corresponding row fields (fin_cents, net_date, status_date, rep_name,
// fin_co) are no longer populated — verified 2026-08-07 to have zero readers in
// LP-MCP and in Reece-Dashboard before they were dropped.
//
// MONEY IS CENTS via parseCsvMoneyCents, NOT parseMoneyCents: TotalDue prints
// LP's four-decimal form on 478 of 525 rows ('0.0000') and the strict
// two-decimal parser returns null for it, which would fail the whole file closed
// on money that is perfectly well-formed. Negative TotalDue is real (18 rows).
//
// DATES: ContractDate prints a TWO-DIGIT year ('03/01/26') and must go through
// parseDateMDY. parseCsvDate requires four digits and would silently null the
// one column that now defines the cohort. SDate/EDate/CurrentDateTime are
// four-digit and keep parseCsvDate / parseCsvDateTimeET.

import { parseCsvMoneyCents, parseDateMDY } from './lp-report-common.js';
import {
  csvToObjects, parseCsvDate, parseCsvDateTimeET,
  columnReader, assertRequiredColumns,
} from './lp-report-csv-common.js';

/** Bumped when a parse change should let corrected output re-land and supersede. */
export const JOB_STATUS_PARSER_VERSION = 'job-status-csv-v3';

/**
 * Verbatim LP status → bucket. All 14 statuses observed in the March 2026
 * export, plus the pre-release holds carried forward from the earlier one.
 *
 * ADDED 2026-08-21: 'Await Customer'. LP introduced it without notice and it
 * fail-closed the 133 ingest for four consecutive days (8/18–8/21) — 1 row on
 * the first day, 2 on each of the rest. It is a pre-release hold (the job is
 * parked waiting on the homeowner: job 59522 carried the note "Per REP- Hold
 * off for two weeks as the HO is making changes on contract"), so it buckets
 * to other_pending alongside 'Await Rep' and 'Mgmt Hold' and therefore COUNTS
 * INTO open Good Business. That is the deliberate ruling, not a default.
 *
 * The vocabulary is six buckets, not four. `excluded` used to mean "released to
 * the production track" AND double as the dumping ground for anything that was
 * not an open hold; under a cohort export that conflation would swallow every
 * terminal outcome. It is renamed `in_production` (same membership, honest name)
 * and the two terminal families get their own buckets:
 *
 *   hoa            blocked on an HOA decision
 *   permit         blocked on a permit
 *   other_pending  pre-release holds (quotes, paperwork, credit, mgmt)
 *   in_production  released / production track
 *   completed      money collected
 *   lost           cancelled, declined, dead
 *
 * `lost` and `completed` MUST stay separately addressable — cancellation and
 * credit-decline volume by market is the reporting value of this export
 * (167 of 525 rows in March). Do not collapse either into another bucket.
 *
 * Matching is exact after trim, deliberately: LP adding a 15th status must STOP
 * the pipeline, not be case-folded into a near-miss.
 */
export const JOB_STATUS_BUCKET_MAP = {
  'HOLD - HOA': 'hoa',
  'Hold - Permit': 'permit',
  // pre-release holds — counted into open Good Business
  'New': 'other_pending',
  'Quoted': 'other_pending',
  'Await Rep': 'other_pending',
  'Awaiting Paperwork': 'other_pending',
  'Awaiting Commission Sheet': 'other_pending',
  'Awaiting Change Order': 'other_pending',
  'Awaiting Credit Application': 'other_pending',
  'Awaiting Loan Docs': 'other_pending',
  'Awaiting Lender': 'other_pending',
  'Awaiting Par Sheet': 'other_pending',
  'Await Customer': 'other_pending',
  'Mgmt Hold': 'other_pending',
  // released / production track — NOT pending Good Business, NOT terminal
  'Rel To Production': 'in_production',
  'RTP Await recission': 'in_production',
  'RTP DP DUE': 'in_production',
  'Awaiting Product': 'in_production',
  'Out to Measure': 'in_production',
  'Product Received': 'in_production',
  'Scheduled': 'in_production',
  'Started': 'in_production',
  'Installed & Unpaid': 'in_production',
  'Sent To Attorney': 'in_production',
  // terminal — money collected
  'Paid In Full': 'completed',
  'PIF Survey Ready': 'completed',
  // terminal — no revenue
  'Cancelled': 'lost',
  'Cancelled By Mgt': 'lost',
  'Credit Decline': 'lost',
  'Dead Deal': 'lost',
};

/** Every bucket the map can produce — the CHECK constraint's source of truth. */
export const JOB_STATUS_BUCKETS = ['hoa', 'permit', 'other_pending', 'in_production', 'completed', 'lost'];

/** Buckets that are genuinely OPEN pipeline. Everything else is released or terminal. */
export const GOOD_BUSINESS_BUCKETS = ['hoa', 'permit', 'other_pending'];

/** Trimmed status → bucket, null for anything unmapped (fail closed upstream). */
export function classifyJobStatus(statusRaw) {
  return JOB_STATUS_BUCKET_MAP[String(statusRaw ?? '').trim()] ?? null;
}

/** Defaults for the unmapped-status quarantine guard; env can override both. */
export const UNMAPPED_STATUS_MAX_ROWS = 10;
export const UNMAPPED_STATUS_MAX_PCT = 2;

/**
 * Decide what an `unmapped_status` violation costs: quarantine the rows and
 * keep the file, or reject the file outright.
 *
 * Pure and separate from the ingest so the ruling is testable without a
 * database, and so the threshold lives next to the map it protects rather than
 * buried in the orchestrator.
 *
 * THE RULING. LP adds statuses without notice; 'Await Customer' appeared on
 * 2026-08-18 and fail-closed report 133 for four days over one or two rows a
 * day. Rejecting 328 rows to avoid mis-filing 2 is the wrong trade, and the
 * quarantined rows are not lost — scorecard_ingest_quarantine keeps the whole
 * parsed object, so re-sending after the map is widened recovers them.
 *
 * THE GUARD, and why it is not optional. Buckets are money: an unmapped row is
 * dropped from a snapshot that feeds Open Backlog, so quarantining always
 * understates revenue by exactly the gross withheld. That is affordable at two
 * rows and indefensible at two hundred. A bulk LP status rename must still
 * stop the pipeline instead of landing a snapshot that looks fine and is not.
 *
 * Returns 'none' when the violation is absent, 'quarantine' when within both
 * limits, 'reject' when past either. The caller owns the side effects.
 */
export function judgeUnmappedStatus(parsed, violations, opts = {}) {
  // `?? undefined` is deliberate: an unset env var arrives as undefined and
  // must fall back, but a deliberate 0 must be honoured as "never quarantine".
  const num = (v, dflt) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? dflt : Number(v));
  const maxRows = num(opts.maxRows, UNMAPPED_STATUS_MAX_ROWS);
  const maxPct = num(opts.maxPct, UNMAPPED_STATUS_MAX_PCT);
  const list = violations ?? [];

  // Narrow on purpose: only when `unmapped_status` is the ONLY thing wrong.
  // A file that also fails money parsing or is missing job ids is a broken
  // file, and softening one of its several violations helps nobody.
  const only = list.length > 0 && list.every((x) => x.rule === 'unmapped_status');
  if (!only) return { action: 'none' };

  const rows = parsed?.rows ?? [];
  const bad = rows.filter((r) => r.bucket == null);
  if (!bad.length) return { action: 'none' };

  const statuses = [...new Set(bad.map((r) => r.status_raw))];
  const grossCents = bad.reduce((a, r) => a + (r.gross_cents ?? 0), 0);
  // An empty file cannot be a small fraction of itself — treat it as 100% so a
  // degenerate parse can never slip through the percentage half of the guard.
  const pct = rows.length ? Number(((bad.length / rows.length) * 100).toFixed(2)) : 100;
  const within = bad.length <= maxRows && pct <= maxPct;

  return {
    action: within ? 'quarantine' : 'reject',
    bad, statuses, grossCents, pct, maxRows, maxPct,
  };
}

/**
 * Only what the parser actually consumes and cannot proceed without.
 *
 * Kept deliberately minimal so extra columns in a future export cannot fail the
 * file closed — the previous list demanded seven columns this export does not
 * have, which is the entire defect this rewrite fixes. Exported so the
 * structural test in test-lp-csv-cutover.js can assert REQUIRED ⊆ fixture
 * header and catch the next fingerprint-vs-parser split before production does.
 */
export const REQUIRED = ['id', 'Market', 'ContractDate', 'grossamount', 'Status', 'SDate', 'EDate'];

/** Money cell → cents, or null when absent/unparseable. Tracks sub-cent loss. */
function money(raw, sink, column) {
  if (!String(raw ?? '').trim()) return null;
  const parsed = parseCsvMoneyCents(raw);
  if (parsed === null) return null;
  if (parsed.subCent) sink.push(column);
  return parsed.cents;
}

/** Non-empty trimmed values from a run of columns, in order, deduped. */
function listOf(get, row, names) {
  const out = [];
  for (const n of names) {
    const v = String(get(row, n) ?? '').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Parse the Jobs by Status CSV.
 * @returns {{ rows: object[], header: {periodStart, periodEnd, asOf, generatedAt,
 *            generatedAtTruncated}, subCentColumns: string[] }}
 */
export function parseJobStatusCsv(text) {
  // Required columns are checked case-insensitively HERE rather than by
  // csvToObjects, whose check is case-sensitive. detectReportFromHeader routes
  // case-insensitively, so a parser that is stricter than its own router would
  // reject a file the router already accepted — exactly how 133 came to fail.
  const { header, rows: raw } = csvToObjects(text);
  assertRequiredColumns(header, REQUIRED);
  const get = columnReader(header);

  let periodStart = null, periodEnd = null, asOf = null, generatedAt = null;
  const subCentColumns = [];

  const rows = raw.map((r, i) => {
    periodStart ??= parseCsvDate(get(r, 'SDate'));
    periodEnd ??= parseCsvDate(get(r, 'EDate'));
    // Full timestamp, not just the date: this is the coverage-as-of value behind
    // is_partial_month, and truncating it loses the only signal of how much of
    // the period the file actually contains.
    if (!generatedAt) {
      const gen = parseCsvDateTimeET(get(r, 'CurrentDateTime'));
      if (gen) { generatedAt = gen; asOf ??= parseCsvDate(get(r, 'CurrentDateTime')); }
    }
    const status_raw = String(get(r, 'Status') ?? '').trim();
    return {
      row_num: i + 1,
      // The LP customer id. It is NOT unique per row — the March export has 525
      // rows and 524 distinct ids (414605 covers two separate jobs) — so it is a
      // join key to 135, never a row identity or upsert target. job_id is the
      // per-row key (525/525 distinct); contractid carries the literal 'NEW' on
      // 8 rows and is not a key at all.
      lp_id: String(get(r, 'id') ?? '').trim(),
      job_id: String(get(r, 'job_id') ?? '').trim() || null,
      contract_id: String(get(r, 'contractid') ?? '').trim() || null,
      customer_name: String(get(r, 'custname') ?? '').trim() || null,
      phone: String(get(r, 'Phone') ?? '').trim() || null,
      city: String(get(r, 'city') ?? '').trim() || null,
      // Both branch codes verbatim. Market is populated on every row; District
      // is blank on 3 of 525 and disagrees with Market on 4, so Market leads and
      // District is the fallback. Mapping to a *_MKT happens in the orchestrator.
      market_code_raw: String(get(r, 'Market') ?? '').trim() || null,
      district_raw: String(get(r, 'District') ?? '').trim() || null,
      contract_date: parseDateMDY(get(r, 'ContractDate')),
      status_raw,
      bucket: classifyJobStatus(status_raw),
      gross_cents: money(get(r, 'grossamount'), subCentColumns, 'grossamount'),
      total_due_cents: money(get(r, 'TotalDue'), subCentColumns, 'TotalDue'),
      sub_source: String(get(r, 'Subsourcedescr') ?? '').trim() || null,
      product_ids: listOf(get, r, ['ProductID', 'ProductID2', 'ProductID3', 'ProductID4']),
      finance_sources: listOf(get, r, ['FinanceSource1', 'FinanceSource2', 'FinanceSource3']),
      notes_raw: String(get(r, 'MostRecentNoteHOA') ?? '').trim() || null,
    };
  });

  return {
    rows,
    subCentColumns: [...new Set(subCentColumns)],
    header: {
      periodStart, periodEnd, asOf,
      generatedAt: generatedAt?.iso ?? null,
      generatedAtTruncated: Boolean(generatedAt && generatedAt.isMidnight && !generatedAt.hadTime),
    },
  };
}

/**
 * Fail-closed validation. Violations: [{rule, detail}].
 *   unmapped_status     any row whose status isn't in the bucket map
 *   missing_job_id      a row without its per-row identity key
 *   money_parse_failed  a non-empty grossamount that didn't parse
 *   missing_contract_date  a row whose ContractDate didn't parse — this export
 *                       is a contract-date cohort, so a null there is not a
 *                       missing detail, it is a row with no cohort
 *   empty_file          zero data rows
 * Also asserts the bucket partition foots: every row lands in exactly one
 * bucket, so Σ bucket counts == row count by construction — checked anyway so a
 * future edit can't silently break the invariant.
 */
export function validateJobStatusCsv(parsed) {
  const violations = [];
  const { rows } = parsed;
  if (!rows.length) violations.push({ rule: 'empty_file', detail: 'no data rows' });

  const unmapped = rows.filter((r) => r.bucket == null);
  if (unmapped.length) {
    violations.push({
      rule: 'unmapped_status',
      detail: { count: unmapped.length, statuses: [...new Set(unmapped.map((r) => r.status_raw))] },
    });
  }
  const noKey = rows.filter((r) => !r.job_id);
  if (noKey.length) {
    violations.push({ rule: 'missing_job_id', detail: { count: noKey.length } });
  }
  // grossamount may legitimately be '0' (parses to 0) but never unparseable.
  const unparseable = rows.filter((r) => r.gross_cents == null);
  if (unparseable.length) {
    violations.push({ rule: 'money_parse_failed', detail: { count: unparseable.length, sample_job_ids: unparseable.slice(0, 5).map((r) => r.job_id) } });
  }
  const noDate = rows.filter((r) => !r.contract_date);
  if (noDate.length) {
    violations.push({ rule: 'missing_contract_date', detail: { count: noDate.length, sample_job_ids: noDate.slice(0, 5).map((r) => r.job_id) } });
  }

  const bucketCounts = {};
  for (const r of rows) bucketCounts[r.bucket ?? 'UNMAPPED'] = (bucketCounts[r.bucket ?? 'UNMAPPED'] || 0) + 1;
  const foot = Object.values(bucketCounts).reduce((a, b) => a + b, 0);
  if (foot !== rows.length) {
    violations.push({ rule: 'bucket_foot_mismatch', detail: { foot, rows: rows.length, bucketCounts } });
  }

  return { ok: violations.length === 0, violations, bucketCounts };
}
