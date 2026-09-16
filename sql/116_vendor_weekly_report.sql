-- 116_vendor_weekly_report.sql
-- Automated Wednesday vendor performance review — storage.
--
-- STATUS: NOT APPLIED. Apply from the Supabase dashboard (LP instance).
-- Run as THREE SEPARATE executions, in this order:
--   1. Section 1 — tables (one transaction is fine)
--   2. Section 2 — seed rows
--   3. Section 3 — indexes (CREATE INDEX CONCURRENTLY cannot run inside a
--      transaction block; run each statement on its own)
--
-- Additive only. No existing table, view or function is touched.
-- Idempotent — safe to re-run.
--
-- ══ WHAT THIS STORES ══
-- vendor_config            the roster: one row per lead vendor on the weekly rhythm
-- vendor_weekly_runs       one row per (vendor, run): the fact pack every number came
--                          from, the narrative Claude produced, the validator report,
--                          rulebook version, model, and where both PDFs landed
-- vendor_weekly_decisions  the decisions ledger — rows carry forward across runs until
--                          closed, so "Needed today" never restarts from zero
-- vendor_actuals           vendor-supplied spend / delivered-lead count / tier mix,
--                          pasted in or parsed from email; the only path to a
--                          non-provisional cost per issued lead until report 136's
--                          MCost column is fed again (see sql/109 header)
--
-- ══ SOURCES THE RUN READS (already in this database — nothing new to ingest) ══
-- lp_leads                        same-age cohorts by lead_source_detail and lp_branch_id
-- lp_lead_disposition_history     report 135 Lead Disposition Detail 2, lead grain,
--                                 with num_dials / last_result / category / entry_date
-- lp_source_cost_history          report 136 Mktg Sub-Source Cost Analysis 2, per
--                                 sub_source; mcost_cents is 0 since 2026-08-10 (unfed)
-- lp_source_scorecard_daily       per (market, source, sub_source, as_of_date) actuals on
--                                 the appointment-date basis — conversion vs company
-- scorecard_report_snapshots      which 135/136 snapshot is current for month / mtd


-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 1 — tables
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vendor_config (
  vendor_id             text PRIMARY KEY,                 -- 'myhomepros'
  display_name          text NOT NULL,                    -- 'MyHomePros' — the ONLY name used on the vendor sheet
  lp_source_detail      text NOT NULL,                    -- lp_leads.lead_source_detail / 135+136 sub_source
  contact_name          text,                             -- 'Toni Landry'
  contact_email         text,                             -- Gmail draft recipient; NULL = no draft created
  email_domain          text,                             -- Gmail pull filter: from/to this domain, last 7 days
  notion_title_contains text,                             -- Meeting Master title filter, case-insensitive
  active                boolean NOT NULL DEFAULT true,
  meeting_weekday       int,                              -- 0=Sun … 3=Wed; informational only, the run is Wednesday regardless
  targets               jsonb NOT NULL DEFAULT '{}'::jsonb,
                        -- {"cost_per_issued_usd":500,"set_rate":0.10,"net_com":0.15}
  reports_safe_to_send  text[] NOT NULL DEFAULT '{}',     -- {'135','136'} — 137 is NEVER in this list
  canon                 jsonb NOT NULL DEFAULT '{}'::jsonb,
                        -- {"forbid":["Tony","Suited Connector"],"aliases":["MHP","My Home Pros"]}
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vendor_weekly_runs (
  run_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             text NOT NULL REFERENCES vendor_config(vendor_id),
  run_kind              text NOT NULL DEFAULT 'weekly',   -- 'weekly' | 'manual' | 'month_final'
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  baseline_start        date NOT NULL,
  baseline_end          date NOT NULL,
  comparison_rule       text NOT NULL,                    -- 'same_age_mtd' | 'trailing_14' (early-month rule)
  fact_pack             jsonb NOT NULL,                   -- every computed figure, each with {value, source, fetched_at}
  soft_sources          jsonb,                            -- Notion / Gmail / Omi payloads as text; never attachments
  narrative             jsonb,                            -- Claude's structured output (slots)
  validator_report      jsonb,                            -- {hard:[...], soft:[...], passed:bool}
  rulebook_version      text,                             -- git blob sha of src/reports/vendor-weekly/rulebook.md
  model                 text,                             -- pinned model string used for compose
  vendor_pdf_path       text,                             -- Supabase storage path
  internal_pdf_path     text,
  status                text NOT NULL DEFAULT 'started',  -- 'started' | 'facts_ready' | 'composed' | 'held' | 'delivered' | 'sent_to_vendor' | 'failed'
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
);

CREATE TABLE IF NOT EXISTS vendor_weekly_decisions (
  decision_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             text NOT NULL REFERENCES vendor_config(vendor_id),
  first_run_id          uuid REFERENCES vendor_weekly_runs(run_id),
  last_run_id           uuid REFERENCES vendor_weekly_runs(run_id),
  item                  text NOT NULL,                    -- short label, stable across runs (dedupe key with vendor_id)
  requirement           text NOT NULL,
  decision_owner        text NOT NULL,
  execution_owner       text NOT NULL,
  due_date              date,
  original_due_date     date,
  status                text NOT NULL DEFAULT 'open',     -- 'open' | 'done' | 'actioned' | 'late' | 'disputed' | 'worsened' | 'dropped'
  status_basis          text NOT NULL DEFAULT 'llm',      -- 'rule' (code-verified) | 'llm' (inferred; internal sheet flags it) | 'manual'
  evidence              text,                             -- citation: 'lp_leads JAX 0 leads Sep 10–15' / 'email 2026-09-09 Toni'
  notion_action_item_id text,
  owned_by_reece        boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, item)
);

CREATE TABLE IF NOT EXISTS vendor_actuals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id             text NOT NULL REFERENCES vendor_config(vendor_id),
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  spend_usd             numeric,
  delivered_leads       int,
  tier_mix              jsonb,                            -- {"70":179,"40":..,"20":..,"10":..} or by market
  source                text NOT NULL,                    -- 'email 2026-09-18 Toni' | 'invoice' | 'pasted by Mark'
  entered_by            text NOT NULL,
  entered_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor_id, period_start, period_end)
);


-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 2 — seed the roster (idempotent upserts)
-- ══════════════════════════════════════════════════════════════════════════

INSERT INTO vendor_config
  (vendor_id, display_name, lp_source_detail, contact_name, contact_email, email_domain,
   notion_title_contains, active, meeting_weekday, targets, reports_safe_to_send, canon)
VALUES
  ('myhomepros', 'MyHomePros', 'MyHomePros', 'Toni Landry', 'tlandry@suitedconnector.com',
   'suitedconnector.com', 'homepros', true, 3,
   '{"cost_per_issued_usd":500,"set_rate":0.10,"net_com":0.15}'::jsonb,
   '{135,136}',
   '{"forbid":["Tony","Suited Connector","Sweeted Connector"],"aliases":["MHP","My Home Pros","Home Pros"]}'::jsonb),
  ('modernize', 'Modernize', 'Modernize', NULL, NULL,
   'modernize.com', 'modernize', true, NULL,
   '{"cost_per_issued_usd":500,"set_rate":0.10,"net_com":0.15}'::jsonb,
   '{135,136}',
   '{"forbid":[],"aliases":["Modernize Weekly"]}'::jsonb)
ON CONFLICT (vendor_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  lp_source_detail = EXCLUDED.lp_source_detail,
  email_domain = EXCLUDED.email_domain,
  notion_title_contains = EXCLUDED.notion_title_contains,
  reports_safe_to_send = EXCLUDED.reports_safe_to_send,
  canon = EXCLUDED.canon,
  updated_at = now();
-- Modernize contact_name / contact_email are intentionally NULL — fill with one UPDATE
-- when known. Until then the run produces both PDFs but creates no Gmail draft.


-- ══════════════════════════════════════════════════════════════════════════
-- SECTION 3 — indexes. Each statement is its OWN execution.
-- ══════════════════════════════════════════════════════════════════════════

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vendor_weekly_runs_vendor_created
  ON vendor_weekly_runs (vendor_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vendor_weekly_decisions_vendor_status
  ON vendor_weekly_decisions (vendor_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lp_leads_source_detail_created
  ON lp_leads (lead_source_detail, created_at_lp);
