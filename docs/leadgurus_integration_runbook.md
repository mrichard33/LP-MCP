# I.LG — Lead Gurus Integration — Runbook

**Status:** built / activate after LP-MCP deploy · **Owner:** Mark · **Updated:** 2026-06-18

Pulls Lead Gurus' paid-media data (FB ad spend / leads / revenue for Reece
Windows, client id **91**) into the LP Supabase as `ft_*` tables, surfaces it on
the Reece Dashboard as a "Paid Media (Lead Gurus)" section, and (gated, default
OFF) enriches matched GHL contacts with `ft_*` custom fields.

Lead Gurus is the **paid-media agency platform** (`clients.leadgurus.com`) — NOT
Full Throttle (a separate feed, out of scope until after the June 24 walkthrough).

## Architecture

Thin n8n cron → LP-MCP endpoint (same shape as I.STITCH). The workflow does no
business logic; all of it lives in `src/leadgurus-ingest.js`.

```
n8n "I.LG — Lead Gurus Daily Pull"  (daily ~06:00 ET, tz America/New_York)
  └─ POST https://lp-mcp-production.up.railway.app/n8n/leadgurus/daily-pull
        └─ src/leadgurus-ingest.js (runPull):
             GET /api/v1/summary/client|territory|channel/  → upsert ft_daily_summary / ft_summary_territory / ft_summary_channel
             GET /api/v1/leads/?client=91 (paginate `next`)  → upsert ft_leads
             (gated) match GHL contact email→phone → PUT /contacts/{id} customFields ONLY
```

n8n workflow id: **`1AYZbPomUEyDKU27`** (active). Backfill is a separate manual
POST (below).

## Config (env on the LP-MCP Railway service)

| Var | Purpose | State |
|-----|---------|-------|
| `LEAD_GURUS_API_KEY` | `X-API-Key` for clients.leadgurus.com | **set** |
| `LEAD_GURUS_CLIENT_ID` | client filter (numeric) | defaults to `91` |
| `LEAD_GURUS_ENRICH_ENABLED` | master switch for GHL enrichment | `false` (default) |
| `GHL_CF_FT_CAMPAIGN_ID` / `_CREDIT_SCORE` / `_PROJECT_TYPE` / `_SELF_BOOK_DT` / `_TERRITORY` | GHL custom-field IDs for the 5 `ft_*` fields | unset until Mark creates the fields |
| `GHL_API_KEY` | reused for the enrichment writes | set |

Client filter is the numeric `91` — the slug `reece-windows` is rejected by the
leads endpoint. The key lives on LP-MCP (not n8n) because all HTTP happens here.

## Tables (`sql/027_leadgurus_ingest.sql`)

`ft_daily_summary` (date PK), `ft_summary_territory` (date,territory PK),
`ft_summary_channel` (date,channel PK), `ft_leads` (lead_id PK + full payload in
`raw`). Idempotent `create table if not exists`. **Already applied** to the LP
Supabase on 2026-06-18; the file is committed for the record / other
environments. If standing up a fresh DB, run it in the Supabase SQL editor.

## Deploy + enable

1. **LP-MCP:** merge branch `claude/fervent-knuth-7cssax` to `main` so Railway
   deploys `src/leadgurus-ingest.js` + the route registration. Until this
   deploys, the n8n workflow's POST returns 404 (the endpoint doesn't exist yet).
2. **n8n:** the "I.LG — Lead Gurus Daily Pull" workflow is already created and
   **active**. Its first real run is the next 06:00 ET trigger after the deploy.
3. **Dashboard:** the "Paid Media (Lead Gurus)" section is on the feature branch.
   **Mark merges to `main` to deploy** — do not push to main.

## Smoke test — verify (after the LP-MCP deploy)

```bash
# 1. One-shot daily pull (defaults to yesterday→today ET)
curl -X POST https://lp-mcp-production.up.railway.app/n8n/leadgurus/daily-pull \
  -H 'Content-Type: application/json' -d '{}'
# expect: { ok:true, summary:{daily,territory,channel}, leads:{upserted,...} }

# 2. Confirm rows landed (LP Supabase SQL editor)
#   select count(*) from ft_daily_summary;
#   select count(*) from ft_summary_territory;
#   select count(*) from ft_summary_channel;
#   select count(*) from ft_leads;

# 3. Backfill history (monthly windows from 2026-01-01)
curl -X POST https://lp-mcp-production.up.railway.app/n8n/leadgurus/backfill \
  -H 'Content-Type: application/json' -d '{"start_date":"2026-01-01"}'
```

The dashboard "Paid Media (Lead Gurus)" section renders once `ft_daily_summary`
has rows.

## Enabling contact enrichment (gated — do this last)

The enrichment branch ships **disabled** and is harmless until turned on. It runs
only when `LEAD_GURUS_ENRICH_ENABLED=true` **and** all 5 `GHL_CF_FT_*` IDs are set.

1. In GHL, create 5 contact custom fields and capture their IDs: `ft_campaign_id`,
   `ft_credit_score`, `ft_project_type`, `ft_self_book_dt`, `ft_territory`.
2. Set the 5 `GHL_CF_FT_*` env vars on LP-MCP + `LEAD_GURUS_ENRICH_ENABLED=true`,
   redeploy.
3. On the next pull, each new `ft_leads` row is matched to a GHL contact by
   **email then phone** and the `ft_*` fields are written via
   `PUT /contacts/{id}` — **customFields only, never a `tags` array** (avoids the
   known tag-wipe hazard). No match → skip. Never creates a contact.

## Out of scope

Full Throttle (separate feed, after June 24). SalesRabbit canvassing push from
`success_post` leads. Any revenue push-back to Lead Gurus — confirm with them how
closed-deal revenue feeds `gross_amount`/`net_amount` before building it.
