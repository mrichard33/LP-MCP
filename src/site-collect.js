/**
 * I.TRACK — Site Event Collector — src/site-collect.js
 *
 * Receives first-party tracker beacons (reece-tracker.js on the main site, GHL
 * pages, and the Weakest Point LP) forwarded by the n8n "I.TRACK — Site Event
 * Collector" webhook, and inserts conforming rows into public.site_events
 * (Visitor Identity Tracking Build v1.0 — sql/025 schema). Those rows are then
 * consumed by I.STITCH (src/site-stitch.js) on its 5-min cron.
 *
 * Mirrors site-stitch.js conventions: ESM, reuses the LP-MCP service-role
 * Supabase client, /n8n/* surface, no auth (matches the existing
 * /n8n/site/stitch-batch + /n8n/site/seed-test routes).
 *
 * Flow:
 *   tracker (text/plain beacon)
 *     → n8n Webhook POST /webhook/reece-track   (responds 200 immediately)
 *     → n8n HTTP Request forwards the whole webhook item (body + headers)
 *     → POST /n8n/site/collect  (this module)
 *         · parse $json.body as JSON if it arrived as text
 *         · fold client IP (x-forwarded-for, first hop) into raw.ip
 *           (the 025 table has no ip column — IP rides inside raw, preserving
 *            the secondary-signal design intent)
 *         · whitelist/coerce to the 025 columns and insert via the
 *           service-role client (parameterized — no string interpolation)
 *
 * Beacon contract: fire-and-forget, write-only to the one table, never throws
 * on a bad field, always answers 200. A malformed payload is skipped, not fatal.
 */

import supabase from './supabase.js';

// Only the event types the tracker emits (pageview | identify | event). Anything
// else is dropped so a stray/forged event_type can't pollute the table.
const ALLOWED_EVENT_TYPES = new Set(['pageview', 'identify', 'event']);

// Length-guarded string coercion for the text columns.
const str = (v) => (v == null ? null : String(v).slice(0, 2000));

// First hop of x-forwarded-for is the real client; the rest is the proxy chain.
function firstIp(xff) {
  if (!xff) return null;
  return String(xff).split(',')[0].trim() || null;
}

/**
 * Insert one tracker event. `envelope` is the forwarded n8n webhook item:
 *   { body: <event payload obj|string>, headers: {...}, query, params, ... }
 * Also tolerates being handed the bare event payload directly.
 * Returns a small status object; never throws.
 */
export async function collectEvent(envelope) {
  if (!supabase) return { ok: false, error: 'supabase_not_configured' };

  // The tracker sends text/plain, so the body can arrive as a JSON string.
  let evt = (envelope && typeof envelope === 'object' && 'body' in envelope)
    ? envelope.body
    : envelope;
  if (typeof evt === 'string') {
    try { evt = JSON.parse(evt); } catch { evt = {}; }
  }
  evt = (evt && typeof evt === 'object') ? evt : {};

  const event_type = ALLOWED_EVENT_TYPES.has(evt.event_type) ? evt.event_type : null;
  const visitor_id = str(evt.visitor_id);
  if (!event_type || !visitor_id) {
    return { ok: false, skipped: true, reason: 'missing_event_type_or_visitor_id' };
  }

  // raw = full client payload object; fold in the client IP as a secondary signal.
  const raw = (evt.raw && typeof evt.raw === 'object') ? { ...evt.raw } : {};
  const ip = firstIp(
    (envelope && envelope.headers && envelope.headers['x-forwarded-for']) || envelope?.ip
  );
  if (ip) raw.ip = ip;

  const row = {
    event_type,
    visitor_id,
    session_id: str(evt.session_id),
    page_path: str(evt.page_path),
    utm_source: str(evt.utm_source),
    fbclid: str(evt.fbclid),
    identity_email: evt.identity_email ? String(evt.identity_email).trim().toLowerCase().slice(0, 320) : null,
    identity_phone: str(evt.identity_phone),
    raw,
  };

  const { error } = await supabase.from('site_events').insert(row);
  if (error) {
    console.error(`[I.TRACK] insert failed: ${error.message}`);
    return { ok: false, error: error.message };
  }
  return { ok: true, event_type, visitor_id };
}

// ─── Route ─────────────────────────────────────────────────────────────────
export function registerSiteCollectRoutes(app) {
  // POST /n8n/site/collect — beacon ingest forwarded by the I.TRACK n8n webhook.
  // No auth, matches the /n8n/site/* surface. Always 200 — a bad payload must
  // never turn into a client-visible beacon error.
  app.post('/n8n/site/collect', async (req, res) => {
    try {
      const result = await collectEvent(req.body || {});
      res.status(200).json(result);
    } catch (err) {
      console.error(`[I.TRACK] collect unhandled: ${err.message}`);
      res.status(200).json({ ok: false, error: err.message });
    }
  });

  console.log('[REST API] Registered: POST /n8n/site/collect');
}
