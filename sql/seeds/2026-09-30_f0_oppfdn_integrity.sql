-- 2026-09-30 fix/f0-oppfdn-integrity — F.0 entry and exit rules (LP Supabase).
-- Durable record; Mark applies it after the merge (see the PR's Post-merge steps).
-- Needs the lp_current_lead_match verb (src/decision-engine.js) to be deployed first:
-- an unknown verb short-circuits silently and the rule would never fire.

-- A) Agentic F.0 entry: current lead OPPFDN, appointment in last 14 days, real change only.
--    Posts to F.0's "Inbound Agentic Trigger" webhook (4e3a9178…), the same form-post
--    pattern the E.2 / S1.1 entry rules use, so the contact enters on F.0's webhook path.
INSERT INTO agent_rules (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
  action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
VALUES (
 'F0_ENROLL_CURRENT_OPPFDN', 'Enroll F.0 when the current LP lead is OPPFDN', 'routing',
 '{"event_type":"lp.disposition_changed","payload":{"disposition_code":"OPPFDN"}}'::jsonb,
 NULL,
 '{"lp_current_lead_match":{"disposition_in":["OPPFDN"],"max_days_since_appointment":14,"allow_synthetic":false},
   "not_has_any_tag":["active-f.0","customer","lp-sale","deal-won","dnc","lp-dnc","stage:dnc","stop-bot","suppress-outbound"]}'::jsonb,
 '[{"action_type":"add_to_workflow","target_entity":"contact","target_system":"ghl",
    "params":{"webhook_url":"https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/4e3a9178-6f67-4889-b3bb-02cc35aca17d",
              "format":"form","payload":{"source":"f0_agentic","entry_route_rule":"F0_ENROLL_CURRENT_OPPFDN"},
              "workflow_name":"F.0 Post-Appointment Follow-Up","canonical_code":"F.0","canonical_name":"F.0 Post-Appointment Follow-Up"}}]'::jsonb,
 false, true, 100, 'contextual', 'claude',
 '2026-09-30 fix/f0-oppfdn-integrity: the ONLY F.0 entry. Current lead (src/current-lead.js) must be OPPFDN with an appointment within 14 days; synthetic replays ignored. Enrolls through F.0''s "Inbound Agentic Trigger" webhook (Mark, 2026-09-30), not the GHL API. canonical_code F.0 keeps the active-f.0 already-enrolled skip. The GHL F.0 gate re-checks LP Disposition == OPPFDN.')
ON CONFLICT (rule_key) DO UPDATE SET event_pattern=EXCLUDED.event_pattern, context_conditions=EXCLUDED.context_conditions,
 action_template=EXCLUDED.action_template, requires_approval=EXCLUDED.requires_approval, enabled=EXCLUDED.enabled,
 notes=EXCLUDED.notes, version=coalesce(agent_rules.version,1)+1, updated_at=now();

-- B) Auto-exit: current disposition is anything other than OPPFDN, Sale included.
INSERT INTO agent_rules (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
  action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
VALUES (
 'F0_EXIT_NOT_OPPFDN', 'Remove from F.0 when the current LP lead is no longer OPPFDN (including Sale)', 'routing',
 '{"event_type":"lp.disposition_changed"}'::jsonb,
 NULL,
 '{"has_tag":"active-f.0",
   "lp_current_lead_match":{"disposition_not_in":["OPPFDN"],"allow_synthetic":false}}'::jsonb,
 '[{"action_type":"remove_from_workflow","target_entity":"contact","target_system":"ghl",
    "params":{"workflow_id":"15f47572-9ffc-453d-995d-a1890441f290","workflow_name":"F.0 Post-Appointment Follow-Up","canonical_code":"F.0"}},
   {"action_type":"remove_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"active-f.0"}},
   {"action_type":"add_tag","target_entity":"contact","target_system":"ghl","params":{"tag":"f0-exit-not-oppfdn"}}]'::jsonb,
 false, true, 90, 'contextual', 'claude',
 '2026-09-30 fix/f0-oppfdn-integrity: F.0 holds only current-OPPFDN contacts. Sale exits too; C.0 onboarding has its own triggers (deal-won tag, LP Gross Sale Amount, P2 Closed Won). Existing cancel/no-show/objection rules still route; this catches everything else (NoRehash, Issue, Set, NOC, ...).')
ON CONFLICT (rule_key) DO UPDATE SET event_pattern=EXCLUDED.event_pattern, context_conditions=EXCLUDED.context_conditions,
 action_template=EXCLUDED.action_template, requires_approval=EXCLUDED.requires_approval, enabled=EXCLUDED.enabled,
 notes=EXCLUDED.notes, version=coalesce(agent_rules.version,1)+1, updated_at=now();

-- ROLLBACK:
-- UPDATE agent_rules SET enabled=false, updated_at=now() WHERE rule_key IN ('F0_ENROLL_CURRENT_OPPFDN','F0_EXIT_NOT_OPPFDN');
