-- 20261023200000_lead_cost_live_job_status — Working / Net from each job's live LP status.
--
-- 2026-10-23 (the user: "Why doesn't the marketing subsource cost analysis from Lead
-- Perfection match the dashboard? ... HomeBuddy shows gross sales of 109,000 but net
-- sales of 36,727"). The dashboard read HomeBuddy September as Working $76,261, Net $0.
-- The view split each job by its newest bucket in a report 133 (Jobs By Status)
-- snapshot, but the daily 133 file is month-to-date, so a job contracted in an
-- earlier month kept the bucket of its last snapshot. Now each job's state is read
-- from lp_jobs (live status) plus its RTP milestone, the way LP 136 (Mktg Sub-Source
-- Cost Analysis 2) splits it. September after the change, against LP 136:
--   HomeBuddy   Working $39,534  Net $36,727  (LP: same)
--   ChatBot     Working $48,000  Net $156,078 (LP: same)
--   Modernize   Gross $308,643  Working $49,000 (LP: same; a same-value copy job dropped)
--   Vis PPC, Google, Bing Organic: same as LP.
-- Remaining gaps are jobs LP has moved since the report ran and a few leads whose
-- sub-source or created date differs (Canvass gross ~5%).
-- as_of_snapshot is now the newest lp_jobs sync date. Columns unchanged.
-- Mkt % stays total cost / net (LP 136's Mkt %).
-- ROLLBACK: re-run the CREATE OR REPLACE VIEW in 20261023120000.

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
-- Each job's CURRENT state from lp_jobs (synced every few minutes), never a
-- report 133 snapshot: the daily 133 file is month-to-date, so a September job
-- kept the bucket of its last September snapshot forever (job 59999, RTP 9/25,
-- read "Quoted" -> Working; HomeBuddy September showed Net $0 against LP 136's
-- $36,727). LP 136's own split, matched job by job for September:
--   lost    = status Cancelled, Cancelled By Mgt, Credit Decline or Dead Deal
--   net     = released to production (an RTP milestone) or paid in full
--   working = everything else sold (HOA, permit, paperwork, loan holds, ...)
-- A prospect with two jobs of the SAME value counts once (LP keeps a copy job
-- on a second lead: Modernize prospect 458957, $49,000 HOA on leads 575738 and
-- 576873; LP 136 counts $49,000 once). The kept job is the one with an RTP,
-- then a live status, then the lowest job id.
rtp_jobs AS (
  SELECT DISTINCT m.lp_job_id
  FROM lp_job_milestones m
  WHERE m.datetype = 'RTP' AND m.act_date IS NOT NULL
),
job_state AS (
  SELECT DISTINCT ON (COALESCE(l.lp_prospect_id, j.lp_lead_id), j.job_value)
         j.lp_job_id, j.lp_lead_id, j.job_value,
         CASE
           WHEN j.job_status IN ('Cancelled', 'Cancelled By Mgt', 'Credit Decline', 'Dead Deal') THEN 'lost'
           WHEN r.lp_job_id IS NOT NULL
             OR j.job_status IN ('Paid In Full', 'PIF Survey Ready', 'PIF NO Survey') THEN 'net'
           ELSE 'working'
         END AS bucket
  FROM lp_jobs j
  JOIN lp_leads l ON l.lp_lead_id = j.lp_lead_id
  LEFT JOIN rtp_jobs r ON r.lp_job_id = j.lp_job_id
  WHERE l.lp_deleted_at IS NULL AND l.created_at_lp >= DATE '2026-01-01'
  ORDER BY COALESCE(l.lp_prospect_id, j.lp_lead_id), j.job_value,
           (r.lp_job_id IS NOT NULL) DESC,
           (j.job_status IN ('Cancelled', 'Cancelled By Mgt', 'Credit Decline', 'Dead Deal')) ASC,
           NULLIF(regexp_replace(j.lp_job_id, '\D', '', 'g'), '')::bigint NULLS LAST
),
snap_asof AS (
  SELECT MAX(j.synced_at)::date AS as_of_date FROM lp_jobs j
),
dollars AS (
  SELECT g.grain,
         CASE g.grain WHEN 'month' THEN date_trunc('month', lb.created_et)::date
                      ELSE date_trunc('week', lb.created_et)::date END AS period_start,
         lb.market, lb.lp_sub_source,
         SUM(js.job_value) AS gross,
         COALESCE(SUM(js.job_value) FILTER (WHERE js.bucket = 'working'), 0) AS working,
         COALESCE(SUM(js.job_value) FILTER (WHERE js.bucket = 'net'), 0) AS net,
         COALESCE(SUM(js.job_value) FILTER (WHERE js.bucket = 'lost'), 0) AS lost
  FROM job_state js
  JOIN leads_base lb ON lb.lp_lead_id = js.lp_lead_id
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
