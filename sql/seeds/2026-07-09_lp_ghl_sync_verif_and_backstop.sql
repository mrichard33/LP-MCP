-- ════════════════════════════════════════════════════════════════════
-- LP→GHL Verif disposition sync + contact backstop — 2026-07-09
--
-- WHY: Two gaps kept the GHL dashboard below LP reality even with the
--   2026-07-07 LP→GHL appointment sync live:
--     1. LP `Verif` = a live Window Estimate appointment that must exist in
--        GHL as status `new`, exactly like `Set` (Mark's rule, 2026-07-09) —
--        but the reconciler classified it `out_of_scope`.
--     2. ~30% of daily Set leads had no ghl_contact_id (I.LP-IN webhook
--        delivery misses). The contact auto-create backstop
--        (src/services/lp-contact-backstop.js + POST /admin/lp-contact-backstop,
--        scheduler env-gated ENABLE_LP_CONTACT_BACKSTOP, default off) closes
--        that on the guaranteed polling pipe — it needs NO decision-engine
--        rule (it is a sweep, not an event handler).
--
--   This file seeds only the missing piece for gap 1: a fourth
--   LP_APPT_GHL_SYNC_* rule so a disposition change to `Verif` reconciles the
--   GHL Window Estimate calendar via the SAME sync_lp_appointment_to_ghl
--   action as Set/Cnf/CXL. classifyDisposition() now maps Verif→'set'
--   (deploy the code BEFORE seeding), so the handler needs no change.
--
-- RUNNER NOTES:
--   * One statement per supabase_run_query call.
--   * Bare top-level statement (no data-modifying CTEs — the runner rejects
--     them; verified 2026-07-07). Confirm with the SELECT at the end.
--   * Idempotent: ON CONFLICT (rule_key) DO UPDATE (safe to re-run).
--   * After running: POST /n8n/decision-engine/reload-rules and assert
--     rules_loaded increased by 1 (or wait ≤60s for the cache TTL).
--
-- SHAPE NOTES (verified against decision-engine.js):
--   * event_pattern payload matching is nested equality (matchesPattern) —
--     same shape as the live LP_APPT_GHL_SYNC_SET/CNF/CXL rules.
--   * createActionsFromRule takes target_id from event.ghl_contact_id and
--     skips unlinked leads automatically (the backstop handles those).
--   * params.disposition_code is informational: the handler re-reads the
--     authoritative newest lp_leads row and reconciles from it.
--   * priority 20 = the time-sensitive appointment lane.
--
-- COEXISTENCE: the stale-appt tag rules and I.LP-IN's booking branch also
--   still fire on these events — separate defects with their own pending
--   fixes; the reconciler's idempotent same-time skip makes the race benign.
-- ════════════════════════════════════════════════════════════════════

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'LP_APPT_GHL_SYNC_VERIF',
  'LP Verif → GHL Window Estimate sync (create/reschedule, never downgrade)',
  'appointment', 'pattern',
  '{"event_type": "lp.disposition_changed", "payload": {"disposition_code": "Verif"}}'::jsonb,
  NULL, NULL,
  '[{"action_type": "sync_lp_appointment_to_ghl", "target_system": "ghl", "target_entity": "contact", "priority": 20, "params": {"disposition_code": "Verif"}}]'::jsonb,
  false, true, 20, 'claude',
  'LP→GHL appointment authority (2026-07-09). LP Verif is a live Window Estimate appointment, same as Set: create WE appointment status new, or reschedule in place if time differs; same-time no-op never downgrades a confirmed. Handler re-reads newest lp_leads row; classifyDisposition maps Verif→set.'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- Verification (run as its own call; expect 4 rows, all enabled=true):
-- SELECT rule_key, enabled, priority FROM agent_rules WHERE rule_key LIKE 'LP_APPT_GHL_SYNC_%' ORDER BY rule_key;
