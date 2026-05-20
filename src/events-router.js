/**
 * Events Router — src/events-router.js
 *
 * Registers per-event-type webhook endpoints that GHL workflows fire to
 * hand state-machine signals back to LP MCP. Each endpoint normalizes
 * the GHL payload into a `system_events` row using the same shape
 * /webhook/ghl-event produces, so the existing Decision Engine + filter
 * pipeline picks them up unchanged.
 *
 * Endpoints:
 *   POST /events/workflow_started   → system_events(event_type='ghl.workflow_started')
 *   POST /events/workflow_exit      → system_events(event_type='ghl.workflow_exit')
 *   POST /events/state_transition   → system_events(event_type='ghl.state_transition')
 *   POST /events/routing_failure    → system_events(event_type='ghl.routing_failure')
 *
 * These existed implicitly in S5.2 v2 workflow webhook nodes (the
 * "Layer 3: Workflow Started" step + cousins) but had no server-side
 * handler — every call returned 404 silently. This module closes that
 * gap without changing the workflow.
 *
 * Payload contract (lenient — accepts both snake_case and camelCase):
 *   {
 *     contact_id | contactId        : "GHL contact ID" (required),
 *     workflow_id | workflowId      : "GHL workflow ID" (optional),
 *     lp_lead_id | lpLeadId         : "LP lead ID" (optional),
 *     event_subtype                 : free-form subtype (optional),
 *     ...                           : forwarded verbatim into payload
 *   }
 *
 * Dedup: per-minute idempotency_key composed from event_type + contact_id
 *        + workflow_id to absorb GHL retries without burning unique-key slots.
 */

import supabase from './supabase.js';

const EVENT_TYPE_MAP = {
  workflow_started: 'ghl.workflow_started',
  workflow_exit: 'ghl.workflow_exit',
  state_transition: 'ghl.state_transition',
  routing_failure: 'ghl.routing_failure',
};

const PRIORITY_MAP = {
  'ghl.routing_failure': 'high',
};

async function handleEvent(eventType, req, res) {
  try {
    const payload = req.body || {};
    const contactId = payload.contact_id || payload.contactId || null;
    const workflowId = payload.workflow_id || payload.workflowId || null;
    const lpLeadId = payload.lp_lead_id || payload.lpLeadId || null;

    if (!contactId && !lpLeadId) {
      return res.status(400).json({ error: 'contact_id (or lp_lead_id) required' });
    }

    const idempotencyKey = `${eventType}_${contactId || lpLeadId}_${workflowId || 'none'}_${Math.floor(Date.now() / 60000)}`;

    const { data: existing } = await supabase
      .from('system_events')
      .select('id')
      .eq('idempotency_key', idempotencyKey)
      .limit(1);

    if (existing && existing.length > 0) {
      return res.json({ received: true, event_id: existing[0].id, event_type: eventType, deduplicated: true });
    }

    const { data: event, error } = await supabase
      .from('system_events')
      .insert({
        event_type: eventType,
        event_subtype: payload.event_subtype || null,
        source: 'ghl',
        entity_type: 'contact',
        entity_id: String(contactId || lpLeadId),
        ghl_contact_id: contactId || null,
        lp_lead_id: lpLeadId || null,
        payload,
        priority: PRIORITY_MAP[eventType] || 'normal',
        idempotency_key: idempotencyKey,
        event_timestamp: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      console.error(`[EventsRouter] ${eventType} insert failed:`, error.message);
      return res.status(500).json({ error: 'Failed to create event', detail: error.message });
    }

    console.log(`[EventsRouter] ${eventType} | contact=${contactId || lpLeadId} | workflow=${workflowId || 'none'} | event_id=${event.id}`);
    res.json({ received: true, event_id: event.id, event_type: eventType });
  } catch (err) {
    console.error(`[EventsRouter] ${eventType} threw:`, err.message);
    res.status(500).json({ error: err.message });
  }
}

export function registerEventsRouter(app) {
  for (const [path, eventType] of Object.entries(EVENT_TYPE_MAP)) {
    app.post(`/events/${path}`, (req, res) => handleEvent(eventType, req, res));
    console.log(`[EventsRouter] Registered: POST /events/${path} → ${eventType}`);
  }
}
