// ─── LP report PDF ingest orchestrator — src/jobs/lp-report-ingest.js ───
//
// POST /n8n/admin/lp-report-ingest/jobs-by-milestone  (Report A → Net Sales)
// POST /n8n/admin/lp-report-ingest/jobs-by-status     (Report B → GB split)
// GET  /n8n/admin/lp-report-ingest/status
//
// n8n is thin transport: Gmail Trigger → POST the raw PDF bytes here. This
// module owns the whole pipeline, in the handoff's order:
//   sha256 → duplicate check → ARCHIVE FIRST (Storage keeps the original
//   even when parsing dies) → pdffonts text-layer assertion (scanned PDF →
//   no_text_layer, STOP — no OCR ever) → pdftotext -layout → parse →
//   validate → market/status resolution → scorecard_ingest_snapshot RPC
//   (single tx) → ingest log.
//
// FAIL-CLOSED: any validation violation or unresolvable row means NOTHING
// writes to the snapshot/row tables. The scorecard_ingest_log row (+
// scorecard_ingest_quarantine rows) are the failure record and always
// write. GroupMe gets failures only — a healthy morning is silent.
//
// HTTP CONTRACT: deterministic content failures return 200 with
// { success:false, failure_reason } (the goal-scorecard-run precedent) so
// n8n's retry loop doesn't hammer an identically-failing PDF; transport /
// infra errors stay 5xx and DO retry. Requires poppler-utils in the image
// (Dockerfile: apk add poppler-utils).

import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import supabase from '../supabase.js';
import { getMarketMaps } from './market-resolver.js';
import { sha256Hex, resolveRowMarket, todayET, centsToDollars } from './lp-report-common.js';
import { parseJobsByMilestone, validateJobsByMilestone } from './lp-report-parse-a.js';
import { parseJobsByStatus, flagDuplicates, validateJobsByStatus } from './lp-report-parse-b.js';

const execFileP = promisify(execFile);
const INGEST_SECRET = (process.env.LP_REPORT_INGEST_SECRET || '').trim();
const STORAGE_BUCKET = 'lp-reports';

export const REPORT_TYPES = {
  'jobs-by-milestone': 'jobs_by_milestone',
  'jobs-by-status': 'jobs_by_status',
};

export class NoTextLayerError extends Error {
  constructor(msg) { super(msg); this.name = 'NoTextLayerError'; }
}

/**
 * pdffonts + pdftotext -layout via poppler. The pdffonts pass is the
 * text-layer assertion: a scanned/flattened PDF lists zero fonts, and we
 * STOP there — OCR output can silently transpose money, so it is banned.
 */
export async function extractPdfText(buffer) {
  const tmp = join(tmpdir(), `lp-report-${randomUUID()}.pdf`);
  await writeFile(tmp, buffer);
  try {
    const fonts = await execFileP('pdffonts', [tmp], { maxBuffer: 4 * 1024 * 1024 });
    // pdffonts prints two header lines, then one row per embedded font.
    const fontRows = fonts.stdout.split('\n').slice(2).filter((l) => l.trim());
    if (!fontRows.length) {
      throw new NoTextLayerError('PDF has no text layer (pdffonts lists zero fonts) — scanned image? OCR is not permitted.');
    }
    const { stdout } = await execFileP('pdftotext', ['-layout', tmp, '-'], { maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } finally {
    await unlink(tmp).catch(() => {});
  }
}

async function logIngest(entry) {
  if (!supabase) return;
  const { error } = await supabase.from('scorecard_ingest_log').insert(entry);
  if (error) console.error('[LPReport] ingest-log write failed:', error.message);
}

async function quarantineRows(reportType, sha, items) {
  if (!supabase || !items.length) return;
  const { error } = await supabase.from('scorecard_ingest_quarantine').insert(
    items.map(({ reason, row }) => ({
      report_type: reportType,
      file_sha256: sha,
      reason,
      row_raw: row.notes_raw ?? null,
      parsed: row,
    })),
  );
  if (error) console.error('[LPReport] quarantine write failed:', error.message);
}

async function alertGroupMe(text) {
  try {
    const { sendGroupMeMessage } = await import('../groupme.js');
    await sendGroupMeMessage(text);
  } catch (err) {
    console.error('[LPReport] GroupMe alert failed:', err.message);
  }
}

/**
 * Run the full pipeline for one PDF. Returns the HTTP-shaped result;
 * never throws for content problems (those are logged + returned), only
 * for infra failures the route maps to 5xx.
 */
export async function ingestReportPdf({ reportType, buffer, source = 'n8n' }) {
  const started = Date.now();
  if (!supabase) throw new Error('Supabase not configured');
  const sha = sha256Hex(buffer);
  const done = (status, extra = {}) =>
    logIngest({
      report_type: reportType, file_sha256: sha, status,
      failure_reason: extra.failure_reason ?? null, detail: extra.detail ?? null,
      snapshot_id: extra.snapshot_id ?? null, source, duration_ms: Date.now() - started,
    });

  // 1. Idempotency: same bytes twice = clean no-op (LP re-sends, n8n retries).
  const { data: dup, error: dupErr } = await supabase
    .from('scorecard_report_snapshots')
    .select('id, ingested_at')
    .eq('report_type', reportType).eq('file_sha256', sha)
    .maybeSingle();
  if (dupErr) throw new Error(`duplicate check failed: ${dupErr.message}`);
  if (dup) {
    await done('duplicate', { snapshot_id: dup.id });
    return { success: true, duplicate: true, snapshot_id: dup.id, sha256: sha };
  }

  // 2. Archive FIRST — the original survives every downstream failure.
  const storagePath = `${reportType}/${todayET()}/${sha}.pdf`;
  const { error: upErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });
  if (upErr) throw new Error(`storage archive failed: ${upErr.message}`);

  // 3. Text layer or stop.
  let text;
  try {
    text = await extractPdfText(buffer);
  } catch (err) {
    if (err instanceof NoTextLayerError) {
      await done('no_text_layer', { failure_reason: 'no_text_layer', detail: { message: err.message, storage_path: storagePath } });
      await alertGroupMe(`⚠️ LP report ingest STOPPED (${reportType}): PDF has no text layer (scanned image?). Archived at ${storagePath}. LP must re-send a text PDF — OCR is not permitted.`);
      return { success: false, failure_reason: 'no_text_layer', sha256: sha };
    }
    throw err;
  }

  // 4-5. Parse + validate (pure).
  const isA = reportType === 'jobs_by_milestone';
  const parsed = isA ? parseJobsByMilestone(text) : parseJobsByStatus(text);
  if (!isA) flagDuplicates(parsed.rows);
  const { ok, violations } = isA ? validateJobsByMilestone(parsed) : validateJobsByStatus(parsed);
  if (!ok) {
    const reason = violations[0].rule;
    await quarantineRows(reportType, sha,
      parsed.rows.filter((r) => !isA && r.bucket == null).map((row) => ({ reason: 'unmapped_status', row })));
    await done('failed', { failure_reason: reason, detail: { violations } });
    await alertGroupMe(`⚠️ LP report ingest REJECTED (${reportType}): ${reason} (+${violations.length - 1} more). Nothing written — see scorecard_ingest_log. Archived at ${storagePath}.`);
    return { success: false, failure_reason: reason, violations, sha256: sha };
  }

  // 6. Market resolution — an unmapped branch quarantines the row and
  //    rejects the FILE (never silently UNASSIGNED revenue).
  const { branchMap } = await getMarketMaps();
  const unmappedBranch = [];
  for (const row of parsed.rows) {
    row.market = resolveRowMarket(row.branch_code_raw, branchMap);
    if (!row.market) unmappedBranch.push(row);
  }
  if (unmappedBranch.length) {
    await quarantineRows(reportType, sha, unmappedBranch.map((row) => ({ reason: 'unmapped_branch', row })));
    const branches = [...new Set(unmappedBranch.map((r) => r.branch_code_raw))];
    await done('failed', { failure_reason: 'unmapped_branch', detail: { count: unmappedBranch.length, branches } });
    await alertGroupMe(`⚠️ LP report ingest REJECTED (${reportType}): ${unmappedBranch.length} row(s) with unmapped branch ${branches.join(', ')}. Add to lp_branch_market_map, then re-send.`);
    return { success: false, failure_reason: 'unmapped_branch', branches, sha256: sha };
  }

  // 7. Snapshot payload. A: the PDF's own declared range. B: point-in-time.
  const reportDate = isA ? null : (parsed.header.reportDate ?? todayET());
  const netTotal = isA
    ? parsed.rows.reduce((a, r) => a + (r.net_cents ?? 0), 0)
    : null;
  const grossTotal = isA
    ? parsed.rows.reduce((a, r) => a + (r.gross_cents ?? 0), 0)
    : parsed.rows.reduce((a, r) => a + (r.total_gross_cents ?? 0), 0);
  const snapshot = {
    report_type: reportType,
    period_start: isA ? parsed.header.periodStart : reportDate,
    period_end: isA ? parsed.header.periodEnd : reportDate,
    report_generated_at: null,
    file_sha256: sha,
    storage_path: storagePath,
    row_count: parsed.rows.length,
    net_total_cents: netTotal,
    gross_total_cents: grossTotal,
  };
  const rows = isA
    ? parsed.rows.map((r) => ({
        job_number: r.job_number, customer_name: r.customer_name, address: r.address,
        city: r.city, contract_date: r.contract_date, rtp_date: r.rtp_date,
        branch_code_raw: r.branch_code_raw, market: r.market, product: r.product,
        gross_cents: r.gross_cents, net_cents: r.net_cents, paid_cents: r.paid_cents,
        balance_cents: r.balance_cents, sales_rep: r.sales_rep,
      }))
    : parsed.rows.map((r) => ({
        prosp_number: r.prosp_number, customer_name: r.customer_name, phone: r.phone,
        email: r.email, contract_date: r.contract_date, branch_code_raw: r.branch_code_raw,
        market: r.market, status_raw: r.status_raw, bucket: r.bucket,
        total_gross_cents: r.total_gross_cents, lender: r.lender,
        notes_raw: r.notes_raw, dup_review: r.dup_review,
      }));

  // 8. One transaction: snapshot + rows + count assertion + is_current flip.
  const { data: snapshotId, error: rpcErr } = await supabase
    .rpc('scorecard_ingest_snapshot', { p_snapshot: snapshot, p_rows: rows });
  if (rpcErr) throw new Error(`ingest RPC failed: ${rpcErr.message}`);

  await done('success', { snapshot_id: snapshotId });
  console.log(`[LPReport] ${reportType} ingested: ${rows.length} rows, ${isA ? `net ${centsToDollars(netTotal)}` : `gross ${centsToDollars(grossTotal)}`}, snapshot ${snapshotId}`);
  return { success: true, snapshot_id: snapshotId, rows: rows.length, sha256: sha };
}

function authorized(req) {
  if (!INGEST_SECRET) return true;
  const provided = req.headers['x-ghl-signature'] || req.headers['x-webhook-secret'] || '';
  return provided === INGEST_SECRET;
}

export function registerLpReportRoutes(app) {
  // Raw bytes, route-scoped (PDFs blow through express.json's cap).
  const rawPdf = express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '25mb' });

  for (const [slug, reportType] of Object.entries(REPORT_TYPES)) {
    app.post(`/n8n/admin/lp-report-ingest/${slug}`, rawPdf, async (req, res) => {
      try {
        if (!authorized(req)) return res.status(401).json({ success: false, error: 'bad signature' });
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
          return res.status(400).json({ success: false, error: 'POST the raw PDF bytes as the request body (Content-Type: application/pdf)' });
        }
        const result = await ingestReportPdf({
          reportType, buffer: req.body, source: String(req.query.source || 'n8n'),
        });
        // Deterministic content failures are 200 so n8n doesn't retry a PDF
        // that will fail identically; the log row + GroupMe carry the alarm.
        res.json(result);
      } catch (err) {
        console.error(`[LPReport] ${slug} ingest error:`, err.message);
        res.status(500).json({ success: false, error: err.message });
      }
    });
  }

  app.get('/n8n/admin/lp-report-ingest/status', async (req, res) => {
    try {
      if (!supabase) return res.status(500).json({ success: false, error: 'Supabase not configured' });
      const { data: log, error } = await supabase
        .from('scorecard_ingest_log')
        .select('report_type, status, failure_reason, snapshot_id, duration_ms, created_at')
        .order('created_at', { ascending: false }).limit(20);
      if (error) throw new Error(error.message);
      const { data: current } = await supabase
        .from('scorecard_report_snapshots')
        .select('report_type, period_start, period_end, row_count, net_total_cents, gross_total_cents, ingested_at')
        .eq('is_current', true)
        .order('ingested_at', { ascending: false }).limit(10);
      res.json({ success: true, recent: log || [], current: current || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[LPReport] Routes registered: POST /n8n/admin/lp-report-ingest/{jobs-by-milestone|jobs-by-status} | GET /n8n/admin/lp-report-ingest/status');
}
