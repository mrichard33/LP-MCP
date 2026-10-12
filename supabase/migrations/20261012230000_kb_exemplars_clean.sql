-- kb_exemplars: clean_version + excluded_reason (2026-10-12)
--
-- WHAT: two columns on the past-win exemplar table (sql/078).
--   clean_version    which version of prepareExemplar (src/knowledge/exemplars-core.js)
--                    last cleaned the row; 0 = stored before cleaning existed.
--   excluded_reason  why a row is inactive: workflow_message, too_short, or
--                    reply_check:<code> (a hard check from src/eval/reply-invariants.js).
--
-- WHY: of the 5,670 examples served in shadow over 14 days, 24% were GHL's raw
-- live-chat HTML, about a quarter named another lead's day and time, 222 promised
-- a call "right now" and 24 were workflow drips. The sweep now cleans each row and
-- re-cleans every row below the current version in place, so it has to know which
-- rows it has done, and a person has to be able to see why a row was dropped.
--
-- Additive. match_kb_exemplars() is unchanged: it already serves active rows only.
-- The code reads a missing column as "not migrated yet" and writes as before.
--
-- ROLLBACK: ALTER TABLE kb_exemplars DROP COLUMN excluded_reason, DROP COLUMN clean_version;
-- (then UPDATE kb_exemplars SET active = true to restore the excluded rows).
-- destructive rollback only; this migration itself drops nothing.

ALTER TABLE public.kb_exemplars
  ADD COLUMN IF NOT EXISTS clean_version smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS excluded_reason text;

COMMENT ON COLUMN public.kb_exemplars.clean_version IS
  'prepareExemplar version that last cleaned this row (exemplars-core.js EXEMPLAR_CLEAN_VERSION); 0 = never cleaned.';
COMMENT ON COLUMN public.kb_exemplars.excluded_reason IS
  'Why the row is inactive: workflow_message | too_short | reply_check:<code>. NULL = usable.';
