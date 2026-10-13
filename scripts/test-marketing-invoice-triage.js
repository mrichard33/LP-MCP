/**
 * test-marketing-invoice-triage.js — the three real parts of the first email
 * into I.MCIN (2026-10-13): two inline images that OCR'd to "qb" and
 * "Th Kf Wr" (not invoices) and the JMJ Digital Marketing PDF (an invoice
 * with a total and an invoice date but no service period). Plus the row
 * defaults that keep marketing_expenses' NOT NULL columns satisfied, and the
 * vendor matching rules for a FORWARDED email.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { triageExtraction, fillRowDefaults, linkedFileIn, MIN_INVOICE_CHARS, SKIP_REASONS } from '../src/marketing/invoice-triage.js';
import { matchVendor, vendorLearnPatch, isInternalMailDomain, emailDomainsIn } from '../src/marketing/vendors.js';
import { buildExpenseRows, computeFlags } from '../src/marketing/expense-builder.js';
import { extractInvoiceFacts } from '../src/marketing/invoice-rules.js';

export const JMJ_TEXT = `INVOICE
JMJ Digital Marketing, LLC jmjdigitalmarketingppc@gmail.com
1203 Bullard Ave +1 (732) 547-3007
Ste 104
Forked River, NJ 08731-4430
Bill to Ship to
Mr Brad Codman Mr Brad Codman
Reece Windows Reece Windows
Florida Florida
Invoice details
Invoice no.: 1883
Terms: Net 7
Invoice date: 10/02/2026
Due date: 10/09/2026
# Date Product or service Description Qty Rate Amount
1. Google & Meta Ad Account Management Of The Google And/Or 7973 $0.20 $1,594.60
Management - Management Fee Meta Ad Account.
2. One-Time Campaign Setup Fee One-time charge for the setup of the 1 $2,000.00 $2,000.00
Google Ads and/or Meta Ads account
3. Data Fee Make platform fee for offline conversion 1 $30.00 $30.00
uploads.
Total $3,624.60
Ways to pay
Overdue 10/09/2026
View and pay`;

test('the two inline images are not invoices; the JMJ PDF is', () => {
  assert.deepEqual(triageExtraction({ text: 'qb\n', kind: 'image' }), { verdict: 'not_an_invoice', reason: SKIP_REASONS.TOO_LITTLE_TEXT, chars: 2 });
  assert.deepEqual(triageExtraction({ text: 'Th\nKf\nWr\n', kind: 'image' }), { verdict: 'not_an_invoice', reason: SKIP_REASONS.TOO_LITTLE_TEXT, chars: 6 });
  assert.deepEqual(triageExtraction({ text: '', kind: 'image' }), { verdict: 'not_an_invoice', reason: SKIP_REASONS.NO_TEXT, chars: 0 });
  const pdf = triageExtraction({ text: JMJ_TEXT, kind: 'pdf' });
  assert.equal(pdf.verdict, 'invoice');
  assert.ok(pdf.chars > MIN_INVOICE_CHARS);
});

test('a short OCR that carries a money figure or an invoice word is still an invoice', () => {
  assert.equal(triageExtraction({ text: 'AMOUNT DUE $1,200.00', kind: 'image' }).verdict, 'invoice');
  assert.equal(triageExtraction({ text: 'Invoice 4471', kind: 'image' }).verdict, 'invoice');
  assert.equal(triageExtraction({ text: 'see 987.65 attached', kind: 'image' }).verdict, 'invoice');
});

test('a CSV or an XLSX is never triaged out; an email body needs an amount, and a linked receipt is named', () => {
  assert.equal(triageExtraction({ text: 'a,b', kind: 'csv' }).verdict, 'invoice');
  assert.equal(triageExtraction({ text: '', kind: 'xlsx' }).verdict, 'invoice');
  assert.equal(triageExtraction({ text: 'please pay $500 for September', kind: 'text', meta: { format: 'email_body' } }).verdict, 'invoice');
  assert.deepEqual(triageExtraction({ text: 'ok', kind: 'text', meta: { format: 'email_body' } }).reason, SKIP_REASONS.NO_AMOUNT);
  // 2026-10-13: the Hatch forward — Outlook "attached" the receipt as a OneDrive link.
  const hatch = '​[https://res.public.onecdn.static.microsoft/assets/fluentui-resources/1.1.0/app-min/assets/item-types/24/pdf.png]Receipt-2757-9497.pdf<https://reecewindows-my.sharepoint.com/:b:/p/m_richard/IQDxd6PLVYpxRaGupkkG5vNWAapvV-GDyjSq6hwmoWrD0Ao>​ ';
  const t = triageExtraction({ text: hatch, kind: 'text', meta: { format: 'email_body' } });
  assert.equal(t.verdict, 'not_an_invoice');
  assert.equal(t.reason, SKIP_REASONS.LINKED_FILE);
  assert.equal(linkedFileIn(hatch).name, 'Receipt-2757-9497.pdf');
  assert.equal(linkedFileIn('Total $5 https://example.com/x.pdf'), null);
});

test('the JMJ invoice: the rules read the total and the invoice date, the period is assumed and flagged', () => {
  const rules = extractInvoiceFacts(JMJ_TEXT);
  assert.equal(rules.total, 3624.6);
  assert.equal(rules.invoice_date, '2026-10-02');
  const facts = { invoice_number: rules.invoice_number, invoice_date: rules.invoice_date, period_start: rules.period_start, period_end: rules.period_end, total: rules.total, currency: 'USD' };
  const { rows } = buildExpenseRows({ document: { id: 'd1' }, vendor: null, facts, analysis: null, confidence: 0.4 });
  const flags = computeFlags({ vendor: null, facts, rows, confidence: 0.4 });
  assert.ok(flags.includes('unknown_vendor'));
  const filled = fillRowDefaults(rows, facts, { receivedAt: '2026-10-13T16:01:38.000Z', today: '2026-10-13' });
  assert.equal(filled.rows.length, 1);
  assert.equal(filled.rows[0].amount, 3624.6);
  assert.ok(filled.rows[0].period_start, 'a period the database will take');
  assert.ok(filled.rows[0].period_end);
  if (!facts.period_start) {
    // What production saw: no service period printed → the invoice date, flagged.
    assert.ok(flags.includes('missing_period'));
    assert.deepEqual(filled.assumed, ['missing_period']);
    assert.equal(filled.rows[0].period_start, '2026-10-02');
    assert.equal(filled.rows[0].period_end, '2026-10-02');
    assert.equal(filled.facts.period_assumed_from, 'invoice_date');
  }
});

test('fillRowDefaults: a missing total becomes 0 and is flagged; a missing period falls back to the day received, then today', () => {
  const facts = { invoice_number: '77', invoice_date: null, period_start: null, period_end: null, total: null, currency: 'USD' };
  const { rows } = buildExpenseRows({ document: { id: 'd2' }, vendor: null, facts, analysis: null });
  assert.equal(rows[0].amount, null);
  const a = fillRowDefaults(rows, facts, { receivedAt: '2026-10-13T16:01:38.000Z' });
  assert.equal(a.rows[0].amount, 0);
  assert.equal(a.rows[0].period_start, '2026-10-13');
  assert.equal(a.rows[0].period_end, '2026-10-13');
  assert.deepEqual(a.assumed.sort(), ['missing_period', 'missing_total']);
  assert.equal(a.facts.period_assumed_from, 'received_at');
  const b = fillRowDefaults(rows, facts, { today: '2026-10-14' });
  assert.equal(b.rows[0].period_start, '2026-10-14');
  assert.equal(b.facts.period_assumed_from, 'today');
  // A row that already has everything is untouched.
  const whole = fillRowDefaults([{ amount: 5, period_start: '2026-09-01', period_end: '2026-09-30' }], { period_start: '2026-09-01', period_end: '2026-09-30', total: 5 });
  assert.deepEqual(whole.assumed, []);
  assert.equal(whole.facts.period_assumed_from, undefined);
  // Only one end of the period known → the other end is the same day, still flagged.
  const half = fillRowDefaults([{ amount: 5, period_start: '2026-09-01', period_end: null }], { period_start: '2026-09-01', period_end: null, total: 5 });
  assert.equal(half.rows[0].period_end, '2026-09-01');
  assert.deepEqual(half.assumed, ['missing_period']);
});

test('a forwarded email: the forwarder is never the vendor, the address printed in the text is tried', () => {
  const JMJ = { id: 'v-jmj', vendor_name: 'JMJ Digital Marketing', aliases: [], sender_domains: ['jmjdigital.example'], lp_sub_sources: ['Google PPC Windows'], eligible_markets: [], default_cost_type: 'invoice', is_active: true };
  const TRAP = { id: 'v-trap', vendor_name: 'Some Vendor', aliases: [], sender_domains: ['reecewindows.com'], lp_sub_sources: [], eligible_markets: [], default_cost_type: 'invoice', is_active: true };
  assert.equal(isInternalMailDomain('reecewindows.com'), true);
  assert.equal(isInternalMailDomain('mail.reecewindowsmail.com'), true);
  assert.equal(isInternalMailDomain('leadgurus.com'), false);
  assert.equal(isInternalMailDomain('partner.example', { MKT_INTERNAL_MAIL_DOMAINS: 'partner.example' }), true);
  // An internal sender domain never matches a vendor, even a mis-seeded one.
  assert.equal(matchVendor({ fromAddress: 'm.richard@reecewindows.com', text: 'nothing', vendors: [TRAP] }).vendor, null);
  // The vendor's own e-mail printed in the invoice text matches by domain …
  const byText = matchVendor({ fromAddress: 'm.richard@reecewindows.com', text: 'Billing: ar@jmjdigital.example\nTotal $5', vendors: [JMJ] });
  assert.equal(byText.vendor?.id, 'v-jmj');
  assert.equal(byText.method, 'text_domain');
  // … but a public mailbox printed in the text never does (gmail.com is not a vendor).
  const MAILBOX = { ...TRAP, id: 'v-mailbox', vendor_name: 'Mailbox Vendor', sender_domains: ['gmail.com'] };
  assert.equal(matchVendor({ fromAddress: 'm.richard@reecewindows.com', text: JMJ_TEXT, vendors: [MAILBOX] }).vendor, null);
  // The vendor's printed name still matches on the forwarded text once the vendor exists.
  const byAlias = matchVendor({ fromAddress: 'm.richard@reecewindows.com', text: JMJ_TEXT, vendors: [JMJ] });
  assert.equal(byAlias.vendor?.id, 'v-jmj');
  assert.equal(byAlias.method, 'alias');
  assert.deepEqual(emailDomainsIn(JMJ_TEXT), ['gmail.com']);
  // Learning from an Edit on a forwarded document adds the alias, never our domain.
  const learn = vendorLearnPatch(JMJ, { alias: 'JMJ Digital Marketing, LLC', fromAddress: 'm.richard@reecewindows.com' });
  assert.deepEqual(learn.sender_domains, ['jmjdigital.example']);
  assert.deepEqual(learn.aliases, ['JMJ Digital Marketing, LLC']);
});
