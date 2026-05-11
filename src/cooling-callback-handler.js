/**
 * Cooling Callback Handler — src/cooling-callback-handler.js
 *
 * Receives end-of-hold callbacks from the 7 I.COOL-* GHL workflows.
 *
 * Routes
 * ------
 *   POST /agentic/cooling/complete
 *     Timer expired naturally. Marks the originating agent_action complete,
 *     emits cooling.completed, lets the Decision Engine pick up the contact
 *     for re-evaluation.
 *
 *   POST /agentic/cooling/error
 *     Find Contact failed inside the GHL workflow (bad contact_id, deleted
 *     contact, etc.). Marks the agent_action failed, emits cooling.failed,
 *     fires a GroupMe alert.
 *
 * Auth
 * ----
 * Bearer token via Authorization header. Token comes from
 *   AGENTIC_CALLBACK_TOKEN  (preferred)
 *   MESSAGE_ENGINE_TOKEN    (fallback — same value as
 *                            GHL custom_values.message_engine_token)
 *
 * Idempotency
 * -----------
 * Originating agent_actions.id is bigserial, so it can't be the lookup
 * key for a callback that arrives weeks/months later. Instead the
 * enrollment helper mints a UUID (cooling_enrollment_event_id), embeds
 * it in the payload sent to GHL, and GHL echoes it back here. We look
 * up the action via a JSONB query on
 *   action_payload->'payload'->>'cooling_enrollment_event_id'.
 *
 * If the action is already in a terminal state (completed/failed), we
 * return 200 without re-emitting events — GHL sometimes retries.
 *
 * Wiring (already done in src/index.js):
 *   import { registerCoolingCallbackRoutes } from './cooling-callback-handler.js';
 *   registerCoolingCallbackRoutes(app);
 *
 * v1.0 — 2026-05-11 initial.
 */

import supabase from './supabase.js';
import { emitEvent } from './event-emitter.js';
import { sendGroupMeMessage } from './groupme.js';

const AGENTIC_CALLBACK_TOKEN =
  process.env.AGENTIC_CALLBACK_TOKEN || process.env.MESSAGE_ENGINE_TOKEN || '';

// ─── Auth middleware ──────────────────────────────────────────────────
function validateBearer(req, res, next) {
  if (!AGENTIC_CALLBACK_TOKEN) {
    console.warn('[CoolingCallback] AGENTIC_CALLBACK_TOKEN not set — refusing all requests');
    return res.status(503).json({ error: 'callback_token_not_configured' });
  }
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${AGENTIC_CALLBACK_TOKEN}`;
  if (auth !== expected) {
    console.warn(`[CoolingCallback] Rejected: invalid bearer from ${req.ip}`);
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ─── Payload normalization ────────────────────────────────────────────
function extractCoolingPayload(body) {
  const b = body || {};
  const missing = [];
  for (const k of ['contact_id', 'cooling_enrollment_event_id']) {
    if (!b[k]) missing.push(k);
  }
  if (missing.length) {
    return { ok: false, reason: `missing required fields: ${missing.join(', ')}` };
  }
  return {
    ok: true,
    data: {
      contact_id: String(b.contact_id),
      cooling_duration_code: b.cooling_duration_code || null,
      cooling_started_at: b.cooling_started_at || null,
      cooling_expected_end_at: b.cooling_expected_end_at || null,
      cooling_reason: b.cooling_reason || null,
      cooling_re_entry_hint: b.cooling_re_entry_hint || null,
      cooling_enrollment_event_id: String(b.cooling_enrollment_event_id),
      ghl_workflow_id: b.ghl_workflow_id || null,
      completed_at: b.completed_at || new Date().toISOString(),
    },
  };
}

// ─── Lookup the originating agent_action via the UUID embedded in payload ───
async function findEnrollmentAction(enrollmentEventId) {
  const { data, error } = await supabase
    .from('agent_actions')
    .select('id, status, target_id, action_payload, executed_at, execution_result')
    .eq('action_type', 'add_to_workflow')
    .filter('action_payload->payload->>cooling_enrollment_event_id', 'eq', enrollmentEventId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return { action: data || null, error };
}

// ─── Handler: /agentic/cooling/complete ───────────────────────────────
async function handleCoolingComplete(req, res) {
  const { ok, data, reason } = extractCoolingPayload(req.body);
  if (!ok) {
    console.warn(`[CoolingCallback] /complete rejected: ${reason}`);
    return res.status(400).json({ error: reason });
  }

  const { action, error: lookupErr } = await findEnrollmentAction(data.cooling_enrollment_event_id);
  if (lookupErr) {
    console.error(`[CoolingCallback] /complete lookup error: ${lookupErr.message}`);
    return res.status(500).json({ error: 'lookup_failed' });
  }

  // Orphaned callback — no matching action
  if (!action) {
    console.warn(`[CoolingCallback] /complete orphan: enrollment_event_id=${data.cooling_enrollment_event_id} contact=${data.contact_id}`);
    await emitEvent({
      event_type: 'cooling.completed_orphan',
      source: 'ghl_cooling_callback',
      entity_type: 'contact',
      entity_id: data.contact_id,
      ghl_contact_id: data.contact_id,
      payload: data,
      priority: 'low',
      idempotency_key: `cooling_complete_orphan_${data.cooling_enrollment_event_id}`,
    });
    return res.json({ status: 'accepted', mode: 'orphan' });
  }

  // Idempotency: already processed
  if (action.status === 'completed') {
    console.log(`[CoolingCallback] /complete idempotent: action ${action.id} already completed`);
    return res.json({ status: 'accepted', mode: 'idempotent', action_id: action.id });
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .from('agent_actions')
    .update({
      status: 'completed',
      executed_at: nowIso,
      updated_at: nowIso,
      execution_result: {
        cooling_completed_naturally: true,
        cooling_duration_code: data.cooling_duration_code,
        cooling_started_at: data.cooling_started_at,
        cooling_expected_end_at: data.cooling_expected_end_at,
        ghl_completed_at: data.completed_at,
      },
    })
    .eq('id', action.id);

  if (updErr) {
    console.error(`[CoolingCallback] /complete update error: ${updErr.message}`);
    return res.status(500).json({ error: 'update_failed' });
  }

  await emitEvent({
    event_type: 'cooling.completed',
    event_subtype: data.cooling_duration_code,
    source: 'ghl_cooling_callback',
    entity_type: 'contact',
    entity_id: data.contact_id,
    ghl_contact_id: data.contact_id,
    payload: {
      ...data,
      enrollment_action_id: action.id,
      enrollment_payload: action.action_payload?.payload || null,
    },
    priority: 'normal',
    idempotency_key: `cooling_complete_${action.id}`,
  });

  console.log(`[CoolingCallback] ✅ /complete: action ${action.id} → cooling.completed emitted for contact ${data.contact_id}`);
  return res.json({ status: 'accepted', mode: 'completed', action_id: action.id });
}

// ─── Handler: /agentic/cooling/error ──────────────────────────────────
async function handleCoolingError(req, res) {
  const { ok, data, reason } = extractCoolingPayload(req.body);
  if (!ok) {
    console.warn(`[CoolingCallback] /error rejected: ${reason}`);
    return res.status(400).json({ error: reason });
  }

  const { action } = await findEnrollmentAction(data.cooling_enrollment_event_id);

  // Idempotency
  if (action && (action.status === 'failed' || action.status === 'completed')) {
    console.log(`[CoolingCallback] /error idempotent: action ${action.id} already in terminal state (${action.status})`);
    return res.json({ status: 'accepted', mode: 'idempotent', action_id: action.id });
  }

  if (action) {
    const nowIso = new Date().toISOString();
    await supabase
      .from('agent_actions')
      .update({
        status: 'failed',
        executed_at: nowIso,
        updated_at: nowIso,
        error_message: `GHL cooling workflow could not find contact ${data.contact_id}`,
        execution_result: {
          cooling_failed: true,
          failure_reason: 'contact_not_found_in_ghl',
          ghl_completed_at: data.completed_at,
        },
      })
      .eq('id', action.id);
  }

  await emitEvent({
    event_type: 'cooling.failed',
    event_subtype: data.cooling_duration_code || 'unknown',
    source: 'ghl_cooling_callback',
    entity_type: 'contact',
    entity_id: data.contact_id,
    ghl_contact_id: data.contact_id,
    payload: {
      ...data,
      failure_reason: 'contact_not_found_in_ghl',
      enrollment_action_id: action?.id || null,
    },
    priority: 'high',
    idempotency_key: `cooling_failed_${data.cooling_enrollment_event_id}`,
  });

  try {
    await sendGroupMeMessage(
      `⚠️ COOLING ENROLLMENT FAILED — contact_id=${data.contact_id} ` +
      `duration=${data.cooling_duration_code} reason=${data.cooling_reason} ` +
      `enrollment_event_id=${data.cooling_enrollment_event_id}. ` +
      `GHL workflow ${data.ghl_workflow_id} couldn't find the contact. ` +
      `agent_actions.id=${action?.id || 'orphan'}.`
    );
  } catch (err) {
    console.warn(`[CoolingCallback] /error GroupMe alert failed: ${err.message}`);
  }

  console.log(`[CoolingCallback] ✅ /error: contact ${data.contact_id} → cooling.failed emitted (orphan=${!action})`);
  return res.json({ status: 'accepted', mode: action ? 'failed' : 'orphan_failed', action_id: action?.id || null });
}

// ─── Route registration ───────────────────────────────────────────────
export function registerCoolingCallbackRoutes(app) {
  app.post('/agentic/cooling/complete', validateBearer, async (req, res) => {
    try {
      await handleCoolingComplete(req, res);
    } catch (err) {
      console.error('[CoolingCallback] /complete unhandled:', err.message, err.stack);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  app.post('/agentic/cooling/error', validateBearer, async (req, res) => {
    try {
      await handleCoolingError(req, res);
    } catch (err) {
      console.error('[CoolingCallback] /error unhandled:', err.message, err.stack);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  console.log('[CoolingCallback] Routes registered: POST /agentic/cooling/complete, /agentic/cooling/error');
}
