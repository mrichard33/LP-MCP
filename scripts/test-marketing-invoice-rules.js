/**
 * test-marketing-invoice-rules.js — the pure invoice layer: vendor matching,
 * regex facts, the AI schema and the expense rows + flags. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { matchVendor, senderDomain, vendorLearnPatch, normalizeName } from '../src/marketing/vendors.js';
import { extractInvoiceFacts, parseDate, parseAmount, marketHints, extractTotal } from '../src/marketing/invoice-rules.js';
import { validateAnalysis } from '../src/marketing/analysis-schema.js';
import { mergeFacts, buildExpenseRows, computeFlags, autoApproveDecision, FLAGS } from '../src/marketing/expense-builder.js';

const VENDORS = [
  { id: '11111111-1111-4111-8111-111111111111', vendor_name: 'Lead Gurus', aliases: ['LeadGurus', 'Lead Gurus LLC'], sender_domains: ['leadgurus.com'], lp_sub_sources: ['Lead Gurus'], eligible_markets: ['FTMYR_MKT', 'SAR_MKT'], is_active: true },
  { id: '22222222-2222-4222-8222-222222222222', vendor_name: 'MyHomePros', aliases: ['My Home Pros'], sender_domains: [], lp_sub_sources: ['MyHomePros'], eligible_markets: [], is_active: true },
  { id: '33333333-3333-4333-8333-333333333333', vendor_name: 'Old Vendor', aliases: [], sender_domains: ['old.com'], lp_sub_sources: ['Old'], eligible_markets: ['SAR_MKT'], is_active: false },
];

const INVOICE_TEXT = `Lead Gurus LLC
123 Agency Way, Tampa, FL
Bill To: Reece Windows & Doors — Fort Myers office
Invoice # LG-2026-0912        Invoice Date: 10/02/2026
Service Period: 09/01/2026 - 09/30/2026

Description                              Amount
Facebook lead generation - Fort Myers    $51,580.11
Agency fee                               $1,500.00

Subtotal                                 $53,080.11
Amount Due                               $53,080.11
Terms: Net 15. Thank you.`;

test('vendor: sender domain wins, subdomains count, inactive vendors never match', () => {
  assert.equal(senderDomain('Billing <ar@mail.leadgurus.com>'), 'mail.leadgurus.com');
  assert.equal(matchVendor({ fromAddress: 'ar@mail.leadgurus.com', vendors: VENDORS }).vendor.vendor_name, 'Lead Gurus');
  assert.equal(matchVendor({ fromAddress: 'ar@mail.leadgurus.com', vendors: VENDORS }).method, 'sender_domain');
  assert.equal(matchVendor({ fromAddress: 'x@old.com', text: 'Old Vendor invoice', vendors: VENDORS }).vendor, null);
});

test('vendor: alias in the text, longest alias wins, punctuation ignored', () => {
  const r = matchVendor({ fromAddress: 'someone@gmail.com', text: 'INVOICE from My-Home Pros, Inc.', vendors: VENDORS });
  assert.equal(r.vendor.vendor_name, 'MyHomePros');
  assert.equal(r.method, 'alias');
  assert.equal(matchVendor({ fromAddress: 'someone@gmail.com', text: 'nothing here', vendors: VENDORS }).vendor, null);
  assert.equal(normalizeName('My-Home Pros, Inc.'), 'my home pros inc');
});

test('vendor: learning from an edit adds the alias and a real sender domain, never gmail', () => {
  const p = vendorLearnPatch(VENDORS[1], { alias: 'MHP Digital', fromAddress: 'ar@billing.myhomepros.com' });
  assert.deepEqual(p.aliases, ['My Home Pros', 'MHP Digital']);
  assert.deepEqual(p.sender_domains, ['billing.myhomepros.com']);
  assert.equal(vendorLearnPatch(VENDORS[1], { alias: 'my home pros', fromAddress: 'x@gmail.com' }), null);
});

test('rules: dates and amounts', () => {
  assert.equal(parseDate('10/02/2026'), '2026-10-02');
  assert.equal(parseDate('September 30, 2026'), '2026-09-30');
  assert.equal(parseDate('2026-09-30'), '2026-09-30');
  assert.equal(parseDate('30 Sep 2026'), '2026-09-30');
  assert.equal(parseDate('13/40/2026'), null);
  assert.equal(parseAmount('$53,080.11'), 53080.11);
  assert.equal(parseAmount('(1,234.00)'), -1234);
  assert.equal(parseAmount('n/a'), null);
});

test('rules: the Lead Gurus invoice facts', () => {
  const f = extractInvoiceFacts(INVOICE_TEXT);
  assert.equal(f.invoice_number, 'LG-2026-0912');
  assert.equal(f.invoice_date, '2026-10-02');
  assert.equal(f.period_start, '2026-09-01');
  assert.equal(f.period_end, '2026-09-30');
  assert.equal(f.period_source, 'labelled_range');
  assert.equal(f.total, 53080.11);
  assert.equal(f.currency, 'USD');
});

test('rules: "month of September 2026" and a bare Total, last total wins', () => {
  const f = extractInvoiceFacts('Invoice No. 4471\nServices for the month of September 2026\nTotal $900.00\nTotal $1,000.00');
  assert.equal(f.invoice_number, '4471');
  assert.deepEqual([f.period_start, f.period_end], ['2026-09-01', '2026-09-30']);
  assert.equal(f.total, 1000);
  assert.equal(extractTotal('Qty 12 Items 500'), null, 'no total word → null, never the largest number');
  assert.equal(extractInvoiceFacts('Total CAD 100.00').currency, 'CAD');
});

test('rules: market hints from city words and slack names', () => {
  const hints = marketHints('Campaigns for Fort Myers and Naples; billed from Tampa office', { STPET: 'St. Petersburg' });
  const codes = hints.map((h) => h.market).sort();
  assert.deepEqual(codes, ['FTMYR_MKT', 'STPET_MKT']);
  assert.deepEqual(hints.find((h) => h.market === 'FTMYR_MKT').evidence.sort(), ['fort myers', 'naples']);
});

test('schema: a good analysis is coerced, a bad one is rejected with reasons', () => {
  const good = validateAnalysis({
    vendor_name: 'Lead Gurus LLC', vendor_match_id: '11111111-1111-4111-8111-111111111111', invoice_number: 'LG-2026-0912',
    invoice_date: '2026-10-02', billing_period_start: '2026-09-01', billing_period_end: '2026-09-30', currency: 'usd', total: '53,080.11',
    lines: [{ description: 'FB leads', amount: '51580.11', lp_sub_source: 'Lead Gurus', markets: ['ftmyr_mkt'], market_evidence: 'Fort Myers' },
      { description: 'Agency fee', amount: 1500, lp_sub_source: null, markets: [], market_evidence: null }],
    confidence: 0.92, notes: null,
  });
  assert.equal(good.valid, true, good.errors.join('; '));
  assert.equal(good.value.total, 53080.11);
  assert.equal(good.value.currency, 'USD');
  assert.deepEqual(good.value.lines[0].markets, ['FTMYR_MKT']);

  const bad = validateAnalysis({ vendor_match_id: 'not-a-uuid', total: 'abc', lines: [{ amount: null, markets: ['Fort Myers'] }], confidence: 2, extra: 1 });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => /vendor_match_id/.test(e)));
  assert.ok(bad.errors.some((e) => /total/.test(e)));
  assert.ok(bad.errors.some((e) => /non-code/.test(e)));
  assert.ok(bad.errors.some((e) => /confidence/.test(e)));
  assert.ok(bad.errors.some((e) => /unknown key "extra"/.test(e)));
  assert.equal(validateAnalysis('nope').valid, false);
});

test('merge: rules win on total and invoice number, disagreements recorded, AI fills gaps', () => {
  const { facts, disagreements } = mergeFacts(
    { invoice_number: 'A-1', total: 100, period_start: null, period_end: null, currency: 'USD', invoice_date: null },
    { invoice_number: 'A-2', total: 99, billing_period_start: '2026-09-01', billing_period_end: '2026-09-30', invoice_date: '2026-10-01' },
  );
  assert.equal(facts.invoice_number, 'A-1');
  assert.equal(facts.total, 100);
  assert.equal(facts.period_start, '2026-09-01');
  assert.equal(facts.invoice_date, '2026-10-01');
  assert.equal(disagreements.length, 2);
});

test('rows + flags: a clean known-vendor invoice has no flags; unknown vendor and empty markets flag', () => {
  const vendor = VENDORS[0];
  const facts = { invoice_number: 'LG-1', period_start: '2026-09-01', period_end: '2026-09-30', total: 100, currency: 'USD' };
  const analysis = { lines: [{ description: 'FTMYR', amount: 60, lp_sub_source: 'Lead Gurus', markets: ['FTMYR_MKT'] }, { description: 'SAR', amount: 40, lp_sub_source: 'Lead Gurus', markets: ['SAR_MKT'] }], confidence: 0.95 };
  const { rows, lineProblems } = buildExpenseRows({ document: { id: 'd1' }, vendor, facts, analysis, confidence: 0.95 });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].eligible_markets, ['FTMYR_MKT']);
  assert.deepEqual(rows[1].lp_sub_sources, ['Lead Gurus']);
  assert.equal(rows[0].status, 'pending_review');
  assert.equal(rows[0].source_ref, 'd1|1');
  assert.deepEqual(computeFlags({ vendor, facts, rows, lineProblems, confidence: 0.95, extraction: { page_count: 2, ocr_pages: 0 } }), []);

  const unknown = buildExpenseRows({ document: { id: 'd2' }, vendor: null, facts: { ...facts, total: null, period_start: null }, analysis: null, confidence: 0.4 });
  const flags = computeFlags({ vendor: null, facts: { ...facts, total: null, period_start: null }, rows: unknown.rows, confidence: 0.4 });
  for (const f of [FLAGS.UNKNOWN_VENDOR, FLAGS.MISSING_PERIOD, FLAGS.MISSING_TOTAL, FLAGS.LOW_CONFIDENCE]) assert.ok(flags.includes(f), f);

  const noMarkets = computeFlags({ vendor: VENDORS[1], facts, rows: buildExpenseRows({ document: { id: 'd3' }, vendor: VENDORS[1], facts, analysis: null, confidence: 0.9 }).rows, confidence: 0.9 });
  assert.ok(noMarkets.includes(FLAGS.VENDOR_MARKETS_UNKNOWN));
});

test('flags: line sum ≠ total, non-USD, spike, duplicate, disagreement, OCR-heavy, non-eligible market', () => {
  const vendor = VENDORS[0];
  const facts = { invoice_number: 'X', period_start: '2026-09-01', period_end: '2026-09-30', total: 100, currency: 'CAD' };
  const analysis = { lines: [{ description: 'a', amount: 70, lp_sub_source: 'Lead Gurus', markets: ['STPET_MKT'] }] };
  const { rows, lineProblems } = buildExpenseRows({ document: { id: 'd' }, vendor, facts, analysis, confidence: 0.9 });
  assert.deepEqual(rows[0].eligible_markets, vendor.eligible_markets, 'a non-eligible market falls back to the vendor list');
  const flags = computeFlags({
    vendor, facts, rows, lineProblems, confidence: 0.9, disagreements: ['total'], extraction: { page_count: 3, ocr_pages: 2 },
    trailingAvg: 40, possibleDuplicate: true,
  });
  for (const f of [FLAGS.LINES_NE_TOTAL, FLAGS.NON_USD, FLAGS.AMOUNT_SPIKE, FLAGS.POSSIBLE_DUPLICATE, FLAGS.RULES_AI_DISAGREE, FLAGS.OCR_HEAVY, FLAGS.MARKET_NOT_ELIGIBLE]) {
    assert.ok(flags.includes(f), f);
  }
});

test('auto-approve only with no flags and ≥ 2 prior approvals', () => {
  assert.equal(autoApproveDecision({ flags: [], priorApprovals: 2, minPrior: 2 }), true);
  assert.equal(autoApproveDecision({ flags: [], priorApprovals: 1, minPrior: 2 }), false);
  assert.equal(autoApproveDecision({ flags: [FLAGS.LOW_CONFIDENCE], priorApprovals: 9, minPrior: 2 }), false);
});
