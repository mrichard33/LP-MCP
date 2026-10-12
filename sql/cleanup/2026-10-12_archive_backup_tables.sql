-- sql/cleanup/2026-10-12_archive_backup_tables.sql
--
-- PROPOSAL. NOT A MIGRATION. NOT APPLIED. Nothing in this folder runs anywhere.
--
-- The LP project's public schema carries eleven tables that are backups,
-- undo snapshots or one-off staging left behind by past repairs, plus two
-- tables that belong to another project. They sit in the PostgREST API surface,
-- show up in every schema read, and `startup-mirrors.js` and the dashboard's
-- type generation see them as real. Found 2026-10-12 (Fix 1), row counts from
-- `list_tables` that day:
--
--   lp_source_mapping_bak_20260617             391 rows   source-mapping backup, 2026-06-17
--   agent_rules_bak_20260713                     5 rows   agent_rules backup, 2026-07-13
--   agent_rules_backup_20260930                  8 rows   agent_rules backup, 2026-09-30
--   recon_net_report_0709                    2,078 rows   recon snapshot; STILL READ by
--                                                        src/admin/lp-rtp-job-backfill.js: KEEP
--   lp_link_propagate_undo_jobs_20260829       830 rows   undo snapshot for the 08-29 link propagate
--   lp_link_propagate_undo_ms_20260829      13,489 rows   undo snapshot
--   lp_link_propagate_undo_20260831_jobs        96 rows   undo snapshot
--   lp_link_propagate_undo_20260831_milestones 1,757 rows undo snapshot
--   ai_os_load_v0_3_5                        8,875 rows   staging; its own comment says "Safe to drop"
--   ai_os_load_v0_3_6                        5,977 rows   staging; "Safe to remove"
--   calculator_events                            0 rows   window-calculator's; its sql/001 names the
--   estimate_jobs                                0 rows   HL project as the target, where both live
--                                                        with data. These LP copies are empty.
--
-- The safe first step is to MOVE, not DROP: an `archive` schema is outside the
-- API surface and the dashboards' type generation, keeps every row, and is
-- undone with the same statement pointing back at `public`. Dropping happens
-- in a later migration, after 30 quiet days, with the destructive marker.
--
-- HOW THIS BECOMES REAL (do not run from the dashboard):
--   1. The baseline dump must exist and be merged first (sql/README.md: order).
--   2. Copy the statements below into supabase/migrations/<ts>_archive_backup_tables.sql
--      with a timestamp AFTER the baseline, open a PR, merge. CI applies it.
--   3. Thirty days later, a second migration drops archive.* with
--      `-- destructive: approved by <name> <date>` on it.
--
-- ROLLBACK: ALTER TABLE archive.<name> SET SCHEMA public; for each table.

CREATE SCHEMA IF NOT EXISTS archive;

ALTER TABLE IF EXISTS public.lp_source_mapping_bak_20260617             SET SCHEMA archive;
ALTER TABLE IF EXISTS public.agent_rules_bak_20260713                   SET SCHEMA archive;
ALTER TABLE IF EXISTS public.agent_rules_backup_20260930                SET SCHEMA archive;
ALTER TABLE IF EXISTS public.lp_link_propagate_undo_jobs_20260829       SET SCHEMA archive;
ALTER TABLE IF EXISTS public.lp_link_propagate_undo_ms_20260829         SET SCHEMA archive;
ALTER TABLE IF EXISTS public.lp_link_propagate_undo_20260831_jobs       SET SCHEMA archive;
ALTER TABLE IF EXISTS public.lp_link_propagate_undo_20260831_milestones SET SCHEMA archive;
ALTER TABLE IF EXISTS public.ai_os_load_v0_3_5                          SET SCHEMA archive;
ALTER TABLE IF EXISTS public.ai_os_load_v0_3_6                          SET SCHEMA archive;
-- window-calculator's tables live in the HL project; these LP copies are empty.
ALTER TABLE IF EXISTS public.calculator_events                          SET SCHEMA archive;
ALTER TABLE IF EXISTS public.estimate_jobs                              SET SCHEMA archive;
-- recon_net_report_0709 stays in public until lp-rtp-job-backfill.js stops reading it.

-- Verification (after the migration applies):
--   SELECT table_schema, table_name FROM information_schema.tables
--    WHERE table_name IN ('lp_source_mapping_bak_20260617','agent_rules_bak_20260713',
--      'agent_rules_backup_20260930','lp_link_propagate_undo_jobs_20260829',
--      'lp_link_propagate_undo_ms_20260829','lp_link_propagate_undo_20260831_jobs',
--      'lp_link_propagate_undo_20260831_milestones','ai_os_load_v0_3_5','ai_os_load_v0_3_6',
--      'calculator_events','estimate_jobs')
--    ORDER BY 1, 2;   -- every row should read archive
