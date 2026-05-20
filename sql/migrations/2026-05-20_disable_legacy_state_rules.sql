-- ============================================================================
-- Migration: disable / retarget legacy rules superseded by S5.2 v2 state path
-- Date: 2026-05-20
-- ----------------------------------------------------------------------------
-- RUN ORDER:
--   1. sql/seeds/2026-05-20_state_classification_rules_v2.sql
--   2. sql/seeds/2026-05-20_pre_demo_friction_to_state.sql
--   3. VERIFY: confirm the new rules fire on a test contact and the state
--      handler enrolls in S5.2 v2 successfully.
--   4. THEN run this file to retire the legacy paths.
--
-- This file is intentionally written as targeted UPDATEs by rule_key rather
-- than by id, because rule IDs differ between environments. Before applying,
-- verify each rule_key actually exists in your environment:
--
--   SELECT id, rule_key, rule_name, enabled FROM agent_rules
--   WHERE rule_key IN (
--     'NO_SHOW_RECOVERY_S5_2',         -- ← UPDATE if your Rule 227 key differs
--     'OBJECTION_ROUTE_PRE_DEMO',      -- ← UPDATE if your Rule 215 key differs
--     'LP_DISPOSITION_CANCEL_TO_S5_2', -- ← UPDATE if your Rule 107 key differs
--     'LP_DISPOSITION_NOC_TO_S5_2',    -- ← UPDATE if your Rule 38 key differs
--     'LP_DISPOSITION_NIS_TO_S5_2',    -- ← UPDATE if your Rule 40 key differs
--     'LP_DISPOSITION_NIS2_TO_S5_2'    -- ← UPDATE if your Rule 51 key differs
--   );
--
-- If a key doesn't match, find the right one with:
--   SELECT id, rule_key, rule_name FROM agent_rules WHERE id IN (227,215,107,38,40,51);
-- Then edit the rule_keys below to match before running.
--
-- Why disable instead of delete: rolling back is one UPDATE away, and the
-- audit trail (created_by, notes, updated_at) survives. Decision engine
-- skips disabled rules at src/decision-engine.js loadRules() — they have
-- zero runtime cost.
-- ============================================================================

BEGIN;

-- ── 1. Disable Rule 227 (legacy no_show path) ─────────────────────────────
-- The new LP_DISP_NS_OR_NOHOME_TO_NOSHOW rule handles every disposition
-- 227 used to handle (NS, NoHome, NOC, NIS, NIS2) and routes through the
-- state handler. Once verified, 227's hardcoded route should be retired.
UPDATE agent_rules
SET enabled = FALSE,
    notes = COALESCE(notes, '') ||
            E'\n\n[2026-05-20] Disabled — superseded by STATE_CLASSIFICATION ' ||
            'rule LP_DISP_NS_OR_NOHOME_TO_NOSHOW which routes NOC/NIS/NIS2/NS/' ||
            'NoHome through the state handler (src/actions/handlers/objection-' ||
            'state.js) for unified enrollment in S5.2 v2.',
    updated_at = NOW()
WHERE rule_key = 'NO_SHOW_RECOVERY_S5_2'           -- TODO verify against id=227
  AND enabled = TRUE;

-- ── 2. Disable Rule 107 (legacy cancellation → legacy S5.2) ──────────────
-- New rule LP_DISP_CXL_TO_CANCELLED routes cancellations to S5.2 v2.
UPDATE agent_rules
SET enabled = FALSE,
    notes = COALESCE(notes, '') ||
            E'\n\n[2026-05-20] Disabled — superseded by ' ||
            'LP_DISP_CXL_TO_CANCELLED which routes to S5.2 v2 (' ||
            '0a6a1349-0b44-429b-91e1-4c5be264cd9f) via the state handler ' ||
            'rather than the legacy 613dbbbd-b7af-4be0-81fa-371f3e1d7b14 ' ||
            'workflow.',
    updated_at = NOW()
WHERE rule_key = 'LP_DISPOSITION_CANCEL_TO_S5_2'   -- TODO verify against id=107
  AND enabled = TRUE;

-- ── 3. Disable Rules 38 / 40 / 51 (legacy per-code NOC/NIS/NIS2 paths) ───
-- Replaced by LP_DISP_NS_OR_NOHOME_TO_NOSHOW (single rule, all 5 codes).
UPDATE agent_rules
SET enabled = FALSE,
    notes = COALESCE(notes, '') ||
            E'\n\n[2026-05-20] Disabled — folded into ' ||
            'LP_DISP_NS_OR_NOHOME_TO_NOSHOW which covers NS/NoHome/NOC/NIS/NIS2 ' ||
            'in a single contextual rule.',
    updated_at = NOW()
WHERE rule_key IN (
    'LP_DISPOSITION_NOC_TO_S5_2',                  -- TODO verify against id=38
    'LP_DISPOSITION_NIS_TO_S5_2',                  -- TODO verify against id=40
    'LP_DISPOSITION_NIS2_TO_S5_2'                  -- TODO verify against id=51
  )
  AND enabled = TRUE;

-- ── 4. Rule 215 (OBJECTION_ROUTE_PRE_DEMO): point at S5.2 v2, not legacy ─
-- Per handoff: existing Rule 215 routes pre-demo objections to LEGACY S5.2
-- (613dbbbd-b7af-4be0-81fa-371f3e1d7b14). The replacement path
-- PRE_DEMO_CONCERN_*_TO_STATE rules in 2026-05-20_pre_demo_friction_to_state.sql
-- route through the state handler which uses the workflow_id seeded in
-- objection_state_policies (0a6a1349-... for S5.2 v2). So Rule 215 can either
-- be disabled (let the new state path handle it) OR retargeted.
--
-- DEFAULT BELOW: disable. Re-enable only if downstream behaviour from Rule
-- 215 differs from what the new state-handler path produces.
UPDATE agent_rules
SET enabled = FALSE,
    notes = COALESCE(notes, '') ||
            E'\n\n[2026-05-20] Disabled — pre-demo objection→S5.2 routing ' ||
            'now flows through PRE_DEMO_CONCERN_*_TO_STATE rules + the state ' ||
            'handler (workflow_id sourced from objection_state_policies). If ' ||
            'this rule did anything beyond plain enrollment (e.g. extra task ' ||
            'creation, notification), audit before disabling.',
    updated_at = NOW()
WHERE rule_key = 'OBJECTION_ROUTE_PRE_DEMO'        -- TODO verify against id=215
  AND enabled = TRUE;

COMMIT;

-- ----------------------------------------------------------------------------
-- Verification:
--   SELECT id, rule_key, enabled, updated_at FROM agent_rules
--   WHERE id IN (38, 40, 51, 107, 215, 227)
--   ORDER BY id;
--
-- Rollback (selective):
--   UPDATE agent_rules SET enabled = TRUE, updated_at = NOW()
--   WHERE rule_key IN ('NO_SHOW_RECOVERY_S5_2', 'OBJECTION_ROUTE_PRE_DEMO', ...);
-- ----------------------------------------------------------------------------
