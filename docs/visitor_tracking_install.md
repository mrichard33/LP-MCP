# Visitor Tracking — Install & Operations (I.TRACK + reece-tracker.js)

First-party visitor tracking for Reece across the **main site**, **GHL pages**, and the
**Weakest Point LP**. Feeds `public.site_events` (LP Supabase, sql/025 schema), which the
**I.STITCH** workflow stitches to GHL contacts every 5 minutes.

## How it flows

```
reece-tracker.js (browser, text/plain beacon)
  → n8n Webhook   POST https://n8n-main-instance-production-981e.up.railway.app/webhook/reece-track
                  (responds 200 immediately — fire-and-forget)
  → n8n HTTP Request → LP-MCP  POST /n8n/site/collect   (src/site-collect.js)
                  · whitelists fields to the 025 columns
                  · folds client IP (x-forwarded-for) into raw.ip
                  · inserts into public.site_events via the service-role client
  → I.STITCH (5-min cron) claims new `identify` rows → GHL custom fields + intent signals
```

The tracker posts the body as **`text/plain`** on purpose: that makes it a CORS "simple"
request, so **no preflight/CORS config** is needed on any of the three surfaces.

## 1. Embed snippet (identical on all three surfaces)

Add this once per page/site (replace `YOURHOST` with wherever Kyle hosts the file):

```html
<script src="https://YOURHOST/reece-tracker.js"
        data-reece-tracker
        data-collector="https://n8n-main-instance-production-981e.up.railway.app/webhook/reece-track"
        defer></script>
```

Optional attributes (defaults shown):
- `data-cookie="_reece_vid"` — visitor cookie name.
- `data-cookie-days="730"` — visitor cookie lifetime.
- `data-sister-domains="reecewindows.com,getreecewindows.com"` — domains that get `?vid=`
  decoration for cross-domain stitching. **Update this to the real sister domains.**
- `data-track-spa="true"` — also fire a pageview on SPA route changes (pushState/popstate).

A pageview is sent automatically on load (and on SPA navigations). The tracker sets a
first-party visitor cookie and a per-session cookie, and exposes `window.ReeceTrack`.

## 2. Identify known leads on form / chatbot submit

When a visitor submits a form or chatbot (any surface), call:

```js
ReeceTrack.identify({ email: "jane@example.com", phone: "+15551234567", name: "Jane Doe" });
```

This emits an `identify` event. I.STITCH resolves it to a GHL contact **match-only**
(never creates) in this priority order: `raw.cid` → exact email → normalized phone.

You can also send custom events:

```js
ReeceTrack.track("quote_started", { product: "impact-windows" });
```

## 3. Decorate email / SMS links with `?cid=` (known-lead stitching)

For outbound GHL email/SMS links pointing at any tracked surface, append the contact id so
a click stitches immediately with the highest confidence (no email/phone search needed):

```
https://reecewindows.com/financing?cid={{contact.id}}
```

The tracker reads `?cid=` and includes it in `raw.cid` on every event for that visit; the
`?vid=` cross-domain decoration is added automatically on clicks to sister domains.

## 4. Privacy policy reminder

Both domains (main site + LP / sister domains) **must disclose analytics/visitor tracking**
in their privacy policy (first-party cookies, page/visit tracking, and identity association
on form submission). Confirm this is covered before go-live.

## Operational notes

- **Collector workflow:** n8n "I.TRACK — Site Event Collector" (active). Public path
  `/webhook/reece-track`. It is fire-and-forget — `neverError` + continue-on-error mean a
  malformed payload never breaks the beacon.
- **Ingest route:** `POST /n8n/site/collect` (LP-MCP, `src/site-collect.js`). No auth,
  write-only to `site_events`. **Goes live only after LP-MCP is deployed** (Railway tracks
  `main`) — until then the n8n webhook still returns 200 but the forward 404s.
- **Schema:** `site_events` columns — `event_type, visitor_id, session_id, page_path,
  utm_source, fbclid, identity_email, identity_phone, raw`. The IP has no column; it lives
  in `raw.ip`. Other secondary signals (referrer, utm_medium/campaign/term/content, gclid,
  msclkid, screen, tz, cid, alias_id) also live in `raw`.
- **Tuning intent scoring / page tiers:** edit the `RUBRIC` object in `src/site-stitch.js`.
