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

/** Minimal RFC-4180-ish CSV parser (handles quoted fields, embedded commas, "" escapes). */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
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
 * Parse an LP CSV date-or-datetime cell to ISO 'YYYY-MM-DD'. The exports
 * print plain 'M/D/YYYY' for most dates but 'M/D/YYYY HH:MM' for
 * appointment slots and report timestamps — the time part is dropped.
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
