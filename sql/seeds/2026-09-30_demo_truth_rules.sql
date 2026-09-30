-- 2026-09-30 fix/demo-truth — agent_rules changes (LP Supabase).
-- Durable record; Mark applies it live from the Supabase dashboard (see the PR's
-- Post-merge steps). Run step 0 on its own first, then steps 1, 2 and 3.

-- 0) Backup (DDL: run in Supabase dashboard SQL editor, its own execution)
CREATE TABLE IF NOT EXISTS agent_rules_backup_20260930 AS
SELECT * FROM agent_rules WHERE rule_key IN (
 'ENROLL_S5_2_v2_NO_SHOW_ON_US','ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED','GHL_APPT_CANCELLED_REBOOK',
 'GHL_APPT_CANCELLED_REBOOK_COLD','LP_DISP_1LEG','LP_DISP_CANCEL_COLD_TO_S5_2','LP_DISP_NOSHOW_COLD_TO_TOFU',
 'LP_DAY15_STAMP_DEMO_COMPLETED_TAG');

-- 1) Pre-check: expect exactly 7 rows, all action_type remove_tag
SELECT rule_key, e FROM agent_rules, jsonb_array_elements(action_template) e
WHERE enabled AND e->>'action_type'='remove_tag'
  AND (e->'params'->>'tag'='lp-demo-completed' OR coalesce(e->'params'->'tags','[]'::jsonb) ? 'lp-demo-completed');

-- 2) Stop stripping the demo tag on cancels / no-shows. Expect count = 7
WITH u AS (
  UPDATE agent_rules r SET
    action_template = (SELECT jsonb_agg(e ORDER BY ord)
      FROM jsonb_array_elements(r.action_template) WITH ORDINALITY x(e, ord)
      WHERE NOT (e->>'action_type'='remove_tag' AND e->'params'->>'tag'='lp-demo-completed')),
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-09-30 fix/demo-truth: no longer strips lp-demo-completed. A demo that happened stays true.'
  WHERE r.enabled AND r.rule_key IN (
   'ENROLL_S5_2_v2_NO_SHOW_ON_US','ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED','GHL_APPT_CANCELLED_REBOOK',
   'GHL_APPT_CANCELLED_REBOOK_COLD','LP_DISP_1LEG','LP_DISP_CANCEL_COLD_TO_S5_2','LP_DISP_NOSHOW_COLD_TO_TOFU')
  RETURNING 1)
SELECT count(*) FROM u;

-- 3) Day-15 stamp: real demos only (drop NIS, NOC, BO, 1Leg; add NoRehash, PM). Expect count = 1
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = jsonb_set(context_conditions, '{lp_disposition_in}',
      '["OPPFDN","FDNS","SW","PM","Sale","NoRehash"]'::jsonb),
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-09-30 fix/demo-truth: NIS/NOC/BO/1Leg are not demos.'
  WHERE rule_key = 'LP_DAY15_STAMP_DEMO_COMPLETED_TAG' RETURNING 1)
SELECT count(*) FROM u;

-- ROLLBACK (only if needed):
-- UPDATE agent_rules a SET action_template=b.action_template, context_conditions=b.context_conditions,
--   version=b.version, notes=b.notes, updated_at=now()
-- FROM agent_rules_backup_20260930 b WHERE a.rule_key=b.rule_key;
