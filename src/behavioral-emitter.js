/**
 * Behavioral Event Emitter — src/behavioral-emitter.js
 * 
 * Layer 3 component. Receives GHL webhooks for behavioral signals
 * and emits typed system events into the Decision Engine pipeline.
 * 
 * Webhook endpoints:
 *   POST /webhook/ghl/reply        — Inbound SMS/email replies
 *   POST /webhook/ghl/appointment  — Appointment created/updated/deleted
 *   POST /webhook/ghl/engagement   — Email opened, link clicked, VSL watched
 *   POST /webhook/ghl/lead-score   — Lead score threshold crossed
 *   POST /webhook/ghl/workflow     — Workflow completed
 * 
 * Security: All endpoints validate GHL_WEBHOOK_SECRET.
 *
 * v2.1 — handleAppointment now extracts startDate and passes all extra
 *   body fields through to the event payload. Filters literal "null"
 *   string values that GHL sends when template variables don't resolve.
 */

import { emitEvent } from './event-emitter.js';
import { upsertLeadIntelligence } from './context-builder.js';
import supabase from './supabase.js';

const GHL_WEBHOOK_SECRET = process.env.GHL_WEBHOOK_SECRET || '';

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

async function handleAppointment(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;
  const calendarId = body.calendarId || body.calendar_id || null;
  const status = (body.status || body.appointmentStatus || '').toLowerCase();

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });

  let eventType = 'ghl.appointment_booked';
  if (status === 'cancelled' || status === 'canceled') eventType = 'ghl.appointment_cancelled';
  else if (status === 'no_show' || status === 'noshow' || status === 'no-show') eventType = 'ghl.appointment_no_show';

  // v2.1: Extract all appointment fields including startDate.
  // Clean "null" strings from GHL template variables that didn't resolve.
  const startTime = cleanGHLValue(body.startTime || body.start_time) || null;
  const startDate = cleanGHLValue(body.startDate || body.start_date) || null;
  const endTime = cleanGHLValue(body.endTime || body.end_time) || null;
  const title = cleanGHLValue(body.title || body.name) || null;
  const appointmentId = cleanGHLValue(body.appointmentId || body.appointment_id) || null;

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
    },
    priority: 'high', idempotency_key: `ghl_appt_${contactId}_${calendarId}_${status}_${Date.now()}`,
  });
  console.log(`[BehavioralEmitter] Appointment ${eventType} for ${contactId} (calendar: ${calendarId}, date: ${startDate}, time: ${startTime})`);
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

async function handleLeadScore(req, res) {
  const body = req.body || {};
  const contactId = body.contactId || body.contact_id || null;
  const score = parseInt(body.score || body.lead_score || '0', 10);
  const previousScore = parseInt(body.previousScore || body.previous_score || '0', 10);

  if (!contactId) return res.status(400).json({ error: 'Missing contactId' });
  const delta = score - previousScore;

  await upsertLeadIntelligence(contactId, {
    lead_score: score, lead_score_velocity: delta, last_engagement_at: new Date().toISOString(),
  });

  const priority = score >= 50 ? 'critical' : 'normal';
  await emitEvent({
    event_type: 'ghl.lead_score_changed', event_subtype: score >= 50 ? 'hyperactive' : 'normal',
    source: 'ghl_webhook', entity_type: 'contact', entity_id: contactId, ghl_contact_id: contactId,
    payload: { score, previous_score: previousScore, delta, hyperactive_eligible: score >= 50 && delta >= 30 },
    priority, idempotency_key: `ghl_score_${contactId}_${score}_${Date.now()}`,
  });

  if (score >= 50) console.log(`[BehavioralEmitter] 🔥 HYPERACTIVE BUYER signal: ${contactId} score=${score} (delta=${delta})`);
  return res.json({ status: 'accepted', score, priority });
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

  console.log('[BehavioralEmitter] GHL webhook routes registered: /webhook/ghl/{reply,appointment,engagement,lead-score,workflow}');
}
