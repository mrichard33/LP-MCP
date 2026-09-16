-- ════════════════════════════════════════════════════════════════════
-- ENTRY_HYGIENE_AT_CREATION_{OTHER,FALLBACK,UNKNOWN} — stop wiping the
-- namespace before re-stamping it
-- 2026-09-16
--
-- WHAT: drops two actions from each of three rules' action_template —
--
--     {"action_type": "remove_tag", "params": {"prefix": "source:"}}
--     {"action_type": "remove_tag", "params": {"prefix": "active-entry:"}}
--
--   leaving the three add_tag actions (entry:other, active-entry:other,
--   source:unknown). Nothing else changes: same rules, same event patterns,
--   same conditions, same approval tier.
--
-- WHY: a blanket prefix wipe is executed by executeRemoveTag, which never
--   consults decideTagWrite. The MVI v2.8 fallback guard therefore could not
--   see it — the rule had already deleted the specific tag before anything
--   was asked to judge the add. The guard says "a fallback carries no routing
--   information, so it must never evict a specific sibling that does"; these
--   rules evicted it out of band and then wrote the fallback.
--
--   Measured over 30 days to 2026-09-16:
--     source:       1,580 contacts lost a specific vendor tag
--                   (OTHER 1,482 + FALLBACK 98) — internet-modernize,
--                   my-home-pros, homebuddy, angi, lead-gurus,
--                   contractor-appointments. Paid vendors, straight into
--                   revenue-by-source and vendor ROI.
--     active-entry: 46 contacts demoted to active-entry:other from a real
--                   routing value (canvassing x36, high-intent-digital x6,
--                   referral x2, estimate-calculator x2), all via FALLBACK.
--                   The other ~1,987 removals were active-entry:other being
--                   deleted only to be re-added — pure churn, ~4,000 wasted
--                   GHL calls a month against a bucket that was starved.
--
--   Rule 266's own notes already said "entry:* immutability +
--   active-entry:*/source:* exclusivity enforced by executor MVI v2.6". That
--   was correct, and it is why the explicit wipe was redundant — it existed
--   only to defeat the guard the author believed was protecting them.
--
--   Live case that surfaced it: contact leP1lS9hUp8LdPjGsUZQ (GHL source
--   "Contractor Appointments"), 2026-09-16 03:02. The routing-tags path
--   correctly declined (fallback_blocked: true, both tags kept) — and 90
--   seconds later actions 464623/464624 from ENTRY_HYGIENE_AT_CREATION_OTHER
--   wiped source: and wrote source:unknown anyway.
--
-- INVARIANT — "one active-entry:/source: per contact" still holds. Removing
--   the wipe does not stack tags:
--     specific -> specific   SWAP  (ordinary exclusivity removes the incumbent)
--     specific -> fallback   NO-OP (the guard declines; nothing is added)
--     nothing  -> fallback   ADD
--     fallback -> fallback   NO-OP
--   A contact never ends with two.
--
-- DEPENDENCY — do NOT apply this before LP-MCP PR #950 is deployed. It
--   registers 'source:' in NAMESPACE_FALLBACK_VALUES; without it the guard
--   does not cover source: and removing the wipe would let source:unknown
--   swap out a vendor tag by ordinary exclusivity instead — same loss, new
--   route. (#950 merged and deployed 2026-09-16 02:00 UTC; this was applied
--   live at 03:26 UTC, after.)
--
-- ORDER OF OPERATIONS:
--   1. confirm PR #950 is live (GET /n8n/rate-limiter/stats shows refillPerMin
--      — any response from the #950 build will do);
--   2. run this file;
--   3. POST /n8n/decision-engine/reload-rules and assert rules_loaded is
--      UNCHANGED (283 -> 283 on 2026-09-16) — this modifies rules, it does not
--      add or disable any;
--   4. verify a firing: next ghl.contact_created with subtype other/unknown on
--      a contact carrying a vendor source tag should leave that tag in place.
-- ════════════════════════════════════════════════════════════════════
BEGIN;

UPDATE agent_rules
SET action_template = (
      SELECT COALESCE(jsonb_agg(elem ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(action_template) WITH ORDINALITY AS t(elem, ord)
      WHERE NOT (elem->>'action_type' = 'remove_tag'
                 AND elem->'params'->>'prefix' IN ('source:', 'active-entry:'))
    ),
    updated_at = NOW()
WHERE rule_key IN (
  'ENTRY_HYGIENE_AT_CREATION_OTHER',
  'ENTRY_HYGIENE_AT_CREATION_FALLBACK',
  'ENTRY_HYGIENE_AT_CREATION_UNKNOWN'
);

COMMIT;

-- Verification (expect 3 rows, actions = 3, still_has_remove = false):
--   SELECT json_agg(row_to_json(s)) FROM (
--     SELECT rule_key, jsonb_array_length(action_template) AS actions,
--            action_template::text LIKE '%remove_tag%' AS still_has_remove
--     FROM agent_rules
--     WHERE rule_key IN ('ENTRY_HYGIENE_AT_CREATION_OTHER',
--                        'ENTRY_HYGIENE_AT_CREATION_FALLBACK',
--                        'ENTRY_HYGIENE_AT_CREATION_UNKNOWN')
--     ORDER BY rule_key) s;
--
-- Confirms the loss has stopped (expect 0 after the apply timestamp):
--   SELECT count(DISTINCT a.target_id)
--   FROM agent_actions a,
--     LATERAL jsonb_array_elements_text((a.execution_result)::jsonb->'tags') AS t
--   WHERE a.action_type = 'remove_tag'
--     AND a.action_payload::text LIKE '%"prefix": "source:"%'
--     AND a.created_at > '2026-09-16T03:26:31Z'
--     AND a.rule_applied IN ('ENTRY_HYGIENE_AT_CREATION_OTHER',
--                            'ENTRY_HYGIENE_AT_CREATION_FALLBACK',
--                            'ENTRY_HYGIENE_AT_CREATION_UNKNOWN')
--     AND t.value LIKE 'source:internet-%';
--
-- Reload required after apply:
--   POST /n8n/decision-engine/reload-rules  (assert rules_loaded unchanged)
--
-- Rollback — restores the wipes on all three rules, then reload:
--   UPDATE agent_rules
--   SET action_template = jsonb_build_array(
--         jsonb_build_object('action_type','add_tag','target_system','ghl',
--           'target_entity','contact','params',jsonb_build_object('tag','entry:other')),
--         jsonb_build_object('action_type','remove_tag','target_system','ghl',
--           'target_entity','contact','params',jsonb_build_object('prefix','active-entry:')),
--         jsonb_build_object('action_type','add_tag','target_system','ghl',
--           'target_entity','contact','params',jsonb_build_object('tag','active-entry:other')),
--         jsonb_build_object('action_type','remove_tag','target_system','ghl',
--           'target_entity','contact','params',jsonb_build_object('prefix','source:')),
--         jsonb_build_object('action_type','add_tag','target_system','ghl',
--           'target_entity','contact','params',jsonb_build_object('tag','source:unknown'))),
--       updated_at = NOW()
--   WHERE rule_key IN ('ENTRY_HYGIENE_AT_CREATION_OTHER',
--                      'ENTRY_HYGIENE_AT_CREATION_FALLBACK',
--                      'ENTRY_HYGIENE_AT_CREATION_UNKNOWN');
--   -- NOTE: rolling this back re-opens the attribution loss. Prefer reverting
--   -- PR #950 first if the guard itself is the problem.
