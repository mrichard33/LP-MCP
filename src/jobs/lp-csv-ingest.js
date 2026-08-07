// ─── LP CSV export ingest orchestrator — src/jobs/lp-csv-ingest.js ───
//
// POST /n8n/admin/lp-csv-ingest/job-status        (Job Status Report YTD)
// POST /n8n/admin/lp-csv-ingest/lead-disposition  (Lead Disposition Detail)
// POST /n8n/admin/lp-csv-ingest/source-cost       (Marketing Sub-Source Cost 2)
// POST /n8n/admin/lp-report-ingest/lead-disposition  (135 PDF — LIVE parser)
// POST /n8n/admin/lp-report-ingest/source-cost       (136 PDF — LIVE parser)
//
// Mirrors lp-report-ingest.js: sha256 → duplicate check → ARCHIVE FIRST →
// parse → validate → market resolution → chunked RPC load
// (lp_csv_ingest_begin → _rows×N → _finalize) → ingest log. The finalize
// RPC is the fail-closed gate: row-count + control-total assertions run in
// ONE tx with the is_current promotion, so a bad load never becomes
// visible. GroupMe gets failures only.
//
// The CSVs are today a manual backfill (LP's scheduler is PDF-only, confirmed
// 2026-08-05). Reports 135 and 136 both went live 2026-08-06, built and pinned
// against their real emailed files (135: 100 pages / 1,194 rows; 136: 2 pages /
// 37 sub-source rows, Grand Total Raw 1,194 — the same population). All five LP
// reports now parse from the scheduled PDF.
//
// HTTP CONTRACT: deterministic content failures return 200 with
// { success:false, rejected:true, reason }; transport/infra errors stay 5xx.
//
// A DUPLICATE IS NOT A FAILURE. Re-sending a report that already landed returns
// 200 { success:true, duplicate:true, snapshot_id, matched_on } and writes one
// `duplicate` log row. success MUST be true — n8n routes anything else to
// failure telemetry, and paging on a benign no-op trains people to ignore the
// alarm. Nothing is written on that path: no snapshot, no child rows, and the
// existing snapshot's is_current / finalized_at / period_closed_at are
// untouched with no other snapshot demoted.
//
// 5xx IS RESERVED FOR INFRASTRUCTURE — DB unreachable, storage down, unhandled
// panic — because 5xx is the only thing n8n replays. Returning it for a
// content problem is what turned one file into
// `duplicate ×3 → success ×1 → finalize_assertion ×2 → 500`.

import express from 'express';

import supabase from '../supabase.js';
import { getMarketMaps } from './market-resolver.js';
import { sha256Hex, contentSha256, resolveRowMarket, todayET, centsToDollars } from './lp-report-common.js';
import { logIngest, quarantineRows, alertGroupMe, duplicateResponse, extractPdfText, extractPdfBboxXml, NoTextLayerError } from './lp-report-ingest.js';
import { parseJobStatusCsv, validateJobStatusCsv } from './lp-report-parse-job-status.js';
import {
  parseLeadDispositionCsv, validateLeadDispositionCsv, resolveLeadMarkets,
  leadDispositionControlTotals,
} from './lp-report-parse-lead-disposition.js';
import { parseSourceCostCsv, validateSourceCostCsv, computeSourceCostTotals } from './lp-report-parse-source-cost.js';
import {
  parseMilestoneCsv, validateMilestoneCsv, computeMilestoneTotals,
  PARSER_VERSION as MILESTONE_CSV_PARSER_VERSION,
} from './lp-report-parse-milestone-csv.js';
import {
  parseCsv, detectReportFromHeader, CONTENT_SORT_KEYS,
} from './lp-report-csv-common.js';
import {
  parseLeadDispositionPdf, validateLeadDispositionPdf,
} from './lp-report-parse-lead-disposition-pdf.js';
import {
  parseSourceCostPdf, validateSourceCostPdf, computeSourceCostPdfTotals,
} from './lp-report-parse-source-cost-pdf.js';
import {
  parseSalesEfficiencyCsv, parseSalesEfficiencyPdf, resolveSalesEfficiencyMarkets,
  computeSalesEfficiencyTotals, validateSalesEfficiency,
} from './lp-report-parse-sales-efficiency.js';

const INGEST_SECRET = (process.env.LP_REPORT_INGEST_SECRET || '').trim();
const STORAGE_BUCKET = 'lp-reports';
const ROW_CHUNK = 1500;

/**
 * Bucket for a 137 Grouper that lp_branch_market_map does not know (§F).
 * An explicit label, never a drop: the revenue stays counted and visibly
 * unattributed, which is recoverable. A dropped row is not.
 */
export const UNRESOLVED_MARKET = 'UNRESOLVED';

/**
 * Slug → report type for the CSV routes.
 *
 * The slug is now only a HINT. Since the CSV cutover the header fingerprint
 * decides which report a file is (§C), so any of these slugs accepts any LP CSV
 * and routes it correctly — which is what lets one n8n workflow post every
 * attachment without knowing what it holds. `jobs-by-milestone` joins the list
 * because 134 had no CSV route at all; it is the fifth report in an existing
 * route family, not a new endpoint shape, and emphatically not a batch route.
 */
export const CSV_REPORT_TYPES = {
  'job-status': 'job_status_ytd',
  'lead-disposition': 'lead_disposition',
  'source-cost': 'source_cost',
  'sales-efficiency': 'sales_efficiency',
  'jobs-by-milestone': 'jobs_by_milestone',
};

/**
 * Slugs whose PDF variant has no parser yet — fail closed until a sample
 * arrives. EMPTY as of 2026-08-06: 135 and 136 both graduated to live parsers,
 * so all five LP reports now parse. The loop below is kept because the next new
 * report will need exactly this behaviour on its first arrival.
 */
export const PDF_PENDING_TYPES = {};

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
export async function ingestCsv({ reportType, text, source = 'manual', expectedTotals = null, expectedPeriod = null }) {
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

  // 1. Idempotency — same bytes twice is a clean no-op. Only FINALIZED
  //    snapshots count: an aborted chunked ingest (begin succeeded, finalize
  //    rejected) must not block the corrected retry.
  const { data: dup, error: dupErr } = await supabase
    .from('scorecard_report_snapshots')
    .select('id').eq('report_type', reportType).eq('file_sha256', sha)
    .not('finalized_at', 'is', null)
    .maybeSingle();
  if (dupErr) throw new Error(`duplicate check failed: ${dupErr.message}`);
  if (dup) {
    await done('duplicate', { snapshot_id: dup.id, detail: { matched_on: 'file_sha256' } });
    return { success: true, duplicate: true, snapshot_id: dup.id, matched_on: 'file_sha256', sha256: sha };
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
    // `rejected` is the §B contract: a content-level "no" is a 200 with a
    // machine-readable reason, never a 5xx. Only a 5xx makes n8n replay, and
    // replaying a deterministically-bad file just repeats the rejection.
    return { success: false, rejected: true, reason, failure_reason: reason, sha256: sha };
  };

  // 3. Parse + validate + market resolution, per type.
  let parsed, rows, controlTotals, parserVersion = null, extraDetail = {};
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
        return { success: false, rejected: true, reason: 'unmapped_branch', failure_reason: 'unmapped_branch', branches, sha256: sha };
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
    } else if (reportType === 'sales_efficiency') {
      parsed = parseSalesEfficiencyCsv(text);
      const v = validateSalesEfficiency(parsed, { expectedTotals, todayIso: todayET() });
      if (!v.ok) {
        return await fail(v.violations[0].rule, { violations: v.violations },
          `${v.violations[0].rule} (+${v.violations.length - 1} more).`);
      }
      const maps = await getMarketMaps();
      const unmapped = resolveSalesEfficiencyMarkets(parsed.rows, maps);
      if (unmapped.length) {
        // UNRESOLVED, NOT REJECTED (§F). 137 is nine or ten company-wide rows;
        // dropping one loses a whole market's revenue from every downstream
        // total, and rejecting the file loses all ten. An unknown Grouper is
        // named, counted, quarantined for follow-up and alerted — the money
        // stays visible and attributable to "we don't know which market".
        //
        // Validated against lp_branch_market_map, never a hardcoded list: the
        // map already carries RFED (→ FTLAU_MKT), which a nine-market literal
        // would have bucketed as UNRESOLVED on every single file.
        const branches = [...new Set(unmapped.map((r) => r.branch_code_raw))];
        for (const r of unmapped) r.market = UNRESOLVED_MARKET;
        await quarantineRows(reportType, sha, unmapped.map((row) => ({ reason: 'unresolved_branch', row })));
        await alertGroupMe(`⚠️ LP report 137: unknown Grouper ${branches.join(', ')} — ${unmapped.length} row(s) landed as ${UNRESOLVED_MARKET}, NOT dropped. Add to lp_branch_market_map and re-send to reattribute.`);
        extraDetail.unresolved_branches = branches;
      }
      rows = parsed.rows;
      controlTotals = expectedTotals ?? computeSalesEfficiencyTotals(parsed.rows, parsed.mode);
      extraDetail = { ...extraDetail, mode: parsed.mode, reconciliations: v.reconciliations };
    } else if (reportType === 'jobs_by_milestone') {
      parsed = parseMilestoneCsv(text);
      const v = validateMilestoneCsv(parsed);
      if (!v.ok) {
        return await fail(v.violations[0].rule, { violations: v.violations },
          `${v.violations[0].rule} (+${v.violations.length - 1} more).`);
      }
      // Branch → market stays FAIL-CLOSED here, unlike 137. This report is
      // per-job revenue feeding Net Released; an unattributed job silently
      // changes a market's released dollars, and there are hundreds of rows to
      // hide in rather than 137's nine.
      const maps = await getMarketMaps();
      const unmappedRows = [];
      for (const r of parsed.rows) {
        r.market = resolveRowMarket(r.branch_code_raw, maps.branchMap);
        if (!r.market) unmappedRows.push(r);
      }
      if (unmappedRows.length) {
        await quarantineRows(reportType, sha, unmappedRows.map((row) => ({ reason: 'unmapped_branch', row })));
        const branches = [...new Set(unmappedRows.map((r) => r.branch_code_raw))];
        await done('failed', { failure_reason: 'unmapped_branch', detail: { count: unmappedRows.length, branches } });
        await alertGroupMe(`⚠️ LP CSV ingest REJECTED (${reportType}): unmapped branch ${branches.join(', ')}. Add to lp_branch_market_map, then re-send.`);
        return { success: false, rejected: true, reason: 'unmapped_branch', failure_reason: 'unmapped_branch', branches, sha256: sha };
      }
      rows = parsed.rows.map((r) => ({
        job_number: r.job_number, customer_name: r.customer_name, address: r.address,
        city: r.city, contract_date: r.contract_date, rtp_date: r.rtp_date,
        branch_code_raw: r.branch_code_raw, market: r.market, product: r.product,
        gross_cents: r.gross_cents, net_cents: r.net_cents,
        paid_cents: r.paid_cents, balance_cents: r.balance_cents, sales_rep: r.sales_rep,
      }));
      controlTotals = computeMilestoneTotals(parsed.rows);
      extraDetail = { reconciliations: v.reconciliations, unmapped_columns: parsed.unmappedColumns };
      parserVersion = MILESTONE_CSV_PARSER_VERSION;
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
  //
  // content_sha256 is the authoritative dedup key for CSV (§E). It hashes the
  // parsed rows and the window, excluding the volatile echo columns, with rows
  // sorted on a stable business key so LP's sort-order parameters cannot fork
  // identity. includeAsOf is false because a re-pull of the same period IS the
  // same report even though its CurrentDateTime moved — the very case
  // file_sha256 cannot see, since those bytes differ every time.
  const contentSha = contentSha256({
    reportType,
    periodStart: parsed.header.periodStart,
    periodEnd: parsed.header.periodEnd,
    scope: null,
    rows,
    parserVersion,
    includeAsOf: false,
    sortKeys: CONTENT_SORT_KEYS[reportType] ?? null,
  });

  const snapshotPayload = {
    report_type: reportType,
    period_start: parsed.header.periodStart,
    period_end: parsed.header.periodEnd,
    // Full timestamp, not a date: this is the coverage-as-of value that decides
    // is_partial_month, and truncating it to midnight is what made every 134
    // snapshot claim it was generated at 00:00.
    report_generated_at: parsed.header.generatedAt ?? null,
    file_sha256: sha,
    content_sha256: contentSha,
    parser_version: parserVersion,
    storage_path: storagePath,
    row_count: rows.length,
    as_of_date: parsed.header.asOf ?? parsed.header.periodEnd ?? todayET(),
    source_format: 'csv',
    control_totals: controlTotals,
  };
  if (!snapshotPayload.period_start || !snapshotPayload.period_end) {
    return await fail('missing_period', { header: parsed.header }, 'SDate/EDate missing from the export.');
  }

  // The period comes from the FILE (§D). A caller that disagrees is working
  // from a different file than the one it sent, and guessing which is right is
  // how a month's revenue lands under the wrong month.
  if (expectedPeriod
      && (expectedPeriod.start !== snapshotPayload.period_start
       || expectedPeriod.end !== snapshotPayload.period_end)) {
    return await fail('period_mismatch', {
      caller: expectedPeriod,
      file: { start: snapshotPayload.period_start, end: snapshotPayload.period_end },
    }, `caller declared ${expectedPeriod.start}..${expectedPeriod.end}, file says ${snapshotPayload.period_start}..${snapshotPayload.period_end}.`);
  }

  const { data: snapshotId, error: beginErr } = await supabase
    .rpc('lp_csv_ingest_begin', { p_snapshot: snapshotPayload });
  if (beginErr) {
    // 23505 here means the same report already landed — benign (§A), not a 500.
    const dupRes = await duplicateResponse(beginErr, {
      reportType, fileSha: sha, contentSha: snapshotPayload.content_sha256, done,
    });
    if (dupRes) return dupRes;
    throw new Error(`ingest begin failed: ${beginErr.message}`);
  }

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
    return { success: false, rejected: true, reason: 'finalize_assertion', failure_reason: 'finalize_assertion', message: err.message, snapshot_id: snapshotId, sha256: sha };
  }
}

/**
 * Sales Efficiency (137) PDF ingest — the REAL parser path (unlike the
 * lead-disposition / source-cost stubs). Same pipeline shape: sha256 →
 * duplicate check → archive FIRST → text layer → parse (column bands) →
 * validate (Total-row checksum, MTD counts_only guard) → market resolution →
 * chunked load → finalize (fail-closed). PDF dollars are whole — control
 * totals are the parser's own sums (chunk-integrity guard); cents-exact
 * assertions belong to the CSV path.
 */
/**
 * Report 135 "Lead Disposition Detail" PDF ingest.
 *
 * sha256 → duplicate → ARCHIVE FIRST → -bbox-layout extract → coordinate-
 * cluster parse → two-level COUNT gate → chunked load → finalize.
 *
 * The count gate is the ONLY fail-closed check: per-band `Totals:` and the
 * `Grand Totals:` line must both tie to the parsed rows. An unmapped
 * disposition or last-result value writes a reconciliation warning and the
 * snapshot still lands — the opposite of report 133, which has been failing
 * 25× a day on `unmapped_status`.
 *
 * Nothing is deduped: LP counts ROWS, prosp # repeats, and row identity is
 * (snapshot_id, row_ordinal).
 */
export async function ingestLeadDispositionPdf({ buffer, source = 'n8n' }) {
  const started = Date.now();
  const reportType = 'lead_disposition';
  if (!supabase) throw new Error('Supabase not configured');
  const sha = sha256Hex(buffer);
  const done = (status, extra = {}) =>
    logIngest({
      report_type: reportType, file_sha256: sha, status,
      failure_reason: extra.failure_reason ?? null, detail: extra.detail ?? null,
      snapshot_id: extra.snapshot_id ?? null, source, duration_ms: Date.now() - started,
    });

  const { data: dup, error: dupErr } = await supabase
    .from('scorecard_report_snapshots')
    .select('id').eq('report_type', reportType).eq('file_sha256', sha)
    .not('finalized_at', 'is', null)
    .maybeSingle();
  if (dupErr) throw new Error(`duplicate check failed: ${dupErr.message}`);
  if (dup) {
    await done('duplicate', { snapshot_id: dup.id, detail: { matched_on: 'file_sha256' } });
    return { success: true, duplicate: true, snapshot_id: dup.id, matched_on: 'file_sha256', sha256: sha };
  }

  const storagePath = `${reportType}/${todayET()}/${sha}.pdf`;
  const { error: upErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });
  if (upErr) throw new Error(`storage archive failed: ${upErr.message}`);

  let xml;
  try {
    xml = await extractPdfBboxXml(buffer);
  } catch (err) {
    if (err instanceof NoTextLayerError) {
      await done('no_text_layer', { failure_reason: 'no_text_layer', detail: { message: err.message, storage_path: storagePath } });
      await alertGroupMe(`⚠️ LP report 135 ingest STOPPED: PDF has no text layer (scanned image?). Archived at ${storagePath}. OCR is not permitted.`);
      return { success: false, rejected: true, reason: 'no_text_layer', failure_reason: 'no_text_layer', sha256: sha };
    }
    throw err;
  }

  const parsed = parseLeadDispositionPdf(xml);
  const v = validateLeadDispositionPdf(parsed);
  if (!v.ok) {
    const reason = v.violations[0].rule;
    await done('failed', { failure_reason: reason, detail: { violations: v.violations } });
    await alertGroupMe(`⚠️ LP report 135 ingest REJECTED: ${reason}${v.violations.length > 1 ? ` (+${v.violations.length - 1} more)` : ''}. Nothing written. Archived at ${storagePath}.`);
    return { success: false, rejected: true, reason: reason, failure_reason: reason, violations: v.violations, sha256: sha };
  }

  const snapshotPayload = {
    report_type: reportType,
    period_start: parsed.header.periodStart,
    period_end: parsed.header.periodEnd,
    file_sha256: sha,
    storage_path: storagePath,
    row_count: parsed.rows.length,
    as_of_date: parsed.header.asOf ?? todayET(),
    source_format: 'pdf',
    scope: parsed.header.scope,
    control_totals: {
      grand_total: parsed.grandTotalPrinted,
      bands: parsed.bands.map((b) => ({ band: b.label, count: b.parsed })),
    },
  };
  const { data: snapshotId, error: beginErr } = await supabase
    .rpc('lp_csv_ingest_begin', { p_snapshot: snapshotPayload });
  if (beginErr) {
    // 23505 here means the same report already landed — benign (§A), not a 500.
    const dupRes = await duplicateResponse(beginErr, {
      reportType, fileSha: sha, contentSha: snapshotPayload.content_sha256, done,
    });
    if (dupRes) return dupRes;
    throw new Error(`ingest begin failed: ${beginErr.message}`);
  }

  try {
    // Dedicated loader — lp_csv_ingest_rows dispatches `lead_disposition` to the
    // CSV table, which is a different grain with different columns.
    for (let i = 0; i < parsed.rows.length; i += ROW_CHUNK) {
      const chunk = parsed.rows.slice(i, i + ROW_CHUNK);
      const { error } = await supabase.rpc('lp_lead_disposition_pdf_rows', {
        p_snapshot_id: snapshotId, p_rows: chunk,
      });
      if (error) throw new Error(`row load failed at chunk ${i / ROW_CHUNK}: ${error.message}`);
    }
  } catch (err) {
    // Content failure, not infrastructure: the log row is written and the
    // snapshot stays non-current and inert. Re-throwing made this a 500 too,
    // which is the only thing n8n replays — one bad file became a retry storm.
    await done('failed', { failure_reason: 'row_load_failed', detail: { message: err.message }, snapshot_id: snapshotId });
    await alertGroupMe(`⚠️ LP CSV ingest REJECTED (${reportType}): row load failed — ${err.message}. Snapshot ${snapshotId} left non-current.`);
    return { success: false, rejected: true, reason: 'row_load_failed', failure_reason: 'row_load_failed', message: err.message, snapshot_id: snapshotId, sha256: sha };
  }

  const { error: finErr } = await supabase.rpc('lp_lead_disposition_pdf_finalize', {
    p_snapshot_id: snapshotId,
  });
  if (finErr) {
    await done('failed', { failure_reason: 'finalize_failed', detail: { message: finErr.message }, snapshot_id: snapshotId });
    await alertGroupMe(`⚠️ LP report 135 ingest FAILED at finalize: ${finErr.message}. Nothing promoted.`);
    return { success: false, rejected: true, reason: 'finalize_failed', failure_reason: 'finalize_failed', sha256: sha };
  }

  // Warnings are reconciliations, never rejections.
  if (parsed.warnings.length) {
    await done('succeeded_with_warnings', {
      snapshot_id: snapshotId,
      detail: { warnings: parsed.warnings.slice(0, 50), warning_count: parsed.warnings.length },
    });
  } else {
    await done('succeeded', { snapshot_id: snapshotId });
  }
  return {
    success: true, snapshot_id: snapshotId, sha256: sha,
    rows: parsed.rows.length, bands: parsed.bands, scope: parsed.header.scope,
    warnings: parsed.warnings.length,
  };
}

/**
 * Report 136 "Marketing Sub-Source Cost Analysis 2" PDF ingest.
 *
 * Reuses lp_source_cost_history — the PDF's columns are a strict SUBSET of the
 * CSV's, so a parallel table would be duplication. `num_cnf` and `num_net_sold`
 * are written NULL, not 0: the PDF has no such columns, and a zero would read
 * as "nothing confirmed / nothing netted" on the company control-total
 * authority.
 *
 * Promotion goes through lp_source_cost_pdf_finalize, which asserts the NINE
 * columns the PDF prints. The CSV path keeps lp_csv_ingest_finalize and its
 * eleven cents-exact assertions — this must not weaken that.
 */
export async function ingestSourceCostPdf({ buffer, source = 'n8n' }) {
  const started = Date.now();
  const reportType = 'source_cost';
  if (!supabase) throw new Error('Supabase not configured');
  const sha = sha256Hex(buffer);
  const done = (status, extra = {}) =>
    logIngest({
      report_type: reportType, file_sha256: sha, status,
      failure_reason: extra.failure_reason ?? null, detail: extra.detail ?? null,
      snapshot_id: extra.snapshot_id ?? null, source, duration_ms: Date.now() - started,
    });

  const { data: dup, error: dupErr } = await supabase
    .from('scorecard_report_snapshots')
    .select('id').eq('report_type', reportType).eq('file_sha256', sha)
    .not('finalized_at', 'is', null)
    .maybeSingle();
  if (dupErr) throw new Error(`duplicate check failed: ${dupErr.message}`);
  if (dup) {
    await done('duplicate', { snapshot_id: dup.id, detail: { matched_on: 'file_sha256' } });
    return { success: true, duplicate: true, snapshot_id: dup.id, matched_on: 'file_sha256', sha256: sha };
  }

  const storagePath = `${reportType}/${todayET()}/${sha}.pdf`;
  const { error: upErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });
  if (upErr) throw new Error(`storage archive failed: ${upErr.message}`);

  let text;
  try {
    text = await extractPdfText(buffer);
  } catch (err) {
    if (err instanceof NoTextLayerError) {
      await done('no_text_layer', { failure_reason: 'no_text_layer', detail: { message: err.message, storage_path: storagePath } });
      await alertGroupMe(`⚠️ LP report 136 ingest STOPPED: PDF has no text layer (scanned image?). Archived at ${storagePath}. OCR is not permitted.`);
      return { success: false, rejected: true, reason: 'no_text_layer', failure_reason: 'no_text_layer', sha256: sha };
    }
    throw err;
  }

  const parsed = parseSourceCostPdf(text);
  const v = validateSourceCostPdf(parsed);
  if (!v.ok) {
    const reason = v.violations[0].rule;
    await done('failed', { failure_reason: reason, detail: { violations: v.violations } });
    await alertGroupMe(`⚠️ LP report 136 ingest REJECTED: ${reason}${v.violations.length > 1 ? ` (+${v.violations.length - 1} more)` : ''}. Nothing written. Archived at ${storagePath}.`);
    return { success: false, rejected: true, reason: reason, failure_reason: reason, violations: v.violations, sha256: sha };
  }

  // PDF field names → the CSV table's columns. Demo is the CSV's `sat`.
  const rows = parsed.rows.map((r) => ({
    row_num: r.row_num,
    sub_source: r.sub_source,
    num_raw: r.raw, num_set: r.set, num_issued: r.issued, num_sat: r.demo, num_sold: r.sold,
    num_cnf: null, num_net_sold: null,   // absent from this report — NOT zero
    gsa_cents: r.gross_cents, nsa_cents: r.net_sales_cents,
    mcost_cents: r.total_cost_cents, working_cents: r.working_cents,
  }));
  const t = computeSourceCostPdfTotals(parsed.rows);
  const snapshotPayload = {
    report_type: reportType,
    period_start: parsed.header.periodStart,
    period_end: parsed.header.periodEnd,
    file_sha256: sha,
    storage_path: storagePath,
    row_count: rows.length,
    as_of_date: parsed.header.asOf ?? todayET(),
    source_format: 'pdf',
    scope: parsed.header.scope,
    control_totals: {
      num_raw: t.raw, num_set: t.set, num_issued: t.issued, num_sat: t.demo, num_sold: t.sold,
      gsa_cents: t.gross_cents, nsa_cents: t.net_sales_cents,
      mcost_cents: t.total_cost_cents, working_cents: t.working_cents,
    },
  };
  const { data: snapshotId, error: beginErr } = await supabase
    .rpc('lp_csv_ingest_begin', { p_snapshot: snapshotPayload });
  if (beginErr) {
    // 23505 here means the same report already landed — benign (§A), not a 500.
    const dupRes = await duplicateResponse(beginErr, {
      reportType, fileSha: sha, contentSha: snapshotPayload.content_sha256, done,
    });
    if (dupRes) return dupRes;
    throw new Error(`ingest begin failed: ${beginErr.message}`);
  }

  try {
    await loadChunked(snapshotId, rows);
  } catch (err) {
    // Content failure, not infrastructure: the log row is written and the
    // snapshot stays non-current and inert. Re-throwing made this a 500 too,
    // which is the only thing n8n replays — one bad file became a retry storm.
    await done('failed', { failure_reason: 'row_load_failed', detail: { message: err.message }, snapshot_id: snapshotId });
    await alertGroupMe(`⚠️ LP CSV ingest REJECTED (${reportType}): row load failed — ${err.message}. Snapshot ${snapshotId} left non-current.`);
    return { success: false, rejected: true, reason: 'row_load_failed', failure_reason: 'row_load_failed', message: err.message, snapshot_id: snapshotId, sha256: sha };
  }

  const { error: finErr } = await supabase.rpc('lp_source_cost_pdf_finalize', { p_snapshot_id: snapshotId });
  if (finErr) {
    await done('failed', { failure_reason: 'finalize_failed', detail: { message: finErr.message }, snapshot_id: snapshotId });
    await alertGroupMe(`⚠️ LP report 136 ingest FAILED at finalize: ${finErr.message}. Nothing promoted.`);
    return { success: false, rejected: true, reason: 'finalize_failed', failure_reason: 'finalize_failed', sha256: sha };
  }

  await done(v.reconciliations.length ? 'succeeded_with_warnings' : 'succeeded', {
    snapshot_id: snapshotId,
    detail: v.reconciliations.length ? { reconciliations: v.reconciliations.slice(0, 50) } : null,
  });
  return {
    success: true, snapshot_id: snapshotId, sha256: sha,
    rows: rows.length, scope: parsed.header.scope, grand_total_raw: parsed.printedTotals.raw,
  };
}

export async function ingestSalesEfficiencyPdf({ buffer, source = 'n8n' }) {
  const started = Date.now();
  const reportType = 'sales_efficiency';
  if (!supabase) throw new Error('Supabase not configured');
  const sha = sha256Hex(buffer);
  const done = (status, extra = {}) =>
    logIngest({
      report_type: reportType, file_sha256: sha, status,
      failure_reason: extra.failure_reason ?? null, detail: extra.detail ?? null,
      snapshot_id: extra.snapshot_id ?? null, source, duration_ms: Date.now() - started,
    });

  const { data: dup, error: dupErr } = await supabase
    .from('scorecard_report_snapshots')
    .select('id').eq('report_type', reportType).eq('file_sha256', sha)
    .not('finalized_at', 'is', null)
    .maybeSingle();
  if (dupErr) throw new Error(`duplicate check failed: ${dupErr.message}`);
  if (dup) {
    await done('duplicate', { snapshot_id: dup.id, detail: { matched_on: 'file_sha256' } });
    return { success: true, duplicate: true, snapshot_id: dup.id, matched_on: 'file_sha256', sha256: sha };
  }

  const storagePath = `${reportType}/${todayET()}/${sha}.pdf`;
  const { error: upErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: true });
  if (upErr) throw new Error(`storage archive failed: ${upErr.message}`);

  let text;
  try {
    text = await extractPdfText(buffer);
  } catch (err) {
    if (err instanceof NoTextLayerError) {
      await done('no_text_layer', { failure_reason: 'no_text_layer', detail: { message: err.message, storage_path: storagePath } });
      await alertGroupMe(`⚠️ LP report 137 ingest STOPPED: PDF has no text layer (scanned image?). Archived at ${storagePath}. OCR is not permitted.`);
      return { success: false, rejected: true, reason: 'no_text_layer', failure_reason: 'no_text_layer', sha256: sha };
    }
    throw err;
  }

  const parsed = parseSalesEfficiencyPdf(text);
  const v = validateSalesEfficiency(parsed, { todayIso: todayET() });
  if (!v.ok) {
    const reason = v.violations[0].rule;
    await done('failed', { failure_reason: reason, detail: { violations: v.violations } });
    await alertGroupMe(`⚠️ LP report 137 ingest REJECTED: ${reason} (+${v.violations.length - 1} more). Nothing written. Archived at ${storagePath}.`);
    return { success: false, rejected: true, reason: reason, failure_reason: reason, violations: v.violations, sha256: sha };
  }

  const maps = await getMarketMaps();
  const unmapped = resolveSalesEfficiencyMarkets(parsed.rows, maps);
  if (unmapped.length) {
    await quarantineRows(reportType, sha, unmapped.map((row) => ({ reason: 'unmapped_branch', row })));
    const branches = [...new Set(unmapped.map((r) => r.branch_code_raw))];
    await done('failed', { failure_reason: 'unmapped_branch', detail: { count: unmapped.length, branches } });
    await alertGroupMe(`⚠️ LP report 137 ingest REJECTED: unmapped branch ${branches.join(', ')}. Add to lp_branch_market_map, then re-send.`);
    return { success: false, rejected: true, reason: 'unmapped_branch', failure_reason: 'unmapped_branch', branches, sha256: sha };
  }

  if (!parsed.header.periodStart || !parsed.header.periodEnd) {
    await done('failed', { failure_reason: 'missing_period', detail: { header: parsed.header } });
    await alertGroupMe(`⚠️ LP report 137 ingest REJECTED: appointment-date window missing from the header. Archived at ${storagePath}.`);
    return { success: false, rejected: true, reason: 'missing_period', failure_reason: 'missing_period', sha256: sha };
  }

  const controlTotals = computeSalesEfficiencyTotals(parsed.rows, parsed.mode);
  const snapshotPayload = {
    report_type: reportType,
    period_start: parsed.header.periodStart,
    period_end: parsed.header.periodEnd,
    file_sha256: sha,
    storage_path: storagePath,
    row_count: parsed.rows.length,
    as_of_date: todayET(),
    source_format: 'pdf',
    control_totals: controlTotals,
  };
  const { data: snapshotId, error: beginErr } = await supabase
    .rpc('lp_csv_ingest_begin', { p_snapshot: snapshotPayload });
  if (beginErr) {
    // 23505 here means the same report already landed — benign (§A), not a 500.
    const dupRes = await duplicateResponse(beginErr, {
      reportType, fileSha: sha, contentSha: snapshotPayload.content_sha256, done,
    });
    if (dupRes) return dupRes;
    throw new Error(`ingest begin failed: ${beginErr.message}`);
  }

  try {
    await loadChunked(snapshotId, parsed.rows.map((r) => ({
      row_num: r.row_num, branch_code_raw: r.branch_code_raw, market: r.market,
      num_issued: r.num_issued ?? null, num_net_issued: r.num_net_issued ?? null,
      num_sat: r.num_sat ?? null, num_sold: r.num_sold ?? null, gsa_cents: r.gsa_cents ?? null,
      num_net: parsed.mode === 'full' ? (r.num_net ?? null) : null,
      nsa_cents: parsed.mode === 'full' ? (r.nsa_cents ?? null) : null,
      num_working: r.num_working ?? null, working_cents: r.working_cents ?? null,
      num_cd: r.num_cd ?? null, cd_cents: r.cd_cents ?? null,
      num_cancelled: r.num_cancelled ?? null, cancelled_cents: r.cancelled_cents ?? null,
      num_hold: r.num_hold ?? null, hold_cents: r.hold_cents ?? null,
    })));
    const { data: factRows, error: finErr } = await supabase
      .rpc('lp_csv_ingest_finalize', { p_snapshot_id: snapshotId });
    if (finErr) throw new Error(finErr.message);
    await done('success', {
      snapshot_id: snapshotId,
      detail: { mode: parsed.mode, control_totals: controlTotals, fact_rows: factRows, reconciliations: v.reconciliations },
    });
    console.log(`[LPCsv] sales_efficiency PDF ingested: ${parsed.rows.length} rows, mode ${parsed.mode}, gross ${centsToDollars(controlTotals.gsa_cents ?? 0)}, snapshot ${snapshotId}`);
    return { success: true, snapshot_id: snapshotId, rows: parsed.rows.length, mode: parsed.mode, fact_rows: factRows, sha256: sha, reconciliations: v.reconciliations };
  } catch (err) {
    await done('failed', { failure_reason: 'finalize_assertion', snapshot_id: snapshotId, detail: { message: err.message } });
    await alertGroupMe(`⚠️ LP report 137 ingest REJECTED: ${err.message}. Snapshot ${snapshotId} left non-current. Archived at ${storagePath}.`);
    return { success: false, rejected: true, reason: 'finalize_assertion', failure_reason: 'finalize_assertion', message: err.message, snapshot_id: snapshotId, sha256: sha };
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
        // THE HEADER DECIDES, NOT THE SLUG (§C). CSV attachments are all named
        // `_<YYMMDDHHMMSS>_Export.csv`, so the report ID that PDF filenames
        // carried is gone and n8n can no longer route by name. The slug is now
        // only a hint; the file's own header row is authoritative.
        let resolved;
        try {
          resolved = detectReportFromHeader(parseCsv(req.body)[0] ?? []);
        } catch (err) {
          console.warn(`[LPCsv] ${slug}: ${err.failureReason ?? err.message}`, err.detail ?? '');
          return res.json({
            success: false, rejected: true, reason: err.failureReason ?? 'unknown_report_fingerprint',
            failure_reason: err.failureReason ?? 'unknown_report_fingerprint', detail: err.detail ?? null,
          });
        }
        if (resolved.reportType !== reportType) {
          console.warn(`[LPCsv] ${slug}: header says ${resolved.reportType}, routing there instead`);
        }
        const result = await ingestCsv({
          reportType: resolved.reportType, text: req.body, source: String(req.query.source || 'manual'),
        });
        res.json({ ...result, report_type: resolved.reportType, lp_report_id: resolved.lpReportId });
      } catch (err) {
        console.error(`[LPCsv] ${slug} ingest error:`, err.message);
        res.status(500).json({ success: false, error: err.message });
      }
    });
  }

  const rawPdf = express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '25mb' });

  // Sales Efficiency (137) — REAL PDF pipeline (parser built from the
  // 2026-08-05 sample; column-band layout, Total-row checksum, MTD guard).
  app.post('/n8n/admin/lp-report-ingest/sales-efficiency', rawPdf, async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ success: false, error: 'bad signature' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ success: false, error: 'POST the raw PDF bytes as the request body (Content-Type: application/pdf)' });
      }
      const result = await ingestSalesEfficiencyPdf({ buffer: req.body, source: String(req.query.source || 'n8n') });
      res.json(result);
    } catch (err) {
      console.error('[LPCsv] sales-efficiency ingest error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Report 135 — live parser (coordinate clustering over -bbox-layout).
  app.post('/n8n/admin/lp-report-ingest/lead-disposition', rawPdf, async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ success: false, error: 'bad signature' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ success: false, error: 'POST the raw PDF bytes as the request body (Content-Type: application/pdf)' });
      }
      const result = await ingestLeadDispositionPdf({ buffer: req.body, source: String(req.query.source || 'n8n') });
      res.json(result);
    } catch (err) {
      console.error('[LPCsv] lead-disposition ingest error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Report 136 — live parser (strict fifteen-cell rows, Grand Total gate).
  app.post('/n8n/admin/lp-report-ingest/source-cost', rawPdf, async (req, res) => {
    try {
      if (!authorized(req)) return res.status(401).json({ success: false, error: 'bad signature' });
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ success: false, error: 'POST the raw PDF bytes as the request body (Content-Type: application/pdf)' });
      }
      const result = await ingestSourceCostPdf({ buffer: req.body, source: String(req.query.source || 'n8n') });
      res.json(result);
    } catch (err) {
      console.error('[LPCsv] source-cost ingest error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // First-arrival fail-closed path for any FUTURE report without a parser.
  // The PDF is archived (it IS the sample), the rejection is logged, GroupMe
  // alerts, and nothing is written.
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

  console.log('[LPCsv] Routes registered: POST /n8n/admin/lp-csv-ingest/{job-status|lead-disposition|source-cost|sales-efficiency} | POST /n8n/admin/lp-report-ingest/{sales-efficiency|lead-disposition|source-cost} (137/135/136, live parsers)');
}
