-- 2026-10-07 — Remove two junk lp_leads rows that cost LP ~95s of "Execution Timeout Expired"
-- twice every 30 minutes, around the clock.
-- APPLIED LIVE 2026-10-07 (2 rows; re-count: 0 junk left, 0 rows with NULL created_at_lp).
--
--   lp_lead_id 'null'        synced_at 2026-03-25, every field empty (a String(null) write)
--   lp_lead_id 'test-smoke'  synced_at 2026-09-02, a test fixture (lp_payload_hash 'abc123')
--
-- Neither had a GHL contact, and no lp_jobs / lp_job_milestones / lp_call_logs / lp_notes /
-- lp_activities row referenced either (checked before the delete). With no created_at_lp they
-- sorted FIRST under the data-freshness drift probe's `created_at_lp DESC`, so every run asked LP
-- for lead "null" and lead "test-smoke"; LP times out on an id it cannot find. The probe now
-- samples only dated, all-digit lead ids (src/admin/data-freshness.js, checkFieldDrift).

DELETE FROM lp_leads
 WHERE lp_lead_id IN ('null', 'test-smoke')
   AND ghl_contact_id IS NULL
   AND NOT EXISTS (SELECT 1 FROM lp_jobs j WHERE j.lp_lead_id = lp_leads.lp_lead_id);

-- Expect 0 and 0.
SELECT (SELECT count(*) FROM lp_leads WHERE lp_lead_id IN ('null', 'test-smoke')) AS junk_left,
       (SELECT count(*) FROM lp_leads WHERE created_at_lp IS NULL)                AS undated_left;
