-- ════════════════════════════════════════════════════════════════════
-- Backstop: E.0 "other" branch fired on an appointment-stage lead
-- 2026-06-17
--
-- WHAT: catches LP-inbound leads that were ALREADY dispositioned (booked by
--   the call center: Set/Cnf/OPPFDN/etc.) but still got entry-routed cold.
--   ENTRY_HYGIENE_AT_CREATION_INTERNET stamps entry:other on source alone, so
--   E.0 Master Router sends them down the "other" branch → E.5 Unknown Source
--   Bridge → S2.2 Chatbot Indoctrination. No rule consumed ghl.e0_branch_fired
--   (other), so a booked lead sat in cold-lead indoctrination with nothing
--   pulling it back (canary: Denise Klein, GHL FDkW5LaKF4ArpyRL99Mc, OPPFDN).
--
-- This rule fires on ghl.e0_branch_fired (event_subtype "other"), and ONLY if
-- the contact looks appointment-staged (any_of):
--   - has any of the lp-route:* / lp-demo-completed appointment tags, OR
--   - its canonical LP disposition (lp_leads.disposition_code, read by the
--     lp_disposition_in verb) is an appointment-stage code.
-- The disposition arm is what catches the canary — Denise has no lp-route:*
-- tag (LP_DISP_* never fired for her) but is OPPFDN.
--
-- Then it pulls the lead out of indoctrination and re-asserts its route:
--   1-2. remove from S2.2 + E.5 workflows
--   3.   strip any active-s2.* indoctrination tag (prefix mode)
--   4.   strip stage:indoctrination
--   5.   re-emit lp.disposition_changed (no subtype needed; LP_DISP_* match on
--        event_type and read disposition via lp_disposition_in) so the correct
--        stage/route is re-applied
--   6.   🧠 GroupMe intelligence note documenting the catch
--
-- WORKFLOW IDS (verified against workflow_registry 2026-06-17 — the canonical
--   mapping resolveWorkflowTarget uses, NOT the duplicate-named rows in the
--   `workflows` table):
--     S2.2 → ea3c3aed-77a4-470d-bc3c-1b1765bfff3b (canonical_code S2.2, active/published)
--     E.5  → 0c7b2137-76fd-46d9-9f9b-75d095d3d769 (canonical_code E.5)
--   canonical_code is also passed so the executor can re-resolve if an id rolls.
--
-- ⚠ DEPLOY-ORDER HAZARD — custom_field_in arm:
--   This guard uses the custom_field_in operator, which is ADDED to the engine
--   in the same branch as this seed (decision-engine.js evaluateContextConditions).
--   An UNKNOWN context operator FAILS OPEN (default: warns, returns true). Inside
--   any_of a failed-open arm short-circuits the whole guard to TRUE for EVERY
--   "other"-branch contact. Therefore:
--     * Do NOT apply this 3-arm version to the live agent_rules table until the
--       branch carrying custom_field_in is deployed (Railway dev for LP MCP).
--     * The interim live rule inserted this session uses only the 2 deployed-safe
--       arms (has_any_tag + lp_disposition_in). Re-run THIS seed post-deploy to
--       add the custom_field_in arm (ON CONFLICT updates in place), then reload.
--   Why the third arm is required: the canary (Denise, OPPFDN) and likely a
--   share of the 84 contaminated contacts carry their disposition ONLY in the
--   GHL field URWTGtobi9a9Y7gwGxC8 with NO lp_leads row, so lp_disposition_in
--   cannot see them. custom_field_in reads the GHL field directly (the same
--   field the Change-4 detection query uses).
--
-- DEPLOYMENT (per session decision):
--   * requires_approval = TRUE — every match queues as pending_approval until
--     validated on a real inbound batch. Flip to FALSE (re-run this seed with
--     the flag changed, then reload-rules) once confirmed correct.
--   * Run AFTER the LP-MCP code deploy adding (a) custom_field_in and (b) the
--     inbound disposition backfill (Change 1), so both the GHL-field guard arm
--     works and lp_leads.disposition_code is reliably populated.
--   * Bare top-level statement (one per supabase_run_query call).
--   * After running: POST /n8n/decision-engine/reload-rules.
--
-- GUARD CAPABILITIES (verified in decision-engine.js evaluateContextConditions):
--   any_of (L719) recursively ORs full condition objects; lp_disposition_in
--   (L679) reads lp_leads.disposition_code by ghl_contact_id; has_any_tag (L563);
--   custom_field_in (new) reads a GHL custom field value live and tests set
--   membership, sharing the per-event customFields fetch with custom_field_eq.
-- ════════════════════════════════════════════════════════════════════

INSERT INTO agent_rules (rule_key, rule_name, category, rule_type, event_pattern, context_conditions, action_template, requires_approval, enabled, priority, created_by, notes)
VALUES (
  'BACKSTOP_E0_OTHER_BOOKED_LEAD',
  'Backstop: E.0 Other branch fired on appointment-stage lead → pull from indoctrination',
  'routing', 'contextual',
  '{"event_type": "ghl.e0_branch_fired", "event_subtype": "other"}'::jsonb,
  '{
    "any_of": [
      {"has_any_tag": ["lp-route:appt-confirmed", "lp-route:post-appointment", "lp-route:stale-appt", "lp-demo-completed"]},
      {"lp_disposition_in": ["Set", "Cnf", "Verif", "Conf Backup", "Soft Confirm", "UnCon", "OPPFDN", "FDNS", "NOC", "1Leg", "No Demo", "NS"]},
      {"custom_field_in": {"field_id": "URWTGtobi9a9Y7gwGxC8", "values": ["Set", "Cnf", "Verif", "Conf Backup", "Soft Confirm", "UnCon", "OPPFDN", "FDNS", "NOC", "1Leg", "No Demo", "NS"]}}
    ]
  }'::jsonb,
  '[
    {"action_type": "remove_from_workflow", "target_system": "ghl", "target_entity": "contact",
     "params": {"workflow_id": "ea3c3aed-77a4-470d-bc3c-1b1765bfff3b", "canonical_code": "S2.2", "workflow_name": "S2.2 Chatbot Indoctrination"}},
    {"action_type": "remove_from_workflow", "target_system": "ghl", "target_entity": "contact",
     "params": {"workflow_id": "0c7b2137-76fd-46d9-9f9b-75d095d3d769", "canonical_code": "E.5", "workflow_name": "E.5 Unknown Source Bridge"}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact",
     "params": {"prefix": "active-s2."}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact",
     "params": {"tag": "stage:indoctrination"}},
    {"action_type": "emit_event", "target_system": "lp", "target_entity": "contact",
     "params": {"event_type": "lp.disposition_changed", "priority": "high",
       "payload": {"synthetic": true, "reason": "backstop_e0_other_reassert"}}},
    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "params": {"notification_class": "intelligence", "action_verb": "BACKSTOP: pulled booked lead from indoctrination",
       "tier": "Booked", "status": "Auto-corrected",
       "message": "E.0 routed a booked/appointment-stage lead down the cold ''other'' branch into indoctrination — backstop pulled it out and re-asserted its route.",
       "narrative": "Backstop fired for {{contact_name}}: an LP-inbound lead that was already dispositioned (appointment-stage) took the E.0 ''other'' branch into E.5/S2.2 indoctrination. Removed from S2.2 + E.5, stripped active-s2.* and stage:indoctrination, and re-emitted lp.disposition_changed so LP_DISP_* re-applies the correct stage/route.",
       "next_step": "Confirm the lead landed on its correct post-appointment route; investigate why entry hygiene stamped entry:other."}}
  ]'::jsonb,
  true, true, 15, 'claude',
  'Source fix is Change 1 (synthetic lp.disposition_changed on inbound pre-dispositioned leads) + Change 3 (Mark adds an E.0 other-branch exclusion in GHL). This is the agentic safety net for any booked lead that still reaches the cold path. requires_approval=TRUE until validated on a live inbound batch, then flip to FALSE. Guard disposition arm covers leads with no lp-route:* tag (canary Denise FDkW5LaKF4ArpyRL99Mc, OPPFDN). Workflow ids verified against workflow_registry canonical_code mapping 2026-06-17.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, context_conditions = EXCLUDED.context_conditions,
  action_template = EXCLUDED.action_template, requires_approval = EXCLUDED.requires_approval,
  enabled = EXCLUDED.enabled, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = now();
