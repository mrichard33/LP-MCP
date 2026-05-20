-- ============================================================================
-- Migration: contact_objection_states event-id column type fix
-- Date: 2026-05-20
-- ----------------------------------------------------------------------------
-- ROOT CAUSE
-- The 2026-05-14 substrate migration declared:
--   triggering_event_id  uuid
--   exit_event_id        uuid
--
-- But every event source in the system_events table uses bigint ids (the
-- table's PRIMARY KEY is `id bigint GENERATED AS IDENTITY`). There is no
-- uuid column on system_events at all.
--
-- When the objection-state handler tries to write a system_events.id
-- (e.g. 193754) into one of these uuid columns, Postgres throws:
--   "invalid input syntax for type uuid: 193754"
--
-- The handler then aborts before the state row is written, leaving
-- contact_objection_states empty even when the rule fired correctly and
-- created the agent_action.
--
-- VERIFIED IN PRODUCTION 2026-05-20 22:55
-- agent_action id 63417, rule PRE_DEMO_CONCERN_SPOUSE_TO_STATE on
-- contact 0kk3xz6XatILy8jajymX, event 193754.
-- Executor logged: insert new state: invalid input syntax for type uuid: "193754"
--
-- FIX
-- Change both columns to bigint so they can hold system_events.id values
-- directly. Idempotent: only runs the conversion if the columns are still
-- uuid. Safe because contact_objection_states is currently empty (no rows
-- to migrate). If you run this AFTER state rows have been written you
-- must drop and recreate, OR explicitly cast existing uuid values to
-- bigint (impossible in general — values are random).
-- ============================================================================

BEGIN;

DO $$
BEGIN
  -- Only fire if both columns are still uuid (idempotent on re-run)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contact_objection_states'
      AND column_name = 'triggering_event_id'
      AND data_type = 'uuid'
  ) THEN
    -- Drop existing column (no data to preserve)
    ALTER TABLE contact_objection_states DROP COLUMN triggering_event_id;
    ALTER TABLE contact_objection_states ADD COLUMN triggering_event_id bigint;
    RAISE NOTICE 'Converted triggering_event_id from uuid to bigint';
  ELSE
    RAISE NOTICE 'triggering_event_id is not uuid — skipping';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contact_objection_states'
      AND column_name = 'exit_event_id'
      AND data_type = 'uuid'
  ) THEN
    ALTER TABLE contact_objection_states DROP COLUMN exit_event_id;
    ALTER TABLE contact_objection_states ADD COLUMN exit_event_id bigint;
    RAISE NOTICE 'Converted exit_event_id from uuid to bigint';
  ELSE
    RAISE NOTICE 'exit_event_id is not uuid — skipping';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- Verification
-- ============================================================================
-- Should return both columns as bigint:
--   SELECT column_name, data_type
--   FROM information_schema.columns
--   WHERE table_name = 'contact_objection_states'
--     AND column_name IN ('triggering_event_id', 'exit_event_id');
