-- ═══════════════════════════════════════════════════════════════════════════
-- DNC_LIFT_ON_REENTRY_E0 — lift the Five9 arm too
-- 2026-09-21
--
-- WHAT
--   Adds five9_remove_numbers_from_dnc_reentry to DNC_LIFT_ON_REENTRY_E0 at
--   action priority 100, and rewrites the rule's notification narrative,
--   which currently tells the floor to dial manually.
--
-- WHY
--   Mark's ruling: a lead who re-enters through a fresh first-party
--   submission has DNC lifted EVERYWHERE, Five9 included. The rule already
--   lifts GHL tags, DND and the LP objection state — but Five9 DNC has been
--   add-only since five9_remove_numbers_from_dnc was deleted on 2026-08-21,
--   so a re-entered lead was routed, worked, and then silently skipped by
--   the dialer. The rule's own card had to say so:
--     "Five9 DNC is add-only and was NOT removed."
--     "If this lead should be called, dial manually."
--
-- WHAT THIS DOES NOT DO — READ THIS BEFORE WIDENING IT
--   It does NOT lift a contact-initiated STOP. suppress:dnc-reply and
--   suppress:dnc-voice are in this rule's not_has_any_tag (added 2026-09-16)
--   and stay there by decision, 2026-09-21: a person who texted STOP is
--   cleared by a human, deliberately.
--
--   That matters more from today than it did yesterday. Until now
--   suppress:dnc-reply was written only for the minority of STOPs that
--   BEHAVIORAL_DNC_REPLY actually processed. With the stage-gate fix
--   (sql/seeds/2026-09-21_behavioral_dnc_reply_five9.sql) every STOP gets the
--   tag, so this rule will correctly lift only rep-keyed and system DNC.
--   The narrowing is intended.
--
--   It is also NOT a general Five9 DNC removal. The op refuses any caller
--   whose rule_applied is not DNC_LIFT_ON_REENTRY_E0, re-reads the contact
--   at execution time to confirm consent:new-submission is STILL present,
--   and refuses a triggering event older than 15 minutes.
--
-- ORDER OF OPERATIONS
--   1. Merge the code PR (which depends on the Part A PR for
--      resolveContactDncNumbers) and let Railway deploy. The action type must
--      exist before a rule can queue it.
--   2. Mark's GHL work must be done or this rule still never fires:
--        - tag consent:new-submission written by I.WC, the website
--          form-submitted workflows, U.CW and B.1A. NOT vendor intake.
--        - E.0 first branch: if dnc|stage:dnc|dnc-sms|stop-bot → Wait 1 min →
--          if consent:new-submission → POST /webhook/ghl/entry
--          (contactId={{contact.id}}, source=reentry) → end run; else
--          continue unchanged. If no DNC tag but has consent:new-submission →
--          remove that tag and continue.
--   3. Apply this seed.
--   4. POST /n8n/decision-engine/reload-rules; rules_loaded UNCHANGED
--      (this seed adds no rules — last recorded count 290).
--
-- IMPACT
--   A re-entered lead is actually dialable. Every lift writes a
--   five9.dnc_removed_reentry audit event naming the numbers, the triggering
--   event and its age.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The Five9 lift, at action priority 100 ────────────────────────────
-- BEFORE the priority-200 removal of consent:new-submission. The op re-reads
-- that tag at execution time, so if the removal ran first the lift would
-- refuse itself. Rule-356 lesson: same-lane ordering is not guaranteed, so
-- the two are in different lanes rather than merely in a good order.

UPDATE agent_rules
SET action_template = action_template || '[{
      "action_type": "five9_remove_numbers_from_dnc_reentry",
      "target_system": "lp",
      "target_entity": "contact",
      "priority": 100,
      "params": {"numbers_from_contact": true}
    }]'::jsonb,
    updated_at = now()
WHERE rule_key = 'DNC_LIFT_ON_REENTRY_E0'
  AND NOT (action_template @> '[{"action_type":"five9_remove_numbers_from_dnc_reentry"}]'::jsonb);

-- ── 2. The card no longer tells the floor to dial manually ───────────────
-- Rewrites the send_notification element in place, leaving every other
-- action untouched. jsonb_agg preserves array order.

UPDATE agent_rules
SET action_template = (
      SELECT jsonb_agg(
        CASE WHEN elem->>'action_type' = 'send_notification'
          THEN jsonb_set(
                 jsonb_set(elem, '{params,narrative}',
                   to_jsonb('{{contact_name}} was on DNC and submitted a new request. DNC lifted in GHL and in Five9, and the lead was sent back through E.0 for normal routing.'::text)),
                 '{params,next_step}',
                 to_jsonb('Nothing to do. If this person should stay suppressed, re-apply stop-bot — a texted STOP is never auto-lifted.'::text))
          ELSE elem END
        ORDER BY ord)
      FROM jsonb_array_elements(action_template) WITH ORDINALITY AS t(elem, ord)
    ),
    updated_at = now()
WHERE rule_key = 'DNC_LIFT_ON_REENTRY_E0'
  AND action_template @> '[{"action_type":"five9_remove_numbers_from_dnc_reentry"}]'::jsonb;

-- ── 3. Record why ────────────────────────────────────────────────────────

UPDATE agent_rules
SET notes = notes || E'\n2026-09-21 (Claude Code): Five9 arm added. '
                  || E'five9_remove_numbers_from_dnc_reentry at action priority 100, BEFORE the '
                  || E'priority-200 consent-tag removal — the op re-reads consent:new-submission at '
                  || E'execution time and would refuse itself if the tag were already gone. '
                  || E'The op is not a general removal: it refuses any rule_applied but this one, '
                  || E'refuses a missing consent tag, and refuses a triggering event older than 15 '
                  || E'minutes. Narrative no longer tells the floor to dial manually. '
                  || E'suppress:dnc-reply / suppress:dnc-voice REMAIN in not_has_any_tag by decision: '
                  || E'a contact-initiated STOP is cleared by a human. From today that gate bites far '
                  || E'more often, because the stage-gate fix means every STOP now actually gets '
                  || E'suppress:dnc-reply — previously only the minority the rule managed to process did.',
    updated_at = now()
WHERE rule_key = 'DNC_LIFT_ON_REENTRY_E0';

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────────
-- SELECT jsonb_array_length(action_template) AS n,
--        action_template @> '[{"action_type":"five9_remove_numbers_from_dnc_reentry"}]'::jsonb AS has_five9,
--        action_template::text NOT LIKE '%dial manually%' AS narrative_fixed
--   FROM agent_rules WHERE rule_key = 'DNC_LIFT_ON_REENTRY_E0';
--   -- expect 16 / true / true
--
-- Reload and confirm rules_loaded is UNCHANGED (290) — no rules added.
--
-- Then ONE real re-entry, end to end:
--   * GHL: dnc / dnc-sms / stage:dnc / p3:dnc / stop-bot all gone, DND inactive
--   * five9_check_dnc on the contact's number → not_on_dnc
--   * the contact re-routed by E.0
--   * SELECT * FROM system_events WHERE event_type = 'five9.dnc_removed_reentry'
--     ORDER BY id DESC LIMIT 1;   -- names the numbers, the event and its age

-- ── Rollback ─────────────────────────────────────────────────────────────
--   -- Narrowest: drop just the Five9 arm, keep the GHL/LP lift working.
--   UPDATE agent_rules
--      SET action_template = (
--            SELECT jsonb_agg(a) FROM jsonb_array_elements(action_template) a
--             WHERE a->>'action_type' <> 'five9_remove_numbers_from_dnc_reentry'),
--          updated_at = now()
--    WHERE rule_key = 'DNC_LIFT_ON_REENTRY_E0';
--
--   -- Widest: stop the whole re-entry lift.
--   UPDATE agent_rules SET enabled = FALSE WHERE rule_key = 'DNC_LIFT_ON_REENTRY_E0';
--
--   then POST /n8n/decision-engine/reload-rules.
--
--   Neither rollback re-adds anyone to Five9 DNC. Numbers already lifted stay
--   lifted; re-suppressing one is a deliberate five9_add_numbers_to_dnc.
