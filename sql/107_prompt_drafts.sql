-- Prompt Drafts — edit-before-live staging for agentic_messaging_prompts
--
-- v1.0 — 2026-09-11. BOT REVIEW — PROMPT EDITOR.
--
-- WHY A SEPARATE TABLE.
--   agentic_messaging_prompts is read LIVE on every generation by
--   src/nurture/nurture-prompt-selector.js:
--     .from('agentic_messaging_prompts').select('*').eq('active', true)
--   There is no cache and no restart between an UPDATE and the next customer
--   message. Editing that table directly from a UI would mean every keystroke
--   saved is immediately in front of a customer.
--
--   Staging drafts in their own table means the live table's SHAPE never
--   changes and its CONTENT only ever changes at an explicit Activate. Drafts
--   are invisible to the selector by construction — not by an `active` flag
--   someone could flip by accident, and not by a WHERE clause a future query
--   might forget.
--
-- WHY NO VERSION-HISTORY TABLE.
--   bot_change_log (sql/103) is already append-only, already protected by
--   bot_change_log_immutable(), and already stores `before`/`after` as JSONB
--   with an action vocabulary that names `promoted_live` and `rolled_back`.
--   Rollback re-applies the `before` of a chosen log entry. Adding a second
--   history table would give the same facts two homes and two chances to
--   disagree.
--
-- Applied BY HAND in the Supabase SQL editor, like sql/103–106.

CREATE TABLE IF NOT EXISTS agentic_messaging_prompt_drafts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id   UUID NOT NULL
                REFERENCES agentic_messaging_prompts(id) ON DELETE CASCADE,
  -- Only the columns being changed, as {column: new_value}. A partial patch
  -- rather than a whole row copy: a draft opened today must not silently
  -- revert a field someone else changed on the live row in the meantime.
  fields      JSONB NOT NULL DEFAULT '{}'::jsonb,
  note        TEXT,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One open draft per prompt. Two people editing the same prompt should
  -- collide loudly here rather than race each other to Activate.
  CONSTRAINT agentic_messaging_prompt_drafts_one_per_prompt UNIQUE (prompt_id)
);

CREATE INDEX IF NOT EXISTS idx_prompt_drafts_updated
  ON agentic_messaging_prompt_drafts (updated_at DESC);

COMMENT ON TABLE agentic_messaging_prompt_drafts IS
  'Staged, not-yet-live edits to agentic_messaging_prompts. Invisible to the nurture prompt selector by construction. Promoted onto the live row only by POST /api/bot-feedback/prompts/:id/activate, which bumps version and writes bot_change_log.';

COMMENT ON COLUMN agentic_messaging_prompt_drafts.fields IS
  'Partial patch {column: new_value} — only the columns this draft changes.';

-- ── Keep updated_at honest ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION agentic_messaging_prompt_drafts_touch()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prompt_drafts_touch
  ON agentic_messaging_prompt_drafts;
CREATE TRIGGER trg_prompt_drafts_touch
  BEFORE UPDATE ON agentic_messaging_prompt_drafts
  FOR EACH ROW EXECUTE FUNCTION agentic_messaging_prompt_drafts_touch();

-- ── Verification ────────────────────────────────────────────────────
-- After applying, this must return one row and zero drafts:
--   SELECT count(*) AS prompts FROM agentic_messaging_prompts;
--   SELECT count(*) AS drafts  FROM agentic_messaging_prompt_drafts;
