-- ─── 049 — LP attribution + latching outcome flags ──────────────────────────
--
-- LP supplies setbyname / confirmedbyname / verifiedbyname and the ever* flags
-- on every lead payload; buildLeadRow() had never mapped them. Verified live
-- 2026-07-27 against /api/Customers/GetLead.
--
-- ever_confirmed is the LATCHING counterpart to appointment_confirmed. LP sends
-- confirmed=false when an appointment cancels, which is why 0 of 2,381 CXL rows
-- since January carry appointment_confirmed=true while NoHome (61), Issue (74)
-- and 1Leg (30) do. ever_confirmed survives cancellation, so it — not
-- appointment_confirmed — answers "does confirming reduce cancellation?".
--
-- appointment_confirmed / appointment_verified are UNCHANGED. They are correct
-- for the capacity board (src/jobs/capacity-sweep.js), which asks "is this
-- confirmed right now". The defect was using a current-state field to answer a
-- historical question. Both live side by side: current state vs. history.
--
-- TIMEZONE RULE (binding, inherited from 043): lp_leads.appointment_date is
-- timestamptz. A bare ::date cast rolls evening appointments (≥8pm ET) onto the
-- next UTC day. Every cast and date predicate goes through
-- (col AT TIME ZONE 'America/New_York')::date — no exceptions.
--
-- Idempotent — safe to re-run. The ADD COLUMNs are mirrored in runMigrations()
-- (src/index.js) so a deploy boots with the schema in place before the first
-- lead upsert writes them.

-- ─── Columns ────────────────────────────────────────────────────────────────
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS set_by_name       text;
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS confirmed_by_name text;
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS verified_by_name  text;
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS set_date          timestamptz;
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS confirmed_date    timestamptz;
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_set          boolean;
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_confirmed    boolean;
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_sat          boolean;
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_issued       boolean;
ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS ever_net_issued   boolean;

COMMENT ON COLUMN lp_leads.set_by_name IS
  'LP setbyname — who set the appointment. Format "Last, First", stored verbatim; normalise at read time. "Agent, Revin" is the AI SMS agent, not a person.';
COMMENT ON COLUMN lp_leads.confirmed_by_name IS
  'LP confirmedbyname — who confirmed the appointment. Equal to set_by_name means LP stamped the setter as its own confirmer, not that confirmation work happened.';
COMMENT ON COLUMN lp_leads.verified_by_name IS
  'LP verifiedbyname — who verified the appointment. Frequently empty.';
COMMENT ON COLUMN lp_leads.set_date IS
  'LP setdate — when the appointment was set. LP sends bare UTC; stored via lpDateToEastern().';
COMMENT ON COLUMN lp_leads.confirmed_date IS
  'LP confirmeddate — when the appointment was confirmed. LP sends bare UTC; stored via lpDateToEastern().';
COMMENT ON COLUMN lp_leads.ever_confirmed IS
  'LP everconfirmed — LATCHING. Survives cancellation. Use for historical analysis; appointment_confirmed is current state only and is cleared by LP on cancel.';
COMMENT ON COLUMN lp_leads.ever_set IS
  'LP everset — LATCHING. Survives cancellation.';
COMMENT ON COLUMN lp_leads.ever_sat IS
  'LP eversat — LATCHING. Survives cancellation.';
COMMENT ON COLUMN lp_leads.ever_issued IS
  'LP everissued — LATCHING. Survives cancellation.';
COMMENT ON COLUMN lp_leads.ever_net_issued IS
  'LP evernetissued — LATCHING. Survives cancellation.';

-- ─── Reporting view ─────────────────────────────────────────────────────────
-- NEW name; v_appt_board and all existing views are untouched.
CREATE OR REPLACE VIEW v_appt_attribution AS
SELECT
  l.lp_lead_id,
  (l.appointment_date AT TIME ZONE 'America/New_York')::date AS appt_date,
  l.set_by_name,
  l.confirmed_by_name,
  l.lead_source,
  l.lead_source_detail,
  l.lp_branch_id,
  l.disposition_code,
  l.ever_confirmed,
  l.ever_sat,
  l.ever_net_issued,
  (l.disposition_code = 'CXL')                         AS cancelled,
  (l.disposition_code = 'Sale')                        AS sold,
  (l.disposition_code NOT IN ('Set','Cnf','Verif'))    AS resolved,
  (l.set_by_name IS DISTINCT FROM l.confirmed_by_name) AS separately_confirmed
FROM lp_leads l
WHERE l.appointment_date IS NOT NULL;

COMMENT ON VIEW v_appt_attribution IS
  'Appointments by setter and confirmer with latching LP outcome flags. Filter resolved=true before computing any rate — pending appointments are not failures. separately_confirmed distinguishes real confirmation work from LP stamping the setter as its own confirmer. resolved is NULL where disposition_code is NULL, so those rows drop out of a WHERE resolved filter.';

-- ─── Index — RUN SEPARATELY ─────────────────────────────────────────────────
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so this must
-- NOT be executed as part of the migration above. Apply it on its own via the
-- Supabase MCP execute_sql tool (NOT apply_migration, which wraps in a
-- transaction):
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lp_leads_set_by_name
--     ON lp_leads (set_by_name, appointment_date)
--     WHERE set_by_name IS NOT NULL;
