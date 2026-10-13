/**
 * test-marketing-invoice-formats.js — one realistic sample of every email
 * format the invoice inbox receives (the user, 2026-10-13: "We need to ensure
 * our system can reliably extract information and data from emails in various
 * formats"). Each sample goes through the real extractor and the real rules;
 * only the PDF/OCR service is a stub.
 *
 * Covered: plain and HTML email bodies (entities, tables, Outlook forwards,
 * FreshBooks / QuickBooks / Stripe-style receipts), PDF, image, CSV, XLSX,
 * Word .docx, a .docx with an odd name, a forwarded .eml with a PDF inside
 * (base64 and quoted-printable parts, inline logos skipped), and the formats
 * nothing here can open (.xls, .doc, .msg), which must come back
 * 'unsupported', never a junk card.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';

delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.INJECTION_GUARD_MODE = 'shadow';

import { extractDocument, documentKind, htmlToText, cleanEmailBody, decodeEntities, mimeParts } from '../src/marketing/extract-client.js';
import { extractInvoiceFacts } from '../src/marketing/invoice-rules.js';
import { triageExtraction } from '../src/marketing/invoice-triage.js';
import { ingestInvoice } from '../src/jobs/marketing-invoice-ingest.js';
import { fakeSupabase } from './lib/fake-supabase.js';

// The PDF / OCR service stub: it "reads" a buffer as its own utf8 text.
const service = { extractViaService: async (buffer) => ({ text: buffer.toString('utf8').replace(/^%PDF-1\.7\n/, ''), meta: { format: 'document', page_count: 1, ocr_pages: 0, engine: 'stub' } }) };
const pdf = (text) => Buffer.from(`%PDF-1.7\n${text}`);

async function docx(paragraphs, { table = null } = {}) {
  const zip = new JSZip();
  const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`;
  const tbl = table ? `<w:tbl>${table.map((row) => `<w:tr>${row.map((c) => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : '';
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${paragraphs.map(p).join('')}${tbl}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function eml({ from = 'Billing <billing@vendor.example>', subject = 'Invoice', text = null, html = null, attachments = [], qp = false }) {
  const b = 'BOUNDARY_123';
  const parts = [];
  if (text != null) parts.push(`Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: ${qp ? 'quoted-printable' : '7bit'}\r\n\r\n${qp ? text.replace(/=/g, '=3D').replace(/\$/g, '=24') : text}`);
  if (html != null) parts.push(`Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(html).toString('base64')}`);
  for (const a of attachments) {
    parts.push(`Content-Type: ${a.type}; name="${a.name}"\r\nContent-Disposition: ${a.inline ? 'inline' : 'attachment'}; filename="${a.name}"\r\n${a.inline ? 'Content-ID: <logo@x>\r\n' : ''}Content-Transfer-Encoding: base64\r\n\r\n${a.data.toString('base64').replace(/(.{76})/g, '$1\r\n')}`);
  }
  return Buffer.from(`From: ${from}\r\nTo: marketing-invoices@reecewindowsmail.com\r\nSubject: ${subject}\r\nDate: Tue, 13 Oct 2026 15:05:00 -0400\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n--${b}\r\n${parts.join(`\r\n--${b}\r\n`)}\r\n--${b}--\r\n`, 'latin1');
}

const facts = async (buffer, opts = {}) => {
  const x = await extractDocument(buffer, opts, service);
  return { x, f: extractInvoiceFacts(x.text), t: triageExtraction({ text: x.text, kind: x.kind, meta: x.meta }) };
};

test('file kinds are told by content first: PDF, PNG, JPEG, GIF, WEBP, zip, old Office, eml, html', () => {
  assert.equal(documentKind(pdf('x'), { fileName: 'invoice' }), 'pdf');
  assert.equal(documentKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), {}), 'image');
  assert.equal(documentKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { fileName: 'scan' }), 'image');
  assert.equal(documentKind(Buffer.from('GIF89a....'), {}), 'image');
  assert.equal(documentKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]), {}), 'image');
  assert.equal(documentKind(Buffer.from('PK\u0003\u0004rest'), { fileName: 'x.docx' }), 'docx');
  assert.equal(documentKind(Buffer.from('PK\u0003\u0004rest'), { fileName: 'attachment' }), 'zip');
  assert.equal(documentKind(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]), { fileName: 'invoice.xls' }), 'unsupported');
  assert.equal(documentKind(Buffer.from('anything'), { fileName: 'note.msg' }), 'unsupported');
  assert.equal(documentKind(Buffer.from('From: a@b.com\r\nSubject: x\r\nContent-Type: text/plain\r\n\r\nhi'), { fileName: 'fwd' }), 'eml');
  assert.equal(documentKind(Buffer.from('<!DOCTYPE html><html><body>x</body></html>'), { fileName: 'receipt' }), 'html');
  assert.equal(documentKind(pdf('x'), { fileName: 'weird.bin', mimeType: 'application/octet-stream' }), 'pdf');
});

test('HTML: tags, scripts and entities out; table cells apart; link targets kept', () => {
  const html = '<html><head><style>.x{color:red}</style></head><body><script>alert(1)</script><p>Invoice&nbsp;#&nbsp;00046476</p><table><tr><td>Description</td><td>Amount</td></tr><tr><td>Lead fee</td><td>&#36;2,800.00</td></tr></table><p>Total Due: &dollar;2,800.00</p><a href="https://acme.sharepoint.com/x">Receipt-1.pdf</a></body></html>';
  const t = htmlToText(html);
  assert.ok(!/alert|color:red|</.test(t));
  assert.match(t, /Invoice # 00046476/);
  assert.match(t, /Lead fee \| \$2,800\.00/);
  assert.match(t, /Receipt-1\.pdf \(https:\/\/acme\.sharepoint\.com\/x\)/);
  assert.equal(decodeEntities('A &amp; B &lt;x&gt; &#x24;5 &unknown;'), 'A & B <x> $5 &unknown;');
});

test('email body: the part that names an amount wins (Outlook forward with the amount only in the HTML)', () => {
  const text = 'See below.\n\n[cid:abc]\nMark Richard';
  const html = '<div>See below.</div><table><tr><td>Amount Due</td><td>$1,250.00</td></tr></table>';
  assert.match(cleanEmailBody(text, html), /Amount Due \| \$1,250\.00/);
  assert.equal(cleanEmailBody('Total $5', '<p>Total $9</p>'), 'Total $5');
  assert.match(cleanEmailBody('<p>Amount&nbsp;due &#36;7.00</p>', null), /Amount due \$7\.00/, 'an HTML body sent as text is read as HTML');
});

test('FreshBooks forward (HTML body, escaped headers): invoice #, date and total', async () => {
  const html = '<div>From: My Home Renovator, Inc. via FreshBooks &lt;mail@fb05.freshbooks.com&gt;</div><div>Subject: My Home Renovator, Inc. sent you an invoice (00046476)</div><table><tr><td>Invoice</td><td>00046476</td></tr><tr><td>Invoice Date</td><td>10/06/2026</td></tr><tr><td>Amount Due</td><td>$2,800.00 USD</td></tr></table>';
  const { x, f, t } = await facts(null, { bodyText: '', bodyHtml: html });
  assert.equal(x.meta.format, 'email_body');
  assert.equal(t.verdict, 'invoice');
  assert.equal(f.invoice_number, '00046476');
  assert.equal(f.invoice_date, '2026-10-06');
  assert.equal(f.total, 2800);
});

test('QuickBooks reminder body: amount, due and invoice number', async () => {
  const body = 'Dear Reece Windows,\nHere\'s invoice 1883 for $3,624.60.\nThe amount due on invoice 1883 is $3,624.60.\nInvoice date: 10/02/2026\nDue date: 10/09/2026\nThanks for your business!\nJMJ Digital Marketing, LLC';
  const { f } = await facts(null, { bodyText: body });
  assert.equal(f.invoice_number, '1883');
  assert.equal(f.total, 3624.6);
  assert.equal(f.invoice_date, '2026-10-02');
});

test('Stripe-style receipt (HTML): receipt #, date paid, amount paid and a one-year range', async () => {
  const html = '<h1>Receipt from Hatch</h1><p>Receipt #2757-9497</p><table><tr><td>Amount paid</td><td>$249.00</td></tr><tr><td>Date paid</td><td>October 1, 2026</td></tr></table><table><tr><td>Hatch Pro</td><td>Oct 1 – Nov 1, 2026</td><td>Qty 1</td><td>$249.00</td></tr></table>';
  const { f } = await facts(Buffer.from(html), { fileName: 'receipt.html', mimeType: 'text/html' });
  assert.deepEqual([f.invoice_number, f.invoice_date, f.total, f.period_start, f.period_end], ['2757-9497', '2026-10-01', 249, '2026-10-01', '2026-11-01']);
});

test('PDF and a scanned image go to the service; their text reads the same way', async () => {
  const { x, f } = await facts(pdf('Lead Gurus LLC\nInvoice # LG-9\nService Period: 09/01/2026 - 09/30/2026\nAmount Due $1,000.00'), { fileName: 'LG-9.pdf' });
  assert.equal(x.kind, 'pdf');
  assert.deepEqual([f.invoice_number, f.period_start, f.period_end, f.total], ['LG-9', '2026-09-01', '2026-09-30', 1000]);
  const img = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('\nINVOICE 55\nTotal $12.00')]);
  const r = await facts(img, { fileName: 'scan.png' });
  assert.equal(r.x.kind, 'image');
  assert.equal(r.f.total, 12);
});

test('CSV and XLSX are read in-process', async () => {
  const csv = await facts(Buffer.from('Description,Amount\nLeads,600.00\nTotal,600.00\n'), { fileName: 'inv.csv' });
  assert.equal(csv.x.kind, 'csv');
  assert.equal(csv.f.total, 600);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Invoice');
  ws.addRow(['Invoice #', 'X-77']); ws.addRow(['Billing period', '09/01/2026 - 09/30/2026']); ws.addRow(['Total Due', 450]);
  const xl = await facts(Buffer.from(await wb.xlsx.writeBuffer()), { fileName: 'inv.xlsx' });
  assert.equal(xl.x.kind, 'xlsx');
  assert.match(xl.x.text, /Total Due \| 450/);
});

test('Word .docx (and a .docx with an odd name): paragraphs and table cells', async () => {
  const buf = await docx(['ACME Media', 'Invoice # AM-12', 'Service period: 10/01/2026 - 10/31/2026'], { table: [['Item', 'Amount'], ['Radio spots', '$900.00'], ['Total Due', '$900.00']] });
  const a = await facts(buf, { fileName: 'AM-12.docx' });
  assert.equal(a.x.kind, 'docx');
  assert.match(a.x.text, /Radio spots \| \$900\.00/);
  assert.deepEqual([a.f.invoice_number, a.f.period_start, a.f.total], ['AM-12', '2026-10-01', 900]);
  const b = await facts(buf, { fileName: 'attachment', mimeType: 'application/octet-stream' });
  assert.equal(b.x.kind, 'docx', 'a zip with word/document.xml is a Word file whatever its name');
});

test('a forwarded .eml: body + the PDF inside it, the inline logo skipped, quoted-printable decoded', async () => {
  const logo = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(200)]);
  const msg = eml({
    subject: 'Fw: Invoice 1883', qp: true,
    text: 'Please see the attached invoice. Amount due $3,624.60',
    attachments: [{ name: 'logo.png', type: 'image/png', data: logo, inline: true }, { name: 'INVOICE_1883.pdf', type: 'application/pdf', data: pdf('JMJ Digital Marketing, LLC\nInvoice no.: 1883\nInvoice date: 10/02/2026\nTotal $3,624.60') }],
  });
  assert.ok(mimeParts(msg.toString('latin1')).length >= 3);
  const { x, f, t } = await facts(msg, { fileName: 'Fw Invoice 1883.eml', mimeType: 'message/rfc822' });
  assert.equal(x.kind, 'eml');
  assert.equal(t.verdict, 'invoice');
  assert.match(x.text, /Subject: Fw: Invoice 1883/);
  assert.match(x.text, /Amount due \$3,624\.60/, 'quoted-printable =24 decoded to $');
  assert.match(x.text, /--- attachment: INVOICE_1883\.pdf ---/);
  assert.ok(!/logo\.png/.test(x.text), 'an inline logo is not read');
  assert.deepEqual(x.meta.attachments.map((a) => [a.name, a.read]), [['INVOICE_1883.pdf', true]]);
  assert.deepEqual([f.invoice_number, f.invoice_date, f.total], ['1883', '2026-10-02', 3624.6]);
});

test('an .eml whose only content is an HTML body still reads', async () => {
  const msg = eml({ html: '<p>Statement</p><p>Billing period: October 1 - 31, 2026</p><p>Total charged: <b>$1,200.00</b></p>' });
  const { f } = await facts(msg, { fileName: 'statement.eml' });
  assert.deepEqual([f.period_start, f.period_end, f.total], ['2026-10-01', '2026-10-31', 1200]);
});

test('old .xls / .doc / .msg: unsupported, never a document, one note asking for a PDF', async () => {
  const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
  const x = await extractDocument(ole, { fileName: 'October.xls' }, service);
  assert.equal(x.kind, 'unsupported');
  assert.equal(x.meta.format, 'xls');
  const supabase = fakeSupabase({ marketing_vendors: [], slack_market_slugs: [], marketing_invoice_documents: [], marketing_expenses: [], marketing_expense_allocations: [] });
  const posts = [];
  const r = await ingestInvoice({ gmail_message_id: 'x1', from: 'ar@vendor.example', subject: 'October invoice', received_at: '2026-10-13T12:00:00Z', file_name: 'October.xls', mime_type: 'application/vnd.ms-excel', file_b64: ole.toString('base64') }, {
    supabase, cfg: { minPrior: 2, minConfidence: 0.85, channelId: 'C_REVIEW' }, extractDeps: service,
    postToSlack: async (text, channel) => { posts.push({ text, channel }); return { ok: true, ts: '1.0', channel }; },
  });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'unsupported_format');
  assert.equal(supabase.tables.marketing_invoice_documents.length, 0);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /October\.xls.*xls file.*Save it as PDF/);
});

test('an n8n payload with only the HTML body part reaches the ledger with its facts', async () => {
  const supabase = fakeSupabase({ marketing_vendors: [], slack_market_slugs: [], marketing_invoice_documents: [], marketing_expenses: [], marketing_expense_allocations: [] }, { rpc: { mkt_issued_counts: async () => [] } });
  const posts = [];
  const html = '<table><tr><td>Invoice #</td><td>INV-4410</td></tr><tr><td>Service period</td><td>09/01/2026 - 09/30/2026</td></tr><tr><td>Balance Due</td><td>$5,000.00</td></tr></table>';
  const r = await ingestInvoice({ gmail_message_id: 'h1', from: 'ar@vendor.example', subject: 'Invoice INV-4410', received_at: '2026-10-13T12:00:00Z', body_text: '', body_html: html }, {
    supabase, cfg: { minPrior: 2, minConfidence: 0.85, channelId: 'C_REVIEW' },
    analyzeDeps: { callJson: async () => ({ data: null }), guard: async () => ({ mode: 'shadow', verdict: 'clean', score: 0, block: false }) },
    postToSlack: async (text, channel, opts) => { posts.push({ text, channel, opts }); return { ok: true, ts: '1.0', channel }; },
    signedLink: async () => null,
  });
  assert.equal(r.success, true);
  const doc = supabase.tables.marketing_invoice_documents[0];
  assert.deepEqual([doc.analysis.facts.invoice_number, doc.analysis.facts.total, doc.analysis.facts.period_start], ['INV-4410', 5000, '2026-09-01']);
  assert.equal(supabase.tables.marketing_expenses[0].amount, 5000);
});
