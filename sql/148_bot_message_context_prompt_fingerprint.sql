-- ════════════════════════════════════════════════════════════════════
-- sql/148_bot_message_context_prompt_fingerprint.sql — 2026-10-06
-- (AI OS batch 1, PR 2; CANON.STD.026: every production run records the
-- versions it used, including the resolved model ID)
--
-- WHAT
--   Two nullable columns on bot_message_context:
--     prompt_sha256  — sha256 of the exact system prompt sent for the reply
--     resolved_model — the model named in the API RESPONSE (not the alias
--                      configured in env)
--   Additive. Older rows stay NULL; a rule-written send (no model call)
--   leaves both NULL.
--
-- The code works before this runs: src/bot-feedback/fingerprint.js retries a
-- refused write without the two columns and logs that once per process.
--
-- Mirrored at boot (src/admin/startup-mirrors.js, block 'sql/148').
-- APPLY: Supabase dashboard SQL editor, LP MCP instance. Two executions are
-- fine (each statement is idempotent).
-- ROLLBACK:
--   ALTER TABLE bot_message_context DROP COLUMN IF EXISTS prompt_sha256;
--   ALTER TABLE bot_message_context DROP COLUMN IF EXISTS resolved_model;
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE bot_message_context ADD COLUMN IF NOT EXISTS prompt_sha256 text;
ALTER TABLE bot_message_context ADD COLUMN IF NOT EXISTS resolved_model text;
