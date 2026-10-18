-- 2026-10-18 — Phase 1 item 2: the watchdog's hint contradicted the closer rule.
--
-- Rule 228 AGENTIC_ACTIVE_REPLY_BACKSTOP's prompt_hint said "then move toward the booking on every turn and never
-- end without a next step". That contradicts the closer step (a lead's sign-off gets one matching line and no
-- question, 2026-10-17) and the two-no's rule (two no's stop the selling). Those two clauses go; nothing else in
-- the hint changes (the rest moves to the policy file in Phase 2). One bot_change_log row records it.
--
-- Safe to apply before or after the Phase 1 deploy (a prompt_hint is read per action). Then
-- POST /n8n/decision-engine/reload-rules.

-- Expect 1, then 1.
WITH before AS (
  SELECT id, action_template FROM agent_rules
   WHERE rule_key = 'AGENTIC_ACTIVE_REPLY_BACKSTOP'
     AND action_template->0->'params'->>'prompt_hint' LIKE '%then move toward the booking on every turn and never end without a next step.%'
), u AS (
  UPDATE agent_rules r SET
    action_template = jsonb_set(r.action_template, '{0,params,prompt_hint}', to_jsonb(replace(
      r.action_template->0->'params'->>'prompt_hint',
      'Read the last few turns, answer what they actually asked in one or two sentences, then move toward the booking on every turn and never end without a next step.',
      'Read the last few turns and answer what they actually asked in one or two sentences.'))),
    version = coalesce(r.version, 1) + 1, updated_at = now(),
    notes = coalesce(r.notes, '') || E'\n2026-10-18 (Phase 1 item 2): removed "move toward the booking on every turn" and "never end without a next step" (they contradicted the closer and two-no rules).'
  FROM before b WHERE r.id = b.id
  RETURNING r.id, r.action_template
), log AS (
  INSERT INTO bot_change_log (actor, action, target_table, target_id, reason, before, after)
  SELECT 'claude', 'prompt_hint_edited', 'agent_rules', u.id::text, 'Phase 1: watchdog hint contradicted closer rule',
         jsonb_build_object('prompt_hint', b.action_template->0->'params'->>'prompt_hint'),
         jsonb_build_object('prompt_hint', u.action_template->0->'params'->>'prompt_hint')
    FROM u JOIN before b ON b.id = u.id
  RETURNING 1
)
SELECT (SELECT count(*) FROM u) AS rules_updated, (SELECT count(*) FROM log) AS log_rows;

-- Rollback: the before value is in bot_change_log (action 'prompt_hint_edited', target agent_rules / 228):
-- UPDATE agent_rules SET action_template = jsonb_set(action_template, '{0,params,prompt_hint}', to_jsonb(
--   (SELECT before->>'prompt_hint' FROM bot_change_log WHERE action = 'prompt_hint_edited' AND target_id = '228' ORDER BY id DESC LIMIT 1)))
--  WHERE rule_key = 'AGENTIC_ACTIVE_REPLY_BACKSTOP';
