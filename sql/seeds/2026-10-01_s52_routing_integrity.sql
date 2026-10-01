-- 2026-10-01 — S5.2 Appointment Rescue: only people who belong there, and out when they're rescued.
-- Durable record; Mark applies it from the Supabase dashboard (LP project) AFTER the PR that adds
-- appointment_within_days to lp_current_lead_match is deployed, then reloads the rules.
-- (Older code ignores the new key, so running it early is harmless, just not yet protective.)
--
-- What a 7-day look at S5.2 entries found (181 entries, 2026-09-24 → 10-01):
--   * Sharyn Blake (3UHhZjKgDtQgtDD3N8qI) was sent in for an APRIL cancel. LP-MCP first copied that
--     old lead on 9/30, its first sync emitted lp.disposition_changed:CXL, and the rule's
--     lp_disposition_in read the most recently SYNCED lead. The code now reads the current lead; the
--     guard below also refuses a cancel whose appointment is more than 14 days old.
--   * 2 contacts were sent in as "ghost after booking" 24h AFTER they demoed (2LtKCh5Sr6j502v0iDvS,
--     8BY0XEk0P84qJjnNrivz): the ghost sweep fires a day after the appointment and the demo tag had
--     not been stamped yet.
--   * Nothing takes a contact OUT of S5.2 when LP shows they rebooked, demoed or bought.
--     BOOKING_EXITS_W5_2 only hears GHL calendar bookings. On 10/1, 22 contacts in S5.2 were Sale and
--     4 OPPFDN.

-- 1) Cancel / 1Leg entries: the appointment must be upcoming or at most 14 days old. Expect 3.
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = context_conditions || '{"lp_current_lead_match":{"appointment_within_days":14}}'::jsonb,
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-01: lp_current_lead_match.appointment_within_days=14 — a cancel/1Leg for a months-old appointment is history, not news (Sharyn Blake, April CXL first synced 9/30).'
  WHERE rule_key IN ('LP_DISP_CANCEL_COLD_TO_S5_2','LP_DISP_CXL_TO_CANCELLED','LP_DISP_1LEG_TO_ONELEG')
    AND enabled AND NOT (context_conditions ? 'lp_current_lead_match')
  RETURNING 1)
SELECT count(*) FROM u;

-- 2) "Ghost after booking" never fires for someone whose current lead shows a demo or a sale. Expect 1.
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = context_conditions || '{"lp_current_lead_match":{"disposition_not_in":["Sale","OPPFDN","NoRehash","FDNS","SW","PM"]}}'::jsonb,
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-01: not after a demo or sale — the ghost sweep fires 24h after the appointment, before the demo tag is stamped (2 demoed contacts sent to S5.2 in 7 days).'
  WHERE rule_key = 'BEHAVIORAL_GHOST_AFTER_BOOKING' AND NOT (context_conditions ? 'lp_current_lead_match')
  RETURNING 1)
SELECT count(*) FROM u;

-- 3) New exit: in S5.2 and LP now shows a rebook, a demo or a sale → out of S5.2. Expect 1.
--    Mirrors BOOKING_EXITS_W5_2 (which only hears GHL calendar bookings). Removes s52-task-created
--    so a later cancel can route to S5.2 again. F.0 entry for a demo is a separate rule.
INSERT INTO agent_rules (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
  action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
VALUES (
 'S52_EXIT_REBOOKED_OR_DEMOED', 'Exit S5.2 when LP shows a rebook, a demo or a sale', 'routing',
 '{"event_type":"lp.disposition_changed"}'::jsonb,
 NULL,
 '{"has_any_tag":["active-s5.2","active-w5.2"],
   "lp_current_lead_match":{"disposition_in":["Set","Cnf","Verif","Issue","OPPFDN","NoRehash","FDNS","SW","PM","Sale"],"allow_synthetic":false}}'::jsonb,
 '[{"action_type":"remove_from_workflow","target_entity":"contact","target_system":"ghl",
    "params":{"workflow_id":"0a6a1349-0b44-429b-91e1-4c5be264cd9f","workflow_name":"S5.2 Appointment Rescue (Policy Executor) v2","canonical_code":"S5.2"}},
   {"action_type":"remove_from_workflow","target_entity":"contact","target_system":"ghl",
    "params":{"workflow_id":"613dbbbd-b7af-4be0-81fa-371f3e1d7b14","workflow_name":"S5.2 Appointment Rescue Reactivation","canonical_code":"S5.2"}},
   {"action_type":"remove_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"active-s5.2"}},
   {"action_type":"remove_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"active-w5.2"}},
   {"action_type":"remove_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"s52-task-created"}},
   {"action_type":"add_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"s52-exit-rescued"}}]'::jsonb,
 false, true, 95, 'contextual', 'claude',
 '2026-10-01: S5.2 rescues an appointment; once LP shows the contact rebooked (Set/Cnf/Verif/Issue), demoed or bought, the rescue is over. Reads the CURRENT lead (src/current-lead.js). On 10/1, 22 Sale and 4 OPPFDN contacts were still in S5.2.')
ON CONFLICT (rule_key) DO UPDATE SET event_pattern=EXCLUDED.event_pattern, context_conditions=EXCLUDED.context_conditions,
 action_template=EXCLUDED.action_template, requires_approval=EXCLUDED.requires_approval, enabled=EXCLUDED.enabled,
 notes=EXCLUDED.notes, version=coalesce(agent_rules.version,1)+1, updated_at=now();

-- Then reload: POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules

-- ROLLBACK:
-- UPDATE agent_rules SET context_conditions = context_conditions - 'lp_current_lead_match', updated_at = now()
--   WHERE rule_key IN ('LP_DISP_CANCEL_COLD_TO_S5_2','LP_DISP_CXL_TO_CANCELLED','LP_DISP_1LEG_TO_ONELEG','BEHAVIORAL_GHOST_AFTER_BOOKING');
-- UPDATE agent_rules SET enabled = false, updated_at = now() WHERE rule_key = 'S52_EXIT_REBOOKED_OR_DEMOED';
