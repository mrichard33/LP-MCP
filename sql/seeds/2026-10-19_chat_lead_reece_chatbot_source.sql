-- 2026-10-19 (the user): "Any lead in our system that is created by the Chat Widget on the site should be
-- sent to lead perfection with the Reece Chatbot as the source."
--
-- Rule 386 CHAT_LEAD_CAPTURED_NEEDS_LP_LEAD (GHL I.CT → chat:lead-captured) sent no source, so
-- create_lp_lead took the contact's LP Source ID field, falling back to 830 only when it was blank.
-- A chat contact GHL merged onto an older record kept that record's source. The source is now
-- explicit (payload.srs_id / pro_id win over the contact, src/actions/handlers/lp-lead.js), the same
-- way rule 399 pins the calculator's 842 / 5862. Every chat contact of the last 30 days already held
-- 830 or blank (HL mirror, 2026-10-19), so today's leads are unchanged; this makes it a guarantee.
--
-- Returning leads (15+ days) who chat are sent by job chat-return-lead (src/jobs/chat-return-lead-sweep.js),
-- not by this rule: I.CT fires only on Contact Created, which a returning lead never is.
WITH u AS (
  UPDATE agent_rules
     SET action_template = '[{"action_type":"create_lp_lead","target_system":"lp","target_entity":"contact",
                              "params":{"sender":"agentic-chat-lead","include_appt":false,"srs_id":"830","pro_id":"5574"}}]'::jsonb,
         notes = notes || ' | 2026-10-19 (the user): source pinned to Reece ChatBot (srs 830 / pro 5574), whatever the contact held.'
   WHERE rule_key = 'CHAT_LEAD_CAPTURED_NEEDS_LP_LEAD'
     AND NOT (action_template->0->'params' ? 'srs_id')
  RETURNING 1
)
SELECT count(*) AS updated FROM u;
