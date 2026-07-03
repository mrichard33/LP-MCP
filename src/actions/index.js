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
 * Supported action types (27):
 *   add_tag, remove_tag, set_stage, move_opportunity, update_opportunity,
 *   remove_from_workflow, add_to_workflow, book_appointment,
 *   cancel_appointment, reschedule_appointment, update_appointment_status,
 *   create_task,
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
import { runPool, groupByBatch } from './concurrency.js';
import { classifyHandlerResult } from './result-status.js';

// MVI v2.5 — outbound dedup + Layer 3 dispatch
import { tryAcquireLock, releaseLock, checkLock, decideLockHeldReschedule, shouldKeepOutboundLock } from '../services/outbound-locks.js';
import { getDispatchForClassification } from '../services/layer3-dispatch.js';

// 2026-07-03 — enforcing per-contact single-flight + cooldown (Steve Nkzhm
// incident). Complements outbound_locks, which is per (contact, trigger_id)
// and therefore blind to two sends with different trigger_ids.
import { acquireAgenticSlot, releaseAgenticSlot, commitAgenticSend } from '../services/agentic-reply-locks.js';

// 2026-06-16 — Layer-3 suppress telemetry + silent agentic teardown
import { emitEvent } from '../event-emitter.js';
import { endAgenticHandoff } from '../services/agentic-handoff.js';

// Phase 1 Intake/Routing Layer #51 — universal outbound suppression
// 2026-07-03 — checkMutationSuppression: suppress-automation / stop-bot now
// gates ALL mutating action types, not only send_message.
import { checkSuppression, checkMutationSuppression } from '../services/suppression-check.js';
// Send-dedup — logical-identity idempotency for non-idempotent senders (2026-06-05)
import { claimSendMark, releaseSendMark, makeDedupKey } from '../services/send-dedup.js';

// Antifragile Validation Gate — pre-handler invariant check (2026-05-18)
import { validateAction } from '../services/validation-gate.js';

// ─── Handlers ──────────────────────────────────────────────────────
import { executeAddTag, executeRemoveTag, executeSetStage } from './handlers/tags.js';
import { executeMoveOpportunity, executeUpdateOpportunity } from './handlers/opportunities.js';
import { executeAddToWorkflow, executeRemoveFromWorkflow, executeIssueHold } from './handlers/workflows.js';
import { executeBookAppointment, executeCancelAppointment, executeRescheduleAppointment, executeUpdateAppointmentStatus } from './handlers/appointments.js';
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
//   2. acquireAgenticSlot            — per-contact single-flight + cooldown
//   3. tryAcquireLock                — outbound dedup per (contact, trigger)
//   4. executeSendMessage            — actual GHL API call
//
// Lock hygiene (2026-07-03 P0, agent_actions 165762/165770): every exit
// that did NOT consume the inbound (superseded, blocked, suppressed, no
// channel, no trigger message) releases the outbound lock — see
// shouldKeepOutboundLock. A send blocked by a live lock is RESCHEDULED
// (bounded polling via decideLockHeldReschedule), never terminal-skipped;
// otherwise a leaked lock deadlocks the reply until TTL and the contact is
// never answered. The reschedule timer is in-process — a restart drops it
// (same accepted limitation as the cooldown reschedule below); the action
// stays visible as skipped/outbound_lock_held + rescheduled for forensics
// and can be re-run manually, where the presumed-sent guard keeps the
// re-run duplicate-safe.

// In-memory reschedule attempt counter for lock-held sends. Cleared on
// restart — with the timers gone too, a fresh process starts a fresh budget.
const lockHeldAttempts = new Map();

async function executeSendMessageWithLock(action, context) {
  const params = action.action_payload || {};
  const contact_id = action.target_id;

  // ── Presumed-sent guard (2026-07-03) ──
  // Re-run of a lock-held reschedule: if the blocking lock ran to full TTL
  // WITHOUT being released, its holder either sent (sends keep the lock by
  // design) or hard-crashed mid-send. send_message is non-idempotent
  // (reaper.js: NON_IDEMPOTENT_ACTION_TYPES) — drop over duplicate.
  const priorSkip = action.status === 'skipped'
    && action.execution_result?.reason === 'outbound_lock_held';
  if (priorSkip) {
    const priorTrigger = action.execution_result?.trigger_id;
    if (priorTrigger) {
      const prior = await checkLock(contact_id, priorTrigger);
      const expired = prior.expires_at && Date.parse(prior.expires_at) < Date.now();
      if (!prior.held && expired && !prior.released_at) {
        console.warn(
          `[ActionExecutor] send_message re-run for action ${action.id}: prior lock ` +
          `${contact_id}:${priorTrigger} expired unreleased — holder presumed sent, skipping`
        );
        lockHeldAttempts.delete(action.id);
        return {
          skipped: true,
          reason: 'holder_expired_unreleased_presumed_sent',
          contact_id,
          trigger_id: priorTrigger,
        };
      }
    }
  }

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

  // ── Enforcing per-contact single-flight + cooldown (2026-07-03) ──
  // At most ONE agentic reply in flight per contact; sends are spaced by
  // MIN_AGENTIC_SEND_GAP_SEC. A job that arrives while another is in flight
  // supersedes it (the displaced job aborts before its GHL POST — it is
  // unsent, so nothing is recalled). A job that lands inside the cooldown is
  // rescheduled via executeActionById: the re-run repeats this whole gate,
  // so supersession and suppression are re-checked at send time. The timer
  // is in-process — a restart during the (≤90s) window drops the reschedule;
  // the action row stays visible as skipped/agentic_cooldown for forensics.
  const agenticJobId = String(action.id ?? `job-${trigger_id || contact_id}`);
  const slot = await acquireAgenticSlot({
    contact_id,
    job_id: agenticJobId,
    trigger_id,
    holder: 'agent_executor',
  });
  if (!slot.acquired && slot.reason === 'cooldown') {
    const delayMs = Math.max(1000, (slot.retry_in_ms || 0) + 500);
    if (Number.isFinite(Number(action.id))) {
      console.log(
        `[ActionExecutor] send_message inside agentic cooldown: contact=${contact_id} ` +
        `action=${action.id} retry_at=${slot.retry_at} — rescheduling in ${Math.round(delayMs / 1000)}s`
      );
      const timer = setTimeout(() => {
        executeActionById(Number(action.id)).catch((err) =>
          console.error(`[ActionExecutor] cooldown re-run failed for action ${action.id}: ${err.message}`)
        );
      }, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
    } else {
      console.warn(
        `[ActionExecutor] send_message inside agentic cooldown with no action id: contact=${contact_id} — skipping (cannot reschedule)`
      );
    }
    return {
      skipped: true,
      reason: 'agentic_cooldown',
      retry_at: slot.retry_at,
      rescheduled: Number.isFinite(Number(action.id)),
      contact_id,
      trigger_id,
    };
  }
  if (slot.superseded_job_id) {
    console.log(
      `[ActionExecutor] send_message job ${agenticJobId} superseded unsent job ${slot.superseded_job_id} for contact ${contact_id}`
    );
  }

  const lock = await tryAcquireLock({
    contact_id,
    trigger_id,
    sender: 'agent_executor',
    message_preview: params.message || params.body,
    // Award the slot deterministically by action priority (lower = higher
    // priority) so the intended primary send wins over a racing sibling.
    priority: Number.isFinite(action.priority) ? action.priority : undefined,
  });

  if (!lock.acquired) {
    console.log(
      `[ActionExecutor] send_message blocked by outbound lock: contact=${contact_id} trigger=${trigger_id} held_by=${lock.held_by}`
    );
    // Reschedule past the holder (2026-07-03 P0 fix) instead of terminal-
    // skipping — a leaked/held lock must delay the reply, not kill it.
    //
    // The agentic slot is deliberately KEPT while rescheduled: releasing it
    // here deleted the row this job took over at acquire time, so the
    // superseded older job's checkNotSuperseded saw no_row, sent its stale
    // reply, and commitAgenticSend found no row to arm the cooldown —
    // a stale send plus a double-send window. Held, the slot keeps older
    // jobs superseded, newer jobs can still displace it, and it self-heals
    // via the LOCK_TTL_SEC reclaim if this timer is lost to a restart.
    const canReschedule = Number.isFinite(Number(action.id));
    if (canReschedule) {
      const attempt = lockHeldAttempts.get(action.id) || 0;
      const decision = decideLockHeldReschedule(lock.expires_at, Date.now(), { attempt });
      if (decision.reschedule) {
        lockHeldAttempts.set(action.id, attempt + 1);
        console.log(
          `[ActionExecutor] send_message lock held: contact=${contact_id} action=${action.id} ` +
          `attempt=${attempt + 1} — rescheduling in ${Math.round(decision.delayMs / 1000)}s (${decision.reason})`
        );
        const timer = setTimeout(() => {
          executeActionById(Number(action.id)).catch((err) =>
            console.error(`[ActionExecutor] lock-held re-run failed for action ${action.id}: ${err.message}`)
          );
        }, decision.delayMs);
        if (typeof timer.unref === 'function') timer.unref();
        return {
          skipped: true,
          reason: 'outbound_lock_held',
          rescheduled: true,
          retry_at: decision.retryAt,
          held_by: lock.held_by,
          lock_expires_at: lock.expires_at,
          contact_id,
          trigger_id,
        };
      }
      console.warn(
        `[ActionExecutor] send_message lock-held retries exhausted: contact=${contact_id} action=${action.id}`
      );
      lockHeldAttempts.delete(action.id);
      await releaseAgenticSlot(contact_id, agenticJobId);
      return {
        skipped: true,
        reason: 'outbound_lock_retry_exhausted',
        rescheduled: false,
        held_by: lock.held_by,
        lock_expires_at: lock.expires_at,
        contact_id,
        trigger_id,
      };
    }
    // No numeric action id — cannot reschedule; free the slot and skip.
    await releaseAgenticSlot(contact_id, agenticJobId);
    return {
      skipped: true,
      reason: 'outbound_lock_held',
      rescheduled: false,
      held_by: lock.held_by,
      lock_expires_at: lock.expires_at,
      contact_id,
      trigger_id,
    };
  }

  lockHeldAttempts.delete(action.id);

  try {
    const result = await executeSendMessage(action, context);
    // 'message_sent' arms the per-contact cooldown; both it and
    // 'send_message_handed_off' CONSUMED the inbound, so their outbound
    // lock is kept until TTL as the post-outcome dedup. Every other
    // outcome (blocked, suppressed, superseded, no channel, no trigger
    // message) sent nothing — release BOTH locks so a superseding or
    // rescheduled job is not deadlocked until lock expiry (2026-07-03 P0:
    // agent_actions 165762/165770).
    if (result?.action === 'message_sent') {
      await commitAgenticSend(contact_id, agenticJobId);
    } else {
      await releaseAgenticSlot(contact_id, agenticJobId);
    }
    if (!shouldKeepOutboundLock(result?.action) && trigger_id) {
      await releaseLock(contact_id, trigger_id, { expected_expires_at: lock.expires_at });
    }
    return {
      ...result,
      _outbound_lock: { acquired: true, trigger_id, lock_key: lock.lock_key, reason: lock.reason },
    };
  } catch (err) {
    if (trigger_id) await releaseLock(contact_id, trigger_id, { expected_expires_at: lock.expires_at });
    await releaseAgenticSlot(contact_id, agenticJobId);
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

  const dispatchContactId = action.target_id || event.ghl_contact_id || event.entity_id || null;
  const result = await getDispatchForClassification(event.payload || {}, { contactId: dispatchContactId });
  if (!result.dispatch) {
    console.log(
      `[ActionExecutor] layer3_dispatch skipped: action=${action.id} reason=${result.reason}` +
      (result.confidence !== undefined ? ` (confidence=${result.confidence}, threshold=${result.threshold})` : '')
    );
    // 2026-06-16 — observability for the suppress benign-hold gate. Pure
    // telemetry (no actions queued) so a misfire-that-would-have-been is
    // queryable. Would have surfaced the Jacqueline Virtue case immediately.
    if (result.reason === 'benign_hold_not_a_decline') {
      await emitEvent({
        event_type: 'layer3.suppress_reclassified_as_hold',
        source: 'agent_executor',
        entity_type: 'contact',
        entity_id: String(dispatchContactId || ''),
        ghl_contact_id: dispatchContactId || null,
        payload: {
          contact_id: dispatchContactId,
          decline_signal: result.decline_signal ?? null,
          had_active_appointment: result.had_active_appointment ?? null,
          recommended_action: result.recommended_action || 'suppress',
          message_preview: String(event.payload?.message_text || event.payload?.message_preview || '').slice(0, 200),
        },
        priority: 'normal',
        // No consuming rule — bypass the default-drop intake filter so this
        // observability event lands in system_events (not system_events_filtered)
        // and stays queryable. Marked no_matching_rules on processing (harmless).
        bypass_filter: true,
      }).catch((err) => console.warn(`[ActionExecutor] layer3_dispatch hold-telemetry emit failed: ${err.message}`));
    }
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
  issue_hold: executeIssueHold,                  // 2026-06-12 — universal Dynamic Hold issuer (+ brain-side serialization)
  book_appointment: executeBookAppointment,
  cancel_appointment: executeCancelAppointment,
  reschedule_appointment: executeRescheduleAppointment, // v2.7.8 — agentic reschedule (cancel old + book new)
  update_appointment_status: executeUpdateAppointmentStatus, // 2026-06-03 — in-home book-then-capture status upgrade (new→confirmed)
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
  end_agentic_handoff: (action) => endAgenticHandoff(action.target_id), // 2026-06-16 — silent agentic-active teardown on terminal closeout
};

// Handlers that need the triggering event's payload injected as context.
const CONTEXT_AWARE_HANDLERS = new Set([
  'send_notification',
  'create_task',
  'book_appointment',
  'reschedule_appointment',  // v2.7.8 — needs context for date interpolation in new_start_time
  'update_appointment_status', // 2026-06-03 — consistent with other appointment actions (context currently unused)
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

// 2026-07-03 — action types that MUTATE contact/pipeline state and are
// therefore gated by suppress-automation / stop-bot (agentic.action_suppressed).
// send_message keeps its own richer gate inside executeSendMessageWithLock.
// Deliberately NOT gated: appointment actions (cancel/reschedule may be the
// direct fulfillment of an explicit customer request), LP DNC writes
// (compliance must always land), notifications/tasks (rep-facing, not
// contact-facing), and read/compute actions.
const MUTATION_GATED_ACTION_TYPES = new Set([
  'move_opportunity',
  'update_opportunity',
  'add_to_workflow',
  'remove_from_workflow',
  'set_stage',
  'update_custom_fields',
  'update_contact_email',
  'add_tag',
  'remove_tag',
]);

// add_tag exception: suppression/audit tags must still land on a suppressed
// contact (they're how suppression is recorded in the first place).
const SUPPRESSION_AUDIT_TAG_RE = /^(dnc|dnc-|do-not-contact|stop-bot|suppress-|hard-disqualified|quarantined|audit-|compliance-|loss-reason:)/i;

function isSuppressionAuditTag(tag) {
  return SUPPRESSION_AUDIT_TAG_RE.test(String(tag || ''));
}

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

  // ═══ Mutation suppression gate (2026-07-03) ══════════════════════
  // suppress-automation / stop-bot blocks ALL mutating action types — not
  // only send_message. Exception: add_tag of a suppression/audit tag (that
  // is how suppression itself is recorded). Fail-open on infra errors,
  // matching checkSuppression.
  if (MUTATION_GATED_ACTION_TYPES.has(action.action_type)) {
    const exemptTagAdd = action.action_type === 'add_tag'
      && isSuppressionAuditTag(action.action_payload?.tag);
    if (!exemptTagAdd) {
      const mutationGate = await checkMutationSuppression(action.target_id);
      if (mutationGate.suppressed) {
        console.log(
          `[ActionExecutor] 🚫 ${action.action_type} suppressed (action ${action.id}): ` +
          `contact ${action.target_id} has ${mutationGate.matched_tag}`
        );
        emitEvent({
          event_type: 'agentic.action_suppressed',
          source: 'action_executor',
          entity_type: 'contact',
          entity_id: String(action.target_id || 'unknown'),
          ghl_contact_id: action.target_id || null,
          priority: 'low',
          bypass_filter: true,
          payload: {
            action_type: action.action_type,
            action_id: action.id || null,
            rule_key: action.rule_applied || null,
            matched_tag: mutationGate.matched_tag,
          },
          idempotency_key: `action_suppressed_${action.id || `${action.target_id}_${action.action_type}`}`,
        }).catch((err) => console.warn(`[ActionExecutor] action_suppressed emit failed: ${err.message}`));
        await supabase.from('agent_actions').update({
          status: 'suppressed',
          error_message: `mutation suppressed: contact has ${mutationGate.matched_tag}`,
          execution_result: { suppressed: true, matched_tag: mutationGate.matched_tag },
          executed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', action.id);
        return {
          action_id: action.id,
          status: 'suppressed',
          action_type: action.action_type,
          result: { suppressed: true, matched_tag: mutationGate.matched_tag },
        };
      }
    }
  }

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
  // ═══ Send-dedup gate (logical-identity idempotency) ═════════════════
  // Runs after the validation gate, before dispatch. For send_notification
  // and create_task, claim an atomic mark keyed on (action_type, target_id,
  // payload hash). A near-simultaneous sibling row or a post-timeout retry
  // produces the SAME key → claim fails → we short-circuit instead of double-
  // sending. Fail-open (any infra error claims). The mark is released in the
  // catch below if the handler throws, so a genuinely-failed send still
  // retries. See src/services/send-dedup.js.
  let _dedupKey = null;
  if (DEDUP_ACTION_TYPES.has(action.action_type)) {
    _dedupKey = makeDedupKey(action);
    const claim = await claimSendMark(_dedupKey, action);
    if (claim.duplicate) {
      await supabase.from('agent_actions').update({
        status: 'completed',
        execution_result: {
          action: 'deduped',
          skipped: true,
          reason: 'send_dedup',
          dedup_key: _dedupKey,
          first_action_id: claim.first_action_id,
          age_ms: claim.age_ms,
        },
        executed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq('id', action.id);
      console.log(
        `[ActionExecutor] 🟰 ${action.action_type} deduped (action ${action.id}, ` +
        `key=${_dedupKey}, first=${claim.first_action_id}, age=${claim.age_ms}ms)`
      );
      return {
        action_id: action.id,
        status: 'completed',
        action_type: action.action_type,
        result: { deduped: true, first_action_id: claim.first_action_id },
      };
    }
  }

  try {
    // Base context always carries the per-batch contact cache so every handler
    // can dedupe its GET /contacts/{id} reads. Context-aware handlers also get
    // the event payload + accumulated batchContext (which already includes
    // _contactCache via the spread). Non-aware handlers get ONLY _contactCache —
    // never the accumulated _context — to preserve existing behavior.
    let context = { _contactCache: batchContext._contactCache };
    if (CONTEXT_AWARE_HANDLERS.has(action.action_type)) {
      context = { ...(await getEventContext(action)), ...batchContext };
    }
    const result = await Promise.race([
      handler(action, context),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error(`handler ${action.action_type} timed out after ${HANDLER_TIMEOUT_MS}ms`)),
        HANDLER_TIMEOUT_MS,
      )),
    ]);
    if (result?._context) Object.assign(batchContext, result._context);
    // Issue #99: a handler can return a non-throwing result that still
    // represents a failure (AI generation failed → safe fallback sent, or the
    // legacy early-return ai_generation_failed shape). classifyHandlerResult
    // maps those to `failed` with a populated error_message so they stop hiding
    // under `completed` + null error_message. execution_result is preserved.
    const { status, error_message: errorMessage } = classifyHandlerResult(result);
    await supabase.from('agent_actions').update({
      status,
      error_message: errorMessage,
      execution_result: result,
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('id', action.id);
    if (status === 'failed') {
      console.warn(`[ActionExecutor] ⚠️ ${action.action_type} marked failed (action ${action.id}, rule: ${action.rule_applied}): ${errorMessage}`);
    } else if (status === 'skipped') {
      console.log(`[ActionExecutor] ⏭️ ${action.action_type} skipped (action ${action.id}, rule: ${action.rule_applied}): ${errorMessage}`);
    } else {
      console.log(`[ActionExecutor] ✅ ${action.action_type} completed (action ${action.id}, rule: ${action.rule_applied})`);
    }
    return {
      action_id: action.id,
      status,
      action_type: action.action_type,
      result,
    };
  } catch (err) {
    // Release the send-dedup mark so a genuinely-failed send can retry.
    if (_dedupKey) {
      try { await releaseSendMark(_dedupKey, action.id); } catch (e) { /* swallow */ }
    }
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

// ═══════════════════════════════════════════════════════════════════
// PHASE 2 (2026-06-02) — Safe-claimed bounded concurrency
//
// Before: executeActions pulled up to 50 pending rows with a plain SELECT and
// ran batches serially, capping drain at ~80/hr — far under the real ceiling
// (the shared GHL token bucket in ghl-rate-limiter.js: 40 calls/min ≈
// ~1,000 actions/hr at ~2 GHL calls each). Now we CLAIM rows atomically via the
// claim_agent_actions() Postgres RPC (UPDATE … FOR UPDATE SKIP LOCKED), so
// concurrent drivers (n8n cron + the in-process primary scheduler) receive
// disjoint work and never double-fire non-idempotent actions. Within a run we
// group claimed rows by batch_id and run independent batches through a small
// async pool; a batch's own actions still run serially in sequence_order.
//
// Claiming is CHUNKED (EXECUTOR_CLAIM_CHUNK) so the time-budget cutoff can
// never strand more than one chunk in 'executing' (the reaper recovers those
// after 10 min). RUN_BUDGET_MS is kept well under the 10-min reaper age and
// under the 60s scheduler cadence.
// ═══════════════════════════════════════════════════════════════════

const EXECUTOR_BATCH_LIMIT   = Math.max(1, parseInt(process.env.EXECUTOR_BATCH_LIMIT   || '250', 10));
const EXECUTOR_CONCURRENCY   = Math.max(1, parseInt(process.env.EXECUTOR_CONCURRENCY   || '4', 10));
const EXECUTOR_RUN_BUDGET_MS = Math.max(1000, parseInt(process.env.EXECUTOR_RUN_BUDGET_MS || '50000', 10));
const EXECUTOR_CLAIM_CHUNK   = Math.max(1, parseInt(process.env.EXECUTOR_CLAIM_CHUNK   || '25', 10));

// Per-handler watchdog. A hung handler (e.g. an add_to_workflow webhook fetch
// that never resolves) would otherwise sit 'executing' indefinitely and hold the
// executorRunning guard, freezing the whole sweep so every later action drains
// minutes late. This race caps any single handler; on timeout the catch below
// marks the action pending/failed and the sweep returns, releasing the guard.
// 2026-06-05 — raised 30000 → 60000. The 30s watchdog was SHORTER than the
// worst-case legitimate path: ghl-rate-limiter acquireToken can wait up to its
// own 30s fail-open, and the downstream ghlFetch adds up to 15s — ~45s total
// under token-bucket contention. At 30s the race fired on healthy-but-queued
// calls, marked them failed/pending, and retried; because Promise.race does
// NOT cancel the loser, the original POST could still land → duplicate GroupMe
// cards + lost-alert churn. 60s clears the legitimate ceiling while still
// capping a truly hung handler (the 10-min reaper is the real backstop).
const HANDLER_TIMEOUT_MS = parseInt(process.env.EXECUTOR_HANDLER_TIMEOUT_MS || '60000', 10);
// Send-dedup: action types whose handlers cause an external, user-visible side
// effect that must not double-fire. Guarded by an atomic claim on a logical-
// identity key (action_type + target_id + payload hash) so that (a) near-
// simultaneous sibling rows and (b) post-timeout retries collapse to a single
// send. See src/services/send-dedup.js.
const DEDUP_ACTION_TYPES = new Set(['send_notification', 'create_task']);

// Module-level in-flight guard. Protects BOTH entry points (the n8n /execute
// route AND the 60s in-process scheduler) from stacking into wasteful empty
// churn. Claiming already makes overlap *correct*; this just avoids redundant
// work and overlapping reaper/approval passes.
let executorRunning = false;

/**
 * Atomically claim up to `n` pending actions via the claim_agent_actions RPC
 * (flips them to 'executing' and returns them). Falls back to the legacy
 * non-claiming SELECT if the RPC is missing (deploy-before-DDL grace) — in that
 * mode rows are NOT locked, so the caller must stay single-pass / single-driver.
 *
 * @returns {Promise<{rows: object[], claimed: boolean}>} claimed=false ⇒ legacy path
 */
async function claimActions(n) {
  const { data, error } = await supabase.rpc('claim_agent_actions', { p_limit: n });
  if (!error) return { rows: data || [], claimed: true };

  const missing = /does not exist|could not find|undefined function|42883|schema cache/i.test(error.message || '');
  if (!missing) throw new Error(`claim_agent_actions RPC failed: ${error.message}`);

  console.warn('[ActionExecutor] claim_agent_actions RPC missing — falling back to legacy non-claiming SELECT (single-driver only). Create the RPC to enable concurrency.');
  const { data: rows, error: selErr } = await supabase.from('agent_actions')
    .select('*')
    .eq('status', 'pending')
    .order('priority', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .order('sequence_order', { ascending: true })
    .limit(n);
  if (selErr) throw new Error(selErr.message);
  return { rows: rows || [], claimed: false };
}

/**
 * Run one batch's actions serially in sequence_order. Preserves the original
 * semantics: a hard `failed` stops the batch; `rejected_by_validation` does
 * NOT (a single invariant violation shouldn't kill unrelated routing).
 */
async function runBatch(batch) {
  // Per-batch contact cache (src/actions/contact-cache.js). One Map per
  // batch_id → serial within a batch → no concurrency hazard. Dedupes the
  // redundant GET /contacts/{id} reads that the tag + lp-appointment handlers
  // would otherwise each perform on the same contact.
  const batchContext = { _contactCache: new Map() };
  const priorBatchResults = [];
  const out = [];
  for (const a of batch) {
    const r = await executeSingleAction(a, batchContext, priorBatchResults);
    out.push(r);
    priorBatchResults.push({ ...r, action: a });
    if (r.status === 'failed') break;
  }
  return out;
}

export async function executeActions({ limit } = {}) {
  const startTime = Date.now();

  // In-flight guard — one run at a time per process (covers the n8n route and
  // the in-process scheduler). Claiming makes overlap safe; this avoids churn.
  if (executorRunning) {
    return { success: true, skipped: true, reason: 'already_running' };
  }
  executorRunning = true;

  try {
    // Phase 0: reap stuck 'executing' (killed-process zombies) + orphaned
    // 'approved' rows. Phase 1: send pending_approval GroupMe cards.
    const reaperResult = await reapStuckActions();
    const approvalRequestsSent = await processApprovalQueue();

    // Phase 2: claim → group → bounded-concurrent execute, chunked, until the
    // per-run limit or the wall-clock budget is hit. Pull order is enforced by
    // the claim RPC (priority ASC NULLS LAST, created_at ASC, sequence_order
    // ASC — matches idx_aa_priority_pull).
    const totalLimit = Math.max(1, limit || EXECUTOR_BATCH_LIMIT);
    const results = [];
    let completed = 0, failed = 0, rejectedByValidation = 0, skipped = 0;
    let claimedTotal = 0, chunks = 0, budgetExhausted = false, usedLegacyPath = false;

    while (claimedTotal < totalLimit) {
      if (Date.now() - startTime >= EXECUTOR_RUN_BUDGET_MS) { budgetExhausted = true; break; }

      const want = Math.min(EXECUTOR_CLAIM_CHUNK, totalLimit - claimedTotal);
      const { rows, claimed } = await claimActions(want);
      if (!claimed) usedLegacyPath = true;
      if (!rows.length) break;
      claimedTotal += rows.length;
      chunks++;

      const batches = groupByBatch(rows);
      const batchResults = await runPool(batches, EXECUTOR_CONCURRENCY, runBatch);
      for (const br of batchResults) {
        for (const r of br) {
          results.push(r);
          if (r.status === 'completed') completed++;
          else if (r.status === 'failed') failed++;
          else if (r.status === 'skipped') skipped++;
          else if (r.status === 'rejected_by_validation') rejectedByValidation++;
        }
      }

      // Legacy fallback returns rows still in 'pending' (no lock); looping would
      // re-pull the same rows. One pass only in that mode.
      if (!claimed) break;
    }

    const elapsed = Date.now() - startTime;
    console.log(
      `[ActionExecutor] Done: ${completed} completed, ${failed} failed, ${skipped} skipped, ` +
      `${rejectedByValidation} rejected_by_validation across ${chunks} chunk(s), ` +
      `${claimedTotal} claimed (concurrency=${EXECUTOR_CONCURRENCY})` +
      `${budgetExhausted ? ' [budget exhausted]' : ''}${usedLegacyPath ? ' [legacy-select fallback]' : ''} (${elapsed}ms)`
    );

    return {
      success: true,
      actions_executed: results.length,
      completed,
      failed,
      skipped,
      rejected_by_validation: rejectedByValidation,
      retrying: results.filter(r => r.status === 'pending').length,
      approval_requests_sent: approvalRequestsSent,
      stuck_actions_reaped: reaperResult.reaped || 0,
      reaper_detail: reaperResult.reaped > 0 ? reaperResult : undefined,
      claimed_total: claimedTotal,
      chunks,
      budget_exhausted: budgetExhausted,
      concurrency: EXECUTOR_CONCURRENCY,
      used_legacy_path: usedLegacyPath || undefined,
      results,
      elapsed_ms: elapsed,
    };
  } finally {
    executorRunning = false;
  }
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
      res.json(await executeActions({ limit: req.body?.limit }));
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
