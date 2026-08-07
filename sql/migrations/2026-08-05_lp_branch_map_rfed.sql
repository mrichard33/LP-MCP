-- ════════════════════════════════════════════════════════════════════
-- lp_branch_market_map: add RFED → Fort Lauderdale — 2026-08-05
--
-- Run in: LP MCP Supabase → SQL Editor (or supabase MCP apply_migration).
-- Idempotent; safe to re-run. Applied manually — no migration runner.
--
-- WHY: RFED appears as a live branch code in the LP exports (286 rows in
-- the 2026-08-05 Lead Disposition Detail YTD CSV) and in the parsers'
-- known-branch lists, but was never seeded into lp_branch_market_map, so
-- any RFED revenue row quarantines and fails the whole file closed.
-- Standing market ruling: FTLAU + BOCA + MIAMI + RFED → Fort Lauderdale.
-- LAKE stays LAKE_MKT — its own warehouse code AND its own display market.
--
-- (Superseded note: this comment originally said the dashboard folded LAKE into
-- Orlando at display and that Lakeland was never shown. The 2026-08-06 ruling
-- reversed that fold; Reece-Dashboard lib/scorecard/markets.ts now carries
-- Lakeland as one of seven first-class markets, and no LAKE number is summed
-- into Orlando anywhere.)
-- ════════════════════════════════════════════════════════════════════

insert into lp_branch_market_map (brn_id, market_code, market_label) values
  ('RFED', 'FTLAU_MKT', 'Fort Lauderdale')
on conflict (brn_id) do update
  set market_code = excluded.market_code, market_label = excluded.market_label;
