// ─── Report B parser — "Jobs By Status" (open pipeline) ───
// src/jobs/lp-report-parse-b.js
//
// Input: pdftotext -layout output of LP's scheduled "Jobs By Status" PDF.
// Output: one row per open job with its status classified into the scorecard's
// Good Business split. RULED 2026-08-04: TWO reporting buckets only —
//   hoa            HOLD - HOA (Held in HOA)
//   other_pending  every other open pending status, INCLUDING Hold - Permit
//                  (there is NO permit bucket, ever)
// plus 'excluded' for statuses that are on the report but are not Good
// Business (cancelled/dead/declined) or already counted in Net Sales
// (Rel To Production / RTP-adjacent — flagged as an assumption in the PR).
//
// FAIL-CLOSED: a status not in KNOWN_STATUSES classifies to null; the ingest
// orchestrator quarantines the row and rejects the whole file. LP adding a
// 22nd status makes the pipeline STOP, not guess.
//
// LINE MODEL: a detail line is anchored by BRANCH + Prosp# at column 0.
// Everything between one anchor and the next accumulates VERBATIM into the
// current row's notes_raw — free-text notes routinely contain money ("MSRP
// $21,750"), so money is parsed ONLY from the anchor line, after the status
// cell. Two structured wraps are recognized and consumed before the residue
// goes to notes: a status whose long name wrapped to the next line, and a
// wrapped customer-name fragment sitting under the name column.
//
// PURE: no I/O, no env.

import { parseMoneyCents, parseDateMDY } from './lp-report-common.js';

// LP branch codes as printed (lp_branch_market_map.brn_id).
export const MARKET_CODES = ['BOCA', 'FTLAU', 'FTMYR', 'JAX', 'LAKE', 'MIAMI', 'ORL', 'RFED', 'SAR', 'STPET'];

// The 21 statuses "Jobs By Status" prints (verified against the live
// lp_jobs.job_status vocabulary). Grouped by scorecard bucket. Anything
// else → classifyStatus() returns null → quarantine.
export const STATUS_BUCKET_MAP = new Map([
  // Held in HOA — its own reporting bucket.
  ['HOLD - HOA', 'hoa'],
  // Not Good Business, or already counted in Net Sales (assumption flagged
  // in the PR: Rel To Production / RTP Await recission / RTP DP DUE excluded).
  ['Cancelled', 'excluded'],
  ['Cancelled By Mgt', 'excluded'],
  ['Dead Deal', 'excluded'],
  ['Credit Decline', 'excluded'],
  ['Rel To Production', 'excluded'],
  ['RTP Await recission', 'excluded'],
  ['RTP DP DUE', 'excluded'],
  // Other Pending — Good Business awaiting release. Hold - Permit lives HERE.
  ['New', 'other_pending'],
  ['Quoted', 'other_pending'],
  ['Awaiting Paperwork', 'other_pending'],
  ['Awaiting Commission Sheet', 'other_pending'],
  ['Awaiting Change Order', 'other_pending'],
  ['Awaiting Credit Application', 'other_pending'],
  ['Awaiting Loan Docs', 'other_pending'],
  ['Awaiting Lender', 'other_pending'],
  ['Awaiting Par Sheet', 'other_pending'],
  ['Await Rep', 'other_pending'],
  ['Await Customer', 'other_pending'],
  ['Hold - Permit', 'other_pending'],
  ['Mgmt Hold', 'other_pending'],
]);

export const KNOWN_STATUSES = [...STATUS_BUCKET_MAP.keys()];
// Longest-first so 'Awaiting Change Order' wins over any shorter overlap.
const STATUSES_BY_LENGTH = [...KNOWN_STATUSES].sort((a, b) => b.length - a.length);

/** Bucket for a verbatim status; null = unknown → quarantine upstream. */
export function classifyStatus(statusRaw) {
  const s = String(statusRaw ?? '').trim();
  return STATUS_BUCKET_MAP.get(s) ?? null;
}

const ANCHOR_RE = new RegExp(`^\\s*(${MARKET_CODES.join('|')})\\s+(\\d+)\\s+(.*)$`);
// Report B money may print without cents ('1,379,228') — accept both, but
// ONLY when applied after the status cell of an anchor line (notes are never
// scanned for money). Comma group or decimal required so bare integers
// (prosp#, street numbers) can't match; '$0' / '0.00' allowed. Digit
// lookarounds keep fragments of longer numbers ('0' inside '2026') out.
const MONEY_B_RE = /(?<![\d,.])\(?\$?(?:\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2}|0)\)?(?![\d.])/g;
const DATE_RE = /\d{1,2}\/\d{1,2}\/\d{4}/g;
const PHONE_RE = /\(?\d{3}\)?[- .]\d{3}[- .]\d{4}/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Word-boundary–aware status matchers: 'New' must NOT hit inside 'Newman'.
const STATUS_RES = STATUSES_BY_LENGTH.map((s) => ({
  status: s,
  re: new RegExp(`(?<![A-Za-z])${escapeRe(s)}(?![A-Za-z])`),
}));

/** Find a known status on the line (longest first): { status, at, end } or null. */
function findStatus(line) {
  for (const { status, re } of STATUS_RES) {
    const m = line.match(re);
    if (m) return { status, at: m.index, end: m.index + status.length };
  }
  return null;
}

/**
 * Wrapped-status recovery. When a long status name overflows its column
 * ('Awaiting Change Order' → 'Awaiting Change' on the anchor line, 'Order'
 * on the next), the money/lender cells STAY on the anchor line to the right
 * of the status column — only the overflow word drops. So: find a known
 * status whose word-PREFIX sits on the anchor line and whose remainder opens
 * the next line. Returns { status, at, end, restLen } with at/end relative
 * to `segment` (the anchor line after the prosp#), or null. The joint
 * condition (prefix on line N AND exact remainder opening line N+1) keeps
 * common words like 'Credit' from matching spuriously.
 */
function findWrappedStatus(segment, nextLine) {
  const cont = String(nextLine ?? '').trim();
  if (!cont) return null;
  for (const s of STATUSES_BY_LENGTH) {
    const words = s.split(' ');
    for (let cut = words.length - 1; cut >= 1; cut--) {
      const head = words.slice(0, cut).join(' ');
      const rest = words.slice(cut).join(' ');
      if (cont !== rest && !cont.startsWith(`${rest}  `)) continue;
      const m = segment.match(new RegExp(`(?<![A-Za-z])${escapeRe(head)}(?![A-Za-z])`));
      if (m) return { status: s, at: m.index, end: m.index + head.length, restLen: rest.length };
    }
  }
  return null;
}

/**
 * Parse the -layout text into detail rows. Content problems become nulls the
 * validators/ingest reject — never silent guesses.
 */
export function parseJobsByStatus(text) {
  const lines = String(text ?? '').split('\n');
  const rows = [];
  const headerLines = [];
  let footer = { recordCount: null, totalCents: null };
  let current = null; // row under construction (notes may still accumulate)

  const flush = () => { if (current) { rows.push(current.row); current = null; } };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const recMatch = line.match(/Total\s*#?\s*Records\s*:?\s*([\d,]+)/i);
    if (recMatch) {
      flush();
      footer.recordCount = Number(recMatch[1].replace(/,/g, ''));
      const toks = [...line.matchAll(MONEY_B_RE)].map((m) => parseMoneyCents(m[0]));
      if (toks.length) footer.totalCents = toks[toks.length - 1];
      continue;
    }
    if (/^\s*(grand\s+)?totals?\b/i.test(line)) {
      flush();
      const toks = [...line.matchAll(MONEY_B_RE)].map((m) => parseMoneyCents(m[0]));
      if (toks.length) footer.totalCents = toks[toks.length - 1];
      continue;
    }

    const anchor = line.match(ANCHOR_RE);
    if (anchor) {
      flush();
      const [, branch, prosp] = anchor;
      const restStart = line.indexOf(prosp, line.indexOf(branch) + branch.length) + prosp.length;
      const segment = line.slice(restStart);

      const dateM = segment.match(DATE_RE);
      const phoneM = segment.match(PHONE_RE);
      const emailM = segment.match(EMAIL_RE);
      let statusHit = findStatus(segment);
      let consumedNextLen = 0;
      if (!statusHit) {
        const wrapped = findWrappedStatus(segment, lines[i + 1]);
        if (wrapped) {
          statusHit = wrapped;
          consumedNextLen = wrapped.restLen; // strip the completion off the next line's notes
        }
      }

      // Money strictly AFTER the status cell (notes money can't leak in).
      let totalGross = null;
      let lender = null;
      if (statusHit) {
        const afterStatus = segment.slice(statusHit.end);
        const monies = [...afterStatus.matchAll(MONEY_B_RE)];
        if (monies.length) {
          totalGross = parseMoneyCents(monies[0][0]);
          lender = afterStatus.slice(monies[0].index + monies[0][0].length).trim() || null;
        }
      }

      // Customer name: text after prosp# up to the first structured cell.
      const structuredAts = [
        phoneM ? phoneM.index : null,
        emailM ? emailM.index : null,
        dateM ? segment.indexOf(dateM[0]) : null,
        statusHit ? statusHit.at : null,
      ].filter((x) => x != null);
      const nameEnd = structuredAts.length ? Math.min(...structuredAts) : segment.length;
      const customer = segment.slice(0, nameEnd).trim() || null;

      current = {
        pendingNameWrap: true, // first continuation line may be a wrapped name fragment
        consumedNextLen,
        row: {
          prosp_number: prosp,
          customer_name: customer,
          phone: phoneM ? phoneM[0] : null,
          email: emailM ? emailM[0] : null,
          contract_date: dateM ? parseDateMDY(dateM[0]) : null,
          branch_code_raw: branch,
          status_raw: statusHit ? statusHit.status : null,
          bucket: statusHit ? classifyStatus(statusHit.status) : null,
          total_gross_cents: totalGross,
          lender,
          notes_raw: null,
          dup_review: false,
        },
      };
      continue;
    }

    // Non-anchor, non-footer line.
    if (!current) { headerLines.push(line.trim()); continue; }

    let content = line;
    if (current.consumedNextLen) {
      // This line began with the wrapped-status completion — strip it.
      content = content.replace(/^\s*/, '').slice(current.consumedNextLen);
      current.consumedNextLen = 0;
    }
    const t = content.trim();
    if (!t) { current.pendingNameWrap = false; continue; }

    // Wrapped customer-name fragment: short letters-only residue directly
    // under the name column on the first continuation line.
    if (current.pendingNameWrap && /^[A-Za-z.,'\- ]{1,40}$/.test(t) && current.row.customer_name) {
      current.row.customer_name = `${current.row.customer_name} ${t}`;
      current.pendingNameWrap = false;
      continue;
    }
    current.pendingNameWrap = false;

    // Everything else between anchors is a note, verbatim — INCLUDING lines
    // with money in them. Money here is narrative, never a metric.
    current.row.notes_raw = current.row.notes_raw ? `${current.row.notes_raw}\n${t}` : t;
  }
  flush();

  const headerText = headerLines.join('\n');
  const headerDates = [...headerText.matchAll(DATE_RE)].map((m) => parseDateMDY(m[0])).filter(Boolean).sort();
  return {
    header: { text: headerText, reportDate: headerDates[headerDates.length - 1] ?? null },
    rows,
    footer,
  };
}

/**
 * Same Prosp# + same contract date twice = a real duplicate needing human
 * review → dup_review on BOTH rows (kept, flagged). Same Prosp# on different
 * dates is legitimate (a prospect with two contracts) — untouched.
 */
export function flagDuplicates(rows) {
  const seen = new Map(); // `${prosp}|${date}` → first row
  for (const r of rows) {
    const key = `${r.prosp_number}|${r.contract_date ?? ''}`;
    const first = seen.get(key);
    if (first) { first.dup_review = true; r.dup_review = true; }
    else seen.set(key, r);
  }
  return rows;
}

/**
 * Validation gates — all must pass or nothing writes (fail-closed).
 * Unknown statuses are reported here AND quarantined row-by-row upstream.
 * @returns {{ ok:boolean, violations:Array<{rule:string, detail:object}> }}
 */
export function validateJobsByStatus(parsed) {
  const v = [];
  const { rows, footer } = parsed;

  if (!rows.length) v.push({ rule: 'no_detail_rows', detail: { rows: 0 } });

  const unknown = rows.filter((r) => r.bucket == null);
  if (unknown.length) {
    v.push({
      rule: 'unmapped_status',
      detail: {
        count: unknown.length,
        sample: unknown.slice(0, 5).map((r) => ({ prosp: r.prosp_number, status_raw: r.status_raw })),
      },
    });
  }

  if (footer.recordCount == null) {
    v.push({ rule: 'missing_footer', detail: { expected: 'Total # Records line' } });
  } else if (footer.recordCount !== rows.length) {
    v.push({ rule: 'footer_count_mismatch', detail: { printed: footer.recordCount, parsed: rows.length } });
  }

  if (footer.totalCents != null) {
    const sum = rows.reduce((a, r) => a + (r.total_gross_cents ?? 0), 0);
    if (Math.abs(footer.totalCents - sum) > 1) {
      v.push({ rule: 'footer_total_mismatch', detail: { printed_cents: footer.totalCents, computed_cents: sum } });
    }
  } else {
    v.push({ rule: 'missing_footer_total', detail: { expected: 'grand total money line' } });
  }

  return { ok: v.length === 0, violations: v };
}

/** { bucket → { count, cents } } roll-up (recon's b_internal + goldens). */
export function sumByBucket(rows) {
  const out = new Map();
  for (const r of rows) {
    const key = r.bucket ?? 'UNKNOWN';
    const acc = out.get(key) || { count: 0, cents: 0 };
    acc.count += 1;
    acc.cents += r.total_gross_cents ?? 0;
    out.set(key, acc);
  }
  return out;
}
