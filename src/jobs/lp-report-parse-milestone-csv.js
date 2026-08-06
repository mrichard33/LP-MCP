// ─── Jobs by Milestone Date (134, CSV) parser — src/jobs/lp-report-parse-milestone-csv.js ───
//
// PURE. Parses the LP "Jobs by Milestone Date" CSV export — one row per job,
// the source of Net Released and the Goal & Pace hero.
//
// WHY THIS EXISTS. 134 was the one report with no CSV parser: it landed
// exclusively through the -layout PDF path (lp-report-parse-a.js), which is
// also the path that stored report_generated_at as date-only midnight on every
// snapshot in the table. The CSV carries its own run timestamp per row, so the
// truncation has nothing left to stand on.
//
// ── COLUMN MAPPING IS PROVISIONAL AND FAILS LOUD ────────────────────────────
// The six discriminator columns below are confirmed from the report
// fingerprint. The DESCRIPTIVE columns (customer, address, rep, product) are
// resolved by trying LP's known header spellings in order, and anything not
// recognised is REPORTED, never guessed at: parseMilestoneCsv returns
// `unmappedColumns` and the ingest logs it.
//
// That asymmetry is deliberate. Silently sliding a value into the wrong field
// is the exact defect this whole cutover exists to kill — March's 137 put
// $8,357,993 of net sales into hold_cents without a word of complaint. Money
// and identity columns are REQUIRED and the file is rejected without them; a
// missing rep name is merely NULL and noted.
//
// MONEY IS CENTS, parsed with parseCsvMoneyCents: LP prints the same money
// column as a bare integer on one row and '0.0000' on the next, and the strict
// two-decimal parser returns null for the latter — which `?? 0` would have
// turned into a silent zero.

import { parseCsvMoneyCents } from './lp-report-common.js';
import { csvToObjects, parseCsvDate, parseCsvDateTimeET } from './lp-report-csv-common.js';

export const PARSER_VERSION = 'milestone-csv-v1';

/** Confirmed by the report fingerprint (§C) — absence rejects the file. */
const REQUIRED = ['contractid', 'MilestoneDate', 'NetAmount', 'GrossAmount', 'brp_id', 'MdtDescr'];

/**
 * Descriptive columns, by LP's known header spellings. First hit wins; no hit
 * is NULL and reported. These carry no money and no identity, so a miss
 * degrades the row's readability, never its arithmetic.
 */
const OPTIONAL = {
  customer_name: ['custname', 'CustName', 'CustomerName', 'Customer'],
  address:       ['address', 'Address', 'addr1', 'Address1'],
  city:          ['city', 'City'],
  product:       ['MdtDescr', 'ProductDescr', 'productdescr', 'Product'],
  sales_rep:     ['EmpName', 'SalesRep', 'RepName', 'salesrep'],
  contract_date: ['ContractDate', 'contractdate', 'cdate', 'SaleDate'],
};

/** Money columns whose sub-cent remainder matters (§F). */
const MONEY = {
  gross_cents:   ['GrossAmount'],
  net_cents:     ['NetAmount'],
  paid_cents:    ['PaidAmount', 'AmountPaid'],
  balance_cents: ['BalanceAmount', 'Balance'],
};

const pick = (row, names) => {
  for (const n of names) {
    if (row[n] !== undefined && String(row[n]).trim() !== '') return String(row[n]).trim();
  }
  return null;
};

/**
 * Parse the Jobs by Milestone Date CSV.
 * @returns {{rows: object[], header: object, subCentColumns: string[], unmappedColumns: string[]}}
 */
export function parseMilestoneCsv(text) {
  const { header: columns, rows: raw } = csvToObjects(text, REQUIRED);

  let periodStart = null, periodEnd = null, asOf = null, generatedAt = null;
  const subCentColumns = [];

  const rows = raw.map((r, i) => {
    periodStart ??= parseCsvDate(r.SDate);
    periodEnd ??= parseCsvDate(r.EDate);
    if (!generatedAt) {
      const gen = parseCsvDateTimeET(r.CurrentDateTime);
      if (gen) { generatedAt = gen; asOf ??= parseCsvDate(r.CurrentDateTime); }
    }

    const out = {
      row_num: i + 1,
      job_number: String(r.contractid ?? '').trim() || null,
      branch_code_raw: String(r.brp_id ?? '').trim() || null,
      rtp_date: parseCsvDate(r.MilestoneDate),
      market: null,                       // resolved by the ingest, fail-closed
    };
    for (const [field, names] of Object.entries(OPTIONAL)) {
      out[field] = field === 'contract_date' ? parseCsvDate(pick(r, names)) : pick(r, names);
    }
    for (const [field, names] of Object.entries(MONEY)) {
      const parsed = parseCsvMoneyCents(pick(r, names));
      out[field] = parsed === null ? null : parsed.cents;
      if (parsed?.subCent) subCentColumns.push(names[0]);
    }
    return out;
  });

  // Everything the file offered that this parser does not read. Reported so the
  // first real export tells us what we are dropping instead of hiding it.
  const known = new Set([
    ...REQUIRED, 'SDate', 'EDate', 'CurrentDateTime',
    ...Object.values(OPTIONAL).flat(), ...Object.values(MONEY).flat(),
  ].map((c) => c.toLowerCase()));
  const unmappedColumns = (columns ?? []).filter((c) => {
    const lower = c.trim().toLowerCase();
    return !known.has(lower) && !lower.startsWith('x')
      && !['usecolor', 'fullname', 'empname'].includes(lower);
  });

  return {
    rows,
    header: {
      periodStart, periodEnd, asOf,
      generatedAt: generatedAt?.iso ?? null,
      generatedAtTruncated: Boolean(generatedAt && generatedAt.isMidnight && !generatedAt.hadTime),
    },
    subCentColumns: [...new Set(subCentColumns)],
    unmappedColumns,
  };
}

/** Column sums — the control totals lp_csv_ingest_finalize re-asserts. */
export function computeMilestoneTotals(rows) {
  const t = { gross_cents: 0, net_cents: 0, row_count: 0 };
  for (const r of rows) {
    t.gross_cents += r.gross_cents ?? 0;
    t.net_cents += r.net_cents ?? 0;
    t.row_count += 1;
  }
  return t;
}

/**
 * Fail-closed validation. Identity and money are non-negotiable; a job with no
 * contract id or no gross cannot be reconciled against anything, so the FILE is
 * rejected rather than the row silently dropped.
 */
export function validateMilestoneCsv(parsed) {
  const violations = [];
  const reconciliations = [];
  const { rows, header } = parsed;

  if (!rows.length) violations.push({ rule: 'empty_file', detail: {} });
  if (!header.periodStart || !header.periodEnd) {
    violations.push({ rule: 'missing_period', detail: { header } });
  }
  if (header.generatedAtTruncated) {
    violations.push({ rule: 'report_generated_at_truncated', detail: { generated_at: header.generatedAt } });
  }

  const noId = rows.filter((r) => !r.job_number).map((r) => r.row_num);
  if (noId.length) violations.push({ rule: 'missing_contract_id', detail: { rows: noId.slice(0, 20), count: noId.length } });

  const noGross = rows.filter((r) => r.gross_cents === null).map((r) => r.row_num);
  if (noGross.length) violations.push({ rule: 'unparseable_money', detail: { column: 'GrossAmount', rows: noGross.slice(0, 20), count: noGross.length } });

  const noBranch = rows.filter((r) => !r.branch_code_raw).map((r) => r.row_num);
  if (noBranch.length) violations.push({ rule: 'missing_branch', detail: { rows: noBranch.slice(0, 20), count: noBranch.length } });

  // Soft — recorded, never blocking.
  if (parsed.subCentColumns?.length) {
    reconciliations.push({ class: 'sub_cent_precision_loss', scope: 'milestone_csv', detail: { columns: parsed.subCentColumns } });
  }
  if (parsed.unmappedColumns?.length) {
    reconciliations.push({ class: 'unmapped_columns', scope: 'milestone_csv', detail: { columns: parsed.unmappedColumns } });
  }

  return { ok: violations.length === 0, violations, reconciliations };
}
