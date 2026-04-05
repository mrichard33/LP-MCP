/**
 * Behavioral Event Emitter — src/behavioral-emitter.js
 * 
 * Layer 3 component. Receives GHL webhooks for behavioral signals
 * and emits typed system events into the Decision Engine pipeline.
 * 
 * Webhook endpoints:
 *   POST /webhook/ghl/reply        — Inbound SMS/email replies
 *   POST /webhook/ghl/appointment  — Appointment created/updated/deleted
 *   POST /webhook/ghl/engagement   — Email opened, link clicked (from GHL Custom Webhook steps)
 *   POST /webhook/ghl/lead-score   — Lead score threshold crossed (from GHL Custom Webhook)
 *   POST /webhook/ghl/workflow     — Workflow completed (from GHL Custom Webhook last step)
 * 
 * Security: All endpoints validate GHL_WEBHOOK_SECRET (header or query param).
 * 
 * Event types emitted:
 *   ghl.reply_received    — with pending_analysis, trivial, or dnc subtype
 *   ghl.appointment_booked / ghl.appointment_cancelled / ghl.appointment_no_show
 *   ghl.email_opened / ghl.link_clicked / ghl.vsl_watched
 *   ghl.lead_score_changed
 *   ghl.workflow_completed
 */

import { emitEvent } from './event-emitter.js';
import { upsertLeadIntelligence } from './context-builder.js';
import supabase from './supabase.js';

const GHL_WEBHOOK_SECRET = process.env.GHL_WEBHOOK_SECRET || '';

// ═══════════════════════════════════════════════════════════════════
// SECURITY
// ═══════════════════════════════════════════════════════════════════

function validateWebhook(req) {
  if (!GHL_WEBHOOK_SECRET) return true; // No secret = no validation (dev mode)
  const provided = req.headers['x-ghl-signature']
    || req.headers['x-webhook-secret']
    || req.query.secret
    || '';
  return provided === GHL_WEBHOOK_SECRET;
}

// ═══════════════════════════════════════════════════════════════════
// DNC / DISENGAGEMENT DETECTION (no AI needed)
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
  const trimmed = text.trim();
  return DNC_PATTERNS.some(p => p.test(trimmed));
}

function isTrivialMessage(text) {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < 2) return true;
  return TRIVIAL_PATTERNS.some(p => p.test(trimmed));
}

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK HANDLERS
// ═══════════════════════════════════════════════════════════════════

/**
 * POST /webhook/ghl/reply
 * Receives inbound message notifications from GHL.
 * 
 * GHL webhook payload shape:
 *   { type: 'InboundMessage', contactId, body, messageType, ... }
 *   or: { contact_id, message, ... } (varies by GHL version/config)
 */
async function handleReply(req, res) {
  const body = req.body || {};

  // Normalize — GHL webhook payloads vary
  const contactId = body.contactId || body.contact_id || body.id || null;
  const messageText = body.body || body.message || body.text || '';
  const messageType = body.messageType || body.type || 'SMS';

  if (!contactId) {
    return res.status(400).json({ error: 'Missing contactId in webhook payload' });
  }

  const trimmed = messageText.trim();

  // ─── DNC — immediate suppress, no AI ───────────────────
  if (isDNCSignal(trimmed)) {
    await emitEvent({
      event_type: 'ghl.reply_received',
      event_subtype: 'dnc',
      source: 'ghl_webhook',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: {
        message_text: trimmed,
        message_type: messageType,
        engagement_quality: 'dnc',
        word_count: trimmed.split(/\s+/).length,
      },
      priority: 'critical',
      idempotency_key: `ghl_reply_dnc_${contactId}_${Date.now()}`,
    });

    console.log(`[BehavioralEmitter] DNC reply from ${contactId}: "${trimmed.slice(0, 50)}"`);
    return res.json({ status: 'accepted', classification: 'dnc' });
  }

  // ─── Trivial — log engagement but skip AI analysis ─────
  if (isTrivialMessage(trimmed)) {
    // Still count the reply for engagement tracking
    await upsertLeadIntelligence(contactId, {
      last_reply_at: new Date().toISOString(),
      last_engagement_at: new Date().toISOString(),
    }).catch(() => {}); // Non-critical

    await emitEvent({
      event_type: 'ghl.reply_received',
      event_subtype: 'trivial',
      source: 'ghl_webhook',
      entity_type: 'contact',
      entity_id: contactId,
      ghl_contact_id: contactId,
      payload: {
        message_text: trimmed,
        message_type: messageType,
        engagement_quality: 'neutral',
        word_count: trimmed.split(/\s+/).length,
      },
      priority: 'low',
      idempotency_key: `ghl_reply_trivial_${contactId}_${Date.now()}`,
    });

    return res.json({ status: 'accepted', classification: 'trivial' });
  }

  // ─── Substantive reply — needs AI analysis ─────────────
  await emitEvent({
    event_type: 'ghl.reply_received',
    event_subtype: 'pending_analysis',
    source: 'ghl_webhook',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload: {
      message_text: trimmed,
      message_type: messageType,
      word_count: trimmed.split(/\s+/).length,
    },
    priority: 'high',
    idempotency_key: `ghl_reply_${contactId}_${Date.now()}`,
  });

  console.log(`[BehavioralEmitter] Substantive reply from ${contactId} (${trimmed.split(/\s+/).length} words) → pending AI analysis`);
  return res.json({ status: 'accepted', classification: 'pending_analysis' });
}

/**
 * POST /webhook/ghl/appointment
 * Receives appointment status changes from GHL.
 */
async function handleAppointment(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;
  const calendarId = body.calendarId || body.calendar_id || null;
  const status = (body.status || body.appointmentStatus || '').toLowerCase();

  if (!contactId) {
    return res.status(400).json({ error: 'Missing contactId' });
  }

  // Map status to event type
  let eventType = 'ghl.appointment_booked';
  const priority = 'high';

  if (status === 'cancelled' || status === 'canceled') {
    eventType = 'ghl.appointment_cancelled';
  } else if (status === 'no_show' || status === 'noshow' || status === 'no-show') {
    eventType = 'ghl.appointment_no_show';
  } else if (status === 'confirmed') {
    eventType = 'ghl.appointment_booked';
  }

  await emitEvent({
    event_type: eventType,
    event_subtype: calendarId || null,
    source: 'ghl_webhook',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload: {
      calendar_id: calendarId,
      status,
      start_time: body.startTime || body.start_time || null,
      end_time: body.endTime || body.end_time || null,
      title: body.title || body.name || null,
    },
    priority,
    idempotency_key: `ghl_appt_${contactId}_${calendarId}_${status}_${Date.now()}`,
  });

  console.log(`[BehavioralEmitter] Appointment ${eventType} for ${contactId} (calendar: ${calendarId})`);
  return res.json({ status: 'accepted', event_type: eventType });
}

/**
 * POST /webhook/ghl/engagement
 * Receives email open / link click / VSL watched signals from GHL Custom Webhook steps.
 * 
 * Expected payload: { type: 'email_opened' | 'link_clicked' | 'vsl_watched', contactId, url?, percent? }
 */
async function handleEngagement(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;
  const signalType = body.type || body.signal_type || 'unknown';

  if (!contactId) {
    return res.status(400).json({ error: 'Missing contactId' });
  }

  let eventType;
  const updates = { last_engagement_at: new Date().toISOString() };

  switch (signalType) {
    case 'email_opened':
      eventType = 'ghl.email_opened';
      // Atomic increment via raw SQL
      await supabase.rpc('run_sql', {
        query_text: `UPDATE lead_intelligence SET emails_opened = COALESCE(emails_opened, 0) + 1, last_engagement_at = NOW(), updated_at = NOW() WHERE ghl_contact_id = '${contactId.replace(/'/g, "''")}'`,
      }).catch(() => {
        upsertLeadIntelligence(contactId, { emails_opened: 1, ...updates });
      });
      break;

    case 'link_clicked':
      eventType = 'ghl.link_clicked';
      await supabase.rpc('run_sql', {
        query_text: `UPDATE lead_intelligence SET links_clicked = COALESCE(links_clicked, 0) + 1, last_engagement_at = NOW(), updated_at = NOW() WHERE ghl_contact_id = '${contactId.replace(/'/g, "''")}'`,
      }).catch(() => {
        upsertLeadIntelligence(contactId, { links_clicked: 1, ...updates });
      });
      break;

    case 'vsl_watched':
      eventType = 'ghl.vsl_watched';
      const percent = parseInt(body.percent || body.watch_percent || '50', 10);
      await upsertLeadIntelligence(contactId, {
        vsl_watched: true,
        vsl_watch_percent: percent,
        ...updates,
      });
      break;

    default:
      eventType = 'ghl.engagement_signal';
  }

  await emitEvent({
    event_type: eventType,
    event_subtype: signalType,
    source: 'ghl_webhook',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload: {
      signal_type: signalType,
      url: body.url || null,
      percent: body.percent || null,
    },
    priority: 'normal',
    idempotency_key: `ghl_engagement_${contactId}_${signalType}_${Date.now()}`,
  });

  return res.json({ status: 'accepted', event_type: eventType });
}

/**
 * POST /webhook/ghl/lead-score
 * Receives lead score change notifications from GHL Custom Webhook steps.
 * 
 * Expected payload: { contactId, score, previousScore? }
 */
async function handleLeadScore(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;
  const score = parseInt(body.score || body.lead_score || '0', 10);
  const previousScore = parseInt(body.previousScore || body.previous_score || '0', 10);

  if (!contactId) {
    return res.status(400).json({ error: 'Missing contactId' });
  }

  const delta = score - previousScore;

  // Update lead_intelligence
  await upsertLeadIntelligence(contactId, {
    lead_score: score,
    lead_score_velocity: delta,
    last_engagement_at: new Date().toISOString(),
  });

  // Determine priority — DS#6 Hyperactive Buyer threshold is 50
  const priority = score >= 50 ? 'critical' : 'normal';

  await emitEvent({
    event_type: 'ghl.lead_score_changed',
    event_subtype: score >= 50 ? 'hyperactive' : 'normal',
    source: 'ghl_webhook',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload: {
      score,
      previous_score: previousScore,
      delta,
      hyperactive_eligible: score >= 50 && delta >= 30,
    },
    priority,
    idempotency_key: `ghl_score_${contactId}_${score}_${Date.now()}`,
  });

  if (score >= 50) {
    console.log(`[BehavioralEmitter] 🔥 HYPERACTIVE BUYER signal: ${contactId} score=${score} (delta=${delta})`);
  }

  return res.json({ status: 'accepted', score, priority });
}

/**
 * POST /webhook/ghl/workflow
 * Receives workflow completion signals from GHL Custom Webhook steps.
 * 
 * Expected payload: { contactId, workflowId, workflowName? }
 */
async function handleWorkflowCompleted(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;
  const workflowId = body.workflowId || body.workflow_id || null;
  const workflowName = body.workflowName || body.workflow_name || null;

  if (!contactId) {
    return res.status(400).json({ error: 'Missing contactId' });
  }

  await emitEvent({
    event_type: 'ghl.workflow_completed',
    event_subtype: workflowId,
    source: 'ghl_webhook',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload: {
      workflow_id: workflowId,
      workflow_name: workflowName,
    },
    priority: 'normal',
    idempotency_key: `ghl_wf_complete_${contactId}_${workflowId}_${Date.now()}`,
  });

  return res.json({ status: 'accepted', event_type: 'ghl.workflow_completed' });
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE REGISTRATION
// ═══════════════════════════════════════════════════════════════════

export function registerBehavioralEmitterRoutes(app) {
  // Security middleware for all GHL webhook routes
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

  console.log('[BehavioralEmitter] GHL webhook routes registered: /webhook/ghl/{reply,appointment,engagement,lead-score,workflow}');
}
