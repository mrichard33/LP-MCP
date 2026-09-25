-- ═══════════════════════════════════════════════════════════════════════════
-- 129 — lp_notes.note_origin = 'lp_revin' for Revin's conversation summaries
-- Date: 2026-09-25
--
-- Data-only (no DDL). note_origin is a free text column (sql/050); this adds a
-- third value next to 'lp' and 'ghl_ai_brief'. Ingest stamps it from now on
-- (src/note-origin.js); this marks the rows already stored.
--
-- WHY: Revin, LP's texting bot, writes a ~160-char summary note per SMS
-- conversation under rep "Agent, Revin" (69,671 rows on 2026-09-25). The label
-- tells Revin's texting apart from a rep's note. It does NOT stop the GHL push:
-- the summaries still go to GHL (user ruling, 2026-09-25). See src/note-origin.js.
--
-- Idempotent. Applied 2026-09-25.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE lp_notes
   SET note_origin = 'lp_revin'
 WHERE note_origin = 'lp'
   AND created_by_rep_name ~* '^\s*agent,\s*revin\M';

-- Verify:
--   SELECT note_origin, count(*) FROM lp_notes
--    WHERE created_by_rep_name ~* 'revin' GROUP BY 1;   -- expect only lp_revin
