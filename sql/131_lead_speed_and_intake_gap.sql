-- 131_lead_speed_and_intake_gap.sql
-- Time to first call + leads that never reached LP, for the Lead Leak Monitor
-- (src/jobs/lead-leak-monitor.js) and the dashboard's Lead Leaks page
-- (2026-09-26).
--
-- WHY. The monitor answered "which LP leads did Five9 never dial". Two
-- questions it could not answer: how long do leads wait for their FIRST call
-- (and is that getting worse), and which GHL leads never became LP leads at
-- all — so could never be dialled. Five9 is the only clock for calls; LP's
-- firstcalldate / call_count are not used (src/lead-speed.js has why).
--
-- lead_call_speed_daily — one row per ET creation day, rewritten every run.
--   minutes are WORKING minutes: the clock starts when the lead arrives, or at
--   the next call-center opening if it arrived after hours.
--   expected      leads owed a call (called, or uncalled for a leak reason)
--   never_called  owed leads with no Five9 call yet
--   median_min / p90_min over called leads only
--
-- lead_intake_gap_daily — one row per GHL contact per run: a contact at least
--   24h old, with a phone and no LP id stamped, classed by phone as
--   not_in_lp | not_in_lp_but_called | in_lp_unlinked. Copied from the HL
--   mirror by the job; nothing joins across the two Supabase instances.
--
-- APPLY FROM THE DASHBOARD, LP instance — the two statements as separate
-- executions. Mirrored in src/admin/startup-mirrors.js (block 'sql/131').
-- Additive only: no existing table or view is altered.

-- 1 ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_call_speed_daily (
  created_day date PRIMARY KEY,
  leads integer NOT NULL,
  expected integer NOT NULL,
  called integer NOT NULL,
  never_called integer NOT NULL,
  called_1h integer NOT NULL,
  called_24h integer NOT NULL,
  median_min numeric,
  p90_min numeric,
  updated_at timestamptz DEFAULT now()
);

-- 2 ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lead_intake_gap_daily (
  id bigserial PRIMARY KEY,
  run_date date NOT NULL,
  ghl_contact_id text NOT NULL,
  first_name text,
  last_name text,
  phone10 text,
  source text,
  date_added timestamptz,
  class text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (run_date, ghl_contact_id)
);
