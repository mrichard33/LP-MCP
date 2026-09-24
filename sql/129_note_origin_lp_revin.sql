-- ═══════════════════════════════════════════════════════════════════════════
-- 129 — lp_notes.note_origin = 'lp_revin' for Revin's conversation summaries
-- Date: 2026-09-25
--
-- Data-only (no DDL). note_origin is a free text column (sql/050); this adds a
-- third value next to 'lp' and 'ghl_ai_brief'. Ingest stamps it from now on
-- (src/note-origin.js); this marks the rows already stored.
--
-- WHY: Revin, LP's texting bot, writes a ~160-char summary note per SMS
-- conversation under rep "Agent, Revin" (69,671 rows on 2026-09-25, 32,814 of
-- them not yet pushed). pushNotesToGHL copied each onto the GHL contact as
-- "📋 LP Note". Mark (2026-09-24): show them as messages on the dashboard, stop
-- copying them into GHL, leave LP untouched. Rows are kept; only the push
-- skips them (NEVER_PUSH_ORIGINS in src/note-origin.js).
--
-- Safe before the code deploys: the old push filter was neq 'ghl_ai_brief',
-- so it keeps pushing these until the new filter ships. Idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE lp_notes
   SET note_origin = 'lp_revin'
 WHERE note_origin = 'lp'
   AND created_by_rep_name ~* '^\s*agent,\s*revin\M';

-- Verify:
--   SELECT note_origin, count(*) FROM lp_notes
--    WHERE created_by_rep_name ~* 'revin' GROUP BY 1;   -- expect only lp_revin
