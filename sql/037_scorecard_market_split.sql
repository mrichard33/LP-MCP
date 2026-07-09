-- ─── Per-market scorecard split — sql/037_scorecard_market_split.sql ───
--
-- Two reporting-layer tables in the LP Supabase project. NEITHER writes back to LP.
--
--   lp_branch_market_map        Branch code → market rollup (single source of truth
--                               for the 7 dashboard markets). The branch code is the
--                               `service_area_zips.market_code` a lead's ZIP resolves
--                               to (STPET, ORL, FTMYR, JAX, SAR, BOCA, MIAMI, FTLAU,
--                               LAKE). Fort Lauderdale = BOCA + MIAMI + FTLAU.
--
--   lp_lead_market_assignments  Per-lead market resolution audit, produced by the
--                               nightly market-assignment job (src/jobs/
--                               market-assignment-daily.js). Reporting-side record
--                               only — it does NOT mutate LP.
--
-- Leads carry no brn_id in the cache, so market is resolved from ZIP:
--   lp_leads.zip → service_area_zips.market_code (branch) → lp_branch_market_map
--   → market_code (*_MKT).  ZIP present but not in territory → OUT_OF_AREA.
--   No usable ZIP → UNASSIGNED.
--
-- Idempotent — safe to re-run.

-- ─── Branch → market rollup ──────────────────────────────────────────────────────
create table if not exists lp_branch_market_map (
  brn_id        text primary key,          -- branch code (= service_area_zips.market_code)
  market_code   text not null,             -- snapshot key written to lp_market_scorecard_daily.market
  market_label  text not null
);

insert into lp_branch_market_map (brn_id, market_code, market_label) values
  ('STPET', 'STPET_MKT', 'St. Petersburg'),   -- Tampa ships under STPET in LP
  ('ORL',   'ORL_MKT',   'Orlando'),
  ('FTMYR', 'FTMYR_MKT', 'Fort Myers'),
  ('JAX',   'JAX_MKT',   'Jacksonville'),
  ('SAR',   'SAR_MKT',   'Sarasota'),
  ('BOCA',  'FTLAU_MKT', 'Fort Lauderdale'),
  ('MIAMI', 'FTLAU_MKT', 'Fort Lauderdale'),
  ('FTLAU', 'FTLAU_MKT', 'Fort Lauderdale'),
  ('LAKE',  'LAKE_MKT',  'Lakeland')
on conflict (brn_id) do update
  set market_code = excluded.market_code, market_label = excluded.market_label;

-- ─── Per-lead market assignment audit ────────────────────────────────────────────
create table if not exists lp_lead_market_assignments (
  lead_id               text primary key,   -- lp_leads.lp_lead_id
  prospect_id           text,               -- lp_leads.lp_prospect_id (cohort join key)
  raw_brn_id            text,               -- original branch id if ever present (cache has none today)
  resolved_market_code  text not null,      -- '*_MKT' | 'OUT_OF_AREA' | 'UNASSIGNED'
  method                text not null,      -- 'brn_map' | 'zip_lookup' | 'zip_out_of_area' | 'no_address'
  zip                   text,
  resolved_at           timestamptz not null default now()
);
create index if not exists idx_llma_market   on lp_lead_market_assignments(resolved_market_code);
create index if not exists idx_llma_prospect on lp_lead_market_assignments(prospect_id);
