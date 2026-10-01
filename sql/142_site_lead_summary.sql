-- ════════════════════════════════════════════════════════════════════
-- sql/142 — site_lead_summary: ONE row per GHL contact (2026-10-01)
--
-- Additive. Mirrored in src/admin/startup-mirrors.js.
--
-- WHY THIS TABLE EXISTS
--   site_events is the raw log — one row per page view or form submit
--   (~1,500 a day). visitor_identity_map is one row per BROWSER linked to a
--   contact. Nothing held one row per lead, so "what has this lead done on
--   the site?" meant re-aggregating the log every time, and the only copy of
--   the answer lived in four GHL custom fields.
--
--   I.STITCH (src/site-stitch.js) upserts this row every time it stitches a
--   form submit AND on its returning-visit refresh (a known lead browsing
--   again without submitting), from the same aggregate it writes to GHL —
--   so the row and the GHL fields always agree.
--
--   site_events stays the source of truth: it is what lets page views made
--   BEFORE someone fills in a form be credited to them afterwards. This row
--   is the summary, rebuilt from it, never the other way round.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS site_lead_summary (
  contact_id          text PRIMARY KEY,
  visitor_ids         text[] NOT NULL DEFAULT '{}',
  pages_viewed        integer NOT NULL DEFAULT 0,
  sessions            integer NOT NULL DEFAULT 0,
  first_visit         timestamptz,
  last_visit          timestamptz,
  first_touch_source  text,
  intent_score        integer NOT NULL DEFAULT 0,
  top_pages           text[] NOT NULL DEFAULT '{}',
  page_counts         jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE site_lead_summary ENABLE ROW LEVEL SECURITY;
