// ─── lp_report_facts projection spec — src/jobs/lp-report-facts.js ───
//
// PURE. The JS mirror of the SQL projection in scorecard_rebuild_facts()
// (sql/migrations/2026-08-05_lp_report_facts.sql). The facts table is a
// PROJECTION over scorecard_report_rows_a/_b — never a second source of
// truth — and the daily facts_vs_raw recon (lp-report-recon.js) is exactly
// the guard that keeps this file and the SQL in agreement: if they drift,
// recon fails loud, the raw rows win, and facts rebuild.
//
// GRAIN: one entry per (market, branch_code_raw, metric, bucket) aggregate.
// METRICS partition the raw rows completely, so the recon covers every row:
//   rows_a                         → net_sales + gross_sold (count = jobs)
//   rows_b !dup_review, hoa/other  → good_business_open (bucket kept)
//   rows_b !dup_review, excluded   → pipeline_excluded  (bucket 'excluded')
//   rows_b dup_review              → dup_review_pending (bucket null —
//                                    ruled 2026-08-04: held for review,
//                                    never counted into Good Business)

/** Stable key for one fact grain. */
export function factKey({ market, branch_code_raw, metric, bucket }) {
  return `${market}|${branch_code_raw ?? ''}|${metric}|${bucket ?? ''}`;
}

/**
 * Project raw report rows to the expected fact aggregates.
 * @param {'jobs_by_milestone'|'jobs_by_status'} reportType
 * @param {object[]} rows parsed rows (market already resolved)
 * @returns {Map<string, {market:string, branch_code_raw:string|null, metric:string,
 *                        bucket:string|null, cents:number, count:number}>} keyed by factKey
 */
export function expectedFacts(reportType, rows) {
  if (reportType !== 'jobs_by_milestone' && reportType !== 'jobs_by_status') {
    throw new Error(`expectedFacts: unknown report_type ${reportType}`);
  }
  const out = new Map();
  const add = (market, branch, metric, bucket, cents) => {
    const entry = { market, branch_code_raw: branch ?? null, metric, bucket: bucket ?? null, cents: 0, count: 0 };
    const key = factKey(entry);
    const acc = out.get(key) || entry;
    acc.cents += cents ?? 0;
    acc.count += 1;
    out.set(key, acc);
  };

  for (const r of rows) {
    if (reportType === 'jobs_by_milestone') {
      add(r.market, r.branch_code_raw, 'net_sales', null, r.net_cents);
      add(r.market, r.branch_code_raw, 'gross_sold', null, r.gross_cents);
    } else {
      if (r.dup_review) add(r.market, r.branch_code_raw, 'dup_review_pending', null, r.total_gross_cents);
      else if (r.bucket === 'excluded') add(r.market, r.branch_code_raw, 'pipeline_excluded', 'excluded', r.total_gross_cents);
      else add(r.market, r.branch_code_raw, 'good_business_open', r.bucket, r.total_gross_cents);
    }
  }
  return out;
}
