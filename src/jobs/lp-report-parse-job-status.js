// ─── Job Status Report YTD (CSV) parser — src/jobs/lp-report-parse-job-status.js ───
//
// PURE. Parses the LP "Job Status Report" CSV export (one row per OPEN job,
// full-YTD stock snapshot — not a period cohort) into typed rows, and
// validates fail-closed. Market resolution happens in the orchestrator
// (lp-csv-ingest.js): this report carries NO branch column, so market comes
// from the cst_id → Lead Disposition id join.
//
// BUCKETS (three-bucket build, 2026-08-05 — flagged for Mark's ruling):
//   hoa            HOLD - HOA
//   permit         Hold - Permit   ← exists in this export (18 jobs,
//                  $343,564 on 2026-08-05), contra the 2026-08-04 Report B
//                  ruling which was scoped to that month's PDF cohort.
//                  Collapsing permit → other_pending later is a one-line
//                  change here; the reverse is a schema migration.
//   other_pending  pre-release holds (quotes, paperwork, credit, mgmt)
//   excluded       released/production track (RTP'd, product, install,
//                  collection) — consistent with Report B's exclusions.
//
// An unmapped status (LP adding a 24th) makes the pipeline STOP, not guess:
// classify returns null → validate fails → the whole file is rejected and
// the rows quarantined. Same doctrine as lp-report-parse-b.js.
//
// MONEY IS CENTS (parseMoneyCents). FinAmount is the FINANCED amount — it
// prints one decimal ('6288.9') and is NEVER net (standing rule; only ~281
// of 940 rows carry it).

import { parseMoneyCents } from './lp-report-common.js';
import { csvToObjects, parseCsvDate, parseCsvDateTimeET } from './lp-report-csv-common.js';

/** Verbatim LP status → bucket. All 23 statuses in the 2026-08-05 export. */
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
  'Mgmt Hold': 'other_pending',
  // released / production track — excluded from pending Good Business
  'Rel To Production': 'excluded',
  'RTP Await recission': 'excluded',
  'RTP DP DUE': 'excluded',
  'Awaiting Product': 'excluded',
  'Out to Measure': 'excluded',
  'Product Received': 'excluded',
  'Scheduled': 'excluded',
  'Started': 'excluded',
  'Installed & Unpaid': 'excluded',
  'Sent To Attorney': 'excluded',
};

/** Trimmed status → bucket, null for anything unmapped (fail closed upstream). */
export function classifyJobStatus(statusRaw) {
  return JOB_STATUS_BUCKET_MAP[String(statusRaw ?? '').trim()] ?? null;
}

const REQUIRED = ['cst_id', 'contractid', 'contractdate', 'grossamount', 'NETDATE',
  'statusdate', 'FinAmount', 'descr', 'RepName', 'FinCo', 'SDate', 'EDate'];

/**
 * Parse the Job Status Report CSV.
 * @returns {{ rows: object[], header: {periodStart:string|null, periodEnd:string|null, asOf:string|null} }}
 */
export function parseJobStatusCsv(text) {
  const { rows: raw } = csvToObjects(text, REQUIRED);
  let periodStart = null, periodEnd = null, asOf = null, generatedAt = null;
  const rows = raw.map((r) => {
    periodStart ??= parseCsvDate(r.SDate);
    periodEnd ??= parseCsvDate(r.EDate);
    // Full timestamp, not just the date: this is the coverage-as-of value
    // behind is_partial_month, and truncating it loses the only signal of how
    // much of the period the file actually contains.
    if (!generatedAt) {
      const gen = parseCsvDateTimeET(r.CurrentDateTime);
      if (gen) { generatedAt = gen; asOf ??= parseCsvDate(r.CurrentDateTime); }
    }
    const status_raw = String(r.descr ?? '').trim();
    return {
      cst_id: String(r.cst_id ?? '').trim(),
      contract_id: String(r.contractid ?? '').trim() || null,
      customer_name: String(r.CustName ?? '').trim() || null,
      phone: String(r.Phone ?? '').trim() || null,
      contract_date: parseCsvDate(r.contractdate),
      net_date: parseCsvDate(r.NETDATE),
      status_date: parseCsvDate(r.statusdate),
      status_raw,
      bucket: classifyJobStatus(status_raw),
      gross_cents: parseMoneyCents(r.grossamount),
      fin_cents: parseMoneyCents(r.FinAmount),
      rep_name: String(r.RepName ?? '').trim() || null,
      fin_co: String(r.FinCo ?? '').trim() || null,
      notes_raw: String(r.UNotes ?? '').trim() || null,
    };
  });
  return {
    rows,
    header: {
      periodStart, periodEnd, asOf,
      generatedAt: generatedAt?.iso ?? null,
      generatedAtTruncated: Boolean(generatedAt && generatedAt.isMidnight && !generatedAt.hadTime),
    },
   };
}

/**
 * Fail-closed validation. Violations: [{rule, detail}].
 *   unmapped_status     any row whose status isn't in the 23-entry map
 *   missing_cst_id      a row without its join key
 *   money_parse_failed  a non-empty grossamount that didn't parse
 *   empty_file          zero data rows
 * Also asserts the bucket partition foots: every row lands in exactly one
 * bucket, so Σ bucket counts == row count by construction — checked anyway
 * so a future edit can't silently break the invariant.
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
  const noKey = rows.filter((r) => !r.cst_id);
  if (noKey.length) {
    violations.push({ rule: 'missing_cst_id', detail: { count: noKey.length } });
  }
  // grossamount may legitimately be '0' (parses to 0) but never unparseable.
  const unparseable = rows.filter((r) => r.gross_cents == null);
  if (unparseable.length) {
    violations.push({ rule: 'money_parse_failed', detail: { count: unparseable.length, sample_cst_ids: unparseable.slice(0, 5).map((r) => r.cst_id) } });
  }

  const bucketCounts = {};
  for (const r of rows) bucketCounts[r.bucket ?? 'UNMAPPED'] = (bucketCounts[r.bucket ?? 'UNMAPPED'] || 0) + 1;
  const foot = Object.values(bucketCounts).reduce((a, b) => a + b, 0);
  if (foot !== rows.length) {
    violations.push({ rule: 'bucket_foot_mismatch', detail: { foot, rows: rows.length, bucketCounts } });
  }

  return { ok: violations.length === 0, violations, bucketCounts };
}
