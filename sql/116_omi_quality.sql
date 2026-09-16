-- ─── 116 — Omi ingestion quality: the 'too_short' ledger disposition ────────
--
-- WHY. Mark's ruling, 2026-09-16. Two things were wrong with what the Omi pull
-- filed. 277 of the 399 open Omi items were "memories" — Omi's durable personal
-- facts, not conversations — reading like "The user is using Claude as an AI
-- assistant" and "The user interacts with a person named Reece" (wrong; Reece is
-- the company), 30 of them generated from screenshots rather than speech, and
-- 232 of them embedded and degrading memory_search. And 8 of 105 sessions came
-- from a brief clip that produced no action item at all.
--
-- The memories half is pure code (OMI_PULL_MEMORIES, default false) and needs
-- nothing here. The short-conversation half writes a ledger row so the skip is
-- recorded once and never re-evaluated, and that row needs a disposition this
-- table does not yet accept. That is all this file does.
--
-- WHY A MIGRATION AT ALL, given sql/051 declares the column as bare TEXT NOT
-- NULL. The CHECK constraint below exists in the LIVE database only — it was
-- added through the dashboard and never written back to sql/. Reading the repo
-- alone says no migration is needed; reading the database says the ingest throws
-- on the first short conversation without one. Verified against the LP instance
-- on 2026-09-16:
--
--   CHECK ((disposition = ANY (ARRAY['linked'::text, 'retro_written'::text,
--                                    'no_content'::text, 'deferred'::text])))
--
-- This file is therefore also the moment the constraint stops being invisible to
-- anyone reading the repo.
--
-- Constraint-only. No data is touched, no row is rewritten, no column is added
-- or dropped. Every existing row already satisfies the wider list (counted
-- 2026-09-16: 452 retro_written, 333 linked, 125 no_content, 2 deferred).
--
-- HOW TO APPLY. Supabase dashboard → SQL editor on the LP instance
-- (rcjcgjlqzepicbwhnnjl), as ONE execution. Verification query at the bottom.
--
-- APPLY THIS BEFORE THE CODE DEPLOYS. It is safe on its own — the wider list
-- permits a value nothing writes yet — whereas deploying first leaves the pull
-- throwing on the first short clip it meets, which runOmiPull records as a
-- failure and alarms on after three ticks.
--
-- ROLLBACK (only if the short gate is abandoned; harmless to leave in place):
--   -- First make sure nothing depends on the value:
--   --   SELECT count(*) FROM claude_transcript_ledger WHERE disposition = 'too_short';
--   -- and re-point those rows at 'no_content' before narrowing, or the ALTER
--   -- below fails on its own data.
--   ALTER TABLE claude_transcript_ledger DROP CONSTRAINT IF EXISTS claude_transcript_ledger_disposition_check;
--   ALTER TABLE claude_transcript_ledger ADD CONSTRAINT claude_transcript_ledger_disposition_check
--     CHECK (disposition = ANY (ARRAY['linked','retro_written','no_content','deferred']));

-- ═══ A. Widen the disposition CHECK to admit 'too_short' ════════════════════
-- 'too_short' rather than another 'no_content' reason string on purpose: "how
-- many clips is the gate dropping, and was that right?" is a question the ledger
-- has to answer on its own, by disposition, without parsing the notes column.
-- Follows the sql/101 drop-and-re-add-wider pattern.

ALTER TABLE claude_transcript_ledger DROP CONSTRAINT IF EXISTS claude_transcript_ledger_disposition_check;
ALTER TABLE claude_transcript_ledger ADD CONSTRAINT claude_transcript_ledger_disposition_check
  CHECK (disposition = ANY (ARRAY['linked','retro_written','no_content','deferred','too_short']));

COMMENT ON COLUMN claude_transcript_ledger.disposition IS
  'linked | retro_written | no_content | deferred | too_short. '
  'no_content = reviewed, nothing worth remembering. '
  'too_short = an Omi clip under OMI_MIN_CONVERSATION_SEC with no action item '
  'and a short overview (sql/116, ruling 2026-09-16). Both are terminal: '
  'findDuplicate() in src/memory/omi-ingest.js treats either as already handled '
  'and never re-ingests.';

-- ═══ Verification ══════════════════════════════════════════════════════════
-- Run after applying. Expect check_ok true, and every count unchanged from
-- before (this file moves no rows).
--
-- SELECT json_build_object(
--   'check_ok',      (SELECT pg_get_constraintdef(oid) LIKE '%too_short%'
--                       FROM pg_constraint
--                      WHERE conname = 'claude_transcript_ledger_disposition_check'),
--   'by_disposition',(SELECT json_object_agg(disposition, n)
--                       FROM (SELECT disposition, count(*) AS n
--                               FROM claude_transcript_ledger
--                              GROUP BY disposition) d),
--   'total',         (SELECT count(*) FROM claude_transcript_ledger));
