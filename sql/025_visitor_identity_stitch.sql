-- ─────────────────────────────────────────────────────────────────────────────
-- 025 — Visitor Identity Stitch & Enrichment (I.STITCH) support objects
-- ─────────────────────────────────────────────────────────────────────────────
-- Pairs with:
--   • n8n workflow "I.STITCH — Visitor Identity Stitch & Enrichment" (built via
--     the n8n MCP, left inactive until smoke test passes)
--   • docs/I_STITCH_runbook.md — deploy/runbook + Mark's post-deploy steps
--
-- Run in: LP MCP Supabase → SQL Editor (same database as the rest of the
-- agentic schema — site_events + system_events share one connection).
-- Additive + idempotent — no drops, safe to re-run.
--
-- NOTE on site_events / visitor_links: these belong to "Visitor Identity
-- Tracking — Build v1.0". They are authored here (idempotent) because that build
-- was not confirmed deployed at I.STITCH build time. The `track` Edge Function
-- (web team) MUST write rows conforming to site_events below. If Build v1.0
-- already created these with a different column set, the IF NOT EXISTS guards
-- make this a no-op — reconcile columns with the track function before activate.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. site_events — raw first-party web tracking (pageviews + identify) ──────
CREATE TABLE IF NOT EXISTS public.site_events (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type      text NOT NULL,                -- 'pageview' | 'identify'
  visitor_id      text NOT NULL,                -- first-party anonymous id
  session_id      text,
  page_path       text,
  utm_source      text,
  fbclid          text,
  identity_email  text,                         -- present on 'identify' events
  identity_phone  text,
  raw             jsonb NOT NULL DEFAULT '{}',  -- full payload; includes raw.cid (GHL contact id) when known
  created_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz                   -- watermark stamped by I.STITCH Node 2
);

-- I.STITCH claim index: unprocessed identify events, oldest first.
CREATE INDEX IF NOT EXISTS idx_site_events_unprocessed
  ON public.site_events (created_at)
  WHERE event_type = 'identify' AND processed_at IS NULL;

-- History aggregation index (Node 5): per-visitor timeline.
CREATE INDEX IF NOT EXISTS idx_site_events_visitor
  ON public.site_events (visitor_id, created_at);


-- ── 2. visitor_links — cross-domain identity graph (Build v1.0 contract) ──────
-- Undirected edges between visitor_ids the tracker has stitched (Node 4 unnests
-- both endpoints to merge browsing history under one identity).
CREATE TABLE IF NOT EXISTS public.visitor_links (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id_a        text NOT NULL,
  id_b        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_visitor_links_a ON public.visitor_links (id_a);
CREATE INDEX IF NOT EXISTS idx_visitor_links_b ON public.visitor_links (id_b);


-- ── 3. visitor_identity_map — resolved visitor_id → GHL contact_id ────────────
-- Upserted by I.STITCH Node 8 for every linked visitor_id once a contact is matched.
CREATE TABLE IF NOT EXISTS public.visitor_identity_map (
  visitor_id        text PRIMARY KEY,
  contact_id        text NOT NULL,
  stitched_at       timestamptz NOT NULL DEFAULT now(),
  last_enriched_at  timestamptz
);
CREATE INDEX IF NOT EXISTS idx_vim_contact ON public.visitor_identity_map (contact_id);


-- ── 4. unmatched_identities — match-only backoff log (Node 3) ─────────────────
-- One row per visitor that could not be resolved to a GHL contact. Attempts are
-- incremented on each miss; after STITCH_MAX_MATCH_ATTEMPTS the event is left
-- processed and abandoned. Unique on visitor_id so retries upsert in place.
CREATE TABLE IF NOT EXISTS public.unmatched_identities (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  site_event_id   bigint,
  visitor_id      text,
  identity_email  text,
  identity_phone  text,
  attempts        int NOT NULL DEFAULT 1,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_attempt    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_unmatched_visitor
  ON public.unmatched_identities (visitor_id);
