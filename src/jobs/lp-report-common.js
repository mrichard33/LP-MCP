// ─── LP scheduled-report shared helpers — src/jobs/lp-report-common.js ───
//
// Pure helpers shared by the two LP report parsers (lp-report-parse-a.js /
// lp-report-parse-b.js) and the ingest orchestrator (lp-report-ingest.js).
// No I/O here except resolveRowMarket's delegate, which is pure given a
// preloaded branch map — everything is unit-testable without env.
//
// MONEY IS CENTS. Every dollar figure parsed from a PDF becomes an integer
// cent count (bigint in the DB). Ties are asserted to the cent; float math
// never touches report money.

import { createHash } from 'node:crypto';
import { resolveMarketFromBranch } from './market-resolver.js';

/**
 * Parse a report money string to integer CENTS.
 *   '1,158,424.00' → 115842400   '(1,234.56)' / '-1,234.56' → -123456
 *   '$0.00' → 0                  '' / '-' / garbage → null
 * @returns {number|null}
 */
export function parseMoneyCents(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s === '-') return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  s = s.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  return negative ? -cents : cents;
}

/** Format integer cents as a plain dollar string for logs/alerts ('-12.34'). */
export function centsToDollars(cents) {
  if (cents == null) return null;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Parse an LP report date ('M/D/YYYY' or 'MM/DD/YYYY') to ISO 'YYYY-MM-DD'.
 * @returns {string|null}
 */
export function parseDateMDY(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  const mm = Number(mo), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

const MONTH_NAMES = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Parse a long-form report date to ISO 'YYYY-MM-DD'. LP's scheduled runs
 * print the period as prose ('from Monday, August 3, 2026 through …'), not
 * M/D/YYYY — verified against the first production email (2026-08-04).
 *   'Monday, August 3, 2026' / 'August 3, 2026' → '2026-08-03'
 * @returns {string|null}
 */
export function parseDateLong(raw) {
  const m = String(raw ?? '').trim().match(/^(?:[A-Za-z]+,\s*)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const mo = MONTH_NAMES[m[1].toLowerCase()];
  const dd = Number(m[2]);
  if (!mo || dd < 1 || dd > 31) return null;
  return `${m[3]}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

/** M/D/YYYY or long-form, trailing punctuation tolerated. */
export function parseDateAny(raw) {
  const s = String(raw ?? '').trim().replace(/[.,;]$/, '');
  return parseDateMDY(s) ?? parseDateLong(s);
}

/** SHA-256 hex digest of a Buffer (the raw-PDF idempotency key). */
export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Resolve a report row's branch code to a market via lp_branch_market_map
 * (branch is authoritative for revenue — same resolution the Net Report
 * ties 1,710/1,710 with). Returns null for empty/unmapped branches — the
 * ingest orchestrator QUARANTINES those rows and fails the file closed;
 * an unmapped branch must never silently become UNASSIGNED revenue.
 * @param {string} branchRaw  verbatim branch cell (LP pads with spaces)
 * @param {Map<string,string>} branchMap  brn_id(upper,trimmed) → market_code
 * @returns {string|null}
 */
export function resolveRowMarket(branchRaw, branchMap) {
  const res = resolveMarketFromBranch(branchRaw, { branchMap });
  if (!res || res.market_code === 'UNASSIGNED') return null;
  return res.market_code;
}

/** Today's ET calendar date as YYYY-MM-DD (report archive paths, watchdog). */
export function todayET(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/** Current ET hour (0-23) — scheduler gates. */
export function hourET(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }).formatToParts(d);
  return Number(parts.find((p) => p.type === 'hour')?.value ?? -1);
}
