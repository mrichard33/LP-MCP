-- 2026-09-25_layer3_silence_audit.sql
--
-- Read-only. A Layer 3 dispatch skipped for low confidence with NO reply to
-- the same contact within 2 minutes either side — i.e. the lead got silence.
--
-- Before LAYER3_LOWCONF_FALLBACK (30 days to 2026-09-25) this returned 4 rows:
--   497154, 497148  BazzY5Ihu2heR4osVlBF  guide_send    0.6  (Mark Test)
--   489617          kMpGByubOHH9hk5yTxvv  guide_send    0.6  (Alyce)
--   448153          O3P8I7Dju6Q5Pq8blI0W  wrong_person  0.5  (Maritza Rodriguez)
--
-- After deploy it must return 0 rows for anything created after the deploy.
-- A row that does appear: read execution_result->'lowconf_fallback'->>'reason'
-- first. responder_guards_blocked / responder_stage_gate_blocked mean rule 106
-- itself would have stayed silent (stop-bot, not agentic-active, dq, …) — that
-- is policy, not this bug. Anything else is this bug.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT a.id, a.target_id, a.created_at,
         a.execution_result->>'recommended_action'                 AS recommended_action,
         a.execution_result->>'confidence'                         AS confidence,
         a.execution_result->>'threshold'                          AS threshold,
         a.execution_result->'lowconf_fallback'->>'reason'         AS fallback_reason
  FROM agent_actions a
  WHERE a.rule_applied = 'LAYER3_DISPATCH'
    AND a.action_type = 'layer3_dispatch'
    AND a.execution_result->>'reason' = 'below_confidence_threshold'
    AND a.created_at >= now() - interval '30 days'
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions m
      WHERE m.action_type = 'send_message'
        AND m.target_id = a.target_id
        AND m.created_at BETWEEN a.created_at - interval '2 minutes' AND a.created_at + interval '2 minutes'
    )
  ORDER BY a.created_at DESC
) s;
