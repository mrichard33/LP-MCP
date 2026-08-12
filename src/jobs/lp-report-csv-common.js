// ─── LP CSV export shared helpers — src/jobs/lp-report-csv-common.js ───
//
// Pure helpers shared by the three LP CSV export parsers
// (lp-report-parse-job-status.js / lp-report-parse-lead-disposition.js /
// lp-report-parse-source-cost.js) and by scorecard-rtp-source.js (the Net
// Report CSV path, where parseCsv originally lived). No I/O — everything
// unit-testable without env.
//
// MONEY IS CENTS — money parsing stays in lp-report-common.js
// (parseMoneyCents); this module owns CSV structure and CSV-specific dates.

/**
 * Minimal RFC-4180-ish CSV parser (handles quoted fields, embedded commas,
 * "" escapes, and NEWLINES INSIDE QUOTED FIELDS).
 *
 * That last one is not decoration. Report 133 prints free-text HOA notes in
 * `MostRecentNoteHOA`, and those notes contain literal newlines — a sample file
 * is 74 physical lines and 48 records. Anything that splits on \n silently
 * corrupts it, so record count and line count are deliberately allowed to
 * differ and a regression test pins that.
 *
 * A leading UTF-8 BOM is stripped explicitly. It previously survived only
 * because csvToObjects trims header cells and JS happens to treat U+FEFF as
 * whitespace — an accident, not a contract, and it would have contaminated the
 * first header name anywhere the trim was skipped.
 *
 * CRLF inside a quoted field is normalized to LF so the same logical note
 * hashes identically regardless of the line endings LP emitted.
 */
export function parseCsv(text) {
  const src = typeof text === 'string' && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else if (c === '\r') {
        if (src[i + 1] === '\n') i++;            // CRLF inside a quote → LF
        field += '\n';
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Parse a CSV export into header-keyed row objects.
 * Fully-empty trailing rows are dropped; every other row is kept verbatim.
 * @param {string} text
 * @param {string[]} requiredColumns  throws (fail closed) when any is absent
 * @returns {{ header: string[], rows: Array<Record<string,string>> }}
 */
export function csvToObjects(text, requiredColumns = []) {
  const raw = parseCsv(text);
  if (!raw.length) throw new Error('empty CSV');
  const header = raw[0].map((h) => h.trim());
  const missing = requiredColumns.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new Error(`CSV missing required columns (${missing.join(', ')})`);
  }
  const rows = [];
  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i];
    if (!cells || cells.every((c) => !String(c ?? '').trim())) continue;
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = cells[j] ?? '';
    rows.push(obj);
  }
  return { header, rows };
}

/**
 * Case-insensitive column reader.
 *
 * The older parsers index rows by exact header name, which is safe for reports
 * whose headers we have seen across many months. detectReportFromHeader already
 * matches case-insensitively, so a file that ROUTES to a parser could still
 * fail inside it purely on casing — a parser must not be stricter than the
 * router that dispatched to it. 138 established this; 133 adopted it when its
 * export changed shape underneath the parser.
 *
 * @param {string[]} header
 * @returns {(row: Record<string,string>, name: string) => (string|undefined)}
 */
export function columnReader(header) {
  const byLower = new Map();
  for (const h of header) byLower.set(String(h).trim().toLowerCase(), h);
  return (row, name) => {
    const key = byLower.get(String(name).toLowerCase());
    return key === undefined ? undefined : row[key];
  };
}

/**
 * Fail a file closed on a MISSING required column, comparing case-insensitively.
 * The companion to columnReader: csvToObjects' own check is case-SENSITIVE, so
 * parsers that read case-insensitively must call csvToObjects(text) with no
 * required list and come through here instead.
 *
 * Throws the same message shape csvToObjects throws, so the ingest gate's
 * `csv_shape_unrecognized` path is unchanged.
 *
 * @param {string[]} header
 * @param {string[]} required
 */
export function assertRequiredColumns(header, required) {
  const present = new Set(header.map((h) => String(h).trim().toLowerCase()));
  const missing = required.filter((c) => !present.has(String(c).toLowerCase()));
  if (missing.length) {
    throw new Error(`CSV missing required columns (${missing.join(', ')})`);
  }
}

/**
 * Parse an LP CSV date-or-datetime cell to ISO 'YYYY-MM-DD'. The exports
 * print plain 'M/D/YYYY' for most dates but 'M/D/YYYY HH:MM' for
 * appointment slots and report timestamps — the time part is dropped.
 *
 * TWO-DIGIT YEARS ARE REJECTED here (they return null), which is deliberate for
 * the header/period columns this was written for. Detail columns that print
 * 'MM/DD/YY' — report 133's ContractDate — must use parseDateMDY from
 * lp-report-common.js instead, or every row silently loses its date.
 *
 * @returns {string|null}
 */
export function parseCsvDate(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?$/i);
  if (!m) return null;
  const mm = Number(m[1]), dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${m[3]}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/**
 * Parse an LP CSV datetime cell ('8/6/2026 6:00:01 PM') to a UTC instant,
 * KEEPING THE TIME. parseCsvDate above deliberately drops it; this does not.
 *
 * WHY BOTH EXIST. `CurrentDateTime` is the only signal of how much of a period
 * a file actually covers, so truncating it to a date destroys the one thing
 * that distinguishes the 6:00 AM pull from the 6:00 PM one. Every current 134
 * snapshot landed as date-only midnight for exactly this reason.
 *
 * LP prints wall-clock with no zone; the reports are generated in the company's
 * timezone, so the string is read as America/New_York and stored as UTC. The
 * offset is resolved by asking Intl what ET showed at a candidate instant and
 * correcting — two passes settle every case except the ambiguous hour at
 * fall-back DST, where either reading is defensible.
 *
 * @param {*} raw
 * @returns {{iso: string, hadTime: boolean, isMidnight: boolean}|null}
 */
export function parseCsvDateTimeET(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = s.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?)?$/i,
  );
  if (!m) return null;
  const [, mo, da, yr, hh, mi, ss, ampm] = m;
  const month = Number(mo), day = Number(da);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const hadTime = hh !== undefined;
  let hour = hadTime ? Number(hh) : 0;
  const minute = hadTime ? Number(mi) : 0;
  const second = hadTime && ss !== undefined ? Number(ss) : 0;
  if (ampm) {
    const pm = ampm.toUpperCase() === 'PM';
    if (hour < 1 || hour > 12) return null;
    hour = pm ? (hour === 12 ? 12 : hour + 12) : (hour === 12 ? 0 : hour);
  } else if (hour > 23) return null;
  if (minute > 59 || second > 59) return null;

  // Treat the wall clock as UTC, then subtract whatever offset ET was actually
  // running at that moment.
  const wall = Date.UTC(Number(yr), month - 1, day, hour, minute, second);
  let utc = wall - etOffsetMs(wall);
  utc = wall - etOffsetMs(utc);

  return {
    iso: new Date(utc).toISOString(),
    hadTime,
    isMidnight: hour === 0 && minute === 0 && second === 0,
  };
}

/** Offset (ms) that America/New_York was running at a given UTC instant. */
function etOffsetMs(utcMs) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUtc - utcMs;
}

/**
 * Parse an integer count cell ('12,257' / '0' / '' → 12257 / 0 / null).
 * Garbage returns null, never 0 — same doctrine as parseMoneyCents.
 * @returns {number|null}
 */
export function parseCount(raw) {
  const s = String(raw ?? '').trim().replace(/,/g, '');
  if (!s) return null;
  if (!/^-?\d+$/.test(s)) return null;
  return Number(s);
}

// ─── Header fingerprint routing (§C) ────────────────────────────────────────
//
// CSV attachments are ALL named `_<YYMMDDHHMMSS>_Export.csv`, so the LP report
// ID that the PDF filenames carried (`_134_`) is simply gone. Routing moves to
// the one thing the file still asserts about itself: its header row.
//
// Each entry lists DISCRIMINATORS — columns whose combined presence is unique
// to that report. All of them must be present, and exactly one report may
// match; zero or two is `unknown_report_fingerprint` and the file is rejected
// rather than guessed at. Matching is case- and order-insensitive because LP's
// header casing is not stable across reports (the live 137 export emits
// `xBrn_id` where 136 emits lowercase echoes).

export const REPORT_FINGERPRINTS = [
  // 133 resolves to job_status_ytd, NOT jobs_by_status. Those are two distinct
  // report types over the same LP report: the CSV lands in
  // lp_job_status_history as job_status_ytd (where the existing 940-row YTD
  // snapshot lives), while jobs_by_status is the legacy PDF type writing to
  // scorecard_report_rows_b. Resolving to the PDF type would dispatch the CSV
  // into a branch that cannot load it.
  { reportType: 'job_status_ytd', lpReportId: '133',
    discriminators: ['id', 'District', 'Market', 'custname', 'Status', 'MostRecentNoteHOA'] },
  { reportType: 'jobs_by_milestone', lpReportId: '134',
    discriminators: ['contractid', 'MilestoneDate', 'NetAmount', 'GrossAmount', 'brp_id', 'MdtDescr'] },
  { reportType: 'lead_disposition', lpReportId: '135',
    discriminators: ['Category', 'lastresult', 'dspdescr', 'NumDials', 'sds_id', 'PromoterName'] },
  { reportType: 'source_cost', lpReportId: '136',
    discriminators: ['descr', 'NumRaw', 'NumSet', 'NumCnf', 'MCost', 'WorkingAmount'] },
  { reportType: 'sales_efficiency', lpReportId: '137',
    discriminators: ['Grouper', 'NumIssued', 'NSLI', 'ClosingPct', 'NumJSC1', 'jbs1'] },
  // 138 is the canonical Reece-series id. LP also exposes this report as
  // ReportView `Rpt=229` — that number is only for building an on-demand URL
  // and is deliberately absent from slugs, tables and logs. (Same two-series
  // arrangement as 134, which is `Rpt=140`.)
  //
  // 137 and 138 both count issued appointments, so the sets were checked
  // against the real headers rather than assumed: 137's discriminators hit
  // only `NumIssued` on a 138 header, 136's hit only `NumSet`, and 138's hit
  // exactly one column on any other report. test-lp-csv-cutover.js asserts
  // that disjointness in both directions.
  { reportType: 'appt_stats_by_rep_source', lpReportId: '138',
    discriminators: ['Salesrep', 'Src_id', 'NumNetIssued', 'NumDsp1', 'Dsp1', 'Footer'] },
];

/**
 * Resolve a report type from a CSV header row.
 * @param {string[]} header
 * @returns {{reportType: string, lpReportId: string}}
 * @throws {Error} 'unknown_report_fingerprint' on zero or ambiguous matches
 */
export function detectReportFromHeader(header) {
  const present = new Set((header ?? []).map((h) => String(h ?? '').trim().toLowerCase()));
  const matches = REPORT_FINGERPRINTS.filter(
    (f) => f.discriminators.every((d) => present.has(d.toLowerCase())),
  );
  if (matches.length !== 1) {
    const err = new Error('unknown_report_fingerprint');
    err.failureReason = 'unknown_report_fingerprint';
    err.detail = { matched: matches.map((m) => m.reportType), header_columns: header?.length ?? 0 };
    throw err;
  }
  return { reportType: matches[0].reportType, lpReportId: matches[0].lpReportId };
}

// ─── Variant routing (§C.2) ─────────────────────────────────────────────────
//
// Some LP reports emit BYTE-IDENTICAL headers for what are semantically
// different reports. 137 is the case: "By Market", "By Setter" and "By Source"
// are the same report re-grouped, so `Grouper` holds a branch code on one, a
// setter name on the next and a lead source on the third — and the header row
// cannot tell them apart. detectReportFromHeader is therefore necessary but not
// sufficient, and is deliberately left alone: it answers "which report", and
// this answers "which grouping of it".
//
// The discriminator is `xGrouper`, one of LP's echo columns — a DATA column,
// present on every row, absent from the header. Resolution has to read row 1.
//
// Left unrouted, a By Setter file lands in lp_sales_efficiency_history with
// setter names in branch_code_raw, and — because content identity is keyed on
// report_type — can take `is_current` from the By Market snapshot the Scorecard
// reads. That is a market-level revenue number silently becoming a setter-level
// one. This already happened once: the By Source export ingested 2026-08-11 put
// 29 rows of lead sources (Bing PPC, HomeBuddy, Modernize …) into the market
// table, every one of them UNRESOLVED.

export const REPORT_VARIANTS = {
  sales_efficiency: {
    column: 'xGrouper',
    map: {
      'by market': 'sales_efficiency',
      'by setter': 'sales_efficiency_by_setter',
    },
    // Recognised, deliberately NOT stored. These files are archived and logged
    // and nothing more — no rows, no alert. Keeping this list explicit is what
    // lets the unknown-variant alert stay loud: an operator who sees one is
    // seeing a grouping nobody has decided about yet, not a Tuesday.
    knownUnstored: ['by source'],
  },
};

/** Normalised form for variant comparison — LP's echo casing is not stable. */
const variantKey = (raw) => String(raw ?? '').trim().toLowerCase();

/**
 * Resolve a report VARIANT from the first data row, for reports whose header
 * fingerprint is identical across groupings.
 *
 * Fails CLOSED. An unrecognised value throws rather than defaulting to the
 * market variant, because defaulting is precisely what writes setter names into
 * branch_code_raw. Note this is a different question from §F's
 * UNRESOLVED-not-rejected doctrine for unknown BRANCH codes: an unmapped branch
 * is a mapping gap inside a file we understand, while an unmapped variant means
 * we do not know what the file IS, and there is no safe table to put it in.
 *
 * Reports absent from REPORT_VARIANTS pass through untouched — the other five
 * have no xGrouper and must not start failing.
 *
 * @param {string} reportType  as returned by detectReportFromHeader
 * @param {string[]} header    row 0
 * @param {string[]} firstDataRow  row 1 — the echo columns repeat on every row
 * @returns {{reportType: string, variant: string|null, knownUnstored: boolean}}
 * @throws {Error} 'unknown_report_variant' when the column is missing or unmapped
 */
export function resolveVariant(reportType, header, firstDataRow) {
  const spec = REPORT_VARIANTS[reportType];
  if (!spec) return { reportType, variant: null, knownUnstored: false };

  const idx = (header ?? []).findIndex(
    (h) => variantKey(h) === variantKey(spec.column),
  );
  const raw = idx === -1 ? undefined : firstDataRow?.[idx];
  const value = variantKey(raw);

  const fail = (detail) => {
    const err = new Error('unknown_report_variant');
    err.failureReason = 'unknown_report_variant';
    err.detail = { report_type: reportType, column: spec.column, ...detail };
    throw err;
  };

  if (idx === -1) fail({ reason: 'column_absent', header_columns: header?.length ?? 0 });
  if (!value) fail({ reason: 'value_empty' });

  const mapped = spec.map[value];
  if (mapped) return { reportType: mapped, variant: value, knownUnstored: false };

  if ((spec.knownUnstored ?? []).includes(value)) {
    return { reportType, variant: value, knownUnstored: true };
  }

  return fail({ reason: 'value_unmapped', value, known: Object.keys(spec.map) });
}

/**
 * Row sort keys per report — the business key that makes content identity
 * independent of LP's sort-order parameters (§E).
 *
 * ⚠ THESE ARE MATCHED AGAINST THE ROWS contentSha256 IS ACTUALLY GIVEN, and
 * ingestCsv hands it the PARSED rows, not the raw header-keyed ones. A key that
 * names a raw CSV column therefore matches no field, `sortKeys` finds nothing to
 * sort on, and the report is hashed in file order.
 *
 * The five entries below marked (inert) are in exactly that state: they name raw
 * header columns (`id`, `contractid`, `descr`, `Grouper`) while the parsed rows
 * carry `cst_id`, `job_number`, `sub_source`, `branch_code_raw`. Their sorting
 * has never taken effect, so LP flipping `xSortBy` on one of those reports would
 * fork its content hash today. The §E test in test-lp-csv-cutover.js passes
 * because it feeds csvToObjects output — raw rows — rather than parser output.
 *
 * NOT repaired here, deliberately: correcting the five would change the digest
 * of every existing snapshot, so the next ingest of any period would read as new
 * content and supersede a perfectly good row. That is a migration with a blast
 * radius, not a one-line fix, and it wants its own change.
 *
 * 138 is new and has no history to disturb, so its key names parsed fields and
 * actually sorts.
 */
export const CONTENT_SORT_KEYS = {
  job_status_ytd: ['id'],            // (inert — parsed rows carry cst_id)
  jobs_by_milestone: ['contractid'], // (inert — parsed rows carry job_number)
  lead_disposition: ['id'],          // (inert — parsed rows carry lp_lead_id)
  source_cost: ['descr'],            // (inert — parsed rows carry sub_source)
  sales_efficiency: ['Grouper'],     // (inert — parsed rows carry branch_code_raw)
  // 138's grain is one row per (rep, source); neither column alone is unique.
  appt_stats_by_rep_source: ['salesrep_raw', 'src_id_raw'],
  // Like 138 and unlike the five above: new, no history to disturb, and named
  // for the field the PARSER emits — so this one actually sorts.
  sales_efficiency_by_setter: ['setter_name_raw'],
};
