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

/**
 * Billed but not found (the user, 2026-10-19: "accept an invoice as received
 * and later amend it if a dispute arises … it should be clear that 9 leads
 * were actually issued to an office, while 3 were overbilled"). The part of a
 * call-center line we cannot match to its leads sits here: not charged to any
 * office, shown as Disputed, until a revised invoice replaces it, the charge is
 * confirmed, or a credit comes off it. Stored with rule 'hold' (the rule CHECK
 * allows no other parked rule); the market keeps it apart from REECE_HOLD.
 */
export const DISPUTED_MARKET = 'DISPUTED';

/**
 * Company-wide spend (the user, 2026-10-13: "For software that doesn't generate
 * leads for a specific office, distribute it evenly across all offices", e.g.
 * Hatch). A line whose eligible_markets holds ALL_OFFICES is split EQUALLY over
 * OFFICE_MARKETS, whatever the issued leads say, and needs no sub-source; its
 * allocation rows carry the sub-source typed on the line, else COMPANY_WIDE.
 * The six offices are the six markets (Lakeland is Orlando); Houston and
 * Winston-Salem are service areas without an office of their own.
 */
export const ALL_OFFICES = 'ALL_OFFICES';
export const OFFICE_MARKETS = Object.freeze(['FTLAU_MKT', 'FTMYR_MKT', 'JAX_MKT', 'ORL_MKT', 'SAR_MKT', 'STPET_MKT']);
export const COMPANY_WIDE = 'Company-wide';

/** True when the line is company-wide spend split evenly over every office. */
export function splitsEvenly(expense) {
  return (expense?.eligible_markets || []).includes(ALL_OFFICES);
}

/**
 * The two kinds of company-wide spend (the user, 2026-10-14: "we should add a
 * call-center cost and a software cost, each split among all offices"). An
 * invoice assigned to one is split evenly over OFFICE_MARKETS and its line
 * carries the category as its sub-source, so the report shows "Call Center"
 * and "Software" as their own rows next to the lead sources.
 */
export const COST_CATEGORIES = Object.freeze({ call_center: 'Call Center', software: 'Software' });

/** 'call_center' | 'software' for an even-split line carrying that label, else null. */
export function costCategory(expense) {
  if (!splitsEvenly(expense)) return null;
  const subs = (expense?.lp_sub_sources || []).map((s) => String(s).trim().toLowerCase());
  return Object.keys(COST_CATEGORIES).find((k) => subs.includes(COST_CATEGORIES[k].toLowerCase())) || null;
}

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

/**
 * A call center's charges go to the offices whose leads they were for (the
 * user, 2026-10-19: "if there were 10 demos at $250 each set in Fort
 * Lauderdale, then those should all be assigned to Fort Lauderdale. The same
 * applies to the 1.5% sales"). LightFire bills three kinds of line, each read
 * from its description and weighted by the leads payroll pays it for
 * (src/payroll/rules.js), in the line's own days:
 *   canvass  "61 Canvas", $15 a confirmation → canvass appointments its agents confirmed
 *   demo     "Demos - AGED", $250 a demo     → aged-lead demos its agents set
 *   sales    "Sales 1.5%"                    → net dollars RTP'd on new leads its agents set
 * Still "Call Center" cost. A call-center line naming none of them (a fee)
 * stays split evenly. Read from the description, not stored on the row, so an
 * Edit back to "call center cost" keeps it.
 */
const CALL_CENTER_LINE_KINDS = Object.freeze([
  ['canvass', /\bcanvas{1,2}\b/i],
  ['demo', /\bdemos?\b/i],
  ['sales', /\bsales\b/i],
]);
export function callCenterLineKind(expense) {
  if (costCategory(expense) !== 'call_center') return null;
  const d = String(expense?.description || '');
  return CALL_CENTER_LINE_KINDS.find(([, rx]) => rx.test(d))?.[0] || null;
}
/** What one unit of a kind's weight is, for the card and the dispute note. */
export const CALL_CENTER_UNIT = Object.freeze({
  canvass: { one: 'canvass confirmation', many: 'canvass confirmations', dollars: false },
  demo: { one: 'aged-lead demo', many: 'aged-lead demos', dollars: false },
  sales: { one: 'dollar of sales', many: 'in sales', dollars: true },
});

const usd0 = (d) => `$${Math.round(d).toLocaleString('en-US')}`;
const usd2 = (d) => `$${Number(d).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Billed more than we found (the user, 2026-10-19: a dispute opens only when
 * they billed MORE than we found; finding more just splits normally). `weights`
 * are the found units per office (a count, or whole dollars of sales);
 * `unitPrice` is the dollars billed per unit ($250 a demo, $15 a canvass
 * confirmation, 0.015 per dollar of sales), from pay_rules. Unknown price → no
 * dispute can be told. A gap under half a unit (a dollar for sales) is rounding.
 * Returns null, or { matched, disputed, note } in dollars.
 */
export function callCenterGap({ amount, weights = {}, unitPrice, kind }) {
  if (!(Number(unitPrice) > 0) || !CALL_CENTER_UNIT[kind]) return null;
  const found = Object.entries(weights).filter(([m]) => m !== HOLD_MARKET && m !== DISPUTED_MARKET).reduce((a, [, v]) => a + Math.max(0, Number(v) || 0), 0);
  const amountC = toCents(amount);
  const matchedC = Math.min(amountC, Math.round(found * unitPrice * 100));
  const gapC = amountC - matchedC;
  const unit = CALL_CENTER_UNIT[kind];
  if (gapC < (unit.dollars ? 100 : Math.round(unitPrice * 50))) return null;
  const billed = amount / unitPrice;
  const note = unit.dollars
    ? `billed on ${usd0(billed)} in sales, found ${usd0(found)}: ${usd0(billed - found)} of sales not found (${usd2(gapC / 100)})`
    : `billed ${Math.round(billed)} ${unit.many}, found ${found}: ${Math.round(billed) - found} not found (${usd2(gapC / 100)})`;
  return { matched: fromCents(matchedC), disputed: fromCents(gapC), note };
}

export const CALL_CENTER_KIND_LABEL = Object.freeze({
  canvass: 'canvass appointments it confirmed', demo: 'aged-lead demos it set', sales: 'sales on leads it set',
});

/** True when the expense names no markets, so its source's issued leads pick them. */
export function splitsBySource(expense) {
  return !(expense?.eligible_markets || []).filter(Boolean).length;
}

/** The plain-English split for a line, for the card and the Edit form. */
export function splitKind(expense) {
  if (callCenterLineKind(expense)) return 'call_center_work';
  if (splitsEvenly(expense)) return 'even';
  if (splitsBySource(expense)) return 'by_source';
  return 'markets';
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
  // A call center's demo / sales / canvass line: `issuedLookup` returns that
  // work per office for the slice's own days, and those pick the offices.
  const workKind = callCenterLineKind(expense);
  const even = !workKind && splitsEvenly(expense);
  const bySource = !even && !workKind && splitsBySource(expense);
  const subs = (expense.lp_sub_sources || []).filter(Boolean);
  if (bySource && !subs.length) throw new Error('allocation: no markets and no sub-source to split by');
  const subSource = subs.length === 1 ? subs[0] : (even && !subs.length ? COMPANY_WIDE : null);
  const out = [];
  for (const slice of splitPeriodByMonth(expense.period_start, expense.period_end, expense.amount)) {
    // An even split ignores issued leads entirely: every office pays the same.
    const looked = even ? {} : (issuedLookup(slice.month, slice.start, slice.end) || {});
    // A call-center line's lookup answers { weights, unitPrice }; anything else is a weight map.
    const work = workKind && looked && typeof looked === 'object' && 'weights' in looked ? looked : null;
    const issuedByMarket = work ? (work.weights || {}) : looked;
    let markets = even ? [...OFFICE_MARKETS] : (expense.eligible_markets || []);
    let note = null;
    if (workKind) {
      markets = marketsFromIssued(issuedByMarket);
      const accepted = (expense.flags || []).includes('dispute_accepted');
      const gap = accepted ? null : callCenterGap({ amount: slice.amount, weights: issuedByMarket, unitPrice: work?.unitPrice, kind: workKind });
      if (gap) {
        if (gap.matched > 0 && markets.length) {
          for (const row of allocateSlice({ amount: gap.matched, markets, issuedByMarket })) out.push({ month: slice.month, lp_sub_source: subSource, ...row });
        }
        out.push({ month: slice.month, lp_sub_source: subSource, market: DISPUTED_MARKET, rule: 'hold', issued_basis: null, issued_total: null, amount: gap.disputed, note: gap.note });
        continue;
      }
      if (!markets.length) {
        markets = [HOLD_MARKET];
        note = `no call-center ${CALL_CENTER_KIND_LABEL[workKind]} found ${slice.start}..${slice.end} yet; split by office once they sync (re-run nightly)`;
      }
    } else if (bySource) {
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
