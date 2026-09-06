-- ─── 093 — area auto-fill trigger on the claude_* memory tables ─────────────
--
-- Follow-on to sql/092 (priority #6 of the Reece Memory System Optimization
-- plan). Applied to Reece Lead Perfection Sync (rcjcgjlqzepicbwhnnjl) on
-- 2026-09-06 through the LP MCP supabase_run_query tool after Mark's approval;
-- verified with a throwaway claude_pending_items row that classified itself
-- 'nurture-reengagement' from "S4.5 Seinfeld nurture" and was then marked
-- dropped. Every statement is idempotent.
--
-- Problem: sql/092 backfilled area on every existing row but left the column
-- with no default and no trigger, so every new row written by the
-- reece-session-continuity skill, Cowork, Code or n8n arrives with
-- area = NULL and the area filter decays session by session.
--
-- Fix: one BEFORE INSERT trigger function, claude_set_area(), attached to all
-- four memory tables. Mirrors the 092 backfill rules exactly:
--   sessions       → claude_area_for(phase_focus || ' ' || session_title)
--   decisions      → claude_area_for(decision || rationale || workflow_name),
--                    parent = session_id
--   issues         → claude_area_for(description || impact || workflow_name),
--                    parent = reported_session_id
--   pending items  → claude_area_for(description), parent = source_session_id
-- If the row's own text classifies as 'general' and it has a parent session,
-- the parent session's area is used. An explicitly supplied area is never
-- overwritten (the function returns early when NEW.area IS NOT NULL).
--
-- Fields are read through to_jsonb(NEW) so one function serves all four tables
-- without per-table record-field resolution. BEFORE INSERT only — an UPDATE
-- that deliberately sets area to NULL is left alone.
--
-- CREATE OR REPLACE TRIGGER needs PostgreSQL 14+; the LP instance is 15+.

CREATE OR REPLACE FUNCTION claude_set_area()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  j jsonb := to_jsonb(NEW);
  txt text; parent_id int; a text;
BEGIN
  IF NEW.area IS NOT NULL THEN RETURN NEW; END IF;
  CASE TG_TABLE_NAME
    WHEN 'claude_session_logs' THEN
      txt := concat_ws(' ', j->>'phase_focus', j->>'session_title');
    WHEN 'claude_decision_log' THEN
      txt := concat_ws(' ', j->>'decision', j->>'rationale', j->>'workflow_name');
      parent_id := (j->>'session_id')::int;
    WHEN 'claude_known_issues' THEN
      txt := concat_ws(' ', j->>'description', j->>'impact', j->>'workflow_name');
      parent_id := (j->>'reported_session_id')::int;
    WHEN 'claude_pending_items' THEN
      txt := j->>'description';
      parent_id := (j->>'source_session_id')::int;
  END CASE;
  a := claude_area_for(txt);
  IF a = 'general' AND parent_id IS NOT NULL THEN
    SELECT COALESCE(area, 'general') INTO a FROM claude_session_logs WHERE id = parent_id;
  END IF;
  NEW.area := COALESCE(a, 'general');
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER trg_claude_set_area BEFORE INSERT ON claude_session_logs  FOR EACH ROW EXECUTE FUNCTION claude_set_area();
CREATE OR REPLACE TRIGGER trg_claude_set_area BEFORE INSERT ON claude_decision_log  FOR EACH ROW EXECUTE FUNCTION claude_set_area();
CREATE OR REPLACE TRIGGER trg_claude_set_area BEFORE INSERT ON claude_known_issues  FOR EACH ROW EXECUTE FUNCTION claude_set_area();
CREATE OR REPLACE TRIGGER trg_claude_set_area BEFORE INSERT ON claude_pending_items FOR EACH ROW EXECUTE FUNCTION claude_set_area();

-- NOT mirrored in runMigrations() — same reasoning as sql/051, 090, 091, 092:
-- the claude_* tables belong to the skill, not the request path.
--
-- ROLLBACK (no data loss — area values already written stay): for each of the
-- four tables, remove trigger trg_claude_set_area; then remove function
-- claude_set_area(). Rows inserted afterwards revert to area = NULL.
--
-- ─── Verification ───────────────────────────────────────────────────────────
-- SELECT json_agg(row_to_json(v)) FROM (
--   SELECT
--     (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_claude_set_area') AS triggers,   -- 4
--     (SELECT count(*) FROM pg_proc WHERE proname = 'claude_set_area') AS fn                 -- 1
-- ) v;
