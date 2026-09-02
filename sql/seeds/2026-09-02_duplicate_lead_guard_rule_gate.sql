-- =====================================================================
-- 2026-09-02 — DUPLICATE-LEAD GUARD, RULE GATE (objection-state v2.0 part 2)
-- =====================================================================
-- APPLIED LIVE 2026-09-02 ~02:25Z via LP MCP supabase_run_query, AFTER the
-- decision-engine.js v2.19 deploy landed (Railway deployment
-- e6c7d693-e313-4ccc-9525-b0828eced1c3, SUCCESS, built from merge commit
-- e036264 / PR #802). Deploy order was respected — code first, then this SQL.
--
--   Pre-change enabled rules: 277 (304 total, 0 already gated)
--   Rules gated:              12 (all enabled)
--   Reload asserted:          POST /n8n/decision-engine/reload-rules
--                             -> {"success":true,"rules_loaded":277}
--                             UNCHANGED, as required for a condition edit.
--   Fail-closed on the new operator at apply time: 0
--
-- NOTE the wrapper limitation: LP MCP supabase_run_query rejects a top-level
-- data-modifying CTE ("WITH clause containing a data-modifying statement must
-- be at the top level") and does not report rows_affected. The APPLY below is
-- therefore written as a plain UPDATE ... RETURNING, and the count is asserted
-- by the read-back query that follows it. Do not "restore" the CTE form.
--
-- This file remains the durable record and the rollback vehicle.
--
-- WHAT
--   Adds the context condition `not_duplicate_lead_live_appointment: true` to
--   the 12 enabled rules that route an appointment disruption into S5.2 v2.
--
-- WHY
--   Call-center duplicate-lead cleanup CXLs one LP lead while the real
--   appointment stays Set/Cnf on the OTHER lead. objection-state.js v2.0
--   (PR #802) stopped the state write and the S5.2 enrollment, but the routing
--   rule's SIBLING actions still fired against a contact who never cancelled:
--     set_stage stage:reactivation, move_opportunity -> Reactivation,
--     add_tag appt-cancelled, create_task "LP CANCELLATION",
--     end_agentic_handoff.
--   Gating at the rule means the WHOLE batch is suppressed before any action
--   is queued. Evidence: contact cySIThxV1wJsV5E11Umu, actions 389380-389397,
--   all 18 queued by GHL_APPT_CANCELLED_REBOOK_COLD.
--
-- ⚠ DEPLOY ORDER — THIS IS NOT OPTIONAL ⚠
--   evaluateContextConditions() FAILS CLOSED on an unknown operator. If this
--   SQL lands before decision-engine.js v2.19 is live, all 12 rules below go
--   silent: every cancellation and no-show stops routing entirely (~700
--   contacts/30d, not just the false-positive cohort). Same failure mode the
--   v2.18 header warns about for payload_field_in.
--     1. Merge + confirm Railway has deployed decision-engine.js v2.19.
--     2. Confirm the operator is live (see PRE-FLIGHT below).
--     3. THEN run this file.
--     4. Reload rules and assert the count.
--     5. Verify a firing (see VERIFY below).
--
-- FAIL-OPEN: the operator maps every lp_leads query error to "no block", so a
-- Supabase outage lets these rules fire exactly as they do today. Deliberate
-- exception to the 2026-07-03 fail-closed doctrine — failing closed here would
-- suppress ~700 contacts/30d of legitimate rescue to spare the ~8% bad cohort.
-- Rationale in full: src/duplicate-lead-guard.js.
-- =====================================================================

-- ---------------------------------------------------------------------
-- PRE-FLIGHT — run FIRST, after the deploy. Both must pass.
-- ---------------------------------------------------------------------
-- (a) Railway logs must show the v2.19 boot. The operator is live only if
--     decision-engine.js on the running deploy contains the case. Check the
--     deploy SHA against the merge commit of the PR before continuing.
--
-- (b) Confirm the 12 target rules are the ones still expected, and that none
--     already carries the key (this file is idempotent, but a surprise here
--     means the rule set drifted since 2026-09-02 — re-read before running):
--
-- SELECT json_agg(row_to_json(s)) FROM (
--   SELECT id, rule_key, enabled,
--          context_conditions ? 'not_duplicate_lead_live_appointment' AS already_gated
--   FROM agent_rules
--   WHERE rule_key IN (
--     'LP_DISP_CXL_TO_CANCELLED','LP_DISP_CANCEL_COLD_TO_S5_2',
--     'LP_DISP_NS_NOHOME_CUSTOMER_TO_NOSHOW','LP_DISP_NOSHOW_COLD_TO_TOFU',
--     'LP_DISP_1LEG_TO_ONELEG','LP_DISP_BO_TO_BEBACK',
--     'GHL_APPT_CANCELLED_REBOOK','GHL_APPT_CANCELLED_REBOOK_COLD',
--     'BEHAVIORAL_APPT_NO_SHOW','BEHAVIORAL_APPT_NO_SHOW_COLD',
--     'ENROLL_S5_2_v2_NO_SHOW_ON_US','ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED')
--   ORDER BY id) s;

-- ---------------------------------------------------------------------
-- APPLY — jsonb merge, idempotent. Expect count = 12.
-- ---------------------------------------------------------------------
-- The `||` merge adds the key without disturbing the existing gates
-- (has_any_tag, lp_disposition_in, last_active_appointment,
-- not_reschedule_inflight, ...). Re-running is a no-op on already-gated rows.
--
-- Note on evaluation cost: jsonb stores object keys sorted by length, and
-- `not_duplicate_lead_live_appointment` (35 chars) is the longest key on every
-- one of these rules — so it is evaluated LAST, after the cheap tag and
-- disposition checks have already short-circuited most events. The lp_leads
-- lookup only runs for events that pass everything else.

UPDATE agent_rules
   SET context_conditions =
         coalesce(context_conditions, '{}'::jsonb)
         || '{"not_duplicate_lead_live_appointment": true}'::jsonb,
       version = version + 1,
       notes = coalesce(notes, '') ||
         E'\n[2026-09-02 Claude] Added not_duplicate_lead_live_appointment. '
         'Call-center duplicate-lead cleanup CXLs one LP lead while the real '
         'appointment stays Set/Cnf on another lead for the same contact; '
         'this rule was firing its full action batch (stage:reactivation, '
         'move_opportunity, appt-cancelled, task, end_agentic_handoff, S5.2 '
         'enrollment) against contacts who never cancelled. objection-state '
         'v2.0 guarded only the state write and enrollment; this gates the '
         'siblings. Requires decision-engine.js v2.19. Fails OPEN on lp_leads '
         'query error. Evidence: cySIThxV1wJsV5E11Umu, actions 389380-389397.'
 WHERE rule_key IN (
   'LP_DISP_CXL_TO_CANCELLED','LP_DISP_CANCEL_COLD_TO_S5_2',
   'LP_DISP_NS_NOHOME_CUSTOMER_TO_NOSHOW','LP_DISP_NOSHOW_COLD_TO_TOFU',
   'LP_DISP_1LEG_TO_ONELEG','LP_DISP_BO_TO_BEBACK',
   'GHL_APPT_CANCELLED_REBOOK','GHL_APPT_CANCELLED_REBOOK_COLD',
   'BEHAVIORAL_APPT_NO_SHOW','BEHAVIORAL_APPT_NO_SHOW_COLD',
   'ENROLL_S5_2_v2_NO_SHOW_ON_US','ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED')
   AND NOT (coalesce(context_conditions, '{}'::jsonb)
            ? 'not_duplicate_lead_live_appointment')
RETURNING id, rule_key;

-- Assert the count (the wrapper does not report rows_affected). Expect
-- gated_total = 12, gated_enabled = 12, enabled_rules unchanged at 277.
-- SELECT json_agg(row_to_json(s)) FROM (
--   SELECT
--     (SELECT count(*) FROM agent_rules
--       WHERE coalesce(context_conditions,'{}'::jsonb) ? 'not_duplicate_lead_live_appointment') AS gated_total,
--     (SELECT count(*) FROM agent_rules
--       WHERE coalesce(context_conditions,'{}'::jsonb) ? 'not_duplicate_lead_live_appointment'
--         AND enabled) AS gated_enabled,
--     (SELECT count(*) FROM agent_rules WHERE enabled) AS enabled_rules) s;

-- ---------------------------------------------------------------------
-- RELOAD — required. Assert rules_loaded against the pre-change enabled count.
-- ---------------------------------------------------------------------
--   POST https://<lp-mcp-host>/n8n/decision-engine/reload-rules
-- This is a condition change, not an enable/disable, so the enabled count must
-- be UNCHANGED. A drop means a rule failed to load — roll back immediately.

-- ---------------------------------------------------------------------
-- VERIFY — the gate is only proven by a firing (or a suppression).
-- ---------------------------------------------------------------------
-- (1) Suppressions emitted by the rule gate (this change):
-- SELECT json_agg(row_to_json(s)) FROM (
--   SELECT created_at::timestamp(0), payload->>'rule_key' AS rule,
--          payload->>'blocking_reason' AS why,
--          payload->>'blocking_disposition' AS blocked_by,
--          payload->>'blocking_source' AS src, ghl_contact_id
--   FROM system_events
--   WHERE event_type = 'rule.suppressed_duplicate_lead'
--   ORDER BY created_at DESC LIMIT 20) s;
--
-- (2) Suppressions from the handler guard (PR #802, already live) should now
--     TREND TO ZERO for disposition-driven disruptions — the rule gate stops
--     those upstream, so the handler no longer sees them. Handler suppressions
--     that remain are the paths the rule gate does not cover (e.g. manual
--     overrides, message-analyzer proposals), which is expected:
-- SELECT json_agg(row_to_json(s)) FROM (
--   SELECT created_at::timestamp(0), payload->>'trigger_source' AS trig,
--          payload->>'contact_id' AS contact
--   FROM system_events
--   WHERE event_type = 'state_transition_suppressed_duplicate_lead'
--   ORDER BY created_at DESC LIMIT 20) s;
--
-- (3) Cancellation routing must NOT have stopped. This is the regression that
--     matters — compare the 7 days after against the 7 days before. A collapse
--     to zero means the operator is not live and the rules are failing closed:
-- SELECT json_agg(row_to_json(s)) FROM (
--   SELECT rule_applied, count(DISTINCT target_id) AS contacts_7d
--   FROM agent_actions
--   WHERE created_at >= now() - interval '7 days'
--     AND rule_applied IN ('LP_DISP_CANCEL_COLD_TO_S5_2','GHL_APPT_CANCELLED_REBOOK_COLD')
--   GROUP BY 1) s;
--   Baseline (30d to 2026-09-02): LP_DISP_CANCEL_COLD_TO_S5_2 714 contacts,
--   GHL_APPT_CANCELLED_REBOOK_COLD 687 contacts.
--   Baseline at apply time (2026-09-02 02:25Z), for the first post-apply check:
--     GHL_APPT_CANCELLED_REBOOK_COLD  28 contacts/24h, 154/7d
--     LP_DISP_CANCEL_COLD_TO_S5_2     27 contacts/24h, 154/7d
--     LP_DISP_NOSHOW_COLD_TO_TOFU      8 contacts/24h,  36/7d
--   A 24h figure near zero on either of the top two = the gate is over-firing
--   or the operator is not live. Roll back and investigate.
--
-- (4) Engine-side fail-closed events must NOT name these rules. If they do,
--     the operator is unknown to the running deploy — roll back now:
-- SELECT json_agg(row_to_json(s)) FROM (
--   SELECT created_at::timestamp(0), payload->>'rule_key' AS rule,
--          payload->>'missing_key' AS missing_key
--   FROM system_events
--   WHERE event_type = 'rule.condition_failed_closed'
--     AND payload->>'missing_key' = 'not_duplicate_lead_live_appointment'
--   ORDER BY created_at DESC LIMIT 20) s;

-- ---------------------------------------------------------------------
-- ROLLBACK — removes the gate, leaves every other condition intact.
-- ---------------------------------------------------------------------
-- Use this if cancellation routing collapses, or if the operator turns out not
-- to be live. Reload after running. Expect count = 12.
--
-- WITH u AS (
--   UPDATE agent_rules
--      SET context_conditions = context_conditions - 'not_duplicate_lead_live_appointment',
--          version = version + 1
--    WHERE rule_key IN (
--      'LP_DISP_CXL_TO_CANCELLED','LP_DISP_CANCEL_COLD_TO_S5_2',
--      'LP_DISP_NS_NOHOME_CUSTOMER_TO_NOSHOW','LP_DISP_NOSHOW_COLD_TO_TOFU',
--      'LP_DISP_1LEG_TO_ONELEG','LP_DISP_BO_TO_BEBACK',
--      'GHL_APPT_CANCELLED_REBOOK','GHL_APPT_CANCELLED_REBOOK_COLD',
--      'BEHAVIORAL_APPT_NO_SHOW','BEHAVIORAL_APPT_NO_SHOW_COLD',
--      'ENROLL_S5_2_v2_NO_SHOW_ON_US','ENROLL_S5_2_v2_NO_SHOW_REP_TRAVELED')
--      AND context_conditions ? 'not_duplicate_lead_live_appointment'
--   RETURNING 1
-- )
-- SELECT count(*) AS rules_ungated FROM u;
--
-- The code side needs no rollback: an operator nothing references is inert.
-- =====================================================================
