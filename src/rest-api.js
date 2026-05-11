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
 *   POST /webhook/ghl-event                      — GHL→Agentic handoff (Webhook Bridge, no auth)
 */

import supabase from './supabase.js';
import crypto from 'crypto';
import { registerCallbackMessageRoutes } from './agentic-callback-message.js';
import { registerNurtureRoutes } from './nurture/nurture-orchestrator.js';
import { registerEngagementRoutes } from './nurture/nurture-engagement.js';

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
