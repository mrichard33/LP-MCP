-- ─────────────────────────────────────────────────────────────────────────────
-- 027 — Lead Gurus Ingestion (I.LG) support objects
-- ─────────────────────────────────────────────────────────────────────────────
-- Pairs with:
--   • src/leadgurus-ingest.js — the LP-MCP worker behind POST /n8n/leadgurus/*
--   • n8n workflow "I.LG — Lead Gurus Daily Pull" (thin daily cron → the endpoint)
--   • docs/leadgurus_integration_runbook.md — deploy/runbook + Mark's steps
--
-- Run in: LP MCP Supabase → SQL Editor (same database as the rest of the agentic
-- schema). Lead Gurus is the paid-media agency platform (clients.leadgurus.com,
-- client id 91); these `ft_*` tables are the ingest landing zone for its daily
-- summary (spend/revenue attribution) and per-lead feed.
--
-- Additive + idempotent — no drops, safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. ft_daily_summary — one row per day (GET /api/v1/summary/client/) ───────
CREATE TABLE IF NOT EXISTS public.ft_daily_summary (
  date                date PRIMARY KEY,           -- summary day (client tz)
  total_leads         integer,
  total_spend         numeric(14,2),              -- ad spend for the day
  cost_per_lead       numeric(14,2),
  accepted_count      integer,
  success_count       integer,                    -- success_post = true count
  self_book_count     integer,
  cost_per_self_book  numeric(14,2),
  booked              integer,
  scheduled           integer,
  demos               integer,
  issues              integer,
  gross_sales         integer,                    -- # of gross-sale deals
  gross_amount        numeric(14,2),              -- $ gross revenue
  net_sales           integer,                    -- # of net-sale deals
  net_amount          numeric(14,2),              -- $ net revenue
  pulled_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ft_daily_summary_date
  ON public.ft_daily_summary (date);


-- ── 2. ft_summary_territory — per day × territory (GET /summary/territory/) ───
CREATE TABLE IF NOT EXISTS public.ft_summary_territory (
  date                date NOT NULL,
  territory           text NOT NULL,
  total_leads         integer,
  total_spend         numeric(14,2),
  cost_per_lead       numeric(14,2),
  accepted_count      integer,
  success_count       integer,
  self_book_count     integer,
  cost_per_self_book  numeric(14,2),
  booked              integer,
  scheduled           integer,
  demos               integer,
  issues              integer,
  gross_sales         integer,
  gross_amount        numeric(14,2),
  net_sales           integer,
  net_amount          numeric(14,2),
  pulled_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, territory)
);


-- ── 3. ft_summary_channel — per day × channel (GET /summary/channel/) ─────────
CREATE TABLE IF NOT EXISTS public.ft_summary_channel (
  date                date NOT NULL,
  channel             text NOT NULL,
  total_leads         integer,
  total_spend         numeric(14,2),
  cost_per_lead       numeric(14,2),
  accepted_count      integer,
  success_count       integer,
  self_book_count     integer,
  cost_per_self_book  numeric(14,2),
  booked              integer,
  scheduled           integer,
  demos               integer,
  issues              integer,
  gross_sales         integer,
  gross_amount        numeric(14,2),
  net_sales           integer,
  net_amount          numeric(14,2),
  pulled_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, channel)
);


-- ── 4. ft_leads — per-lead feed (GET /api/v1/leads/?client=91) ────────────────
-- `raw` keeps the full Lead Gurus payload so new fields can be backfilled from
-- history without re-pulling. lead_id is the Lead Gurus lead id (kept as text).
CREATE TABLE IF NOT EXISTS public.ft_leads (
  lead_id                        text PRIMARY KEY,
  full_name                      text,
  email                          text,
  phone                          text,
  address                        text,
  city                           text,
  state                          text,
  zip_code                       text,
  territory                      text,
  vertical                       text,
  campaign_id                    text,
  ad_set_id                      text,
  ad_id                          text,
  source                         text,
  medium                         text,
  credit_score                   text,            -- often a banded string
  project_type                   text,
  windows_count                  integer,
  success_post                   boolean,
  self_book_appointment_datetime timestamptz,
  created_at                     timestamptz,     -- lead's date_created on LG
  pulled_at                      timestamptz NOT NULL DEFAULT now(),
  raw                            jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_ft_leads_email ON public.ft_leads (email);
CREATE INDEX IF NOT EXISTS idx_ft_leads_phone ON public.ft_leads (phone);


-- ─────────────────────────────────────────────────────────────────────────────
-- Verify (after a daily-pull / backfill run):
--   select count(*) from public.ft_daily_summary;
--   select count(*) from public.ft_summary_territory;
--   select count(*) from public.ft_summary_channel;
--   select count(*) from public.ft_leads;
-- ─────────────────────────────────────────────────────────────────────────────
