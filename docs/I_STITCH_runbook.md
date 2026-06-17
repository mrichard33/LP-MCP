# I.STITCH — Visitor Identity Stitch & Enrichment — Runbook

**Status:** built inactive / pending smoke test · **Owner:** Mark · **Date:** 2026-06-17

Turns raw `site_events` (Visitor Identity Tracking Build v1.0) into enriched GHL contact
intelligence: match an identified visitor to their **live** GHL contact, merge cross-domain
browsing history, score intent 0–100, write 4 custom fields + a note, persist the
visitor→contact mapping, and emit `system_events` for the LP Decision Engine.

> **Scope guardrail:** enrichment + signal ONLY. No messaging, no routing, **no
> stage/buyer/active-entry tag writes**. The consuming `agent_rule` + event-intake
> allowlist + Decision Engine reload are a separate post-deploy step (Mark).

---

## 1. Prerequisites (must exist before activation)

### 1.1 Database (run `sql/025_visitor_identity_stitch.sql` in the LP MCP Supabase SQL editor)
Creates (idempotent, `public` schema): `site_events`, `visitor_links`,
`visitor_identity_map`, `unmatched_identities`. `site_events`/`visitor_links` belong to
Build v1.0 — if already present with a different shape, reconcile the column set with the
web team's `track` Edge Function before activating.

### 1.2 `track` Edge Function (web team / Build v1.0)
Deployed into **this** LP MCP Supabase project so its auto-injected
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` resolve to LP. Give the web guy this project's
function URL. It must write `site_events` rows conforming to §1.1 (notably `event_type`,
`visitor_id`, `identity_email`/`identity_phone` on `identify`, and `raw.cid` when a GHL
contact id is known on the URL).

### 1.3 GHL custom fields (Mark creates in GHL UI; capture IDs into env)
| Field (GHL) | Type | Env var |
|---|---|---|
| `last_site_visit` | Date | `GHL_CF_LAST_SITE_VISIT` |
| `site_intent_score` | Number | `GHL_CF_SITE_INTENT_SCORE` |
| `site_pages_viewed` | Number | `GHL_CF_SITE_PAGES_VIEWED` |
| `first_touch_source` | Text | `GHL_CF_FIRST_TOUCH_SOURCE` |

Reserve (do NOT create yet) for the Lead Gurus/FT follow-up: `ft_propensity`,
`ft_journey_segment`, `ft_territory`, `ft_credit_score`, `ft_windows_count`.

### 1.4 n8n credentials
- **Postgres credential → LP MCP Supabase** (host / 5432 or 6543 pooler / db / user /
  password / SSL=require). Used by every Postgres node (the `FOR UPDATE SKIP LOCKED` claim
  needs raw SQL, so PostgREST is insufficient). Referenced in the workflow as
  `LP Supabase Postgres` — set the real credential id on import.
- GHL auth is supplied via the `GHL_API_TOKEN` env var on the HTTP header (no stored
  credential needed); the token is a location-scoped Private Integration Token, never inline.

### 1.5 n8n host env vars (Railway)
```
GHL_API_BASE=https://services.leadconnectorhq.com
GHL_API_TOKEN=                 # location-scoped PIT
GHL_LOCATION_ID=SsBG7j5KQAIP1SFP2Sca
GHL_CF_LAST_SITE_VISIT=
GHL_CF_SITE_INTENT_SCORE=
GHL_CF_SITE_PAGES_VIEWED=
GHL_CF_FIRST_TOUCH_SOURCE=
SITE_INTENT_HIGH_THRESHOLD=50
STITCH_BATCH_SIZE=50
STITCH_MAX_MATCH_ATTEMPTS=3
```
(`LEAD_GURUS_API_KEY` is only needed for the §6 follow-up, not v1.)

---

## 2. Event-bus contract (verified — conform exactly)

`public.system_events` (from `sql/006_agentic_system.sql`) requires NOT NULL
`event_type`, `source`, `entity_type`, `entity_id`. A BEFORE-INSERT trigger assigns
`priority_lane`; the Decision Engine reads `processed=false` ordered by
`priority_lane, created_at`. We INSERT directly (bypassing the intake filter) — rows wait
until Mark adds the allowlist entry + `agent_rule`. Mapping used by Node 9:

| column | identity_stitched | high_intent_signal |
|---|---|---|
| `event_type` | `site.identity_stitched` | `site.high_intent_signal` |
| `source` | `i_stitch` | `i_stitch` |
| `entity_type` | `contact` | `contact` |
| `entity_id` / `ghl_contact_id` | `<contact_id>` | `<contact_id>` |
| `priority` | `normal` | `high` |
| `idempotency_key` | `site.identity_stitched:<cid>:<max_site_event_id>` | `site.high_intent_signal:<cid>:<max_site_event_id>` |
| `payload` | `{contact_id, visitor_ids, site_intent_score, pageviews, first_touch_source}` | `{contact_id, score, top_pages, first_touch_source}` |

---

## 3. Workflow nodes (exact configs)

> **GHL PUT tag-wipe hazard** (see `src/n8n-enrichment.js` v3.0): a `PUT /contacts/{id}`
> with a `tags` array WHOLESALE-REPLACES the contact's tags and has caused production data
> loss. The enrichment PUT below carries **`customFields` only — never `tags` or
> `locationId`**.

### N1 — Schedule trigger
`scheduleTrigger` v1.2, every **5 minutes**.

### N2 — Claim Identify Batch (Postgres `executeQuery`, LP creds)
```sql
with claimed as (
  select id from public.site_events
  where event_type = 'identify' and processed_at is null
  order by created_at
  limit {{ $env.STITCH_BATCH_SIZE }}
  for update skip locked
)
update public.site_events s set processed_at = now()
from claimed c where s.id = c.id
returning s.*;
```
Empty result ⇒ downstream nodes no-op (run ends naturally).

### N3 — Resolve GHL Contact (Code, per item) — confidence cid > email > phone
Match-only; never creates a contact. Uses the live GHL API via `httpRequest`. Carries
`contact_id` + `matched` forward; leaves unmatched items for N3b.
```js
const base = $env.GHL_API_BASE, token = $env.GHL_API_TOKEN, loc = $env.GHL_LOCATION_ID;
const out = [];
for (const item of $input.all()) {
  const e = item.json;
  const raw = e.raw || {};
  const norm = s => (s || '').toString().replace(/[^0-9+]/g, '');
  let contact_id = null;
  if (raw.cid) {
    contact_id = raw.cid;                                   // (1) highest confidence
  } else if (e.identity_email || e.identity_phone) {
    const q = e.identity_email ? e.identity_email : norm(e.identity_phone);
    const res = await this.helpers.httpRequest({
      method: 'GET',
      url: `${base}/contacts/`,
      qs: { locationId: loc, query: q, limit: 20 },
      headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json' },
      json: true,
    });
    const contacts = res.contacts || [];
    if (e.identity_email) {                                 // (2) exact email
      const m = contacts.find(c => (c.email || '').toLowerCase() === e.identity_email.toLowerCase());
      if (m) contact_id = m.id;
    }
    if (!contact_id && e.identity_phone) {                  // (3) normalized phone
      const want = norm(e.identity_phone);
      const m = contacts.find(c => norm(c.phone).endsWith(want.slice(-10)));
      if (m) contact_id = m.id;
    }
  }
  out.push({ json: { ...e, contact_id, matched: !!contact_id } });
}
return out;
```
> Confirm the live v2 lookup shape at build time. If `GET /contacts/?query=` is unavailable
> in this location, switch to `POST /contacts/search` with
> `{ locationId, pageLimit:20, filters:[{field:'email'|'phone', operator:'eq', value}] }`
> and keep the same client-side exact-match.

### N3b — IF `matched` → false branch → Upsert Unmatched + Backoff (Postgres, LP creds)
```sql
with up as (
  insert into public.unmatched_identities
    (site_event_id, visitor_id, identity_email, identity_phone, attempts, first_seen, last_attempt)
  values
    ({{ $json.id }}, '{{ $json.visitor_id }}',
     {{ $json.identity_email ? "'" + $json.identity_email + "'" : 'null' }},
     {{ $json.identity_phone ? "'" + $json.identity_phone + "'" : 'null' }},
     1, now(), now())
  on conflict (visitor_id) do update
    set attempts = public.unmatched_identities.attempts + 1, last_attempt = now()
  returning attempts
)
-- re-queue for a later run while under the attempt cap; otherwise leave processed
update public.site_events
   set processed_at = null
 where id = {{ $json.id }}
   and (select attempts from up) < {{ $env.STITCH_MAX_MATCH_ATTEMPTS }};
```
(`matched=true` items continue to N4.)

### N4+N5 — Aggregate Cross-Domain History (Postgres, LP creds — one row per contact)
Merges the `visitor_links` graph and aggregates `site_events` in a single query; carries
`contact_id` (from N3, not the DB) through as a literal.
```sql
with linked as (
  select distinct unnest(array[id_a, id_b]) as vid
    from public.visitor_links
   where id_a = '{{ $json.visitor_id }}' or id_b = '{{ $json.visitor_id }}'
  union select '{{ $json.visitor_id }}'
),
ev as (
  select * from public.site_events
   where visitor_id in (select vid from linked) and event_type = 'pageview'
)
select
  '{{ $json.contact_id }}'::text                                   as contact_id,
  {{ $json.id }}::bigint                                           as max_site_event_id,
  (select array_agg(vid) from linked)                             as visitor_ids,
  (select string_agg(vid, ',') from linked)                       as visitor_ids_csv,
  count(*)                                                         as pageviews,
  count(distinct session_id)                                      as sessions,
  max(created_at)                                                 as last_visit,
  (select coalesce(utm_source, fbclid) from ev
     where coalesce(utm_source, fbclid) is not null
     order by created_at asc limit 1)                             as first_touch_source,
  coalesce(jsonb_object_agg(page_path, cnt) filter (where page_path is not null), '{}'::jsonb)
    as page_counts,
  coalesce(jsonb_object_agg(page_path, recent_cnt)
     filter (where page_path is not null and recent_cnt > 0), '{}'::jsonb)
    as recent_page_counts
from (
  select page_path, session_id, created_at, utm_source, fbclid,
         count(*) over (partition by page_path)                    as cnt,
         count(*) filter (where created_at >= now() - interval '7 days')
                  over (partition by page_path)                    as recent_cnt
  from ev
) z;
```
(If a contact has zero pageviews the row still returns with `pageviews=0` and empty jsonbs.)

### N6 — Score Intent (Code) — single editable rubric object
```js
const RUBRIC = {
  high:   { weight: 25, paths: ['/financing','/pricing','/estimate','/quote','/free-quote','/book','/schedule'] },
  medium: { weight: 10, paths: ['/impact-windows','/impact-doors','/windows','/doors','/gallery'] },
  low:    { weight: 3,  paths: ['/about','/blog','/reviews'] },
  ignore: { weight: 0,  paths: ['/careers','/privacy','/terms'] },
  recency_days: 7, recency_multiplier: 2, cap: 100,
};
const tierWeight = (path) => {
  for (const t of ['high','medium','low','ignore'])
    if (RUBRIC[t].paths.some(p => (path || '').startsWith(p))) return RUBRIC[t].weight;
  return RUBRIC.low.weight; // default unknown pages to low
};
return $input.all().map(item => {
  const j = item.json;
  const counts = j.page_counts || {};
  const recent = j.recent_page_counts || {};
  let score = 0;
  for (const [path, c] of Object.entries(counts)) score += tierWeight(path) * Number(c);
  for (const [path, c] of Object.entries(recent))  // recency bonus: ×(multiplier-1) extra
    score += tierWeight(path) * Number(c) * (RUBRIC.recency_multiplier - 1);
  score = Math.min(Math.round(score), RUBRIC.cap);
  const top_pages = Object.entries(counts).sort((a,b) => b[1]-a[1]).slice(0,5).map(x => x[0]);
  return { json: { ...j, site_intent_score: score, top_pages } };
});
```

### N7a — Write Custom Fields (HTTP Request v4.3) — **customFields ONLY**
`PUT {{ $env.GHL_API_BASE }}/contacts/{{ $json.contact_id }}`
Headers: `Authorization: Bearer {{ $env.GHL_API_TOKEN }}`, `Version: 2021-07-28`,
`Content-Type: application/json`. JSON body:
```js
={{ JSON.stringify({ customFields: [
  { id: $env.GHL_CF_LAST_SITE_VISIT,    field_value: $json.last_visit },
  { id: $env.GHL_CF_SITE_INTENT_SCORE,  field_value: $json.site_intent_score },
  { id: $env.GHL_CF_SITE_PAGES_VIEWED,  field_value: $json.pageviews },
  { id: $env.GHL_CF_FIRST_TOUCH_SOURCE, field_value: $json.first_touch_source || '' },
] }) }}
```

### N7b — Add Note (HTTP Request v4.3)
`POST {{ $env.GHL_API_BASE }}/contacts/{{ $json.contact_id }}/notes`, same headers. Body:
```js
={{ JSON.stringify({ body:
  `Site activity: ${$json.pageviews} pageviews / ${$json.sessions} sessions. ` +
  `Last visit ${$json.last_visit}. Top pages: ${($json.top_pages||[]).join(', ')}. ` +
  `First touch: ${$json.first_touch_source || 'unknown'}. Intent score ${$json.site_intent_score}.`
}) }}
```

### N8 — Persist visitor_identity_map (Postgres, LP creds) — every linked visitor_id
```sql
insert into public.visitor_identity_map (visitor_id, contact_id, last_enriched_at)
select trim(v), '{{ $json.contact_id }}', now()
from unnest(string_to_array('{{ $json.visitor_ids_csv }}', ',')) as v
on conflict (visitor_id) do update
  set contact_id = excluded.contact_id, last_enriched_at = now();
```

### N9 — Emit to system_events (Postgres, LP creds) — always stitched, conditional high-intent
```sql
insert into public.system_events
  (event_type, source, entity_type, entity_id, ghl_contact_id, priority, payload, idempotency_key)
values (
  'site.identity_stitched', 'i_stitch', 'contact',
  '{{ $json.contact_id }}', '{{ $json.contact_id }}', 'normal',
  jsonb_build_object(
    'contact_id', '{{ $json.contact_id }}',
    'visitor_ids', '{{ $json.visitor_ids_csv }}',
    'site_intent_score', {{ $json.site_intent_score }},
    'pageviews', {{ $json.pageviews }},
    'first_touch_source', '{{ $json.first_touch_source }}'),
  'site.identity_stitched:{{ $json.contact_id }}:{{ $json.max_site_event_id }}'
)
on conflict (idempotency_key) do nothing;

insert into public.system_events
  (event_type, source, entity_type, entity_id, ghl_contact_id, priority, payload, idempotency_key)
select
  'site.high_intent_signal', 'i_stitch', 'contact',
  '{{ $json.contact_id }}', '{{ $json.contact_id }}', 'high',
  jsonb_build_object(
    'contact_id', '{{ $json.contact_id }}',
    'score', {{ $json.site_intent_score }},
    'top_pages', '{{ ($json.top_pages || []).join("|") }}',
    'first_touch_source', '{{ $json.first_touch_source }}'),
  'site.high_intent_signal:{{ $json.contact_id }}:{{ $json.max_site_event_id }}'
where {{ $json.site_intent_score }} >= {{ $env.SITE_INTENT_HIGH_THRESHOLD }}
on conflict (idempotency_key) do nothing;
```

### N10 — External Intelligence Ingestion (two DISABLED stubs, not wired to the trigger)
See §6. Two separate companies — keep them distinct.

---

## 4. Smoke test (after §1 prerequisites are satisfied)
1. Seed one `identify` `site_events` row for Mark Test contact `0kk3xz6XatILy8jajymX` with a
   known email and a couple of high-intent pageviews (`/pricing`, `/estimate`).
2. Run the workflow once (manual). Confirm:
   - correct match (cid > email > phone), **no duplicate contact created**;
   - cross-domain history merged via `visitor_links`;
   - 4 custom fields + note written in GHL, **no tag changes** on the contact;
   - `visitor_identity_map` upserted for every linked visitor_id; `processed_at` stamped;
   - `system_events` has `site.identity_stitched` (and `site.high_intent_signal` if score ≥ threshold);
   - `unmatched_identities` only grows on a genuine miss, attempts increment, and the event
     re-queues (`processed_at` back to null) until the attempt cap.
3. **Activate** only after this passes.

## 5. Post-deploy (Mark — separate change, NOT in this workflow)
1. Add event-intake allowlist entries for `site.identity_stitched` + `site.high_intent_signal`.
2. Add one `agent_rule` consuming `site.high_intent_signal`.
3. **Reload the Decision Engine.**
4. Monitoring: daily check for `unmatched_identities` growth and `site_events` rows
   unprocessed > 1 hour.

## 6. Follow-up: External Intelligence Ingestion (Node 10) — two separate stubs
### 6a. Full Throttle — DISABLED, wire after the June 24 walkthrough
API shape unknown until June 24. Expected inputs: `propensity_score`, `journey_segment`
(≤20), resolved address. Map journey_segment → eight-pillar/page-intent; fold propensity
into `site_intent_score`. No live FT calls until then.

### 6b. Lead Gurus — confirmed (June 17 live pull); build-ready AFTER the v1 smoke test
Different company / API / data from Full Throttle. Base `https://clients.leadgurus.com`,
auth header `X-API-Key: {{ $env.LEAD_GURUS_API_KEY }}` (Railway, never inline), client id
**`91`** (numeric; slug `reece-windows` is rejected by the leads endpoint). This is a
**daily** pull → its own daily Schedule trigger, separate from the 5-minute stitch trigger.
- **Daily leads** `GET /api/v1/leads/?client=91&date_after=YESTERDAY&page_size=500`
  (paginate via `next`). Match to GHL by **email then phone** (Node 3 order). Write custom
  fields `ft_propensity` (from `success_post` + presence of `self_book_appointment_datetime`
  as a proxy until taxonomy is confirmed), `ft_journey_segment` (= `project_type` for now),
  `ft_territory` (= `territory`), `ft_credit_score` (= `credit_score` string),
  `ft_windows_count` (= `windows_count`).
- **Address → SalesRabbit canvassing** for `success_post = true` leads with a verified
  `address`: push with a **minimum 24-hour delay from `date_created` — NEVER same-day**.
  Carry `campaign_id`/`ad_set_id`/`ad_id` as attribution metadata.
- **Daily summary** `GET /api/v1/summary/client/?client=91&date_after=YESTERDAY&date_before=TODAY`
  → upsert new LP tables `ft_daily_summary` (+ `ft_summary_territory` from
  `/summary/territory/`, `ft_summary_channel` from `/summary/channel/`) — the revenue
  attribution layer (`gross_amount`/`net_amount` already populated by Lead Gurus).
- **Defer to post-June-24:** formal `journey_segment` taxonomy (≤20 → eight-pillar remap),
  lookalike/AI model feed, `/api/v1/backend-data/` device-resolution records.

---

## Open items carried into execution
- Exact `site_events`/`visitor_links` column set vs. the web team's `track` function.
- Live GHL v2 contact-lookup shape (`GET /contacts/?query=` vs `POST /contacts/search`) and
  PUT/notes payload confirmation.
- The n8n workflow was authored from this spec; **validate via the n8n MCP
  (`validate_workflow`) and wire the real Postgres credential id before activating.**
