-- ─── 050 — Terminal failure state for LP → GHL note pushes ──────────────────
--
-- Incident 2026-07-28. "[Sync] GHL notes push: 0 pushed, 3 failed" repeated on
-- every 90s cycle. Cause: one orphan GHL contact id (Y21mrJPUGYGKIWFptVpu on LP
-- lead 562172) that exists in no Reece location. GHL answers such an id with
-- HTTP 403 "The token does not have access to this location."; the classifier
-- in src/ghl.js only recognised 400 + "not found", so addGHLNote returned a
-- generic failure, pushNotesToGHL never marked the row, and the same three
-- notes were re-selected forever — a head-of-line block on the whole backlog.
--
-- The classifier fix (src/services/ghl-error-classify.js) stops the retry storm
-- for THIS failure mode. These columns are the general backstop: any note that
-- cannot be delivered eventually stops being selected, whatever the reason.
--
--   ghl_note_push_attempts  incremented on every non-terminal failure
--   ghl_note_push_error     last failure string ('contact_not_found', …)
--   ghl_note_push_terminal  true = never select this row again
--
-- Set immediately on a not-found contact (attempts is irrelevant — the contact
-- is gone), and at attempts >= 5 for anything else. src/ghl-notes-sync.js also
-- NULLs ghl_contact_id when it marks a row terminal for not-found, so the dead
-- id stops propagating. NOTE: lp_call_logs and system_events rows may still
-- carry orphan ids — scripts/audit-orphan-ghl-links.js sweeps the former; the
-- latter are audit records and are deliberately left alone.
--
-- The partial index backs the new pending-note predicate. sql/005's
-- idx_lp_notes_unpushed is left in place: it is keyed on
-- (ghl_contact_id, ghl_note_pushed) and still serves countUnpushedNotes.
--
-- Idempotent — safe to re-run. The ADD COLUMNs are mirrored in runMigrations()
-- (src/index.js), which awaits before initFieldSync() starts the notes cycle,
-- so a deploy cannot reach the new ghl_note_push_terminal filter before the
-- column exists. Apply this file first regardless; the mirror is the safety
-- net, not the plan.

-- ─── Columns ────────────────────────────────────────────────────────────────
ALTER TABLE lp_notes
  ADD COLUMN IF NOT EXISTS ghl_note_push_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ghl_note_push_error    text,
  ADD COLUMN IF NOT EXISTS ghl_note_push_terminal boolean NOT NULL DEFAULT false;

-- ─── Index ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_lp_notes_pending
  ON lp_notes (created_at_lp)
  WHERE ghl_note_pushed = false AND ghl_note_push_terminal = false;

-- ═══════════════════════════════════════════════════════════════════════════
-- AMENDMENT 2026-07-29 — note origin (echo-loop fix)
--
-- This file was already applied when the amendment landed. Every statement is
-- IF NOT EXISTS / idempotent, so RE-RUN 050 in full; it is a no-op for the
-- columns above and adds the ones below.
--
-- The GHL→LP pipeline (src/ghl-note-pipeline/) writes an AI brief onto the LP
-- prospect. LP's note sync then pulls it back into lp_notes, and
-- pushNotesToGHL pushes it straight back to the GHL contact it came from,
-- wrapped in a "📋 LP Note" header. addGHLNote's dedup cannot catch it: the
-- wrapper changes the body, so normalizeNoteBody never matches. Confirmed
-- live 2026-07-29 — all 56 AI BRIEF notes in lp_notes had ghl_note_pushed=true.
--
-- note_origin is the structural marker that breaks the loop. Stamped at ingest
-- (src/sync-children.js syncNotes) rather than matched with a LIKE on every
-- push, so the filter is indexable and the classification happens exactly once.
--
--   'lp'           note originated in Lead Perfection (default — push it)
--   'ghl_ai_brief' note originated in GHL via the note pipeline (never push)
--
-- NOT NULL DEFAULT 'lp' is deliberate: a nullable column would make the push
-- filter need `.or(is.null, neq)` because SQL NULL <> 'x' is NULL, not true.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE lp_notes
  ADD COLUMN IF NOT EXISTS note_origin text NOT NULL DEFAULT 'lp';

-- Backfill: mark the existing echoed population. Matches BOTH the legacy
-- "[AI BRIEF" prefix (the 56 rows already in LP) and the "[GHL · AI BRIEF"
-- prefix written from 2026-07-29 onward. Matching only the new prefix would
-- leave the existing population echoing forever.
UPDATE lp_notes
   SET note_origin = 'ghl_ai_brief'
 WHERE note_origin <> 'ghl_ai_brief'
   AND (note_body LIKE '[AI BRIEF · %'
        OR note_body LIKE '[GHL · AI BRIEF · %'
        -- writeLpNote prefixes landmine notes with "** IMPORTANT **\n"
        OR note_body LIKE '** IMPORTANT **' || chr(10) || '[AI BRIEF · %'
        OR note_body LIKE '** IMPORTANT **' || chr(10) || '[GHL · AI BRIEF · %');

CREATE INDEX IF NOT EXISTS idx_lp_notes_origin
  ON lp_notes (note_origin)
  WHERE note_origin <> 'lp';

-- ─── Delivery receipt for GHL→LP note writes ────────────────────────────────
--
-- ghl_note_log.lp_note_id was NULL on all 131 rows written since the pipeline
-- went live 2026-06-24 — LP's AddNotes API does not return an id, so there was
-- no receipt at all and a run that silently stopped writing would have looked
-- identical to a healthy one. lp_write_confirmed records that LP ACCEPTED the
-- write (addNote throws on non-2xx), which is a real receipt even without an id.
-- Nullable: NULL means "written before this column existed", which is
-- information, and is why it is not defaulted to false.
ALTER TABLE ghl_note_log
  ADD COLUMN IF NOT EXISTS lp_write_confirmed boolean;

-- NOTE: the note_origin backfill UPDATE above is data-op-sized and is NOT
-- mirrored in runMigrations() — same rule sql/046 applied to its
-- legacy_unverified backfill. The ADD COLUMNs and indexes ARE mirrored.
