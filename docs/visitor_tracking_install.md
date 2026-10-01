# Visitor Tracking — Install & Operations (I.TRACK + reece-tracker.js)

First-party visitor tracking for Reece across the **main site**, **GHL pages**, and the
**Weakest Point LP**. Feeds `public.site_events` (LP Supabase, sql/025 schema), which the
**I.STITCH** workflow stitches to GHL contacts every 5 minutes.

> **2026-10-01 — where the tracker lives now.** The script and its collector are a separate
> Railway service, **`reece-tracker`** (repo `mrichard33/reece-tracker`), on
> `https://track.getreecewindows.com`. Edit the tracker there; LP-MCP no longer holds a copy.
> LP-MCP still owns **I.STITCH** (`src/site-stitch.js`), which reads `site_events`.

## How it flows

```
reece-tracker.js (browser, text/plain beacon)
  → reece-tracker service   POST https://track.getreecewindows.com/collect
                  · whitelists fields to the 025 columns, folds client IP into raw.ip
                  · inserts into public.site_events (LP Supabase)
  → I.STITCH (LP-MCP, 5-min cron) claims new `identify` rows → GHL custom fields + note + intent signals
```

The older path (n8n `/webhook/reece-track` → LP-MCP `POST /n8n/site/collect`) still works
for any page that sets `data-collector` to it.

The tracker posts the body as **`text/plain`** on purpose: that makes it a CORS "simple"
request, so **no preflight/CORS config** is needed on any of the three surfaces.

## 1. Embed snippet (identical on all three surfaces)

Add this once per page/site:

```html
<script src="https://track.getreecewindows.com/reece-tracker.js" data-reece-tracker defer></script>
```

With no `data-collector`, the tracker sends to `https://track.getreecewindows.com/collect`.

Optional attributes (defaults shown):
- `data-cookie="_reece_vid"` — visitor cookie name.
- `data-cookie-days="730"` — visitor cookie lifetime.
- `data-sister-domains="reecewindows.com,getreecewindows.com"` — domains that get `?vid=`
  decoration for cross-domain stitching. **Update this to the real sister domains.**
- `data-track-spa="true"` — also fire a pageview on SPA route changes (pushState/popstate).
- `data-auto-identify="true"` — identify automatically on form submit (see §2). Set
  `"false"` to turn that off for the page.

A pageview is sent automatically on load (and on SPA navigations). The tracker sets a
first-party visitor cookie and a per-session cookie, and exposes `window.ReeceTrack`.

## 2. Identify known leads on form / chatbot submit

**Automatic since 2026-10-01.** Any form with an email or phone field fires `identify` on
submit — the Wufoo forms on reecewindows.com included (they have no `<label>`s, so the
tracker matches on `type=`, placeholder, name/id and label text). Phone is sent as 10 digits;
a ZIP in a `type=tel` box is ignored. It never blocks or delays the form, and fires once per
form for the same email/phone within 10 seconds. To skip one form, add
`data-reece-no-identify` to its `<form>` tag.

Manual calls still work — use them for chatbots or anything that is not a `<form>`:

```js
ReeceTrack.identify({ email: "jane@example.com", phone: "+15551234567", name: "Jane Doe" });
```

This emits an `identify` event. I.STITCH resolves it to a GHL contact **match-only**
(never creates) in this priority order: `raw.cid` → exact email → normalized phone.

When several GHL contacts share the email or phone (duplicates), I.STITCH picks one in this
order: the contact this visitor is already stitched to → a contact whose phone matches the
submitted phone → a contact another visitor is stitched to → the most complete record
(has a phone and a name) → the most recently updated.

A contact's totals (`site_pages_viewed`, `site_intent_score`, `last_site_visit`,
`first_touch_source`) cover **every** visitor ever stitched to them, so a return visit from
a new browser or device adds to the totals instead of replacing them. An unknown first touch
is never written, so it cannot erase one GHL already holds.

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

- **Collector (live):** the `reece-tracker` service, `POST https://track.getreecewindows.com/collect`.
  See that repo's README for redeploys and the health check.
- **Legacy collector:** n8n "I.TRACK — Site Event Collector" (`/webhook/reece-track`) →
  LP-MCP `POST /n8n/site/collect` (`src/site-collect.js`). No auth, write-only to `site_events`.
- **Browser cache:** the tracker is served with `max-age=3600`, so a tracker change reaches a
  returning browser up to an hour later. Test changes in a fresh incognito window.
- **Schema:** `site_events` columns — `event_type, visitor_id, session_id, page_path,
  utm_source, fbclid, identity_email, identity_phone, raw`. The IP has no column; it lives
  in `raw.ip`. Other secondary signals (referrer, utm_medium/campaign/term/content, gclid,
  msclkid, screen, tz, cid, alias_id) also live in `raw`.
- **Tuning intent scoring / page tiers:** edit the `RUBRIC` object in `src/site-stitch.js`.
- **Stitch decisions** (which visitors a contact's totals cover, which fields are written,
  which duplicate wins) live in `src/site-stitch-core.js`, tested by
  `scripts/test-site-stitch-core.js`.

## Where the data lives (2026-10-01)

| Table | One row per | What it is |
|---|---|---|
| `site_events` | page view / form submit | The raw log. Kept because visits made **before** a form submit are credited to the lead afterwards. |
| `visitor_identity_map` | browser | Which GHL contact each stitched browser belongs to. |
| `site_lead_summary` (sql/142) | **lead (GHL contact)** | Totals: pages viewed, sessions, first/last visit, first touch, intent score, top pages, per-page counts. |

- **Kept current both ways.** I.STITCH upserts `site_lead_summary` when someone submits a
  form, and each 5-minute run also rebuilds up to `STITCH_REFRESH_LIMIT` (default 50) known
  leads who came back and browsed without submitting. Those runs update the row and the 4 GHL
  fields, and add a GHL note only when something a rep would act on changed: the score crossed
  50, a first visit to a pricing/estimate/financing page, or the score jumped 20+.
  `STITCH_REFRESH_LIMIT=0` turns the refresh off.
- **Retention.** `site-events-retention` (daily 04:00 ET) deletes page views older than
  `SITE_EVENTS_RETENTION_DAYS` (default 180, Mark's ruling) **only** for browsers that never
  identified. Stitched leads keep everything; `identify` rows are never deleted.
- **GHL's Activity panel stays empty for Wufoo leads.** GHL's own External Tracking script
  (installed through GTM) records page views, but Wufoo's form sends the browser to wufoo.com
  before GHL's script can capture the submission (tested 2026-10-01), so GHL never learns who
  the visitor is. Our data reaches GHL as the 4 site fields and the "Site activity" note.
  Only switching to native GHL forms would fill that panel (Mark chose not to, 2026-10-01).
