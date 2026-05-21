/**
 * Objection Fall-Through Sweep — src/objection-fall-through-sweep.js
 *
 * Detects "genuine fall-throughs" — Layer 3 detected an objection but no
 * downstream routing rule picked the contact up. Examples:
 *   - competitor or DIY objections (no state-classifier rule covers them)
 *   - contact in an undetermined funnel state (no appointment tag, no
 *     demo-completed tag → neither Rule 214 nor Rule 215 matches)
 *   - state-handler crashed before writing a state row + enrollment
 *
 * These cases used to be caught by layer3_action_dispatch row 8's
 * create_task action, which fired unconditionally with the misleading
 * message "did not auto-route" — even when routing actually succeeded
 * via the state handler or Rules 214/215.
 *
 * v1.6 of objection-state.js + Rules 214/215 now emit accurate
 * "routed to X" notifications when they succeed. This sweep covers
 * the remaining gap: the cases where NEITHER fired.
 *
 * Detection logic — for each intent.objection_detected event in the
 * past LOOKBACK_MINUTES (default 15) that has not yet been swept:
 *   1. Skip if the contact has a contact_objection_states row created
 *      since the event. The state handler picked it up.
 *   2. Skip if an agent_actions row exists with action_type='add_to_workflow'
 *      AND rule_applied in ('STATE_ENROLLMENT', 'OBJECTION_ROUTE_POST_DEMO',
 *      'OBJECTION_ROUTE_PRE_DEMO') AND created_at > event.created_at.
 *      A legacy routing rule picked it up.
 *   3. Otherwise → emit a "fall-through" send_notification agent_action
 *      naming the objection type and reasoning the analyzer extracted.
 *
 * Idempotency: each event is keyed by `fallthrough_sweep_{event_id}` so
 * subsequent sweep runs don't double-notify on the same event. The
 * idempotency_key sits on the emitted notification action's reasoning
 * field as a stable substring search.
 *
 * Tuning knobs (env or defaults):
 *   FALLTHROUGH_SWEEP_LOOKBACK_MIN=15
 *   FALLTHROUGH_SWEEP_GRACE_MIN=3      (don't sweep events <3min old —
 *                                       give downstream rules time to fire)
 *   FALLTHROUGH_SWEEP_BATCH=200
 *   FALLTHROUGH_SWEEP_INTERVAL_MS=300000  (5 minutes)
 */

import supabase from './supabase.js';

const LOOKBACK_MIN = Number(process.env.FALLTHROUGH_SWEEP_LOOKBACK_MIN || 15);
const GRACE_MIN = Number(process.env.FALLTHROUGH_SWEEP_GRACE_MIN || 3);
const BATCH = Number(process.env.FALLTHROUGH_SWEEP_BATCH || 200);
const INTERVAL_MS = Number(process.env.FALLTHROUGH_SWEEP_INTERVAL_MS || 5 * 60 * 1000);

const ROUTING_RULE_KEYS = [
  'STATE_ENROLLMENT',
  'OBJECTION_ROUTE_POST_DEMO',
  'OBJECTION_ROUTE_PRE_DEMO',
];

/**
 * Pull intent.objection_detected events in the lookback window that are
 * outside the grace period. The Decision Engine emits this event_type
 * via layer3_action_dispatch row 8 whenever Layer 3 classifies an
 * inbound message as an objection.
 */
async function findFallthroughCandidates(now) {
  const lookbackCutoff = new Date(now.getTime() - LOOKBACK_MIN * 60_000).toISOString();
  const graceCutoff = new Date(now.getTime() - GRACE_MIN * 60_000).toISOString();

  const { data, error } = await supabase
    .from('system_events')
    .select('id, ghl_contact_id, event_type, event_timestamp, created_at, payload')
    .eq('event_type', 'intent.objection_detected')
    .gte('created_at', lookbackCutoff)
    .lte('created_at', graceCutoff)
    .not('ghl_contact_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(BATCH);

  if (error) throw new Error(`fallthrough sweep candidate query: ${error.message}`);
  return data || [];
}

async function hasStateRowSince(contact_id, since_iso) {
  try {
    const { data, error } = await supabase
      .from('contact_objection_states')
      .select('id')
      .eq('contact_id', contact_id)
      .gte('entered_at', since_iso)
      .limit(1);
    if (error) return false;
    return (data || []).length > 0;
  } catch {
    return false;
  }
}

async function hasRoutingActionSince(contact_id, since_iso) {
  try {
    const { data, error } = await supabase
      .from('agent_actions')
      .select('id, rule_applied')
      .eq('target_id', contact_id)
      .eq('action_type', 'add_to_workflow')
      .in('rule_applied', ROUTING_RULE_KEYS)
      .gte('created_at', since_iso)
      .limit(1);
    if (error) return false;
    return (data || []).length > 0;
  } catch {
    return false;
  }
}

/**
 * Has this event already been swept? Look for any send_notification
 * agent_action whose reasoning field contains the per-event idempotency
 * key. Returns true if a prior sweep already notified on this event,
 * preventing duplicate alerts on subsequent runs.
 */
async function alreadySwept(event_id) {
  const key = `fallthrough_sweep_event_${event_id}`;
  try {
    const { data, error } = await supabase
      .from('agent_actions')
      .select('id')
      .eq('action_type', 'send_notification')
      .eq('rule_applied', 'OBJECTION_FALLTHROUGH_SWEEP')
      .ilike('reasoning', `%${key}%`)
      .limit(1);
    if (error) return false;
    return (data || []).length > 0;
  } catch {
    return false;
  }
}

function extractObjectionInfo(payload) {
  // intent.objection_detected payloads carry fields from the message
  // analyzer's ai.analysis_completed event. Both common shapes are
  // handled: nested under `analysis` or flat at the top level.
  const root = payload || {};
  const analysis = root.analysis || root;
  return {
    objection_type: analysis.objection_type || root.objection_type || 'unknown',
    objection_confidence: analysis.objection_confidence || root.objection_confidence || null,
    buyer_stage: analysis.buyer_stage || root.buyer_stage || null,
    inbound_preview:
      analysis.inbound_message_preview ||
      root.inbound_message_preview ||
      (analysis.reasoning || root.reasoning || '').slice(0, 200) ||
      null,
  };
}

async function emitFallthroughNotification({ event, info }) {
  const key = `fallthrough_sweep_event_${event.id}`;
  const narrativeBits = [
    `Layer 3 detected a ${info.objection_type} objection but neither the state classifier nor Rules 214/215 routed the contact.`,
  ];
  if (info.objection_confidence != null) {
    narrativeBits.push(`Confidence ${info.objection_confidence}.`);
  }
  if (info.buyer_stage != null) {
    narrativeBits.push(`Buyer stage ${info.buyer_stage}.`);
  }
  if (info.inbound_preview) {
    const preview = info.inbound_preview.length > 180
      ? info.inbound_preview.slice(0, 180) + '…'
      : info.inbound_preview;
    narrativeBits.push(`Recent reasoning/inbound: "${preview}"`);
  }
  narrativeBits.push('Review the contact and either enroll manually or add a routing rule for this objection type.');

  const narrative = narrativeBits.join(' ');

  try {
    const { error } = await supabase
      .from('agent_actions')
      .insert({
        action_type: 'send_notification',
        target_system: 'lp',
        target_entity: 'contact',
        target_id: String(event.ghl_contact_id),
        action_payload: {
          notification_class: 'priority',
          action_verb: `OBJECTION FALL-THROUGH — ${info.objection_type.toUpperCase()}`,
          tier: 'Warm',
          status: 'Manual Review Required',
          narrative,
          next_step: 'Review and enroll in O.0 (post-demo) or S5.2 v2 (pre-demo) manually',
          cooldown_minutes: 60,
        },
        // Per-event idempotency: the key appears in reasoning, so the
        // alreadySwept() lookup finds it on subsequent sweep runs and
        // skips re-notifying. cooldown_minutes provides a second layer
        // of dedup if the same contact has multiple fall-throughs in
        // quick succession.
        reasoning: `Fall-through sweep — no routing observed for intent.objection_detected event ${event.id} after ${GRACE_MIN}min grace window. key=${key}`,
        rule_applied: 'OBJECTION_FALLTHROUGH_SWEEP',
        status: 'pending',
        requires_approval: false,
        priority: 25,
      });
    if (error) {
      console.warn(`[FallthroughSweep] enqueue notification failed for event ${event.id}: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[FallthroughSweep] enqueue notification threw for event ${event.id}: ${err.message}`);
    return false;
  }
}

export async function runFallthroughSweep({ dryRun = false } = {}) {
  const start = Date.now();
  const now = new Date();
  const candidates = await findFallthroughCandidates(now);

  let emitted = 0;
  let skippedStateRow = 0;
  let skippedRoutingAction = 0;
  let skippedAlreadySwept = 0;
  let errors = 0;
  const details = [];

  for (const event of candidates) {
    const contactId = event.ghl_contact_id;
    if (!contactId) continue;
    try {
      if (await alreadySwept(event.id)) {
        skippedAlreadySwept++;
        continue;
      }
      if (await hasStateRowSince(contactId, event.created_at)) {
        skippedStateRow++;
        continue;
      }
      if (await hasRoutingActionSince(contactId, event.created_at)) {
        skippedRoutingAction++;
        continue;
      }

      const info = extractObjectionInfo(event.payload);

      if (dryRun) {
        emitted++;
        details.push({
          event_id: event.id,
          contact_id: contactId,
          objection_type: info.objection_type,
          would_emit: true,
        });
        continue;
      }

      const ok = await emitFallthroughNotification({ event, info });
      if (ok) emitted++;
    } catch (err) {
      errors++;
      console.error(`[FallthroughSweep] event ${event.id} failed: ${err.message}`);
    }
  }

  const summary = {
    success: true,
    candidates: candidates.length,
    emitted,
    skipped_state_row: skippedStateRow,
    skipped_routing_action: skippedRoutingAction,
    skipped_already_swept: skippedAlreadySwept,
    errors,
    dry_run: !!dryRun,
    elapsed_ms: Date.now() - start,
  };
  if (dryRun) summary.details = details;
  console.log(
    `[FallthroughSweep] ${candidates.length} candidates → ${emitted} emitted, ` +
    `${skippedStateRow} skipped (state row), ${skippedRoutingAction} skipped (routing action), ` +
    `${skippedAlreadySwept} skipped (already swept), ${errors} errors (${summary.elapsed_ms}ms)`
  );
  return summary;
}

let intervalHandle = null;

export function startFallthroughSweepScheduler() {
  if (intervalHandle) return;
  // First run after 3 minutes (server-settle delay, matches ghost sweep).
  setTimeout(() => {
    runFallthroughSweep().catch(err =>
      console.error('[FallthroughSweep] scheduled run failed:', err.message),
    );
    intervalHandle = setInterval(() => {
      runFallthroughSweep().catch(err =>
        console.error('[FallthroughSweep] scheduled run failed:', err.message),
      );
    }, INTERVAL_MS);
  }, 180_000);
  console.log(
    `[FallthroughSweep] Scheduler armed: ${LOOKBACK_MIN}min lookback, ${GRACE_MIN}min grace, ` +
    `${INTERVAL_MS / 60_000}min cadence`,
  );
}

export function registerFallthroughSweepRoutes(app) {
  app.post('/n8n/objection-state/fallthrough-sweep', async (req, res) => {
    try {
      const dryRun = req.body?.dryRun === true || req.query?.dryRun === 'true';
      const result = await runFallthroughSweep({ dryRun });
      res.json(result);
    } catch (err) {
      console.error('[FallthroughSweep] /fallthrough-sweep error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });
  console.log('[FallthroughSweep] Registered: POST /n8n/objection-state/fallthrough-sweep');
}
