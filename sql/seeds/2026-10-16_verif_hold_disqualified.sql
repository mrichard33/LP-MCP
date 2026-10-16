-- 2026-10-16 — Verif is a hold; ND and No Demo are disqualified (Mark, handoff v3.4).
--
-- Mark's rulings, 2026-10-16:
--   * Verif = "there is an issue with the lead." It triggers NO automation of any kind.
--     This REVERSES the 2026-07-09 reconciler rule ("LP Verif = a live Window Estimate,
--     exactly like Set") and the 2026-10-06 booked-dial-routing note "Verif counts as Set".
--     A Verif must never lift a DNC. A DNC'd Verif lead must still have its DNC pushed to LP
--     (a compliance sync, not a workflow automation).
--   * ND and No Demo both = disqualified: no S5.2, no rebook, no Five9, no F.0, no nurture.
--     An open GHL estimate is marked `invalid` (never `cancelled`, which fires cancel/rebook).
--
-- Verified live 2026-10-16 before this file: in 30 days LP_APPT_GHL_SYNC_VERIF created or
-- rescheduled 55 GHL appointments, LP_DISP_VERIF tagged 186 contacts lp-route:appt-confirmed,
-- and LP_DISP_NO_DEMO (enabled) tagged 138 No Demo contacts lp-route:rebook-group2 + a
-- time-lapse tier. LP_DISP_ND (46) was already disabled.
--
-- Ships with the code (src/lp-disposition-classes.js, the reconciler's verif_hold /
-- disqualified kinds, the disqualified_cleanup handler). Apply AFTER the deploy, then reload.

-- ── 1. Verif starts nothing ───────────────────────────────────────────────
-- Expect 2.
WITH u AS (
  UPDATE agent_rules SET
    enabled = FALSE,
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-16: DISABLED. Mark 2026-10-16: Verif = lead issue, no automation (handoff v3.4 Fix 0).'
  WHERE rule_key IN ('LP_APPT_GHL_SYNC_VERIF', 'LP_DISP_VERIF')
    AND enabled = TRUE
  RETURNING 1)
SELECT count(*) FROM u;

-- A Verif never lifts DNC: event_subtype_in becomes [Set, Cnf]. Expect 1.
WITH u AS (
  UPDATE agent_rules SET
    conditions = jsonb_set(conditions, '{event_subtype_in}', '["Set","Cnf"]'::jsonb),
    rule_name = 'DNC-lift on re-engagement (LP Set/Cnf after DNC) → clear suppression stack',
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-16: Verif removed from event_subtype_in — a Verif (a lead issue) must never lift DNC (Mark).'
  WHERE rule_key = 'DNC_LIFT_ON_REENGAGEMENT_LP'
    AND conditions->'event_subtype_in' ? 'Verif'
  RETURNING 1)
SELECT count(*) FROM u;

-- A DNC'd Verif lead still has DNC pushed to LP: event_subtype_not_in becomes [Set, Cnf]. Expect 1.
WITH u AS (
  UPDATE agent_rules SET
    conditions = jsonb_set(conditions, '{event_subtype_not_in}', '["Set","Cnf"]'::jsonb),
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-16: Verif removed from event_subtype_not_in — a Verif is not a recovery, so a DNC stays pushed to LP (Mark).'
  WHERE rule_key = 'RECONCILE_LP_DNC_ON_LINK'
    AND conditions->'event_subtype_not_in' ? 'Verif'
  RETURNING 1)
SELECT count(*) FROM u;

-- ── 2. ND and No Demo are disqualified ─────────────────────────────────────
-- Retire the rebook route for No Demo. Expect 1.
WITH u AS (
  UPDATE agent_rules SET
    enabled = FALSE,
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-16: DISABLED. Mark 2026-10-16: ND and No Demo = disqualified, never rebooked. Replaced by LP_DISP_DISQUALIFIED.'
  WHERE rule_key = 'LP_DISP_NO_DEMO'
    AND enabled = TRUE
  RETURNING 1)
SELECT count(*) FROM u;

-- One rule for both codes. The handler (src/actions/handlers/disqualified-cleanup.js) re-reads
-- the contact's CURRENT lead and acts only when that lead is still ND / No Demo. Expect 1.
WITH u AS (
  INSERT INTO agent_rules (rule_key, rule_name, rule_type, category, priority, enabled, requires_approval,
                           event_pattern, conditions, context_conditions, action_template, notes, created_by, version)
  SELECT 'LP_DISP_DISQUALIFIED',
         'LP ND / No Demo → disqualified: invalidate open estimate, stop every automation',
         'contextual', 'disposition_routing', 25, TRUE, FALSE,
         '{"event_type":"lp.disposition_changed"}'::jsonb,
         NULL,
         '{"event_subtype_in":["ND","No Demo"]}'::jsonb,
         '[{"action_type":"disqualified_cleanup","target_entity":"contact","target_system":"ghl","priority":25,"params":{}}]'::jsonb,
         '2026-10-16 (Mark, handoff v3.4 Fix 2): ND and No Demo = disqualified. Open GHL estimate → invalid (never cancelled), off A.WE-1, reminder tags off; out of S5.2 / rebook / nurture; tag lp-disqualified; Five9 removal from every outbound list the phone is on (approval card unless DISQUALIFIED_FIVE9_AUTO_REMOVE=true). Replaces LP_DISP_NO_DEMO (rebook-group2) and LP_DISP_ND (disabled).',
         'claude', 1
  WHERE NOT EXISTS (SELECT 1 FROM agent_rules WHERE rule_key = 'LP_DISP_DISQUALIFIED')
  RETURNING 1)
SELECT count(*) FROM u;

-- Rule 171 GHL_APPT_CANCELLED_REBOOK_COLD skips a disqualified current lead UP FRONT (new verb
-- lp_disposition_not_in, src/decision-engine.js), not only through the late lp_note_dq read
-- (Avila, LP 583486). Expect 1.
WITH u AS (
  UPDATE agent_rules SET
    context_conditions = context_conditions || '{"lp_disposition_not_in":["ND","No Demo"]}'::jsonb,
    version = coalesce(version,1) + 1, updated_at = now(),
    notes = coalesce(notes,'') || E'\n2026-10-16: lp_disposition_not_in [ND, No Demo] — a disqualified lead is never rebooked or rescued (Mark, handoff v3.4 Fix 2).'
  WHERE rule_key = 'GHL_APPT_CANCELLED_REBOOK_COLD'
    AND NOT (context_conditions ? 'lp_disposition_not_in')
  RETURNING 1)
SELECT count(*) FROM u;

-- Then reload: POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules

-- ROLLBACK:
-- UPDATE agent_rules SET enabled = TRUE, updated_at = now() WHERE rule_key IN ('LP_APPT_GHL_SYNC_VERIF','LP_DISP_VERIF','LP_DISP_NO_DEMO');
-- UPDATE agent_rules SET conditions = jsonb_set(conditions,'{event_subtype_in}','["Set","Cnf","Verif"]'::jsonb), updated_at = now() WHERE rule_key = 'DNC_LIFT_ON_REENGAGEMENT_LP';
-- UPDATE agent_rules SET conditions = jsonb_set(conditions,'{event_subtype_not_in}','["Set","Cnf","Verif"]'::jsonb), updated_at = now() WHERE rule_key = 'RECONCILE_LP_DNC_ON_LINK';
-- UPDATE agent_rules SET enabled = FALSE, updated_at = now() WHERE rule_key = 'LP_DISP_DISQUALIFIED';
-- UPDATE agent_rules SET context_conditions = context_conditions - 'lp_disposition_not_in', updated_at = now() WHERE rule_key = 'GHL_APPT_CANCELLED_REBOOK_COLD';
