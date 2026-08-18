-- ============================================================================
-- 060 — LP addlead address hold (Section D, 2026-08-18 handoff)
--
-- WHY: the LP push IS the dial trigger (LP is the only writer into Five9's
-- LP_ASAP list), so an addlead that goes out with an incomplete address is a
-- prospect record LP will keep incomplete forever — LeadAdd dedupes onto the
-- existing prospect and never updates prospect-level address (proven live on
-- prospect 452653: the 08-16 push carried zip only, the 08-17 estimator push
-- carried the full street address, and the prospect kept a blank address).
--
-- HOLD-AND-ENRICH, NEVER DROP: a lead parked here is retried with GHL
-- enrichment until complete or until retries exhaust, and then it is
-- FORWARDED ANYWAY with notes stamped "INCOMPLETE ADDRESS ON FILE". Every
-- lead still reaches LP; the hold only trades minutes of speed-to-lead for
-- a complete prospect record.
--
-- Mirrored in runMigrations() (src/index.js) so a fresh deploy self-heals.
-- This file is the source of truth. DDL executes in the Supabase dashboard.
-- ============================================================================

CREATE TABLE IF NOT EXISTS lp_addlead_address_hold (
  id              bigserial PRIMARY KEY,
  ghl_contact_id  text NOT NULL,          -- body.lognumber (= GHL contact id on GHL paths)
  payload         jsonb NOT NULL,         -- the full addlead body as received
  missing_fields  text[] NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  released_at     timestamptz,
  release_reason  text,                   -- 'enriched' | 'exhausted'
  lp_in1_id       text,                   -- LP inbound id once the release forward succeeds
  created_at      timestamptz DEFAULT now()
);

-- One live hold per contact: a second incomplete addlead for the same
-- contact updates the parked payload instead of stacking a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lp_addlead_address_hold_active
  ON lp_addlead_address_hold (ghl_contact_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_lp_addlead_address_hold_due
  ON lp_addlead_address_hold (next_attempt_at)
  WHERE released_at IS NULL;
