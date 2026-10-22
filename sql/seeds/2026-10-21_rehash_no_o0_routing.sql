-- 2026-10-21 — A rehash contact is never routed into O.0 (Mark; Jim Anderson, 5Cp5CiWtQ2zSRlxb2XPL)
--
-- WHY. Jim was in rehash with John Manieri texting him by hand. At 8:48 ET
-- BEHAVIORAL_PRICE_OBJECTION and at 8:54 BEHAVIORAL_COMPETITOR_OBJECTION each
-- removed him from F.0 and enrolled him in O.0 Objection Handler: a second
-- automated sequence on a lead the rehash rep was working.
--
-- MARK'S RULING (2026-10-21):
--   - Do NOT skip on stage:post-appointment, lp-demo-completed or bj:stage-4/5:
--     the family keeps firing for unsold post-demo leads OUTSIDE rehash (FDNS,
--     BO, 1Leg, NIS, OPPFDN past the 30-day window).
--   - Skip condition: the contact has any of rehash, active-f.0, rehash-owned.
--   - Under it skip ONLY the workflow moves (remove_from_workflow F.0, and the
--     add_to_workflow O.0). Tags, notes and notifications still fire.
--   - The routing branch also removes the contact from F.0 v2
--     (07559309-9f55-4adf-8eff-9e5e3e5c3979), not only v1.
--   - agent_rules cannot condition a single action (the engine evaluates a
--     rule's conditions once for all of its actions), so each rule splits in
--     two: <KEY> keeps its tags + notification with conditions unchanged;
--     <KEY>_ROUTE carries the workflow moves, the same event and conditions,
--     plus not_has_any_tag ["rehash","active-f.0","rehash-owned"].
--   - The whole post-demo objection family: BEHAVIORAL_{COMPETITOR,PRICE,SPOUSE,
--     TIMING,TRUST,DIY}_OBJECTION, BRIDGE_CONCERN_{COMPETITOR,PRICE,SPOUSE,
--     TIMING,TRUST,DIY}, OBJECTION_ROUTE_POST_DEMO. NOT RESCISSION_RESCUE_HUMAN_
--     OWNED (signed with a competitor stays on its human-owned O.0 lane) and no
--     cancel / rebook / disposition rule.
--   - LOOP_ESCALATION_UNCLEAR (rule 323) enrolls in no workflow (add_tag,
--     create_task, add_note only, read 2026-10-21), so it has nothing to split.
--
-- Engine notes (src/decision-engine.js): a <KEY>_ROUTE key keeps the BEHAVIORAL_
-- / OBJECTION_ prefix, so it gets the same stage gate and per-key dedup as its
-- parent (dedupPolicy group null); not_has_any_tag reads the contact LIVE and an
-- unreadable read suppresses the routing (fail-closed), never the tags.
--
-- Idempotent: a _ROUTE row is created only when it does not exist, and the
-- parent loses its workflow actions only in the same statement that created
-- its _ROUTE row. Re-running does nothing.
--
-- Apply: the one statement below (the parent update and the _ROUTE insert land
-- together, so no rule is ever half split). The engine re-reads agent_rules every
-- 60 s (loadRules, CACHE_TTL_MS); then run MCP check_rule_targets. Expected:
-- routes_created = 13, parents_updated = 13, log_rows = 13 (dry run 2026-10-21:
-- all 13 rules matched, each with an F.0 v1 removal and an O.0 add).

WITH keys(rule_key) AS (
  VALUES ('BEHAVIORAL_COMPETITOR_OBJECTION'), ('BEHAVIORAL_PRICE_OBJECTION'), ('BEHAVIORAL_SPOUSE_OBJECTION'),
         ('BEHAVIORAL_TIMING_OBJECTION'), ('BEHAVIORAL_TRUST_OBJECTION'), ('BEHAVIORAL_DIY_OBJECTION'),
         ('BRIDGE_CONCERN_COMPETITOR'), ('BRIDGE_CONCERN_PRICE'), ('BRIDGE_CONCERN_SPOUSE'),
         ('BRIDGE_CONCERN_TIMING'), ('BRIDGE_CONCERN_TRUST'), ('BRIDGE_CONCERN_DIY'),
         ('OBJECTION_ROUTE_POST_DEMO')
),
src AS (
  SELECT r.* FROM agent_rules r JOIN keys k USING (rule_key)
  WHERE jsonb_path_exists(r.action_template, '$[*] ? (@.action_type == "add_to_workflow" || @.action_type == "remove_from_workflow")')
    AND NOT EXISTS (SELECT 1 FROM agent_rules x WHERE x.rule_key = r.rule_key || '_ROUTE')
),
split AS (
  SELECT s.id, s.rule_key,
    (SELECT coalesce(jsonb_agg(a ORDER BY o), '[]'::jsonb) FROM jsonb_array_elements(s.action_template) WITH ORDINALITY t(a, o)
      WHERE a->>'action_type' IN ('add_to_workflow', 'remove_from_workflow')) AS moves,
    (SELECT coalesce(jsonb_agg(a ORDER BY o), '[]'::jsonb) FROM jsonb_array_elements(s.action_template) WITH ORDINALITY t(a, o)
      WHERE a->>'action_type' NOT IN ('add_to_workflow', 'remove_from_workflow')) AS keep,
    -- The F.0 v2 removal rides with the F.0 v1 one (Mark: "not only v1").
    jsonb_path_exists(s.action_template, '$[*] ? (@.action_type == "remove_from_workflow" && @.params.workflow_id == "15f47572-9ffc-453d-995d-a1890441f290")') AS removes_f0
  FROM src s
),
route AS (
  INSERT INTO agent_rules (rule_key, rule_name, category, event_pattern, conditions, action_template, requires_approval,
                           enabled, priority, version, created_by, notes, rule_type, context_conditions, decision_point, variants)
  SELECT s.rule_key || '_ROUTE', s.rule_name || ' — workflow routing', s.category, s.event_pattern, s.conditions,
    sp.moves || CASE WHEN sp.removes_f0 AND NOT jsonb_path_exists(sp.moves, '$[*] ? (@.params.workflow_id == "07559309-9f55-4adf-8eff-9e5e3e5c3979")')
      THEN jsonb_build_array(jsonb_build_object(
        'action_type', 'remove_from_workflow', 'target_entity', 'contact', 'target_system', 'ghl',
        'params', jsonb_build_object('workflow_id', '07559309-9f55-4adf-8eff-9e5e3e5c3979', 'workflow_name', 'F.0  Post-Appointment Follow-Up v2', 'canonical_code', 'F.0')))
      ELSE '[]'::jsonb END,
    s.requires_approval, s.enabled, s.priority, 1, 'claude',
    '2026-10-21 (Mark): split from ' || s.rule_key || '. The workflow moves only, never for a rehash contact (rehash, active-f.0, rehash-owned); the tags and the notification stay on ' || s.rule_key || '. See sql/seeds/2026-10-21_rehash_no_o0_routing.sql.',
    s.rule_type,
    jsonb_set(coalesce(s.context_conditions, '{}'::jsonb), '{not_has_any_tag}',
      (SELECT jsonb_agg(DISTINCT t) FROM jsonb_array_elements_text(coalesce(s.context_conditions->'not_has_any_tag', '[]'::jsonb) || '["rehash","active-f.0","rehash-owned"]'::jsonb) t)),
    s.decision_point, s.variants
  FROM src s JOIN split sp ON sp.id = s.id
  RETURNING id, rule_key, action_template, context_conditions
),
parent AS (
  UPDATE agent_rules r SET
    action_template = sp.keep,
    version = coalesce(r.version, 1) + 1,
    updated_at = now(),
    notes = coalesce(r.notes, '') || E'\n2026-10-21 (Mark): workflow moves split to ' || r.rule_key || '_ROUTE (skipped for rehash / active-f.0 / rehash-owned); this rule keeps the tags and the notification.'
  FROM split sp JOIN route rt ON rt.rule_key = sp.rule_key || '_ROUTE'
  WHERE r.id = sp.id
  RETURNING r.id, r.rule_key, r.action_template
),
log AS (
  INSERT INTO bot_change_log (actor, action, target_table, target_id, reason, before, after)
  SELECT 'claude', 'rule_split_rehash_routing', 'agent_rules', p.id::text,
    'Mark 2026-10-21: no O.0 routing for a rehash contact (Jim Anderson); the workflow moves now live on ' || rt.rule_key,
    jsonb_build_object('rule_key', p.rule_key, 'action_template', s.action_template),
    jsonb_build_object('rule_key', p.rule_key, 'action_template', p.action_template, 'route_rule_id', rt.id, 'route_rule_key', rt.rule_key,
                       'route_action_template', rt.action_template, 'route_context_conditions', rt.context_conditions)
  FROM parent p JOIN route rt ON rt.rule_key = p.rule_key || '_ROUTE' JOIN src s ON s.id = p.id
  RETURNING 1
)
SELECT (SELECT count(*) FROM route) AS routes_created, (SELECT count(*) FROM parent) AS parents_updated, (SELECT count(*) FROM log) AS log_rows;

-- Verify:
--   SELECT rule_key, jsonb_path_query_array(action_template, '$[*].action_type'), context_conditions->'not_has_any_tag'
--   FROM agent_rules WHERE rule_key LIKE '%_ROUTE' OR rule_key IN (<the 13 keys>) ORDER BY rule_key;
--
-- Rollback (puts the moves back on the parent and drops the _ROUTE row):
--   UPDATE agent_rules p SET action_template = (b.before->'action_template'), version = p.version + 1, updated_at = now()
--   FROM bot_change_log b WHERE b.action = 'rule_split_rehash_routing' AND b.target_id = p.id::text;
--   DELETE FROM agent_rules WHERE rule_key IN (SELECT (after->>'route_rule_key') FROM bot_change_log WHERE action = 'rule_split_rehash_routing');
