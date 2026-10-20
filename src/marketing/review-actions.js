/**
 * Slack review decisions — src/marketing/review-actions.js
 *
 * What happens when Mark or Brad clicks Approve / Edit / Reject on the invoice
 * card, or saves the Edit modal (handoff §8). Called from the Slack front door
 * (src/slack-approvals.js) with the parsed interaction; every network and
 * database call goes through `deps` so the flow is testable offline.
 *
 *   approve      rows → approved (who, when) → allocate each (allocation-io) →
 *                Lead Gurus true-up when the vendor is the feed vendor →
 *                document posted → card replaced with the final allocation
 *   reject       rows + document → rejected, card replaced
 *   edit         views.open with the edit modal (trigger_id lives 3 s)
 *   edit_submit  rows rewritten from the modal, the vendor learns the alias /
 *                sender domain, flags recomputed, card re-rendered with a new preview
 *
 * Authorisation: MKT_INVOICE_APPROVER_SLACK_IDS. Empty = nobody (same rule as
 * parseApproverIds everywhere else). A refusal is an ephemeral reply; the card
 * is never touched by someone who may not decide.
 */
import supabaseDefault from '../supabase.js';
import { postToSlack, updateSlackMessage } from '../slack.js';
import { parseApproverIds } from '../slack-approvals-core.js';
import { allocateExpenseById, previewAllocation, deleteAllocations } from './allocation-io.js';
import { trueUpInvoice } from './leadgurus-feed.js';
import { buildReviewCard, buildEditView, buildDecisionReply, parseEditSubmission, marketsForSplit, subSourcesForSplit } from './slack-review.js';
import { computeFlags } from './expense-builder.js';
import { vendorLearnPatch, normalizeName } from './vendors.js';
import { splitsEvenly, callCenterLineKind, DISPUTED_MARKET } from './allocation.js';

const LOG = '[MktReview]';

export function reviewChannelId(env = process.env) {
  return String(env.SLACK_MKT_INVOICE_CHANNEL_ID || '').trim();
}
export function invoiceApprovers(env = process.env) {
  return parseApproverIds(env.MKT_INVOICE_APPROVER_SLACK_IDS);
}

async function respond(responseUrl, body) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  } catch (err) {
    console.warn(`${LOG} response_url post failed: ${err.message}`);
  }
}

/** views.open. Needs the bot's `views:open`-capable token (chat:write apps have it). Never throws. */
export async function openSlackView(triggerId, view, { token = process.env.SLACK_BOT_TOKEN, fetchImpl = fetch } = {}) {
  if (!triggerId) return { ok: false, error: 'no_trigger_id' };
  if (!token) return { ok: false, error: 'no_token' };
  try {
    const res = await fetchImpl('https://slack.com/api/views.open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ trigger_id: triggerId, view }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({}));
    return body?.ok ? { ok: true } : { ok: false, error: String(body?.error || res.status) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** views.update — redraw an open modal. Never throws. `hash` guards against racing a newer redraw. */
export async function updateSlackView(viewId, view, { hash = '', token = process.env.SLACK_BOT_TOKEN, fetchImpl = fetch } = {}) {
  if (!viewId) return { ok: false, error: 'no_view_id' };
  if (!token) return { ok: false, error: 'no_token' };
  try {
    const res = await fetchImpl('https://slack.com/api/views.update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ view_id: viewId, view, ...(hash ? { hash } : {}) }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({}));
    return body?.ok ? { ok: true } : { ok: false, error: String(body?.error || res.status) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Everything the card needs for one document. */
export async function loadReviewContext(documentId, { supabase = supabaseDefault } = {}) {
  const { data: document, error } = await supabase.from('marketing_invoice_documents').select('*').eq('id', documentId).maybeSingle();
  if (error) throw new Error(`document read failed: ${error.message}`);
  if (!document) return null;
  const { data: rows, error: rErr } = await supabase.from('marketing_expenses').select('*').eq('document_id', documentId).order('line_no');
  if (rErr) throw new Error(`expenses read failed: ${rErr.message}`);
  const vendorId = rows?.find((r) => r.vendor_id)?.vendor_id || null;
  let vendor = null;
  if (vendorId) {
    const { data } = await supabase.from('marketing_vendors').select('*').eq('id', vendorId).maybeSingle();
    vendor = data || null;
  }
  const analysis = document.analysis || {};
  return { document, rows: rows || [], vendor, facts: analysis.facts || {}, flags: analysis.flags || [], confidence: analysis.confidence ?? null, extraction: document.extraction_meta || null, vendorMethod: analysis.vendor_method || null, disagreements: analysis.disagreements || [] };
}

/** Preview allocations for every row that can be allocated (eligible markets + period + amount). */
export async function previewRows(rows, deps) {
  const out = [];
  for (const r of rows) {
    // No markets picked = split by the sub-source's issued leads (2026-10-13), so
    // such a row previews as long as it names a sub-source.
    if ((!(r.eligible_markets || []).length && !(r.lp_sub_sources || []).length) || !r.period_start || !r.period_end || r.amount == null || Number(r.amount) === 0) continue;
    // (an even split over all offices needs no sub-source and always previews)
    const kind = callCenterLineKind(r);
    try { out.push(...(await previewAllocation(r, deps)).map((a) => ({ ...a, expense_id: r.id, kind }))); } catch (err) { console.warn(`${LOG} preview ${r.id}: ${err.message}`); }
  }
  return out;
}

export async function renderCard(ctx, { decision = null, note = null } = {}, deps = {}) {
  // The card says what each split was based on (demos, sales, issued leads), so
  // every allocation row carries the kind of its invoice line.
  const kindOf = new Map(ctx.rows.map((r) => [r.id, callCenterLineKind(r)]));
  const allocation = decision
    ? (await loadAllocations(ctx.rows.map((r) => r.id), deps)).map((a) => ({ ...a, kind: kindOf.get(a.expense_id) || null }))
    : await previewRows(ctx.rows, deps);
  return buildReviewCard({ ...ctx, allocation, decision, note });
}

async function loadAllocations(expenseIds, { supabase = supabaseDefault } = {}) {
  if (!expenseIds.length) return [];
  const { data } = await supabase.from('marketing_expense_allocations').select('expense_id, month, market, amount, rule, issued_basis, issued_total, recommendation_reason').in('expense_id', expenseIds).order('month');
  return (data || []).map(({ recommendation_reason, ...r }) => (r.rule === 'hold' && recommendation_reason ? { ...r, note: recommendation_reason } : r));
}

async function updateCard(ctx, card, deps) {
  const update = deps.updateSlackMessage || updateSlackMessage;
  const channel = ctx.document.slack_channel || reviewChannelId(deps.env);
  if (!ctx.document.slack_ts || !channel) return { ok: false, error: 'no_card' };
  return update(channel, ctx.document.slack_ts, card.text, { blocks: card.blocks });
}

/**
 * One reply in the card's thread (2026-10-19, the user: the approval "right below
 * as a reply to the thread so it is always directly attached"). Best effort: a
 * failed reply is a log line, never a reason to undo the decision.
 */
export async function postDecisionReply(document, text, deps = {}) {
  const channel = document?.slack_channel || reviewChannelId(deps.env);
  if (!document?.slack_ts || !channel || !text) return { ok: false, error: 'no_card' };
  const r = await (deps.postToSlack || postToSlack)(text, channel, { threadTs: document.slack_ts });
  if (!r?.ok) console.warn(`${LOG} decision reply for ${document.id} not posted: ${r?.error}`);
  return r || { ok: false };
}

/**
 * The entry point the front door calls. `parsed` is parseMarketingInvoiceInteraction's result.
 */
export async function handleMarketingInvoiceInteraction(parsed, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const approvers = deps.approvers || invoiceApprovers(deps.env);
  const reply = deps.reply || respond;
  const { decision, documentId, userId, userName, responseUrl } = parsed;
  const who = `${userName} (${userId})`;

  if (!approvers.has(userId)) {
    console.warn(`${LOG} refused ${decision} on ${documentId} from non-approver ${who}`);
    await reply(responseUrl, { response_type: 'ephemeral', replace_original: false, text: 'Only Mark and Brad can decide marketing invoices. Nothing changed.' });
    return { handled: true, action: 'unauthorized' };
  }

  const ctx = await loadReviewContext(documentId, { supabase });
  if (!ctx) {
    await reply(responseUrl, { response_type: 'ephemeral', replace_original: false, text: 'That invoice is no longer in the ledger.' });
    return { handled: true, action: 'not_found' };
  }
  const pending = ctx.rows.filter((r) => r.status === 'pending_review');

  if (decision === 'edit') {
    const { data: vendors } = await supabase.from('marketing_vendors').select('id, vendor_name').eq('is_active', true).order('vendor_name');
    const view = buildEditView({ document: ctx.document, vendor: ctx.vendor, facts: ctx.facts, rows: pending.length ? pending : ctx.rows, vendors: vendors || [] });
    const r = await (deps.openView || openSlackView)(parsed.triggerId, view);
    if (r.ok) console.log(`${LOG} edit form opened for ${documentId} by ${who}`);
    else {
      console.error(`${LOG} edit form for ${documentId} NOT opened: ${r.error}`);
      await reply(responseUrl, { response_type: 'ephemeral', replace_original: false, text: `Could not open the edit form (${r.error}).` });
    }
    return { handled: true, action: r.ok ? 'edit_opened' : 'edit_failed' };
  }

  // 2026-10-19: a choice changed inside the open Edit form → redraw it with only
  // the fields that choice needs (slack-review.js buildEditView). Nothing is saved.
  if (decision === 'form_change') {
    const { data: vendors } = await supabase.from('marketing_vendors').select('id, vendor_name').eq('is_active', true).order('vendor_name');
    const view = buildEditView({ document: ctx.document, vendor: ctx.vendor, facts: ctx.facts, rows: pending.length ? pending : ctx.rows, vendors: vendors || [], state: parsed.values || {} });
    const r = await (deps.updateView || updateSlackView)(parsed.viewId, view, { hash: parsed.viewHash });
    if (!r.ok && r.error !== 'hash_conflict') console.warn(`${LOG} edit form redraw for ${documentId} failed: ${r.error}`);
    return { handled: true, action: r.ok ? 'form_redrawn' : 'form_redraw_failed' };
  }

  if (decision === 'edit_submit') {
    if (!pending.length) return { handled: true, action: 'already_resolved' };
    // The dashboard's edit form sends the parsed fields (decideFromDashboard); Slack sends its view state.
    const v = parsed.edit || parseEditSubmission(parsed.values);
    const notes = [];
    let vendor = ctx.vendor;
    const vendorChanged = !!(v.vendor_id && v.vendor_id !== ctx.vendor?.id);
    if (vendorChanged) {
      const { data } = await supabase.from('marketing_vendors').select('*').eq('id', v.vendor_id).maybeSingle();
      vendor = data || vendor;
    }
    // 2026-10-13 (the user): "allow editing and adding options when they don't
    // already exist". A vendor typed in "New vendor" is created now (or, when
    // one with that name or alias already exists, that one is used), with the
    // sub-source and split from this form, so its next invoice matches by name.
    const splitMarkets = marketsForSplit(v);
    // Call center / software (2026-10-14): the category IS the line's sub-source,
    // whatever was typed in the sub-source box, so the report shows it as its own row.
    const formSubs = subSourcesForSplit(v);
    let created = false;
    if (v.new_vendor) {
      const { data: all } = await supabase.from('marketing_vendors').select('*');
      const key = normalizeName(v.new_vendor);
      const existing = (all || []).find((x) => [x.vendor_name, ...(x.aliases || [])].some((n) => normalizeName(n) === key));
      if (existing) vendor = existing;
      else {
        const aliases = [...new Set([v.new_vendor, ctx.facts?.vendor_name_hint].filter(Boolean).map((x) => String(x).trim()))];
        const { data: made, error: mkErr } = await supabase.from('marketing_vendors').insert({
          vendor_name: v.new_vendor, aliases, sender_domains: [], lp_sub_sources: formSubs,
          eligible_markets: splitMarkets ?? [], default_cost_type: 'invoice', is_active: true,
          notes: `Added from the invoice Edit form by ${who}, ${new Date().toISOString().slice(0, 10)}`,
        }).select('*').single();
        if (mkErr) throw new Error(`vendor create failed: ${mkErr.message}`);
        vendor = made;
        created = true;
        notes.push(`new vendor "${made.vendor_name}" added`);
      }
    }
    const usingNewVendor = vendor && vendor.id !== ctx.vendor?.id;
    const patch = { updated_at: new Date().toISOString() };
    if (vendor) patch.vendor_id = vendor.id;
    if (v.invoice_number) patch.invoice_number = v.invoice_number;
    if (v.period_start) patch.period_start = v.period_start;
    if (v.period_end) patch.period_end = v.period_end;
    // A vendor picked or created here brings its own sub-source and split when
    // the form leaves them blank (pick "Hatch" → evenly across all offices).
    if (formSubs.length) patch.lp_sub_sources = formSubs;
    else if (usingNewVendor && (vendor.lp_sub_sources || []).length) patch.lp_sub_sources = vendor.lp_sub_sources;
    else if (v.split === 'even' || v.lp_sub_sources.length) patch.lp_sub_sources = [];
    if (splitMarkets) patch.eligible_markets = splitMarkets;
    else if (usingNewVendor && !v.split) patch.eligible_markets = vendor.eligible_markets || [];
    if (v.amount != null && pending.length === 1) patch.amount = v.amount;
    const { error } = await supabase.from('marketing_expenses').update(patch).in('id', pending.map((r) => r.id));
    if (error) throw new Error(`edit update failed: ${error.message}`);

    // "Remember": the vendor keeps this sub-source and split for its next invoices.
    if (vendor && v.remember && !created) {
      const keep = {};
      if (patch.lp_sub_sources && JSON.stringify(patch.lp_sub_sources) !== JSON.stringify(vendor.lp_sub_sources || [])) keep.lp_sub_sources = patch.lp_sub_sources;
      if (patch.eligible_markets && JSON.stringify(patch.eligible_markets) !== JSON.stringify(vendor.eligible_markets || [])) keep.eligible_markets = patch.eligible_markets;
      if (Object.keys(keep).length) {
        await supabase.from('marketing_vendors').update({ ...keep, updated_at: new Date().toISOString() }).eq('id', vendor.id);
        vendor = { ...vendor, ...keep };
        notes.push(`"${vendor.vendor_name}" will use this ${keep.eligible_markets ? 'split' : ''}${keep.eligible_markets && keep.lp_sub_sources ? ' and ' : ''}${keep.lp_sub_sources ? 'sub-source' : ''} next time`);
      }
    }

    // The vendor learns how this invoice named it, so the next one matches by rules.
    let learnt = null;
    if (vendor && !created) {
      const learn = vendorLearnPatch(vendor, { alias: ctx.analysis?.ai?.vendor_name || ctx.facts?.vendor_name_hint || null, fromAddress: ctx.document.from_address });
      if (learn) {
        await supabase.from('marketing_vendors').update({ ...learn, updated_at: new Date().toISOString() }).eq('id', vendor.id);
        learnt = `vendor "${vendor.vendor_name}" now also matches ${[...(learn.aliases.slice(vendor.aliases?.length || 0)), ...(learn.sender_domains.slice(vendor.sender_domains?.length || 0))].join(', ')}`;
      }
    }
    if (learnt) notes.push(learnt);
    const fresh = await loadReviewContext(documentId, { supabase });
    fresh.vendor = vendor;
    const facts = { ...fresh.facts, invoice_number: patch.invoice_number ?? fresh.facts.invoice_number, period_start: patch.period_start ?? fresh.facts.period_start, period_end: patch.period_end ?? fresh.facts.period_end, total: fresh.rows.reduce((a, r) => a + Number(r.amount || 0), 0) };
    const flags = computeFlags({ vendor, facts, rows: fresh.rows.filter((r) => r.status === 'pending_review'), confidence: fresh.confidence, extraction: fresh.extraction, minConfidence: 0 });
    // vendor_id too (2026-10-19): the dashboard's Invoices tab names the vendor from
    // analysis.vendor_id, so a vendor picked or created in Edit read "unknown" there.
    const analysis = { ...(fresh.document.analysis || {}), facts, flags, ...(vendor?.id ? { vendor_id: vendor.id } : {}), vendor_method: 'edited', edited_by: who, edited_at: new Date().toISOString() };
    await supabase.from('marketing_invoice_documents').update({ analysis, updated_at: new Date().toISOString() }).eq('id', documentId);
    const card = await renderCard({ ...fresh, facts, flags, vendorMethod: 'edited' }, { note: `Edited by ${userName}${notes.length ? ` · ${notes.join(' · ')}` : ''}` }, { ...deps, supabase });
    await updateCard(fresh, card, deps);
    return { handled: true, action: 'edited' };
  }

  // 2026-10-19 (the user: "I would like the ability to reopen"): a decided
  // invoice goes back to review. Its allocations are deleted (the market
  // numbers drop it at once), the lines go back to pending_review, and the card
  // gets its Approve / Edit / Reject buttons back. A Lead Gurus invoice is not
  // reopened here: its approval superseded the feed rows (trueUpInvoice) and
  // reopening would leave that month with neither.
  if (decision === 'reopen') {
    const decided = ctx.rows.filter((r) => r.status === 'approved' || r.status === 'rejected');
    if (!decided.length) {
      await reply(responseUrl, { response_type: 'ephemeral', replace_original: false, text: pending.length ? 'This invoice is already open for review.' : 'Nothing to reopen on this invoice.' });
      return { handled: true, action: 'nothing_to_reopen' };
    }
    if (ctx.vendor?.default_cost_type === 'feed' && decided.some((r) => r.status === 'approved')) {
      await reply(responseUrl, { response_type: 'ephemeral', replace_original: false, text: 'Lead Gurus invoices can\'t be reopened from Slack yet (approving one replaced that month\'s daily feed). Nothing changed.' });
      return { handled: true, action: 'reopen_refused_feed' };
    }
    const now = new Date().toISOString();
    for (const r of decided) await (deps.deleteAllocations || deleteAllocations)(r.id, { supabase });
    const { error } = await supabase.from('marketing_expenses').update({ status: 'pending_review', approved_by: null, approved_at: null, updated_at: now }).in('id', decided.map((r) => r.id));
    if (error) throw new Error(`reopen update failed: ${error.message}`);
    await supabase.from('marketing_invoice_documents').update({ status: 'in_review', updated_at: now }).eq('id', documentId);
    const fresh = await loadReviewContext(documentId, { supabase });
    const card = await renderCard(fresh, { note: `Reopened by ${userName}` }, { ...deps, supabase });
    await reply(responseUrl, { replace_original: true, text: card.text, blocks: card.blocks });
    await postDecisionReply(fresh.document, buildDecisionReply({ outcome: 'reopened', by: userName }), deps);
    console.log(`${LOG} reopened ${documentId} by ${who}: ${decided.length} line(s)`);
    return { handled: true, action: 'reopened' };
  }

  // 2026-10-19 (the user: "accept an invoice as received and later amend it if a
  // dispute arises"): the Disputed part of an approved invoice is settled here,
  // through settleDispute (below), which the dashboard's invoice view uses too.
  if (decision === 'dispute_accept' || decision === 'dispute_credit') {
    const out = await settleDispute({ documentId, action: decision === 'dispute_accept' ? 'accept' : 'credit', who, userName }, { ...deps, supabase });
    if (!out.ok) {
      await reply(responseUrl, { response_type: 'ephemeral', replace_original: false, text: out.message });
      return { handled: true, action: out.action };
    }
    await reply(responseUrl, { replace_original: true, text: out.card.text, blocks: out.card.blocks });
    await postDecisionReply(out.document, out.threadText, deps);
    return { handled: true, action: out.action, amount: out.amount };
  }

  if (!pending.length) {
    await reply(responseUrl, { response_type: 'ephemeral', replace_original: false, text: `This invoice was already ${ctx.rows[0]?.status || 'decided'}.` });
    return { handled: true, action: 'already_resolved' };
  }

  if (decision === 'reject') {
    const now = new Date().toISOString();
    await supabase.from('marketing_expenses').update({ status: 'rejected', approved_by: who, approved_at: now, updated_at: now }).in('id', pending.map((r) => r.id));
    await supabase.from('marketing_invoice_documents').update({ status: 'rejected', updated_at: now }).eq('id', documentId);
    const fresh = await loadReviewContext(documentId, { supabase });
    const card = await renderCard(fresh, { decision: { outcome: 'rejected', by: userName, at: now.slice(0, 16).replace('T', ' ') } }, { ...deps, supabase });
    await reply(responseUrl, { replace_original: true, text: card.text, blocks: card.blocks });
    await postDecisionReply(fresh.document, buildDecisionReply({ outcome: 'rejected', by: userName }), deps);
    return { handled: true, action: 'rejected' };
  }

  // approve
  const blockers = [];
  for (const r of pending) {
    if (!r.period_start || !r.period_end) blockers.push(`line ${r.line_no}: no billing period — Edit first`);
    if (r.amount == null) blockers.push(`line ${r.line_no}: no amount — Edit first`);
    // 2026-10-13: a total the extraction could not read is stored as 0 with the
    // missing_total flag (the column is NOT NULL); nobody approves $0.
    else if (Number(r.amount) === 0) blockers.push(`line ${r.line_no}: amount is $0 (not found on the invoice) — Edit first`);
    // An even split over all offices (software, company-wide) needs no sub-source.
    if (!(r.lp_sub_sources || []).length && !splitsEvenly(r)) blockers.push(`line ${r.line_no}: no LP sub-source — Edit first`);
  }
  if (blockers.length) {
    await reply(responseUrl, { response_type: 'ephemeral', replace_original: false, text: `Not approved:\n• ${blockers.join('\n• ')}` });
    return { handled: true, action: 'blocked', blockers };
  }
  const now = new Date().toISOString();
  const { error } = await supabase.from('marketing_expenses').update({ status: 'approved', approved_by: who, approved_at: now, updated_at: now }).in('id', pending.map((r) => r.id));
  if (error) throw new Error(`approve update failed: ${error.message}`);
  const allocate = deps.allocate || allocateExpenseById;
  for (const r of pending) await allocate(r.id, { supabase });
  const replaced = await (deps.replaceEarlier || replaceEarlierInvoice)({ documentId, rows: pending, by: who, now }, { ...deps, supabase });
  await (deps.refreshEstimates || refreshEstimatesFor)(pending, { ...deps, supabase });
  let trueUp = null;
  if (ctx.vendor?.default_cost_type === 'feed') {
    const approved = pending.map((r) => ({ ...r, status: 'approved' }));
    trueUp = await (deps.trueUp || trueUpInvoice)(approved, { supabase, post: (text) => (deps.postToSlack || postToSlack)(text, reviewChannelId(deps.env)) });
  }
  await supabase.from('marketing_invoice_documents').update({ status: 'posted', updated_at: now }).eq('id', documentId);
  const fresh = await loadReviewContext(documentId, { supabase });
  const card = await renderCard(fresh, { decision: { outcome: 'approved', by: userName, at: now.slice(0, 16).replace('T', ' ') } }, { ...deps, supabase });
  await reply(responseUrl, { replace_original: true, text: card.text, blocks: card.blocks });
  const approvedTotal = fresh.rows.filter((r) => r.status === 'approved').reduce((a, r) => a + Number(r.amount || 0), 0);
  const allocations = await loadAllocations(fresh.rows.map((r) => r.id), { supabase });
  const replacedLine = replaced?.documents?.length
    ? `\n♻️ Replaces invoice #${replaced.invoice_number} approved earlier (${usdPlain(replaced.amount)}); that one is now marked replaced and out of the market costs.`
    : '';
  await postDecisionReply(fresh.document, buildDecisionReply({ outcome: 'approved', by: userName, total: approvedTotal, allocation: allocations }) + replacedLine, deps);
  console.log(`${LOG} approved ${documentId} by ${who}: ${pending.length} line(s)${trueUp ? `, true-up ${JSON.stringify(trueUp.months)}` : ''}`);
  return { handled: true, action: 'approved', trueUp };
}

const usdPlain = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DISPUTE_FLAGS = new Set(['dispute_accepted', 'dispute_credited']);
const cents = (n) => Math.round(Number(n || 0) * 100);

/** Disputed dollars per expense, read from its DISPUTED allocations. */
async function disputedByExpense(ids, supabase) {
  const out = new Map();
  if (!ids.length) return out;
  const { data, error } = await supabase.from('marketing_expense_allocations').select('expense_id, amount').in('expense_id', ids).eq('market', DISPUTED_MARKET);
  if (error) throw new Error(`disputed read failed: ${error.message}`);
  for (const a of data || []) out.set(a.expense_id, (out.get(a.expense_id) || 0) + cents(a.amount));
  return out;
}

/**
 * Settle, change or reopen the Disputed part of an approved invoice (the user,
 * 2026-10-19). Shared by the Slack card's buttons and the dashboard's invoice view.
 *   accept  the charge stands: 'dispute_accepted', the whole line re-split by office
 *   credit  the vendor credited `amount` (default: everything disputed): the line
 *           drops by it ('dispute_credited'); a part credit leaves the rest Disputed
 *   reopen  undo a confirm or a credit: amounts back to what was billed, flags off,
 *           re-split, so the gap is Disputed again
 * `reset: true` (the dashboard's credit) first undoes any earlier settlement, so a
 * credit can be changed and a confirmed charge credited instead. The Slack buttons keep their
 * one-way meaning (reset false): they act on what is Disputed right now.
 * `analysis.credits` holds the credits in force (each with the line's billed `was`),
 * `analysis.dispute_log` every action. Returns { ok, action, amount, message, ... }.
 */
export async function settleDispute({ documentId, action, amount = null, who, userName, reset = false }, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const allocate = deps.allocate || allocateExpenseById;
  const ctx = await loadReviewContext(documentId, { supabase });
  if (!ctx) return { ok: false, action: 'not_found', message: 'That invoice is no longer in the ledger.' };
  const approved = ctx.rows.filter((r) => r.status === 'approved');
  if (!approved.length) return { ok: false, action: 'not_approved', message: 'Only an approved invoice can have a dispute settled. Nothing changed.' };
  const now = new Date().toISOString();
  const analysis = ctx.document.analysis || {};
  const credits = Array.isArray(analysis.credits) ? analysis.credits : [];
  const billedWas = new Map();
  for (const c of credits) if (c?.expense_id && !billedWas.has(c.expense_id)) billedWas.set(c.expense_id, Number(c.was));

  // Undo an earlier confirm / credit: back to what the vendor billed, and re-split.
  let undone = 0;
  if (reset || action === 'reopen') {
    for (const r of approved) {
      const settled = (r.flags || []).some((f) => DISPUTE_FLAGS.has(f)) || billedWas.has(r.id);
      if (!settled) continue;
      const billed = billedWas.has(r.id) ? billedWas.get(r.id) : Number(r.amount);
      const { error } = await supabase.from('marketing_expenses')
        .update({ amount: billed, flags: (r.flags || []).filter((f) => !DISPUTE_FLAGS.has(f)), updated_at: now }).eq('id', r.id);
      if (error) throw new Error(`dispute reset failed: ${error.message}`);
      r.amount = billed;
      r.flags = (r.flags || []).filter((f) => !DISPUTE_FLAGS.has(f));
      await allocate(r.id, { supabase });
      undone++;
    }
  }

  const disputed = await disputedByExpense(approved.map((r) => r.id), supabase);
  const lines = approved.filter((r) => (disputed.get(r.id) || 0) > 0);
  const totalC = lines.reduce((a, r) => a + disputed.get(r.id), 0);
  let keptCredits = undone ? [] : credits;
  let amountC = totalC;
  let settledText;

  if (action === 'reopen') {
    if (!undone) return { ok: false, action: 'nothing_to_reopen', message: 'Nothing on this invoice was confirmed or credited. Nothing changed.' };
    settledText = `Dispute reopened by ${userName}: ${usdPlain(totalC / 100)} is Disputed again`;
  } else {
    if (!lines.length) return { ok: false, action: 'nothing_disputed', message: 'Nothing on this invoice is in dispute. Nothing changed.' };
    if (action === 'credit' && amount != null) {
      amountC = cents(amount);
      if (!(amountC > 0) || amountC > totalC) {
        return { ok: false, action: 'bad_amount', message: `The credit must be more than $0 and at most the ${usdPlain(totalC / 100)} in dispute. Nothing changed.` };
      }
    }
    let leftC = amountC;
    const added = [];
    for (const r of lines) {
      const flag = action === 'accept' ? 'dispute_accepted' : 'dispute_credited';
      const patch = { flags: [...new Set([...(r.flags || []), flag])], updated_at: now };
      if (action === 'credit') {
        const partC = Math.min(leftC, disputed.get(r.id));
        if (!(partC > 0)) continue;
        leftC -= partC;
        patch.amount = (cents(r.amount) - partC) / 100;
        added.push({ expense_id: r.id, line_no: r.line_no, was: billedWas.get(r.id) ?? Number(r.amount), credited: partC / 100, by: who, at: now });
      }
      const { error } = await supabase.from('marketing_expenses').update(patch).eq('id', r.id);
      if (error) throw new Error(`dispute update failed: ${error.message}`);
      // A credited line keeps exactly what it had found; its new amount matches the
      // found work, so the re-split parks nothing (or only the part not credited).
      await allocate(r.id, { supabase });
    }
    keptCredits = [...keptCredits, ...added];
    const restC = totalC - amountC;
    settledText = action === 'accept'
      ? `Disputed ${usdPlain(totalC / 100)} confirmed by ${userName}: charged to the offices`
      : `${usdPlain(amountC / 100)} credit recorded by ${userName}: taken off the invoice${restC > 0 ? `; ${usdPlain(restC / 100)} still disputed` : ''}`;
  }

  const log = [...(Array.isArray(analysis.dispute_log) ? analysis.dispute_log : []), { action, amount: (action === 'reopen' ? totalC : amountC) / 100, by: who, at: now }];
  const { error: dErr } = await supabase.from('marketing_invoice_documents')
    .update({ analysis: { ...analysis, credits: keptCredits, dispute_log: log }, updated_at: now }).eq('id', documentId);
  if (dErr) throw new Error(`dispute record failed: ${dErr.message}`);

  const fresh = await loadReviewContext(documentId, { supabase });
  const first = fresh.rows.find((r) => r.status === 'approved');
  const decision = { outcome: 'approved', by: String(first?.approved_by || '').replace(/ \(.*\)$/, '') || userName, at: String(first?.approved_at || now).slice(0, 16).replace('T', ' ') };
  const card = await renderCard(fresh, { decision, note: settledText }, { ...deps, supabase });
  const icon = action === 'accept' ? '✅' : action === 'credit' ? '💳' : '↩️';
  const done = { accept: 'dispute_accepted', credit: 'dispute_credited', reopen: 'dispute_reopened' }[action];
  console.log(`${LOG} ${done} on ${documentId} by ${who}: ${settledText}`);
  return { ok: true, action: done, amount: (action === 'reopen' ? totalC : amountC) / 100, message: settledText, card, document: fresh.document, fresh, threadText: `${icon} ${settledText}.` };
}

/**
 * The dashboard's invoice view (the user, 2026-10-19: "a button that displays the
 * invoice and lets me update the credit received, confirm the charge, or reopen a
 * disputed amount"). The dashboard checks the person is an admin and relays the
 * click here; the Slack card is redrawn in place and gets the same thread reply,
 * so the card and the dashboard never disagree.
 */
export async function settleDisputeFromDashboard({ documentId, action, amount = null, by = null }, deps = {}) {
  if (!['accept', 'credit', 'reopen'].includes(action)) return { ok: false, action: 'bad_action', message: 'Unknown action.' };
  const name = String(by || 'dashboard').replace(/@.*$/, '');
  // A credit is a change: undo the earlier confirm / credit and start from what was
  // billed. A confirm keeps a credit already received and confirms what is left.
  const out = await settleDispute({ documentId, action, amount, who: `${by || 'dashboard'} (dashboard)`, userName: name, reset: action === 'credit' }, deps);
  if (!out.ok) return out;
  const r = await updateCard(out.fresh, out.card, deps);
  if (!r?.ok && r?.error !== 'no_card') console.warn(`${LOG} card for ${documentId} not redrawn after the dashboard ${action}: ${r?.error}`);
  await postDecisionReply(out.document, out.threadText, deps);
  return { ok: true, action: out.action, amount: out.amount, message: out.message };
}

/**
 * A revised invoice replaces the original (the user, 2026-10-19: "Replace the
 * original automatically"). When an invoice is approved, any APPROVED lines of
 * another document from the same vendor with the same invoice number are marked
 * `superseded` (their allocations go, so the market costs carry only the
 * revision), and that document records `replaced_by`. One with the same number
 * AND total never gets here: the ingest drops it as a duplicate. Best effort: a
 * failure is a log line, never a reason to undo the approval.
 */
export async function replaceEarlierInvoice({ documentId, rows, by, now }, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const invoiceNumber = rows.find((r) => r.invoice_number)?.invoice_number;
  const vendorId = rows.find((r) => r.vendor_id)?.vendor_id;
  if (!invoiceNumber || !vendorId) return null;
  try {
    const { data: older, error } = await supabase.from('marketing_expenses').select('id, document_id, amount')
      .eq('vendor_id', vendorId).eq('invoice_number', invoiceNumber).eq('status', 'approved').neq('document_id', documentId);
    if (error || !older?.length) return null;
    for (const r of older) await (deps.deleteAllocations || deleteAllocations)(r.id, { supabase });
    const { error: uErr } = await supabase.from('marketing_expenses').update({ status: 'superseded', updated_at: now }).in('id', older.map((r) => r.id));
    if (uErr) throw new Error(uErr.message);
    const docs = [...new Set(older.map((r) => r.document_id).filter(Boolean))];
    for (const id of docs) {
      const { data: d } = await supabase.from('marketing_invoice_documents').select('analysis').eq('id', id).maybeSingle();
      await supabase.from('marketing_invoice_documents').update({ analysis: { ...(d?.analysis || {}), replaced_by: documentId, replaced_at: now, replaced_by_who: by }, updated_at: now }).eq('id', id);
    }
    const amount = Math.round(older.reduce((a, r) => a + Number(r.amount || 0), 0) * 100) / 100;
    console.log(`${LOG} invoice #${invoiceNumber}: ${older.length} line(s) of ${docs.length} earlier document(s) replaced by ${documentId}`);
    return { invoice_number: invoiceNumber, documents: docs, lines: older.length, amount };
  } catch (err) {
    console.warn(`${LOG} replacing earlier invoice #${invoiceNumber} failed: ${err.message}`);
    return null;
  }
}

/**
 * The invoice replaces the estimate (the user, 2026-10-19). Once lines that
 * carry a commission rule's sub-source are approved, the months they sit in are
 * recomputed so the 15% estimate steps aside for them at once, not at the next
 * report 133 or nightly run (which only reaches the current and prior month; a
 * LeadPilot sale is often older). Best effort: the approval already stands.
 */
export async function refreshEstimatesFor(rows, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  try {
    const { data: rules } = await supabase.from('marketing_cost_rules').select('lp_sub_sources');
    const ruled = new Set((rules || []).flatMap((r) => r.lp_sub_sources || []));
    const months = [...new Set((rows || [])
      .filter((r) => (r.lp_sub_sources || []).some((s) => ruled.has(s)) && r.period_start)
      .map((r) => `${String(r.period_start).slice(0, 7)}-01`))];
    if (!months.length) return [];
    const { recomputeCalculatedCosts } = await import('./commission.js');
    const out = [];
    for (const m of months) out.push(await (deps.recompute || recomputeCalculatedCosts)(m, { supabase }));
    return out;
  } catch (err) {
    console.warn(`${LOG} estimate refresh after approval failed: ${err.message}`);
    return null;
  }
}

/** Pure: the header a decided card is redrawn with, from what the ledger holds (null = still in review). */
export function decisionFor(ctx) {
  const rows = ctx.rows || [];
  const approved = rows.find((r) => r.status === 'approved');
  if (ctx.document?.status === 'posted' && approved) {
    return { outcome: 'approved', by: String(approved.approved_by || '').replace(/ \(.*\)$/, ''), at: String(approved.approved_at || ctx.document.updated_at || '').slice(0, 16).replace('T', ' ') };
  }
  if (rows.length && rows.every((r) => r.status === 'rejected')) {
    return { outcome: 'rejected', by: '', at: String(ctx.document?.updated_at || '').slice(0, 16).replace('T', ' ') };
  }
  return null;
}

/**
 * Redraw the review cards already in Slack (the user, 2026-10-19: "All of the
 * Slack items need to be updated"). A card is a picture taken when it was
 * posted: the six LightFire cards went up at 1:53 PM ET, the office split and
 * the readable basis went live at 2:15 PM, and 17734 kept showing
 * "4182700/17951276 issued" with no office. Each card is drawn again exactly as
 * a new one would be (an open card with a fresh preview, a decided one with its
 * real allocations and its decision) and replaces the old one in place. Posts
 * nothing new, writes nothing to the ledger, and one card failing never stops
 * the rest. Run it after any change to the card or to the allocation rules.
 */
export async function refreshReviewCards({ ids = null, since = null, dryRun = false } = {}, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  let q = supabase.from('marketing_invoice_documents').select('id, status, slack_ts, created_at').not('slack_ts', 'is', null);
  if (ids?.length) q = q.in('id', ids);
  else q = q.gte('created_at', since || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
  const { data: docs, error } = await q;
  if (error) throw new Error(`documents read failed: ${error.message}`);
  const out = { matched: (docs || []).length, refreshed: 0, failed: [], cards: [] };
  for (const d of docs || []) {
    try {
      const ctx = await loadReviewContext(d.id, { supabase });
      if (!ctx) continue;
      const decision = decisionFor(ctx);
      out.cards.push({ id: d.id, invoice_number: ctx.facts?.invoice_number || null, status: ctx.document.status, decided: decision?.outcome || null });
      if (dryRun) continue;
      const card = await renderCard(ctx, { decision }, { ...deps, supabase });
      const r = await updateCard(ctx, card, deps);
      if (r?.ok === false) throw new Error(r.error || 'slack_update_failed');
      out.refreshed++;
    } catch (err) {
      console.warn(`${LOG} refresh ${d.id} failed: ${err.message}`);
      out.failed.push({ id: d.id, error: err.message });
    }
  }
  console.log(`${LOG} cards refreshed${dryRun ? ' (dry run)' : ''}: ${out.refreshed}/${out.matched}, ${out.failed.length} failed`);
  return out;
}


/**
 * Approve, reject, reopen or edit an invoice from the dashboard's invoice view
 * (the user, 2026-10-19: "View and Edit … doesn't allow any edits"). It runs the
 * SAME handler as the Slack buttons and the Edit modal, so the rules, blockers
 * and thread replies are one code path; the dashboard checks the person is an
 * admin (Mark, Brad) and relays here. A Slack reply that would have replaced the
 * card is applied to the card instead (updateCard), and an ephemeral one becomes
 * the answer the dashboard shows. `edit` carries the fields parseEditSubmission
 * returns (vendor_id, new_vendor, invoice_number, period_start, period_end,
 * amount, lp_sub_sources, split, eligible_markets, remember).
 */
export async function decideFromDashboard({ documentId, action, edit = null, by = null }, deps = {}) {
  const decision = { approve: 'approve', reject: 'reject', reopen: 'reopen', edit: 'edit_submit' }[action];
  if (!decision) return { ok: false, action: 'bad_action', message: 'Unknown action.' };
  const supabase = deps.supabase || supabaseDefault;
  const userName = String(by || 'dashboard').replace(/@.*$/, '');
  const said = [];
  let card = null;
  const out = await handleMarketingInvoiceInteraction(
    { decision, documentId, userId: 'DASHBOARD', userName, responseUrl: null, edit: decision === 'edit_submit' ? normalizeEdit(edit) : null },
    {
      ...deps,
      supabase,
      approvers: new Set(['DASHBOARD']),
      reply: async (_url, body) => {
        if (body?.replace_original && body.blocks) card = body;
        else if (body?.text) said.push(body.text);
        return { ok: true };
      },
    },
  );
  if (card) {
    const ctx = await loadReviewContext(documentId, { supabase });
    if (ctx) {
      const r = await updateCard(ctx, card, deps);
      if (!r?.ok && r?.error !== 'no_card') console.warn(`${LOG} card for ${documentId} not redrawn after the dashboard ${action}: ${r?.error}`);
    }
  }
  const done = ['approved', 'rejected', 'reopened', 'edited'].includes(out?.action);
  return { ok: done, action: out?.action || 'unknown', message: said.join(' ') || (done ? `Invoice ${out.action}.` : 'Nothing changed.'), blockers: out?.blockers || null };
}

function normalizeEdit(e = {}) {
  const num = (v) => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  return {
    vendor_id: e.vendor_id || null,
    invoice_number: String(e.invoice_number || '').trim() || null,
    period_start: date(e.period_start),
    period_end: date(e.period_end),
    amount: num(e.amount),
    lp_sub_sources: list(e.lp_sub_sources),
    eligible_markets: list(e.eligible_markets).filter((m) => /^[A-Z_]{2,16}$/.test(m)),
    new_vendor: String(e.new_vendor || '').trim().slice(0, 150) || null,
    split: ['by_source', 'markets', 'even', 'call_center', 'software'].includes(e.split) ? e.split : null,
    remember: e.remember === true,
  };
}
