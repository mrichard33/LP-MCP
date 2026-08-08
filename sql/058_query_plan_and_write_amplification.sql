-- ============================================================================
-- 058_query_plan_and_write_amplification.sql
-- ============================================================================
-- Target:  LP Supabase  (rcjcgjlqzepicbwhnnjl) — statements 1-4, 6
--          HL Supabase  (jtlngmcrtqncimtjjzlz) — statement 5
-- Author:  2026-08-08
--
-- STATUS:  ALREADY APPLIED to both databases on 2026-08-08. This file is the
--          record of what was run, why, and what it measured. It is written to
--          be idempotent so it can be replayed onto a restored snapshot.
--
-- CONTEXT
-- ───────
-- Follows sql/057 and PR #648/#649. With the heartbeat query volume removed
-- and the instance upgraded Micro -> Small, a fresh pg_stat_statements window
-- exposed a different and larger problem: a small number of low-frequency
-- queries doing full sequential scans of the biggest tables. These barely
-- register on total execution time because they run only a few times an hour,
-- but each one reads hundreds of megabytes off disk and evicts the entire
-- 512 MB buffer pool. The damage lands on every OTHER query, which then has
-- to re-read from disk. That is what kept the table cache hit rate at 67%.
--
-- Fixing cache-eviction sources matters more than the raw millisecond totals
-- of the queries themselves.
--
-- NOTE ON CONCURRENTLY
-- ────────────────────
-- sql/057 used CREATE INDEX CONCURRENTLY, which cannot run through any MCP
-- path (every one wraps statements in a transaction). These were built
-- NON-concurrently, under `SET LOCAL lock_timeout = '10s'`, after confirming
-- pg_stat_activity showed zero other active backends. The lock_timeout is the
-- safety: if the table had been busy the statement would have aborted in 10
-- seconds rather than queueing behind a long transaction and stalling the
-- sync engine. A non-concurrent build also fails cleanly — it rolls back
-- rather than leaving an INVALID index behind, which is the failure mode
-- CONCURRENTLY has.
--
-- If replaying this onto a live production database at a busy time, add
-- CONCURRENTLY and run each statement by hand in the SQL editor instead.


-- ===========================================================================
-- 1. lp_call_logs — synced_at reconciliation scan   [LP]
-- ===========================================================================
-- Before: Parallel Seq Scan on lp_call_logs
--           Rows Removed by Filter: 771,658 (x2 workers)
--           Buffers: shared hit=3,391 read=78,649   (~614 MB off disk)
--           Execution Time: 2,924 ms   to return 28 rows
--
-- lp_call_logs is 641 MB of heap over 1,543,761 rows and had indexes only on
-- (id), (lp_call_id), (call_date) and (lp_lead_id, call_date). Nothing covered
-- synced_at, so this reconciliation query scanned the entire table. At ~2 runs
-- per 20 minutes it flushed the whole buffer pool roughly every 10 minutes.
--
-- Partial on ghl_contact_id IS NOT NULL: 336,677 of 1,543,761 rows qualify,
-- so the index is 6.8 MB instead of ~33 MB.
--
-- After:  Index Scan using idx_lp_call_logs_synced_at
--           Buffers: shared hit=7 read=16
--           Execution Time: 4.5 ms
--         2,924 ms -> 4.5 ms, and 78,649 disk blocks -> 16.

CREATE INDEX IF NOT EXISTS idx_lp_call_logs_synced_at
  ON public.lp_call_logs (synced_at DESC)
  WHERE ghl_contact_id IS NOT NULL;


-- ===========================================================================
-- 2. lp_notes — same reconciliation shape           [LP]
-- ===========================================================================
-- The same job hits lp_notes with an identical predicate: 194 ms mean,
-- 13,296 blocks read per call. Smaller table, same defect, same fix.

CREATE INDEX IF NOT EXISTS idx_lp_notes_synced_at
  ON public.lp_notes (synced_at DESC)
  WHERE ghl_contact_id IS NOT NULL;


-- ===========================================================================
-- 3. lp_notes — push-queue index, v2                [LP]
-- ===========================================================================
-- sql/057 added idx_lp_notes_push_queue (ghl_note_pushed, created_at_lp) and
-- noted a known residual: the two IS NOT NULL conditions were left as heap
-- filters, so the plan still walked 133,391 index entries and touched ~121,000
-- buffers to return 44 rows.
--
-- That residual is now closed. sql/057 had hedged against putting the
-- conditions in a partial predicate, on the theory that PostgREST's
-- `NOT (col IS NULL)` rendering might not match `WHERE col IS NOT NULL`.
-- That theory was tested directly on 2026-08-08 and is FALSE — Postgres's
-- predicate prover matches it correctly. See the retraction section in
-- sql/057 for the evidence.
--
-- Before (v1): Index Scan, Rows Removed by Filter: 133,391
--                Buffers: shared hit=121,311
--                Execution Time: 117 ms
-- After  (v2): Index Scan using idx_lp_notes_push_queue_v2
--                Buffers: shared hit=32 read=2
--                Execution Time: 0.217 ms
--
-- 117 ms -> 0.217 ms. Cumulative against sql/057's baseline: 11,658 ms ->
-- 0.217 ms, a ~54,000x reduction on the GHL note-pipeline drain.
--
-- v2 strictly subsumes v1 for both consumers of this table (the plain drain
-- and the terminal-flag variant both filter ghl_contact_id and note_body
-- NOT NULL), so v1 was dropped to stop paying its write cost on a table
-- taking ~3,667 inserts per sync cycle.

CREATE INDEX IF NOT EXISTS idx_lp_notes_push_queue_v2
  ON public.lp_notes (ghl_note_pushed, created_at_lp)
  WHERE ghl_contact_id IS NOT NULL AND note_body IS NOT NULL;

DROP INDEX IF EXISTS public.idx_lp_notes_push_queue;


-- ===========================================================================
-- 4. system_events_filtered — drop dead 58 MB index [LP]
-- ===========================================================================
-- idx_sef_filter_reason (filter_reason, created_at DESC), 58 MB, ZERO scans
-- since stats began, on a table carrying 500,901 writes. system_events_filtered
-- is itself effectively write-only: 497,669 rows, 315 MB, 68 index scans and
-- 9 sequential scans in its entire lifetime.
--
-- Pure write amplification with no read benefit. Recreate with the statement
-- below if a filter_reason query is ever actually built.
--
--   CREATE INDEX idx_sef_filter_reason
--     ON public.system_events_filtered (filter_reason, created_at DESC);

DROP INDEX IF EXISTS public.idx_sef_filter_reason;


-- ===========================================================================
-- 5. lead_events — drop duplicate 244 MB index      [HL — RUN ON HL SUPABASE]
-- ===========================================================================
-- ⚠ This statement targets the HL MCP Supabase (jtlngmcrtqncimtjjzlz), NOT LP.
--
-- lead_events carried TWO 244 MB indexes on the same single column:
--
--   lead_events_event_hash_key   UNIQUE btree (event_hash)   244 MB
--   idx_lead_events_hash         plain  btree (event_hash)   244 MB
--
-- The plain one is an exact duplicate of the unique constraint's index. The
-- unique index already serves every possible lookup on event_hash, so the
-- duplicate could never be chosen — and wasn't: zero scans across the full
-- stats window opening 2025-12-08, against 2,136,988 writes to the table.
--
-- Dedup behaviour is unaffected. The UNIQUE constraint is what enforces
-- idempotency on event_hash and it is untouched — verified present after the
-- drop.
--
-- HL database size: 8,184 MB -> 7,952 MB. That also brings the instance back
-- under the 8 GB included with Pro.

-- DROP INDEX IF EXISTS public.idx_lead_events_hash;   -- run against HL, not LP


-- ===========================================================================
-- 6. Autovacuum tuning on the churn-heavy tables    [LP]
-- ===========================================================================
-- Postgres defaults autovacuum_vacuum_scale_factor to 0.20 — a table may
-- reach 20% dead tuples before it is cleaned. On tables this size that is far
-- too loose, and the audit found exactly the expected result:
--
--   five9_events_raw  18.9% dead      lp_jobs            16.5% dead
--   lp_call_logs      16.6% dead      lp_job_milestones  15.9% dead
--   lp_prospects      14.6% dead      lp_activities      11.7% dead
--
-- Dead tuples are read into the buffer pool alongside live ones, so bloat on a
-- cache-constrained instance costs on every scan, not just on disk.
--
-- 0.05 vacuum / 0.02 analyze means cleanup at 5% dead and fresh planner stats
-- at 2% churn. More frequent, much smaller passes. Reversible per table with
--   ALTER TABLE <t> RESET (autovacuum_vacuum_scale_factor,
--                          autovacuum_analyze_scale_factor);

ALTER TABLE public.lp_call_logs               SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.lp_activities              SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.five9_events_raw           SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.lp_prospects               SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.system_events              SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.agent_actions              SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.processed_events           SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.lp_notes                   SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.lp_leads                   SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.lp_job_milestones          SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE public.lp_lead_market_assignments SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02);

-- Planner stats refreshed after the new indexes. VACUUM cannot run through
-- MCP (transaction block); autovacuum handles reclamation on the new
-- thresholds above.
ANALYZE public.lp_call_logs;
ANALYZE public.lp_notes;
ANALYZE public.lp_leads;
ANALYZE public.agent_actions;
ANALYZE public.system_events;


-- ===========================================================================
-- VERIFICATION — confirmed 2026-08-08
-- ===========================================================================
--   idx_lp_call_logs_synced_at    valid   6,872 kB
--   idx_lp_notes_synced_at        valid   1,280 kB
--   idx_lp_notes_push_queue_v2    valid   1,576 kB
--   idx_lp_leads_phone_trgm       valid   9,888 kB
--   idx_lp_leads_phone_alt_trgm   valid   2,504 kB
--   invalid indexes on LP: 0
--
--   LP database size: 6,124 MB
--   HL database size: 8,184 MB -> 7,952 MB
--
-- Re-run to confirm nothing regressed:
--
--   SELECT c.relname, i.indisvalid, pg_size_pretty(pg_relation_size(c.oid))
--   FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--   WHERE NOT i.indisvalid;
--   -- expect zero rows
--
-- ===========================================================================
-- DELIBERATELY NOT DONE
-- ===========================================================================
--   * The remaining ~125 unused indexes are all under 1 MB. Dropping them
--     saves negligible write cost and risks breaking a rare query. Only the
--     two large, provably redundant ones were removed.
--
--   * No retention/deletion of system_events_filtered, lp_activities,
--     five9_events_raw or lead_events. system_events_filtered alone holds
--     315 MB that is essentially never read, and lead_events is 7.9 GB of
--     HL's 8.0 GB — but deleting an audit trail is a business decision about
--     what history must be retained, not a performance call. Needs Mark's
--     ruling on retention windows before anything is removed.
--
--   * src/decision-engine-heartbeat.js line 159 was queued for a
--     `.not(col,'is',null)` -> `.gte(col, EPOCH)` rewrite. NOT DONE, and it
--     should not be: the premise was wrong and the query measures 0.05 ms.
--     See the retraction section in sql/057.
--
--   * Compute is Small (512 MB shared_buffers, 1.5 GB effective_cache_size).
--     Do not size up until 24-48 hours of post-fix data exists — the buffer
--     pool was being flushed every ~10 minutes by statement 1, so the old
--     67% cache hit rate was not a true measure of what the working set needs.
-- ===========================================================================
