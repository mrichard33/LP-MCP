-- ════════════════════════════════════════════════════════════════════
-- DNC-lift on re-engagement + RECONCILE recovery guard
-- 2026-07-11
--
-- WHAT: the system took NO action when a DNC'd / hard-loss contact later
--   received an Appointment Set / Confirmed disposition. A DNC that a
--   subsequent confirmed booking has already invalidated was left in place,
--   suppressing a live, bookable lead. Policy (Mark): DNC lifts on
--   re-initiation / booking. Two canaries, same missing rule:
--     - Bianco 546771 (lAJz6tfGcrFeDLTfJ8wa): CXL → mid-call DNC (15:10) →
--       rep re-confirm; LP flipped DNC→Cnf (15:27) + Five9 Appointment Set
--       (15:29) / Confirmed (15:37). Nothing lifted the DNC. Final LP truth
--       Cnf + live 10:00 appt; GHL still fully DNC-stacked.
--     - Mcgee 350476 (mNmXCZW9WPedxFuwf6Gi): DNC came from a stale duplicate
--       lead 556316 (last contact Aug 2025) that — via newest-lead-wins —
--       buried the booked sibling lead 556298 (Set). Cross-lead shape.
--
-- This seed adds the LP + Five9 lift rules and hardens RECONCILE. It pairs
-- with code in the SAME branch (see DEPLOY ORDER):
--   - decision-engine.js: `event_subtype_in` condition operator; multi-lead
--     DNC-duplicate carve-out (booked sibling no longer buried by a DNC dup).
--   - actions/index.js: mutation-gate `bypass_suppression` flag (lets the lift
--     REMOVE stop-bot/lp-dnc from a stop-bot contact — the DNC otherwise blocks
--     its own removal).
--   - actions/handlers/objection-state.js: `resolve_objection_state` action
--     (hard_loss is transition-terminal, so it must be RESOLVED, not transitioned).
--   - services/lp-ghl-appointment-reconciler.js: LP 'confirm' bypasses the
--     dnc_consent guard (Cnf is the confirmation authority + reconsent signal).
--
-- ⚠ DEPLOY ORDER — apply this seed ONLY AFTER the branch code is deployed:
--   * `event_subtype_in` is a NEW operator. Unknown operators FAIL CLOSED
--     (evaluateContextConditions default), so pre-deploy the lift rules simply
--     never match — safe, but inert.
--   * `resolve_objection_state` is a NEW action type; pre-deploy it would fail
--     as "Unknown action type".
--   * `bypass_suppression` is a NEW gate flag; pre-deploy the lift's remove_tag
--     actions would be suppressed by stop-bot (the very bug this fixes).
--   Sequence: merge+deploy code (Railway) → run this seed → POST
--   /n8n/decision-engine/reload-rules.
--
-- DEPLOYMENT (per session decision, mirrors BACKSTOP_E0_OTHER_BOOKED_LEAD):
--   * requires_approval = TRUE — every lift queues as pending_approval until
--     validated on a live batch (this clears DNC/consent state; roll out
--     supervised). Flip to FALSE (re-run with the flag changed, then
--     reload-rules) once confirmed correct on real re-engagement events.
--   * Bare top-level statements (one per supabase_run_query call).
-- ════════════════════════════════════════════════════════════════════

-- ── Rule A1: LP disposition → booking on a DNC'd contact ──────────────
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'DNC_LIFT_ON_REENGAGEMENT_LP',
  'DNC-lift on re-engagement (LP Set/Cnf/Verif after DNC) → clear suppression stack',
  'reconciliation', 'contextual',
  '{"event_type": "lp.disposition_changed"}'::jsonb,
  '{
    "has_any_tag": ["stage:dnc", "lp-dnc", "dnc", "dnc-sms", "loss-reason:dnc"],
    "event_subtype_in": ["Set", "Cnf", "Verif"]
  }'::jsonb,
  '[
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "stop-bot", "bypass_suppression": true}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "lp-dnc", "bypass_suppression": true}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "loss-reason:dnc", "bypass_suppression": true}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "mark-p1-lost", "bypass_suppression": true}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "suppress-automation", "bypass_suppression": true}},
    {"action_type": "set_stage", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "stage:booked-main-appointment", "bypass_suppression": true}},
    {"action_type": "move_opportunity", "target_system": "ghl", "target_entity": "opportunity", "priority": 5,
     "params": {"pipeline": "P1", "stage": "Appointment Booked", "status": "open", "bypass_suppression": true}},
    {"action_type": "resolve_objection_state", "target_system": "lp", "target_entity": "contact", "priority": 5,
     "params": {"resolution": "recovered", "trigger_source": "LP_WEBHOOK",
       "only_if_state": ["DISENGAGEMENT.hard_loss", "DISENGAGEMENT.soft_opt_out", "DISENGAGEMENT.cannot_afford_pursuing_assistance"]}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "recovery:dnc-lifted", "bypass_suppression": true}},
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "params": {"notification_class": "intelligence", "action_verb": "DNC LIFTED: re-engagement booking",
       "tier": "Recovered", "status": "Auto-lifted",
       "message": "A DNC/hard-loss contact received a booking disposition (Set/Cnf/Verif) — cleared the suppression stack so the booking proceeds.",
       "narrative": "DNC-lift fired for {{contact_name}}: the contact was DNC/hard-loss but LP now shows a booking disposition. Removed stop-bot / lp-dnc / loss-reason:dnc / mark-p1-lost / suppress-automation, moved back to P1 Appointment Booked, resolved the loss objection-state (recovered). The LP Cnf→GHL confirm-sync now proceeds.",
       "next_step": "Confirm the appointment mirrored/confirmed in GHL; investigate why the DNC landed mid-recovery (data-quality)."}}
  ]'::jsonb,
  true, true, 15, 'claude',
  'DNC-lift on re-engagement (LP arm). Fires when a contact still carrying a DNC/loss marker gets an LP booking disposition. bypass_suppression lets the removals run on a stop-bot contact. Pairs with the Five9 arm + RECONCILE guard in this seed and the branch code (event_subtype_in, bypass_suppression gate, resolve_objection_state, confirm consent-bypass). requires_approval=TRUE until validated; flip to FALSE then reload-rules.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- ── Rule A2: Five9 Appointment Set / Confirmed on a DNC'd contact ─────
-- Backstop for a Five9-only confirm (no accompanying LP disposition change).
-- Same suppression-clear; the appointment sync is driven by the paired LP
-- Cnf when present.
INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'DNC_LIFT_ON_REENGAGEMENT_FIVE9',
  'DNC-lift on re-engagement (Five9 Appointment Set/Confirmed after DNC) → clear suppression stack',
  'reconciliation', 'contextual',
  '{"event_type": "five9.disposition_set"}'::jsonb,
  '{
    "has_any_tag": ["stage:dnc", "lp-dnc", "dnc", "dnc-sms", "loss-reason:dnc"],
    "event_subtype_in": ["Appointment Set", "Confirmed"]
  }'::jsonb,
  '[
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "stop-bot", "bypass_suppression": true}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "lp-dnc", "bypass_suppression": true}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "loss-reason:dnc", "bypass_suppression": true}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "mark-p1-lost", "bypass_suppression": true}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "suppress-automation", "bypass_suppression": true}},
    {"action_type": "set_stage", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "stage:booked-main-appointment", "bypass_suppression": true}},
    {"action_type": "move_opportunity", "target_system": "ghl", "target_entity": "opportunity", "priority": 5,
     "params": {"pipeline": "P1", "stage": "Appointment Booked", "status": "open", "bypass_suppression": true}},
    {"action_type": "resolve_objection_state", "target_system": "lp", "target_entity": "contact", "priority": 5,
     "params": {"resolution": "recovered", "trigger_source": "EXTERNAL_API",
       "only_if_state": ["DISENGAGEMENT.hard_loss", "DISENGAGEMENT.soft_opt_out", "DISENGAGEMENT.cannot_afford_pursuing_assistance"]}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "recovery:dnc-lifted", "bypass_suppression": true}},
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "params": {"notification_class": "intelligence", "action_verb": "DNC LIFTED: Five9 re-book",
       "tier": "Recovered", "status": "Auto-lifted",
       "message": "A DNC/hard-loss contact got a Five9 Appointment Set/Confirmed — cleared the suppression stack.",
       "narrative": "DNC-lift (Five9 arm) fired for {{contact_name}}: a Five9 Appointment Set/Confirmed disposition landed on a DNC/hard-loss contact. Cleared the suppression stack and resolved the loss objection-state.",
       "next_step": "Confirm the paired LP disposition/appointment sync completed; investigate the mid-recovery DNC."}}
  ]'::jsonb,
  true, true, 15, 'claude',
  'DNC-lift on re-engagement (Five9 arm). event_subtype for five9.disposition_set is the disposition_name. Backstop for a Five9-only confirm; appointment sync driven by the paired LP Cnf. requires_approval=TRUE until validated; flip to FALSE then reload-rules.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- ── Defect C: RECONCILE must not re-assert DNC to LP on a recovery ────
-- RECONCILE_LP_DNC_ON_LINK fired on EVERY lp.disposition_changed for a
-- dnc/dnc-sms contact and re-asserted DNC-P to LP — even when the disposition
-- had just flipped TO a booking (Bianco 15:27, DNC→Cnf). For lp.disposition_changed
-- the event_subtype IS the new disposition code, so event_subtype_not_in skips
-- the re-assert whenever the change is to a booking.
UPDATE agent_rules
SET conditions = jsonb_set(
      COALESCE(conditions, '{}'::jsonb),
      '{event_subtype_not_in}',
      '["Set", "Cnf", "Verif"]'::jsonb,
      true
    ),
    notes = COALESCE(notes || ' ', '') || '2026-07-11: added event_subtype_not_in [Set,Cnf,Verif] so a recovery (DNC→booking) no longer re-asserts DNC-P.',
    updated_at = now()
WHERE rule_key = 'RECONCILE_LP_DNC_ON_LINK';
