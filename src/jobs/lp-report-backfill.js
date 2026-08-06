// ─── LP report historical backfill — src/jobs/lp-report-backfill.js ───
//
// POST /n8n/admin/lp-report-ingest/backfill/jobs-by-milestone
//        ?expected_start=YYYY-MM-DD&expected_end=YYYY-MM-DD
//
// One-time path for landing HISTORICAL monthly reports (Jan–Jul 2026: the
// daily schedule pulls yesterday only, so closed months can never arrive on
// their own). The PDF runs through the IDENTICAL ingestReportPdf pipeline —
// same parser, same validators, same fail-closed gates — with one addition:
// the caller declares which period the file must cover (expected_start/_end)
// and the shared validator rejects a mismatched header (rule wrong_period).
// Backfilled months therefore carry exactly the guarantees daily ones do.
//
// After a successful snapshot (facts are projected inside the ingest RPC's
// transaction), a jobs_by_milestone backfill also bridges into the proven
// month-freeze mechanism (the one that froze Jan–June via the Net Report):
//   1. project per-market monthly net (Σ rows_a.net_cents + REECE roll-up)
//      into lp_net_report_rtp (report_as_of = period_end);
//   2. for a CLOSED month, convert that month's lp_market_scorecard_daily
//      rows to computed_from='net_report_rtp' (funnel counts stay — only the
//      revenue columns and provenance change), mirroring the June row shape;
//   3. run restateClosedFromReport so the stored dollars match the LATEST
//      report snapshot exactly (a later Net Report CSV upload with cents
//      sorts newer by report_as_of and wins over the PDF's whole dollars).
//
// Every run is recorded in scorecard_rederive_reports (the existing
// backfill-tracking table) — no parallel mechanism.

import supabase from '../supabase.js';
import { ingestReportPdf } from './lp-report-ingest.js';
import { restateClosedFromReport } from './scorecard-rtp-source.js';
import { todayET, centsToDollars } from './lp-report-common.js';

const REECE = 'REECE';
const monthStartOf = (iso) => `${String(iso).slice(0, 7)}-01`;
const currentMonthStartET = () => monthStartOf(todayET());

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Σ net per market for one snapshot's raw rows, plus the REECE roll-up.
 * @returns {Map<string, {cents:number, rows:number}>}
 */
export function sumSnapshotNetByMarket(rows) {
  const out = new Map();
  const bump = (market, cents) => {
    const acc = out.get(market) || { cents: 0, rows: 0 };
    acc.cents += cents;
    acc.rows += 1;
    out.set(market, acc);
  };
  for (const r of rows) {
    const cents = r.net_cents ?? 0;
    bump(r.market, cents);
    bump(REECE, cents);
  }
  return out;
}

/**
 * Coverage end of a snapshot: how far the data actually reaches.
 *
 * LP prints the SCHEDULED window, so a month-to-date pull run on Aug 5 declares
 * `period_end = 2026-08-31` — a date that has not happened. `report_as_of` must
 * never claim coverage past the generation date, because everything downstream
 * reads it as "the report covers through here": `computeAuthoritativeRtpNet`
 * takes max(report_as_of) as the winning snapshot, and the provisional tail is
 * the days AFTER it. An uncapped future end would silently swallow the rest of
 * the month as already-reported and freeze the figure until Sep 1.
 */
export const coverageEndOf = (periodEnd, asOfDate) =>
  asOfDate && asOfDate < periodEnd ? asOfDate : periodEnd;

/**
 * Project a jobs_by_milestone snapshot into lp_net_report_rtp — the staging
 * table the month-freeze mechanism reads, and the ONLY source of the
 * dashboard's Net — Released hero (lp_market_scorecard_daily.released_dollars).
 * Whole-month snapshots only: the declared period must sit inside one calendar
 * month. Exported because the DAILY ingest path calls it too — see
 * lp-report-ingest.js; when only the backfill called it, a current-month
 * snapshot could carry a perfectly good net total and the hero still rendered
 * "report pending" (2026-08-05 §2).
 */
export async function projectSnapshotToNetReport(snapshotId) {
  const { data: snap, error: snapErr } = await supabase
    .from('scorecard_report_snapshots')
    .select('id, report_type, period_start, period_end, as_of_date')
    .eq('id', snapshotId).single();
  if (snapErr) throw new Error(`snapshot read failed: ${snapErr.message}`);
  if (snap.report_type !== 'jobs_by_milestone') {
    return { projected: false, reason: 'not_jobs_by_milestone' };
  }
  const reportMonth = monthStartOf(snap.period_start);
  if (monthStartOf(snap.period_end) !== reportMonth) {
    throw new Error(`snapshot spans months (${snap.period_start}..${snap.period_end}) — backfill one calendar month per report`);
  }
  const reportAsOf = coverageEndOf(snap.period_end, snap.as_of_date);

  const { data: rows, error: rowsErr } = await supabase
    .from('scorecard_report_rows_a')
    .select('market, net_cents')
    .eq('snapshot_id', snapshotId);
  if (rowsErr) throw new Error(`snapshot rows read failed: ${rowsErr.message}`);

  const byMarket = sumSnapshotNetByMarket(rows || []);
  const records = [...byMarket.entries()].map(([market, agg]) => ({
    market,
    report_month: reportMonth,
    report_as_of: reportAsOf,
    released_net: Math.round(agg.cents) / 100,
    rows_counted: market === REECE ? (rows || []).length : agg.rows,
  }));
  const { error: upErr } = await supabase
    .from('lp_net_report_rtp')
    .upsert(records, { onConflict: 'market,report_month,report_as_of' });
  if (upErr) throw new Error(`lp_net_report_rtp upsert failed: ${upErr.message}`);

  return {
    projected: true,
    report_month: reportMonth,
    report_as_of: reportAsOf,
    period_end: snap.period_end,
    markets: records.length - 1,
    total_net: centsToDollars(byMarket.get(REECE)?.cents ?? 0),
  };
}

/**
 * Convert a CLOSED month's lp_market_scorecard_daily rows to report-sourced
 * (computed_from='net_report_rtp') for every market the report carries —
 * the same row shape June's frozen months have. Idempotent; funnel counts
 * are untouched. The subsequent restate pass stamps the exact dollars from
 * the latest lp_net_report_rtp snapshot.
 */
async function freezeClosedMonth(reportMonth) {
  if (reportMonth >= currentMonthStartET()) {
    return { frozen: false, reason: 'month_not_closed' };
  }
  const { data: netRows, error: netErr } = await supabase
    .from('lp_net_report_rtp')
    .select('market')
    .eq('report_month', reportMonth);
  if (netErr) throw new Error(`lp_net_report_rtp read failed: ${netErr.message}`);
  // Utility markets carry no report revenue but flip provenance with the
  // month (the June precedent) — otherwise the frozen month renders as
  // mixed report+live. restateClosedFromReport leaves their dollars at 0.
  const markets = [...new Set([...(netRows || []).map((r) => r.market), 'UNASSIGNED', 'OUT_OF_AREA'])];
  if (!netRows?.length) return { frozen: false, reason: 'no_net_report_rows' };

  const { data: updated, error: updErr } = await supabase
    .from('lp_market_scorecard_daily')
    .update({ computed_from: 'net_report_rtp', reconciled: true })
    .eq('period_start', reportMonth)
    .in('market', markets)
    .select('id');
  if (updErr) throw new Error(`scorecard freeze update failed: ${updErr.message}`);

  // Exact dollars from the LATEST report snapshot for every converted month.
  const restate = await restateClosedFromReport({});
  return { frozen: true, report_month: reportMonth, markets: markets.length, rows_converted: (updated || []).length, restated: restate.restated };
}

/**
 * Full backfill run: identical ingest pipeline + freeze bridge, tracked in
 * scorecard_rederive_reports. Returns the HTTP-shaped result.
 */
export async function runReportBackfill({ reportType, buffer, expectedStart, expectedEnd, source = 'backfill' }) {
  if (!supabase) throw new Error('Supabase not configured');
  if (!DATE_RE.test(expectedStart || '') || !DATE_RE.test(expectedEnd || '')) {
    return { success: false, failure_reason: 'bad_request', error: 'expected_start and expected_end (YYYY-MM-DD) are required — the declared header period must match them' };
  }

  const runId = `lpreport-backfill-${reportType}-${expectedStart}-${Date.now()}`;
  await supabase.from('scorecard_rederive_reports').insert({
    run_id: runId, dry_run: false, status: 'running',
    report: { kind: 'lp_report_backfill', report_type: reportType, expected_start: expectedStart, expected_end: expectedEnd, source },
  });
  const finish = async (status, reportPatch, error = null) => {
    await supabase.from('scorecard_rederive_reports')
      .update({ status, finished_at: new Date().toISOString(), error, report: { kind: 'lp_report_backfill', report_type: reportType, expected_start: expectedStart, expected_end: expectedEnd, source, ...reportPatch } })
      .eq('run_id', runId);
  };

  try {
    const ingest = await ingestReportPdf({
      reportType, buffer, source,
      expectedPeriod: { start: expectedStart, end: expectedEnd },
    });
    if (!ingest.success) {
      await finish('error', { ingest }, ingest.failure_reason ?? 'ingest_failed');
      return { success: false, run_id: runId, ...ingest };
    }

    let projection = { projected: false, reason: 'not_jobs_by_milestone' };
    let freeze = { frozen: false, reason: 'not_projected' };
    if (reportType === 'jobs_by_milestone') {
      // ingestReportPdf now projects every jobs_by_milestone snapshot itself
      // (the daily path needs it too); reuse its result rather than repeating
      // the identical upsert.
      projection = ingest.net_projection ?? await projectSnapshotToNetReport(ingest.snapshot_id);
      if (projection.projected) freeze = await freezeClosedMonth(projection.report_month);
    }

    await finish('done', { ingest, projection, freeze });
    return { success: true, run_id: runId, ingest, projection, freeze };
  } catch (err) {
    await finish('error', {}, err.message);
    throw err;
  }
}
