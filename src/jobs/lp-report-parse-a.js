// ─── Report A parser — "Jobs by Milestone Date" (RTP / Actual) ───
// src/jobs/lp-report-parse-a.js
//
// Input: pdftotext -layout output of LP's scheduled "Jobs by Milestone Date"
// PDF (milestone=RTP, mode=Actual). Output: detail rows (NET dollars by RTP
// date — the scorecard's Net Sales feed) plus everything needed to validate
// the file closed.
//
// LINE CLASSIFIER (structure the report prints, in order):
//   detail       leading numeric Job Number
//   rep header   bare-name line (letters/punctuation only) — carried onto
//                subsequent detail rows for audit; never a metric dimension
//   rep subtotal money-tokens-only line — the per-rep printed sums. Checked
//                to the CENT against our accumulated detail sums; this is
//                the double-count guard (a detail line misread as two, or a
//                subtotal misread as a detail row, breaks it immediately)
//   footer       'Total # Records: N' + a Total line with the grand sums
//   anything else (page headers, column headers, blank) — ignored
//
// PURE: no I/O, no env. The ingest orchestrator supplies text and consumes
// { header, rows, repSubtotals, footer }. All money is CENTS (see
// lp-report-common.parseMoneyCents). Column order on a detail line is
//   Job# Customer Address City ContractDate RTPDate Branch Product
//   Gross Net Paid Balance
// Money/date/branch cells are matched by PATTERN, not position, so modest
// layout drift shifts nothing — and when drift does break parsing, the
// validators below catch it and the file is rejected (fail-closed), never
// mis-ingested.

import { parseMoneyCents, parseDateMDY } from './lp-report-common.js';

// Money cells on Report A always carry cents ('1,158,424.00') — requiring the
// decimal point keeps street numbers and ZIPs from ever matching, and the
// digit lookarounds keep a match from starting mid-number ('1234.56' → '234.56').
const MONEY_RE = /(?<![\d,.])\(?\$?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?!\d)/g;
const DATE_RE = /\d{1,2}\/\d{1,2}\/\d{4}/g;

// Verbatim LP branch codes (lp_branch_market_map.brn_id). RFED included even
// though it rarely reports — a code missing here would swallow that branch's
// cell into the product field, which the subtotal/footer ties would then
// reject loudly rather than mis-attribute.
export const BRANCH_CODES = ['BOCA', 'FTLAU', 'FTMYR', 'JAX', 'LAKE', 'MIAMI', 'ORL', 'RFED', 'SAR', 'STPET'];
const BRANCH_RE = new RegExp(`\\b(${BRANCH_CODES.join('|')})\\b`);

const money = (tok) => parseMoneyCents(tok);

/** All money tokens on a line, as cents, with their character offsets. */
function moneyTokens(line) {
  const out = [];
  for (const m of line.matchAll(MONEY_RE)) out.push({ cents: money(m[0]), at: m.index });
  return out;
}

function isRepHeader(line) {
  const t = line.trim();
  if (!t || /\d/.test(t)) return false;
  if (!/^[A-Za-z][A-Za-z.,'\- ]*$/.test(t)) return false;
  // Column/page headers are letters-only too — exclude by vocabulary.
  if (/\b(total|customer|address|city|branch|product|gross|net|paid|balance|milestone|page|records|job|date|report)\b/i.test(t)) return false;
  return true;
}

/**
 * Parse the -layout text. Never throws on content problems — structural
 * doubts become validator violations, not exceptions, so the ingest log
 * always records WHAT failed with both sides.
 */
export function parseJobsByMilestone(text) {
  const lines = String(text ?? '').split('\n');

  const rows = [];
  const repSubtotals = [];   // { rep, cents: number[] } in printed order
  const headerLines = [];    // everything before the first detail line
  let footer = { recordCount: null, totalCents: null };
  let currentRep = null;
  let sawDetail = false;

  for (const line of lines) {
    if (!line.trim()) continue;

    const recMatch = line.match(/Total\s*#?\s*Records\s*:?\s*([\d,]+)/i);
    if (recMatch) {
      footer.recordCount = Number(recMatch[1].replace(/,/g, ''));
      const toks = moneyTokens(line);
      if (toks.length) footer.totalCents = toks.map((t) => t.cents);
      continue;
    }
    if (/^\s*(grand\s+)?totals?\b/i.test(line)) {
      const toks = moneyTokens(line);
      if (toks.length) footer.totalCents = toks.map((t) => t.cents);
      continue;
    }

    const detail = line.match(/^\s*(\d{3,})\s+(.*)$/);
    if (detail && moneyTokens(line).length >= 2) {
      sawDetail = true;
      const jobNumber = detail[1];
      const dates = [...line.matchAll(DATE_RE)].map((m) => ({ iso: parseDateMDY(m[0]), at: m.index }));
      const monies = moneyTokens(line);
      const branchMatch = line.match(BRANCH_RE);

      // Text between the job number and the first date = Customer | Address | City
      // (column gaps in -layout are 2+ spaces).
      const preDateEnd = dates.length ? dates[0].at : (branchMatch ? branchMatch.index : monies[0].at);
      const nameCells = line
        .slice(line.indexOf(jobNumber) + jobNumber.length, preDateEnd)
        .split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);

      // Product sits between the branch cell and the first money cell.
      let product = null;
      if (branchMatch && monies.length) {
        product = line.slice(branchMatch.index + branchMatch[0].length, monies[0].at).trim() || null;
      }

      rows.push({
        job_number: jobNumber,
        customer_name: nameCells[0] ?? null,
        address: nameCells[1] ?? null,
        city: nameCells[2] ?? null,
        contract_date: dates[0]?.iso ?? null,
        rtp_date: dates[1]?.iso ?? dates[0]?.iso ?? null,
        branch_code_raw: branchMatch ? branchMatch[0] : null,
        product,
        // Printed order: Gross Net Paid Balance. Net is the metric.
        gross_cents: monies[0]?.cents ?? null,
        net_cents: monies[1]?.cents ?? null,
        paid_cents: monies[2]?.cents ?? null,
        balance_cents: monies[3]?.cents ?? null,
        sales_rep: currentRep,
      });
      continue;
    }

    // Money-tokens-only line = the current rep's printed subtotal.
    const stripped = line.replace(MONEY_RE, '').trim();
    const toks = moneyTokens(line);
    if (toks.length && (stripped === '' || /^totals?:?$/i.test(stripped))) {
      repSubtotals.push({ rep: currentRep, cents: toks.map((t) => t.cents) });
      continue;
    }

    if (isRepHeader(line)) { currentRep = line.trim(); continue; }
    if (!sawDetail) headerLines.push(line.trim());
  }

  // Declared parameters + period come from the pre-detail header block.
  const headerText = headerLines.join('\n');
  const headerDates = [...headerText.matchAll(DATE_RE)].map((m) => parseDateMDY(m[0])).filter(Boolean).sort();
  return {
    header: {
      text: headerText,
      declaresRtp: /\bRTP\b/i.test(headerText),
      declaresActual: /\bActual\b/i.test(headerText),
      periodStart: headerDates[0] ?? null,
      periodEnd: headerDates[headerDates.length - 1] ?? null,
    },
    rows,
    repSubtotals,
    footer,
  };
}

/**
 * Validation gates — ALL must pass or the file writes nothing (fail-closed).
 * Every violation carries both sides so the ingest log answers "what broke"
 * without re-opening the PDF.
 * @returns {{ ok:boolean, violations:Array<{rule:string, detail:object}> }}
 */
export function validateJobsByMilestone(parsed) {
  const v = [];
  const { header, rows, repSubtotals, footer } = parsed;

  // 1. Wrong report parameters — a Projected run or a non-RTP milestone would
  //    parse cleanly and lie. Reject unless the header declares RTP + Actual.
  if (!header.declaresRtp || !header.declaresActual) {
    v.push({ rule: 'wrong_report_parameters', detail: { declaresRtp: header.declaresRtp, declaresActual: header.declaresActual, header: header.text.slice(0, 500) } });
  }
  if (!header.periodStart || !header.periodEnd) {
    v.push({ rule: 'missing_period', detail: { periodStart: header.periodStart, periodEnd: header.periodEnd } });
  }

  if (!rows.length) v.push({ rule: 'no_detail_rows', detail: { rows: 0 } });
  const noNet = rows.filter((r) => r.net_cents == null);
  if (noNet.length) {
    v.push({ rule: 'rows_missing_net', detail: { count: noNet.length, sample: noNet.slice(0, 3).map((r) => r.job_number) } });
  }

  // 2. Rep subtotal tie — EXACT cents, column-by-column for as many columns
  //    as the subtotal prints. The double-count guard: any detail/subtotal
  //    misclassification breaks at least one rep's tie.
  const byRep = new Map();
  for (const r of rows) {
    const key = r.sales_rep ?? '';
    const acc = byRep.get(key) || [0, 0, 0, 0];
    acc[0] += r.gross_cents ?? 0; acc[1] += r.net_cents ?? 0;
    acc[2] += r.paid_cents ?? 0; acc[3] += r.balance_cents ?? 0;
    byRep.set(key, acc);
  }
  for (const sub of repSubtotals) {
    const acc = byRep.get(sub.rep ?? '') || [0, 0, 0, 0];
    sub.cents.forEach((printed, i) => {
      if (i < 4 && printed !== acc[i]) {
        v.push({ rule: 'rep_subtotal_mismatch', detail: { rep: sub.rep, column: i, printed_cents: printed, computed_cents: acc[i] } });
      }
    });
  }

  // 3. Footer record count — exact.
  if (footer.recordCount == null) {
    v.push({ rule: 'missing_footer', detail: { expected: "Total # Records line" } });
  } else if (footer.recordCount !== rows.length) {
    v.push({ rule: 'footer_count_mismatch', detail: { printed: footer.recordCount, parsed: rows.length } });
  }

  // 4. Footer money tie — ±1¢ (LP's own rounding), matched column-wise.
  if (footer.totalCents && footer.totalCents.length) {
    const sums = [0, 0, 0, 0];
    for (const r of rows) {
      sums[0] += r.gross_cents ?? 0; sums[1] += r.net_cents ?? 0;
      sums[2] += r.paid_cents ?? 0; sums[3] += r.balance_cents ?? 0;
    }
    footer.totalCents.forEach((printed, i) => {
      if (i < 4 && Math.abs(printed - sums[i]) > 1) {
        v.push({ rule: 'footer_total_mismatch', detail: { column: i, printed_cents: printed, computed_cents: sums[i] } });
      }
    });
  } else {
    v.push({ rule: 'missing_footer_total', detail: { expected: 'grand total money line' } });
  }

  return { ok: v.length === 0, violations: v };
}

/** Per-market net roll-up (branch → market via the supplied map), in cents. */
export function sumNetByMarket(rows, branchMap) {
  const out = new Map();
  for (const r of rows) {
    const b = String(r.branch_code_raw ?? '').trim().toUpperCase();
    const market = branchMap.get(b) || 'UNMAPPED';
    out.set(market, (out.get(market) || 0) + (r.net_cents ?? 0));
  }
  return out;
}
