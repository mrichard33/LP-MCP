-- ─── 092 — Memory taxonomy: 12 categories, area slugs, workflow reference ────
--
-- Priority #6 of the Reece Memory System Optimization plan (sql/090 = #2,
-- sql/091 = #4/#5). Applied to Reece Lead Perfection Sync
-- (rcjcgjlqzepicbwhnnjl) on 2026-09-06 through the LP MCP supabase_run_query
-- tool, batch by batch after Mark's approval. Every statement here is
-- idempotent; the one-time data backfills that ran alongside (category
-- normalisation, area assignment, workflow_id backfill) are described but
-- NOT repeated here — see claude_session_logs #697. Do NOT re-apply as a way
-- of re-running the backfill.
--
-- Before this migration: 92 distinct decision categories and 95 issue
-- categories (data / data-quality / data integrity / data-plane …), 581
-- distinct free-text phase_focus values on sessions, and 1,513 of 1,668
-- decisions with no workflow_id. None of it usable as a filter.
--
-- ─── A. category → 12 values, original preserved ────────────────────────────
--
--   category_raw   the value as originally written. category is rewritten in
--                  place to one of: architecture · routing · messaging ·
--                  appointments · sync · integration · data · agentic ·
--                  infrastructure · reporting · compliance · operations.
--                  (integration = LP sync / n8n / Five9 / external systems,
--                  the old skill's own definition; telephony folded in.
--                  timing → routing; publication → operations.)
--
-- Backfill (one-time, 2026-09-06): category_raw = category, then a 12-way
-- regex CASE over category_raw. Result — decisions: architecture 524,
-- integration 317, infrastructure 287, messaging 229, operations 120, data 81,
-- routing 64, appointments 19, reporting 12, agentic 10, sync 9, compliance 9.
-- Issues: data 379, routing 335, architecture 262, infrastructure 221,
-- messaging 214, integration 87, operations 45, agentic 26, sync 19,
-- appointments 14, compliance 12, reporting 11.

ALTER TABLE claude_decision_log ADD COLUMN IF NOT EXISTS category_raw text;
ALTER TABLE claude_known_issues ADD COLUMN IF NOT EXISTS category_raw text;

-- ─── B. area — one slug per row, same rules everywhere ───────────────────────
--
-- 19 values chosen to line up with Mark's memory-file areas and the registry
-- stage families:
--   memory-system · call-intelligence · payroll-callcenter · partners-vendors ·
--   five9-dialer · scorecard-reporting · calculator-lane · chatbot-lane ·
--   canvassing · objections-rescue · nurture-reengagement · appointments ·
--   agentic-engine · lp-ghl-sync · lead-intake · content-copy · infrastructure ·
--   routing-workflows · general
--
-- claude_area_for(text) holds the keyword rules (first match wins, ordered
-- most-specific first). It is IMMUTABLE so it can be used in indexes and
-- generated columns later. Change the rules here, not in the skill.
--
-- Backfill (one-time): sessions from phase_focus || session_title; decisions,
-- issues and pending items from their own text, falling back to the parent
-- session's area when their own text classifies as 'general'. phase_focus is
-- NOT dropped — it stays as the free-text label; area is the filter.

CREATE OR REPLACE FUNCTION claude_area_for(t text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN t IS NULL OR btrim(t) = '' THEN 'general'
    WHEN t ~* '(memory system|session continuity|claude_session|transcript ledger|memory audit|claude_pending|memory tier)' THEN 'memory-system'
    WHEN t ~* '(call intelligence|transcription|whispersync|\mci_|call recording)' THEN 'call-intelligence'
    WHEN t ~* '(payroll|comp plan|compensation|setter hiring|bonus|work agreement|hiring|interview|recruit)' THEN 'payroll-callcenter'
    WHEN t ~* '(modernize|my home pros|lightfire|contractor connect|lead gurus|affiliate|\mross\M|dealer|suncoast|vendor|partner)' THEN 'partners-vendors'
    WHEN t ~* '(five9|dialer|dnis|campaign|dial list|outbound iq|callback request|rehash|previous customer)' THEN 'five9-dialer'
    WHEN t ~* '(scorecard|report|dashboard|revenue|kpi|rep performance|sit rate|attribution|capacity|efficiency)' THEN 'scorecard-reporting'
    WHEN t ~* '(calculator|estimate calc|\mE\.2\M|\mS2\.1\M|\mS3\.1\M|\mI\.WC\M)' THEN 'calculator-lane'
    WHEN t ~* '(chatbot|live chat|\mE\.3\M|\mS2\.2\M|\mS3\.3\M|\mB\.[0-9A-Z]|responder|\mbot\M)' THEN 'chatbot-lane'
    WHEN t ~* '(canvass|\mE\.4\M|\mI\.CC\M|door knock|event lead)' THEN 'canvassing'
    WHEN t ~* '(objection|rescue|\mS5\.|\mO\.0|\mO\.V)' THEN 'objections-rescue'
    WHEN t ~* '(nurture|re-engage|reengage|seinfeld|cooling|\mS4\.5|\mS1\.|\mL\.[0-9]|stale lead|revival|day 15|dormant)' THEN 'nurture-reengagement'
    WHEN t ~* '(appointment|confirmation|booking|reschedule|no-show|\mA\.CC|\mA\.MV|\mA\.WE|\mS4\.1|calendar)' THEN 'appointments'
    WHEN t ~* '(agent_rules|agent rules|decision engine|layer 3|layer3|suppression|intent|agentic|executor|action queue)' THEN 'agentic-engine'
    WHEN t ~* '(lp.ghl|ghl.lp|sync|lp_leads|ghl_contact_id|milestone|opportunit|identity|parity|reconcil)' THEN 'lp-ghl-sync'
    WHEN t ~* '(intake|source mapping|universal lead|data status|orphan|webhook|leadconduit|trustedform|entry:|inbound)' THEN 'lead-intake'
    WHEN t ~* '(email|copy|vsl|story|brand|randy|template|content|indoctrination|html|landing page|video)' THEN 'content-copy'
    WHEN t ~* '(railway|supabase|\mmcp\M|n8n|repo|deploy|github|infrastructure|migration|skill|notion|prestige|permissions|documentation)' THEN 'infrastructure'
    WHEN t ~* '(routing|router|\mE\.0\M|workflow|pipeline|stage|\mtag)' THEN 'routing-workflows'
    ELSE 'general' END
$$;

ALTER TABLE claude_session_logs   ADD COLUMN IF NOT EXISTS area text;
ALTER TABLE claude_decision_log   ADD COLUMN IF NOT EXISTS area text;
ALTER TABLE claude_known_issues   ADD COLUMN IF NOT EXISTS area text;
ALTER TABLE claude_pending_items  ADD COLUMN IF NOT EXISTS area text;

-- ─── C. Workflow reference + workflow_code ───────────────────────────────────
--
-- The canonical source of workflow identity is workflow_registry in the HL
-- Supabase. The memory tables live in the LP Supabase and cannot join across
-- instances, so claude_workflow_ref is a 219-row cache of (canonical_code,
-- workflow_id, canonical_name, stage_family, status), keyed by code, with
-- synced_at. Refresh with an INSERT … ON CONFLICT (canonical_code) DO UPDATE
-- from the registry whenever codes are added; the nightly job (priority #8)
-- should own that refresh. It is a cache — the registry always wins.
--
--   workflow_code  the canonical code (S4.5, E.2, A.WE-1) on decisions and
--                  issues, next to the existing workflow_id / workflow_name.
--                  Filter and group on this, not on the free-text name.
--
-- Backfill (one-time, 2026-09-06), rows with workflow_id NULL only, legacy
-- workflows excluded: (1) earliest canonical code found in the text,
-- (2) an 8-char UUID prefix found in the text, (3) workflow_name matched to a
-- registry name. Existing non-null workflow_id / workflow_name never
-- overwritten. Result: decisions with a workflow 155 → 281 (225 with a code);
-- issues 310 (220 with a code).

CREATE TABLE IF NOT EXISTS claude_workflow_ref (
  canonical_code text PRIMARY KEY,
  workflow_id    text NOT NULL,
  canonical_name text NOT NULL,
  stage_family   text,
  status         text,
  synced_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE claude_decision_log ADD COLUMN IF NOT EXISTS workflow_code text;
ALTER TABLE claude_known_issues ADD COLUMN IF NOT EXISTS workflow_code text;

CREATE INDEX IF NOT EXISTS idx_claude_issues_area_status  ON claude_known_issues (area, status);
CREATE INDEX IF NOT EXISTS idx_claude_decisions_area      ON claude_decision_log (area);
CREATE INDEX IF NOT EXISTS idx_claude_pending_area_status ON claude_pending_items (area, status);

-- NOT mirrored in runMigrations() — same reasoning as sql/051, 090, 091.
--
-- ROLLBACK: DROP FUNCTION claude_area_for(text); DROP TABLE claude_workflow_ref;
-- DROP the area / workflow_code / category_raw columns; then
-- UPDATE … SET category = category_raw before dropping category_raw, or the
-- original categories are lost. No data is deleted by this migration itself.
--
-- ─── Verification ───────────────────────────────────────────────────────────
-- SELECT json_agg(row_to_json(v)) FROM (
--   SELECT
--     (SELECT count(DISTINCT category) FROM claude_decision_log) AS decision_categories,   -- 12
--     (SELECT count(DISTINCT category) FROM claude_known_issues) AS issue_categories,      -- 12
--     (SELECT count(*) FROM claude_workflow_ref) AS ref_rows,                              -- 219
--     (SELECT count(*) FROM claude_session_logs WHERE area IS NULL) AS sessions_no_area,   -- 0
--     claude_area_for('S4.5 Seinfeld nurture cadence') AS sample_area                       -- nurture-reengagement
-- ) v;
