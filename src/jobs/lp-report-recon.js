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
// Report 137 "Sales Efficiency By Market" now ingests directly
// (lp-csv-ingest.js, 2026-08-05) — the SE tie-out is automated here:
//   se_internal              GSA − Cancelled − CD − Working − Hold vs NSA,
//                            with the named $246,768 bucket residual.
//   se_hold_vs_job_status    137's Hold bucket vs Job Status YTD's HOA —
//                            two independently generated reports; named
//                            tolerance Δ1 job / $8,785 (verified 2026-08-05).
//
// CROSS-REPORT OBSERVABILITY (§F). Recorded, never enforced — neither can
// return 'fail', neither alerts, neither can block a send:
//   lead_count_vs_source_raw 135 record count vs summed 136 NumRaw over the
//                            SAME window. Tied at 1,194 on the 2026-08-06 MTD
//                            pull; 4 apart at YTD on 2026-08-07. Advisory.
//   se_gsa_vs_milestone_gross 137 per-market GSA vs 134 summed GrossAmount.
//                            EXPECTED TO DIFFER — different milestone bases,
//                            measured at 1.1×–3× and negative for two markets
//                            in August. Do not add a threshold; it would fire
//                            on everything forever.
//
// Both pair on the WINDOW, not the scope label, and write 'skipped' with the
// windows each side actually had when no shared window exists — which is the
// common case, since 135 is pulled MTD daily and 136 YTD.

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

// Report 137 named artifacts (verified against the 2026-08-05 YTD export):
// the report's own buckets do not foot to NSA — GSA − Cancelled − CD −
// Working − Hold leaves a $246,768.00 residual. Recorded with its own code,
// NEVER absorbed into a bucket to force a tie.
export const SE_BUCKET_RESIDUAL = { records: 0, cents: 24676800 };
// 137 Hold vs Job Status YTD HOA: Δ1 job / $8,785.00 between two
// independently generated reports — a named tolerance, not a failure.
export const SE_HOLD_VS_HOA_TOLERANCE = { records: 1, cents: 878500 };

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

/** Every current snapshot for a report type, newest window first. */
async function currentSnapshots(reportType) {
  const { data, error } = await supabase
    .from('scorecard_report_snapshots')
    .select('id, period_start, period_end, scope, row_count')
    .eq('report_type', reportType).eq('is_current', true)
    .order('period_end', { ascending: false });
  if (error) throw new Error(`snapshot read failed: ${error.message}`);
  return data || [];
}

/**
 * Find two reports describing the SAME window.
 *
 * Cross-report checks cannot use currentSnapshot(): it returns one snapshot per
 * type by newest period_start, and two report types are rarely on the same
 * window. 135 is pulled MTD daily and YTD weekly while 136 is YTD, so on any
 * given morning the newest 135 and the newest 136 usually describe different
 * spans — comparing them would manufacture a difference out of the calendar.
 *
 * Match on the window itself, not the scope label: scope is derived per report
 * and the same span can carry different labels. Newest matching window wins.
 *
 * @returns {{lhs: object, rhs: object}|null}
 */
export function pairOnWindow(lhsSnaps, rhsSnaps) {
  for (const l of lhsSnaps) {
    const r = rhsSnaps.find((x) => x.period_start === l.period_start && x.period_end === l.period_end);
    if (r) return { lhs: l, rhs: r };
  }
  return null;
}

/** Compact description of what windows a side actually had, for skip reasons. */
export const windowList = (snaps) => snaps.map((s) => `${s.period_start}..${s.period_end}(${s.scope})`);

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

  // ── Report 137 (sales_efficiency) checks ──────────────────────────────────
  const snapSe = await currentSnapshot('sales_efficiency');
  if (!snapSe) {
    results.push(await writeResult(date, 'se_internal', 'skipped', { reason: 'no current sales_efficiency snapshot' }));
    results.push(await writeResult(date, 'se_hold_vs_job_status_hoa', 'skipped', { reason: 'no current sales_efficiency snapshot' }));
  } else {
    const seSums = (await runSQL(`
      SELECT COALESCE(SUM(gsa_cents),0)::bigint AS gsa,
             COALESCE(SUM(nsa_cents),0)::bigint AS nsa,
             COUNT(*) FILTER (WHERE nsa_cents IS NOT NULL) AS net_rows,
             COALESCE(SUM(cancelled_cents),0)::bigint AS cancelled,
             COALESCE(SUM(cd_cents),0)::bigint AS cd,
             COALESCE(SUM(working_cents),0)::bigint AS working,
             COALESCE(SUM(hold_cents),0)::bigint AS hold,
             COALESCE(SUM(num_hold),0)::bigint AS hold_count
      FROM lp_sales_efficiency_history WHERE snapshot_id = '${snapSe.id}'`))?.[0];

    // se_internal: the report's own bucket identity. GSA − Cancelled − CD −
    // Working − Hold vs NSA — carries the named $246,768 residual. Skipped on
    // counts_only (MTD) snapshots, which have no net figures at all.
    if (!seSums || Number(seSums.net_rows) === 0) {
      results.push(await writeResult(date, 'se_internal', 'skipped', { reason: 'counts_only snapshot (MTD pull — no net figures)' }));
    } else {
      const residualCents = Number(seSums.gsa) - Number(seSums.cancelled) - Number(seSums.cd)
        - Number(seSums.working) - Number(seSums.hold) - Number(seSums.nsa);
      const cmpSe = compareBuckets(
        { residual: { count: 0, cents: residualCents } },
        { residual: { count: 0, cents: 0 } },
        { namedExceptions: { SE_BUCKET_RESIDUAL } },
      );
      results.push(await writeResult(date, 'se_internal', cmpSe.ok ? 'pass' : 'warn', {
        note: 'GSA − Cancelled − CreditDecline − Working − Hold vs NSA (report 137 internal identity)',
        residual_cents: residualCents, residual: centsToDollars(residualCents),
      }, cmpSe.applied_exceptions.length ? { applied: cmpSe.applied_exceptions } : null));
      if (!cmpSe.ok) {
        await alertGroupMe(`⚠️ LP recon: report 137 bucket residual ${centsToDollars(residualCents)} does not match the named SE_BUCKET_RESIDUAL exception ($246,768.00). Investigate before trusting 137-sourced net figures.`);
      }
    }

    // se_hold_vs_job_status_hoa: two independent reports, one truth.
    const snapJs = await currentSnapshot('job_status_ytd');
    if (!snapJs) {
      results.push(await writeResult(date, 'se_hold_vs_job_status_hoa', 'skipped', { reason: 'no current job_status_ytd snapshot' }));
    } else {
      const hoa = (await runSQL(`
        SELECT COUNT(*)::bigint AS n, COALESCE(SUM(gross_cents),0)::bigint AS cents
        FROM lp_job_status_history WHERE snapshot_id = '${snapJs.id}' AND bucket = 'hoa'`))?.[0];
      const cmpHold = compareBuckets(
        { hoa_hold: { count: Number(seSums?.hold_count ?? 0), cents: Number(seSums?.hold ?? 0) } },
        { hoa_hold: { count: Number(hoa?.n ?? 0), cents: Number(hoa?.cents ?? 0) } },
        { namedExceptions: { SE_HOLD_VS_HOA_TOLERANCE } },
      );
      results.push(await writeResult(date, 'se_hold_vs_job_status_hoa', cmpHold.ok ? 'pass' : 'warn', {
        note: '137 Hold bucket vs Job Status YTD HOA — independent-report integrity check (named Δ1/$8,785 tolerance)',
        se_hold: { count: Number(seSums?.hold_count ?? 0), cents: Number(seSums?.hold ?? 0) },
        job_status_hoa: { count: Number(hoa?.n ?? 0), cents: Number(hoa?.cents ?? 0) },
        deltas: cmpHold.deltas, total_delta: cmpHold.total_delta,
      }, cmpHold.applied_exceptions.length ? { applied: cmpHold.applied_exceptions } : null));
      if (!cmpHold.ok) {
        await alertGroupMe(`⚠️ LP recon: report 137 Hold vs Job Status HOA diverges beyond the named Δ1/$8,785 tolerance — see scorecard_recon_results (se_hold_vs_job_status_hoa).`);
      }
    }
  }

  // ══ CROSS-REPORT OBSERVABILITY (§F) ══════════════════════════════════════
  //
  // The two checks below are RECORDED, NEVER ENFORCED. They never return
  // 'fail', never alert, and never touch a send. They exist because the five LP
  // reports describe overlapping slices of one business and nothing else
  // notices when they stop agreeing — a divergence no single file's own control
  // totals can contradict.
  //
  // Both are deliberately quiet: see the note on each for why a threshold would
  // be worse than useless.
  results.push(...await runCrossReportRecon(date));

  return { recon_date: date, results };
}

/**
 * §F cross-report reconciliations. Observability only — the caller must be able
 * to trust that nothing here can fail a file or page anyone.
 */
async function runCrossReportRecon(date) {
  const out = [];

  // ── lead_count_vs_source_raw: 135 record count vs summed 136 NumRaw ──────
  //
  // Two reports over the SAME lead population, generated independently. They
  // tied at 1,194 on the 2026-08-06 MTD pull; at YTD on 2026-08-07 they sat 4
  // apart (78,557 vs 78,561). Small drift is LP-side timing and is worth
  // seeing, not worth failing on — hence 'warn' as the ceiling.
  const ldSnaps = await currentSnapshots('lead_disposition');
  const scSnaps = await currentSnapshots('source_cost');
  const pair = pairOnWindow(ldSnaps, scSnaps);

  if (!pair) {
    // The common case, not an error: 135 is pulled MTD daily and YTD weekly
    // while 136 is YTD, so a shared window often does not exist. Recorded so
    // that "no result" and "never ran" stay distinguishable.
    out.push(await writeResult(date, 'lead_count_vs_source_raw', 'skipped', {
      reason: 'no shared window between current lead_disposition and source_cost snapshots',
      lead_disposition_windows: windowList(ldSnaps),
      source_cost_windows: windowList(scSnaps),
    }));
  } else {
    const raw = (await runSQL(`
      SELECT COALESCE(SUM(num_raw),0)::bigint AS n
      FROM lp_source_cost_history WHERE snapshot_id = '${pair.rhs.id}'`))?.[0];
    const leadCount = Number(pair.lhs.row_count ?? 0);
    const sourceRaw = Number(raw?.n ?? 0);
    const delta = leadCount - sourceRaw;
    out.push(await writeResult(date, 'lead_count_vs_source_raw', delta === 0 ? 'pass' : 'warn', {
      note: '135 record count vs summed 136 NumRaw over the same window — independent views of one lead population. Advisory: drift is signal, never a rejection.',
      window: { period_start: pair.lhs.period_start, period_end: pair.lhs.period_end },
      lead_disposition: { snapshot_id: pair.lhs.id, scope: pair.lhs.scope, record_count: leadCount },
      source_cost: { snapshot_id: pair.rhs.id, scope: pair.rhs.scope, sum_num_raw: sourceRaw },
      delta,
    }));
  }

  // ── se_gsa_vs_milestone_gross: 137 per-market GSA vs 134 summed gross ────
  //
  // These count DIFFERENT MILESTONE BASES and are expected to differ — measured
  // 2026-08-07 at ratios of 1.1×–3× across every market, and negative for ORL
  // and STPET in August. There is no threshold that would not fire on
  // everything forever, so this records the delta and stops. Do not add an
  // alert here; do not "tune" it until it ties. If someone later wants a
  // signal, the honest one is a change in the ratio over time, not its size.
  const seSnaps = await currentSnapshots('sales_efficiency');
  const msSnaps = await currentSnapshots('jobs_by_milestone');
  const gsaPair = pairOnWindow(seSnaps, msSnaps);

  if (!gsaPair) {
    out.push(await writeResult(date, 'se_gsa_vs_milestone_gross', 'skipped', {
      reason: 'no shared window between current sales_efficiency and jobs_by_milestone snapshots',
      sales_efficiency_windows: windowList(seSnaps),
      jobs_by_milestone_windows: windowList(msSnaps),
    }));
  } else {
    const seRows = await runSQL(`
      SELECT market, COALESCE(SUM(gsa_cents),0)::bigint AS cents
      FROM lp_sales_efficiency_history WHERE snapshot_id = '${gsaPair.lhs.id}' GROUP BY market`) || [];
    const msRows = await runSQL(`
      SELECT market, COALESCE(SUM(gross_cents),0)::bigint AS cents
      FROM scorecard_report_rows_a WHERE snapshot_id = '${gsaPair.rhs.id}' GROUP BY market`) || [];

    const seByMarket = new Map(seRows.map((r) => [r.market, Number(r.cents)]));
    const msByMarket = new Map(msRows.map((r) => [r.market, Number(r.cents)]));

    // Union, not intersection. An inner join silently loses a market that only
    // one report knows about — and a market missing from one side is exactly
    // the kind of thing this check exists to surface. Same doctrine that makes
    // an unknown 137 Grouper an UNRESOLVED bucket instead of a dropped row.
    const markets = [...new Set([...seByMarket.keys(), ...msByMarket.keys()])].sort();
    const perMarket = markets.map((market) => {
      const se = seByMarket.get(market) ?? null;
      const ms = msByMarket.get(market) ?? null;
      return {
        market,
        se_gsa_cents: se, milestone_gross_cents: ms,
        delta_cents: se !== null && ms !== null ? se - ms : null,
        ratio: se !== null && ms ? Number((se / ms).toFixed(3)) : null,
      };
    });

    out.push(await writeResult(date, 'se_gsa_vs_milestone_gross', 'warn', {
      note: 'EXPECTED TO DIFFER — 137 GSA and 134 GrossAmount count different milestone bases. Recorded for observability; never gated, never alerted. A large delta is not a defect.',
      window: { period_start: gsaPair.lhs.period_start, period_end: gsaPair.lhs.period_end },
      sales_efficiency: { snapshot_id: gsaPair.lhs.id, scope: gsaPair.lhs.scope },
      jobs_by_milestone: { snapshot_id: gsaPair.rhs.id, scope: gsaPair.rhs.scope },
      per_market: perMarket,
      markets_only_in_137: markets.filter((m) => !msByMarket.has(m)),
      markets_only_in_134: markets.filter((m) => !seByMarket.has(m)),
      total_delta_cents: perMarket.reduce((a, r) => a + (r.delta_cents ?? 0), 0),
    }));
  }

  return out;
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
