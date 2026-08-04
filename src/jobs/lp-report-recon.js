// ─── LP report daily reconciliation — src/jobs/lp-report-recon.js ───
//
// Daily 07:00 ET (after the 6:00/6:15 report emails land and ingest), each
// check writes one scorecard_recon_results row (upsert on recon_date +
// recon_type; a missing snapshot writes 'skipped', never silence):
//
//   b_internal               Report B row sums vs its own snapshot header
//                            (bucket sums, zero null buckets). The only
//                            FAIL-grade check — a breach means our write
//                            path corrupted data → GroupMe.
//   b_vs_warehouse_status    Report B bucket counts vs lp_jobs.job_status
//                            through the SAME bucket map. ADVISORY (warn):
//                            the warehouse lags LP intraday; drift is
//                            signal, not corruption. Unmapped warehouse
//                            statuses are LISTED, never dropped.
//   a_vs_warehouse_rtp_gross Report A net total vs warehouse RTP GROSS for
//                            the same period (computeProvisionalRtpGross).
//                            WARN-only by design — gross-vs-net drift is a
//                            measured −25%…+30% band; do not tune it away.
//   a_vs_net_report          Report A per-market net vs lp_net_report_rtp
//                            (the CSV-sourced authoritative net) for the
//                            same month. ADVISORY. Known July-2026 residual
//                            (2 records / $14,957) is a NAMED exception —
//                            accepted and annotated, not hidden.
//   facts_vs_raw_a/_b        lp_report_facts vs fresh aggregates from the
//                            raw rows, per current snapshot. FAIL-grade —
//                            facts are a projection, raw rows win; on
//                            divergence facts are rebuilt (recorded 'warn'
//                            if the rebuild converges, 'fail' otherwise).
//
// There is NO LP API for "Sales Efficiency By Market" (verified against
// lp-client.js) — the monthly SE tie-out stays a documented manual step.

import express from 'express';
import supabase from '../supabase.js';
import { runSQL } from '../admin/supabase-admin.js';
import { hourET, todayET, centsToDollars } from './lp-report-common.js';
import { STATUS_BUCKET_MAP } from './lp-report-parse-b.js';
import { computeProvisionalRtpGross } from './scorecard-rtp-source.js';

const RECON_ENABLED = (process.env.LP_REPORT_RECON_ENABLED || 'true').trim() !== 'false';

// Known, accepted residuals. Keyed for the PR/report trail; each carries the
// exact delta it forgives. July 2026: 2 records / $14,957.00 between Report A
// and the Net Report (LP-side timing, investigated and accepted 2026-08-04).
export const NAMED_RECON_EXCEPTIONS = {
  SE_RESIDUAL_2026_07: { records: 2, cents: 1495700, month: '2026-07' },
};

/**
 * Pure comparison of two { key → { count, cents } } shapes.
 * A named exception is consumed when it exactly explains the remaining
 * TOTAL delta (records and cents) — consumed exceptions are annotated,
 * never silent.
 * @returns {{ ok:boolean, deltas:object[], total_delta:{count:number,cents:number},
 *             applied_exceptions:string[] }}
 */
export function compareBuckets(lhs, rhs, { toleranceCents = 0, namedExceptions = {} } = {}) {
  const keys = [...new Set([...Object.keys(lhs), ...Object.keys(rhs)])].sort();
  const deltas = [];
  let dCount = 0, dCents = 0;
  for (const key of keys) {
    const a = lhs[key] || { count: 0, cents: 0 };
    const b = rhs[key] || { count: 0, cents: 0 };
    const delta = { key, lhs: a, rhs: b, d_count: a.count - b.count, d_cents: a.cents - b.cents };
    if (delta.d_count !== 0 || delta.d_cents !== 0) deltas.push(delta);
    dCount += delta.d_count; dCents += delta.d_cents;
  }
  const applied = [];
  for (const [name, ex] of Object.entries(namedExceptions)) {
    if (Math.abs(dCount) === ex.records && Math.abs(dCents) === ex.cents) {
      applied.push(name);
      dCount = 0; dCents = 0;
      break;
    }
  }
  // Totals alone would let offsetting per-key deltas cancel (a row counted in
  // the WRONG bucket nets to zero) — every key must tie unless a named
  // exception explains the total. Count deltas are never tolerated.
  const perKeyOk = applied.length > 0
    || deltas.every((d) => d.d_count === 0 && Math.abs(d.d_cents) <= toleranceCents);
  const ok = dCount === 0 && Math.abs(dCents) <= toleranceCents && perKeyOk;
  return { ok, deltas, total_delta: { count: dCount, cents: dCents }, applied_exceptions: applied };
}

async function currentSnapshot(reportType) {
  const { data, error } = await supabase
    .from('scorecard_report_snapshots')
    .select('id, period_start, period_end, row_count, net_total_cents, gross_total_cents, ingested_at')
    .eq('report_type', reportType).eq('is_current', true)
    .order('period_start', { ascending: false })
    .limit(1).maybeSingle();
  if (error) throw new Error(`snapshot read failed: ${error.message}`);
  return data;
}

async function writeResult(reconDate, reconType, status, comparison, namedExceptions = null) {
  const { error } = await supabase
    .from('scorecard_recon_results')
    .upsert(
      { recon_date: reconDate, recon_type: reconType, status, comparison, named_exceptions: namedExceptions },
      { onConflict: 'recon_date,recon_type' },
    );
  if (error) console.error(`[LPReportRecon] ${reconType} result write failed:`, error.message);
  return { recon_type: reconType, status, comparison };
}

async function alertGroupMe(text) {
  try {
    const { sendGroupMeMessage } = await import('../groupme.js');
    await sendGroupMeMessage(text);
  } catch (err) {
    console.error('[LPReportRecon] GroupMe alert failed:', err.message);
  }
}

/**
 * Bucket roll-up of a B snapshot's rows via SQL (428 rows — one round trip).
 * dup_review rows are EXCLUDED from bucket sums (ruled 2026-08-04) and
 * returned separately — the pass condition accounts for them explicitly.
 */
async function bucketSumsFromDb(snapshotId) {
  const rows = (await runSQL(`
    SELECT bucket, COUNT(*)::int AS count, COALESCE(SUM(total_gross_cents), 0)::bigint AS cents
    FROM scorecard_report_rows_b WHERE snapshot_id = '${snapshotId}' AND NOT dup_review GROUP BY bucket`)) || [];
  const out = {};
  for (const r of rows) out[r.bucket ?? 'NULL'] = { count: Number(r.count), cents: Number(r.cents) };
  const dup = (await runSQL(`
    SELECT COUNT(*)::int AS count, COALESCE(SUM(total_gross_cents), 0)::bigint AS cents
    FROM scorecard_report_rows_b WHERE snapshot_id = '${snapshotId}' AND dup_review`)) || [];
  const dupReview = { count: Number(dup[0]?.count ?? 0), cents: Number(dup[0]?.cents ?? 0) };
  return { buckets: out, dupReview };
}

/**
 * facts_vs_raw — lp_report_facts must equal the same aggregates computed
 * fresh from the raw rows (the facts table is a projection, never a second
 * truth). FAIL-grade. On mismatch the raw rows win: rebuild via
 * scorecard_rebuild_facts, re-compare, and record 'warn' (rebuilt clean —
 * the write path mis-projected, investigate) or 'fail' (still divergent).
 */
async function factsVsRawCheck(reconDate, snapshotId, reportType) {
  const key = reportType === 'jobs_by_milestone' ? 'facts_vs_raw_a' : 'facts_vs_raw_b';
  const rawSql = reportType === 'jobs_by_milestone'
    ? `SELECT r.market, COALESCE(r.branch_code_raw, '') AS branch, m.metric, '' AS bucket,
              CASE m.metric WHEN 'net_sales' THEN COALESCE(SUM(r.net_cents), 0)
                            ELSE COALESCE(SUM(r.gross_cents), 0) END::bigint AS cents,
              COUNT(*)::int AS count
       FROM scorecard_report_rows_a r
       CROSS JOIN (VALUES ('net_sales'), ('gross_sold')) AS m(metric)
       WHERE r.snapshot_id = '${snapshotId}'
       GROUP BY r.market, r.branch_code_raw, m.metric`
    : `SELECT market, COALESCE(branch_code_raw, '') AS branch,
              CASE WHEN dup_review THEN 'dup_review_pending'
                   WHEN bucket = 'excluded' THEN 'pipeline_excluded'
                   ELSE 'good_business_open' END AS metric,
              CASE WHEN dup_review THEN '' ELSE bucket END AS bucket,
              COALESCE(SUM(total_gross_cents), 0)::bigint AS cents, COUNT(*)::int AS count
       FROM scorecard_report_rows_b
       WHERE snapshot_id = '${snapshotId}'
       GROUP BY 1, 2, 3, 4`;

  const toSide = (rows) => {
    const out = {};
    for (const r of rows) out[`${r.market}|${r.branch}|${r.metric}|${r.bucket}`] = { count: Number(r.count), cents: Number(r.cents) };
    return out;
  };
  const fetchBoth = async () => {
    const raw = toSide((await runSQL(rawSql)) || []);
    const facts = toSide(((await runSQL(`
      SELECT market, COALESCE(branch_code_raw, '') AS branch, metric,
             COALESCE(bucket, '') AS bucket, value_cents AS cents, value_count AS count
      FROM lp_report_facts WHERE snapshot_id = '${snapshotId}'`)) || []));
    return { raw, facts, cmp: compareBuckets(facts, raw) };
  };

  let { raw, facts, cmp } = await fetchBoth();
  if (cmp.ok) {
    return writeResult(reconDate, key, 'pass', { snapshot_id: snapshotId, grains: Object.keys(raw).length });
  }

  // Raw wins — rebuild and re-compare.
  const { error: rbErr } = await supabase.rpc('scorecard_rebuild_facts', { p_snapshot_id: snapshotId });
  const before = { deltas: cmp.deltas, facts, raw };
  if (!rbErr) ({ raw, facts, cmp } = await fetchBoth());
  const status = !rbErr && cmp.ok ? 'warn' : 'fail';
  await alertGroupMe(status === 'warn'
    ? `⚠️ LP report recon (${key}): lp_report_facts diverged from raw rows for snapshot ${snapshotId} — rebuilt clean from raw. The write-path projection mis-projected; investigate before trusting facts written today.`
    : `🚨 LP report recon FAIL (${key}): lp_report_facts diverges from raw rows for snapshot ${snapshotId} and rebuild ${rbErr ? `errored: ${rbErr.message}` : 'did not converge'}. Raw rows are the truth — do not read facts for this snapshot.`);
  return writeResult(reconDate, key, status, {
    snapshot_id: snapshotId, rebuilt: !rbErr, rebuild_error: rbErr?.message ?? null,
    before, after_deltas: cmp.deltas,
  });
}

/** Run all the checks for today; returns the per-check results. */
export async function runLpReportRecon({ reconDate } = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const date = reconDate || todayET();
  const results = [];

  // ── b_internal: our own write path must agree with itself, to the cent ──
  const snapB = await currentSnapshot('jobs_by_status');
  if (!snapB) {
    results.push(await writeResult(date, 'b_internal', 'skipped', { reason: 'no current jobs_by_status snapshot' }));
    results.push(await writeResult(date, 'b_vs_warehouse_status', 'skipped', { reason: 'no current jobs_by_status snapshot' }));
    results.push(await writeResult(date, 'facts_vs_raw_b', 'skipped', { reason: 'no current jobs_by_status snapshot' }));
  } else {
    const { buckets, dupReview } = await bucketSumsFromDb(snapB.id);
    const rowCount = Object.values(buckets).reduce((a, b) => a + b.count, 0);
    const centsSum = Object.values(buckets).reduce((a, b) => a + b.cents, 0);
    const nullBuckets = buckets.NULL?.count ?? 0;
    // Header row_count is ALL inserted rows; header gross excludes dup_review
    // (ruled 2026-08-04) — so buckets + dups must reconstruct the count while
    // the cents tie is dup-exclusive on both sides.
    const okInternal = rowCount + dupReview.count === snapB.row_count
      && centsSum === Number(snapB.gross_total_cents ?? 0)
      && nullBuckets === 0;
    const comparison = {
      snapshot_id: snapB.id, buckets, dup_review: dupReview,
      rows: { db: rowCount, dup_review: dupReview.count, header: snapB.row_count },
      cents: { db: centsSum, header: Number(snapB.gross_total_cents ?? 0) },
      null_buckets: nullBuckets,
    };
    results.push(await writeResult(date, 'b_internal', okInternal ? 'pass' : 'fail', comparison));
    if (!okInternal) {
      await alertGroupMe(`🚨 LP report recon FAIL (b_internal): Report B rows disagree with their own snapshot header (rows ${rowCount}/${snapB.row_count}, cents ${centsSum}/${snapB.gross_total_cents}, null buckets ${nullBuckets}). Write-path corruption — investigate scorecard_report_rows_b snapshot ${snapB.id}.`);
    }

    // ── b_vs_warehouse_status: advisory drift vs lp_jobs through the SAME map ──
    const whRows = (await runSQL(`
      SELECT job_status, COUNT(*)::int AS count, COALESCE(SUM(job_value), 0)::numeric AS gross
      FROM lp_jobs GROUP BY job_status`)) || [];
    const whBuckets = {};
    const unmappedWh = [];
    for (const r of whRows) {
      const bucket = STATUS_BUCKET_MAP.get(String(r.job_status ?? '').trim());
      if (!bucket) { unmappedWh.push({ job_status: r.job_status, count: Number(r.count) }); continue; }
      const acc = whBuckets[bucket] || { count: 0, cents: 0 };
      acc.count += Number(r.count);
      acc.cents += Math.round(Number(r.gross) * 100);
      whBuckets[bucket] = acc;
    }
    const cmp = compareBuckets(buckets, whBuckets);
    results.push(await writeResult(date, 'b_vs_warehouse_status', cmp.ok ? 'pass' : 'warn', {
      note: 'advisory — warehouse covers ALL jobs and lags LP intraday; drift is expected signal',
      report: buckets, warehouse: whBuckets, deltas: cmp.deltas,
      warehouse_statuses_outside_report_map: unmappedWh,
    }));

    results.push(await factsVsRawCheck(date, snapB.id, 'jobs_by_status'));
  }

  // ── a_vs_warehouse_rtp_gross + a_vs_net_report ──
  const snapA = await currentSnapshot('jobs_by_milestone');
  if (!snapA) {
    results.push(await writeResult(date, 'a_vs_warehouse_rtp_gross', 'skipped', { reason: 'no current jobs_by_milestone snapshot' }));
    results.push(await writeResult(date, 'a_vs_net_report', 'skipped', { reason: 'no current jobs_by_milestone snapshot' }));
    results.push(await writeResult(date, 'facts_vs_raw_a', 'skipped', { reason: 'no current jobs_by_milestone snapshot' }));
    return { recon_date: date, results };
  }

  results.push(await factsVsRawCheck(date, snapA.id, 'jobs_by_milestone'));

  const marketRows = (await runSQL(`
    SELECT market, COUNT(*)::int AS count, COALESCE(SUM(net_cents), 0)::bigint AS net_cents
    FROM scorecard_report_rows_a WHERE snapshot_id = '${snapA.id}' GROUP BY market`)) || [];
  const aByMarket = {};
  for (const r of marketRows) aByMarket[r.market] = { count: Number(r.count), cents: Number(r.net_cents) };
  const aNetTotal = Number(snapA.net_total_cents ?? 0);

  // WARN-only: warehouse is GROSS, the report is NET — the delta is a pace
  // signal (measured −25%…+30%), never a mismatch to fix.
  const grossMap = await computeProvisionalRtpGross({
    periodStart: snapA.period_start, periodEnd: snapA.period_end, sinceDate: null,
  });
  const whGrossCents = Math.round((grossMap.get('REECE') ?? 0) * 100);
  results.push(await writeResult(date, 'a_vs_warehouse_rtp_gross', 'warn', {
    note: 'gross-vs-net comparison — drift band is signal, not error; warn is this check\'s healthy state',
    report_net_cents: aNetTotal, warehouse_gross_cents: whGrossCents,
    drift_cents: whGrossCents - aNetTotal,
    drift_pct: aNetTotal ? Math.round(10000 * (whGrossCents - aNetTotal) / aNetTotal) / 100 : null,
    period: { start: snapA.period_start, end: snapA.period_end },
  }));

  // Advisory tie vs the CSV-sourced authoritative net for the same month.
  const reportMonth = `${String(snapA.period_start).slice(0, 7)}-01`;
  const { data: netRep, error: netErr } = await supabase
    .from('lp_net_report_rtp')
    .select('market, released_net, report_as_of')
    .eq('report_month', reportMonth)
    .order('report_as_of', { ascending: false });
  if (netErr) throw new Error(`lp_net_report_rtp read failed: ${netErr.message}`);
  if (!netRep || !netRep.length) {
    results.push(await writeResult(date, 'a_vs_net_report', 'skipped', { reason: `no lp_net_report_rtp rows for ${reportMonth}` }));
  } else {
    const asOf = String(netRep[0].report_as_of).slice(0, 10);
    const csvByMarket = {};
    for (const r of netRep) {
      if (String(r.report_as_of).slice(0, 10) !== asOf || r.market === 'REECE') continue;
      csvByMarket[r.market] = { count: 0, cents: Math.round(Number(r.released_net) * 100) };
    }
    // Counts aren't comparable across the two sources — zero them on the PDF side too.
    const aMoneyOnly = Object.fromEntries(
      Object.entries(aByMarket).map(([k, v]) => [k, { count: 0, cents: v.cents }]));
    const cmp = compareBuckets(aMoneyOnly, csvByMarket, {
      toleranceCents: 100, // two independent renderings of the same report — allow $1 rounding
      namedExceptions: NAMED_RECON_EXCEPTIONS,
    });
    results.push(await writeResult(date, 'a_vs_net_report', cmp.ok ? 'pass' : 'warn', {
      note: 'advisory — PDF Report A vs CSV Net Report, same month, per market',
      report_as_of: asOf, deltas: cmp.deltas, total_delta: cmp.total_delta,
      report_total: centsToDollars(aNetTotal),
    }, cmp.applied_exceptions.length ? { applied: cmp.applied_exceptions } : null));
  }

  return { recon_date: date, results };
}

export function registerLpReportReconRoutes(app) {
  app.post('/n8n/admin/lp-report-recon-run', express.json(), async (req, res) => {
    try {
      const result = await runLpReportRecon({ reconDate: (req.query.date || '').trim() || undefined });
      res.json({ success: true, ...result });
    } catch (err) {
      console.error('[LPReportRecon] run error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/admin/lp-report-recon-status', async (req, res) => {
    try {
      if (!supabase) return res.status(500).json({ success: false, error: 'Supabase not configured' });
      const { data, error } = await supabase
        .from('scorecard_recon_results')
        .select('recon_date, recon_type, status, comparison, named_exceptions, created_at')
        .order('recon_date', { ascending: false }).limit(20);
      if (error) throw new Error(error.message);
      res.json({ success: true, recent: data || [] });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  console.log('[LPReportRecon] Routes registered: POST /n8n/admin/lp-report-recon-run | GET /n8n/admin/lp-report-recon-status');
}

// ─── Scheduler — daily at 07:00 ET (after the 6:00/6:15 report ingest) ───
let reconTimer = null;
let lastReconDate = null;

export function startLpReportReconScheduler() {
  if (reconTimer) return;
  if (!RECON_ENABLED) {
    console.log('[LPReportRecon] Scheduler DISABLED (LP_REPORT_RECON_ENABLED=false)');
    return;
  }
  console.log('[LPReportRecon] Scheduler started — daily run at 07:00 ET');
  const checkAndRun = async () => {
    const today = todayET();
    if (hourET() === 7 && lastReconDate !== today) {
      lastReconDate = today; // claim before awaiting (avoids double-fire)
      try {
        await runLpReportRecon();
      } catch (err) {
        console.error('[LPReportRecon] daily run failed:', err.message);
      }
    }
  };
  reconTimer = setInterval(checkAndRun, 5 * 60 * 1000);
}

export function stopLpReportReconScheduler() {
  if (reconTimer) { clearInterval(reconTimer); reconTimer = null; }
}
