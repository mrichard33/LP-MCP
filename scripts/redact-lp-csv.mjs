#!/usr/bin/env node
// ─── LP CSV fixture redactor — scripts/redact-lp-csv.mjs ───
//
// Turns a raw LP CSV export into a committable fixture. Raw exports are NEVER
// committed; this is how the files under scripts/fixtures/lp-reports/ are made.
//
//   node scripts/redact-lp-csv.mjs <in.csv> <out.csv> [--slice N]
//
// The report is identified by its HEADER FINGERPRINT, the same way the ingest
// router identifies it — never by filename, so a renamed export cannot be
// redacted against the wrong column list.
//
// ══ THE RULE ══
// Mask GLYPHS, never STRUCTURE. Row count, column count and order, embedded
// newlines inside quoted fields, and EVERY NUMERIC VALUE survive untouched —
// those are what the goldens assert. An earlier pass on the bbox fixtures that
// ignored this turned `BOCA` into `Bxxx` and `49` into `55`.
//
// Employee names STAY: `Salesrep` (138), `SalesRepName` / `Manager` (134) and
// `EmpName` (136) are not customer PII and rep-level goldens depend on them.
// Only the report RUNNER (`FullName` / `fullname`) is replaced, matching the
// committed fixtures' 'Dana Whitfield' / 'dwhitfield'.
//
// --slice N keeps only the first N data rows (135 is 5.3 MB and 12,444 rows,
// far past this directory's norm — commit a slice, not the whole file).

import { readFileSync, writeFileSync } from 'node:fs';

import { parseCsv, detectReportFromHeader } from '../src/jobs/lp-report-csv-common.js';

const RUNNER_FULL = 'Dana Whitfield';
const RUNNER_USER = 'dwhitfield';

/**
 * Per-report PII treatment, keyed by the reportType the fingerprint resolves to.
 * Column names are matched case-insensitively, as everywhere else in this path.
 *
 *   name    'Surname000, Given000'   (133's custname is one combined cell)
 *   surname / given                  (135 splits them)
 *   phone   '(555)555-0000'
 *   email   'person000@example.com'
 *   street  '000 Example St'
 *   city    stable synthetic per distinct value — repeated cities stay repeated
 *   text    free text: letters masked, DIGITS AND NEWLINES PRESERVED
 *   runner  the report runner
 */
const PII = {
  job_status_ytd: {
    custname: 'name', Phone: 'phone', Email: 'email', city: 'city',
    MostRecentNoteHOA: 'text', fullname: 'runner',
  },
  jobs_by_milestone: {
    CustName: 'name', address1: 'street', city: 'city', FullName: 'runner',
  },
  lead_disposition: {
    lastname: 'surname', FirstName: 'given', Phone: 'phone', Address1: 'street',
    city: 'city', CSZ: 'csz', Email: 'email', FullName: 'runner',
  },
  source_cost: { EmpName: 'runner_user', FullName: 'runner' },
  sales_efficiency: { FullName: 'runner' },
  appt_stats_by_rep_source: { FullName: 'runner' },
};

const pad = (n) => String(n).padStart(4, '0');

/** Mask letters, keep digits, punctuation, whitespace AND newlines verbatim. */
function maskText(v) {
  return v.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? 'X' : 'x'));
}

function redact(text, { slice = null } = {}) {
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('empty CSV');
  const header = rows[0].map((h) => h.trim());
  const { reportType, lpReportId } = detectReportFromHeader(header);
  const rules = PII[reportType];
  if (!rules) throw new Error(`no redaction rules for ${reportType}`);

  // Resolve the rule map onto this file's actual header casing.
  const byLower = new Map(header.map((h, i) => [h.toLowerCase(), i]));
  const plan = new Map();                       // column index → treatment
  for (const [col, kind] of Object.entries(rules)) {
    const i = byLower.get(col.toLowerCase());
    if (i !== undefined) plan.set(i, kind);
  }

  let body = rows.slice(1).filter((r) => !(r.length === 1 && r[0] === ''));
  if (slice) body = body.slice(0, slice);

  const cities = new Map();
  const out = body.map((cells, n) => cells.map((v, i) => {
    const kind = plan.get(i);
    if (kind === undefined || v === '') return v;   // empty stays empty
    switch (kind) {
      case 'name': return `Surname${pad(n)}, Given${pad(n)}`;
      case 'surname': return `Surname${pad(n)}`;
      case 'given': return `Given${pad(n)}`;
      case 'phone': return `(555)555-${pad(n).slice(-4)}`;
      case 'email': return `person${pad(n)}@example.com`;
      case 'street': return `${100 + (n % 900)} Example St`;
      case 'city': {
        if (!cities.has(v)) cities.set(v, `City${pad(cities.size)}`);
        return cities.get(v);
      }
      // 'Titusville, FL  32796' — mask the town, keep state and ZIP (numeric).
      case 'csz': return v.replace(/^[^,]+/, (t) => {
        if (!cities.has(t)) cities.set(t, `City${pad(cities.size)}`);
        return cities.get(t);
      });
      case 'text': return maskText(v);
      case 'runner': return RUNNER_FULL;
      case 'runner_user': return RUNNER_USER;
      default: return v;
    }
  }));

  return { csv: emit([header, ...out]), reportType, lpReportId, records: out.length };
}

/** RFC-4180 emitter. CRLF, and every cell quoted — matching what LP ships. */
function emit(rows) {
  return `${rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n')}\r\n`;
}

const [, , inPath, outPath, ...rest] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: node scripts/redact-lp-csv.mjs <in.csv> <out.csv> [--slice N]');
  process.exit(1);
}
const sliceArg = rest.indexOf('--slice');
const slice = sliceArg >= 0 ? Number(rest[sliceArg + 1]) : null;

const res = redact(readFileSync(inPath, 'utf8'), { slice });
writeFileSync(outPath, res.csv);
console.log(`${inPath} → ${outPath}\n  report ${res.lpReportId} (${res.reportType}), ${res.records} records`);
