/**
 * System Event Handler — src/actions/handlers/system-events.js
 *
 * Generic emit_event executor. Used by Layer 3 dispatch sequences that
 * include observability or follow-on triggers (e.g., disposition_drift_check).
 *
 * Action payload shape:
 *   {
 *     event_type:      string,    // required
 *     entity_type?:    string,    // default 'contact'
 *     entity_id?:      string,    // default action.target_id
 *     ghl_contact_id?: string,    // default action.target_id
 *     priority?:       string,    // default 'normal'
 *     payload?:        object,    // arbitrary event payload
 *     idempotency_key?: string,
 *   }
 */

import { emitEvent } from '../../event-emitter.js';

export async function executeEmitEvent(action) {
  const params = action.action_payload || {};
  if (!params.event_type) throw new Error('emit_event requires action_payload.event_type');

  const result = await emitEvent({
    event_type: params.event_type,
    source: params.source || 'agent_executor',
    entity_type: params.entity_type || 'contact',
    entity_id: String(params.entity_id || action.target_id || ''),
    ghl_contact_id: params.ghl_contact_id || action.target_id || null,
    payload: params.payload || {},
    priority: params.priority || 'normal',
    idempotency_key: params.idempotency_key || null,
  });

  return {
    event_emitted: !!result,
    event_id: result?.id || null,
    event_type: params.event_type,
  };
}
