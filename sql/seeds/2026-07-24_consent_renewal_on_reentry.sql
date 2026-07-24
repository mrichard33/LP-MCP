-- ════════════════════════════════════════════════════════════════════
-- CONSENT_RENEWAL_ON_REENTRY — re-entry = new consent
-- 2026-07-24  (Channel-Scoped DNC, Phase 2)
--
-- WHAT: when a NEW consumer-initiated inbound (web estimator / chatbot)
--   lands on a prospect who was DNC from PRIOR history, that inbound is a
--   fresh, express-consent inquiry — not a suppression signal. The paired
--   sync-leads.js emitter (shouldRenewConsent / emitConsentReestablished)
--   detects this and emits `consent.reestablished` INSTEAD of
--   lp.disposition_changed:DNC (which drove LP_DISP_DNC + RECONCILE and
--   suppressed Max Lesser — LP lead 561019 / prospect 447640 — before the
--   opener landed). This rule consumes that event and clears the DNC stack
--   in GHL + LP so the contact can be worked again.
--
-- COMPLIANCE: renewal is defensible ONLY because inbound web forms carry
--   express-consent language (TCPA prior express written consent). The
--   `consent.reestablished` event IS the audit trail — DNC history is never
--   silently deleted. The emitter's guard (first-appearance of a NEW lead +
--   consumer-inbound source bucket + recent createdAt) already excludes
--   rep-created opps, Five9, resellers, and re-reads of existing DNC leads —
--   so a valid post-inbound STOP revocation (e.g. Max texting STOP after his
--   inbound) is NEVER re-lifted, because his lead already exists on re-sync.
--
-- ⚠ DEPLOY ORDER — apply this seed ONLY AFTER the branch code is deployed:
--   * `consent.reestablished` is only emitted by the new sync-leads.js code;
--     pre-deploy this rule simply never matches (safe, inert).
--   * `dnc_code: "CLEAR"` is a NEW update_lp_dnc_status value the handler
--     only understands post-merge (lp-dnc.js + lp-client.js LP_DNC_CLEAR_CODE);
--     pre-deploy it would throw "invalid dnc_code".
--   * `bypass_suppression` on the remove/add tag actions must clear the stack
--     off a stop-bot contact (it otherwise blocks its own removal).
--   Sequence: merge+deploy code (Railway) → run this seed → POST
--   /n8n/decision-engine/reload-rules  (or wait out the 60s rule cache).
--
-- ⚠ LP_DNC_CLEAR_CODE is NOT yet probe-confirmed against production (the probe
--   mutates a live prospect's DNC on success, and the only known-DNC target on
--   hand is Max Lesser 447640, under a valid STOP revocation). Confirm the
--   exact clear value against a DISPOSABLE sandbox prospect, then set the
--   LP_DNC_CLEAR_CODE env var before relying on the CLEAR action in prod. A
--   wrong value fails LOUD (LP Result:0 / "Error:", contact tagged
--   lp-dnc-clear-failed, GroupMe alert) — never a silent mis-clear.
--
-- DEPLOYMENT: per the handoff directive — requires_approval = FALSE (immediate
--   consent restoration so the opener can land), priority 15, enabled TRUE.
--   The emitter guard + this rule's has_any_tag condition are the safety net.
--   To roll out supervised, flip requires_approval to TRUE, re-run, reload.
-- ════════════════════════════════════════════════════════════════════

INSERT INTO agent_rules (
  rule_key, rule_name, category, rule_type, event_pattern, conditions,
  action_template, enabled, priority, requires_approval, created_by, notes
)
VALUES (
  'CONSENT_RENEWAL_ON_REENTRY',
  'New consumer inbound on DNC contact → clear DNC everywhere (new consent)',
  'reconciliation', 'contextual',
  '{"event_type": "consent.reestablished"}'::jsonb,
  '{"has_any_tag": ["dnc", "dnc-sms", "dnc-voice", "lp-dnc", "stage:dnc", "lp-dnc:p", "lp-dnc:t", "lp-dnc:c"]}'::jsonb,
  '[
    {"action_type": "update_lp_dnc_status", "target_system": "lp", "target_entity": "contact", "priority": 5,
     "params": {"dnc_code": "CLEAR", "source": "consent.reestablished — new inbound inquiry"}},

    {"action_type": "remove_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"bypass_suppression": true, "tags": [
       "stop-bot", "dnc", "dnc-sms", "dnc-voice", "lp-dnc",
       "lp-dnc:p", "lp-dnc:t", "lp-dnc:c", "lp-dnc:e", "lp-dnc:m",
       "loss-reason:dnc", "mark-p1-lost", "suppress-outbound", "suppress-automation",
       "suppress:dnc-reply", "suppress:dnc-voice", "hard-disqualified",
       "stage:dnc", "p3:dnc", "lp-dnd:set"
     ]}},

    {"action_type": "set_dnd", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"status": "inactive", "channels": ["Email", "SMS", "Call", "WhatsApp", "GMB", "FB", "RCS"]}},

    {"action_type": "add_tag", "target_system": "ghl", "target_entity": "contact", "priority": 5,
     "params": {"tag": "recovery:consent-renewed", "bypass_suppression": true}},

    {"action_type": "resolve_objection_state", "target_system": "lp", "target_entity": "contact", "priority": 5,
     "params": {"resolution": "recovered", "trigger_source": "LP_WEBHOOK",
       "only_if_state": ["DISENGAGEMENT.hard_loss", "DISENGAGEMENT.soft_opt_out"]}},

    {"action_type": "send_notification", "target_system": "groupme", "target_entity": "contact",
     "params": {"notification_class": "intelligence", "action_verb": "CONSENT RENEWED: re-entry",
       "tier": "Recovered", "status": "Auto-lifted",
       "message": "CONSENT RENEWED: {{contact_name}} re-entered via a new web inbound (estimator/chatbot) — DNC lifted in GHL + LP, full stack cleared.",
       "narrative": "A NEW consumer-initiated inbound landed on {{contact_name}}, who was previously DNC. This is a fresh express-consent inquiry (TCPA prior express written consent), not a suppression signal. Cleared the LP DNC flag, removed the full GHL suppression stack (stop-bot / dnc / lp-dnc* / loss-reason:dnc / mark-p1-lost / suppress* / hard-disqualified / stage:dnc / p3:dnc / lp-dnd:set), lifted GHL DND on all channels, resolved any open loss objection-state (recovered), and tagged recovery:consent-renewed. The consent.reestablished event is the audit trail.",
       "next_step": "Confirm the opener/nurture proceeds; verify LP DNC actually cleared (watch for lp-dnc-clear-failed if the clear code is unconfirmed)."}}
  ]'::jsonb,
  true, 15, false, 'claude-handoff-2026-07-23',
  'Re-entry = new consent (Mark directive 2026-07-23). Paired with inbound-backfill consent.reestablished emitter (sync-leads.js shouldRenewConsent). Clears DNC in GHL + LP on a genuine new consumer inbound to a previously-DNC prospect. CLEAR relies on LP_DNC_CLEAR_CODE (probe-confirm before prod). bypass_suppression lets the removals run on a stop-bot contact. requires_approval=FALSE per directive; flip TRUE + reload-rules for supervised rollout.'
)
ON CONFLICT (rule_key) DO UPDATE SET
  rule_name = EXCLUDED.rule_name, category = EXCLUDED.category, rule_type = EXCLUDED.rule_type,
  event_pattern = EXCLUDED.event_pattern, conditions = EXCLUDED.conditions,
  action_template = EXCLUDED.action_template, enabled = EXCLUDED.enabled,
  priority = EXCLUDED.priority, requires_approval = EXCLUDED.requires_approval,
  notes = EXCLUDED.notes, updated_at = now();
