-- 110_appt_rescheduled_rule.sql
-- Route lp.appointment_rescheduled to the LP→GHL appointment sync (WO-4a).
--
-- STATUS: NOT APPLIED. Apply from the Supabase dashboard (LP instance), then
-- RELOAD the decision engine and assert rules_loaded went up by one. A rule
-- row that is inserted but not reloaded is not live — never assume the reload
-- happened. Re-running this file is idempotent (ON CONFLICT DO UPDATE).
--
-- ══ WHY ══
-- LP→GHL appointment sync fired only on `lp.disposition_changed`. An LP
-- reschedule that did not change the disposition emitted nothing, so
-- reconcileLpAppointmentToGhl never ran and GHL kept the old date — holding a
-- stale slot and double-counting the appointment across two days.
--
-- Telemetry, 30 days: appt.booking = 2,823 `created`, 34
-- `noop_already_exists`, ONE `updated`. The reconciler has handled reschedules
-- correctly the whole time — planReconciliation() returns reschedule /
-- reschedule_confirm on a start-time mismatch, and the PUT path is live-
-- verified with ignoreFreeSlotValidation. It was simply never invoked.
--
-- Canary: prospect 230117 / lead 575494 (Pat Maidment, GHL contact
-- 3a3rAaHxnICmykJKGDt1). 9/12 18:39Z lp.disposition_changed:Cnf → 18:41Z
-- appt.booking:created for 2026-09-14 10:00, appt vZGuTDlgYJk9vohBTWoF. 9/13
-- 16:25Z LP moved it to 2026-09-15 10:00, disposition unchanged. No event
-- followed. GHL still holds 9/14.
--
-- ══ TWO DESIGN CHOICES, AND WHY ══
--
--  1. THE PATTERN MATCHES ON EVENT TYPE ONLY — no disposition_code. The
--     producer (src/sync-leads.js via services/appointment-reschedule-emit.js)
--     already restricts the emit to Set / Verif / Cnf, so one rule covers all
--     three. The three LP_APPT_GHL_SYNC_* rules split by code because each code
--     means a different ACTION (set / confirm / cancel); a reschedule means the
--     same action whatever the code.
--
--  2. THE ACTION CARRIES NO disposition_code PARAM. The handler
--     (src/actions/handlers/lp-ghl-appointment-sync.js:179) uses
--     `lead.disposition_code` off the authoritative lp_leads row and only WARNS
--     when a payload code disagrees. Hard-coding one code here would log a
--     spurious warning on the other two while changing nothing.
--
-- CXL is deliberately NOT routed here — rule 271 owns cancels, and the producer
-- does not emit for CXL at all.
--
-- ══ VOLUME GATE (checked 2026-09-14, before merge) ══
-- Leads whose appt_date changed to a different non-null value with the
-- disposition unchanged, from lp_lead_disposition_history over eight days:
-- 2, 4, 2, 4, 5, 7, 5, 4 per day. ~4/day against a ~50/day stop threshold, so
-- this is not a storm risk against the decision engine. (Lower bound: daily
-- snapshot grain, so intra-day churn is invisible.)

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, conditions, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'LP_APPT_GHL_SYNC_RESCHEDULED',
  'LP appointment-date change → GHL Window Estimate reschedule (disposition unchanged)',
  'appointment', 'pattern',
  '{"event_type": "lp.appointment_rescheduled"}'::jsonb,
  NULL, NULL,
  '[{"action_type": "sync_lp_appointment_to_ghl", "target_system": "ghl", "target_entity": "contact", "priority": 20}]'::jsonb,
  false, true, 20, 'claude',
  'WO-4a (2026-09-14). LP→GHL appointment authority: propagate a reschedule that did NOT change the disposition. Producer restricts to Set/Verif/Cnf and skips CXL (rule 271 owns cancels), so the pattern needs no disposition_code and the action carries none — the handler re-reads the authoritative lp_leads row and only warns on a payload/row mismatch. Before this rule the reconciler was never invoked on a date-only move: 30-day appt.booking was 2,823 created against ONE updated.'
  )
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  context_conditions = EXCLUDED.context_conditions, action_template = EXCLUDED.action_template,
  requires_approval = EXCLUDED.requires_approval, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();

-- Verification (run as its own call; expect 4 rows, all enabled = true):
-- SELECT rule_key, enabled, priority FROM agent_rules
--  WHERE rule_key LIKE 'LP_APPT_GHL_SYNC_%' ORDER BY rule_key;
--
-- Then RELOAD the decision engine and assert rules_loaded is +1 on its prior
-- value. Then, after the next reschedule, assert the routing actually fired:
-- SELECT rule_applied, action_type, status, created_at FROM agent_actions
--  WHERE rule_applied = 'LP_APPT_GHL_SYNC_RESCHEDULED' ORDER BY created_at DESC LIMIT 10;
