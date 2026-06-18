# I.STITCH — Visitor Identity Stitch & Enrichment — Runbook (v2: LP-MCP endpoint)

**Status:** built / smoke-test → activate · **Owner:** Mark · **Updated:** 2026-06-17

Turns raw `site_events` (Visitor Identity Tracking Build v1.0) into enriched GHL contact
intelligence: match an identified visitor to their **live** GHL contact, merge cross-domain
browsing history, score intent 0–100, write 4 custom fields + a note, persist the
visitor→contact mapping, and emit `system_events` for the LP Decision Engine.

> **Scope guardrail:** enrichment + signal ONLY. No messaging, no routing, **no
> stage/buyer/active-entry tag writes.** High intent is signalled via the `system_events`
> emit, never via a GHL tag.

## Architecture (v2 — matches the instance)

The n8n instance keeps workflows thin and routes DB work through LP-MCP `/n8n/...` HTTP
endpoints (same pattern as "Agentic Message Engine — Daily MV Refresh"). So:

- **n8n workflow** `I.STITCH — Visitor Identity Stitch & Enrichment` (`n8n/workflows/…json`):
  2 functional nodes — Schedule (every 5 min) → `POST https://lp-mcp-production.up.railway.app/n8n/site/stitch-batch`.
- **LP-MCP** `src/site-stitch.js` (registered in `src/index.js`) does the whole pipeline with
  the service-role Supabase client + `run_sql`, reusing `emitEvent`, and the tag-safe GHL
  helpers `updateGHLContactFields` / `addGHLNote` from `src/ghl.js`.

(The earlier n8n Postgres-node design + `n8n/workflows` JSON it implied are **superseded**:
the instance has no LP-Supabase Postgres credential and we can't create n8n creds / env vars.)

## Endpoints (`src/site-stitch.js`, open — matches the `/n8n/*` surface)
- `POST /n8n/site/stitch-batch` — the 5-min worker. Per call: `ensureSchema()` (idempotent
  DDL via `run_sql`, mirrors `sql/025`), `ensureGhlFields()` (resolve/create the 4 custom
  fields, cache name→id), claim a batch (`FOR UPDATE SKIP LOCKED`), resolve contact
  (cid > email > phone, **match-only, never creates**; misses → `unmatched_identities` with
  attempt backoff + `processed_at=null` re-queue while under `STITCH_MAX_MATCH_ATTEMPTS`),
  aggregate cross-domain history via `visitor_links`, score intent, write GHL customFields +
  deduped note, upsert `visitor_identity_map`, and `emitEvent(... bypass_filter:true ...)`.
  Returns `{ ok, claimed, matched, unmatched, emitted, high_intent }`.
- `POST /n8n/site/seed-test` — one-shot smoke seeder. Body `{ contact_id?, visitor_id?,
  identity_email?, pages? }`; defaults `contact_id` to Mark Test `0kk3xz6XatILy8jajymX` and
  seeds an `identify` row (`raw.cid` = contact_id) + `/pricing` `/estimate` pageviews.

## Event contract (`emitEvent`, `bypass_filter:true`)
- always `site.identity_stitched` (priority `normal`) — payload `{contact_id, visitor_ids,
  site_intent_score, pageviews, first_touch_source}`.
- if `score >= SITE_INTENT_HIGH_THRESHOLD` also `site.high_intent_signal` (priority `high`) —
  payload `{contact_id, score, top_pages, first_touch_source}`.
- `bypass_filter:true` is required: these types aren't in the event-intake allowlist yet, so
  without bypass they'd be dropped to `system_events_filtered`. Idempotency keys
  `<type>:<contact_id>:<max_site_event_id>`.

## Tag safety
I.STITCH writes **no tags**. GHL writes are `updateGHLContactFields` (PUT with `{customFields}`
ONLY — never a `tags` array, so it cannot wipe tags) and `addGHLNote` (POST to notes, deduped
via `GHL_NOTE_DEDUP_WINDOW_MIN`). The v3.0 tag-wipe incident was caused by including `tags` in a
contact PUT; we never do that. Note: any customFields PUT still fires GHL's generic
contact-updated trigger — same as the existing LP field-sync; I.STITCH adds no new tag/PUT
behavior.

## Config (env, with safe fallbacks — no n8n env dependency)
`STITCH_BATCH_SIZE`=50, `STITCH_MAX_MATCH_ATTEMPTS`=3, `SITE_INTENT_HIGH_THRESHOLD`=50,
`GHL_LOCATION_ID`=`SsBG7j5KQAIP1SFP2Sca`, `GHL_API_KEY` (already set on the LP-MCP service).

## Deploy + enable
1. Merge the LP-MCP PR to `main`; Railway auto-deploys (prod = `lp-mcp-production`).
2. Create the n8n workflow from `n8n/workflows/I.STITCH-visitor-identity-stitch.json` (inactive).
3. First hit to `/n8n/site/stitch-batch` runs `ensureSchema()` + `ensureGhlFields()` — no SQL
   editor step and no manual GHL custom-field creation needed.
4. Smoke test: `POST /n8n/site/seed-test` (Mark Test contact), then run once. Verify below.
5. Activate the workflow.

## Smoke test — verify
- correct match (cid > email > phone), **no duplicate contact**;
- cross-domain history merged via `visitor_links`;
- 4 custom fields + note on the contact, **no tag changes**;
- `visitor_identity_map` upserted for every linked visitor_id; `processed_at` stamped;
- `system_events` has `site.identity_stitched` (+ `site.high_intent_signal` if ≥ threshold);
- `unmatched_identities` grows only on a genuine miss, with attempt backoff;
- re-run emits nothing new (idempotency + `processed_at`).

## Out of scope / still Mark's
- Event-intake **allowlist** entries for the two `site.*` events + one `agent_rule` + Decision
  Engine reload (we emit with `bypass_filter:true` so events land now; consumption is post-deploy).
- The `track` Edge Function + real site traffic (web team). Without it, prod batches are no-ops
  until live `site_events` arrive; the smoke test uses the seeded row.

## §6 Follow-up: External Intelligence Ingestion (two separate stubs)
### 6a. Full Throttle — DISABLED, wire after the June 24 walkthrough
API shape unknown until June 24. Expected inputs `propensity_score`, `journey_segment` (≤20),
resolved address; map journey_segment → eight-pillar/page-intent; fold propensity into
`site_intent_score`. No live FT calls yet.

### 6b. Lead Gurus — confirmed (June 17 live pull); build-ready follow-up after the v1 smoke test
Different company/API from Full Throttle. Base `https://clients.leadgurus.com`, header
`X-API-Key: {{ $env.LEAD_GURUS_API_KEY }}` (Railway, never inline), client id **`91`** (numeric;
slug `reece-windows` rejected by the leads endpoint). **Daily** pull → its own daily trigger +
its own LP-MCP endpoint:
- `GET /api/v1/leads/?client=91&date_after=YESTERDAY&page_size=500` (paginate `next`). Match to
  GHL by **email then phone**. Write `ft_propensity` (from `success_post` + presence of
  `self_book_appointment_datetime` as a proxy), `ft_journey_segment` (= `project_type` for now),
  `ft_territory`, `ft_credit_score`, `ft_windows_count`.
- **Address → SalesRabbit canvassing** for `success_post=true` with verified `address`: push
  with a **minimum 24-hour delay from `date_created` — NEVER same-day**. Carry
  `campaign_id`/`ad_set_id`/`ad_id`.
- `GET /api/v1/summary/client/?client=91&date_after=…&date_before=…` → upsert new LP tables
  `ft_daily_summary` (+ `ft_summary_territory` from `/summary/territory/`, `ft_summary_channel`
  from `/summary/channel/`) — revenue attribution layer.
- Defer post-June-24: formal `journey_segment` taxonomy (≤20 → eight-pillar), lookalike/AI model
  feed, `/api/v1/backend-data/`.
