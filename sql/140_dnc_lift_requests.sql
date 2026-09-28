-- ════════════════════════════════════════════════════════════════════
-- sql/140 — dnc_lift_requests: one row per Slack DNC-lift review (2026-09-28)
--
-- Part 1, execution 5 of 5. Additive. Mirrored in
-- src/admin/startup-mirrors.js.
--
-- WHY THIS TABLE EXISTS (it was not in the handoff's DDL list)
--   POST /slack/dnc-lift/decision must be idempotent on request_id: n8n
--   retries a timed-out HTTP call, and a double-click on the Slack card is a
--   second POST. Without an atomic claim, two posts would both queue a Five9
--   DNC removal. The PRIMARY KEY is that claim — the first decision to move
--   a row out of 'awaiting_decision' wins, every later post gets the stored
--   result back and queues nothing.
--
--   It also closes a hole: the route only accepts a request_id THIS service
--   issued (written when the review card was requested) for the SAME contact,
--   so a leaked secret alone cannot lift an arbitrary contact.
--
--   And it is the "already reviewed in the last 24h" record
--   DNC_LIFT_REVIEW_REQUEST checks before asking again.
--
-- Until it exists the decision route refuses (503) rather than risk a
-- duplicate lift, and no review card is requested.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS dnc_lift_requests (
  request_id       text PRIMARY KEY,
  ghl_contact_id   text NOT NULL,
  status           text NOT NULL DEFAULT 'awaiting_decision'
                     CHECK (status IN ('awaiting_decision','processing','approved','kept_blocked','failed')),
  review_payload   jsonb,
  decision         text CHECK (decision IN ('approve','keep_blocked')),
  slack_user_id    text,
  slack_user_name  text,
  slack_ts         text,
  batch_result     jsonb,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  completed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_dnc_lift_requests_contact ON dnc_lift_requests (ghl_contact_id, requested_at DESC);

ALTER TABLE dnc_lift_requests ENABLE ROW LEVEL SECURITY;
