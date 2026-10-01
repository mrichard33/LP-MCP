-- ═══════════════════════════════════════════════════════════════════════════
-- Channel opt-out rules fire only if the tag is REALLY on the contact — 2026-09-30
--
-- WHY. ghl.tag_added is a diff of GHL webhook snapshots (src/ghl-tag-handler.js),
-- and GHL can deliver them out of order: a stale snapshot that still carries a
-- tag, arriving after one without it, reads as "tag added". On 2026-09-30
-- DNC_LIFT_ON_REENGAGEMENT_LP auto-lifted HSbgCxhok5IMEj8reiP4 (LP disposition
-- Cnf — a confirmed appointment) and removed dnc-sms at 15:05:54 UTC; a
-- "dnc-sms added" event followed at 15:06:00 and TAG_DNC_SMS_OPTOUT re-blocked
-- calls + texts, Five9 and LP. The contact never carried dnc-sms again.
--
-- FIX. has_tag <the rule's own tag>, which reads the contact live (GHL fetch,
-- snapshot fallback; fail-closed when unreadable). The other 9 contacts the
-- sms rule fired on that week still carry dnc-sms, so it would have let every
-- real opt-out through.
--
-- Applied live 2026-09-30 ~22:45 UTC, then reload-rules. Re-running is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE agent_rules
   SET context_conditions = coalesce(context_conditions, '{}'::jsonb)
         || jsonb_build_object('has_tag', CASE rule_key WHEN 'TAG_DNC_SMS_OPTOUT' THEN 'dnc-sms'
                                                        WHEN 'TAG_DNC_VOICE_OPTOUT' THEN 'dnc-voice'
                                                        ELSE 'dnc-email' END),
       updated_at = now()
 WHERE rule_key IN ('TAG_DNC_SMS_OPTOUT', 'TAG_DNC_VOICE_OPTOUT', 'TAG_DNC_EMAIL_OPTOUT')
   AND NOT (coalesce(context_conditions, '{}'::jsonb) ? 'has_tag');

-- verify (expect each rule to carry has_tag = its own tag)
SELECT rule_key, enabled, context_conditions
  FROM agent_rules
 WHERE rule_key IN ('TAG_DNC_SMS_OPTOUT', 'TAG_DNC_VOICE_OPTOUT', 'TAG_DNC_EMAIL_OPTOUT')
 ORDER BY rule_key;
