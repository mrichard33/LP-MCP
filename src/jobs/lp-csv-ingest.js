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
import {
  sha256Hex, contentSha256, resolveRowMarket, todayET, centsToDollars,
  ingestAuthorized, assertIngestAuthConfigured,
} from './lp-report-common.js';
import { logIngest, quarantineRows, alertGroupMe, duplicateResponse, extractPdfText, extractPdfBboxXml, NoTextLayerError } from './lp-report-ingest.js';
import {
  parseJobStatusCsv, validateJobStatusCsv,
  JOB_STATUS_PARSER_VERSION,
} from './lp-report-parse-job-status.js';
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
import {
  parseApptStatsCsv, validateApptStatsCsv, sitRateBy, APPT_STATS_PARSER_VERSION,
  SALESREP_UNKNOWN,
} from './lp-report-parse-appt-stats.js';

/**
 * Report 133's scoping semantic: every job whose CONTRACT DATE falls in the
 * period, at whatever status it now has — NOT a snapshot of what is still open.
 * One constant so the row column, the snapshot column and the HTTP response
 * cannot drift apart; they did, and the snapshot column silently stayed NULL.
 */
export const COHORT_BASIS_CONTRACT_DATE = 'contract_date';
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
 * Resolve one 133 row's branch code to a market.
 *
 * The Job Status export USED to carry no branch column, so market came from a
 * cst_id → Lead Disposition (135) id join against the current 135 snapshot.
 * The shipped export carries District and Market natively, so that join is gone
 * along with its whole failure surface: 133 no longer needs a current 135
 * snapshot to know its own branch, and the ambiguity/unmatched machinery the
 * join required has no remaining purpose.
 *
 * Market leads, District is the fallback: Market is populated on all 525 rows of
 * the March export, District is blank on 3 and disagrees with Market on 4.
 *
 * Validated against lp_branch_market_map, never a hardcoded list — the map
 * already carries RFED (→ FTLAU_MKT) alongside BOCA/FTLAU/MIAMI, and a
 * nine-market literal would have bucketed RFED as UNRESOLVED on every file.
 *
 * @returns {{market: string, method: string, code: string|null}}
 */
export function resolveJobStatusMarket(row, branchMap) {
  const code = row.market_code_raw || row.district_raw || null;
  const market = code ? resolveRowMarket(code, branchMap) : null;
  if (!market) return { market: UNRESOLVED_MARKET, method: 'unresolved_branch', code };
  return { market, method: 'branch_native', code };
}

/**
 * 138 vs 137 for the same period — RECORDED, NEVER GATED.
 *
 * These two are the pair worth comparing. Both count activity in the window
 * (appointments issued), so they should very nearly tie, and a drift is
 * informative rather than expected. January 2026 measured issued 2,029 vs
 * 2,023, net issued 1,786 vs 1,782, sat 1,566 vs 1,565, sale 488 vs 488 —
 * sales tie exactly and issued is short by 6, most plausibly appointments with
 * no rep assignment, which 137 still places by market and 138 cannot place at
 * all.
 *
 * 136 is deliberately NOT the comparison. It is cohort-based (leads created in
 * the window) against 138's activity basis, so divergence there is expected and
 * a check can never fail informatively. It also cannot be done by source: 136's
 * only source column is `descr`, the SUB-source, against 138's `Src_id`, the
 * source — 61 values against 17, with no clean bridge.
 *
 * Advisory only. A missing 137 snapshot, or any query failure, records null
 * rather than disturbing an otherwise good 138 ingest.
 */
async function crossCheckSalesEfficiency(periodStart, periodEnd, totals) {
  if (!periodStart || !periodEnd) return null;
  try {
    const { data: snaps, error: snapErr } = await supabase
      .from('scorecard_report_snapshots')
      .select('id')
      .eq('report_type', 'sales_efficiency').eq('is_current', true)
      .eq('period_start', periodStart).eq('period_end', periodEnd)
      .order('ingested_at', { ascending: false }).limit(1);
    if (snapErr || !snaps?.length) {
      return { compared: false, reason: snapErr ? 'lookup_failed' : 'no_current_137_snapshot' };
    }
    const { data, error } = await supabase
      .from('lp_sales_efficiency_history')
      .select('num_issued, num_net_issued, num_sat, num_sold')
      .eq('snapshot_id', snaps[0].id);
    if (error || !data?.length) return { compared: false, reason: 'no_137_rows' };
    const se = data.reduce((a, r) => ({
      num_issued: a.num_issued + (r.num_issued ?? 0),
      num_net_issued: a.num_net_issued + (r.num_net_issued ?? 0),
      num_sat: a.num_sat + (r.num_sat ?? 0),
      num_sale: a.num_sale + (r.num_sold ?? 0),
    }), { num_issued: 0, num_net_issued: 0, num_sat: 0, num_sale: 0 });
    const deltas = {};
    for (const k of Object.keys(se)) deltas[k] = (totals[k] ?? 0) - se[k];
    return { compared: true, snapshot_id: snaps[0].id, sales_efficiency: se, appt_stats: {
      num_issued: totals.num_issued, num_net_issued: totals.num_net_issued,
      num_sat: totals.num_sat, num_sale: totals.num_sale }, deltas };
  } catch (err) {
    return { compared: false, reason: 'lookup_failed', message: err.message };
  }
}

/**
 * Pre-begin idempotency probe, shared by all four chunked ingest paths.
 *
 * ══ WHY THERE IS NO `finalized_at IS NOT NULL` FILTER HERE ══
 *
 * There used to be one, so that an aborted chunked ingest could not block its
 * own corrected retry. But the DB constraint on (report_type, file_sha256)
 * carries no such filter, and that mismatch was the bug: when begin succeeded
 * and finalize failed, the orphan row kept the key with finalized_at NULL, this
 * probe skipped past it, lp_csv_ingest_begin raised 23505, and duplicateResponse
 * answered `success: true, duplicate: true` pointing at a snapshot holding
 * nothing. The caller was told the re-send had landed when nothing had — the
 * exact way a remediation re-send of a bad month reads as repaired while the bad
 * snapshot stays live.
 *
 * The probe now matches the constraint, and the unfinalized case is named rather
 * than disguised: HTTP 200 (the file is fine; replaying it would only repeat
 * this) but success:false, so it cannot be mistaken for a landed ingest.
 *
 * Clearing the orphan is not done here, but it is no longer purely manual
 * either: lp_csv_reap_orphan_snapshots marks abandoned ones on the 5-minute
 * heartbeat and releases both keys. See src/jobs/lp-csv-orphan-reaper.js.
 *
 * @returns {Promise<object|null>} a response to return immediately, or null to proceed
 */
async function probeExistingSnapshot(reportType, sha, done) {
  const { data: dup, error: dupErr } = await supabase
    .from('scorecard_report_snapshots')
    .select('id, finalized_at, is_current').eq('report_type', reportType).eq('file_sha256', sha)
    .maybeSingle();
  if (dupErr) throw new Error(`duplicate check failed: ${dupErr.message}`);
  if (!dup) return null;
  return decideOnExistingSnapshot(dup, { matchedOn: 'file_sha256', sha, done });
}

/**
 * The SECOND unique key, and the one that was actually firing.
 *
 * scorecard_report_snapshots carries two unique keys, not one:
 * UNIQUE (report_type, file_sha256) and the partial index
 * scorecard_report_snapshots_content_uq on (report_type, content_sha256).
 * probeExistingSnapshot covers only the first, because content_sha256 is a hash
 * of the PARSED rows and does not exist until parsing is done — long after the
 * pre-begin probe runs.
 *
 * So a re-export of the same month with a byte-level difference (LP stamps a
 * generation time into the file) has a NEW file_sha256 but the SAME
 * content_sha256. The pre-probe saw nothing, and the collision surfaced as a
 * 23505 inside lp_csv_ingest_begin — caught by duplicateResponse, which named it
 * correctly, but only after a snapshot row had been attempted. Every one of the
 * 17 report-133 `orphaned_snapshot` rejections on 2026-08-09/10 matched on
 * content_sha256, not file_sha256.
 *
 * This closes that gap: same decision, same vocabulary, run at the point where
 * the content hash first exists. The 23505 path stays as the backstop.
 */
async function probeExistingContentSnapshot(reportType, contentSha, done) {
  if (!contentSha) return null;
  const { data: dup, error: dupErr } = await supabase
    .from('scorecard_report_snapshots')
    .select('id, finalized_at, is_current').eq('report_type', reportType).eq('content_sha256', contentSha)
    .maybeSingle();
  if (dupErr) throw new Error(`content duplicate check failed: ${dupErr.message}`);
  if (!dup) return null;
  return decideOnExistingSnapshot(dup, { matchedOn: 'content_sha256', sha: contentSha, done });
}

/**
 * The shared orphan-vs-duplicate decision, on whichever key matched.
 *
 * Deliberately ONE function rather than a copy per probe: the rule that an
 * unfinalized match is an orphan and not a benign duplicate is the fix for a
 * real incident (a remediation re-send reading as landed while the bad snapshot
 * stayed current), and two copies of it would drift.
 *
 * The unfinalized branch MUST be reached before anything can log a duplicate.
 */
async function decideOnExistingSnapshot(dup, { matchedOn, sha, done }) {
  if (!dup.finalized_at) {
    await done('failed', {
      snapshot_id: dup.id,
      failure_reason: 'orphaned_snapshot',
      detail: {
        matched_on: matchedOn, is_current: Boolean(dup.is_current),
        message: 'an earlier ingest of these bytes began but never finalized; '
          + 'it holds the unique key, so this re-send cannot land until it is cleared',
      },
    });
    return {
      success: false, rejected: true, reason: 'orphaned_snapshot',
      failure_reason: 'orphaned_snapshot',
      snapshot_id: dup.id, matched_on: matchedOn, sha256: sha,
    };
  }

  await done('duplicate', { snapshot_id: dup.id, detail: { matched_on: matchedOn } });
  return { success: true, duplicate: true, snapshot_id: dup.id, matched_on: matchedOn, sha256: sha };
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

  // 1. Idempotency — same bytes twice is a clean no-op, and an unfinalized
  //    match is an orphan rather than a duplicate. See probeExistingSnapshot.
  const existing = await probeExistingSnapshot(reportType, sha, done);
  if (existing) return existing;

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
  // How the file was scoped, when the file says so. Snapshot-level, distinct
  // from the per-row copy: lp_job_status_history.cohort_basis was populated from
  // the row objects while scorecard_report_snapshots.cohort_basis stayed NULL on
  // every 133 snapshot, because lp_csv_ingest_begin reads a key snapshotPayload
  // never carried. One variable now feeds the row, the snapshot AND the
  // response, so the three cannot disagree again.
  let cohortBasis = null;
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
      // UNRESOLVED, NOT REJECTED — the 137 doctrine (§F), for the same reason:
      // an unknown branch code is a mapping gap, not a corrupt file. The row's
      // money stays visible and attributable to "we don't know which market"
      // rather than being dropped or taking the other 524 rows down with it.
      const { branchMap } = await getMarketMaps();
      const unresolved = [];
      rows = parsed.rows.map((r) => {
        const { market, method, code } = resolveJobStatusMarket(r, branchMap);
        if (method === 'unresolved_branch') unresolved.push(r);
        return {
          row_num: r.row_num,
          lp_id: r.lp_id,
          job_id: r.job_id,
          contract_id: r.contract_id,
          customer_name: r.customer_name,
          phone: r.phone,
          city: r.city,
          contract_date: r.contract_date,
          status_raw: r.status_raw,
          bucket: r.bucket,
          gross_cents: r.gross_cents,
          total_due_cents: r.total_due_cents,
          sub_source: r.sub_source,
          product_ids: r.product_ids,
          finance_sources: r.finance_sources,
          district_raw: r.district_raw,
          market_code_raw: r.market_code_raw,
          branch_code_raw: code,
          market,
          market_method: method,
          notes_raw: r.notes_raw,
          // The semantic, stored in the data rather than implied by a filename:
          // this file is every job whose CONTRACT DATE falls in the period, at
          // whatever status it has now — not a snapshot of what is still open.
          cohort_basis: COHORT_BASIS_CONTRACT_DATE,
        };
      });
      if (unresolved.length) {
        const branches = [...new Set(unresolved.map((r) => r.market_code_raw || r.district_raw))];
        await quarantineRows(reportType, sha, unresolved.map((row) => ({ reason: 'unresolved_branch', row })));
        await alertGroupMe(`⚠️ LP report 133: unknown branch ${branches.join(', ')} — ${unresolved.length} row(s) landed as ${UNRESOLVED_MARKET}, NOT dropped. Add to lp_branch_market_map and re-send to reattribute.`);
        extraDetail.unresolved_branches = branches;
      }
      const bucketTally = {};
      for (const r of rows) bucketTally[r.bucket] = (bucketTally[r.bucket] || 0) + 1;
      // Every bucket is asserted, not just the two open ones. Under a cohort
      // export the terminal buckets carry most of the file, so leaving them
      // unchecked would let the largest counts drift silently.
      controlTotals = {
        gross_cents: rows.reduce((a, r) => a + (r.gross_cents ?? 0), 0),
        hoa_count: bucketTally.hoa ?? 0,
        permit_count: bucketTally.permit ?? 0,
        other_pending_count: bucketTally.other_pending ?? 0,
        in_production_count: bucketTally.in_production ?? 0,
        completed_count: bucketTally.completed ?? 0,
        lost_count: bucketTally.lost ?? 0,
      };
      cohortBasis = COHORT_BASIS_CONTRACT_DATE;
      extraDetail = {
        ...extraDetail,
        bucket_tally: bucketTally,
        cohort_basis: cohortBasis,
        sub_cent_columns: parsed.subCentColumns,
      };
      parserVersion = JOB_STATUS_PARSER_VERSION;
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
    } else if (reportType === 'appt_stats_by_rep_source') {
      parsed = parseApptStatsCsv(text);
      const v = validateApptStatsCsv(parsed, expectedTotals);
      if (!v.ok) {
        return await fail(v.violations[0].rule, { violations: v.violations, computed: v.totals },
          `${v.violations[0].rule} (+${v.violations.length - 1} more).`);
      }
      // NO MARKET RESOLUTION. 138 carries no branch column, so its rows cannot
      // go through lp_branch_market_map and produce no lp_report_facts. That is
      // by design, not an omission — scorecard_rebuild_facts simply matches none
      // of its six source tables and returns 0.
      rows = parsed.rows;
      controlTotals = v.totals;
      parserVersion = APPT_STATS_PARSER_VERSION;
      extraDetail = {
        disposition_labels: parsed.dispositionLabels,
        alias_disagreements: parsed.aliasDisagreements.length,
        warnings: v.warnings,
        rep_count: new Set(rows.map((r) => r.salesrep_raw)).size,
        source_count: new Set(rows.map((r) => r.src_id_raw)).size,
        // Rep-level numbers are only trustworthy from ISSUE onward. LP sets a
        // large share of appointments before a rep is assigned and files them
        // under its own '(SalesRep Unknown)' label — 12 rows and 1,822 sets in
        // January 2026. Counted here so any set-count tile grouped by rep can
        // show the bucket rather than dropping or redistributing it.
        salesrep_unknown: rows.filter((r) => r.salesrep_raw === SALESREP_UNKNOWN)
          .reduce((a, r) => ({
            rows: a.rows + 1, num_set: a.num_set + r.num_set,
            num_issued: a.num_issued + r.num_issued, num_sat: a.num_sat + r.num_sat,
          }), { rows: 0, num_set: 0, num_issued: 0, num_sat: 0 }),
        sit_rate_by_source: sitRateBy(rows, 'src_id_raw'),
        cross_report: await crossCheckSalesEfficiency(
          parsed.header.periodStart, parsed.header.periodEnd, v.totals),
      };
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
    // lp_csv_ingest_begin has always read this key; nothing ever sent it, so
    // scorecard_report_snapshots.cohort_basis was NULL on every 133 snapshot
    // while the response cheerfully reported 'contract_date'. NULL for the
    // types that have no cohort semantic — an unknown is not a false.
    cohort_basis: cohortBasis,
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

  // The content key can only be probed here — it is a hash of the PARSED rows,
  // so it does not exist at the pre-parse probe above. See
  // probeExistingContentSnapshot: this is the key that was actually colliding.
  const existingByContent = await probeExistingContentSnapshot(
    reportType, snapshotPayload.content_sha256, done);
  if (existingByContent) return existingByContent;

  const { data: snapshotId, error: beginErr } = await supabase
    .rpc('lp_csv_ingest_begin', { p_snapshot: snapshotPayload });
  if (beginErr) {
    // 23505 here means the same report already landed — benign (§A), not a 500.
    // Still reachable despite both probes: neither runs in the same transaction
    // as the insert, so a concurrent ingest of the same file can still win the
    // race. The DB stays the arbiter.
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
    // A warned file is NOT a clean one. The CSV path used to write 'success'
    // unconditionally, so the only way to tell a file that broke an arithmetic
    // identity from one that did not was to read detail->'warnings'. That was
    // survivable while warnings were rare; it stopped being survivable when the
    // two 138 identities were downgraded from rejections to warnings, since the
    // warning is now the ONLY signal that a month came in with a delta.
    const warned = Array.isArray(extraDetail.warnings) && extraDetail.warnings.length > 0;
    await done(warned ? 'succeeded_with_warnings' : 'success',
      { snapshot_id: snapshotId, detail: { ...extraDetail, control_totals: controlTotals, fact_rows: factRows } });
    console.log(`[LPCsv] ${reportType} ingested${warned ? ` WITH ${extraDetail.warnings.length} warning(s)` : ''}: ${rows.length} rows, snapshot ${snapshotId}, ${factRows} fact rows`);
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

  const existing = await probeExistingSnapshot(reportType, sha, done);
  if (existing) return existing;

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

  const existing = await probeExistingSnapshot(reportType, sha, done);
  if (existing) return existing;

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

  const existing = await probeExistingSnapshot(reportType, sha, done);
  if (existing) return existing;

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

/** See ingestAuthorized in lp-report-common.js — including why it fails OPEN. */
const authorized = (req) => ingestAuthorized(req, 'lp-csv-ingest');

export function registerLpCsvRoutes(app) {
  assertIngestAuthConfigured('lp-csv-ingest');
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
