-- ═══════════════════════════════════════════════════════════════════════════
-- Calls + texts opt-outs send ONE LP code: C (Do Not Call) — 2026-09-29
--
-- WHY. LP holds a single internal DNC value per prospect (GetLead -> intdnc;
-- LP's API docs: a new value replaces "the existing selection"). Every
-- calls+texts rule sent two update_lp_dnc_status steps, C and T, so whichever
-- ran last won: prospect 461611 read "Do Not Text" after a dnc-sms opt-out,
-- i.e. LP showed calls as allowed. The user ruled: use Do Not Call for calls
-- and texts opt-outs. The T step is dropped; nothing else in these templates
-- changes. (Five9 DNC and GHL DND are unaffected — they block the dialer and
-- texts on their own.)
--
-- Applied live 2026-09-29 ~21:45 UTC, then reload-rules (306 loaded).
-- Re-running is a no-op (the @> guard finds no T step).
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE agent_rules
   SET action_template = (
         SELECT jsonb_agg(e ORDER BY ord)
           FROM jsonb_array_elements(action_template) WITH ORDINALITY o(e, ord)
          WHERE NOT (e->>'action_type' = 'update_lp_dnc_status' AND e->'params'->>'dnc_code' = 'T')),
       updated_at = now()
 WHERE rule_key IN ('BEHAVIORAL_DNC_REPLY', 'RECONCILE_LP_DNC_ON_LINK', 'TAG_DNC_SMS_OPTOUT',
                    'TAG_DNC_VOICE_OPTOUT', 'VOICE_DNC_REQUEST')
   AND action_template @> '[{"action_type":"update_lp_dnc_status","params":{"dnc_code":"T"}}]'::jsonb;

-- verify (expect each rule to list exactly ["C"])
SELECT rule_key,
       (SELECT json_agg(e->'params'->>'dnc_code') FROM jsonb_array_elements(action_template) e
         WHERE e->>'action_type' = 'update_lp_dnc_status') AS lp_codes
  FROM agent_rules
 WHERE rule_key IN ('BEHAVIORAL_DNC_REPLY', 'RECONCILE_LP_DNC_ON_LINK', 'TAG_DNC_SMS_OPTOUT',
                    'TAG_DNC_VOICE_OPTOUT', 'VOICE_DNC_REQUEST')
 ORDER BY rule_key;
