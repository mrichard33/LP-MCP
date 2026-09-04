-- 2026-09-04_map_event_sources.sql
--
-- WO-7 / PR B.4 — READY TO FILL IN. NOT RUN, NOT APPLIED, NOT SCHEDULED.
--
-- FOR MARK. Every statement below is commented out. Bucket and entry tag are
-- your decision, never the reconciler's and never Claude's — so those two
-- fields are left blank on purpose. Fill them in, uncomment the rows you want,
-- and run it yourself.
--
-- The identifying fields (lp_source_id, lp_source_raw, lp_source_subdetail)
-- are pre-filled from LP's own catalog, read live on 2026-09-04. The volume
-- figures come from v_source_volume_90d on the same date. Both are recorded
-- here so the numbers you are deciding against are visible at the point of
-- decision instead of living in a chat message.
--
-- ─────────────────────────────────────────────────────────────────────────
-- ONE THING TO KNOW BEFORE YOU START
--
-- PR B adds a lower alert floor for event-class sources
-- (SOURCE_GAP_MIN_LEADS_30D_EVENTS, default 5), matched on lp_source_raw
-- against "Events …" or a name containing "Show". That rule reaches THREE of
-- the five sources listed here.
--
-- Angie and Point2Web carry lp_source_raw = 'Internet'. They are not events,
-- so the event floor does not apply to them and they will still not alert at
-- 13 and 0 leads per 30 days against the standard floor of 25. They are in
-- this file because they are genuinely unmapped and worth a decision — not
-- because the new floor will surface them. If you want them to alert, that is
-- a separate call about the standard floor, and it is yours to make.
-- ─────────────────────────────────────────────────────────────────────────
--
-- lp_source_mapping columns, for reference:
--   lp_source_subdetail, lp_source_raw, ghl_intent_bucket, ghl_entry_tag,
--   ghl_bridge_wf_id, notes, confidence, mapping_status
--
-- The table has no lp_source_id column; LP's id is carried in the comment
-- above each row so it can be traced back to the catalog.


-- ── EVENT-CLASS (the new floor of 5 reaches these) ──────────────────────────

-- lp_source_id 871 | 16 leads/30d | 16 leads/90d
-- INSERT INTO lp_source_mapping
--   (lp_source_subdetail, lp_source_raw, ghl_intent_bucket, ghl_entry_tag, confidence, notes)
-- VALUES
--   ('Great American Home Show', 'Events 2026', '-- FILL IN', '-- FILL IN', 'high',
--    'Mapped by hand 2026-09-04 (WO-7). LP source id 871.');

-- lp_source_id 869 | 3 leads/30d | 12 leads/90d
-- INSERT INTO lp_source_mapping
--   (lp_source_subdetail, lp_source_raw, ghl_intent_bucket, ghl_entry_tag, confidence, notes)
-- VALUES
--   ('Fort Myers Arts & Crafts Show', 'Events 2026', '-- FILL IN', '-- FILL IN', 'high',
--    'Mapped by hand 2026-09-04 (WO-7). LP source id 869.');

-- lp_source_id 870 | 3 leads/30d | 7 leads/90d
-- NOTE: LP's full subdetail is 'Fort Myers Beat the Heat Indoor Craft Festival',
-- not the shortened 'Fort Myers Beat the Heat'. The full string is what the
-- catalog publishes and what lead rows carry, so it is what must be matched.
-- INSERT INTO lp_source_mapping
--   (lp_source_subdetail, lp_source_raw, ghl_intent_bucket, ghl_entry_tag, confidence, notes)
-- VALUES
--   ('Fort Myers Beat the Heat Indoor Craft Festival', 'Events 2026', '-- FILL IN', '-- FILL IN', 'high',
--    'Mapped by hand 2026-09-04 (WO-7). LP source id 870.');


-- ── NOT EVENT-CLASS (standard floor of 25 still applies) ────────────────────

-- lp_source_id 848 | 13 leads/30d | 44 leads/90d
-- INSERT INTO lp_source_mapping
--   (lp_source_subdetail, lp_source_raw, ghl_intent_bucket, ghl_entry_tag, confidence, notes)
-- VALUES
--   ('Angie', 'Internet', '-- FILL IN', '-- FILL IN', 'high',
--    'Mapped by hand 2026-09-04 (WO-7). LP source id 848.');

-- lp_source_id 845 | 0 leads/30d | 25 leads/90d
-- INSERT INTO lp_source_mapping
--   (lp_source_subdetail, lp_source_raw, ghl_intent_bucket, ghl_entry_tag, confidence, notes)
-- VALUES
--   ('Point2Web', 'Internet', '-- FILL IN', '-- FILL IN', 'high',
--    'Mapped by hand 2026-09-04 (WO-7). LP source id 845.');


-- ── AFTER YOU RUN IT ────────────────────────────────────────────────────────
--
-- Confirm the rows landed and that the reconciler now sees them as mapped:
--
--   SELECT lp_source_subdetail, lp_source_raw, ghl_intent_bucket, ghl_entry_tag
--     FROM lp_source_mapping
--    WHERE lp_source_subdetail IN (
--      'Great American Home Show',
--      'Fort Myers Arts & Crafts Show',
--      'Fort Myers Beat the Heat Indoor Craft Festival',
--      'Angie',
--      'Point2Web'
--    );
--
-- then run get_source_catalog_health — each mapped source should drop out of
-- `unmapped`. A bucket of 'unmapped' does NOT count as mapped: the reconciler
-- skips those deliberately, because resolveSourceBucket falls through them to
-- entry:other and they would hide the very leads that are misrouted.
