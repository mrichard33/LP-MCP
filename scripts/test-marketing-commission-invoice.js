/**
 * test-marketing-commission-invoice.js — a per-sale commission invoice line is
 * matched to its LP sale and booked in that sale's office and contract month,
 * and the same month's 15% estimate steps aside for it (the user, 2026-10-19:
 * LeadPilot INV-000088, "David Shadlick $68,000", landed on Fort Lauderdale from
 * LeadPilot's letterhead; the sale was David Shadick's, an Orlando lead).
 * Offline; scripts/lib/fake-supabase.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { fakeSupabase } from './lib/fake-supabase.js';
import { saleFromLine, nameMatches, pickSale, applySaleMatch, matchCommissionInvoiceRows, SALE_NOT_FOUND } from '../src/marketing/commission-invoice.js';
import { buildCommissionRows, invoicedByCell, recomputeCalculatedCosts } from '../src/marketing/commission.js';
import { refreshEstimatesFor } from '../src/marketing/review-actions.js';

const LINE = { description: 'David Shadlick $68,000 - commission on sale (Sold on 09/14/2025)', amount: 10200 };
const VENDOR = {
  id: 'v-lp', vendor_name: 'LeadPilotData (commission)', default_cost_type: 'calculated', lp_sub_sources: ['LeadPilotData'],
  eligible_markets: ['STPET_MKT', 'ORL_MKT', 'FTMYR_MKT', 'FTLAU_MKT', 'JAX_MKT', 'SAR_MKT'],
};
const ROW = {
  document_id: 'd1', vendor_id: 'v-lp', cost_type: 'invoice', invoice_number: 'INV-000088', line_no: 1,
  description: `${LINE.description} (West Palm Beach, Florida)`, amount: 10200, period_start: '2026-10-19', period_end: '2026-10-19',
  lp_sub_sources: ['LeadPilotData'], eligible_markets: ['FTLAU_MKT'], status: 'pending_review',
};
const BASE = {
  marketing_cost_rules: [{ id: 'r-lp', lp_sub_sources: ['LeadPilotData'], rate: 0.15, label: 'LeadPilotData 15% of net', effective_from: '2026-01-01', effective_to: null, basis: 'net_sales' }],
  lp_branch_market_map: [{ brn_id: 'ORL', market_code: 'ORL_MKT', market_label: 'Orlando' }, { brn_id: 'BOCA', market_code: 'FTLAU_MKT', market_label: 'Fort Lauderdale' }],
  lp_lead_market_assignments: [],
};

test('saleFromLine: the name, the printed sale and the "sold on" text; else line ÷ rate', () => {
  assert.deepEqual(saleFromLine(LINE, 0.15), { name: 'david shadlick', sale: 68000, sold: '09/14/2025' });
  assert.equal(saleFromLine({ description: 'Jane Roe', amount: 1500 }, 0.15).sale, 10000);
});

test('nameMatches: one typo in the surname passes, another customer does not', () => {
  assert.equal(nameMatches('david shadlick', { first_name: 'David', last_name: 'Shadick' }), true);
  assert.equal(nameMatches('david shadlick', { first_name: 'Mary', last_name: 'Shadick' }), false);
  assert.equal(nameMatches('david shadlick', { first_name: 'David', last_name: 'Shade' }), false);
  assert.equal(nameMatches('david shadlick', { first_name: 'Marlon / Lori', last_name: 'Shadd' }), false);
});

test('pickSale: the amount must agree and the name decides; a same-price stranger is refused', () => {
  const shadick = { first_name: 'David', last_name: 'Shadick', job_value: 68000 };
  const other = { first_name: 'Erik', last_name: 'Coleman', job_value: 68000 };
  assert.equal(pickSale([other, shadick], { name: 'david shadlick', sale: 68000 }), shadick);
  assert.equal(pickSale([other], { name: 'david shadlick', sale: 68000 }), null);
  assert.equal(pickSale([{ ...shadick, job_value: 67000 }], { name: 'david shadlick', sale: 68000 }), null);
});

test('applySaleMatch: the lead\'s office, the contract month, the prospect on the line (never the letterhead)', () => {
  const r = applySaleMatch(ROW, LINE, { market: 'ORL_MKT', market_label: 'Orlando', prospect_id: '449431', first_name: 'David', last_name: 'Shadick', job_value: 68000, contract_date: '2026-08-26T00:00:00' });
  assert.deepEqual(r.eligible_markets, ['ORL_MKT']);
  assert.equal(r.period_start, '2026-08-01');
  assert.equal(r.period_end, '2026-08-31');
  assert.match(r.description, /Prospect 449431, David Shadick, Orlando, \$68,000 sold 8\/26\/2026/);
  assert.doesNotMatch(r.description, /West Palm/);
});

test('matchCommissionInvoiceRows: found in our copy → Orlando, August', async () => {
  const supabase = fakeSupabase({
    ...BASE,
    lp_jobs: [
      { lp_lead_id: '570426', job_value: 68000, branch_code: 'ORL', raw_lp_data: { contractdate: '2026-08-26T00:00:00' } },
      { lp_lead_id: '467174', job_value: 68000, branch_code: 'BOCA', raw_lp_data: { contractdate: '2025-10-31T00:00:00' } },
    ],
    lp_leads: [
      { lp_lead_id: '570426', lp_prospect_id: '449431', first_name: 'David', last_name: 'Shadick', lead_source_detail: 'LeadPilotData', lp_branch_id: 'ORL' },
      { lp_lead_id: '467174', lp_prospect_id: '1', first_name: 'Erik & Sabrina', last_name: 'Coleman', lead_source_detail: 'Lead Gurus', lp_branch_id: 'BOCA' },
    ],
  });
  const lp = { getCustomers3: async () => { throw new Error('LP must not be called when our copy has the sale'); }, getLead: async () => [] };
  const out = await matchCommissionInvoiceRows({ rows: [ROW], lines: [LINE], vendor: VENDOR }, { supabase, lp });
  assert.deepEqual(out.flags, []);
  assert.deepEqual(out.rows[0].eligible_markets, ['ORL_MKT']);
  assert.equal(out.rows[0].period_start, '2026-08-01');
  assert.equal(out.matches[0].found_in, 'database');
  assert.equal(out.matches[0].prospect_id, '449431');
});

test('matchCommissionInvoiceRows: not in our copy → found in LP live by the surname\'s first letters', async () => {
  const supabase = fakeSupabase({ ...BASE, lp_jobs: [], lp_leads: [] });
  const asked = [];
  const lp = {
    getCustomers3: async (p) => { asked.push(p.lastname); return [
      { ProspectID: 173952, FirstName: 'Marlon / Lori', LastName: 'Shadd' },
      { ProspectID: 449431, FirstName: 'David', LastName: 'Shadick' },
    ]; },
    getLead: async (id) => (id === '449431' ? [{ firstname: 'David', lastname: 'Shadick', leads: [
      { id: '563344', sourcesubdescr: 'Lead Gurus', brn_id: 'ORL', jobs: [] },
      { id: '570426', sourcesubdescr: 'LeadPilotData', brn_id: 'ORL', GrossSaleAmount: '68000.00', jobs: [{ grossamount: '68000.00', contractdate: '2026-08-26T00:00:00', pds_id: 'ORL' }] },
    ] }] : []),
  };
  const out = await matchCommissionInvoiceRows({ rows: [ROW], lines: [LINE], vendor: VENDOR }, { supabase, lp });
  assert.deepEqual(asked, ['shad']);
  assert.deepEqual(out.rows[0].eligible_markets, ['ORL_MKT']);
  assert.equal(out.matches[0].found_in, 'lead_perfection');
  assert.equal(out.matches[0].lp_lead_id, '570426');
});

test('matchCommissionInvoiceRows: no sale found → the letterhead market is dropped and the card is flagged', async () => {
  const supabase = fakeSupabase({ ...BASE, lp_jobs: [], lp_leads: [] });
  const lp = { getCustomers3: async () => [], getLead: async () => [] };
  const out = await matchCommissionInvoiceRows({ rows: [ROW], lines: [LINE], vendor: VENDOR }, { supabase, lp });
  assert.deepEqual(out.flags, [SALE_NOT_FOUND]);
  assert.deepEqual(out.rows[0].eligible_markets, VENDOR.eligible_markets);
  assert.equal(out.rows[0].description, LINE.description);
});

test('matchCommissionInvoiceRows: a vendor that is not a commission vendor is left alone', async () => {
  const supabase = fakeSupabase(BASE);
  const out = await matchCommissionInvoiceRows({ rows: [ROW], lines: [LINE], vendor: { ...VENDOR, default_cost_type: 'invoice' } }, { supabase });
  assert.equal(out.rows[0], ROW);
  assert.deepEqual(out.flags, []);
});

test('the invoice replaces the estimate: the 15% cell keeps only what is not invoiced, never below 0', () => {
  const rules = BASE.marketing_cost_rules;
  const invoices = [
    { cost_type: 'invoice', status: 'approved', amount: 10200, period_start: '2026-08-01', eligible_markets: ['ORL_MKT'], lp_sub_sources: ['LeadPilotData'] },
    { cost_type: 'invoice', status: 'pending_review', amount: 999, period_start: '2026-08-01', eligible_markets: ['ORL_MKT'], lp_sub_sources: ['LeadPilotData'] },
    { cost_type: 'invoice', status: 'approved', amount: 500, period_start: '2026-08-01', eligible_markets: ['ORL_MKT', 'SAR_MKT'], lp_sub_sources: ['LeadPilotData'] },
    { cost_type: 'invoice', status: 'approved', amount: 700, period_start: '2026-09-01', eligible_markets: ['ORL_MKT'], lp_sub_sources: ['LeadPilotData'] },
  ];
  const invoiced = invoicedByCell(invoices, '2026-08-01');
  assert.deepEqual(invoiced, { 'ORL_MKT|LeadPilotData': 10200 });
  const dollars = [
    { market: 'ORL_MKT', lp_sub_source: 'LeadPilotData', net: 100000 },
    { market: 'SAR_MKT', lp_sub_source: 'LeadPilotData', net: 20000 },
  ];
  const rows = buildCommissionRows({ month: '2026-08-01', rules, dollars, invoiced });
  const orl = rows.find((r) => r.eligible_markets[0] === 'ORL_MKT');
  assert.equal(orl.amount, 4800);
  assert.match(orl.description, /less \$10,200\.00 invoiced/);
  assert.equal(rows.find((r) => r.eligible_markets[0] === 'SAR_MKT').amount, 3000);
  const only = buildCommissionRows({ month: '2026-08-01', rules, dollars: [{ market: 'ORL_MKT', lp_sub_source: 'LeadPilotData', net: 68000 }], invoiced });
  assert.equal(only[0].amount, 0);
});

test('recomputeCalculatedCosts reads the approved invoices; approving one refreshes its month', async () => {
  const supabase = fakeSupabase({
    ...BASE, marketing_vendors: [],
    marketing_expenses: [{ id: 'inv1', cost_type: 'invoice', status: 'approved', amount: 10200, period_start: '2026-08-01', period_end: '2026-08-31', eligible_markets: ['ORL_MKT'], lp_sub_sources: ['LeadPilotData'], source_system: 'email_invoice' }],
  }, { rpc: { mkt_sales_dollars: () => [{ market: 'ORL_MKT', lp_sub_source: 'LeadPilotData', net: 68000 }], mkt_lead_counts: () => [] } });
  await recomputeCalculatedCosts('2026-08', { supabase });
  const { data } = await supabase.from('marketing_expenses').select('*').eq('source_system', 'commission_rule');
  assert.equal(data.length, 1);
  assert.equal(Number(data[0].amount), 0);

  const months = [];
  await refreshEstimatesFor([{ lp_sub_sources: ['LeadPilotData'], period_start: '2026-08-01' }, { lp_sub_sources: ['Hatch'], period_start: '2026-07-01' }], { supabase, recompute: async (m) => { months.push(m); return { m }; } });
  assert.deepEqual(months, ['2026-08-01']);
});
