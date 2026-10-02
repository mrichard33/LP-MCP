-- 2026-10-02 (user ruling) — only an ACTIVE canvassing entry keeps a contact out of S5.2. The morning
-- seed (2026-10-02_s52_gate.sql) blocked three markers; a contact whose active entry is chatbot / other
-- but who still carries an old entry:canvassing or source:canvass tag must be allowed in. Matches
-- CANVASSING_TAGS in src/s52-entry-gate.js. active-entry:canvassing stays on every rule.
--
-- Expect 4.
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = jsonb_set(context_conditions, '{not_has_any_tag}',
      (context_conditions->'not_has_any_tag') - 'entry:canvassing' - 'source:canvass'),
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-02 (later): only an ACTIVE canvassing entry blocks S5.2 (user ruling) — not_has_any_tag -= entry:canvassing, source:canvass; active-entry:canvassing kept.'
  WHERE id IN (171, 227, 271, 295)
    AND rule_key IN ('GHL_APPT_CANCELLED_REBOOK_COLD','ENROLL_S5_2_v2_NO_SHOW_ON_US',
                     'LP_DISP_CANCEL_COLD_TO_S5_2','ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED')
    AND context_conditions->'not_has_any_tag' ?| ARRAY['entry:canvassing','source:canvass']
  RETURNING 1)
SELECT count(*) FROM u;

-- Check: SELECT id, context_conditions->'not_has_any_tag' FROM agent_rules WHERE id IN (171,227,271,295);
-- ROLLBACK: append '["entry:canvassing","source:canvass"]' back onto not_has_any_tag for the same ids.
