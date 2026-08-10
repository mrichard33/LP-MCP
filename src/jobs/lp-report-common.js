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
 * Parse a report money string to integer CENTS, reporting sub-cent precision.
 *
 * TWO SCALES, ONE PARSER. A report PDF prints money at two decimals and nothing
 * else, so a third decimal there is corruption and must read as null (see
 * parseMoneyCents). LP's CSV exports print the SAME column as a bare integer on
 * one row and a four-decimal string ('0.0000', '23060059.1500') on the next —
 * legitimate, and rejecting it would silently null out real money. So scale
 * tolerance is opt-in per call site, never global.
 *
 * Rounding is half-even on the magnitude and the arithmetic is string/integer
 * throughout — float never touches report money (see the file header).
 * `subCent` is true when digits past the cent were discarded, so the caller can
 * raise `sub_cent_precision_loss` rather than quietly absorbing the remainder.
 *
 * @param {*} raw
 * @param {{allowSubCent?: boolean}} [opts]  allowSubCent: accept >2 decimals
 * @returns {{cents: number, subCent: boolean}|null}
 */
export function parseMoneyCentsExact(raw, { allowSubCent = false } = {}) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s || s === '-') return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) { negative = true; s = s.slice(1, -1); }
  if (s.startsWith('-')) { negative = true; s = s.slice(1); }
  s = s.replace(/[$,\s]/g, '');
  if (!(allowSubCent ? /^\d+(\.\d+)?$/ : /^\d+(\.\d{1,2})?$/).test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  let cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  const rest = frac.slice(2);
  const subCent = /[1-9]/.test(rest);
  if (subCent) {
    // Half-even: '…5' exactly ties to the even cent; anything past it rounds up.
    const roundUp = rest[0] > '5' ? true
      : rest[0] < '5' ? false
        : (/[1-9]/.test(rest.slice(1)) || cents % 2 === 1);
    if (roundUp) cents += 1;
  }
  return { cents: negative ? -cents : cents, subCent };
}

/**
 * Parse a report money string to integer CENTS.
 *   '1,158,424.00' → 115842400   '(1,234.56)' / '-1,234.56' → -123456
 *   '$0.00' → 0                  '' / '-' / garbage → null
 * Strict two-decimal scale — '12.345' is corruption, not money. CSV callers
 * that must tolerate LP's four-decimal columns use parseCsvMoneyCents.
 * @returns {number|null}
 */
export function parseMoneyCents(raw) {
  return parseMoneyCentsExact(raw)?.cents ?? null;
}

/**
 * Parse an LP CSV money cell to integer CENTS, tolerating LP's four-decimal
 * scale. Returns {cents, subCent} so the ingest gate can flag
 * `sub_cent_precision_loss` (§F) instead of losing the remainder in silence.
 * @returns {{cents: number, subCent: boolean}|null}
 */
export function parseCsvMoneyCents(raw) {
  return parseMoneyCentsExact(raw, { allowSubCent: true });
}

/** Format integer cents as a plain dollar string for logs/alerts ('-12.34'). */
export function centsToDollars(cents) {
  if (cents == null) return null;
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Parse an LP report date to ISO 'YYYY-MM-DD'. Detail rows print 2-digit
 * years ('05/16/26' — verified against the first production PDF, 2026-08-04);
 * header/footer lines print 4-digit. Two-digit years land in 2000–2069 —
 * LP has no pre-2000 report data.
 * @returns {string|null}
 */
export function parseDateMDY(raw) {
  const m = String(raw ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const [, mo, d, y] = m;
  const mm = Number(mo), dd = Number(d);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const yyyy = y.length === 4 ? y : String(Number(y) < 70 ? 2000 + Number(y) : 1900 + Number(y));
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
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
 * Is this a Postgres unique violation (23505)?
 *
 * A duplicate is a BENIGN outcome, not a failure: the report already landed and
 * the second copy has nothing to add. It became a 500 only because nothing
 * caught the raise, and n8n replays on 5xx — which is how one file turned into
 * `duplicate ×3 → success ×1 → finalize_assertion ×2 → 500`.
 *
 * Test the error BEFORE wrapping it: `new Error(err.message)` throws the `code`
 * away, and that is exactly how these reached the route handler unrecognised.
 */
export function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  return /duplicate key value violates unique constraint/i.test(String(err.message ?? ''));
}

/**
 * Identity of a report's CONTENT, independent of the bytes that carried it.
 *
 * WHY A SECOND HASH. The byte hash (`file_sha256`) is doing its job — it
 * catches a literal re-POST of the same file, and the ingest log shows it
 * firing. What it cannot catch is the same logical report re-rendered: LP
 * regenerates the PDF on each fetch, so a redundant pull produces different
 * BYTES for identical CONTENT. On 2026-08-05 that left eight jobs_by_milestone
 * snapshots for one period, all 30 rows, all net $702,506, every one with a
 * DISTINCT file_sha256 — two of them landing 20ms and 43ms apart. No byte hash
 * could have deduped those.
 *
 * The key is a canonical serialization of the PARSED ROWS plus the window they
 * describe — not just the control totals. Totals alone would treat a Jobs By
 * Status file whose bucket mix changed while its row count and gross held
 * steady as a duplicate, silently dropping a real update. Any material change
 * to any row changes this hash.
 */
export function contentSha256({
  reportType, periodStart, periodEnd, asOfDate, scope, rows,
  parserVersion = null, includeAsOf = true, sortKeys = null,
}) {
  const h = createHash('sha256');
  // NUL separates fields and \x1e separates rows so no concatenation of cell
  // values can forge another report's digest. Written as escapes, not literal
  // control bytes, so this function stays editable.
  //
  // includeAsOf=false is the CSV contract. A CSV re-pull of the same period is
  // the SAME report even though its CurrentDateTime — and so its as-of — moved;
  // that is the whole reason content identity exists for CSV. The PDF path
  // keeps as-of in the key, where it distinguishes two same-window pulls taken
  // on different days. With includeAsOf=true the digest is byte-identical to
  // the pre-CSV one.
  h.update(`${reportType}\0${periodStart ?? ''}\0${periodEnd ?? ''}\0`);
  if (includeAsOf) h.update(`${asOfDate ?? ''}\0`);
  h.update(`${scope ?? ''}\0`);
  // A parser change is a new READING of the same content: folding its version
  // in lets corrected output re-land and supersede, instead of bouncing as a
  // duplicate of the reading it was meant to replace.
  if (parserVersion) h.update(`pv=${parserVersion}\0`);

  // LP's sort-order parameters (xSortBy &c.) reorder rows without changing the
  // report. Sorting on a stable business key makes identity independent of them.
  let ordered = rows ?? [];
  if (sortKeys?.length) {
    ordered = [...ordered].sort((a, b) => {
      for (const k of sortKeys) {
        const av = a?.[k] == null ? '' : String(a[k]);
        const bv = b?.[k] == null ? '' : String(b[k]);
        if (av !== bv) return av < bv ? -1 : 1;
      }
      return 0;
    });
  }

  for (const r of ordered) {
    // Key order is fixed by sorting, so a parser field-order change does not
    // invent a new identity for unchanged data.
    const keys = Object.keys(r).filter((k) => !isVolatileKey(k)).sort();
    for (const k of keys) {
      const v = r[k];
      h.update(`${k}=${v === null || v === undefined ? '' : String(v).trim()}\x1f`);
    }
    h.update('\x1e');
  }
  return h.digest('hex');
}

/**
 * Columns that echo the RUN rather than describe the DATA, and so must never
 * reach the content hash. LP stamps every CSV row with these, and two pulls of
 * an identical period differ in all of them — which is precisely why
 * file_sha256 cannot dedup a CSV.
 *
 * The `x`-prefix rule covers LP's parameter echoes (xBrn_id, xSortBy,
 * xGrouper, xGrade, xSetter, …). Header case varies between reports, so the
 * test is case-insensitive. No LP DATA column begins with `x`.
 *
 * `footer` is here because report 138 stamps a static legend on EVERY row
 * ('1Leg=1 Leg Wife or Husband Missing;    NoHome=No-Show;    …') decoding its
 * disposition buckets. It is documentation, not data — one distinct value
 * across all 345 rows of the January export. Left in the hash, an LP wording
 * change to that legend would fork the digest of every row at once and
 * spuriously supersede a perfectly good snapshot.
 */
const VOLATILE_COLUMNS = new Set(['currentdatetime', 'usecolor', 'fullname', 'empname', 'footer']);

function isVolatileKey(k) {
  if (k.startsWith('_')) return true;          // parser-transient, e.g. _renders_cents
  const lower = k.toLowerCase();
  return VOLATILE_COLUMNS.has(lower) || /^x[a-z]/.test(lower);
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

// ─── Ingest-route authentication ─────────────────────────────────────────────
//
// Shared by lp-csv-ingest.js and lp-report-ingest.js. It lives HERE rather than
// in either of them because lp-csv-ingest already imports from lp-report-ingest,
// and putting it in the latter would close a require cycle.
//
// ══ THE CHECK FAILS OPEN WHEN UNCONFIGURED — AND SAID NOTHING ══
//
// Verified 2026-08-10: a POST carrying the literal placeholder
// `x-ghl-signature: PASTE_SIGNATURE` was accepted and wrote 484 rows. Not a
// missing check — authorized() is called by every CSV ingest route, every PDF
// ingest route and /events/*, each returning 401 on a mismatch. The cause is
// that LP_REPORT_INGEST_SECRET is unset, so the guard returns true for
// anything, silently. A control that disables itself without saying so reads
// exactly like a control that is working.
//
// The fail-open default is KEPT deliberately: flipping to fail-closed while the
// variable is unset would 401 every n8n workflow at once and take the whole
// report pipeline down. Enforcement is enabled by SETTING the variable — no
// code change — after confirming every caller sends the same value.

export const INGEST_SECRET = (process.env.LP_REPORT_INGEST_SECRET || '').trim();

/** Opt-in: refuse to register ingest routes at all without a configured secret. */
const INGEST_STRICT = /^(1|true|yes)$/i.test((process.env.LP_REPORT_INGEST_STRICT || '').trim());

let unauthenticatedWarned = false;

/** Say it once per process, loudly. Per-request would drown the logs. */
export function warnUnauthenticatedIngest(where) {
  if (unauthenticatedWarned) return;
  unauthenticatedWarned = true;
  console.error(
    `[SECURITY] ${where}: LP_REPORT_INGEST_SECRET is NOT SET — the ingest routes are accepting `
    + 'UNAUTHENTICATED writes on a public host. Any caller can post arbitrary report bytes into '
    + 'the scorecard. Set LP_REPORT_INGEST_SECRET to the value the n8n workflows already send in '
    + 'x-ghl-signature; enforcement turns on the moment it is set. Set LP_REPORT_INGEST_STRICT=true '
    + 'to make an unset secret a hard startup failure instead.',
  );
}

/**
 * The shared header check. Returns true to allow.
 * Logs rejections, never the supplied value — it may be a near-miss of the real
 * secret and the logs are less protected than the environment.
 */
export function ingestAuthorized(req, where) {
  const provided = req.headers['x-ghl-signature'] || req.headers['x-webhook-secret'] || '';
  if (!INGEST_SECRET) {
    warnUnauthenticatedIngest(where);
    return true;
  }
  if (provided === INGEST_SECRET) return true;
  console.warn(`[${where}] REJECTED unauthenticated ingest: ${req.method} ${req.originalUrl} from ${req.ip} (signature ${provided ? 'mismatched' : 'absent'})`);
  return false;
}

/** Announce the auth posture at route registration, not on the first POST. */
export function assertIngestAuthConfigured(where) {
  if (INGEST_SECRET) {
    console.log(`[${where}] ingest signature enforcement ACTIVE`);
    return;
  }
  if (INGEST_STRICT) {
    throw new Error(
      `${where}: LP_REPORT_INGEST_STRICT is set but LP_REPORT_INGEST_SECRET is empty — refusing to `
      + 'register unauthenticated ingest routes.',
    );
  }
  warnUnauthenticatedIngest(where);
}
