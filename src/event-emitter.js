/**
 * Event Emitter — src/event-emitter.js
 * 
 * Thin helper to emit system events into the system_events table.
 * Used by sync-leads.js (disposition changes), sync-engine.js (sync events),
 * and any other system component that needs to fire events for the Decision Engine.
 * 
 * Uses idempotency_key to prevent duplicate events from re-syncs.
 */

import supabase from './supabase.js';

/**
 * Emit a system event. Skips silently if idempotency_key already exists.
 * 
 * @param {Object} opts
 * @param {string} opts.event_type       - e.g. 'lp.disposition_changed', 'ghl.appointment_booked'
 * @param {string} [opts.event_subtype]  - e.g. the disposition code 'FDNS', 'BO', etc.
 * @param {string} opts.source           - 'lp_sync', 'ghl_webhook', 'claude', 'n8n'
 * @param {string} opts.entity_type      - 'lead', 'contact', 'opportunity', 'system'
 * @param {string} opts.entity_id        - The primary ID (lp_lead_id for LP events)
 * @param {string} [opts.ghl_contact_id] - GHL contact ID if known
 * @param {string} [opts.lp_lead_id]     - LP lead ID
 * @param {string} [opts.lp_prospect_id] - LP prospect ID
 * @param {Object} [opts.payload]        - Event-specific data (disposition_code, rep_name, etc.)
 * @param {Object} [opts.previous_state] - State before the change
 * @param {Object} [opts.new_state]      - State after the change
 * @param {string} [opts.priority]       - 'critical', 'high', 'normal', 'low' (default: 'normal')
 * @param {string} [opts.idempotency_key] - Unique key to prevent duplicates
 * @returns {Object|null} The inserted event row, or null if skipped
 */
export async function emitEvent(opts) {
  const {
    event_type, event_subtype, source, entity_type, entity_id,
    ghl_contact_id, lp_lead_id, lp_prospect_id,
    payload = {}, previous_state = null, new_state = null,
    priority = 'normal', idempotency_key = null,
  } = opts;

  try {
    // Check idempotency — skip if this exact event was already emitted
    if (idempotency_key) {
      const { data: existing } = await supabase
        .from('system_events')
        .select('id')
        .eq('idempotency_key', idempotency_key)
        .maybeSingle();

      if (existing) {
        return null; // Already emitted, skip
      }
    }

    const { data, error } = await supabase
      .from('system_events')
      .insert({
        event_type,
        event_subtype: event_subtype || null,
        source,
        entity_type,
        entity_id: String(entity_id),
        ghl_contact_id: ghl_contact_id || null,
        lp_lead_id: lp_lead_id || null,
        lp_prospect_id: lp_prospect_id || null,
        payload,
        previous_state,
        new_state,
        priority,
        idempotency_key,
        event_timestamp: new Date().toISOString(),
        processed: false,
      })
      .select()
      .single();

    if (error) {
      console.error(`[EventEmitter] Failed to emit ${event_type}:`, error.message);
      return null;
    }

    console.log(`[EventEmitter] Emitted ${event_type}${event_subtype ? ':' + event_subtype : ''} for ${entity_type}:${entity_id} (priority: ${priority}, id: ${data.id})`);
    return data;
  } catch (err) {
    console.error(`[EventEmitter] Error emitting ${event_type}:`, err.message);
    return null;
  }
}

/**
 * Determine priority for a disposition change event based on the disposition code.
 * Critical = DNC, Sale (needs immediate action)
 * High = Cnf, Set, NS, FDNS (appointment-related, time-sensitive)
 * Normal = most disposition changes
 * Low = suppressed/dead codes
 */
export function dispositionPriority(code) {
  const c = String(code || '').trim();
  
  // Critical — immediate action required
  if (['DNC', 'Sale', 'SW'].includes(c)) return 'critical';
  
  // High — appointment-related, time-sensitive
  if (['Cnf', 'Set', 'NS', 'FDNS', 'CXL', 'NoHome', '1Leg', 'Issue'].includes(c)) return 'high';
  
  // Low — dead/suppressed codes
  if (['NG', 'BD', 'CTR', 'NOP NOP', 'NOPNOP', 'Renter', 'VNI'].includes(c)) return 'low';
  
  // Normal — everything else
  return 'normal';
}
