-- 2026-10-16 — the follow-up check-in never goes to a lead who has booked since (the user).
--
-- Rule 331 FOLLOW_UP_DUE_REENGAGE texts "checking back like you asked" when a
-- follow-up hold ends (agentic.hold_completed / follow_up_due). A lead who asked
-- for a follow-up and then booked a visit during the hold would still have been
-- told we were "checking back". no_future_appointment is the same verb rules 290
-- and 294 already use on their hold completions (fail-closed: an unreadable
-- calendar suppresses the check-in).
--
-- Ships with src/agentic/follow-up-checkin.js. The rule only fires once
-- HOLD_RETURN_RECOVERY_MODE=live, so this can be applied before or after the deploy.

-- Expect 1.
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = coalesce(context_conditions, '{}'::jsonb) || '{"no_future_appointment": true}'::jsonb,
    version = coalesce(version, 1) + 1, updated_at = now(),
    notes = coalesce(notes, '') || E'\n2026-10-16: + no_future_appointment (the user): no check-in to a lead who booked during the hold.'
  WHERE rule_key = 'FOLLOW_UP_DUE_REENGAGE'
    AND NOT (coalesce(context_conditions, '{}'::jsonb) ? 'no_future_appointment')
  RETURNING 1)
SELECT count(*) FROM u;
