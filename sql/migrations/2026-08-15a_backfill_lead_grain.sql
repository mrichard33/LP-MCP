-- ─── 2026-08-15a · backfill report 135 lead-grain facts onto every period ────
--
-- WHAT THIS IS. `2026-08-13d_lead_grain_supersedes.sql` taught
-- scorecard_rebuild_facts to publish `leads_distinct` and `leads_superseded`.
-- It republished the FUNCTION; it did not rebuild the snapshots that had already
-- been ingested. So the two metrics exist for exactly one period — the August
-- MTD snapshot, the only one finalized since — and are absent from the seven
-- closed months and the YTD pull:
--
--     Jan..Jul (month)   leads ✓   leads_distinct ✗
--     YTD 01-01..08-05   leads ✓   leads_distinct ✗
--     Aug 08-01..08-13   leads ✓   leads_distinct ✓  3,208
--
-- WHY IT MATTERS NOW. Amendment E re-bases the published Leads actual from the
-- ROW count to the DISTINCT count, and derives the Leads target from
-- `Σ Net Sales (137) ÷ Σ distinct leads (135)` over Jan–May. Both are impossible
-- while eight of nine current snapshots carry no distinct count: the dashboard
-- would render Leads unmeasured for every period except the current month, and
-- the rate could not be computed at all.
--
-- ══ THIS MIGRATION ADDS NO LOGIC ══
--
-- It calls the EXISTING scorecard_rebuild_facts once per stale snapshot. Every
-- fold — one row per lead, owned by the branch of its lowest row_num, carrying
-- MAX(NumSuperseded) across that lead's rows — is 2026-08-13d's and is not
-- restated here. Verified live before writing this:
--
--     has_lead_grain_block = true   has_owning_branch_fold = true
--     has_max_fold         = true
--
-- ══ THE RISK THIS GUARDS ══
--
-- scorecard_rebuild_facts DELETEs every fact for a snapshot and re-inserts the
-- lot. That is correct and idempotent, but it means a rebuild touches `leads`,
-- `sets`, `sold` and `net_sold` too — metrics the dashboard already reads and
-- that MUST NOT move. So each snapshot is rebuilt inside a check that captures
-- those four totals before and compares them after, and raises on any drift.
-- A backfill that silently restated a published figure would be worse than no
-- backfill.
--
-- The new metrics are additionally checked against the source rows directly,
-- rather than trusting that the function did what it says.
--
-- IDEMPOTENT. Only snapshots with no `leads_distinct` fact are rebuilt, so a
-- second run is a no-op. Re-running after a new 135 ingest picks up only the
-- new snapshot.
--
-- SCOPE: is_current lead_disposition snapshots only. History rows keep their
-- own facts (is_current false) and are not republished — a demoted snapshot's
-- facts are history and rebuilding them would rewrite the past.
--
-- AFTER RUNNING: the verification block at the foot of this file.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
DECLARE
  r                   record;
  v_before            jsonb;
  v_after             jsonb;
  v_facts             int;
  v_distinct_expected bigint;
  v_distinct_actual   bigint;
  v_sup_expected      bigint;
  v_sup_actual        bigint;
  v_rebuilt           int := 0;
BEGIN
  FOR r IN
    SELECT s.id, s.scope, s.period_start, s.period_end
      FROM scorecard_report_snapshots s
     WHERE s.is_current
       AND s.report_type = 'lead_disposition'
       AND NOT EXISTS (
             SELECT 1 FROM lp_report_facts f
              WHERE f.snapshot_id = s.id
                AND f.metric = 'leads_distinct')
     ORDER BY s.period_start, s.scope
  LOOP
    -- ── The four published metrics that must survive the rebuild untouched ──
    SELECT COALESCE(jsonb_object_agg(metric, total), '{}'::jsonb)
      INTO v_before
      FROM (SELECT metric, SUM(value_count) AS total
              FROM lp_report_facts
             WHERE snapshot_id = r.id
               AND metric IN ('leads', 'sets', 'sold', 'net_sold')
             GROUP BY metric) t;

    -- ── Truth for the two NEW metrics, derived from the source rows ─────────
    -- Mirrors 2026-08-13d's fold exactly: DISTINCT ON lowest row_num for the
    -- owning branch, MAX(num_superseded) over the whole lead. Computed here
    -- from lp_lead_disposition_history so the assertion is independent of the
    -- function it is checking.
    SELECT COUNT(*), COALESCE(SUM(o.sup), 0)
      INTO v_distinct_expected, v_sup_expected
      FROM (
        SELECT DISTINCT ON (l.lp_lead_id)
               MAX(l.num_superseded) OVER (PARTITION BY l.lp_lead_id) AS sup
          FROM lp_lead_disposition_history l
         WHERE l.snapshot_id = r.id
           AND l.lp_lead_id IS NOT NULL
           AND btrim(l.lp_lead_id) <> ''
         ORDER BY l.lp_lead_id, l.row_num
      ) o;

    SELECT scorecard_rebuild_facts(r.id) INTO v_facts;

    SELECT COALESCE(jsonb_object_agg(metric, total), '{}'::jsonb)
      INTO v_after
      FROM (SELECT metric, SUM(value_count) AS total
              FROM lp_report_facts
             WHERE snapshot_id = r.id
               AND metric IN ('leads', 'sets', 'sold', 'net_sold')
             GROUP BY metric) t;

    IF v_before <> v_after THEN
      RAISE EXCEPTION
        'backfill_lead_grain: rebuilding % (% .. %) MOVED a published metric — before % after % — aborting',
        r.id, r.period_start, r.period_end, v_before, v_after;
    END IF;

    SELECT COALESCE(SUM(value_count) FILTER (WHERE metric = 'leads_distinct'), 0),
           COALESCE(SUM(value_count) FILTER (WHERE metric = 'leads_superseded'), 0)
      INTO v_distinct_actual, v_sup_actual
      FROM lp_report_facts
     WHERE snapshot_id = r.id;

    IF v_distinct_actual <> v_distinct_expected THEN
      RAISE EXCEPTION
        'backfill_lead_grain: % (% .. %) published % distinct leads, source rows hold % — aborting',
        r.id, r.period_start, r.period_end, v_distinct_actual, v_distinct_expected;
    END IF;

    IF v_sup_actual <> v_sup_expected THEN
      RAISE EXCEPTION
        'backfill_lead_grain: % (% .. %) published % superseded, source rows hold % — aborting',
        r.id, r.period_start, r.period_end, v_sup_actual, v_sup_expected;
    END IF;

    v_rebuilt := v_rebuilt + 1;
    RAISE NOTICE 'backfill_lead_grain: % % .. % → % facts, % distinct, % superseded',
      r.scope, r.period_start, r.period_end, v_facts, v_distinct_actual, v_sup_actual;
  END LOOP;

  RAISE NOTICE 'backfill_lead_grain: % snapshot(s) rebuilt', v_rebuilt;
END;
$$;

COMMIT;

-- ── Verification ────────────────────────────────────────────────────────────
--
-- 1. Every current lead_disposition snapshot now carries both lead-grain
--    metrics. MUST return zero rows.
--
-- SELECT s.scope, s.period_start, s.period_end
--   FROM scorecard_report_snapshots s
--  WHERE s.is_current AND s.report_type = 'lead_disposition'
--    AND NOT EXISTS (SELECT 1 FROM lp_report_facts f
--                     WHERE f.snapshot_id = s.id AND f.metric = 'leads_distinct');
--
-- 2. The published totals, for eyeballing against the Amendment E table.
--    Expected distinct: Jan 9,387 · Feb 11,924 · Mar 12,805 · Apr 11,958 ·
--    May 10,122 · Jun 9,011 · Jul 8,722 · Aug MTD 3,208 · YTD 71,040.
--
-- SELECT period_start, period_end, scope,
--        SUM(value_count) FILTER (WHERE metric = 'leads')            AS rows_,
--        SUM(value_count) FILTER (WHERE metric = 'leads_distinct')   AS distinct_,
--        SUM(value_count) FILTER (WHERE metric = 'leads_superseded') AS superseded_
--   FROM lp_report_facts
--  WHERE is_current AND report_type = 'lead_disposition'
--  GROUP BY period_start, period_end, scope
--  ORDER BY period_start, scope;
--
-- 3. §E7's additivity contract: the owning-branch fold makes Σ branch rows equal
--    the company distinct count EXACTLY. Any row here means the fold has broken
--    and the dashboard's company Leads figure would over-count. MUST be zero.
--
-- SELECT f.snapshot_id, SUM(f.value_count) AS branch_sum, t.company_distinct
--   FROM lp_report_facts f
--   JOIN (SELECT snapshot_id, COUNT(DISTINCT lp_lead_id) AS company_distinct
--           FROM lp_lead_disposition_history
--          WHERE lp_lead_id IS NOT NULL AND btrim(lp_lead_id) <> ''
--          GROUP BY snapshot_id) t ON t.snapshot_id = f.snapshot_id
--  WHERE f.is_current AND f.metric = 'leads_distinct'
--  GROUP BY f.snapshot_id, t.company_distinct
-- HAVING SUM(f.value_count) <> t.company_distinct;
