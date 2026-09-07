-- =====================================================================
-- 2026-09-07 — HOT_CALL_IMMEDIATE (#324): escalate_to_rep → Callback Request
--               list, both branches gated on customer_relationship
--
-- RUN ONLY AFTER message-analyzer v1.12 / context-builder v2.9 IS LIVE AND
-- ai.analysis_completed rows show payload->>'customer_relationship' populated.
-- The condition switch fails closed on a missing payload field, so landing
-- this early would silence the ONLY path into the Five9 Callback Request
-- list — calm callback requests included.
--
-- WHAT: replaces context_conditions on rule 324 with
--   not_has_tag: stop-bot
--   payload_field_in: customer_relationship ∈ {prospect, returning_customer}
--   any_of: [ {recommended_action_eq: callback_request,
--              payload_field_eq: requested_fulfillment = phone_call},
--             {recommended_action_eq: escalate_to_rep,
--              payload_field_null: escalation_category} ]
--
-- WHY: 2026-09-07, contact 19zXvwBKo8RISXbafGHC (event 3460420) — a prospect's
-- cancelled-appointment complaint came back escalate_to_rep, never
-- callback_request, so this rule did not fire. Six other rules did: 24 actions
-- (tasks/notes/notifications), zero dials, two days with nobody calling him.
-- Mark's ruling: a plain sales escalation must reach the dialer.
--
-- The rule had NO customer-service exclusion (none in callback-push.js
-- either). All 24 matching events in the prior 60 days had a null
-- escalation_category — luck, not design. customer_relationship (emitted by
-- analyzer v1.12) now gates both branches, so a service customer who says
-- "just call me" goes to a service task, not the sales dialer.
--
-- Blast radius (30 days to 2026-09-07): callback_request+phone_call ran 17
-- events / 11 contacts; escalate_to_rep ran 45 events / 34 contacts, ~15 of
-- which carried service tags and are now excluded by the relationship gate.
-- Expect roughly +20–30 pushes / 30 days from the new branch.
--
-- ROLLBACK is at the bottom of this file.
-- =====================================================================

-- Pre-check: current state of the rule and that the analyzer field is live.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, rule_key, enabled, priority, requires_approval, version,
         context_conditions,
         context_conditions ? 'any_of' AS already_has_any_of
  FROM agent_rules WHERE rule_key = 'HOT_CALL_IMMEDIATE'
) s;

-- MUST be > 0 before applying. If 0, the analyzer deploy is not live; STOP.
SELECT count(*) AS analyses_with_relationship_last_2h
FROM system_events
WHERE event_type = 'ai.analysis_completed'
  AND created_at >= now() - interval '2 hours'
  AND payload ? 'customer_relationship';

-- Apply. Full replacement of context_conditions (not a merge) so the old
-- top-level recommended_action_eq / payload_field_eq cannot AND against the
-- new any_of and silently narrow it back to callback_request only.
WITH u AS (
  UPDATE agent_rules
  SET context_conditions = jsonb_build_object(
        'not_has_tag', 'stop-bot',
        'payload_field_in', jsonb_build_object(
          'field',  'customer_relationship',
          'values', jsonb_build_array('prospect', 'returning_customer')
        ),
        'any_of', jsonb_build_array(
          jsonb_build_object(
            'recommended_action_eq', 'callback_request',
            'payload_field_eq', jsonb_build_object('field', 'requested_fulfillment', 'value', 'phone_call')
          ),
          jsonb_build_object(
            'recommended_action_eq', 'escalate_to_rep',
            'payload_field_null', 'escalation_category'
          )
        )
      ),
      notes = coalesce(notes, '') ||
        E'\n[2026-09-07 Claude] Widened to escalate_to_rep with null '
        'escalation_category (Shawn Friend, 19zXvwBKo8RISXbafGHC, event '
        '3460420: 24 actions, zero dials). Both branches now gated on '
        'customer_relationship in {prospect, returning_customer} so '
        'customer-service contacts never reach the sales dialer. Requires '
        'message-analyzer v1.12 (emits the field). Fails closed on legacy '
        'events without it.',
      version = version + 1
  WHERE rule_key = 'HOT_CALL_IMMEDIATE'
    AND NOT (context_conditions ? 'any_of')   -- idempotent; skip if already applied
  RETURNING 1
)
SELECT count(*) AS rules_updated FROM u;   -- EXPECT 1

-- Post-check.
SELECT json_agg(row_to_json(s)) FROM (
  SELECT rule_key, version, context_conditions
  FROM agent_rules WHERE rule_key = 'HOT_CALL_IMMEDIATE'
) s;

-- Then reload the Decision Engine and assert enabled count is unchanged at 279
-- (no rule is added or enabled by this seed):
--   POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules

-- =====================================================================
-- ROLLBACK — restores the exact pre-change conditions (verified 2026-09-07).
-- =====================================================================
-- WITH u AS (
--   UPDATE agent_rules
--   SET context_conditions = jsonb_build_object(
--         'not_has_tag', 'stop-bot',
--         'payload_field_eq', jsonb_build_object('field', 'requested_fulfillment', 'value', 'phone_call'),
--         'recommended_action_eq', 'callback_request'
--       ),
--       notes = coalesce(notes, '') || E'\n[rollback] 2026-09-07 rule324 seed reverted.',
--       version = version + 1
--   WHERE rule_key = 'HOT_CALL_IMMEDIATE'
--   RETURNING 1
-- )
-- SELECT count(*) FROM u;   -- then reload the engine
