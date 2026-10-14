-- 2026-10-14 — let a post-cancellation contact be re-routed by the trust and
-- price objection families. Before this, both existed only as from_state='*'
-- wildcards, and a wildcard row still respects the priority guard
-- (src/actions/handlers/objection-state.js, precedenceBlocks), so a contact in
-- APPOINTMENT_DISRUPTION.cancelled (50) who raised a trust or price concern (40)
-- stayed in the S5.2 rotation (gordon brack, robin smith, ben davis, pat goudy).
--
-- Additive DML, not DDL. Run in the Supabase dashboard (LP MCP instance) ONLY
-- after Mark approves. Order versus the code merge does not matter: each alone
-- changes nothing.
INSERT INTO objection_state_transitions
  (from_state, to_state, allowed, requires_approval, approval_threshold)
VALUES
  ('APPOINTMENT_DISRUPTION.cancelled', 'APPOINTMENT_FRICTION.trust_hesitation',       true, false, NULL),
  ('APPOINTMENT_DISRUPTION.cancelled', 'APPOINTMENT_FRICTION.price_anxiety_pre_demo', true, false, NULL)
ON CONFLICT (from_state, to_state) DO NOTHING;

-- Verify (expect 6 rows):
-- SELECT from_state, to_state, allowed
-- FROM objection_state_transitions
-- WHERE from_state = 'APPOINTMENT_DISRUPTION.cancelled'
-- ORDER BY to_state;
