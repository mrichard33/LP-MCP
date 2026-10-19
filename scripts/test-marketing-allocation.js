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

// 2026-10-19, the user: "hide fields when they're not needed".
import { buildEditView } from '../src/marketing/slack-review.js';
const ids = (v) => v.blocks.map((b) => b.block_id);
const DOCX = { id: '11111111-1111-4111-8111-111111111111' };
const pick = (value) => ({ selected_option: { value } });

test('Edit form shows only the fields the chosen cost needs', () => {
  const soft = buildEditView({ document: DOCX, facts: { vendor_name_hint: 'Unbounce' }, rows: [{ amount: 149, lp_sub_sources: ['Software'], eligible_markets: ['ALL_OFFICES'] }] });
  assert.deepEqual(ids(soft), ['vendor', 'new_vendor', 'invoice_number', 'period_start', 'period_end', 'amount', 'split', 'remember']);
  const lead = buildEditView({ document: DOCX, facts: {}, rows: [{ amount: 10, lp_sub_sources: ['Vis PPC'], eligible_markets: [] }] });
  assert.ok(ids(lead).includes('sub_source') && !ids(lead).includes('markets'));
  const pinned = buildEditView({ document: DOCX, facts: {}, rows: [{ amount: 10, lp_sub_sources: ['Vis PPC'], eligible_markets: ['REECE_HOLD'] }] });
  assert.ok(ids(pinned).includes('sub_source') && ids(pinned).includes('markets'));
  const vendor = buildEditView({ document: DOCX, vendor: { id: 'v1' }, vendors: [{ id: 'v1', vendor_name: 'Hatch' }], facts: {}, rows: [{ lp_sub_sources: ['Software'], eligible_markets: ['ALL_OFFICES'] }] });
  assert.ok(!ids(vendor).includes('new_vendor'), 'a picked vendor hides "New vendor"');
  for (const v of [soft, lead]) {
    assert.ok(v.blocks.find((b) => b.block_id === 'split').dispatch_action, 'the cost choice redraws the form');
    assert.ok(v.blocks.find((b) => b.block_id === 'vendor').dispatch_action, 'the vendor pick redraws the form');
  }
});

test('Edit form redraw follows the new choice and keeps what was typed, even a cleared box', () => {
  const rows = [{ amount: 149, lp_sub_sources: ['Software'], eligible_markets: ['ALL_OFFICES'] }];
  const state = {
    vendor: { mktinv_v_vendor: { selected_option: null } },
    new_vendor: { mktinv_v_new_vendor: { value: 'Unbounce' } },
    invoice_number: { mktinv_v_invoice_number: { value: null } },
    period_start: { mktinv_v_period_start: { selected_date: '2026-10-11' } },
    period_end: { mktinv_v_period_end: { selected_date: '2026-11-11' } },
    amount: { mktinv_v_amount: { value: '150' } },
    split: { mktinv_v_split: pick('markets') },
    remember: { mktinv_v_remember: { selected_options: [] } },
  };
  const v = buildEditView({ document: DOCX, facts: { invoice_number: '400' }, rows, state });
  assert.ok(ids(v).includes('sub_source') && ids(v).includes('markets'));
  const by = (id) => v.blocks.find((b) => b.block_id === id).element;
  assert.equal(by('amount').initial_value, '150');
  assert.equal(by('invoice_number').initial_value, '', 'a cleared box stays cleared');
  assert.equal(by('sub_source').initial_value, '', 'never prefilled with the "Software" category');
  assert.equal(by('markets').initial_options, undefined, 'ALL_OFFICES is not a market chip');
  assert.equal(by('remember').initial_options, undefined, 'an unticked Remember stays unticked');
  assert.equal(by('period_end').initial_date, '2026-11-11');
});

// 2026-10-19, the user: "why so many lines? combine per market".
import { groupLines, groupAllocations } from '../src/marketing/slack-review.js';
test('card combines repeated invoice lines and sums the allocation per month and market', () => {
  const r = (amount, description) => ({ amount, description, lp_sub_sources: ['Modernize'], eligible_markets: [] });
  const g = groupLines([r(85, 'FTLAU leads'), r(15, 'ORL leads'), r(132, 'FTLAU leads')]);
  assert.deepEqual(g.map((x) => [x.description, x.amount, x.count]), [['FTLAU leads', 217, 2], ['ORL leads', 15, 1]]);
  const a = (market, amount, basis) => ({ month: '2026-10-01', market, amount, rule: 'proportional', issued_basis: basis, issued_total: 30 });
  const sum = groupAllocations([a('ORL_MKT', 10.2, 9), a('FTLAU_MKT', 4.53, 4), a('ORL_MKT', 67.2, 9), a('FTLAU_MKT', 29.86, 4)]);
  assert.deepEqual(sum.map((x) => [x.market, x.amount, x.rule, x.issued_basis]), [['FTLAU_MKT', 34.39, 'proportional', 4], ['ORL_MKT', 77.4, 'proportional', 9]]);
  const mixed = groupAllocations([a('SAR_MKT', 5, 1), { month: '2026-10-01', market: 'SAR_MKT', amount: 5, rule: 'direct', issued_basis: 1, issued_total: 1 }]);
  assert.deepEqual([mixed[0].amount, mixed[0].rule], [10, null]);
});

// 2026-10-19, the user: per-market invoice lines go to the market printed on them;
// Lakeland → Orlando, BOCA → Fort Lauderdale.
import { marketFromLineText } from '../src/marketing/expense-builder.js';
import { buildDecisionReply } from '../src/marketing/slack-review.js';
test('an invoice line that prints one market goes to that market', () => {
  assert.equal(marketFromLineText('Account Level - BOCA - Total Leads (BOCA)'), 'FTLAU_MKT');
  assert.equal(marketFromLineText('Account Level - LAKE - Total Leads (LAKE)'), 'ORL_MKT');
  assert.equal(marketFromLineText('Account Level - FTMYR - Total Leads'), 'FTMYR_MKT');
  assert.equal(marketFromLineText('Leads - St. Petersburg'), 'STPET_MKT');
  assert.equal(marketFromLineText('Lake Worth homeowners'), null, 'a capital code only, never prose');
  assert.equal(marketFromLineText('ORL and JAX bundle'), null, 'two markets → split by source as before');
  assert.equal(marketFromLineText('Monthly subscription'), null);
  const vendor = { id: 'v', vendor_name: 'Modernize', lp_sub_sources: ['Modernize'], eligible_markets: [] };
  const facts = { invoice_number: '9', total: 300, period_start: '2026-10-09', period_end: '2026-10-15' };
  const analysis = { lines: [
    { description: 'Account Level - BOCA - Total Leads (BOCA)', amount: 198, lp_sub_source: 'Modernize', markets: [] },
    { description: 'Account Level - LAKE - Total Leads (LAKE)', amount: 30, lp_sub_source: 'Modernize', markets: [] },
    { description: 'Platform fee', amount: 72, lp_sub_source: 'Modernize', markets: [] },
  ] };
  const { rows } = buildExpenseRows({ document: { id: 'd' }, vendor, facts, analysis, confidence: 0.9 });
  assert.deepEqual(rows.map((r) => r.eligible_markets), [['FTLAU_MKT'], ['ORL_MKT'], []]);
});

test('Edit on an invoice whose lines carry their own markets never offers one market box for all', () => {
  const rows = [{ amount: 1, lp_sub_sources: ['Modernize'], eligible_markets: ['FTLAU_MKT'] }, { amount: 2, lp_sub_sources: ['Modernize'], eligible_markets: ['ORL_MKT'] }];
  const v = buildEditView({ document: DOCX, facts: {}, rows });
  assert.ok(!ids(v).includes('markets'));
  assert.ok(v.blocks.some((b) => b.type === 'context' && /printed on it/.test(b.elements[0].text)));
  assert.equal(marketsForSplit({ split: 'markets', eligible_markets: [] }), null, 'Save keeps each line\'s market');
});

test('the thread reply names who decided and the money per market', () => {
  const t = buildDecisionReply({ outcome: 'approved', by: 'mark', total: 300, allocation: [
    { month: '2026-10-01', market: 'FTLAU_MKT', amount: 100 }, { month: '2026-11-01', market: 'FTLAU_MKT', amount: 98 }, { month: '2026-10-01', market: 'ORL_MKT', amount: 102 }] });
  assert.equal(t, '✅ Approved by mark · $300.00\n• Fort Lauderdale: $198.00\n• Orlando: $102.00');
  assert.match(buildDecisionReply({ outcome: 'reopened', by: 'brad' }), /^🔓 Reopened by brad/);
});
