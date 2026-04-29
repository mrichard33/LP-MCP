/**
 * Entry Event Handler — src/entry-event-handler.js
 *
 * Receives entry-source events from GHL workflows and emits them to the
 * agentic event bus. The Decision Engine consumes ghl.entry_detected
 * events and routes contacts to the destination workflow via Route B
 * (inbound webhook URL of the destination workflow).
 *
 * GHL Setup (per entry source):
 *   1. Each entry-source workflow is reduced to ONE step:
 *        Custom Webhook → POST /webhook/ghl/entry
 *        Body: {
 *          "contactId": "{{contact.id}}",
 *          "source": "calculator" | "hrr" | "chatbot" | etc.,
 *          "context": { ...optional source-specific fields }
 *        }
 *
 *   2. This endpoint emits ghl.entry_detected events with source as subtype.
 *
 *   3. Decision Engine matches ENTRY_ROUTE_* rules (one per source) and
 *      produces add_to_workflow actions with webhook_url targeting the
 *      destination workflow's Inbound Webhook trigger.
 *
 *   4. Action Executor (Route B) POSTs to the destination URL with full
 *      payload context, which the destination workflow can reference as
 *      {{inboundWebhookRequest.field}}.
 *
 * v1.0 — Initial implementation. Route B agentic-first entry routing.
 */

import { emitEvent } from './event-emitter.js';

// Canonical entry source names. Adding a new entry source means adding
// it here AND creating a corresponding ENTRY_ROUTE_* rule in agent_rules.
const VALID_SOURCES = new Set([
  'calculator',           // Estimate Calculator submission
  'hrr',                  // Home Risk Report
  'chatbot',              // Chatbot intent qualified
  'canvassing',           // Canvasser submission
  'referral',             // Customer referral
  'high_intent_digital',  // High-intent digital signal
  'manual',               // Rep manual entry
]);

async function handleEntryEvent(req, res) {
  const body = req.body || {};
  const contactId = body.contact_id || body.contactId || body.id || null;
  const sourceRaw = body.source || body.entry_source || null;
  const source = sourceRaw ? String(sourceRaw).toLowerCase().trim() : null;
  const context = body.context || body.payload || {};

  if (!contactId) {
    return res.status(400).json({ error: 'Missing contactId' });
  }
  if (!source) {
    return res.status(400).json({
      error: 'Missing source. Must be one of: ' + [...VALID_SOURCES].join(', '),
    });
  }
  if (!VALID_SOURCES.has(source)) {
    return res.status(400).json({
      error: `Invalid source "${source}". Must be one of: ${[...VALID_SOURCES].join(', ')}`,
    });
  }

  // 5-minute idempotency window per (source, contact). Prevents duplicate
  // routing if the upstream GHL workflow fires the webhook twice.
  const timeBucket = Math.floor(Date.now() / (5 * 60 * 1000));

  await emitEvent({
    event_type: 'ghl.entry_detected',
    event_subtype: source,
    source: 'ghl_webhook_entry',
    entity_type: 'contact',
    entity_id: contactId,
    ghl_contact_id: contactId,
    payload: {
      source,
      context,
      raw: body,
    },
    priority: 'high',
    idempotency_key: `entry_${source}_${contactId}_${timeBucket}`,
  });

  console.log(`[EntryEvent] ✅ ${source} → ${contactId} (idempotency=${timeBucket})`);

  return res.json({
    status: 'accepted',
    event_type: 'ghl.entry_detected',
    source,
    contactId,
  });
}

export function registerEntryEventRoutes(app) {
  app.post('/webhook/ghl/entry', async (req, res) => {
    try {
      await handleEntryEvent(req, res);
    } catch (err) {
      console.error('[EntryEvent] error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  app.get('/webhook/ghl/entry/sources', (req, res) => {
    res.json({ valid_sources: [...VALID_SOURCES] });
  });

  console.log('[EntryEvent] Route registered: POST /webhook/ghl/entry');
  console.log('[EntryEvent] Route registered: GET  /webhook/ghl/entry/sources');
}
