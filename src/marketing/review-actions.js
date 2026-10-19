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
import { splitsEvenly } from './allocation.js';

const LOG = '[MktReview]';
const INVOICES_BUCKET = 'marketing-invoices';
const SIGNED_TTL_S = 7 * 24 * 3600;

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

export async function signedOriginalLink(document, { supabase = supabaseDefault } = {}) {
  if (!document?.storage_path || !supabase) return null;
  try {
    const { data } = await supabase.storage.from(document.storage_bucket || INVOICES_BUCKET).createSignedUrl(document.storage_path, SIGNED_TTL_S);
    return data?.signedUrl || null;
  } catch { return null; }
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
    try { out.push(...(await previewAllocation(r, deps))); } catch (err) { console.warn(`${LOG} preview ${r.id}: ${err.message}`); }
  }
  return out;
}

export async function renderCard(ctx, { decision = null, note = null } = {}, deps = {}) {
  const allocation = decision
    ? await loadAllocations(ctx.rows.map((r) => r.id), deps)
    : await previewRows(ctx.rows, deps);
  const link = deps.signedLink ? await deps.signedLink(ctx.document) : await signedOriginalLink(ctx.document, deps);
  return buildReviewCard({ ...ctx, allocation, link, decision, note });
}

async function loadAllocations(expenseIds, { supabase = supabaseDefault } = {}) {
  if (!expenseIds.length) return [];
  const { data } = await supabase.from('marketing_expense_allocations').select('month, market, amount, rule, issued_basis, issued_total, recommendation_reason').in('expense_id', expenseIds).order('month');
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
    const v = parseEditSubmission(parsed.values);
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
  await postDecisionReply(fresh.document, buildDecisionReply({ outcome: 'approved', by: userName, total: approvedTotal, allocation: allocations }), deps);
  console.log(`${LOG} approved ${documentId} by ${who}: ${pending.length} line(s)${trueUp ? `, true-up ${JSON.stringify(trueUp.months)}` : ''}`);
  return { handled: true, action: 'approved', trueUp };
}
