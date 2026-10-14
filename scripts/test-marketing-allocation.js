/**
 * test-marketing-allocation.js — the cent rules of src/marketing/allocation.js
 * (handoff 2026-10-12 §11.3). Offline, no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { allocateSlice, allocateExpense, splitPeriodByMonth, sumCents, HOLD_MARKET } from '../src/marketing/allocation.js';

const byMarket = (rows) => Object.fromEntries(rows.map((r) => [r.market, r.amount]));

test('$100 across FTLAU + SAR with 3/1 issued → $75 / $25', () => {
  const rows = allocateSlice({ amount: 100, markets: ['FTLAU_MKT', 'SAR_MKT'], issuedByMarket: { FTLAU_MKT: 3, SAR_MKT: 1 } });
  assert.deepEqual(byMarket(rows), { FTLAU_MKT: 75, SAR_MKT: 25 });
  assert.ok(rows.every((r) => r.rule === 'proportional' && r.issued_total === 4));
});

test('$500 SAR only, 0 issued → $500 direct', () => {
  const rows = allocateSlice({ amount: 500, markets: ['SAR_MKT'], issuedByMarket: {} });
  assert.deepEqual(rows, [{ market: 'SAR_MKT', rule: 'direct', issued_basis: 0, issued_total: 0, amount: 500 }]);
});

test('$900 across 3 markets, 0 issued → $300 each (equal)', () => {
  const rows = allocateSlice({ amount: 900, markets: ['ORL_MKT', 'SAR_MKT', 'JAX_MKT'] });
  assert.deepEqual(byMarket(rows), { JAX_MKT: 300, ORL_MKT: 300, SAR_MKT: 300 });
  assert.ok(rows.every((r) => r.rule === 'equal'));
});

test('$100 across 3 equal → 33.34 / 33.33 / 33.33, leftover cent to the alphabetical first on a tie', () => {
  const rows = allocateSlice({ amount: 100, markets: ['SAR_MKT', 'JAX_MKT', 'ORL_MKT'] });
  assert.deepEqual(byMarket(rows), { JAX_MKT: 33.34, ORL_MKT: 33.33, SAR_MKT: 33.33 });
  assert.equal(sumCents(rows), 10000);
});

test('leftover cent goes to the market with the most issued', () => {
  const rows = allocateSlice({ amount: 100, markets: ['A_MKT', 'B_MKT', 'C_MKT'], issuedByMarket: { A_MKT: 1, B_MKT: 1, C_MKT: 1 } });
  assert.equal(sumCents(rows), 10000);
  // 33.33 each = 99.99; the extra cent lands on the first max (alphabetical)
  assert.equal(rows.find((r) => r.market === 'A_MKT').amount, 33.34);
  const rows2 = allocateSlice({ amount: 100, markets: ['A_MKT', 'B_MKT', 'C_MKT'], issuedByMarket: { A_MKT: 1, B_MKT: 2, C_MKT: 1 } });
  assert.deepEqual(byMarket(rows2), { A_MKT: 25, B_MKT: 50, C_MKT: 25 });
});

test('never a non-eligible market, even when it has issued leads', () => {
  const rows = allocateSlice({ amount: 100, markets: ['FTMYR_MKT', 'SAR_MKT'], issuedByMarket: { FTMYR_MKT: 2, SAR_MKT: 2, STPET_MKT: 50 } });
  assert.deepEqual(Object.keys(byMarket(rows)).sort(), ['FTMYR_MKT', 'SAR_MKT']);
  assert.deepEqual(byMarket(rows), { FTMYR_MKT: 50, SAR_MKT: 50 });
});

test('REECE_HOLD alone → hold, never spread', () => {
  const rows = allocateSlice({ amount: 2529.34, markets: [HOLD_MARKET], issuedByMarket: { FTMYR_MKT: 10 } });
  assert.deepEqual(rows, [{ market: HOLD_MARKET, rule: 'hold', issued_basis: null, issued_total: null, amount: 2529.34 }]);
});

test('no eligible markets throws', () => {
  assert.throws(() => allocateSlice({ amount: 10, markets: [] }), /no eligible markets/);
});

test('a Sep 20 – Oct 10 period splits by days (11 + 10) and the slices sum to the amount', () => {
  const slices = splitPeriodByMonth('2026-09-20', '2026-10-10', 210);
  assert.equal(slices.length, 2);
  assert.deepEqual(slices.map((s) => [s.month, s.days, s.amount]), [['2026-09-01', 11, 110], ['2026-10-01', 10, 100]]);
  // odd cents: remainder lands on the last slice
  const odd = splitPeriodByMonth('2026-09-20', '2026-10-10', 100);
  assert.equal(odd[0].amount + odd[1].amount, 100);
  assert.equal(odd[0].amount, 52.38);
  assert.equal(odd[1].amount, 47.62);
});

test('a one-day period is one slice', () => {
  const slices = splitPeriodByMonth('2026-09-22', '2026-09-22', 12936.69);
  assert.deepEqual(slices, [{ month: '2026-09-01', start: '2026-09-22', end: '2026-09-22', days: 1, amount: 12936.69 }]);
});

test('allocateExpense: per slice issued counts, single sub-source carried, total reconciles', () => {
  const expense = {
    id: 'e1', amount: 210, period_start: '2026-09-20', period_end: '2026-10-10',
    lp_sub_sources: ['MyHomePros'], eligible_markets: ['FTMYR_MKT', 'SAR_MKT'],
  };
  const lookup = (month) => (month === '2026-09-01' ? { FTMYR_MKT: 1, SAR_MKT: 0 } : {});
  const rows = allocateExpense(expense, lookup);
  assert.equal(sumCents(rows), 21000);
  const sep = rows.filter((r) => r.month === '2026-09-01');
  const oct = rows.filter((r) => r.month === '2026-10-01');
  assert.deepEqual(byMarket(sep), { FTMYR_MKT: 110, SAR_MKT: 0 });
  assert.ok(sep.every((r) => r.rule === 'proportional' && r.lp_sub_source === 'MyHomePros'));
  assert.deepEqual(byMarket(oct), { FTMYR_MKT: 50, SAR_MKT: 50 });
  assert.ok(oct.every((r) => r.rule === 'equal'));
});

test('allocateExpense: several sub-sources → lp_sub_source null (the view keys on "(none)")', () => {
  const rows = allocateExpense({ amount: 10, period_start: '2026-09-01', period_end: '2026-09-30', lp_sub_sources: ['A', 'B'], eligible_markets: ['SAR_MKT'] });
  assert.equal(rows[0].lp_sub_source, null);
});

// 2026-10-13 (the user): no markets picked → the sub-source's gross issued leads pick them.
test('by source: no markets picked splits over every market with issued leads for that sub-source', async () => {
  const { allocateExpense, splitsBySource, marketsFromIssued } = await import('../src/marketing/allocation.js');
  const e = { id: 'e', amount: 3624.6, period_start: '2026-09-02', period_end: '2026-09-02', lp_sub_sources: ['Vis PPC'], eligible_markets: [] };
  assert.equal(splitsBySource(e), true);
  assert.equal(splitsBySource({ ...e, eligible_markets: ['STPET_MKT'] }), false);
  assert.deepEqual(marketsFromIssued({ STPET_MKT: 2, ORL_MKT: 0, REECE_HOLD: 4 }), ['STPET_MKT']);
  const rows = allocateExpense(e, () => ({ STPET_MKT: 2, ORL_MKT: 0 }));
  assert.deepEqual(rows.map((r) => [r.market, r.amount, r.rule]), [['STPET_MKT', 3624.6, 'direct']]);
  const two = allocateExpense(e, () => ({ STPET_MKT: 3, SAR_MKT: 1 }));
  assert.deepEqual(two.map((r) => [r.market, r.amount, r.rule]), [['SAR_MKT', 906.15, 'proportional'], ['STPET_MKT', 2718.45, 'proportional']]);
  const none = allocateExpense(e, () => ({}));
  assert.deepEqual(none.map((r) => [r.market, r.amount, r.rule]), [['REECE_HOLD', 3624.6, 'hold']]);
  assert.match(none[0].note, /no Vis PPC issued leads in 2026-09 yet/);
  assert.throws(() => allocateExpense({ ...e, lp_sub_sources: [] }, () => ({})), /no markets and no sub-source/);
});

test('the issued basis for a slice is its whole calendar month, not the days the slice covers', async () => {
  const { previewAllocation } = await import('../src/marketing/allocation-io.js');
  const calls = [];
  const supabase = { rpc: async (_fn, args) => { calls.push(args); return { data: [{ market: 'STPET_MKT', lp_sub_source: 'Vis PPC', issued: 2 }], error: null }; } };
  const rows = await previewAllocation({ id: 'e', amount: 100, period_start: '2026-10-02', period_end: '2026-10-02', lp_sub_sources: ['Vis PPC'], eligible_markets: [] }, { supabase });
  assert.deepEqual(calls, [{ p_from: '2026-10-01', p_to: '2026-10-31' }]);
  assert.deepEqual(rows.map((r) => [r.market, r.amount]), [['STPET_MKT', 100]]);
});

// 2026-10-14, the user: a call-center cost and a software cost, each split among all offices.
import { costCategory, COST_CATEGORIES, OFFICE_MARKETS } from '../src/marketing/allocation.js';
import { SPLIT_OPTIONS, splitChoice, splitLabel, marketsForSplit, subSourcesForSplit } from '../src/marketing/slack-review.js';
import { buildExpenseRows } from '../src/marketing/expense-builder.js';

test('call center and software: even over the six offices, the category on every allocation row', () => {
  for (const [key, label] of Object.entries(COST_CATEGORIES)) {
    const e = { id: key, amount: 1000, period_start: '2026-10-01', period_end: '2026-10-31', lp_sub_sources: [label], eligible_markets: ['ALL_OFFICES'] };
    assert.equal(costCategory(e), key);
    const rows = allocateExpense(e, () => ({ STPET_MKT: 99 }));
    assert.deepEqual(rows.map((r) => r.market).sort(), [...OFFICE_MARKETS].sort());
    assert.ok(rows.every((r) => r.rule === 'equal' && r.lp_sub_source === label));
    assert.equal(sumCents(rows), 100000);
  }
  assert.equal(costCategory({ lp_sub_sources: ['Software'], eligible_markets: [] }), null, 'a category needs the even split');
});

test('the Edit form offers call center and software, and reads a line back to its choice', () => {
  assert.deepEqual(SPLIT_OPTIONS.map(([v]) => v), ['by_source', 'call_center', 'software', 'markets']);
  assert.ok(SPLIT_OPTIONS.every(([, l]) => l.length <= 75), 'Slack option text limit');
  assert.equal(splitChoice({ lp_sub_sources: ['Call Center'], eligible_markets: ['ALL_OFFICES'] }), 'call_center');
  assert.equal(splitChoice({ lp_sub_sources: [], eligible_markets: ['ALL_OFFICES'] }), 'software', 'an unlabelled even split reads as software');
  assert.equal(splitChoice({ lp_sub_sources: ['Vis PPC'], eligible_markets: [] }), 'by_source');
  assert.equal(splitChoice({ lp_sub_sources: ['Vis PPC'], eligible_markets: ['ORL_MKT'] }), 'markets');
  assert.match(splitLabel({ lp_sub_sources: ['Software'], eligible_markets: ['ALL_OFFICES'] }), /software cost, split evenly across all offices/);
  assert.deepEqual(marketsForSplit({ split: 'call_center' }), ['ALL_OFFICES']);
  assert.deepEqual(marketsForSplit({ split: 'software', eligible_markets: ['ORL_MKT'] }), ['ALL_OFFICES']);
  assert.deepEqual(subSourcesForSplit({ split: 'software', lp_sub_sources: ['Vis PPC'] }), ['Software']);
  assert.deepEqual(subSourcesForSplit({ split: 'by_source', lp_sub_sources: ['software', 'Vis PPC'] }), ['Vis PPC']);
  assert.deepEqual(subSourcesForSplit({ split: null, lp_sub_sources: ['Vis PPC'] }), ['Vis PPC']);
});

test('a vendor split evenly keeps its category and split whatever the model guessed for a line', () => {
  const vendor = { id: 'v', vendor_name: 'Five9', lp_sub_sources: ['Call Center'], eligible_markets: ['ALL_OFFICES'] };
  const facts = { invoice_number: '1', total: 500, period_start: '2026-10-01', period_end: '2026-10-31' };
  const analysis = { lines: [{ description: 'Seats', amount: 500, lp_sub_source: 'Vis PPC', markets: ['ORL_MKT'] }] };
  const { rows, lineProblems } = buildExpenseRows({ document: { id: 'd' }, vendor, facts, analysis, confidence: 0.9 });
  assert.deepEqual(lineProblems, []);
  assert.deepEqual([rows[0].lp_sub_sources, rows[0].eligible_markets], [['Call Center'], ['ALL_OFFICES']]);
});
