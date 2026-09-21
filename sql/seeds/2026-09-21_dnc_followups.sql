-- ════════════════════════════════════════════════════════════════════
-- DNC follow-ups — 2026-09-21 (all APPLIED LIVE; this file documents them)
-- Companion to sql/seeds/2026-09-21_dnc_lift_on_reentry.sql (PR #1000).
-- Reload after last change: rules_loaded 290 (289 + DNC_LIFT_ON_REENTRY_E0).
--
-- 1. BEHAVIORAL_DNC_REPLY (id 57) v7 → v8
--    Regex rewritten with explicit [Xx] character classes (case-insensitive by
--    construction). NOT the root cause of the Sep 5+ silence — "Stop" and
--    "Cancel" matched lowercase patterns before, so the engine already matches
--    case-insensitively. Kept because it is harmless and removes one variable.
--    Root cause is engine-side and open: the rule has not fired organically
--    since 2026-09-05 09:10 ET; live test event 3836790 (Mayra, "STOP WITH THE
--    SOLICITATION", subtype dnc) → no_matching_rules. See the Claude Code
--    handoff "BEHAVIORAL_DNC_REPLY silent since Sep 5".
--
-- 2. DNC_LIFT_ON_REENTRY_E0 (NEW, enabled, dormant)
--    ghl.entry_detected / reentry, gated on consent:new-submission + DNC
--    family. Dormant until /webhook/ghl/entry accepts source=reentry and E.0
--    gets the re-entry branch.
--
-- 3. Backlog DNC lift — batch BACKLOG_DNC_LIFT_20260921 (agent_actions, not a rule)
--    13 contacts whose approval-gated lift expired unapproved Jul–Sep and who
--    showed NO opt-out signal afterwards (33 others excluded). Lift-only: DNC
--    tags + p3:dnc removed, DND inactive, objection state recovered,
--    recovery:dnc-lifted added. No set_stage / move_opportunity (stale appts).
--    Result: 12 contacts completed; qPcO25PbcYHJ5gsSvy9U failed (deleted in GHL).
--    Stale pending_approval DNC_LIFT_ON_REENGAGEMENT_* actions were rejected as
--    superseded.
--
-- 4. Mayra (qM5QYwn5ISZ8DQOgFJpX / LP prospect 155710) — manual hardening
--    action 482927 set_dnd active SMS/RCS/Call (Call had been open) — completed.
--    action 482928 update_lp_dnc_status C — "already set" (LP was DNC).
--    Five9: 8134166946 confirmed on domain DNC (agent dispositions 9/21).
-- ════════════════════════════════════════════════════════════════════
BEGIN;

-- 1. BEHAVIORAL_DNC_REPLY regex (idempotent)
UPDATE agent_rules
   SET context_conditions = jsonb_set(context_conditions, '{payload_message_matches}', to_jsonb($re$\b([Ss][Tt][Oo][Pp]|[Ss][Tt][Oo][Pp][Aa][Ll][Ll]|[Uu][Nn][Ss][Uu][Bb][Ss][Cc][Rr][Ii][Bb][Ee]|[Rr][Ee][Mm][Oo][Vv][Ee]\s+[Mm][Ee]|[Tt][Aa][Kk][Ee]\s+[Mm][Ee]\s+[Oo][Ff][Ff]|[Dd][Oo]\s+[Nn][Oo][Tt]\s+([Cc][Oo][Nn][Tt][Aa][Cc][Tt]|[Tt][Ee][Xx][Tt]|[Cc][Aa][Ll][Ll]|[Ee][Mm][Aa][Ii][Ll])|[Dd][Oo][Nn]'?[Tt]\s+([Cc][Oo][Nn][Tt][Aa][Cc][Tt]|[Tt][Ee][Xx][Tt]|[Cc][Aa][Ll][Ll]|[Ee][Mm][Aa][Ii][Ll])\s+[Mm][Ee]|[Qq][Uu][Ii][Tt]\s+([Tt][Ee][Xx][Tt][Ii][Nn][Gg]|[Cc][Aa][Ll][Ll][Ii][Nn][Gg]|[Ee][Mm][Aa][Ii][Ll][Ii][Nn][Gg]|[Mm][Ee][Ss][Ss][Aa][Gg][Ii][Nn][Gg])|[Oo][Pp][Tt][\s\-]*[Oo][Uu][Tt]|[Nn][Oo]\s+([Mm][Oo][Rr][Ee]|[Ff][Uu][Rr][Tt][Hh][Ee][Rr])\s+([Cc][Oo][Nn][Tt][Aa][Cc][Tt]|[Tt][Ee][Xx][Tt][Ss]?|[Cc][Aa][Ll][Ll][Ss]?|[Mm][Ee][Ss][Ss][Aa][Gg][Ee][Ss]?|[Ee][Mm][Aa][Ii][Ll][Ss]?)|[Pp][Ll][Ee][Aa][Ss][Ee]\s+[Ss][Tt][Oo][Pp])\b$re$::text)),
       updated_at = NOW()
 WHERE rule_key = 'BEHAVIORAL_DNC_REPLY';

-- 2. DNC_LIFT_ON_REENTRY_E0 — full row lives in agent_rules; key shape:
--    event_pattern      {"event_type":"ghl.entry_detected","event_subtype":"reentry"}
--    context_conditions has_tag consent:new-submission
--                       has_any_tag [dnc, dnc-sms, stage:dnc, p3:dnc, lp-dnc, loss-reason:dnc, do-not-contact, stop-bot]
--                       not_has_any_tag [suppress:dnc-reply, suppress:dnc-voice]
--    actions            remove_tag ×10 (bypass_suppression), set_dnd inactive (all channels),
--                       resolve_objection_state recovered, add_tag recovery:dnc-lifted,
--                       [priority 200] remove_tag consent:new-submission,
--                       [priority 200] add_to_workflow E.0 (hook 0ac2b756-81ef-42ae-aeed-e9ab4bfaf374),
--                       send_notification (intelligence, 24h cooldown)
--    requires_approval FALSE, priority 15.

COMMIT;

-- 3 + 4 are one-time agent_actions, recorded above; not re-runnable by design.

-- Rollback:
--   UPDATE agent_rules SET enabled=FALSE, updated_at=NOW() WHERE rule_key='DNC_LIFT_ON_REENTRY_E0';
--   (BEHAVIORAL_DNC_REPLY v7 regex is in its notes history; restoring it changes nothing functionally.)
--   then POST /n8n/decision-engine/reload-rules.

-- ════════════════════════════════════════════════════════════════════
-- ANSWER to item 1's open question — 2026-09-21 (Claude Code)
--
-- "Root cause is engine-side and open" is now closed. It was
-- passesStageGate() in src/decision-engine.js.
--
-- Every rule key starting with BEHAVIORAL_ / OBJECTION_ / INTENT_ is held to
-- a SALES-QUALIFICATION test: the contact must carry one of 14
-- QUALIFYING_TAGS (appointment or late buyer-journey) or sit at
-- buyer_stage >= 3. A COMPLIANCE rule inherited a SALES gate purely from how
-- it was named, and a person texting STOP is almost never a qualified lead —
-- so the gate blocked the rule exactly when it mattered.
--
-- This also explains the two things that made the Sep-5 story not quite fit:
--   * Identical text matched on one event and not another ("Stop" fired at
--     17:10 on 8/28 but not at 10:21). The gate reads the CONTACT, not the
--     message.
--   * Booked contacts were blocked too — dDEvTYYv56kW031zv0ml and
--     qM5QYwn5ISZ8DQOgFJpX both had appointments, but carry
--     window-estimate-booked while QUALIFYING_TAGS lists appt:window-estimate.
--
-- And it is NOT a Sep-5 regression. Opt-out replies where the rule did not
-- fire, by month: May 23/27 · Jun 32/43 · Jul 20/31 · Aug 40/50 · Sep 84/86 —
-- ~199 missed since 2026-05-15, when the condition gate was added. The last
-- organic fire was 2026-09-05 because QzEyHIThzCQDUNETOBto happened to carry
-- bj:stage-3-comparing, not because anything changed that day.
--
-- Fixed in code via STAGE_GATE_EXEMPT_RULE_KEYS (five named suppression
-- rules skip the gate; sales rules still get it). INTENT_DNC_HARD_REQUEST and
-- INTENT_SPIKE_GUARD_DNC were silently gated the same way and are exempt too.
-- The v8 regex above stays as it is — harmless, and re-litigating it is how
-- the next session loses another day.
--
-- See sql/seeds/2026-09-21_behavioral_dnc_reply_five9.sql for the companion
-- rule change that finally pushes a STOP to Five9.
-- ════════════════════════════════════════════════════════════════════
