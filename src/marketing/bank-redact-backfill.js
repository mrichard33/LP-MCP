/**
 * Erase the bank numbers already saved — src/marketing/bank-redact-backfill.js
 *
 * 2026-10-19 (the user): "Please also remove the routing and account numbers
 * that were already entered into my system." Until today every invoice's text
 * was stored whole, so a LightFire remit block sits in
 * marketing_invoice_documents (extracted_text, the model's analysis, an error,
 * the subject), possibly in a marketing_expenses description, and in a stored
 * .txt copy of an email-body invoice. This pass runs redactBankDetails over all
 * of them (the same function the ingest now runs, so a second pass finds 0).
 *
 * The original PDFs and photos are KEPT (the user's ruling: "Keep files, admins
 * only"); a PDF cannot be redacted in place and the dashboard opens it for
 * admins only. Only our own .txt copies of email bodies are rewritten.
 *
 * The report holds COUNTS only, never a number. Dry run by default.
 * Entry points: MCP tool invoice_bank_redact_run, scripts/redact-saved-bank-numbers.js.
 */
import supabaseDefault from '../supabase.js';
import { redactBankDetails, redactBankDeep, removedCount } from '../security/bank-redact.js';

const LOG = '[BankRedactBackfill]';
const PAGE = 100;
const BUCKET = 'marketing-invoices';

const add = (into, removed) => { into.routing += removed.routing || 0; into.account += removed.account || 0; };

async function readAll(supabase, table, columns) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select(columns).order('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * @param {{ dryRun?: boolean }} opts
 * @param {{ supabase?: object }} deps
 */
export async function runBankRedactBackfill({ dryRun = true } = {}, deps = {}) {
  const supabase = deps.supabase || supabaseDefault;
  if (!supabase) throw new Error('supabase is not configured');
  const report = {
    dry_run: dryRun,
    documents: { scanned: 0, with_numbers: 0, updated: 0, failed: 0 },
    expenses: { scanned: 0, with_numbers: 0, updated: 0, failed: 0 },
    stored_text_files: { scanned: 0, with_numbers: 0, updated: 0, failed: 0 },
    numbers_found: { routing: 0, account: 0 },
    originals_kept: 0,
  };

  // 1. The document rows: text, analysis, error, subject.
  const docs = await readAll(supabase, 'marketing_invoice_documents', 'id, extracted_text, analysis, error, subject, storage_bucket, storage_path');
  for (const d of docs) {
    report.documents.scanned++;
    const found = { routing: 0, account: 0 };
    const patch = {};
    for (const col of ['extracted_text', 'error', 'subject']) {
      if (typeof d[col] !== 'string') continue;
      const r = redactBankDetails(d[col]);
      if (removedCount(r.removed)) { patch[col] = r.text; add(found, r.removed); }
    }
    if (d.analysis && typeof d.analysis === 'object') {
      const r = redactBankDeep(d.analysis);
      if (removedCount(r.removed)) { patch.analysis = r.value; add(found, r.removed); }
    }
    if (d.storage_path && !/\.txt$/i.test(d.storage_path)) report.originals_kept++;
    if (!removedCount(found)) continue;
    report.documents.with_numbers++;
    add(report.numbers_found, found);
    if (dryRun) continue;
    const { error } = await supabase.from('marketing_invoice_documents').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', d.id);
    if (error) { report.documents.failed++; console.warn(`${LOG} document ${d.id} not updated: ${error.message}`); } else report.documents.updated++;
  }

  // 2. Ledger descriptions (built from the model's line descriptions).
  const rows = await readAll(supabase, 'marketing_expenses', 'id, description');
  for (const x of rows) {
    report.expenses.scanned++;
    if (typeof x.description !== 'string') continue;
    const r = redactBankDetails(x.description);
    if (!removedCount(r.removed)) continue;
    report.expenses.with_numbers++;
    add(report.numbers_found, r.removed);
    if (dryRun) continue;
    const { error } = await supabase.from('marketing_expenses').update({ description: r.text }).eq('id', x.id);
    if (error) { report.expenses.failed++; console.warn(`${LOG} expense ${x.id} not updated: ${error.message}`); } else report.expenses.updated++;
  }

  // 3. Our own .txt copies of email-body invoices.
  for (const d of docs) {
    if (!d.storage_path || !/\.txt$/i.test(d.storage_path)) continue;
    report.stored_text_files.scanned++;
    const bucket = d.storage_bucket || BUCKET;
    try {
      const { data, error } = await supabase.storage.from(bucket).download(d.storage_path);
      if (error) throw new Error(error.message);
      const body = typeof data?.text === 'function' ? await data.text() : Buffer.from(data || '').toString('utf8');
      const r = redactBankDetails(body);
      if (!removedCount(r.removed)) continue;
      report.stored_text_files.with_numbers++;
      add(report.numbers_found, r.removed);
      if (dryRun) continue;
      const { error: upErr } = await supabase.storage.from(bucket).upload(d.storage_path, Buffer.from(r.text, 'utf8'), { contentType: 'text/plain', upsert: true });
      if (upErr) throw new Error(upErr.message);
      report.stored_text_files.updated++;
    } catch (err) {
      report.stored_text_files.failed++;
      console.warn(`${LOG} stored copy of ${d.id} not read or rewritten: ${err.message}`);
    }
  }

  console.log(`${LOG} ${dryRun ? 'dry run' : 'applied'}: ${report.documents.with_numbers} document(s), ${report.expenses.with_numbers} ledger line(s), ${report.stored_text_files.with_numbers} stored text file(s); ${report.numbers_found.routing} routing + ${report.numbers_found.account} account number(s)`);
  return report;
}
