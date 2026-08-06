// ─── Marketing Sub-Source Cost Analysis 2 (report 136, PDF) ───
//   src/jobs/lp-report-parse-source-cost-pdf.js
//
// PURE. Parses the LP "Marketing Sub-Source Cost Analysis 2" PDF from
// `pdftotext -layout` text. Verified against the real 2026-08-06 emailed file
// (2 pages, 37 sub-source rows + Grand Total).
//
// THIS REPORT IS THE COMPANY CONTROL-TOTAL AUTHORITY. Its Grand Total row is
// the checksum, and it is fail-closed: a column that does not tie rejects the
// file. Report 135's own Grand Total (1,194 rows) reconciles against this
// report's Raw for the same window — verified equal on 2026-08-06.
//
// WHY -layout HERE AND NOT -bbox-layout. Report 135 needs coordinate
// clustering because continuation fragments from different columns interleave
// on one physical line. Nothing interleaves here: every data row is one line of
// fifteen right-aligned numeric cells, and a wrapped sub-source name occupies
// its own line with nothing else on it. The strict fifteen-field shape below is
// the guard — a row that does not match it is not silently reinterpreted, it
// simply is not a row, and the Grand Total then fails to tie.
//
// WHOLE DOLLARS. Unlike the CSV export, this PDF prints money with NO cents
// ($714,138, not $714,138.29). Values are stored as cents for a consistent
// domain, but the trailing two digits are always zero and this report cannot
// tie the CSV to the cent. The CSV path remains the cents-exact authority.
//
// GRAIN. Company-wide, one row per marketing sub-source, NO market dimension —
// its rows legitimately key on REECE. Sub-source names REPEAT (`Previous
// Customer` twice in the 2026-08-06 file) and two rows have a BLANK name; row
// identity is (snapshot, row_num) and every row is kept verbatim.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];

/** One numeric cell: optional $, digits/commas, optional decimals, optional %. */
const CELL = String.raw`\$?-?[\d,]+(?:\.\d+)?%?`;

/**
 * A data row: a left-aligned label, two-or-more spaces, then EXACTLY fifteen
 * numeric cells. Anything else is not a row.
 */
const ROW_RE = new RegExp(`^(.*?)\\s{2,}(${Array(15).fill(CELL).join(')\\s+(')})\\s*$`);

/** The fifteen cells, in print order. */
export const SC_PDF_FIELDS = [
  'raw', 'set', 'issued', 'issue_pct', 'demo', 'demo_pct', 'sold', 'std_pct',
  'gross_cents', 'working_cents', 'net_sales_cents', 'nsli_cents',
  'total_cost_cents', 'cost_per_lead_cents', 'mkt_pct',
];

/** Columns that are SUMS and must tie to the printed Grand Total. */
export const SC_PDF_SUM_FIELDS = ['raw', 'set', 'issued', 'demo', 'sold',
  'gross_cents', 'working_cents', 'net_sales_cents', 'total_cost_cents'];

/** Columns that are RATIOS — derived per row, never summed. */
const RATIO_FIELDS = new Set(['issue_pct', 'demo_pct', 'std_pct', 'mkt_pct',
  'nsli_cents', 'cost_per_lead_cents']);

const isFurniture = (t) => (
  /^Marketing Sub-Source Cost Analysis/i.test(t)
  || /^For the Period\b/i.test(t)
  || /^Source:\s*ALL/i.test(t)
  || /^Sort By:/i.test(t)
  || /\bPage\s+\d+\s+of\s+\d+\b/i.test(t)
  || /^\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)\b/i.test(t)
);

/** The two column-header lines, matched on their stable anchor words. */
const isColumnHeader = (t) => (
  /^%\s+#\s+%\s+#\b/.test(t)
  || (/\bRaw\b/.test(t) && /\bSet\b/.test(t) && /\bSTD\s*%/.test(t) && /\bGross\s*\$/.test(t))
);

const isGrandTotal = (label) => /^grand\s+total:?$/i.test(String(label ?? '').trim());

/** `$714,138` / `1,194` / `17.7%` → integer. Money and percent scale by 100. */
export function parseCell(raw, field) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  const neg = t.startsWith('-') || /^\(.*\)$/.test(t);
  const digits = t.replace(/[^0-9.]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  const scaled = /_cents$/.test(field) || /_pct$/.test(field)
    ? Math.round(n * 100)
    : Math.round(n);
  return neg ? -scaled : scaled;
}

/** `For the Period Saturday, August 1, 2026 through Monday, August 31, 2026`. */
export function parsePeriodLine(text) {
  const re = /([A-Z][a-z]+)\s+(\d{1,2}),\s*(\d{4})/g;
  const hits = [];
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const mi = MONTHS.indexOf(m[1].toLowerCase());
    if (mi < 0) continue;
    hits.push(`${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`);
  }
  return { periodStart: hits[0] ?? null, periodEnd: hits[1] ?? null };
}

/** `8/6/2026 7:00AM` → ISO date (report is generated in ET). */
function parseGeneratedDate(text) {
  const m = String(text ?? '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+\d{1,2}:\d{2}\s*(?:AM|PM)/i);
  if (!m) return null;
  return `${m[3]}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/**
 * Parse the 136 PDF.
 *
 * @returns {{ rows:object[], header:{periodStart,periodEnd,asOf,scope},
 *             printedTotals:object|null, error?:string }}
 */
export function parseSourceCostPdf(text) {
  const lines = String(text ?? '').split('\n');
  const periodLine = lines.find((l) => /^\s*For the Period\b/i.test(l));
  const { periodStart, periodEnd } = parsePeriodLine(periodLine);
  const stampLine = lines.find((l) => parseGeneratedDate(l));
  const asOf = parseGeneratedDate(stampLine);

  const rows = [];
  let printedTotals = null;
  let current = null;

  for (const line of lines) {
    const t = line.trimEnd();
    if (!t.trim()) continue;
    if (isFurniture(t.trim()) || isColumnHeader(t.trim())) { current = null; continue; }

    const m = t.match(ROW_RE);
    if (!m) {
      // A line with no numeric tail continues the PREVIOUS row's sub-source
      // name — LP wraps long ones (`Website Estimate` / `Calculator`,
      // `Fort Myers Beat the` / `Heat Indoor Craft` / `Festival`).
      if (current && !isGrandTotal(current.sub_source)) {
        current.sub_source = `${current.sub_source ?? ''} ${t.trim()}`.trim();
      }
      continue;
    }

    const label = m[1].trim();
    const cells = {};
    SC_PDF_FIELDS.forEach((f, i) => { cells[f] = parseCell(m[i + 2], f); });

    if (isGrandTotal(label)) { printedTotals = cells; current = null; continue; }

    // Blank sub-source names are real rows and LP counts them — keep verbatim.
    current = { row_num: rows.length + 1, sub_source: label || null, ...cells };
    rows.push(current);
  }

  // Scope: a period end in the future means the window is still open.
  const scope = periodEnd && asOf && periodEnd > asOf ? 'mtd' : 'custom';
  return { rows, header: { periodStart, periodEnd, asOf, scope }, printedTotals };
}

/** Column sums over the SUM fields. Ratios are never summed. */
export function computeSourceCostPdfTotals(rows) {
  const out = {};
  for (const f of SC_PDF_SUM_FIELDS) {
    out[f] = rows.reduce((a, r) => a + (r[f] ?? 0), 0);
  }
  return out;
}

/**
 * FAIL-CLOSED on the Grand Total. This report is the control-total authority,
 * so a column that does not tie rejects the file — there is no display-rounding
 * allowance, because every printed value is already a whole dollar and the sums
 * are of whole dollars.
 *
 * The per-row percentages are RECONCILED, not gated: they are LP's own rounded
 * renderings of ratios we can recompute, so a 0.1pt difference is display
 * rounding and not a data problem.
 */
export function validateSourceCostPdf(parsed) {
  const violations = [];
  const reconciliations = [];

  if (parsed.error) {
    violations.push({ rule: parsed.error, detail: parsed.detail ?? {} });
    return { ok: false, violations, reconciliations };
  }
  if (!parsed.rows.length) violations.push({ rule: 'no_detail_rows', detail: { rows: 0 } });
  if (!parsed.header.periodStart || !parsed.header.periodEnd) {
    violations.push({ rule: 'missing_period', detail: { header: parsed.header } });
  }
  if (!parsed.printedTotals) {
    violations.push({ rule: 'missing_grand_total', detail: { expected: 'Grand Total: row' } });
    return { ok: violations.length === 0, violations, reconciliations };
  }

  const computed = computeSourceCostPdfTotals(parsed.rows);
  for (const f of SC_PDF_SUM_FIELDS) {
    const printed = parsed.printedTotals[f] ?? 0;
    if (computed[f] !== printed) {
      violations.push({
        rule: 'grand_total_mismatch',
        detail: { column: f, printed, computed: computed[f], delta: computed[f] - printed, rows: parsed.rows.length },
      });
    }
  }

  // Ratio cross-check (advisory). Issue% = issued/raw, Demo% = demo/issued,
  // STD% = sold/demo — each stored x100, so compare in the same domain.
  const near = (a, b, tol) => a == null || b == null || Math.abs(a - b) <= tol;
  for (const r of parsed.rows) {
    const checks = [
      ['issue_pct', r.raw ? Math.round((r.issued / r.raw) * 10000) : null],
      ['demo_pct', r.issued ? Math.round((r.demo / r.issued) * 10000) : null],
      ['std_pct', r.demo ? Math.round((r.sold / r.demo) * 10000) : null],
    ];
    for (const [field, expected] of checks) {
      if (expected == null || r[field] == null) continue;
      if (!near(r[field], expected, 10)) {
        reconciliations.push({
          class: 'ratio_drift', scope: field,
          detail: { sub_source: r.sub_source, row_num: r.row_num, printed: r[field], recomputed: expected },
        });
      }
    }
  }

  return { ok: violations.length === 0, violations, reconciliations };
}

/**
 * Cross-report reconciliation against report 135 (log only, NEVER a gate).
 *
 * 135's Grand Total row count and 136's Raw count the same population for the
 * same window — 1,194 both sides on 2026-08-06. Do NOT attempt to tie 135's
 * disposition counts to 136's Set/Issue/Demo/Sold: 135's Current Dispo is a
 * POINT-IN-TIME STATE and 136's funnel columns are CUMULATIVE COUNTERS. A lead
 * currently sitting at `Sale` was also Set and Issued, so counting dispo='Set'
 * in 135 can never equal Set in 136. Any code gating on that equality is wrong.
 */
export function reconcileWithLeadDisposition({ sourceCostRaw, leadDispositionRows }) {
  if (sourceCostRaw == null || leadDispositionRows == null) return null;
  return {
    class: 'cross_report',
    scope: 'raw_vs_lead_rows',
    detail: {
      source_cost_raw: sourceCostRaw,
      lead_disposition_rows: leadDispositionRows,
      delta: leadDispositionRows - sourceCostRaw,
      tied: leadDispositionRows === sourceCostRaw,
    },
  };
}
