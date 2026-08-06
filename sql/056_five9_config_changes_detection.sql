-- 056_five9_config_changes_detection.sql — tag change rows with how they were
-- detected, so the same-day branch can persist instead of discarding (2026-08-06)
--
-- WHAT THIS IS: one additive column on five9_config_changes recording whether a
-- delta was found against an EARLIER day's snapshot (`cross_day`, the ordinary
-- case) or against another snapshot taken the SAME day (`same_day`).
--
-- WHY IT EXISTS: the snapshot job used to detect a same-day delta, count it as
-- an "unstable hash", and then discard the diff without writing a change row.
-- That was built to suppress serialization noise — an array coming back in a
-- different order would otherwise fire the change log daily on that entity.
--
-- It suppressed real edits too. On 2026-08-06 action 283639 set
-- previewDialImmediately false -> true on DIAL ASAP at 19:44:50Z. The preceding
-- snapshot ran 19:42:40Z and stored `false`. The next run detected the delta,
-- counted it as unstable, and dropped it: `SELECT count(*) FROM
-- five9_config_changes` returned 0 for a change we can name to the second.
--
-- Detecting a change and declining to record it is the one behavior a change
-- log cannot have. The job now writes the rows and tags them; separating noise
-- from real edits is a QUERY, not a decision made before persistence.
--
-- Reading the tag: serialization noise lands on bracket-indexed sibling paths
-- (`role_permissions.admin[0].type`); a real edit lands on a named scalar
-- (`raw.previewDialImmediately`). field_path already carries that, so:
--
--   -- same-day deltas that look like real edits, not reordering
--   SELECT * FROM five9_config_changes
--    WHERE detection = 'same_day' AND field_path NOT LIKE '%[%]%'
--    ORDER BY detected_at DESC;
--
-- NOTE ON previous_snapshot_id: it is deliberately NULL on `same_day` rows.
-- five9_config_snapshots is UNIQUE (snapshot_date, entity_type, entity_name)
-- and same-day runs upsert, so by the time a same-day change row is written the
-- snapshot it would point at has already been overwritten with the NEW config.
-- A foreign key that resolves to the wrong value is worse than no foreign key;
-- previous_value on the change row carries the truth. This is also why the
-- change log has to be the system of record for intra-day history — the
-- snapshot table structurally cannot hold two rows for one entity in one day.
--
-- Additive only. Mirrored in runMigrations() (src/index.js) via runSQL, so a
-- fresh deploy self-heals. Per sql/README.md, ADD COLUMN goes through MCP
-- apply_migration.
--
-- ROLLBACK:
--   ALTER TABLE five9_config_changes DROP COLUMN IF EXISTS detection;

ALTER TABLE five9_config_changes
  ADD COLUMN IF NOT EXISTS detection text NOT NULL DEFAULT 'cross_day';

-- Existing rows predate the same-day branch ever writing, so the default is
-- correct for every one of them: they were all found across days.

CREATE INDEX IF NOT EXISTS idx_f9_changes_detection
  ON five9_config_changes (detection, detected_at DESC);

-- Verification
--   Column present with the intended default:
SELECT column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
 WHERE table_name = 'five9_config_changes' AND column_name = 'detection';

--   Distribution once the job has run again (expect cross_day rows, and
--   same_day rows only when something changed between two runs on one day):
SELECT detection, count(*) AS rows, min(detected_at) AS first_seen, max(detected_at) AS last_seen
  FROM five9_config_changes
 GROUP BY detection
 ORDER BY detection;
