-- 055_five9_config_snapshots.sql — daily Five9 config history + change log (2026-08-06)
--
-- WHAT THIS IS: a daily point-in-time record of every Five9 configuration
-- object (campaigns, profiles, lists, skills, users, dispositions) plus a
-- field-level log of what changed between snapshots.
--
-- WHAT THIS IS NOT: an audit of who made a change. five9.admin_write events
-- already cover writes made THROUGH LP MCP and carry the actor. This table
-- covers everything else — principally changes made by a human in the Five9
-- admin UI, which leave no trace anywhere else. It answers "what changed and
-- when", never "who". Those are different questions and this is the cheaper one.
--
-- WHY IT EXISTS: the `Data Leads` profile sat at numberOfAttempts=100 for an
-- unknown length of time and nobody could say when it got that way. Five9
-- exposes only current state; there is no history API.
--
-- Full daily rows are kept even when nothing changed — the ask was a daily
-- history of every setting, not only of changes. Volume is ~150 rows/day.
-- Revisit rollup only if that becomes a problem.
--
-- Idempotent — tables and the plain indexes are mirrored in runMigrations()
-- (src/index.js) via runSQL, so a fresh deploy self-heals.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS five9_config_changes;
--   DROP TABLE IF EXISTS five9_config_snapshots;
--   (changes references snapshots, so drop changes first.)
--
-- AFTER RUNNING: the job still ships dark. Set FIVE9_CONFIG_SNAPSHOT_ENABLED=true
-- on Railway to arm the daily scheduler, or POST /admin/five9/config-snapshot to
-- capture once by hand.

CREATE TABLE IF NOT EXISTS five9_config_snapshots (
  id             bigserial PRIMARY KEY,
  snapshot_date  date        NOT NULL DEFAULT (now() AT TIME ZONE 'America/New_York')::date,
  captured_at    timestamptz NOT NULL DEFAULT now(),
  entity_type    text        NOT NULL,
  entity_name    text        NOT NULL,
  config         jsonb       NOT NULL,
  config_hash    text        NOT NULL,
  CONSTRAINT five9_config_snapshots_uniq UNIQUE (snapshot_date, entity_type, entity_name)
);

CREATE TABLE IF NOT EXISTS five9_config_changes (
  id                   bigserial PRIMARY KEY,
  detected_at          timestamptz NOT NULL DEFAULT now(),
  entity_type          text        NOT NULL,
  entity_name          text        NOT NULL,
  field_path           text        NOT NULL,
  previous_value       jsonb,
  new_value            jsonb,
  previous_snapshot_id bigint REFERENCES five9_config_snapshots(id) ON DELETE SET NULL,
  new_snapshot_id      bigint REFERENCES five9_config_snapshots(id) ON DELETE SET NULL
);

-- ─── Indexes — RUN SEPARATELY ───────────────────────────────────────────────
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so these
-- must NOT be executed as part of the migration above. Apply each on its own
-- via the Supabase MCP execute_sql tool (NOT apply_migration, which wraps in a
-- transaction), or in the dashboard SQL editor:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_f9_snap_entity_date
--     ON five9_config_snapshots (entity_type, entity_name, snapshot_date DESC);
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_f9_changes_detected
--     ON five9_config_changes (detected_at DESC);
--
-- runMigrations() mirrors these WITHOUT the CONCURRENTLY keyword. On a fresh
-- deploy the tables are empty, so a blocking build is instantaneous and the
-- distinction does not matter there.

-- ─── Verification ───────────────────────────────────────────────────────────
-- SELECT entity_type, count(*) AS entities, max(snapshot_date) AS latest
--   FROM five9_config_snapshots GROUP BY entity_type ORDER BY entity_type;
--
-- SELECT detected_at, entity_type, entity_name, field_path, previous_value, new_value
--   FROM five9_config_changes ORDER BY detected_at DESC LIMIT 50;
