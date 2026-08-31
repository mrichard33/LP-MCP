-- 2026-08-31_lp_jobs_field_backfill.sql
--
-- WHAT THIS IS: the preflight and verification queries for the lp_jobs field
-- backfill. Run the numbered sections around
-- `node scripts/backfill-lp-job-fields.js`.
--
-- WHAT THIS IS NOT: the backfill itself, and not a second implementation of the
-- mapping. The derivation lives in exactly one place — mapJobFields() in
-- src/lp-job-fields.js — which the live sync and the backfill script both call.
-- Expressing the same derivation again in SQL is how the two drift and how a
-- column ends up holding confidently wrong data that looks right. Every write is
-- done by the script.
--
-- NO DDL. The ten columns already exist (sql/schema.sql) and are nullable with no
-- default. Nothing here is mirrored in runMigrations() because there is nothing to
-- mirror. No new table, no new column, no env var.
--
-- NOT APPLIED VIA MCP apply_migration: this accompanies a backfill on a populated
-- table, which per sql/README.md is run with a human watching.
--
-- ROLLBACK: there is no data to restore — every column written here was 100% NULL
-- beforehand, so the inverse is a straight reset. Milestones likewise.
--     UPDATE lp_jobs SET job_stage = NULL, financing_status = NULL,
--            financing_company = NULL, hoa_required = NULL, permit_required = NULL,
--            permit_status = NULL, install_date = NULL,
--            install_completed_date = NULL, rep_id = NULL, updated_at_lp = NULL;
--     UPDATE lp_job_milestones SET last_changed_by = NULL, last_changed_on = NULL;
--   Note this also clears values the LIVE SYNC has written since deploy, so if the
--   code change is already out, revert the code first or the columns refill.
--
-- AFTER RUNNING: nothing to restart. The sync picks the mapper up on deploy; the
-- backfill only closes the gap for rows already stored.


-- ─── 1. PREFLIGHT — the before picture ──────────────────────────────
-- Expected 2026-08-31: total 5889, all ten at 0, created_at_lp 3590.
-- Counts drift by a few rows per hour as the sync writes; that is expected.
SELECT count(*) AS total,
       count(job_stage)        AS job_stage,
       count(financing_status) AS financing_status,
       count(financing_company) AS financing_company,
       count(hoa_required)     AS hoa_required,
       count(permit_required)  AS permit_required,
       count(permit_status)    AS permit_status,
       count(install_date)     AS install_date,
       count(install_completed_date) AS install_completed_date,
       count(rep_id)           AS rep_id,
       count(updated_at_lp)    AS updated_at_lp,
       count(created_at_lp)    AS created_at_lp
  FROM lp_jobs;


-- ─── 2. PREFLIGHT — the ghl_contact_id leak ─────────────────────────
-- Jobs sitting NULL against a parent lead that IS linked. The job-changes sweep
-- called syncJobAndMilestones with ghlContactId=null for every record and wrote
-- that null over the link the Tier A backfill copies down from lp_leads.
-- Measured 2026-08-31: 93 — every one of them Shape A, zero Shape B, which is
-- exactly the shape of that code path. RUN THIS BEFORE AND AFTER: it must not
-- grow. After the fix plus a Tier A re-run it should approach 0.
SELECT count(*) AS orphaned_jobs
  FROM lp_jobs j
 WHERE j.ghl_contact_id IS NULL
   AND EXISTS (SELECT 1 FROM lp_leads l
                WHERE l.lp_lead_id = j.lp_lead_id
                  AND l.ghl_contact_id IS NOT NULL);


-- ─── 3. RUN THE BACKFILL ────────────────────────────────────────────
--   node scripts/backfill-lp-job-fields.js --dry-run     # report, write nothing
--   node scripts/backfill-lp-job-fields.js               # apply
--
-- The dry run must report, within a handful:
--   rep_id 5559 | updated_at_lp 3583 | financing_company 918
--   financing_status 1310 | hoa_required 3717 | permit_required 5368
--   permit_status 4236 | job_stage 4592 | install_date 3907
--   install_completed_date 2283 | milestones last_changed 57654
-- A material divergence means the mapper disagrees with the validated projection.
-- Stop and diff rather than proceeding.


-- ─── 4. VERIFY — coverage matches source availability ───────────────
-- Same query as §1. Expected after the backfill: the figures listed in §3.
-- Three of these are BELOW 100% by design, and that is the correct outcome:
--   * install_date 3907 — the 'Start' milestone has an ACTUAL date on 66% of
--     jobs. The rest are not yet scheduled. estdate is populated on nearly every
--     milestone of every job and would give a ~100% column full of forecasts.
--   * hoa_required 3717 / permit_required 5368 — one-directional evidence. An HOA
--     Approved milestone proves HOA WAS required; its absence proves nothing, so
--     the negative case is NULL and never false.
--   * financing_company 918 — finco is named on 918 rows. fincrlimit and finmonths
--     are > 0 on 2 rows each and carry no signal at all.
SELECT count(*) AS total,
       count(rep_id)            AS rep_id,
       count(updated_at_lp)     AS updated_at_lp,
       count(install_date)      AS install_date,
       count(permit_status)     AS permit_status,
       count(financing_company) AS financing_company,
       count(job_stage)         AS job_stage
  FROM lp_jobs;


-- ─── 5. VERIFY — no empty-string cast landed an epoch or a typo ─────
-- Expect 0. The lower bound is 2005, NOT the 2015 in the original spec: jobs 2732
-- and 2695 carry genuine 2014 Start dates on Paid In Full rows, and Reece has
-- operated since 2005 (see src/milestone-gate.js). A 2015 floor flags real
-- history as corruption. The upper bound catches the real typos — job 54908 has a
-- 'Received All Product' dated 2206-01-23 and job 56270 an 'Inspection Passed'
-- dated 2046-04-01; neither sits on S or F, and the mapper's clamp is there so the
-- next one does not land either.
SELECT count(*) AS implausible_install_dates
  FROM lp_jobs
 WHERE install_date < '2005-01-01'
    OR install_date > now() + interval '3 years';


-- ─── 6. VERIFY — install_date against the four live statuses ────────
-- The original spec expected 0 here. Expect ~368, and that is correct data.
-- Awaiting Product and Product Received have not been scheduled, so they have no
-- actual start date. The row that matters is 'Installed & Unpaid': a job that is
-- installed but unpaid MUST have an install date, so anything other than 0 in that
-- row is a real defect.
SELECT job_status,
       count(*)                                  AS jobs,
       count(*) FILTER (WHERE install_date IS NULL) AS missing_install_date
  FROM lp_jobs
 WHERE job_status IN ('Scheduled', 'Awaiting Product', 'Product Received', 'Installed & Unpaid')
 GROUP BY job_status
 ORDER BY jobs DESC;


-- ─── 7. VERIFY — milestone change tracking ──────────────────────────
-- Expect last_changed_on ≈ 57654 of 94870, and 0 in the future. The remainder are
-- milestone slots LP has never touched: LP ships every slot for every job with ""
-- in the unset fields. lastchangedby and lastchangedon are always populated
-- together, so either one is a sufficient test.
SELECT count(*)                                             AS total_rows,
       count(last_changed_by)                               AS last_changed_by,
       count(last_changed_on)                               AS last_changed_on,
       count(*) FILTER (WHERE last_changed_on > now())      AS future_dates
  FROM lp_job_milestones;


-- ─── 8. VERIFY — the ghl_contact_id leak is closed ──────────────────
-- Re-run §2. Must not have grown.


-- Verification summary — paste results into the PR:
--   §1 before / §4 after   ten columns move from 0 to the §3 figures
--   §5                     0
--   §6                     Installed & Unpaid = 0 missing; the rest expected
--   §7                     ~57654 populated, 0 future
--   §2 vs §8               not growing
