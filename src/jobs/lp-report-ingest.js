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
import { sha256Hex, contentSha256, resolveRowMarket, todayET, centsToDollars } from './lp-report-common.js';
import { parseJobsByMilestone, validateJobsByMilestone } from './lp-report-parse-a.js';
import { parseJobsByStatus, flagDuplicates, validateJobsByStatus } from './lp-report-parse-b.js';

const execFileP = promisify(execFile);
const INGEST_SECRET = (process.env.LP_REPORT_INGEST_SECRET || '').trim();
const STORAGE_BUCKET = 'lp-reports';

/**
 * URL slug → canonical report_type. Only the two PDF-parsed reports get an
 * ingest ROUTE here, but the map must cover all five, because the n8n telemetry
 * endpoint resolves failure reports through it too.
 */
export const REPORT_TYPES = {
  'jobs-by-milestone': 'jobs_by_milestone',
  'jobs-by-status': 'jobs_by_status',
};

/**
 * Every slug the telemetry endpoint may see, canonicalised.
 *
 * WHY THIS EXISTS. The telemetry handler resolved `REPORT_TYPES[slug] ?? slug`,
 * and REPORT_TYPES held only the two routed reports — so a failure reported for
 * any of the other three was logged under its RAW HYPHENATED slug. The ingest
 * log ended up carrying both spellings of the same report, with every failure
 * double-counted under two keys:
 *
 *   lead_disposition  11 failed   ·  lead-disposition  12 failed
 *   source_cost       12 failed   ·  source-cost       12 failed
 *   sales_efficiency   1 failed   ·  sales-efficiency   1 failed
 *
 * Anything grouping the log by report_type saw two half-populated reports
 * instead of one. One canonical key per report, always.
 */
export const REPORT_TYPE_SLUGS = {
  ...REPORT_TYPES,
  'lead-disposition': 'lead_disposition',
  'source-cost': 'source_cost',
  'sales-efficiency': 'sales_efficiency',
  'job-status': 'job_status_ytd',
  'job-status-ytd': 'job_status_ytd',
};

/**
 * Canonicalise any inbound report identifier. Known slugs map explicitly;
 * anything unrecognised still gets hyphens folded to underscores so a new
 * report can never open a second key for an existing one. Unknown reports stay
 * VISIBLE (returned, not dropped) — they just cannot fragment a known one.
 */
export function canonicalReportType(slug) {
  const s = String(slug ?? '').trim().toLowerCase();
  if (!s) return null;
  return REPORT_TYPE_SLUGS[s] ?? s.replace(/-/g, '_');
}

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

export async function logIngest(entry) {
  if (!supabase) return;
  const { error } = await supabase.from('scorecard_ingest_log').insert(entry);
  if (error) console.error('[LPReport] ingest-log write failed:', error.message);
}

export async function quarantineRows(reportType, sha, items) {
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

export async function alertGroupMe(text) {
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
export async function ingestReportPdf({ reportType, buffer, source = 'n8n', expectedPeriod = null }) {
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

  // 4-5. Parse + validate (pure). Expected milestone is config, default RTP —
  // the 2026-08-04 'Ordered' default was a regression against a briefly
  // misconfigured LP schedule and rejected every correct file.
  const isA = reportType === 'jobs_by_milestone';
  const parsed = isA ? parseJobsByMilestone(text) : parseJobsByStatus(text);
  if (!isA) flagDuplicates(parsed.rows);
  const { ok, violations, reconciliations } = isA
    ? validateJobsByMilestone(parsed, {
        expectedMilestone: (process.env.LP_REPORT_EXPECTED_MILESTONE || 'RTP').trim(),
        expectedPeriod,
      })
    : validateJobsByStatus(parsed);
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
  //    B's header gross EXCLUDES dup_review rows (ruled 2026-08-04: dups are
  //    retained + surfaced, never counted into bucket totals). row_count
  //    stays the full inserted-row count — it feeds the RPC insert assertion.
  const reportDate = isA ? null : (parsed.header.reportDate ?? todayET());
  const netTotal = isA
    ? parsed.rows.reduce((a, r) => a + (r.net_cents ?? 0), 0)
    : null;
  const grossTotal = isA
    ? parsed.rows.reduce((a, r) => a + (r.gross_cents ?? 0), 0)
    : parsed.rows.reduce((a, r) => a + (r.dup_review ? 0 : (r.total_gross_cents ?? 0)), 0);
  const snapshot = {
    report_type: reportType,
    period_start: isA ? parsed.header.periodStart : reportDate,
    period_end: isA ? parsed.header.periodEnd : reportDate,
    // The PDF's printed run date. This was hardcoded null on every snapshot,
    // which is why nothing could distinguish a genuine re-run from a redundant
    // re-fetch of the same report.
    report_generated_at: parsed.header.reportGeneratedAt ?? null,
    // ET date the report was generated — the lp_report_facts time-series
    // axis. Best-effort from the PDF's printed run date, else B's report
    // date, else the ingest date.
    as_of_date: parsed.header.reportGeneratedAt ?? reportDate ?? todayET(),
    file_sha256: sha,
    storage_path: storagePath,
    row_count: parsed.rows.length,
    net_total_cents: netTotal,
    gross_total_cents: grossTotal,
  };

  // CONTENT identity — see contentSha256. The byte hash above already rejected
  // a literal re-POST; this rejects the same logical report arriving as
  // different bytes, which is what produced eight jobs_by_milestone snapshots
  // for one period (all 30 rows, all net $702,506, all distinct file hashes).
  snapshot.content_sha256 = contentSha256({
    reportType,
    periodStart: snapshot.period_start,
    periodEnd: snapshot.period_end,
    asOfDate: snapshot.as_of_date,
    scope: snapshot.scope ?? null,
    rows: parsed.rows,
  });
  const { data: sameContent, error: contentErr } = await supabase
    .from('scorecard_report_snapshots')
    .select('id, ingested_at')
    .eq('report_type', reportType)
    .eq('content_sha256', snapshot.content_sha256)
    .maybeSingle();
  if (contentErr) throw new Error(`content-identity check failed: ${contentErr.message}`);
  if (sameContent) {
    await done('duplicate', {
      snapshot_id: sameContent.id,
      detail: { matched_on: 'content_sha256', file_sha256: sha, note: 're-render of an already-ingested report' },
    });
    return { success: true, duplicate: true, snapshot_id: sameContent.id, sha256: sha };
  }
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

  // 9. Bridge into the Net — Released hero. lp_market_scorecard_daily
  //    .released_dollars is sourced ONLY from lp_net_report_rtp, and until now
  //    the only writer of that table was the historical backfill route — so a
  //    current-month jobs_by_milestone snapshot with a perfectly good net total
  //    left the hero rendering "report pending" (2026-08-05 §2: Aug 1–31 net
  //    $702,507 current, lp_net_report_rtp latest row July). Dynamic import
  //    keeps the module cycle broken (backfill imports this file).
  //
  //    The snapshot is already durable and promoted at this point; a failing
  //    projection is reported and alerted, never silently swallowed, and never
  //    retracts a good snapshot.
  let netProjection = null;
  if (reportType === 'jobs_by_milestone') {
    try {
      const { projectSnapshotToNetReport } = await import('./lp-report-backfill.js');
      netProjection = await projectSnapshotToNetReport(snapshotId);
    } catch (err) {
      netProjection = { projected: false, reason: 'projection_failed', error: err.message };
      console.error(`[LPReport] net-report projection failed for ${snapshotId}: ${err.message}`);
      await alertGroupMe(`⚠️ LP report ${reportType} ingested (snapshot ${snapshotId}) but the Net — Released projection FAILED: ${err.message}. The dashboard hero will read "report pending" until this is fixed.`);
    }
  }

  // Granted tolerances (display_rounding) are logged on SUCCESS too — the
  // allowance must stay visible on every invocation, never silent.
  await done('success', {
    snapshot_id: snapshotId,
    detail: reconciliations?.length || netProjection
      ? { ...(reconciliations?.length ? { reconciliations } : {}), ...(netProjection ? { net_projection: netProjection } : {}) }
      : null,
  });
  console.log(`[LPReport] ${reportType} ingested: ${rows.length} rows, ${isA ? `net ${centsToDollars(netTotal)}` : `gross ${centsToDollars(grossTotal)}`}, snapshot ${snapshotId}${reconciliations?.length ? `, ${reconciliations.length} display_rounding reconciliation(s)` : ''}${netProjection?.projected ? `, net-report projected ${netProjection.total_net} as of ${netProjection.report_as_of}` : ''}`);
  return {
    success: true, snapshot_id: snapshotId, rows: rows.length, sha256: sha,
    reconciliations: reconciliations ?? [],
    ...(netProjection ? { net_projection: netProjection } : {}),
  };
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

  // Historical backfill — the identical pipeline (ingestReportPdf, shared
  // validators) with a caller-declared expected period; a mismatched header
  // fails with wrong_period. Bridges successful jobs_by_milestone snapshots
  // into the lp_net_report_rtp month-freeze path. See lp-report-backfill.js.
  for (const [slug, reportType] of Object.entries(REPORT_TYPES)) {
    app.post(`/n8n/admin/lp-report-ingest/backfill/${slug}`, rawPdf, async (req, res) => {
      try {
        if (!authorized(req)) return res.status(401).json({ success: false, error: 'bad signature' });
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
          return res.status(400).json({ success: false, error: 'POST the raw PDF bytes as the request body (Content-Type: application/pdf)' });
        }
        const { runReportBackfill } = await import('./lp-report-backfill.js');
        const result = await runReportBackfill({
          reportType,
          buffer: req.body,
          expectedStart: String(req.query.expected_start || '').trim(),
          expectedEnd: String(req.query.expected_end || '').trim(),
          source: String(req.query.source || 'backfill'),
        });
        res.json(result);
      } catch (err) {
        console.error(`[LPReport] ${slug} backfill error:`, err.message);
        res.status(500).json({ success: false, error: err.message });
      }
    });
  }

  // n8n failure telemetry. The workflows POST here when the ingest call
  // itself failed (transport error, timeout) or returned success:false —
  // previously a 404 because /events/* only serves GHL contact events, which
  // masked the real failure reason three debugging cycles in a row. Writes to
  // scorecard_ingest_log (the table that already records ingest failures) and
  // alerts GroupMe for transport-class failures LP-MCP never saw. ALWAYS 200
  // on handled errors — a failure-reporting path must never fail its caller.
  app.post('/events/lp_report_ingest_failed', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ success: false, error: 'bad signature' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const slug = String(body.report || '').trim();
      const reportType = canonicalReportType(slug);
      // n8n stringifies its reason, but a non-string slipping through used to
      // land in the log as the literal `n8n_[object Object]`.
      const rawReason = body.failure_reason;
      const reason = String(
        typeof rawReason === 'string' || typeof rawReason === 'number'
          ? rawReason
          : rawReason == null
            ? 'unknown'
            : JSON.stringify(rawReason),
      ).slice(0, 120);
      await logIngest({
        report_type: reportType || 'unknown',
        file_sha256: typeof body.sha256 === 'string' && body.sha256 ? body.sha256 : null,
        status: 'failed',
        failure_reason: `n8n_${reason}`.slice(0, 120),
        detail: { ...body, source: 'n8n_telemetry' },
        source: 'n8n_telemetry',
      });
      // LP-MCP already alerted for failures it saw itself; transport-class
      // failures (no sha) are the ones only n8n knows about.
      if (!body.sha256) {
        await alertGroupMe(`⚠️ LP report ingest TRANSPORT failure (${body.workflow || 'n8n'} / ${slug || '?'}): ${reason}. The PDF never reached LP-MCP — check n8n execution history.`);
      }
      res.json({ success: true });
    } catch (err) {
      console.error('[LPReport] telemetry event error:', err.message);
      res.json({ success: true, logged: false, error: err.message });
    }
  });

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
        .select('id, report_type, period_start, period_end, row_count, net_total_cents, gross_total_cents, ingested_at')
        .eq('is_current', true)
        .order('ingested_at', { ascending: false }).limit(10);
      // dup_review rows are excluded from bucket totals (ruled 2026-08-04)
      // but never dropped — this is their human-review surface.
      const currentB = (current || []).find((s) => s.report_type === 'jobs_by_status');
      let dupReview = [];
      if (currentB) {
        const { data: dups } = await supabase
          .from('scorecard_report_rows_b')
          .select('prosp_number, customer_name, market, status_raw, bucket, contract_date, total_gross_cents, lender')
          .eq('snapshot_id', currentB.id).eq('dup_review', true)
          .order('prosp_number');
        dupReview = dups || [];
      }
      // Current-facts summary — grain counts + the as_of span per report type
      // (the lp_report_facts time series accumulating).
      const { data: factRows } = await supabase
        .from('lp_report_facts')
        .select('report_type, as_of_date')
        .eq('is_current', true);
      const facts = {};
      for (const f of factRows || []) {
        const acc = facts[f.report_type] || { grains: 0, as_of_min: f.as_of_date, as_of_max: f.as_of_date };
        acc.grains += 1;
        if (f.as_of_date < acc.as_of_min) acc.as_of_min = f.as_of_date;
        if (f.as_of_date > acc.as_of_max) acc.as_of_max = f.as_of_date;
        facts[f.report_type] = acc;
      }
      res.json({ success: true, recent: log || [], current: current || [], dup_review: dupReview, facts });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Rebuild one snapshot's facts from its raw rows (raw wins — the recon's
  // manual escape hatch). Same auth as ingest.
  app.post('/n8n/admin/lp-report-facts-rebuild', async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ success: false, error: 'bad signature' });
      if (!supabase) return res.status(500).json({ success: false, error: 'Supabase not configured' });
      const snapshotId = String(req.query.snapshot_id || '').trim();
      if (!snapshotId) return res.status(400).json({ success: false, error: 'snapshot_id query param required' });
      const { data, error } = await supabase.rpc('scorecard_rebuild_facts', { p_snapshot_id: snapshotId });
      if (error) throw new Error(error.message);
      res.json({ success: true, snapshot_id: snapshotId, fact_rows: data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[LPReport] Routes registered: POST /n8n/admin/lp-report-ingest/{jobs-by-milestone|jobs-by-status} | POST /n8n/admin/lp-report-ingest/backfill/{…} | POST /events/lp_report_ingest_failed | GET /n8n/admin/lp-report-ingest/status | POST /n8n/admin/lp-report-facts-rebuild');
}
