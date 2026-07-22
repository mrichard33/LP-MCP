-- ─── 043 — Appointment Capacity Board (LP → Supabase → TV) ───────────────────
--
-- Substrate for the 15-min capacity sweep (src/jobs/capacity-sweep.js) and the
-- unauthenticated GET /board/capacity aggregate the dashboard TV board polls.
--
-- Denominator (Requested) = slots LP publishes per rep per day via
-- /api/SalesApi/GetSalesSchedule (ONE BrnID:"All" call per sweep, grouped
-- client-side by RepHomeMarket → lp_branch_market_map). Slots carry NO
-- appointment id / lead id / status — HasApptScheduled:boolean is all there is.
--
-- Numerator (Confirmed / Set) lives in lp_leads, market via
-- lp_lead_market_assignments. Every market-grouped query in this build is
-- LEFT JOIN + COALESCE('UNRESOLVED') — a silent inner-join drop is forbidden.
--
-- TIMEZONE RULE (binding): lp_leads.appointment_date is timestamptz. A bare
-- ::date cast rolls evening appointments (≥8pm ET) onto the next UTC day.
-- Every cast and date predicate goes through
-- (col AT TIME ZONE 'America/New_York')::date — no exceptions.
--
-- Idempotent — safe to re-run. Mirrored in runMigrations() (src/index.js) so a
-- deploy boots with the schema in place before the first sweep/lead upsert.

-- ─── Denominator: per-rep-per-day slots from GetSalesSchedule ────────────────
CREATE TABLE IF NOT EXISTS lp_capacity_slots (
  slot_date        date NOT NULL,
  slr_id           text NOT NULL,
  rep_home_market  text NOT NULL,   -- raw branch code, TRIMmed (LP pads with spaces)
  slot_id          int  NOT NULL,   -- 1|2|3 (M/A/E)
  has_appt         boolean NOT NULL,
  swept_at         timestamptz NOT NULL,
  PRIMARY KEY (slot_date, slr_id, slot_id)
);
CREATE INDEX IF NOT EXISTS idx_lp_capacity_slots_date ON lp_capacity_slots(slot_date);

-- ─── GetLead explicit appointment booleans on the lead cache ─────────────────
-- The change-window sweep (GetLead options=261120) returns explicit
-- apptset/verified/confirmed booleans per lead. confirmed=true is preferred
-- over disposition-code interpretation for the Confirmed count; rows synced
-- before these columns existed stay NULL and fall back to disposition codes.
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS appointment_confirmed boolean;
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS appointment_verified  boolean;

-- ─── Denominator aggregate ───────────────────────────────────────────────────
-- slot_date is already a plain date written from the ET sweep — no cast needed
-- here; the TIMEZONE RULE applies wherever timestamptz is touched.
CREATE OR REPLACE VIEW v_appt_board AS
SELECT slot_date,
       COALESCE(bm.market_code, 'UNRESOLVED') AS market,
       count(*) AS requested,
       count(*) FILTER (WHERE cs.has_appt) AS booked
FROM lp_capacity_slots cs
LEFT JOIN lp_branch_market_map bm
  ON UPPER(TRIM(bm.brn_id)) = UPPER(TRIM(cs.rep_home_market))
GROUP BY 1, 2;

-- ─── Daily fill snapshot — the days-out fill curve LP cannot produce ─────────
-- LP only ever renders "now". The 23:50 ET job inserts one row per
-- (slot_date, market) for the forward window; days_out calibrates the
-- day-relative board thresholds once ~2 weeks of history exist. Insert-only:
-- nothing reads it yet — no trend view until it has history to say something.
CREATE TABLE IF NOT EXISTS lp_appt_fill_snapshot (
  snapshot_date date NOT NULL,
  slot_date     date NOT NULL,
  market        text NOT NULL,        -- includes 'UNRESOLVED'
  requested     int  NOT NULL DEFAULT 0,
  confirmed     int  NOT NULL DEFAULT 0,
  set_pending   int  NOT NULL DEFAULT 0,
  days_out      int  GENERATED ALWAYS AS (slot_date - snapshot_date) STORED,
  PRIMARY KEY (snapshot_date, slot_date, market)
);
