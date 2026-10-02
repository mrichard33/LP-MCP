-- 2026-10-02 — Slack alert noise cut (Mark). Info-only enrollment cards come off these rules: the
-- send_notification step is removed, every other step (tags, workflow moves, state transitions)
-- stays, and the events they record are unchanged. List mirrored in src/alert-noise.js
-- (CUT_NOTIFICATION_RULE_KEYS).
--
-- NOT here, on purpose:
--   - STATE_ROUTING_NOTIFICATION is not a rule; the "ROUTED TO S5.2 — BRANCH X" card is built in
--     src/actions/handlers/objection-state.js and is switched off there (ROUTING_NOTIFICATION_CARDS).
--   - P2_JOB_TERMINAL_WON / _LOST keep their step; it is dropped at queue time while
--     ALERT_DIGEST_ENABLED is on, so the env switch alone can bring those cards back.
--
-- Expect 7.
WITH u AS (
  UPDATE agent_rules SET
    action_template = (
      SELECT coalesce(jsonb_agg(a ORDER BY o), '[]'::jsonb)
        FROM jsonb_array_elements(action_template) WITH ORDINALITY AS x(a, o)
       WHERE a->>'action_type' IS DISTINCT FROM 'send_notification'),
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-02: send_notification removed — info-only card, no action needed (Mark, alert noise cut). The rule still runs and its events are still recorded.'
  WHERE id IN (150, 215, 269, 286, 288, 295, 296)
    AND rule_key IN ('W5_2_EXHAUSTED_ROUTE_TO_W11_0','OBJECTION_ROUTE_PRE_DEMO','ENROLL_S1_1_V3_REENGAGEMENT',
                     'ENROLL_S2_2_FROM_CHATBOT_NO_BOOK','S2_2_NO_EMAIL_EXHAUST_TO_COOLING',
                     'ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED','BACKSTOP_E0_OTHER_BOOKED_LEAD')
    AND action_template @> '[{"action_type":"send_notification"}]'::jsonb
  RETURNING 1)
SELECT count(*) FROM u;

-- Check (expect 0 rows):
-- SELECT id, rule_key FROM agent_rules WHERE id IN (150,215,269,286,288,295,296)
--   AND action_template @> '[{"action_type":"send_notification"}]'::jsonb;

-- Rule 162 DRIFT_NOTIFY_GROUPME listens for system.drift_batch_detected, which the intake filter
-- drops (0 events, 0 actions in 7 days). The once-per-contact card in drift-detector.js replaces it;
-- disabled so a future allowlist change cannot bring back a second, batched drift card. Expect 1.
WITH u AS (
  UPDATE agent_rules SET enabled = false, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-02: disabled — drift now posts one card per contact, once ever, from src/services/drift-detector.js (Mark, alert noise cut).'
  WHERE id = 162 AND rule_key = 'DRIFT_NOTIFY_GROUPME' AND enabled
  RETURNING 1)
SELECT count(*) FROM u;

-- Drift: every contact already announced (or marked announced) is marked posted for good, so the
-- once-per-contact drift card (src/services/drift-detector.js) never re-posts the backlog. Also run
-- at boot by backfillDriftPosted(); idempotent.
-- INSERT INTO audit_posted_items (audit, contact_id, reason, posted_at, permanent)
-- SELECT 'drift', replace(alert_key, 'drift:ghl_closed_lp_active:', ''), 'drift', now(), true
--   FROM alert_conditions WHERE alert_key LIKE 'drift:ghl_closed_lp_active:%'
-- ON CONFLICT (audit, contact_id, reason) DO UPDATE SET permanent = true;

-- ROLLBACK: re-apply the send_notification step from the rule's previous version (agent_rules
-- history / the seeds that created each step), e.g. sql/seeds/2026-09-09_rescission_o0_routing.sql
-- for 215. There is no automatic undo for a removed template step.
