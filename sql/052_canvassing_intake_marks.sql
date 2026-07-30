-- ─── 052 — Idempotency marks for the canvassing/event lead intake ──────────
--
-- src/canvassing-lead-handler.js has referenced canvassing_intake_marks since
-- the endpoint shipped, but the table was never created. Verified 2026-07-30:
-- `relation "canvassing_intake_marks" does not exist`.
--
-- Every read and write against it is wrapped fail-open — findRecentCanvassMark
-- returns null and writeCanvassMark logs "(fail-open)" — so its absence has
-- never thrown and never surfaced an error. What it did instead was silently
-- disable the 24h idempotency gate entirely: the duplicate pre-check in
-- registerCanvassingLeadRoutes can never find a prior mark, so a webhook retry
-- (GHL retries on timeout) posts the same lead to LP a second time. The gate
-- has been decorative for its whole life.
--
-- Additive and idempotent. Creating the table simply lets the existing
-- fail-open code paths start succeeding; no handler change accompanies it.
--
--   dedup_key              ghl_contact_id — the upsert conflict target
--   ghl_contact_id         denormalised copy, kept for direct lookups
--   phone                  as submitted, for operator triage off a card
--   in1_id                 LP inbound-QUEUE id once addLead returns it
--   appt_date/appt_time    the CONVERTED slot actually sent to LP, not raw
--   flagged_beyond_window  true when the lead posted as Set but outside the
--                          booking horizon and carded the canvass channel
--   status                 processing → lp_posted | lp_failed
--   created_at             drives the DEDUP_WINDOW_MIN (default 1440) lookback

CREATE TABLE IF NOT EXISTS canvassing_intake_marks (
  dedup_key              text PRIMARY KEY,
  ghl_contact_id         text,
  phone                  text,
  in1_id                 text,
  appt_date              text,
  appt_time              text,
  flagged_beyond_window  boolean NOT NULL DEFAULT false,
  status                 text NOT NULL DEFAULT 'processing',
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvassing_intake_marks_created
  ON canvassing_intake_marks (created_at DESC);
