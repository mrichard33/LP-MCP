/**
 * Behavioral Event Emitter — src/behavioral-emitter.js
 * 
 * Layer 3 component. Receives GHL webhooks for behavioral signals
 * and emits typed system events into the Decision Engine pipeline.
 * 
 * Webhook endpoints:
 *   POST /webhook/ghl/reply            — Inbound SMS/email replies
 *   POST /webhook/ghl/appointment      — Appointment created/updated/deleted
 *   POST /webhook/ghl/engagement       — Email opened, link clicked, VSL watched
 *   POST /webhook/ghl/lead-score       — Lead score threshold crossed
 *   POST /webhook/ghl/workflow         — Workflow completed
 *   POST /webhook/ghl/contact-created  — New contact created in GHL
 * 
 * Security: All endpoints validate GHL_WEBHOOK_SECRET.
 *
 * v2.4 — /webhook/ghl/lead-score self-enriches via GHL API.
 *   GHL's {{contact.engagement_score}} merge field doesn't resolve in
 *   webhook template variables — always sends 0. The actual score lives
 *   in the GHL API at contact.scoring: { "<profileId>": <score> }.
 *   handleLeadScore now calls fetchGHLContact() to get the real score
 *   and computes delta from lead_intelligence previous value.
 *
 * v2.3.1 — /webhook/ghl/contact-created self-enriches via GHL API.
 *   GHL standard webhooks send template variables as flat strings,
 *   not raw JSON. Tags arrive as comma-separated strings, not arrays.
 *   Instead of relying on GHL to send structured data, the endpoint:
 *     1. Accepts just contactId (+ optional fields from webhook body)
 *     2. Calls GHL API to fetch the full contact (tags, source, name)
 *     3. Resolves entry_source from GHL API tags (most reliable)
 *     4. Falls back to webhook body fields if GHL API fails
 *
 * v2.3 — Add /webhook/ghl/contact-created endpoint.
 *   Resolves entry_source from active-entry:* tags, explicit fields,
 *   or GHL source. Emits ghl.contact_created for Decision Engine routing.
 *   This is Gap 1 from the agentic migration audit — prerequisite for
 *   W0.0 Master Router migration.
 *
 * v2.2 — Fix duplicate GroupMe notifications.
 *   - handleAppointment idempotency key now uses 30-min buckets (was Date.now())
 *   - 'confirmed' status now emits ghl.appointment_confirmed (was ghl.appointment_booked)
 *   - 'rescheduled' status now emits ghl.appointment_rescheduled
 *   Both fixes prevent Rule 82 from firing duplicate notifications.
 *
 * v2.1 — handleAppointment now extracts startDate and passes all extra
 *   body fields through to the event payload. Filters literal "null"
 *   string values that GHL sends when template variables don't resolve.
 */

import { emitEvent } from './event-emitter.js';
import { upsertLeadIntelligence } from './context-builder.js';
import supabase from './supabase.js';

const GHL_WEBHOOK_SECRET = process.env.GHL_WEBHOOK_SECRET || '';
const GHL_API_KEY = process.env.GHL_API_KEY;

function validateWebhook(req) {
  if (!GHL_WEBHOOK_SECRET) return true;
  const provided = req.headers['x-ghl-signature']
    || req.headers['x-webhook-secret']
    || req.query.secret
    || '';
  return provided === GHL_WEBHOOK_SECRET;
}

// ═══════════════════════════════════════════════════════════════════
// DNC / TRIVIAL DETECTION
// ═══════════════════════════════════════════════════════════════════

const DNC_PATTERNS = [
  /\b(stop|unsubscribe|remove me|opt out|opt-out|do not contact|dnc)\b/i,
  /^(stop|end|cancel|quit|remove)\.?$/i,
];

const TRIVIAL_PATTERNS = [
  /^(ok|yes|no|k|yep|nope|sure|thanks|ty|thx|yeah|nah|lol|ha|haha|cool|👍|👎|\.|\?)$/i,
];

function isDNCSignal(text) {
  if (!text) return false;
  return DNC_PATTERNS.some(p => p.test(text.trim()));
}

function isTrivialMessage(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 2) return true;
  return TRIVIAL_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Clean a value from GHL webhook body.
 * GHL sends literal string "null" when a template variable doesn't resolve.
 * Convert these to actual null so downstream code can handle them properly.
 */
function cleanGHLValue(val) {
  if (val === 'null' || val === 'undefined' || val === '') return null;
  return val;
}

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK HANDLERS
// ═══════════════════════════════════════════════════════════════════

async function handleReply(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || body.id || null;
  const messageText = body.body || body.message || body.text || '';
  const messageType = body.messageType || body.type || 'SMS';

  if (!contactId) return res.status(400).json({ error: 'Missing contactId in webhook payload' });
  const trimmed = messageText.trim();

  if (isDNCSignal(trimmed)) {
    await emitEvent({
      event_type: 'ghl.reply_received', event_subtype: 'dnc', source: 'ghl_webhook',
      entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
      payload: { message_text: trimmed, message_type: messageType, engagement_quality: 'dnc', word_count: trimmed.split(/\s+/).length },
      priority: 'critical', idempotency_key: `ghl_reply_dnc_${contactId}_${Date.now()}`,
    });
    console.log(`[BehavioralEmitter] DNC reply from ${contactId}: "${trimmed.slice(0, 50)}"`);
    return res.json({ status: 'accepted', classification: 'dnc' });
  }

  if (isTrivialMessage(trimmed)) {
    try { await upsertLeadIntelligence(contactId, { last_reply_at: new Date().toISOString(), last_engagement_at: new Date().toISOString() }); } catch {}
    await emitEvent({
      event_type: 'ghl.reply_received', event_subtype: 'trivial', source: 'ghl_webhook',
      entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
      payload: { message_text: trimmed, message_type: messageType, engagement_quality: 'neutral', word_count: trimmed.split(/\s+/).length },
      priority: 'low', idempotency_key: `ghl_reply_trivial_${contactId}_${Date.now()}`,
    });
    return res.json({ status: 'accepted', classification: 'trivial' });
  }

  await emitEvent({
    event_type: 'ghl.reply_received', event_subtype: 'pending_analysis', source: 'ghl_webhook',
    entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    payload: { message_text: trimmed, message_type: messageType, word_count: trimmed.split(/\s+/).length },
    priority: 'high', idempotency_key: `ghl_reply_${contactId}_${Date.now()}`,
  });
  console.log(`[BehavioralEmitter] Substantive reply from ${contactId} (${trimmed.split(/\s+/).length} words) → pending AI analysis`);
  return res.json({ status: 'accepted', classification: 'pending_analysis' });
}

/**
 * v2.2: Fixed duplicate notifications.
 * 
 * Two root causes:
 * 1. Idempotency key used Date.now() — every webhook call was unique.
 *    Now uses 30-minute bucket: same contact + calendar + status within
 *    30 minutes = same key = deduped.
 * 
 * 2. 'confirmed' status fell through to ghl.appointment_booked.
 *    Now maps to ghl.appointment_confirmed — Rule 82 only matches
 *    ghl.appointment_booked, so confirmations don't fire duplicate
 *    LP writebacks and GroupMe notifications.
 */
async function handleAppointment(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;
  const calendarId = body.calendarId || body.calendar_id || null;
  const status = (body.status || body.appointmentStatus || '').toLowerCase();

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  // v2.2: Explicit event type mapping — confirmed is NOT a booking
  let eventType;
  if (status === 'cancelled' || status === 'canceled') {
    eventType = 'ghl.appointment_cancelled';
  } else if (status === 'no_show' || status === 'noshow' || status === 'no-show') {
    eventType = 'ghl.appointment_no_show';
  } else if (status === 'confirmed') {
    eventType = 'ghl.appointment_confirmed';
  } else if (status === 'rescheduled') {
    eventType = 'ghl.appointment_rescheduled';
  } else {
    eventType = 'ghl.appointment_booked';
  }

  // v2.1: Extract all appointment fields including startDate.
  const startTime = cleanGHLValue(body.startTime || body.start_time) || null;
  const startDate = cleanGHLValue(body.startDate || body.start_date) || null;
  const endTime = cleanGHLValue(body.endTime || body.end_time) || null;
  const title = cleanGHLValue(body.title || body.name) || null;
  const appointmentId = cleanGHLValue(body.appointmentId || body.appointment_id) || null;
  const contactName = cleanGHLValue(body.contactName || body.contact_name) || null;

  // v2.2: Idempotency key uses 30-minute time buckets instead of Date.now().
  // Same contact + calendar + status within 30 min = deduped.
  const timeBucket = Math.floor(Date.now() / (30 * 60 * 1000));
  const idempotencyKey = `ghl_appt_${contactId}_${calendarId}_${status}_${timeBucket}`;

  await emitEvent({
    event_type: eventType, event_subtype: calendarId || null, source: 'ghl_webhook',
    entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    payload: {
      calendar_id: calendarId,
      status,
      start_time: startTime,
      startDate: startDate,
      end_time: endTime,
      title,
      appointment_id: appointmentId,
      contactName,
    },
    priority: 'high', idempotency_key: idempotencyKey,
  });
  console.log(`[BehavioralEmitter] Appointment ${eventType} for ${contactId} (calendar: ${calendarId}, date: ${startDate}, time: ${startTime}, status: ${status})`);
  return res.json({ status: 'accepted', event_type: eventType });
}

async function handleEngagement(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;
  const signalType = body.type || body.signal_type || 'unknown';

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  let eventType;
  const now = new Date().toISOString();

  switch (signalType) {
    case 'email_opened': {
      eventType = 'ghl.email_opened';
      const { data: current } = await supabase
        .from('lead_intelligence')
        .select('emails_opened')
        .eq('ghl_contact_id', contactId)
        .maybeSingle();
      await upsertLeadIntelligence(contactId, {
        emails_opened: (current?.emails_opened || 0) + 1,
        last_engagement_at: now,
      });
      console.log(`[BehavioralEmitter] Email opened by ${contactId} (total: ${(current?.emails_opened || 0) + 1})`);
      break;
    }

    case 'link_clicked': {
      eventType = 'ghl.link_clicked';
      const { data: current } = await supabase
        .from('lead_intelligence')
        .select('links_clicked')
        .eq('ghl_contact_id', contactId)
        .maybeSingle();
      await upsertLeadIntelligence(contactId, {
        links_clicked: (current?.links_clicked || 0) + 1,
        last_engagement_at: now,
      });
      console.log(`[BehavioralEmitter] Link clicked by ${contactId} (total: ${(current?.links_clicked || 0) + 1})`);
      break;
    }

    case 'vsl_watched': {
      eventType = 'ghl.vsl_watched';
      const percent = parseInt(body.percent || body.watch_percent || '50', 10);
      await upsertLeadIntelligence(contactId, {
        vsl_watched: true,
        vsl_watch_percent: percent,
        last_engagement_at: now,
      });
      console.log(`[BehavioralEmitter] VSL watched by ${contactId} (${percent}%)`);
      break;
    }

    default:
      eventType = 'ghl.engagement_signal';
      console.log(`[BehavioralEmitter] Unknown engagement type "${signalType}" from ${contactId}`);
  }

  await emitEvent({
    event_type: eventType, event_subtype: signalType, source: 'ghl_webhook',
    entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    payload: { signal_type: signalType, url: body.url || null, percent: body.percent || null },
    priority: 'normal', idempotency_key: `ghl_engagement_${contactId}_${signalType}_${Date.now()}`,
  });

  return res.json({ status: 'accepted', event_type: eventType });
}

/**
 * v2.4: Self-enriching lead score handler.
 *
 * GHL's {{contact.engagement_score}} merge field doesn't resolve in
 * webhook template variables — always sends 0/empty. The actual score
 * lives in the GHL API response at contact.scoring: { profileId: score }.
 *
 * Flow:
 *   1. Receive webhook with contactId (score from body is unreliable)
 *   2. Call GHL API to fetch contact.scoring
 *   3. Extract score from first scoring profile
 *   4. Get previous score from lead_intelligence for delta calculation
 *   5. Emit event with real score data
 */
async function handleLeadScore(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  // Self-enrich: fetch real score from GHL API
  const ghlContact = await fetchGHLContact(contactId);

  let score = 0;
  let enrichedVia = 'webhook_body';
  if (ghlContact?.scoring) {
    const profileScores = Object.values(ghlContact.scoring);
    if (profileScores.length > 0 && typeof profileScores[0] === 'number') {
      score = profileScores[0];
      enrichedVia = 'ghl_api';
    }
  }

  // Fallback to body value if API didn't return a score
  if (score === 0 && enrichedVia === 'webhook_body') {
    score = parseInt(body.score || body.lead_score || '0', 10);
  }

  // Get previous score from lead_intelligence for delta calculation
  let previousScore = 0;
  try {
    const { data: intel } = await supabase
      .from('lead_intelligence')
      .select('lead_score')
      .eq('ghl_contact_id', contactId)
      .maybeSingle();
    if (intel?.lead_score != null) previousScore = intel.lead_score;
  } catch {}

  const delta = score - previousScore;

  await upsertLeadIntelligence(contactId, {
    lead_score: score, lead_score_velocity: delta, last_engagement_at: new Date().toISOString(),
  });

  const priority = score >= 50 ? 'critical' : 'normal';
  await emitEvent({
    event_type: 'ghl.lead_score_changed', event_subtype: score >= 50 ? 'hyperactive' : 'normal',
    source: 'ghl_webhook', entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    payload: { score, previous_score: previousScore, delta, hyperactive_eligible: score >= 50 && delta >= 30, enriched_via: enrichedVia },
    priority, idempotency_key: `ghl_score_${contactId}_${score}_${Date.now()}`,
  });

  if (score >= 50) {
    console.log(`[BehavioralEmitter] 🔥 HYPERACTIVE BUYER signal: ${contactId} score=${score} (delta=${delta})`);
  } else {
    console.log(`[BehavioralEmitter] Lead score: ${contactId} score=${score} (delta=${delta}, enriched: ${enrichedVia})`);
  }
  return res.json({ status: 'accepted', score, delta, priority, enriched_via: enrichedVia });
}

async function handleWorkflowCompleted(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;
  const workflowId = body.workflowId || body.workflow_id || null;
  const workflowName = body.workflowName || body.workflow_name || null;

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  await emitEvent({
    event_type: 'ghl.workflow_completed', event_subtype: workflowId, source: 'ghl_webhook',
    entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    payload: { workflow_id: workflowId, workflow_name: workflowName },
    priority: 'normal', idempotency_key: `ghl_wf_complete_${contactId}_${workflowId}_${Date.now()}`,
  });
  return res.json({ status: 'accepted', event_type: 'ghl.workflow_completed' });
}

// ═══════════════════════════════════════════════════════════════════
// v2.3.1: CONTACT CREATED HANDLER — Self-Enriching
// ═══════════════════════════════════════════════════════════════════

/**
 * Normalize tags from any format GHL might send:
 *   - Array of strings: ["tag1", "tag2"]             → as-is
 *   - Comma-separated string: "tag1, tag2, tag3"     → split + trim
 *   - Single string: "tag1"                          → wrap in array
 *   - null/undefined                                 → empty array
 */
function normalizeTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(t => String(t).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    return raw.split(',').map(t => t.trim()).filter(Boolean);
  }
  return [];
}

const ENTRY_SOURCE_ALIASES = {
  'risk-report': 'risk-report',
  'risk_report': 'risk-report',
  'hrr': 'risk-report',
  'home-risk-report': 'risk-report',
  'estimate-calculator': 'estimate-calculator',
  'estimate_calculator': 'estimate-calculator',
  'calculator': 'estimate-calculator',
  'chatbot': 'chatbot',
  'chat': 'chatbot',
  'live-chat': 'chatbot',
  'live_chat': 'chatbot',
  'canvassing': 'canvassing',
  'canvass': 'canvassing',
  'door-to-door': 'canvassing',
  'referral': 'referral',
  'referred': 'referral',
  'manual': 'other',
  'other': 'other',
  'unknown': 'unknown',
};

/**
 * Resolve entry source from a normalized tags array + source string.
 * 
 * Priority:
 *   1. active-entry:* tag (most authoritative — set by LP sync or entry workflows)
 *   2. GHL source field
 *   3. Fallback: "unknown"
 */
function resolveEntrySourceFromData(tags, ghlSource) {
  // 1. Check tags for active-entry:*
  for (const tag of tags) {
    const t = tag.toLowerCase();
    if (t.startsWith('active-entry:')) {
      return t.replace('active-entry:', '');
    }
  }

  // 2. GHL source field
  if (ghlSource) {
    const normalized = ENTRY_SOURCE_ALIASES[ghlSource.toLowerCase()];
    return normalized || ghlSource.toLowerCase();
  }

  // 3. Fallback
  return 'unknown';
}

/**
 * Fetch full contact from GHL API for self-enrichment.
 * Returns { tags, source, name, phone, email, scoring } or null on failure.
 *
 * v2.4: Added scoring field — contains engagement score profiles
 *   as { profileId: score }. Used by handleLeadScore for self-enrichment.
 */
async function fetchGHLContact(contactId) {
  if (!GHL_API_KEY || !contactId) return null;
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.warn(`[BehavioralEmitter] GHL contact lookup failed for ${contactId}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const c = data?.contact;
    if (!c) return null;
    return {
      tags: c.tags || [],
      source: c.source || null,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name || null,
      phone: c.phone || null,
      email: c.email || null,
      scoring: c.scoring || null,
    };
  } catch (err) {
    console.warn(`[BehavioralEmitter] GHL contact lookup error for ${contactId}: ${err.message}`);
    return null;
  }
}

async function handleContactCreated(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || body.id || null;

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  // Self-enrich: fetch full contact from GHL API for reliable tags + source
  const ghlContact = await fetchGHLContact(contactId);

  // Build data from GHL API (primary) with webhook body as fallback
  let tags, source, contactName, phone, email;

  if (ghlContact) {
    tags = ghlContact.tags;  // Already a proper array from GHL API
    source = ghlContact.source;
    contactName = ghlContact.name;
    phone = ghlContact.phone;
    email = ghlContact.email;
  } else {
    // Fallback to webhook body — tags may be comma-separated string
    tags = normalizeTags(body.tags || body.contactTags);
    source = cleanGHLValue(body.source) || null;
    contactName = cleanGHLValue(body.contactName || body.contact_name
      || body.name || body.firstName || body.first_name) || null;
    phone = cleanGHLValue(body.phone) || null;
    email = cleanGHLValue(body.email) || null;
  }

  const entrySource = resolveEntrySourceFromData(tags, source);

  // 30-minute idempotency bucket — same contact within 30 min = deduped
  const timeBucket = Math.floor(Date.now() / (30 * 60 * 1000));
  const idempotencyKey = `ghl_contact_created_${contactId}_${timeBucket}`;

  await emitEvent({
    event_type: 'ghl.contact_created',
    event_subtype: entrySource,
    source: 'ghl_webhook',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload: {
      entry_source: entrySource,
      contactName,
      phone,
      email,
      tags,
      ghl_source: source,
      enriched_via: ghlContact ? 'ghl_api' : 'webhook_body',
    },
    priority: 'high',
    idempotency_key: idempotencyKey,
  });

  console.log(`[BehavioralEmitter] Contact created: ${contactId} (source: ${entrySource}, name: ${contactName}, enriched: ${ghlContact ? 'API' : 'body'})`);
  return res.json({ status: 'accepted', event_type: 'ghl.contact_created', entry_source: entrySource });
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION
// ═══════════════════════════════════════════════════════════════════

export function registerBehavioralEmitterRoutes(app) {
  const validateGHL = (req, res, next) => {
    if (!validateWebhook(req)) {
      console.warn(`[BehavioralEmitter] Rejected webhook: invalid secret from ${req.ip}`);
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    next();
  };

  app.post('/webhook/ghl/reply', validateGHL, async (req, res) => {
    try { await handleReply(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /reply error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });
  app.post('/webhook/ghl/appointment', validateGHL, async (req, res) => {
    try { await handleAppointment(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /appointment error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });
  app.post('/webhook/ghl/engagement', validateGHL, async (req, res) => {
    try { await handleEngagement(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /engagement error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });
  app.post('/webhook/ghl/lead-score', validateGHL, async (req, res) => {
    try { await handleLeadScore(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /lead-score error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });
  app.post('/webhook/ghl/workflow', validateGHL, async (req, res) => {
    try { await handleWorkflowCompleted(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /workflow error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });
  app.post('/webhook/ghl/contact-created', validateGHL, async (req, res) => {
    try { await handleContactCreated(req, res); }
    catch (err) { console.error('[BehavioralEmitter] /contact-created error:', err.message); if (!res.headersSent) res.status(500).json({ error: err.message }); }
  });

  console.log('[BehavioralEmitter] GHL webhook routes registered: /webhook/ghl/{reply,appointment,engagement,lead-score,workflow,contact-created}');
}
