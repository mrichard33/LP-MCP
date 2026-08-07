// ─── Marketing Sub-Source Cost Analysis 2 (CSV) parser — src/jobs/lp-report-parse-source-cost.js ───
//
// PURE. Parses the LP "Marketing Sub Source Cost Anlysis 2" CSV export —
// one row per marketing sub-source, company-wide funnel counts + dollars.
//
// THIS REPORT IS THE CONTROL-TOTAL AUTHORITY: its column sums tie the LP
// footer to the cent (verified 2026-08-05 — NumRaw 78,561 · NumSold 3,344 ·
// NumNetSold 2,389 · GSA $79,904,667.20 · NSA $56,893,787.43 · MCost
// $2,129,690.39 · Working $4,640,023.00). validateSourceCostCsv compares
// computed totals against caller-declared expected totals; a 1¢ mismatch
// fails the file closed.
//
// GRAIN WARNING: sub-source names repeat (Previous Customer / Customer
// Referral / Billboard each appear twice, plus 5 blank-descr rows in the
// 2026-08-05 export) and LP repeats the same-named row's NSA on the
// duplicates — totals still tie. Row identity is (snapshot, row_num);
// every row is kept verbatim, including blanks.

import { parseCsvMoneyCents } from './lp-report-common.js';
import { csvToObjects, parseCsvDate, parseCsvDateTimeET, parseCount } from './lp-report-csv-common.js';

/**
 * The label for a row LP prints with a blank `descr`.
 *
 * These are REAL DATA — an unattributed sub-source bucket, carrying 3 raw leads
 * in the 2026-08-06 export. Storing NULL made them indistinguishable from a
 * parse failure and invited a downstream reader to skip them; naming the bucket
 * keeps the leads counted and attributable to "we don't know".
 */
export const UNATTRIBUTED = 'UNATTRIBUTED';

/** Money cell → cents, tracking sub-cent loss for the §F gate. */
function money(raw, sink, column) {
  const parsed = parseCsvMoneyCents(raw);
  if (parsed === null) return 0;
  if (parsed.subCent) sink.push(column);
  return parsed.cents;
}

const REQUIRED = ['descr', 'NumRaw', 'NumSet', 'NumCnf', 'NumIssued', 'NumSat',
  'NumSold', 'NumNetSold', 'GSA', 'NSA', 'MCost', 'WorkingAmount', 'SDate', 'EDate'];

/**
 * Parse the Marketing Sub-Source Cost Analysis CSV.
 * @returns {{ rows: object[], header: {periodStart:string|null, periodEnd:string|null, asOf:string|null} }}
 */
export function parseSourceCostCsv(text) {
  const { rows: raw } = csvToObjects(text, REQUIRED);
  let periodStart = null, periodEnd = null, asOf = null, generatedAt = null;
  const subCentColumns = [];
  const rows = raw.map((r, i) => {
    periodStart ??= parseCsvDate(r.SDate);
    periodEnd ??= parseCsvDate(r.EDate);
    // Full timestamp, not just the date: it is the coverage-as-of value that
    // decides is_partial_month. asOf keeps the date form for scope derivation.
    if (!generatedAt) {
      const gen = parseCsvDateTimeET(r.CurrentDateTime);
      if (gen) { generatedAt = gen; asOf ??= parseCsvDate(r.CurrentDateTime); }
    }
    return {
      row_num: i + 1,
      sub_source: String(r.descr ?? '').trim() || UNATTRIBUTED,
      num_raw: parseCount(r.NumRaw) ?? 0,
      num_set: parseCount(r.NumSet) ?? 0,
      num_cnf: parseCount(r.NumCnf) ?? 0,
      num_issued: parseCount(r.NumIssued) ?? 0,
      num_sat: parseCount(r.NumSat) ?? 0,
      num_sold: parseCount(r.NumSold) ?? 0,
      num_net_sold: parseCount(r.NumNetSold) ?? 0,
      gsa_cents: money(r.GSA, subCentColumns, 'GSA'),
      nsa_cents: money(r.NSA, subCentColumns, 'NSA'),
      mcost_cents: money(r.MCost, subCentColumns, 'MCost'),
      working_cents: money(r.WorkingAmount, subCentColumns, 'WorkingAmount'),
    };
  });
  return {
    rows,
    header: {
      periodStart, periodEnd, asOf,
      generatedAt: generatedAt?.iso ?? null,
      generatedAtTruncated: Boolean(generatedAt && generatedAt.isMidnight && !generatedAt.hadTime),
    },
    subCentColumns: [...new Set(subCentColumns)],
  };
}

/** Column sums — the control totals the finalize RPC re-asserts. All cents/counts. */
export function computeSourceCostTotals(rows) {
  const t = {
    num_raw: 0, num_set: 0, num_cnf: 0, num_issued: 0, num_sat: 0,
    num_sold: 0, num_net_sold: 0,
    gsa_cents: 0, nsa_cents: 0, mcost_cents: 0, working_cents: 0,
  };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += r[k] ?? 0;
  return t;
}

/**
 * Fail-closed validation. When expectedTotals is provided (the backfill
 * passes the handoff-verified §0 figures), EVERY provided key must match
 * the computed sum exactly — a 1¢ mismatch is a violation. Without
 * expectedTotals (a future scheduled pull has no external authority), the
 * computed sums stand as the declared control totals and the DB-side
 * finalize assertion still guards the chunked load.
 */
export function validateSourceCostCsv(parsed, expectedTotals = null) {
  const violations = [];
  const { rows } = parsed;
  if (!rows.length) violations.push({ rule: 'empty_file', detail: 'no data rows' });
  const totals = computeSourceCostTotals(rows);
  if (expectedTotals) {
    for (const [key, expected] of Object.entries(expectedTotals)) {
      if (!(key in totals)) {
        violations.push({ rule: 'unknown_control_key', detail: { key } });
        continue;
      }
      if (totals[key] !== expected) {
        violations.push({ rule: 'control_total_mismatch', detail: { key, computed: totals[key], expected } });
      }
    }
  }
  return { ok: violations.length === 0, violations, totals };
}
