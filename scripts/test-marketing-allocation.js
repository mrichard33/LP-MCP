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

// 2026-10-19, the user: every LightFire charge goes to the office of the leads it
// was for ("10 demos at $250 each set in Fort Lauderdale ... all assigned to Fort
// Lauderdale. The same applies to the 1.5% sales"), never split evenly.
import { fakeSupabase } from './lib/fake-supabase.js';
test('a call-center demo / sales / canvass line goes to the offices of its leads; a fee stays even', async () => {
  const { allocateExpense, callCenterLineKind, splitKind } = await import('../src/marketing/allocation.js');
  const line = (description, amount) => ({ id: description, amount, period_start: '2026-08-23', period_end: '2026-08-31', description, lp_sub_sources: ['Call Center'], eligible_markets: ['ALL_OFFICES'] });
  const canvass = line('Canvas', 2910);
  const demos = line('Demos - AGED', 4250);
  const sales = line('Sales 1.5%', 3812.07);
  const fee = line('Credit Card Fee .035', 60);
  assert.deepEqual([canvass, demos, sales, fee].map(callCenterLineKind), ['canvass', 'demo', 'sales', null]);
  assert.equal(callCenterLineKind({ ...canvass, lp_sub_sources: ['Canvass'], eligible_markets: [] }), null, 'a canvass lead source is not a call-center line');
  assert.equal(callCenterLineKind({ ...demos, lp_sub_sources: ['Software'] }), null, 'only call-center cost');
  assert.equal(splitKind(demos), 'call_center_work');

  const tenInLauderdale = allocateExpense({ ...demos, amount: 2500 }, () => ({ FTLAU_MKT: 10 }));
  assert.deepEqual(tenInLauderdale.map((r) => [r.market, r.amount, r.lp_sub_source]), [['FTLAU_MKT', 2500, 'Call Center']]);
  const c = allocateExpense(canvass, () => ({ FTMYR_MKT: 71, STPET_MKT: 41, SAR_MKT: 33, ORL_MKT: 31, JAX_MKT: 18 }));
  assert.equal(c.reduce((t, r) => t + Math.round(r.amount * 100), 0), 291000);
  assert.equal(c.find((r) => r.market === 'FTMYR_MKT').amount, 1065, '71 of 194 × $15');
  const s = allocateExpense(sales, () => ({ FTMYR_MKT: 300000, ORL_MKT: 100000 }));
  assert.deepEqual(s.map((r) => [r.market, r.amount]), [['FTMYR_MKT', 2859.06], ['ORL_MKT', 953.01]], 'by net dollars, the leftover cent to the bigger');
  const even = allocateExpense(fee, () => { throw new Error('an even split reads nothing'); });
  assert.equal(even.length, 6);
  const none = allocateExpense(demos, () => ({}));
  assert.deepEqual(none.map((r) => [r.market, r.rule]), [['REECE_HOLD', 'hold']]);
  assert.match(none[0].note, /aged-lead demos it set found 2026-08-23\.\.2026-08-31/);
  assert.equal(splitLabel(demos), '_call center cost, by the office of the aged-lead demos it set_');
  assert.equal(splitChoice(sales), 'call_center');
});

test('call-center work per office: LF agents only, aged demos, new-lead sales by the job\'s market', async () => {
  const { callCenterWorkByMarketFor, previewAllocation } = await import('../src/marketing/allocation-io.js');
  const supabase = fakeSupabase({
    lp_leads: [
      { lp_lead_id: '1', lp_branch_id: '10' }, { lp_lead_id: '2', lp_branch_id: '20' }, { lp_lead_id: '3', lp_branch_id: null },
      { lp_lead_id: '4', lp_branch_id: '10' }, { lp_lead_id: '5', lp_branch_id: '20' },
    ],
    lp_branch_market_map: [{ brn_id: '10', market_code: 'FTLAU_MKT' }, { brn_id: '20', market_code: 'SAR_MKT' }],
    lp_lead_market_assignments: [{ lead_id: '3', resolved_market_code: 'ORL_MKT' }],
  });
  const lead = (id, over) => ({ lp_lead_id: id, lead_source: 'Data', created_at_lp: '2026-06-01T10:00:00+00:00', set_date: '2026-08-20T10:00:00+00:00', ever_sat: true, ...over });
  const store = {
    loadCanvassConfirms: async () => [
      lead('1', { lead_source: 'Canvass', confirmed_by_name: 'Smith - LF, Ann', confirmed_date: '2026-08-24T14:00:00+00:00' }),
      lead('3', { lead_source: 'Canvass Sticky', confirmed_by_name: 'Lee-LF, Cy', confirmed_date: '2026-08-25T14:00:00+00:00' }),
      lead('4', { lead_source: 'Canvass', confirmed_by_name: 'Garner, Chris', confirmed_date: '2026-08-25T14:00:00+00:00' }),
      lead('2', { lead_source: 'Canvass', confirmed_by_name: 'No, Setter', confirmed_date: '2026-08-25T14:00:00+00:00' }),
    ],
    loadDemos: async () => [
      lead('1', { set_by_name: 'Deer - LF, Craig', demo_date: '2026-08-25T14:00:00+00:00' }),
      lead('4', { set_by_name: 'Deer - LF, Craig', demo_date: '2026-08-26T14:00:00+00:00' }),
      lead('2', { set_by_name: 'Deer - LF, Craig', demo_date: '2026-08-26T14:00:00+00:00', created_at_lp: '2026-08-10T10:00:00+00:00' }),
      lead('5', { set_by_name: 'Garner, Chris', demo_date: '2026-08-26T14:00:00+00:00' }),
    ],
    load134: async () => ({ rows: [
      { job_number: 'J1', rtp_date: '2026-08-25', net_cents: 3000000, market: 'JAX_MKT' },
      { job_number: 'J2', rtp_date: '2026-08-26', net_cents: 1000000, market: null },
      { job_number: 'J3', rtp_date: '2026-08-27', net_cents: 5000000, market: 'FTLAU_MKT' },
      { job_number: 'J4', rtp_date: '2026-08-27', net_cents: 7000000, market: 'FTLAU_MKT' },
    ] }),
    matchJobsToLeads: async () => new Map([
      ['J1', { lead: lead('2', { set_by_name: 'Deer - LF, Craig', created_at_lp: '2026-08-10T10:00:00+00:00' }) }],
      ['J2', { lead: lead('5', { set_by_name: 'Gray-LF, Romeala', created_at_lp: '2026-08-15T10:00:00+00:00' }) }],
      ['J3', { lead: lead('1', { set_by_name: 'Deer - LF, Craig' }) }],
      ['J4', { lead: lead('4', { set_by_name: 'Garner, Chris', created_at_lp: '2026-08-15T10:00:00+00:00' }) }],
    ]),
  };
  const deps = { supabase, store, env: {} };
  const win = { from: '2026-08-23', to: '2026-08-31' };
  assert.deepEqual(await callCenterWorkByMarketFor({ kind: 'canvass', ...win }, deps), { FTLAU_MKT: 1, ORL_MKT: 1 }, 'LF confirmers only');
  assert.deepEqual(await callCenterWorkByMarketFor({ kind: 'demo', ...win }, deps), { FTLAU_MKT: 2 }, 'aged LF demos only');
  assert.deepEqual(await callCenterWorkByMarketFor({ kind: 'sales', ...win }, deps), { JAX_MKT: 30000, SAR_MKT: 10000 }, 'new LF leads only, whole dollars; the job\'s market, else the lead\'s');
  const rows = await previewAllocation({ id: 'd', amount: 500, period_start: '2026-08-23', period_end: '2026-08-31', description: 'Demos - AGED', lp_sub_sources: ['Call Center'], eligible_markets: ['ALL_OFFICES'] }, deps);
  assert.deepEqual(rows.map((r) => [r.market, r.amount]), [['FTLAU_MKT', 500]]);
});

test('a $0 line beside billed lines is dropped; an all-$0 invoice keeps its line', () => {
  const vendor = { id: 'lf', vendor_name: 'LightFire Partners', lp_sub_sources: ['Call Center'], eligible_markets: ['ALL_OFFICES'] };
  const facts = { invoice_number: '17734', total: 3812.07, period_start: '2026-08-16', period_end: '2026-08-31' };
  const { rows } = buildExpenseRows({ document: { id: 'd' }, vendor, facts, analysis: { lines: [
    { description: 'Demos - AGED', amount: 0 }, { description: 'Canvas', amount: 0 }, { description: 'Sales 1.5%', amount: 3812.07 },
  ] } });
  assert.deepEqual(rows.map((r) => [r.line_no, r.description, r.amount, r.lp_sub_sources, r.eligible_markets]), [[1, 'Sales 1.5%', 3812.07, ['Call Center'], ['ALL_OFFICES']]]);
  const allZero = buildExpenseRows({ document: { id: 'd' }, vendor, facts, analysis: { lines: [{ description: 'Canvas', amount: 0 }] } });
  assert.equal(allZero.rows.length, 1);
});

// 2026-10-19, the user: "accept an invoice as received and later amend it if a
// dispute arises … 9 leads were actually issued to an office, while 3 were
// overbilled." A dispute opens only when they billed MORE than we found.
import { callCenterGap, DISPUTED_MARKET } from '../src/marketing/allocation.js';
import { basisText, disputedTotal, buildReviewCard } from '../src/marketing/slack-review.js';
test('billed 12 demos, found 9: $2,250 to the offices of the 9, $750 Disputed; confirmed → all $3,000 by office', () => {
  const line = { id: 'd', amount: 3000, period_start: '2026-08-01', period_end: '2026-08-08', description: 'Demos - AGED', lp_sub_sources: ['Call Center'], eligible_markets: ['ALL_OFFICES'], flags: [] };
  const look = () => ({ weights: { FTLAU_MKT: 5, SAR_MKT: 4 }, unitPrice: 250 });
  const rows = allocateExpense(line, look);
  assert.deepEqual(rows.map((r) => [r.market, r.amount]), [['FTLAU_MKT', 1250], ['SAR_MKT', 1000], [DISPUTED_MARKET, 750]]);
  const d = rows.find((r) => r.market === DISPUTED_MARKET);
  assert.equal(d.rule, 'hold');
  assert.equal(d.note, 'billed 12 aged-lead demos, found 9: 3 not found ($750.00)');
  assert.equal(sumCents(rows), 300000);
  const accepted = allocateExpense({ ...line, flags: ['dispute_accepted'] }, look);
  assert.deepEqual(accepted.map((r) => [r.market, r.amount]), [['FTLAU_MKT', 1666.67], ['SAR_MKT', 1333.33]]);
  const credited = allocateExpense({ ...line, amount: 2250, flags: ['dispute_credited'] }, look);
  assert.deepEqual(credited.map((r) => [r.market, r.amount]), [['FTLAU_MKT', 1250], ['SAR_MKT', 1000]], 'after the credit the offices keep exactly what they had');
  assert.deepEqual(allocateExpense(line, () => ({ weights: {}, unitPrice: 250 })).map((r) => [r.market, r.amount]), [[DISPUTED_MARKET, 3000]], 'nothing found: all disputed');
  assert.deepEqual(allocateExpense(line, () => ({ weights: { FTLAU_MKT: 9 }, unitPrice: null })).map((r) => r.market), ['FTLAU_MKT'], 'no price on file: no dispute can be told');
});

test('sales: finding MORE than billed splits normally; finding less parks the difference', () => {
  const sales = { id: 's', amount: 2538.81, period_start: '2026-08-01', period_end: '2026-08-15', description: 'Sales 169,254 x 0.015', lp_sub_sources: ['Call Center'], eligible_markets: ['ALL_OFFICES'] };
  const found = { FTMYR_MKT: 41827, ORL_MKT: 60984, SAR_MKT: 37560, STPET_MKT: 39141 };
  const rows = allocateExpense(sales, () => ({ weights: found, unitPrice: 0.015 }));
  assert.ok(rows.every((r) => r.market !== DISPUTED_MARKET));
  assert.equal(rows.find((r) => r.market === 'FTMYR_MKT').issued_basis, 41827, 'whole dollars of sales, as the card prints them');
  assert.equal(basisText({ ...rows.find((r) => r.market === 'FTMYR_MKT'), kind: 'sales' }), ' ($41,827 of $179,512 in sales)');
  const gap = callCenterGap({ amount: 2538.81, weights: { FTMYR_MKT: 100000 }, unitPrice: 0.015, kind: 'sales' });
  assert.deepEqual([gap.matched, gap.disputed], [1500, 1038.81]);
  assert.equal(gap.note, 'billed on $169,254 in sales, found $100,000: $69,254 of sales not found ($1,038.81)');
  assert.equal(callCenterGap({ amount: 2538.81, weights: { FTMYR_MKT: 169200 }, unitPrice: 0.015, kind: 'sales' }), null, 'under a dollar is rounding');
  assert.equal(callCenterGap({ amount: 3000, weights: { FTLAU_MKT: 12 }, unitPrice: 250, kind: 'demo' }), null);
});

test('the card says what each split was based on, and a decided card with a dispute can settle it', () => {
  assert.equal(basisText({ market: 'SAR_MKT', rule: 'proportional', issued_basis: 3, issued_total: 9, kind: 'demo' }), ' (3 of 9 aged-lead demos)');
  assert.equal(basisText({ market: 'SAR_MKT', rule: 'proportional', issued_basis: 12, issued_total: 40 }), ' (12 of 40 issued leads)');
  assert.equal(basisText({ market: 'SAR_MKT', rule: 'equal' }), ' (split evenly)');
  assert.equal(basisText({ market: DISPUTED_MARKET, rule: 'hold' }), '');
  const allocation = [
    { month: '2026-08-01', market: 'FTLAU_MKT', amount: 1250, rule: 'proportional', issued_basis: 5, issued_total: 9, kind: 'demo' },
    { month: '2026-08-01', market: DISPUTED_MARKET, amount: 750, rule: 'hold', note: 'billed 12 aged-lead demos, found 9: 3 not found ($750.00)', kind: 'demo' },
  ];
  assert.equal(disputedTotal(allocation), 750);
  const rows = [{ id: 'd', amount: 3000, description: 'Demos - AGED', lp_sub_sources: ['Call Center'], eligible_markets: ['ALL_OFFICES'] }];
  const preview = buildReviewCard({ document: DOCX, facts: { invoice_number: '17638' }, rows, allocation });
  const text = JSON.stringify(preview.blocks);
  assert.match(text, /Fort Lauderdale · demos: \$1,250\.00 \(5 of 9 aged-lead demos\)/);
  assert.match(text, /Disputed \(not charged to any office\): \$750\.00 _billed 12 aged-lead demos, found 9: 3 not found/);
  assert.doesNotMatch(text, /issued\)/);
  assert.match(text, /Accepts \$3,000\.00 as received\. \$2,250\.00 goes to the offices; \$750\.00 sits as Disputed/);
  const done = buildReviewCard({ document: DOCX, facts: {}, rows, allocation, decision: { outcome: 'approved', by: 'mark', at: 'x' } });
  const ids = done.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id));
  assert.deepEqual(ids, ['mktinv_dispute_accept', 'mktinv_dispute_credit', 'mktinv_reopen']);
  const clean = buildReviewCard({ document: DOCX, facts: {}, rows, allocation: allocation.slice(0, 1), decision: { outcome: 'approved', by: 'mark', at: 'x' } });
  assert.deepEqual(clean.blocks.filter((b) => b.type === 'actions').flatMap((b) => b.elements.map((e) => e.action_id)), ['mktinv_reopen']);
});

import { handleMarketingInvoiceInteraction, replaceEarlierInvoice } from '../src/marketing/review-actions.js';
import { parseMarketingInvoiceInteraction } from '../src/slack-approvals-core.js';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
function disputedDb() {
  return fakeSupabase({
    marketing_invoice_documents: [{ id: DOC_ID, status: 'posted', analysis: { facts: { invoice_number: '17638' } }, slack_channel: 'C1', slack_ts: '1.1' }],
    marketing_expenses: [{ id: 'e1', document_id: DOC_ID, line_no: 1, status: 'approved', approved_by: 'mark (U_MARK)', approved_at: '2026-10-19T18:00:00Z', amount: 3000, description: 'Demos - AGED', lp_sub_sources: ['Call Center'], eligible_markets: ['ALL_OFFICES'], flags: [], invoice_number: '17638', vendor_id: 'lf' }],
    marketing_expense_allocations: [
      { expense_id: 'e1', month: '2026-08-01', market: 'FTLAU_MKT', amount: 2250, rule: 'proportional' },
      { expense_id: 'e1', month: '2026-08-01', market: DISPUTED_MARKET, amount: 750, rule: 'hold', recommendation_reason: 'billed 12 …' },
    ],
  });
}
const click = (decision) => ({ kind: 'mktinv', decision, documentId: DOC_ID, userId: 'U_MARK', userName: 'mark', responseUrl: 'https://hooks.slack.com/x' });
const settleDeps = (supabase, sink) => ({ supabase, approvers: new Set(['U_MARK']), reply: async (_u, b) => sink.replies.push(b), allocate: async (id) => sink.allocated.push(id), signedLink: async () => null, postToSlack: async (t) => { sink.thread.push(t); return { ok: true }; }, updateSlackMessage: async () => ({ ok: true }) });

test('Credit received: the line drops by the disputed $750, the credit is recorded, the line re-splits', async () => {
  const supabase = disputedDb();
  const sink = { replies: [], allocated: [], thread: [] };
  const r = await handleMarketingInvoiceInteraction(click('dispute_credit'), settleDeps(supabase, sink));
  assert.equal(r.action, 'dispute_credited');
  const e = supabase.tables.marketing_expenses[0];
  assert.equal(e.amount, 2250);
  assert.ok(e.flags.includes('dispute_credited'));
  assert.deepEqual(sink.allocated, ['e1']);
  assert.equal(supabase.tables.marketing_invoice_documents[0].analysis.credits[0].credited, 750);
  assert.match(sink.thread[0], /\$750\.00 credit recorded by mark/);
});

test('Confirm charge: flagged accepted and re-split; with nothing disputed the click changes nothing', async () => {
  const supabase = disputedDb();
  const sink = { replies: [], allocated: [], thread: [] };
  const r = await handleMarketingInvoiceInteraction(click('dispute_accept'), settleDeps(supabase, sink));
  assert.equal(r.action, 'dispute_accepted');
  assert.equal(supabase.tables.marketing_expenses[0].amount, 3000);
  assert.ok(supabase.tables.marketing_expenses[0].flags.includes('dispute_accepted'));
  supabase.tables.marketing_expense_allocations = supabase.tables.marketing_expense_allocations.filter((a) => a.market !== DISPUTED_MARKET);
  const again = await handleMarketingInvoiceInteraction(click('dispute_credit'), settleDeps(supabase, sink));
  assert.equal(again.action, 'nothing_disputed');
});

test('a revised invoice with the same number replaces the approved original', async () => {
  const supabase = disputedDb();
  const r = await replaceEarlierInvoice({ documentId: 'NEW', rows: [{ invoice_number: '17638', vendor_id: 'lf' }], by: 'mark', now: '2026-10-20T00:00:00Z' }, { supabase });
  assert.deepEqual([r.invoice_number, r.lines, r.amount], ['17638', 1, 3000]);
  assert.equal(supabase.tables.marketing_expenses[0].status, 'superseded');
  assert.equal(supabase.tables.marketing_expense_allocations.length, 0, 'the original is out of the market costs');
  assert.equal(supabase.tables.marketing_invoice_documents[0].analysis.replaced_by, 'NEW');
  assert.equal(await replaceEarlierInvoice({ documentId: 'NEW', rows: [{ invoice_number: '99', vendor_id: 'lf' }], by: 'mark', now: 'x' }, { supabase }), null);
});

test('the settle buttons reach the handler', () => {
  for (const id of ['mktinv_dispute_accept', 'mktinv_dispute_credit']) {
    const p = parseMarketingInvoiceInteraction(`payload=${encodeURIComponent(JSON.stringify({ type: 'block_actions', user: { id: 'U_MARK', name: 'mark' }, actions: [{ action_id: id, value: DOC_ID }] }))}`);
    assert.equal(p?.decision, id.replace('mktinv_', ''));
  }
});
