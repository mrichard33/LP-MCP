-- ─── 049 — Appointment confirmation history (latching) ──────────────────────
--
-- Additive. One NEW column, one NEW trigger, one CREATE OR REPLACE VIEW on a
-- NEW name. lp_leads.appointment_confirmed keeps its exact current semantics,
-- v_appt_board (sql/043) and v_appt_board_bands (sql/048) are untouched, and
-- src/jobs/capacity-sweep.js is not changed — the board must keep reading
-- CURRENT confirmed state.
--
-- WHY: lp_leads.appointment_confirmed mirrors LP's CURRENT appointment state.
-- LP sends confirmed=false when an appointment cancels and buildLeadRow()
-- (src/sync-leads.js:389) faithfully stamps it, so the column can never answer
-- "was this confirmed BEFORE it cancelled?". Verified 2026-07-27: across all
-- 2,381 CXL rows since January, appointment_confirmed is false on every single
-- one, while Sale (421), OPPFDN (249), Issue (73), NoHome (60) and 1Leg (30)
-- all retain it. Every report asking whether confirmation reduces cancellation
-- returned a circular 0%.
--
-- The history DOES exist in system_events (lp.disposition_changed, first event
-- 2026-04-05). Reconstructed from there for resolved appointments
-- 2026-05-01..2026-07-26: confirmed appointments cancel at 7.4% (153/2,074),
-- unconfirmed at 49.1% (692/1,408). Largest single lever in the cancellation
-- picture, and invisible to every report until now.
--
-- appointment_confirmed_at LATCHES: set on first confirmation, never cleared.
--
-- ─── CONFIRMED CODE SET (binding) ───────────────────────────────────────────
-- [Cnf, Issue] — the same set as CAPACITY_CONFIRMED_CODES in
-- src/jobs/capacity-sweep.js:79, so "confirmed" means one thing across the
-- capacity board and this report. Per the live-verified bucket mapping at
-- capacity-sweep.js:62-80: 'Issue' is issued-to-rep, the strongest will-run
-- state (LP's nightly run-sheet mass-flips Cnf → Issue; repro lead 556824),
-- and 'Verif' is AT-RISK — "a step BEFORE confirmation, not equivalent to it"
-- — so Verif and the appointment_verified boolean are deliberately NOT latch
-- signals.
--
-- The codes are hardcoded here rather than read from env or a config table.
-- CAPACITY_CONFIRMED_CODES is env-tunable and could drift from this list, but
-- this column is a HISTORICAL RECORD: silently re-defining what past rows mean
-- via an env flip would be worse than requiring a deliberate migration if the
-- mapping ever changes.
--
-- ─── TIMEZONE RULE (binding, inherited from 043) ────────────────────────────
-- lp_leads.appointment_date is timestamptz. A bare ::date cast rolls evening
-- appointments (≥8pm ET) onto the next UTC day. Every cast and date predicate
-- goes through (col AT TIME ZONE 'America/New_York')::date — no exceptions,
-- including the history_available boundary in the view below.
--
-- Idempotent — safe to re-run. The ADD COLUMN is mirrored in runMigrations()
-- (src/index.js) so a fresh deploy self-heals the schema; the trigger, backfill
-- and view are applied from this file only.

ALTER TABLE lp_leads ADD COLUMN IF NOT EXISTS appointment_confirmed_at timestamptz;

COMMENT ON COLUMN lp_leads.appointment_confirmed_at IS
  'First time this appointment was confirmed (disposition Cnf or Issue, matching CAPACITY_CONFIRMED_CODES). Latching: never cleared, even on CXL. Use this for historical analysis; appointment_confirmed is current state only.';

-- ─── Latch trigger ──────────────────────────────────────────────────────────
-- Fires on any writer — upsertLeadOnly (src/sync-leads.js:509), processProspect
-- (:706), upsertLeadFromFlat (:971), lp-cohort-reconcile.js:212,
-- lp-mirror-backfill.js:169, the ~18 partial .update() callers, and any manual
-- patch — so there is no write-path to keep in sync and no future writer can
-- bypass it. It also keeps sync-leads.js (49.7KB) out of the diff entirely.
--
-- Precedence, first-match-wins:
--   1. An established latch is ALWAYS preserved, whatever the new row says.
--   2. Otherwise latch when EITHER the explicit boolean is true OR the
--      disposition says confirmed.
--
-- Note the OR in (2), where capacity-sweep.js:174 uses
-- COALESCE(appointment_confirmed, disposition_code = ANY(CONFIRMED_CODES)) —
-- i.e. the boolean PREFERRED. That preference is right for the board (an
-- explicit false means "not confirmed right now") and wrong here: LP can flip
-- confirmed true → false between sync passes without us ever observing the true
-- state, so an explicit false must not veto a Cnf/Issue disposition when what
-- we are recording is that a confirmation happened at all.
CREATE OR REPLACE FUNCTION lp_latch_appt_confirmed_at()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.appointment_confirmed_at IS NOT NULL THEN
    NEW.appointment_confirmed_at := OLD.appointment_confirmed_at;
    RETURN NEW;
  END IF;

  IF NEW.appointment_confirmed_at IS NULL
     AND (NEW.appointment_confirmed IS TRUE
          OR NEW.disposition_code IN ('Cnf', 'Issue')) THEN
    NEW.appointment_confirmed_at := now();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lp_latch_appt_confirmed_at ON lp_leads;
CREATE TRIGGER trg_lp_latch_appt_confirmed_at
  BEFORE INSERT OR UPDATE ON lp_leads
  FOR EACH ROW EXECUTE FUNCTION lp_latch_appt_confirmed_at();

-- ─── Backfill from the event bus (exact, one-shot) ──────────────────────────
-- Run AFTER the trigger exists: reversing the order would still work, but
-- leaves a window where a concurrent sync writes a row with no latch.
--
-- system_events.lp_lead_id and lp_leads.lp_lead_id are both text — direct join,
-- no cast; idx_se_lp_lead covers it. system_events begins 2026-04-03 and the
-- first Cnf event is 2026-04-05, so rows with appointments older than that stay
-- NULL BY DESIGN — anything earlier would be inferred, not observed.
-- v_appt_confirmation_outcome.history_available marks the boundary.
--
-- The trigger leaves this UPDATE's value alone: OLD.appointment_confirmed_at is
-- NULL (the WHERE requires it) so branch 1 is skipped, and NEW is already
-- non-NULL so branch 2 is skipped.
--
-- Expect ~3,821 rows as of 2026-07-27. A materially different count means the
-- event query changed — stop and report rather than proceeding. Do NOT add this
-- to runMigrations(): it is a no-op on re-run, but there is no reason to pay
-- for it on every boot.
-- Written as a subquery rather than a CTE: some SQL runners (including the LP
-- MCP supabase_run_query tool) reject a leading WITH on an UPDATE. Equivalent.
UPDATE lp_leads l
SET appointment_confirmed_at = f.cnf_at
FROM (SELECT lp_lead_id, MIN(created_at) AS cnf_at
      FROM system_events
      WHERE event_type = 'lp.disposition_changed'
        AND event_subtype IN ('Cnf', 'Issue')
        AND lp_lead_id IS NOT NULL
      GROUP BY lp_lead_id) f
WHERE f.lp_lead_id = l.lp_lead_id
  AND l.appointment_confirmed_at IS NULL;

-- ─── Reporting view ─────────────────────────────────────────────────────────
-- NEW name; v_appt_board and every existing view are untouched.
--
-- resolved: 'Issue' sits with Set/Cnf/Verif as NOT resolved — issued-to-rep
-- means the appointment has not happened yet, so counting it as an outcome
-- would understate cancellation. The explicit IS NOT NULL guard matters: a bare
-- NOT IN returns NULL on a NULL disposition_code, which would silently drop
-- those rows from every filtered aggregate rather than excluding them visibly.
--
-- history_available gates the honest window: only appointments on/after
-- 2026-04-05 have event-bus coverage. Filter on it before quoting a rate.
CREATE OR REPLACE VIEW v_appt_confirmation_outcome AS
SELECT
  l.lp_lead_id,
  (l.appointment_date AT TIME ZONE 'America/New_York')::date      AS appt_date,
  l.lead_source,
  l.lead_source_detail,
  l.lp_branch_id,
  l.disposition_code,
  l.appointment_confirmed_at,
  (l.appointment_confirmed_at IS NOT NULL)                        AS was_confirmed,
  (l.disposition_code = 'CXL')                                    AS cancelled,
  l.demo_completed,
  (l.disposition_code IS NOT NULL
     AND l.disposition_code NOT IN ('Set', 'Cnf', 'Verif', 'Issue')) AS resolved,
  ((l.appointment_date AT TIME ZONE 'America/New_York')::date
     >= '2026-04-05'::date)                                       AS history_available
FROM lp_leads l
WHERE l.appointment_date IS NOT NULL;

COMMENT ON VIEW v_appt_confirmation_outcome IS
  'Appointment outcomes with latched confirmation history. Always filter history_available=true AND resolved=true before computing a cancellation rate.';

-- ─── Index (SEPARATE EXECUTION — cannot run inside a transaction block) ─────
-- STILL OUTSTANDING as of 2026-07-27: everything above was applied live, but
-- this was not. CREATE INDEX CONCURRENTLY cannot run through a client that
-- wraps statements in a transaction (the LP MCP supabase_run_query tool does).
-- Run it from the Supabase dashboard SQL editor as its OWN execution.
--
-- Do NOT drop CONCURRENTLY to work around a runner: lp_leads is 223,904 rows /
-- 141 MB, and a plain CREATE INDEX takes an ACCESS EXCLUSIVE lock that blocks
-- every sync write for the duration of the build.
--
-- Performance only — nothing depends on it for correctness.
--
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lp_leads_appt_confirmed_at
--   ON lp_leads (appointment_confirmed_at)
--   WHERE appointment_confirmed_at IS NOT NULL;
