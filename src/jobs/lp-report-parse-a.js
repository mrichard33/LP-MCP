// ─── Report A parser — "Jobs by Milestone Date" (RTP / Actual) ───
// src/jobs/lp-report-parse-a.js
//
// Input: pdftotext -layout output of LP's scheduled "Jobs by Milestone Date"
// PDF (milestone=Ordered, mode=Actual — the original spec said RTP; the real
// scheduled run declares 'Ordered'). Output: detail rows (NET dollars by
// milestone date — the scorecard's Net Sales feed) plus everything needed to
// validate the file closed. Rows keep the rtp_date field name (schema
// compatibility); it holds the milestone ('Ordered') date column.
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
// lp-report-common.parseMoneyCents).
//
// MONEY COLUMN ORDER IS DERIVED FROM THE PRINTED COLUMN HEADER, never
// hardcoded. The first production PDF (2026-08-04) printed
//   Net Amount | Total Gross | Total Paid | Balance Due
// while the original spec assumed Gross | Net | Paid | Balance — a hardcoded
// order would have silently transposed net and gross (and every tie would
// still pass, because subtotals sum the same printed columns). If the header
// cannot be recognized, validation fails with money_columns_unrecognized:
// layout drift stops the pipeline, it never guesses (fail-closed).

import { parseMoneyCents, parseDateMDY, parseDateAny } from './lp-report-common.js';

// Strict money (comma-grouped or explicit cents) — used on subtotal/footer
// lines and as the branchless fallback, where a bare integer could be a
// street number or ZIP. Detail-row money is parsed cell-wise right of the
// branch column instead (see below), so no-cents renderings still land.
const MONEY_RE = /(?<![\d,.])\(?\$?(?:\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2})\)?(?!\d)/g;
// Detail rows print 2-digit years ('05/16/26'), header/footer 4-digit —
// both verified against the first production PDF (2026-08-04).
const DATE_RE = /\d{1,2}\/\d{1,2}\/\d{2,4}/g;
const LONG_DATE_RE = /(?:[A-Za-z]+,\s*)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}/g;
// Printed run timestamp ('8/4/2026 6:00:12 AM' etc.) — best-effort, non-gating.
const PRINTED_AT_RE = /(\d{1,2}\/\d{1,2}\/\d{4})[ ,]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?/i;

// Verbatim LP branch codes (lp_branch_market_map.brn_id). RFED included even
// though it rarely reports — a code missing here would swallow that branch's
// cell into the product field, which the subtotal/footer ties would then
// reject loudly rather than mis-attribute.
export const BRANCH_CODES = ['BOCA', 'FTLAU', 'FTMYR', 'JAX', 'LAKE', 'MIAMI', 'ORL', 'RFED', 'SAR', 'STPET'];
const BRANCH_RE = new RegExp(`\\b(${BRANCH_CODES.join('|')})\\b`);

const money = (tok) => parseMoneyCents(tok);

/** All strict money tokens on a line, as cents, with their character offsets. */
function moneyTokens(line) {
  const out = [];
  for (const m of line.matchAll(MONEY_RE)) out.push({ cents: money(m[0]), at: m.index });
  return out;
}

/**
 * Cell-wise money for subtotal/total lines: split on -layout's 2+-space
 * column gaps and require EVERY cell to parse as money. Unlike MONEY_RE this
 * accepts bare small integers — the first production PDF printed subtotal
 * cells of '1' and '200' (paid column, whole dollars), which strict matching
 * silently dropped, taking two reps' double-count ties with it. All-cells-
 * money keeps the classification safe: any prose on the line disqualifies it.
 * @returns {number[]|null} cents per cell, or null if any cell is not money
 */
function allMoneyCells(segment) {
  const cells = segment.trim().split(/\s{2,}/).filter(Boolean);
  if (!cells.length) return null;
  const cents = cells.map((c) => parseMoneyCents(c));
  return cents.every((c) => c != null) ? cents : null;
}

function isRepHeader(line) {
  const t = line.trim();
  if (!t || /\d/.test(t)) return false;
  if (!/^[A-Za-z][A-Za-z.,'\- ]*$/.test(t)) return false;
  // Column/page headers are letters-only too — exclude by vocabulary.
  if (/\b(total|customer|address|city|branch|mkt|product|gross|net|paid|balance|amount|due|milestone|page|records|job|date|report|number)\b/i.test(t)) return false;
  return true;
}

// ── money-column order, derived from the printed column header ──────────────
const COL_VOCAB = new Set(['net', 'gross', 'paid', 'balance', 'total', 'amount', 'due']);

/** Trailing run of column-vocabulary words at the end of a line ('mkt product amount gross paid due' → ['amount','gross','paid','due']). */
function trailingVocabRun(line) {
  const words = String(line).trim().split(/\s+/);
  const run = [];
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i].toLowerCase().replace(/[^a-z]/g, '');
    if (!COL_VOCAB.has(w)) break;
    run.unshift(w);
  }
  return run;
}

function labelToField(words) {
  const s = new Set(words);
  if (s.has('gross')) return 'gross';
  if (s.has('net')) return 'net';
  if (s.has('paid')) return 'paid';
  if (s.has('balance') || s.has('due')) return 'balance';
  return null;
}

/**
 * Derive the printed money-column order from the header block.
 * Recognizes the two-line compound header LP actually prints
 *   …  Net    Total    Total   Balance
 *   …  Amount  Gross    Paid     Due
 * (labels paired positionally — -layout preserves left-to-right order even
 * when absolute offsets drift) and the flat single-line form
 *   …  Gross  Net  Paid  Balance
 * Returns exactly-4 distinct fields (e.g. ['net','gross','paid','balance'])
 * or null — null fails validation, it never falls back to a guess.
 * @returns {string[]|null}
 */
export function deriveMoneyColumnOrder(headerLines) {
  for (let i = 0; i + 1 < headerLines.length; i++) {
    const top = trailingVocabRun(headerLines[i]);
    const bot = trailingVocabRun(headerLines[i + 1]);
    if (top.length === 4 && bot.length === 4) {
      const fields = top.map((t, k) => labelToField([t, bot[k]]));
      if (!fields.includes(null) && new Set(fields).size === 4) return fields;
    }
  }
  for (const line of headerLines) {
    const run = trailingVocabRun(line);
    if (run.length === 4) {
      const fields = run.map((w) => labelToField([w]));
      if (!fields.includes(null) && new Set(fields).size === 4) return fields;
    }
  }
  return null;
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
  let reportGeneratedAt = null;
  let lastDetailRow = null; // wrapped-name continuation target

  for (const line of lines) {
    if (!line.trim()) continue;

    if (!reportGeneratedAt) {
      const printed = line.match(PRINTED_AT_RE);
      if (printed) reportGeneratedAt = parseDateMDY(printed[1]);
    }

    const recMatch = line.match(/Total\s*#?\s*Records\s*:?\s*([\d,]+)/i);
    if (recMatch) {
      footer.recordCount = Number(recMatch[1].replace(/,/g, ''));
      // Money cells sit right of the record count — cell-wise, so no-cents
      // grand totals (bare integers) parse. Slicing past recMatch keeps the
      // record count itself out of the money run.
      const cents = allMoneyCells(line.slice(recMatch.index + recMatch[0].length));
      if (cents?.length) footer.totalCents = cents;
      continue;
    }
    const totalsMatch = line.match(/^\s*(grand\s+)?totals?\b\s*:?/i);
    if (totalsMatch) {
      const cents = allMoneyCells(line.slice(totalsMatch[0].length));
      if (cents?.length) footer.totalCents = cents;
      continue;
    }

    const detail = line.match(/^\s*(\d{3,})\s+(.*)$/);
    if (detail) {
      const jobNumber = detail[1];
      const branchMatch = line.match(BRANCH_RE);

      // Money is parsed CELL-WISE right of the branch column: split the
      // post-branch segment on -layout's 2+-space column gaps and take the
      // trailing run of money-parseable cells. Bare integers are money HERE
      // (LP can print totals without cents) but nowhere left of the branch,
      // so street numbers / ZIPs / job numbers can never match.
      let monies = null;
      let product = null;
      let firstMoneyAt = null;
      if (branchMatch) {
        const afterStart = branchMatch.index + branchMatch[0].length;
        const cells = [];
        for (const m of line.slice(afterStart).matchAll(/\S+(?: \S+)*/g)) {
          cells.push({ text: m[0], at: afterStart + m.index });
        }
        let firstMoneyIdx = cells.length;
        for (let i = cells.length - 1; i >= 0; i--) {
          if (parseMoneyCents(cells[i].text) == null) break;
          firstMoneyIdx = i;
        }
        const run = cells.slice(firstMoneyIdx);
        if (run.length >= 2) {
          monies = run.map((c) => parseMoneyCents(c.text));
          firstMoneyAt = run[0].at;
          product = cells.slice(0, firstMoneyIdx).map((c) => c.text).join(' ').trim() || null;
        }
      } else {
        // Branchless row (quarantined upstream) — strict tokens only.
        const toks = moneyTokens(line);
        if (toks.length >= 2) {
          monies = toks.map((t) => t.cents);
          firstMoneyAt = toks[0].at;
        }
      }

      if (monies) {
        sawDetail = true;
        const dates = [...line.matchAll(DATE_RE)].map((m) => ({ iso: parseDateMDY(m[0]), at: m.index }));

        // Text between the job number and the first date = Customer | Address | City
        // (column gaps in -layout are 2+ spaces).
        const preDateEnd = dates.length ? dates[0].at : (branchMatch ? branchMatch.index : firstMoneyAt);
        const nameCells = line
          .slice(line.indexOf(jobNumber) + jobNumber.length, preDateEnd)
          .split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);

        rows.push({
          job_number: jobNumber,
          customer_name: nameCells[0] ?? null,
          address: nameCells[1] ?? null,
          city: nameCells[2] ?? null,
          contract_date: dates[0]?.iso ?? null,
          rtp_date: dates[1]?.iso ?? dates[0]?.iso ?? null,
          branch_code_raw: branchMatch ? branchMatch[0] : null,
          product,
          _monies: monies, // assigned to fields once the column order is derived
          sales_rep: currentRep,
        });
        lastDetailRow = rows[rows.length - 1];
        continue;
      }
    }

    // All-money-cells line = the current rep's printed subtotal. Cell-wise
    // (not MONEY_RE) because subtotal cells can be bare integers — '1',
    // '200' in the first production PDF.
    const subCents = allMoneyCells(line);
    if (subCents && subCents.length >= 2) {
      repSubtotals.push({ rep: currentRep, cents: subCents });
      lastDetailRow = null;
      continue;
    }

    if (isRepHeader(line)) {
      // A letters-only line right after a detail row, indented off the left
      // margin, is a WRAPPED customer name ('Hernandez/Hodzic, Jay &' /
      // '   Raisa'), not a rep header — rep group headers print flush-left.
      if (/^\s/.test(line) && lastDetailRow) {
        lastDetailRow.customer_name = [lastDetailRow.customer_name, line.trim()].filter(Boolean).join(' ');
        continue;
      }
      if (/^\S/.test(line)) { currentRep = line.trim(); lastDetailRow = null; continue; }
    }
    if (!sawDetail) headerLines.push(line.trim());
  }

  // Column order comes from the printed header; rows get their money fields
  // only once the order is known. Unrecognized header → all money fields
  // null → money_columns_unrecognized (+ rows_missing_net) in validation.
  const moneyColumnOrder = deriveMoneyColumnOrder(headerLines);
  for (const r of rows) {
    const m = r._monies;
    delete r._monies;
    if (moneyColumnOrder) {
      // Money columns are rightmost — with an extra leading numeric cell
      // (e.g. a purely numeric product) the TRAILING four are the money.
      const use = m.length > moneyColumnOrder.length ? m.slice(-moneyColumnOrder.length) : m;
      moneyColumnOrder.forEach((f, k) => { r[`${f}_cents`] = use[k] ?? null; });
    }
    for (const f of ['gross', 'net', 'paid', 'balance']) r[`${f}_cents`] ??= null;
  }

  // Declared parameters + period come from the pre-detail header block.
  // Period: prefer the explicit range line — 'from Monday, August 3, 2026
  // through …' (the real scheduled run) or 'From: 7/1/2026  To: 7/31/2026' —
  // falling back to all header dates sorted.
  const headerText = headerLines.join('\n');
  let periodStart = null;
  let periodEnd = null;
  for (const hl of headerLines) {
    const m = hl.match(/\bfrom:?\s+(.+?)\s+(?:through|thru|to):?\s+(.+)$/i);
    if (!m) continue;
    const s = parseDateAny(m[1]);
    const e = parseDateAny(m[2]);
    if (s && e) { periodStart = s; periodEnd = e; break; }
  }
  if (!periodStart || !periodEnd) {
    const headerDates = [
      ...[...headerText.matchAll(DATE_RE)].map((m) => parseDateMDY(m[0])),
      ...[...headerText.matchAll(LONG_DATE_RE)].map((m) => parseDateAny(m[0])),
    ].filter(Boolean).sort();
    periodStart ??= headerDates[0] ?? null;
    periodEnd ??= headerDates[headerDates.length - 1] ?? null;
  }

  // Declared milestone — the real scheduled run prints
  // "For Jobs with the Milestone 'Ordered'" (first production PDF,
  // 2026-08-04; the original spec assumed RTP).
  const milestoneMatch = headerText.match(/Milestone\s+'([^']+)'/i);

  return {
    header: {
      text: headerText,
      milestone: milestoneMatch ? milestoneMatch[1] : null,
      declaresActual: /\bActual\b/i.test(headerText),
      periodStart,
      periodEnd,
      moneyColumnOrder,
      reportGeneratedAt,
    },
    rows,
    repSubtotals,
    footer,
  };
}

const DEFAULT_ORDER = ['gross', 'net', 'paid', 'balance'];

/**
 * Validation gates — ALL must pass or the file writes nothing (fail-closed).
 * Every violation carries both sides so the ingest log answers "what broke"
 * without re-opening the PDF. Subtotal/footer ties compare column-by-column
 * in the PRINTED (derived) order — printed totals sum printed columns.
 * @returns {{ ok:boolean, violations:Array<{rule:string, detail:object}> }}
 */
export function validateJobsByMilestone(parsed, opts = {}) {
  const v = [];
  const { header, rows, repSubtotals, footer } = parsed;
  const order = header.moneyColumnOrder ?? DEFAULT_ORDER;
  const expectedMilestone = opts.expectedMilestone ?? 'Ordered';

  // 1. Wrong report parameters — a Projected run or a different milestone
  //    would parse cleanly and lie. The production schedule runs milestone
  //    'Ordered' + Mode 'Actual' (verified against the first production PDF,
  //    2026-08-04 — the original spec assumed RTP, which would have rejected
  //    every real file). Reject anything else.
  const milestoneOk = header.milestone != null
    && header.milestone.toLowerCase() === String(expectedMilestone).toLowerCase();
  if (!milestoneOk || !header.declaresActual) {
    v.push({ rule: 'wrong_report_parameters', detail: { milestone: header.milestone, expected_milestone: expectedMilestone, declaresActual: header.declaresActual, header: header.text.slice(0, 500) } });
  }
  if (!header.periodStart || !header.periodEnd) {
    v.push({ rule: 'missing_period', detail: { periodStart: header.periodStart, periodEnd: header.periodEnd } });
  }

  // 1b. Unrecognized money-column header — assigning by guess could transpose
  //     net and gross while every tie still passes. Stop instead.
  if (!header.moneyColumnOrder && rows.length) {
    v.push({ rule: 'money_columns_unrecognized', detail: { expected: 'column header naming Net/Gross/Paid/Balance', header: header.text.slice(0, 500) } });
  }

  if (!rows.length) v.push({ rule: 'no_detail_rows', detail: { rows: 0 } });
  const noNet = rows.filter((r) => r.net_cents == null);
  if (noNet.length) {
    v.push({ rule: 'rows_missing_net', detail: { count: noNet.length, sample: noNet.slice(0, 3).map((r) => r.job_number) } });
  }

  // 2. Rep subtotal tie — EXACT cents, column-by-column (printed order) for
  //    as many columns as the subtotal prints. The double-count guard: any
  //    detail/subtotal misclassification breaks at least one rep's tie.
  const byRep = new Map();
  for (const r of rows) {
    const key = r.sales_rep ?? '';
    const acc = byRep.get(key) || order.map(() => 0);
    order.forEach((f, i) => { acc[i] += r[`${f}_cents`] ?? 0; });
    byRep.set(key, acc);
  }
  const subtotalReps = new Set();
  for (const sub of repSubtotals) {
    subtotalReps.add(sub.rep ?? '');
    const acc = byRep.get(sub.rep ?? '') || order.map(() => 0);
    sub.cents.forEach((printed, i) => {
      if (i < order.length && printed !== acc[i]) {
        v.push({ rule: 'rep_subtotal_mismatch', detail: { rep: sub.rep, column: i, column_field: order[i], printed_cents: printed, computed_cents: acc[i] } });
      }
    });
  }
  // 2b. Every rep with detail rows must have a captured subtotal — a dropped
  //     subtotal line (misclassified or unparsed) is a hole in the
  //     double-count guard, not a pass. Caught live on the first production
  //     PDF, where strict money matching dropped two reps' subtotals.
  for (const rep of byRep.keys()) {
    if (!subtotalReps.has(rep)) {
      v.push({ rule: 'rep_subtotal_missing', detail: { rep, rows: rows.filter((r) => (r.sales_rep ?? '') === rep).length } });
    }
  }

  // 3. Footer record count — exact.
  if (footer.recordCount == null) {
    v.push({ rule: 'missing_footer', detail: { expected: "Total # Records line" } });
  } else if (footer.recordCount !== rows.length) {
    v.push({ rule: 'footer_count_mismatch', detail: { printed: footer.recordCount, parsed: rows.length } });
  }

  // 4. Footer money tie — ±1¢ (LP's own rounding), matched column-wise in
  //    printed order.
  if (footer.totalCents && footer.totalCents.length) {
    const sums = order.map(() => 0);
    for (const r of rows) {
      order.forEach((f, i) => { sums[i] += r[`${f}_cents`] ?? 0; });
    }
    footer.totalCents.forEach((printed, i) => {
      if (i < order.length && Math.abs(printed - sums[i]) > 1) {
        v.push({ rule: 'footer_total_mismatch', detail: { column: i, column_field: order[i], printed_cents: printed, computed_cents: sums[i] } });
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
