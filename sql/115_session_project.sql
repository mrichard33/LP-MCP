-- ─── 115 — session.project: the field that would have made C2 trivial ────────
--
-- Every chat session was written without recording which project its chat lives
-- in, and `conversation_search` is project-scoped. So linking the backlog means
-- opening a sweep chat per project and discovering the partition by probing —
-- roughly 12 chats of searches to recover one fact that was free at write time.
-- 189 rows currently need that treatment.
--
-- Free text, deliberately. Project names are Mark's and they change; a CHECK
-- constraint here would repeat the claude_session_logs.link_confidence problem
-- (a fourth legitimate value needed a migration and rippled into every query
-- and doc that read the column).
--
-- NOT backfilled. An absent project is the truth for every existing row, and
-- guessing one from area or title would be the positional-zip mistake again —
-- a plausible value written over a blank is worse than the blank, because the
-- blank is honest about not knowing.

ALTER TABLE claude_session_logs ADD COLUMN IF NOT EXISTS project text;

-- Partial: the column is NULL for the whole backlog and only new writes set it,
-- so indexing the nulls would be dead weight.
CREATE INDEX IF NOT EXISTS idx_claude_session_logs_project
  ON claude_session_logs (project) WHERE project IS NOT NULL;

COMMENT ON COLUMN claude_session_logs.project IS
  'The Claude project the source chat lives in, recorded at checkpoint time. NULL for every row written before sql/115 — conversation_search is project-scoped, so this is what lets a link sweep target the right project instead of probing for it. Free text: project names change, and an enum here would need a migration each time.';
