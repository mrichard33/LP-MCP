/**
 * test-marketing-cost-jobs.js — commission rows (D2 × D8), hold
 * recommendations (D4), the nightly run, and the Brad-format report model +
 * workbook (formulas, never typed values). Offline; scripts/lib/fake-supabase.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { fakeSupabase } from './lib/fake-supabase.js';
import { buildCommissionRows, recomputeCalculatedCosts } from '../src/marketing/commission.js';
import { summarizeRecommendation, matchHeldLeads, recommendHolds } from '../src/marketing/holds.js';
import { runMarketingCostNightly, defaultMonths } from '../src/jobs/marketing-cost-nightly.js';
import { buildMarketModel, COMPANY } from '../src/marketing/report.js';
import { buildWorkbook, readWorkbook } from '../src/marketing/report-xlsx.js';
import { runMarketingReport, defaultReportMonth } from '../src/jobs/marketing-cost-report.js';

const RULES = [
  { id: 'r-canvass', lp_sub_sources: ['Canvass', 'Canvass Sticky'], rate: 0.15, label: 'Canvass 15% of net', effective_from: '2026-01-01', effective_to: null },
  { id: 'r-mvp', lp_sub_sources: ['MVP Marketing'], rate: 0.15, label: 'MVP Marketing 15% of net', effective_from: '2026-01-01', effective_to: null },
  { id: 'r-ref', lp_sub_sources: ['Previous Customer', 'Customer Referral'], rate: 0.01, label: 'Previous Customer / Referral 1% of net', effective_from: '2026-01-01', effective_to: null },
  { id: 'r-old', lp_sub_sources: ['Canvass'], rate: 0.5, label: 'expired', effective_from: '2025-01-01', effective_to: '2025-12-31' },
];
const DOLLARS = [
  { market: 'FTMYR_MKT', lp_sub_source: 'MVP Marketing', gross: 14916, working: 0, net: 14916, lost: 0 },
  { market: 'FTMYR_MKT', lp_sub_source: 'Canvass', gross: 1239760, working: 276669, net: 627356, lost: 335735 },
  { market: 'FTMYR_MKT', lp_sub_source: 'Previous Customer', gross: 18334, working: 16834, net: 1500, lost: 0 },
  { market: 'UNRESOLVED', lp_sub_source: 'Canvass', gross: 1, working: 0, net: 1, lost: 0 },
  { market: 'FTMYR_MKT', lp_sub_source: 'Lead Gurus', gross: 88003, working: 36391, net: 51612, lost: 0 },
];

test('commission: FTMYR Sep MVP calculated = 0.15 × 14,916; expired rules and non-market rows skipped', () => {
  const rows = buildCommissionRows({ month: '2026-09-01', rules: RULES, dollars: DOLLARS });
  const mvp = rows.find((r) => r.lp_sub_sources[0] === 'MVP Marketing');
  assert.equal(mvp.amount, 2237.4);
  assert.deepEqual(mvp.eligible_markets, ['FTMYR_MKT']);
  assert.equal(mvp.cost_type, 'calculated');
  assert.equal(mvp.source_ref, 'r-mvp|FTMYR_MKT|MVP Marketing|2026-09-01');
  assert.equal(rows.find((r) => r.lp_sub_sources[0] === 'Canvass').amount, 94103.4);
  assert.equal(rows.find((r) => r.lp_sub_sources[0] === 'Previous Customer').amount, 15);
  assert.ok(!rows.some((r) => r.eligible_markets[0] === 'UNRESOLVED'));
  assert.ok(!rows.some((r) => r.description.startsWith('expired')));
  assert.ok(!rows.some((r) => r.lp_sub_sources[0] === 'Lead Gurus'), 'no rule → no row');
});

test('commission: recompute is idempotent, updates a moved net, zeroes a vanished basis, allocates direct', async () => {
  const supabase = fakeSupabase({ marketing_cost_rules: RULES, marketing_vendors: [], marketing_expenses: [], marketing_expense_allocations: [] }, { rpc: { mkt_sales_dollars: async () => DOLLARS } });
  const r1 = await recomputeCalculatedCosts('2026-09', { supabase });
  assert.equal(r1.inserted, 3);
  assert.equal(supabase.tables.marketing_expense_allocations.length, 3);
  assert.ok(supabase.tables.marketing_expense_allocations.every((a) => a.rule === 'direct' && a.market === 'FTMYR_MKT'));
  const r2 = await recomputeCalculatedCosts('2026-09', { supabase });
  assert.equal(r2.unchanged, 3);
  DOLLARS[0].net = 20000;
  const r3 = await recomputeCalculatedCosts('2026-09', { supabase });
  assert.equal(r3.updated, 1);
  assert.equal(Number(supabase.tables.marketing_expenses.find((e) => e.lp_sub_sources[0] === 'MVP Marketing').amount), 3000);
  DOLLARS[0].net = 14916;
  const gone = DOLLARS.splice(2, 1);
  const r4 = await recomputeCalculatedCosts('2026-09', { supabase });
  assert.equal(r4.zeroed, 1);
  DOLLARS.splice(2, 0, ...gone);
  const empty = fakeSupabase({ marketing_cost_rules: RULES }, { rpc: { mkt_sales_dollars: async () => [] } });
  assert.equal((await recomputeCalculatedCosts('2026-09', { supabase: empty })).skipped, 'no_snapshot');
});

test('holds: summary names every market by lead count, or asks for a manual pick', () => {
  const s = summarizeRecommendation([{ market: 'FTMYR_MKT', reason: 'matched LP lead 1' }, { market: 'FTMYR_MKT', reason: 'zip 33901 in FTMYR_MKT service area' }, { market: 'SAR_MKT', reason: 'matched LP lead 2' }, { market: null, reason: 'no match' }]);
  assert.equal(s.recommended_market, 'FTMYR_MKT,SAR_MKT');
  assert.match(s.recommendation_reason, /FTMYR_MKT 2\/3 leads, SAR_MKT 1\/3 lead — matched LP lead 1/);
  assert.deepEqual(summarizeRecommendation([{ market: null, reason: 'no match' }]), { recommended_market: null, recommendation_reason: 'no match — needs manual pick' });
});

test('holds: email, then phone, then zip; and the allocation row gets the recommendation', async () => {
  const supabase = fakeSupabase({
    ft_leads: [
      { lead_id: 'a', email: 'A@x.com', phone: '(941) 555-0100', zip_code: '34236', territory: 'Unknown', created_at: '2026-09-22T10:00:00' },
      { lead_id: 'b', email: null, phone: '239-555-0200', zip_code: '33901', territory: 'Out Of Area', created_at: '2026-09-22T11:00:00' },
      { lead_id: 'c', email: null, phone: null, zip_code: '33901', territory: 'Unknown', created_at: '2026-09-22T12:00:00' },
      { lead_id: 'd', email: null, phone: null, zip_code: '99999', territory: null, created_at: '2026-09-22T13:00:00' },
      { lead_id: 'e', email: 'mapped@x.com', phone: null, zip_code: '33901', territory: 'FTMYR', created_at: '2026-09-22T13:00:00' },
    ],
    lp_leads: [{ lp_lead_id: '581001', lp_branch_id: 'SAR', email: 'a@x.com', phone: '+19415550100' }, { lp_lead_id: '581002', lp_branch_id: 'FTMYR', email: null, phone: '2395550200' }],
    lp_branch_market_map: [{ brn_id: 'SAR', market_code: 'SAR_MKT' }, { brn_id: 'FTMYR', market_code: 'FTMYR_MKT' }],
    service_area_zips: [{ zip: '33901', market_code: 'FTMYR' }],
    marketing_expenses: [{ id: 'g1', source_system: 'leadgurus_feed', source_ref: '2026-09-22|__gap__', period_start: '2026-09-22', eligible_markets: ['REECE_HOLD'] }, { id: 'i1', source_system: 'email_invoice', source_ref: 'x', period_start: '2026-09-01', eligible_markets: ['REECE_HOLD'] }],
    marketing_expense_allocations: [{ id: 'h1', expense_id: 'g1', month: '2026-09-01', market: 'REECE_HOLD', amount: 4653.59, rule: 'hold' }, { id: 'h2', expense_id: 'i1', month: '2026-09-01', market: 'REECE_HOLD', amount: 10, rule: 'hold' }],
  });
  const m = await matchHeldLeads('2026-09-22', { supabase });
  assert.deepEqual(m.map((x) => [x.lead_id, x.market]), [['a', 'SAR_MKT'], ['b', 'FTMYR_MKT'], ['c', 'FTMYR_MKT'], ['d', null]]);
  assert.match(m[0].reason, /matched LP lead 581001, branch SAR/);
  assert.match(m[2].reason, /zip 33901 in FTMYR_MKT service area/);
  const r = await recommendHolds('2026-09', { supabase });
  assert.deepEqual(r, { month: '2026-09-01', holds: 2, recommended: 1, unmatched: 1 });
  const h1 = supabase.tables.marketing_expense_allocations.find((a) => a.id === 'h1');
  assert.equal(h1.recommended_market, 'FTMYR_MKT,SAR_MKT');
  assert.match(h1.recommendation_reason, /^day gap; held leads that day: FTMYR_MKT 2\/3/);
  assert.equal(supabase.tables.marketing_expense_allocations.find((a) => a.id === 'h2').recommendation_reason, 'no match — needs manual pick');

  // 2026-10-13: a line split by source that is waiting for its first issued lead
  // keeps its own note; it is not a held lead for a person to place.
  supabase.tables.marketing_expenses.push({ id: 'bs1', source_system: 'email_invoice', source_ref: 'y', period_start: '2026-09-02', eligible_markets: [] });
  supabase.tables.marketing_expense_allocations.push({ id: 'h3', expense_id: 'bs1', month: '2026-09-01', amount: 10, rule: 'hold', recommendation_reason: 'no Vis PPC issued leads in 2026-09 yet; split by source once there are (re-run nightly)' });
  const again = await recommendHolds('2026-09', { supabase });
  assert.equal(again.holds, 3);
  assert.match(supabase.tables.marketing_expense_allocations.find((a) => a.id === 'h3').recommendation_reason, /^no Vis PPC issued leads/);
});

test('nightly: runs every step per month and reports a failing step without dying', async () => {
  assert.deepEqual(defaultMonths('2026-10-12'), ['2026-09-01', '2026-10-01']);
  assert.deepEqual(defaultMonths('2026-01-05'), ['2025-12-01', '2026-01-01']);
  const supabase = fakeSupabase({ marketing_cost_rules: [], marketing_vendors: [{ vendor_name: 'Lead Gurus', id: 'v' }], marketing_territory_map: [], ft_summary_territory: [], ft_daily_summary: [], marketing_expenses: [], marketing_expense_allocations: [] }, { rpc: { mkt_sales_dollars: async () => { throw new Error('boom'); } } });
  const r = await runMarketingCostNightly({ months: ['2026-09'] }, { supabase });
  assert.equal(r.ok, false);
  assert.equal(r.months.length, 1);
  assert.ok(r.errors.some((e) => /commission 2026-09-01: mkt_sales_dollars failed: boom/.test(e)));
  assert.ok(r.months[0].reallocate, 'later steps still ran');
});

const VIEW_ROWS = [
  { grain: 'month', period_start: '2026-09-01', market: 'FTMYR_MKT', lp_sub_source: 'Lead Gurus', raw: 172, set_count: 88, issued: 36, sat: 25, sold: 4, gross: 88003, working: 36391, net: 51612, invoice_cost: 51580.11, calculated_cost: 0, has_provisional: true, as_of_snapshot: '2026-10-01' },
  { grain: 'month', period_start: '2026-09-01', market: 'FTMYR_MKT', lp_sub_source: 'MVP Marketing', raw: 27, set_count: 27, issued: 8, sat: 5, sold: 1, gross: 14916, working: 0, net: 14916, invoice_cost: 0, calculated_cost: 2237.4, has_provisional: false, as_of_snapshot: '2026-10-01' },
  { grain: 'month', period_start: '2026-08-01', market: 'FTMYR_MKT', lp_sub_source: 'Lead Gurus', raw: 150, set_count: 80, issued: 30, sat: 20, sold: 3, gross: 50000, working: 10000, net: 40000, invoice_cost: 40000, calculated_cost: 0, has_provisional: false, as_of_snapshot: '2026-09-01' },
  { grain: 'month', period_start: '2026-09-01', market: 'SAR_MKT', lp_sub_source: 'Lead Gurus', raw: 100, set_count: 50, issued: 20, sat: 10, sold: 2, gross: 30000, working: 5000, net: 25000, invoice_cost: 24268.64, calculated_cost: 0, has_provisional: true, as_of_snapshot: '2026-10-01' },
  { grain: 'month', period_start: '2026-09-01', market: 'REECE_HOLD', lp_sub_source: 'Lead Gurus', raw: 0, set_count: 0, issued: 0, sat: 0, sold: 0, gross: null, working: null, net: null, invoice_cost: 2529.34, calculated_cost: 0, has_provisional: true, as_of_snapshot: null, recommended_market: 'FTMYR_MKT', recommendation_reason: 'FTMYR_MKT 3/3 leads' },
  { grain: 'iso_week', period_start: '2026-09-21', market: 'FTMYR_MKT', lp_sub_source: 'Lead Gurus', raw: 40, set_count: 20, issued: 9, sat: 5, sold: 1, gross: null, working: null, net: null, invoice_cost: 12000, calculated_cost: 0, has_provisional: true, as_of_snapshot: null },
  { grain: 'iso_week', period_start: '2026-09-28', market: 'FTMYR_MKT', lp_sub_source: 'Lead Gurus', raw: 38, set_count: 18, issued: 8, sat: 4, sold: 1, gross: null, working: null, net: null, invoice_cost: 11000, calculated_cost: 0, has_provisional: true, as_of_snapshot: null },
];

test('report model: a market and the company roll-up, † on provisional, held $ in the footnotes', () => {
  const m = buildMarketModel({ market: 'FTMYR_MKT', month: '2026-09', monthRows: VIEW_ROWS.filter((r) => r.grain === 'month'), weekRows: VIEW_ROWS.filter((r) => r.grain === 'iso_week') });
  assert.equal(m.campaign.length, 2);
  assert.equal(m.campaign[0].label, 'Lead Gurus');
  assert.equal(m.campaign[0].has_provisional, true);
  assert.equal(m.campaign[0].issued, 36);
  assert.equal(m.monthly.length, 2);
  assert.equal(m.monthly[0].label, 'August 2026');
  assert.equal(m.weekly.length, 2);
  assert.equal(m.held, 2529.34);
  assert.ok(m.footnotes.some((f) => /Held at company level.*\$2,529\.34.*FTMYR_MKT 3\/3 leads/.test(f)));
  assert.ok(m.footnotes.some((f) => /as of the 2026-10-01 report 133 snapshot/.test(f)));
  const c = buildMarketModel({ market: COMPANY, month: '2026-09', monthRows: VIEW_ROWS.filter((r) => r.grain === 'month'), weekRows: [] });
  const lg = c.campaign.find((x) => x.label === 'Lead Gurus');
  assert.equal(lg.issued, 56, 'company sums the markets');
  assert.equal(Math.round(lg.invoice_cost * 100) / 100, 75848.75);
  assert.ok(!c.campaign.some((x) => x.issued === 0 && x.raw === 0), 'REECE_HOLD is not a campaign row');
});

test('workbook: formulas, not typed values; All Campaigns is a SUM; n.a. on divide by zero', async () => {
  const model = buildMarketModel({ market: 'FTMYR_MKT', month: '2026-09', monthRows: VIEW_ROWS.filter((r) => r.grain === 'month'), weekRows: VIEW_ROWS.filter((r) => r.grain === 'iso_week') });
  const buf = await buildWorkbook(model);
  assert.ok(buf.length > 2000);
  const wb = await readWorkbook(buf);
  const ws = wb.getWorksheet('Campaign Summary');
  assert.equal(ws.getCell('A3').value, 'Lead Gurus †');
  assert.equal(ws.getCell('D3').value, 36);
  assert.equal(ws.getCell('N3').value, 51580.11);
  assert.equal(ws.getCell('Q3').value.formula, 'IFERROR(P3/D3,"n.a.")');
  assert.equal(ws.getCell('P3').value.formula, 'N3+O3');
  assert.equal(ws.getCell('E3').value.formula, 'IFERROR(D3/C3,"n.a.")');
  assert.equal(ws.getCell('M3').value.formula, 'IFERROR(L3/D3,"n.a.")');
  assert.equal(ws.getCell('A5').value, 'All Campaigns');
  assert.equal(ws.getCell('D5').value.formula, 'SUM(D3:D4)');
  assert.equal(ws.getCell('Q5').value.formula, 'IFERROR(P5/D5,"n.a.")');
  const monthly = wb.getWorksheet('Monthly Results');
  assert.equal(monthly.getCell('A3').value, 'August 2026');
  assert.equal(monthly.getCell('A5').value, 'Jan–YTD');
  assert.equal(monthly.getCell('L5').value.formula, 'SUM(L3:L4)');
  const weekly = wb.getWorksheet('Weekly');
  assert.equal(weekly.getCell('A3').value, 'Week of 2026-09-21');
  assert.equal(weekly.getCell('E3').value.formula, 'IFERROR(D3/C3,"n.a.")');
});

test('report run: one file per market + company, stored and linked, one card', async () => {
  const supabase = fakeSupabase({ v_market_subsource_cost: VIEW_ROWS });
  supabase.from = ((orig) => (t) => { const c = orig(t); const r = c.range; c.range = () => c; return c; })(supabase.from);
  const posts = [];
  const r = await runMarketingReport({ month: '2026-09' }, { supabase, env: { MKT_REPORT_EMAIL_TO: 'mark@x,brad@x', SLACK_MKT_INVOICE_CHANNEL_ID: 'C1' }, buildWorkbook: async () => Buffer.from('xlsx'), postToSlack: async (text, channel) => { posts.push({ text, channel }); return { ok: true }; } });
  assert.equal(r.files.length, 7);
  assert.equal(r.files.at(-1).market, 'REECE');
  assert.ok(r.files.every((f) => f.url && f.path.startsWith('2026-09/')));
  assert.equal(r.email_to, 'mark@x,brad@x');
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /Marketing cost report — September 2026/);
  assert.equal(defaultReportMonth('2026-10-02'), '2026-09');
  assert.equal(defaultReportMonth('2026-10-12'), '2026-10');
});
