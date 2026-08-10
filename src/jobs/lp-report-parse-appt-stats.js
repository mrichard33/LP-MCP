// ─── Appointment Stats by Sales Rep with Source (CSV) parser ───────────────
//                          src/jobs/lp-report-parse-appt-stats.js
//
// PURE. Parses LP report 138 "Appointment Stats by Sales Rep with Source" —
// one row per (Salesrep, Src_id), carrying the appointment funnel from set
// through issued, sat and sold, plus a ten-bucket disposition breakdown.
//
// 138 is the canonical Reece-series id and the only one that appears in slugs,
// tables, logs and prose. LP also exposes this report as ReportView `Rpt=229`;
// that number exists solely to build an on-demand URL and is not an identifier.
//
// WHY THIS REPORT EXISTS FOR US. It is the ONLY export carrying both gross and
// net issued at source grain. 136 has NumIssued with no net-issued column, so a
// gross-basis sit rate by source is not computable from it and must come from
// here:
//     sit_rate_by_source = Σ NumSat ÷ Σ NumIssued   grouped by Src_id
//     sit_rate_by_rep    = Σ NumSat ÷ Σ NumIssued   grouped by Salesrep
// GROSS issued is the denominator, always — see the NSLI note in
// lp-report-parse-sales-efficiency.js. LP's own net-issue-based rates are not
// used anywhere.
//
// NO MARKET DIMENSION. 138 has no branch column, so its rows cannot be mapped
// through lp_branch_market_map and produce no lp_report_facts. Do not attempt
// market attribution from this report.
//
// MONEY IS CENTS (parseCsvMoneyCents — GSA/NSA mix bare integers and LP's
// 4-decimal form in the same column).

import { parseCsvMoneyCents } from './lp-report-common.js';
import {
  csvToObjects, parseCsvDate, parseCsvDateTimeET, parseCount,
  columnReader, assertRequiredColumns,
} from './lp-report-csv-common.js';

/** Bumped when a parse change should let corrected output re-land and supersede. */
export const APPT_STATS_PARSER_VERSION = 'appt-stats-csv-v1';

/**
 * Label for a row LP prints with a blank rep or source.
 *
 * Note this is NOT the same thing as LP's own `(SalesRep Unknown)` bucket,
 * which is a real, named value the report emits for appointments set before a
 * rep was assigned — 12 rows and 1,822 sets in January 2026. That one is passed
 * through verbatim and must be displayed, never dropped or redistributed.
 * UNATTRIBUTED is only for a genuinely empty cell.
 */
export const UNATTRIBUTED = 'UNATTRIBUTED';

/** LP's own sentinel for "set before a rep was assigned". */
export const SALESREP_UNKNOWN = '(SalesRep Unknown)';

/** How many positional disposition slots LP prints. */
const DSP_SLOTS = 10;

/**
 * LP's fixed-name disposition columns and the `Dsp` label each one shadows.
 *
 * These are exact per-row duplicates of the positional counts — verified
 * identical on all 345 rows of the January 2026 export (Num1Leg = NumDsp2,
 * NumNoHome = NumDsp3, NumCCC = NumDsp4, NumNIS = NumDsp6, NumOpps = NumDsp7,
 * NumNOCOPPRRF = NumDsp10, NumSale = NumDsp1).
 *
 * They are kept as a CROSS-CHECK, not as a second source of truth. The labels
 * are authoritative because they travel with their counts; the named columns
 * are pinned to fixed positions. If LP ever reorders Dsp1..Dsp10, these two
 * readings diverge, and that divergence is the only signal that would catch it.
 *
 * NumNOPs and NumIssCTR are absent here deliberately: both are zero across the
 * whole January export, so which label they shadow cannot be established from
 * the data and guessing would defeat the point of the check.
 */
const ALIAS_LABELS = {
  NumSale: 'Sale',
  Num1Leg: '1leg',
  NumNoHome: 'NoHome',
  NumCCC: 'CCC',
  NumNIS: 'NIS',
  NumOpps: 'OPPFDN',
  NumNOCOPPRRF: 'NOC',
};

/**
 * Only what the parser actually consumes.
 *
 * Kept deliberately short. csvToObjects fails a file closed on a MISSING
 * required column, so every name added here is a way for a future export to be
 * rejected wholesale. Extra columns we do not know about are harmless — they
 * ride into the content hash and are ignored.
 */
export const REQUIRED = ['Salesrep', 'Src_id', 'NumSet', 'NumIssued', 'NumNetIssued',
  'NumSat', 'NumSale', 'SDate', 'EDate'];

/** Money cell → cents, tracking sub-cent loss for the §F gate. */
function money(raw, sink, column) {
  const parsed = parseCsvMoneyCents(raw);
  if (parsed === null) return 0;
  if (parsed.subCent) sink.push(column);
  return parsed.cents;
}

/**
 * Parse the 138 CSV export.
 * @returns {{ rows: object[], header: object, subCentColumns: string[],
 *            dispositionLabels: string[], aliasDisagreements: object[] }}
 */
export function parseApptStatsCsv(text) {
  // Required columns are checked HERE rather than by csvToObjects, because that
  // check is case-sensitive and this parser is not. Handing it REQUIRED would
  // reject a file on casing alone that detectReportFromHeader had already
  // matched and routed here — the parser being stricter than its own router.
  const { header, rows: raw } = csvToObjects(text);
  assertRequiredColumns(header, REQUIRED);
  const get = columnReader(header);
  let periodStart = null, periodEnd = null, asOf = null, generatedAt = null;
  const subCentColumns = [];
  const aliasDisagreements = [];
  const labelsSeen = new Set();

  const rows = raw.map((r, i) => {
    periodStart ??= parseCsvDate(get(r, 'SDate'));
    periodEnd ??= parseCsvDate(get(r, 'EDate'));
    // Full timestamp, not just the date: it is the coverage-as-of value that
    // decides is_partial_month. asOf keeps the date form for scope derivation.
    if (!generatedAt) {
      const gen = parseCsvDateTimeET(get(r, 'CurrentDateTime'));
      if (gen) { generatedAt = gen; asOf ??= parseCsvDate(get(r, 'CurrentDateTime')); }
    }

    // Dispositions decode BY LABEL. The label travels with its count, so a
    // reordering upstream moves both together and cannot silently
    // re-attribute. Position is only how the two are paired, never what a
    // count means.
    const dispositions = {};
    for (let slot = 1; slot <= DSP_SLOTS; slot++) {
      const label = String(get(r, `Dsp${slot}`) ?? '').trim();
      if (!label) continue;                     // LP leaves unused slots blank
      const count = parseCount(get(r, `NumDsp${slot}`)) ?? 0;
      labelsSeen.add(label);
      dispositions[label] = (dispositions[label] ?? 0) + count;
    }

    for (const [column, label] of Object.entries(ALIAS_LABELS)) {
      const alias = parseCount(get(r, column));
      if (alias === null) continue;             // column absent in this export
      const viaLabel = dispositions[label];
      if (viaLabel !== undefined && viaLabel !== alias) {
        aliasDisagreements.push({ row_num: i + 1, column, label, alias, via_label: viaLabel });
      }
    }

    return {
      row_num: i + 1,
      salesrep_raw: String(get(r, 'Salesrep') ?? '').trim() || UNATTRIBUTED,
      src_id_raw: String(get(r, 'Src_id') ?? '').trim() || UNATTRIBUTED,
      num_set: parseCount(get(r, 'NumSet')) ?? 0,
      num_issued: parseCount(get(r, 'NumIssued')) ?? 0,
      num_net_issued: parseCount(get(r, 'NumNetIssued')) ?? 0,
      num_sat: parseCount(get(r, 'NumSat')) ?? 0,
      num_sale: parseCount(get(r, 'NumSale')) ?? 0,
      gsa_cents: money(get(r, 'GSA'), subCentColumns, 'GSA'),
      nsa_cents: money(get(r, 'NSA'), subCentColumns, 'NSA'),
      // Two SEPARATE residual buckets. NumOther is set-but-not-issued (it
      // completes NumSet exactly — see the identity gate below). NumOther2
      // satisfies no identity derivable from the file; it is carried verbatim
      // and deliberately not interpreted.
      num_other: parseCount(get(r, 'NumOther')) ?? 0,
      num_other2: parseCount(get(r, 'NumOther2')) ?? 0,
      dispositions,
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
    dispositionLabels: [...labelsSeen],
    aliasDisagreements,
  };
}

/** Column sums — the control totals the finalize RPC re-asserts. */
export function computeApptStatsTotals(rows) {
  const t = {
    num_set: 0, num_issued: 0, num_net_issued: 0, num_sat: 0, num_sale: 0,
    gsa_cents: 0, nsa_cents: 0, num_other: 0, num_other2: 0,
  };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += r[k] ?? 0;
  return t;
}

/** Σ of a row's decoded disposition counts. */
function dispositionTotal(row) {
  return Object.values(row.dispositions ?? {}).reduce((a, n) => a + n, 0);
}

/** Full-detail rows carried per warning. Aggregates below are never truncated. */
const DELTA_SAMPLE_LIMIT = 50;

/**
 * Roll a list of per-row breaches into ONE warning: complete deltas, bounded size.
 *
 * `deltas` is every row's signed delta keyed by row_num — one small integer per
 * row, so a wholly broken 345-row file costs a few KB rather than the ~1,000
 * violation objects the old un-capped violation path would have serialised into
 * scorecard_ingest_log.detail. `sample` carries the first few in full for
 * eyeballing; `rows`, `net_delta` and `abs_delta` are exact regardless.
 */
function deltaWarning(rule, breaches, note) {
  const deltas = {};
  let net = 0;
  let abs = 0;
  for (const b of breaches) {
    deltas[b.row_num] = b.delta;
    net += b.delta;
    abs += Math.abs(b.delta);
  }
  return {
    rule,
    detail: {
      rows: breaches.length,
      net_delta: net,
      abs_delta: abs,
      deltas,
      sample: breaches.slice(0, DELTA_SAMPLE_LIMIT),
      truncated_sample: breaches.length > DELTA_SAMPLE_LIMIT,
      note,
    },
  };
}

/**
 * Validation. Structural faults fail the file closed; the two arithmetic
 * identities record a delta and let it through.
 *
 * LP CSV exports print no footer, no grand total and no per-band subtotals, so
 * the sum-ties-to-printed-footer gate every PDF parser leans on is simply
 * unavailable. 138 appeared to hand back something better — two exact identities:
 *
 *     Σ NumDsp1..NumDsp10  ==  NumIssued     the dispositions partition issued
 *     NumIssued + NumOther ==  NumSet        NumOther is set-but-not-issued
 *
 * ══ WHY THESE TWO ARE WARNINGS AND NOT VIOLATIONS ══
 *
 * Both were verified against exactly ONE month — January 2026, 345 rows, zero
 * breaches — and generalised from there. They do not hold across all months. On
 * 2026-08-10 they rejected 60 files in a day, and report 138 had not landed since
 * 08-08: an identity observed once was failing files closed on every month that
 * did not share January's shape.
 *
 * A control total earns the right to fail a file closed by being a rule of the
 * source system, not by having been true in the sample we happened to check. The
 * arithmetic is still worth knowing — a column slide or mis-zipped label still
 * breaks it — so the delta is recorded per row and surfaced as
 * succeeded_with_warnings. What changed is who decides: the identity now reports,
 * and a human rules on it, rather than silently keeping a month out of the
 * scorecard.
 *
 * Re-promoting either to a violation requires evidence across months, not one.
 *
 * Still fail-closed, because these are structural rather than arithmetic:
 * empty_file, sat_exceeds_issued (a bound, not an identity — more sat than
 * issued is impossible, not merely unexplained), unknown_control_key and
 * control_total_mismatch (the caller's own declared totals disagreeing with the
 * file it sent is a caller bug, and finalize re-asserts them anyway).
 *
 * The alias cross-check remains a WARNING. The label-driven decode is correct by
 * construction; a disagreement means LP moved something and we want it visible,
 * not that this file is unparseable.
 */
export function validateApptStatsCsv(parsed, expectedTotals = null) {
  const violations = [];
  const warnings = [];
  const { rows } = parsed;

  if (!rows.length) violations.push({ rule: 'empty_file', detail: 'no data rows' });

  const dispositionBreaches = [];
  const partitionBreaches = [];

  for (const r of rows) {
    const dsp = dispositionTotal(r);
    if (dsp !== r.num_issued) {
      dispositionBreaches.push({
        row_num: r.row_num, salesrep: r.salesrep_raw, src_id: r.src_id_raw,
        dispositions_total: dsp, num_issued: r.num_issued,
        delta: dsp - r.num_issued,
      });
    }
    if (r.num_issued + r.num_other !== r.num_set) {
      partitionBreaches.push({
        row_num: r.row_num, salesrep: r.salesrep_raw, src_id: r.src_id_raw,
        num_issued: r.num_issued, num_other: r.num_other, num_set: r.num_set,
        delta: (r.num_issued + r.num_other) - r.num_set,
      });
    }
    if (r.num_sat > r.num_issued) {
      violations.push({
        rule: 'sat_exceeds_issued',
        detail: { row_num: r.row_num, num_sat: r.num_sat, num_issued: r.num_issued },
      });
    }
  }

  if (dispositionBreaches.length) {
    warnings.push(deltaWarning('disposition_sum_mismatch', dispositionBreaches,
      'Σ NumDsp1..NumDsp10 != NumIssued on these rows. delta = dispositions_total - num_issued. '
      + 'Recorded, not rejected: this identity was validated against January 2026 only and does not hold across all months.'));
  }
  if (partitionBreaches.length) {
    warnings.push(deltaWarning('set_partition_mismatch', partitionBreaches,
      'NumIssued + NumOther != NumSet on these rows. delta = (num_issued + num_other) - num_set. '
      + 'Recorded, not rejected: same single-month provenance as disposition_sum_mismatch.'));
  }

  if (parsed.aliasDisagreements?.length) {
    warnings.push({
      rule: 'disposition_alias_disagreement',
      detail: {
        count: parsed.aliasDisagreements.length,
        sample: parsed.aliasDisagreements.slice(0, 5),
        note: 'LP fixed-name disposition columns disagree with the label-decoded counts — Dsp slots may have been reordered upstream',
      },
    });
  }
  if (parsed.subCentColumns?.length) {
    warnings.push({ rule: 'sub_cent_precision_loss', detail: { columns: parsed.subCentColumns } });
  }

  const totals = computeApptStatsTotals(rows);
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

  return { ok: violations.length === 0, violations, warnings, totals };
}

/**
 * Gross-basis sit rate grouped by one of the two key columns.
 * Ratio of sums, never a mean of per-row rates — a 914-issue source and a
 * 1-issue source are not equal votes.
 * @param {object[]} rows
 * @param {'src_id_raw'|'salesrep_raw'} key
 */
export function sitRateBy(rows, key) {
  const acc = new Map();
  for (const r of rows) {
    const k = r[key];
    const a = acc.get(k) ?? { num_sat: 0, num_issued: 0, num_set: 0, num_sale: 0 };
    a.num_sat += r.num_sat; a.num_issued += r.num_issued;
    a.num_set += r.num_set; a.num_sale += r.num_sale;
    acc.set(k, a);
  }
  const out = {};
  for (const [k, a] of acc) {
    out[k] = { ...a, sit_rate: a.num_issued > 0 ? a.num_sat / a.num_issued : null };
  }
  return out;
}
