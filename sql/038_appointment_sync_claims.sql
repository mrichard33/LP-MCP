-- 038_appointment_sync_claims.sql — 2026-07-11
--
-- Cross-worker double-create guard for the LP→GHL appointment reconciler
-- (src/services/appointment-sync-claim.js). Before POSTing a create,
-- reconcileLpAppointmentToGhl claims (contact_id, slot_ms) via a PRIMARY-KEY
-- INSERT; exactly one concurrent worker wins, the loser (unique violation) skips
-- the create. Backs up the decision-engine event dedup against any create that
-- reaches the reconciler twice (manual re-emit, executor retry, two sync rules
-- racing) — the root cause behind duplicate same-slot appointments.
--
-- The claim persists for the service TTL (default 300s) so a near-simultaneous
-- second create is blocked while GHL propagates the first; a stale claim (older
-- than the TTL) is reclaimable so a crashed create never blocks the slot forever.
-- Deploy-order safe: the claim service fails OPEN if this table is missing, so
-- creates keep working (unguarded) until the table exists.

CREATE TABLE IF NOT EXISTS appointment_sync_claims (
  contact_id  text        NOT NULL,
  slot_ms     bigint      NOT NULL,
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, slot_ms)
);

-- Supports the stale-claim reclaim (WHERE claimed_at < …) and any future
-- periodic prune of long-dead claims.
CREATE INDEX IF NOT EXISTS idx_appt_sync_claims_claimed_at
  ON appointment_sync_claims (claimed_at);
