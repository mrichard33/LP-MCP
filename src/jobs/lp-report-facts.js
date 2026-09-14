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
const KNOWN_TYPES = new Set([
  'jobs_by_milestone', 'jobs_by_status',
  // CSV-era sources (2026-08-05) — see sql/migrations/2026-08-05_lp_csv_history.sql
  'job_status_ytd', 'lead_disposition', 'source_cost',
  // report 137 (2026-08-05) — see sql/migrations/2026-08-05_sales_efficiency.sql
  'sales_efficiency',
]);

export function expectedFacts(reportType, rows) {
  if (!KNOWN_TYPES.has(reportType)) {
    throw new Error(`expectedFacts: unknown report_type ${reportType}`);
  }
  const out = new Map();
  // addOne: one source row into one grain (count += 1, PDF-era shape).
  // addAgg: pre-aggregated counts (source_cost), where value_count is a Σ.
  const bump = (market, branch, metric, bucket, cents, count, centsIsNull) => {
    const entry = { market, branch_code_raw: branch ?? null, metric, bucket: bucket ?? null, cents: centsIsNull ? null : 0, count: 0 };
    const key = factKey(entry);
    const acc = out.get(key) || entry;
    if (!centsIsNull) acc.cents += cents ?? 0;
    acc.count += count;
    out.set(key, acc);
  };
  const add = (market, branch, metric, bucket, cents) => bump(market, branch, metric, bucket, cents, 1, false);

  for (const r of rows) {
    if (reportType === 'jobs_by_milestone') {
      add(r.market, r.branch_code_raw, 'net_sales', null, r.net_cents);
      add(r.market, r.branch_code_raw, 'gross_sold', null, r.gross_cents);
    } else if (reportType === 'jobs_by_status') {
      if (r.dup_review) add(r.market, r.branch_code_raw, 'dup_review_pending', null, r.total_gross_cents);
      else if (r.bucket === 'excluded') add(r.market, r.branch_code_raw, 'pipeline_excluded', 'excluded', r.total_gross_cents);
      else add(r.market, r.branch_code_raw, 'good_business_open', r.bucket, r.total_gross_cents);
    } else if (reportType === 'job_status_ytd') {
      // Buckets keep their identity (incl. 'permit'); excluded rows are the
      // released/production track.
      const metric = r.bucket === 'excluded' ? 'pipeline_excluded' : 'good_business_open';
      add(r.market, r.branch_code_raw, metric, r.bucket, r.gross_cents);
    } else if (reportType === 'lead_disposition') {
      bump(r.market, r.brn_id_raw || null, 'leads', null, null, 1, true);
      if (r.appt_date != null) bump(r.market, r.brn_id_raw || null, 'sets', null, null, 1, true);
      if ((r.gsa_cents ?? 0) > 0) bump(r.market, r.brn_id_raw || null, 'sold', null, r.gsa_cents, 1, false);
      if ((r.net_cents ?? 0) > 0) bump(r.market, r.brn_id_raw || null, 'net_sold', null, r.net_cents, 1, false);
    } else if (reportType === 'sales_efficiency') {
      // Per-market funnel + buckets. net_sold emitted only when the row
      // carries net figures (MTD pulls do not — the counts_only guard).
      const b = r.branch_code_raw ?? null;
      bump(r.market, b, 'issued', null, null, r.num_issued ?? 0, true);
      bump(r.market, b, 'sat', null, null, r.num_sat ?? 0, true);
      bump(r.market, b, 'sold', null, r.gsa_cents ?? 0, r.num_sold ?? 0, false);
      if (r.num_net != null) bump(r.market, b, 'net_sold', null, r.nsa_cents ?? 0, r.num_net, false);
      bump(r.market, b, 'cancelled', null, r.cancelled_cents ?? 0, r.num_cancelled ?? 0, false);
      bump(r.market, b, 'credit_decline', null, r.cd_cents ?? 0, r.num_cd ?? 0, false);
      bump(r.market, b, 'working_open', null, r.working_cents ?? 0, r.num_working ?? 0, false);
      bump(r.market, b, 'hold', null, r.hold_cents ?? 0, r.num_hold ?? 0, false);
    } else {
      // source_cost: company-level control-total facts (market 'REECE').
      bump('REECE', null, 'leads', null, null, r.num_raw ?? 0, true);
      bump('REECE', null, 'sets', null, null, r.num_set ?? 0, true);
      bump('REECE', null, 'confirmed', null, null, r.num_cnf ?? 0, true);
      bump('REECE', null, 'issued', null, null, r.num_issued ?? 0, true);
      bump('REECE', null, 'sat', null, null, r.num_sat ?? 0, true);
      bump('REECE', null, 'sold', null, null, r.num_sold ?? 0, true);
      bump('REECE', null, 'net_sold', null, null, r.num_net_sold ?? 0, true);
      bump('REECE', null, 'gross_sold', null, r.gsa_cents, 1, false);
      bump('REECE', null, 'net_sales', null, r.nsa_cents, 1, false);
      bump('REECE', null, 'marketing_cost', null, r.mcost_cents, 1, false);
      bump('REECE', null, 'working_amount', null, r.working_cents, 1, false);
    }
  }

  // ── Report 135 lead-grain metrics — a SECOND grain over the same rows ──
  //
  // `leads` above is a ROW count, and 135 is emitted at lead × disposition-
  // state grain: history holds 243,917 rows over 72,570 distinct leads, and
  // one lead's rows can carry different entry_dates (5,464 do, up to 12).
  // So the row count cannot answer "how many leads", and NumSuperseded —
  // LP's own count of duplicate records folded into a survivor — cannot be
  // read off a row either. Both need the lead grain, and both are published
  // separately rather than by changing what `leads` means.
  //
  // TWO FOLDS, and getting either wrong inflates the number:
  //
  //  1. MAX per lead, not Σ over rows. NumSuperseded repeats on every row of
  //     a lead, so summing rows gives ~15,670 against a true 4,347 — 3.6×.
  //
  //  2. ONE OWNING BRANCH per lead. 429 leads appear under more than one
  //     (market, branch) inside a snapshot, and these facts are consumed
  //     ADDITIVELY — the dashboard sums a market's branch rows. Folding per
  //     branch would count those leads once per branch: 72,862 distinct /
  //     4,370 superseded against a true 72,570 / 4,347. Each lead is
  //     therefore assigned to the branch of its LOWEST row_num — first
  //     appearance in the file, deterministic — which makes both metrics sum
  //     exactly to the company figure.
  //
  // Mirrors the lead-grain INSERT in scorecard_rebuild_facts()
  // (sql/migrations/2026-08-13d_lead_grain_supersedes.sql).
  if (reportType === 'lead_disposition') {
    const owner = new Map(); // lp_lead_id → { market, branch, rowNum } at lowest row_num
    const maxSup = new Map(); // lp_lead_id → MAX(num_superseded)
    for (const r of rows) {
      const id = String(r.lp_lead_id ?? '').trim();
      if (!id) continue; // parser already reports id-less rows; they cannot be folded
      const rowNum = r.row_num ?? Number.MAX_SAFE_INTEGER;
      const prev = owner.get(id);
      if (!prev || rowNum < prev.rowNum) {
        owner.set(id, { market: r.market, branch: r.brn_id_raw || null, rowNum });
      }
      maxSup.set(id, Math.max(maxSup.get(id) ?? 0, r.num_superseded ?? 0));
    }
    for (const [id, o] of owner) {
      bump(o.market, o.branch, 'leads_distinct', null, null, 1, true);
      bump(o.market, o.branch, 'leads_superseded', null, null, maxSup.get(id) ?? 0, true);
    }
  }

  // ── marketing_cost fails to NULL, never to zero (2026-09-14) ───────────────
  // Mirrors NULLIF(SUM(c.mcost_cents), 0) in scorecard_rebuild_facts.
  //
  // A cost column that reports nothing for a whole period must publish
  // "unknown", not "free". August 2026 and September MTD both read $0 against
  // $269,602 in July — 68 and 47 contributing rows, every one of them a hard
  // zero, Modernize and Lead Gurus included — and every cost-per-lead,
  // cost-per-issued, cost-per-sale and marketing-%-of-net derived from them was
  // computing against a coalesced zero for six weeks.
  //
  // NOTE THE COLLAPSE THIS ACCEPTS: `money()` in lp-report-parse-source-cost.js
  // returns 0 for any cell it cannot parse, blank included, so a missing figure
  // and a real $0.00 are already identical by the time they reach here. A
  // genuinely-zero period therefore resolves to unknown as well. That is the
  // safe side: a suppressed tile, against a fabricated cost-per-lead. See the
  // sql/109 header for what restoring the real distinction would take.
  if (reportType === 'source_cost') {
    const mc = out.get(factKey({
      market: 'REECE', branch_code_raw: null, metric: 'marketing_cost', bucket: null,
    }));
    if (mc && mc.cents === 0) mc.cents = null;
  }

  return out;
}
