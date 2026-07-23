-- 047_lp_sync_failure_notices.sql — 2026-07-22
--
-- Exactly-once guard for the "LP APPT SYNC FAILED" GroupMe card.
--
-- Prior behaviour reused lp_appointment_sync_marks, which (a) expired on
-- LP_APPT_DEDUP_WINDOW_MIN (default 1440 min) so an unresolved failure re-carded
-- every 24h until a human fixed it, (b) was written AFTER the card by a
-- non-blocking upsert that swallowed errors, so any Supabase hiccup lost the guard
-- entirely, and (c) had no atomic claim, so concurrent webhook fires both sent.
--
-- Claim-before-send: the notice row is INSERTed first and the card goes out only
-- if the insert won the primary key. No TTL — the notice persists until the
-- contact's sync succeeds, at which point clearSyncFailedTag() deletes it so a
-- genuinely new failure can notify again.
--
-- Deploy-order safe: claimFailureNotice() detects 42P01 (relation missing) and
-- fails OPEN, so cards keep working (unguarded) until this migration lands.
--
-- NOTE: numbered 047 because 046 is already taken by
-- 046_link_corroboration_identity_sync.sql.

CREATE TABLE IF NOT EXISTS lp_sync_failure_notices (
  notice_key  text        PRIMARY KEY,
  contact_id  text        NOT NULL,
  appt_date   text,
  appt_time   text,
  notified_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lp_sync_failure_notices_contact
  ON lp_sync_failure_notices (contact_id);
