/**
 * Event Emitter — src/event-emitter.js
 *
 * Thin helper to emit system events into the system_events table.
 * Used by sync-leads.js (disposition changes), sync-engine.js (sync events),
 * and any other system component that needs to fire events for the Decision Engine.
 *
 * Uses idempotency_key to prevent duplicate events from re-syncs.
 *
 * 2026-05-13 — Play 1 Optimization: event-intake-filter integration.
 *   All emits run through applyIntakeFilter() first. Events for types/
 *   subtypes not in the allowlist are recorded to system_events_filtered
 *   for telemetry and dropped from the main queue. Pass bypass:true to
 *   skip the gate when the caller already knows the event has a consumer
 *   (used by internal emitters: intent.*, behavioral.*, ai.*, system.*).
 *   See src/services/event-intake-filter.js for the allowlist and rationale.
 */

import supabase from './supabase.js';
import { applyIntakeFilter } from './services/event-intake-filter.js';

// v1.1 (2026-06-02) — Per-call ceiling on emitEvent's Supabase calls. The JS
// client has no abort support; a hung insert/select into system_events would
// otherwise stall emitEvent forever. analyzeMessage awaits the ai.analysis_completed
// emit AFTER buildLeadContext and BEFORE returning, so a hang here is the same
// silent-loss class the analyzer/context-builder timeouts close: the success path
// would stall with no completed event. Racing each call against this timeout turns
// a hang into a thrown error caught by emitEvent's outer try/catch → returns null.
const EMIT_EVENT_TIMEOUT_MS = parseInt(process.env.EMIT_EVENT_TIMEOUT_MS || '6000', 10);

// v1.1 — Promise timeout wrapper. Rejects with a labeled error if `promise`
// hasn't settled within `ms`. The underlying work is not cancelled (no abort in
// the Supabase JS client), but emitEvent stops waiting; its catch logs and
// returns null, which callers already handle safely (e.g. the reply buffer reads
// emittedEvent?.id → undefined → the event simply isn't buffered).
function withTimeout(promise, label, ms = EMIT_EVENT_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Emit a system event. Skips silently if idempotency_key already exists.
 *
 * Filter behavior (2026-05-13):
 *   - Before any DB write, applyIntakeFilter() checks if the event type
 *     has any active rule consumer. If not, the event is recorded to
 *     system_events_filtered (72h TTL) and emitEvent returns
 *     { filtered: true, reason }.
 *   - Pass opts.bypass_filter = true to skip the gate. Used by internal
 *     emitters that have proven rule consumers (intent.*, ai.*, etc).
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
 * @param {boolean} [opts.bypass_filter]  - 2026-05-13: skip event-intake-filter gate
 * @returns {Object|null} The inserted event row, or null if skipped/filtered.
 *                        Filtered events return { filtered: true, reason }.
 */
export async function emitEvent(opts) {
  const {
    event_type, event_subtype, source, entity_type, entity_id,
    ghl_contact_id, lp_lead_id, lp_prospect_id,
    payload = {}, previous_state = null, new_state = null,
    priority = 'normal', idempotency_key = null,
    bypass_filter = false,
  } = opts;

  try {
    // ─── Phase 1 Optimization Play 1 (2026-05-13) ──────────────────
    // Event intake filter. Runs BEFORE the idempotency check so filtered
    // events never touch system_events at all (and so the idempotency
    // key isn't burned on a dropped event).
    const filterDecision = await applyIntakeFilter(
      { event_type, event_subtype, source, ghl_contact_id, entity_id, payload },
      { bypass: bypass_filter }
    );
    if (!filterDecision.allow) {
      // Telemetry is already recorded inside applyIntakeFilter.
      return { filtered: true, reason: filterDecision.reason };
    }

    // Check idempotency — skip if this exact event was already emitted
    if (idempotency_key) {
      const { data: existing } = await withTimeout(
        supabase
          .from('system_events')
          .select('id')
          .eq('idempotency_key', idempotency_key)
          .maybeSingle(),
        'emitEvent.idempotencyCheck',
      );

      if (existing) {
        return null; // Already emitted, skip
      }
    }

    const { data, error } = await withTimeout(
      supabase
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
        .single(),
      'emitEvent.insert',
    );

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
