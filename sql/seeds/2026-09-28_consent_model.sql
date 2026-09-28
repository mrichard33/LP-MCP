-- ═══════════════════════════════════════════════════════════════════════════
-- Consent Model v1 — rule changes
-- 2026-09-28
--
-- APPLY ONLY AFTER the code PR is merged AND the Railway deploy is ACTIVE.
-- Every action type used below (record_consent_change, request_dnc_lift_review)
-- must exist before a rule can queue it; queued early, they fail as unknown
-- action types. Then POST /n8n/decision-engine/reload-rules.
--
-- WHAT
--   1. Appends record_consent_change to seven existing rules, so every opt-out
--      and every automatic lift writes contact_consent + consent_events:
--        BEHAVIORAL_DNC_REPLY   phone/revoked + phone/carrier_stop_on (sms_stop)
--        VOICE_DNC_REQUEST      phone/revoked (voice_request)
--        LP_DISP_DNC            all/dnc_full_on (lp_dnc)
--        DNC_LIFT_ON_REENGAGEMENT_LP, DNC_LIFT_ON_REENGAGEMENT_FIVE9,
--        DNC_LIFT_ON_REENTRY_CALCULATOR, DNC_LIFT_ON_REENTRY_E0
--                               all/dnc_full_off + phone/granted (auto_lift)
--      NO OTHER ACTION IN THESE TEMPLATES CHANGES. Each UPDATE only appends,
--      and each is guarded so re-running the file is a no-op.
--   2. Adds DNC_LIFT_REVIEW_REQUEST (manual `dnc-lift:request` tag) and
--      DNC_LIFT_REVIEW_REQUEST_REENTRY (a re-entry the first-party auto-lift
--      does not own). Both queue request_dnc_lift_review, which posts the
--      Approve / Keep Blocked card via n8n to #dnc-lift-approval. They only
--      ASK — requires_approval false.
--
-- carrier_stop_on on BEHAVIORAL_DNC_REPLY carries require_event_channel
--   ["sms"]: that rule fires on a STOP from email and live chat too, and
--   carrier_stop means "texted STOP". A STOP whose channel is unknown is still
--   recorded. phone/revoked has no such filter — it mirrors what the rule
--   already does today (SMS+Call DND, LP T+C, Five9) on every channel.
--
-- WHY TWO REVIEW RULES: a rule has one event_pattern.event_type, and the
--   handoff's trigger is "ghl.entry_detected/reentry OR ghl.tag_added/
--   dnc-lift:request".
--
-- "Not already reviewed in the last 24h" has no rule operator; the handler
--   enforces it from dnc_lift_requests (sql/140), and also refuses a contact
--   that DNC_LIFT_ON_REENTRY_E0 owns (consent:new-submission and no STOP).
--
-- VERIFIED 2026-09-28 — DNC_LIFT_ON_REENTRY_E0 fires for FIRST-PARTY sources
--   only, so no context condition was added to it. The rule keys on
--   has_tag consent:new-submission; the HL workflow mirror (synced
--   2026-09-28 16:00 ET) shows exactly four workflows that ADD that tag —
--   U.CW Chat Widget Tag Added, I.WC Calculator Completed, B.1A Live Chat
--   First-Touch, E.1 Risk Report Bridge — all first-party. U.CEF Canvassing
--   removes it; no vendor or ActiveProspect intake writes it; E.0 posts
--   source=reentry only when the tag is present. Zero reentry events so far.
--   Consequence for DNC_LIFT_REVIEW_REQUEST_REENTRY: today a reentry event
--   always carries the consent tag, so it will fire only for a first-party
--   re-entry by someone who texted/said STOP (which E0 refuses by design).
--   Vendor/AP re-entries reach review through the manual tag until E.0 grows
--   a branch that posts reentry without consent:new-submission.
--
-- EXPECTED reload-rules delta: +2 rules.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1a. BEHAVIORAL_DNC_REPLY — texted STOP ────────────────────────────────
UPDATE agent_rules
SET action_template = action_template || '[
      {"action_type": "record_consent_change", "target_system": "lp", "target_entity": "contact", "priority": 20,
       "params": {"channel": "phone", "change": "revoked", "source": "sms_stop",
                  "reason": "Contact-initiated STOP reply — texts + automated calls (FCC 24-24 para. 32)"}},
      {"action_type": "record_consent_change", "target_system": "lp", "target_entity": "contact", "priority": 20,
       "params": {"channel": "phone", "change": "carrier_stop_on", "source": "sms_stop",
                  "require_event_channel": ["sms"],
                  "reason": "Lead texted STOP — SMS reopens only on START/UNSTOP or a new form with SMS consent"}}
    ]'::jsonb,
    updated_at = now()
WHERE rule_key = 'BEHAVIORAL_DNC_REPLY'
  AND NOT (action_template @> '[{"action_type":"record_consent_change"}]'::jsonb);

-- ── 1b. VOICE_DNC_REQUEST — verbal "stop calling" ─────────────────────────
UPDATE agent_rules
SET action_template = action_template || '[
      {"action_type": "record_consent_change", "target_system": "lp", "target_entity": "contact", "priority": 20,
       "params": {"channel": "phone", "change": "revoked", "source": "voice_request",
                  "reason": "Verbal opt-out on a call — calls + texts (FCC 24-24 para. 32); email continues"}}
    ]'::jsonb,
    updated_at = now()
WHERE rule_key = 'VOICE_DNC_REQUEST'
  AND NOT (action_template @> '[{"action_type":"record_consent_change"}]'::jsonb);

-- ── 1c. LP_DISP_DNC — LP disposition DNC ──────────────────────────────────
UPDATE agent_rules
SET action_template = action_template || '[
      {"action_type": "record_consent_change", "target_system": "lp", "target_entity": "contact", "priority": 20,
       "params": {"channel": "all", "change": "dnc_full_on", "source": "lp_dnc",
                  "reason": "LP disposition DNC"}}
    ]'::jsonb,
    updated_at = now()
WHERE rule_key = 'LP_DISP_DNC'
  AND NOT (action_template @> '[{"action_type":"record_consent_change"}]'::jsonb);

-- ── 1d. The four automatic lifts ──────────────────────────────────────────
UPDATE agent_rules
SET action_template = action_template || jsonb_build_array(
      jsonb_build_object('action_type', 'record_consent_change', 'target_system', 'lp', 'target_entity', 'contact', 'priority', 5,
        'params', jsonb_build_object('channel', 'all', 'change', 'dnc_full_off', 'source', 'auto_lift',
                                     'reason', 'Automatic DNC lift — ' || rule_key)),
      jsonb_build_object('action_type', 'record_consent_change', 'target_system', 'lp', 'target_entity', 'contact', 'priority', 5,
        'params', jsonb_build_object('channel', 'phone', 'change', 'granted', 'source', 'auto_lift',
                                     'reason', 'Automatic DNC lift — ' || rule_key))
    ),
    updated_at = now()
WHERE rule_key IN ('DNC_LIFT_ON_REENGAGEMENT_LP', 'DNC_LIFT_ON_REENGAGEMENT_FIVE9',
                   'DNC_LIFT_ON_REENTRY_CALCULATOR', 'DNC_LIFT_ON_REENTRY_E0')
  AND NOT (action_template @> '[{"action_type":"record_consent_change"}]'::jsonb);

-- ── 2a. DNC_LIFT_REVIEW_REQUEST — a person asked for a review ─────────────
INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
SELECT
  'DNC_LIFT_REVIEW_REQUEST',
  'Manual DNC-lift request tag → Slack approval card',
  'reconciliation',
  '{"event_type": "ghl.tag_added", "event_subtype": "dnc-lift:request"}'::jsonb,
  NULL,
  '{"has_any_tag": ["dnc", "dnc-sms", "dnc-voice", "stage:dnc", "p3:dnc", "lp-dnc", "do-not-contact", "loss-reason:dnc", "stop-bot"]}'::jsonb,
  '[
    {"action_type": "request_dnc_lift_review", "target_system": "lp", "target_entity": "contact", "priority": 20,
     "params": {"trigger": "manual_tag"}},
    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 200,
     "params": {"tag": "dnc-lift:request", "bypass_suppression": true}}
  ]'::jsonb,
  FALSE, TRUE, 15, 'contextual', 'claude',
  '2026-09-28 Consent Model v1. Asks only — the lift happens when a person clicks Approve in #dnc-lift-approval (n8n OPS.DNC-LIFT → POST /slack/dnc-lift/decision). The handler skips a contact reviewed in the last 24h (dnc_lift_requests) and one DNC_LIFT_ON_REENTRY_E0 owns. The request tag is removed at priority 200 so it can be re-added later. dnc-lift:request is in ALLOWED_TAG_ADDED_SUBTYPES.'
WHERE NOT EXISTS (SELECT 1 FROM agent_rules WHERE rule_key = 'DNC_LIFT_REVIEW_REQUEST');

-- ── 2b. DNC_LIFT_REVIEW_REQUEST_REENTRY — a re-entry E0 will not lift ─────
INSERT INTO agent_rules
  (rule_key, rule_name, category, event_pattern, conditions, context_conditions,
   action_template, requires_approval, enabled, priority, rule_type, created_by, notes)
SELECT
  'DNC_LIFT_REVIEW_REQUEST_REENTRY',
  'DNC re-entry not covered by the first-party auto-lift → Slack approval card',
  'reconciliation',
  '{"event_type": "ghl.entry_detected", "event_subtype": "reentry"}'::jsonb,
  NULL,
  '{"has_any_tag": ["dnc", "dnc-sms", "dnc-voice", "stage:dnc", "p3:dnc", "lp-dnc", "do-not-contact", "loss-reason:dnc", "stop-bot"],
    "any_of": [
      {"not_has_tag": "consent:new-submission"},
      {"has_any_tag": ["suppress:dnc-reply", "suppress:dnc-voice"]}
    ]}'::jsonb,
  '[
    {"action_type": "request_dnc_lift_review", "target_system": "lp", "target_entity": "contact", "priority": 20,
     "params": {"trigger": "reentry"}}
  ]'::jsonb,
  FALSE, TRUE, 15, 'contextual', 'claude',
  '2026-09-28 Consent Model v1. The mirror of DNC_LIFT_ON_REENTRY_E0: fires exactly when E0 will NOT lift — no first-party consent tag, or a contact-initiated STOP (which E0 refuses by design; a STOP is cleared by a human). Asks only. 24h dedup + E0-ownership re-checked in the handler.'
WHERE NOT EXISTS (SELECT 1 FROM agent_rules WHERE rule_key = 'DNC_LIFT_REVIEW_REQUEST_REENTRY');

-- ── verify (expect 7 updated rules carrying record_consent_change, 2 new) ──
SELECT rule_key,
       (action_template @> '[{"action_type":"record_consent_change"}]'::jsonb) AS has_consent_write,
       jsonb_array_length(action_template) AS n_actions
  FROM agent_rules
 WHERE rule_key IN ('BEHAVIORAL_DNC_REPLY','VOICE_DNC_REQUEST','LP_DISP_DNC',
                    'DNC_LIFT_ON_REENGAGEMENT_LP','DNC_LIFT_ON_REENGAGEMENT_FIVE9',
                    'DNC_LIFT_ON_REENTRY_CALCULATOR','DNC_LIFT_ON_REENTRY_E0',
                    'DNC_LIFT_REVIEW_REQUEST','DNC_LIFT_REVIEW_REQUEST_REENTRY')
 ORDER BY rule_key;

COMMIT;
