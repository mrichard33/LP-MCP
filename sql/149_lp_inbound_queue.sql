-- ─── sql/149 — mirror of LP's inbound queue + booked-lead routing audit ──────
--
-- 2026-10-06 (issues #153 / #490, pending #363 / #4130; session #1743).
--
-- Every lead we send to Lead Perfection lands in LP's INBOUND QUEUE as an
-- inquiry (in1_id). It becomes a lead (lds_id) only when somebody checks it
-- out. LP auto-checks-out about half within seconds ("Rubertone, Bob"); the
-- rest wait for a person — median 11 min in the day, 4–15 HOURS overnight
-- (1,030 rows 10/03–10/06, 506 checked out by hand). Nothing of ours could see
-- that queue: the inbound read was live-only, so "how long did it wait?" had
-- no answer and an inquiry with an appointment could sit unseen.
--
--   lp_inbound_queue          one row per inquiry, upserted every 5 minutes by
--                             src/jobs/inbound-checkout-watch.js.
--   booked_dial_routing_log   every decision src/jobs/booked-dial-routing.js
--                             makes (what, why, which approval) — the audit
--                             trail for moving booked leads off DIAL ASAP.
--   v_lp_inbound_checkout_daily  the per-day trend we show LP.
--
-- ADDITIVE ONLY. Apply from the Supabase dashboard (LP instance). The code
-- fails soft until this exists: the watch still alerts, it just keeps no
-- mirror, and the routing job logs to job_runs only.
--
-- TIMES: received_at_lp / checkout_at_lp are TRUE UTC, converted from LP's
-- Eastern wall clock with src/lp-dates.js lpStoredToUtcMs (DST-correct) before
-- the write. They are NOT the "+00:00-tagged Eastern" convention lp_leads uses.

CREATE TABLE IF NOT EXISTS lp_inbound_queue (
  in1_id            text PRIMARY KEY,
  received_at_lp    timestamptz,
  checkout_at_lp    timestamptz,
  checkout_user     text,          -- LP checkoutusername, e.g. 'Rubertone, Bob' (LP's auto-import)
  checkout_user_id  text,          -- LP checkoutuser (employee id)
  method            text,          -- LP method; 'X' = killed
  lds_id            text,
  cst_id            text,
  dsp_id            text,
  kill_reason       text,
  sender            text,          -- 'GHL-Chatbot', 'GHL-Canvass', 'Simpletext', ...
  srs_id            text,
  source            text,
  source_sub        text,          -- sourcesubdescr
  brn_id            text,
  first_name        text,
  last_name         text,
  phone10           text,
  lognumber         text,          -- GHL contact id when we sent it
  appt_date         date,
  appt_time         text,          -- LP's own text, e.g. '6:00 PM'
  raw               jsonb,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lp_inbound_queue_phone10   ON lp_inbound_queue (phone10);
CREATE INDEX IF NOT EXISTS idx_lp_inbound_queue_lognumber ON lp_inbound_queue (lognumber);
CREATE INDEX IF NOT EXISTS idx_lp_inbound_queue_received  ON lp_inbound_queue (received_at_lp);
CREATE INDEX IF NOT EXISTS idx_lp_inbound_queue_waiting   ON lp_inbound_queue (received_at_lp) WHERE lds_id IS NULL;

ALTER TABLE lp_inbound_queue ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS booked_dial_routing_log (
  id               bigserial PRIMARY KEY,
  phone10          text,
  in1_id           text,
  lds_id           text,
  ghl_contact_id   text,
  appt_date        date,
  appt_time        text,
  action           text,          -- would_add | added | would_remove | remove_queued | held | skipped | expired
  list_name        text,
  agent_action_id  bigint,
  mode             text,          -- shadow | live
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booked_dial_routing_log_phone   ON booked_dial_routing_log (phone10, created_at);
CREATE INDEX IF NOT EXISTS idx_booked_dial_routing_log_created ON booked_dial_routing_log (created_at);

ALTER TABLE booked_dial_routing_log ENABLE ROW LEVEL SECURITY;

-- Per Eastern day: how many inquiries LP auto-checked-out, how many waited for a
-- person and for how long, and the same split for GHL senders and for rows that
-- already carried an appointment. Wait = checkout - received, in minutes.
CREATE OR REPLACE VIEW v_lp_inbound_checkout_daily AS
WITH q AS (
  SELECT
    (received_at_lp AT TIME ZONE 'America/New_York')::date AS et_day,
    checkout_user,
    lds_id,
    checkout_at_lp,
    sender,
    appt_date,
    (checkout_user = 'Rubertone, Bob') AS is_auto,
    (checkout_at_lp IS NOT NULL AND coalesce(checkout_user, '') <> 'Rubertone, Bob') AS is_manual,
    (checkout_at_lp IS NULL AND lds_id IS NULL AND coalesce(kill_reason, '') = '' AND coalesce(method, '') <> 'X') AS is_waiting,
    EXTRACT(EPOCH FROM (checkout_at_lp - received_at_lp)) / 60.0 AS wait_min
  FROM lp_inbound_queue
  WHERE received_at_lp IS NOT NULL
)
SELECT
  et_day,
  count(*)                                                      AS rows,
  count(*) FILTER (WHERE is_auto)                               AS auto,
  count(*) FILTER (WHERE is_manual)                             AS manual,
  count(*) FILTER (WHERE is_waiting)                            AS waiting,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_min) FILTER (WHERE is_manual) AS manual_wait_median_min,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_min) FILTER (WHERE is_manual) AS manual_wait_p90_min,
  count(*) FILTER (WHERE sender LIKE 'GHL-%')                   AS ghl_rows,
  count(*) FILTER (WHERE sender LIKE 'GHL-%' AND is_auto)       AS ghl_auto,
  count(*) FILTER (WHERE sender LIKE 'GHL-%' AND is_manual)     AS ghl_manual,
  count(*) FILTER (WHERE sender LIKE 'GHL-%' AND is_waiting)    AS ghl_waiting,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_min) FILTER (WHERE sender LIKE 'GHL-%' AND is_manual) AS ghl_manual_wait_median_min,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_min) FILTER (WHERE sender LIKE 'GHL-%' AND is_manual) AS ghl_manual_wait_p90_min,
  count(*) FILTER (WHERE appt_date IS NOT NULL)                 AS appt_rows,
  count(*) FILTER (WHERE appt_date IS NOT NULL AND is_auto)     AS appt_auto,
  count(*) FILTER (WHERE appt_date IS NOT NULL AND is_manual)   AS appt_manual,
  count(*) FILTER (WHERE appt_date IS NOT NULL AND is_waiting)  AS appt_waiting,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_min) FILTER (WHERE appt_date IS NOT NULL AND is_manual) AS appt_manual_wait_median_min,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY wait_min) FILTER (WHERE appt_date IS NOT NULL AND is_manual) AS appt_manual_wait_p90_min
FROM q
GROUP BY et_day;

REVOKE ALL ON v_lp_inbound_checkout_daily FROM PUBLIC, anon, authenticated;
