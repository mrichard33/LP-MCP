-- ════════════════════════════════════════════════════════════════════
-- Smoke test for sql/migrations/2026-08-05_lp_report_facts.sql
--
-- Run AFTER applying the migration, in the Supabase SQL editor, as ONE
-- statement batch. Everything happens inside a transaction that ROLLS BACK
-- — nothing persists, no matter what. A failed assertion RAISEs and aborts.
--
-- What it proves (handoff tests #16–18 + the rebuild path):
--   #17 retention: a second ingest of the SAME period keeps the superseded
--       snapshot, its rows, and its facts (flag flip only, nothing deleted)
--   #16 facts == raw aggregates, both report types (hand-computed sums)
--   #18 two daily Report B ingests → two distinct queryable as_of_date
--       points (the time-series capability), dup_review split out
--   rebuild: a corrupted fact row is restored by scorecard_rebuild_facts
-- ════════════════════════════════════════════════════════════════════
BEGIN;

DO $smoke$
DECLARE
  a1 uuid; a2 uuid; b1 uuid; b2 uuid;
  n  bigint; c  int; d  date;
BEGIN
  -- ── two Report A ingests, SAME period (2099-07) ──────────────────────────
  a1 := scorecard_ingest_snapshot(
    '{"report_type":"jobs_by_milestone","period_start":"2099-07-01","period_end":"2099-07-31",
      "file_sha256":"smoke-a-1","storage_path":"smoke/a1.pdf","row_count":2,
      "net_total_cents":150000,"gross_total_cents":180000,"as_of_date":"2099-07-31"}'::jsonb,
    '[{"job_number":"1","market":"ORL_MKT","branch_code_raw":"ORL","net_cents":100000,"gross_cents":120000},
      {"job_number":"2","market":"FTLAU_MKT","branch_code_raw":"BOCA","net_cents":50000,"gross_cents":60000}]'::jsonb);

  a2 := scorecard_ingest_snapshot(
    '{"report_type":"jobs_by_milestone","period_start":"2099-07-01","period_end":"2099-07-31",
      "file_sha256":"smoke-a-2","storage_path":"smoke/a2.pdf","row_count":3,
      "net_total_cents":350000,"gross_total_cents":420000,"as_of_date":"2099-07-31"}'::jsonb,
    '[{"job_number":"1","market":"ORL_MKT","branch_code_raw":"ORL","net_cents":100000,"gross_cents":120000},
      {"job_number":"3","market":"ORL_MKT","branch_code_raw":"ORL","net_cents":200000,"gross_cents":240000},
      {"job_number":"2","market":"FTLAU_MKT","branch_code_raw":"BOCA","net_cents":50000,"gross_cents":60000}]'::jsonb);

  -- #17: the superseded snapshot SURVIVES — snapshot, rows, and facts.
  SELECT COUNT(*) INTO c FROM scorecard_report_snapshots
   WHERE report_type = 'jobs_by_milestone' AND period_start = '2099-07-01';
  IF c <> 2 THEN RAISE EXCEPTION 'retention: expected 2 snapshots for the period, found %', c; END IF;
  SELECT COUNT(*) INTO c FROM scorecard_report_rows_a WHERE snapshot_id = a1;
  IF c <> 2 THEN RAISE EXCEPTION 'retention: superseded snapshot lost raw rows (%)', c; END IF;
  SELECT COUNT(*) INTO c FROM lp_report_facts WHERE snapshot_id = a1;
  IF c = 0 THEN RAISE EXCEPTION 'retention: superseded snapshot lost its facts'; END IF;

  -- exactly one current, facts in lockstep
  IF NOT EXISTS (SELECT 1 FROM scorecard_report_snapshots WHERE id = a2 AND is_current)
     OR EXISTS (SELECT 1 FROM scorecard_report_snapshots WHERE id = a1 AND is_current) THEN
    RAISE EXCEPTION 'is_current: expected a2 current, a1 demoted';
  END IF;
  IF EXISTS (SELECT 1 FROM lp_report_facts WHERE snapshot_id = a1 AND is_current)
     OR EXISTS (SELECT 1 FROM lp_report_facts WHERE snapshot_id = a2 AND NOT is_current) THEN
    RAISE EXCEPTION 'is_current: facts not in lockstep with snapshots';
  END IF;

  -- #16 (A): facts == hand-computed raw aggregates.
  SELECT value_cents INTO n FROM lp_report_facts
   WHERE snapshot_id = a2 AND market = 'ORL_MKT' AND branch_code_raw = 'ORL' AND metric = 'net_sales';
  IF n <> 300000 THEN RAISE EXCEPTION 'A facts: ORL net_sales expected 300000, got %', n; END IF;
  SELECT value_count INTO c FROM lp_report_facts
   WHERE snapshot_id = a2 AND market = 'ORL_MKT' AND branch_code_raw = 'ORL' AND metric = 'gross_sold';
  IF c <> 2 THEN RAISE EXCEPTION 'A facts: ORL gross_sold count expected 2, got %', c; END IF;
  SELECT value_cents INTO n FROM lp_report_facts
   WHERE snapshot_id = a2 AND market = 'FTLAU_MKT' AND metric = 'net_sales';
  IF n <> 50000 THEN RAISE EXCEPTION 'A facts: FTLAU net_sales expected 50000, got %', n; END IF;

  -- ── two DAILY Report B ingests (different days) ──────────────────────────
  b1 := scorecard_ingest_snapshot(
    '{"report_type":"jobs_by_status","period_start":"2099-08-01","period_end":"2099-08-01",
      "file_sha256":"smoke-b-1","storage_path":"smoke/b1.pdf","row_count":5,
      "gross_total_cents":150000,"as_of_date":"2099-08-01"}'::jsonb,
    '[{"prosp_number":"10","market":"ORL_MKT","branch_code_raw":"ORL","status_raw":"HOLD - HOA","bucket":"hoa","total_gross_cents":100000},
      {"prosp_number":"11","market":"SAR_MKT","branch_code_raw":"SAR","status_raw":"New","bucket":"other_pending","total_gross_cents":50000},
      {"prosp_number":"12","market":"STPET_MKT","branch_code_raw":"STPET","status_raw":"Credit Decline","bucket":"excluded","total_gross_cents":0},
      {"prosp_number":"13","market":"JAX_MKT","branch_code_raw":"JAX","status_raw":"New","bucket":"other_pending","total_gross_cents":70000,"dup_review":true},
      {"prosp_number":"13","market":"JAX_MKT","branch_code_raw":"JAX","status_raw":"New","bucket":"other_pending","total_gross_cents":70000,"dup_review":true}]'::jsonb);

  b2 := scorecard_ingest_snapshot(
    '{"report_type":"jobs_by_status","period_start":"2099-08-02","period_end":"2099-08-02",
      "file_sha256":"smoke-b-2","storage_path":"smoke/b2.pdf","row_count":1,
      "gross_total_cents":250000,"as_of_date":"2099-08-02"}'::jsonb,
    '[{"prosp_number":"10","market":"ORL_MKT","branch_code_raw":"ORL","status_raw":"HOLD - HOA","bucket":"hoa","total_gross_cents":250000}]'::jsonb);

  -- #18: two distinct as_of_date points queryable as a series.
  SELECT COUNT(DISTINCT as_of_date) INTO c FROM lp_report_facts
   WHERE metric = 'good_business_open' AND bucket = 'hoa' AND as_of_date IN ('2099-08-01','2099-08-02');
  IF c <> 2 THEN RAISE EXCEPTION 'time series: expected 2 distinct as_of_date points, got %', c; END IF;
  SELECT value_cents INTO n FROM lp_report_facts
   WHERE snapshot_id = b1 AND metric = 'good_business_open' AND bucket = 'hoa';
  IF n <> 100000 THEN RAISE EXCEPTION 'B facts day1: hoa expected 100000, got %', n; END IF;
  SELECT value_cents INTO n FROM lp_report_facts
   WHERE snapshot_id = b2 AND metric = 'good_business_open' AND bucket = 'hoa';
  IF n <> 250000 THEN RAISE EXCEPTION 'B facts day2: hoa expected 250000, got %', n; END IF;

  -- #16 (B) + dup split: dups land ONLY in dup_review_pending; excluded kept.
  SELECT value_cents, value_count INTO n, c FROM lp_report_facts
   WHERE snapshot_id = b1 AND metric = 'dup_review_pending';
  IF n <> 140000 OR c <> 2 THEN RAISE EXCEPTION 'B facts: dup_review_pending expected 140000/2, got %/%', n, c; END IF;
  SELECT value_count INTO c FROM lp_report_facts
   WHERE snapshot_id = b1 AND metric = 'pipeline_excluded';
  IF c <> 1 THEN RAISE EXCEPTION 'B facts: pipeline_excluded expected count 1, got %', c; END IF;
  IF EXISTS (SELECT 1 FROM lp_report_facts
              WHERE snapshot_id = b1 AND metric = 'good_business_open' AND market = 'JAX_MKT') THEN
    RAISE EXCEPTION 'B facts: dup_review rows leaked into good_business_open';
  END IF;

  -- rebuild: corrupt a fact, rebuild, assert restored (raw rows win).
  UPDATE lp_report_facts SET value_cents = 999999
   WHERE snapshot_id = b1 AND metric = 'good_business_open' AND bucket = 'hoa';
  PERFORM scorecard_rebuild_facts(b1);
  SELECT value_cents INTO n FROM lp_report_facts
   WHERE snapshot_id = b1 AND metric = 'good_business_open' AND bucket = 'hoa';
  IF n <> 100000 THEN RAISE EXCEPTION 'rebuild: expected 100000 after rebuild, got %', n; END IF;

  RAISE NOTICE 'lp_report_facts smoke: ALL CHECKS PASSED (rolling back)';
END
$smoke$;

ROLLBACK;
