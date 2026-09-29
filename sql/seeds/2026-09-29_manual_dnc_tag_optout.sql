-- ═══════════════════════════════════════════════════════════════════════════
-- A `dnc` tag is a real opt-out — TAG_DNC_MANUAL_OPTOUT
-- 2026-09-29
--
-- WHY
--   A person added `dnc` to a contact in GHL and nothing was blocked. The only
--   rule on ghl.tag_added/dnc was 241 TAG_DNC_TO_HARDLOSS, which moves the
--   objection state and nothing else: no DND, no Five9 DNC, no LP DNC, no
--   consent record. The full opt-out ran only on a texted STOP
--   (BEHAVIORAL_DNC_REPLY), a verbal one (VOICE_DNC_REQUEST) or an LP DNC
--   disposition (LP_DISP_DNC).
--
--   Measured over the 30 days to 2026-09-29: 194 `dnc` tag adds, 90 alongside
--   one of those three rules. Most of the other 104 arrived with dnc-sms /
--   stop-bot / stage:dnc / p3:dnc — GHL's own STOP handling — and so never
--   reached Five9 or LP and have no consent row. This rule closes that too,
--   which is why it has NO "already opted out" guard: every step is idempotent
--   (set_dnd writes only channels that change, Five9/LP re-adds are no-ops).
--
-- WHAT IT BLOCKS — everything (Mark's team, 2026-09-29): every DND channel
--   (set_dnd with no channel list = Call, SMS, RCS, Email, WhatsApp, GMB, FB),
--   Five9, LP codes C + T, stop-bot, and consent all/dnc_full_on. It does NOT
--   set sms_carrier_stop: nobody texted STOP, so an approved Slack lift may
--   reopen texts. An approved lift (src/consent/dnc-lift-decision.js) undoes
--   every step here.
--
-- Rule 241 is unchanged and still does the state transition. Both rules match
--   the same event; the engine runs every match. TAG_ is not a dedup-policy
--   prefix, so a later re-add of `dnc` (after a lift) fires again.
--
-- `dnc` is already in ALLOWED_TAG_ADDED_SUBTYPES (rule 241).
--
-- Then POST /n8n/decision-engine/reload-rules. EXPECTED delta: +1 rule.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
SELECT
  'TAG_DNC_MANUAL_OPTOUT',
  'dnc tag added → full opt-out (all channels, Five9, LP, consent)',
  'reconciliation',
  '{"event_type": "ghl.tag_added", "event_subtype": "dnc"}'::jsonb,
  NULL,
  '{}'::jsonb,
  '[
    {"action_type": "set_dnd", "target_system": "ghl", "target_entity": "contact", "priority": 20,
     "params": {"status": "active", "reason": "TAG_DNC_MANUAL_OPTOUT — dnc tag added: do not contact on any channel"}},
    {"action_type": "five9_add_numbers_to_dnc", "target_system": "lp", "target_entity": "contact", "priority": 20,
     "params": {"reason": "dnc tag added in GHL — suppress dialing", "numbers_from_contact": true}},
    {"action_type": "update_lp_dnc_status", "target_system": "lp", "target_entity": "contact",
     "params": {"emp_id": "5686", "dnc_code": "C"}},
    {"action_type": "update_lp_dnc_status", "target_system": "lp", "target_entity": "contact",
     "params": {"emp_id": "5686", "dnc_code": "T"}},
    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact",
     "params": {"tag": "stop-bot"}},
    {"action_type": "record_consent_change", "target_system": "lp", "target_entity": "contact", "priority": 20,
     "params": {"channel": "all", "change": "dnc_full_on", "source": "manual_tag",
                "reason": "dnc tag added in GHL — do not contact on any channel"}}
  ]'::jsonb,
  FALSE, TRUE, 15, 'contextual', 'claude',
  '2026-09-29. A dnc tag is a full opt-out: every DND channel, Five9, LP C+T, stop-bot, consent all/dnc_full_on (source manual_tag). No sms_carrier_stop — nobody texted STOP. Rule 241 still does the state change. An approved Slack lift undoes all of it. Seed: sql/seeds/2026-09-29_manual_dnc_tag_optout.sql.'
WHERE NOT EXISTS (SELECT 1 FROM agent_rules WHERE rule_key = 'TAG_DNC_MANUAL_OPTOUT');

-- ── verify (expect one enabled row, 6 actions) ──
SELECT rule_key, enabled, jsonb_array_length(action_template) AS n_actions
  FROM agent_rules
 WHERE rule_key IN ('TAG_DNC_MANUAL_OPTOUT', 'TAG_DNC_TO_HARDLOSS')
 ORDER BY rule_key;

COMMIT;
