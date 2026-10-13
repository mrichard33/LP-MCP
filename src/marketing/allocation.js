/**
 * Marketing cost allocation — src/marketing/allocation.js
 *
 * PURE. No I/O, no project imports, so every cent rule here is tested offline
 * (scripts/test-marketing-allocation.js). The handoff (2026-10-12, §6) wrote
 * this as plpgsql; it lives in JS instead so there is ONE implementation and
 * it can be unit-tested without a database. src/marketing/allocation-io.js
 * reads the facts (mkt_issued_counts) and writes the rows.
 *
 * Rules, per calendar-month slice of an expense (§6):
 *   1 eligible market                      → direct, 100%, even with 0 issued
 *   several markets, total issued > 0      → proportional, market issued ÷ total
 *   several markets, total issued = 0      → equal, 1 ÷ n
 *   eligible_markets = {'REECE_HOLD'}       → hold (D4: never spread)
 *   never a market outside eligible_markets
 *
 * No markets picked (eligible_markets = '{}') means BY SOURCE (the user,
 * 2026-10-13: "we should be able to determine the markets based on the gross
 * issued leads for that source"). Every market where the line's sub-source
 * had gross issued leads that month takes its share, the same proportional
 * rule. A month with none yet (JMJ / Vis PPC in October 2026: a new campaign)
 * goes to REECE_HOLD with a note, and the nightly re-run (current + prior
 * month) splits it once leads issue. A line with no sub-source cannot be
 * split by source and throws; Approve already refuses one.
 *
 * The issued basis for a slice is its whole CALENDAR MONTH (D1: "split per
 * month and market by gross issued leads"), not only the days the slice
 * covers: an invoice with no printed period sits on its invoice date, and one
 * day of issued leads is almost always zero.
 * Round to cents. The leftover cent goes to the market with the most issued
 * (ties: alphabetical). The sum must equal the slice amount, or we throw —
 * a ledger that does not reconcile is worse than one that refuses to write.
 */

export const HOLD_MARKET = 'REECE_HOLD';

const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => Math.round(c) / 100;

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  if (!m) throw new Error(`allocation: bad date ${JSON.stringify(s)}`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
const iso = (d) => d.toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((b - a) / 86400000) + 1; // inclusive

/** First day of the month containing d (UTC date). */
export function monthStart(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function monthEnd(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

/**
 * Split an inclusive period into calendar-month slices, prorated by days.
 * Cents only; the rounding remainder lands on the LAST slice so the slices
 * always sum to the amount. A period inside one month is one slice.
 *
 * @returns {Array<{month:string, start:string, end:string, days:number, amount:number}>}
 */
export function splitPeriodByMonth(periodStart, periodEnd, amount) {
  const start = parseDate(periodStart);
  const end = parseDate(periodEnd);
  if (end < start) throw new Error(`allocation: period_end ${periodEnd} is before period_start ${periodStart}`);
  const totalCents = toCents(amount);
  const totalDays = daysBetween(start, end);
  const slices = [];
  let cursor = start;
  while (cursor <= end) {
    const sliceEnd = monthEnd(cursor) < end ? monthEnd(cursor) : end;
    slices.push({ month: iso(monthStart(cursor)), start: iso(cursor), end: iso(sliceEnd), days: daysBetween(cursor, sliceEnd), amount: 0 });
    cursor = new Date(Date.UTC(sliceEnd.getUTCFullYear(), sliceEnd.getUTCMonth(), sliceEnd.getUTCDate() + 1));
  }
  let assigned = 0;
  slices.forEach((s, i) => {
    const cents = i === slices.length - 1 ? totalCents - assigned : Math.round((totalCents * s.days) / totalDays);
    s.amount = fromCents(cents);
    assigned += cents;
  });
  return slices;
}

/**
 * Allocate one slice amount across the eligible markets.
 *
 * @param {object} p
 * @param {number} p.amount            slice amount in dollars
 * @param {string[]} p.markets         eligible markets (deduped here)
 * @param {Record<string,number>} p.issuedByMarket  gross issued per market for the slice window
 * @returns {Array<{market:string, rule:string, issued_basis:number|null, issued_total:number|null, amount:number}>}
 */
export function allocateSlice({ amount, markets, issuedByMarket = {} }) {
  const eligible = [...new Set((markets || []).map((m) => String(m).trim()).filter(Boolean))].sort();
  if (!eligible.length) throw new Error('allocation: no eligible markets');
  const totalCents = toCents(amount);

  if (eligible.length === 1 && eligible[0] === HOLD_MARKET) {
    return [{ market: HOLD_MARKET, rule: 'hold', issued_basis: null, issued_total: null, amount: fromCents(totalCents) }];
  }
  if (eligible.length === 1) {
    const m = eligible[0];
    return [{ market: m, rule: 'direct', issued_basis: Number(issuedByMarket[m] || 0), issued_total: Number(issuedByMarket[m] || 0), amount: fromCents(totalCents) }];
  }

  const issued = Object.fromEntries(eligible.map((m) => [m, Math.max(0, Number(issuedByMarket[m] || 0))]));
  const issuedTotal = eligible.reduce((a, m) => a + issued[m], 0);
  const rule = issuedTotal > 0 ? 'proportional' : 'equal';

  const rows = eligible.map((m) => ({
    market: m, rule, issued_basis: issued[m], issued_total: issuedTotal,
    cents: rule === 'proportional' ? Math.floor((totalCents * issued[m]) / issuedTotal) : Math.floor(totalCents / eligible.length),
  }));
  // Leftover cents (floor rounding) go to the market with the most issued;
  // ties alphabetical (eligible is sorted, so the first max wins).
  const assigned = rows.reduce((a, r) => a + r.cents, 0);
  let leftover = totalCents - assigned;
  if (leftover !== 0) {
    const winner = rows.reduce((best, r) => (r.issued_basis > best.issued_basis ? r : best), rows[0]);
    winner.cents += leftover;
    leftover = 0;
  }
  const sum = rows.reduce((a, r) => a + r.cents, 0);
  if (sum !== totalCents) throw new Error(`allocation: slice sum ${sum} ≠ amount ${totalCents} cents`);
  return rows.map(({ cents, ...r }) => ({ ...r, amount: fromCents(cents) }));
}

/** True when the expense names no markets, so its source's issued leads pick them. */
export function splitsBySource(expense) {
  return !(expense?.eligible_markets || []).filter(Boolean).length;
}

/** The markets a by-source slice spreads over: every market with issued > 0. */
export function marketsFromIssued(issuedByMarket = {}) {
  return Object.keys(issuedByMarket).filter((m) => m && m !== HOLD_MARKET && Number(issuedByMarket[m]) > 0).sort();
}

/**
 * Allocate a whole expense: month slices × markets. `issuedLookup(month,
 * start, end)` returns gross issued per market for that slice's month
 * (restricted by the caller to the expense's sub-sources). Returns the rows
 * to insert into marketing_expense_allocations (without the expense_id).
 */
export function allocateExpense(expense, issuedLookup = () => ({})) {
  const bySource = splitsBySource(expense);
  const subs = (expense.lp_sub_sources || []).filter(Boolean);
  if (bySource && !subs.length) throw new Error('allocation: no markets and no sub-source to split by');
  const subSource = subs.length === 1 ? subs[0] : null;
  const out = [];
  for (const slice of splitPeriodByMonth(expense.period_start, expense.period_end, expense.amount)) {
    const issuedByMarket = issuedLookup(slice.month, slice.start, slice.end) || {};
    let markets = expense.eligible_markets || [];
    let note = null;
    if (bySource) {
      markets = marketsFromIssued(issuedByMarket);
      if (!markets.length) {
        markets = [HOLD_MARKET];
        note = `no ${subs.join(' / ')} issued leads in ${slice.month.slice(0, 7)} yet; split by source once there are (re-run nightly)`;
      }
    }
    for (const row of allocateSlice({ amount: slice.amount, markets, issuedByMarket })) {
      out.push({ month: slice.month, lp_sub_source: subSource, ...row, ...(note ? { note } : {}) });
    }
  }
  const total = out.reduce((a, r) => a + toCents(r.amount), 0);
  if (total !== toCents(expense.amount)) {
    throw new Error(`allocation: expense ${expense.id || '?'} allocations ${total} ≠ amount ${toCents(expense.amount)} cents`);
  }
  return out;
}

/** Sum of allocation amounts, in cents (for the reconciliation check). */
export function sumCents(rows) {
  return (rows || []).reduce((a, r) => a + toCents(r.amount), 0);
}
