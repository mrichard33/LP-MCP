-- ═══════════════════════════════════════════════════════════════════════════
-- BEHAVIORAL_DNC_REPLY + LP_DISP_DNC — push the opt-out to Five9
-- 2026-09-21
--
-- WHAT
--   Appends one action to both DNC rules:
--     five9_add_numbers_to_dnc { numbers_from_contact: true }
--   and corrects rule 57's notes, which recorded the wrong root cause.
--
-- WHY
--   A STOP reached GHL tags and LP, and stopped there. Five9 DNC was never
--   written, so the dialer kept calling people who had opted out
--   (qM5QYwn5ISZ8DQOgFJpX, ~7 calls after "STOP WITH THE SOLICITATION").
--
--   The note added to rule 57 on 2026-09-21 blamed case-sensitive regex
--   matching and rewrote the pattern into [Ss][Tt][Oo][Pp] character classes.
--   That diagnosis was wrong and the rewrite was a no-op: the engine compiles
--   payload_message_matches with the 'i' flag (src/decision-engine.js), so
--   case was never load-bearing. The real cause was passesStageGate() holding
--   a COMPLIANCE rule to a SALES-QUALIFICATION test purely because its key
--   starts with BEHAVIORAL_. Fixed in code, not here. The character-class
--   pattern is left exactly as it is — it is correct, just unnecessary — so
--   that this seed changes behaviour in one place only.
--
-- ORDER OF OPERATIONS
--   1. Merge the code PR and let Railway deploy.  ← numbers_from_contact and
--      the approval carve-out must exist BEFORE a rule can queue this action,
--      or every queued row fails with "Unknown action type" / stays unarmed.
--   2. Confirm FIVE9_WRITES_ENABLED=true on Railway. With it unset the write
--      path is dry-run AND the action stays approval-gated, by design.
--   3. Apply this seed.
--   4. POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules
--      and assert rules_loaded is UNCHANGED (this seed adds no rules).
--
-- IMPACT
--   Every contact-initiated STOP from here on lands on the Five9 DNC list
--   within one executor sweep. Five9 DNC is ADD-ONLY — there is no removal op
--   by ruling (2026-08-21) — so this is irreversible per number. That is why
--   the action resolves numbers from the contact at execution time and throws
--   rather than guessing (src/actions/resolvers.js resolveContactDncNumbers).
--   Backfill of the ~199 historical misses is a SEPARATE, reviewed step.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. BEHAVIORAL_DNC_REPLY (rule 57) ────────────────────────────────────
-- priority 20 puts the Five9 push in the same lane as the existing set_dnd,
-- after the tag/LP writes. The @> guard makes re-running this seed a no-op.

UPDATE agent_rules
SET action_template = action_template || '[{
      "action_type": "five9_add_numbers_to_dnc",
      "target_system": "lp",
      "target_entity": "contact",
      "priority": 20,
      "params": {
        "numbers_from_contact": true,
        "reason": "Contact-initiated revocation (STOP) — FCC 24-24"
      }
    }]'::jsonb,
    updated_at = now()
WHERE rule_key = 'BEHAVIORAL_DNC_REPLY'
  AND NOT (action_template @> '[{"action_type":"five9_add_numbers_to_dnc"}]'::jsonb);

-- ── 2. LP_DISP_DNC ───────────────────────────────────────────────────────
-- A rep keying a DNC disposition in LP is the same revocation arriving by a
-- different door; the dialer has to hear about it either way.

UPDATE agent_rules
SET action_template = action_template || '[{
      "action_type": "five9_add_numbers_to_dnc",
      "target_system": "lp",
      "target_entity": "contact",
      "priority": 20,
      "params": {
        "numbers_from_contact": true,
        "reason": "LP DNC disposition — suppress dialing"
      }
    }]'::jsonb,
    updated_at = now()
WHERE rule_key = 'LP_DISP_DNC'
  AND NOT (action_template @> '[{"action_type":"five9_add_numbers_to_dnc"}]'::jsonb);

-- ── 3. Correct the root cause on the record ──────────────────────────────
-- The next session reads these notes before it reads the code. Leaving the
-- case-sensitivity claim there means the next person re-fixes the regex and
-- the rule stays silent.

UPDATE agent_rules
SET notes = notes || E'\n2026-09-21 (Claude, correction): the note above is WRONG about the cause. '
                  || E'payload_message_matches compiles with the ''i'' flag, so matching was ALWAYS '
                  || E'case-insensitive and the character-class rewrite changed nothing. The rule was '
                  || E'blocked by passesStageGate(): every rule key starting with BEHAVIORAL_ / '
                  || E'OBJECTION_ / INTENT_ is held to a SALES-QUALIFICATION test (a QUALIFYING_TAG or '
                  || E'buyer_stage >= 3), and a person texting STOP is almost never qualified. '
                  || E'~199 opt-outs were swallowed between 2026-05-15 and 2026-09-21 (84%% of them); '
                  || E'the rare fires were late-stage contacts (QzEyHIThzCQDUNETOBto carried '
                  || E'bj:stage-3-comparing). Two BOOKED contacts were blocked anyway because they '
                  || E'carry window-estimate-booked while QUALIFYING_TAGS lists appt:window-estimate. '
                  || E'Fixed in code via STAGE_GATE_EXEMPT_RULE_KEYS, not by editing this row. '
                  || E'Also appended five9_add_numbers_to_dnc so a STOP reaches the dialer.',
    updated_at = now()
WHERE rule_key = 'BEHAVIORAL_DNC_REPLY';

COMMIT;

-- ── Verification ─────────────────────────────────────────────────────────
-- SELECT rule_key, jsonb_array_length(action_template) AS n_actions,
--        action_template @> '[{"action_type":"five9_add_numbers_to_dnc"}]'::jsonb AS has_five9
--   FROM agent_rules WHERE rule_key IN ('BEHAVIORAL_DNC_REPLY','LP_DISP_DNC');
--   -- expect BEHAVIORAL_DNC_REPLY 6 / true, LP_DISP_DNC 9 / true
--
-- Then reload and confirm the rule count did not move:
--   POST https://lp-mcp-production.up.railway.app/n8n/decision-engine/reload-rules
--
-- Live proof (the only proof that counts — the Slack mirror is fail-silent,
-- so silence is not evidence): after the next organic dnc reply, check
--   SELECT id, action_type, status, error_message FROM agent_actions
--    WHERE rule_applied = 'BEHAVIORAL_DNC_REPLY' ORDER BY id DESC LIMIT 6;
-- and confirm the number with five9_check_dnc within 5 minutes.

-- ── Rollback ─────────────────────────────────────────────────────────────
--   UPDATE agent_rules
--      SET action_template = (
--            SELECT jsonb_agg(a) FROM jsonb_array_elements(action_template) a
--             WHERE a->>'action_type' <> 'five9_add_numbers_to_dnc'),
--          updated_at = now()
--    WHERE rule_key IN ('BEHAVIORAL_DNC_REPLY','LP_DISP_DNC');
--   then POST /n8n/decision-engine/reload-rules.
--
--   Rolling this back does NOT un-DNC anyone. Five9 DNC is add-only by
--   ruling; numbers already pushed stay pushed. It only stops further pushes.
