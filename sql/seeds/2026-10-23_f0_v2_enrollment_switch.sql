-- 2026-10-23 F.0 v2 go-live (the user, 2026-10-23: "Please send the leads to version 2 and point the
-- enrollment at V2"). LP Supabase, agent_rules.
--
-- Before this, rule 393 F0_ENROLL_CURRENT_OPPFDN posted every new OPPFDN lead to the OLD F.0's
-- "Inbound Agentic Trigger" (4e3a9178…, workflow 15f47572…): 266 enrollments in the 7 days to
-- 2026-10-23, while only the test contact ran F.0 v2 (07559309…). And the 22 enabled rules that take
-- a contact OUT of F.0 (a cancel, a no-show, an objection route, a new booking, F0_EXIT_NOT_OPPFDN)
-- removed it from the old F.0 only.
--
-- A) Rule 393 now posts to F.0 v2's "Agentic Inbound" trigger (ab59957a…, active). Same form body
--    (contact_id, source, entry_route_rule): v2's "Find Contact by Contact ID" reads
--    {{inboundWebhookRequest.contact_id}}, and its entry gate is the old one (no active-f.0, LP
--    Disposition = OPPFDN). canonical_code stays F.0, so the active-f.0 already-enrolled skip still
--    keeps a contact who is in the old F.0 from being enrolled twice.
-- B) Every enabled rule that removes a contact from the old F.0 now also removes it from v2, right
--    after the old step (the old one stays for contacts still running the old F.0). Disabled rules
--    are left as they are. Applied 2026-10-23 AFTER sql/seeds/2026-10-21_rehash_no_o0_routing.sql
--    (never applied until then; 13 routes created): its 13 _ROUTE rules already remove from v2 and
--    skip rehash / active-f.0 / rehash-owned contacts, so B touched the other 9 (exit_rules_extended
--    = 9: LP_DISP_SW, LP_DISP_1LEG, GHL_APPT_STAGE_ADVANCE, GHL_APPT_CANCELLED_REBOOK(_COLD),
--    LP_DISP_CANCEL_COLD_TO_S5_2, LP_DISP_NOSHOW_COLD_TO_TOFU, ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED,
--    F0_EXIT_NOT_OPPFDN).
--
-- A is run ONLY once Railway has F0_V2_MODE=live, F0_EMAIL_MODE=live and NURTURE_SHADOW_WORKFLOWS=none
-- (feature_modes shows the two modes live): in shadow, v2 drafts every text without sending it and
-- the workflow ends the sequence at the first text.
--
-- ROLLBACK: re-run sql/seeds/2026-09-30_f0_oppfdn_integrity.sql section A (puts 393 back on the old
-- trigger). The added v2 removals are harmless to leave.

-- A) enrollment → F.0 v2
WITH u AS (
  UPDATE agent_rules
     SET action_template = (
           SELECT jsonb_agg(
                    CASE WHEN a->>'action_type' = 'add_to_workflow'
                         THEN jsonb_set(jsonb_set(jsonb_set(a,
                                '{params,webhook_url}', to_jsonb('https://services.leadconnectorhq.com/hooks/SsBG7j5KQAIP1SFP2Sca/webhook-trigger/ab59957a-8d3c-4f5b-91f5-5ddf17e0c911'::text)),
                                '{params,workflow_name}', to_jsonb('F.0  Post-Appointment Follow-Up v2'::text)),
                                '{params,canonical_name}', to_jsonb('F.0  Post-Appointment Follow-Up v2'::text))
                         ELSE a END ORDER BY ord)
             FROM jsonb_array_elements(action_template) WITH ORDINALITY AS e(a, ord)),
         notes = coalesce(notes, '') || ' | 2026-10-23 F.0 v2 go-live (the user): enrolls through F.0 v2''s "Agentic Inbound" trigger (ab59957a…) instead of the old F.0 (4e3a9178…).',
         version = coalesce(version, 1) + 1,
         updated_at = now()
   WHERE rule_key = 'F0_ENROLL_CURRENT_OPPFDN'
     AND action_template::text LIKE '%4e3a9178-6f67-4889-b3bb-02cc35aca17d%'
  RETURNING 1)
SELECT count(*) AS enrollment_rules_switched FROM u;

-- B) every enabled F.0 removal also removes from v2
WITH u AS (
  UPDATE agent_rules r
     SET action_template = (
           SELECT jsonb_agg(x ORDER BY ord, sub)
             FROM jsonb_array_elements(r.action_template) WITH ORDINALITY AS e(a, ord),
                  LATERAL (
                    SELECT a AS x, 0 AS sub
                    UNION ALL
                    SELECT jsonb_set(jsonb_set(a,
                             '{params,workflow_id}', to_jsonb('07559309-9f55-4adf-8eff-9e5e3e5c3979'::text)),
                             '{params,workflow_name}', to_jsonb('F.0  Post-Appointment Follow-Up v2'::text)), 1
                     WHERE a->>'action_type' = 'remove_from_workflow'
                       AND a->'params'->>'workflow_id' = '15f47572-9ffc-453d-995d-a1890441f290'
                  ) s),
         notes = coalesce(notes, '') || ' | 2026-10-23 F.0 v2 go-live: also removes from F.0 v2 (07559309…).',
         version = coalesce(version, 1) + 1,
         updated_at = now()
   WHERE r.enabled
     AND r.action_template::text LIKE '%15f47572-9ffc-453d-995d-a1890441f290%'
     AND r.action_template::text NOT LIKE '%07559309-9f55-4adf-8eff-9e5e3e5c3979%'
  RETURNING 1)
SELECT count(*) AS exit_rules_extended FROM u;
