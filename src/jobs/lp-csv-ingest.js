// ─── LP CSV export ingest orchestrator — src/jobs/lp-csv-ingest.js ───
//
// POST /n8n/admin/lp-csv-ingest/job-status        (Job Status Report YTD)
// POST /n8n/admin/lp-csv-ingest/lead-disposition  (Lead Disposition Detail)
// POST /n8n/admin/lp-csv-ingest/source-cost       (Marketing Sub-Source Cost 2)
// POST /n8n/admin/lp-report-ingest/lead-disposition  (future PDF — parser_pending)
// POST /n8n/admin/lp-report-ingest/source-cost       (future PDF — parser_pending)
//
// Mirrors lp-report-ingest.js: sha256 → duplicate check → ARCHIVE FIRST →
// parse → validate → market resolution → chunked RPC load
// (lp_csv_ingest_begin → _rows×N → _finalize) → ingest log. The finalize
// RPC is the fail-closed gate: row-count + control-total assertions run in
// ONE tx with the is_current promotion, so a bad load never becomes
// visible. GroupMe gets failures only.
//
// The CSVs are today a manual backfill (LP's scheduler is PDF-only,
// confirmed 2026-08-05). The PDF endpoints for reports C/D exist but fail
// closed with parser_pending until a first real sample PDF lets us build
// and pin their parsers — the archived PDF is that sample.
//
// HTTP CONTRACT: deterministic content failures return 200 with
// { success:false, failure_reason }; transport/infra errors stay 5xx.

import express from 'express';

import supabase from '../supabase.js';
import { getMarketMaps } from './market-resolver.js';
import { sha256Hex, todayET, centsToDollars } from './lp-report-common.js';
import { logIngest, quarantineRows, alertGroupMe } from './lp-report-ingest.js';
import { parseJobStatusCsv, validateJobStatusCsv } from './lp-report-parse-job-status.js';
import {
  parseLeadDispositionCsv, validateLeadDispositionCsv, resolveLeadMarkets,
  leadDispositionControlTotals,
} from './lp-report-parse-lead-disposition.js';
import { parseSourceCostCsv, validateSourceCostCsv } from './lp-report-parse-source-cost.js';

const INGEST_SECRET = (process.env.LP_REPORT_INGEST_SECRET || '').trim();
const STORAGE_BUCKET = 'lp-reports';
const ROW_CHUNK = 1500;

export const CSV_REPORT_TYPES = {
  'job-status': 'job_status_ytd',
  'lead-disposition': 'lead_disposition',
  'source-cost': 'source_cost',
};

/** Slugs whose PDF variant has no parser yet — fail closed until a sample arrives. */
export const PDF_PENDING_TYPES = {
  'lead-disposition': 'lead_disposition',
  'source-cost': 'source_cost',
};

/**
 * Market map for Job Status rows: cst_id → { market, method, brn, lead_id }.
 * The Job Status export has NO branch column (LP report gap — flagged as a
 * recommendation to add one); market comes from the cst_id → Lead
 * Disposition id join against the CURRENT lead_disposition snapshot.
 *
 * A cst_id can match several lead rows (lead id repeats). Preference:
 *   1. a row with Category 'Sale-Contract Signed' (a job implies a sale)
 *   2. a row with a real branch over one without
 *   3. latest entry_date
 * When surviving candidates still disagree on market (4 FTMYR-vs-SAR cases
 * on 2026-08-05), the winner is taken and the disagreement reported in
 * ambiguities — advisory, not file-failing.
 */
export async function buildJobStatusMarketMap(cstIds) {
  const { data: snaps, error: snapErr } = await supabase
    .from('scorecard_report_snapshots')
    .select('id, period_start, period_end, as_of_date')
    .eq('report_type', 'lead_disposition').eq('is_current', true)
    .order('period_end', { ascending: false }).limit(1);
  if (snapErr) throw new Error(`lead snapshot lookup failed: ${snapErr.message}`);
  if (!snaps?.length) return { snapshotId: null, byCst: new Map(), ambiguities: [] };
  const snapshotId = snaps[0].id;

  const ids = [...new Set(cstIds.filter(Boolean))];
  const byCst = new Map();
  const ambiguities = [];
  const CHUNK = 300;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const { data, error } = await supabase
      .from('lp_lead_disposition_history')
      .select('lp_lead_id, brn_id_raw, market, market_method, category, entry_date')
      .eq('snapshot_id', snapshotId)
      .in('lp_lead_id', slice);
    if (error) throw new Error(`lead join lookup failed: ${error.message}`);
    const grouped = new Map();
    for (const r of data || []) {
      const list = grouped.get(r.lp_lead_id) || [];
      list.push(r);
      grouped.set(r.lp_lead_id, list);
    }
    for (const [cstId, list] of grouped) {
      const rank = (r) => [
        r.category === 'Sale-Contract Signed' ? 1 : 0,
        r.brn_id_raw && r.brn_id_raw !== '0' ? 1 : 0,
        r.entry_date || '',
      ];
      list.sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        for (let k = 0; k < ra.length; k++) {
          if (ra[k] !== rb[k]) return ra[k] > rb[k] ? -1 : 1;
        }
        return 0;
      });
      const winner = list[0];
      const markets = [...new Set(list.map((r) => r.market))];
      if (markets.length > 1) {
        ambiguities.push({ cst_id: cstId, markets, chosen: winner.market });
      }
      byCst.set(cstId, {
        market: winner.market,
        method: 'lead_join',
        branch_code_raw: winner.brn_id_raw || null,
        lead_id: winner.lp_lead_id,
      });
    }
  }
  return { snapshotId, byCst, ambiguities };
}

async function loadChunked(snapshotId, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += ROW_CHUNK) {
    const chunk = rows.slice(i, i + ROW_CHUNK);
    const { data, error } = await supabase.rpc('lp_csv_ingest_rows', {
      p_snapshot_id: snapshotId, p_rows: chunk,
    });
    if (error) throw new Error(`row load failed at chunk ${i / ROW_CHUNK}: ${error.message}`);
    inserted += data ?? 0;
  }
  return inserted;
}

/**
 * Run the full pipeline for one CSV. Same result contract as
 * ingestReportPdf: content problems are logged + returned (never thrown),
 * infra failures throw and the route maps them to 5xx.
 */
export async function ingestCsv({ reportType, text, source = 'manual', expectedTotals = null }) {
  const started = Date.now();
  if (!supabase) throw new Error('Supabase not configured');
  const buffer = Buffer.from(text, 'utf8');
  const sha = sha256Hex(buffer);
  const done = (status, extra = {}) =>
    logIngest({
      report_type: reportType, file_sha256: sha, status,
      failure_reason: extra.failure_reason ?? null, detail: extra.detail ?? null,
      snapshot_id: extra.snapshot_id ?? null, source, duration_ms: Date.now() - started,
    });

  // 1. Idempotency — same bytes twice is a clean no-op.
  const { data: dup, error: dupErr } = await supabase
    .from('scorecard_report_snapshots')
    .select('id').eq('report_type', reportType).eq('file_sha256', sha)
    .maybeSingle();
  if (dupErr) throw new Error(`duplicate check failed: ${dupErr.message}`);
  if (dup) {
    await done('duplicate', { snapshot_id: dup.id });
    return { success: true, duplicate: true, snapshot_id: dup.id, sha256: sha };
  }

  // 2. Archive FIRST.
  const storagePath = `${reportType}/${todayET()}/${sha}.csv`;
  const { error: upErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: 'text/csv', upsert: true });
  if (upErr) throw new Error(`storage archive failed: ${upErr.message}`);

  const fail = async (reason, detail, alert) => {
    await done('failed', { failure_reason: reason, detail });
    await alertGroupMe(`⚠️ LP CSV ingest REJECTED (${reportType}): ${alert} Nothing promoted — see scorecard_ingest_log. Archived at ${storagePath}.`);
    return { success: false, failure_reason: reason, sha256: sha };
  };

  // 3. Parse + validate + market resolution, per type.
  let parsed, rows, controlTotals, extraDetail = {};
  try {
    if (reportType === 'job_status_ytd') {
      parsed = parseJobStatusCsv(text);
      const v = validateJobStatusCsv(parsed);
      if (!v.ok) {
        await quarantineRows(reportType, sha,
          parsed.rows.filter((r) => r.bucket == null).map((row) => ({ reason: 'unmapped_status', row })));
        return await fail(v.violations[0].rule, { violations: v.violations },
          `${v.violations[0].rule} (+${v.violations.length - 1} more).`);
      }
      const { snapshotId: leadSnap, byCst, ambiguities } =
        await buildJobStatusMarketMap(parsed.rows.map((r) => r.cst_id));
      if (!leadSnap) {
        return await fail('lead_snapshot_missing',
          { message: 'no current lead_disposition snapshot to join markets from — ingest Lead Disposition first' },
          'no current lead_disposition snapshot — ingest Lead Disposition first.');
      }
      const unmatched = [];
      rows = parsed.rows.map((r) => {
        const hit = byCst.get(r.cst_id);
        if (!hit) unmatched.push(r.cst_id);
        return {
          cst_id: r.cst_id,
          lead_id: hit?.lead_id ?? null,
          contract_id: r.contract_id,
          customer_name: r.customer_name,
          phone: r.phone,
          contract_date: r.contract_date,
          net_date: r.net_date,
          status_date: r.status_date,
          status_raw: r.status_raw,
          bucket: r.bucket,
          gross_cents: r.gross_cents,
          fin_cents: r.fin_cents,
          rep_name: r.rep_name,
          fin_co: r.fin_co,
          branch_code_raw: hit?.branch_code_raw ?? null,
          // Unmatched jobs land in UNASSIGNED — visible, never dropped, and
          // named individually in the ingest log detail.
          market: hit?.market ?? 'UNASSIGNED',
          market_method: hit ? hit.method : 'unmatched_lead',
          notes_raw: r.notes_raw,
        };
      });
      const bucketTally = {};
      for (const r of rows) bucketTally[r.bucket] = (bucketTally[r.bucket] || 0) + 1;
      controlTotals = {
        gross_cents: rows.reduce((a, r) => a + (r.gross_cents ?? 0), 0),
        hoa_count: bucketTally.hoa ?? 0,
        permit_count: bucketTally.permit ?? 0,
      };
      extraDetail = { unmatched_cst_ids: unmatched, join_ambiguities: ambiguities, bucket_tally: bucketTally, lead_snapshot_id: leadSnap };
    } else if (reportType === 'lead_disposition') {
      parsed = parseLeadDispositionCsv(text);
      const v = validateLeadDispositionCsv(parsed);
      if (!v.ok) {
        return await fail(v.violations[0].rule, { violations: v.violations },
          `${v.violations[0].rule} (+${v.violations.length - 1} more).`);
      }
      const maps = await getMarketMaps();
      const unmappedBranch = resolveLeadMarkets(parsed.rows, maps);
      if (unmappedBranch.length) {
        await quarantineRows(reportType, sha,
          unmappedBranch.map((row) => ({ reason: 'unmapped_branch', row })));
        const branches = [...new Set(unmappedBranch.map((r) => r.brn_id_raw))];
        await done('failed', { failure_reason: 'unmapped_branch', detail: { count: unmappedBranch.length, branches } });
        await alertGroupMe(`⚠️ LP CSV ingest REJECTED (${reportType}): ${unmappedBranch.length} row(s) with unmapped branch ${branches.join(', ')}. Add to lp_branch_market_map, then re-send.`);
        return { success: false, failure_reason: 'unmapped_branch', branches, sha256: sha };
      }
      rows = parsed.rows.map((r) => ({
        row_num: r.row_num, lp_lead_id: r.lp_lead_id, entry_date: r.entry_date,
        category: r.category, dsp_descr: r.dsp_descr, last_result: r.last_result,
        src_id: r.src_id, sub_source: r.sub_source, promoter: r.promoter,
        city: r.city, state: r.state, zip: r.zip,
        num_dials: r.num_dials, num_superseded: r.num_superseded,
        appt_date: r.appt_date, job_status: r.job_status,
        gsa_cents: r.gsa_cents, net_cents: r.net_cents,
        brn_id_raw: r.brn_id_raw || null, market: r.market, market_method: r.market_method,
      }));
      controlTotals = leadDispositionControlTotals(parsed.rows);
      const marketTally = {};
      for (const r of rows) marketTally[r.market] = (marketTally[r.market] || 0) + 1;
      extraDetail = { market_tally: marketTally };
    } else if (reportType === 'source_cost') {
      parsed = parseSourceCostCsv(text);
      const v = validateSourceCostCsv(parsed, expectedTotals);
      if (!v.ok) {
        return await fail(v.violations[0].rule, { violations: v.violations, computed: v.totals },
          `${v.violations[0].rule} (+${v.violations.length - 1} more).`);
      }
      rows = parsed.rows;
      controlTotals = v.totals;
    } else {
      throw new Error(`unknown CSV report type ${reportType}`);
    }
  } catch (err) {
    if (err.message.startsWith('CSV missing required columns') || err.message === 'empty CSV') {
      return await fail('csv_shape_unrecognized', { message: err.message }, err.message);
    }
    throw err;
  }

  // 4. Chunked load: begin → rows×N → finalize (the fail-closed gate).
  const snapshotPayload = {
    report_type: reportType,
    period_start: parsed.header.periodStart,
    period_end: parsed.header.periodEnd,
    file_sha256: sha,
    storage_path: storagePath,
    row_count: rows.length,
    as_of_date: parsed.header.asOf ?? parsed.header.periodEnd ?? todayET(),
    source_format: 'csv',
    control_totals: controlTotals,
  };
  if (!snapshotPayload.period_start || !snapshotPayload.period_end) {
    return await fail('missing_period', { header: parsed.header }, 'SDate/EDate missing from the export.');
  }

  const { data: snapshotId, error: beginErr } = await supabase
    .rpc('lp_csv_ingest_begin', { p_snapshot: snapshotPayload });
  if (beginErr) throw new Error(`ingest begin failed: ${beginErr.message}`);

  try {
    await loadChunked(snapshotId, rows);
    const { data: factRows, error: finErr } = await supabase
      .rpc('lp_csv_ingest_finalize', { p_snapshot_id: snapshotId });
    if (finErr) throw new Error(finErr.message);
    await done('success', { snapshot_id: snapshotId, detail: { ...extraDetail, control_totals: controlTotals, fact_rows: factRows } });
    console.log(`[LPCsv] ${reportType} ingested: ${rows.length} rows, snapshot ${snapshotId}, ${factRows} fact rows`);
    return { success: true, snapshot_id: snapshotId, rows: rows.length, fact_rows: factRows, sha256: sha, ...extraDetail };
  } catch (err) {
    // Assertion failures inside finalize are content failures: the snapshot
    // stays non-current and inert. Log + alert, return 200 success:false.
    await done('failed', { failure_reason: 'finalize_assertion', snapshot_id: snapshotId, detail: { message: err.message, ...extraDetail } });
    await alertGroupMe(`⚠️ LP CSV ingest REJECTED (${reportType}): ${err.message}. Snapshot ${snapshotId} left non-current. Archived at ${storagePath}.`);
    return { success: false, failure_reason: 'finalize_assertion', message: err.message, snapshot_id: snapshotId, sha256: sha };
  }
}

function authorized(req) {
  if (!INGEST_SECRET) return true;
  const provided = req.headers['x-ghl-signature'] || req.headers['x-webhook-secret'] || '';
  return provided === INGEST_SECRET;
}

export function registerLpCsvRoutes(app) {
  // CSV text bodies — the Lead Disposition YTD export runs ~20MB.
  const csvText = express.text({ type: ['text/csv', 'text/plain', 'application/octet-stream'], limit: '60mb' });

  for (const [slug, reportType] of Object.entries(CSV_REPORT_TYPES)) {
    app.post(`/n8n/admin/lp-csv-ingest/${slug}`, csvText, async (req, res) => {
      try {
        if (!authorized(req)) return res.status(401).json({ success: false, error: 'bad signature' });
        if (typeof req.body !== 'string' || !req.body.length) {
          return res.status(400).json({ success: false, error: 'POST the CSV text as the request body (Content-Type: text/csv)' });
        }
        const result = await ingestCsv({
          reportType, text: req.body, source: String(req.query.source || 'manual'),
        });
        res.json(result);
      } catch (err) {
        console.error(`[LPCsv] ${slug} ingest error:`, err.message);
        res.status(500).json({ success: false, error: err.message });
      }
    });
  }

  // Future PDF ingest for reports C/D — FAIL CLOSED until a sample PDF
  // exists to build the parser from. The PDF is archived (it IS the sample),
  // the rejection is logged, GroupMe alerts, and nothing is written.
  const rawPdf = express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '25mb' });
  for (const [slug, reportType] of Object.entries(PDF_PENDING_TYPES)) {
    app.post(`/n8n/admin/lp-report-ingest/${slug}`, rawPdf, async (req, res) => {
      try {
        if (!authorized(req)) return res.status(401).json({ success: false, error: 'bad signature' });
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
          return res.status(400).json({ success: false, error: 'POST the raw PDF bytes as the request body (Content-Type: application/pdf)' });
        }
        const sha = sha256Hex(req.body);
        const storagePath = `${reportType}-pdf/${todayET()}/${sha}.pdf`;
        const { error: upErr } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(storagePath, req.body, { contentType: 'application/pdf', upsert: true });
        if (upErr) throw new Error(`storage archive failed: ${upErr.message}`);
        await logIngest({
          report_type: reportType, file_sha256: sha, status: 'failed',
          failure_reason: 'parser_pending',
          detail: { message: 'PDF parser not built yet — archived sample for parser development', storage_path: storagePath },
          source: String(req.query.source || 'n8n'),
        });
        await alertGroupMe(`📥 LP report PDF received for ${reportType} — parser not built yet (parser_pending). Archived at ${storagePath}; this sample unblocks building the parser.`);
        res.json({ success: false, failure_reason: 'parser_pending', sha256: sha, storage_path: storagePath });
      } catch (err) {
        console.error(`[LPCsv] ${slug} pdf stub error:`, err.message);
        res.status(500).json({ success: false, error: err.message });
      }
    });
  }

  console.log('[LPCsv] Routes registered: POST /n8n/admin/lp-csv-ingest/{job-status|lead-disposition|source-cost} | POST /n8n/admin/lp-report-ingest/{lead-disposition|source-cost} (parser_pending)');
}
