-- ═══════════════════════════════════════════════════════════════════════════
-- A channel tag blocks only its channel — TAG_DNC_{SMS,VOICE,EMAIL}_OPTOUT
-- 2026-09-29
--
-- APPLY ONLY AFTER the code that adds dnc-sms / dnc-voice / dnc-email to
-- ALLOWED_TAG_ADDED_SUBTYPES (src/services/event-intake-filter.js) is merged
-- and the Railway deploy is ACTIVE — until then the intake filter drops those
-- tag events and these rules never see one. Then
-- POST /n8n/decision-engine/reload-rules. EXPECTED delta: +3 rules.
--
-- THE RULING (the user, 2026-09-29): a contact is opted out ONLY on the
--   channel they asked to stop. Plain `dnc` blocks nothing (rule 241 moves the
--   objection state only); TAG_DNC_MANUAL_OPTOUT, which made it a full
--   opt-out, is disabled (see 2026-09-29_manual_dnc_tag_optout.sql).
--     dnc-sms, dnc-voice → calls + texts. `phone` is the FCC 24-24 pair (para.
--                          32): a text or spoken STOP revokes both. Never
--                          split without counsel (CONSENT_SPLIT_SMS_CALL).
--     dnc-email          → email only. No Five9, no LP.
--   Same actions as the automatic opt-outs already use (BEHAVIORAL_DNC_REPLY,
--   VOICE_DNC_REQUEST). No stop-bot: SMS DND already stops the bot's texts,
--   exactly as a STOP reply does today.
--
-- GUARDS. BEHAVIORAL_DNC_REPLY adds suppress:dnc-reply then dnc-sms, and
--   VOICE_DNC_REQUEST adds dnc-voice + suppress:dnc-voice — so without a guard
--   every automatic opt-out would run a second time and be re-recorded as a
--   tag. not_has_tag reads the contact live. What still fires: a person adding
--   the tag, and GHL's own STOP handling, which tags dnc-sms (~100 contacts in
--   the 30 days to 2026-09-29) and until now never reached Five9 or LP.
--
-- LP gets ONE code, C (Do Not Call) — LP holds a single internal DNC value per
--   prospect, so a C then a T used to leave only T (the user's ruling
--   2026-09-29: calls + texts opt-outs are Do Not Call in LP). See
--   2026-09-29_lp_dnc_single_code.sql.
--
-- LIFT. dnc-sms is a carrier-STOP signal to the lift (detectCarrierStop): an
--   approved lift gives calls, LP and Five9 back and leaves texts off. The
--   lift clears dnc-voice and dnc-email and turns Email DND off.
--
-- Also adds dnc-email to both review rules' has_any_tag, so an email-only
--   block can be put up for review.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── dnc-sms → calls + texts ───────────────────────────────────────────────
INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
SELECT
  'TAG_DNC_SMS_OPTOUT',
  'dnc-sms tag → opt out of calls + texts (Five9, LP Do Not Call, consent)',
  'reconciliation',
  '{"event_type": "ghl.tag_added", "event_subtype": "dnc-sms"}'::jsonb,
  NULL,
  '{"not_has_tag": "suppress:dnc-reply"}'::jsonb,
  '[
    {"action_type": "set_dnd", "target_system": "ghl", "target_entity": "contact", "priority": 20,
     "params": {"status": "active", "channels": ["SMS", "RCS", "Call"], "reason": "TAG_DNC_SMS_OPTOUT — dnc-sms tag: calls + texts (FCC 24-24 pair); email continues"}},
    {"action_type": "five9_add_numbers_to_dnc", "target_system": "lp", "target_entity": "contact", "priority": 20,
     "params": {"reason": "dnc-sms tag in GHL — suppress dialing", "numbers_from_contact": true}},
    {"action_type": "update_lp_dnc_status", "target_system": "lp", "target_entity": "contact",
     "params": {"emp_id": "5686", "dnc_code": "C"}},
    {"action_type": "record_consent_change", "target_system": "lp", "target_entity": "contact", "priority": 20,
     "params": {"channel": "phone", "change": "revoked", "source": "ghl_tag",
                "reason": "dnc-sms tag added in GHL — texts + automated calls (FCC 24-24 para. 32); email continues"}}
  ]'::jsonb,
  FALSE, TRUE, 15, 'contextual', 'claude',
  '2026-09-29. Per-channel opt-out: dnc-sms blocks calls + texts only. Guarded on suppress:dnc-reply so a STOP reply (which adds that tag first) is not run twice. Seed: sql/seeds/2026-09-29_channel_dnc_tags.sql.'
WHERE NOT EXISTS (SELECT 1 FROM agent_rules WHERE rule_key = 'TAG_DNC_SMS_OPTOUT');

-- ── dnc-voice → calls + texts ─────────────────────────────────────────────
INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
SELECT
  'TAG_DNC_VOICE_OPTOUT',
  'dnc-voice tag → opt out of calls + texts (Five9, LP Do Not Call, consent)',
  'reconciliation',
  '{"event_type": "ghl.tag_added", "event_subtype": "dnc-voice"}'::jsonb,
  NULL,
  '{"not_has_tag": "suppress:dnc-voice"}'::jsonb,
  '[
    {"action_type": "set_dnd", "target_system": "ghl", "target_entity": "contact", "priority": 20,
     "params": {"status": "active", "channels": ["SMS", "RCS", "Call"], "reason": "TAG_DNC_VOICE_OPTOUT — dnc-voice tag: calls + texts (FCC 24-24 pair); email continues"}},
    {"action_type": "five9_add_numbers_to_dnc", "target_system": "lp", "target_entity": "contact", "priority": 20,
     "params": {"reason": "dnc-voice tag in GHL — suppress dialing", "numbers_from_contact": true}},
    {"action_type": "update_lp_dnc_status", "target_system": "lp", "target_entity": "contact",
     "params": {"emp_id": "5686", "dnc_code": "C"}},
    {"action_type": "record_consent_change", "target_system": "lp", "target_entity": "contact", "priority": 20,
     "params": {"channel": "phone", "change": "revoked", "source": "ghl_tag",
                "reason": "dnc-voice tag added in GHL — calls + texts (FCC 24-24 para. 32); email continues"}}
  ]'::jsonb,
  FALSE, TRUE, 15, 'contextual', 'claude',
  '2026-09-29. Per-channel opt-out: dnc-voice blocks calls + texts only. Guarded on suppress:dnc-voice so VOICE_DNC_REQUEST (which adds that tag) is not run twice. Seed: sql/seeds/2026-09-29_channel_dnc_tags.sql.'
WHERE NOT EXISTS (SELECT 1 FROM agent_rules WHERE rule_key = 'TAG_DNC_VOICE_OPTOUT');

-- ── dnc-email → email only ────────────────────────────────────────────────
INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
SELECT
  'TAG_DNC_EMAIL_OPTOUT',
  'dnc-email tag → opt out of email only (consent)',
  'reconciliation',
  '{"event_type": "ghl.tag_added", "event_subtype": "dnc-email"}'::jsonb,
  NULL,
  '{}'::jsonb,
  '[
    {"action_type": "set_dnd", "target_system": "ghl", "target_entity": "contact", "priority": 20,
     "params": {"status": "active", "channels": ["Email"], "reason": "TAG_DNC_EMAIL_OPTOUT — dnc-email tag: email only; calls + texts continue"}},
    {"action_type": "record_consent_change", "target_system": "lp", "target_entity": "contact", "priority": 20,
     "params": {"channel": "email", "change": "revoked", "source": "ghl_tag",
                "reason": "dnc-email tag added in GHL — email only"}}
  ]'::jsonb,
  FALSE, TRUE, 15, 'contextual', 'claude',
  '2026-09-29. Per-channel opt-out: dnc-email blocks email only — no Five9, no LP. Seed: sql/seeds/2026-09-29_channel_dnc_tags.sql.'
WHERE NOT EXISTS (SELECT 1 FROM agent_rules WHERE rule_key = 'TAG_DNC_EMAIL_OPTOUT');

-- ── an email-only block can be reviewed too ───────────────────────────────
UPDATE agent_rules
   SET context_conditions = jsonb_set(context_conditions, '{has_any_tag}',
                                      (context_conditions->'has_any_tag') || '["dnc-email"]'::jsonb),
       updated_at = now()
 WHERE rule_key IN ('DNC_LIFT_REVIEW_REQUEST', 'DNC_LIFT_REVIEW_REQUEST_REENTRY')
   AND NOT (context_conditions->'has_any_tag' ? 'dnc-email');

-- ── verify (expect 3 new enabled rules; both review rules list dnc-email;
--    TAG_DNC_MANUAL_OPTOUT disabled) ──
SELECT rule_key, enabled, jsonb_array_length(action_template) AS n_actions,
       (context_conditions->'has_any_tag' ? 'dnc-email') AS reviews_dnc_email
  FROM agent_rules
 WHERE rule_key IN ('TAG_DNC_SMS_OPTOUT', 'TAG_DNC_VOICE_OPTOUT', 'TAG_DNC_EMAIL_OPTOUT',
                    'DNC_LIFT_REVIEW_REQUEST', 'DNC_LIFT_REVIEW_REQUEST_REENTRY',
                    'TAG_DNC_MANUAL_OPTOUT')
 ORDER BY rule_key;

COMMIT;
