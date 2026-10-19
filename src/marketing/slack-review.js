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
import { ALL_OFFICES, COST_CATEGORIES, costCategory, splitKind } from './allocation.js';

export const MKT_INVOICE_ACTION_PREFIX = 'mktinv_';
export const ACTION_MKTINV_APPROVE = 'mktinv_approve';
export const ACTION_MKTINV_REJECT = 'mktinv_reject';
export const ACTION_MKTINV_EDIT = 'mktinv_edit';
export const MKTINV_EDIT_CALLBACK = 'mktinv_edit';

export const MARKET_OPTIONS = Object.freeze([
  ['STPET_MKT', 'St. Petersburg'], ['ORL_MKT', 'Orlando'], ['FTMYR_MKT', 'Fort Myers'],
  ['FTLAU_MKT', 'Fort Lauderdale'], ['JAX_MKT', 'Jacksonville'], ['SAR_MKT', 'Sarasota'], ['REECE_HOLD', 'Hold at company level (parked, not split to any office)'],
]);

const usd = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const short = (id) => String(id || '').slice(0, 8);

export function marketLabel(code) {
  if (code === ALL_OFFICES) return 'All offices, split evenly';
  return MARKET_OPTIONS.find(([c]) => c === code)?.[1] || code;
}

/** How a line's money is split, in plain words (2026-10-13). */
export function splitLabel(row) {
  const k = splitKind(row);
  if (k === 'even') {
    const cat = costCategory(row);
    return cat ? `_${COST_CATEGORIES[cat].toLowerCase()} cost, split evenly across all offices_` : '_all offices, split evenly_';
  }
  if (k === 'by_source') return (row.lp_sub_sources || []).length ? '_markets by issued leads_' : '_no market_';
  return (row.eligible_markets || []).map(marketLabel).join(', ');
}

/**
 * The ways the Edit form can assign a line (2026-10-14, the user: "I should be
 * able to assign it to either call-center or software, and the amount will be
 * divided among all offices"). A lead source is split by its issued leads or
 * pinned to markets; call center and software are split evenly over every office.
 */
export const SPLIT_OPTIONS = Object.freeze([
  ['by_source', 'Lead source: split by its issued leads'],
  ['call_center', 'Call center cost: split evenly across all offices'],
  ['software', 'Software cost: split evenly across all offices'],
  ['markets', 'Lead source: only the markets picked below'],
]);

/** The Edit form's option for a line as it stands (an unlabelled even split reads as software). */
export function splitChoice(row) {
  const k = splitKind(row);
  if (k === 'even') return costCategory(row) || 'software';
  return k;
}

function extractionLine(extraction) {
  if (!extraction) return 'extraction: unknown';
  if (extraction.format === 'email_body') return 'read from the email body';
  if (extraction.format === 'csv' || extraction.format === 'xlsx') return `read as ${extraction.format.toUpperCase()}`;
  const pages = extraction.page_count ?? '?';
  const ocr = Number(extraction.ocr_pages || 0);
  return ocr ? `OCR ${ocr} of ${pages} page(s)` : `text layer (${pages} page(s))`;
}

/** Card only: invoice lines with the same description, sub-source and split, summed (first-seen order). */
export function groupLines(rows = []) {
  const groups = new Map();
  for (const r of rows) {
    const description = String(r.description || 'line').trim();
    const subs = (r.lp_sub_sources || []).join(', ');
    const split = splitLabel(r);
    const key = `${description}\u0000${subs}\u0000${split}`;
    const g = groups.get(key) || { description, subs, split, amount: 0, count: 0 };
    g.amount = Math.round((g.amount + (Number(r.amount) || 0)) * 100) / 100;
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()];
}

/**
 * Card only: allocation rows summed per month × market. The rule and issued
 * basis show when every summed row agrees (one month's issued counts are the
 * same for every line of a sub-source); notes are kept once each.
 */
export function groupAllocations(allocation = []) {
  const groups = new Map();
  for (const a of allocation) {
    const key = `${a.month}\u0000${a.market}`;
    const g = groups.get(key);
    if (!g) { groups.set(key, { ...a, amount: Math.round(Number(a.amount || 0) * 100) / 100, notes: a.note ? [a.note] : [] }); continue; }
    g.amount = Math.round((g.amount + Number(a.amount || 0)) * 100) / 100;
    if (g.rule !== a.rule || g.issued_basis !== a.issued_basis || g.issued_total !== a.issued_total) { g.rule = null; g.issued_basis = null; g.issued_total = null; }
    if (a.note && !g.notes.includes(a.note)) g.notes.push(a.note);
  }
  return [...groups.values()]
    .map(({ notes, ...g }) => ({ ...g, note: notes.join('; ') || undefined }))
    .sort((x, y) => (x.month === y.month ? marketLabel(x.market).localeCompare(marketLabel(y.market)) : x.month.localeCompare(y.month)));
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
  // 2026-10-13: a period the invoice never printed is assumed (the invoice date,
  // else the day it arrived) so the row can exist; the card says so. A total the
  // extraction could not read is stored as $0 and blocks Approve until edited.
  const periodNote = facts?.period_assumed_from
    ? ` _(assumed from the ${facts.period_assumed_from === 'invoice_date' ? 'invoice date' : 'day it arrived'} — Edit if this bills a month)_`
    : '';
  const totalNote = flags.includes('missing_total') ? ' _(not found on the invoice — Edit to enter it)_' : '';
  const head = [
    `*${escapeMrkdwn(title)}*`,
    `Invoice #: ${escapeMrkdwn(facts?.invoice_number || '—')} · Period: ${facts?.period_start || '?'} → ${facts?.period_end || '?'}${periodNote} · Total: *${usd(total)}*${facts?.currency && facts.currency !== 'USD' ? ` ${facts.currency}` : ''}${totalNote}`,
    `From: ${escapeMrkdwn(document?.from_address || '—')} · ${escapeMrkdwn(document?.subject || '')}`.trim(),
    vendor ? `Vendor matched by ${escapeMrkdwn(vendorMethod || 'rules')}` : '⚠️ Vendor not matched — use Edit to pick one',
  ].join('\n');

  // 2026-10-19 (the user: "why so many lines? combine per market"): the card
  // shows one line per kind of charge and one allocation line per month ×
  // market. The ledger keeps every invoice line; only the card sums them.
  const lineText = rows.length
    ? groupLines(rows).map((g) => `• ${usd(g.amount)} — ${escapeMrkdwn(g.description)}${g.count > 1 ? ` _(${g.count} lines)_` : ''} → ${escapeMrkdwn(g.subs || 'sub-source?')} · ${g.split}`).join('\n')
    : '_no lines_';

  const allocText = allocation.length
    ? groupAllocations(allocation).map((a) => `• ${a.month.slice(0, 7)} ${marketLabel(a.market)}: ${usd(a.amount)}${a.rule ? ` (${a.rule}${a.issued_total != null && a.rule !== 'direct' ? `, ${a.issued_basis}/${a.issued_total} issued` : ''})` : ''}${a.note ? ` _${escapeMrkdwn(a.note)}_` : ''}`).join('\n')
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

/**
 * The edit modal (views.open / views.update). private_metadata carries the
 * document id.
 *
 * 2026-10-19 (the user: "make it hide fields when they're not needed … as
 * simple and easy to understand as possible"): the form shows only what the
 * current choice needs, and redraws itself when "What is this cost?" or the
 * vendor pick changes (dispatch_action → handler → views.update):
 *   software / call center   → no sub-source, no markets
 *   lead source, by leads    → sub-source
 *   lead source, markets     → sub-source + markets
 *   a vendor picked          → no "New vendor" box
 * `state` is the open form's view.state.values on a redraw; what was typed or
 * picked there is carried into the new form so nothing is lost.
 */
export function buildEditView({ document, vendor, facts, rows = [], vendors = [], state = null }) {
  const first = rows[0] || {};
  const typed = (block, key = 'value') => state?.[block]?.[`mktinv_v_${block}`]?.[key];
  const had = (block) => !!(state && state[block]);
  const vendorOptions = vendors.slice(0, 100).map((v) => ({ text: { type: 'plain_text', text: String(v.vendor_name).slice(0, 75) }, value: String(v.id) }));
  const vendorPickedId = state ? typed('vendor', 'selected_option')?.value || null : (vendor ? String(vendor.id) : null);
  const vendorInitial = vendorPickedId ? vendorOptions.find((o) => o.value === vendorPickedId) : null;
  const marketOptions = MARKET_OPTIONS.map(([c, l]) => ({ text: { type: 'plain_text', text: l }, value: c }));
  const marketsPicked = had('markets') ? (typed('markets', 'selected_options') || []).map((o) => o.value) : (first.eligible_markets || []).filter((m) => m !== ALL_OFFICES);
  const marketInitial = marketOptions.filter((o) => marketsPicked.includes(o.value));
  const splitOptions = SPLIT_OPTIONS.map(([v, l]) => ({ text: { type: 'plain_text', text: l }, value: v }));
  const split = (state && typed('split', 'selected_option')?.value) || splitChoice(first);
  const splitInitial = splitOptions.find((o) => o.value === split);
  const isLeadSource = split === 'by_source' || split === 'markets';
  const rememberOption = { text: { type: 'plain_text', text: 'Use this vendor, sub-source and split for this vendor\'s next invoices' }, value: 'remember' };
  const rememberInitial = had('remember') ? (typed('remember', 'selected_options') || []) : [rememberOption];
  // On a redraw, a field the open form had keeps exactly what is in it (even
  // when cleared); a field it did not have (it was hidden) starts from the line.
  const text = (block, fallback) => String((had(block) ? typed(block) : fallback) ?? '');
  const date = (block, fallback) => (had(block) ? typed(block, 'selected_date') : fallback) || null;
  const input = (block_id, label, element, extra = {}) => ({ type: 'input', block_id, label: { type: 'plain_text', text: label }, element, optional: true, ...extra });
  const hint = (t) => ({ hint: { type: 'plain_text', text: t } });
  // A category line carries "Software" / "Call Center" as its sub-source; never
  // show that in the box when switching to a lead source.
  const subsPrefill = (first.lp_sub_sources || []).filter((x) => !Object.values(COST_CATEGORIES).some((l) => l.toLowerCase() === String(x).trim().toLowerCase())).join(', ');
  const blocks = [
    input('vendor', 'Vendor', { type: 'static_select', action_id: 'mktinv_v_vendor', placeholder: { type: 'plain_text', text: 'Pick a vendor' }, options: vendorOptions, ...(vendorInitial ? { initial_option: vendorInitial } : {}) }, { dispatch_action: true }),
  ];
  // 2026-10-13 (the user): "allow editing and adding options when they don't
  // already exist". A vendor typed here is created on Save. Hidden once one is picked.
  if (!vendorInitial) {
    blocks.push(input('new_vendor', 'New vendor (only if it is not in the list)', { type: 'plain_text_input', action_id: 'mktinv_v_new_vendor', initial_value: text('new_vendor', vendor ? '' : String(facts?.vendor_name_hint || '').slice(0, 150)) }));
  }
  blocks.push(
    input('invoice_number', 'Invoice #', { type: 'plain_text_input', action_id: 'mktinv_v_invoice_number', initial_value: text('invoice_number', facts?.invoice_number) }),
    input('period_start', 'Period start', { type: 'datepicker', action_id: 'mktinv_v_period_start', ...(date('period_start', facts?.period_start) ? { initial_date: date('period_start', facts?.period_start) } : {}) }),
    input('period_end', 'Period end', { type: 'datepicker', action_id: 'mktinv_v_period_end', ...(date('period_end', facts?.period_end) ? { initial_date: date('period_end', facts?.period_end) } : {}) }),
    input('amount', rows.length > 1 ? 'Total (leave blank to keep the lines as they are)' : 'Amount', { type: 'plain_text_input', action_id: 'mktinv_v_amount', initial_value: text('amount', first.amount != null ? String(first.amount) : '') }),
    input('split', 'What is this cost?', { type: 'radio_buttons', action_id: 'mktinv_v_split', options: splitOptions, ...(splitInitial ? { initial_option: splitInitial } : {}) }, { dispatch_action: true }),
  );
  if (isLeadSource) {
    blocks.push(input('sub_source', 'LP sub-source', { type: 'plain_text_input', action_id: 'mktinv_v_sub_source', initial_value: text('sub_source', subsPrefill) }, hint('Must match the sub-source in Lead Perfection exactly.')));
  }
  if (split === 'markets') {
    blocks.push(input('markets', 'Markets', { type: 'multi_static_select', action_id: 'mktinv_v_markets', placeholder: { type: 'plain_text', text: 'Pick one or more' }, options: marketOptions, ...(marketInitial.length ? { initial_options: marketInitial } : {}) },
      hint('One office gets all of it. Several are split by their issued leads. "Hold at company level" parks it unassigned (not split) until you move it.')));
  }
  blocks.push(input('remember', 'Remember', { type: 'checkboxes', action_id: 'mktinv_v_remember', options: [rememberOption], ...(rememberInitial.length ? { initial_options: [rememberOption] } : {}) }));
  return {
    type: 'modal',
    callback_id: MKTINV_EDIT_CALLBACK,
    private_metadata: String(document.id),
    title: { type: 'plain_text', text: 'Edit invoice' },
    submit: { type: 'plain_text', text: 'Save' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks,
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
    new_vendor: String(get('new_vendor', 'value') || '').trim().slice(0, 150) || null,
    split: get('split', 'selected_option')?.value || null,
    remember: (get('remember', 'selected_options') || []).some((o) => o.value === 'remember'),
  };
}

/**
 * The eligible_markets a submitted split means: [] = by the sub-source's
 * issued leads, [ALL_OFFICES] = evenly over every office (call center,
 * software, or the older plain "even"), else the markets picked. null = the
 * form said nothing about markets (keep what the line has).
 */
export function marketsForSplit({ split, eligible_markets = [] }) {
  if (split === 'even' || COST_CATEGORIES[split]) return [ALL_OFFICES];
  if (split === 'by_source') return [];
  if (split === 'markets') return eligible_markets.length ? eligible_markets : null;
  return eligible_markets.length ? eligible_markets : null;
}

const isCategoryLabel = (s) => Object.values(COST_CATEGORIES).some((l) => l.toLowerCase() === String(s).trim().toLowerCase());

/**
 * The sub-sources a submitted form writes on the line. A category split writes
 * its label ("Call Center" / "Software") whatever the box says; a lead-source
 * split drops a leftover category label (the box is prefilled from the line, so
 * switching Software back to a lead source would otherwise keep "Software").
 */
export function subSourcesForSplit({ split, lp_sub_sources = [] }) {
  if (COST_CATEGORIES[split]) return [COST_CATEGORIES[split]];
  if (split === 'by_source' || split === 'markets') return lp_sub_sources.filter((s) => !isCategoryLabel(s));
  return lp_sub_sources;
}
