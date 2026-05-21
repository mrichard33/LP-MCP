/**
 * REST API for GHL Agent Studio — src/rest-api.js
 *
 * Lightweight REST endpoints that wrap Supabase queries so GHL Agent Studio
 * API call nodes can fetch LP data without speaking MCP protocol.
 *
 * Routes:
 *   GET /api/prospects/:prospectId               — LP prospect by cst_id
 *   GET /api/leads/:leadId                       — LP lead by lds_id
 *   GET /api/search?phone=...                    — Search by phone (E.164 or digits)
 *   GET /api/search?ghlContactId=...             — Search by GHL contact ID
 *   GET /api/search?email=...                    — Search by email
 *   GET /api/search?name=...                     — Search by name (first or last)
 *   GET /api/lead-summary/:contactId             — Full lead intelligence summary
 *   GET /api/service-area/lookup?zip=...         — Map zip → market + service phone (no auth)
 *   POST /api/service-area/lookup                — Same, with {"zip": "..."} JSON body (no auth)
 *   POST /api/agentic/dynamic-callback-message   — AI-generated SMS for HDL.2 (no auth)
 *   POST /api/agentic/nurture/generate           — Outbound nurture generator (S4.5 v2)
 *   POST /api/agentic/messages/engagement        — Email engagement events (§12.3)
 *   POST /api/agentic/notifications/appointment  — Calendar-agnostic GroupMe alerts (cancelled/rescheduled, v1)
 *   POST /api/agentic/notifications/contract-cancellation — Post-demo contract-cancellation email (v1, email-only)
 *   POST /api/agentic/notifications/engagement   — Notification engagement stub (v1)
 *   POST /webhook/ghl-event                      — GHL→Agentic handoff (Webhook Bridge, no auth)
 *   GET  /api/lookup/lp-lead?lead_id=...         — LP lead name + contact info lookup (no auth, cache + LP API live)
 *   POST /api/lookup/lp-lead                     — Same, with JSON body (no auth)
 */

import supabase from './supabase.js';
import crypto from 'crypto';
import { registerCallbackMessageRoutes } from './agentic-callback-message.js';
import { registerNurtureRoutes } from './nurture/nurture-orchestrator.js';
import { registerEngagementRoutes } from './nurture/nurture-engagement.js';
import { registerAppointmentNotificationRoutes } from './notifications/appointment-notifications.js';
import { registerContractCancellationNotificationRoutes } from './notifications/cancellation-notifications.js';

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK SIGNATURE VERIFICATION (optional but recommended)
// ═══════════════════════════════════════════════════════════════════

/**
 * Verifies HMAC-SHA256 signature from GHL Custom Webhook.
 * If WEBHOOK_SECRET is not set, verification is skipped (open mode).
 * Header: x-webhook-signature: sha256=<hex>
 */
function verifyWebhookSignature(req) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true; // No secret configured — open mode

  const signature = req.headers['x-webhook-signature'];
  if (!signature) return false;

  const body = JSON.stringify(req.body);
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ═══════════════════════════════════════════════════════════════════
// SERVICE AREA LOOKUP — shared handler for GET + POST
// ═══════════════════════════════════════════════════════════════════
//
// Maps a US zip code to the right Reece service market + dispatch phone.
// Backed by service_area_zips (1,060 zips) joined to service_markets (10 rows).
// Falls back to GENERAL ((954) 800-8906) if the zip isn't in the table or
// no zip is supplied at all.
//
// Used by HDL.2 (Customer Service Handler) Step 4: Custom Webhook step
// reads the contact's postal_code, calls this endpoint, saves the response
// to contact custom fields, then HDL.2 routes via market_code IF/ELSE.
//
// Response contract (always 200 — never errors out, since downstream GHL
// workflow can't gracefully handle 4xx/5xx without a fallback branch):
// {
//   "matched":             true|false,    // true if zip found in table
//   "zip":                 "33312",       // echoed back (or null)
//   "market_code":         "FTLAU",       // always set
//   "market_name":         "Ft. Lauderdale",
//   "service_phone":       "(754) 203-9190",
//   "service_phone_e164":  "+17542039190",
//   "has_dedicated_phone": true|false,
//   "city":                "Fort Lauderdale",   // null if unmatched
//   "county":              "Broward",            // null if unmatched
//   "lookup_method":       "zip" | "fallback"
// }
async function serviceAreaLookupHandler(req, res) {
  try {
    // Extract zip from query (GET) or JSON body (POST). Tolerate empty strings.
    const rawZip = (req.query?.zip ?? req.body?.zip ?? '').toString().trim();

    // Normalize: strip non-digits, keep first 5 (handles "33312-1234" → "33312")
    const zip = rawZip.replace(/\D/g, '').slice(0, 5);

    // ─── Fallback when no zip supplied ────────────────────────
    if (!zip || zip.length < 5) {
      const { data: fallback } = await supabase
        .from('service_markets')
        .select('*')
        .eq('market_code', 'GENERAL')
        .maybeSingle();

      return res.json({
        matched: false,
        zip: rawZip || null,
        market_code: fallback?.market_code || 'GENERAL',
        market_name: fallback?.market_name || 'General / Out-of-mapped-area fallback',
        service_phone: fallback?.service_phone || '(954) 800-8906',
        service_phone_e164: fallback?.service_phone_e164 || '+19548008906',
        has_dedicated_phone: fallback?.has_dedicated_phone ?? false,
        city: null,
        county: null,
        lookup_method: 'fallback',
        reason: 'no_zip_supplied',
      });
    }

    // ─── Look up zip in service_area_zips ─────────────────────
    const { data: zipRow, error: zipErr } = await supabase
      .from('service_area_zips')
      .select('zip, city, county, market_code')
      .eq('zip', zip)
      .maybeSingle();

    if (zipErr) {
      console.error('[ServiceArea] zip lookup error:', zipErr.message);
      // Fall through to GENERAL on DB error — never break HDL.2
    }

    // ─── If zip not in table, return GENERAL ─────────────────
    if (!zipRow) {
      const { data: fallback } = await supabase
        .from('service_markets')
        .select('*')
        .eq('market_code', 'GENERAL')
        .maybeSingle();

      return res.json({
        matched: false,
        zip,
        market_code: fallback?.market_code || 'GENERAL',
        market_name: fallback?.market_name || 'General / Out-of-mapped-area fallback',
        service_phone: fallback?.service_phone || '(954) 800-8906',
        service_phone_e164: fallback?.service_phone_e164 || '+19548008906',
        has_dedicated_phone: fallback?.has_dedicated_phone ?? false,
        city: null,
        county: null,
        lookup_method: 'fallback',
        reason: 'zip_not_in_service_area',
      });
    }

    // ─── Resolve market metadata ─────────────────────────────
    const { data: market, error: marketErr } = await supabase
      .from('service_markets')
      .select('*')
      .eq('market_code', zipRow.market_code)
      .maybeSingle();

    if (marketErr || !market) {
      console.error(`[ServiceArea] market lookup failed for ${zipRow.market_code}:`, marketErr?.message);
      // Should never happen if FK integrity holds — fall back to GENERAL
      return res.json({
        matched: false,
        zip,
        market_code: 'GENERAL',
        market_name: 'General / Out-of-mapped-area fallback',
        service_phone: '(954) 800-8906',
        service_phone_e164: '+19548008906',
        has_dedicated_phone: false,
        city: zipRow.city || null,
        county: zipRow.county || null,
        lookup_method: 'fallback',
        reason: 'market_metadata_missing',
      });
    }

    // ─── Happy path ──────────────────────────────────────────
    res.json({
      matched: true,
      zip,
      market_code: market.market_code,
      market_name: market.market_name,
      service_phone: market.service_phone,
      service_phone_e164: market.service_phone_e164,
      has_dedicated_phone: market.has_dedicated_phone,
      city: zipRow.city,
      county: zipRow.county,
      lookup_method: 'zip',
    });

  } catch (err) {
    console.error('[ServiceArea] Unhandled error:', err.message);
    // Even on uncaught error, return a usable fallback so HDL.2 doesn't break
    res.json({
      matched: false,
      zip: null,
      market_code: 'GENERAL',
      market_name: 'General / Out-of-mapped-area fallback',
      service_phone: '(954) 800-8906',
      service_phone_e164: '+19548008906',
      has_dedicated_phone: false,
      city: null,
      county: null,
      lookup_method: 'fallback',
      reason: 'internal_error',
      error: err.message,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// LP LEAD LOOKUP — name + contact-info enrichment for GHL workflows
// ═══════════════════════════════════════════════════════════════════
//
// Built 2026-05-21 because the LP Inbound Webhook (workflow 7f24f79d)
// payload sometimes arrives without first_name / last_name set. When
// the GHL Contact Not Found branch tries to create a contact, missing
// names break Create Contact + downstream personalization.
//
// USAGE FROM GHL: Custom Webhook step in the Contact Not Found branch,
// gated by an IF/ELSE that checks whether the inbound webhook already
// has names. POST JSON body OR GET query with one of:
//   - lead_id      (LP lds_id — PRIMARY, most reliable)
//   - prospect_id  (LP cst_id — fallback)
//   - phone        (digits or formatted — last-resort fallback)
//
// LOOKUP STRATEGY:
//   1. Try Supabase lp_leads cache (fast, ~50ms). Skip if not present
//      or missing names.
//   2. Fall back to LP API live via getLeadByLdsId / getLead /
//      getCustomers3. ~500-2000ms cold, but always current.
//
// RESPONSE CONTRACT (always 200 — never throws to GHL):
//   {
//     found: true|false,
//     first_name: "John",         // empty string if not found
//     last_name: "Smith",
//     email: "...",
//     phone: "5551234567",
//     address1: "123 Main St",
//     city: "...",
//     state: "FL",
//     zip: "33301",
//     lead_id: "12345",           // echoed back
//     prospect_id: "67890",
//     source: "cache" | "live_api" | null,
//     lookup_method: "lead_id" | "prospect_id" | "phone" | "none",
//     reason: "..."               // only when found=false
//   }
//
// Empty strings (not nulls) are returned for missing fields so GHL's
// IF/ELSE conditions ("field has value") behave predictably.
async function lpLeadLookupHandler(req, res) {
  const src = { ...(req.query || {}), ...(req.body || {}) };

  // Accept the naming conventions GHL LP webhooks tend to use.
  const leadId = String(src.lead_id || src.leadId || src.lds_id || src.ldsId || '').trim();
  const prospectId = String(src.prospect_id || src.prospectId || src.cst_id || src.cstId || src.prospect_number || src.prospectNumber || '').trim();
  const phoneRaw = String(src.phone || '').trim();
  const phoneDigits = phoneRaw.replace(/\D/g, '');

  // Always-200 empty response shape used by every miss path.
  const emptyResponse = (reason, lookupMethod = 'none') => ({
    found: false,
    first_name: '',
    last_name: '',
    email: '',
    phone: phoneDigits || '',
    address1: '',
    city: '',
    state: '',
    zip: '',
    lead_id: leadId || '',
    prospect_id: prospectId || '',
    source: null,
    lookup_method: lookupMethod,
    reason,
  });

  // Map a normalized record to the response contract. Accepts either a
  // cache row (lp_leads) or a prospect-level LP API record (post-unwrap).
  const toResponse = (rec, source, lookupMethod) => {
    const get = (...names) => {
      for (const n of names) {
        const v = rec?.[n];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v);
      }
      return '';
    };
    return {
      found: true,
      first_name: get('first_name', 'firstname', 'FirstName'),
      last_name: get('last_name', 'lastname', 'LastName'),
      email: get('email', 'Email'),
      phone: get('phone', 'phone1', 'Phone1', 'Phone'),
      address1: get('address', 'address1', 'Address1'),
      city: get('city', 'City'),
      state: get('state', 'State'),
      zip: get('zip', 'Zip'),
      lead_id: get('lp_lead_id', 'lds_id', 'LeadID', 'id') || leadId || '',
      prospect_id: get('lp_prospect_id', 'cst_id', 'CstID', 'ProspectID') || prospectId || '',
      source,
      lookup_method: lookupMethod,
    };
  };

  if (!leadId && !prospectId && !phoneDigits) {
    return res.json(emptyResponse('no_lookup_key_supplied'));
  }

  try {
    // ───── Tier 1: Supabase cache (lp_leads) ─────────────────────
    // Fast path. The cache is populated by incremental sync, so brand-
    // new LP leads may not be here yet — we fall through to LP API
    // in that case.
    let cacheRow = null;
    if (leadId) {
      const { data } = await supabase.from('lp_leads').select('*').eq('lp_lead_id', leadId).maybeSingle();
      if (data) cacheRow = data;
    }
    if (!cacheRow && prospectId) {
      const { data } = await supabase.from('lp_leads').select('*').eq('lp_prospect_id', prospectId).order('synced_at', { ascending: false }).limit(1).maybeSingle();
      if (data) cacheRow = data;
    }
    if (!cacheRow && phoneDigits && phoneDigits.length >= 10) {
      const last10 = phoneDigits.slice(-10);
      const { data } = await supabase.from('lp_leads').select('*').or(`phone.ilike.%${last10}%,phone_alt.ilike.%${last10}%`).order('synced_at', { ascending: false }).limit(1).maybeSingle();
      if (data) cacheRow = data;
    }

    if (cacheRow && (cacheRow.first_name || cacheRow.last_name)) {
      const method = leadId ? 'lead_id' : (prospectId ? 'prospect_id' : 'phone');
      const result = toResponse(cacheRow, 'cache', method);
      console.log(`[LP Lead Lookup] HIT via ${method} (cache): lead_id=${leadId || '?'}, name=${result.first_name} ${result.last_name}`);
      return res.json(result);
    }

    // ───── Tier 2: LP API live ───────────────────────────────────
    // Lazy import to avoid loading lp-client when this route isn't hit.
    const { getLeadByLdsId, getLead, getCustomers3 } = await import('./lp-client.js');

    const unwrap = (resp) => {
      if (!resp) return [];
      if (Array.isArray(resp)) return resp;
      if (typeof resp === 'object') return resp.data || resp.leads || resp.results || resp.items || [];
      return [];
    };

    let prospect = null;
    let method = 'none';

    if (leadId) {
      try {
        const resp = await getLeadByLdsId(leadId);
        const items = unwrap(resp);
        if (items.length > 0) { prospect = items[0]; method = 'lead_id'; }
      } catch (err) {
        console.warn('[LP Lead Lookup] getLeadByLdsId failed:', err.message);
      }
    }

    if (!prospect && prospectId) {
      try {
        const resp = await getLead(prospectId);
        const items = unwrap(resp);
        if (items.length > 0) { prospect = items[0]; method = 'prospect_id'; }
      } catch (err) {
        console.warn('[LP Lead Lookup] getLead failed:', err.message);
      }
    }

    if (!prospect && phoneDigits && phoneDigits.length >= 10) {
      try {
        const resp = await getCustomers3({ phone: phoneDigits.slice(-10) });
        const items = unwrap(resp);
        if (items.length > 0) { prospect = items[0]; method = 'phone'; }
      } catch (err) {
        console.warn('[LP Lead Lookup] getCustomers3 failed:', err.message);
      }
    }

    if (!prospect) {
      return res.json(emptyResponse('no_match_in_lp_api', method));
    }

    const result = toResponse(prospect, 'live_api', method);
    console.log(`[LP Lead Lookup] HIT via ${method} (live): lead_id=${leadId || '?'}, name=${result.first_name} ${result.last_name}`);
    return res.json(result);

  } catch (err) {
    console.error('[LP Lead Lookup] Unhandled error:', err.message);
    return res.json(emptyResponse('internal_error_' + err.message.slice(0, 80)));
  }
}

export function registerRestApiRoutes(app, authenticate) {

  // ═══════════════════════════════════════════════════════════════
  // POST /webhook/ghl-event — GHL → Agentic Layer Handoff
  // ═══════════════════════════════════════════════════════════════
  //
  // This is the universal entry point for GHL workflows to hand off
  // decision-making to the LP MCP agentic layer. GHL workflows POST
  // a JSON payload with contact data + trigger context. This endpoint
  // creates a system_event and returns immediately. The Decision Engine
  // picks it up on the next cron cycle.
  //
  // Payload contract:
  // {
  //   "contact_id":      "GHL contact ID",
  //   "contact_name":    "Full name",
  //   "contact_phone":   "Phone",
  //   "contact_email":   "Email",
  //   "lp_lead_id":      "LP lead ID (if known)",
  //   "entry_source":    "entry:tag value",
  //   "current_tags":    "comma-separated tag string or array",
  //   "trigger_context": "appointment_booked | disposition_changed | stage_advanced | ...",
  //   "calendar_name":   "Calendar name (for appointment events)",
  //   "appointment_date": "YYYY-MM-DD",
  //   "appointment_time": "HH:MM AM/PM",
  //   ...any additional fields specific to the trigger
  // }
  //
  // Returns: { received: true, event_id: <id> }
  //
  app.post('/webhook/ghl-event', async (req, res) => {
    try {
      // ─── Signature verification ────────────────────────────
      if (!verifyWebhookSignature(req)) {
        console.warn('[Webhook] Invalid signature — rejected');
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }

      const payload = req.body;
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'Request body must be JSON' });
      }

      const contactId = payload.contact_id || payload.contactId || '';
      const triggerContext = payload.trigger_context || payload.triggerContext || 'unknown';
      const lpLeadId = payload.lp_lead_id || payload.lpLeadId || null;

      if (!contactId && !lpLeadId) {
        return res.status(400).json({ error: 'Either contact_id or lp_lead_id is required' });
      }

      // ─── Build event_subtype from trigger context ──────────
      const subtypeMap = {
        'appointment_booked': 'appt:booked',
        'appointment_cancelled': 'appt:cancelled',
        'appointment_rescheduled': 'appt:rescheduled',
        'appointment_completed': 'appt:completed',
        'appointment_no_show': 'appt:no_show',
        'disposition_changed': 'lp:disposition',
        'stage_advanced': 'pipeline:advanced',
        'tag_added': 'contact:tag_added',
        'reply_received': 'contact:reply',
        'booking_requested': 'appt:booking_requested',
      };
      const eventSubtype = subtypeMap[triggerContext] || triggerContext;

      // ─── Dedup key: prevent duplicate events from GHL retries ──
      const idempotencyKey = `ghl_${contactId || lpLeadId}_${triggerContext}_${Math.floor(Date.now() / 60000)}`;

      // ─── Check for duplicate (same key within last 5 min) ──
      const { data: existing } = await supabase
        .from('system_events')
        .select('id')
        .eq('idempotency_key', idempotencyKey)
        .limit(1);

      if (existing && existing.length > 0) {
        console.log(`[Webhook] Dedup: event already exists for ${idempotencyKey}`);
        return res.json({ received: true, event_id: existing[0].id, deduplicated: true });
      }

      // ─── Create system_event ───────────────────────────────
      const { data: event, error } = await supabase
        .from('system_events')
        .insert({
          event_type: 'ghl.workflow_handoff',
          event_subtype: eventSubtype,
          source: 'ghl',
          entity_type: 'contact',
          entity_id: contactId || lpLeadId,
          ghl_contact_id: contactId || null,
          lp_lead_id: lpLeadId || null,
          payload: payload,
          priority: triggerContext.includes('appointment') ? 'high' : 'normal',
          idempotency_key: idempotencyKey,
          event_timestamp: new Date().toISOString(),
        })
        .select('id')
        .single();

      if (error) {
        console.error('[Webhook] Event creation failed:', error.message);
        return res.status(500).json({ error: 'Failed to create event', detail: error.message });
      }

      console.log(`[Webhook] ✅ Event ${event.id} created: ${triggerContext} for ${contactId || lpLeadId}`);
      res.json({ received: true, event_id: event.id, trigger_context: triggerContext });

    } catch (err) {
      console.error('[Webhook] Unhandled error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[Webhook] Registered: POST /webhook/ghl-event');

  // ═══════════════════════════════════════════════════════════════
  // /api/service-area/lookup — Zip → Market routing for HDL.2
  // ═══════════════════════════════════════════════════════════════
  // No auth: this is non-sensitive zip→phone mapping; called by GHL
  // Custom Webhook step which can't easily pass auth tokens.
  // Both GET (zip in querystring) and POST (zip in JSON body) supported.
  app.get('/api/service-area/lookup', serviceAreaLookupHandler);
  app.post('/api/service-area/lookup', serviceAreaLookupHandler);
  console.log('[REST API] Registered: GET+POST /api/service-area/lookup (no-auth, HDL.2 routing)');

  // ═══════════════════════════════════════════════════════════════
  // /api/lookup/lp-lead — LP lead name/contact lookup for GHL workflows
  // ═══════════════════════════════════════════════════════════════
  // No auth. Called by the GHL Custom Webhook step in the LP Inbound
  // Webhook workflow's Contact Not Found branch when the inbound
  // payload is missing first_name / last_name. See lpLeadLookupHandler
  // above for the full contract.
  app.get('/api/lookup/lp-lead', lpLeadLookupHandler);
  app.post('/api/lookup/lp-lead', lpLeadLookupHandler);
  console.log('[REST API] Registered: GET+POST /api/lookup/lp-lead (no-auth, GHL Create-Contact name fallback)');

  // ═══════════════════════════════════════════════════════════════
  // POST /api/agentic/dynamic-callback-message — Dynamic SMS for HDL.2
  // ═══════════════════════════════════════════════════════════════
  // Generates a context-aware SMS handoff message via Claude. Replaces
  // the two static SMS templates that lived in HDL.2 (within-hours and
  // after-hours). Always returns 200 — falls back to a static template
  // body if the AI path fails so the workflow keeps moving. See
  // agentic-callback-message.js for the full contract and prompt.
  registerCallbackMessageRoutes(app);

  // ═══════════════════════════════════════════════════════════════
  // POST /api/agentic/nurture/generate — Outbound nurture message
  // ═══════════════════════════════════════════════════════════════
  // Generates outbound Seinfeld-style nurture content for the S4.5 v2
  // GHL workflow (and future workflow codes). Runs the full 8-step
  // pipeline (context → interrupts → prompt selection → generation →
  // hard blockers → judge score → GHL writeback → audit). Always
  // returns 200; the send_ready boolean signals whether the gate was
  // flipped. See src/nurture/nurture-orchestrator.js for the contract.
  registerNurtureRoutes(app);

  // ═══════════════════════════════════════════════════════════════
  // POST /api/agentic/messages/engagement — Email engagement events
  // ═══════════════════════════════════════════════════════════════
  // §12.3 of the S4.5 v1.0 architecture spec. Receives email open,
  // click, reply, unsubscribe, and booking-attribution events from a
  // GHL Tier 1 webhook workflow and idempotently writes them to
  // agentic_messages. First-touch wins. Drives every §14 learning
  // loop (prompt performance review, confidence threshold
  // calibration, story-arc deployment validation). Always 200.
  // See src/nurture/nurture-engagement.js for the contract.
  registerEngagementRoutes(app);

  // ═══════════════════════════════════════════════════════════════
  // POST /api/agentic/notifications/appointment — GHL email + SMS
  // ═══════════════════════════════════════════════════════════════
  // Calendar-agnostic endpoint that any GHL appointment workflow can
  // fire the same Layer-3 webhook config at. Pulls per-contact LIVE
  // intelligence from LP MCP services + aggregate analytics from
  // Supabase, generates BOTH an email body and an SMS body via
  // Claude (one structured call), and writes them back to GHL in
  // strict order: body+sms+id in one PATCH, then
  // team_notification_ready = "Yes" as the separate, final atomic
  // gate. The GHL workflow's wait-for-condition step reads
  // team_notification_ready and proceeds to its already-wired
  // internal_notification (email + SMS) steps, which render the two
  // bodies as merge tags. This endpoint never posts to GroupMe; the
  // existing GroupMe pipeline (src/groupme.js) is unrelated.
  //
  // v1 whitelist: status ∈ { cancelled, rescheduled }. Adding more
  // statuses (booked, confirmed) is a one-line change to
  // ENABLED_NOTIFICATION_STATUSES in notifications/appointment-
  // notifications.js. Feature-flagged via
  // ENABLE_ENHANCED_APPT_NOTIFICATIONS env var (returns 503 when not
  // 'true' so the workflow's 30-min timeout fires the fallback).
  registerAppointmentNotificationRoutes(app);

  // ═══════════════════════════════════════════════════════════════
  // POST /api/agentic/notifications/contract-cancellation — Email only
  // ═══════════════════════════════════════════════════════════════
  // Receives a webhook from the GHL "Post-Demo Cancellation Routing"
  // workflow (id 1da073c9-c8f8-46a1-932b-248547c91060). Pulls per-
  // contact LIVE intelligence (decoded contact + LP lead summary +
  // unified timeline + resolved prospect id), generates an email body
  // via Claude (single call, JSON output), and writes it back to GHL
  // in strict order: team_notification_body + team_notification_id +
  // sms-cleared-to-empty in PATCH 1, then team_notification_ready =
  // "Yes" as the separate atomic gate in PATCH 2. A fire-and-forget
  // tag poke (notif-ready-poke) fires ~2s later to force the GHL
  // wait-for-condition step to re-evaluate.
  //
  // EMAIL ONLY — no SMS. Contract cancellation is a lower-volume,
  // higher-stakes event handled by a single assigned user (Shaina) +
  // CC'd manager (Edwin), so SMS would be noise. The workflow's
  // Internal Notification step uses {{contact.team_notification_body}}
  // + the {{trigger_link.ihTBLwptOxJMIbpCDEH7}} ("Open Contact in
  // Lead Perfection") trigger link directly in the email template;
  // the agentic body content does NOT need to include the link itself.
  //
  // Feature-flagged via ENABLE_CONTRACT_CANCELLATION_NOTIFICATIONS
  // (defaults TRUE; set to 'false' explicitly to disable and let the
  // workflow's 30-min timeout fire the fallback branch). Auth: Bearer
  // MESSAGE_ENGINE_TOKEN, same as appointment notifications. v1 event
  // whitelist: { contract_cancellation_requested }. Adding new event
  // types is a one-line change to ENABLED_EVENT_TYPES in
  // notifications/cancellation-notifications.js.
  registerContractCancellationNotificationRoutes(app);

  // ─── GET /api/prospects/:prospectId ────────────────────────────
  // Returns all leads for an LP prospect (cst_id)
  app.get('/api/prospects/:prospectId', authenticate, async (req, res) => {
    try {
      const { prospectId } = req.params;
      if (!prospectId) return res.status(400).json({ error: 'prospectId is required' });

      const { data, error } = await supabase
        .from('lp_leads')
        .select('*')
        .eq('lp_prospect_id', prospectId)
        .order('synced_at', { ascending: false });

      if (error) return res.status(500).json({ error: error.message });
      if (!data || data.length === 0) return res.status(404).json({ error: 'No leads found for prospect', prospectId, match_count: 0 });

      res.json({ match_count: data.length, best_match: data[0], all_leads: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/leads/:leadId ────────────────────────────────────
  // Returns a single LP lead by lds_id
  app.get('/api/leads/:leadId', authenticate, async (req, res) => {
    try {
      const { leadId } = req.params;
      if (!leadId) return res.status(400).json({ error: 'leadId is required' });

      const { data, error } = await supabase
        .from('lp_leads')
        .select('*')
        .eq('lp_lead_id', leadId)
        .maybeSingle();

      if (error) return res.status(500).json({ error: error.message });
      if (!data) return res.status(404).json({ error: 'Lead not found', leadId, match_count: 0 });

      res.json({ match_count: 1, best_match: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/search?phone=...&ghlContactId=...&email=...&name=... ─
  // Multi-field search — returns matching LP leads
  app.get('/api/search', authenticate, async (req, res) => {
    try {
      const { phone, ghlContactId, email, name } = req.query;

      if (!phone && !ghlContactId && !email && !name) {
        return res.status(400).json({ error: 'At least one search param required: phone, ghlContactId, email, or name' });
      }

      let query = supabase.from('lp_leads').select('*');

      if (ghlContactId) {
        query = query.eq('ghl_contact_id', ghlContactId);
      } else if (phone) {
        // Strip to digits for flexible matching
        const digits = phone.replace(/\D/g, '');
        const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
        // Try exact match first, then partial
        query = query.or(`phone.ilike.%${last10}%,phone_alt.ilike.%${last10}%`);
      } else if (email) {
        query = query.ilike('email', `%${email}%`);
      } else if (name) {
        query = query.or(`first_name.ilike.%${name}%,last_name.ilike.%${name}%`);
      }

      query = query.order('synced_at', { ascending: false }).limit(10);
      const { data, error } = await query;

      if (error) return res.status(500).json({ error: error.message });
      if (!data || data.length === 0) {
        return res.json({ match_count: 0, best_match: null, all_leads: [], search_params: { phone, ghlContactId, email, name } });
      }

      res.json({ match_count: data.length, best_match: data[0], all_leads: data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── GET /api/lead-summary/:contactId ──────────────────────────
  // Full intelligence summary: LP lead + jobs + milestones + call logs + intent
  app.get('/api/lead-summary/:contactId', authenticate, async (req, res) => {
    try {
      const { contactId } = req.params;
      if (!contactId) return res.status(400).json({ error: 'contactId is required' });

      // Get LP lead
      const { data: leads } = await supabase
        .from('lp_leads')
        .select('*')
        .eq('ghl_contact_id', contactId)
        .order('synced_at', { ascending: false })
        .limit(1);

      const lead = leads?.[0] || null;

      // Get lead intelligence
      const { data: intel } = await supabase
        .from('lead_intelligence')
        .select('*')
        .eq('ghl_contact_id', contactId)
        .maybeSingle();

      // Get jobs if LP lead found
      let jobs = [];
      if (lead?.lp_lead_id) {
        const { data: j } = await supabase
          .from('lp_jobs')
          .select('*')
          .eq('lp_lead_id', lead.lp_lead_id);
        jobs = j || [];
      }

      // Get recent call logs
      let calls = [];
      if (lead?.lp_lead_id) {
        const { data: c } = await supabase
          .from('lp_call_logs')
          .select('*')
          .eq('lp_lead_id', lead.lp_lead_id)
          .order('call_date', { ascending: false })
          .limit(10);
        calls = c || [];
      }

      if (!lead && !intel) {
        return res.status(404).json({ error: 'No LP or intelligence data found', contactId });
      }

      res.json({
        contactId,
        lp_lead: lead,
        intelligence: intel ? {
          intent_score: intel.intent_score,
          intent_tier: intel.intent_tier,
          buyer_stage: intel.buyer_stage,
          primary_objection: intel.primary_objection,
          recommended_approach: intel.recommended_approach,
          spike_count: intel.spike_count,
          engagement_count: intel.engagement_count,
          last_engagement: intel.last_engagement_at,
        } : null,
        jobs,
        recent_calls: calls,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('[REST API] Registered: GET /api/prospects/:id | /api/leads/:id | /api/search | /api/lead-summary/:contactId');
}
