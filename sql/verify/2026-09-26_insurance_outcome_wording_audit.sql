-- 2026-09-26 — Insurance outcome wording audit (discovery discipline, Fix 6)
--
-- READ-ONLY. Run in the LP Supabase SQL editor. No DDL, no writes.
--
-- WHY: the responder guard (src/agentic/discovery-discipline.js
-- findInsuranceOutcomeClaims) now refuses any reply that predicts a premium or
-- savings result unless it carries the one approved sentence:
--
--   "Impact windows can qualify for wind-mitigation credits, and we give you the
--    documentation your insurance company asks for. Your insurance company
--    decides the final number."
--
-- The guard covers what the bot SENDS regardless of what the KB says. This
-- audit lists the KB rows that still carry outcome language, so the model is
-- not being handed "premium reductions" in its own context and then told not
-- to say it. Review, then rewrite the rows in the dashboard if any remain.
--
-- Tables are probed one at a time; a table that does not exist in this
-- instance simply errors on its own statement and the rest still run.

-- 1. Structured KB (sql/013 / sql/124 families)
SELECT json_agg(row_to_json(s)) FROM (
  SELECT 'kb_faqs' AS source, id, left(coalesce(question, ''), 120) AS question, left(coalesce(answer, ''), 240) AS answer
  FROM kb_faqs
  WHERE answer ~* '(premium reductions?|lower(ing)? (your|their|the) (insurance )?premium|save (money |a lot |hundreds |thousands )?on (your )?(home(owners)? )?insurance|insurance savings|premiums? (will |would |could )?(drop|go down)|discount on (your )?(home(owners)? )?insurance)'
     OR answer ~* '\m(Citizens|State Farm|Allstate|Progressive|USAA|Universal Property|Heritage|Security First|Florida Peninsula|Tower Hill|Frontline|Slide|HCI|Nationwide|Liberty Mutual|Farmers|Travelers|GEICO|Chubb|American Integrity|Kin)\M'
  ORDER BY id
) s;

-- 2. Golden KB v1 (sql/seeds/2026-09-25_golden_kb_v1.sql — LIB-I01..I04 are the insurance entries)
SELECT json_agg(row_to_json(s)) FROM (
  SELECT 'kb_golden' AS source, id, topic, left(coalesce(answer, ''), 240) AS answer
  FROM kb_golden
  WHERE answer ~* '(premium reductions?|lower(ing)? (your|their|the) (insurance )?premium|save (money |a lot |hundreds |thousands )?on (your )?(home(owners)? )?insurance|insurance savings|premiums? (will |would |could )?(drop|go down)|discount on (your )?(home(owners)? )?insurance)'
     OR answer ~* '\m(Citizens|State Farm|Allstate|Progressive|USAA|Universal Property|Heritage|Security First|Florida Peninsula|Tower Hill|Frontline|Slide|HCI|Nationwide|Liberty Mutual|Farmers|Travelers|GEICO|Chubb|American Integrity|Kin)\M'
  ORDER BY id
) s;

-- 3. What the bot actually SENT in the last 14 days that would now be refused
--    (before/after evidence for the PR; agent_actions.execution_result.sent_body)
SELECT json_agg(row_to_json(s)) FROM (
  SELECT id, target_id AS ghl_contact_id, rule_applied, created_at,
         left(execution_result->>'sent_body', 300) AS sent_body
  FROM agent_actions
  WHERE action_type = 'send_message'
    AND status = 'completed'
    AND created_at >= now() - interval '14 days'
    AND (execution_result->>'sent_body') ~* '(premium reductions?|lower(ing)? (your|their|the) (insurance )?premium|save (money |a lot |hundreds |thousands )?on (your )?(home(owners)? )?insurance|insurance savings|premiums? (will |would |could )?(drop|go down)|discount on (your )?(home(owners)? )?insurance)'
    AND NOT ((execution_result->>'sent_body') ~* 'insurance company decides the final number')
  ORDER BY created_at DESC
  LIMIT 50
) s;
