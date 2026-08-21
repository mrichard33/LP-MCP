-- ============================================================================
-- 064 — Call Intelligence: join agents by LOGIN, not by numeric id
--
-- WHY: verified against the live Call Log on 2026-08-21, this domain's saved
-- report has NO agent-id column. Its agent columns are:
--
--     AGENT       the Five9 login          'jmanieri'
--     AGENT NAME  the display name         'John Manieri', 'Shari Walker - LF'
--
-- ci_agent_map was seeded keyed on agent_five9_id (the numeric user id from
-- getUsersGeneralInfo, e.g. '300000001915097'). Nothing in the call log
-- carries that id, so the map as keyed CANNOT be joined to a single call —
-- every call would fall through to team 'unknown' and land in review. The
-- login is the only identifier both sides share.
--
-- WHAT THIS DOES: adds agent_username to both tables and indexes it on the
-- map. agent_five9_id stays the primary key — it is the stable identity, and
-- a login can be renamed — but the username becomes the join column.
--
-- SECOND CORRECTION, recorded here because it reverses a claim in PR #725:
-- that PR concluded the " - LF" / " - NC" / " - FTM" suffixes from handoff
-- decision #5 did not exist on the Five9 side, because zero of 48 users from
-- getUsersGeneralInfo carried one. True of the USER RECORDS, false of the
-- CALL LOG — AGENT NAME returns 'Shari Walker - LF' live. Both signals are
-- real and they agree: the nine agents the email rule classified as lightfire
-- are the same nine the suffix identifies. Discovery now reads the suffix
-- directly (it is what the dialer recorded against the call) and falls back
-- to the map.
--
-- Mirrored in runMigrations() (src/index.js). Additive; no data is rewritten
-- and no existing column changes type or nullability.
--
-- AFTER RUNNING: re-run scripts/seed-ci-maps.js to populate agent_username on
-- the 42 seeded rows. Until then the map still resolves nothing, so team
-- classification leans on the AGENT NAME suffix and the campaign map.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS ci_agent_map_username_idx;
--   ALTER TABLE ci_agent_map DROP COLUMN IF EXISTS agent_username;
--   ALTER TABLE ci_calls     DROP COLUMN IF EXISTS agent_username;
-- ============================================================================

-- The login as it appears in the call log's AGENT column.
ALTER TABLE ci_calls     ADD COLUMN IF NOT EXISTS agent_username text;
ALTER TABLE ci_agent_map ADD COLUMN IF NOT EXISTS agent_username text;

-- The join column, so classification is an index lookup rather than a scan.
-- Not UNIQUE: logins are unique in Five9 today, but a stale row for a renamed
-- login must not break the seed's upsert.
CREATE INDEX IF NOT EXISTS ci_agent_map_username_idx
  ON ci_agent_map (agent_username);

-- ─── Verification ────────────────────────────────────────────────────────────
-- Both columns present:
--   SELECT table_name, column_name FROM information_schema.columns
--   WHERE column_name = 'agent_username' AND table_name IN ('ci_calls','ci_agent_map');
--   -- expect 2 rows
-- Index present:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'ci_agent_map';
--   -- expect ci_agent_map_username_idx
-- After re-seeding, every active agent should carry a login:
--   SELECT count(*) FILTER (WHERE agent_username IS NULL) AS unmapped,
--          count(*) AS total
--   FROM ci_agent_map;
--   -- unmapped should be 0 once the seed has re-run
