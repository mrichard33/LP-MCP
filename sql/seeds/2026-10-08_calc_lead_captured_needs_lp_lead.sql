-- 2026-10-08 — Calculator leads → LP through the agentic create_lp_lead (calculator lane).
-- Sibling of CHAT_LEAD_CAPTURED_NEEDS_LP_LEAD (386). Fired by GHL I.WE and I.WC posting
-- event_subtype calc:lead-captured to /webhook/ghl-event. Replaces I.WE → 8e30ff37.
-- A same-second double fire (I.WE + I.WC) is covered twice: the Decision Engine will not
-- queue this rule while one is in flight for the contact (dedupPolicy), and a completed
-- push is in the 15-day ledger (agent_actions.execution_result.calc_dedupe_key).
INSERT INTO agent_rules (rule_key, rule_name, category, event_pattern, conditions, action_template,
                         requires_approval, enabled, priority, rule_type, context_conditions, notes)
SELECT 'CALC_LEAD_CAPTURED_NEEDS_LP_LEAD',
       'Calculator lead captured → create LP lead (calculator lane)',
       'ghl_attr',
       '{"event_type":"ghl.workflow_handoff","event_subtype":"calc:lead-captured"}'::jsonb,
       NULL,
       '[{"action_type":"create_lp_lead","target_system":"lp","target_entity":"contact",
          "params":{"sender":"agentic-calculator","include_appt":false,"lead_lane":"calculator","srs_id":"842","pro_id":"5862"}}]'::jsonb,
       false, true, 85, 'contextual',
       '{"not_has_any_tag":["dnc","stage:dnc","lp-dnc","dnc-sms","do-not-contact","unsubscribed","stop-bot","contact:delete","no-contact-method"]}'::jsonb,
       '2026-10-08. Calculator leads reach LP only through this rule. Dedupe: same phone + calculator push in last 15d (agent_actions ledger, key calc:<phone10>) OR a calculator-source LP lead in last 15d → reuse. Leads from any OTHER source never block: a new calculator-source lead (srs 842 / pro 5862) is created. In-flight dedupe per contact (dedupPolicy) covers an I.WE + I.WC double fire. Supersedes decision 797 (I.WE → 8e30ff37).'
WHERE NOT EXISTS (SELECT 1 FROM agent_rules WHERE rule_key = 'CALC_LEAD_CAPTURED_NEEDS_LP_LEAD');
