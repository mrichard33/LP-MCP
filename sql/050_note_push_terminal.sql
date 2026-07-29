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
