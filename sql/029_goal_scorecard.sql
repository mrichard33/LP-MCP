-- ─── Goal/Variance Scorecard ("Monday a.m." report) — sql/029_goal_scorecard.sql ───
--
-- Two tables in the LP Supabase project:
--
--   scorecard_goals            EDITABLE management inputs (one row per market).
--                              Read by the dashboard at request time; written by
--                              the admin-gated saveScorecardGoals() server action.
--                              Goal columns / pace / variance are derived at READ
--                              TIME from these values — a goal edit takes effect
--                              immediately, no cron wait.
--
--   lp_market_scorecard_daily  ACTUALS-only daily snapshot, upserted by the LP-MCP
--                              daily job (src/jobs/goal-scorecard-daily.js). One row
--                              per (market, as_of_date). NO goal/pace/variance stored.
--
-- Reece has no LP office/market field, so market = constant 'REECE'. The schema is
-- group-by-market so a later split (sales rep/team, product line, or the brn_id
-- branch field) is a config change, not a migration.
--
-- ⚠ TIE-OUT: ko_count, good_business, close_pct, good_rate_pct (and read-time pace /
-- variance) are LP-internal definitions that stay provisional until reconciled to a
-- real Reece Monday-a.m. export. See src/jobs/scorecard-metrics.js.
--
-- Idempotent — safe to re-run.

-- ─── EDITABLE goal config ────────────────────────────────────────────────────────
-- ⚠ monthly_goal_dollars IS NET. Net = LP NSA, never GSA. Every goal comparison
-- in Reece-Dashboard reads a net actual, and the NSLI chain divides this goal by
-- a net-over-gross-issued rate (NSA ÷ NumIssued) — goal and rate numerator must
-- be the same currency or every derived Issued/Leads/Demo target rescales too.
-- The basis is recorded per row in goal_basis, added by Reece-Dashboard
-- db/migrations/0019_goal_net_basis.sql (this table is created here but read and
-- written by that repo). Enforced app-side in lib/scorecard/goalBasis.ts.
create table if not exists scorecard_goals (
  market                text primary key,            -- 'REECE' (or future split key)
  monthly_goal_dollars  numeric  not null default 0,  -- NET sales dollars (NSA) — see above
  working_days          integer  not null default 26,
  target_close_pct      numeric  not null default 30.0,
  target_good_rate_pct  numeric  not null default 70.0,
  target_demo_pct       numeric  not null default 70.0,
  target_ko_pct         numeric  not null default 10.0,
  trailing_nsli         numeric  not null default 0,  -- past-3-month NSLI (pace basis)
  updated_by            text,
  updated_at            timestamptz not null default now()
);

-- Seed the single Reece market with safe defaults; Mark edits via the dashboard.
insert into scorecard_goals (market) values ('REECE') on conflict (market) do nothing;

-- RLS: authenticated users may READ goals (the dashboard reads them server-side and
-- shows them read-only to non-admins). Writes go through the service-role key only
-- (the admin-gated server action), so no INSERT/UPDATE policy is granted to
-- authenticated — service role bypasses RLS. Mirrors the executives/fb_secrets pattern.
alter table scorecard_goals enable row level security;
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'scorecard_goals'
      and policyname = 'scorecard_goals_read'
  ) then
    create policy scorecard_goals_read on scorecard_goals
      for select to authenticated using (true);
  end if;
end $$;

-- ─── ACTUALS-only daily snapshot ─────────────────────────────────────────────────
create table if not exists lp_market_scorecard_daily (
  id              uuid primary key default gen_random_uuid(),
  market          text not null,
  as_of_date      date not null,              -- snapshot day (ET) the job computed
  period_start    date not null,              -- MTD window start (ET)
  period_end      date not null,              -- MTD window end   (= as_of_date for live MTD)
  days_elapsed    integer not null,

  -- funnel actuals (cohort = leads whose lead-date falls in the window)
  leads           integer not null default 0,
  issued          integer not null default 0,
  sets            integer not null default 0,
  demos           integer not null default 0,
  sales           integer not null default 0,
  ko_count        integer not null default 0,   -- ⚠ TIE-OUT (which statuses count)

  -- dollar buckets
  good_business   numeric not null default 0,    -- ⚠ TIE-OUT (clean/good sold $)
  gross_sales     numeric not null default 0,
  net_sales       numeric not null default 0,
  pending_dollars numeric not null default 0,
  deposits        numeric not null default 0,

  -- actual-side rates (stored so the UI never recomputes inconsistently)
  demo_pct        numeric,                       -- demos/issued*100   (verified)
  close_pct       numeric,                       -- ⚠ TIE-OUT denominator (v1 sales/issued)
  good_rate_pct   numeric,                       -- ⚠ TIE-OUT (v1 good_business/gross_sales*100)
  ko_pct          numeric,                       -- ⚠ TIE-OUT (v1 ko_count/sales*100)
  nsli            numeric,                       -- net_sales/issued
  avg_sale        numeric,                       -- net_sales/sales

  computed_from   text not null default 'lp_api',
  reconciled      boolean not null default false,
  raw_inputs      jsonb,                         -- audit: counts/status tallies used
  created_at      timestamptz not null default now(),
  unique (market, as_of_date)
);

create index if not exists idx_goal_scorecard_market_asof
  on lp_market_scorecard_daily (market, as_of_date desc);
