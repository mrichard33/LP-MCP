/**
 * Marketing invoice ingest — src/jobs/marketing-invoice-ingest.js
 *
 * POST /n8n/admin/marketing-invoice-ingest is where n8n `I.MCIN Marketing
 * Invoice Ingest` hands over an email attachment (or the email body) from the
 * marketing-invoices@ inbox. n8n is a thin transport; every decision is here
 * (handoff 2026-10-12 §7.1), fail-closed, in order:
 *
 *   1. dedupe on the file's sha256  → { success:true, duplicate:true }
 *   2. store the original in Storage bucket marketing-invoices/<yyyy>/<mm>/<sha>.<ext>
 *   3. extract text for FREE (src/marketing/extract-client.js — reece-speech-api
 *      for PDF/images, in-process for CSV/XLSX/body text)
 *   4. analyze: rules, then the model on the TEXT only (invoice-analyzer.js)
 *   5. build marketing_expenses rows (pending_review) + flags
 *   6. auto-approve only with no flags AND ≥ MKT_AUTO_APPROVE_MIN_PRIOR prior
 *      person approvals of the vendor; everything else → Slack review card
 *   7. answer { success, duplicate, document_id, expense_ids, flags, auto_approved }
 *
 * Auth: the same x-ghl-signature / LP_REPORT_INGEST_SECRET check the LP
 * report ingest uses (src/jobs/lp-report-common.js), with the same fail-open-
 * until-set posture it documents. A failure after the document row exists
 * leaves status='failed' + error, so nothing is silently lost; a 5xx makes
 * n8n retry, and the retry is a duplicate (the sha is already claimed) unless
 * the row was marked failed, in which case it is re-run.
 */
import express from 'express';
import supabaseDefault from '../supabase.js';
import { sha256Hex, refuseIngest, assertIngestAuthConfigured, todayET } from './lp-report-common.js';
import { parseCsv } from './lp-report-csv-common.js';
import { postToSlack } from '../slack.js';
import { extractDocument, documentKind } from '../marketing/extract-client.js';
import { analyzeInvoiceText } from '../marketing/invoice-analyzer.js';
import { buildExpenseRows, computeFlags, autoApproveDecision } from '../marketing/expense-builder.js';
import { allocateExpenseById, reallocateMonth, reconcileAllocations } from '../marketing/allocation-io.js';
import { trueUpInvoice } from '../marketing/leadgurus-feed.js';
import { buildReviewCard } from '../marketing/slack-review.js';
import { previewRows, reviewChannelId, signedOriginalLink } from '../marketing/review-actions.js';

const LOG = '[MktInvoice]';
export const INVOICES_BUCKET = 'marketing-invoices';

export function ingestConfig(env = process.env) {
  return {
    minPrior: Math.max(0, parseInt(env.MKT_AUTO_APPROVE_MIN_PRIOR || '2', 10) || 0),
    minConfidence: Math.min(1, Math.max(0, Number(env.MKT_MIN_CONFIDENCE || 0.85))),
    channelId: reviewChannelId(env),
  };
}

function extOf({ fileName, mimeType, kind }) {
  const m = /\.([a-z0-9]{2,5})$/i.exec(String(fileName || ''));
  if (m) return m[1].toLowerCase();
  if (/pdf/.test(mimeType)) return 'pdf';
  if (/png/.test(mimeType)) return 'png';
  if (/jpe?g/.test(mimeType)) return 'jpg';
  if (kind === 'csv') return 'csv';
  if (kind === 'xlsx') return 'xlsx';
  return 'txt';
}

/** Validate and normalise the n8n payload. Returns { ok, error } or { ok, buffer, bodyText, meta }. */
export function parsePayload(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'JSON body required' };
  const fileB64 = body.file_b64 == null ? null : String(body.file_b64);
  const bodyText = body.body_text == null ? null : String(body.body_text);
  let buffer = null;
  if (fileB64) {
    try { buffer = Buffer.from(fileB64, 'base64'); } catch { return { ok: false, error: 'file_b64 is not base64' }; }
    if (!buffer.length) return { ok: false, error: 'file_b64 decodes to nothing' };
  }
  if (!buffer && !(bodyText && bodyText.trim())) return { ok: false, error: 'send file_b64 or a non-empty body_text' };
  return {
    ok: true, buffer, bodyText,
    meta: {
      gmail_message_id: body.gmail_message_id ? String(body.gmail_message_id) : null,
      from_address: body.from ? String(body.from).slice(0, 300) : null,
      subject: body.subject ? String(body.subject).slice(0, 500) : null,
      received_at: body.received_at ? new Date(body.received_at).toISOString() : null,
      file_name: body.file_name ? String(body.file_name).slice(0, 300) : null,
      mime_type: body.mime_type ? String(body.mime_type).slice(0, 100) : null,
    },
  };
}

async function loadVendorsAndSlugs(supabase) {
  const [{ data: vendors, error }, { data: slugs }] = await Promise.all([
    supabase.from('marketing_vendors').select('*').eq('is_active', true),
    supabase.from('slack_market_slugs').select('market_code, market_name'),
  ]);
  if (error) throw new Error(`marketing_vendors read failed: ${error.message}`);
  return { vendors: vendors || [], slugNames: Object.fromEntries((slugs || []).map((s) => [s.market_code, s.market_name])) };
}

/** Vendor history for the flags: prior person approvals, trailing-3-month average, possible duplicate. */
async function vendorHistory(supabase, vendor, facts) {
  if (!vendor) return { priorApprovals: 0, trailingAvg: null, possibleDuplicate: false };
  const since = new Date(Date.now() - 92 * 86400000).toISOString().slice(0, 10);
  const { data } = await supabase.from('marketing_expenses')
    .select('document_id, invoice_number, amount, period_start, period_end, approved_by, approved_at, status')
    .eq('vendor_id', vendor.id).eq('cost_type', 'invoice').in('status', ['approved', 'pending_review']);
  const rows = data || [];
  const byDoc = {};
  for (const r of rows) {
    const d = byDoc[r.document_id] ||= { total: 0, approvedByPerson: false, approved_at: r.approved_at, invoice_number: r.invoice_number, period_start: r.period_start, period_end: r.period_end, status: r.status };
    d.total += Number(r.amount || 0);
    if (r.status === 'approved' && r.approved_by && !/^auto\b/i.test(r.approved_by)) d.approvedByPerson = true;
  }
  const docs = Object.values(byDoc);
  const priorApprovals = docs.filter((d) => d.approvedByPerson).length;
  const recent = docs.filter((d) => d.status === 'approved' && d.approved_at && d.approved_at.slice(0, 10) >= since);
  const trailingAvg = recent.length ? recent.reduce((a, d) => a + d.total, 0) / recent.length : null;
  const cents = (n) => Math.round(Number(n || 0) * 100);
  const possibleDuplicate = facts.total != null && docs.some((d) => cents(d.total) === cents(facts.total)
    && d.period_start === facts.period_start && d.period_end === facts.period_end
    && String(d.invoice_number || '') !== String(facts.invoice_number || ''));
  return { priorApprovals, trailingAvg, possibleDuplicate };
}

/**
 * The whole pipeline for one payload. Returns the route's JSON body plus
 * `httpStatus`. Throws only for an infrastructure failure before the document
 * row exists (the caller answers 500 and n8n retries).
 */
export async function ingestInvoice(body, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const cfg = deps.cfg || ingestConfig(deps.env);
  const now = deps.now || (() => new Date());
  const parsed = parsePayload(body);
  if (!parsed.ok) return { httpStatus: 400, success: false, error: parsed.error };
  const { buffer, bodyText, meta } = parsed;
  const bytes = buffer || Buffer.from(bodyText, 'utf8');
  const sha = sha256Hex(bytes);

  // 1. dedupe — the sha is claimed by the insert; a race loses on the unique index.
  const { data: seen } = await supabase.from('marketing_invoice_documents').select('id, status').eq('sha256', sha).maybeSingle();
  let documentId = seen?.id || null;
  if (seen && seen.status !== 'failed') {
    return { httpStatus: 200, success: true, duplicate: true, document_id: seen.id, status: seen.status };
  }
  if (!seen) {
    const { data, error } = await supabase.from('marketing_invoice_documents')
      .insert({ sha256: sha, ...meta, status: 'extracted' }).select('id').single();
    if (error) {
      if (/duplicate|unique|23505/i.test(error.message || '')) {
        const { data: again } = await supabase.from('marketing_invoice_documents').select('id, status').eq('sha256', sha).maybeSingle();
        return { httpStatus: 200, success: true, duplicate: true, document_id: again?.id || null, status: again?.status || null };
      }
      throw new Error(`document insert failed: ${error.message}`);
    }
    documentId = data.id;
  }
  const fail = async (step, err) => {
    const message = `${step}: ${err?.message || err}`;
    console.error(`${LOG} ${documentId} ${message}`);
    await supabase.from('marketing_invoice_documents').update({ status: 'failed', error: message.slice(0, 1000), updated_at: now().toISOString() }).eq('id', documentId);
    return { httpStatus: 500, success: false, document_id: documentId, error: message };
  };

  // 2. store the original
  const kind = buffer ? documentKind(buffer, { fileName: meta.file_name, mimeType: meta.mime_type }) : 'text';
  const ext = buffer ? extOf({ fileName: meta.file_name, mimeType: meta.mime_type, kind }) : 'txt';
  const d = now();
  const storagePath = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${sha}.${ext}`;
  try {
    const { error } = await supabase.storage.from(INVOICES_BUCKET).upload(storagePath, bytes, { contentType: meta.mime_type || (buffer ? 'application/octet-stream' : 'text/plain'), upsert: true });
    if (error) throw new Error(error.message);
    await supabase.from('marketing_invoice_documents').update({ storage_bucket: INVOICES_BUCKET, storage_path: storagePath }).eq('id', documentId);
  } catch (err) { return fail('store', err); }

  // 3. extract (free)
  let extracted;
  try {
    extracted = await (deps.extract || extractDocument)(buffer, { fileName: meta.file_name, mimeType: meta.mime_type, bodyText }, deps.extractDeps || {});
    await supabase.from('marketing_invoice_documents').update({ extracted_text: extracted.text, extraction_meta: extracted.meta, status: 'extracted', updated_at: now().toISOString() }).eq('id', documentId);
  } catch (err) { return fail('extract', err); }

  // 4. analyze
  let a;
  try {
    const { vendors, slugNames } = await loadVendorsAndSlugs(supabase);
    a = await (deps.analyze || analyzeInvoiceText)({ text: extracted.text, fromAddress: meta.from_address, vendors, slugNames, sourceRef: sha }, deps.analyzeDeps || {});
  } catch (err) { return fail('analyze', err); }

  // 5. expense rows + flags
  const { rows, lineProblems } = buildExpenseRows({ document: { id: documentId }, vendor: a.vendor, facts: a.facts, analysis: a.ai, confidence: a.confidence });
  const history = await vendorHistory(supabase, a.vendor, a.facts);
  const flags = computeFlags({
    vendor: a.vendor, facts: a.facts, rows, lineProblems, confidence: a.confidence, disagreements: a.disagreements,
    extraction: extracted.meta, trailingAvg: history.trailingAvg, possibleDuplicate: history.possibleDuplicate, minConfidence: cfg.minConfidence,
  });
  if (a.guard && a.guard.verdict && a.guard.verdict !== 'clean') flags.push('text_flagged_by_guardrail');
  const autoApproved = autoApproveDecision({ flags, priorApprovals: history.priorApprovals, minPrior: cfg.minPrior });

  const { data: inserted, error: insErr } = await supabase.from('marketing_expenses').insert(rows.map((r) => ({ ...r, flags }))).select('id, line_no');
  if (insErr) return fail('expenses', insErr);
  const expenseIds = (inserted || []).map((r) => r.id);
  const analysis = {
    facts: { ...a.facts, vendor_name_hint: a.ai?.vendor_name || null }, rules: a.rules, ai: a.ai, ai_errors: a.aiErrors, hints: a.hints,
    vendor_id: a.vendor?.id || null, vendor_method: a.vendorMethod, confidence: a.confidence, disagreements: a.disagreements, flags,
    guard: a.guard ? { verdict: a.guard.verdict, score: a.guard.score, mode: a.guard.mode } : null,
    history: { prior_approvals: history.priorApprovals, trailing_avg: history.trailingAvg },
    auto_approved: autoApproved,
  };
  await supabase.from('marketing_invoice_documents').update({ analysis, analyzer: a.analyzer, status: 'analyzed', updated_at: now().toISOString() }).eq('id', documentId);

  const ctxBase = { document: { id: documentId, ...meta, analyzer: a.analyzer }, vendor: a.vendor, facts: analysis.facts, flags, confidence: a.confidence, extraction: extracted.meta, vendorMethod: a.vendorMethod, disagreements: a.disagreements };
  const post = deps.postToSlack || postToSlack;

  // 6. auto-approve or review
  if (autoApproved) {
    const ts = now().toISOString();
    await supabase.from('marketing_expenses').update({ status: 'approved', approved_by: `auto (${history.priorApprovals} prior approvals, no flags)`, approved_at: ts }).in('id', expenseIds);
    const allocate = deps.allocate || allocateExpenseById;
    for (const id of expenseIds) await allocate(id, { supabase });
    let trueUp = null;
    if (a.vendor?.default_cost_type === 'feed') {
      const { data: approvedRows } = await supabase.from('marketing_expenses').select('*').in('id', expenseIds);
      trueUp = await (deps.trueUp || trueUpInvoice)(approvedRows || [], { supabase, post: (text) => post(text, cfg.channelId) });
    }
    await supabase.from('marketing_invoice_documents').update({ status: 'posted', updated_at: ts }).eq('id', documentId);
    const { data: approvedRows } = await supabase.from('marketing_expenses').select('*').in('id', expenseIds);
    const { data: allocation } = await supabase.from('marketing_expense_allocations').select('month, market, amount, rule, issued_basis, issued_total').in('expense_id', expenseIds).order('month');
    const link = await (deps.signedLink || signedOriginalLink)({ id: documentId, storage_bucket: INVOICES_BUCKET, storage_path: storagePath }, { supabase });
    const card = buildReviewCard({ ...ctxBase, rows: approvedRows || [], allocation: allocation || [], link, decision: { outcome: 'auto_approved', by: 'system', at: ts.slice(0, 16).replace('T', ' ') } });
    if (cfg.channelId) {
      const r = await post(card.text, cfg.channelId, { blocks: card.blocks });
      if (r.ok) await supabase.from('marketing_invoice_documents').update({ slack_channel: r.channel, slack_ts: r.ts }).eq('id', documentId);
    }
    console.log(`${LOG} ${documentId} auto-approved (${a.vendor?.vendor_name}, $${a.facts.total})`);
    return { httpStatus: 200, success: true, duplicate: false, document_id: documentId, expense_ids: expenseIds, flags, auto_approved: true, true_up: trueUp };
  }

  const allocation = await previewRows(rows.map((r, i) => ({ ...r, id: expenseIds[i] })), { supabase });
  const link = await (deps.signedLink || signedOriginalLink)({ id: documentId, storage_bucket: INVOICES_BUCKET, storage_path: storagePath }, { supabase });
  const card = buildReviewCard({ ...ctxBase, rows, allocation, link });
  let posted = false;
  if (cfg.channelId) {
    const r = await post(card.text, cfg.channelId, { blocks: card.blocks });
    posted = !!r.ok;
    if (r.ok) {
      await supabase.from('marketing_invoice_documents').update({ status: 'in_review', slack_channel: r.channel, slack_ts: r.ts, updated_at: now().toISOString() }).eq('id', documentId);
      console.log(`${LOG} review card for ${documentId} posted (${a.vendor?.vendor_name || 'unknown vendor'}, ${flags.length} flag(s))`);
    } else {
      console.error(`${LOG} review card for ${documentId} NOT posted: ${r.error}`);
    }
  } else {
    console.warn(`${LOG} SLACK_MKT_INVOICE_CHANNEL_ID unset — ${documentId} waits in the ledger with no card`);
  }
  return { httpStatus: 200, success: true, duplicate: false, document_id: documentId, expense_ids: expenseIds, flags, auto_approved: false, review_posted: posted };
}

/**
 * Manual backfill (handoff §11.1): a CSV of expenses, one per line. Columns:
 * vendor, invoice_number, period_start, period_end, amount, lp_sub_sources
 * (semicolon-separated), markets (semicolon-separated codes), description.
 * Rows land pending_review unless `approvedBy` is given (the operator's
 * token-protected call with Mark's approval), in which case they are approved
 * and allocated at once.
 */
export async function importCsvExpenses(csvText, { approvedBy = null } = {}, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  const grid = parseCsv(String(csvText || ''));
  if (grid.length < 2) return { success: false, error: 'CSV needs a header row and at least one line' };
  const header = grid[0].map((h) => String(h).trim().toLowerCase());
  const col = (row, name) => { const i = header.indexOf(name); return i === -1 ? '' : String(row[i] ?? '').trim(); };
  for (const need of ['vendor', 'period_start', 'period_end', 'amount']) if (!header.includes(need)) return { success: false, error: `missing column ${need}` };
  const { data: vendors } = await supabase.from('marketing_vendors').select('*');
  const byName = Object.fromEntries((vendors || []).map((v) => [String(v.vendor_name).toLowerCase(), v]));
  const list = (s) => s.split(/[;|]/).map((x) => x.trim()).filter(Boolean);
  const out = { success: true, inserted: 0, skipped: [], ids: [] };
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row.some((c) => String(c).trim())) continue;
    const vendor = byName[col(row, 'vendor').toLowerCase()];
    if (!vendor) { out.skipped.push(`row ${i + 1}: unknown vendor "${col(row, 'vendor')}"`); continue; }
    const amount = Number(col(row, 'amount').replace(/[$,]/g, ''));
    if (!Number.isFinite(amount)) { out.skipped.push(`row ${i + 1}: bad amount`); continue; }
    const subs = list(col(row, 'lp_sub_sources')).length ? list(col(row, 'lp_sub_sources')) : vendor.lp_sub_sources;
    const markets = list(col(row, 'markets')).length ? list(col(row, 'markets')) : vendor.eligible_markets;
    if (!markets.length) { out.skipped.push(`row ${i + 1}: no markets for ${vendor.vendor_name}`); continue; }
    const rec = {
      vendor_id: vendor.id, cost_type: 'invoice', invoice_number: col(row, 'invoice_number') || `CSV-${todayET()}-${i}`, line_no: 1,
      description: col(row, 'description') || `Imported from CSV (${vendor.vendor_name})`, amount: Math.round(amount * 100) / 100,
      period_start: col(row, 'period_start'), period_end: col(row, 'period_end'), lp_sub_sources: subs, eligible_markets: markets,
      status: approvedBy ? 'approved' : 'pending_review', provisional: false, source_system: 'manual_csv',
      source_ref: `csv|${vendor.id}|${col(row, 'invoice_number') || i}|${col(row, 'period_start')}`,
      approved_by: approvedBy, approved_at: approvedBy ? new Date().toISOString() : null,
    };
    const { data, error } = await supabase.from('marketing_expenses').upsert(rec, { onConflict: 'source_system,source_ref' }).select('id').single();
    if (error) { out.skipped.push(`row ${i + 1}: ${error.message}`); continue; }
    out.inserted++;
    out.ids.push(data.id);
    if (approvedBy) await (deps.allocate || allocateExpenseById)(data.id, { supabase });
  }
  return out;
}

export function registerMarketingInvoiceRoutes(app, deps = {}) {
  assertIngestAuthConfigured('marketing-invoice-ingest');
  const refuse = (req, res) => refuseIngest(req, res, 'marketing-invoice-ingest');
  const json = express.json({ limit: '40mb' });
  const text = express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' });

  app.post('/n8n/admin/marketing-invoice-ingest', json, async (req, res) => {
    try {
      if (refuse(req, res)) return;
      const out = await (deps.ingest || ingestInvoice)(req.body, deps);
      const { httpStatus, ...body } = out;
      res.status(httpStatus || 200).json(body);
    } catch (err) {
      console.error(`${LOG} ingest error: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/n8n/admin/marketing-expenses/import-csv', text, async (req, res) => {
    try {
      if (refuse(req, res)) return;
      if (typeof req.body !== 'string' || !req.body.length) return res.status(400).json({ success: false, error: 'POST the CSV text (Content-Type: text/csv)' });
      const approvedBy = req.query.approved_by ? String(req.query.approved_by).slice(0, 120) : null;
      res.json(await importCsvExpenses(req.body, { approvedBy }, deps));
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/n8n/admin/marketing-expenses/reallocate', json, async (req, res) => {
    try {
      if (refuse(req, res)) return;
      const month = String(req.body?.month || req.query.month || todayET().slice(0, 7));
      res.json({ success: true, ...(await reallocateMonth(month, deps)) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // A PERSON applies a REECE_HOLD recommendation (handoff §7.5): the dashboard's
  // admin-only button relays here; the money never moves on its own.
  app.post('/n8n/admin/marketing-expenses/apply-recommendation', json, async (req, res) => {
    try {
      if (refuse(req, res)) return;
      const { applyRecommendation } = await import('../marketing/holds.js');
      const expenseId = String(req.body?.expense_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(expenseId)) return res.status(400).json({ success: false, error: 'expense_id must be a uuid' });
      const out = await applyRecommendation(expenseId, { markets: req.body?.markets || [], by: req.body?.by || null }, deps);
      res.status(out.ok ? 200 : 400).json({ success: out.ok, ...out });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/admin/marketing-expenses/status', async (req, res) => {
    try {
      if (refuse(req, res)) return;
      const supabase = deps.supabase || supabaseDefault;
      const [{ data: docs }, failing] = await Promise.all([
        supabase.from('marketing_invoice_documents').select('id, status, from_address, subject, received_at, analyzer, created_at').order('created_at', { ascending: false }).limit(50),
        reconcileAllocations({ supabase }),
      ]);
      res.json({ success: true, documents: docs || [], reconciliation_failures: failing });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[REST API] Registered: POST /n8n/admin/marketing-invoice-ingest | /marketing-expenses/import-csv | /marketing-expenses/reallocate | /marketing-expenses/apply-recommendation | GET /marketing-expenses/status');
}
