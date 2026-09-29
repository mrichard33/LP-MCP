-- ═══════════════════════════════════════════════════════════════════════════
-- TAG_DNC_MANUAL_OPTOUT — DISABLED (2026-09-29)
--
-- Inserted live 2026-09-29 ~20:20 UTC (rule id 389): a plain `dnc` tag became
-- a FULL opt-out (every DND channel, Five9, LP C+T, stop-bot, consent
-- all/dnc_full_on). The user ruled the same afternoon that a contact is opted
-- out only on the channel they asked to stop, so it was disabled at ~20:35 UTC
-- before it had fired once (0 agent_actions rows). The row is kept for the
-- record; it is not re-created anywhere.
--
-- What replaced it: sql/seeds/2026-09-29_channel_dnc_tags.sql — dnc-sms and
-- dnc-voice block calls + texts, dnc-email blocks email. Plain `dnc` is back to
-- rule 241 TAG_DNC_TO_HARDLOSS only (objection state; blocks nothing).
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE agent_rules
   SET enabled = false,
       notes = notes || ' — DISABLED 2026-09-29: user ruled per-channel only; see TAG_DNC_SMS_OPTOUT / TAG_DNC_VOICE_OPTOUT / TAG_DNC_EMAIL_OPTOUT.',
       updated_at = now()
 WHERE rule_key = 'TAG_DNC_MANUAL_OPTOUT'
   AND enabled = true;
