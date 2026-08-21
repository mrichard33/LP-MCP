-- ============================================================================
-- 062 — Call Intelligence v2: recording→call join substrate
--       (2026-08-20 handoff revision, follows sql/061)
--
-- WHY: the 2026-08-19 handoff assumed the Five9 Call ID was recoverable from
-- the recording filename. Inspecting ETG's live archive on 2026-08-20 proved
-- that wrong — the real format is
--     {ANI} by {agent_username} @ {H_MM_SS AM/PM}_{ivr_module}.wav
-- and the leading number is the ANI, not a Call ID. There is no clean key, so
-- the join is redesigned to campaign + ANI + timestamp, and a recording now
-- exists in its own right BEFORE it is attached to a call (or is never
-- attached at all, when the match is ambiguous). sql/061 cannot express that:
-- its ci_recordings.call_id is NOT NULL and its uniqueness is keyed on a
-- call_id it may not have.
--
-- WHAT THIS IS: additive ALTERs bringing ci_recordings and ci_campaign_map to
-- the v2 shape. Twelve new columns capture the filename's parsed parts plus
-- the match decision and its evidence; call_id becomes nullable; uniqueness
-- moves to the one thing that is genuinely unique and always present, the
-- full remote path.
--
-- Two of the new columns exist to make the timezone conversion auditable.
-- Filename clocks are in the Recordings export config's FIXED EST (GMT-05:00,
-- no DST) while the Call Log is Pacific and operations display ET — three
-- zones in one join path. filename_clock_text keeps the verbatim string and
-- recorded_at keeps the derived instant, so a bad conversion is visible in
-- the data rather than silently shifting every summer match by an hour.
--
-- WHAT THIS IS NOT: no DROP TABLE. ci_recordings is empty today, so a drop
-- and recreate would be tempting and would produce tidier DDL — but a drop is
-- a destructive operation under sql/README.md regardless of row count, it
-- cannot be mirrored in runMigrations(), and it would make this file unsafe
-- to re-run against any environment that did have rows. Everything below is
-- additive and idempotent instead. No existing table outside the ci_* family
-- is touched, and nothing here writes data.
--
-- Mirrored in runMigrations() (src/index.js) so a fresh deploy self-heals:
-- sql/061 creates the v1 shape and this file alters it forward. This file is
-- the source of truth. Additive DDL, so it may be applied via MCP
-- apply_migration per sql/README.md — there is no CONCURRENTLY index here and
-- therefore no second execution.
--
-- ROLLBACK: the twelve ADD COLUMNs reverse with
--   ALTER TABLE ci_recordings DROP COLUMN IF EXISTS <col>;   (and
--   ci_campaign_map.excluded_ivr_modules likewise)
-- then DROP INDEX IF EXISTS ci_recordings_source_path_uq;
-- then ALTER TABLE ci_recordings ALTER COLUMN call_id SET NOT NULL; (only
-- valid while no NULL call_id rows exist) and re-add the old composite
-- UNIQUE (call_id, source_filename). Rolling back is only sane while the
-- table is empty; once PR 2 is ingesting, roll forward instead.
-- ============================================================================

-- ─── ci_recordings: the recording exists before the call it belongs to ──────

-- A recording is discovered by crawling the archive, not by looking up a
-- call, so it is inserted unlinked and matched afterwards. Ambiguous matches
-- stay unlinked forever rather than being guessed onto the wrong call.
ALTER TABLE ci_recordings ALTER COLUMN call_id DROP NOT NULL;

-- Provenance: exactly where on nas1 the file came from.
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS source_path      text;
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS campaign_dir     text;
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS date_dir         text;

-- Parsed out of the filename. ani is the LEADING number and is NOT a call id.
-- agent_username is an empty string on transfer legs ('by  @', two spaces).
-- ivr_module is present only on transfer legs ('_Transfer to Lightfire') and
-- is the PRIMARY team classifier, matched against ci_transfer_target_map.label.
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS ani              text;
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS agent_username   text;
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS ivr_module       text;

-- The timezone audit pair: verbatim clock text, and the instant derived from
-- it at a FIXED -5 offset (never America/New_York, which would apply DST).
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS filename_clock_text text;
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS recorded_at      timestamptz;

-- How the call_id above was decided, and how confident that decision was.
-- 'campaign_ani_time' | 'manual' | NULL (unmatched).
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS match_method     text;
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS match_confidence numeric;

-- Deliberate non-ingestion, recorded rather than silently skipped:
-- 'test_module' | 'below_min_bytes' | 'owner_dir'.
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS excluded         boolean NOT NULL DEFAULT false;
ALTER TABLE ci_recordings ADD COLUMN IF NOT EXISTS excluded_reason  text;

-- Uniqueness moves to the remote path. The old key could not work: it was
-- (call_id, source_filename), and a recording now legitimately has no
-- call_id. The path is unique by construction on the source filesystem and is
-- what makes re-crawling the archive idempotent.
ALTER TABLE ci_recordings DROP CONSTRAINT IF EXISTS ci_recordings_call_id_source_filename_key;
CREATE UNIQUE INDEX IF NOT EXISTS ci_recordings_source_path_uq
  ON ci_recordings (source_path);

-- ─── ci_campaign_map: exclude the transfer-module test calls ────────────────

-- Modules ThirdPartyTransfer / ThirdPartyTransfer2 / 'Third Party Transfer'
-- appear only on 8/14 and 8/17/2026 at 1.7–4.9 KB (~1 second) — build-time
-- tests of the transfer module, not production traffic. The byte floor
-- (CI_MIN_RECORDING_BYTES) catches them too; this is the by-name belt to that
-- braces, because a longer test recording would slip past a size check.
ALTER TABLE ci_campaign_map ADD COLUMN IF NOT EXISTS excluded_ivr_modules text[] NOT NULL DEFAULT
  '{ThirdPartyTransfer,ThirdPartyTransfer2,"Third Party Transfer"}';

-- ─── Verification ────────────────────────────────────────────────────────────
-- All twelve new ci_recordings columns present:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--   WHERE table_name = 'ci_recordings'
--     AND column_name IN ('source_path','campaign_dir','date_dir','ani',
--                         'agent_username','ivr_module','filename_clock_text',
--                         'recorded_at','match_method','match_confidence',
--                         'excluded','excluded_reason')
--   ORDER BY column_name;                                  -- expect 12 rows
-- call_id is now nullable:
--   SELECT is_nullable FROM information_schema.columns
--   WHERE table_name = 'ci_recordings' AND column_name = 'call_id';  -- 'YES'
-- Uniqueness moved:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'ci_recordings';
--   -- expect ci_recordings_source_path_uq; NOT ci_recordings_call_id_source_filename_key
-- Exclusion default is the three test modules:
--   SELECT column_default FROM information_schema.columns
--   WHERE table_name = 'ci_campaign_map' AND column_name = 'excluded_ivr_modules';
-- Nothing was populated by this migration:
--   SELECT count(*) FROM ci_recordings;                    -- unchanged
