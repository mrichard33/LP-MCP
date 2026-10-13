/**
 * The invoice review card and edit modal — src/marketing/slack-review.js (pure).
 *
 * Builds the Block Kit for #marketing-invoice-review (handoff §8): vendor,
 * invoice #, period, total; each line with its sub-source + markets +
 * evidence; the allocation preview; flags and confidence; how the text was
 * read; a 7-day link to the original; and the three buttons
 * mktinv_approve / mktinv_reject / mktinv_edit (value = document id).
 *
 * Only Mark and Brad Codman may decide (D6): the handler in review-actions.js
 * checks MKT_INVOICE_APPROVER_SLACK_IDS; this file only draws.
 */
import { escapeMrkdwn } from '../slack-approvals-core.js';
import { FLAG_LABELS } from './expense-builder.js';

export const MKT_INVOICE_ACTION_PREFIX = 'mktinv_';
export const ACTION_MKTINV_APPROVE = 'mktinv_approve';
export const ACTION_MKTINV_REJECT = 'mktinv_reject';
export const ACTION_MKTINV_EDIT = 'mktinv_edit';
export const MKTINV_EDIT_CALLBACK = 'mktinv_edit';

export const MARKET_OPTIONS = Object.freeze([
  ['STPET_MKT', 'St. Petersburg'], ['ORL_MKT', 'Orlando'], ['FTMYR_MKT', 'Fort Myers'],
  ['FTLAU_MKT', 'Fort Lauderdale'], ['JAX_MKT', 'Jacksonville'], ['SAR_MKT', 'Sarasota'], ['REECE_HOLD', 'Hold at company level'],
]);

const usd = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const short = (id) => String(id || '').slice(0, 8);

export function marketLabel(code) {
  return MARKET_OPTIONS.find(([c]) => c === code)?.[1] || code;
}

function extractionLine(extraction) {
  if (!extraction) return 'extraction: unknown';
  if (extraction.format === 'email_body') return 'read from the email body';
  if (extraction.format === 'csv' || extraction.format === 'xlsx') return `read as ${extraction.format.toUpperCase()}`;
  const pages = extraction.page_count ?? '?';
  const ocr = Number(extraction.ocr_pages || 0);
  return ocr ? `OCR ${ocr} of ${pages} page(s)` : `text layer (${pages} page(s))`;
}

/**
 * @param {object} p
 * @param {object} p.document
 * @param {object|null} p.vendor
 * @param {object} p.facts
 * @param {Array}  p.rows           expense rows (pending or approved)
 * @param {Array}  [p.allocation]   preview rows {month, market, amount, rule, issued_basis, issued_total}
 * @param {string[]} [p.flags]
 * @param {number|null} [p.confidence]
 * @param {object} [p.extraction]
 * @param {string|null} [p.link]
 * @param {string} [p.vendorMethod]
 * @param {string[]} [p.disagreements]
 * @param {object} [p.decision]     { by, at, outcome } once decided
 * @param {string} [p.note]         a line to append (e.g. "edited by …")
 */
export function buildReviewCard({
  document, vendor, facts, rows = [], allocation = [], flags = [], confidence = null, extraction = null,
  link = null, vendorMethod = null, disagreements = [], decision = null, note = null,
}) {
  const vendorName = vendor?.vendor_name || facts?.vendor_name_hint || 'Unknown vendor';
  const title = `Marketing invoice · ${vendorName}`;
  const total = rows.length ? rows.reduce((a, r) => a + (Number(r.amount) || 0), 0) : facts?.total;
  const head = [
    `*${escapeMrkdwn(title)}*`,
    `Invoice #: ${escapeMrkdwn(facts?.invoice_number || '—')} · Period: ${facts?.period_start || '?'} → ${facts?.period_end || '?'} · Total: *${usd(total)}*${facts?.currency && facts.currency !== 'USD' ? ` ${facts.currency}` : ''}`,
    `From: ${escapeMrkdwn(document?.from_address || '—')} · ${escapeMrkdwn(document?.subject || '')}`.trim(),
    vendor ? `Vendor matched by ${escapeMrkdwn(vendorMethod || 'rules')}` : '⚠️ Vendor not matched — use Edit to pick one',
  ].join('\n');

  const lineText = rows.length
    ? rows.map((r) => `• ${usd(r.amount)} — ${escapeMrkdwn(r.description || 'line')} → ${escapeMrkdwn((r.lp_sub_sources || []).join(', ') || 'sub-source?')} · ${(r.eligible_markets || []).map(marketLabel).join(', ') || '_no market_'}`).join('\n')
    : '_no lines_';

  const allocText = allocation.length
    ? allocation.map((a) => `• ${a.month.slice(0, 7)} ${marketLabel(a.market)}: ${usd(a.amount)} (${a.rule}${a.issued_total != null && a.rule !== 'direct' ? `, ${a.issued_basis}/${a.issued_total} issued` : ''})`).join('\n')
    : '_cannot preview: fix the flags first_';

  const flagText = flags.length
    ? `⚠️ *Needs a look:*\n${flags.map((f) => `• ${escapeMrkdwn(FLAG_LABELS[f] || f)}`).join('\n')}${disagreements.length ? `\n_${escapeMrkdwn(disagreements.join('; '))}_` : ''}`
    : '✅ No flags';

  const context = `Confidence ${confidence == null ? '—' : Number(confidence).toFixed(2)} · ${extractionLine(extraction)} · analyzer ${document?.analyzer || 'rules'} · ref ${short(document?.id)}${link ? ` · <${link}|original file (7-day link)>` : ''}`;

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: head.slice(0, 2900) } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Lines*\n${lineText}`.slice(0, 2900) } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Allocation ${decision ? '' : 'preview '}by gross issued leads*\n${allocText}`.slice(0, 2900) } },
    { type: 'section', text: { type: 'mrkdwn', text: flagText.slice(0, 2900) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: context.slice(0, 2900) }] },
  ];
  if (note) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: escapeMrkdwn(note).slice(0, 2900) }] });

  if (decision) {
    const icon = decision.outcome === 'approved' ? '✅' : decision.outcome === 'auto_approved' ? '🤖✅' : '🚫';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${icon} *${decision.outcome.replace('_', ' ')}* by ${escapeMrkdwn(decision.by)} · ${decision.at}` } });
  } else {
    blocks.push({
      type: 'actions',
      block_id: `mktinv_${document?.id}`,
      elements: [
        {
          type: 'button', action_id: ACTION_MKTINV_APPROVE, style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: String(document?.id),
          confirm: {
            title: { type: 'plain_text', text: 'Approve this invoice?' },
            text: { type: 'mrkdwn', text: `Posts ${usd(total)} to the ledger and allocates it as previewed.` },
            confirm: { type: 'plain_text', text: 'Approve' }, deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
        { type: 'button', action_id: ACTION_MKTINV_EDIT, text: { type: 'plain_text', text: 'Edit' }, value: String(document?.id) },
        { type: 'button', action_id: ACTION_MKTINV_REJECT, style: 'danger', text: { type: 'plain_text', text: 'Reject' }, value: String(document?.id) },
      ],
    });
  }
  const text = `${title} — ${usd(total)} · ${facts?.period_start || '?'}→${facts?.period_end || '?'}${flags.length ? ` · ${flags.length} flag(s)` : ''}${decision ? ` · ${decision.outcome}` : ' · needs a decision'}`;
  return { text, blocks };
}

/** The edit modal (views.open). private_metadata carries the document id. */
export function buildEditView({ document, vendor, facts, rows = [], vendors = [] }) {
  const first = rows[0] || {};
  const vendorOptions = vendors.slice(0, 100).map((v) => ({ text: { type: 'plain_text', text: String(v.vendor_name).slice(0, 75) }, value: String(v.id) }));
  const vendorInitial = vendor ? vendorOptions.find((o) => o.value === String(vendor.id)) : null;
  const marketOptions = MARKET_OPTIONS.map(([c, l]) => ({ text: { type: 'plain_text', text: l }, value: c }));
  const marketInitial = marketOptions.filter((o) => (first.eligible_markets || []).includes(o.value));
  const input = (block_id, label, element) => ({ type: 'input', block_id, label: { type: 'plain_text', text: label }, element, optional: true });
  return {
    type: 'modal',
    callback_id: MKTINV_EDIT_CALLBACK,
    private_metadata: String(document.id),
    title: { type: 'plain_text', text: 'Edit invoice' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      input('vendor', 'Vendor', { type: 'static_select', action_id: 'mktinv_v_vendor', options: vendorOptions, ...(vendorInitial ? { initial_option: vendorInitial } : {}) }),
      input('invoice_number', 'Invoice #', { type: 'plain_text_input', action_id: 'mktinv_v_invoice_number', initial_value: String(facts?.invoice_number || '') }),
      input('period_start', 'Period start', { type: 'datepicker', action_id: 'mktinv_v_period_start', ...(facts?.period_start ? { initial_date: facts.period_start } : {}) }),
      input('period_end', 'Period end', { type: 'datepicker', action_id: 'mktinv_v_period_end', ...(facts?.period_end ? { initial_date: facts.period_end } : {}) }),
      input('amount', rows.length > 1 ? 'Total (leave blank to keep the lines as they are)' : 'Amount', { type: 'plain_text_input', action_id: 'mktinv_v_amount', initial_value: first.amount != null ? String(first.amount) : '' }),
      input('sub_source', 'LP sub-source (exact lead_source_detail)', { type: 'plain_text_input', action_id: 'mktinv_v_sub_source', initial_value: (first.lp_sub_sources || []).join(', ') }),
      input('markets', 'Markets this invoice is for', { type: 'multi_static_select', action_id: 'mktinv_v_markets', options: marketOptions, ...(marketInitial.length ? { initial_options: marketInitial } : {}) }),
    ],
  };
}

/** The values a submitted edit modal carries → a plain object (nulls where blank). */
export function parseEditSubmission(stateValues = {}) {
  const get = (block, key) => stateValues?.[block]?.[`mktinv_v_${block}`]?.[key];
  const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    vendor_id: get('vendor', 'selected_option')?.value || null,
    invoice_number: (get('invoice_number', 'value') || '').trim() || null,
    period_start: get('period_start', 'selected_date') || null,
    period_end: get('period_end', 'selected_date') || null,
    amount: num(get('amount', 'value')),
    lp_sub_sources: list(get('sub_source', 'value')),
    eligible_markets: (get('markets', 'selected_options') || []).map((o) => o.value),
  };
}
