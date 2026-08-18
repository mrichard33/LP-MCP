-- ════════════════════════════════════════════════════════════════════
-- RULE 324 (HOT_CALL_IMMEDIATE) — calm callback_request must reach the dialer
-- 2026-08-18  (durable record; pairs with PR "fix: callback dial path")
--
-- WHY: 2026-08-18 17:28–17:32Z, contact KE2VqAhWZ91iCdmwAmmx (John
--   Czeropski) — two ai.analysis_completed events (ids 2940885, 2940982),
--   both recommended_action=callback_request +
--   requested_fulfillment=phone_call. The outbound SMS promised "someone
--   will ring you within the next few minutes." HOT_CALL_IMMEDIATE never
--   fired: its context_conditions carried
--     payload_message_matches: "\b(call me now|right now|now works|call now|asap|immediately)\b"
--   an URGENCY-TEXT gate. John was polite — "hi Mark what's a phone number
--   at which I can call you?" and "yes and thanks" contain none of those
--   phrases — so the rule stayed silent and no LP push (= no dial) happened.
--   The engine matcher itself is fine (conditions evaluate correctly); the
--   gate was simply wrong. Politeness must not cost the customer the
--   callback: the analyzer's requested_fulfillment=phone_call IS the signal,
--   calm or urgent (calm variant carries call_purpose=general_questions).
--
-- PHASE 1 — WIDEN THE TRIGGER (apply immediately; safe with deployed code):
--   conditions become recommended_action=callback_request AND
--   requested_fulfillment=phone_call (payload_field_eq — engine-verified
--   operator, src/decision-engine.js). The existing action_template still
--   applies: trigger-hot-call tag → GHL workflow 8e30ff37 addlead → LP
--   inbound → LP_ASAP push → DIAL ASAP dials (~4s measured on lead 567746).
--
-- PHASE 2 — RE-QUEUE WITH GUARDRAILS (apply ONLY after the PR carrying
--   src/actions/handlers/lp-requeue.js is merged AND the Railway deploy is
--   ACTIVE — the action_type is unknown to older code):
--   replaces the bare trigger-hot-call tag with the lp_callback_requeue
--   action: dedup window, queue precondition (no second LeadAdd when an
--   existing lead is already dialable in a Data queue), UpdateProspectInfo
--   address repair before dispatch, srs_id UNCHANGED, sender/user2 re-queue
--   markers, and the verification sweep that escalates to priority GroupMe
--   if the lead does not become dialable inside the bounded window.
-- ════════════════════════════════════════════════════════════════════

-- ── PHASE 1 — widen conditions (applied live 2026-08-18, see PR body) ──
BEGIN;
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = '{
      "not_has_tag": "stop-bot",
      "recommended_action_eq": "callback_request",
      "payload_field_eq": { "field": "requested_fulfillment", "value": "phone_call" }
    }'::jsonb,
    notes = 'Bot 2/3/4 consolidation A7 (2026-07-06); WIDENED 2026-08-18 (John Czeropski, KE2VqAhWZ91iCdmwAmmx): the old payload_message_matches urgency regex missed calm callback requests — events 2940885/2940982 carried recommended_action=callback_request + requested_fulfillment=phone_call and the rule stayed silent while the SMS promised a call within minutes. Trigger is now callback_request + phone_call, urgent or calm. Composes with the callback_request dispatch reply. The LP push IS the dial trigger (LP -> LP_ASAP -> DIAL ASAP, ~4s measured).',
    version = version + 1,
    updated_at = now()
  WHERE rule_key = 'HOT_CALL_IMMEDIATE'
  RETURNING 1
)
SELECT count(*) AS updated FROM u;  -- expect 1
COMMIT;

-- ── PHASE 2 — swap tag-chain for the guarded re-queue action ──────────
-- DO NOT APPLY until the lp_callback_requeue handler is deployed ACTIVE.
BEGIN;
WITH u AS (
  UPDATE agent_rules SET
    action_template = '[
      {
        "params": {},
        "action_type": "lp_callback_requeue",
        "target_entity": "contact",
        "target_system": "lp"
      },
      {
        "params": {
          "tier": "Hot",
          "status": "Call Now",
          "message": "Lead wants a call. Reply: \"{{message_text}}\"",
          "narrative": "Callback requested (phone_call) — LP re-queue pushed with dedup + queue precondition + address repair. LP feeds LP_ASAP; DIAL ASAP dials. ACTION: expect the dialer to ring them within minutes; verification sweep escalates if it does not.",
          "next_step": "Dialer rings them via LP_ASAP; verify sweep escalates if the lead does not become dialable",
          "action_verb": "HOT CALL",
          "notification_class": "priority"
        },
        "action_type": "send_notification",
        "target_entity": "contact",
        "target_system": "groupme"
      },
      {
        "params": {
          "next_step": "Callback requested — LP re-queue is the dial trigger.",
          "include_context_summary": true
        },
        "action_type": "add_note",
        "target_entity": "contact",
        "target_system": "ghl"
      }
    ]'::jsonb,
    version = version + 1,
    updated_at = now()
  WHERE rule_key = 'HOT_CALL_IMMEDIATE'
  RETURNING 1
)
SELECT count(*) AS updated FROM u;  -- expect 1
COMMIT;

-- Verification:
--   SELECT json_agg(row_to_json(s)) FROM (
--     SELECT id, rule_key, version, enabled, context_conditions, action_template
--     FROM agent_rules WHERE rule_key = 'HOT_CALL_IMMEDIATE') s;
--   Replay test: scripts/test-hot-call-immediate-match.js replays event
--   2940982''s live payload through the engine evaluator — old conditions
--   block, new conditions pass.
-- Reload required after EACH phase:
--   POST /n8n/decision-engine/reload-rules  (assert rules_loaded unchanged —
--   this edits an already-enabled rule, so the count delta is 0)
-- Rollback:
--   Phase 1: restore context_conditions to
--     '{"not_has_tag":"stop-bot","recommended_action_eq":"callback_request",
--       "payload_message_matches":"\\b(call\\s+me\\s+now|right\\s+now|now\\s+works|call\\s+now|asap|immediately)\\b"}'
--   Phase 2: restore the original 3-action template (add_tag trigger-hot-call
--     + send_notification + add_note — see agent_rules history / this file''s
--     git history), then reload.
