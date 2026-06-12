-- ════════════════════════════════════════════════════════════════════
-- S1.3 Booking-Push Timeout → Universal Dynamic Hold → S2.2
-- 2026-06-12
--
-- WHAT: wires the first consumer of the universal Agentic Dynamic Hold.
--   1. S13_LANE3_INTERESTED gains an issue_hold action: after sending the PPR
--      booking link to a warm non-booker, park them 72h in the Dynamic Hold.
--   2. On hold completion the Dynamic Hold POSTs /api/agentic/hold-complete,
--      which emits agentic.hold_completed (event_subtype = return_to). Two new
--      rules branch on it:
--        - S13_BOOKING_PUSH_TIMEOUT_REISSUE — conversation still alive
--          (inbound within 24h) → re-issue the same 72h hold, stop.
--        - S13_BOOKING_PUSH_TIMEOUT_TO_S22  — gone silent (no inbound 24h) AND
--          not booked (no future appt) → swap stage:re-engagement →
--          stage:indoctrination, enroll S2.2 (W1.2), 🧠 GroupMe note.
--        - Booked (future appt) → neither rule fires → natural no-op.
--
-- EXECUTION CONTRACT (HARD ORDER — fail-open hazard):
--   * Run AFTER the LP-MCP code deploy that adds the context verbs
--     (no_future_appointment, no_inbound_within_hours, inbound_within_hours),
--     the issue_hold action, and the 'agentic.hold_completed' intake-filter
--     allowlist entry. Unknown verbs hit the engine's default: case and FAIL
--     OPEN (the rule fires without the gate) — running this first would let
--     REISSUE/TO_S22 fire ungated.
--   * STAGED: do NOT run live until Mark confirms the GHL concurrency test on
--     the Dynamic Hold (its result decides ship-as-is vs. adding a
--     serialization constraint; brain-side serialization is already ON in
--     executeIssueHold via HOLD_SERIALIZATION_ENABLED).
--   * Bare top-level statements only (one per supabase_run_query call).
--   * After running: POST /n8n/decision-engine/reload-rules.
--
-- FAILURE-POLICY INVARIANT (asymmetric, deliberate):
--   inbound_within_hours FAILS CLOSED, no_inbound_within_hours FAILS OPEN. If
--   the GHL message lookup is down, REISSUE is blocked and only TO_S22 can fire
--   — exactly one timeout rule wins, biased toward progress. TO_S22 is itself
--   idempotent via not_has_tag stage:indoctrination (S2.2 is allowMultiple=true,
--   so GHL will NOT dedupe a duplicate completion).
--
-- S2.2 ENROLLMENT NOTE (verify before enable):
--   ea3c3aed-77a4-470d-bc3c-1b1765bfff3b is the W1.2 WORKFLOW id (confirmed in
--   src/workflow-completion-handler.js). The rule enrolls via Route A
--   (action_payload.workflow_id → POST /contacts/{id}/workflow/{wfId}). If S2.2
--   must instead be entered through its inbound-webhook trigger (to pass
--   enrollment context, or if the workflow has no API-addable entry), replace
--   the add_to_workflow params with Route B:
--     {"webhook_url":"https://services.leadconnectorhq.com/hooks/<LOC>/webhook-trigger/<S2.2 inbound trigger id>","format":"json","payload":{...}}
--   and verify the trigger id in GHL first.
-- ════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────
-- 1. S13_LANE3_INTERESTED — append issue_hold (idempotent via @> guard)
-- ────────────────────────────────────────────────────────────────────
UPDATE agent_rules
SET action_template = action_template || '[
  {"action_type": "issue_hold", "target_system": "ghl", "target_entity": "contact",
   "params": {"hold_hours": 72, "return_to": "booking_push_timeout_s13",
     "hold_reason": "S1.3 booking link sent, awaiting booking", "workflow_code": "S1.3"}}
]'::jsonb,
notes = COALESCE(notes, '') || ' | 2026-06-12: +issue_hold (72h, return_to=booking_push_timeout_s13) — warm non-booker parked in Dynamic Hold; completion routes via S13_BOOKING_PUSH_TIMEOUT_*.',
updated_at = now()
WHERE rule_key = 'S13_LANE3_INTERESTED'
  AND NOT (action_template @> '[{"action_type": "issue_hold"}]'::jsonb);

-- ────────────────────────────────────────────────────────────────────
-- 2. S13_BOOKING_PUSH_TIMEOUT_REISSUE — conversation alive → re-hold
--    inbound_within_hours FAILS CLOSED: unknown inbound age cannot fire this.
-- ────────────────────────────────────────────────────────────────────
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'S13_BOOKING_PUSH_TIMEOUT_REISSUE',
  'S1.3 booking-push timeout — conversation alive → re-issue 72h hold',
  'S13_REPLY_LANES', 'contextual',
  '{"event_type": "agentic.hold_completed", "event_subtype": "booking_push_timeout_s13"}'::jsonb,
  '{
    "has_tag_prefix": "sent:s1.3-",
    "not_has_any_tag": ["suppress-outbound", "mark-p1-lost", "stop-bot", "do-not-contact"],
    "inbound_within_hours": 24
  }'::jsonb,
  '[
    {"action_type": "issue_hold", "target_system": "ghl", "target_entity": "contact",
     "params": {"hold_hours": 72, "return_to": "booking_push_timeout_s13",
       "hold_reason": "S1.3 booking link sent, awaiting booking", "workflow_code": "S1.3"}}
  ]'::jsonb,
  false, true, 85, 'claude',
  'Conversation still alive at hold expiry (inbound within 24h) → re-arm the same 72h hold, nothing else. inbound_within_hours fails closed so a message-layer outage cannot fire this alongside TO_S22. Brain-side serialization in executeIssueHold prevents a stacked hold if both somehow fire.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- ────────────────────────────────────────────────────────────────────
-- 3. S13_BOOKING_PUSH_TIMEOUT_TO_S22 — silent & not booked → S2.2
--    not_has_tag stage:indoctrination = duplicate-enrollment guard (S2.2 is
--    allowMultiple=true). no_inbound_within_hours FAILS OPEN; no_future_appointment
--    fails open on lookup error.
-- ────────────────────────────────────────────────────────────────────
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'S13_BOOKING_PUSH_TIMEOUT_TO_S22',
  'S1.3 booking-push timeout — warm non-booker → S2.2 indoctrination',
  'S13_REPLY_LANES', 'contextual',
  '{"event_type": "agentic.hold_completed", "event_subtype": "booking_push_timeout_s13"}'::jsonb,
  '{
    "has_tag_prefix": "sent:s1.3-",
    "not_has_any_tag": ["suppress-outbound", "mark-p1-lost", "stop-bot", "do-not-contact"],
    "not_has_tag": "stage:indoctrination",
    "no_inbound_within_hours": 24,
    "no_future_appointment": true
  }'::jsonb,
  '[
    {"action_type": "set_stage", "target_system": "ghl", "target_entity": "contact",
     "params": {"tag": "stage:indoctrination"}},
    {"action_type": "add_to_workflow", "target_system": "ghl", "target_entity": "contact",
     "params": {"workflow_id": "ea3c3aed-77a4-470d-bc3c-1b1765bfff3b",
       "workflow_name": "W1.2 - Canvassing/Chatbot Indoctrination", "canonical_code": "S2.2"}},
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "params": {"notification_class": "intelligence", "action_verb": "S1.3 → S2.2 INDOCTRINATION",
       "tier": "Warm", "status": "Auto-enrolled",
       "message": "S1.3 warm non-booker timed out without booking — moved to S2.2.",
       "narrative": "S1.3 warm non-booker → S2.2 indoctrination: {{contact_name}}. The 72h booking-push hold expired with no inbound in 24h and no future appointment, so the lead was auto-enrolled in the S2.2 (W1.2) indoctrination SOS and the stage tag swapped re-engagement → indoctrination.",
       "next_step": "None — automated re-engagement; monitor for reply"}}
  ]'::jsonb,
  false, true, 85, 'claude',
  'Hold expired, conversation dead (no inbound 24h), not booked → indoctrinate. set_stage swaps stage:re-engagement → stage:indoctrination (one-stage-tag invariant) AND is the dedupe guard: not_has_tag stage:indoctrination makes every duplicate hold-completion inert (S2.2 allowMultiple=true, GHL will not dedupe). Booked leads have a future appt → no_future_appointment blocks → no-op. add_to_workflow is Route A (W1.2 workflow id); see header note for the Route B inbound-trigger alternative.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- After running these three statements: POST /n8n/decision-engine/reload-rules
