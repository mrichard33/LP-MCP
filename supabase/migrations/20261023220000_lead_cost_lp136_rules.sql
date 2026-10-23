-- 20261023220000_lead_cost_lp136_rules — Lead Cost dollars and counts follow LP 136 to the penny.
--
-- 2026-10-23 (the user: "Track down all the gaps. I need this to be penny
-- accurate."). Checked against LP report 136 (Mktg Sub-Source Cost Analysis 2)
-- for September, run 2026-10-23 4:43 PM, every source:
--   * A lead's period is its LP ENTRY DATE (raw entrydate), not dateentered.
--   * Gross = jobs on sold leads entered in the period; Working / Net = jobs
--     CONTRACTED in the period (any lead date), split by the RTP milestone;
--     status New jobs never count. See the job_rows comment.
--   * lp_jobs.lp_deleted_at: a job LP deleted (a reversed sale: lead 579034's
--     $9,000 job vanished in LP on 10/06 and stayed here as a sale). The
--     nightly LP sales reconcile (src/jobs/lp-sales-reconcile.js) sets it.
-- With those, every September source matched LP except where our copy of LP
-- was out of date, which the reconcile fixes.
-- ROLLBACK: re-run 20261023200000's CREATE OR REPLACE VIEW (the column can stay).

ALTER TABLE lp_jobs ADD COLUMN IF NOT EXISTS lp_deleted_at timestamptz;
COMMENT ON COLUMN lp_jobs.lp_deleted_at IS 'Set when LP no longer returns this job on its lead (src/jobs/lp-sales-reconcile.js); cleared if it returns.';

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
  -- LP 136 dates a lead by its ENTRY DATE (raw entrydate), not dateentered:
  -- lead 571626 was entered 8/31 15:10 with entry date 9/1, and LP 136 counts
  -- its $25,000 sale in September (Self Generated matched only that way).
  SELECT l.lp_lead_id,
         COALESCE(m.market_code, a.resolved_market_code, 'UNASSIGNED') AS market,
         COALESCE(l.lead_source_detail, '(none)') AS lp_sub_source,
         COALESCE(left(l.raw_lp_data->>'entrydate', 10)::date,
                  (l.created_at_lp AT TIME ZONE 'UTC')::date)::timestamp AS created_et,
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
  WHERE l.lp_deleted_at IS NULL AND l.created_at_lp >= DATE '2025-11-01'
    AND COALESCE(left(l.raw_lp_data->>'entrydate', 10)::date,
                 (l.created_at_lp AT TIME ZONE 'UTC')::date) >= DATE '2026-01-01'
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
-- Dollars follow LP 136 (Mktg Sub-Source Cost Analysis 2) exactly. Reverse-
-- engineered job by job against the September report run 2026-10-23 4:43 PM
-- (every source matched once our copy of LP was current):
--   Gross   = jobs on SOLD leads whose ENTRY DATE is in the period
--   Working = jobs CONTRACTED in the period, sold lead, not lost, no RTP yet
--   Net     = jobs CONTRACTED in the period, sold lead, not lost, with an RTP
--   (lost   = Cancelled, Cancelled By Mgt, Credit Decline or Dead Deal)
-- So Net and Working are by contract date and can include a lead from an
-- earlier month (Billboard's $30,780: lead 8/6, contract and RTP in September;
-- LP prints it with $0 gross). Every rule reads the job's own LP payload
-- (status, grossamount, contractdate, the RTP milestone). A job in status New
-- is LP's placeholder and never counts (Canvass 60077 / 60078, $37,500 each).
-- A job LP deleted (lp_deleted_at, set by the nightly LP sales reconcile) and a
-- lead that is not sold (Modernize's second $49,000 HOA copy) never count.
job_rows AS (
  SELECT COALESCE(m.market_code, a.resolved_market_code, 'UNASSIGNED') AS market,
         COALESCE(l.lead_source_detail, '(none)') AS lp_sub_source,
         COALESCE(left(l.raw_lp_data->>'entrydate', 10)::date,
                  (l.created_at_lp AT TIME ZONE 'UTC')::date) AS entry_date,
         left(j.raw_lp_data->>'contractdate', 10)::date AS contract_date,
         j.job_value,
         CASE
           WHEN j.job_status IN ('Cancelled', 'Cancelled By Mgt', 'Credit Decline', 'Dead Deal') THEN 'lost'
           WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(j.raw_lp_data->'milestones', '[]'::jsonb)) ms
                         WHERE ms->>'datetype' = 'RTP' AND COALESCE(ms->>'actdate', '') <> '') THEN 'net'
           ELSE 'working'
         END AS bucket
  FROM lp_jobs j
  JOIN lp_leads l ON l.lp_lead_id = j.lp_lead_id
  LEFT JOIN lp_branch_market_map m ON m.brn_id = l.lp_branch_id
  LEFT JOIN lp_lead_market_assignments a ON a.lead_id = l.lp_lead_id
  WHERE l.lp_deleted_at IS NULL AND j.lp_deleted_at IS NULL
    AND l.closed_won AND COALESCE(j.job_status, '') <> 'New'
),
job_periods AS (
  SELECT g.grain,
         CASE g.grain WHEN 'month' THEN date_trunc('month', jr.entry_date)::date
                      ELSE date_trunc('week', jr.entry_date)::date END AS period_start,
         jr.market, jr.lp_sub_source,
         jr.job_value AS gross, 0::numeric AS working, 0::numeric AS net, 0::numeric AS lost
  FROM job_rows jr CROSS JOIN (VALUES ('month'), ('iso_week')) AS g(grain)
  WHERE jr.entry_date >= DATE '2026-01-01'
  UNION ALL
  SELECT g.grain,
         CASE g.grain WHEN 'month' THEN date_trunc('month', jr.contract_date)::date
                      ELSE date_trunc('week', jr.contract_date)::date END,
         jr.market, jr.lp_sub_source,
         0, CASE WHEN jr.bucket = 'working' THEN jr.job_value ELSE 0 END,
            CASE WHEN jr.bucket = 'net' THEN jr.job_value ELSE 0 END,
            CASE WHEN jr.bucket = 'lost' THEN jr.job_value ELSE 0 END
  FROM job_rows jr CROSS JOIN (VALUES ('month'), ('iso_week')) AS g(grain)
  WHERE jr.contract_date >= DATE '2026-01-01'
),
snap_asof AS (
  SELECT MAX(j.synced_at)::date AS as_of_date FROM lp_jobs j
),
dollars AS (
  SELECT grain, period_start, market, lp_sub_source,
         SUM(gross) AS gross, SUM(working) AS working, SUM(net) AS net, SUM(lost) AS lost
  FROM job_periods
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
