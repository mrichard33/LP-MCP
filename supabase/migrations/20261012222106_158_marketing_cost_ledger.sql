-- 20261012222106_158_marketing_cost_ledger — Marketing cost ledger
-- (invoices → allocation → cost per issued lead).
--
-- Written as sql/158 and applied to the live project through the Supabase MCP on
-- 2026-10-12 (recorded as version 20261012222106, name 158_marketing_cost_ledger),
-- the same day the migrations ledger (sql/README.md) froze sql/NNN at 157. The
-- file keeps that version so `supabase db push` records nothing new and the
-- ledger compare in CI agrees with the database. Every statement is idempotent
-- (IF NOT EXISTS / OR REPLACE / ON CONFLICT DO NOTHING), so a replay is a no-op.
--
-- ROLLBACK: DROP VIEW v_market_subsource_cost; DROP FUNCTION mkt_sales_dollars(date),
-- mkt_sales_snapshot(date), mkt_lead_counts(date, date), mkt_issued_counts(date, date);
-- DROP TABLE marketing_expense_allocations, marketing_expenses, marketing_invoice_documents,
-- marketing_cost_rules, marketing_territory_map, marketing_vendors; (export the ledger
-- first: it is the only record of approved marketing spend). Destructive rollback only;
-- this migration itself drops nothing.
--
-- 2026-10-12 (handoff "Marketing Cost Ledger, Invoice Automation & Brad-Format
-- Reporting v2", Mark + Brad Codman). Until now marketing cost was typed into
-- Lead Perfection by hand and read back through report 136, which is
-- company-wide only and has printed $0 since 2026-08-10. Brad rebuilt the cost
-- per issued lead sheet by hand every month.
--
-- This file is the ledger that replaces both. Nothing here reads report 136.
--
--   marketing_vendors              who bills us, how their name prints on an invoice,
--                                  which lp_leads.lead_source_detail values and which
--                                  markets they may be charged to ('{}' = unknown,
--                                  which BLOCKS approval until Mark or Brad fills it)
--   marketing_invoice_documents    the "transcript" of every invoice: the file's hash,
--                                  where the original sits, the extracted text, the
--                                  analysis (rules + AI), status
--   marketing_expenses             one row per invoice line / feed day / commission
--                                  rule, with the sub-sources and eligible markets it
--                                  belongs to; status pending_review → approved
--   marketing_expense_allocations  the approved money split per calendar month and
--                                  market (direct / proportional by gross issued
--                                  leads / equal / hold). The sum per expense MUST
--                                  equal the expense (src/marketing/allocation.js
--                                  asserts it; sql/verify re-checks it)
--   marketing_cost_rules           D2: commission-style costs as a % of net sales
--   marketing_territory_map        Lead Gurus territory → market; Unknown and
--                                  Out Of Area → REECE_HOLD (D4, never auto-spread)
--
-- Locked decisions (handoff §1): D1 gross issued = lp_leads.ever_issued by
-- created_at_lp, not deleted, market = branch map else lead market assignment.
-- D8 Net / Working / Gross $ come from report 133 (lp_job_status_history).
-- Market codes are the `<X>_MKT` form lp_branch_market_map and
-- lp_job_status_history already use. North Carolina needs no migration later:
-- a market is just a text code here (D5).
--
-- Allocation math is in JS (one implementation, offline-testable) — see
-- src/marketing/allocation.js. This file holds the FACTS the allocator and
-- the report read: mkt_issued_counts (D1) and mkt_sales_dollars (D8), and the
-- view the dashboard and the XLSX read, v_market_subsource_cost.
--
-- ADDITIVE ONLY and idempotent. Apply from the Supabase dashboard (LP
-- instance). The boot mirror (src/admin/startup-mirrors.js, block 'sql/158')
-- creates the tables/view too; functions run every boot.

-- ─── Tables ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS marketing_vendors (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_name       text NOT NULL UNIQUE,
  aliases           text[] DEFAULT '{}',                 -- names as printed on invoices
  sender_domains    text[] DEFAULT '{}',                 -- e.g. {'leadgurus.com'}
  lp_sub_sources    text[] NOT NULL,                     -- exact lp_leads.lead_source_detail values
  eligible_markets  text[] NOT NULL,                     -- market codes; '{}' = unknown → blocks approval
  default_cost_type text NOT NULL DEFAULT 'invoice'
    CHECK (default_cost_type IN ('invoice', 'feed', 'calculated')),
  is_active         boolean DEFAULT true,
  notes             text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_invoice_documents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256            text NOT NULL UNIQUE,
  gmail_message_id  text,
  from_address      text,
  subject           text,
  received_at       timestamptz,
  file_name         text,
  mime_type         text,
  storage_bucket    text DEFAULT 'marketing-invoices',
  storage_path      text,
  extracted_text    text,                                -- from reece-speech-api /v1/extract (or CSV/XLSX/body text)
  extraction_meta   jsonb,                               -- pages, method per page, ocr_pages, engine
  analysis          jsonb,                               -- rules + AI output, validated
  analyzer          text,                                -- 'rules' | 'rules+llm'
  status            text NOT NULL DEFAULT 'extracted'
    CHECK (status IN ('extracted', 'analyzed', 'in_review', 'posted', 'rejected', 'failed')),
  error             text,
  slack_channel     text,
  slack_ts          text,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS marketing_expenses (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid REFERENCES marketing_invoice_documents(id),
  vendor_id         uuid REFERENCES marketing_vendors(id),
  cost_type         text NOT NULL CHECK (cost_type IN ('invoice', 'feed', 'calculated')),
  invoice_number    text,
  line_no           int DEFAULT 1,
  description       text,
  amount            numeric(12,2) NOT NULL,
  period_start      date NOT NULL,
  period_end        date NOT NULL,
  lp_sub_sources    text[] NOT NULL,
  eligible_markets  text[] NOT NULL,
  status            text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected', 'superseded')),
  provisional       boolean DEFAULT false,
  source_system     text NOT NULL,                       -- email_invoice | leadgurus_feed | manual_csv | commission_rule
  source_ref        text,
  flags             text[] DEFAULT '{}',
  match_confidence  numeric(4,3),                        -- 0..1 from analysis
  approved_by       text,
  approved_at       timestamptz,
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now(),
  UNIQUE (vendor_id, invoice_number, line_no, cost_type, period_start)
);
-- Feed days and commission rows carry no invoice number; their identity is the
-- source_ref ('<date>|<territory>', '<rule id>|<market>|<month>'). One row each.
CREATE UNIQUE INDEX IF NOT EXISTS marketing_expenses_source_ref_uidx
  ON marketing_expenses (source_system, source_ref) WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS marketing_expenses_period_idx
  ON marketing_expenses (period_start, period_end);

CREATE TABLE IF NOT EXISTS marketing_expense_allocations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id            uuid NOT NULL REFERENCES marketing_expenses(id) ON DELETE CASCADE,
  month                 date NOT NULL,                   -- first day of the calendar month slice
  market                text NOT NULL,
  lp_sub_source         text,
  rule                  text NOT NULL CHECK (rule IN ('direct', 'proportional', 'equal', 'hold')),
  issued_basis          int,
  issued_total          int,
  amount                numeric(12,2) NOT NULL,
  recommended_market    text,
  recommendation_reason text,
  computed_at           timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mea_month_market ON marketing_expense_allocations (month, market);
CREATE INDEX IF NOT EXISTS mea_expense_idx ON marketing_expense_allocations (expense_id);

CREATE TABLE IF NOT EXISTS marketing_cost_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lp_sub_sources   text[] NOT NULL,
  rate             numeric(6,4) NOT NULL,
  basis            text NOT NULL DEFAULT 'net_sales',
  label            text NOT NULL,
  effective_from   date NOT NULL,
  effective_to     date
);

CREATE TABLE IF NOT EXISTS marketing_territory_map (
  territory  text PRIMARY KEY,
  market     text NOT NULL
);

-- ─── Seeds (never overwrite a row a person has edited) ──────────────────────

INSERT INTO marketing_territory_map (territory, market) VALUES
  ('STPET', 'STPET_MKT'),
  ('ORL', 'ORL_MKT'), ('LAKE', 'ORL_MKT'),
  ('FTMYR', 'FTMYR_MKT'),
  ('BOCA', 'FTLAU_MKT'), ('MIAMI', 'FTLAU_MKT'), ('FTLAU', 'FTLAU_MKT'), ('RFED', 'FTLAU_MKT'),
  ('Jacksonville', 'JAX_MKT'), ('JAX', 'JAX_MKT'),
  ('SAR', 'SAR_MKT'),
  ('Unknown', 'REECE_HOLD'), ('Out Of Area', 'REECE_HOLD')
ON CONFLICT (territory) DO NOTHING;

-- D2: commission-style costs, shown separately as cost_type='calculated'.
INSERT INTO marketing_cost_rules (id, lp_sub_sources, rate, basis, label, effective_from)
SELECT v.id::uuid, v.subs, v.rate, 'net_sales', v.label, DATE '2026-01-01'
FROM (VALUES
  ('a1a1a1a1-0001-4000-8000-000000000001', ARRAY['Canvass', 'Canvass Sticky'], 0.1500, 'Canvass 15% of net'),
  ('a1a1a1a1-0001-4000-8000-000000000002', ARRAY['MVP Marketing'],             0.1500, 'MVP Marketing 15% of net'),
  ('a1a1a1a1-0001-4000-8000-000000000003', ARRAY['Previous Customer', 'Customer Referral'], 0.0100, 'Previous Customer / Referral 1% of net')
) AS v(id, subs, rate, label)
WHERE NOT EXISTS (SELECT 1 FROM marketing_cost_rules r WHERE r.id = v.id::uuid);

-- Vendors from Brad's September Fort Myers sheet. eligible_markets='{}' means
-- "unknown": the first invoice goes to Slack review and the approver fills it
-- in. Lead Gurus is the one feed vendor and bills every market.
INSERT INTO marketing_vendors (vendor_name, aliases, sender_domains, lp_sub_sources, eligible_markets, default_cost_type, notes) VALUES
  ('Lead Gurus', ARRAY['Lead Gurus', 'LeadGurus', 'Lead Gurus LLC'], ARRAY['leadgurus.com'], ARRAY['Lead Gurus'],
     ARRAY['STPET_MKT','ORL_MKT','FTMYR_MKT','FTLAU_MKT','JAX_MKT','SAR_MKT'], 'feed',
     'Paid media agency. The daily feed is provisional; the monthly invoice is the source of truth (D3).'),
  ('MyHomePros', ARRAY['MyHomePros', 'My Home Pros'], '{}', ARRAY['MyHomePros'], '{}', 'invoice', NULL),
  ('Modernize', ARRAY['Modernize', 'Modernize Home Services'], ARRAY['modernize.com'], ARRAY['Modernize'], '{}', 'invoice', NULL),
  ('HomeBuddy', ARRAY['HomeBuddy', 'Home Buddy'], ARRAY['homebuddy.com'], ARRAY['HomeBuddy'], '{}', 'invoice', NULL),
  ('Bing PPC', ARRAY['Microsoft Advertising', 'Bing Ads'], ARRAY['microsoft.com'], ARRAY['Bing PPC'], '{}', 'invoice', NULL),
  ('Google PPC', ARRAY['Google Ads', 'Google LLC'], ARRAY['google.com'], ARRAY['Google PPC Windows', 'Google PPC Roofs'], '{}', 'invoice', NULL),
  ('Socius Marketing', ARRAY['Socius Marketing', 'Socius'], ARRAY['sociusmarketing.com'], ARRAY['Socius Marketing'], '{}', 'invoice', NULL),
  ('Prolific Marketing', ARRAY['Prolific Marketing', 'Prolific'], '{}', ARRAY['Prolific Marketing'], '{}', 'invoice', NULL),
  ('Taste of Latino', ARRAY['Taste of Latino'], '{}', ARRAY['Taste of Latino'], '{}', 'invoice', NULL),
  ('Swish Leads', ARRAY['Swish Leads', 'Swish'], '{}', ARRAY['Swish Leads'], '{}', 'invoice', NULL),
  ('Canvass (commission)', '{}', '{}', ARRAY['Canvass', 'Canvass Sticky'],
     ARRAY['STPET_MKT','ORL_MKT','FTMYR_MKT','FTLAU_MKT','JAX_MKT','SAR_MKT'], 'calculated', 'D2: 15% of net, computed monthly.'),
  ('MVP Marketing (commission)', '{}', '{}', ARRAY['MVP Marketing'],
     ARRAY['STPET_MKT','ORL_MKT','FTMYR_MKT','FTLAU_MKT','JAX_MKT','SAR_MKT'], 'calculated', 'D2: 15% of net, computed monthly.'),
  ('Previous Customer / Referral (commission)', '{}', '{}', ARRAY['Previous Customer', 'Customer Referral'],
     ARRAY['STPET_MKT','ORL_MKT','FTMYR_MKT','FTLAU_MKT','JAX_MKT','SAR_MKT'], 'calculated', 'D2: 1% of net, computed monthly.')
ON CONFLICT (vendor_name) DO NOTHING;

-- ─── D1: gross issued leads by market × sub-source, by LEAD-CREATED date ────
-- Market = lp_branch_market_map on the lead's branch, else the resolver's
-- lp_lead_market_assignments. p_to is INCLUSIVE (a calendar range).

CREATE OR REPLACE FUNCTION mkt_issued_counts(p_from date, p_to date)
RETURNS TABLE (market text, lp_sub_source text, issued int)
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(m.market_code, a.resolved_market_code) AS market,
         l.lead_source_detail AS lp_sub_source,
         COUNT(*)::int AS issued
  FROM lp_leads l
  LEFT JOIN lp_branch_market_map m ON m.brn_id = l.lp_branch_id
  LEFT JOIN lp_lead_market_assignments a ON a.lead_id = l.lp_lead_id
  WHERE l.ever_issued
    AND l.lp_deleted_at IS NULL
    AND l.created_at_lp >= p_from
    AND l.created_at_lp < p_to + 1
  GROUP BY 1, 2
$$;

-- All five funnel counts the report needs, same grain and same market rule.
CREATE OR REPLACE FUNCTION mkt_lead_counts(p_from date, p_to date)
RETURNS TABLE (market text, lp_sub_source text, raw int, set_count int, issued int, sat int, sold int)
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(m.market_code, a.resolved_market_code) AS market,
         l.lead_source_detail AS lp_sub_source,
         COUNT(*)::int,
         COUNT(*) FILTER (WHERE l.ever_set)::int,
         COUNT(*) FILTER (WHERE l.ever_issued)::int,
         COUNT(*) FILTER (WHERE l.ever_sat)::int,
         COUNT(*) FILTER (WHERE l.closed_won)::int
  FROM lp_leads l
  LEFT JOIN lp_branch_market_map m ON m.brn_id = l.lp_branch_id
  LEFT JOIN lp_lead_market_assignments a ON a.lead_id = l.lp_lead_id
  WHERE l.lp_deleted_at IS NULL
    AND l.created_at_lp >= p_from
    AND l.created_at_lp < p_to + 1
  GROUP BY 1, 2
$$;

-- ─── D8: Net / Working / Gross $ by market × sub-source from report 133 ─────
-- A closed month reads its `month` snapshot; the current month reads the
-- newest MTD snapshot. Same rule the scorecard uses: one current snapshot per
-- (report_type, scope, period_start), `month` outranks `mtd` for the same
-- period_start. Bucket → Brad column: Net = in_production + completed,
-- Working = other_pending + hoa, Gross = everything incl. lost.

CREATE OR REPLACE FUNCTION mkt_sales_snapshot(p_month date)
RETURNS TABLE (snapshot_id uuid, as_of_date date, scope text)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.as_of_date, s.scope
  FROM scorecard_report_snapshots s
  WHERE s.report_type = 'job_status_ytd'
    AND s.is_current
    AND s.period_start = date_trunc('month', p_month)::date
  ORDER BY (s.scope = 'month') DESC, s.as_of_date DESC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION mkt_sales_dollars(p_month date)
RETURNS TABLE (market text, lp_sub_source text, gross numeric, working numeric, net numeric, lost numeric)
LANGUAGE sql STABLE AS $$
  SELECT h.market, h.sub_source,
         SUM(h.gross_cents) / 100.0,
         SUM(h.gross_cents) FILTER (WHERE h.bucket IN ('other_pending', 'hoa')) / 100.0,
         SUM(h.gross_cents) FILTER (WHERE h.bucket IN ('in_production', 'completed')) / 100.0,
         SUM(h.gross_cents) FILTER (WHERE h.bucket = 'lost') / 100.0
  FROM lp_job_status_history h
  JOIN mkt_sales_snapshot(p_month) snap ON h.snapshot_id = snap.snapshot_id
  GROUP BY 1, 2
$$;

-- ─── The reporting view: month and ISO-week × market × lp_sub_source ────────
--
-- Costs come from marketing_expense_allocations of APPROVED expenses (feed
-- rows are approved + provisional). The month grain sums allocations as
-- written (exact cents). The week grain spreads each allocation evenly over
-- the days of its month slice and sums by ISO week, which is how a monthly
-- invoice lands on weeks and how a daily feed row lands on its own day.
-- Net / Working / Gross $ exist only at month grain (133 is a monthly report).
-- REECE_HOLD rows carry the recommendation; they are never in a market total.
-- Bounded to 2026-01-01 forward: nothing in the ledger predates it.

CREATE OR REPLACE VIEW v_market_subsource_cost AS
WITH alloc AS (
  SELECT a.id, a.expense_id, a.month, a.market, COALESCE(a.lp_sub_source, '(none)') AS lp_sub_source,
         a.amount, a.rule, a.recommended_market, a.recommendation_reason,
         e.cost_type, COALESCE(e.provisional, false) AS provisional,
         GREATEST(e.period_start, a.month) AS slice_start,
         LEAST(e.period_end, (a.month + INTERVAL '1 month' - INTERVAL '1 day')::date) AS slice_end
  FROM marketing_expense_allocations a
  JOIN marketing_expenses e ON e.id = a.expense_id
  WHERE e.status = 'approved'
),
cost_month AS (
  SELECT 'month'::text AS grain, month AS period_start, market, lp_sub_source,
         SUM(amount) FILTER (WHERE cost_type IN ('invoice', 'feed')) AS invoice_cost,
         SUM(amount) FILTER (WHERE cost_type = 'calculated') AS calculated_cost,
         BOOL_OR(provisional) AS has_provisional,
         STRING_AGG(DISTINCT recommended_market, ',') FILTER (WHERE rule = 'hold') AS recommended_market,
         STRING_AGG(DISTINCT recommendation_reason, ' | ') FILTER (WHERE rule = 'hold') AS recommendation_reason
  FROM alloc
  GROUP BY 1, 2, 3, 4
),
alloc_days AS (
  SELECT al.market, al.lp_sub_source, al.cost_type, al.provisional, al.rule,
         al.recommended_market, al.recommendation_reason,
         d::date AS day,
         al.amount / GREATEST(1, (al.slice_end - al.slice_start + 1)) AS amount
  FROM alloc al
  CROSS JOIN LATERAL generate_series(al.slice_start, GREATEST(al.slice_end, al.slice_start), INTERVAL '1 day') AS d
),
cost_week AS (
  SELECT 'iso_week'::text AS grain, date_trunc('week', day)::date AS period_start, market, lp_sub_source,
         ROUND(SUM(amount) FILTER (WHERE cost_type IN ('invoice', 'feed')), 2) AS invoice_cost,
         ROUND(SUM(amount) FILTER (WHERE cost_type = 'calculated'), 2) AS calculated_cost,
         BOOL_OR(provisional) AS has_provisional,
         STRING_AGG(DISTINCT recommended_market, ',') FILTER (WHERE rule = 'hold') AS recommended_market,
         STRING_AGG(DISTINCT recommendation_reason, ' | ') FILTER (WHERE rule = 'hold') AS recommendation_reason
  FROM alloc_days
  GROUP BY 1, 2, 3, 4
),
costs AS (
  SELECT * FROM cost_month UNION ALL SELECT * FROM cost_week
),
leads_base AS (
  SELECT COALESCE(m.market_code, a.resolved_market_code, 'UNASSIGNED') AS market,
         COALESCE(l.lead_source_detail, '(none)') AS lp_sub_source,
         l.created_at_lp, l.ever_set, l.ever_issued, l.ever_sat, l.closed_won
  FROM lp_leads l
  LEFT JOIN lp_branch_market_map m ON m.brn_id = l.lp_branch_id
  LEFT JOIN lp_lead_market_assignments a ON a.lead_id = l.lp_lead_id
  WHERE l.lp_deleted_at IS NULL AND l.created_at_lp >= DATE '2026-01-01'
),
leads AS (
  SELECT g.grain,
         CASE g.grain WHEN 'month' THEN date_trunc('month', lb.created_at_lp)::date
                      ELSE date_trunc('week', lb.created_at_lp)::date END AS period_start,
         lb.market, lb.lp_sub_source,
         COUNT(*)::int AS raw,
         COUNT(*) FILTER (WHERE lb.ever_set)::int AS set_count,
         COUNT(*) FILTER (WHERE lb.ever_issued)::int AS issued,
         COUNT(*) FILTER (WHERE lb.ever_sat)::int AS sat,
         COUNT(*) FILTER (WHERE lb.closed_won)::int AS sold
  FROM leads_base lb
  CROSS JOIN (VALUES ('month'), ('iso_week')) AS g(grain)
  GROUP BY 1, 2, 3, 4
),
months AS (
  SELECT DISTINCT period_start AS month FROM leads WHERE grain = 'month'
  UNION SELECT DISTINCT month FROM alloc
),
dollars AS (
  SELECT mo.month, d.market, COALESCE(d.lp_sub_source, '(none)') AS lp_sub_source,
         d.gross, d.working, d.net, d.lost, snap.as_of_date
  FROM months mo
  CROSS JOIN LATERAL mkt_sales_snapshot(mo.month) snap
  CROSS JOIN LATERAL mkt_sales_dollars(mo.month) d
),
keys AS (
  SELECT grain, period_start, market, lp_sub_source FROM leads
  UNION SELECT grain, period_start, market, lp_sub_source FROM costs
  UNION SELECT 'month', month, market, lp_sub_source FROM dollars
)
SELECT k.grain, k.period_start, k.market, k.lp_sub_source,
       COALESCE(l.raw, 0) AS raw,
       COALESCE(l.set_count, 0) AS set_count,
       COALESCE(l.issued, 0) AS issued,
       COALESCE(l.sat, 0) AS sat,
       COALESCE(l.sold, 0) AS sold,
       d.gross, d.working, d.net, d.lost,
       COALESCE(c.invoice_cost, 0) AS invoice_cost,
       COALESCE(c.calculated_cost, 0) AS calculated_cost,
       COALESCE(c.invoice_cost, 0) + COALESCE(c.calculated_cost, 0) AS total_cost,
       CASE WHEN COALESCE(l.issued, 0) > 0
            THEN ROUND((COALESCE(c.invoice_cost, 0) + COALESCE(c.calculated_cost, 0)) / l.issued, 2) END AS cost_per_issued,
       CASE WHEN COALESCE(l.issued, 0) > 0 AND d.net IS NOT NULL THEN ROUND(d.net / l.issued, 2) END AS nsli,
       CASE WHEN d.net > 0
            THEN ROUND((COALESCE(c.invoice_cost, 0) + COALESCE(c.calculated_cost, 0)) / d.net, 4) END AS mkt_pct,
       COALESCE(c.has_provisional, false) AS has_provisional,
       d.as_of_date AS as_of_snapshot,
       c.recommended_market, c.recommendation_reason
FROM keys k
LEFT JOIN leads l ON l.grain = k.grain AND l.period_start = k.period_start AND l.market = k.market AND l.lp_sub_source = k.lp_sub_source
LEFT JOIN costs c ON c.grain = k.grain AND c.period_start = k.period_start AND c.market = k.market AND c.lp_sub_source = k.lp_sub_source
LEFT JOIN dollars d ON k.grain = 'month' AND d.month = k.period_start AND d.market = k.market AND d.lp_sub_source = k.lp_sub_source;

-- ─── Row-level security ───────────────────────────────────────────────────────
-- The live project enables RLS on every new public table (feature_modes and
-- lead_conversation_stage carry the same lines), and the first CI drift check
-- (2026-10-12) read its absence here as six statements of drift. No policies:
-- LP-MCP and the dashboard read and write these tables with the service role,
-- which bypasses RLS; anon and authenticated keys see nothing.
ALTER TABLE public.marketing_vendors            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_invoice_documents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_expenses           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_expense_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_cost_rules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_territory_map      ENABLE ROW LEVEL SECURITY;
