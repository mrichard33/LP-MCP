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
 *        Custom Data:
 *          contactId = {{contact.id}}
 *          source    = calculator | hrr | chatbot | canvassing | etc.
 *
 *   2. GHL's outbound webhook nests user-defined "Custom Data" fields
 *      inside a `customData` object while auto-populating contactId at
 *      the top level. This handler accepts both shapes plus a few other
 *      common variants (top-level, customData, contact.id, query string).
 *
 *   3. The endpoint emits ghl.entry_detected events with source as the
 *      event_subtype.
 *
 *   4. Decision Engine matches ENTRY_ROUTE_* rules (one per source) and
 *      produces add_to_workflow actions with webhook_url targeting the
 *      destination workflow's Inbound Webhook trigger.
 *
 *   5. Action Executor (Route B) POSTs to the destination URL with full
 *      payload context, which the destination workflow can reference as
 *      {{inboundWebhookRequest.field}}.
 *
 * v1.1 — Defensive payload parsing. Looks for contactId/source in
 *        top-level, customData, contact, and query string locations.
 *        Adds debug payload to error responses so misconfigurations
 *        surface in the GHL workflow execution log without needing
 *        Railway logs. Logs incoming body shape for fingerprinting.
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

/**
 * Pull a value from an object by trying multiple key names in order.
 * Returns the first non-empty match. Treats empty string as not-found.
 */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

/**
 * Resolve contactId and source from a request, trying every payload
 * shape GHL is known to produce. Returns the resolved values plus a
 * shape fingerprint for diagnostics.
 */
function resolveEntryFields(req) {
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customData = (body.customData || body.custom_data || body.customValues || {}) || {};
  const contact = (body.contact && typeof body.contact === 'object') ? body.contact : {};
  const query = req.query || {};

  // contactId: top-level, then customData, then nested contact, then query
  const contactId =
    pick(body, ['contactId', 'contact_id', 'id']) ||
    pick(customData, ['contactId', 'contact_id', 'id']) ||
    pick(contact, ['id', 'contactId', '_id']) ||
    pick(query, ['contactId', 'contact_id', 'id']) ||
    null;

  // source: top-level, then customData, then query
  const sourceRaw =
    pick(body, ['source', 'entry_source']) ||
    pick(customData, ['source', 'entry_source']) ||
    pick(query, ['source', 'entry_source']) ||
    null;

  // Optional context bag (rare, but supported)
  const context =
    (body.context && typeof body.context === 'object' ? body.context : null) ||
    (body.payload && typeof body.payload === 'object' ? body.payload : null) ||
    (customData.context && typeof customData.context === 'object' ? customData.context : null) ||
    {};

  return {
    contactId,
    sourceRaw,
    context,
    fingerprint: {
      content_type: req.headers['content-type'] || null,
      body_keys: Object.keys(body),
      customData_keys: Object.keys(customData),
      contact_keys: Object.keys(contact),
      query_keys: Object.keys(query),
      contactId_resolved_from: contactId
        ? (body.contactId || body.contact_id || body.id ? 'body'
          : customData.contactId || customData.contact_id || customData.id ? 'customData'
          : contact.id || contact.contactId || contact._id ? 'contact'
          : 'query')
        : null,
      source_resolved_from: sourceRaw
        ? (body.source || body.entry_source ? 'body'
          : customData.source || customData.entry_source ? 'customData'
          : 'query')
        : null,
    },
  };
}

async function handleEntryEvent(req, res) {
  const { contactId, sourceRaw, context, fingerprint } = resolveEntryFields(req);
  const source = sourceRaw ? String(sourceRaw).toLowerCase().trim() : null;

  // Lightweight always-on diagnostics. The body itself can be huge, so
  // we log the shape (keys + content-type) rather than the full body.
  console.log('[EntryEvent] inbound shape:', JSON.stringify(fingerprint));

  if (!contactId) {
    return res.status(400).json({
      error: 'Missing contactId',
      debug: fingerprint,
    });
  }
  if (!source) {
    return res.status(400).json({
      error: 'Missing source. Must be one of: ' + [...VALID_SOURCES].join(', '),
      debug: fingerprint,
    });
  }
  if (!VALID_SOURCES.has(source)) {
    return res.status(400).json({
      error: `Invalid source "${source}". Must be one of: ${[...VALID_SOURCES].join(', ')}`,
      debug: fingerprint,
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
      raw: req.body,
      shape: fingerprint,
    },
    priority: 'high',
    idempotency_key: `entry_${source}_${contactId}_${timeBucket}`,
  });

  console.log(`[EntryEvent] ✅ ${source} → ${contactId} (idempotency=${timeBucket}, source_from=${fingerprint.source_resolved_from})`);

  return res.json({
    status: 'accepted',
    event_type: 'ghl.entry_detected',
    source,
    contactId,
    resolved_from: {
      contactId: fingerprint.contactId_resolved_from,
      source: fingerprint.source_resolved_from,
    },
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
