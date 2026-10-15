-- 20261015180000_market_meeting_blocks.sql
--
-- WHAT: market_meeting_blocks, the times a market's reps are in a meeting and cannot run a visit.
-- WHY: Mark, 2026-10-15 (market capacity gate, rule R3). The bot may offer or book an in-home time only
--      when the lead's market has open LP capacity for that date and band
--      (src/knowledge/market-capacity-gate.js). A band that overlaps an active row here is closed for that
--      market (closed_reason `meeting`). A row is either weekly (day_of_week, 0 = Sunday .. 6 = Saturday) or one
--      day (specific_date), never both. Times are wall clock in `timezone`.
--      market_code is the CAPACITY code (SAR_MKT, FTLAU_MKT …), the same code lp_branch_market_map holds.
-- NOT: no seed rows (Mark supplies the schedule). It never touches the LP→GHL sync, a call-center booking or a
--      manual move: only the bot's own offers and bookings read it.
-- ROLLBACK: CAPACITY_GATE_ENABLED=false stops every read. The table is additive; leave it in place.

create table if not exists public.market_meeting_blocks (
  id            uuid        primary key default gen_random_uuid(),
  market_code   text        not null,
  day_of_week   int         null check (day_of_week between 0 and 6),
  specific_date date        null,
  start_local   time        not null,
  end_local     time        not null,
  timezone      text        not null default 'America/New_York',
  active        boolean     not null default true,
  note          text,
  created_at    timestamptz not null default now(),
  constraint market_meeting_blocks_one_kind
    check ((day_of_week is null) <> (specific_date is null)),
  constraint market_meeting_blocks_start_before_end
    check (start_local < end_local)
);

create index if not exists market_meeting_blocks_market_active_idx
  on public.market_meeting_blocks (market_code) where active;

alter table public.market_meeting_blocks enable row level security;

-- Example (not applied): Sarasota's weekly sales meeting, Mondays 9:00–11:00 AM ET, closes Monday mornings.
-- insert into public.market_meeting_blocks (market_code, day_of_week, start_local, end_local, note)
-- values ('SAR_MKT', 1, '09:00', '11:00', 'Weekly sales meeting');
