/**
 * Action Executor — src/actions/index.js
 *
 * Layer 2 of the agentic system. Reads pending actions from agent_actions,
 * dispatches each through its handler, reports status. Also processes the
 * approval queue before running executions.
 *
 * This is the orchestrator. All handler implementations live under
 * src/actions/handlers/ and each one is small and self-contained. To add a
 * new action type: create a new handler file, import it here, and register
 * it in ACTION_HANDLERS.
 *
 * Refactored from src/action-executor.js on 2026-04-24. Behavior preserved
 * exactly; v4.2 approval-pipeline fixes live in approval-path.js. Stuck-
 * action reaper (added 2026-04-24, Phase 2 added 2026-04-28) runs first
 * as defense against Railway redeploys killing processes mid-handler and
 * against the orphan 'approved' status.
 *
 * MVI v2.5 (2026-05-04) — three additions:
 *   1. send_message acquires an outbound_lock keyed on (contact, trigger_id)
 *      before delegating to executeSendMessage. lock-held → skipped.
 *   2. layer3_dispatch handler — reads layer3_action_dispatch and queues
 *      the row's action sequence into agent_actions. Closes the
 *      no_matching_rules gap (event 18741, Douglas / Bonnie Jennings).
 *   3. emit_event handler — used by Layer 3 sequences and observability rules.
 *
 *   IMPORTANT plumbing note: getEventContext returns the spread payload
 *   directly (not { event, payload, ... }). Both new wrappers fetch the
 *   originating system_events row by action.event_id when they need
 *   structural fields like event.id or event.payload.message_id.
 *
 * Supported action types (26):
 *   add_tag, remove_tag, set_stage, move_opportunity, update_opportunity,
 *   remove_from_workflow, add_to_workflow, book_appointment,
 *   cancel_appointment, reschedule_appointment, create_task,
 *   send_notification, set_lp_appointment, create_lp_lead,
 *   update_lp_dnc_status, update_custom_fields, update_contact_email,
 *   calculate_time_lapse_tier, send_message, layer3_dispatch, emit_event,
 *   compute_rescission_dispatch, check_eligibility, compute_risk_score,
 *   check_throttle, classify_bucket.
 *
 * 2026-05-01 — added create_lp_lead (Jane recovery). Closes the
 * chatbot-in-session-booking gap that left contacts out of LP because
 * Bot 4 didn't set any tag wired to the existing LP-Send Lead workflow.
 *
 * 2026-05-01 — added update_lp_dnc_status (Charles Poulos recovery).
 * Closes the GHL→LP DNC propagation gap that left STOP-keyword DNC
 * contacts marked DNC in GHL but still "Data" disposition in LP.
 *
 * 2026-05-06 — added compute_rescission_dispatch (Thomas Michaud post-mortem).
 * Wires the FL 3-business-day rescission rescue arc. Detects signing-date
 * cues from inbound text, computes deadline + variant via rescission-window.js,
 * synchronously tags + writes custom fields so GHL workflow O.RR can fire on
 * the tag trigger immediately, then queues GroupMe HIGH-priority alert +
 * observability event. past_window branch hands off to L.1 gracefully.
 *
 * 2026-05-02 — added executeActionById + POST /execute-action endpoint
 * (Jeanne Jewell recovery). The FIFO queue order (created_at ASC) means
 * a freshly-queued action sits behind every older pending action.
 *
 * 2026-05-07 — priority lanes (sql/020). Customer-facing actions
 * (send_message=10, layer3_dispatch=15, agentic routing tags=20) skip
 * ahead of bulk batch work at lane 200.
 *
 * 2026-05-13 — Phase 1 Intake/Routing Layer #51: universal suppression
 * for outbound send_message. executeSendMessageWithLock now calls
 * checkSuppression() before acquiring the outbound lock. On match, the
 * send is skipped without lock acquisition or GHL API call.
 *
 * 2026-05-13 — Phase 1 #52: check_eligibility — hard gate for
 * resurrection enrollment (phone, email, suppression, exclusion tags).
 *
 * 2026-05-13 — Phase 1 #54/#55/#56: composite risk scoring and bucket
 * routing for the Day 15 backfill + dormant-pool resurrection. Adds
 * compute_risk_score (40% decay / 25% deliverability / 15% age / 20%
 * intent, locked weights), check_throttle (resurrection_enrollment_log
 * dedup), and classify_bucket (bucket → workflow_id resolver). Together
 * with #51/#52 these form the full Intake/Routing Layer pipeline:
 *   check_eligibility → compute_risk_score → classify_bucket
 *   → check_throttle → add_to_workflow
 * Each step short-circuits the batch on hard fail; classify_bucket
 * exposes target_workflow_id via batchContext._context so the downstream
 * add_to_workflow picks it up without rule re-templating.
 *
 * 2026-05-18 — Antifragile Validation Gate wired into executeSingleAction.
 * The gate runs immediately before handler dispatch, validates the action
 * against codified framework invariants (Antifragile Trust Escalation,
 * Expert Secrets Big Domino, DotCom Traffic Temperature), and rejects
 * actions that violate doctrine. Status 'rejected_by_validation' is the
 * new terminal state for blocked actions. See:
 *   docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md
 *   src/services/validation-gate.js
 *   src/services/validation/doctrine.js
 *   src/services/validation/invariants/*
 * v1 ships TL-1..TL-4 (trust-level invariants). v2 adds stage-integrity,
 * self-fulfilling, channel-integrity, entry-source. Master kill switch:
 * AVG_ENABLED=false. Per-invariant disable: AVG_DISABLE_INVARIANTS=TL-1,TL-2.
 *
 * 2026-06-02 — Phase 2 lead-state: added classify_lead_state. The reactive
 * invoker for the lead-state intelligence layer — classifies a contact
 * (writes agentic_lead_states) and routes the result through the S4.5
 * enrollment gate (shadow-gated). Counterpart to the periodic sweep
 * (src/agentic/lead-state/sweep.js). See src/actions/handlers/lead-state.js.
 */

import supabase from '../supabase.js';
import { executeSendMessage } from '../send-message-handler.js';
import { registerRateLimiterRoutes } from '../ghl-rate-limiter.js';
import { getEventContext } from './resolvers.js';
import { processApprovalQueue } from './approval-path.js';
import { reapStuckActions } from './reaper.js';

// MVI v2.5 — outbound dedup + Layer 3 dispatch
import { tryAcquireLock, releaseLock } from '../services/outbound-locks.js';
import { getDispatchForClassification } from '../services/layer3-dispatch.js';

// Phase 1 Intake/Routing Layer #51 — universal outbound suppression
import { checkSuppression } from '../services/suppression-check.js';

// Antifragile Validation Gate — pre-handler invariant check (2026-05-18)
import { validateAction } from '../services/validation-gate.js';

// ─── Handlers ──────────────────────────────────────────────────────
import { executeAddTag, executeRemoveTag, executeSetStage } from './handlers/tags.js';
import { executeMoveOpportunity, executeUpdateOpportunity } from './handlers/opportunities.js';
import { executeAddToWorkflow, executeRemoveFromWorkflow } from './handlers/workflows.js';
import { executeBookAppointment, executeCancelAppointment, executeRescheduleAppointment } from './handlers/appointments.js';
import { executeSetLPAppointment } from './handlers/lp-appointment.js';
import { executeCreateLPLead } from './handlers/lp-lead.js';
import { executeUpdateLPDNCStatus } from './handlers/lp-dnc.js';
import { executeCreateTask } from './handlers/tasks.js';
import { executeSendNotification } from './handlers/notifications.js';
import { executeUpdateCustomFields, executeUpdateContactEmail } from './handlers/custom-fields.js';
import { executeCalculateTimeLapseTier } from './handlers/time-lapse.js';
import { executeEmitEvent } from './handlers/system-events.js';
import { executeComputeRescissionDispatch } from './handlers/rescission.js';
// Phase 1 #52 — Intake/Routing Layer eligibility gate
import { executeCheckEligibility } from './handlers/eligibility.js';
// Phase 1 #54/#55/#56 — Intake/Routing Layer scoring + routing
import { executeComputeRiskScore } from './handlers/risk-score.js';
import { executeCheckThrottle } from './handlers/throttle.js';
import { executeClassifyBucket } from './handlers/classify-bucket.js';
// S5.2 v2 (Spec v1.2) — objection-state substrate writer
import { executeTransitionObjectionState } from './handlers/objection-state.js';
// Phase 2 lead-state — reactive classifier + S4.5 enrollment invoker
import { executeClassifyLeadState } from './handlers/lead-state.js';

// MVI v2.5 — fetch the source event for a given action. The shared
// getEventContext returns ONLY the spread payload (no event_id /
// event_type). Wrappers that need the event row itself use this helper.
async function fetchSourceEvent(action) {
  if (!action?.event_id) return null;
  const { data } = await supabase
    .from('system_events')
    .select('id, event_type, event_subtype, ghl_contact_id, entity_id, payload')
    .eq('id', action.event_id)
    .maybeSingle();
  return data || null;
}

// ═══════════════════════════════════════════════════════════════════
// MVI v2.5 — send_message wrapper: outbound lock around the existing handler
// Phase 1 #51 — universal suppression check runs BEFORE lock acquisition
// ═══════════════════════════════════════════════════════════════════
//
// Order:
//   1. checkSuppression(contact_id)  — tag-based gate (NEW 2026-05-13)
//   2. tryAcquireLock                — outbound dedup
//   3. executeSendMessage            — actual GHL API call

async function executeSendMessageWithLock(action, context) {
  const params = action.action_payload || {};
  const contact_id = action.target_id;

  // Phase 1 #51 — universal suppression gate. Runs first so suppressed
  // sends do not waste a lock slot or call GHL. Fail-open on infra errors.
  const suppression = await checkSuppression(contact_id);
  if (suppression.suppressed) {
    console.log(
      `[ActionExecutor] send_message suppressed: contact=${contact_id} ` +
      `matched_tag=${suppression.matched_tag} all=${(suppression.all_matches || []).join(',')}`
    );
    return {
      skipped: true,
      reason: 'suppressed',
      matched_tag: suppression.matched_tag,
      all_matches: suppression.all_matches,
      contact_id,
    };
  }

  let trigger_id = params.trigger_id || context?.message_id || null;
  if (!trigger_id) {
    const evt = await fetchSourceEvent(action);
    trigger_id = evt?.payload?.message_id || (evt?.id ? `evt-${evt.id}` : null);
  }

  const lock = await tryAcquireLock({
    contact_id,
    trigger_id,
    sender: 'agent_executor',
    message_preview: params.message || params.body,
  });

  if (!lock.acquired) {
    console.log(
      `[ActionExecutor] send_message blocked by outbound lock: contact=${contact_id} trigger=${trigger_id} held_by=${lock.held_by}`
    );
    return {
      skipped: true,
      reason: 'outbound_lock_held',
      held_by: lock.held_by,
      lock_expires_at: lock.expires_at,
      contact_id,
      trigger_id,
    };
  }

  try {
    const result = await executeSendMessage(action, context);
    return {
      ...result,
      _outbound_lock: { acquired: true, trigger_id, lock_key: lock.lock_key, reason: lock.reason },
    };
  } catch (err) {
    if (trigger_id) await releaseLock(contact_id, trigger_id);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════
// MVI v2.5 — layer3_dispatch handler
// ═══════════════════════════════════════════════════════════════════

async function executeLayer3Dispatch(action /*, context */) {
  const event = await fetchSourceEvent(action);
  if (!event) {
    return { skipped: true, reason: 'no_source_event', action_id: action.id };
  }

  const result = await getDispatchForClassification(event.payload || {});
  if (!result.dispatch) {
    console.log(
      `[ActionExecutor] layer3_dispatch skipped: action=${action.id} reason=${result.reason}` +
      (result.confidence !== undefined ? ` (confidence=${result.confidence}, threshold=${result.threshold})` : '')
    );
    return { skipped: true, ...result };
  }

  const targetId = action.target_id || event.ghl_contact_id || event.entity_id || null;
  const dispatch = result.dispatch;
  const subActions = Array.isArray(dispatch.actions) ? dispatch.actions : [];
  const batchId = `layer3_${event.id}_${dispatch.recommended_action}_${Date.now()}`;
  const queued = [];

  for (let i = 0; i < subActions.length; i++) {
    const tmpl = subActions[i] || {};
    if (!tmpl.action_type) continue;

    const targetSystem = tmpl.target_system || 'ghl';
    const targetEntity = tmpl.target_entity || 'contact';
    const subTargetId = tmpl.target_id || targetId;

    if (targetSystem === 'ghl' && !subTargetId) {
      console.log(`[ActionExecutor] layer3_dispatch: skipping ${tmpl.action_type} — no GHL contact id`);
      continue;
    }

    const insertRow = {
      event_id: event.id,
      action_type: tmpl.action_type,
      target_system: targetSystem,
      target_entity: targetEntity,
      target_id: String(subTargetId || ''),
      action_payload: tmpl.params || tmpl.payload || {},
      reasoning: `LAYER3_DISPATCH(${dispatch.recommended_action}): ${dispatch.notes || 'data-driven dispatch'}`,
      confidence: result.confidence ?? 1.0,
      rule_applied: 'LAYER3_DISPATCH',
      status: 'pending',
      requires_approval: false,
      batch_id: batchId,
      sequence_order: i,
    };
    if (tmpl.priority !== undefined && tmpl.priority !== null) {
      insertRow.priority = tmpl.priority;
    }

    const { data, error } = await supabase.from('agent_actions').insert(insertRow).select().single();

    if (error) {
      console.error(`[ActionExecutor] layer3_dispatch: queue failed for ${tmpl.action_type}: ${error.message}`);
      continue;
    }
    queued.push({ id: data.id, action_type: data.action_type });
  }

  console.log(
    `[ActionExecutor] layer3_dispatch(${dispatch.recommended_action}): queued ${queued.length}/${subActions.length} sub-actions (batch=${batchId})`
  );

  return {
    classification: dispatch.recommended_action,
    confidence: result.confidence,
    threshold: result.threshold,
    queued_count: queued.length,
    queued,
    batch_id: batchId,
  };
}

// ─── Handler registry ──────────────────────────────────────────────
const ACTION_HANDLERS = {
  add_tag: executeAddTag,
  remove_tag: executeRemoveTag,
  set_stage: executeSetStage,                   // v4.3 — atomic stage tag swap
  move_opportunity: executeMoveOpportunity,
  update_opportunity: executeUpdateOpportunity,
  remove_from_workflow: executeRemoveFromWorkflow,
  add_to_workflow: executeAddToWorkflow,
  book_appointment: executeBookAppointment,
  cancel_appointment: executeCancelAppointment,
  reschedule_appointment: executeRescheduleAppointment, // v2.7.8 — agentic reschedule (cancel old + book new)
  create_task: executeCreateTask,
  send_notification: executeSendNotification,
  set_lp_appointment: executeSetLPAppointment,
  create_lp_lead: executeCreateLPLead,           // 2026-05-01 — agentic LP push (Jane recovery)
  update_lp_dnc_status: executeUpdateLPDNCStatus, // 2026-05-01 — agentic DNC push (Charles Poulos recovery)
  update_custom_fields: executeUpdateCustomFields,
  update_contact_email: executeUpdateContactEmail,
  calculate_time_lapse_tier: executeCalculateTimeLapseTier,
  send_message: executeSendMessageWithLock,      // MVI v2.5 — outbound_locks wrap; 2026-05-13 — + suppression gate
  layer3_dispatch: executeLayer3Dispatch,        // MVI v2.5 — Layer 3 fan-out
  emit_event: executeEmitEvent,                  // MVI v2.5 — observability / follow-on
  compute_rescission_dispatch: executeComputeRescissionDispatch, // 2026-05-06 — FL rescission rescue (Thomas Michaud post-mortem)
  check_eligibility: executeCheckEligibility,    // 2026-05-13 — Phase 1 #52 Intake/Routing eligibility gate
  compute_risk_score: executeComputeRiskScore,   // 2026-05-13 — Phase 1 #54 composite scoring
  check_throttle: executeCheckThrottle,          // 2026-05-13 — Phase 1 #55 enrollment dedup
  classify_bucket: executeClassifyBucket,        // 2026-05-13 — Phase 1 #56 bucket→workflow resolver
  transition_objection_state: executeTransitionObjectionState, // 2026-05-14 — S5.2 v2 objection-state substrate writer (Spec v1.2)
  classify_lead_state: executeClassifyLeadState, // 2026-06-02 — Phase 2 lead-state classifier + S4.5 enrollment (reactive invoker)
};

// Handlers that need the triggering event's payload injected as context.
const CONTEXT_AWARE_HANDLERS = new Set([
  'send_notification',
  'create_task',
  'book_appointment',
  'reschedule_appointment',  // v2.7.8 — needs context for date interpolation in new_start_time
  'update_contact_email',
  'send_message',
  'create_lp_lead',          // 2026-05-01 — needs event payload for appointment_date/time
]);
// Note: layer3_dispatch doesn't go through CONTEXT_AWARE_HANDLERS because
// it fetches its own source event row (it needs event.id, not just the
// spread payload that getEventContext provides).
// compute_rescission_dispatch also fetches its own source event for the
// same reason (needs event.id and event.created_at for sign-date defaulting).
// check_eligibility / compute_risk_score / check_throttle / classify_bucket
// (Phase 1 Intake/Routing) do not need event context — they operate only on
// action.target_id and the action_payload, plus shared batchContext written
// by upstream handlers via result._context (classify_bucket sets
// bucket_target_workflow_id for downstream add_to_workflow).
// classify_lead_state (Phase 2 lead-state) also does not need event context —
// it operates on action.target_id (the contact) and builds its own context
// via the classifier's buildLeadContext call.

// ═══════════════════════════════════════════════════════════════════
// EXECUTOR ENGINE
// ═══════════════════════════════════════════════════════════════════

async function executeSingleAction(action, batchContext = {}, priorBatchResults = []) {
  const handler = ACTION_HANDLERS[action.action_type];
  if (!handler) {
    await supabase.from('agent_actions').update({
      status: 'failed',
      error_message: `Unknown action type: ${action.action_type}`,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    return { action_id: action.id, status: 'failed', error: `Unknown: ${action.action_type}` };
  }

  await supabase.from('agent_actions').update({
    status: 'executing',
    updated_at: new Date().toISOString(),
  }).eq('id', action.id);

  // ═══ Antifragile Validation Gate (2026-05-18) ═══════════════════
  // Runs immediately before handler dispatch. Blocks actions that violate
  // codified framework invariants (Antifragile Trust Escalation, Expert
  // Secrets Big Domino, DotCom Traffic Temperature). Fail-open on infra
  // errors. See docs/ANTIFRAGILE_VALIDATION_GATE_DOCTRINE.md.
  let validation;
  try {
    validation = await validateAction(action, { priorBatchResults });
  } catch (e) {
    console.error(`[ActionExecutor] AVG threw (fail-open): ${e.message}`);
    validation = { decision: 'pass', blocked: false, warnings: [], reason: 'avg_exception_open' };
  }

  if (validation.blocked) {
    await supabase.from('agent_actions').update({
      status: 'rejected_by_validation',
      error_message:
        `AVG ${validation.blocking_invariant.key} — ${validation.blocking_invariant.name}: ` +
        `${validation.blocking_reason}`,
      execution_result: validation,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    return {
      action_id: action.id,
      status: 'rejected_by_validation',
      action_type: action.action_type,
      validation,
    };
  }
  // ═══════════════════════════════════════════════════════════════════

  try {
    let context = {};
    if (CONTEXT_AWARE_HANDLERS.has(action.action_type)) {
      context = { ...(await getEventContext(action)), ...batchContext };
    }
    const result = await handler(action, context);
    if (result?._context) Object.assign(batchContext, result._context);
    await supabase.from('agent_actions').update({
      status: 'completed',
      execution_result: result,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    console.log(`[ActionExecutor] ✅ ${action.action_type} completed (action ${action.id}, rule: ${action.rule_applied})`);
    return {
      action_id: action.id,
      status: 'completed',
      action_type: action.action_type,
      result,
    };
  } catch (err) {
    const retries = (action.retry_count || 0) + 1;
    const max = action.max_retries || 3;
    const st = retries >= max ? 'failed' : 'pending';
    await supabase.from('agent_actions').update({
      status: st,
      error_message: err.message,
      retry_count: retries,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    console.error(`[ActionExecutor] ❌ ${action.action_type} failed (action ${action.id}): ${err.message} [retry ${retries}/${max}]`);
    return {
      action_id: action.id,
      status: st,
      action_type: action.action_type,
      error: err.message,
      retry: `${retries}/${max}`,
    };
  }
}

export async function executeActions({ limit = 50 } = {}) {
  const startTime = Date.now();

  // Phase 0: reap any 'executing' actions stuck from a killed process,
  // and any orphaned 'approved' status rows from the legacy MCP
  // approve_action bug (fixed in 2ac7f25 on 2026-04-28). Requeues
  // idempotent ones to 'pending' (they'll run in phase 2 below) and
  // fails non-idempotent / retry-exhausted ones with an audit trail.
  const reaperResult = await reapStuckActions();

  // Phase 1: process any pending_approval actions (send GroupMe cards).
  const approvalRequestsSent = await processApprovalQueue();

  // Phase 2: execute actions whose status is 'pending' (approved or auto-approved).
  // Pull order (sql/020 — priority lanes, 2026-05-07):
  //   1. priority ASC      — customer-facing (10) before background batch (200)
  //   2. created_at ASC    — within a lane, oldest first (FIFO)
  //   3. sequence_order ASC — within a batch, respect intra-batch order
  // The partial index idx_aa_priority_pull (status=pending) covers this exactly.
  const { data: actions, error } = await supabase.from('agent_actions')
    .select('*')
    .eq('status', 'pending')
    .order('priority', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .order('sequence_order', { ascending: true })
    .limit(limit);

  if (error) return { success: false, error: error.message };
  if (!actions?.length) {
    return {
      success: true,
      actions_executed: 0,
      approval_requests_sent: approvalRequestsSent,
      stuck_actions_reaped: reaperResult.reaped || 0,
      elapsed_ms: Date.now() - startTime,
    };
  }

  const batches = new Map();
  for (const a of actions) {
    const k = a.batch_id || `s_${a.id}`;
    if (!batches.has(k)) batches.set(k, []);
    batches.get(k).push(a);
  }
  for (const b of batches.values()) {
    b.sort((a, b) => (a.sequence_order || 0) - (b.sequence_order || 0));
  }

  console.log(`[ActionExecutor] Executing ${actions.length} actions in ${batches.size} batches...`);
  const results = [];
  let completed = 0, failed = 0, rejectedByValidation = 0;
  for (const [, ba] of batches) {
    const batchContext = {};
    const priorBatchResults = [];
    for (const a of ba) {
      const r = await executeSingleAction(a, batchContext, priorBatchResults);
      results.push(r);
      priorBatchResults.push({ ...r, action: a });
      if (r.status === 'completed') completed++;
      else if (r.status === 'failed') { failed++; break; }
      else if (r.status === 'rejected_by_validation') rejectedByValidation++;
      // 'rejected_by_validation' does NOT break the batch — siblings continue.
      // A single invariant violation shouldn't kill unrelated routing.
    }
  }
  const elapsed = Date.now() - startTime;
  console.log(`[ActionExecutor] Done: ${completed} completed, ${failed} failed, ${rejectedByValidation} rejected_by_validation (${elapsed}ms)`);
  return {
    success: true,
    actions_executed: results.length,
    completed,
    failed,
    rejected_by_validation: rejectedByValidation,
    retrying: results.filter(r => r.status === 'pending').length,
    approval_requests_sent: approvalRequestsSent,
    stuck_actions_reaped: reaperResult.reaped || 0,
    reaper_detail: reaperResult.reaped > 0 ? reaperResult : undefined,
    results,
    elapsed_ms: elapsed,
  };
}

/**
 * 2026-05-02 — Direct execute by ID. Runs a single action immediately,
 * bypassing the FIFO queue ordering. Used for recovery flows and time-
 * sensitive operations where waiting on the 5K+ pending queue is not
 * acceptable.
 *
 * @param {number} actionId
 * @param {object} [opts]
 * @param {boolean} [opts.allowExecuting=true]  Run actions stuck in 'executing'
 * @param {boolean} [opts.resetRetryCount=true] For failed actions, reset retry_count
 * @returns {Promise<object>} executeSingleAction result
 */
export async function executeActionById(actionId, opts = {}) {
  const { allowExecuting = true, resetRetryCount = true } = opts;

  if (typeof actionId !== 'number' || !Number.isFinite(actionId)) {
    throw new Error('executeActionById: actionId must be a finite number');
  }

  const { data: action, error: fetchErr } = await supabase
    .from('agent_actions')
    .select('*')
    .eq('id', actionId)
    .maybeSingle();

  if (fetchErr) throw new Error(`Failed to fetch action ${actionId}: ${fetchErr.message}`);
  if (!action) throw new Error(`Action ${actionId} not found`);

  const terminal = new Set(['completed', 'rejected', 'rejected_by_validation']);
  if (terminal.has(action.status)) {
    return {
      action_id: actionId,
      status: action.status,
      skipped: true,
      reason: `Action is in terminal state '${action.status}'. Reset status manually to re-run.`,
    };
  }

  if (action.status === 'pending_approval') {
    return {
      action_id: actionId,
      status: 'pending_approval',
      skipped: true,
      reason: 'Action requires approval. Use approve_action first, then re-call execute-action.',
    };
  }

  if (action.status === 'executing' && !allowExecuting) {
    return {
      action_id: actionId,
      status: 'executing',
      skipped: true,
      reason: 'Action already in executing state. Pass allowExecuting=true to override.',
    };
  }

  // For previously-failed actions, reset the retry counter so the manual
  // re-run gets a fresh attempt budget. Keep error_message for audit.
  if (action.status === 'failed' && resetRetryCount) {
    await supabase.from('agent_actions').update({
      retry_count: 0,
      updated_at: new Date().toISOString(),
    }).eq('id', actionId);
    action.retry_count = 0;
  }

  console.log(`[ActionExecutor] Direct-execute action ${actionId} (type: ${action.action_type}, prior status: ${action.status})`);
  const result = await executeSingleAction(action, {}, []);
  return {
    ...result,
    direct_execute: true,
    prior_status: action.status,
  };
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════

export function registerActionExecutorRoutes(app) {
  app.post('/n8n/decision-engine/execute', async (req, res) => {
    try {
      res.json(await executeActions({ limit: req.body?.limit || 50 }));
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 2026-05-02 — Direct execute by action_id. Bypasses FIFO queue.
  app.post('/n8n/decision-engine/execute-action', async (req, res) => {
    try {
      const actionId = Number(req.body?.action_id);
      if (!Number.isFinite(actionId)) {
        return res.status(400).json({ success: false, error: 'action_id is required (number)' });
      }
      const result = await executeActionById(actionId, {
        allowExecuting: req.body?.allow_executing !== false,
        resetRetryCount: req.body?.reset_retry_count !== false,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/n8n/decision-engine/execute-action/:id', async (req, res) => {
    try {
      const actionId = Number(req.params.id);
      if (!Number.isFinite(actionId)) {
        return res.status(400).json({ success: false, error: 'id must be a number' });
      }
      const result = await executeActionById(actionId, {
        allowExecuting: req.body?.allow_executing !== false,
        resetRetryCount: req.body?.reset_retry_count !== false,
      });
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/n8n/decision-engine/execution-stats', async (req, res) => {
    try {
      const [p, a, c, f, e, rv] = await Promise.all([
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'completed'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'executing'),
        supabase.from('agent_actions').select('id', { count: 'exact', head: true }).eq('status', 'rejected_by_validation'),
      ]);
      res.json({
        pending: p.count || 0,
        pending_approval: a.count || 0,
        completed: c.count || 0,
        failed: f.count || 0,
        executing: e.count || 0,
        rejected_by_validation: rv.count || 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  registerRateLimiterRoutes(app);
}
