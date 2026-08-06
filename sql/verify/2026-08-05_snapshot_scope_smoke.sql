-- Smoke for 2026-08-05_snapshot_scope.sql — run inside BEGIN … ROLLBACK.
-- Proves the §1 regression cannot recur: an MTD arrival never demotes a YTD
-- snapshot of the same report type, while same-scope overlaps still supersede.
BEGIN;

-- ── A. the regression itself: MTD must not demote YTD ─────────────────────
-- YTD jobs_by_milestone (Jan 1 → Aug 5, generated Aug 5)
SELECT scorecard_ingest_snapshot(
  jsonb_build_object(
    'report_type', 'jobs_by_milestone',
    'period_start', '2026-01-01', 'period_end', '2026-08-05',
    'as_of_date', '2026-08-05', 'row_count', 1,
    'file_sha256', 'smoke-scope-ytd', 'storage_path', 'smoke/ytd.pdf'),
  jsonb_build_array(jsonb_build_object(
    'job_number', 'SMOKE-Y', 'branch_code_raw', 'ORL', 'market', 'ORL_MKT',
    'gross_cents', 100000, 'net_cents', 100000))
);

-- MTD jobs_by_milestone (Aug 1 → Aug 31, generated Aug 5) — overlaps the YTD
-- window by 5 days. Under the old unscoped rule this demoted the YTD snapshot.
SELECT scorecard_ingest_snapshot(
  jsonb_build_object(
    'report_type', 'jobs_by_milestone',
    'period_start', '2026-08-01', 'period_end', '2026-08-31',
    'as_of_date', '2026-08-05', 'row_count', 1,
    'file_sha256', 'smoke-scope-mtd', 'storage_path', 'smoke/mtd.pdf'),
  jsonb_build_array(jsonb_build_object(
    'job_number', 'SMOKE-M', 'branch_code_raw', 'ORL', 'market', 'ORL_MKT',
    'gross_cents', 200000, 'net_cents', 200000))
);

-- EXPECT: both current, one per scope; facts current in lockstep.
SELECT 'A. mtd does not demote ytd' AS check,
       count(*) FILTER (WHERE scope = 'ytd' AND is_current) AS ytd_current,
       count(*) FILTER (WHERE scope = 'mtd' AND is_current) AS mtd_current
  FROM scorecard_report_snapshots
 WHERE file_sha256 LIKE 'smoke-scope-%';
-- ytd_current = 1, mtd_current = 1

SELECT 'A2. facts follow the snapshot' AS check, s.scope, f.is_current, count(*)
  FROM lp_report_facts f JOIN scorecard_report_snapshots s ON s.id = f.snapshot_id
 WHERE s.file_sha256 LIKE 'smoke-scope-%'
 GROUP BY 2, 3;
-- both scopes is_current = true

-- ── B. same-scope overlap still supersedes ────────────────────────────────
SELECT scorecard_ingest_snapshot(
  jsonb_build_object(
    'report_type', 'jobs_by_milestone',
    'period_start', '2026-08-01', 'period_end', '2026-08-31',
    'as_of_date', '2026-08-06', 'row_count', 1,
    'file_sha256', 'smoke-scope-mtd2', 'storage_path', 'smoke/mtd2.pdf'),
  jsonb_build_array(jsonb_build_object(
    'job_number', 'SMOKE-M2', 'branch_code_raw', 'ORL', 'market', 'ORL_MKT',
    'gross_cents', 300000, 'net_cents', 300000))
);

SELECT 'B. later mtd supersedes earlier mtd, ytd untouched' AS check,
       file_sha256, is_current, scope
  FROM scorecard_report_snapshots
 WHERE file_sha256 LIKE 'smoke-scope-%'
 ORDER BY ingested_at;
-- smoke-scope-ytd  true  ytd
-- smoke-scope-mtd  FALSE mtd
-- smoke-scope-mtd2 true  mtd

-- ── C. a prior-month (month scope) pull supersedes its stale MTD sibling ──
-- {mtd, month} are one family: July's MTD dailies must yield to the finalized
-- July pull rather than double-counting July.
SELECT scorecard_ingest_snapshot(
  jsonb_build_object(
    'report_type', 'jobs_by_milestone',
    'period_start', '2026-07-01', 'period_end', '2026-07-31',
    'as_of_date', '2026-07-20', 'row_count', 1,
    'file_sha256', 'smoke-scope-jul-mtd', 'storage_path', 'smoke/jul-mtd.pdf'),
  jsonb_build_array(jsonb_build_object(
    'job_number', 'SMOKE-J1', 'branch_code_raw', 'ORL', 'market', 'ORL_MKT',
    'gross_cents', 100, 'net_cents', 100)));
SELECT scorecard_ingest_snapshot(
  jsonb_build_object(
    'report_type', 'jobs_by_milestone',
    'period_start', '2026-07-01', 'period_end', '2026-07-31',
    'as_of_date', '2026-08-05', 'row_count', 1,
    'file_sha256', 'smoke-scope-jul-final', 'storage_path', 'smoke/jul-final.pdf'),
  jsonb_build_array(jsonb_build_object(
    'job_number', 'SMOKE-J2', 'branch_code_raw', 'ORL', 'market', 'ORL_MKT',
    'gross_cents', 200, 'net_cents', 200)));

SELECT 'C. month supersedes stale mtd for the same window' AS check,
       file_sha256, scope, is_current
  FROM scorecard_report_snapshots
 WHERE file_sha256 LIKE 'smoke-scope-jul-%' ORDER BY ingested_at;
-- smoke-scope-jul-mtd   mtd   FALSE
-- smoke-scope-jul-final month true

-- ── D. scope derivation table ─────────────────────────────────────────────
SELECT 'D. derivation' AS check,
       lp_derive_scope('2026-08-01','2026-08-31','2026-08-05') AS aug_mtd,      -- mtd
       lp_derive_scope('2026-01-01','2026-09-02','2026-08-05') AS ytd_future,   -- ytd
       lp_derive_scope('2026-01-01','2026-08-04','2026-08-05') AS ytd_pinned,   -- ytd
       lp_derive_scope('2026-07-01','2026-07-31','2026-08-05') AS jul_month,    -- month
       lp_derive_scope('2026-08-04','2026-08-04','2026-08-05') AS one_day,      -- custom
       lp_derive_scope('2026-01-01','2026-06-30','2026-08-05') AS stale_ytd;    -- custom

ROLLBACK;
