// ─── Sales Efficiency (LP report 137) parser — src/jobs/lp-report-parse-sales-efficiency.js ───
//
// PURE (market resolution takes a preloaded branch map). Report 137 is the
// ONLY per-market source of Issued / Sat / Sold / Cancelled / NSA.
//
// VARIANTS: LP re-groups this same report by Market, by Setter and by Source,
// and all three export an IDENTICAL header — the grouping shows up only in the
// `xGrouper` echo column, which resolveVariant reads off row 1. The CSV parser
// takes the resolved variant and changes exactly one thing: what `Grouper`
// means. See REPORT_VARIANTS in lp-report-csv-common.js. Two formats:
//
//   CSV  (manual export, cents)      — one row per branch, rich columns.
//   PDF  (scheduled daily, dollars)  — grid, TWO physical lines per market
//        (values line + percents line), sparse cells simply absent, and a
//        Total row that is the checksum.
//
// PDF COLUMN STRATEGY — self-calibrating bands, never token order:
// markets with no activity in a bucket omit those tokens entirely (BOCA /
// FTLAU show no Credit Decline or Canceled cells in the Aug sample; MIAMI
// has only Iss/NetIss/Demo). Token order therefore CANNOT identify columns.
// Instead the Total row — the one line with every active column populated —
// calibrates the column bands by character offset, and every market-line
// token is assigned to the band whose right edge is nearest its own right
// edge (values are right-aligned). A token that lands in no band fails the
// file closed.
//
// MTD GUARD: cohort-based columns (Net count/volume) are BLANK on MTD
// pulls, and the printed NSLI degrades to garbage (Aug sample: company
// "340"). A parse with no Net band anywhere sets mode='counts_only' —
// net figures are never written, and NOTHING downstream may substitute 0.
//
// NSLI: the printed column is NOT ingested in any mode — it is not
// reproducible from the report's own visible columns. NSLI is always
// computed downstream as NSA ÷ Issued.
//
// MONEY IS CENTS (parseMoneyCents). PDF prints whole dollars — checksum
// asserts within the bounded display_rounding allowance ($1 × row count);
// CSV carries cents and asserts exactly.

import { parseMoneyCents, parseDateMDY } from './lp-report-common.js';
import { csvToObjects, parseCsvDate, parseCount, parseCsvDateTimeET, parseCsv } from './lp-report-csv-common.js';
import { resolveMarketFromBranch } from './market-resolver.js';

// Verbatim branch labels 137 prints (Grouper / row label). RFED appears when
// active. An unknown label fails closed upstream (unmapped_branch).
export const SE_BRANCH_LABELS = ['BOCA', 'FTLAU', 'FTMYR', 'JAX', 'LAKE', 'MIAMI', 'ORL', 'RFED', 'SAR', 'STPET'];

export const CSV_REQUIRED = ['Grouper', 'NumIssued', 'NumSale', 'NumNetIssued', 'NumSat', 'GSA',
  'NumNet', 'NSA', 'NumWorking', 'NumCD', 'NumCancelled', 'NumHold',
  'GSAWorking', 'GSACD', 'GSACancelled', 'GSAHold', 'SDate', 'EDate'];

/**
 * Which field the `Grouper` column becomes, per variant.
 *
 * One branch, not a second parser: every money and count column on a By Setter
 * export is byte-identical to By Market. The ONLY differences are what the row
 * label means and whether it may be resolved to a market — so those are the
 * only two things that vary here.
 */
const SE_ROW_LABEL_FIELD = {
  sales_efficiency: 'branch_code_raw',
  sales_efficiency_by_setter: 'setter_name_raw',
};

/**
 * Parse the 137 CSV export (cents-exact).
 *
 * @param {string} text
 * @param {{variant?: string}} [opts] effective report_type from resolveVariant;
 *   decides the row-label field. Defaults to the By Market shape.
 * @returns {{ rows: object[], header: {periodStart, periodEnd, asOf}, mode: 'full' }}
 */
export function parseSalesEfficiencyCsv(text, { variant = 'sales_efficiency' } = {}) {
  const labelField = SE_ROW_LABEL_FIELD[variant] ?? 'branch_code_raw';
  const { rows: raw } = csvToObjects(text, CSV_REQUIRED);
  let periodStart = null, periodEnd = null, asOf = null, generatedAt = null;
  const rows = raw.map((r, i) => {
    periodStart ??= parseCsvDate(r.SDate);
    periodEnd ??= parseCsvDate(r.EDate);
    // Full timestamp, not just the date: this is the coverage-as-of value
    // behind is_partial_month, and truncating it loses the only signal of how
    // much of the period the file actually contains.
    if (!generatedAt) {
      const gen = parseCsvDateTimeET(r.CurrentDateTime);
      if (gen) { generatedAt = gen; asOf ??= parseCsvDate(r.CurrentDateTime); }
    }
    return {
      row_num: i + 1,
      [labelField]: String(r.Grouper ?? '').trim(),
      num_issued: parseCount(r.NumIssued) ?? 0,
      num_net_issued: parseCount(r.NumNetIssued) ?? 0,
      num_sat: parseCount(r.NumSat) ?? 0,
      num_sold: parseCount(r.NumSale) ?? 0,
      gsa_cents: parseMoneyCents(r.GSA) ?? 0,
      num_net: parseCount(r.NumNet) ?? 0,
      nsa_cents: parseMoneyCents(r.NSA) ?? 0,
      num_working: parseCount(r.NumWorking) ?? 0,
      working_cents: parseMoneyCents(r.GSAWorking) ?? 0,
      num_cd: parseCount(r.NumCD) ?? 0,
      cd_cents: parseMoneyCents(r.GSACD) ?? 0,
      num_cancelled: parseCount(r.NumCancelled) ?? 0,
      cancelled_cents: parseMoneyCents(r.GSACancelled) ?? 0,
      num_hold: parseCount(r.NumHold) ?? 0,
      hold_cents: parseMoneyCents(r.GSAHold) ?? 0,
    };
  });
  return {
    rows,
    header: {
      periodStart, periodEnd, asOf,
      generatedAt: generatedAt?.iso ?? null,
      generatedAtTruncated: Boolean(generatedAt && generatedAt.isMidnight && !generatedAt.hadTime),
    },
    mode: 'full',
  };
}

// ── PDF parsing ─────────────────────────────────────────────────────────────

/** Tokenize a -layout line into { text, start, end } runs split on 2+ spaces. */
function tokenize(line) {
  const tokens = [];
  const re = /\S+(?: \S+)*/g; // runs separated by 2+ spaces
  let m;
  while ((m = re.exec(line)) !== null) {
    tokens.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

const NUM_RE = /^-?[\d,]+(?:\.\d{1,2})?$/;

/** Parse the header window: 'For Appointment Dates Between Sat 08/01/26 and Mon 08/31/26'. */
function parseWindow(text) {
  const m = text.match(/For Appointment Dates Between\s+(?:[A-Za-z]{3}\s+)?([\d/]+)\s+and\s+(?:[A-Za-z]{3}\s+)?([\d/]+)/);
  if (!m) return { periodStart: null, periodEnd: null };
  return { periodStart: parseDateMDY(m[1]), periodEnd: parseDateMDY(m[2]) };
}

/** Parse the page-footer run stamp: '8/5/2026 2:22PM' → '2026-08-05'. */
function parsePrintedAt(text) {
  const m = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s+\d{1,2}:\d{2}\s*[AP]M/i);
  return m ? parseDateMDY(m[1]) : null;
}

/**
 * Parse the 137 PDF (pdftotext -layout output).
 *
 * ══ LEGACY / FROZEN — new ingests are CSV ══
 * LP now schedules CSV exports, and parseSalesEfficiencyCsv above is the
 * go-forward path: it reads named columns and cannot slide a value into the
 * wrong field. This band parser exists only to replay the 18 PDF snapshots
 * already in history. Do not extend it, do not add FIELD_SETS entries, and do
 * not recalibrate bands from the header — repair mislabeled history by
 * re-sending the period as CSV, which supersedes via normal promotion.
 *
 * Column bands come from the Total row: with the NSLI band dropped, an
 * even count of remaining bands pairs up (count, volume) right-to-left
 * after the three leading singles (Gross Iss, Net Iss, Demo) and one
 * Close pair — i.e. 13 data bands = counts_only (no Net), 15 = full.
 * The 13 case is only trustworthy while the period is still open; see the
 * fail-closed gate below.
 *
 * @returns {{ rows: object[], header: {periodStart, periodEnd, asOf},
 *             mode: 'full'|'counts_only', totals: object }}
 */
export function parseSalesEfficiencyPdf(text) {
  const lines = text.split('\n');
  const { periodStart, periodEnd } = parseWindow(text);

  // 1. Locate the Total values line: the numeric-heavy line adjacent to the
  //    'Total:' label (the label renders on its own line in the sample).
  let totalTokens = null;
  const totalLabelIdx = lines.findIndex((l) => /^\s*Total:/.test(l));
  const candidates = [];
  if (totalLabelIdx >= 0) {
    for (const idx of [totalLabelIdx, totalLabelIdx - 1, totalLabelIdx + 1, totalLabelIdx - 2]) {
      if (idx < 0 || idx >= lines.length) continue;
      const toks = tokenize(lines[idx]).filter((t) => t.text !== 'Total:');
      if (toks.length >= 10 && toks.every((t) => NUM_RE.test(t.text))) candidates.push(toks);
    }
  }
  if (candidates.length) totalTokens = candidates[0];
  if (!totalTokens) {
    return { rows: [], header: { periodStart, periodEnd, asOf: null }, mode: 'unparseable', totals: null, error: 'total_row_not_found' };
  }

  // 2. Band layout. Last band is the printed NSLI (ignored). The remainder:
  //    gross_iss, net_iss, demo, then (count,volume) pairs for Close,
  //    Working, Credit Decline, Canceled, Hold-HOA, and — full mode — Net.
  const dataBands = totalTokens.slice(0, -1);
  const FIELD_SETS = {
    13: ['num_issued', 'num_net_issued', 'num_sat',
      'num_sold', 'gsa_cents', 'num_working', 'working_cents', 'num_cd', 'cd_cents',
      'num_cancelled', 'cancelled_cents', 'num_hold', 'hold_cents'],
    15: ['num_issued', 'num_net_issued', 'num_sat',
      'num_sold', 'gsa_cents', 'num_working', 'working_cents', 'num_cd', 'cd_cents',
      'num_cancelled', 'cancelled_cents', 'num_hold', 'hold_cents', 'num_net', 'nsa_cents'],
  };
  const fields = FIELD_SETS[dataBands.length];
  if (!fields) {
    return { rows: [], header: { periodStart, periodEnd, asOf: null }, mode: 'unparseable', totals: null, error: `unexpected_band_count_${dataBands.length}` };
  }

  // ── FAIL CLOSED ON THE AMBIGUOUS 13 (§G) ─────────────────────────────────
  // A 13-band Total row means ONE (count, volume) pair did not print, and the
  // count alone cannot say WHICH. FIELD_SETS[13] assumes the absent pair is the
  // last one, Net — true for a month still in flight, where net requires
  // completion. It is NOT true for a closed month with an empty bucket: March
  // 2026 printed no Hold-HOA activity, so Net slid into the Hold slot and
  // $8,357,993 of net sales was stored as hold_cents with nsa_cents NULL, with
  // no complaint. That silent guess is the defect.
  //
  // The file states its own run date in the page footer, so coverage decides
  // it: a run at or before period_end is still accumulating and may legitimately
  // lack Net; a run after period_end describes a closed period and MUST print
  // all six pairs. No run date means we cannot prove partial coverage — reject.
  const printedAt = parsePrintedAt(text);
  const partialCoverage = Boolean(printedAt && periodEnd && printedAt <= periodEnd);
  if (dataBands.length === 13 && !partialCoverage) {
    return {
      rows: [], header: { periodStart, periodEnd, asOf: printedAt }, mode: 'unparseable', totals: null,
      error: 'unexpected_band_count_13',
      detail: { printed_at: printedAt, period_end: periodEnd, bands: 13 },
    };
  }

  const mode = dataBands.length === 15 ? 'full' : 'counts_only';
  const bandEdges = dataBands.map((t) => t.end);
  const nsliEdge = totalTokens[totalTokens.length - 1].end;

  const assign = (tok) => {
    // right-aligned columns: nearest band right-edge wins, within tolerance
    let best = -1, bestDist = Infinity;
    bandEdges.forEach((edge, i) => {
      const d = Math.abs(tok.end - edge);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    if (Math.abs(tok.end - nsliEdge) < bestDist) return { field: '__nsli__', dist: Math.abs(tok.end - nsliEdge) };
    return { field: fields[best], dist: bestDist };
  };

  // 3. Market values lines: start with a known branch label; the following
  //    percents line (contains '%') is skipped.
  const rows = [];
  const misaligned = [];
  for (const line of lines) {
    const toks = tokenize(line);
    if (!toks.length) continue;
    const label = toks[0].text;
    if (!SE_BRANCH_LABELS.includes(label)) continue;
    if (toks.some((t) => t.text.includes('%'))) continue; // percent line safety
    const row = { branch_code_raw: label };
    for (const tok of toks.slice(1)) {
      if (!NUM_RE.test(tok.text)) { misaligned.push({ label, token: tok.text }); continue; }
      const { field, dist } = assign(tok);
      if (field === '__nsli__') continue; // printed NSLI — never ingested
      if (dist > 6) { misaligned.push({ label, token: tok.text, dist }); continue; }
      row[field] = field.endsWith('_cents') ? parseMoneyCents(tok.text) : parseCount(tok.text);
    }
    rows.push(row);
  }
  rows.forEach((r, i) => { r.row_num = i + 1; });

  // 4. Totals object from the calibration row (same fields).
  const totals = {};
  dataBands.forEach((t, i) => {
    const f = fields[i];
    totals[f] = f.endsWith('_cents') ? parseMoneyCents(t.text) : parseCount(t.text);
  });

  return { rows, header: { periodStart, periodEnd, asOf: printedAt }, mode, totals, misaligned };
}

// ── Printed-layout parsing (By Setter, Excel export of the printed report) ──
//
// 2026-10-08: Mark exported "Sales Efficiency By Setter" for Jan–Sep 2026 from
// LP's report VIEWER as .xls. That file is the printed page laid onto a grid,
// not the data export parseSalesEfficiencyCsv reads: no header row of field
// names, two-plus physical rows per setter (values, then percents), the first
// setter spilling into the header rows, and the Total spread over a dozen
// rows one cell each. Converted to CSV (LibreOffice `soffice --headless
// --convert-to csv`, or Excel "Save As CSV"), every value keeps its grid
// COLUMN, and the column is the same in all nine months — so fields are read
// by column index, and the printed Total is the checksum that proves it.
//
// FAIL CLOSED: the header labels must sit in the columns below (a moved column
// means a changed layout, and a guessed mapping is how March 2026's Net became
// Hold on the PDF path), a field seen twice in one block rejects the file, and
// validateSalesEfficiency compares every column with the printed Total.

/** Grid column → field, measured on all nine 2026 exports. 46 is the printed NSLI: never ingested. */
export const SE_LAYOUT_COLUMNS = Object.freeze({
  1: 'num_issued', 2: 'num_net_issued', 3: 'num_sat',
  6: 'num_sold', 10: 'gsa_cents',
  14: 'num_working', 18: 'working_cents',
  21: 'num_cd', 24: 'cd_cents',
  27: 'num_cancelled', 30: 'cancelled_cents',
  33: 'num_hold', 37: 'hold_cents',
  40: 'num_net', 43: 'nsa_cents',
});
/** Header labels and the column each must occupy: the layout fingerprint. */
const SE_LAYOUT_HEADER = Object.freeze({
  0: 'by setter', 1: 'gross iss', 2: 'net iss', 8: 'close', 15: 'working',
  22: 'credit decline', 28: 'canceled', 33: 'hold-hoa', 41: 'net',
});
export const SE_LAYOUT_PARSER_VERSION = 'se_setter_layout_v1';

const LAYOUT_NUM_RE = /^-?[\d,]+(?:\.\d+)?$/;
const LAYOUT_PCT_RE = /^-?[\d.]+%$/;
const cell = (row, c) => String(row?.[c] ?? '').trim();

/** The grid row holding the column labels, or -1. */
function layoutHeaderRow(grid) {
  for (let i = 0; i < Math.min(grid.length, 8); i++) {
    if (Object.entries(SE_LAYOUT_HEADER).every(([c, label]) => cell(grid[i], c).toLowerCase() === label)) return i;
  }
  return -1;
}

/** Is this grid LP's printed "Sales Efficiency By Setter" page? */
export function isSalesEfficiencySetterLayout(grid) {
  const titled = (grid ?? []).slice(0, 4).some((r) => (r ?? []).some((v) => String(v ?? '').trim().toLowerCase() === 'sales efficiency by setter'));
  return titled && layoutHeaderRow(grid) >= 0;
}

/**
 * Parse the printed By Setter layout (as CSV text).
 *
 * @param {string|string[][]} input CSV text, or a grid already split by parseCsv
 * @returns {{ rows, header: {periodStart, periodEnd, asOf, generatedAt}, mode, totals, misaligned, error? }}
 */
export function parseSalesEfficiencySetterLayout(input) {
  const grid = typeof input === 'string' ? parseCsv(input) : input;
  const text = grid.map((r) => (r ?? []).join(' ')).join('\n');
  const { periodStart, periodEnd } = parseWindow(text);
  const footer = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}):(\d{2})\s*([AP]M)/i);
  const generated = footer ? parseCsvDateTimeET(`${footer[1]} ${footer[2]}:${footer[3]}:00 ${footer[4]}`) : null;
  const header = {
    periodStart, periodEnd,
    asOf: footer ? parseDateMDY(footer[1]) : null,
    generatedAt: generated?.iso ?? null,
  };
  const unparseable = (error, detail) => ({ rows: [], header, mode: 'unparseable', totals: null, misaligned: [], error, detail });

  const headerIdx = layoutHeaderRow(grid);
  if (headerIdx < 0) return unparseable('layout_header_not_found');
  const totalIdx = grid.findIndex((r, i) => i > headerIdx && cell(r, 0) === 'Total:');
  if (totalIdx < 0) return unparseable('total_row_not_found');

  // A block opens on a row whose Gross Iss cell is a count. The setter's name
  // is col 0 of that row; LP's own "no setter" bucket prints with no name at
  // all (Feb and Mar 2026), and is kept as '' exactly as the CSV export does.
  // The last block before 'Total:' is the Total itself.
  const starts = [];
  for (let i = headerIdx + 1; i < totalIdx; i++) {
    if (/^\d+$/.test(cell(grid[i], 1))) starts.push(i);
  }
  if (starts.length < 2) return unparseable('no_setter_rows');

  const misaligned = [];
  const readBlock = (from, to, label) => {
    const out = {};
    for (let i = from; i < to; i++) {
      const row = grid[i] ?? [];
      // A values cell outside the known columns means the layout moved.
      row.forEach((v, c) => {
        const s = String(v ?? '').trim();
        if (c > 0 && c !== 11 && c !== 46 && LAYOUT_NUM_RE.test(s) && !(c in SE_LAYOUT_COLUMNS)) {
          misaligned.push({ label, column: c, token: s });
        }
      });
      for (const [c, field] of Object.entries(SE_LAYOUT_COLUMNS)) {
        if (Number(c) === 1 && i !== from) continue; // only the opening row's Gross Iss
        const s = cell(row, c);
        if (!LAYOUT_NUM_RE.test(s)) continue;
        if (field in out) { misaligned.push({ label, column: Number(c), token: s, reason: 'field_twice' }); continue; }
        out[field] = field.endsWith('_cents') ? parseMoneyCents(s) : parseCount(s);
      }
    }
    return out;
  };
  const pctRowAfter = (from, limit) => {
    for (let i = from + 1; i < limit; i++) {
      if ((grid[i] ?? []).some((v) => LAYOUT_PCT_RE.test(String(v ?? '').trim()))) return i;
    }
    return -1;
  };

  const rows = [];
  for (let k = 0; k < starts.length - 1; k++) {
    const s = starts[k];
    const end = pctRowAfter(s, starts[k + 1]);
    if (end < 0) return unparseable('percent_row_not_found', { row: s });
    const label = cell(grid[s], 0);
    rows.push({ row_num: k + 1, setter_name_raw: label, ...readBlock(s, end, label) });
  }
  const totals = readBlock(starts[starts.length - 1], totalIdx, 'Total:');

  // Net prints only for a closed period (the MTD guard above): no Net total
  // means counts only, and Net stays NULL on every row, never 0.
  const mode = totals.num_net != null && totals.nsa_cents != null ? 'full' : 'counts_only';
  for (const r of rows) {
    for (const f of Object.values(SE_LAYOUT_COLUMNS)) {
      if (r[f] == null) r[f] = (mode === 'counts_only' && (f === 'num_net' || f === 'nsa_cents')) ? null : 0;
    }
  }
  if (mode === 'counts_only') { delete totals.num_net; delete totals.nsa_cents; }
  return { rows, header, mode, totals, misaligned };
}

/**
 * Resolve markets in place; returns rows with a real-but-unmapped branch
 * label (caller quarantines + fails the file — never silently UNASSIGNED).
 *
 * BY MARKET ONLY. Setters do not belong to markets, so the By Setter variant
 * must not reach this function at all — the caller skips it rather than this
 * function guarding against it, because a guard here would leave a `market`
 * field on setter rows for someone to read as meaningful. Passing setter rows
 * in is what put 29 lead sources into lp_sales_efficiency_history as
 * UNRESOLVED on 2026-08-11.
 */
export function resolveSalesEfficiencyMarkets(rows, maps) {
  const unmapped = [];
  for (const r of rows) {
    const res = resolveMarketFromBranch(r.branch_code_raw, maps);
    if (!res || res.market_code === 'UNASSIGNED') {
      unmapped.push(r);
      r.market = 'UNASSIGNED';
    } else {
      r.market = res.market_code;
    }
  }
  return unmapped;
}

/** Column sums over parsed rows — the control totals finalize re-asserts. */
export function computeSalesEfficiencyTotals(rows, mode = 'full') {
  const keys = ['num_issued', 'num_sat', 'num_sold', 'gsa_cents',
    'num_cancelled', 'cancelled_cents'];
  if (mode === 'full') keys.push('num_net', 'nsa_cents');
  const t = {};
  for (const k of keys) t[k] = 0;
  for (const r of rows) for (const k of keys) t[k] += r[k] ?? 0;
  return t;
}

/**
 * Fail-closed validation.
 *   empty_file / unmapped rows are handled by the caller; here:
 *   total_row_mismatch  Σ parsed rows vs the PDF Total row, per column —
 *                       exact for counts, within the display_rounding
 *                       allowance ($1 × row count) for dollars (PDF prints
 *                       whole dollars). CSV path passes no totals → skipped.
 *   expected-totals     (CSV) caller-declared golden figures, exact to the
 *                       cent — a 1¢ mismatch is a violation.
 *   future EDate        recorded as a reconciliation note, never a rejection.
 */
export function validateSalesEfficiency(parsed, { expectedTotals = null, todayIso = null } = {}) {
  const violations = [];
  const reconciliations = [];
  const { rows, mode } = parsed;
  if (mode === 'unparseable') {
    violations.push({ rule: parsed.error ?? 'unparseable', detail: 'PDF layout not recognized' });
    return { ok: false, violations, reconciliations };
  }
  if (!rows.length) violations.push({ rule: 'empty_file', detail: 'no market rows' });

  if (parsed.misaligned?.length) {
    violations.push({ rule: 'column_misaligned', detail: { tokens: parsed.misaligned.slice(0, 5) } });
  }

  if (parsed.totals) {
    for (const [k, printed] of Object.entries(parsed.totals)) {
      const sum = rows.reduce((a, r) => a + (r[k] ?? 0), 0);
      if (printed == null) continue;
      const isMoney = k.endsWith('_cents');
      const allowance = isMoney ? 100 * rows.length : 0;
      const delta = Math.abs(sum - printed);
      if (delta > allowance) {
        violations.push({ rule: 'total_row_mismatch', detail: { column: k, computed: sum, printed, allowance } });
      } else if (isMoney && delta > 0) {
        reconciliations.push({ class: 'display_rounding', scope: 'se_total', detail: { column: k, computed: sum, printed, delta_cents: delta, cap_cents: allowance } });
      }
    }
  }

  if (expectedTotals) {
    const computed = computeSalesEfficiencyTotals(rows, mode);
    for (const [key, expected] of Object.entries(expectedTotals)) {
      if (!(key in computed)) {
        violations.push({ rule: 'unknown_control_key', detail: { key } });
        continue;
      }
      if (computed[key] !== expected) {
        violations.push({ rule: 'control_total_mismatch', detail: { key, computed: computed[key], expected } });
      }
    }
  }

  const today = todayIso ?? null;
  if (today && parsed.header.periodEnd && parsed.header.periodEnd > today) {
    reconciliations.push({
      class: 'future_period_end', scope: 'header',
      detail: {
        period_end: parsed.header.periodEnd, today,
        note: 'export window extends past today — align windows before cross-report comparison; pin EDate to yesterday on the scheduled pull',
      },
    });
  }

  return { ok: violations.length === 0, violations, reconciliations };
}
