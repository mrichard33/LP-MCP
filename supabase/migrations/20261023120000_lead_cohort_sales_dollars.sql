-- 20261023120000_lead_cohort_sales_dollars — Lead Cost dollars by LEAD-CREATED date.
--
-- 2026-10-23 (handoff "Fix Sources & Lead Cost accuracy"). The view's dollars
-- came from mkt_sales_dollars(month), which reads the report 133 snapshot
-- (lp_job_status_history). That snapshot is CONTRACT-dated, carries leads from
-- older months and lags a day (as of 10/22 it covers contracts through 10/21),
-- while the counts on the same row are by lead-created date. Reece ChatBot read
-- $119,724 for 10/1-10/22 against LP 136's $150,705: jobs 60397 (lead 584978)
-- and 60402 (lead 585051), contracted 10/22, were not in the snapshot.
--
-- Now Gross $ = SUM(lp_jobs.job_value) over jobs whose LEAD was created in the
-- period, on the same market and sub-source as the counts. Checked against LP
-- 136 for 10/1-10/22 before this was written: Lead Gurus $777,712, Modernize
-- $112,750, Bing PPC $279,749, ChatBot $150,705, Self Generated $159,106,
-- HomeBuddy $100,205, MVP $42,090 (scripts/tieout-lead-cost-lp136.js).
-- Working / Net / Lost split each job by its NEWEST bucket in any current 133
-- snapshot; a job no snapshot holds yet counts as Working.
--
-- The period is the Eastern date. lp_leads.created_at_lp already holds LP's
-- Eastern wall clock (leads peak at 09-17h in the stored value), so the date is
-- the stored value read as UTC, never AT TIME ZONE 'America/New_York', which
-- would push a 1 AM lead into the day before. Counts use the same expression,
-- so a row's counts and dollars always describe the same leads.
--
-- New column at the END (CREATE OR REPLACE VIEW only appends): cc_issued =
-- issued leads set by a LightFire agent (the user, 2026-10-23: LightFire only,
-- because the Call Center line holds only LightFire Partners invoices). Same
-- rule as isLightFireLpSetter (src/batting-average.js): an "LF" tag on LP's
-- set_by_name ("Deer - LF, Craig", "Edwards-LF, Monique", "Clarke LF, ..."), or
-- the name on the ci_agent_map lightfire roster (older untagged "Deer, Craig").
-- The dashboard spreads Call Center cost across sources by it, in TypeScript.
--
-- NOT changed: mkt_sales_dollars() / mkt_sales_snapshot(). src/marketing/
-- commission.js computes the Canvass / MVP / referral commissions from them.
-- ROLLBACK: re-run the CREATE OR REPLACE VIEW in 20261012222106 after
-- DROP VIEW v_market_subsource_cost (it cannot drop the new column in place).

CREATE OR REPLACE VIEW v_market_subsource_cost AS
WITH alloc AS (
  SELECT a.id, a.expense_id, a.month, a.market, COALESCE(a.lp_sub_source, '(none)') AS lp_sub_source,
         a.amount, a.rule, a.recommended_market, a.recommendation_reason,
         e.cost_type, COALESCE(e.provisional, false) AS provisional,
         GREATEST(e.period_start, a.month) AS slice_start,
         LEAST(e.period_end, (a.month + INTERVAL '1 month' - INTERVAL '1 day')::date) AS slice_end
  FROM marketing_expense_allocations a
  JOIN marketing_expenses e ON e.id = a.expense_id
  WHERE e.status = 'approved'
),
cost_month AS (
  SELECT 'month'::text AS grain, month AS period_start, market, lp_sub_source,
         SUM(amount) FILTER (WHERE cost_type IN ('invoice', 'feed')) AS invoice_cost,
         SUM(amount) FILTER (WHERE cost_type = 'calculated') AS calculated_cost,
         BOOL_OR(provisional) AS has_provisional,
         STRING_AGG(DISTINCT recommended_market, ',') FILTER (WHERE rule = 'hold') AS recommended_market,
         STRING_AGG(DISTINCT recommendation_reason, ' | ') FILTER (WHERE rule = 'hold') AS recommendation_reason
  FROM alloc
  GROUP BY 1, 2, 3, 4
),
alloc_days AS (
  SELECT al.market, al.lp_sub_source, al.cost_type, al.provisional, al.rule,
         al.recommended_market, al.recommendation_reason,
         d::date AS day,
         al.amount / GREATEST(1, (al.slice_end - al.slice_start + 1)) AS amount
  FROM alloc al
  CROSS JOIN LATERAL generate_series(al.slice_start, GREATEST(al.slice_end, al.slice_start), INTERVAL '1 day') AS d
),
cost_week AS (
  SELECT 'iso_week'::text AS grain, date_trunc('week', day)::date AS period_start, market, lp_sub_source,
         ROUND(SUM(amount) FILTER (WHERE cost_type IN ('invoice', 'feed')), 2) AS invoice_cost,
         ROUND(SUM(amount) FILTER (WHERE cost_type = 'calculated'), 2) AS calculated_cost,
         BOOL_OR(provisional) AS has_provisional,
         STRING_AGG(DISTINCT recommended_market, ',') FILTER (WHERE rule = 'hold') AS recommended_market,
         STRING_AGG(DISTINCT recommendation_reason, ' | ') FILTER (WHERE rule = 'hold') AS recommendation_reason
  FROM alloc_days
  GROUP BY 1, 2, 3, 4
),
costs AS (
  SELECT * FROM cost_month UNION ALL SELECT * FROM cost_week
),
lf_roster AS (
  SELECT DISTINCT lower(regexp_replace(trim(agent_name), '\s+', ' ', 'g')) AS k
  FROM ci_agent_map
  WHERE team = 'lightfire' AND agent_name IS NOT NULL
),
leads_base AS (
  SELECT l.lp_lead_id,
         COALESCE(m.market_code, a.resolved_market_code, 'UNASSIGNED') AS market,
         COALESCE(l.lead_source_detail, '(none)') AS lp_sub_source,
         (l.created_at_lp AT TIME ZONE 'UTC') AS created_et,
         l.ever_set, l.ever_issued, l.ever_sat, l.closed_won,
         (l.set_by_name ~* '[-[:space:]]LF[[:space:]]*,'
          OR EXISTS (
            SELECT 1 FROM lf_roster r
            WHERE r.k = lower(regexp_replace(trim(
                    trim(split_part(regexp_replace(l.set_by_name, '[[:space:]]*-?[[:space:]]*LF[[:space:]]*,', ',', 'i'), ',', 2))
                    || ' ' ||
                    trim(split_part(regexp_replace(l.set_by_name, '[[:space:]]*-?[[:space:]]*LF[[:space:]]*,', ',', 'i'), ',', 1))
                  ), '\s+', ' ', 'g'))
          )) AS lightfire_set
  FROM lp_leads l
  LEFT JOIN lp_branch_market_map m ON m.brn_id = l.lp_branch_id
  LEFT JOIN lp_lead_market_assignments a ON a.lead_id = l.lp_lead_id
  WHERE l.lp_deleted_at IS NULL AND l.created_at_lp >= DATE '2026-01-01'
),
leads AS (
  SELECT g.grain,
         CASE g.grain WHEN 'month' THEN date_trunc('month', lb.created_et)::date
                      ELSE date_trunc('week', lb.created_et)::date END AS period_start,
         lb.market, lb.lp_sub_source,
         COUNT(*)::int AS raw,
         COUNT(*) FILTER (WHERE lb.ever_set)::int AS set_count,
         COUNT(*) FILTER (WHERE lb.ever_issued)::int AS issued,
         COUNT(*) FILTER (WHERE lb.ever_sat)::int AS sat,
         COUNT(*) FILTER (WHERE lb.closed_won)::int AS sold,
         COUNT(*) FILTER (WHERE lb.ever_issued AND lb.lightfire_set)::int AS cc_issued
  FROM leads_base lb
  CROSS JOIN (VALUES ('month'), ('iso_week')) AS g(grain)
  GROUP BY 1, 2, 3, 4
),
-- Each job's newest bucket in any current report 133 snapshot (a job sold in
-- November on an October lead is in November's snapshot, not October's).
job_bucket AS (
  SELECT DISTINCT ON (h.job_id) h.job_id, h.bucket, s.as_of_date
  FROM lp_job_status_history h
  JOIN scorecard_report_snapshots s ON s.id = h.snapshot_id
  WHERE s.report_type = 'job_status_ytd' AND s.is_current
  ORDER BY h.job_id, s.as_of_date DESC, (s.scope = 'month') DESC
),
snap_asof AS (
  SELECT MAX(s.as_of_date) AS as_of_date
  FROM scorecard_report_snapshots s
  WHERE s.report_type = 'job_status_ytd' AND s.is_current
),
dollars AS (
  SELECT g.grain,
         CASE g.grain WHEN 'month' THEN date_trunc('month', lb.created_et)::date
                      ELSE date_trunc('week', lb.created_et)::date END AS period_start,
         lb.market, lb.lp_sub_source,
         SUM(j.job_value) AS gross,
         COALESCE(SUM(j.job_value) FILTER (WHERE jb.bucket IS NULL OR jb.bucket IN ('other_pending', 'hoa')), 0) AS working,
         COALESCE(SUM(j.job_value) FILTER (WHERE jb.bucket IN ('in_production', 'completed')), 0) AS net,
         COALESCE(SUM(j.job_value) FILTER (WHERE jb.bucket = 'lost'), 0) AS lost
  FROM lp_jobs j
  JOIN leads_base lb ON lb.lp_lead_id = j.lp_lead_id
  LEFT JOIN job_bucket jb ON jb.job_id = j.lp_job_id
  CROSS JOIN (VALUES ('month'), ('iso_week')) AS g(grain)
  GROUP BY 1, 2, 3, 4
),
keys AS (
  SELECT grain, period_start, market, lp_sub_source FROM leads
  UNION SELECT grain, period_start, market, lp_sub_source FROM costs
  UNION SELECT grain, period_start, market, lp_sub_source FROM dollars
)
SELECT k.grain, k.period_start, k.market, k.lp_sub_source,
       COALESCE(l.raw, 0) AS raw,
       COALESCE(l.set_count, 0) AS set_count,
       COALESCE(l.issued, 0) AS issued,
       COALESCE(l.sat, 0) AS sat,
       COALESCE(l.sold, 0) AS sold,
       d.gross, d.working, d.net, d.lost,
       COALESCE(c.invoice_cost, 0) AS invoice_cost,
       COALESCE(c.calculated_cost, 0) AS calculated_cost,
       COALESCE(c.invoice_cost, 0) + COALESCE(c.calculated_cost, 0) AS total_cost,
       CASE WHEN COALESCE(l.issued, 0) > 0
            THEN ROUND((COALESCE(c.invoice_cost, 0) + COALESCE(c.calculated_cost, 0)) / l.issued, 2) END AS cost_per_issued,
       CASE WHEN COALESCE(l.issued, 0) > 0 AND d.net IS NOT NULL THEN ROUND(d.net / l.issued, 2) END AS nsli,
       CASE WHEN d.net > 0
            THEN ROUND((COALESCE(c.invoice_cost, 0) + COALESCE(c.calculated_cost, 0)) / d.net, 4) END AS mkt_pct,
       COALESCE(c.has_provisional, false) AS has_provisional,
       CASE WHEN d.gross IS NOT NULL THEN (SELECT as_of_date FROM snap_asof) END AS as_of_snapshot,
       c.recommended_market, c.recommendation_reason,
       COALESCE(l.cc_issued, 0) AS cc_issued
FROM keys k
LEFT JOIN leads l ON l.grain = k.grain AND l.period_start = k.period_start AND l.market = k.market AND l.lp_sub_source = k.lp_sub_source
LEFT JOIN costs c ON c.grain = k.grain AND c.period_start = k.period_start AND c.market = k.market AND c.lp_sub_source = k.lp_sub_source
LEFT JOIN dollars d ON d.grain = k.grain AND d.period_start = k.period_start AND d.market = k.market AND d.lp_sub_source = k.lp_sub_source;
